// MarginAPI — client for Fidelity's margin calculator trade-calculator API
// Includes error classification and retry with exponential backoff
'use strict';
const MarginAPI = (() => {
  const ENDPOINT = FMC_CONSTANTS.API.MARGIN_CALC_ENDPOINT;

  const ErrorType = FMC_CONSTANTS.ERROR_TYPES;

  const RETRYABLE = new Set(FMC_CONSTANTS.RETRYABLE_ERROR_TYPES);
  const FETCH_TIMEOUT_MS = FMC_CONSTANTS.FETCH_TIMEOUT_MS.MARGIN_API;
  const MAX_RETRY_AFTER_MS = FMC_CONSTANTS.MAX_RETRY_AFTER_MS;
  const API_ERR = FMC_CONSTANTS.API_ERROR_MESSAGES;

  /**
   * Builds the JSON request body for the margin calculator trade-calculator API.
   * @param {string} accountNum - Brokerage account number.
   * @param {Array<Object>} orders - Trade orders to evaluate.
   * @param {Array<Object>} priceList - Current position price entries.
   * @returns {Object} Request body.
   */
  function buildBody(accountNum, orders, priceList) {
    const cfg = FMC_CONSTANTS.MARGIN_API_CONFIG;
    return {
      accountNum,
      executeOpenOrdersInd: cfg.EXECUTE_OPEN_ORDERS_IND,
      priceSourceInd:       cfg.PRICE_SOURCE_IND,
      executeHpoTxnsInd:    cfg.EXECUTE_HPO_TXNS_IND,
      balancesOnlyInd:      cfg.BALANCES_ONLY_IND,
      rbrAddonsInd:         cfg.RBR_ADDONS_IND,
      tradeOrders: { orders },
      priceList: priceList ?? []
    };
  }

  // Margin calculator referrer — server validates Referer header matches this path.
  // Without it, requests from other Fidelity pages (portfolio, trade) get 400.
  const REFERRER = FMC_CONSTANTS.API.MARGIN_CALC_REFERRER;

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
   * Performs a single fetch call to the margin calculator trade-calculator API.
   * Does not retry — callers use `fetchMarginCalc` (via `Retry.withBackoff`) for retry logic.
   * @param {string} accountNum - Brokerage account number.
   * @param {Array<Object>} orders - Trade orders to evaluate.
   * @param {Array<Object>} priceList - Current position price entries.
   * @returns {Promise<Object>} Parsed JSON response from the API.
   * @throws {MarginApiError} On network error, timeout, non-OK HTTP status, or GraphQL errors.
   */
  async function doFetch(accountNum, orders, priceList) {
    const body = buildBody(accountNum, orders, priceList);

    const headers = {
      'accept': '*/*',
      'content-type': 'application/json'
    };

    const xsrf = getXsrfToken();
    if (xsrf) headers[XSRF_HEADER] = xsrf;

    debugLog(`POST ${ENDPOINT}`);
    debugLog(`Account: ${accountNum}, Orders: ${orders.length}` +
      `, balancesOnly: ${body.balancesOnlyInd}` +
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
      // Transient server errors get a plain-language message (the body stays in the debug log above);
      // other statuses keep the status + a short body excerpt for diagnosis.
      const err = new MarginApiError(
        friendlyHttpMessage(resp.status, "Fidelity's margin calculator") ?? `Margin API HTTP ${resp.status}: ${respBody.slice(0, 200)}`,
        classifyError(resp)
      );
      // Attach a server-specified retry delay so withBackoff can honour it instead of
      // using the fixed jitter schedule — important for 429 Too Many Requests responses
      // where Fidelity signals exactly how long to wait before retrying.
      const retryAfterMs = parseRetryAfterMs(resp.headers.get('Retry-After'), MAX_RETRY_AFTER_MS);
      if (retryAfterMs > 0) err.retryAfterMs = retryAfterMs;
      throw err;
    }

    let data;
    let rawBody = '';
    try {
      rawBody = await resp.text();
      data = JSON.parse(rawBody);
    } catch (e) {
      debugLog(`JSON parse error from margin API: ${e.message} (${describeNonJsonResponse(resp, rawBody)})`);
      // Fidelity serves its maintenance/outage page as HTML with a 2xx status — transient, so
      // retryable API_ERROR rather than a PARSE_ERROR implying the response format changed.
      if (/text\/html/i.test(resp.headers.get('content-type') ?? '')) {
        throw new MarginApiError('Fidelity margin API returned an HTML page — Fidelity may be temporarily unavailable', ErrorType.API_ERROR, { cause: e });
      }
      throw new MarginApiError('Invalid response from margin API', ErrorType.PARSE_ERROR, { cause: e });
    }

    const sysMsgList = data?.data?.getTradeCalculator?.sysMsgs?.sysMsg;
    if (Array.isArray(sysMsgList) && sysMsgList.length > 0) {
      debugLog(`Margin API sysMsgs: ${formatSysMsgs(sysMsgList)}`);
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

    // A 200 without a balance carries Fidelity's reason in `messages` (e.g. 1030 "HYPOTHETICAL
    // TRADE PRICE IS 0") — surface it instead of letting callers show a generic "no data".
    if (!data?.data?.getTradeCalculator?.marginCalcResp?.balance) {
      const msgs = data?.data?.getTradeCalculator?.messages;
      if (Array.isArray(msgs) && msgs.length > 0) {
        const text = msgs.map(m => `${m.code ?? '?'} ${String(m.message ?? '').trim()}`).join('; ');
        debugLog(`Margin API returned no balance — messages: ${text}`);
        throw new MarginApiError(`Fidelity's margin calculator: ${text}`, ErrorType.CLIENT_ERROR);
      }
    }

    return data;
  }

  /**
   * Market orders (price 0, e.g. the legs Fidelity's Roll button pre-fills) are rejected by the
   * calculator ("HYPOTHETICAL TRADE PRICE IS 0"). Price them instead: a held position takes its
   * current mark from the priceList; an option you don't hold (a roll's new leg) takes the
   * bid/ask midpoint from the option chain. A leg that can't be priced is left at 0, so Fidelity's
   * own message is shown. Returns a new array; the input is not mutated.
   * @param {Array<Object>} orders
   * @param {Array<Object>} priceList
   * @returns {Promise<Array<Object>>}
   */
  async function withMarketPrices(orders, priceList) {
    return Promise.all(orders.map(async o => {
      if (Number(o.price) > 0) return o;
      const sym = String(o.orderSymbol ?? '').replace(/^-/, '');
      const mark = priceList.find(e => e.symbol === sym)?.price;
      if (Number.isFinite(mark) && mark > 0) return { ...o, price: mark };
      const mid = o.orderType === 'O' ? await chainMid(sym) : null;
      return mid ? { ...o, price: mid } : o;
    }));
  }

  /**
   * Prices the legs of a net-priced multi-leg order (orders carrying `netPrice`: + credit, − debit).
   * Every leg starts at its market reference (held mark or chain midpoint); the opening leg (else the
   * last leg) is then shifted so that sell proceeds − buy cost equals the ticket's net amount. Falls
   * back to plain market pricing when a leg has no reference price.
   * @param {Array<Object>} orders
   * @param {Array<Object>} priceList
   * @returns {Promise<Array<Object>>}
   */
  async function priceNetLegs(orders, priceList) {
    const net = orders[0].netPrice;
    const refs = await withMarketPrices(orders.map(o => ({ ...o, price: 0 })), priceList);
    if (refs.some(o => !(o.price > 0))) return refs;
    const sign = (o) => (String(o.orderAction).startsWith('S') ? 1 : -1);
    const target = net * orders[0].orderQty;
    const current = refs.reduce((t, o) => t + sign(o) * o.orderQty * o.price, 0);
    let i = refs.map(o => /^[SB]O$/.test(o.orderAction)).lastIndexOf(true);
    if (i < 0) i = refs.length - 1;
    const adjusted = refs[i].price + (target - current) / (sign(refs[i]) * refs[i].orderQty);
    return refs.map((o, k) => (k === i ? { ...o, price: Math.max(0.01, Math.round(adjusted * 100) / 100) } : o));
  }

  /** Bid/ask midpoint of one option from the chain endpoint, or null if unavailable. */
  async function chainMid(sym) {
    try {
      const opt = RollModel.parseOcc(sym);
      if (!opt) return null;
      const exp = (await ChainAPI.fetchExpirations(opt.underlying)).find(e => e.date === opt.expiry);
      if (!exp) return null;
      const row = RollModel.chainRows(await ChainAPI.fetchChain(opt.underlying, exp), opt.type)
        .find(r => r.symbol.replace(/^-/, '') === sym);
      if (!row || !(row.bid > 0 || row.ask > 0)) return null;
      const mid = row.bid > 0 && row.ask > 0 ? (row.bid + row.ask) / 2 : (row.bid || row.ask);
      return Math.round(mid * 100) / 100;
    } catch (err) {
      debugLog(`Chain price lookup failed for ${sym}: ${err.message}`);
      return null;
    }
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
    // `netPrice` is the ticket's single net amount for multi-leg orders — resolved into leg prices
    // here and never sent to Fidelity.
    const priced = (orders.length > 1 && orders.every(o => Number.isFinite(o.netPrice))
      ? await priceNetLegs(orders, priceList)
      : await withMarketPrices(orders, priceList)).map(({ netPrice, ...order }) => order);
    return Retry.withBackoff(
      () => doFetch(accountNum, priced, priceList),
      RETRYABLE,
      onRetry
    );
  }

  return { fetchMarginCalc };
})();
