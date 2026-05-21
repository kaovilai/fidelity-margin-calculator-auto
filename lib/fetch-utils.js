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
 * Only handles the numeric-seconds form (e.g. `Retry-After: 5`).
 * HTTP date values (e.g. `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`) are
 * ignored — they are rarely used by REST/GraphQL APIs and require full HTTP date
 * parsing. Returns 0 for absent, non-numeric, non-positive, or over-cap values
 * so callers can treat 0 as "no server-specified delay".
 * @param {string|null} header - Raw `Retry-After` header value, or null if absent.
 * @param {number} maxMs - Maximum allowed delay in milliseconds; values above this are clamped to 0.
 * @returns {number} Delay in milliseconds (> 0), or 0 if not applicable.
 */
function parseRetryAfterMs(header, maxMs) {
  if (!header) return 0;
  const secs = parseInt(header, 10);
  if (!Number.isFinite(secs) || secs <= 0) return 0;
  const ms = secs * 1000;
  // Cap at maxMs: honour the server's request up to our configured ceiling so
  // an unexpectedly large value (e.g. Retry-After: 3600) cannot stall the extension.
  return ms <= maxMs ? ms : 0;
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
      if (host === 'login.fidelity.com' || host.endsWith('.login.fidelity.com')) return true;
    } catch { /* ignore malformed URL */ }
  }
  return resp.status === 401 || resp.status === 403;
}
