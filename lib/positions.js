// PositionsAPI — fetches account positions from Fidelity's margin calculator current-status API
// and converts them to the priceList format needed by the margin calculator trade-calculator API.
'use strict';
const PositionsAPI = (() => {
  const ENDPOINT = FMC_CONSTANTS.API.POSITIONS_ENDPOINT;

  const RETRYABLE_TYPES = new Set(FMC_CONSTANTS.RETRYABLE_ERROR_TYPES);

  const debugLog = makeDebugLog('[FMC-POS]');

  // Upper bound for position symbols — catches malformed API responses without rejecting
  // real-world symbols.
  const MAX_POSITION_SYMBOL_LEN = FMC_CONSTANTS.POSITIONS_CALC.MAX_POSITION_SYMBOL_LEN;
  // Maximum ms to honour from a Retry-After response header.
  const MAX_RETRY_AFTER_MS = FMC_CONSTANTS.MAX_RETRY_AFTER_MS;

  // Inherits constructor, this.type assignment, and this.name = this.constructor.name
  // from FmcApiError (lib/api-error.js). No constructor needed here.
  class PositionsError extends FmcApiError {}

  /**
   * Converts a position from the margin calculator's `current-status` response into a
   * priceList entry for the `trade-calculator` request. The current-status positions already
   * carry per-unit prices (options per share, bonds per $100), so no price derivation is needed.
   * Positions without a symbol (e.g. T-bills, which are identified by CUSIP only) are skipped,
   * mirroring what Fidelity's own margin calculator page sends.
   * @param {{symbol: string, cusip: string, longShortInd: string, price: number,
   *   currencyInd: boolean}} pos - Raw position from the current-status response.
   * @returns {{symbol: string, cusip: string, priceInd: string, longShortInd: string,
   *   price: number, isCurrency: boolean}|null} priceList entry, or null if unusable.
   */
  function positionToPriceListEntry(pos) {
    const sym = (pos.symbol || '').replace(/^-/, '');
    if (!sym) return null;
    // Guard against unexpectedly long symbols that indicate an API format change.
    if (sym.length > MAX_POSITION_SYMBOL_LEN) {
      debugLog(`Skipping position: symbol unexpectedly long (${sym.length} chars) — API symbol format may have changed`);
      return null;
    }
    if (!Number.isFinite(pos.price) || pos.price === 0) return null;
    if (pos.longShortInd !== 'LONG' && pos.longShortInd !== 'SHORT') return null;
    return {
      symbol: sym,
      // Normalize to empty string so a missing CUSIP never serializes as null.
      cusip: pos.cusip ?? '',
      priceInd: POSITIONS_CONFIG.PRICE_IND,
      longShortInd: pos.longShortInd,
      price: pos.price,
      isCurrency: !!pos.currencyInd
    };
  }


  const FETCH_TIMEOUT_MS = FMC_CONSTANTS.FETCH_TIMEOUT_MS.POSITIONS_API;
  // Aliased at module level for consistency with margin-api.js (which uses ErrorType = FMC_CONSTANTS.ERROR_TYPES)
  // so a rename in FMC_CONSTANTS.ERROR_TYPES is reflected in one place rather than 7+ inline accesses.
  const ErrorType = FMC_CONSTANTS.ERROR_TYPES;
  const API_ERR = FMC_CONSTANTS.API_ERROR_MESSAGES;
  // Aliased at module level so positionToPriceListEntry() and doFetchPriceList() share
  // a single reference rather than doFetchPriceList() creating a local alias on every call.
  const POSITIONS_CONFIG = FMC_CONSTANTS.POSITIONS_CONFIG;

  /**
   * Fetches positions for the given account from the margin calculator current-status API and
   * converts them to the priceList format required by the margin calculator API.
   * Retries automatically on transient errors with exponential backoff.
   * @param {string} accountNum - Brokerage account number.
   * @returns {Promise<{priceList: Array<{symbol: string, cusip: string, priceInd: string,
   *   longShortInd: string, price: number, isCurrency: boolean}>, baselineData: Object|null}>}
   *   `priceList` entries (empty if no positions) and the account's current balance as
   *   `baselineData` (trade-calculator response shape), or null if absent.
   * @throws {PositionsError} On session expiry, network failure, or unexpected API response.
   */
  async function fetchPriceListWithRetry(accountNum) {
    // Guard at the API boundary: an empty/null accountNum would produce a request with no
    // matching account in the response (the API returns an empty acctDetails array), which
    // surfaces as "No positions found" — a misleading error for what is really a caller bug.
    // Failing fast here produces a clear CLIENT_ERROR instead of a confusing empty-list result.
    if (!accountNum) {
      throw new PositionsError('accountNum is required', ErrorType.CLIENT_ERROR);
    }
    return Retry.withBackoff(
      () => doFetchPriceList(accountNum),
      RETRYABLE_TYPES,
      (attempt, max, delay) => debugLog(`Positions retry ${attempt}/${max} in ${delay}ms`)
    );
  }

  /**
   * Performs a single fetch call to the margin calculator current-status API and converts
   * the returned positions to the priceList format required by the margin calculator.
   * Does not retry — callers use `fetchPriceListWithRetry` for retry logic.
   * @param {string} accountNum - Brokerage account number.
   * @returns {Promise<{priceList: Array<{symbol: string, cusip: string, priceInd: string,
   *   longShortInd: string, price: number, isCurrency: boolean}>, baselineData: Object|null}>}
   *   `priceList` entries (empty if no positions) and the account's current balance as
   *   `baselineData` in trade-calculator response shape (null if absent).
   * @throws {PositionsError} On network error, timeout, non-OK HTTP status, or unexpected response.
   */
  async function doFetchPriceList(accountNum) {
    debugLog(`Fetching positions for ${accountNum}`);
    const posCfg = POSITIONS_CONFIG;

    let resp;
    try {
      resp = await fetchWithTimeout(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': '*/*' },
        credentials: 'include',
        body: JSON.stringify({
          accountNum,
          executeOpenOrdersInd: posCfg.EXECUTE_OPEN_ORDERS_IND,
          executeHpoTxnsInd: posCfg.EXECUTE_HPO_TXNS_IND,
          balancesOnlyInd: posCfg.BALANCES_ONLY_IND,
          rbrAddonsInd: posCfg.RBR_ADDONS_IND
        })
      }, FETCH_TIMEOUT_MS);
    } catch (e) {
      if (e.isTimeout) {
        debugLog(`Positions request timed out after ${FETCH_TIMEOUT_MS}ms`);
        throw new PositionsError(`Positions request timed out ${API_ERR.TIMEOUT_SUFFIX}`, ErrorType.NETWORK_ERROR, { cause: e });
      }
      // Re-throw AbortError (from page navigation or extension context invalidation) without
      // wrapping it as NETWORK_ERROR. An un-typed error is not in RETRYABLE_TYPES, so
      // Retry.withBackoff rethrows it immediately rather than waiting through the backoff schedule.
      if (e.name === 'AbortError') throw e;
      debugLog(`Network error fetching positions: ${e.message}`);
      throw new PositionsError(API_ERR.NETWORK_ERROR, ErrorType.NETWORK_ERROR, { cause: e });
    }

    if (isSessionExpiredResponse(resp)) {
      throw new PositionsError(API_ERR.SESSION_EXPIRED, ErrorType.SESSION_EXPIRED);
    }

    if (!resp.ok) {
      let respBody = '';
      try { respBody = await resp.text(); } catch { /* ignore */ }
      debugLog(`Positions API HTTP ${resp.status}: ${respBody.slice(0, 200)}`);
      if (isRetryableHttpStatus(resp.status)) {
        // 408 (Request Timeout), 429 (Rate Limited), or 5xx (server error) — retryable.
        // Use API_ERROR to match margin-api.js classification so callers and logs can
        // distinguish server-side failures from genuine network/connectivity errors (NETWORK_ERROR).
        const err = new PositionsError(
          `Positions API HTTP ${resp.status} — Fidelity may be temporarily unavailable`,
          ErrorType.API_ERROR
        );
        // Honour the server's rate-limit hint so withBackoff waits at least as long as
        // Fidelity requests before retrying — avoids hammering the API during a 429 window.
        const retryAfterMs = parseRetryAfterMs(resp.headers.get('Retry-After'), MAX_RETRY_AFTER_MS);
        if (retryAfterMs > 0) err.retryAfterMs = retryAfterMs;
        throw err;
      }
      // Any other non-OK status (e.g. 400, 404) indicates a client/request problem,
      // not an empty account — throw so the user sees a meaningful error instead of
      // a misleading "No positions found" message. Use CLIENT_ERROR (non-retryable)
      // so the same broken request is not retried — matching margin-api.js classifyError().
      throw new PositionsError(
        `Positions API HTTP ${resp.status} — unexpected error fetching account positions`,
        ErrorType.CLIENT_ERROR
      );
    }

    let data;
    let rawBody = '';
    try {
      rawBody = await resp.text();
      data = JSON.parse(rawBody);
    } catch (e) {
      debugLog(`Invalid JSON from positions API: ${e.message} (${describeNonJsonResponse(resp, rawBody)})`);
      // Fidelity serves its maintenance/outage page as HTML with a 2xx status — transient, so
      // retryable API_ERROR rather than a PARSE_ERROR implying the response format changed.
      if (/text\/html/i.test(resp.headers.get('content-type') ?? '')) {
        throw new PositionsError('Fidelity positions API returned an HTML page — Fidelity may be temporarily unavailable', ErrorType.API_ERROR, { cause: e });
      }
      throw new PositionsError('Invalid response from positions API — Fidelity may have changed its format', ErrorType.PARSE_ERROR, { cause: e });
    }

    const status = data?.data?.getCurrentStatus;
    const sysMsgList = status?.sysMsgs?.sysMsg;
    if (Array.isArray(sysMsgList) && sysMsgList.length > 0) {
      debugLog(`Current-status API sysMsgs: ${formatSysMsgs(sysMsgList)}`);
    }

    const positions = status?.marginCalcResp?.positions;
    if (!Array.isArray(positions)) {
      if (data?.errors?.length > 0) {
        const errorSummary = data.errors.map(e => e.message ?? '(no message)').join('; ');
        debugLog(`Current-status API GraphQL error (no usable data): ${errorSummary}`);
        throw new PositionsError(data.errors[0]?.message || 'Error from positions API', ErrorType.API_ERROR);
      }
      debugLog(`Unexpected current-status response shape: ${JSON.stringify(data).slice(0, 200)}`);
      // PARSE_ERROR (non-retryable): a structural mismatch won't be resolved by retrying.
      throw new PositionsError(
        'Positions API returned an unexpected response format — Fidelity may have updated their API',
        ErrorType.PARSE_ERROR
      );
    }

    const priceList = positions.flatMap(p => {
      const entry = positionToPriceListEntry(p);
      if (!entry) {
        debugLog(`Skipping position ${p.symbol || p.cusip || '(no id)'}: no symbol or unusable price`);
        return [];
      }
      return [entry];
    });

    debugLog(`Built priceList with ${priceList.length} entries from ${positions.length} positions${priceList.length < positions.length ? ` (${positions.length - priceList.length} skipped)` : ''}`);
    // The same response carries the account's current balance — returned in the shape of a
    // trade-calculator response so MarginCalc can diff projected vs. current without any
    // additional network request.
    const balance = status.marginCalcResp.balance;
    const baselineData = balance
      ? { data: { getTradeCalculator: { marginCalcResp: { balance } } } }
      : null;
    return { priceList, baselineData };
  }

  return {
    fetchStatus: fetchPriceListWithRetry,
    fetchPriceList: async (accountNum) => (await fetchPriceListWithRetry(accountNum)).priceList
  };
})();
