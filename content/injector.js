// MarginInjector — injects margin impact panel into trade ticket DOM
const MarginInjector = (() => {
  const PANEL_ID = 'fmc-margin-panel';
  const DEFAULT_WARNING_THRESHOLD = FMC_CONSTANTS.DEFAULT_SETTINGS.debitWarningThreshold;
  let warningThreshold = DEFAULT_WARNING_THRESHOLD;

  // data-fmc-state attribute values
  const PANEL_STATE = Object.freeze({
    LOADING: 'loading',
    ERROR: 'error',
    RESULT: 'result'
  });

  // data-fmc-status attribute values (also used as CSS class suffixes)
  const STATUS = Object.freeze({
    CREDIT: 'credit',
    WARNING: 'warning',
    DEBIT: 'debit'
  });

  // IDs for elements inside the panel — used in both the HTML template and querySelector calls
  const EL_ID = Object.freeze({
    CREDIT_DEBIT:            'fmc-credit-debit',
    CREDIT_DEBIT_LABEL:      'fmc-credit-debit-label',
    CASH_WITHDRAWABLE:       'fmc-cash-withdrawable',
    CASH_WITHDRAWABLE_LABEL: 'fmc-cash-withdrawable-label',
    BUYING_POWER:            'fmc-buying-power',
    BUYING_POWER_LABEL:      'fmc-buying-power-label',
    DELTA:                   'fmc-delta',
    LOADING:                 'fmc-loading',
    ERROR:                   'fmc-error',
    DEBUG_LOG:               'fmc-debug-log'
  });

  // WeakMap from panel element → cached inner element references.
  // Populated once in createPanel(); avoids repeated querySelector calls on every
  // showLoading / showError / updatePanel invocation. Entries are GC-eligible when
  // the panel is removed from the document and no other references remain.
  const panelRefs = new WeakMap();

  let retryCallback = null;
  let debugLog = []; // ring buffer of debug entries
  const MAX_LOG = 50;

  function formatCurrency(value) {
    // Guard against NaN/Infinity — can occur if API returns an unexpected type.
    if (!Number.isFinite(value)) return '--';
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

  // Returns STATUS.CREDIT | STATUS.WARNING | STATUS.DEBIT based on projected value.
  // Guards against NaN: NaN comparisons are always false, which would incorrectly
  // return STATUS.CREDIT — fall back to STATUS.DEBIT (conservative safe default).
  function getStatus(projectedCreditDebit) {
    if (!Number.isFinite(projectedCreditDebit)) return STATUS.DEBIT;
    if (projectedCreditDebit < 0) return STATUS.DEBIT;
    if (projectedCreditDebit <= warningThreshold) return STATUS.WARNING;
    return STATUS.CREDIT;
  }

  // Build a DOM element without innerHTML to avoid CSP violations and accidental XSS.
  // attrs: plain attribute key/value pairs; className and textContent set their properties directly.
  function mkEl(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') node.className = v;
      else if (k === 'textContent') node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const child of children) {
      if (child != null) node.appendChild(child);
    }
    return node;
  }

  function createPanel() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'fmc-margin-panel';
    panel.setAttribute('data-fmc-state', PANEL_STATE.LOADING);
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Margin Impact');
    panel.setAttribute('aria-busy', 'true');

    // Panel body — three data columns
    const body = mkEl('div', { className: 'fmc-panel-body' },
      mkEl('div', { className: 'fmc-col', role: 'group', 'aria-labelledby': EL_ID.CREDIT_DEBIT_LABEL },
        mkEl('span', { className: 'fmc-label', id: EL_ID.CREDIT_DEBIT_LABEL, textContent: 'Margin Credit/Debit' }),
        mkEl('span', { className: 'fmc-value', id: EL_ID.CREDIT_DEBIT, 'aria-live': 'polite', 'aria-atomic': 'true', 'aria-labelledby': EL_ID.CREDIT_DEBIT_LABEL, textContent: '--' }),
        mkEl('span', { className: 'fmc-sublabel', id: EL_ID.DELTA, 'aria-live': 'polite', 'aria-atomic': 'true' })
      ),
      mkEl('div', { className: 'fmc-col', role: 'group', 'aria-labelledby': EL_ID.CASH_WITHDRAWABLE_LABEL },
        mkEl('span', { className: 'fmc-label', id: EL_ID.CASH_WITHDRAWABLE_LABEL, textContent: 'Cash Withdrawable' }),
        mkEl('span', { className: 'fmc-value', id: EL_ID.CASH_WITHDRAWABLE, 'aria-live': 'polite', 'aria-atomic': 'true', 'aria-labelledby': EL_ID.CASH_WITHDRAWABLE_LABEL, textContent: '--' }),
        mkEl('span', { className: 'fmc-sublabel', textContent: 'without margin interest' })
      ),
      mkEl('div', { className: 'fmc-col fmc-col-last', role: 'group', 'aria-labelledby': EL_ID.BUYING_POWER_LABEL },
        mkEl('span', { className: 'fmc-label', id: EL_ID.BUYING_POWER_LABEL, textContent: 'Buying Power' }),
        mkEl('span', { className: 'fmc-value', id: EL_ID.BUYING_POWER, 'aria-live': 'polite', 'aria-atomic': 'true', 'aria-labelledby': EL_ID.BUYING_POWER_LABEL, textContent: '--' }),
        mkEl('span', { className: 'fmc-sublabel', textContent: 'margin buying power' })
      )
    );

    // Loading indicator
    const loading = mkEl('div', { className: 'fmc-panel-loading', id: EL_ID.LOADING, role: 'status', 'aria-label': 'Calculating margin impact...' },
      mkEl('span', { className: 'fmc-spinner', 'aria-hidden': 'true' }),
      mkEl('span', { textContent: 'Calculating margin impact...' })
    );

    // Error row (hidden until needed)
    const warningIcon = mkEl('span', { className: 'fmc-error-icon', 'aria-hidden': 'true' });
    warningIcon.textContent = '\u26a0'; // ⚠ warning sign
    const errorRow = mkEl('div', {
      className: 'fmc-panel-error', id: EL_ID.ERROR, role: 'alert'
    },
      warningIcon,
      mkEl('span', { className: 'fmc-error-text' }),
      mkEl('button', { type: 'button', className: 'fmc-retry-btn', 'aria-label': 'Retry margin calculation', textContent: 'Retry' }),
      mkEl('button', { type: 'button', className: 'fmc-debug-btn', 'aria-label': 'Show debug log', 'aria-controls': EL_ID.DEBUG_LOG, 'aria-expanded': 'false', textContent: 'Debug' })
    );
    errorRow.style.display = 'none';
    const initialRetryBtn = errorRow.querySelector('.fmc-retry-btn');
    if (initialRetryBtn) initialRetryBtn.style.display = 'none';

    // Debug log (hidden until toggled)
    const debugLogDiv = mkEl('div', { className: 'fmc-debug-log', id: EL_ID.DEBUG_LOG, role: 'log', 'aria-label': 'Debug log' });
    debugLogDiv.style.display = 'none';

    const attribution = mkEl('div', { className: 'fmc-attribution' },
      mkEl('span', { className: 'fmc-ext-badge', 'aria-hidden': 'true', textContent: 'Margin Calc' })
    );

    panel.appendChild(body);
    panel.appendChild(loading);
    panel.appendChild(errorRow);
    panel.appendChild(debugLogDiv);
    panel.appendChild(attribution);

    // Cache inner element references so showLoading/showError/updatePanel
    // do not need to call querySelector on every invocation.
    panelRefs.set(panel, {
      body,
      loading,
      error: errorRow,
      errorText:         errorRow.querySelector('.fmc-error-text'),
      retryBtn:          errorRow.querySelector('.fmc-retry-btn'),
      creditDebit:       body.querySelector(`#${EL_ID.CREDIT_DEBIT}`),
      creditDebitLabel:  body.querySelector(`#${EL_ID.CREDIT_DEBIT_LABEL}`),
      delta:             body.querySelector(`#${EL_ID.DELTA}`),
      cash:              body.querySelector(`#${EL_ID.CASH_WITHDRAWABLE}`),
      buyingPower:       body.querySelector(`#${EL_ID.BUYING_POWER}`)
    });

    // Wire retry button
    const retryBtn = panel.querySelector('.fmc-retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        retryCallback?.();
      });
    }

    // Wire debug button
    const debugBtn = panel.querySelector('.fmc-debug-btn');
    const debugLogEl = panel.querySelector(`#${EL_ID.DEBUG_LOG}`);
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
    return panelRefs.get(panel) ?? { body: null, loading: null, error: null };
  }

  function inject() {
    if (getPanel()) return true;

    const mxregin = document.getElementById('mxregin');
    if (!mxregin) return false;

    // Clear stale log entries from any previous panel so the debug view shows
    // only entries relevant to the current trade ticket session.
    clearDebugLog();

    const panel = createPanel();
    // Append inside ott-max-gain-loss to stay within Angular component boundary.
    // Fall back to mxregin's direct parent, but only if it is an element node
    // (nodeType 1) — prevents accidental injection at document/body level if
    // Fidelity removes the surrounding component wrapper.
    const parent = mxregin.closest('ott-max-gain-loss') ||
      (mxregin.parentNode?.nodeType === Node.ELEMENT_NODE ? mxregin.parentNode : null);
    if (!parent) return false;
    try {
      parent.appendChild(panel);
    } catch (e) {
      // Parent may have been removed from DOM by Angular re-render between detection and injection
      console.warn('[FMC] Panel injection failed:', e?.message ?? e);
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
    panel.setAttribute('aria-busy', 'true');
    const { body, loading, error } = getPanelElements(panel);
    if (body) {
      body.style.display = '';
      body.style.opacity = '0.5';
      // Prevent stale aria-live values from being announced while new data loads.
      // aria-busy="true" on the panel suppresses announcements in most screen readers,
      // but aria-hidden here provides an additional safeguard for older AT.
      body.setAttribute('aria-hidden', 'true');
    }
    if (loading) loading.style.display = 'flex';
    if (error) error.style.display = 'none';
  }

  function showError(msg, canRetry) {
    const panel = getPanel();
    if (!panel) return;
    panel.setAttribute('data-fmc-state', PANEL_STATE.ERROR);
    panel.setAttribute('aria-busy', 'false');
    const { body, loading, error, errorText, retryBtn } = getPanelElements(panel);
    if (body) body.style.display = 'none';
    if (loading) loading.style.display = 'none';
    if (error) {
      error.style.display = 'flex';
      if (errorText) errorText.textContent = msg || 'Unknown error';
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
    panel.setAttribute('aria-busy', 'false');

    const { body, loading, error, creditDebit: creditDebitEl, creditDebitLabel, delta: deltaEl, cash: cashEl, buyingPower: bpEl } = getPanelElements(panel);
    if (body) { body.style.display = ''; body.style.opacity = ''; body.removeAttribute('aria-hidden'); }
    if (loading) loading.style.display = 'none';
    if (error) error.style.display = 'none';

    const status = getStatus(impact.projectedCreditDebit);
    panel.setAttribute('data-fmc-status', status);

    // Column 1: Margin Credit/Debit + delta sublabel
    if (creditDebitLabel) {
      creditDebitLabel.textContent = impact.projectedCreditDebit >= 0 ? 'Margin Credit' : 'Margin Debit';
    }
    if (creditDebitEl) {
      creditDebitEl.textContent = formatCurrency(impact.projectedCreditDebit);
      creditDebitEl.className = `fmc-value fmc-status-${status}`;
    }
    if (deltaEl) {
      if (impact.delta !== null) {
        deltaEl.textContent = `${formatDelta(impact.delta)} from current`;
        deltaEl.className = ['fmc-sublabel',
          impact.delta < 0 ? 'fmc-negative' : impact.delta > 0 ? 'fmc-positive' : null
        ].filter(Boolean).join(' ');
      } else {
        deltaEl.textContent = 'projected with trade';
        deltaEl.className = 'fmc-sublabel';
      }
    }

    // Column 2: Cash Withdrawable
    if (cashEl) {
      cashEl.textContent = formatCurrency(impact.cashWithdrawable);
      cashEl.className = `fmc-value ${impact.cashWithdrawable > 0 ? `fmc-status-${STATUS.CREDIT}` : 'fmc-neutral'}`;
    }

    // Column 3: Buying Power
    if (bpEl) {
      bpEl.textContent = formatCurrency(impact.projectedBuyingPower);
      bpEl.className = `fmc-value ${impact.projectedBuyingPower > 0 ? `fmc-status-${STATUS.CREDIT}` : `fmc-status-${STATUS.DEBIT}`}`;
    }
  }

  function addDebugLog(entry) {
    const ts = new Date().toLocaleTimeString();
    debugLog.push(`[${ts}] ${entry}`);
    if (debugLog.length > MAX_LOG) debugLog.shift();
    // Update visible log if open
    const logEl = document.getElementById(EL_ID.DEBUG_LOG);
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
