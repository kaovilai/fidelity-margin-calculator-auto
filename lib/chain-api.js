// ChainAPI — read-only client for the margin calculator's option expiration and option chain
// endpoints (the same calls Fidelity's own margin calculator page makes). Used by the roll
// assistant and the trade-ticket roll helper. Responses are cached briefly: quotes move, but
// a handful of requests per roll search should not be repeated on every click.
'use strict';
const ChainAPI = (() => {
  const { ERROR_TYPES, API } = FMC_CONSTANTS;
  const TTL_MS = 45000;               // fresh
  const STALE_MAX_MS = 30 * 60 * 1000; // last good data may be served this long when Fidelity errors
  const COOLDOWN_MS = 15000;          // after a failed fetch (retries exhausted), don't re-hit the URL
  const TIMEOUT_MS = FMC_CONSTANTS.FETCH_TIMEOUT_MS.POSITIONS_API;
  const RETRYABLE = new Set(FMC_CONSTANTS.RETRYABLE_ERROR_TYPES);
  const cache = new Map();    // url → { ts (fresh-until basis), savedAt, data }
  const inflight = new Map();
  const failedAt = new Map(); // url → time of the last exhausted failure
  let staleServed = false;

  class ChainApiError extends FmcApiError {}

  /** One attempt. 5xx/408/429 and network failures are typed retryable (honouring Retry-After). */
  async function fetchOnce(url) {
    let resp;
    try {
      resp = await fetchWithTimeout(url, { credentials: 'include', headers: { accept: '*/*' } }, TIMEOUT_MS);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new ChainApiError(e.isTimeout ? "Fidelity's option data took too long to respond — try again in a moment." : 'Network error fetching option data — check your connection.', ERROR_TYPES.NETWORK_ERROR, { cause: e });
    }
    if (isSessionExpiredResponse(resp)) throw new ChainApiError('Session expired — please log in to Fidelity', ERROR_TYPES.SESSION_EXPIRED);
    if (!resp.ok) {
      const retryable = isRetryableHttpStatus(resp.status);
      const err = new ChainApiError(
        friendlyHttpMessage(resp.status, "Fidelity's option data service") ?? `Option data request failed (HTTP ${resp.status})`,
        retryable ? ERROR_TYPES.API_ERROR : ERROR_TYPES.CLIENT_ERROR
      );
      const retryAfterMs = parseRetryAfterMs(resp.headers.get('Retry-After'), FMC_CONSTANTS.MAX_RETRY_AFTER_MS);
      if (retryAfterMs > 0) err.retryAfterMs = retryAfterMs;
      throw err;
    }
    try {
      return JSON.parse(await resp.text());
    } catch (e) {
      const html = /text\/html/i.test(resp.headers.get('content-type') ?? '');
      throw new ChainApiError(html ? "Fidelity's option data is temporarily unavailable — try again in a minute." : 'Invalid option data response',
        html ? ERROR_TYPES.API_ERROR : ERROR_TYPES.PARSE_ERROR, { cause: e });
    }
  }

  async function getJson(url) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;
    if (inflight.has(url)) return inflight.get(url);
    const p = (async () => {
      try {
        const cooling = failedAt.has(url) && Date.now() - failedAt.get(url) < COOLDOWN_MS;
        if (cooling) throw new ChainApiError("Fidelity's option data service is still having trouble — retrying shortly.", ERROR_TYPES.API_ERROR);
        const data = await Retry.withBackoff(() => fetchOnce(url), RETRYABLE);
        cache.set(url, { ts: Date.now(), savedAt: Date.now(), data });
        failedAt.delete(url);
        return data;
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        if (RETRYABLE.has(err?.type) && !failedAt.has(url)) failedAt.set(url, Date.now());
        // Serve the last good data (flagged) rather than failing outright.
        if (RETRYABLE.has(err?.type) && hit && Date.now() - hit.savedAt < STALE_MAX_MS) {
          staleServed = true;
          return hit.data;
        }
        throw err;
      }
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

  /**
   * Marks cached responses stale so the next call refetches live quotes — but keeps the data, so a
   * failing refetch can still fall back to the last good response.
   */
  function clear() {
    for (const entry of cache.values()) entry.ts = 0;
    failedAt.clear();
  }

  /** True if any response since the last call was served from stale cache because Fidelity errored. */
  function consumeStale() {
    const was = staleServed;
    staleServed = false;
    return was;
  }

  return { fetchExpirations, fetchChain, fetchUnderlyingPrice, clear, consumeStale };
})();
