// Main orchestrator — ties detector, positions API, margin API, calc, and injector together
// Single-call architecture: portfolio API provides priceList, margin calc API requires order + priceList.
(() => {
  const LOG_PREFIX = '[FMC]';
  const PRICELIST_TTL = FMC_CONSTANTS.CACHE_TTL_MS.PRICELIST;
  const PRICELIST_EMPTY_TTL = FMC_CONSTANTS.CACHE_TTL_MS.PRICELIST_EMPTY;
  const PROJECTED_TTL = FMC_CONSTANTS.CACHE_TTL_MS.PROJECTED;
  const BADGE_COLOR_ERROR = FMC_CONSTANTS.BADGE_COLORS.ERROR;
  const BADGE_COLOR_WARNING = FMC_CONSTANTS.BADGE_COLORS.WARNING;
  const BG_MESSAGE_TIMEOUT_MS = FMC_CONSTANTS.BG_MESSAGE_TIMEOUT_MS;

  const CACHE_KEYS = FMC_CONSTANTS.CACHE_KEY_PREFIX;

  const STORAGE_KEY_SETTINGS = FMC_CONSTANTS.STORAGE_KEY_SETTINGS;
  const STORAGE_KEY_STATUS = FMC_CONSTANTS.STORAGE_KEY_STATUS;
  const MSG = FMC_CONSTANTS.MESSAGE_TYPES;
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
  let fallbackCache = new Map();
  const FALLBACK_CACHE_MAX = FMC_CONSTANTS.CONTENT_FALLBACK_CACHE_MAX;

  // Remove expired entries from fallbackCache to prevent memory growth over long sessions.
  // Also evicts oldest entry if the cache exceeds FALLBACK_CACHE_MAX entries.
  function cleanFallbackCache() {
    const now = Date.now();
    for (const [key, entry] of fallbackCache) {
      if (now >= entry.expires) fallbackCache.delete(key);
    }
    if (fallbackCache.size > FALLBACK_CACHE_MAX) {
      // Evict the entry with the earliest expiry
      let oldestKey = null, oldestExpiry = Infinity;
      for (const [key, entry] of fallbackCache) {
        if (entry.expires < oldestExpiry) { oldestExpiry = entry.expires; oldestKey = key; }
      }
      if (oldestKey !== null) fallbackCache.delete(oldestKey);
    }
  }

  const log = makeLogFn(LOG_PREFIX, console.log);

  // --- Settings ---
  async function loadSettings() {
    if (!chrome.storage?.sync) {
      log('Warning: chrome.storage.sync unavailable — using default settings');
    } else {
      try {
        const result = await chrome.storage.sync.get(STORAGE_KEY_SETTINGS);
        const loaded = result[STORAGE_KEY_SETTINGS];
        if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
          settings = { ...settings, ...loaded };
        }
      } catch (err) {
        log('Warning: could not load settings:', err.message);
      }
    }
    // Always clamp debounceMs — guards against corrupted/pre-guard stored values
    // and future changes to DEFAULT_SETTINGS.debounceMs below MIN_DEBOUNCE_MS.
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
    sendToBackground(MSG.SET_BADGE, { text, color });
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
              resolve(response ?? { fallback: true });
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
    const bgResult = await sendToBackground(MSG.CACHE_GET, { key });
    if (!bgResult.fallback && bgResult.hit) return bgResult.data;
    const entry = fallbackCache.get(key);
    if (entry) {
      if (Date.now() < entry.expires) return entry.data;
      // Delete expired entry eagerly to prevent stale objects accumulating over long sessions.
      fallbackCache.delete(key);
    }
    // Run cleanup on reads too: if setCache is never called (background always responds),
    // expired entries can linger in the fallback map until the next write.
    cleanFallbackCache();
    return null;
  }

  async function setCache(key, data, ttl) {
    fallbackCache.set(key, { data, expires: Date.now() + ttl });
    cleanFallbackCache();
    await sendToBackground(MSG.CACHE_SET, { key, data, ttl });
  }

  async function invalidateCache(pattern) {
    for (const key of fallbackCache.keys()) {
      if (key.startsWith(pattern)) fallbackCache.delete(key);
    }
    await sendToBackground(MSG.CACHE_INVALIDATE, { pattern });
  }

  // Invalidates both priceList and projected caches for the given account.
  // Called on account switch and force-recalc to ensure stale data is not used.
  function invalidateAccountCache(accountNum) {
    return Promise.all([
      invalidateCache(`${CACHE_KEYS.PRICELIST}${accountNum}`),
      invalidateCache(`${CACHE_KEYS.PROJECTED}${accountNum}`)
    ]);
  }

  // --- Orders hash ---
  function hashOrders(orders) {
    return orders
      .map(o => `${o.orderSymbol}|${o.orderType}|${o.orderAction}|${o.orderQty}|${o.price}`)
      .sort()
      .join(';;');
  }

  // --- Helpers ---

  // Shows an API error in the panel, setting the appropriate badge and status.
  // Determines session-expiry vs generic error from err.type; falls back to fallbackMsg
  // if err.message is absent. Mirrors the same logic in both error-handling paths in
  // handleTradeReady, extracted here to avoid duplicating the three-step pattern.
  function showApiError(err, fallbackMsg) {
    const isSession = err?.type === FMC_CONSTANTS.ERROR_TYPES.SESSION_EXPIRED;
    const msg = isSession ? MSG_SESSION_EXPIRED : (err?.message || fallbackMsg);
    showErrorInPanel(msg, !isSession);
    setBadge('!', isSession ? BADGE_COLOR_WARNING : BADGE_COLOR_ERROR);
    reportStatus(FMC_CONSTANTS.STATUS_STATE.ERROR, { lastError: msg });
  }

  // Ensures the panel is present then shows an error message.
  // Use in contexts where the trade ticket is visible but the extension cannot calculate.
  function showErrorInPanel(msg, canRetry) {
    if (!MarginInjector.getPanel()) {
      if (!MarginInjector.inject()) {
        // Injection target not found — panel cannot be shown. Log so it's not silent.
        log('Warning: cannot show error panel — injection target not found. Error was:', msg);
        return;
      }
    }
    MarginInjector.showError(msg, canRetry);
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
        reportStatus(FMC_CONSTANTS.STATUS_STATE.ERROR, { lastError: injErrMsg });
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
        // Extension may have been disabled during the wait
        if (!settings.enabled) return;
      }

      // Also check background rate limit (advisory)
      const rateCheck = await sendToBackground(MSG.LOG_API_CALL, { accountNum });
      // A new request may have arrived while waiting for background response
      if (requestId !== currentRequest) return;
      if (!rateCheck.fallback && rateCheck.rateLimited) {
        const waitMs = Math.max(0, Math.min(rateCheck.retryAfter || 0, FMC_CONSTANTS.MAX_RATE_LIMIT_WAIT_MS));
        await new Promise(r => setTimeout(r, waitMs));
        if (requestId !== currentRequest) return;
        // Extension may have been disabled during the rate-limit back-off wait
        if (!settings.enabled) return;
      }

      // Fetch priceList from portfolio API (cached)
      const priceListKey = `${CACHE_KEYS.PRICELIST}${accountNum}`;
      let priceList = await getCached(priceListKey);
      if (requestId !== currentRequest) return;
      if (!priceList) {
        log('Fetching positions for', accountNum);
        try {
          priceList = await PositionsAPI.fetchPriceList(accountNum);
        } catch (posErr) {
          if (requestId !== currentRequest) return;
          showApiError(posErr, 'Unable to fetch account positions.');
          return;
        }
        if (requestId !== currentRequest) return;
        if (priceList.length > 0) {
          await setCache(priceListKey, priceList, PRICELIST_TTL);
          if (requestId !== currentRequest) return;
        } else {
          // Cache the empty result briefly so repeated trade-form changes do not
          // re-fetch from the positions API on every mutation when the account
          // genuinely has no positions. Short TTL lets the user retry quickly.
          await setCache(priceListKey, priceList, PRICELIST_EMPTY_TTL);
          if (requestId !== currentRequest) return;
          log('Warning: no positions found — margin API requires existing positions');
          // Use showErrorInPanel rather than MarginInjector.showError directly — Angular
          // may have removed the panel during the preceding awaits, and showErrorInPanel
          // re-injects it if needed so the error is never silently lost.
          showErrorInPanel(
            'No positions found for this account. Margin calculation requires at least one existing position.',
            false
          );
          setBadge('!', BADGE_COLOR_ERROR);
          reportStatus(FMC_CONSTANTS.STATUS_STATE.ERROR, { lastError: 'No positions found' });
          return;
        }
      }

      // Fetch projected margin (cached by orders hash)
      const projectedKey = `${CACHE_KEYS.PROJECTED}${accountNum}:${hashOrders(orders)}`;
      let projectedData = await getCached(projectedKey);
      if (requestId !== currentRequest) return;
      if (!projectedData) {
        log('Fetching projected margin for', orders);
        apiCallCount++;
        projectedData = await MarginAPI.fetchMarginCalc(accountNum, orders, (attempt, max, delay) => {
          // Guard against a stale retry overwriting a newer request's panel state.
          // Without this check, a retry callback firing after a newer request has already
          // shown results would reset the panel to loading, leaving it stuck indefinitely
          // (the stale request exits early on the requestId check after the await).
          if (requestId === currentRequest) MarginInjector.showLoading();
          log(`Projected retry ${attempt}/${max} in ${delay}ms`);
        }, priceList);
        if (requestId !== currentRequest) return;
        await setCache(projectedKey, projectedData, PROJECTED_TTL);
        if (requestId !== currentRequest) return;
      }

      // Compute impact — use lastResult as baseline for delta if available
      const impact = MarginCalc.computeImpact(projectedData, lastResult);
      if (!impact) {
        // Use showErrorInPanel rather than MarginInjector.showError directly — Angular
        // may have removed the panel during the preceding awaits.
        showErrorInPanel('No margin data available for this account.', false);
        setBadge('!', BADGE_COLOR_ERROR);
        reportStatus(FMC_CONSTANTS.STATUS_STATE.ERROR, { lastError: 'No margin data' });
        return;
      }

      // Cache this result as baseline for next trade change
      lastResult = projectedData;

      log('Impact:', impact);
      MarginInjector.updatePanel(impact);
      reportStatus(FMC_CONSTANTS.STATUS_STATE.ACTIVE);
      setBadge('', null);

    } catch (err) {
      if (requestId !== currentRequest) return;
      log('Error:', err);
      // All typed errors from MarginAPI and PositionsAPI set err.type correctly.
      // showApiError relies on err.type to distinguish session-expiry from other errors.
      showApiError(err, 'Unable to calculate margin impact.');
    }
  }

  async function init() {
    log('Initializing...');

    // Wire retry button
    MarginInjector.setRetryCallback(() => {
      if (lastAccountNum && lastOrders) {
        handleTradeReady(lastAccountNum, lastOrders).catch(err => log('Error in retry handler:', err));
      }
    });

    // Listen for force-recalc from popup
    if (chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg && msg._fmc && msg.type === MSG.FORCE_RECALC && chrome.runtime?.id && sender.id === chrome.runtime.id) {
          sendResponse({ ok: true }); // acknowledge immediately so popup can confirm receipt
          (async () => {
            fallbackCache.clear();
            lastResult = null;
            if (lastAccountNum) {
              await invalidateAccountCache(lastAccountNum);
            }
            if (lastAccountNum && lastOrders) {
              await handleTradeReady(lastAccountNum, lastOrders);
            }
          })().catch(err => log('Error during force-recalc:', err));
        } else if (msg?._fmc) {
          // Unexpected _fmc message type — acknowledge to avoid "port closed before response" warnings.
          sendResponse({ error: 'unhandled message type' });
        }
        return false; // synchronous response already sent — close port immediately
      });
    }

    // Listen for settings changes
    if (chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        const newValue = changes[STORAGE_KEY_SETTINGS]?.newValue;
        if (area === 'sync' && newValue && typeof newValue === 'object' && !Array.isArray(newValue)) {
          const wasEnabled = settings.enabled;
          const prevDebounceMs = settings.debounceMs;
          settings = { ...settings, ...newValue };
          // Clamp debounceMs to a safe minimum to prevent runaway polling from corrupted storage
          settings.debounceMs = clampDebounceMs(settings.debounceMs);
          MarginInjector.setWarningThreshold(settings.debitWarningThreshold);
          log('Settings updated:', settings);
          // If the extension was just disabled, remove the panel and disconnect the
          // observer so Angular's frequent DOM mutations no longer trigger DOM queries.
          if (wasEnabled && !settings.enabled) {
            // Invalidate any in-flight handleTradeReady so it cannot overwrite the
            // INACTIVE status below with a stale ACTIVE status once its awaits resolve.
            currentRequest++;
            MarginInjector.remove();
            TradeDetector.disconnect();
            setBadge('', null);
            reportStatus(FMC_CONSTANTS.STATUS_STATE.INACTIVE);
          }
          // Re-observe with new debounce so the change takes effect without a page reload.
          // Also re-observe when re-enabling: if the trade form was already filled in and
          // static (no further DOM mutations), the observer's stale fingerprint would prevent
          // a new 'ready' event from firing, leaving the panel invisible until the form changes.
          // Re-observing resets the fingerprint and triggers an immediate fresh check.
          // Only re-observe when enabled — no point reattaching while disabled.
          if (settings.enabled && (settings.debounceMs !== prevDebounceMs || !wasEnabled)) {
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
            // Invalidate any in-flight request so it cannot overwrite this error panel
            // with stale results. Mirrors the same guard used in the 'incomplete' case.
            currentRequest++;
            showErrorInPanel('Could not detect account number — try refreshing the page.', false);
            break;
          }
          if (event.orders?.length > 0) {
            if (previousAccountNum && previousAccountNum !== event.accountNum) {
              sendToBackground(MSG.ACCOUNT_CHANGED, {
                accountNum: event.accountNum,
                previousAccountNum
              });
              // Fire-and-forget: tradeEventCallback is synchronous; invalidateAccountCache is
              // async but the fallback cache is cleared synchronously inside the function,
              // so the next getCached() call immediately sees a miss. Background cache
              // invalidation completes shortly after without needing to block here.
              invalidateAccountCache(previousAccountNum).catch(err => log('Cache invalidation error on account switch:', err));
              lastResult = null;
            }
            previousAccountNum = event.accountNum;
            handleTradeReady(event.accountNum, event.orders).catch(err => log('Unhandled error in trade handler:', err));
          } else {
            // Trade form passed field completeness check but order parsing failed
            // (e.g. unparseable limit price or missing option symbol component).
            // Increment currentRequest so any in-flight handleTradeReady cannot
            // overwrite this error panel with stale results once it resolves.
            currentRequest++;
            // Inject the panel and show a meaningful error so the user isn't left wondering.
            log('Warning: ready event with empty orders — trade form may be incomplete or in an unexpected format');
            showErrorInPanel('Could not parse trade details — verify the form is filled in correctly.', false);
          }
          break;

        case 'closed':
          // Increment currentRequest so any in-flight handleTradeReady call
          // sees a stale requestId and exits early without touching the DOM.
          currentRequest++;
          // Reset lastResult so the next ticket open computes delta from a fresh
          // baseline rather than a potentially stale previous projection.
          lastResult = null;
          // Clear account/orders so a force-recalc from the popup does not attempt
          // a stale calculation (and set an error badge) after the ticket is closed.
          // They will be repopulated when the next 'ready' event fires.
          lastAccountNum = null;
          lastOrders = null;
          MarginInjector.remove();
          break;

        case 'incomplete':
          // Increment currentRequest so any in-flight handleTradeReady call that
          // was dispatched before the form became incomplete cannot overwrite the
          // panel with results that no longer match the current form state.
          currentRequest++;
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
