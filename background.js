// Background service worker — cache manager, rate limiter, account tracker
// API calls stay in content scripts (same-origin cookies); background coordinates.

(() => {
  const LOG_PREFIX = '[FMC-BG]';
  const MAX_CACHE_ENTRIES = 50;
  const DEFAULT_CACHE_TTL = 60000;
  const MIN_API_INTERVAL = 2000;

  // --- In-memory cache (lost on service worker termination — by design) ---
  const cache = new Map(); // key -> { data, expires, lastAccess }
  const apiCallLog = new Map(); // accountNum -> lastCallTimestamp
  const tabAccounts = new Map(); // tabId -> accountNum

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  // --- LRU eviction ---
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
  function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return { hit: false, data: null, age: 0 };
    if (Date.now() > entry.expires) {
      cache.delete(key);
      return { hit: false, data: null, age: 0 };
    }
    const now = Date.now();
    entry.lastAccess = now;
    return { hit: true, data: entry.data, age: now - (entry.expires - entry.ttl) };
  }

  function cacheSet(key, data, ttl) {
    const now = Date.now();
    cache.set(key, { data, expires: now + ttl, ttl, lastAccess: now });
    evictIfNeeded();
    return { ok: true };
  }

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
  function checkRateLimit(accountNum) {
    const last = apiCallLog.get(accountNum) || 0;
    const elapsed = Date.now() - last;
    if (elapsed < MIN_API_INTERVAL) {
      return { rateLimited: true, retryAfter: MIN_API_INTERVAL - elapsed };
    }
    apiCallLog.set(accountNum, Date.now());
    return { rateLimited: false };
  }

  // --- Account tracking ---
  function handleAccountChanged(tabId, accountNum, previousAccountNum) {
    if (tabId === undefined) return { ok: false, error: 'no tab context' };
    tabAccounts.set(tabId, accountNum);
    if (previousAccountNum && previousAccountNum !== accountNum) {
      // Invalidate cache for old account
      cacheInvalidate(null, `pricelist:${previousAccountNum}`);
      cacheInvalidate(null, `projected:${previousAccountNum}`);
      log('Account switched', previousAccountNum, '->', accountNum, '- cache cleared');
    }
    return { ok: true };
  }

  // --- Message router ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg._fmc) return false;

    const tabId = sender.tab?.id;

    switch (msg.type) {
      case 'CACHE_GET':
        sendResponse(cacheGet(msg.payload.key));
        return false;

      case 'CACHE_SET':
        sendResponse(cacheSet(msg.payload.key, msg.payload.data, msg.payload.ttl || DEFAULT_CACHE_TTL));
        return false;

      case 'CACHE_INVALIDATE':
        sendResponse(cacheInvalidate(msg.payload.key, msg.payload.pattern));
        return false;

      case 'ACCOUNT_CHANGED':
        sendResponse(handleAccountChanged(tabId, msg.payload.accountNum, msg.payload.previousAccountNum));
        return false;

      case 'LOG_API_CALL':
        sendResponse(checkRateLimit(msg.payload.accountNum));
        return false;

      case 'GET_STATE':
        sendResponse({
          activeAccount: tabId !== undefined ? (tabAccounts.get(tabId) || null) : null,
          cacheSize: cache.size,
          lastApiCall: apiCallLog.get(msg.payload.accountNum) || 0
        });
        return false;

      case 'SET_BADGE': {
        const badgeTarget = tabId !== undefined ? { tabId } : {};
        if (msg.payload.text) {
          chrome.action.setBadgeText({ text: msg.payload.text, ...badgeTarget });
          chrome.action.setBadgeBackgroundColor({ color: msg.payload.color || '#c41200', ...badgeTarget });
        } else {
          chrome.action.setBadgeText({ text: '', ...badgeTarget });
        }
        sendResponse({ ok: true });
        return false;
      }

      case 'HEARTBEAT':
        sendResponse({ ok: true });
        return false;

      default:
        sendResponse({ error: 'unknown message type' });
        return false;
    }
  });

  // --- Periodic expired-entry cleanup ---
  // MV3 service workers are terminated after ~30s of inactivity, making setInterval
  // unreliable. chrome.alarms survives service worker restarts and runs the cleanup
  // even after the worker is restarted by a new message.
  const CLEANUP_ALARM = 'fmc-cache-cleanup';
  chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== CLEANUP_ALARM) return;
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now > entry.expires) cache.delete(key);
    }
  });

  // Clean up tab tracking when tabs close
  chrome.tabs.onRemoved.addListener((tabId) => {
    const accountNum = tabAccounts.get(tabId);
    if (accountNum) apiCallLog.delete(accountNum);
    tabAccounts.delete(tabId);
  });

  chrome.runtime.onInstalled.addListener(() => {
    log('Extension installed/updated');
  });
})();
