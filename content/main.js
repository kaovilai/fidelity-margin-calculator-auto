// Main orchestrator — ties detector, positions API, margin API, calc, and injector together
// Single-call architecture: portfolio API provides priceList, margin calc API requires order + priceList.
(() => {
  const LOG_PREFIX = '[FMC]';
  const PRICELIST_TTL = 300000; // 5 min — positions don't change often
  const PROJECTED_TTL = 30000;
  const BADGE_COLOR_ERROR = '#c41200';
  const BADGE_COLOR_WARNING = '#f5a623';
  const BG_MESSAGE_TIMEOUT_MS = 3000;

  const CACHE_KEY = {
    PRICELIST: 'pricelist:',
    PROJECTED: 'projected:'
  };

  const STORAGE_KEY_SETTINGS = FMC_CONSTANTS.STORAGE_KEY_SETTINGS;
  const STORAGE_KEY_STATUS = FMC_CONSTANTS.STORAGE_KEY_STATUS;
  const MSG_SESSION_EXPIRED = 'Session expired. Please refresh the page.';

  // Clamp debounceMs to a safe minimum to prevent runaway polling
  function clampDebounceMs(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < FMC_CONSTANTS.MIN_DEBOUNCE_MS) {
      return FMC_CONSTANTS.MIN_DEBOUNCE_MS;
    }
    return ms;
  }

  let currentRequest = 0;
  let lastAccountNum = null;
  let lastOrders = null;
  let lastResult = null; // cached previous result for delta computation
  let apiCallCount = 0;
  let settings = { ...FMC_CONSTANTS.DEFAULT_SETTINGS };

  // Fallback in-memory cache when background is unavailable
  let fallbackCache = {};
  const FALLBACK_CACHE_MAX = 30;

  // Remove expired entries from fallbackCache to prevent memory growth over long sessions.
  // Also evicts oldest entry if the cache exceeds FALLBACK_CACHE_MAX entries.
  function cleanFallbackCache() {
    const now = Date.now();
    for (const key of Object.keys(fallbackCache)) {
      if (now >= fallbackCache[key].expires) delete fallbackCache[key];
    }
    const keys = Object.keys(fallbackCache);
    if (keys.length > FALLBACK_CACHE_MAX) {
      // Evict the entry with the earliest expiry
      keys.sort((a, b) => fallbackCache[a].expires - fallbackCache[b].expires);
      delete fallbackCache[keys[0]];
    }
  }

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
    if (typeof MarginInjector !== 'undefined' && MarginInjector.addDebugLog) {
      MarginInjector.addDebugLog(args.map(a => {
        if (a instanceof Error) return a.message + (a.stack ? '\n' + a.stack : '');
        if (typeof a !== 'object') return String(a);
        try { return JSON.stringify(a); } catch { return '[unserializable object]'; }
      }).join(' '));
    }
  }

  // --- Settings ---
  async function loadSettings() {
    if (!chrome.storage?.sync) {
      log('Warning: chrome.storage.sync unavailable — using default settings');
      MarginInjector.setWarningThreshold(settings.debitWarningThreshold);
      return;
    }
    try {
      const result = await chrome.storage.sync.get(STORAGE_KEY_SETTINGS);
      if (result[STORAGE_KEY_SETTINGS]) {
        settings = { ...settings, ...result[STORAGE_KEY_SETTINGS] };
      }
    } catch (err) {
      log('Warning: could not load settings:', err.message);
    }
    // Clamp debounceMs on load — same guard as in the onChanged listener.
    // Corrupted or pre-guard stored values would otherwise bypass MIN_DEBOUNCE_MS.
    settings.debounceMs = clampDebounceMs(settings.debounceMs);
    MarginInjector.setWarningThreshold(settings.debitWarningThreshold);
  }

  // --- Status reporting ---
  function reportStatus(state, extra) {
    if (!chrome.storage?.local) return;
    const status = {
      state,
      accountNum: lastAccountNum,
      lastCalcTime: Date.now(),
      apiCallCount,
      lastError: null,
      ...extra
    };
    chrome.storage.local.set({ [STORAGE_KEY_STATUS]: status }).catch(() => {});
  }

  function setBadge(text, color) {
    sendToBackground('SET_BADGE', { text, color });
  }

  // --- Background message helper ---
  function sendToBackground(type, payload, timeoutMs = BG_MESSAGE_TIMEOUT_MS) {
    return new Promise((resolve) => {
      if (!chrome.runtime?.sendMessage) {
        resolve({ error: 'no runtime', fallback: true });
        return;
      }
      const timer = setTimeout(() => {
        resolve({ error: 'timeout', fallback: true });
      }, timeoutMs);
      try {
        chrome.runtime.sendMessage(
          { type, payload, _fmc: true, _ts: Date.now() },
          (response) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) {
              resolve({ error: chrome.runtime.lastError.message, fallback: true });
            } else {
              resolve(response || { fallback: true });
            }
          }
        );
      } catch (e) {
        clearTimeout(timer);
        resolve({ error: e.message, fallback: true });
      }
    });
  }

  // --- Cache ---
  async function getCached(key) {
    const bgResult = await sendToBackground('CACHE_GET', { key });
    if (!bgResult.fallback && bgResult.hit) return bgResult.data;
    const entry = fallbackCache[key];
    if (entry && Date.now() < entry.expires) return entry.data;
    return null;
  }

  async function setCache(key, data, ttl) {
    fallbackCache[key] = { data, expires: Date.now() + ttl };
    cleanFallbackCache();
    await sendToBackground('CACHE_SET', { key, data, ttl });
  }

  async function invalidateCache(pattern) {
    for (const key of Object.keys(fallbackCache)) {
      if (key.startsWith(pattern)) delete fallbackCache[key];
    }
    await sendToBackground('CACHE_INVALIDATE', { pattern });
  }

  // --- Orders hash ---
  function hashOrders(orders) {
    return orders
      .map(o => `${o.orderSymbol}|${o.orderAction}|${o.orderQty}|${o.price}`)
      .sort()
      .join(';;');
  }

  // --- Main handler ---
  async function handleTradeReady(accountNum, orders) {
    if (!settings.enabled) return;

    lastAccountNum = accountNum;
    lastOrders = orders;
    const requestId = ++currentRequest;

    if (!MarginInjector.getPanel()) {
      if (!MarginInjector.inject()) {
        const injErrMsg = 'Injection target not found — Fidelity page layout may have changed';
        log('Warning:', injErrMsg);
        setBadge('!', BADGE_COLOR_ERROR);
        reportStatus('error', { lastError: injErrMsg });
        return;
      }
    }
    MarginInjector.showLoading();

    try {
      // Rate limiter (content-side token bucket)
      if (typeof RateLimiter !== 'undefined') {
        const rl = await RateLimiter.acquire();
        if (rl.cancelled) return;
        // A new request may have arrived while waiting for a token
        if (requestId !== currentRequest) return;
      }

      // Also check background rate limit (advisory)
      const rateCheck = await sendToBackground('LOG_API_CALL', { accountNum });
      // A new request may have arrived while waiting for background response
      if (requestId !== currentRequest) return;
      if (!rateCheck.fallback && rateCheck.rateLimited) {
        await new Promise(r => setTimeout(r, rateCheck.retryAfter));
        if (requestId !== currentRequest) return;
      }

      // Fetch priceList from portfolio API (cached)
      const priceListKey = `${CACHE_KEY.PRICELIST}${accountNum}`;
      let priceList = await getCached(priceListKey);
      if (!priceList) {
        log('Fetching positions for', accountNum);
        try {
          priceList = await PositionsAPI.fetchPriceList(accountNum);
        } catch (posErr) {
          if (requestId !== currentRequest) return;
          const isSessionErr = posErr.type === 'SESSION_EXPIRED';
          const msg = isSessionErr
            ? MSG_SESSION_EXPIRED
            : (posErr.message || 'Unable to fetch account positions.');
          MarginInjector.showError(msg, !isSessionErr);
          setBadge('!', isSessionErr ? BADGE_COLOR_WARNING : BADGE_COLOR_ERROR);
          reportStatus('error', { lastError: msg });
          return;
        }
        if (requestId !== currentRequest) return;
        if (priceList.length > 0) {
          await setCache(priceListKey, priceList, PRICELIST_TTL);
        } else {
          log('Warning: no positions found — margin API requires existing positions');
          MarginInjector.showError(
            'No positions found for this account. Margin calculation requires at least one existing position.',
            false
          );
          setBadge('!', BADGE_COLOR_ERROR);
          reportStatus('error', { lastError: 'No positions found' });
          return;
        }
      }

      // Fetch projected margin (cached by orders hash)
      const projectedKey = `${CACHE_KEY.PROJECTED}${accountNum}:${hashOrders(orders)}`;
      let projectedData = await getCached(projectedKey);
      if (!projectedData) {
        log('Fetching projected margin for', orders);
        apiCallCount++;
        projectedData = await MarginAPI.fetchMarginCalc(accountNum, orders, (attempt, max, delay) => {
          MarginInjector.showLoading();
          log(`Projected retry ${attempt}/${max} in ${delay}ms`);
        }, priceList);
        if (requestId !== currentRequest) return;
        await setCache(projectedKey, projectedData, PROJECTED_TTL);
      }

      // Compute impact — use lastResult as baseline for delta if available
      const impact = MarginCalc.computeImpact(projectedData, lastResult);
      if (!impact) {
        MarginInjector.showError('No margin data available for this account.', false);
        setBadge('!', BADGE_COLOR_ERROR);
        reportStatus('error', { lastError: 'No margin data' });
        return;
      }

      // Cache this result as baseline for next trade change
      lastResult = projectedData;

      log('Impact:', impact);
      MarginInjector.updatePanel(impact);
      reportStatus('active');
      setBadge('', null);

    } catch (err) {
      if (requestId !== currentRequest) return;
      log('Error:', err);

      const errType = err.type || 'UNKNOWN';
      const isSessionError = errType === 'SESSION_EXPIRED' ||
        err.message?.includes('Session expired');

      let msg;
      if (isSessionError) {
        msg = MSG_SESSION_EXPIRED;
        setBadge('!', BADGE_COLOR_WARNING);
      } else {
        msg = err.message ?? 'Unable to calculate margin impact.';
        setBadge('!', BADGE_COLOR_ERROR);
      }

      MarginInjector.showError(msg, !isSessionError);
      reportStatus('error', { lastError: msg });
    }
  }

  async function init() {
    log('Initializing...');

    // Wire retry button
    MarginInjector.setRetryCallback(() => {
      if (lastAccountNum && lastOrders) {
        handleTradeReady(lastAccountNum, lastOrders);
      }
    });

    // Listen for force-recalc from popup
    if (chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg._fmc && msg.type === 'FORCE_RECALC') {
          (async () => {
            fallbackCache = {};
            lastResult = null;
            if (lastAccountNum) {
              await Promise.all([
                invalidateCache(`${CACHE_KEY.PRICELIST}${lastAccountNum}`),
                invalidateCache(`${CACHE_KEY.PROJECTED}${lastAccountNum}`)
              ]);
            }
            if (lastAccountNum && lastOrders) {
              await handleTradeReady(lastAccountNum, lastOrders);
            }
          })().catch(err => log('Error during force-recalc:', err));
        }
        return false; // no async response needed — close port immediately
      });
    }

    // Listen for settings changes
    if (chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes[STORAGE_KEY_SETTINGS]?.newValue) {
          const wasEnabled = settings.enabled;
          const prevDebounceMs = settings.debounceMs;
          settings = { ...settings, ...changes[STORAGE_KEY_SETTINGS].newValue };
          // Clamp debounceMs to a safe minimum to prevent runaway polling from corrupted storage
          settings.debounceMs = clampDebounceMs(settings.debounceMs);
          MarginInjector.setWarningThreshold(settings.debitWarningThreshold);
          log('Settings updated:', settings);
          // If the extension was just disabled, remove the panel immediately
          // so stale margin data is not left visible to the user.
          if (wasEnabled && !settings.enabled) {
            MarginInjector.remove();
          }
          // Re-observe with new debounce so the change takes effect without a page reload
          if (settings.debounceMs !== prevDebounceMs) {
            TradeDetector.observe(tradeEventCallback, settings.debounceMs);
          }
        }
      });
    }

    // Load settings first so TradeDetector.observe uses the correct debounceMs
    await loadSettings();
    let previousAccountNum = null;

    function tradeEventCallback(event) {
      switch (event.type) {
        case 'ready':
          if (!event.accountNum) {
            if (!MarginInjector.getPanel()) MarginInjector.inject();
            MarginInjector.showError('Could not detect account number — try refreshing the page.', false);
            break;
          }
          if (event.orders.length > 0) {
            if (previousAccountNum && previousAccountNum !== event.accountNum) {
              sendToBackground('ACCOUNT_CHANGED', {
                accountNum: event.accountNum,
                previousAccountNum
              });
              invalidateCache(`${CACHE_KEY.PRICELIST}${previousAccountNum}`);
              invalidateCache(`${CACHE_KEY.PROJECTED}${previousAccountNum}`);
              lastResult = null;
            }
            previousAccountNum = event.accountNum;
            handleTradeReady(event.accountNum, event.orders).catch(err => log('Unhandled error in trade handler:', err));
          } else {
            // Trade form passed field completeness check but order parsing failed
            // (e.g. unparseable limit price or missing option symbol component).
            // Inject the panel and show a meaningful error so the user isn't left wondering.
            log('Warning: ready event with empty orders — trade form may be incomplete or in an unexpected format');
            if (!MarginInjector.getPanel()) MarginInjector.inject();
            MarginInjector.showError('Could not parse trade details — verify the form is filled in correctly.', false);
          }
          break;

        case 'closed':
          // Increment currentRequest so any in-flight handleTradeReady call
          // sees a stale requestId and exits early without touching the DOM.
          currentRequest++;
          MarginInjector.remove();
          break;

        case 'incomplete':
          break;
      }
    }

    TradeDetector.observe(tradeEventCallback, settings.debounceMs);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init().catch(err => log('Fatal init error:', err)));
  } else {
    init().catch(err => log('Fatal init error:', err));
  }
})();
