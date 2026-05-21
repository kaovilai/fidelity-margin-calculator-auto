// Shared retry utility — exponential backoff with jitter
// Used by margin-api.js and positions.js to avoid duplicating retry logic.
'use strict';
const Retry = (() => {
  const DELAYS = FMC_CONSTANTS.RETRY.DELAYS;       // ms between attempts: [1000, 2000, 4000]
  const JITTER_BASE = FMC_CONSTANTS.RETRY.JITTER_BASE; // multiplier range: [0.5, 1.5) to spread concurrent retries

  /**
   * Retries an async function with exponential backoff + jitter.
   * @param {() => Promise<*>} fn - The async function to execute.
   * @param {Set<string>} retryable - Set of error.type strings that trigger a retry.
   * @param {(attempt: number, maxAttempts: number, delayMs: number) => void} [onRetry] -
   *   Optional callback invoked before each retry with the attempt number, max attempts,
   *   and actual delay in ms.
   * @returns {Promise<*>} Resolves with fn()'s return value, or rejects with the last error
   *   when all retries are exhausted or the error is not in the retryable set.
   */
  async function withBackoff(fn, retryable, onRetry) {
    for (let attempt = 0; attempt <= DELAYS.length; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!retryable.has(err?.type)) throw err;
        if (attempt >= DELAYS.length) throw err;
        // If the server sent a `Retry-After` header, honour it exactly (no extra jitter —
        // the server has told us the minimum wait; adding jitter would not help and could
        // exceed the intended window). Fall back to the normal jitter schedule otherwise.
        const serverDelay = (typeof err.retryAfterMs === 'number' && err.retryAfterMs > 0) ? err.retryAfterMs : 0;
        const delay = serverDelay > 0 ? serverDelay : DELAYS[attempt] * (JITTER_BASE + Math.random());
        onRetry?.(attempt + 1, DELAYS.length, Math.round(delay));
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  return { withBackoff };
})();
