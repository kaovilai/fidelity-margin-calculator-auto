// MarginInjector — injects margin impact panel into trade ticket DOM
const MarginInjector = (() => {
  const warn = makeWarnLog('[FMC]');
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

  // Dynamically-applied CSS class names — centralised so a rename in styles.css
  // only requires a single edit here rather than hunting through updatePanel.
  const CSS = Object.freeze({
    NEUTRAL:  'fmc-neutral',
    POSITIVE: 'fmc-positive',
    NEGATIVE: 'fmc-negative'
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
    ERROR_TEXT:              'fmc-error-text',
    DEBUG_LOG:               'fmc-debug-log'
  });

  // WeakMap from panel element → cached inner element references.
  // Populated once in createPanel(); avoids repeated querySelector calls on every
  // showLoading / showError / updatePanel invocation. Entries are GC-eligible when
  // the panel is removed from the document and no other references remain.
  const panelRefs = new WeakMap();

  let retryCallback = null;
  let debugLog = []; // ring buffer of debug entries
  const MAX_LOG = FMC_CONSTANTS.MAX_DEBUG_LOG_ENTRIES;

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
  // Guards against NaN/non-finite: both are treated as DEBIT (conservative safe default).
  function getStatus(projectedCreditDebit) {
    if (!Number.isFinite(projectedCreditDebit) || projectedCreditDebit < 0) return STATUS.DEBIT;
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

    // Panel body — three data columns — capture value element references directly
    // so panelRefs can use them without a second querySelector pass over the DOM.
    const creditDebitLabelEl = mkEl('span', { className: 'fmc-label', id: EL_ID.CREDIT_DEBIT_LABEL, textContent: 'Margin Credit/Debit' });
    const creditDebitEl = mkEl('span', { className: 'fmc-value', id: EL_ID.CREDIT_DEBIT, 'aria-live': 'polite', 'aria-atomic': 'true', 'aria-labelledby': EL_ID.CREDIT_DEBIT_LABEL, textContent: '--' });
    const deltaEl = mkEl('span', { className: 'fmc-sublabel', id: EL_ID.DELTA, 'aria-live': 'polite', 'aria-atomic': 'true' });
    const cashEl = mkEl('span', { className: 'fmc-value', id: EL_ID.CASH_WITHDRAWABLE, 'aria-live': 'polite', 'aria-atomic': 'true', 'aria-labelledby': EL_ID.CASH_WITHDRAWABLE_LABEL, textContent: '--' });
    const buyingPowerEl = mkEl('span', { className: 'fmc-value', id: EL_ID.BUYING_POWER, 'aria-live': 'polite', 'aria-atomic': 'true', 'aria-labelledby': EL_ID.BUYING_POWER_LABEL, textContent: '--' });
    const body = mkEl('div', { className: 'fmc-panel-body' },
      mkEl('div', { className: 'fmc-col', role: 'group', 'aria-labelledby': EL_ID.CREDIT_DEBIT_LABEL },
        creditDebitLabelEl,
        creditDebitEl,
        deltaEl
      ),
      mkEl('div', { className: 'fmc-col', role: 'group', 'aria-labelledby': EL_ID.CASH_WITHDRAWABLE_LABEL },
        mkEl('span', { className: 'fmc-label', id: EL_ID.CASH_WITHDRAWABLE_LABEL, textContent: 'Cash Withdrawable' }),
        cashEl,
        mkEl('span', { className: 'fmc-sublabel', textContent: 'without margin interest' })
      ),
      mkEl('div', { className: 'fmc-col fmc-col-last', role: 'group', 'aria-labelledby': EL_ID.BUYING_POWER_LABEL },
        mkEl('span', { className: 'fmc-label', id: EL_ID.BUYING_POWER_LABEL, textContent: 'Buying Power' }),
        buyingPowerEl,
        mkEl('span', { className: 'fmc-sublabel', textContent: 'margin buying power' })
      )
    );

    // Loading indicator
    const loading = mkEl('div', { className: 'fmc-panel-loading', id: EL_ID.LOADING, role: 'status', 'aria-label': 'Calculating margin impact...' },
      mkEl('span', { className: 'fmc-spinner', 'aria-hidden': 'true' }),
      mkEl('span', { textContent: 'Calculating margin impact...' })
    );

    // Error row (hidden until needed) — capture child references directly to avoid
    // redundant querySelector calls later for panelRefs and event-listener wiring.
    const errorTextEl = mkEl('span', { className: 'fmc-error-text', id: EL_ID.ERROR_TEXT });
    const retryBtnEl = mkEl('button', { type: 'button', className: 'fmc-retry-btn', 'aria-label': 'Retry margin calculation', 'aria-describedby': EL_ID.ERROR_TEXT, textContent: 'Retry' });
    const debugBtnEl = mkEl('button', { type: 'button', className: 'fmc-debug-btn', 'aria-label': 'Show debug log', 'aria-controls': EL_ID.DEBUG_LOG, 'aria-expanded': 'false', textContent: 'Debug' });
    const errorRow = mkEl('div', {
      className: 'fmc-panel-error', id: EL_ID.ERROR, role: 'alert'
    },
      mkEl('span', { className: 'fmc-error-icon', 'aria-hidden': 'true', textContent: '\u26a0' }),
      errorTextEl,
      retryBtnEl,
      debugBtnEl
    );
    errorRow.style.display = 'none';
    retryBtnEl.style.display = 'none';

    // Debug log (hidden until toggled)
    const debugLogDiv = mkEl('div', { className: 'fmc-debug-log', id: EL_ID.DEBUG_LOG, role: 'log', 'aria-label': 'Debug log', tabindex: '0' });
    debugLogDiv.style.display = 'none';

    const attribution = mkEl('div', { className: 'fmc-attribution', 'aria-hidden': 'true' },
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
      errorText:         errorTextEl,
      retryBtn:          retryBtnEl,
      creditDebit:       creditDebitEl,
      creditDebitLabel:  creditDebitLabelEl,
      delta:             deltaEl,
      cash:              cashEl,
      buyingPower:       buyingPowerEl,
      debugLog:          debugLogDiv,
      debugBtn:          debugBtnEl
    });

    // Wire retry button
    retryBtnEl.addEventListener('click', () => {
      retryCallback?.();
    });

    // Wire debug button — use debugLogDiv reference already in scope
    debugBtnEl.addEventListener('click', () => {
      const visible = debugLogDiv.style.display !== 'none';
      if (visible) {
        debugLogDiv.style.display = 'none';
        debugBtnEl.textContent = 'Debug';
        debugBtnEl.setAttribute('aria-label', 'Show debug log');
        debugBtnEl.setAttribute('aria-expanded', 'false');
      } else {
        debugLogDiv.textContent = debugLog.join('\n') || '(no log entries)';
        debugLogDiv.style.display = 'block';
        debugBtnEl.textContent = 'Hide';
        debugBtnEl.setAttribute('aria-label', 'Hide debug log');
        debugBtnEl.setAttribute('aria-expanded', 'true');
      }
    });

    return panel;
  }

  /**
   * Returns the currently injected margin panel element, or `null` if not present.
   * @returns {HTMLElement|null}
   */
  function getPanel() {
    return document.getElementById(PANEL_ID);
  }

  function getPanelElements(panel) {
    return panelRefs.get(panel) ?? { body: null, loading: null, error: null };
  }

  /**
   * Injects the margin panel into the trade ticket DOM.
   * Finds the injection target (`#mxregin`) and appends the panel to its
   * nearest Angular component ancestor or direct parent.
   * @returns {boolean} `true` if the panel was successfully injected (or was already present),
   *   `false` if the injection target or its parent could not be found or was detached.
   */
  function inject() {
    if (getPanel()) return true;

    const mxregin = document.getElementById(FMC_CONSTANTS.INJECTION.TARGET_ID);
    if (!mxregin) return false;

    // Clear stale log entries from any previous panel so the debug view shows
    // only entries relevant to the current trade ticket session.
    clearDebugLog();

    const panel = createPanel();
    // Append inside the Angular component wrapper to stay within its boundary.
    // Fall back to mxregin's direct parent, but only if it is an element node
    // (nodeType 1) — prevents accidental injection at document/body level if
    // Fidelity removes the surrounding component wrapper.
    const parent = mxregin.closest(FMC_CONSTANTS.INJECTION.COMPONENT_SELECTOR) ||
      (mxregin.parentNode?.nodeType === Node.ELEMENT_NODE ? mxregin.parentNode : null);
    if (!parent) return false;
    // Guard against Angular removing the injection parent between our getElementById call
    // and the actual append. A detached parent would cause the panel to be inserted into a
    // disconnected subtree, making getPanel() return null and silently losing all results.
    if (!parent.isConnected) {
      warn('Injection parent was detached by Angular re-render — will retry on next mutation');
      return false;
    }
    try {
      parent.appendChild(panel);
    } catch (e) {
      // Parent may have been removed from DOM by Angular re-render between detection and injection
      warn('Panel injection failed:', e?.message ?? e);
      return false;
    }
    // Verify the panel is reachable in the live document — guards against the parent being
    // removed in the narrow window between the isConnected check above and the appendChild call.
    if (!panel.isConnected) {
      warn('Panel was detached immediately after injection — Angular re-rendered during append');
      return false;
    }
    return true;
  }

  /**
   * Removes the margin panel from the DOM.
   * No-op if the panel is not currently present.
   */
  function remove() {
    const panel = getPanel();
    if (panel) panel.remove();
  }

  /**
   * Puts the panel into the loading state: shows the spinner, fades the body,
   * and suppresses live-region announcements until results arrive.
   * No-op if the panel is not currently injected.
   */
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

  /**
   * Puts the panel into the error state and displays a message.
   * No-op if the panel is not currently injected.
   * @param {string} msg - Human-readable error message to display.
   * @param {boolean} canRetry - Whether to show the Retry button.
   */
  function showError(msg, canRetry) {
    const panel = getPanel();
    if (!panel) return;
    panel.setAttribute('data-fmc-state', PANEL_STATE.ERROR);
    panel.setAttribute('aria-busy', 'false');
    const { body, loading, error, errorText, retryBtn } = getPanelElements(panel);
    if (body) { body.style.display = 'none'; body.removeAttribute('aria-hidden'); }
    if (loading) loading.style.display = 'none';
    if (error) {
      error.style.display = 'flex';
      if (errorText) errorText.textContent = msg || 'Unknown error';
      if (retryBtn) retryBtn.style.display = canRetry ? 'inline-block' : 'none';
    }
  }

  /**
   * Registers a callback to invoke when the Retry button is clicked.
   * @param {() => void} fn - Callback to invoke on retry.
   */
  function setRetryCallback(fn) {
    retryCallback = fn;
  }

  /**
   * Updates the panel with calculated margin impact data.
   * Hides the loading indicator and error row, and populates all three data columns.
   * No-op if the panel is not currently injected.
   * @param {{
   *   projectedCreditDebit: number,
   *   delta: number|null,
   *   cashWithdrawable: number,
   *   projectedBuyingPower: number
   * }} impact - Margin impact computed by MarginCalc.computeImpact.
   */
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
          impact.delta < 0 ? CSS.NEGATIVE : impact.delta > 0 ? CSS.POSITIVE : null
        ].filter(Boolean).join(' ');
      } else {
        deltaEl.textContent = 'projected with trade';
        deltaEl.className = 'fmc-sublabel';
      }
    }

    // Column 2: Cash Withdrawable
    if (cashEl) {
      cashEl.textContent = formatCurrency(impact.cashWithdrawable);
      // Negative cash withdrawable means the account is already over-borrowed (margin interest
      // would accrue even before this trade). Show as DEBIT to alert the user, not neutral.
      cashEl.className = `fmc-value ${
        impact.cashWithdrawable > 0 ? `fmc-status-${STATUS.CREDIT}` :
        impact.cashWithdrawable < 0 ? `fmc-status-${STATUS.DEBIT}` :
        CSS.NEUTRAL
      }`;
    }

    // Column 3: Buying Power
    if (bpEl) {
      bpEl.textContent = formatCurrency(impact.projectedBuyingPower);
      bpEl.className = `fmc-value ${impact.projectedBuyingPower > 0 ? `fmc-status-${STATUS.CREDIT}` : `fmc-status-${STATUS.DEBIT}`}`;
    }
  }

  /**
   * Appends an entry to the panel's debug log ring buffer and refreshes the
   * visible debug log if it is currently open.
   * @param {string} entry - Log message to append (will be prefixed with a timestamp).
   */
  function addDebugLog(entry) {
    const ts = new Date().toLocaleTimeString();
    debugLog.push(`[${ts}] ${entry}`);
    if (debugLog.length > MAX_LOG) debugLog.shift();
    // Update visible log if open — use panelRefs to avoid a global getElementById
    // call that could theoretically find a detached element from a stale panel.
    const panel = getPanel();
    if (!panel) return;
    const logEl = panelRefs.get(panel)?.debugLog;
    if (logEl && logEl.style.display !== 'none') {
      logEl.textContent = debugLog.join('\n');
    }
  }

  /** Clears all entries from the debug log ring buffer. */
  function clearDebugLog() {
    debugLog = [];
  }

  /**
   * Sets the margin credit/debit threshold below which the panel shows a warning state.
   * Values at or below the threshold display as WARNING instead of CREDIT.
   * @param {number} val - Threshold in dollars (clamped to ≥0).
   */
  function setWarningThreshold(val) {
    const parsed = Number(val);
    // Clamp to ≥0: a negative threshold would cause debit positions to pass the
    // `projectedCreditDebit <= warningThreshold` check and be shown as STATUS.CREDIT.
    // This mirrors the Math.max(0, ...) guard in popup.js saveSettings().
    warningThreshold = Number.isFinite(parsed)
      ? Math.min(FMC_CONSTANTS.MAX_WARNING_THRESHOLD, Math.max(0, parsed))
      : DEFAULT_WARNING_THRESHOLD;
  }

  return { inject, remove, showLoading, showError, updatePanel, getPanel, setRetryCallback, addDebugLog, clearDebugLog, setWarningThreshold };
})();
