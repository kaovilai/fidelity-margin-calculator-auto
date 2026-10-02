// Shared constants — loaded by content scripts (via manifest), popup.html, and background.js
'use strict';
// (via importScripts). Centralises storage keys, default settings, and cache key prefixes so
// diverging copies cannot silently break settings load/save, status reporting, or cache invalidation.

// Error type strings extracted before FMC_CONSTANTS so RETRYABLE_ERROR_TYPES can reference
// them by value rather than duplicating the string literals. A rename in this object is
// automatically reflected in RETRYABLE_ERROR_TYPES with no secondary update required.

// ACCOUNT_MASK component values — declared before FMC_CONSTANTS so MIN_LEN can be derived
// from them rather than being a separate magic number that could silently diverge.
const _ACCOUNT_MASK_PREFIX_LEN = 2;
const _ACCOUNT_MASK_SUFFIX_LEN = 4;

const _FMC_ERROR_TYPES = Object.freeze({
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  API_ERROR: 'API_ERROR',
  CLIENT_ERROR: 'CLIENT_ERROR',
  PARSE_ERROR: 'PARSE_ERROR'
});

const FMC_CONSTANTS = Object.freeze({
  STORAGE_KEY_SETTINGS: 'fmc_settings',
  STORAGE_KEY_STATUS: 'fmc_status',
  // Persists the collapsed/expanded state of the settings section across popup opens.
  // Cleared by the user's toggle action; intentionally NOT cleared on startup/install
  // because it is a UI preference, not transient session state (unlike STORAGE_KEY_STATUS).
  STORAGE_KEY_SETTINGS_COLLAPSED: 'fmc_settings_collapsed',
  MIN_DEBOUNCE_MS: 100, // enforced in both content script and popup to prevent runaway polling
  DEFAULT_SETTINGS: Object.freeze({
    enabled: true,
    debitWarningThreshold: 500,
    debounceMs: 500,
    // Option-chain annotator (content/chain.js)
    chainEnabled: true,
    chainQty: 1,          // contracts assumed per hovered bid/ask
    minWithdrawable: 0    // flag strikes that would leave less withdrawable cash than this ($)
  }),
  // Bounds for the chain annotator settings — enforced in popup.js and content/chain.js.
  // Remembers the account chosen for chain hints (chrome.storage.local).
  STORAGE_KEY_CHAIN_ACCOUNT: 'fmc_chain_account',
  CHAIN_LIMITS: Object.freeze({
    QTY_MAX: 1000,
    MIN_WITHDRAWABLE_MAX: 10000000,
    HOVER_DELAY_MS: 300 // pointer must rest on a cell this long before an exact calculation runs
  }),
  // Upper bound for debitWarningThreshold — prevents misconfiguration where a very
  // large value (e.g. $999999) causes the panel to show WARNING for virtually every
  // trade. Enforced in injector.js (setWarningThreshold) and popup.js (saveSettings).
  MAX_WARNING_THRESHOLD: 100000,
  // Step size for the threshold number input in popup.html. Synced to the <input step>
  // attribute at runtime (see popup.js init) so updating this constant is the only
  // change needed — no separate HTML edit that could drift out of sync.
  THRESHOLD_INPUT_STEP: 50,
  // Cache key prefixes — shared between content/main.js and background.js so a rename
  // in one place cannot silently break cache invalidation in the other.
  CACHE_KEY_PREFIX: Object.freeze({
    PRICELIST: 'pricelist:',
    PROJECTED: 'projected:'
  }),
  // Error type strings — shared across margin-api.js, positions.js, and main.js.
  // Using a single source of truth prevents silent breakage if a string is renamed
  // in one file but not updated in the others (e.g. retry logic, session-expiry checks).
  ERROR_TYPES: _FMC_ERROR_TYPES,
  // Error types that should trigger automatic retry (transient failures).
  // Centralised here so margin-api.js, positions.js, and main.js all share
  // the same definition — prevents the sets from silently diverging if a new
  // retryable error type is added in one place but forgotten in another.
  // SESSION_EXPIRED and CLIENT_ERROR are intentionally excluded: they are
  // permanent states that will not be resolved by retrying the same request.
  // References _FMC_ERROR_TYPES directly so a rename propagates automatically.
  RETRYABLE_ERROR_TYPES: Object.freeze([_FMC_ERROR_TYPES.NETWORK_ERROR, _FMC_ERROR_TYPES.API_ERROR]),
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

  // Human-readable display labels for each STATUS_STATE value — keyed by the state value string
  // so popup.js can do a direct lookup rather than a ternary chain. Centralised here so adding
  // a new state to STATUS_STATE only requires updating this map in one place; popup.js picks it
  // up automatically via FMC_CONSTANTS.STATUS_LABEL[status.state].
  STATUS_LABEL: Object.freeze({
    active:   'Active',
    error:    'Error',
    inactive: 'Inactive'
  }),

  // Account-number masking parameters used by popup/popup.js to partially obscure the
  // account number in the status display. Centralised here so the masking behaviour can be
  // tuned in one place. PREFIX_LEN and SUFFIX_LEN control how many characters to reveal at
  // each end; MIN_LEN is the minimum account length before masking is applied (ensures at
  // least one character is hidden, preventing "AB...CDEF" from showing all 6 chars of a
  // 6-char account).
  ACCOUNT_MASK: Object.freeze({
    PREFIX_LEN: _ACCOUNT_MASK_PREFIX_LEN,
    SUFFIX_LEN: _ACCOUNT_MASK_SUFFIX_LEN,
    // Derived so any change to PREFIX_LEN or SUFFIX_LEN automatically keeps the invariant
    // that masking hides at least one character (length must exceed prefix + suffix).
    MIN_LEN: _ACCOUNT_MASK_PREFIX_LEN + _ACCOUNT_MASK_SUFFIX_LEN + 1
  }),
  // Background alarm period for expired cache cleanup
  BG_CLEANUP_INTERVAL_MINUTES: 1,
  // Chrome alarm name for the background cache-cleanup job.
  // Centralised here to guard against the alarm name drifting out of sync
  // with a future rename — alarms are persisted by Chrome across SW restarts,
  // so a string change without a clear/recreate cycle silently leaves the old
  // alarm running in parallel.
  BG_CLEANUP_ALARM_NAME: 'fmc-cache-cleanup',
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
  // Maximum ms to honour from a `Retry-After` response header on a 429/503 reply.
  // Prevents a server from stalling retries indefinitely (e.g. Retry-After: 3600).
  // Set to 30 s — more than enough for transient Fidelity server overload while
  // keeping the extension responsive.
  MAX_RETRY_AFTER_MS: 30000,
  // Trade event type strings — emitted by content/detector.js observe() and consumed
  // by content/main.js tradeEventCallback(). Centralised here so a rename in one place
  // is caught immediately rather than silently breaking the callback routing in the other,
  // consistent with how MESSAGE_TYPES, STATUS_STATE, and ERROR_TYPES are managed.
  TRADE_EVENT_TYPES: Object.freeze({
    READY:      'ready',
    INCOMPLETE: 'incomplete',
    CLOSED:     'closed'
  }),

  // TradeDetector observer tuning and DOM-value guard bounds — centralized so tests
  // and future tweaks can adjust them without hunting through detector.js.
  DETECTOR: Object.freeze({
    MAX_LEGS: 8,              // Fidelity supports ≤4 legs; 8 is a safe upper bound
    OBSERVER_THROTTLE_MS: 50, // min ms between MutationObserver → check() calls
    // Generous upper bounds that catch structural DOM changes (e.g. a Fidelity redesign)
    // without rejecting any real-world values. A value exceeding these indicates garbled
    // DOM text, not a genuine user input.
    MAX_ACCOUNT_NUM_LEN: 30,  // Fidelity account numbers are typically ≤9 chars
    MAX_SYMBOL_LEN: 15,       // Ticker symbols are typically ≤5 chars (NYSE/NASDAQ)
    MAX_ORDER_QTY: 999999     // Fidelity option limit is 999 contracts; equity ~100k shares
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
    MARGIN_CALC_ENDPOINT:  '/ftgw/digital/api-margin-calculator/api/trade-calculator/v1',
    // Returns current positions + baseline balance (no order needed).
    POSITIONS_ENDPOINT:    '/ftgw/digital/api-margin-calculator/api/current-status/v1',
    // Account list used by the option-chain annotator to pick a default account when no
    // trade ticket has been used yet.
    ACCOUNTS_ENDPOINT:     '/ftgw/digital/api-margin-calculator/api/accounts/v1',
    // Referrer required by Fidelity's margin calculator API — requests from other pages
    // get 400 without it. Enforced via declarativeNetRequest rules in rules.json too.
    MARGIN_CALC_REFERRER:  'https://digital.fidelity.com/ftgw/digital/margin-calculator/',
    // XSRF cookie and header names for the margin calculator API.
    // Path-scoped to /ftgw/digital/margincalcex/ — may be absent on other pages.
    // Centralised here so a Fidelity cookie/header rename only requires one edit.
    XSRF_COOKIE_NAME: 'MARGIN-CALCULATOR-XSRF-TOKEN',
    XSRF_HEADER:      'X-XSRF-TOKEN',
    // Fidelity's login hostname — used by isSessionExpiredResponse() to detect
    // session-expiry redirects. Centralised here so a Fidelity login-domain change
    // (e.g. from login.fidelity.com to auth.fidelity.com) only requires one edit,
    // consistent with how MARGIN_CALC_REFERRER and POSITIONS_ENDPOINT are managed.
    LOGIN_HOSTNAME: 'login.fidelity.com'
  }),

  // Margin calculator API request body flags — extracted from margin-api.js buildBody()
  // so a Fidelity API contract change only requires an edit in one place.
  MARGIN_API_CONFIG: Object.freeze({
    EXECUTE_OPEN_ORDERS_IND: false,
    PRICE_SOURCE_IND:        'S',
    EXECUTE_HPO_TXNS_IND:    true,
    BALANCES_ONLY_IND:       false,
    RBR_ADDONS_IND:          true
  }),

  // Positions price calculation factors — centralized so a contract-size or bond-pricing
  // change only requires an edit here, and the CLAUDE.md "Price derivation" notes stay
  // accurate without hunting through positions.js.
  POSITIONS_CALC: Object.freeze({
    OPTION_CONTRACT_SHARES: 100, // options contracts represent 100 underlying shares
    BOND_PRICE_FACTOR: 100,      // bonds are quoted per $100 face value
    // Security type strings returned by Fidelity's portfolio API (lowercased for comparison).
    // Centralised here so a Fidelity API change to these strings only requires one edit,
    // consistent with how OPTION_CONTRACT_SHARES and BOND_PRICE_FACTOR are managed.
    OPTION_SECURITY_TYPE: 'option',
    // Bond-priced security types: price = (mktVal / qty) * BOND_PRICE_FACTOR.
    // 'bond' covers regular bonds and T-bills as returned by Fidelity's portfolio API.
    // Add further entries here if Fidelity introduces additional fixed-income types
    // (e.g. 'fixed income', 'treasury') that use per-$100-face-value pricing.
    BOND_SECURITY_TYPES: Object.freeze(['bond']),
    // Upper bound for a stripped position symbol from the portfolio API.
    // Full option symbols are at most ~20 chars (e.g. 'GOOGL261218C2000.5' = 18 chars);
    // 50 is a generous safety limit that catches clearly malformed API responses without
    // ever rejecting a real position. Mirrors MAX_SYMBOL_LEN in DETECTOR (which guards
    // underlying ticker symbols only — typically ≤5 chars).
    MAX_POSITION_SYMBOL_LEN: 50
  }),

  // Positions API request configuration — extracted from positions.js doFetchPriceList()
  // and positionToPriceListEntry() so Fidelity API contract changes only require edits here.
  POSITIONS_CONFIG: Object.freeze({
    EXECUTE_OPEN_ORDERS_IND: null,  // request-body flags for current-status/v1
    EXECUTE_HPO_TXNS_IND:    false,
    BALANCES_ONLY_IND:       false,
    RBR_ADDONS_IND:          true,
    PRICE_IND:               'initial' // priceInd value used in every priceList entry
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
  }),

  // Error messages thrown by API client modules (lib/margin-api.js, lib/positions.js).
  // Centralised here so a copy-edit or string rename is reflected in both modules
  // automatically, and so the wording stays consistent with USER_MESSAGES above.
  // TIMEOUT_SUFFIX is appended to an API-specific prefix (e.g. "Margin API request
  // timed out") rather than being a complete sentence, keeping the per-API context.
  API_ERROR_MESSAGES: Object.freeze({
    NETWORK_ERROR:   'Network error — check your connection',
    SESSION_EXPIRED: 'Session expired — please log in to Fidelity',
    TIMEOUT_SUFFIX:  '— Fidelity may be slow'
  }),

  // User-facing panel and status messages — centralised so a UX copy-edit only
  // requires a single change here rather than hunting through content/main.js.
  // Keys ending in _SHORT are the condensed versions shown in the popup status
  // display where space is limited; the full versions appear in the injected panel.
  USER_MESSAGES: Object.freeze({
    SESSION_EXPIRED:       'Session expired. Please refresh the page.',
    NO_POSITIONS:          'No positions found for this account. Margin calculation requires at least one existing position.',
    NO_POSITIONS_SHORT:    'No positions found',
    NO_ACCOUNT:            'Could not detect account number — try refreshing the page.',
    NO_ACCOUNT_SHORT:      'Could not detect account number',
    PARSE_TRADE_FAILED:    'Could not parse trade details — verify the form is filled in correctly.',
    PARSE_TRADE_SHORT:     'Could not parse trade details',
    INJECTION_TARGET_GONE: 'Injection target not found — Fidelity page layout may have changed',
    // Fallback messages used in the catch blocks of handleTradeReady when the typed
    // error from the API client does not carry a message. Centralised here so a copy
    // edit only requires one change, consistent with all other user-facing messages.
    FETCH_POSITIONS_FAILED: 'Unable to fetch account positions.',
    FETCH_MARGIN_FAILED:    'Unable to calculate margin impact.',
    // Shown when the margin API response is missing balance data entirely —
    // distinct from a fetch failure so the panel text is accurate.
    NO_MARGIN_DATA:         'No margin data available for this account.',
    NO_MARGIN_DATA_SHORT:   'No margin data',

    // Circuit breaker messages — include a dynamic countdown so the user
    // knows how long to wait before the extension retries automatically.
    // Centralised here so a copy-edit only requires one change, consistent
    // with all other user-facing messages above.
    // @param {number} s - Remaining seconds until the circuit closes.
    CIRCUIT_BREAKER_PANEL:  (s) => `API temporarily unavailable — pausing ${s}s`,
    CIRCUIT_BREAKER_STATUS: (s) => `Circuit breaker open — ${s}s remaining`
  }),

  // Popup UI timing constants — centralised here so the same edit tunes both
  // the status-refresh ticker and the force-recalculate button feedback delay.
  POPUP: Object.freeze({
    // How often (ms) to re-render the "Last Calc" timeAgo display while the popup is open.
    TIME_REFRESH_INTERVAL_MS: 5000,
    // How long (ms) to show the force-recalculate button's feedback label before clearing it.
    FEEDBACK_CLEAR_MS: 1500,
    // User-facing feedback strings for the force-recalculate button — centralised here so a
    // copy-edit only requires one change, consistent with USER_MESSAGES and PANEL_TEXT above.
    FORCE_RECALC_FEEDBACK: Object.freeze({
      OK:         'Recalculate requested.',
      DISABLED:   'Extension is disabled.',
      INACTIVE:   'No active trade ticket.',
      NO_CONTENT: 'Not active on this tab.',
      NO_TAB:     'No active tab found.',
      ERROR:      'Error sending request.'
    })
  }),

  // Injected panel UI text — centralised so a copy-edit only requires a single change here
  // rather than hunting through content/injector.js. Mirrors the same pattern used by
  // USER_MESSAGES for status/error text in content/main.js.
  PANEL_TEXT: Object.freeze({
    // Column headers (static — set once at panel creation)
    CREDIT_DEBIT_INITIAL: 'Margin Credit/Debit', // shown before first result is available
    CASH_WITHDRAWABLE:    'Cash Withdrawable',
    CASH_SUBLABEL:        'without margin interest',
    BUYING_POWER:         'Buying Power',
    BUYING_POWER_SUBLABEL:'margin buying power',

    // Second row — extra figures derived from responses already fetched (no extra requests)
    REQUIREMENT:        'Margin Requirement',
    REQUIREMENT_SUFFIX: 'from current',
    HOUSE_SURPLUS:      'House Surplus',
    HOUSE_CALL:         'House Call',
    PREMIUM_CREDIT:     'Premium Received',
    PREMIUM_DEBIT:      'Premium Paid',
    PREMIUM_SUBLABEL:   'before fees',

    // Dynamic column 1 label — updated by updatePanel() based on sign of projectedCreditDebit
    CREDIT_LABEL: 'Margin Credit',
    DEBIT_LABEL:  'Margin Debit',

    // Delta sub-label variants
    DELTA_NO_BASELINE: 'projected with trade', // shown when no previous result is cached
    DELTA_SUFFIX:      'from current',         // appended to the formatted delta value

    // Panel state labels
    LOADING_TEXT: 'Calculating margin impact...',

    // Panel region ARIA label — set once at panel creation; centralised here so a
    // copy-edit only requires a single change, consistent with all other UI text above.
    PANEL_ARIA_LABEL: 'Margin Impact',

    // Button labels
    RETRY_BTN:        'Retry',
    // aria-label for the Retry button — overrides the short button text with a
    // more descriptive label for screen readers.
    RETRY_ARIA_LABEL: 'Retry margin calculation',
    DEBUG_BTN_SHOW:  'Debug',
    DEBUG_BTN_HIDE:  'Hide',
    DEBUG_ARIA_SHOW: 'Show debug log',
    DEBUG_ARIA_HIDE: 'Hide debug log',

    // Debug log container ARIA label — used as the accessible name for the debug log div.
    // Centralised here so a copy-edit requires only one change, consistent with all other
    // ARIA labels (PANEL_ARIA_LABEL, RETRY_ARIA_LABEL, DEBUG_ARIA_SHOW, DEBUG_ARIA_HIDE) above.
    DEBUG_LOG_ARIA_LABEL: 'Debug log',

    // Placeholder shown inside the debug log when no entries are present.
    // Centralised here so a rewording only requires one change rather than hunting injector.js.
    DEBUG_LOG_EMPTY: '(no log entries)',

    // Fallback shown in the error panel when an error message is absent or empty.
    // Centralised here so a copy-edit is consistent with USER_MESSAGES and the rest of PANEL_TEXT.
    UNKNOWN_ERROR: 'Unknown error',

    // Attribution badge
    ATTRIBUTION: 'Margin Calc'
  })
});
