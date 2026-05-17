// Popup logic — reads status from chrome.storage.local, manages settings in chrome.storage.sync
(() => {
  const DEFAULT_SETTINGS = {
    enabled: true,
    debitWarningThreshold: 500,
    debounceMs: 500,
    autoRefreshBaseline: true
  };

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
      const result = await chrome.storage.sync.get('fmc_settings');
      const s = { ...DEFAULT_SETTINGS, ...result.fmc_settings };
      document.getElementById('setting-enabled').checked = s.enabled;
      document.getElementById('setting-threshold').value = s.debitWarningThreshold;
      document.getElementById('setting-debounce').value = String(s.debounceMs);
      document.getElementById('setting-auto-refresh').checked = s.autoRefreshBaseline;
    } catch { /* storage unavailable — keep HTML defaults */ }
  }

  function saveSettings() {
    const enabledEl = document.getElementById('setting-enabled');
    const thresholdEl = document.getElementById('setting-threshold');
    const debounceEl = document.getElementById('setting-debounce');
    const autoRefreshEl = document.getElementById('setting-auto-refresh');
    if (!enabledEl || !thresholdEl || !debounceEl || !autoRefreshEl) return;
    const threshold = parseInt(thresholdEl.value, 10);
    const debounce = parseInt(debounceEl.value, 10);
    const settings = {
      enabled: enabledEl.checked,
      debitWarningThreshold: Number.isFinite(threshold) ? threshold : 500,
      debounceMs: Number.isFinite(debounce) && debounce > 0 ? debounce : 500,
      autoRefreshBaseline: autoRefreshEl.checked
    };
    chrome.storage.sync.set({ fmc_settings: settings }).catch((err) => {
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
      const result = await chrome.storage.local.get('fmc_status');
      updateStatus(result.fmc_status);
    } catch { /* storage unavailable */ }

    // Live status updates
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.fmc_status) {
        updateStatus(changes.fmc_status.newValue);
      }
    });

    // Load settings
    await loadSettings();

    // Settings change handlers
    const settingIds = ['setting-enabled', 'setting-threshold', 'setting-debounce', 'setting-auto-refresh'];
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
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'FORCE_RECALC', _fmc: true })
            .catch(() => {}); // Content script may not be loaded on this tab — ignore
        }
      } catch { /* tabs API unavailable */ }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
