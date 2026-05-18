// Popup logic — reads status from chrome.storage.local, manages settings in chrome.storage.sync
(() => {
  const DEFAULT_SETTINGS = FMC_CONSTANTS.DEFAULT_SETTINGS;

  const STORAGE_KEY_SETTINGS = FMC_CONSTANTS.STORAGE_KEY_SETTINGS;
  const STORAGE_KEY_STATUS = FMC_CONSTANTS.STORAGE_KEY_STATUS;

  // How often (ms) to refresh the "Last Calc" timeAgo display while the popup is open.
  const TIME_REFRESH_INTERVAL_MS = 5000;
  // How long (ms) to show the force-recalculate button's feedback before clearing it.
  const REFRESH_FEEDBACK_CLEAR_MS = 1500;

  // Account masking parameters — first N chars + '...' + last M chars.
  const MASK_MIN_LEN = 6;    // only mask accounts long enough to safely truncate
  const MASK_PREFIX = 2;     // chars to show at the start
  const MASK_SUFFIX = 4;     // chars to show at the end

  // Mask account number for privacy: Z2...8273
  function maskAccount(acct) {
    if (!acct || acct.length < MASK_MIN_LEN) return acct || '--';
    return `${acct.slice(0, MASK_PREFIX)}...${acct.slice(-MASK_SUFFIX)}`;
  }

  function timeAgo(ts) {
    if (ts == null) return '--';
    const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diff < 5) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}min ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  }

  // --- Status display ---
  // Cached copy of the most recent status object — lets the TIME_REFRESH_INTERVAL_MS
  // timer re-render timeAgo() without a storage read on every tick.
  let lastStatus = null;

  // Element references cached at DOMContentLoaded time — updateStatus is called on every
  // storage change so avoiding repeated getElementById calls reduces redundant DOM lookups.
  let statusEls = null;
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

  function updateStatus(status) {
    const { dot: dotEl, text: textEl, acct: acctEl, calc: calcEl,
            calls: callsEl, errRow, err: errEl } = getStatusEls();

    if (!status) {
      if (textEl) textEl.textContent = 'Not connected';
      if (dotEl) dotEl.className = `status-dot ${FMC_CONSTANTS.STATUS_STATE.INACTIVE}`;
      // Reset all other fields to defaults so stale data from a previous status is
      // not displayed after the extension status is cleared (e.g. after update/reinstall).
      if (acctEl) acctEl.textContent = '--';
      if (calcEl) calcEl.textContent = '--';
      if (callsEl) callsEl.textContent = '0';
      if (errRow) errRow.style.display = 'none';
      if (errEl) errEl.textContent = '';
      return;
    }

    if (textEl) {
      textEl.textContent = status.state === FMC_CONSTANTS.STATUS_STATE.ACTIVE ? 'Active' :
                           status.state === FMC_CONSTANTS.STATUS_STATE.ERROR ? 'Error' : 'Inactive';
    }
    if (dotEl) dotEl.className = `status-dot ${status.state || FMC_CONSTANTS.STATUS_STATE.INACTIVE}`;

    if (acctEl) acctEl.textContent = maskAccount(status.accountNum);
    if (calcEl) calcEl.textContent = timeAgo(status.lastCalcTime);
    if (callsEl) callsEl.textContent = status.apiCallCount ?? 0;

    if (errRow) errRow.style.display = status.lastError ? 'flex' : 'none';
    if (errEl) errEl.textContent = status.lastError || '';
  }

  // --- Settings ---
  // Element references cached at DOMContentLoaded time — saveSettings fires on
  // every settings change event, so avoiding repeated getElementById calls here
  // mirrors the same optimisation used for status elements in getStatusEls().
  let settingsEls = null;
  function getSettingsEls() {
    if (settingsEls) return settingsEls;
    settingsEls = {
      enabled:   document.getElementById('setting-enabled'),
      threshold: document.getElementById('setting-threshold'),
      debounce:  document.getElementById('setting-debounce')
    };
    return settingsEls;
  }

  async function loadSettings() {
    if (!chrome.storage?.sync) {
      console.warn('[FMC-Popup] chrome.storage.sync unavailable — using default settings');
      return;
    }
    try {
      const result = await chrome.storage.sync.get(STORAGE_KEY_SETTINGS);
      const s = { ...DEFAULT_SETTINGS, ...result[STORAGE_KEY_SETTINGS] };
      const { enabled: enabledEl, threshold: thresholdEl, debounce: debounceEl } = getSettingsEls();
      if (enabledEl) enabledEl.checked = s.enabled;
      if (thresholdEl) thresholdEl.value = s.debitWarningThreshold;
      if (debounceEl) {
        debounceEl.value = String(s.debounceMs);
        // HTMLSelectElement.value silently stays empty if the value doesn't match
        // any option. Fall back to the default so the UI isn't left blank.
        if (debounceEl.value === '') debounceEl.value = String(DEFAULT_SETTINGS.debounceMs);
      }
    } catch (err) {
      console.warn('[FMC-Popup] Could not load settings:', err.message);
    }
  }

  function saveSettings() {
    if (!chrome.storage?.sync) return;
    const { enabled: enabledEl, threshold: thresholdEl, debounce: debounceEl } = getSettingsEls();
    if (!enabledEl || !thresholdEl || !debounceEl) return;
    const threshold = parseInt(thresholdEl.value, 10);
    const debounce = parseInt(debounceEl.value, 10);
    const settings = {
      enabled: enabledEl.checked,
      debitWarningThreshold: Number.isFinite(threshold)
        ? Math.min(FMC_CONSTANTS.MAX_WARNING_THRESHOLD, Math.max(0, threshold))
        : DEFAULT_SETTINGS.debitWarningThreshold,
      debounceMs: Number.isFinite(debounce) && debounce >= FMC_CONSTANTS.MIN_DEBOUNCE_MS ? debounce : DEFAULT_SETTINGS.debounceMs
    };
    chrome.storage.sync.set({ [STORAGE_KEY_SETTINGS]: settings }).catch((err) => {
      console.warn('[FMC-Popup] Could not save settings:', err.message);
    });
  }

  // --- Init ---
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
          loadSettings().catch(err => console.warn('[FMC-Popup] Could not refresh settings:', err.message));
        }
      });
    }

    // Load settings
    await loadSettings();

    // Settings change handlers — use getSettingsEls() so IDs stay in one place
    const { enabled: enabledEl, threshold: thresholdEl, debounce: debounceEl } = getSettingsEls();
    for (const el of [enabledEl, thresholdEl, debounceEl]) {
      if (el) el.addEventListener('change', saveSettings);
    }

    // Settings toggle
    const toggle = document.getElementById('settings-toggle');
    const body = document.getElementById('settings-body');
    const arrow = document.getElementById('settings-arrow');
    if (toggle && body && arrow) {
      const applyToggle = () => {
        const isCollapsed = body.classList.toggle('collapsed');
        arrow.classList.toggle('collapsed');
        toggle.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
        body.setAttribute('aria-hidden', isCollapsed ? 'true' : 'false');
        // inert prevents keyboard users from tabbing into inputs hidden by the CSS
        // max-height collapse (aria-hidden alone only hides from screen readers, not focus).
        if (isCollapsed) {
          body.setAttribute('inert', '');
        } else {
          body.removeAttribute('inert');
        }
      };
      toggle.addEventListener('click', applyToggle);
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
          if (refreshStatus) refreshStatus.textContent = resp?.ok ? 'Recalculate requested.' : 'Not active on this tab.';
        } else {
          if (refreshStatus) refreshStatus.textContent = 'No active tab found.';
        }
      } catch {
        if (refreshStatus) refreshStatus.textContent = 'Error sending request.';
      } finally {
        setTimeout(() => {
          if (refreshStatus) refreshStatus.textContent = '';
          refreshBtn.disabled = false;
        }, REFRESH_FEEDBACK_CLEAR_MS);
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => init().catch(err => console.error('[FMC-Popup] Fatal init error:', err)));
})();
