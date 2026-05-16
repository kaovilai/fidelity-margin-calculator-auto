// MarginAPI — GraphQL client for Fidelity's margin calculator
// Includes error classification and retry with exponential backoff
const MarginAPI = (() => {
  const ENDPOINT = '/ftgw/digital/margincalcex/api/graphql?op=GetTradeCalculator';

  const ErrorType = {
    SESSION_EXPIRED: 'SESSION_EXPIRED',
    NETWORK_ERROR: 'NETWORK_ERROR',
    API_ERROR: 'API_ERROR',
    CLIENT_ERROR: 'CLIENT_ERROR',
    PARSE_ERROR: 'PARSE_ERROR'
  };

  const RETRY_DELAYS = [1000, 2000, 4000];
  const RETRYABLE = new Set([ErrorType.NETWORK_ERROR, ErrorType.API_ERROR]);

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
        priceList: priceList || []
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
  function getXsrfToken() {
    const cookies = document.cookie.split(';');
    for (const cookie of cookies) {
      const [name, ...rest] = cookie.trim().split('=');
      if (name === 'MARGIN-CALCULATOR-XSRF-TOKEN') {
        return rest.join('=');
      }
    }
    return null;
  }

  // Classify error type from response or exception
  function classifyError(err, resp) {
    if (!resp) return ErrorType.NETWORK_ERROR;
    if (resp.redirected && resp.url && resp.url.includes('login.fidelity.com')) {
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

  function debugLog(msg) {
    console.log('[FMC-API]', msg);
    if (typeof MarginInjector !== 'undefined' && MarginInjector.addDebugLog) {
      MarginInjector.addDebugLog(msg);
    }
  }

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

    debugLog('POST ' + ENDPOINT);
    debugLog('Account: ' + accountNum + ', Orders: ' + orders.length +
      ', balancesOnly: ' + variables.tradeCalculatorInput.balancesOnlyInd +
      ', XSRF: ' + (xsrf ? xsrf.slice(0, 8) + '...' : 'none'));

    let resp;
    try {
      resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers,
        credentials: 'include',
        referrer: REFERRER,
        body: JSON.stringify(body)
      });
    } catch (e) {
      debugLog('Network error: ' + e.message);
      throw new MarginApiError('Network error — check your connection', ErrorType.NETWORK_ERROR);
    }

    debugLog('Response: ' + resp.status + ' ' + resp.statusText +
      ', redirected: ' + resp.redirected + ', url: ' + resp.url);

    // Redirect to login = session expired
    if (resp.redirected && resp.url && resp.url.includes('login.fidelity.com')) {
      throw new MarginApiError('Session expired — please log in to Fidelity', ErrorType.SESSION_EXPIRED);
    }

    if (!resp.ok) {
      let respBody = '';
      try { respBody = await resp.text(); } catch { /* ignore */ }
      debugLog('Error body: ' + respBody.slice(0, 500));
      const errType = classifyError(null, resp);
      if (errType === ErrorType.SESSION_EXPIRED) {
        throw new MarginApiError('Session expired — please log in to Fidelity', errType);
      }
      throw new MarginApiError('Margin API HTTP ' + resp.status + ': ' + respBody.slice(0, 200), errType);
    }

    let data;
    try {
      data = await resp.json();
    } catch (e) {
      throw new MarginApiError('Invalid response from margin API', ErrorType.PARSE_ERROR);
    }

    if (data.errors && data.errors.length > 0) {
      const nonLogoErrors = data.errors.filter(e =>
        !e.path || !e.path.includes('logos')
      );
      if (nonLogoErrors.length > 0) {
        throw new MarginApiError(nonLogoErrors[0].message, ErrorType.API_ERROR);
      }
    }

    return data;
  }

  // Retry wrapper with exponential backoff + jitter
  async function fetchWithRetry(accountNum, orders, onRetry, priceList) {
    let lastErr;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        return await doFetch(accountNum, orders, priceList);
      } catch (err) {
        lastErr = err;
        // Don't retry non-retryable errors
        if (!RETRYABLE.has(err.type)) throw err;
        // Don't retry if we've exhausted attempts
        if (attempt >= RETRY_DELAYS.length) throw err;

        const delay = RETRY_DELAYS[attempt] * (0.5 + Math.random());
        if (onRetry) onRetry(attempt + 1, RETRY_DELAYS.length, Math.round(delay));
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  async function fetchMarginCalc(accountNum, orders, onRetry, priceList) {
    return fetchWithRetry(accountNum, orders, onRetry, priceList);
  }

  return { fetchMarginCalc, buildVariables, ErrorType };
})();
