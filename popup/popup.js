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
    return acct.slice(0, 2) + '...' + acct.slice(-4);
  }

  function timeAgo(ts) {
    if (!ts) return '--';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 5) return 'just now';
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'min ago';
    return Math.floor(diff / 3600) + 'h ago';
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
    if (dotEl) dotEl.className = 'status-dot ' + (status.state || 'inactive');

    if (acctEl) acctEl.textContent = maskAccount(status.accountNum);
    if (calcEl) calcEl.textContent = timeAgo(status.lastCalcTime);
    if (callsEl) callsEl.textContent = status.apiCallCount || 0;

    if (errRow) errRow.style.display = status.lastError ? '' : 'none';
    if (errEl && status.lastError) errEl.textContent = status.lastError;
  }

  // --- Settings ---
  function loadSettings() {
    chrome.storage.sync.get('fmc_settings', (result) => {
      const s = Object.assign({}, DEFAULT_SETTINGS, result.fmc_settings);
      document.getElementById('setting-enabled').checked = s.enabled;
      document.getElementById('setting-threshold').value = s.debitWarningThreshold;
      document.getElementById('setting-debounce').value = String(s.debounceMs);
      document.getElementById('setting-auto-refresh').checked = s.autoRefreshBaseline;
    });
  }

  function saveSettings() {
    const settings = {
      enabled: document.getElementById('setting-enabled').checked,
      debitWarningThreshold: parseInt(document.getElementById('setting-threshold').value, 10) || 500,
      debounceMs: parseInt(document.getElementById('setting-debounce').value, 10) || 500,
      autoRefreshBaseline: document.getElementById('setting-auto-refresh').checked
    };
    chrome.storage.sync.set({ fmc_settings: settings });
  }

  // --- Init ---
  function init() {
    // Version
    const manifest = chrome.runtime.getManifest();
    document.getElementById('version').textContent = 'v' + manifest.version;

    // Load current status
    chrome.storage.local.get('fmc_status', (result) => {
      updateStatus(result.fmc_status);
    });

    // Live status updates
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.fmc_status) {
        updateStatus(changes.fmc_status.newValue);
      }
    });

    // Load settings
    loadSettings();

    // Settings change handlers
    const settingIds = ['setting-enabled', 'setting-threshold', 'setting-debounce', 'setting-auto-refresh'];
    for (const id of settingIds) {
      document.getElementById(id).addEventListener('change', saveSettings);
    }

    // Settings toggle
    const toggle = document.getElementById('settings-toggle');
    const body = document.getElementById('settings-body');
    const arrow = document.getElementById('settings-arrow');
    toggle.addEventListener('click', () => {
      body.classList.toggle('collapsed');
      arrow.classList.toggle('collapsed');
    });

    // Force recalculate
    document.getElementById('btn-refresh').addEventListener('click', () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'FORCE_RECALC', _fmc: true });
        }
      });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
