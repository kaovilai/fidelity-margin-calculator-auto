// MarginInjector — injects margin impact panel into trade ticket DOM
const MarginInjector = (() => {
  const PANEL_ID = 'fmc-margin-panel';
  const DEFAULT_WARNING_THRESHOLD = 500; // amber when credit < this
  let warningThreshold = DEFAULT_WARNING_THRESHOLD;

  // data-fmc-state attribute values
  const PANEL_STATE = {
    LOADING: 'loading',
    ERROR: 'error',
    RESULT: 'result'
  };

  // data-fmc-status attribute values (also used as CSS class suffixes)
  const STATUS = {
    CREDIT: 'credit',
    WARNING: 'warning',
    DEBIT: 'debit'
  };

  let retryCallback = null;
  let debugLog = []; // ring buffer of debug entries
  const MAX_LOG = 50;

  function formatCurrency(value) {
    const abs = Math.abs(value);
    const formatted = '$' + abs.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    return value < 0 ? '-' + formatted : formatted;
  }

  function formatDelta(value) {
    const formatted = formatCurrency(value);
    return value > 0 ? '+' + formatted : formatted;
  }

  // Returns STATUS.CREDIT | STATUS.WARNING | STATUS.DEBIT based on projected value
  function getStatus(projectedCreditDebit) {
    if (projectedCreditDebit <= 0) return STATUS.DEBIT;
    if (projectedCreditDebit <= warningThreshold) return STATUS.WARNING;
    return STATUS.CREDIT;
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'fmc-margin-panel';
    panel.setAttribute('data-fmc-state', PANEL_STATE.LOADING);
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Margin Impact');
    panel.innerHTML = `
      <div class="fmc-panel-body">
        <div class="fmc-col">
          <span class="fmc-label" id="fmc-credit-debit-label">Margin Credit/Debit</span>
          <span class="fmc-value" id="fmc-credit-debit" aria-live="polite" aria-atomic="true" aria-labelledby="fmc-credit-debit-label">--</span>
          <span class="fmc-sublabel" id="fmc-delta"></span>
        </div>
        <div class="fmc-col">
          <span class="fmc-label" id="fmc-cash-withdrawable-label">Cash Withdrawable</span>
          <span class="fmc-value" id="fmc-cash-withdrawable" aria-live="polite" aria-atomic="true" aria-labelledby="fmc-cash-withdrawable-label">--</span>
          <span class="fmc-sublabel">without margin interest</span>
        </div>
        <div class="fmc-col fmc-col-last">
          <span class="fmc-label" id="fmc-buying-power-label">Buying Power</span>
          <span class="fmc-value" id="fmc-buying-power" aria-live="polite" aria-atomic="true" aria-labelledby="fmc-buying-power-label">--</span>
          <span class="fmc-sublabel">margin buying power</span>
        </div>
      </div>
      <div class="fmc-panel-loading" id="fmc-loading" role="status" aria-label="Calculating margin impact...">
        <span class="fmc-spinner"></span>
        <span>Calculating margin impact...</span>
      </div>
      <div class="fmc-panel-error" id="fmc-error" role="alert" style="display: none;">
        <span class="fmc-error-icon" aria-hidden="true">&#9888;</span>
        <span class="fmc-error-text"></span>
        <button type="button" class="fmc-retry-btn" aria-label="Retry margin calculation" style="display: none;">Retry</button>
        <button type="button" class="fmc-debug-btn" aria-label="Show debug log" aria-controls="fmc-debug-log" aria-expanded="false">Debug</button>
      </div>
      <div class="fmc-debug-log" id="fmc-debug-log" role="log" aria-label="Debug log" style="display: none;"></div>
      <div class="fmc-attribution">
        <span class="fmc-ext-badge">Margin Calc</span>
      </div>
    `;

    // Wire retry button
    const retryBtn = panel.querySelector('.fmc-retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        if (retryCallback) retryCallback();
      });
    }

    // Wire debug button
    const debugBtn = panel.querySelector('.fmc-debug-btn');
    const debugLogEl = panel.querySelector('#fmc-debug-log');
    if (debugBtn && debugLogEl) {
      debugBtn.addEventListener('click', () => {
        const visible = debugLogEl.style.display !== 'none';
        if (visible) {
          debugLogEl.style.display = 'none';
          debugBtn.textContent = 'Debug';
          debugBtn.setAttribute('aria-label', 'Show debug log');
          debugBtn.setAttribute('aria-expanded', 'false');
        } else {
          debugLogEl.textContent = debugLog.join('\n') || '(no log entries)';
          debugLogEl.style.display = 'block';
          debugBtn.textContent = 'Hide';
          debugBtn.setAttribute('aria-label', 'Hide debug log');
          debugBtn.setAttribute('aria-expanded', 'true');
        }
      });
    }

    return panel;
  }

  function getPanel() {
    return document.getElementById(PANEL_ID);
  }

  function getPanelElements(panel) {
    return {
      body: panel.querySelector('.fmc-panel-body'),
      loading: panel.querySelector('#fmc-loading'),
      error: panel.querySelector('#fmc-error')
    };
  }

  function inject() {
    if (getPanel()) return true;

    const mxregin = document.getElementById('mxregin');
    if (!mxregin) return false;

    const panel = createPanel();
    // Append inside ott-max-gain-loss to stay within Angular component boundary
    const parent = mxregin.closest('ott-max-gain-loss') || mxregin.parentNode;
    if (!parent) return false;
    try {
      parent.appendChild(panel);
    } catch {
      // Parent may have been removed from DOM by Angular re-render between detection and injection
      return false;
    }
    return true;
  }

  function remove() {
    const panel = getPanel();
    if (panel) panel.remove();
  }

  function showLoading() {
    const panel = getPanel();
    if (!panel) return;
    panel.setAttribute('data-fmc-state', PANEL_STATE.LOADING);
    const { body, loading, error } = getPanelElements(panel);
    // Reset display in case a prior showError() hid the body
    if (body) { body.style.display = ''; body.style.opacity = '0.5'; }
    if (loading) loading.style.display = 'flex';
    if (error) error.style.display = 'none';
  }

  function showError(msg, canRetry) {
    const panel = getPanel();
    if (!panel) return;
    panel.setAttribute('data-fmc-state', PANEL_STATE.ERROR);
    const { body, loading, error } = getPanelElements(panel);
    if (body) body.style.display = 'none';
    if (loading) loading.style.display = 'none';
    if (error) {
      error.style.display = 'flex';
      const textEl = error.querySelector('.fmc-error-text');
      if (textEl) textEl.textContent = msg;
      const retryBtn = error.querySelector('.fmc-retry-btn');
      if (retryBtn) retryBtn.style.display = canRetry ? 'inline-block' : 'none';
    }
  }

  function setRetryCallback(fn) {
    retryCallback = fn;
  }

  function updatePanel(impact) {
    const panel = getPanel();
    if (!panel) return;
    panel.setAttribute('data-fmc-state', PANEL_STATE.RESULT);

    const { body, loading, error } = getPanelElements(panel);
    if (body) { body.style.display = ''; body.style.opacity = ''; }
    if (loading) loading.style.display = 'none';
    if (error) error.style.display = 'none';

    const status = getStatus(impact.projectedCreditDebit);
    panel.setAttribute('data-fmc-status', status);

    // Column 1: Margin Credit/Debit + delta sublabel
    const creditDebitEl = panel.querySelector('#fmc-credit-debit');
    const creditDebitLabel = panel.querySelector('#fmc-credit-debit-label');
    const deltaEl = panel.querySelector('#fmc-delta');
    if (creditDebitLabel) {
      creditDebitLabel.textContent = impact.projectedCreditDebit >= 0 ? 'Margin Credit' : 'Margin Debit';
    }
    if (creditDebitEl) {
      creditDebitEl.textContent = formatCurrency(impact.projectedCreditDebit);
      creditDebitEl.className = 'fmc-value fmc-status-' + status;
    }
    if (deltaEl) {
      if (impact.delta !== null) {
        deltaEl.textContent = formatDelta(impact.delta) + ' from current';
        deltaEl.className = 'fmc-sublabel ' +
          (impact.delta < 0 ? 'fmc-negative' : impact.delta > 0 ? 'fmc-positive' : '');
      } else {
        deltaEl.textContent = 'projected with trade';
        deltaEl.className = 'fmc-sublabel';
      }
    }

    // Column 2: Cash Withdrawable
    const cashEl = panel.querySelector('#fmc-cash-withdrawable');
    if (cashEl) {
      cashEl.textContent = formatCurrency(impact.cashWithdrawable);
      cashEl.className = 'fmc-value ' +
        (impact.cashWithdrawable > 0 ? 'fmc-status-' + STATUS.CREDIT : 'fmc-neutral');
    }

    // Column 3: Buying Power
    const bpEl = panel.querySelector('#fmc-buying-power');
    if (bpEl) {
      bpEl.textContent = formatCurrency(impact.projectedBuyingPower);
      bpEl.className = 'fmc-value ' +
        (impact.projectedBuyingPower > 0 ? 'fmc-status-' + STATUS.CREDIT : 'fmc-status-' + STATUS.DEBIT);
    }
  }

  function addDebugLog(entry) {
    const ts = new Date().toLocaleTimeString();
    debugLog.push('[' + ts + '] ' + entry);
    if (debugLog.length > MAX_LOG) debugLog.shift();
    // Update visible log if open
    const logEl = document.getElementById('fmc-debug-log');
    if (logEl && logEl.style.display !== 'none') {
      logEl.textContent = debugLog.join('\n');
    }
  }

  function clearDebugLog() {
    debugLog = [];
  }

  function setWarningThreshold(val) {
    const parsed = Number(val);
    warningThreshold = isFinite(parsed) ? parsed : DEFAULT_WARNING_THRESHOLD;
  }

  return { inject, remove, showLoading, showError, updatePanel, getPanel, setRetryCallback, addDebugLog, clearDebugLog, setWarningThreshold };
})();
