// Shared constants — loaded by content scripts (via manifest), popup.html, and background.js
// (via importScripts). Centralises storage keys, default settings, and cache key prefixes so
// diverging copies cannot silently break settings load/save, status reporting, or cache invalidation.
const FMC_CONSTANTS = Object.freeze({
  STORAGE_KEY_SETTINGS: 'fmc_settings',
  STORAGE_KEY_STATUS: 'fmc_status',
  MIN_DEBOUNCE_MS: 100, // enforced in both content script and popup to prevent runaway polling
  DEFAULT_SETTINGS: Object.freeze({
    enabled: true,
    debitWarningThreshold: 500,
    debounceMs: 500
  }),
  // Upper bound for debitWarningThreshold — prevents misconfiguration where a very
  // large value (e.g. $999999) causes the panel to show WARNING for virtually every
  // trade. Enforced in injector.js (setWarningThreshold) and popup.js (saveSettings).
  MAX_WARNING_THRESHOLD: 100000,
  // Cache key prefixes — shared between content/main.js and background.js so a rename
  // in one place cannot silently break cache invalidation in the other.
  CACHE_KEY_PREFIX: Object.freeze({
    PRICELIST: 'pricelist:',
    PROJECTED: 'projected:'
  }),
  // Error type strings — shared across margin-api.js, positions.js, and main.js.
  // Using a single source of truth prevents silent breakage if a string is renamed
  // in one file but not updated in the others (e.g. retry logic, session-expiry checks).
  ERROR_TYPES: Object.freeze({
    SESSION_EXPIRED: 'SESSION_EXPIRED',
    NETWORK_ERROR: 'NETWORK_ERROR',
    API_ERROR: 'API_ERROR',
    CLIENT_ERROR: 'CLIENT_ERROR',
    PARSE_ERROR: 'PARSE_ERROR'
  }),
  // Error types that should trigger automatic retry (transient failures).
  // Centralised here so margin-api.js, positions.js, and main.js all share
  // the same definition — prevents the sets from silently diverging if a new
  // retryable error type is added in one place but forgotten in another.
  // SESSION_EXPIRED and CLIENT_ERROR are intentionally excluded: they are
  // permanent states that will not be resolved by retrying the same request.
  RETRYABLE_ERROR_TYPES: Object.freeze(['NETWORK_ERROR', 'API_ERROR']),
  // Badge colors — shared between content/main.js (sender) and background.js (fallback default).
  // Keeping them here prevents the two files from silently drifting to different hex values.
  BADGE_COLORS: Object.freeze({
    ERROR: '#c41200',
    WARNING: '#f5a623'
  }),
  // Cache TTLs for content/main.js — named here so the values are self-documenting
  // and easy to tune without hunting through main.js.
  CACHE_TTL_MS: Object.freeze({
    PRICELIST: 300000,       // 5 min — positions change infrequently
    PROJECTED:  30000,       // 30 s  — projected result tied to specific order params
    PRICELIST_EMPTY: 30000   // 30 s  — short TTL for empty-position result to avoid
                             //         repeated API calls while still recovering quickly
  }),
  // Timeout for chrome.runtime.sendMessage calls from content script to background.
  BG_MESSAGE_TIMEOUT_MS: 3000,
  // Fetch timeouts for Fidelity API calls — centralized so both APIs can be tuned together.
  // Margin API allows more time (15 s) because it performs a heavier server-side calculation.
  FETCH_TIMEOUT_MS: Object.freeze({
    MARGIN_API: 15000,
    POSITIONS_API: 10000
  }),
  // Background service worker cache parameters
  BG_CACHE: Object.freeze({
    MAX_ENTRIES: 50,          // evict LRU entries beyond this count
    DEFAULT_TTL_MS: 60000,    // fallback TTL when caller omits ttl
    MIN_API_INTERVAL_MS: 2000 // minimum ms between API calls per account (rate guard)
  }),
  // Status state strings — shared between content/main.js (writer) and popup/popup.js (reader).
  // Centralised so a rename cannot silently break the popup's state display or CSS classes.
  STATUS_STATE: Object.freeze({
    ACTIVE:   'active',
    ERROR:    'error',
    INACTIVE: 'inactive'
  }),
  // Background alarm period for expired cache cleanup
  BG_CLEANUP_INTERVAL_MINUTES: 1,
  // Content-script in-memory fallback cache limit (entries, not bytes)
  CONTENT_FALLBACK_CACHE_MAX: 30,
  // Token-bucket rate limiter for content-script API calls
  RATE_LIMITER: Object.freeze({
    CAPACITY: 10,           // max burst tokens
    REFILL_INTERVAL_MS: 3000 // one token added per this interval
  }),
  // Maximum ms to wait when background rate limit signals a back-off.
  // Caps the retryAfter value so a misbehaving background cannot stall the
  // content script indefinitely.
  MAX_RATE_LIMIT_WAIT_MS: 10000,
  // TradeDetector observer tuning — centralized so tests and future tweaks
  // can adjust them without hunting through detector.js.
  DETECTOR: Object.freeze({
    MAX_LEGS: 8,              // Fidelity supports ≤4 legs; 8 is a safe upper bound
    OBSERVER_THROTTLE_MS: 50  // min ms between MutationObserver → check() calls
  }),
  // Retry backoff schedule used by lib/retry.js for both margin and positions API calls.
  // DELAYS defines the ms wait before each successive retry attempt (3 retries total).
  // JITTER_BASE controls the random multiplier range: [JITTER_BASE, JITTER_BASE + 1).
  RETRY: Object.freeze({
    DELAYS: Object.freeze([1000, 2000, 4000]),
    JITTER_BASE: 0.5
  }),
  // Maximum number of entries kept in the injector's debug log ring buffer.
  // Older entries are dropped when the log exceeds this limit.
  MAX_DEBUG_LOG_ENTRIES: 50,

  // Injection target selectors — the DOM nodes where the margin panel is inserted.
  // Centralised here so a Fidelity page-layout change only requires edits in one place.
  INJECTION: Object.freeze({
    TARGET_ID:        'mxregin',            // ID of the element the panel is anchored to
    COMPONENT_SELECTOR: 'ott-max-gain-loss' // Angular component that wraps the target
  }),

  // API endpoints and request metadata — centralised so a Fidelity URL or version change
  // only requires an edit in one place rather than hunting through individual lib files.
  API: Object.freeze({
    MARGIN_CALC_ENDPOINT:  '/ftgw/digital/margincalcex/api/graphql?op=GetTradeCalculator',
    POSITIONS_ENDPOINT:    '/ftgw/digital/portfolio/api/graphql?ref_at=portsum',
    // Referrer required by Fidelity's margin calculator API — requests from other pages
    // get 400 without it. Enforced via declarativeNetRequest rules in rules.json too.
    MARGIN_CALC_REFERRER:  'https://digital.fidelity.com/ftgw/digital/margincalcex/',
    // Apollo client version header sent with margin calculator GraphQL requests.
    APOLLO_CLIENT_VERSION: '0.0.0'
  }),

  // Margin calculator API request body flags — extracted from margin-api.js buildVariables()
  // so a Fidelity API contract change only requires an edit in one place.
  MARGIN_API_CONFIG: Object.freeze({
    EXECUTE_OPEN_ORDERS_IND: false,
    PRICE_SOURCE_IND:        'S',
    EXECUTE_HPO_TXNS_IND:    true,
    BALANCES_ONLY_IND:       false,
    RBR_ADDONS_IND:          true
  }),

  // Positions API request configuration — extracted from positions.js doFetchPriceList()
  // and positionToPriceListEntry() so Fidelity API contract changes only require edits here.
  POSITIONS_CONFIG: Object.freeze({
    ACCT_TYPE:         'Brokerage',
    ACCT_SUB_TYPE:     'Brokerage',
    PREFERENCE_DETAIL: false,
    PRICE_IND:         'initial' // priceInd value used in every priceList entry
  }),

  // Maximum length (in characters) for a single entry in the injected debug log panel.
  // Entries exceeding this are truncated with an ellipsis to keep the debug view readable.
  MAX_LOG_ENTRY_LEN: 500,

  // Chrome extension message type strings — shared between senders (content/main.js,
  // popup/popup.js) and the receiver (background.js) so a rename in one place is caught
  // immediately rather than silently breaking the runtime message routing.
  MESSAGE_TYPES: Object.freeze({
    CACHE_GET:        'CACHE_GET',
    CACHE_SET:        'CACHE_SET',
    CACHE_INVALIDATE: 'CACHE_INVALIDATE',
    ACCOUNT_CHANGED:  'ACCOUNT_CHANGED',
    LOG_API_CALL:     'LOG_API_CALL',
    SET_BADGE:        'SET_BADGE',
    HEARTBEAT:        'HEARTBEAT',
    FORCE_RECALC:     'FORCE_RECALC'
  }),

  // Interval (ms) at which the content script sends HEARTBEAT messages to the background
  // service worker while a trade ticket is open, keeping it alive between API calls.
  // MV3 service workers terminate after ~30 s of inactivity; pinging every 20 s provides
  // a comfortable margin while imposing negligible overhead (one tiny message per interval).
  HEARTBEAT_INTERVAL_MS: 20000,

  // Lightweight circuit breaker — prevents hammering a failing API endpoint.
  // After FAILURE_THRESHOLD consecutive retryable failures (NETWORK_ERROR or API_ERROR),
  // API calls are blocked for OPEN_DURATION_MS. After the duration elapses, one probe
  // request is allowed through. If it succeeds the circuit closes; if it fails the circuit
  // reopens for another OPEN_DURATION_MS.
  CIRCUIT_BREAKER: Object.freeze({
    FAILURE_THRESHOLD: 5,    // consecutive retryable failures before opening
    OPEN_DURATION_MS: 30000  // ms to stay open before allowing a probe request
  })
});
