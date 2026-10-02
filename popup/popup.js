// Popup logic — reads status from chrome.storage.local, manages settings in chrome.storage.sync
'use strict';
(() => {
  const LOG_PREFIX = '[FMC-Popup]';

  const { DEFAULT_SETTINGS, STORAGE_KEY_SETTINGS, STORAGE_KEY_STATUS } = FMC_CONSTANTS;

  const { TIME_REFRESH_INTERVAL_MS, FEEDBACK_CLEAR_MS: REFRESH_FEEDBACK_CLEAR_MS, FORCE_RECALC_FEEDBACK } = FMC_CONSTANTS.POPUP;

  // Account masking parameters — sourced from FMC_CONSTANTS so a single edit adjusts
  // the masking behaviour in all consumers rather than requiring a change here AND in constants.js.
  const { PREFIX_LEN: MASK_PREFIX, SUFFIX_LEN: MASK_SUFFIX, MIN_LEN: MASK_MIN_LEN } = FMC_CONSTANTS.ACCOUNT_MASK;

  const { STATUS_STATE, STATUS_LABEL, MAX_WARNING_THRESHOLD, THRESHOLD_INPUT_STEP, MIN_DEBOUNCE_MS } = FMC_CONSTANTS;

  /**
   * Masks an account number for privacy display: e.g. "AB12345678" → "AB...5678".
   * Returns '--' for null/undefined; returns the original string if shorter than MASK_MIN_LEN,
   * so that masking only occurs when at least one character is genuinely hidden.
   * @param {string|null|undefined} acct - Raw account number string.
   * @returns {string} Masked account string suitable for display.
   */
  function maskAccount(acct) {
    if (!acct || acct.length < MASK_MIN_LEN) return acct || '--';
    return `${acct.slice(0, MASK_PREFIX)}...${acct.slice(-MASK_SUFFIX)}`;
  }

  /**
   * Returns a human-readable relative time string for a timestamp.
   * e.g. 1715000000000 → "just now" / "42s ago" / "3m ago" / "2h ago".
   * @param {number|null|undefined} ts - Unix timestamp in milliseconds (Date.now() format).
   * @returns {string} Relative time string, or '--' if ts is null/undefined.
   */
  function timeAgo(ts) {
    if (ts == null) return '--';
    const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diff < 5) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  // --- Status display ---
  // Cached copy of the most recent status object — lets the TIME_REFRESH_INTERVAL_MS
  // timer re-render timeAgo() without a storage read on every tick.
  let lastStatus = null;

  // Element references cached at DOMContentLoaded time — updateStatus is called on every
  // storage change so avoiding repeated getElementById calls reduces redundant DOM lookups.
  let statusEls = null;
  /**
   * Returns (and caches) references to all status-section DOM elements.
   * Called on every `updateStatus` invocation so elements are retrieved once
   * instead of on every storage change event.
   * @returns {{ dot: HTMLElement|null, text: HTMLElement|null, acct: HTMLElement|null,
   *   calc: HTMLElement|null, calls: HTMLElement|null,
   *   errRow: HTMLElement|null, err: HTMLElement|null }} Status element map.
   */
  function getStatusEls() {
    if (statusEls) return statusEls;
    statusEls = {
      dot:    document.getElementById('status-dot'),
      text:   document.getElementById('status-text'),
      acct:   document.getElementById('status-account'),
      calc:   document.getElementById('status-last-calc'),
      calls:  document.getElementById('status-api-calls'),
      errRow: document.getElementById('status-error-row'),
      err:    document.getElementById('status-error')
    };
    return statusEls;
  }

  /**
   * Renders the current extension status into the popup's status section.
   * Called on initial load and on every `chrome.storage.local` change for
   * `STORAGE_KEY_STATUS`, as well as by the TIME_REFRESH_INTERVAL_MS timer
   * to keep the relative `timeAgo` display accurate between updates.
   * @param {Object|null} status - Status object from `chrome.storage.local`, or null if absent.
   * @param {string} [status.state] - One of {@link FMC_CONSTANTS.STATUS_STATE}.
   * @param {string|null} [status.accountNum] - Active account number, or null.
   * @param {number|null} [status.lastCalcTime] - Timestamp (ms) of the last successful API call.
   * @param {number} [status.apiCallCount] - Total API calls made in this session.
   * @param {string|null} [status.lastError] - Last error message, or null if no error.
   */
  function updateStatus(status) {
    const { dot: dotEl, text: textEl, acct: acctEl, calc: calcEl,
            calls: callsEl, errRow, err: errEl } = getStatusEls();

    if (!status) {
      if (textEl) textEl.textContent = 'Not connected';
      if (dotEl) dotEl.className = `status-dot ${STATUS_STATE.INACTIVE}`;
      // Reset all other fields to defaults so stale data from a previous status is
      // not displayed after the extension status is cleared (e.g. after update/reinstall).
      if (acctEl) acctEl.textContent = '--';
      if (calcEl) calcEl.textContent = '--';
      if (callsEl) callsEl.textContent = '0';
      if (errEl) errEl.textContent = '';
      errRow?.classList.remove('has-error');
      return;
    }

    if (textEl) {
      textEl.textContent = STATUS_LABEL[status.state] ?? 'Inactive';
    }
    // Validate state before using as a CSS class — guards against corrupted storage
    // injecting an arbitrary string as a class name on the status indicator element.
    const validState = Object.values(STATUS_STATE).includes(status.state)
      ? status.state
      : STATUS_STATE.INACTIVE;
    if (dotEl) dotEl.className = `status-dot ${validState}`;

    if (acctEl) acctEl.textContent = maskAccount(status.accountNum);
    if (calcEl) calcEl.textContent = timeAgo(status.lastCalcTime);
    if (callsEl) callsEl.textContent = status.apiCallCount ?? 0;

    // Set textContent before toggling visibility so the live region has content
    // when it enters the accessibility tree — improves screen-reader announcement
    // reliability when the row transitions from visually-hidden to visible.
    if (errEl) errEl.textContent = status.lastError || '';
    errRow?.classList.toggle('has-error', !!status.lastError);
  }

  // --- Settings ---
  // Element references cached at DOMContentLoaded time — saveSettings fires on
  // every settings change event, so avoiding repeated getElementById calls here
  // mirrors the same optimisation used for status elements in getStatusEls().
  let settingsEls = null;
  /**
   * Returns (and caches) references to all settings-section input elements.
   * Called on every `saveSettings`/`loadSettings` invocation so elements are
   * retrieved once instead of on every storage or change event.
   * @returns {{ enabled: HTMLInputElement|null, threshold: HTMLInputElement|null,
   *   debounce: HTMLSelectElement|null }} Settings element map.
   */
  function getSettingsEls() {
    if (settingsEls) return settingsEls;
    settingsEls = {
      enabled:   document.getElementById('setting-enabled'),
      threshold: document.getElementById('setting-threshold'),
      debounce:  document.getElementById('setting-debounce'),
      chainEnabled:    document.getElementById('setting-chain-enabled'),
      rollEnabled:     document.getElementById('setting-roll-enabled'),
      minWithdrawable: document.getElementById('setting-min-withdrawable'),
      chainQty:        document.getElementById('setting-chain-qty'),
      borrowRate:      document.getElementById('setting-borrow-rate')
    };
    return settingsEls;
  }

  /**
   * Parses and clamps a numeric chain setting; falls back to `fallback` when not finite.
   * @param {*} raw
   * @param {number} min
   * @param {number} max
   * @param {number} fallback
   * @returns {number}
   */
  function clampChainNumber(raw, min, max, fallback) {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  /**
   * Reads settings from `chrome.storage.sync` and populates the settings form.
   * Falls back to {@link DEFAULT_SETTINGS} for any missing or invalid values.
   * Clamps the threshold input to [0, MAX_WARNING_THRESHOLD] before display to
   * normalise any manually-edited or corrupted storage values.
   * @returns {Promise<void>}
   */
  async function loadSettings() {
    if (!chrome.storage?.sync) {
      console.warn(LOG_PREFIX, 'chrome.storage.sync unavailable — using default settings');
      return;
    }
    try {
      const result = await chrome.storage.sync.get(STORAGE_KEY_SETTINGS);
      const s = { ...DEFAULT_SETTINGS, ...result[STORAGE_KEY_SETTINGS] };
      const { enabled: enabledEl, threshold: thresholdEl, debounce: debounceEl } = getSettingsEls();
      if (enabledEl) enabledEl.checked = s.enabled;
      if (thresholdEl) {
        // Clamp before display so corrupted or manually-edited storage values are
        // normalised to a valid range, consistent with the clamping in saveSettings().
        const rawThreshold = Number(s.debitWarningThreshold);
        thresholdEl.value = Number.isFinite(rawThreshold)
          ? Math.min(MAX_WARNING_THRESHOLD, Math.max(0, rawThreshold))
          : DEFAULT_SETTINGS.debitWarningThreshold;
      }
      const { chainEnabled: chainEnabledEl, minWithdrawable: minWEl, chainQty: chainQtyEl } = getSettingsEls();
      if (chainEnabledEl) chainEnabledEl.checked = s.chainEnabled !== false;
      const { borrowRate: borrowRateEl } = getSettingsEls();
      if (borrowRateEl) borrowRateEl.value = clampChainNumber(s.borrowRate, 0, FMC_CONSTANTS.CHAIN_LIMITS.BORROW_RATE_MAX, DEFAULT_SETTINGS.borrowRate);
      const { rollEnabled: rollEnabledEl } = getSettingsEls();
      if (rollEnabledEl) rollEnabledEl.checked = s.rollEnabled !== false;
      if (minWEl) minWEl.value = clampChainNumber(s.minWithdrawable, 0, FMC_CONSTANTS.CHAIN_LIMITS.MIN_WITHDRAWABLE_MAX, DEFAULT_SETTINGS.minWithdrawable);
      if (chainQtyEl) chainQtyEl.value = clampChainNumber(s.chainQty, 1, FMC_CONSTANTS.CHAIN_LIMITS.QTY_MAX, DEFAULT_SETTINGS.chainQty);
      if (debounceEl) {
        debounceEl.value = String(s.debounceMs);
        // HTMLSelectElement.value silently stays empty if the value doesn't match
        // any option. Fall back to the default so the UI isn't left blank.
        if (debounceEl.value === '') debounceEl.value = String(DEFAULT_SETTINGS.debounceMs);
      }
    } catch (err) {
      console.warn(LOG_PREFIX, 'Could not load settings:', err.message);
    }
  }

  /**
   * Reads the current settings form values, clamps/validates them, reflects any
   * clamped values back to the inputs, then persists to `chrome.storage.sync`.
   * Called on every settings `change` event (enabled toggle, threshold input,
   * debounce select). Safe to call if storage is unavailable — returns early.
   */
  function saveSettings() {
    if (!chrome.storage?.sync) return;
    const { enabled: enabledEl, threshold: thresholdEl, debounce: debounceEl } = getSettingsEls();
    if (!enabledEl || !thresholdEl || !debounceEl) return;
    const threshold = parseInt(thresholdEl.value, 10);
    const debounce = parseInt(debounceEl.value, 10);
    const clampedThreshold = Number.isFinite(threshold)
      ? Math.min(MAX_WARNING_THRESHOLD, Math.max(0, threshold))
      : DEFAULT_SETTINGS.debitWarningThreshold;
    // Reflect the clamped value back to the input so the user sees what was saved.
    // Without this, typing "999999" would be saved as 100000 (MAX_WARNING_THRESHOLD)
    // but the input would still display "999999" — a silent inconsistency.
    if (String(clampedThreshold) !== thresholdEl.value) {
      thresholdEl.value = clampedThreshold;
    }
    const { chainEnabled: chainEnabledEl, minWithdrawable: minWEl, chainQty: chainQtyEl } = getSettingsEls();
    const minWithdrawable = clampChainNumber(minWEl?.value, 0, FMC_CONSTANTS.CHAIN_LIMITS.MIN_WITHDRAWABLE_MAX, DEFAULT_SETTINGS.minWithdrawable);
    const chainQty = Math.round(clampChainNumber(chainQtyEl?.value, 1, FMC_CONSTANTS.CHAIN_LIMITS.QTY_MAX, DEFAULT_SETTINGS.chainQty));
    if (minWEl && String(minWithdrawable) !== minWEl.value) minWEl.value = minWithdrawable;
    if (chainQtyEl && String(chainQty) !== chainQtyEl.value) chainQtyEl.value = chainQty;
    const borrowRateEl = getSettingsEls().borrowRate;
    const borrowRate = clampChainNumber(borrowRateEl?.value, 0, FMC_CONSTANTS.CHAIN_LIMITS.BORROW_RATE_MAX, DEFAULT_SETTINGS.borrowRate);
    if (borrowRateEl && String(borrowRate) !== borrowRateEl.value) borrowRateEl.value = borrowRate;
    const settings = {
      borrowRate,
      chainEnabled: chainEnabledEl ? chainEnabledEl.checked : DEFAULT_SETTINGS.chainEnabled,
      rollEnabled: getSettingsEls().rollEnabled ? getSettingsEls().rollEnabled.checked : DEFAULT_SETTINGS.rollEnabled,
      minWithdrawable,
      chainQty,
      enabled: enabledEl.checked,
      debitWarningThreshold: clampedThreshold,
      debounceMs: Number.isFinite(debounce) && debounce >= MIN_DEBOUNCE_MS ? debounce : DEFAULT_SETTINGS.debounceMs
    };
    chrome.storage.sync.set({ [STORAGE_KEY_SETTINGS]: settings }).catch((err) => {
      console.warn(LOG_PREFIX, 'Could not save settings:', err.message);
    });
  }

  /**
   * Popup entry point. Wires up all UI interactions:
   * - Displays the extension version from the manifest.
   * - Loads and renders current status from `chrome.storage.local`.
   * - Starts a periodic timer to refresh the `timeAgo` display.
   * - Subscribes to `chrome.storage.onChanged` for live status/settings updates.
   * - Syncs the threshold input's `max` attribute from `FMC_CONSTANTS`.
   * - Attaches settings change listeners and the settings collapse toggle.
   * - Wires up the force-recalculate button to send a message to the active tab.
   * @returns {Promise<void>}
   */
  async function init() {
    // Version
    const manifest = chrome.runtime.getManifest();
    const versionEl = document.getElementById('version');
    if (versionEl) {
      versionEl.textContent = `v${manifest.version}`;
      versionEl.setAttribute('aria-label', `Extension version ${manifest.version}`);
    }

    // Load current status
    if (chrome.storage?.local) {
      try {
        const result = await chrome.storage.local.get(STORAGE_KEY_STATUS);
        lastStatus = result[STORAGE_KEY_STATUS] ?? null;
        updateStatus(lastStatus);
      } catch { /* storage unavailable */ }
    }

    // Periodically refresh the "Last Calc" timeAgo display while the popup is open.
    // Storage onChanged handles real updates; this keeps the relative time accurate
    // between updates (e.g. "30s ago" → "35s ago") without polling storage.
    setInterval(() => {
      if (lastStatus) updateStatus(lastStatus);
    }, TIME_REFRESH_INTERVAL_MS);

    // Live status updates and settings refresh
    if (chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[STORAGE_KEY_STATUS]) {
          lastStatus = changes[STORAGE_KEY_STATUS].newValue ?? null;
          updateStatus(lastStatus);
        }
        // Refresh settings display if they change via Chrome Sync from another device
        if (area === 'sync' && changes[STORAGE_KEY_SETTINGS]) {
          loadSettings().catch(err => console.warn(LOG_PREFIX, 'Could not refresh settings:', err.message));
        }
      });
    }

    // Sync the threshold input's max and step attributes from constants so changing
    // MAX_WARNING_THRESHOLD or THRESHOLD_INPUT_STEP in constants.js is automatically
    // reflected here without requiring a separate HTML edit that could drift out of sync.
    const { threshold: thresholdConstraintEl } = getSettingsEls();
    if (thresholdConstraintEl) {
      thresholdConstraintEl.max  = String(MAX_WARNING_THRESHOLD);
      thresholdConstraintEl.step = String(THRESHOLD_INPUT_STEP);
    }

    // Keep the hint text in sync with the constant for the same reason.
    const hintThresholdEl = document.getElementById('hint-threshold');
    if (hintThresholdEl) {
      const maxFormatted = MAX_WARNING_THRESHOLD.toLocaleString('en-US');
      hintThresholdEl.textContent =
        `Show a warning when projected margin credit is at or below this amount. Range: $0\u2013$${maxFormatted}.`;
    }

    // Load settings
    await loadSettings();

    // Settings change handlers — use getSettingsEls() so IDs stay in one place
    const { enabled: enabledEl, threshold: thresholdEl, debounce: debounceEl,
      chainEnabled: chainEnabledEl, rollEnabled: rollEnabledEl, minWithdrawable: minWEl, chainQty: chainQtyEl } = getSettingsEls();
    for (const el of [enabledEl, thresholdEl, debounceEl, chainEnabledEl, rollEnabledEl, minWEl, chainQtyEl, getSettingsEls().borrowRate]) {
      el?.addEventListener('change', saveSettings);
    }

    // Settings toggle
    const toggle = document.getElementById('settings-toggle');
    const body = document.getElementById('settings-body');
    const arrow = document.getElementById('settings-arrow');
    if (toggle && body && arrow) {
      const COLLAPSE_KEY = FMC_CONSTANTS.STORAGE_KEY_SETTINGS_COLLAPSED;

      // Apply collapsed or expanded state to all relevant elements.
      // isCollapsed: true = settings section hidden, false = settings section shown.
      const applyCollapsedState = (isCollapsed) => {
        body.classList.toggle('collapsed', isCollapsed);
        arrow.classList.toggle('collapsed', isCollapsed);
        toggle.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
        // Use setAttribute('aria-hidden','true') / removeAttribute rather than
        // setAttribute('aria-hidden','false') or toggleAttribute('aria-hidden', bool):
        //   - aria-hidden="false" is an antipattern — removing the attribute is the correct
        //     way to mark an element as accessible (the "false" value is defined to have no
        //     effect and some screen readers treat it inconsistently).
        //   - toggleAttribute('aria-hidden', true) sets aria-hidden="" (empty string), which
        //     is not a valid enumerated value; AT behaviour is implementation-defined for it.
        if (isCollapsed) {
          body.setAttribute('aria-hidden', 'true');
        } else {
          body.removeAttribute('aria-hidden');
        }
        // inert prevents keyboard users from tabbing into inputs hidden by the CSS
        // max-height collapse (aria-hidden alone only hides from screen readers, not focus).
        if (isCollapsed) {
          body.setAttribute('inert', '');
        } else {
          body.removeAttribute('inert');
        }
      };

      // Restore persisted collapse state so the section opens in the same state
      // the user last left it, rather than always defaulting to expanded.
      // Awaited so the collapse is applied before the popup renders its first frame,
      // preventing a brief flash where the section appears expanded then collapses.
      if (chrome.storage?.local) {
        try {
          const collapseResult = await chrome.storage.local.get(COLLAPSE_KEY);
          if (collapseResult[COLLAPSE_KEY] === true) applyCollapsedState(true);
        } catch { /* storage read failure — default to expanded */ }
      }

      toggle.addEventListener('click', () => {
        const isCollapsed = !body.classList.contains('collapsed');
        applyCollapsedState(isCollapsed);
        // Persist the new state so the next popup open restores it.
        chrome.storage?.local?.set({ [COLLAPSE_KEY]: isCollapsed }).catch(() => {});
      });
    }

    // Force recalculate
    const refreshBtn = document.getElementById('btn-refresh');
    const refreshStatus = document.getElementById('btn-refresh-status');
    if (refreshBtn) refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      if (refreshStatus) refreshStatus.textContent = '';
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]?.id != null) {
          const resp = await chrome.tabs.sendMessage(tabs[0].id, { type: FMC_CONSTANTS.MESSAGE_TYPES.FORCE_RECALC, _fmc: true })
            .catch(() => null); // Content script may not be loaded on this tab — ignore
          if (refreshStatus) {
            if (resp?.ok) {
              refreshStatus.textContent = FORCE_RECALC_FEEDBACK.OK;
            } else if (resp?.disabled) {
              refreshStatus.textContent = FORCE_RECALC_FEEDBACK.DISABLED;
            } else if (resp?.inactive) {
              refreshStatus.textContent = FORCE_RECALC_FEEDBACK.INACTIVE;
            } else {
              refreshStatus.textContent = FORCE_RECALC_FEEDBACK.NO_CONTENT;
            }
          }
        } else {
          if (refreshStatus) refreshStatus.textContent = FORCE_RECALC_FEEDBACK.NO_TAB;
        }
      } catch {
        if (refreshStatus) refreshStatus.textContent = FORCE_RECALC_FEEDBACK.ERROR;
      } finally {
        setTimeout(() => {
          if (refreshStatus) refreshStatus.textContent = '';
          refreshBtn.disabled = false;
        }, REFRESH_FEEDBACK_CLEAR_MS);
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => init().catch(err => console.error(LOG_PREFIX, 'Fatal init error:', err)));
})();
