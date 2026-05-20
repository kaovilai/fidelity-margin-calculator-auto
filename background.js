// Background service worker — cache manager, rate limiter, account tracker
// API calls stay in content scripts (same-origin cookies); background coordinates.
'use strict';

importScripts('/lib/constants.js');

(() => {
  const LOG_PREFIX = '[FMC-BG]';
  const MAX_CACHE_ENTRIES = FMC_CONSTANTS.BG_CACHE.MAX_ENTRIES;
  const DEFAULT_CACHE_TTL = FMC_CONSTANTS.BG_CACHE.DEFAULT_TTL_MS;
  const MIN_API_INTERVAL = FMC_CONSTANTS.BG_CACHE.MIN_API_INTERVAL_MS;
  const CLEANUP_INTERVAL_MINUTES = FMC_CONSTANTS.BG_CLEANUP_INTERVAL_MINUTES;

  // --- In-memory cache (lost on service worker termination — by design) ---
  const cache = new Map(); // key -> { data, expires, lastAccess }
  const apiCallLog = new Map(); // accountNum -> lastCallTimestamp
  const tabAccounts = new Map(); // tabId -> accountNum

  /** @param {...*} args - Values forwarded to console.log after the module prefix. */
  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  /** @param {...*} args - Values forwarded to console.warn after the module prefix. */
  function warn(...args) {
    console.warn(LOG_PREFIX, ...args);
  }

  /**
   * Sets or clears the extension action badge.
   * If `text` is non-empty, also updates the badge background color.
   * @param {Object} badgeTarget - `{ tabId }` to scope the badge to a tab, or `{}` for global.
   * @param {string} [text] - Badge text; empty string or falsy clears the badge.
   * @param {string} [color] - Badge background color hex string; defaults to BADGE_COLORS.ERROR.
   */
  function setBadge(badgeTarget, text, color) {
    if (text) {
      chrome.action?.setBadgeText({ text, ...badgeTarget })?.catch(() => {});
      chrome.action?.setBadgeBackgroundColor({ color: color || FMC_CONSTANTS.BADGE_COLORS.ERROR, ...badgeTarget })?.catch(() => {});
    } else {
      chrome.action?.setBadgeText({ text: '', ...badgeTarget })?.catch(() => {});
    }
  }

  /**
   * Clears any stale badge text and status storage entry left over from a previous session.
   * Called from both onInstalled and onStartup since both events represent a clean-slate scenario
   * where old persisted state (error badges, last-active status) should not be shown to the user.
   */
  function clearStartupState() {
    chrome.action?.setBadgeText({ text: '' })?.catch(() => {});
    chrome.storage.local.remove(FMC_CONSTANTS.STORAGE_KEY_STATUS).catch(() => {});
  }

  // --- LRU eviction ---
  /**
   * Evicts the least-recently-accessed cache entry when the cache exceeds MAX_CACHE_ENTRIES.
   * Called after every `cacheSet` to enforce the entry cap.
   */
  function evictIfNeeded() {
    if (cache.size <= MAX_CACHE_ENTRIES) return;
    // Find least recently accessed
    let oldestKey = null;
    let oldestAccess = Infinity;
    for (const [key, entry] of cache) {
      if (entry.lastAccess < oldestAccess) {
        oldestAccess = entry.lastAccess;
        oldestKey = key;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
  }

  // --- Cache operations ---
  /**
   * Retrieves a cached value by key.
   * Returns a miss (`hit: false`) if the entry is absent or expired (expired entries are deleted).
   * Updates `lastAccess` on hits to support LRU eviction in `evictIfNeeded`.
   * @param {string} key - Cache key.
   * @returns {{ hit: boolean, data: *, age: number }}
   *   `hit`: whether a live entry was found.
   *   `data`: the cached value, or `null` on a miss.
   *   `age`: elapsed ms since the entry was stored, or `0` on a miss.
   */
  function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return { hit: false, data: null, age: 0 };
    const now = Date.now();
    if (now > entry.expires) {
      cache.delete(key);
      return { hit: false, data: null, age: 0 };
    }
    entry.lastAccess = now;
    return { hit: true, data: entry.data, age: now - (entry.expires - entry.ttl) };
  }

  /**
   * Stores a value in the cache under `key` with the given TTL.
   * Triggers LRU eviction if the cache exceeds MAX_CACHE_ENTRIES after insertion.
   * Falls back to `DEFAULT_CACHE_TTL` when `ttl` is missing, non-finite, or ≤ 0.
   * @param {string} key - Cache key.
   * @param {*} data - Value to store.
   * @param {number} [ttl] - Time-to-live in milliseconds.
   * @returns {{ ok: true }}
   */
  function cacheSet(key, data, ttl) {
    const now = Date.now();
    const safeTtl = (typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0) ? ttl : DEFAULT_CACHE_TTL;
    cache.set(key, { data, expires: now + safeTtl, ttl: safeTtl, lastAccess: now });
    evictIfNeeded();
    return { ok: true };
  }

  /**
   * Removes cache entries matching an exact key and/or a key-prefix pattern.
   * Both `key` and `pattern` are optional; at least one should be provided.
   * @param {string|null|undefined} key - Exact cache key to delete, or falsy to skip exact match.
   * @param {string|null|undefined} pattern - Key prefix; all entries whose key starts with this
   *   string are deleted. Falsy skips prefix matching.
   * @returns {{ ok: true, cleared: number }} Number of entries removed.
   */
  function cacheInvalidate(key, pattern) {
    let cleared = 0;
    if (key) {
      if (cache.delete(key)) cleared++;
    }
    if (pattern) {
      for (const k of cache.keys()) {
        if (k.startsWith(pattern)) {
          cache.delete(k);
          cleared++;
        }
      }
    }
    return { ok: true, cleared };
  }

  // --- Rate limiting ---
  /**
   * Checks whether an API call for `accountNum` is within the minimum inter-call interval.
   * If allowed, records `Date.now()` as the last call time for this account.
   * @param {string} accountNum - Brokerage account number.
   * @returns {{ rateLimited: false } | { rateLimited: true, retryAfter: number }}
   *   `retryAfter`: ms to wait before retrying when rate-limited.
   */
  function checkRateLimit(accountNum) {
    const last = apiCallLog.get(accountNum) ?? 0;
    const elapsed = Date.now() - last;
    if (elapsed < MIN_API_INTERVAL) {
      return { rateLimited: true, retryAfter: MIN_API_INTERVAL - elapsed };
    }
    apiCallLog.set(accountNum, Date.now());
    return { rateLimited: false };
  }

  // --- Account tracking ---
  /**
   * Records the new account for a tab and invalidates the cache for the previous account.
   * Called when the content script detects the user switched to a different account.
   * @param {number|null} tabId - Chrome tab ID of the content script sender.
   * @param {string} accountNum - Newly active account number.
   * @param {string|null|undefined} previousAccountNum - Previously active account, or falsy if unknown.
   * @returns {{ ok: boolean, error?: string }}
   */
  function handleAccountChanged(tabId, accountNum, previousAccountNum) {
    if (tabId == null) return { ok: false, error: 'no tab context' };
    tabAccounts.set(tabId, accountNum);
    if (previousAccountNum && previousAccountNum !== accountNum) {
      // Invalidate cache for old account
      cacheInvalidate(null, `${FMC_CONSTANTS.CACHE_KEY_PREFIX.PRICELIST}${previousAccountNum}`);
      cacheInvalidate(null, `${FMC_CONSTANTS.CACHE_KEY_PREFIX.PROJECTED}${previousAccountNum}`);
      log('Account switched', previousAccountNum, '->', accountNum, '- cache cleared');
    }
    return { ok: true };
  }

  // --- Message router ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg?._fmc) return false;
    // Only process messages from this extension's own scripts (content scripts, popup).
    // Rejects messages from other extensions or external sources that somehow spoof _fmc.
    if (sender.id !== chrome.runtime.id) return false;

    const tabId = sender.tab?.id;

    try {
      switch (msg.type) {
        case FMC_CONSTANTS.MESSAGE_TYPES.CACHE_GET:
          if (!msg.payload?.key) { sendResponse({ hit: false, data: null, age: 0 }); return false; }
          sendResponse(cacheGet(msg.payload.key));
          return false;

        case FMC_CONSTANTS.MESSAGE_TYPES.CACHE_SET:
          if (!msg.payload?.key) { sendResponse({ ok: false }); return false; }
          sendResponse(cacheSet(msg.payload.key, msg.payload.data, msg.payload.ttl ?? DEFAULT_CACHE_TTL));
          return false;

        case FMC_CONSTANTS.MESSAGE_TYPES.CACHE_INVALIDATE:
          if (!msg.payload) { sendResponse({ ok: false, cleared: 0 }); return false; }
          sendResponse(cacheInvalidate(msg.payload.key, msg.payload.pattern));
          return false;

        case FMC_CONSTANTS.MESSAGE_TYPES.ACCOUNT_CHANGED:
          if (!msg.payload?.accountNum) { sendResponse({ ok: false, error: 'missing accountNum' }); return false; }
          sendResponse(handleAccountChanged(tabId, msg.payload.accountNum, msg.payload.previousAccountNum));
          return false;

        case FMC_CONSTANTS.MESSAGE_TYPES.LOG_API_CALL:
          if (!msg.payload?.accountNum) { sendResponse({ rateLimited: false }); return false; }
          // Track this tab→account mapping so the apiCallLog entry can be cleaned up
          // when the tab closes. Without this, the first trade on a tab never sends
          // ACCOUNT_CHANGED (previousAccountNum is null), so tabAccounts never gets set
          // and the apiCallLog entry for that account leaks until the service worker restarts.
          if (tabId != null) tabAccounts.set(tabId, msg.payload.accountNum);
          sendResponse(checkRateLimit(msg.payload.accountNum));
          return false;

        case FMC_CONSTANTS.MESSAGE_TYPES.SET_BADGE: {
          // Use != null (loose) to guard against both undefined (popup sender, no tab) and
          // null, consistent with the tabId == null guard used in handleAccountChanged.
          const badgeTarget = tabId != null ? { tabId } : {};
          setBadge(badgeTarget, msg.payload?.text, msg.payload?.color);
          sendResponse({ ok: true });
          return false;
        }

        case FMC_CONSTANTS.MESSAGE_TYPES.HEARTBEAT:
          sendResponse({ ok: true });
          return false;

        default:
          warn('Unhandled _fmc message type:', msg.type);
          sendResponse({ error: 'unknown message type' });
          return false;
      }
    } catch (e) {
      // Catch unexpected errors so sendResponse is always called — prevents the message
      // port from staying open until the content script's 3-second timeout elapses.
      warn('Unexpected error in message handler:', e?.message ?? e);
      sendResponse({ error: e?.message ?? 'internal error', fallback: true });
      return false;
    }
  });

  // --- Periodic expired-entry cleanup ---
  // MV3 service workers are terminated after ~30s of inactivity, making setInterval
  // unreliable. chrome.alarms survives service worker restarts and runs the cleanup
  // even after the worker is restarted by a new message.
  //
  // Guard: only create the alarm if it doesn't already exist. Calling create()
  // unconditionally resets the period timer every time the service worker is
  // activated (e.g. by cache messages), which can prevent the alarm from ever
  // firing if the worker is woken frequently.
  const CLEANUP_ALARM = 'fmc-cache-cleanup';
  (async () => {
    try {
      const existing = await chrome.alarms.get(CLEANUP_ALARM);
      if (!existing) await chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: CLEANUP_INTERVAL_MINUTES });
    } catch (err) {
      warn('Could not query cleanup alarm, attempting creation anyway:', err.message);
      chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: CLEANUP_INTERVAL_MINUTES })
        .catch(e => warn('Could not create cleanup alarm:', e.message));
    }
  })();
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || alarm.name !== CLEANUP_ALARM) return;
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of cache) {
      if (now > entry.expires) { cache.delete(key); cleaned++; }
    }
    if (cleaned > 0) log(`Cache cleanup: removed ${cleaned} expired entries (${cache.size} remaining)`);
  });

  // Clean up tab tracking when tabs close
  chrome.tabs.onRemoved.addListener((tabId) => {
    const accountNum = tabAccounts.get(tabId);
    tabAccounts.delete(tabId);
    // Only remove from apiCallLog if no other open tab is still using this account.
    // Removing it while another tab holds the same account would reset the rate limit
    // window for that account, allowing back-to-back calls from the surviving tab.
    // Avoid allocating a temporary array: use an early-exit for-of loop.
    let accountStillActive = false;
    for (const acc of tabAccounts.values()) {
      if (acc === accountNum) { accountStillActive = true; break; }
    }
    if (accountNum && !accountStillActive) {
      apiCallLog.delete(accountNum);
    }
  });

  chrome.runtime.onInstalled.addListener(() => {
    log('Extension installed/updated');
    clearStartupState();
  });

  // Clear stale status on every browser startup. Status is persisted to chrome.storage.local
  // so the popup can read it, but after a browser restart the content scripts have not yet
  // run and any stored state (e.g. "Active", last error) is stale. Clearing it here ensures
  // the popup shows "Not connected" on first open after a restart rather than a misleading
  // leftover state from a previous session.
  chrome.runtime.onStartup.addListener(() => {
    log('Browser started — clearing stale session status');
    clearStartupState();
  });
})();
