// Main orchestrator — ties detector, positions API, margin API, calc, and injector together
// Single-call architecture: portfolio API provides priceList, margin calc API requires order + priceList.
(() => {
  const LOG_PREFIX = '[FMC]';
  const PRICELIST_TTL = 300000; // 5 min — positions don't change often
  const PROJECTED_TTL = 30000;
  let currentRequest = 0;
  let lastAccountNum = null;
  let lastOrders = null;
  let lastResult = null; // cached previous result for delta computation
  let apiCallCount = 0;
  let settings = { enabled: true, debitWarningThreshold: 500, debounceMs: 500 };

  // Fallback in-memory cache when background is unavailable
  let fallbackCache = {};

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
    if (typeof MarginInjector !== 'undefined' && MarginInjector.addDebugLog) {
      MarginInjector.addDebugLog(args.map(function(a) {
        if (a instanceof Error) return a.message + (a.stack ? '\n' + a.stack : '');
        return typeof a === 'object' ? JSON.stringify(a) : String(a);
      }).join(' '));
    }
  }

  // --- Settings ---
  function loadSettings() {
    if (!chrome.storage || !chrome.storage.sync) return;
    chrome.storage.sync.get('fmc_settings', (result) => {
      if (result.fmc_settings) {
        settings = Object.assign(settings, result.fmc_settings);
      }
    });
  }

  // --- Status reporting ---
  function reportStatus(state, extra) {
    if (!chrome.storage || !chrome.storage.local) return;
    const status = {
      state,
      accountNum: lastAccountNum,
      lastCalcTime: Date.now(),
      apiCallCount,
      lastError: null,
      ...extra
    };
    chrome.storage.local.set({ fmc_status: status });
  }

  function setBadge(text, color) {
    sendToBackground('SET_BADGE', { text, color });
  }

  // --- Background message helper ---
  function sendToBackground(type, payload, timeoutMs) {
    timeoutMs = timeoutMs || 3000;
    return new Promise((resolve) => {
      if (!chrome.runtime || !chrome.runtime.sendMessage) {
        resolve({ error: 'no runtime', fallback: true });
        return;
      }
      const timer = setTimeout(() => {
        resolve({ error: 'timeout', fallback: true });
      }, timeoutMs);
      try {
        chrome.runtime.sendMessage(
          { type: type, payload: payload, _fmc: true, _ts: Date.now() },
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
    var bgResult = await sendToBackground('CACHE_GET', { key: key });
    if (!bgResult.fallback && bgResult.hit) return bgResult.data;
    var entry = fallbackCache[key];
    if (entry && Date.now() < entry.expires) return entry.data;
    return null;
  }

  async function setCache(key, data, ttl) {
    fallbackCache[key] = { data: data, expires: Date.now() + ttl };
    await sendToBackground('CACHE_SET', { key: key, data: data, ttl: ttl });
  }

  async function invalidateCache(pattern) {
    var keys = Object.keys(fallbackCache);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf(pattern) === 0) delete fallbackCache[keys[i]];
    }
    await sendToBackground('CACHE_INVALIDATE', { pattern: pattern });
  }

  // --- Orders hash ---
  function hashOrders(orders) {
    return orders
      .map(function(o) { return o.orderSymbol + '|' + o.orderAction + '|' + o.orderQty + '|' + o.price; })
      .sort()
      .join(';;');
  }

  // --- Main handler ---
  async function handleTradeReady(accountNum, orders) {
    if (!settings.enabled) return;

    lastAccountNum = accountNum;
    lastOrders = orders;
    var requestId = ++currentRequest;

    if (!MarginInjector.getPanel()) {
      if (!MarginInjector.inject()) {
        return;
      }
    }
    MarginInjector.showLoading();

    try {
      // Rate limiter (content-side token bucket)
      if (typeof RateLimiter !== 'undefined') {
        var rl = await RateLimiter.acquire();
        if (rl.cancelled) return;
      }

      // Also check background rate limit (advisory)
      var rateCheck = await sendToBackground('LOG_API_CALL', { accountNum: accountNum });
      if (!rateCheck.fallback && rateCheck.rateLimited) {
        await new Promise(function(r) { setTimeout(r, rateCheck.retryAfter); });
        if (requestId !== currentRequest) return;
      }

      // Fetch priceList from portfolio API (cached)
      var priceListKey = 'pricelist:' + accountNum;
      var priceList = await getCached(priceListKey);
      if (!priceList) {
        log('Fetching positions for', accountNum);
        priceList = await PositionsAPI.fetchPriceList(accountNum);
        if (requestId !== currentRequest) return;
        if (priceList.length > 0) {
          await setCache(priceListKey, priceList, PRICELIST_TTL);
        } else {
          log('Warning: no positions found, margin calc may fail');
        }
      }

      // Fetch projected margin (cached by orders hash)
      var projectedKey = 'projected:' + accountNum + ':' + hashOrders(orders);
      var projectedData = await getCached(projectedKey);
      if (!projectedData) {
        log('Fetching projected margin for', orders);
        apiCallCount++;
        projectedData = await MarginAPI.fetchMarginCalc(accountNum, orders, function(attempt, max, delay) {
          MarginInjector.showLoading();
          log('Projected retry ' + attempt + '/' + max + ' in ' + delay + 'ms');
        }, priceList);
        if (requestId !== currentRequest) return;
        await setCache(projectedKey, projectedData, PROJECTED_TTL);
      }

      // Compute impact — use lastResult as baseline for delta if available
      var impact = MarginCalc.computeImpact(projectedData, lastResult);
      if (!impact) {
        MarginInjector.showError('No margin data available for this account.', false);
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

      var errType = err.type || 'UNKNOWN';
      var isSessionError = errType === 'SESSION_EXPIRED' ||
        (err.message && err.message.indexOf('Session expired') !== -1);

      var msg;
      if (isSessionError) {
        msg = 'Session expired. Please refresh the page.';
        setBadge('!', '#f5a623');
      } else {
        msg = err.message || 'Unable to calculate margin impact.';
        setBadge('!', '#c41200');
      }

      MarginInjector.showError(msg, !isSessionError);
      reportStatus('error', { lastError: msg });
    }
  }

  function init() {
    log('Initializing...');
    loadSettings();

    // Wire retry button
    MarginInjector.setRetryCallback(function() {
      if (lastAccountNum && lastOrders) {
        handleTradeReady(lastAccountNum, lastOrders);
      }
    });

    // Listen for force-recalc from popup
    if (chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function(msg) {
        if (msg && msg._fmc && msg.type === 'FORCE_RECALC') {
          fallbackCache = {};
          lastResult = null;
          if (lastAccountNum) invalidateCache('pricelist:' + lastAccountNum);
          if (lastAccountNum) invalidateCache('projected:' + lastAccountNum);
          if (lastAccountNum && lastOrders) {
            handleTradeReady(lastAccountNum, lastOrders);
          }
        }
      });
    }

    // Listen for settings changes
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function(changes, area) {
        if (area === 'sync' && changes.fmc_settings) {
          settings = Object.assign(settings, changes.fmc_settings.newValue);
          log('Settings updated:', settings);
        }
      });
    }

    var previousAccountNum = null;

    TradeDetector.observe(function(event) {
      switch (event.type) {
        case 'ready':
          if (event.accountNum && event.orders.length > 0) {
            if (previousAccountNum && previousAccountNum !== event.accountNum) {
              sendToBackground('ACCOUNT_CHANGED', {
                accountNum: event.accountNum,
                previousAccountNum: previousAccountNum
              });
              invalidateCache('pricelist:' + previousAccountNum);
              invalidateCache('projected:' + previousAccountNum);
              lastResult = null;
            }
            previousAccountNum = event.accountNum;
            handleTradeReady(event.accountNum, event.orders);
          }
          break;

        case 'closed':
          MarginInjector.remove();
          break;

        case 'incomplete':
          break;
      }
    }, settings.debounceMs);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
