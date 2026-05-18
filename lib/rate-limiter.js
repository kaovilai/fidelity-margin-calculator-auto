// RateLimiter — token bucket for API call throttling
const RateLimiter = (() => {
  const CAPACITY = FMC_CONSTANTS.RATE_LIMITER.CAPACITY;
  const REFILL_INTERVAL = FMC_CONSTANTS.RATE_LIMITER.REFILL_INTERVAL_MS;
  let tokens = CAPACITY;
  let lastRefill = Date.now();
  let pendingResolve = null;
  let refillTimer = null;

  function refill() {
    const now = Date.now();
    const elapsed = now - lastRefill;
    const newTokens = Math.floor(elapsed / REFILL_INTERVAL);
    if (newTokens > 0) {
      tokens = Math.min(CAPACITY, tokens + newTokens);
      lastRefill += newTokens * REFILL_INTERVAL;
    }
  }

  /**
   * Acquires a rate-limiter token, waiting until one is available if the bucket is empty.
   * Only one waiter is queued at a time — a new call cancels any previously waiting promise.
   * @returns {Promise<{waited: boolean, waitMs?: number, cancelled?: boolean}>}
   *   waited: false if a token was immediately available; true if this call waited.
   *   cancelled: true if a newer acquire() call displaced this one while waiting.
   */
  function acquire() {
    refill();
    if (tokens > 0) {
      tokens--;
      return Promise.resolve({ waited: false });
    }
    // Wait for next token
    const waitMs = REFILL_INTERVAL - (Date.now() - lastRefill);
    return new Promise((resolve) => {
      // Cancel any previous pending waiter (only latest request matters)
      if (pendingResolve) pendingResolve({ waited: true, cancelled: true });
      pendingResolve = resolve;
      clearTimeout(refillTimer);
      refillTimer = setTimeout(() => {
        refill();
        // Guard against timers firing slightly early (browser precision ±few ms):
        // the timer contract guarantees at least one token is available to the waiter.
        if (tokens <= 0) tokens = 1;
        tokens--;
        pendingResolve = null;
        resolve({ waited: true, waitMs });
      }, Math.max(waitMs, 100));
    });
  }

  /**
   * Returns the current number of available tokens after applying any elapsed refills.
   * @returns {number}
   */
  function getTokens() {
    refill();
    return tokens;
  }

  return { acquire, getTokens };
})();
