---
id: BL-4
title: 'Phase 4: Background Service Worker'
status: Done
assignee: []
created_date: '2026-04-16 06:07'
updated_date: '2026-04-16 06:11'
labels: []
dependencies:
  - BL-1
  - BL-2
  - BL-3
priority: medium
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement background.js service worker to coordinate between content scripts, manage state, cache margin calculation results, and handle account switching. This is the orchestration layer connecting detection → API calls → UI updates.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 background.js coordinates message passing between content scripts and API layer
- [ ] #2 Caches recent margin calc results to reduce redundant API calls
- [ ] #3 Handles account switching — clears stale cache and re-queries when account changes
- [ ] #4 Service worker lifecycle managed correctly (Manifest V3 constraints)
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Implementation Plan: Background Service Worker (background.js)

### Architecture Decision: Content Script vs Background for API Calls

**Current state**: All logic runs in content scripts. `main.js` orchestrates detector -> API -> calc -> injector, with a simple in-memory baseline cache. `background.js` is a stub. Content scripts call `fetch()` directly, which works because they execute in the page's origin context and automatically attach same-origin cookies.

**Decision**: Keep API calls in content scripts. Move caching and coordination to the background service worker via message passing. Rationale:
- Content scripts inherit the page's cookie jar automatically; background service workers do NOT have same-origin context for `digital.fidelity.com` and would need explicit cookie handling via `chrome.cookies` API plus extra permissions
- Moving fetch to background would add complexity without functional benefit since we only target one origin
- Background's role: cache management, cross-tab coordination, account state, rate limiting

---

### 1. Message Passing Architecture

**Direction**: Content script <-> Background (bidirectional via `chrome.runtime.sendMessage` / `chrome.runtime.onMessage`)

#### Message Types (content -> background):

```
CACHE_GET
  payload: { key: string }
  response: { hit: boolean, data: object | null, age: number }

CACHE_SET
  payload: { key: string, data: object, ttl: number }
  response: { ok: boolean }

CACHE_INVALIDATE
  payload: { key?: string, pattern?: string }  // key for specific, pattern for prefix match
  response: { ok: boolean, cleared: number }

ACCOUNT_CHANGED
  payload: { accountNum: string, previousAccountNum: string | null }
  response: { ok: boolean }

LOG_API_CALL
  payload: { accountNum: string, type: 'baseline' | 'projected', timestamp: number }
  response: { ok: boolean, rateLimited: boolean }

GET_STATE
  payload: {}
  response: { activeAccount: string | null, cacheSize: number, lastApiCall: number }

HEARTBEAT
  payload: { tabId: number }
  response: { ok: boolean }
```

#### Message Types (background -> content, via `chrome.tabs.sendMessage`):

```
CACHE_EXPIRED
  payload: { key: string, reason: 'ttl' | 'account_change' | 'manual' }

RATE_LIMITED
  payload: { retryAfter: number }

SETTINGS_CHANGED
  payload: { settings: object }
```

#### Message Envelope Format:

```javascript
{
  type: 'CACHE_GET',        // message type constant
  payload: { ... },         // type-specific data
  _fmc: true,               // namespace flag to avoid collision with other extensions
  _ts: 1776317700000        // timestamp for debugging
}
```

---

### 2. Caching Strategy

#### Cache Key Structure:
- Baseline: `baseline:{accountNum}` (e.g., `baseline:X12345678`)
- Projected: `projected:{accountNum}:{ordersHash}` where ordersHash = deterministic hash of sorted orders array

#### Orders Hash Function:
```javascript
// Deterministic fingerprint for cache key
function hashOrders(orders) {
  const normalized = orders
    .map(o => `${o.orderSymbol}|${o.orderAction}|${o.orderQty}|${o.price}`)
    .sort()
    .join(';;');
  // Simple string hash (DJB2 or similar) — no crypto needed for cache keys
  return djb2(normalized).toString(36);
}
```

#### TTL Values:
- Baseline: **60 seconds** (account balances change with market; already proven in current code)
- Projected: **30 seconds** (shorter because trade context is more volatile — user is actively editing)
- Rate limit window: **2 seconds** minimum between API calls per account

#### Cache Storage:
- Use in-memory `Map` in service worker (NOT `chrome.storage.local` — too slow for hot-path cache lookups, and data is ephemeral anyway)
- Maximum cache entries: 50 (LRU eviction)
- On service worker restart: cache is empty (acceptable — content script will re-fetch)

#### Cache Invalidation Triggers:
1. TTL expiry (lazy — checked on read)
2. Account switch (clear all entries for old account)
3. Manual user action (future: refresh button in UI panel)
4. Service worker restart (implicit — memory cleared)
5. Tab closed (optional: could track tab-to-account mapping)

---

### 3. Account Switching Flow

#### Detection (in content script — detector.js):
- `detector.js` already reads `getAccountNumber()` from DOM
- Add account change detection to `observe()`: track `lastAccountNum`, fire `ACCOUNT_CHANGED` message when it differs

#### Background handling:
1. Receive `ACCOUNT_CHANGED` message
2. Store `activeAccount` state
3. Invalidate ALL cache entries prefixed with old account number
4. Broadcast `CACHE_EXPIRED` to all content script tabs (via `chrome.tabs.query` + `chrome.tabs.sendMessage`)
5. Content scripts clear their local references and re-fetch baseline on next trade detection

#### Multi-tab considerations:
- User may have multiple Fidelity tabs with different accounts
- Background tracks `tabId -> accountNum` mapping
- Cache invalidation on account change only affects entries for that specific account, not all accounts
- When same account is active in multiple tabs, they share cache

---

### 4. Rate Limiting

#### Strategy:
- Track last API call timestamp per account in background
- Content scripts send `LOG_API_CALL` before making API calls
- Background responds with `{ rateLimited: true, retryAfter: ms }` if too soon
- Minimum 2s between calls per account (configurable)
- Content script should NOT make the API call if rate-limited; instead show "Calculating..." and retry after delay

#### Implementation:
```javascript
// In background.js
const apiCallLog = new Map(); // accountNum -> lastCallTimestamp
const MIN_INTERVAL = 2000;

function checkRateLimit(accountNum) {
  const last = apiCallLog.get(accountNum) || 0;
  const elapsed = Date.now() - last;
  if (elapsed < MIN_INTERVAL) {
    return { rateLimited: true, retryAfter: MIN_INTERVAL - elapsed };
  }
  apiCallLog.set(accountNum, Date.now());
  return { rateLimited: false };
}
```

---

### 5. Service Worker Lifecycle (Manifest V3)

#### Key constraints:
- Service worker terminates after ~30 seconds of inactivity
- All in-memory state (cache, rate limit log) is lost on termination
- No `setInterval`/`setTimeout` survives termination
- Must wake on message from content script

#### Design implications:
- **No keepalive needed**: The cache is ephemeral by design. If the service worker dies and restarts, content scripts simply get cache misses and re-fetch. This is acceptable because API calls are fast (~200-500ms) and the user is actively interacting.
- **No alarms needed**: We don't need periodic background work. All work is triggered by content script messages.
- **Startup handler**: `chrome.runtime.onInstalled` — initialize any one-time setup (e.g., log version). No persistent state to restore.
- **State recovery**: On first message after restart, background initializes empty cache and responds normally. Content scripts handle cache misses gracefully (they already do — the current `main.js` fetches on miss).

#### Service worker lifecycle events to handle:
```javascript
chrome.runtime.onInstalled.addListener(() => { /* log version, init */ });
chrome.runtime.onStartup.addListener(() => { /* warm-start init */ });
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Route to handler based on msg.type
  // MUST return true for async responses
});
```

---

### 6. Data Flow Diagram

```
[User edits trade form fields]
         |
         v
[detector.js — MutationObserver + input listener]
  - Detects field changes, debounces (500ms)
  - Computes params fingerprint
  - Checks account number for changes
         |
         v
[main.js — orchestrator]
  1. Sends CACHE_GET to background for baseline:{accountNum}
  2. If cache hit: use cached baseline
  3. If cache miss:
     a. Sends LOG_API_CALL to background (rate limit check)
     b. If not rate-limited: calls MarginAPI.fetchBaseline() directly via fetch()
     c. Sends CACHE_SET to background with result
  4. Sends CACHE_GET for projected:{accountNum}:{ordersHash}
  5. If cache miss:
     a. Rate limit check via LOG_API_CALL
     b. calls MarginAPI.fetchMarginCalc() directly via fetch()
     c. Sends CACHE_SET to background with result
  6. Calls MarginCalc.computeImpact(baseline, projected)
         |
         v
[injector.js — DOM manipulation]
  - showLoading() during fetch
  - updatePanel(impact) on success
  - showError(msg) on failure
```

---

### 7. Error Propagation

#### Error types and handling:

| Error Source | Error Type | Content Script Action | Background Action |
|---|---|---|---|
| API fetch | HTTP 401/403 | showError("Session expired — please log in") | None (content script handles) |
| API fetch | HTTP 5xx | showError("Fidelity API error") + retry once | Log error count per account |
| API fetch | Network error | showError("Network error") | None |
| API response | GraphQL errors (non-logo) | showError with first error message | None |
| API response | Missing balance data | showError("Could not parse response") | Invalidate cached entry |
| Rate limiting | Too many calls | showLoading() + queue retry | Return rateLimited: true |
| Service worker | Terminated mid-request | Content script gets no response | N/A — content script should use sendMessage with timeout |
| Cache | Stale data served | N/A — TTL prevents this | Lazy TTL check on read |

#### Content script message timeout:
```javascript
function sendToBackground(msg, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({ error: 'timeout', fallback: true });
    }, timeoutMs);
    chrome.runtime.sendMessage(msg, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        // Service worker not running — proceed without cache
        resolve({ error: chrome.runtime.lastError.message, fallback: true });
      } else {
        resolve(response);
      }
    });
  });
}
```

When background is unavailable (timeout or lastError), content script falls back to direct API call without caching — graceful degradation.

---

### 8. File Changes Summary

- **`background.js`**: Complete rewrite — message router, cache manager, rate limiter, account tracker
- **`content/main.js`**: Refactor to use message-based cache instead of in-memory `baselineCache`; add account change detection; add `sendToBackground` helper with timeout/fallback
- **`manifest.json`**: No changes needed — already has `background.service_worker` and `host_permissions`
- **`content/detector.js`**: Minor addition — emit account change events in `observe()` callback
- **`lib/margin-api.js`**: No changes — stays in content script
- **`lib/margin-calc.js`**: No changes
- **`content/injector.js`**: No changes

---

### 9. Implementation Order

1. Implement background.js message router skeleton (onMessage dispatcher)
2. Implement cache manager (Map-based, TTL, LRU eviction, get/set/invalidate)
3. Implement rate limiter
4. Implement account tracker (tabId -> accountNum mapping)
5. Refactor main.js to send cache messages to background (with fallback)
6. Add account change detection to detector.js observe() callback
7. Test: verify cache hits/misses, account switching, service worker restart recovery
8. Test: verify graceful degradation when background is unavailable
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Architectural Considerations

### Why API calls stay in content scripts (not background)

This is the most important architectural decision. In Manifest V3, the background service worker does NOT share the page's origin. If we moved `fetch()` calls to background.js:
- We'd need to manually handle cookies via `chrome.cookies.getAll()` and construct Cookie headers
- We'd need `cookies` permission in manifest (increases permission warnings for users)
- CSRF tokens (like `MARGIN-CALCULATOR-XSRF-TOKEN`, `XSRF-TOKEN`) would need to be extracted and forwarded
- The sample curl shows ~15+ cookies and XSRF tokens — brittle to maintain
- Same-origin fetch from content script handles all of this automatically and transparently

The background worker's value is coordination (cache, rate limiting, cross-tab state), not API proxying.

### Manifest V3 Service Worker Gotchas

1. **30-second idle timeout**: Service worker terminates after ~30s with no activity. All in-memory state is lost. Design around this: cache is ephemeral, content scripts handle cache misses gracefully.

2. **No DOM access**: Background cannot access `document`, `window`, etc. All DOM interaction is content-script-only. (This is already the case in our design.)

3. **No `XMLHttpRequest`**: Only `fetch()` is available in service workers. (We already use `fetch()`.)

4. **Async `onMessage` responses**: `chrome.runtime.onMessage` listener MUST `return true` if the response is sent asynchronously. Forgetting this is a common bug — the message channel closes immediately otherwise.

5. **No persistent connections**: WebSocket/SSE connections don't survive service worker termination. Not relevant to us (we use request/response), but worth noting.

6. **`chrome.storage.session`**: Available in MV3 for session-scoped data that survives service worker restarts (but not browser restarts). Could be used for cache persistence, but adds async overhead for every cache lookup. Not recommended for hot-path cache — only useful if cache rebuilds are expensive (ours aren't).

7. **Message port lifetime**: `chrome.runtime.connect()` (long-lived ports) keep the service worker alive while open. Could be used as a keepalive mechanism, but unnecessary since our cache is ephemeral.

### Response Size Analysis

The API response with full positions/optPairs/underlyingSecurities is ~17KB (sample). The simplified query (balance-only, as implemented in `margin-api.js`) is much smaller — estimated ~500 bytes for the balance object. This is very cache-friendly:
- 50 cached entries * ~500 bytes = ~25KB memory — negligible
- JSON serialization for `chrome.storage.session` (if used) would be fast at this size

### Cache Key Collision Risk

Using DJB2 hash for orders is sufficient. Collision risk is negligible because:
- Cache entries have short TTL (30-60s), limiting the window
- The worst case of a collision is a stale projected result displayed briefly, which self-corrects on next input change

### Cross-Tab Coordination

Multiple Fidelity tabs might be open simultaneously (portfolio summary + options research + trade page). The background service worker naturally handles this because:
- Each tab sends its own messages identified by `sender.tab.id`
- Cache is shared — if tab A fetches a baseline for account X, tab B can reuse it
- Account change in one tab triggers cache invalidation only for that account (not all accounts)

### Design Decisions to Flag

1. **No `chrome.storage` for cache**: Intentional. The async overhead of `chrome.storage.local.get/set` on every cache lookup (even `chrome.storage.session`) adds latency to the critical path. In-memory Map in service worker is synchronous in the handler. Cache cold-start after service worker restart costs one extra API call — acceptable.

2. **Content script fallback**: If `chrome.runtime.sendMessage` fails (service worker dead, extension updating), content scripts fall back to direct API calls without caching. This means the extension never breaks due to background issues — it just makes slightly more API calls temporarily.

3. **No keepalive/alarm**: We explicitly choose NOT to use `chrome.alarms` to keep the service worker alive. The pattern of "wake on content script message -> handle -> sleep" is the intended MV3 design. Fighting it with keepalive hacks creates battery/resource issues.

4. **Rate limiting is advisory**: The background tracks rate limits, but the content script makes the final decision to call or not. If background is unavailable, content script proceeds without rate limiting. This avoids the background being a single point of failure.

5. **Account number in cache key**: Account numbers like `X12345678` are used as-is in cache keys. No hashing needed — they're already short and unique. The Z-prefix format is standard for Fidelity margin accounts.
<!-- SECTION:NOTES:END -->
