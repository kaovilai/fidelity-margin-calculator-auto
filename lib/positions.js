// PositionsAPI — fetches account positions from Fidelity's portfolio GraphQL API
// and converts them to the priceList format needed by the margin calculator API.
'use strict';
const PositionsAPI = (() => {
  const ENDPOINT = FMC_CONSTANTS.API.POSITIONS_ENDPOINT;

  // Exact query captured from Fidelity's portfolio summary page
  const QUERY = `query GetPositions($acctList: [PositionAccountInput], $customerId: String) {
  getPosition(acctList: $acctList, customerId: $customerId) {
    sysMsgs {
      sysMsg {
        code
        detail
        message
        source
        type
        __typename
      }
      __typename
    }
    position {
      portfolioDetail {
        portfolioPositionCount
        __typename
      }
      acctDetails {
        acctDetail {
          acctNum
          positionDetails {
            positionDetail {
              symbol
              cusip
              holdingPct
              optionUnderlyingSymbol
              securityType
              securitySubType
              hasIntradayPricingInd
              marketValDetail {
                marketVal
                totalGainLoss
                __typename
              }
              securityDetail {
                isLoaned
                isHardToBorrow
                bondDetail {
                  maturityDate
                  hasAutoRoll
                  __typename
                }
                __typename
              }
              securityDescription
              quantity
              __typename
            }
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}
`;

  const RETRYABLE_TYPES = new Set(FMC_CONSTANTS.RETRYABLE_ERROR_TYPES);

  const debugLog = makeDebugLog('[FMC-POS]');

  // Options contracts represent 100 shares; market value = qty * OPTION_CONTRACT_SHARES * price
  const OPTION_CONTRACT_SHARES = FMC_CONSTANTS.POSITIONS_CALC.OPTION_CONTRACT_SHARES;
  // Bonds are quoted per $100 face value; price = (mktVal / qty) * BOND_PRICE_FACTOR
  const BOND_PRICE_FACTOR = FMC_CONSTANTS.POSITIONS_CALC.BOND_PRICE_FACTOR;

  class PositionsError extends Error {
    constructor(message, type) {
      super(message);
      this.type = type;
      this.name = 'PositionsError';
    }
  }

  /**
   * Converts a raw portfolio position object from the portfolio GraphQL API into
   * a priceList entry for the margin calculator API.
   * Price derivation varies by security type:
   *   - Options: price = mktVal / (qty * 100) — contract multiplier
   *   - Bonds:   price = (mktVal / qty) * 100  — per $100 face value
   *   - Others:  price = mktVal / qty
   * @param {{
   *   symbol: string,
   *   cusip: string,
   *   securityType: string,
   *   quantity: number,
   *   marketValDetail: {marketVal: number}
   * }} pos - Raw position from the portfolio API response.
   * @returns {{symbol: string, cusip: string, priceInd: string, longShortInd: string,
   *   price: number, isCurrency: boolean}|null}
   *   priceList entry, or null if the price cannot be reliably computed.
   */
  function positionToPriceListEntry(pos) {
    const secType = pos.securityType?.trim().toLowerCase() ?? '';
    const isOption = secType === 'option';
    const isBond = secType === 'bond';
    const qty = Math.abs(pos.quantity);
    const mktVal = Math.abs(pos.marketValDetail?.marketVal ?? NaN);
    // Skip zero-quantity, non-finite-quantity, or zero/non-finite-value positions —
    // price would be 0, NaN, or Infinity, corrupting the margin calc request.
    if (!Number.isFinite(qty) || qty === 0 || mktVal === 0 || !Number.isFinite(mktVal)) return null;
    // Options: mktVal is total (qty * OPTION_CONTRACT_SHARES * price), so price = mktVal / (qty * OPTION_CONTRACT_SHARES)
    // Bonds: priced per $BOND_PRICE_FACTOR face value, so price = (mktVal / qty) * BOND_PRICE_FACTOR
    // Everything else (equities, mutual funds): price = mktVal / qty
    let price;
    if (isOption) {
      price = mktVal / (qty * OPTION_CONTRACT_SHARES);
    } else if (isBond) {
      price = (mktVal / qty) * BOND_PRICE_FACTOR;
    } else {
      price = mktVal / qty;
    }
    if (!Number.isFinite(price)) return null;
    // Round to 2 decimal places (matches API precision) and reject zero-valued prices.
    // Very small positions (e.g. an option worth $0.004/share) would round to $0.00,
    // which the margin API treats as a zero-price position and returns wrong results.
    price = Math.round(price * 100) / 100;
    if (price === 0) return null;
    // Strip leading - from option symbols (portfolio uses -AAPL..., priceList uses AAPL...)
    const sym = (pos.symbol || '').replace(/^-/, '');
    // Skip positions with no usable symbol — an empty symbol would corrupt the margin calc request
    if (!sym) return null;
    // Guard against unexpectedly long symbols that indicate a portfolio API format change.
    // Full option symbols are at most ~20 chars (e.g. 'GOOGL261218C2000.5'); 50 is a
    // generous upper bound. Mirrors the MAX_SYMBOL_LEN guard used in detector.js for
    // DOM-sourced underlying ticker symbols.
    if (sym.length > FMC_CONSTANTS.POSITIONS_CALC.MAX_POSITION_SYMBOL_LEN) {
      debugLog(`Skipping position: symbol unexpectedly long (${sym.length} chars) — portfolio API symbol format may have changed`);
      return null;
    }

    return {
      symbol: sym,
      // Normalize to empty string: options and some other securities may not carry a
      // CUSIP in Fidelity's portfolio API. Passing null/undefined would serialize to JSON
      // null (or be omitted entirely for undefined), which the margin API may reject.
      cusip: pos.cusip ?? '',
      priceInd: FMC_CONSTANTS.POSITIONS_CONFIG.PRICE_IND,
      longShortInd: pos.quantity > 0 ? 'LONG' : 'SHORT',
      price,
      isCurrency: false
    };
  }

  const FETCH_TIMEOUT_MS = FMC_CONSTANTS.FETCH_TIMEOUT_MS.POSITIONS_API;

  /**
   * Fetches positions for the given account from Fidelity's portfolio GraphQL API and
   * converts them to the priceList format required by the margin calculator API.
   * Retries automatically on transient errors with exponential backoff.
   * @param {string} accountNum - Brokerage account number.
   * @returns {Promise<Array<{symbol: string, cusip: string, priceInd: string,
   *   longShortInd: string, price: number, isCurrency: boolean}>>}
   *   Array of price list entries. Empty array if the account has no positions.
   * @throws {PositionsError} On session expiry, network failure, or unexpected API response.
   */
  async function fetchPriceListWithRetry(accountNum) {
    return Retry.withBackoff(
      () => doFetchPriceList(accountNum),
      RETRYABLE_TYPES,
      (attempt, max, delay) => debugLog(`Positions retry ${attempt}/${max} in ${delay}ms`)
    );
  }

  /**
   * Performs a single fetch call to Fidelity's portfolio GraphQL API and converts
   * the returned positions to the priceList format required by the margin calculator.
   * Does not retry — callers use `fetchPriceListWithRetry` for retry logic.
   * @param {string} accountNum - Brokerage account number.
   * @returns {Promise<Array<{symbol: string, cusip: string, priceInd: string,
   *   longShortInd: string, price: number, isCurrency: boolean}>>}
   *   Array of priceList entries. Empty array if the account has no positions.
   * @throws {PositionsError} On network error, timeout, non-OK HTTP status, or unexpected response.
   */
  async function doFetchPriceList(accountNum) {
    debugLog(`Fetching positions for ${accountNum}`);
    const posCfg = FMC_CONSTANTS.POSITIONS_CONFIG;

    let resp;
    try {
      resp = await fetchWithTimeout(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': '*/*' },
        credentials: 'include',
        body: JSON.stringify({
          operationName: 'GetPositions',
          variables: {
            acctList: [{
              acctNum: accountNum,
              acctType: posCfg.ACCT_TYPE,
              acctSubType: posCfg.ACCT_SUB_TYPE,
              preferenceDetail: posCfg.PREFERENCE_DETAIL
            }]
          },
          query: QUERY
        })
      }, FETCH_TIMEOUT_MS);
    } catch (e) {
      if (e.isTimeout) {
        debugLog(`Positions request timed out after ${FETCH_TIMEOUT_MS}ms`);
        throw new PositionsError('Positions request timed out — Fidelity may be slow', FMC_CONSTANTS.ERROR_TYPES.NETWORK_ERROR);
      }
      debugLog(`Network error fetching positions: ${e.message}`);
      throw new PositionsError('Network error — check your connection', FMC_CONSTANTS.ERROR_TYPES.NETWORK_ERROR);
    }

    if (isSessionExpiredResponse(resp)) {
      throw new PositionsError('Session expired — please log in to Fidelity', FMC_CONSTANTS.ERROR_TYPES.SESSION_EXPIRED);
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
          FMC_CONSTANTS.ERROR_TYPES.API_ERROR
        );
        // Honour the server's rate-limit hint so withBackoff waits at least as long as
        // Fidelity requests before retrying — avoids hammering the API during a 429 window.
        const retryAfterMs = parseRetryAfterMs(resp.headers.get('Retry-After'), FMC_CONSTANTS.MAX_RETRY_AFTER_MS);
        if (retryAfterMs > 0) err.retryAfterMs = retryAfterMs;
        throw err;
      }
      // Any other non-OK status (e.g. 400, 404) indicates a client/request problem,
      // not an empty account — throw so the user sees a meaningful error instead of
      // a misleading "No positions found" message. Use CLIENT_ERROR (non-retryable)
      // so the same broken request is not retried — matching margin-api.js classifyError().
      throw new PositionsError(
        `Positions API HTTP ${resp.status} — unexpected error fetching account positions`,
        FMC_CONSTANTS.ERROR_TYPES.CLIENT_ERROR
      );
    }

    let data;
    try {
      data = await resp.json();
    } catch (e) {
      debugLog(`Invalid JSON from positions API: ${e.message}`);
      throw new PositionsError('Invalid response from positions API — Fidelity may have changed its format', FMC_CONSTANTS.ERROR_TYPES.PARSE_ERROR);
    }

    if (data.errors?.length > 0) {
      // Partial GraphQL errors can occur for optional metadata fields (e.g. bondDetail,
      // securityDetail) without affecting the core position data we need to build the
      // priceList. Mirroring the approach in margin-api.js, only throw when the critical
      // acctDetails path is absent — otherwise log a warning and proceed with available data.
      const hasCriticalData = Array.isArray(
        data?.data?.getPosition?.position?.acctDetails?.acctDetail
      );
      const errorSummary = data.errors.map(e => e.message ?? '(no message)').join('; ');
      if (!hasCriticalData) {
        debugLog(`Positions API GraphQL error (no usable data): ${errorSummary}`);
        throw new PositionsError(
          data.errors[0]?.message || 'GraphQL error from positions API',
          FMC_CONSTANTS.ERROR_TYPES.API_ERROR
        );
      }
      debugLog(`Positions API non-critical GraphQL error(s) — continuing with available data: ${errorSummary}`);
    }

    const acctDetails = data?.data?.getPosition?.position?.acctDetails?.acctDetail;
    if (!Array.isArray(acctDetails)) {
      debugLog(`Unexpected positions response shape: ${JSON.stringify(data).slice(0, 200)}`);
      // PARSE_ERROR (non-retryable): a structural mismatch won't be resolved by retrying.
      // Mirrors the non-retryable classification already used for resp.json() failures above.
      throw new PositionsError(
        'Positions API returned an unexpected response format — Fidelity may have updated their API',
        FMC_CONSTANTS.ERROR_TYPES.PARSE_ERROR
      );
    }

    const target = acctDetails.find(a => a.acctNum?.trim() === accountNum?.trim());
    if (!target) {
      // Log the count of returned accounts (not the numbers themselves) to help
      // diagnose account-mismatch issues without leaking account data to the log.
      debugLog(`Account ${accountNum} not found in positions response (${acctDetails.length} account(s) returned)`);
      return [];
    }
    const positions = target.positionDetails?.positionDetail;
    if (!positions) {
      debugLog(`No positions found for account ${accountNum}`);
      return [];
    }
    if (!Array.isArray(positions)) {
      debugLog(`Unexpected positionDetail shape — expected array, got: ${typeof positions}`);
      // PARSE_ERROR (non-retryable): a structural mismatch won't be resolved by retrying.
      // Mirrors the non-retryable classification used above for acctDetails and resp.json() failures.
      throw new PositionsError(
        'Positions API returned an unexpected response format — Fidelity may have updated their API',
        FMC_CONSTANTS.ERROR_TYPES.PARSE_ERROR
      );
    }
    const priceList = positions.flatMap(p => {
      if (!Number.isFinite(Number(p.quantity)) || !Number.isFinite(Number(p.marketValDetail?.marketVal))) {
        debugLog(`Skipping position ${p.symbol ?? '(no symbol)'}: missing, NaN, or non-finite quantity or marketVal`);
        return [];
      }
      const entry = positionToPriceListEntry(p);
      if (!entry) {
        debugLog(`Skipping position ${p.symbol ?? '(no symbol)'}: could not compute price (qty=${p.quantity}, mktVal=${p.marketValDetail?.marketVal})`);
        return [];
      }
      return [entry];
    });

    debugLog(`Built priceList with ${priceList.length} entries from ${positions.length} positions${priceList.length < positions.length ? ` (${positions.length - priceList.length} skipped)` : ''}`);
    return priceList;
  }

  return { fetchPriceList: fetchPriceListWithRetry };
})();
