// Shared retry utility — exponential backoff with jitter
// Used by margin-api.js and positions.js to avoid duplicating retry logic.
const Retry = (() => {
  const DELAYS = [1000, 2000, 4000]; // ms between attempts
  const JITTER_BASE = 0.5; // multiplier range: [0.5, 1.5) to spread concurrent retries

  // Retry fn() up to DELAYS.length extra times on retryable errors.
  // retryable: Set of error.type strings that should trigger a retry
  // onRetry(attempt, maxAttempts, delayMs): optional callback invoked before each retry
  async function withBackoff(fn, retryable, onRetry) {
    for (let attempt = 0; attempt <= DELAYS.length; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!retryable.has(err.type)) throw err;
        if (attempt >= DELAYS.length) throw err;
        const delay = DELAYS[attempt] * (JITTER_BASE + Math.random());
        if (onRetry) onRetry(attempt + 1, DELAYS.length, Math.round(delay));
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  return { withBackoff, DELAYS };
})();
