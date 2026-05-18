// Shared fetch utilities used by lib/positions.js and lib/margin-api.js

/**
 * Wraps fetch() with an AbortController-based timeout.
 * On timeout, throws an Error with isTimeout=true so callers can produce
 * their own typed error messages without duplicating the AbortController boilerplate.
 * On any other network failure, re-throws the original error unchanged.
 * @param {string} url - Request URL.
 * @param {RequestInit} options - fetch() options; signal is overridden internally.
 * @param {number} timeoutMs - Timeout in milliseconds.
 * @returns {Promise<Response>}
 * @throws {Error & {isTimeout: true}} When the request exceeds timeoutMs.
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError' && controller.signal.aborted) {
      // Our timeout fired — report as a timeout so callers can show a specific message.
      const err = new Error(`Request timed out after ${timeoutMs}ms`);
      err.isTimeout = true;
      throw err;
    }
    // External AbortError (e.g., page navigation or extension context invalidation)
    // or other network failure — re-throw as-is so callers handle it correctly.
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
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
