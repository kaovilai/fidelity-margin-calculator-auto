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
  const OPTION_SECURITY_TYPE = FMC_CONSTANTS.POSITIONS_CALC.OPTION_SECURITY_TYPE;
  // Set for O(1) membership test — secType is already lowercased before the check.
  const BOND_SECURITY_TYPES = new Set(FMC_CONSTANTS.POSITIONS_CALC.BOND_SECURITY_TYPES);
  // Upper bound for stripped position symbols — generous limit that catches malformed
  // API responses without rejecting real-world symbols. Aliased at module level for
  // consistency with OPTION_CONTRACT_SHARES, BOND_PRICE_FACTOR, etc. above.
  const MAX_POSITION_SYMBOL_LEN = FMC_CONSTANTS.POSITIONS_CALC.MAX_POSITION_SYMBOL_LEN;

  // Inherits constructor, this.type assignment, and this.name = this.constructor.name
  // from FmcApiError (lib/api-error.js). No constructor needed here.
  class PositionsError extends FmcApiError {}

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
    const isOption = secType === OPTION_SECURITY_TYPE;
    const isBond = BOND_SECURITY_TYPES.has(secType);
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
    if (sym.length > MAX_POSITION_SYMBOL_LEN) {
      debugLog(`Skipping position: symbol unexpectedly long (${sym.length} chars) — portfolio API symbol format may have changed`);
      return null;
    }

    return {
      symbol: sym,
      // Normalize to empty string: options and some other securities may not carry a
      // CUSIP in Fidelity's portfolio API. Passing null/undefined would serialize to JSON
      // null (or be omitted entirely for undefined), which the margin API may reject.
      cusip: pos.cusip ?? '',
      priceInd: POSITIONS_CONFIG.PRICE_IND,
      longShortInd: pos.quantity > 0 ? 'LONG' : 'SHORT',
      price,
      isCurrency: false
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
    const posCfg = POSITIONS_CONFIG;

    const data = await fetchAndParse(ENDPOINT, {
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
    }, FETCH_TIMEOUT_MS, {
      timeout: (e) => {
        debugLog(`Positions request timed out after ${FETCH_TIMEOUT_MS}ms`);
        return new PositionsError(`Positions request timed out ${API_ERR.TIMEOUT_SUFFIX}`, ErrorType.NETWORK_ERROR, { cause: e });
      },
      network: (e) => {
        debugLog(`Network error fetching positions: ${e.message}`);
        return new PositionsError(API_ERR.NETWORK_ERROR, ErrorType.NETWORK_ERROR, { cause: e });
      },
      sessionExpired: () => new PositionsError(API_ERR.SESSION_EXPIRED, ErrorType.SESSION_EXPIRED),
      http: (resp, body) => {
        debugLog(`Positions API HTTP ${resp.status}: ${body.slice(0, 200)}`);
        if (isRetryableHttpStatus(resp.status)) {
          // 408 (Request Timeout), 429 (Rate Limited), or 5xx (server error) — retryable.
          // Use API_ERROR to match margin-api.js classification so callers and logs can
          // distinguish server-side failures from genuine network/connectivity errors (NETWORK_ERROR).
          return new PositionsError(
            `Positions API HTTP ${resp.status} — Fidelity may be temporarily unavailable`,
            ErrorType.API_ERROR
          );
        }
        // Any other non-OK status (e.g. 400, 404) indicates a client/request problem,
        // not an empty account — throw so the user sees a meaningful error instead of
        // a misleading "No positions found" message. Use CLIENT_ERROR (non-retryable)
        // so the same broken request is not retried — matching margin-api.js classifyError().
        return new PositionsError(
          `Positions API HTTP ${resp.status} — unexpected error fetching account positions`,
          ErrorType.CLIENT_ERROR
        );
      },
      parse: (e) => {
        debugLog(`Invalid JSON from positions API: ${e.message}`);
        return new PositionsError('Invalid response from positions API — Fidelity may have changed its format', ErrorType.PARSE_ERROR, { cause: e });
      }
    });

    const sysMsgList = data?.data?.getPosition?.sysMsgs?.sysMsg;
    if (Array.isArray(sysMsgList) && sysMsgList.length > 0) {
      debugLog(`Positions API sysMsgs: ${formatSysMsgs(sysMsgList)}`);
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
          ErrorType.API_ERROR
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
        ErrorType.PARSE_ERROR
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
        ErrorType.PARSE_ERROR
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
