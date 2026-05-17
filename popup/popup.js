// Popup logic — reads status from chrome.storage.local, manages settings in chrome.storage.sync
(() => {
  const DEFAULT_SETTINGS = FMC_CONSTANTS.DEFAULT_SETTINGS;

  const STORAGE_KEY_SETTINGS = FMC_CONSTANTS.STORAGE_KEY_SETTINGS;
  const STORAGE_KEY_STATUS = FMC_CONSTANTS.STORAGE_KEY_STATUS;

  // Mask account number for privacy: Z2...8273
  function maskAccount(acct) {
    if (!acct || acct.length < 6) return acct || '--';
    return `${acct.slice(0, 2)}...${acct.slice(-4)}`;
  }

  function timeAgo(ts) {
    if (!ts) return '--';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 5) return 'just now';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}min ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  }

  // --- Status display ---
  function updateStatus(status) {
    const dotEl = document.getElementById('status-dot');
    const textEl = document.getElementById('status-text');
    const acctEl = document.getElementById('status-account');
    const calcEl = document.getElementById('status-last-calc');
    const callsEl = document.getElementById('status-api-calls');
    const errRow = document.getElementById('status-error-row');
    const errEl = document.getElementById('status-error');

    if (!status) {
      if (textEl) textEl.textContent = 'Not connected';
      if (dotEl) dotEl.className = 'status-dot inactive';
      return;
    }

    if (textEl) {
      textEl.textContent = status.state === 'active' ? 'Active' :
                           status.state === 'error' ? 'Error' : 'Inactive';
    }
    if (dotEl) dotEl.className = `status-dot ${status.state || 'inactive'}`;

    if (acctEl) acctEl.textContent = maskAccount(status.accountNum);
    if (calcEl) calcEl.textContent = timeAgo(status.lastCalcTime);
    if (callsEl) callsEl.textContent = status.apiCallCount || 0;

    if (errRow) errRow.style.display = status.lastError ? '' : 'none';
    if (errEl && status.lastError) errEl.textContent = status.lastError;
  }

  // --- Settings ---
  async function loadSettings() {
    try {
      const result = await chrome.storage.sync.get(STORAGE_KEY_SETTINGS);
      const s = { ...DEFAULT_SETTINGS, ...result[STORAGE_KEY_SETTINGS] };
      const enabledEl = document.getElementById('setting-enabled');
      const thresholdEl = document.getElementById('setting-threshold');
      const debounceEl = document.getElementById('setting-debounce');
      if (enabledEl) enabledEl.checked = s.enabled;
      if (thresholdEl) thresholdEl.value = s.debitWarningThreshold;
      if (debounceEl) debounceEl.value = String(s.debounceMs);
    } catch (err) {
      console.warn('[FMC-Popup] Could not load settings:', err.message);
    }
  }

  function saveSettings() {
    const enabledEl = document.getElementById('setting-enabled');
    const thresholdEl = document.getElementById('setting-threshold');
    const debounceEl = document.getElementById('setting-debounce');
    if (!enabledEl || !thresholdEl || !debounceEl) return;
    const threshold = parseInt(thresholdEl.value, 10);
    const debounce = parseInt(debounceEl.value, 10);
    const settings = {
      enabled: enabledEl.checked,
      debitWarningThreshold: Number.isFinite(threshold) ? threshold : DEFAULT_SETTINGS.debitWarningThreshold,
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
    if (versionEl) versionEl.textContent = `v${manifest.version}`;

    // Load current status
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY_STATUS);
      updateStatus(result[STORAGE_KEY_STATUS]);
    } catch { /* storage unavailable */ }

    // Live status updates
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORAGE_KEY_STATUS]) {
        updateStatus(changes[STORAGE_KEY_STATUS].newValue);
      }
    });

    // Load settings
    await loadSettings();

    // Settings change handlers
    const settingIds = ['setting-enabled', 'setting-threshold', 'setting-debounce'];
    for (const id of settingIds) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', saveSettings);
    }

    // Settings toggle
    const toggle = document.getElementById('settings-toggle');
    const body = document.getElementById('settings-body');
    const arrow = document.getElementById('settings-arrow');
    if (toggle && body && arrow) {
      function applyToggle() {
        const isCollapsed = body.classList.toggle('collapsed');
        arrow.classList.toggle('collapsed');
        toggle.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      }
      toggle.addEventListener('click', applyToggle);
      toggle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          applyToggle();
        }
      });
    }

    // Force recalculate
    const refreshBtn = document.getElementById('btn-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      const originalText = refreshBtn.textContent;
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]) {
          await chrome.tabs.sendMessage(tabs[0].id, { type: 'FORCE_RECALC', _fmc: true })
            .catch(() => null); // Content script may not be loaded on this tab — ignore
          refreshBtn.textContent = 'Sent!';
        } else {
          refreshBtn.textContent = 'No tab';
        }
      } catch {
        refreshBtn.textContent = 'Error';
      } finally {
        setTimeout(() => {
          refreshBtn.textContent = originalText;
          refreshBtn.disabled = false;
        }, 1500);
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => init().catch(err => console.error('[FMC-Popup] Fatal init error:', err)));
})();
