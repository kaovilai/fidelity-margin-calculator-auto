// MarginAPI — GraphQL client for Fidelity's margin calculator
// Includes error classification and retry with exponential backoff
'use strict';
const MarginAPI = (() => {
  const ENDPOINT = FMC_CONSTANTS.API.MARGIN_CALC_ENDPOINT;

  const ErrorType = FMC_CONSTANTS.ERROR_TYPES;

  const RETRYABLE = new Set(FMC_CONSTANTS.RETRYABLE_ERROR_TYPES);
  const FETCH_TIMEOUT_MS = FMC_CONSTANTS.FETCH_TIMEOUT_MS.MARGIN_API;
  const MAX_RETRY_AFTER_MS = FMC_CONSTANTS.MAX_RETRY_AFTER_MS;
  const API_ERR = FMC_CONSTANTS.API_ERROR_MESSAGES;

  // Full query matching Fidelity's margin calculator page — server may whitelist query shape.
  // We only use balance fields from the response, but must send the complete query.
  const QUERY = `query GetTradeCalculator($tradeCalculatorInput: TradeCalculatorInput) {
  getTradeCalculator(tradeCalculatorInput: $tradeCalculatorInput) {
    sysMsgs {
      sysMsg {
        message
        detail
        source
        code
        type
        __typename
      }
      __typename
    }
    messages {
      code
      severity
      message
      __typename
    }
    marginCalcResp {
      ...MarginCalculatorResponseFragment
      __typename
    }
    __typename
  }
}

fragment MarginCalculatorResponseFragment on MarginCalcResponse {
  priceTimeStamp
  tradeForced2CashInd
  bypassedOpenOrdersInd
  balance {
    houseBalance
    exchangeBalance
    fedCallSma
    marginCreditDebit
    marginBuyingPower
    nonMarginBuyingPower
    intradayBuyingPower
    marginEquity
    marginEquityPct
    totalSecurityRequirements
    totalOptionRequirements
    coreCash
    netWrth
    totalAccountValue
    accEqty
    avlToTradeWithoutMarginImpact
    dailyMrkToMarket
    accountEqtPct
    __typename
  }
  positions {
    symbol
    logos {
      ...ImageDetails
      __typename
    }
    cusip
    secType
    acctType
    description
    longShortInd
    share
    price
    currencyInd
    mktValue
    totalReqPct
    totalReqShare
    totalReqAmt
    intraInd
    illogicalPositionInd
    floatingNavInd
    positionReqInfos {
      reqRsnCode
      reqSuplCode
      reqSectorDesc
      reqPct
      __typename
    }
    __typename
  }
  underlyingSecurities {
    cusip
    underlyingSecurityIssuers {
      cusip
      symbol
      price
      __typename
    }
    __typename
  }
  optIntraInd
  optAcctMgnReqt
  optPairs {
    price
    ulSecurity {
      cusip
      symbol
      logos {
        ...ImageDetails
        __typename
      }
      description
      secTypeC
      secType
      __typename
    }
    pairing {
      seq
      pairMatchCode
      pairMatchDesc
      reqt
      legs {
        subseq
        acctType
        shareQty
        opSecTypeC
        price
        requirement
        legSecurities {
          cusip
          symbol
          description
          secTypeC
          secType
          convRatio
          delShares
          mktValue
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

fragment ImageDetails on Image {
  size
  location
  __typename
}`;

  /**
   * Builds the GraphQL variables object for the margin calculator API request.
   * @param {string} accountNum - Brokerage account number.
   * @param {Array<Object>} orders - Trade orders to evaluate.
   * @param {Array<Object>} priceList - Current position price entries.
   * @returns {Object} Variables object shaped as `{ tradeCalculatorInput: { ... } }`.
   */
  function buildVariables(accountNum, orders, priceList) {
    const cfg = FMC_CONSTANTS.MARGIN_API_CONFIG;
    return {
      tradeCalculatorInput: {
        accountNum,
        executeOpenOrdersInd: cfg.EXECUTE_OPEN_ORDERS_IND,
        priceSourceInd:       cfg.PRICE_SOURCE_IND,
        executeHpoTxnsInd:    cfg.EXECUTE_HPO_TXNS_IND,
        balancesOnlyInd:      cfg.BALANCES_ONLY_IND,
        rbrAddonsInd:         cfg.RBR_ADDONS_IND,
        tradeOrders: { orders },
        priceList: priceList ?? []
      }
    };
  }

  // Margin calculator referrer — server validates Referer header matches this path.
  // Without it, requests from other Fidelity pages (portfolio, trade) get 400.
  const REFERRER = FMC_CONSTANTS.API.MARGIN_CALC_REFERRER;
  const APOLLO_CLIENT_VERSION = FMC_CONSTANTS.API.APOLLO_CLIENT_VERSION;

  // Margin-calculator-specific XSRF cookie name. Path-scoped to /ftgw/digital/margincalcex/
  // so it may not be present on other Fidelity pages — callers skip the header when null.
  const XSRF_COOKIE_NAME = FMC_CONSTANTS.API.XSRF_COOKIE_NAME;
  const XSRF_HEADER      = FMC_CONSTANTS.API.XSRF_HEADER;
  /**
   * Reads the `MARGIN-CALCULATOR-XSRF-TOKEN` from `document.cookie`.
   * Only returns this margin-calculator-specific token (not the generic `XSRF-TOKEN`).
   * The cookie is path-scoped to `/ftgw/digital/margincalcex/` and may not be present
   * on other Fidelity pages — callers should skip the `X-XSRF-TOKEN` header when null.
   * @returns {string|null} Token value, or `null` if the cookie is absent.
   */
  function getXsrfToken() {
    const prefix = `${XSRF_COOKIE_NAME}=`;
    return document.cookie.split('; ').find(c => c.startsWith(prefix))?.slice(prefix.length) ?? null;
  }

  /**
   * Classifies a non-OK HTTP response into an `ErrorType` constant.
   * Session-expired responses must be detected by the caller before invoking this function.
   * Called only when `!resp.ok` (status outside 200-299) and after `isSessionExpiredResponse`
   * has already been checked, so session-expiry redirects never reach this function.
   * @param {Response|null} resp - Fetch response object, or `null` for network failures.
   * @returns {string} One of `ErrorType.NETWORK_ERROR`, `ErrorType.API_ERROR`, or `ErrorType.CLIENT_ERROR`.
   */
  function classifyError(resp) {
    if (!resp) return ErrorType.NETWORK_ERROR;
    if (isRetryableHttpStatus(resp.status)) return ErrorType.API_ERROR;
    // CLIENT_ERROR (non-retryable) for all remaining cases: 4xx non-retryable statuses
    // and any unexpected status codes (e.g. 1xx/3xx, which fetch() should not normally
    // surface but are handled defensively so retries are not triggered unnecessarily).
    return ErrorType.CLIENT_ERROR;
  }

  // Inherits constructor, this.type assignment, and this.name = this.constructor.name
  // from FmcApiError (lib/api-error.js). No constructor needed here.
  class MarginApiError extends FmcApiError {}

  const debugLog = makeDebugLog('[FMC-API]');

  /**
   * Performs a single fetch call to the margin calculator GraphQL API.
   * Does not retry — callers use `fetchMarginCalc` (via `Retry.withBackoff`) for retry logic.
   * @param {string} accountNum - Brokerage account number.
   * @param {Array<Object>} orders - Trade orders to evaluate.
   * @param {Array<Object>} priceList - Current position price entries.
   * @returns {Promise<Object>} Parsed JSON response from the API.
   * @throws {MarginApiError} On network error, timeout, non-OK HTTP status, or GraphQL errors.
   */
  async function doFetch(accountNum, orders, priceList) {
    const variables = buildVariables(accountNum, orders, priceList);
    const body = {
      operationName: 'GetTradeCalculator',
      variables,
      query: QUERY
    };

    const headers = {
      'accept': '*/*',
      'content-type': 'application/json',
      'apollographql-client-version': APOLLO_CLIENT_VERSION
    };

    const xsrf = getXsrfToken();
    if (xsrf) headers[XSRF_HEADER] = xsrf;

    debugLog(`POST ${ENDPOINT}`);
    debugLog(`Account: ${accountNum}, Orders: ${orders.length}` +
      `, balancesOnly: ${variables.tradeCalculatorInput.balancesOnlyInd}` +
      `, XSRF: ${xsrf ? 'present' : 'none'}`);

    let resp;
    try {
      resp = await fetchWithTimeout(ENDPOINT, {
        method: 'POST',
        headers,
        credentials: 'include',
        referrer: REFERRER,
        body: JSON.stringify(body)
      }, FETCH_TIMEOUT_MS);
    } catch (e) {
      if (e.isTimeout) {
        debugLog(`Request timed out after ${FETCH_TIMEOUT_MS}ms`);
        throw new MarginApiError(`Margin API request timed out ${API_ERR.TIMEOUT_SUFFIX}`, ErrorType.NETWORK_ERROR, { cause: e });
      }
      // Re-throw AbortError (from page navigation or extension context invalidation) without
      // wrapping it as NETWORK_ERROR. An un-typed error is not in RETRYABLE, so Retry.withBackoff
      // rethrows it immediately rather than waiting through the full backoff schedule (up to 7 s).
      if (e.name === 'AbortError') throw e;
      debugLog(`Network error: ${e.message}`);
      throw new MarginApiError(API_ERR.NETWORK_ERROR, ErrorType.NETWORK_ERROR, { cause: e });
    }

    debugLog(`Response: ${resp.status} ${resp.statusText}, redirected: ${resp.redirected}, url: ${resp.url}`);

    // Redirect to login = session expired
    if (isSessionExpiredResponse(resp)) {
      throw new MarginApiError(API_ERR.SESSION_EXPIRED, ErrorType.SESSION_EXPIRED);
    }

    if (!resp.ok) {
      let respBody = '';
      try { respBody = await resp.text(); } catch { /* ignore */ }
      debugLog(`Error body: ${respBody.slice(0, 500)}`);
      // classifyError returns NETWORK_ERROR, API_ERROR, or CLIENT_ERROR — never SESSION_EXPIRED.
      // Session expiry is already handled above by isSessionExpiredResponse().
      const err = new MarginApiError(`Margin API HTTP ${resp.status}: ${respBody.slice(0, 200)}`, classifyError(resp));
      // Attach a server-specified retry delay so withBackoff can honour it instead of
      // using the fixed jitter schedule — important for 429 Too Many Requests responses
      // where Fidelity signals exactly how long to wait before retrying.
      const retryAfterMs = parseRetryAfterMs(resp.headers.get('Retry-After'), MAX_RETRY_AFTER_MS);
      if (retryAfterMs > 0) err.retryAfterMs = retryAfterMs;
      throw err;
    }

    let data;
    try {
      data = await resp.json();
    } catch (e) {
      debugLog(`JSON parse error from margin API: ${e.message}`);
      throw new MarginApiError('Invalid response from margin API', ErrorType.PARSE_ERROR, { cause: e });
    }

    const sysMsgList = data?.data?.getTradeCalculator?.sysMsgs?.sysMsg;
    if (Array.isArray(sysMsgList) && sysMsgList.length > 0) {
      debugLog(`Margin API sysMsgs: ${sysMsgList.map(m => `[${m.type ?? '?'}/${m.code ?? '?'}] ${m.message ?? ''}${m.detail ? ` — ${m.detail}` : ''}`).join('; ')}`);
    }

    if (data.errors?.length > 0) {
      // Only throw when the balance data we actually use is absent.
      // Partial errors on non-critical fields (positions, optPairs, underlyingSecurities,
      // logos) are logged and ignored when balance is present — mirrors the approach in
      // positions.js which only throws when acctDetails is missing. This makes the
      // extension resilient to Fidelity returning partial GraphQL errors on fields we
      // don't need, rather than failing the whole calculation unnecessarily.
      const hasBalance = !!data?.data?.getTradeCalculator?.marginCalcResp?.balance;
      const nonLogoErrors = data.errors.filter(gqlErr =>
        !gqlErr.path || !gqlErr.path.includes('logos')
      );
      if (nonLogoErrors.length > 0) {
        const errorSummary = nonLogoErrors.map(e => e.message ?? '(no message)').join('; ');
        if (!hasBalance) {
          throw new MarginApiError(nonLogoErrors[0].message || 'GraphQL error from margin API', ErrorType.API_ERROR);
        }
        debugLog(`Non-critical GraphQL error(s) — balance data present, continuing: ${errorSummary}`);
      }
    }

    return data;
  }

  /**
   * Calls Fidelity's margin calculator GraphQL API with the given order and position data.
   * Retries automatically on network or server errors with exponential backoff.
   * @param {string} accountNum - Brokerage account number.
   * @param {Array<{orderSymbol: string, orderType: string, orderAction: string,
   *   orderQty: number, price: number}>} orders - Trade orders to evaluate.
   * @param {(attempt: number, maxAttempts: number, delayMs: number) => void} onRetry -
   *   Callback invoked before each retry attempt.
   * @param {Array<{symbol: string, cusip: string, priceInd: string, longShortInd: string,
   *   price: number, isCurrency: boolean}>} priceList - Current position prices from
   *   PositionsAPI.fetchPriceList. Must be non-empty — the API returns 400 for [].
   * @returns {Promise<Object>} Raw GraphQL response data.
   * @throws {MarginApiError} On session expiry, non-retryable error, or exhausted retries.
   */
  async function fetchMarginCalc(accountNum, orders, onRetry, priceList) {
    // Guard at the API boundary: the margin calculator API always returns 400 for empty
    // orders (confirmed in CLAUDE.md). Failing fast here avoids a wasted network round-trip
    // and produces a clearer CLIENT_ERROR message than the opaque "HTTP 400" the server returns.
    if (!accountNum) {
      throw new MarginApiError('accountNum is required', ErrorType.CLIENT_ERROR);
    }
    if (!Array.isArray(orders) || orders.length === 0) {
      throw new MarginApiError('orders must be a non-empty array', ErrorType.CLIENT_ERROR);
    }
    // Guard: the margin calculator API always returns 400 for an empty priceList (confirmed
    // in CLAUDE.md — same constraint as orders). Failing fast here avoids a wasted network
    // round-trip and produces a clearer CLIENT_ERROR rather than an opaque "HTTP 400" that
    // could be misclassified as a retryable API_ERROR. Mirrors the orders guard above.
    if (!Array.isArray(priceList) || priceList.length === 0) {
      throw new MarginApiError('priceList must be a non-empty array', ErrorType.CLIENT_ERROR);
    }
    return Retry.withBackoff(
      () => doFetch(accountNum, orders, priceList),
      RETRYABLE,
      onRetry
    );
  }

  return { fetchMarginCalc };
})();
