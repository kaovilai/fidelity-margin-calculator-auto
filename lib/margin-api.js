// MarginAPI — GraphQL client for Fidelity's margin calculator
// Includes error classification and retry with exponential backoff
const MarginAPI = (() => {
  const ENDPOINT = '/ftgw/digital/margincalcex/api/graphql?op=GetTradeCalculator';

  const ErrorType = Object.freeze({
    SESSION_EXPIRED: 'SESSION_EXPIRED',
    NETWORK_ERROR: 'NETWORK_ERROR',
    API_ERROR: 'API_ERROR',
    CLIENT_ERROR: 'CLIENT_ERROR',
    PARSE_ERROR: 'PARSE_ERROR'
  });

  const RETRYABLE = new Set([ErrorType.NETWORK_ERROR, ErrorType.API_ERROR]);
  const FETCH_TIMEOUT_MS = 15000; // abort if no response within 15s

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
  const REFERRER = 'https://digital.fidelity.com/ftgw/digital/margincalcex/';

  // Read MARGIN-CALCULATOR-XSRF-TOKEN from cookies.
  // Only returns the margin-calculator-specific token, NOT the generic XSRF-TOKEN.
  // The specific cookie is path-scoped to /ftgw/digital/margincalcex/ so it may
  // not be readable from other pages via document.cookie. In that case, return null
  // and skip the header — the working sample doesn't send X-XSRF-TOKEN at all.
  const XSRF_COOKIE_NAME = 'MARGIN-CALCULATOR-XSRF-TOKEN=';
  function getXsrfToken() {
    return document.cookie.split('; ').find(c => c.startsWith(XSRF_COOKIE_NAME))?.slice(XSRF_COOKIE_NAME.length) ?? null;
  }

  // Classify error type from HTTP response
  function classifyError(resp) {
    if (!resp) return ErrorType.NETWORK_ERROR;
    if (resp.redirected && resp.url?.includes('login.fidelity.com')) {
      return ErrorType.SESSION_EXPIRED;
    }
    if (resp.status === 401 || resp.status === 403) return ErrorType.SESSION_EXPIRED;
    if (resp.status === 429) return ErrorType.API_ERROR; // rate limited by server
    if (resp.status >= 500) return ErrorType.API_ERROR;
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
      variables: variables,
      query: QUERY
    };

    const headers = {
      'accept': '*/*',
      'content-type': 'application/json',
      'apollographql-client-version': '0.0.0'
    };

    const xsrf = getXsrfToken();
    if (xsrf) headers['X-XSRF-TOKEN'] = xsrf;

    debugLog(`POST ${ENDPOINT}`);
    debugLog(`Account: ${accountNum}, Orders: ${orders.length}` +
      `, balancesOnly: ${variables.tradeCalculatorInput.balancesOnlyInd}` +
      `, XSRF: ${xsrf ? 'present' : 'none'}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let resp;
    try {
      resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers,
        credentials: 'include',
        referrer: REFERRER,
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        debugLog(`Request timed out after ${FETCH_TIMEOUT_MS}ms`);
        throw new MarginApiError('Margin API request timed out — Fidelity may be slow', ErrorType.NETWORK_ERROR);
      }
      debugLog(`Network error: ${e.message}`);
      throw new MarginApiError('Network error — check your connection', ErrorType.NETWORK_ERROR);
    } finally {
      clearTimeout(timeoutId);
    }

    debugLog(`Response: ${resp.status} ${resp.statusText}, redirected: ${resp.redirected}, url: ${resp.url}`);

    // Redirect to login = session expired
    if (resp.redirected && resp.url?.includes('login.fidelity.com')) {
      throw new MarginApiError('Session expired — please log in to Fidelity', ErrorType.SESSION_EXPIRED);
    }

    if (!resp.ok) {
      let respBody = '';
      try { respBody = await resp.text(); } catch { /* ignore */ }
      debugLog(`Error body: ${respBody.slice(0, 500)}`);
      const errType = classifyError(resp);
      if (errType === ErrorType.SESSION_EXPIRED) {
        throw new MarginApiError('Session expired — please log in to Fidelity', errType);
      }
      throw new MarginApiError(`Margin API HTTP ${resp.status}: ${respBody.slice(0, 200)}`, errType);
    }

    let data;
    try {
      data = await resp.json();
    } catch (e) {
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

  async function fetchMarginCalc(accountNum, orders, onRetry, priceList) {
    return Retry.withBackoff(
      () => doFetch(accountNum, orders, priceList),
      RETRYABLE,
      onRetry
    );
  }

  return { fetchMarginCalc, buildVariables, ErrorType };
})();
