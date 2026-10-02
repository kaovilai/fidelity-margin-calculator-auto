// ChainAPI — read-only client for the margin calculator's option expiration and option chain
// endpoints (the same calls Fidelity's own margin calculator page makes). Used by the roll
// assistant and the trade-ticket roll helper. Responses are cached briefly: quotes move, but
// a handful of requests per roll search should not be repeated on every click.
'use strict';
const ChainAPI = (() => {
  const { ERROR_TYPES, API } = FMC_CONSTANTS;
  const TTL_MS = 45000;
  const TIMEOUT_MS = FMC_CONSTANTS.FETCH_TIMEOUT_MS.POSITIONS_API;
  const cache = new Map(); // url → { ts, data }
  const inflight = new Map();

  class ChainApiError extends FmcApiError {}

  async function getJson(url) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;
    if (inflight.has(url)) return inflight.get(url);
    const p = (async () => {
      let resp;
      try {
        resp = await fetchWithTimeout(url, { credentials: 'include', headers: { accept: '*/*' } }, TIMEOUT_MS);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw new ChainApiError(e.isTimeout ? 'Option chain request timed out' : 'Network error fetching option chain', ERROR_TYPES.NETWORK_ERROR, { cause: e });
      }
      if (isSessionExpiredResponse(resp)) throw new ChainApiError('Session expired', ERROR_TYPES.SESSION_EXPIRED);
      if (!resp.ok) {
        throw new ChainApiError(`Option chain HTTP ${resp.status}`, isRetryableHttpStatus(resp.status) ? ERROR_TYPES.API_ERROR : ERROR_TYPES.CLIENT_ERROR);
      }
      let data;
      try {
        data = JSON.parse(await resp.text());
      } catch (e) {
        const html = /text\/html/i.test(resp.headers.get('content-type') ?? '');
        throw new ChainApiError(html ? 'Fidelity returned an HTML page — it may be temporarily unavailable' : 'Invalid option chain response',
          html ? ERROR_TYPES.API_ERROR : ERROR_TYPES.PARSE_ERROR, { cause: e });
      }
      cache.set(url, { ts: Date.now(), data });
      return data;
    })().finally(() => inflight.delete(url));
    inflight.set(url, p);
    return p;
  }

  /**
   * Expirations available for an underlying.
   * @param {string} underlying
   * @returns {Promise<Array<{date: string, periodicity: string}>>} ISO dates, ascending.
   */
  async function fetchExpirations(underlying) {
    const data = await getJson(`${API.OPTION_EXPIRATIONS_ENDPOINT}?symbol=${encodeURIComponent(underlying)}`);
    const list = Array.isArray(data?.expirations) ? data.expirations : [];
    return list
      .filter(e => typeof e?.date === 'string')
      .map(e => ({ date: e.date, periodicity: e.optionPeriodicity || 'M' }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  /**
   * Full chain (all strikes, calls and puts) for one expiry.
   * @param {string} underlying
   * @param {{date: string, periodicity: string}} expiry
   * @returns {Promise<Object>} Raw `slo-chain/v1` response (see RollModel.chainRows).
   */
  async function fetchChain(underlying, expiry) {
    const q = new URLSearchParams({
      expirationDates: RollModel.usDate(expiry.date),
      settlementTypes: RollModel.settlementType(expiry.date, expiry.periodicity),
      symbol: underlying,
      adjustedOptionsData: 'true'
    });
    return getJson(`${API.OPTION_CHAIN_ENDPOINT}?${q}`);
  }

  /**
   * Underlying price per share: the bid/ask midpoint of the underlying's quote.
   * @param {string} symbol
   * @returns {Promise<number|null>}
   */
  async function fetchUnderlyingPrice(symbol) {
    const data = await getJson(`${API.QUOTES_ENDPOINT}?symbol=${encodeURIComponent(symbol)}`);
    const q = data?.quotes?.[0]?.quoteData;
    const bid = Number(q?.bidPrice);
    const ask = Number(q?.askPrice);
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) return (bid + ask) / 2;
    const last = Number(q?.lastPrice);
    return Number.isFinite(last) && last > 0 ? last : null;
  }

  /** Drops cached responses so the next call refetches live quotes. */
  function clear() { cache.clear(); }

  return { fetchExpirations, fetchChain, fetchUnderlyingPrice, clear };
})();
