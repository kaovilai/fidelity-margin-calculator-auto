// Main orchestrator — ties detector, positions API, margin API, calc, and injector together
// Single-call architecture: portfolio API provides priceList, margin calc API requires order + priceList.
'use strict';
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
  const MSG_NO_POSITIONS = 'No positions found for this account. Margin calculation requires at least one existing position.';
  const MSG_NO_POSITIONS_SHORT = 'No positions found';

  /**
   * Clamps a debounce delay to at least `FMC_CONSTANTS.MIN_DEBOUNCE_MS`.
   * Rejects non-number and non-finite values (e.g. from corrupted storage) and
   * replaces them with the safe minimum so the observer never polls unboundedly.
   * @param {*} ms - Candidate debounce delay in milliseconds.
   * @returns {number} A finite number ≥ MIN_DEBOUNCE_MS.
   */
  function clampDebounceMs(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < FMC_CONSTANTS.MIN_DEBOUNCE_MS) {
      return FMC_CONSTANTS.MIN_DEBOUNCE_MS;
    }
    return ms;
  }

  /**
   * Clamps a debit warning threshold to `[0, MAX_WARNING_THRESHOLD]`.
   * Mirrors the clamping already applied in popup.js `saveSettings()` and
   * `MarginInjector.setWarningThreshold()` so the `settings` object always holds
   * a valid value — consistent with how `debounceMs` is normalised via `clampDebounceMs`.
   * Non-finite values (NaN, Infinity, non-number) fall back to the default threshold.
   * @param {*} val - Candidate threshold value (typically a number from storage).
   * @returns {number} A finite number in `[0, FMC_CONSTANTS.MAX_WARNING_THRESHOLD]`.
   */
  function clampThreshold(val) {
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0) return FMC_CONSTANTS.DEFAULT_SETTINGS.debitWarningThreshold;
    return Math.min(FMC_CONSTANTS.MAX_WARNING_THRESHOLD, n);
  }

  let currentRequest = 0;
  let lastAccountNum = null;
  let lastOrders = null;
  let lastResult = null; // cached previous result for delta computation
  let apiCallCount = 0;
  let lastCalcTime = null; // timestamp (ms) of the last successful margin calculation
  let settings = { ...FMC_CONSTANTS.DEFAULT_SETTINGS };

  // Heartbeat timer — keeps the MV3 service worker alive while a trade ticket is open.
  // Set by startHeartbeat() when the ticket opens, cleared by stopHeartbeat() when it closes.
  let heartbeatTimer = null;

  /**
   * Starts the background service-worker heartbeat if not already running.
   * Sends a HEARTBEAT message every `HEARTBEAT_INTERVAL_MS` to prevent the MV3
   * service worker from being terminated while a trade ticket is open.
   * No-op if the heartbeat is already running.
   */
  function startHeartbeat() {
    if (heartbeatTimer) return; // already running
    heartbeatTimer = setInterval(() => {
      sendToBackground(MSG.HEARTBEAT, {});
    }, FMC_CONSTANTS.HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Stops the background service-worker heartbeat.
   * No-op if the heartbeat is not currently running.
   */
  function stopHeartbeat() {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  // Circuit breaker state — tracks consecutive retryable failures and blocks
  // API calls for OPEN_DURATION_MS after FAILURE_THRESHOLD failures in a row.
  let consecutiveFailures = 0;
  let circuitOpenUntil = 0; // epoch ms; 0 means circuit is closed

  // Session-expiry flag — set when any API call returns SESSION_EXPIRED.
  // Prevents pointless repeated calls on subsequent form changes since every call
  // will fail until the user refreshes the page and re-authenticates.
  // Cleared explicitly by force-recalculate so the user's manual retry goes through.
  let sessionExpired = false;

  // Fallback in-memory cache when background is unavailable
  const fallbackCache = new Map();
  const FALLBACK_CACHE_MAX = FMC_CONSTANTS.CONTENT_FALLBACK_CACHE_MAX;

  /**
   * Removes expired entries from the in-memory fallback cache and evicts the
   * earliest-expiring entry when the cache exceeds `FALLBACK_CACHE_MAX` entries.
   * Called on every read and write to bound memory growth during long sessions.
   */
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

  const log = makeDebugLog(LOG_PREFIX);
  const warn = makeWarnLog(LOG_PREFIX);

  // --- Settings ---
  /**
   * Loads user settings from `chrome.storage.sync` and applies them to the
   * module-level `settings` object.  Falls back to `DEFAULT_SETTINGS` when storage
   * is unavailable or returns an invalid value.  Always clamps `debounceMs` and
   * `debitWarningThreshold` to valid ranges before applying to the injector.
   * @returns {Promise<void>}
   */
  async function loadSettings() {
    if (!chrome.storage?.sync) {
      warn('chrome.storage.sync unavailable — using default settings');
    } else {
      try {
        const result = await chrome.storage.sync.get(STORAGE_KEY_SETTINGS);
        const loaded = result[STORAGE_KEY_SETTINGS];
        if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
          settings = { ...settings, ...loaded };
        }
      } catch (err) {
        warn('could not load settings:', err.message);
      }
    }
    // Always clamp debounceMs and debitWarningThreshold — guards against corrupted/
    // pre-guard stored values so the settings object always holds valid values.
    settings.debounceMs = clampDebounceMs(settings.debounceMs);
    settings.debitWarningThreshold = clampThreshold(settings.debitWarningThreshold);
    MarginInjector.setWarningThreshold(settings.debitWarningThreshold);
  }

  // --- Status reporting ---
  /**
   * Writes a status snapshot to `chrome.storage.local` so the popup can display
   * the current extension state without an active message channel to the content script.
   * Uses `lastCalcTime` (set only on successful calculations) so the popup's "Last Calc"
   * field reflects the most recent successful result, not the time of an error or status update.
   * @param {string} state - One of `FMC_CONSTANTS.STATUS_STATE` values.
   * @param {Object} [extra] - Additional fields merged into the status object
   *   (e.g. `{ lastError: 'Session expired' }`).
   */
  function reportStatus(state, extra) {
    if (!chrome.storage?.local) return;
    const status = {
      state,
      accountNum: lastAccountNum,
      lastCalcTime,
      apiCallCount,
      lastError: null,
      ...extra
    };
    chrome.storage.local.set({ [STORAGE_KEY_STATUS]: status }).catch(() => {});
  }

  /**
   * Sends a `SET_BADGE` message to the background service worker to update the
   * extension action badge text and color.  Pass `text: ''` to clear the badge.
   * Fire-and-forget — errors are silently ignored by the background handler.
   * @param {string} text - Badge text (empty string clears the badge).
   * @param {string|null} color - Badge background color hex string, or `null` to use the default.
   */
  function setBadge(text, color) {
    sendToBackground(MSG.SET_BADGE, { text, color });
  }

  // Set built once from the shared constant so isRetryableError uses the same
  // membership definition as margin-api.js and positions.js rather than an
  // independent inline check that could silently drift.
  const RETRYABLE_ERROR_TYPES = new Set(FMC_CONSTANTS.RETRYABLE_ERROR_TYPES);

  // --- Circuit breaker ---

  /**
   * Returns `true` when the error type indicates a transient failure that should
   * trigger the circuit breaker: NETWORK_ERROR or API_ERROR.
   * CLIENT_ERROR and SESSION_EXPIRED are non-retryable and must not open the circuit.
   * @param {Error & {type?: string}} err - Typed error from MarginAPI or PositionsAPI.
   * @returns {boolean}
   */
  function isRetryableError(err) {
    return RETRYABLE_ERROR_TYPES.has(err?.type);
  }

  /**
   * Records a retryable API failure (NETWORK_ERROR or API_ERROR) and opens the
   * circuit breaker once `FAILURE_THRESHOLD` consecutive failures are reached.
   * Session-expiry and CLIENT_ERROR are permanent states — callers must check
   * `err.type` and only call this for retryable error types.
   */
  function recordApiFailure() {
    consecutiveFailures++;
    if (consecutiveFailures >= FMC_CONSTANTS.CIRCUIT_BREAKER.FAILURE_THRESHOLD && !circuitOpenUntil) {
      circuitOpenUntil = Date.now() + FMC_CONSTANTS.CIRCUIT_BREAKER.OPEN_DURATION_MS;
      log(`Circuit breaker opened after ${consecutiveFailures} consecutive failures — API calls paused for ${FMC_CONSTANTS.CIRCUIT_BREAKER.OPEN_DURATION_MS / 1000}s`);
    }
  }

  /**
   * Records a successful API call, closing the circuit breaker and resetting the
   * consecutive failure counter so the circuit does not re-open until the threshold
   * is reached again from scratch.
   */
  function recordApiSuccess() {
    consecutiveFailures = 0;
    circuitOpenUntil = 0;
  }

  /**
   * Returns `true` when the circuit breaker is open and API calls should be skipped.
   * After `OPEN_DURATION_MS` elapses, clears the open timestamp to allow one probe
   * request through.  If the probe succeeds, `recordApiSuccess()` closes the circuit;
   * if it fails, `recordApiFailure()` reopens it for another `OPEN_DURATION_MS`.
   * @returns {boolean}
   */
  function isCircuitOpen() {
    if (!circuitOpenUntil) return false;
    if (Date.now() < circuitOpenUntil) return true;
    circuitOpenUntil = 0; // cool-down elapsed — allow probe request
    return false;
  }

  // --- Background message helper ---
  /**
   * Sends a typed message to the background service worker and returns a Promise
   * that resolves with the response.  Never rejects — on timeout, extension context
   * invalidation, or send error the Promise resolves with `{ fallback: true }` so
   * callers can transparently fall back to the in-memory cache.
   * @param {string} type - One of `FMC_CONSTANTS.MESSAGE_TYPES`.
   * @param {Object} payload - Message payload forwarded to the background handler.
   * @param {number} [timeoutMs] - Max ms to wait for a response before falling back.
   * @returns {Promise<Object>} Background response, or `{ fallback: true }` on failure.
   */
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
          { type, payload, _fmc: true },
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
  /**
   * Retrieves a cached value by key, preferring the background service worker's
   * shared cache and falling back to the in-memory `fallbackCache` when the
   * background is unavailable or the message times out.
   * @param {string} key - Cache key.
   * @returns {Promise<*>} Cached value, or `null` if not found or expired.
   */
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

  /**
   * Stores a value in both the in-memory fallback cache and the background
   * service worker's shared cache with the given TTL.
   * @param {string} key - Cache key.
   * @param {*} data - Value to store.
   * @param {number} ttl - Time-to-live in milliseconds.
   * @returns {Promise<void>}
   */
  async function setCache(key, data, ttl) {
    fallbackCache.set(key, { data, expires: Date.now() + ttl });
    cleanFallbackCache();
    await sendToBackground(MSG.CACHE_SET, { key, data, ttl });
  }

  /**
   * Removes all entries whose keys start with `pattern` from both the in-memory
   * fallback cache and the background service worker's shared cache.
   * @param {string} pattern - Key prefix to match (e.g. `'pricelist:X12345'`).
   * @returns {Promise<void>}
   */
  async function invalidateCache(pattern) {
    for (const key of fallbackCache.keys()) {
      if (key.startsWith(pattern)) fallbackCache.delete(key);
    }
    await sendToBackground(MSG.CACHE_INVALIDATE, { pattern });
  }

  /**
   * Invalidates both the priceList and projected-margin caches for the given account.
   * Called on account switch (to prevent stale positions from the old account being used)
   * and on force-recalculate (to ensure fresh data is fetched).
   * @param {string} accountNum - Brokerage account number whose cache entries to clear.
   * @returns {Promise<void>}
   */
  function invalidateAccountCache(accountNum) {
    return Promise.all([
      invalidateCache(`${CACHE_KEYS.PRICELIST}${accountNum}`),
      invalidateCache(`${CACHE_KEYS.PROJECTED}${accountNum}`)
    ]);
  }

  // --- Orders hash ---
  /**
   * Builds a stable string key from an array of order objects for use as a cache key.
   * Includes all fields that affect the margin calculation result so that any change
   * to the order parameters produces a distinct key and forces a fresh API call.
   * The orders are sorted so that multi-leg strategies with the same legs in any
   * order share the same cache entry.
   * @param {Array<{orderSymbol: string, orderType: string, orderAction: string,
   *   orderQty: number, price: number}>} orders - Trade orders from `TradeDetector.buildOrders`.
   * @returns {string} Cache key suffix for the projected-margin cache.
   */
  function hashOrders(orders) {
    return orders
      .map(o => `${o.orderSymbol}|${o.orderType}|${o.orderAction}|${o.orderQty}|${o.price}`)
      .sort()
      .join(';;');
  }

  // --- Helpers ---
  /**
   * Shows a typed API error in the margin panel, sets the badge, and updates the
   * stored status.  Detects session-expiry from `err.type` and:
   *   - shows the localized session-expired message
   *   - sets `sessionExpired = true` to suppress further API calls until retry
   *   - uses the WARNING badge color instead of ERROR for session expiry
   * Falls back to `fallbackMsg` when `err.message` is absent.
   * @param {Error & {type?: string}} err - Typed error from MarginAPI or PositionsAPI.
   * @param {string} fallbackMsg - Message to display if `err.message` is absent.
   */
  function showApiError(err, fallbackMsg) {
    const isSession = err?.type === FMC_CONSTANTS.ERROR_TYPES.SESSION_EXPIRED;
    const msg = isSession ? MSG_SESSION_EXPIRED : (err?.message || fallbackMsg);
    if (isSession) sessionExpired = true;
    showErrorInPanel(msg, !isSession);
    setBadge('!', isSession ? BADGE_COLOR_WARNING : BADGE_COLOR_ERROR);
    reportStatus(FMC_CONSTANTS.STATUS_STATE.ERROR, { lastError: msg });
  }

  /**
   * Ensures the margin panel is injected into the DOM and then calls
   * `MarginInjector.showError`.  Re-injects the panel if Angular removed it
   * during preceding async operations.  Logs a warning and returns without
   * displaying if the injection target is not found.
   * @param {string} msg - Human-readable error message to display.
   * @param {boolean} canRetry - Whether to show the Retry button in the panel.
   */
  function showErrorInPanel(msg, canRetry) {
    if (!MarginInjector.getPanel()) {
      if (!MarginInjector.inject()) {
        // Injection target not found — panel cannot be shown. Log so it's not silent.
        warn('cannot show error panel — injection target not found. Error was:', msg);
        return;
      }
    }
    MarginInjector.showError(msg, canRetry);
  }

  /**
   * Shows the "no positions" error in the panel, sets the error badge, and updates the
   * stored status. Extracted to avoid duplicating the same three-step sequence in both
   * the cached-empty-priceList path and the freshly-fetched-empty-priceList path.
   */
  function showNoPositionsError() {
    showErrorInPanel(MSG_NO_POSITIONS, false);
    setBadge('!', BADGE_COLOR_ERROR);
    reportStatus(FMC_CONSTANTS.STATUS_STATE.ERROR, { lastError: MSG_NO_POSITIONS_SHORT });
  }

  // --- Main handler ---
  /**
   * Main trade handler — orchestrates the full margin calculation flow for a
   * detected trade.  Runs the following pipeline:
   * 1. Guards: enabled check, session-expiry check, circuit-breaker check.
   * 2. Rate limiting: content-side token bucket + background advisory rate limit.
   * 3. PriceList fetch: retrieves current positions from the portfolio API (cached 5 min).
   * 4. Margin calc fetch: calls the margin calculator API with the order + priceList
   *    (cached 30 s per unique order combination).
   * 5. Impact computation: computes margin credit/debit, delta from last result, and
   *    buying power, then updates the injected panel.
   *
   * Each async step checks `requestId === currentRequest` to discard stale results
   * if a newer trade event arrived while this call was awaiting.
   * @param {string} accountNum - Brokerage account number.
   * @param {Array<{orderSymbol: string, orderType: string, orderAction: string,
   *   orderQty: number, price: number}>} orders - Trade orders from `TradeDetector.buildOrders`.
   * @returns {Promise<void>}
   */
  async function handleTradeReady(accountNum, orders) {
    if (!settings.enabled) return;

    // Short-circuit: session has expired and the user has not yet force-recalculated.
    // Every API call will fail with SESSION_EXPIRED until the page is refreshed, so
    // skip the call entirely and keep the existing error panel visible.
    if (sessionExpired) return;

    lastAccountNum = accountNum;
    lastOrders = orders;
    const requestId = ++currentRequest;

    if (!MarginInjector.getPanel()) {
      if (!MarginInjector.inject()) {
        const injErrMsg = 'Injection target not found — Fidelity page layout may have changed';
        warn(injErrMsg);
        setBadge('!', BADGE_COLOR_ERROR);
        reportStatus(FMC_CONSTANTS.STATUS_STATE.ERROR, { lastError: injErrMsg });
        return;
      }
    }

    // Guard against a runaway-failure loop: if the circuit is open (too many recent
    // retryable failures), show an error immediately without making another API call.
    // After OPEN_DURATION_MS the circuit allows one probe request through automatically.
    if (isCircuitOpen()) {
      const remainingSec = Math.ceil((circuitOpenUntil - Date.now()) / 1000);
      // Use showErrorInPanel rather than MarginInjector.showError directly — mirrors the
      // same defensive pattern used elsewhere in handleTradeReady so the panel is
      // re-injected if Angular removed it between the check above and this display call.
      showErrorInPanel(`API temporarily unavailable — pausing ${remainingSec}s`, true);
      setBadge('!', BADGE_COLOR_WARNING);
      reportStatus(FMC_CONSTANTS.STATUS_STATE.ERROR, { lastError: `Circuit breaker open — ${remainingSec}s remaining` });
      return;
    }

    MarginInjector.showLoading();

    try {
      // Rate limiter (content-side token bucket)
      const rl = await RateLimiter.acquire();
      if (rl.cancelled) return;
      // A new request may have arrived while waiting for a token
      if (requestId !== currentRequest) return;
      // Extension may have been disabled during the wait
      if (!settings.enabled) return;

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
      // Guard: a cached empty priceList (from a previous call that found no positions) is
      // truthy (![] is false), so without this check we'd fall through to the margin API
      // call with priceList=[], which returns a 400 error instead of the user-friendly
      // "No positions found" message that was shown on the first call.
      if (Array.isArray(priceList) && priceList.length === 0) {
        showNoPositionsError();
        return;
      }
      if (!priceList) {
        log('Fetching positions for', accountNum);
        try {
          priceList = await PositionsAPI.fetchPriceList(accountNum);
        } catch (posErr) {
          if (requestId !== currentRequest) return;
          if (isRetryableError(posErr)) {
            recordApiFailure();
          }
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
          warn('no positions found — margin API requires existing positions');
          // Use showErrorInPanel rather than MarginInjector.showError directly — Angular
          // may have removed the panel during the preceding awaits, and showErrorInPanel
          // re-injects it if needed so the error is never silently lost.
          showNoPositionsError();
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

      recordApiSuccess();
      log('Impact:', impact);
      lastCalcTime = Date.now(); // update only on successful calculation
      MarginInjector.updatePanel(impact);
      reportStatus(FMC_CONSTANTS.STATUS_STATE.ACTIVE);
      setBadge('', null);

    } catch (err) {
      if (requestId !== currentRequest) return;
      log('Error:', err);
      if (isRetryableError(err)) {
        recordApiFailure();
      }
      // All typed errors from MarginAPI and PositionsAPI set err.type correctly.
      // showApiError relies on err.type to distinguish session-expiry from other errors.
      showApiError(err, 'Unable to calculate margin impact.');
    }
  }

  /**
   * Initializes the content script: loads settings, wires the retry and force-recalc
   * handlers, registers storage-change and message listeners, and starts the
   * `TradeDetector` observer.
   * Called once at `document_idle` time; any fatal error is caught and logged.
   * @returns {Promise<void>}
   */
  async function init() {
    log('Initializing...');

    // Wire retry button
    MarginInjector.setRetryCallback(() => {
      // Clear the circuit open state so the user's manual retry acts as a probe
      // request without waiting for the full cool-down period to elapse.
      // consecutiveFailures is intentionally NOT reset: if this probe also fails,
      // recordApiFailure() will immediately reopen the circuit for another OPEN_DURATION_MS.
      circuitOpenUntil = 0;
      // Clear session-expiry flag so the retry can attempt a fresh API call in case
      // the user has re-authenticated (e.g. opened Fidelity in a new tab and logged back in).
      sessionExpired = false;
      if (lastAccountNum && lastOrders) {
        handleTradeReady(lastAccountNum, lastOrders).catch(err => log('Error in retry handler:', err));
      }
    });

    // Listen for force-recalc from popup
    if (chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        // Validate sender first — reject messages from other extensions (or spoofed _fmc markers)
        // before sending any response. Mirrors the guard in background.js and prevents
        // information leakage about the _fmc handler to other installed extensions.
        if (!msg?._fmc || !chrome.runtime?.id || sender.id !== chrome.runtime.id) return false;
        if (msg.type === MSG.FORCE_RECALC) {
          sendResponse({ ok: true }); // acknowledge immediately so popup can confirm receipt
          (async () => {
            fallbackCache.clear();
            lastResult = null;
            // Also fully reset the circuit breaker and session-expiry flag so a manual
            // recalculate is never silently blocked — the user is explicitly requesting
            // a fresh attempt (they may have re-authenticated in another tab).
            consecutiveFailures = 0;
            circuitOpenUntil = 0;
            sessionExpired = false;
            if (lastAccountNum) {
              await invalidateAccountCache(lastAccountNum);
            }
            if (lastAccountNum && lastOrders) {
              await handleTradeReady(lastAccountNum, lastOrders);
            }
          })().catch(err => log('Error during force-recalc:', err));
        } else {
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
          // Clamp both debounceMs and debitWarningThreshold to safe ranges to
          // prevent runaway polling or an out-of-range threshold from corrupted storage.
          settings.debounceMs = clampDebounceMs(settings.debounceMs);
          settings.debitWarningThreshold = clampThreshold(settings.debitWarningThreshold);
          MarginInjector.setWarningThreshold(settings.debitWarningThreshold);
          log('Settings updated:', settings);
          // If the extension was just disabled, remove the panel and disconnect the
          // observer so Angular's frequent DOM mutations no longer trigger DOM queries.
          if (wasEnabled && !settings.enabled) {
            // Invalidate any in-flight handleTradeReady so it cannot overwrite the
            // INACTIVE status below with a stale ACTIVE status once its awaits resolve.
            currentRequest++;
            // Stop heartbeat — TradeDetector.disconnect() will not fire a 'closed' event,
            // so the interval would otherwise keep pinging the background service worker
            // even though no trade ticket is being tracked.
            stopHeartbeat();
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

    /**
     * Handles trade ticket events from `TradeDetector.observe`.
     * Routes 'ready', 'incomplete', and 'closed' events to the appropriate
     * handler: starts/stops the heartbeat, detects account switches,
     * triggers `handleTradeReady`, or tears down the panel and badge.
     * @param {{ type: 'ready'|'incomplete'|'closed', context?: string,
     *   accountNum?: string|null, orders?: Array<Object> }} event - Typed event from TradeDetector.
     */
    function tradeEventCallback(event) {
      switch (event.type) {
        case 'ready':
          if (!event.accountNum) {
            // Invalidate any in-flight request so it cannot overwrite this error panel
            // with stale results. Mirrors the same guard used in the 'incomplete' case.
            currentRequest++;
            showErrorInPanel('Could not detect account number — try refreshing the page.', false);
            // Sync badge and popup status so the user sees the error reflected everywhere,
            // not just in the injected panel. Mirrors the pattern used in handleTradeReady
            // and showApiError where every error path updates all three surfaces.
            setBadge('!', BADGE_COLOR_ERROR);
            reportStatus(FMC_CONSTANTS.STATUS_STATE.ERROR, { lastError: 'Could not detect account number' });
            break;
          }
          if (event.orders?.length > 0) {
            // Keep the service worker alive while the trade ticket is open.
            startHeartbeat();
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
            warn('ready event with empty orders — trade form may be incomplete or in an unexpected format');
            showErrorInPanel('Could not parse trade details — verify the form is filled in correctly.', false);
            // Sync badge and popup status so the error is visible in all three surfaces,
            // consistent with handleTradeReady and showApiError error handling.
            setBadge('!', BADGE_COLOR_ERROR);
            reportStatus(FMC_CONSTANTS.STATUS_STATE.ERROR, { lastError: 'Could not parse trade details' });
          }
          break;

        case 'closed':
          // Stop heartbeat — service worker no longer needs to be kept alive.
          stopHeartbeat();
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
          // Reset session-expiry flag on ticket close: the user may have navigated away
          // to re-authenticate and then returned to open a new trade ticket.
          sessionExpired = false;
          MarginInjector.remove();
          // Clear any error badge and mark the extension as inactive in the popup.
          // Without these calls the badge persists its last error state (e.g. '!') and
          // the popup continues to show "Active" or "Error" even though no trade ticket
          // is open and no further calculations will run until a new one is opened.
          setBadge('', null);
          reportStatus(FMC_CONSTANTS.STATUS_STATE.INACTIVE);
          break;

        case 'incomplete':
          // Increment currentRequest so any in-flight handleTradeReady call that
          // was dispatched before the form became incomplete cannot overwrite the
          // panel with results that no longer match the current form state.
          currentRequest++;
          // Clear any error badge — the form has changed and the previous error is
          // no longer relevant to the current (incomplete) input state. The badge
          // will be re-set when the next 'ready' cycle completes or fails.
          setBadge('', null);
          // If the panel is visible with stale results (or an error), transition it
          // to loading state so the user is not misled by data that no longer reflects
          // the current (incomplete) form state. showLoading() is idempotent — safe to
          // call even if the panel is already loading.
          if (MarginInjector.getPanel()) MarginInjector.showLoading();
          break;
      }
    }

    // Only start observing when the extension is enabled. If disabled at load time,
    // the storage onChanged listener (above) will call TradeDetector.observe() when the
    // user re-enables — so skipping here avoids a MutationObserver and input listener
    // running on every Fidelity page mutation when no calculation will ever fire.
    if (settings.enabled) TradeDetector.observe(tradeEventCallback, settings.debounceMs);
  }

  // run_at: "document_idle" guarantees DOMContentLoaded has fired before any content script
  // runs, so document.readyState is always 'interactive' or 'complete' here — never 'loading'.
  init().catch(err => log('Fatal init error:', err));
})();
