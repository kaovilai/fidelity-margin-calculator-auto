---
id: BL-5
title: 'Phase 5: Polish'
status: Done
assignee: []
created_date: '2026-04-16 06:07'
updated_date: '2026-04-16 06:11'
labels: []
dependencies:
  - BL-4
priority: low
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Final polish: extension popup for settings/status, robust error handling for expired sessions and API failures, and rate limiting to avoid hammering Fidelity's API.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Extension popup (popup.html/popup.js) shows status and settings (enable/disable, thresholds)
- [ ] #2 Error handling for expired sessions shows clear user-facing message
- [ ] #3 Error handling for API failures (network, 4xx, 5xx) with retry/backoff
- [ ] #4 Rate limiting prevents excessive API calls
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Implementation Plan: Phase 5 — Polish

### 1. Extension Popup (popup.html / popup.js)

#### 1.1 Manifest Changes
- Add `"action": { "default_popup": "popup/popup.html", "default_icon": {} }` to manifest.json
- Add `"permissions": ["storage"]` for chrome.storage access
- Create `popup/popup.html` and `popup/popup.js`

#### 1.2 Settings to Expose
- **Enable/disable extension** — master toggle. When disabled, content scripts skip all detection and injection. Stored as `enabled` (boolean, default `true`).
- **Margin debit warning threshold** — dollar amount at which the injected panel shows an extra warning (e.g., "This trade puts you within $X of margin debit"). Stored as `debitWarningThreshold` (number, default `500`). Set to 0 to disable threshold warnings.
- **Debounce timing** — milliseconds to wait after trade field changes before firing API call. Stored as `debounceMs` (number, default `500`, range 200–2000). Useful if user wants faster or slower response. Expose as a slider or dropdown with presets (Fast 200ms, Normal 500ms, Conservative 1000ms).
- **Auto-refresh baseline** — whether to periodically re-fetch the baseline (no-trade) margin data. Stored as `autoRefreshBaseline` (boolean, default `true`). When enabled, baseline refreshes every 60s. When disabled, baseline only refreshes on account change or manual action.

#### 1.3 Status Display
The popup should show current operational state:
- **Extension status**: Active / Inactive / Error (with color dot indicator)
- **Last calculation**: timestamp of most recent successful API call, e.g., "2 min ago"
- **Current account**: account number currently being monitored (e.g., "Z254...1234" — partially masked for privacy)
- **Error status**: if last API call failed, show the error message and type (session expired, network error, API error)
- **API call count**: number of API calls made this session (helps user understand rate of calls)
- **Trade ticket detected**: Yes/No — whether a trade ticket is currently visible

#### 1.4 Popup-to-Content-Script Communication
- Use `chrome.storage.onChanged` listener in content scripts to react to settings changes in real time.
- For status display, content script writes state to `chrome.storage.local` (not sync — status is device-specific):
  - `fmc_status`: { state: 'active'|'inactive'|'error', lastCalcTime: timestamp, accountNum: string, lastError: string|null, apiCallCount: number, tradeTicketVisible: boolean }
- Popup reads `chrome.storage.local` on open and uses `chrome.storage.onChanged` to update live.
- Settings stored in `chrome.storage.sync` (syncs across devices): `fmc_settings`: { enabled, debitWarningThreshold, debounceMs, autoRefreshBaseline }

#### 1.5 Popup UI Design
- Clean, minimal design matching Fidelity's color palette (greens, grays, reds).
- Two sections: **Status** (top) and **Settings** (bottom, collapsible).
- Status section: icon + text for each status field, with a "Refresh" button to force a new baseline fetch.
- Settings section: toggle switches, number inputs, and the debounce slider.
- Width: 320px (standard popup width). No scrolling needed.
- Footer: version number and "Reload Extension" link (opens chrome://extensions).

### 2. Session Expiry Detection

#### 2.1 How Fidelity Sessions Expire
Based on the cookie analysis from the sample curl:
- Session cookies (`PIT`, `FC`, `MC`, `RC`, `SC`, `SGI`, `SGT`, `ATC`) have no explicit `Max-Age` in the sample — they are session cookies that expire when the browser closes, or when Fidelity's server-side session times out (typically 20-30 minutes of inactivity).
- When the session expires, the GraphQL endpoint will likely:
  1. Return HTTP 302 redirect to `https://login.fidelity.com/...` (most common for Fidelity)
  2. Return HTTP 401 or 403
  3. Return HTTP 200 with a GraphQL error in `sysMsgs` or `messages` indicating auth failure

#### 2.2 Detection Strategy
In `margin-api.js`, enhance the `fetchMarginCalc` function:

1. **Check for redirect**: After `fetch()`, check if `resp.redirected === true` or `resp.url` contains `login.fidelity.com`. This catches the 302-to-login case (since `fetch` follows redirects by default with `credentials: 'include'`).

2. **Check HTTP status**:
   - 401/403: Definite session expiry.
   - 302: Should be caught by redirect check above.
   - Other 4xx: Likely client error (bad request), not session-related.

3. **Check GraphQL response**: Look at `data.data.getTradeCalculator.sysMsgs` and `data.data.getTradeCalculator.messages` for auth-related error codes. If `messages[0].code` is non-zero and `severity` indicates error, check if the message text contains auth-related keywords.

4. **Classify errors**: Return a structured error object with `type` field:
   - `SESSION_EXPIRED` — needs re-login
   - `NETWORK_ERROR` — fetch failed entirely (offline, DNS, etc.)
   - `API_ERROR` — server returned an error (5xx, GraphQL error)
   - `CLIENT_ERROR` — bad request (4xx other than 401/403)
   - `PARSE_ERROR` — response wasn't valid JSON or expected shape

#### 2.3 User-Facing Response to Session Expiry
- Injected panel shows: "Session expired — please log in to Fidelity and refresh this page"
- Panel styling: amber/yellow background with a link icon
- Badge icon: set extension icon badge to "!" with red background via `chrome.action.setBadgeText` (requires messaging to background service worker)
- Popup status: show "Session Expired" in red with a "Open Fidelity Login" link
- Stop all further API calls until the user takes action (set a `sessionExpired` flag)
- When the page navigates or reloads (detected via MutationObserver or `visibilitychange`), clear the `sessionExpired` flag and retry

### 3. API Error Handling with Retry/Backoff

#### 3.1 Retryable vs Non-Retryable Errors
- **Retryable**: `NETWORK_ERROR` (transient connectivity), `API_ERROR` (5xx server errors — Fidelity might be temporarily overloaded)
- **Non-retryable**: `SESSION_EXPIRED` (requires user action), `CLIENT_ERROR` (our request is wrong), `PARSE_ERROR` (unexpected response shape — likely a breaking API change)

#### 3.2 Retry Strategy: Exponential Backoff with Jitter
```
delays = [1000, 2000, 4000] (3 retries max)
actual_delay = delay * (0.5 + Math.random()) // jitter to avoid thundering herd
```
- Max 3 retries for retryable errors
- Total max wait: ~7 seconds before giving up
- After all retries exhausted, show error in panel and update status in storage
- Each retry attempt updates the panel to show "Retrying (2/3)..."

#### 3.3 Implementation Location
- Add a `fetchWithRetry(fn, opts)` wrapper in `margin-api.js` or a new `lib/retry.js`
- The wrapper handles retry logic; callers just use it transparently
- `main.js` continues to call `MarginAPI.fetchMarginCalc` which internally uses the retry wrapper

#### 3.4 Circuit Breaker (Lightweight)
- If 5 consecutive API calls fail (regardless of retry), enter a "circuit open" state
- In circuit open state: skip API calls for 30 seconds, show "API unavailable — retrying in Xs" countdown in the panel
- After 30 seconds, allow one "probe" request. If it succeeds, close the circuit. If it fails, stay open for another 30s.
- This prevents hammering a failing endpoint indefinitely

### 4. Rate Limiting

#### 4.1 Approach: Token Bucket
A token bucket is the best fit because:
- It allows bursts (user rapidly changing trade fields) while enforcing an average rate
- Simple to implement in plain JS
- No server coordination needed

#### 4.2 Parameters
- **Bucket capacity**: 10 tokens (max burst size)
- **Refill rate**: 1 token per 3 seconds (~20 calls/minute max sustained)
- **Initial tokens**: 10 (allow immediate burst on page load)
- Each API call consumes 1 token. If bucket is empty, the call is queued or dropped.

Rationale: Fidelity's margin calculator page itself makes calls on each field change — 20/min is conservative. The debounce (default 500ms) already limits call frequency significantly. The token bucket is a safety net for edge cases (rapid account switching, multiple tickets).

#### 4.3 Behavior When Rate Limited
- Do NOT silently drop calls — queue the most recent one
- Show "Rate limited — will retry in Xs" in the panel loading state
- When a token becomes available, execute only the most recent queued call (discard stale ones)
- This ensures the user always sees the result of their latest trade configuration

#### 4.4 Implementation
- Add `lib/rate-limiter.js` as a new module (IIFE pattern matching existing code)
- Expose `RateLimiter.acquire()` which returns a Promise that resolves when a token is available
- `main.js` calls `await RateLimiter.acquire()` before each API call
- Rate limiter state resets on page navigation

### 5. Badge Icon and Visual Indicators

#### 5.1 Extension Icon Badge
Use `chrome.action.setBadgeText` and `chrome.action.setBadgeBackgroundColor` via messages from content script to background service worker:
- Normal/active: no badge (clear)
- Error: "!" badge, red background (#c41200)
- Session expired: "!" badge, amber background (#f5a623)
- Rate limited: no badge change (transient state)

#### 5.2 Background Service Worker Role
Expand `background.js` to:
- Listen for messages from content scripts: `{ type: 'setBadge', text, color }`
- Call `chrome.action.setBadgeText` and `chrome.action.setBadgeBackgroundColor` (these APIs are only available in the service worker context)
- Listen for messages from popup: `{ type: 'getStatus' }` — forward from storage

### 6. File Changes Summary

| File | Change |
|------|--------|
| `manifest.json` | Add `action`, `permissions: ["storage"]` |
| `background.js` | Add badge management, message listeners |
| `popup/popup.html` | New — popup UI |
| `popup/popup.js` | New — popup logic, settings read/write, status display |
| `popup/popup.css` | New — popup styles |
| `lib/margin-api.js` | Add error classification, retry wrapper, redirect detection |
| `lib/rate-limiter.js` | New — token bucket rate limiter |
| `content/main.js` | Integrate settings, rate limiter, error classification, status reporting to storage |
| `content/injector.js` | Add session-expired and rate-limited panel states |
| `content/styles.css` | Add styles for new panel states (amber warning, retry countdown) |

### 7. Implementation Order
1. Settings storage layer (chrome.storage.sync for settings, chrome.storage.local for status)
2. Error classification in margin-api.js (SESSION_EXPIRED, NETWORK_ERROR, etc.)
3. Retry wrapper with exponential backoff
4. Rate limiter (token bucket)
5. Update main.js to integrate settings, retry, rate limiter, status reporting
6. Update injector.js with new panel states
7. Background service worker (badge management)
8. Popup HTML/CSS/JS
9. Update manifest.json with all new entries
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## UX Considerations

### Privacy
- Account numbers displayed in popup should be partially masked (show first 2 and last 4 chars: "Z2...8273")
- API call count and status data in chrome.storage.local should be cleared when browser closes (use `session` storage if available in MV3, otherwise clear on extension startup)
- No trade details (symbols, quantities, prices) should be stored in extension storage — only aggregate status info

### Error Message Clarity
- Avoid technical jargon in user-facing error messages. "Session expired" is clear; "HTTP 401 Unauthorized" is not.
- Provide actionable guidance: "Log in to Fidelity and refresh this page" rather than just "Authentication failed"
- For rate limiting, show a countdown: "Calculating in 3s..." rather than a generic "Rate limited" message

### Performance Impact
- MutationObserver on document.body with subtree:true is already in place (detector.js). Adding chrome.storage reads should not add meaningful overhead — they are async and cached by Chrome.
- The token bucket is in-memory, zero overhead when not rate-limited.
- Popup only runs when opened — no persistent background page cost.

### Debounce Timing Tradeoff
- 200ms feels responsive but may cause extra API calls on slow typists
- 500ms (default) is a good balance — most users finish entering a value within 500ms
- 1000ms+ feels sluggish for power users
- Exposing this as a setting lets users self-optimize

### Badge Icon Usage
- Keep badge usage minimal — only for states that require user attention (session expired, persistent errors)
- Do NOT badge for transient states (loading, single retry) — this would be distracting
- Clear badge automatically when the issue resolves

## Security Notes

### No New Security Surface
- All API calls remain same-origin to digital.fidelity.com — no new external communication
- chrome.storage.sync only stores user preferences (booleans, numbers) — no sensitive data
- chrome.storage.local stores status metadata only — no credentials, no trade details, no account balances
- The popup cannot make API calls directly — it only reads/writes settings and status from storage

### XSRF Token Consideration
- The sample curl shows multiple XSRF tokens (`MARGIN-CALCULATOR-XSRF-TOKEN`, `XSRF-TOKEN`, etc.) set as cookies
- Currently the extension relies on `credentials: 'include'` to send cookies — this works because the request is same-origin
- If Fidelity starts requiring XSRF tokens in request headers (not just cookies), the extension would need to read the cookie value and set a custom header. This is a potential future breaking change to monitor.
- The `fetch()` API with `credentials: 'include'` on a same-origin request automatically sends all cookies including XSRF tokens as cookies, but does NOT set them as headers.

### Content Security Policy
- popup.html should not use inline scripts — reference popup.js as a separate file (MV3 CSP requirement)
- No eval(), no inline event handlers

## Open Questions

1. **What HTTP status does Fidelity actually return on session expiry?** The sample only shows a successful response. Need to test by letting a session expire and observing the response. The implementation should handle 302 redirect, 401, 403, and GraphQL-level auth errors to cover all possibilities.

2. **Does Fidelity rate-limit the margin calculator API server-side?** If they do, we should detect their rate limit response (likely HTTP 429 with Retry-After header) and respect it. The token bucket parameters (20 calls/min) are conservative enough that this likely won't be an issue.

3. **Should the popup have a "Force Recalculate" button?** This would clear all caches and re-fetch baseline + projected data. Useful after account deposits/withdrawals that change the baseline. Recommendation: Yes, add this — it's low effort and high utility.

4. **Should settings sync across devices (chrome.storage.sync)?** Pros: user sets preferences once. Cons: debounce timing preferences might differ by device. Recommendation: Use sync for most settings, but keep debounce timing in local storage since it's performance-related and device-dependent.

5. **What should happen when the user has multiple Fidelity tabs open?** Each tab runs its own content script. The token bucket is per-tab (in-memory). If the user has 3 tabs with trade tickets, each tab independently rate-limits. This means the combined rate could be 3x the single-tab rate. This is acceptable because each tab has its own trade context, and 60 calls/min combined is still very conservative.

6. **Should the circuit breaker state be shared across tabs?** If Fidelity's API is down, all tabs would independently discover this and each go through their own retry/circuit-break cycle. Sharing state via chrome.storage.local would be more efficient but adds complexity. Recommendation: Keep it per-tab for simplicity in v1.
<!-- SECTION:NOTES:END -->
