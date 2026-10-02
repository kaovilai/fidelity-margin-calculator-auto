// Background service worker — cache manager, rate limiter, account tracker
// API calls stay in content scripts (same-origin cookies); background coordinates.
'use strict';

importScripts('/lib/constants.js', '/lib/tax-rates.js', '/lib/mmf-model.js');

(() => {
  const LOG_PREFIX = '[FMC-BG]';
  const { MAX_ENTRIES: MAX_CACHE_ENTRIES, DEFAULT_TTL_MS: DEFAULT_CACHE_TTL, MIN_API_INTERVAL_MS: MIN_API_INTERVAL } = FMC_CONSTANTS.BG_CACHE;
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
   * Evicts the least-recently-used cache entry when the cache exceeds MAX_CACHE_ENTRIES.
   * Called after every `cacheSet` to enforce the entry cap.
   * Uses Map insertion order: `cacheGet` moves accessed entries to the end (MRU),
   * so the first entry in iteration order is always the LRU candidate — O(1) eviction.
   */
  function evictIfNeeded() {
    if (cache.size <= MAX_CACHE_ENTRIES) return;
    // First entry in Map iteration order is the LRU (least recently accessed).
    // cacheGet promotes entries to the end on access, so this is always correct.
    cache.delete(cache.keys().next().value);
  }

  // --- Cache operations ---
  /**
   * Retrieves a cached value by key.
   * Returns a miss (`hit: false`) if the entry is absent or expired (expired entries are deleted).
   * Promotes the accessed entry to the end of Map insertion order so it is treated as
   * most-recently-used (MRU) by `evictIfNeeded` — the entry at the front is always LRU.
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
    // Promote to MRU by deleting and re-inserting — moves entry to end of Map order.
    cache.delete(key);
    cache.set(key, entry);
    return { hit: true, data: entry.data, age: now - entry.storedAt };
  }

  /**
   * Stores a value in the cache under `key` with the given TTL.
   * Triggers LRU eviction if the cache exceeds MAX_CACHE_ENTRIES after insertion.
   * Falls back to `DEFAULT_CACHE_TTL` when `ttl` is missing, non-finite, or ≤ 0.
   * Deletes any existing entry before inserting so re-sets move the key to the end
   * of Map insertion order (= MRU), keeping eviction order consistent.
   * @param {string} key - Cache key.
   * @param {*} data - Value to store.
   * @param {number} [ttl] - Time-to-live in milliseconds.
   * @returns {{ ok: true }}
   */
  function cacheSet(key, data, ttl) {
    const now = Date.now();
    const safeTtl = (Number.isFinite(ttl) && ttl > 0) ? ttl : DEFAULT_CACHE_TTL;
    // Delete before inserting so an updated entry moves to the end of Map order (MRU).
    cache.delete(key);
    cache.set(key, { data, expires: now + safeTtl, ttl: safeTtl, storedAt: now });
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

  // --- Money-market yields (Fidelity fund screener) ---
  const MMF_TTL_MS = 15 * 60 * 1000;
  let mmfCache = null; // { ts, data }

  /**
   * Fetches the screener's money-market list: 7-day yield, category and minimums per fund.
   * Cached for 15 minutes (yields change daily). Cross-origin, so it runs here rather than in a
   * content script.
   * @returns {Promise<Object>} The screener's raw response.
   */
  async function fetchMmfYields() {
    if (mmfCache && Date.now() - mmfCache.ts < MMF_TTL_MS) return mmfCache.data;
    const resp = await fetch(FMC_CONSTANTS.API.MMF_SCREENER_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        searchFilter: {
          includeLeveragedAndInverseFunds: 'N', openToNewInvestors: 'OPEN', investmentTypeCode: 'MFN',
          assetClass: 'MM', category: 'TM,TF,XT', fidelityFundOnly: 'F'
        },
        sortBy: 'averageAnnualReturnsYear3', sortOrder: 'DESC', currentPageNumber: 1,
        businessChannel: 'RETAIL', noOfRowsPerPage: 100,
        subjectAreaCode: 'fundInformation,dailyNAV,fundFeatures'
      })
    });
    if (!resp.ok) throw new Error(`Fund screener HTTP ${resp.status}`);
    const data = await resp.json();
    if (!Array.isArray(data?.funds)) throw new Error('Unexpected fund screener response');
    mmfCache = { ts: Date.now(), data };
    return data;
  }

  // --- Tax rates (IRS brackets + Tax Foundation state rates), cached 30 days ---
  const TAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  /**
   * Live federal brackets and the requested state's flat rate, parsed from public pages.
   * Returns `{ irs, stateRates, ts }`; either part may be null if its page changed shape (the
   * caller then falls back to configured values). The result is cached in chrome.storage.local.
   * @param {string} state - Two-letter state code.
   */
  async function fetchTaxRates(state) {
    const key = FMC_CONSTANTS.STORAGE_KEY_TAX_CACHE;
    const stored = (await chrome.storage.local.get(key))[key];
    if (stored && Date.now() - stored.ts < TAX_TTL_MS && (!state || state in (stored.stateRates ?? {}))) return stored;
    const page = async (url) => {
      try {
        const r = await fetch(url, { headers: { accept: 'text/html' } });
        return r.ok ? TaxRates.toText(await r.text()) : null;
      } catch { return null; }
    };
    const [irsText, stateText] = await Promise.all([page(FMC_CONSTANTS.API.IRS_BRACKETS_URL), page(FMC_CONSTANTS.API.STATE_RATES_URL)]);
    const result = {
      ts: Date.now(),
      irs: irsText ? TaxRates.parseIrsBrackets(irsText) : (stored?.irs ?? null),
      stateRates: { ...(stored?.stateRates ?? {}) }
    };
    if (state) result.stateRates[state] = stateText ? TaxRates.parseStateRate(stateText, state) : (stored?.stateRates?.[state] ?? null);
    await chrome.storage.local.set({ [key]: result });
    return result;
  }

  // --- Daily best-after-tax money-market check ---
  const FMC_SETTINGS_KEY = FMC_CONSTANTS.STORAGE_KEY_SETTINGS;
  const FIDELITY_POSITIONS_URL = 'https://digital.fidelity.com/ftgw/digital/portfolio/positions';
  const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

  /** Tax configuration from the user's synced settings (same resolution rules as TaxContext). */
  function taxConfig(s) {
    const n = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    return {
      filing: s.taxFiling || 'single', income: n(s.taxIncome) ?? 150000,
      state: String(s.taxState || 'NC').toUpperCase(),
      federalOverride: n(s.taxFederalOverride), stateOverride: n(s.taxStateOverride),
      federalFallback: 24, stateFallback: 4.25
    };
  }

  /**
   * Recomputes the best after-tax money-market fund for each account whose balances we last saw
   * (within a week) and notifies when the recommendation changed since the last check. Runs at most
   * once per calendar day (the result is cached); `force` bypasses that.
   * Never touches Fidelity pages: yields come from the public fund screener, balances from the
   * snapshot the content scripts keep in chrome.storage.local.
   * @param {boolean} [force=false]
   * @returns {Promise<Object|null>} The day's result, or null when disabled.
   */
  async function runMmfDailyCheck(force = false) {
    const settings = (await chrome.storage.sync.get(FMC_SETTINGS_KEY))[FMC_SETTINGS_KEY] ?? {};
    if (settings.mmfEnabled === false) return null;
    const dailyKey = FMC_CONSTANTS.STORAGE_KEY_MMF_DAILY;
    const last = (await chrome.storage.local.get(dailyKey))[dailyKey] ?? null;
    const today = new Date().toLocaleDateString('en-CA');
    if (!force && last?.date === today) return last;

    const funds = MmfModel.parseFunds(await fetchMmfYields());
    const cfg = taxConfig(settings);
    const live = await fetchTaxRates(cfg.state).catch(() => null);
    const resolved = TaxRates.resolve({ config: cfg, live });
    const rates = { federal: resolved.federal, state: resolved.state, stateCode: cfg.state };

    // Best fund anyone can buy with no minimum — useful context even without balance snapshots.
    const open = funds.filter(f => f.minInitial === 0 && f.minBalance === 0)
      .map(f => ({ ticker: f.ticker, afterTax: MmfModel.afterTax(f, rates) }))
      .filter(f => f.afterTax !== null).sort((a, b) => b.afterTax - a.afterTax)[0] ?? null;

    const snapshots = (await chrome.storage.local.get(FMC_CONSTANTS.STORAGE_KEY_MMF_HOLDINGS))[FMC_CONSTANTS.STORAGE_KEY_MMF_HOLDINGS] ?? {};
    const accounts = {};
    for (const [acct, snap] of Object.entries(snapshots)) {
      if (Date.now() - snap.ts > FMC_CONSTANTS.MMF_HOLDINGS_MAX_AGE_MS || !Object.keys(snap.holdings ?? {}).length) continue;
      const plan = MmfModel.plan({ funds, holdings: snap.holdings, rates });
      accounts[acct] = plan.target
        ? { target: plan.target.ticker, afterTax: plan.target.afterTax, amountIn: plan.amountIn, annualGain: plan.annualGain, from: plan.moves.map(m => m.from) }
        : { target: null };
    }
    const result = { date: today, ts: Date.now(), rates, best: open, accounts };
    await chrome.storage.local.set({ [dailyKey]: result });

    // Notify only for a CHANGED recommendation that actually has something to move.
    const changed = Object.entries(accounts).filter(([acct, a]) => a.target && last?.accounts?.[acct]?.target !== a.target);
    if (changed.length) {
      const [acct, a] = changed[0];
      const masked = `…${acct.slice(-4)}`;
      chrome.notifications.create('fmc-mmf-better', {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
        title: 'Better money-market yield available',
        message: `${a.target} now leads at ${a.afterTax.toFixed(2)}% after tax (account ${masked}). Moving ${money(a.amountIn)} from ${a.from.join(', ')} could add about ${money(a.annualGain)}/yr. Open Fidelity to move it.`,
        priority: 1
      });
      setBadge({}, '$', '#2e7d32');
    }
    log(`MMF daily check: best open ${open?.ticker} ${open?.afterTax?.toFixed(2)}%, changed accounts: ${changed.length}`);
    return result;
  }

  chrome.notifications.onClicked.addListener((id) => {
    if (id !== 'fmc-mmf-better') return;
    chrome.tabs.create({ url: FIDELITY_POSITIONS_URL });
    chrome.notifications.clear(id);
    setBadge({}, '', null);
  });

  // Once a day via chrome.alarms (survives worker restarts); also catch up on startup when a day was missed.
  (async () => {
    try {
      const name = FMC_CONSTANTS.MMF_DAILY_ALARM;
      if (!(await chrome.alarms.get(name))) await chrome.alarms.create(name, { delayInMinutes: 5, periodInMinutes: 24 * 60 });
      runMmfDailyCheck().catch(e => warn('MMF daily check failed:', e.message));
    } catch (e) { warn('Could not set up MMF daily alarm:', e.message); }
  })();
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === FMC_CONSTANTS.MMF_DAILY_ALARM) runMmfDailyCheck().catch(e => warn('MMF daily check failed:', e.message));
  });

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

        case FMC_CONSTANTS.MESSAGE_TYPES.FETCH_MMF_YIELDS:
          // Asynchronous: keep the message port open until the fetch settles.
          fetchMmfYields().then(sendResponse, (e) => sendResponse({ error: e?.message ?? 'fetch failed' }));
          return true;

        case FMC_CONSTANTS.MESSAGE_TYPES.FETCH_TAX_RATES:
          fetchTaxRates(String(msg.payload?.state ?? '')).then(sendResponse, (e) => sendResponse({ error: e?.message ?? 'fetch failed' }));
          return true;

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
  const CLEANUP_ALARM = FMC_CONSTANTS.BG_CLEANUP_ALARM_NAME;
  (async () => {
    try {
      const existing = await chrome.alarms.get(CLEANUP_ALARM);
      // Recreate the alarm when absent OR when its period no longer matches the constant.
      // Without the period check, an extension update that changes CLEANUP_INTERVAL_MINUTES
      // would silently continue using the old period since Chrome persists alarms across
      // service worker restarts and the existence guard would prevent recreation.
      if (!existing || existing.periodInMinutes !== CLEANUP_INTERVAL_MINUTES) {
        if (existing) await chrome.alarms.clear(CLEANUP_ALARM);
        await chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: CLEANUP_INTERVAL_MINUTES });
      }
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

  chrome.runtime.onInstalled.addListener((details) => {
    const { version } = chrome.runtime.getManifest();
    if (details.reason === 'update') {
      log(`Extension updated: ${details.previousVersion} → ${version}`);
    } else {
      log(`Extension ${details.reason} (version: ${version})`);
    }
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
