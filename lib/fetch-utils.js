// Shared fetch utilities used by lib/positions.js and lib/margin-api.js
'use strict';

/**
 * Wraps fetch() with an AbortSignal.timeout()-based timeout.
 * On timeout, throws an Error with isTimeout=true so callers can produce
 * their own typed error messages without duplicating timeout boilerplate.
 * On any other network failure, re-throws the original error unchanged.
 *
 * Uses AbortSignal.timeout() (Chrome 103+, covered by manifest minimum_chrome_version 111)
 * instead of AbortController + clearTimeout: the timeout fires as a TimeoutError, while
 * external aborts (page navigation, extension context invalidation) remain AbortError,
 * making the two cases trivially distinguishable without manual cleanup.
 *
 * @param {string} url - Request URL.
 * @param {RequestInit} options - fetch() options; signal is overridden internally.
 * @param {number} timeoutMs - Timeout in milliseconds.
 * @returns {Promise<Response>}
 * @throws {Error & {isTimeout: true}} When the request exceeds timeoutMs.
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e.name === 'TimeoutError') {
      // AbortSignal.timeout() fired — report as a timeout so callers can show a specific message.
      const err = new Error(`Request timed out after ${timeoutMs}ms`);
      err.isTimeout = true;
      throw err;
    }
    // External AbortError (e.g., page navigation or extension context invalidation)
    // or other network failure — re-throw as-is so callers handle it correctly.
    throw e;
  }
}

/**
 * Parses a `Retry-After` response header to milliseconds.
 * Handles both RFC 7231 forms:
 *  - Numeric seconds: `Retry-After: 30` or `Retry-After: 1.5`
 *  - HTTP-date:       `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`
 * Returns 0 for absent, unparseable, or non-positive values so callers can treat
 * 0 as "no server-specified delay". Values above `maxMs` are clamped to `maxMs`
 * so the server's intent is honoured up to our configured ceiling — e.g.
 * `Retry-After: 3600` with `maxMs=30000` waits 30 s rather than ignoring the
 * header and retrying after the normal 1 s jitter schedule.
 * @param {string|null} header - Raw `Retry-After` header value, or null if absent.
 * @param {number} maxMs - Maximum allowed delay in milliseconds; values above this are clamped to maxMs.
 * @returns {number} Delay in milliseconds (> 0), or 0 if not applicable.
 */
function parseRetryAfterMs(header, maxMs) {
  if (!header) return 0;
  // Numeric-seconds form (RFC 7231 §7.1.3) — parseFloat handles fractional values.
  const secs = parseFloat(header);
  if (Number.isFinite(secs) && secs > 0) {
    return Math.min(secs * 1000, maxMs);
  }
  // HTTP-date form (RFC 7231 §7.1.3) — e.g. "Wed, 21 Oct 2026 07:28:00 GMT".
  // new Date() returns an invalid Date for unrecognised strings, guarded by isNaN.
  const date = new Date(header);
  if (!isNaN(date.getTime())) {
    const delayMs = date.getTime() - Date.now();
    if (delayMs > 0) return Math.min(delayMs, maxMs);
  }
  return 0;
}


/**
 * Returns `true` if `status` is an HTTP status code
 * that is worth retrying: 408 Request Timeout, 429 Too Many Requests, or any 5xx.
 * Used by both margin-api.js and positions.js to classify retryable errors.
 * @param {number} status - HTTP status code.
 * @returns {boolean}
 */
function isRetryableHttpStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Formats a `sysMsgs.sysMsg` array from a Fidelity GraphQL response into a
 * single-line debug string.  Used by both `margin-api.js` and `positions.js`
 * so that a future change to the log format (e.g. adding severity) only
 * requires a single edit here rather than two identical changes.
 *
 * Example output:
 *   "[INFO/1234] Account flagged for review — margin requirements may differ"
 *
 * @param {Array<{type?: string, code?: string, message?: string, detail?: string}>} sysMsgList
 *   Array of sysMsg objects from the API response.
 * @returns {string} Semicolon-separated formatted entries, one per message.
 */
function formatSysMsgs(sysMsgList) {
  return sysMsgList
    .map(m => `[${m.type ?? '?'}/${m.code ?? '?'}] ${m.message ?? ''}${m.detail ? ` \u2014 ${m.detail}` : ''}`)
    .join('; ');
}

/**
 * Returns true when a fetch Response indicates the Fidelity session has expired:
 *   - redirect to login.fidelity.com (followed transparently by fetch, status still 200)
 *   - HTTP 401 / 403 (explicit auth failure)
 * @param {Response|null|undefined} resp
 * @returns {boolean}
 */
function isSessionExpiredResponse(resp) {
  if (!resp) return false;
  if (resp.redirected && resp.url) {
    try {
      const host = new URL(resp.url).hostname;
      const loginHost = FMC_CONSTANTS.API.LOGIN_HOSTNAME;
      if (host === loginHost || host.endsWith(`.${loginHost}`)) return true;
    } catch { /* ignore malformed URL */ }
  }
  return resp.status === 401 || resp.status === 403;
}
