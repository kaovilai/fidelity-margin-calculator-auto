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

  // Returns a Promise that resolves when a token is available.
  // If tokens available, resolves immediately.
  // If not, waits until next refill.
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
        if (tokens > 0) tokens--;
        pendingResolve = null;
        resolve({ waited: true, waitMs });
      }, Math.max(waitMs, 100));
    });
  }

  function getTokens() {
    refill();
    return tokens;
  }

  return { acquire, getTokens };
})();
