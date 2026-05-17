// Shared fetch utilities used by lib/positions.js and lib/margin-api.js

// Returns true when a fetch Response indicates the Fidelity session has expired:
//   - redirect to login.fidelity.com (followed transparently by fetch, status still 200)
//   - HTTP 401 / 403 (explicit auth failure)
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
