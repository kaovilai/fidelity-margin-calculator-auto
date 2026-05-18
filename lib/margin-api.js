// MarginAPI — GraphQL client for Fidelity's margin calculator
// Includes error classification and retry with exponential backoff
const MarginAPI = (() => {
  const ENDPOINT = FMC_CONSTANTS.API.MARGIN_CALC_ENDPOINT;

  const ErrorType = FMC_CONSTANTS.ERROR_TYPES;

  const RETRYABLE = new Set([ErrorType.NETWORK_ERROR, ErrorType.API_ERROR]);
  const FETCH_TIMEOUT_MS = FMC_CONSTANTS.FETCH_TIMEOUT_MS.MARGIN_API;

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

  function buildVariables(accountNum, orders, priceList) {
    return {
      tradeCalculatorInput: {
        accountNum,
        executeOpenOrdersInd: false,
        priceSourceInd: 'S',
        executeHpoTxnsInd: true,
        balancesOnlyInd: false,
        rbrAddonsInd: true,
        tradeOrders: { orders },
        priceList: priceList ?? []
      }
    };
  }

  // Margin calculator referrer — server validates Referer header matches this path.
  // Without it, requests from other Fidelity pages (portfolio, trade) get 400.
  const REFERRER = FMC_CONSTANTS.API.MARGIN_CALC_REFERRER;
  const APOLLO_CLIENT_VERSION = FMC_CONSTANTS.API.APOLLO_CLIENT_VERSION;

  // Read MARGIN-CALCULATOR-XSRF-TOKEN from cookies.
  // Only returns the margin-calculator-specific token, NOT the generic XSRF-TOKEN.
  // The specific cookie is path-scoped to /ftgw/digital/margincalcex/ so it may
  // not be readable from other pages via document.cookie. In that case, return null
  // and skip the header — the working sample doesn't send X-XSRF-TOKEN at all.
  const XSRF_COOKIE_NAME = 'MARGIN-CALCULATOR-XSRF-TOKEN=';
  function getXsrfToken() {
    return document.cookie.split('; ').find(c => c.startsWith(XSRF_COOKIE_NAME))?.slice(XSRF_COOKIE_NAME.length) ?? null;
  }

  // Classify error type from a non-OK HTTP response.
  // Session-expired responses are handled by callers before reaching this function.
  function classifyError(resp) {
    if (!resp) return ErrorType.NETWORK_ERROR;
    if (isRetryableHttpStatus(resp.status)) return ErrorType.API_ERROR;
    if (resp.status >= 400) return ErrorType.CLIENT_ERROR;
    return ErrorType.API_ERROR;
  }

  class MarginApiError extends Error {
    constructor(message, type) {
      super(message);
      this.type = type;
      this.name = 'MarginApiError';
    }
  }

  const debugLog = makeDebugLog('[FMC-API]');

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
    if (xsrf) headers['X-XSRF-TOKEN'] = xsrf;

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
        throw new MarginApiError('Margin API request timed out — Fidelity may be slow', ErrorType.NETWORK_ERROR);
      }
      debugLog(`Network error: ${e.message}`);
      throw new MarginApiError('Network error — check your connection', ErrorType.NETWORK_ERROR);
    }

    debugLog(`Response: ${resp.status} ${resp.statusText}, redirected: ${resp.redirected}, url: ${resp.url}`);

    // Redirect to login = session expired
    if (isSessionExpiredResponse(resp)) {
      throw new MarginApiError('Session expired — please log in to Fidelity', ErrorType.SESSION_EXPIRED);
    }

    if (!resp.ok) {
      let respBody = '';
      try { respBody = await resp.text(); } catch { /* ignore */ }
      debugLog(`Error body: ${respBody.slice(0, 500)}`);
      // classifyError returns NETWORK_ERROR, API_ERROR, or CLIENT_ERROR — never SESSION_EXPIRED.
      // Session expiry is already handled above by isSessionExpiredResponse().
      throw new MarginApiError(`Margin API HTTP ${resp.status}: ${respBody.slice(0, 200)}`, classifyError(resp));
    }

    let data;
    try {
      data = await resp.json();
    } catch (e) {
      debugLog(`JSON parse error from margin API: ${e.message}`);
      throw new MarginApiError('Invalid response from margin API', ErrorType.PARSE_ERROR);
    }

    if (data.errors?.length > 0) {
      const nonLogoErrors = data.errors.filter(gqlErr =>
        !gqlErr.path || !gqlErr.path.includes('logos')
      );
      if (nonLogoErrors.length > 0) {
        throw new MarginApiError(nonLogoErrors[0].message || 'GraphQL error from margin API', ErrorType.API_ERROR);
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
   *   PositionsAPI.fetchPriceList.
   * @returns {Promise<Object>} Raw GraphQL response data.
   * @throws {MarginApiError} On session expiry, non-retryable error, or exhausted retries.
   */
  async function fetchMarginCalc(accountNum, orders, onRetry, priceList) {
    return Retry.withBackoff(
      () => doFetch(accountNum, orders, priceList),
      RETRYABLE,
      onRetry
    );
  }

  return { fetchMarginCalc };
})();
