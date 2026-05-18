// PositionsAPI — fetches account positions from Fidelity's portfolio GraphQL API
// and converts them to the priceList format needed by the margin calculator API.
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

  const RETRYABLE_TYPES = new Set([FMC_CONSTANTS.ERROR_TYPES.NETWORK_ERROR, FMC_CONSTANTS.ERROR_TYPES.API_ERROR]);

  const debugLog = makeDebugLog('[FMC-POS]');

  // Options contracts represent 100 shares; market value = qty * OPTION_CONTRACT_SHARES * price
  const OPTION_CONTRACT_SHARES = 100;
  // Bonds are quoted per $100 face value; price = (mktVal / qty) * BOND_PRICE_FACTOR
  const BOND_PRICE_FACTOR = 100;

  class PositionsError extends Error {
    constructor(message, type) {
      super(message);
      this.type = type;
      this.name = 'PositionsError';
    }
  }

  // Convert portfolio position to margin calc priceList entry.
  // Returns null if price cannot be computed (zero quantity or non-numeric marketVal).
  function positionToPriceListEntry(pos) {
    const secType = pos.securityType?.trim().toLowerCase() ?? '';
    const isOption = secType === 'option';
    const isBond = secType === 'bond';
    const qty = Math.abs(pos.quantity);
    const mktVal = Math.abs(pos.marketValDetail?.marketVal ?? NaN);
    // Skip zero-quantity or zero-value positions — price would be 0 or NaN, corrupting margin calc
    if (qty === 0 || mktVal === 0 || !Number.isFinite(mktVal)) return null;
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

    return {
      symbol: sym,
      cusip: pos.cusip,
      priceInd: 'initial',
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

  // Fetch positions for a single account and return priceList array
  async function doFetchPriceList(accountNum) {
    debugLog(`Fetching positions for ${accountNum}`);

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
              acctType: 'Brokerage',
              acctSubType: 'Brokerage',
              preferenceDetail: false
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
      if (resp.status === 408 || resp.status === 429 || resp.status >= 500) {
        // 408 (Request Timeout), 429 (Rate Limited), or 5xx (server error) — retryable.
        // Use API_ERROR to match margin-api.js classification so callers and logs can
        // distinguish server-side failures from genuine network/connectivity errors (NETWORK_ERROR).
        throw new PositionsError(
          `Positions API HTTP ${resp.status} — Fidelity may be temporarily unavailable`,
          FMC_CONSTANTS.ERROR_TYPES.API_ERROR
        );
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
      const msg = data.errors[0]?.message || 'GraphQL error from positions API';
      debugLog(`Positions API GraphQL error: ${msg}`);
      throw new PositionsError(msg, FMC_CONSTANTS.ERROR_TYPES.API_ERROR);
    }

    const acctDetails = data?.data?.getPosition?.position?.acctDetails?.acctDetail;
    if (!Array.isArray(acctDetails)) {
      debugLog('Unexpected positions response shape: ' + JSON.stringify(data).slice(0, 200));
      throw new PositionsError(
        'Positions API returned an unexpected response format — Fidelity may have updated their API',
        FMC_CONSTANTS.ERROR_TYPES.API_ERROR
      );
    }

    const target = acctDetails.find(a => a.acctNum?.trim() === accountNum?.trim());
    if (!target || !target.positionDetails || !target.positionDetails.positionDetail) {
      debugLog(`No positions found for account ${accountNum}`);
      return [];
    }

    const positions = target.positionDetails.positionDetail;
    if (!Array.isArray(positions)) {
      debugLog('Unexpected positionDetail shape — expected array, got: ' + typeof positions);
      throw new PositionsError(
        'Positions API returned an unexpected response format — Fidelity may have updated their API',
        FMC_CONSTANTS.ERROR_TYPES.API_ERROR
      );
    }
    const priceList = positions.flatMap(p => {
      if (!Number.isFinite(p.quantity) || !Number.isFinite(p.marketValDetail?.marketVal)) {
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

    debugLog(`Built priceList with ${priceList.length} entries from ${positions.length} positions`);
    return priceList;
  }

  return { fetchPriceList: fetchPriceListWithRetry };
})();
