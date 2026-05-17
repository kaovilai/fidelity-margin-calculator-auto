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
  // Badge colors — shared between content/main.js (sender) and background.js (fallback default).
  // Keeping them here prevents the two files from silently drifting to different hex values.
  BADGE_COLORS: Object.freeze({
    ERROR: '#c41200',
    WARNING: '#f5a623'
  }),
  // Cache TTLs for content/main.js — named here so the values are self-documenting
  // and easy to tune without hunting through main.js.
  CACHE_TTL_MS: Object.freeze({
    PRICELIST: 300000, // 5 min — positions change infrequently
    PROJECTED:  30000  // 30 s  — projected result tied to specific order params
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
  // Background alarm period for expired cache cleanup
  BG_CLEANUP_INTERVAL_MINUTES: 1,
  // Content-script in-memory fallback cache limit (entries, not bytes)
  CONTENT_FALLBACK_CACHE_MAX: 30,
  // Token-bucket rate limiter for content-script API calls
  RATE_LIMITER: Object.freeze({
    CAPACITY: 10,           // max burst tokens
    REFILL_INTERVAL_MS: 3000 // one token added per this interval
  })
});
