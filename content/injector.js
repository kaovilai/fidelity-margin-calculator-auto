// MarginInjector — injects margin impact panel into trade ticket DOM
'use strict';
const MarginInjector = (() => {
  const warn = makeWarnLog('[FMC]');
  const PANEL_ID = 'fmc-margin-panel';
  const DEFAULT_WARNING_THRESHOLD = FMC_CONSTANTS.DEFAULT_SETTINGS.debitWarningThreshold;
  let warningThreshold = DEFAULT_WARNING_THRESHOLD;

  // Panel UI text — sourced from FMC_CONSTANTS so a copy-edit only requires
  // one change in constants.js rather than hunting through this file.
  const PT = FMC_CONSTANTS.PANEL_TEXT;

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
    // Sublabel IDs — used via aria-describedby on the value elements so screen readers
    // announce the contextual hint ("projected with trade" / "+$50 from current",
    // "without margin interest", "margin buying power") alongside the numeric value,
    // providing the same meaning conveyed visually.
    CASH_SUBLABEL:           'fmc-cash-sublabel',
    BUYING_POWER:            'fmc-buying-power',
    BUYING_POWER_LABEL:      'fmc-buying-power-label',
    BUYING_POWER_SUBLABEL:   'fmc-buying-power-sublabel',
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

  /**
   * Hides the debug log element and resets the debug button to its default state.
   * Called from `showLoading()` and `updatePanel()` when transitioning away from the error
   * state — the Debug button lives inside the hidden error row, so the user would have
   * no way to close the log without this reset.
   * @param {HTMLElement|null} logEl - The debug log container element.
   * @param {HTMLElement|null} btnEl - The debug toggle button element.
   */
  function hideDebugLog(logEl, btnEl) {
    if (!logEl || logEl.style.display === 'none') return;
    logEl.style.display = 'none';
    if (btnEl) {
      btnEl.textContent = PT.DEBUG_BTN_SHOW;
      btnEl.setAttribute('aria-label', PT.DEBUG_ARIA_SHOW);
      btnEl.setAttribute('aria-expanded', 'false');
    }
  }

  let retryCallback = null;
  const debugLog = []; // ring buffer of debug entries
  const MAX_LOG = FMC_CONSTANTS.MAX_DEBUG_LOG_ENTRIES;
  const MAX_LOG_ENTRY_LEN = FMC_CONSTANTS.MAX_LOG_ENTRY_LEN;

  // Cached Intl formatter instances — constructed once per content script load.
  // Reusing formatter objects avoids allocating a new options struct on every call
  // and is the approach recommended by MDN for code that formats values frequently.
  const _currencyFormatter = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  // timeStyle:'medium' requests h:mm:ss display, matching toLocaleTimeString() defaults.
  const _timeFormatter = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });

  /**
   * Shows the debug log element, populates it with the current log entries, and
   * updates the debug button to its "hide" state.
   * Symmetric counterpart to `hideDebugLog` — used by the debug button click handler
   * so the toggle logic is defined in one place and not duplicated inline.
   * @param {HTMLElement|null} logEl - The debug log container element.
   * @param {HTMLElement|null} btnEl - The debug toggle button element.
   */
  function showDebugLog(logEl, btnEl) {
    if (!logEl) return;
    logEl.textContent = debugLog.join('\n') || '(no log entries)';
    logEl.style.display = 'block';
    // Scroll to newest entry (bottom) so the user sees the most recent log lines
    // without having to manually scroll — matches the behaviour of standard log viewers.
    logEl.scrollTop = logEl.scrollHeight;
    if (btnEl) {
      btnEl.textContent = PT.DEBUG_BTN_HIDE;
      btnEl.setAttribute('aria-label', PT.DEBUG_ARIA_HIDE);
      btnEl.setAttribute('aria-expanded', 'true');
    }
  }

  /**
   * Formats a dollar amount for display in the panel.
   * Negative values are prefixed with `-$`; positive with `$`.
   * Non-finite values (NaN, Infinity) return `'--'`.
   * @param {number} value - Dollar amount to format.
   * @returns {string} Formatted currency string (e.g. `'$1,234.56'`, `'-$50.00'`, `'--'`).
   */
  function formatCurrency(value) {
    // Guard against NaN/Infinity — can occur if API returns an unexpected type.
    if (!Number.isFinite(value)) return '--';
    const abs = Math.abs(value);
    const formatted = `$${_currencyFormatter.format(abs)}`;
    return value < 0 ? `-${formatted}` : formatted;
  }

  /**
   * Formats a delta (change) value for display, prefixing positive values with `+`.
   * Delegates to `formatCurrency` for the numeric formatting.
   * @param {number} value - Delta amount in dollars.
   * @returns {string} Formatted delta string (e.g. `'+$50.00'`, `'-$20.00'`).
   */
  function formatDelta(value) {
    const formatted = formatCurrency(value);
    return value > 0 ? `+${formatted}` : formatted;
  }

  /**
   * Returns the CSS class string for a signed dollar value used in data columns.
   * Positive → `fmc-status-credit`, negative → `fmc-status-debit`, zero → `fmc-neutral`.
   * Used for Cash Withdrawable and Buying Power columns, which use a simple sign-based
   * colour rather than the threshold-aware `getStatus()` used for the primary Credit/Debit column.
   * @param {number} amount - Dollar value to classify.
   * @returns {string} Full className string including the base `fmc-value` class.
   */
  function signClass(amount) {
    return `fmc-value ${
      amount > 0 ? `fmc-status-${STATUS.CREDIT}` :
      amount < 0 ? `fmc-status-${STATUS.DEBIT}` :
      CSS.NEUTRAL
    }`;
  }

  /**
   * Determines the display status for a projected margin credit/debit value.
   * Non-finite values (NaN, Infinity) are treated as DEBIT — the conservative safe default.
   * @param {number} projectedCreditDebit - Projected margin credit (positive) or debit (negative).
   * @returns {'credit'|'warning'|'debit'} One of the `STATUS` constants.
   */
  function getStatus(projectedCreditDebit) {
    if (!Number.isFinite(projectedCreditDebit) || projectedCreditDebit < 0) return STATUS.DEBIT;
    if (projectedCreditDebit <= warningThreshold) return STATUS.WARNING;
    return STATUS.CREDIT;
  }

  /**
   * Creates a DOM element without using `innerHTML`, avoiding CSP violations and XSS.
   * The special keys `'className'` and `'textContent'` set their respective properties
   * directly; all other keys are set as attributes via `setAttribute`.
   * @param {string} tag - HTML tag name (e.g. `'div'`, `'span'`, `'button'`).
   * @param {Object} [attrs={}] - Attribute key/value pairs (plus `className`/`textContent`).
   * @param {...(HTMLElement|null|undefined)} children - Child elements to append (nullish skipped).
   * @returns {HTMLElement} The newly created element.
   */
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

  /**
   * Creates the margin panel DOM element with all sub-elements and wires up the
   * retry and debug button event handlers.
   * Caches inner element references in `panelRefs` to avoid repeated querySelector calls
   * in `showLoading`, `showError`, `updatePanel`, and `addDebugLog`.
   * @returns {HTMLDivElement} The fully constructed, detached panel element.
   */
  function createPanel() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'fmc-margin-panel';
    panel.setAttribute('data-fmc-state', PANEL_STATE.LOADING);
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', PT.PANEL_ARIA_LABEL);
    panel.setAttribute('aria-busy', 'true');

    // Panel body — three data columns — capture value element references directly
    // so panelRefs can use them without a second querySelector pass over the DOM.
    const creditDebitLabelEl = mkEl('span', { className: 'fmc-label', id: EL_ID.CREDIT_DEBIT_LABEL, textContent: PT.CREDIT_DEBIT_INITIAL });
    const creditDebitEl = mkEl('span', { className: 'fmc-value', id: EL_ID.CREDIT_DEBIT, 'aria-live': 'polite', 'aria-atomic': 'true', 'aria-labelledby': EL_ID.CREDIT_DEBIT_LABEL, 'aria-describedby': EL_ID.DELTA, textContent: '--' });
    const deltaEl = mkEl('span', { className: 'fmc-sublabel', id: EL_ID.DELTA });
    const cashEl = mkEl('span', { className: 'fmc-value', id: EL_ID.CASH_WITHDRAWABLE, 'aria-live': 'polite', 'aria-atomic': 'true', 'aria-labelledby': EL_ID.CASH_WITHDRAWABLE_LABEL, 'aria-describedby': EL_ID.CASH_SUBLABEL, textContent: '--' });
    const buyingPowerEl = mkEl('span', { className: 'fmc-value', id: EL_ID.BUYING_POWER, 'aria-live': 'polite', 'aria-atomic': 'true', 'aria-labelledby': EL_ID.BUYING_POWER_LABEL, 'aria-describedby': EL_ID.BUYING_POWER_SUBLABEL, textContent: '--' });
    const body = mkEl('div', { className: 'fmc-panel-body' },
      mkEl('div', { className: 'fmc-col', role: 'group', 'aria-labelledby': EL_ID.CREDIT_DEBIT_LABEL },
        creditDebitLabelEl,
        creditDebitEl,
        deltaEl
      ),
      mkEl('div', { className: 'fmc-col', role: 'group', 'aria-labelledby': EL_ID.CASH_WITHDRAWABLE_LABEL },
        mkEl('span', { className: 'fmc-label', id: EL_ID.CASH_WITHDRAWABLE_LABEL, textContent: PT.CASH_WITHDRAWABLE }),
        cashEl,
        mkEl('span', { className: 'fmc-sublabel', id: EL_ID.CASH_SUBLABEL, textContent: PT.CASH_SUBLABEL })
      ),
      mkEl('div', { className: 'fmc-col fmc-col-last', role: 'group', 'aria-labelledby': EL_ID.BUYING_POWER_LABEL },
        mkEl('span', { className: 'fmc-label', id: EL_ID.BUYING_POWER_LABEL, textContent: PT.BUYING_POWER }),
        buyingPowerEl,
        mkEl('span', { className: 'fmc-sublabel', id: EL_ID.BUYING_POWER_SUBLABEL, textContent: PT.BUYING_POWER_SUBLABEL })
      )
    );

    // Loading indicator
    const loading = mkEl('div', { className: 'fmc-panel-loading', id: EL_ID.LOADING, role: 'status' },
      mkEl('span', { className: 'fmc-spinner', 'aria-hidden': 'true' }),
      mkEl('span', { textContent: PT.LOADING_TEXT })
    );

    // Error row (hidden until needed) — capture child references directly to avoid
    // redundant querySelector calls later for panelRefs and event-listener wiring.
    const errorTextEl = mkEl('span', { className: 'fmc-error-text', id: EL_ID.ERROR_TEXT });
    const retryBtnEl = mkEl('button', { type: 'button', className: 'fmc-panel-btn fmc-retry-btn', 'aria-label': PT.RETRY_ARIA_LABEL, 'aria-describedby': EL_ID.ERROR_TEXT, textContent: PT.RETRY_BTN });
    const debugBtnEl = mkEl('button', { type: 'button', className: 'fmc-panel-btn fmc-debug-btn', 'aria-label': PT.DEBUG_ARIA_SHOW, 'aria-controls': EL_ID.DEBUG_LOG, 'aria-expanded': 'false', textContent: PT.DEBUG_BTN_SHOW });
    const errorRow = mkEl('div', {
      className: 'fmc-panel-error', id: EL_ID.ERROR, role: 'alert', 'data-fmc-can-retry': 'false'
    },
      mkEl('span', { className: 'fmc-error-icon', 'aria-hidden': 'true', textContent: '\u26a0' }),
      errorTextEl,
      retryBtnEl,
      debugBtnEl
    );
    // retryBtnEl visibility is controlled via data-fmc-can-retry on the error row (see styles.css)
    // rather than inline style, consistent with the CSS-driven panel state approach used throughout.
    // Initial hidden state handled by CSS rule: .fmc-panel-error:not([data-fmc-can-retry="true"]) .fmc-retry-btn

    // Debug log (hidden until toggled).
    // aria-live="off" overrides the implicit aria-live="polite" from role="log":
    // the log content is replaced wholesale via textContent on every update (not appended),
    // so polite announcements would read out the entire log on each API call. Since this is
    // a developer tool opened on demand, users read it manually — no live announcements needed.
    const debugLogDiv = mkEl('div', { className: 'fmc-debug-log', id: EL_ID.DEBUG_LOG, role: 'log', 'aria-live': 'off', 'aria-label': 'Debug log', tabindex: '0' });
    debugLogDiv.style.display = 'none';

    const attribution = mkEl('div', { className: 'fmc-attribution', 'aria-hidden': 'true' },
      mkEl('span', { className: 'fmc-ext-badge', textContent: PT.ATTRIBUTION })
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

    // Wire debug button — delegate to hideDebugLog / showDebugLog so the toggle
    // logic is defined in one place; the click handler just decides which direction.
    debugBtnEl.addEventListener('click', () => {
      const visible = debugLogDiv.style.display !== 'none';
      if (visible) {
        hideDebugLog(debugLogDiv, debugBtnEl);
      } else {
        showDebugLog(debugLogDiv, debugBtnEl);
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

  /**
   * Retrieves the cached inner element references for a panel.
   * Returns a complete fallback object with null properties when the panel is not in `panelRefs`
   * (e.g. a panel created outside the normal `createPanel` path, or a stale DOM element
   * found by getElementById whose WeakMap entry has been GC-ed).
   * All properties match the shape stored by `createPanel` so callers can safely destructure
   * any subset without receiving `undefined` — consistent with the null-guard pattern used
   * throughout showLoading, showError, updatePanel, and addDebugLog.
   * @param {HTMLElement} panel - The margin panel element to look up.
   * @returns {Object} Cached element references, or a null-valued fallback of the same shape.
   */
  function getPanelElements(panel) {
    return panelRefs.get(panel) ?? {
      body: null, loading: null, error: null,
      errorText: null, retryBtn: null,
      creditDebit: null, creditDebitLabel: null,
      delta: null, cash: null, buyingPower: null,
      debugLog: null, debugBtn: null
    };
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
    panel?.remove();
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
    // display/opacity of body, loading spinner, and error row are driven by
    // data-fmc-state CSS rules — no inline style manipulation needed here.
    const { body, errorText: errorTextEl, debugLog: debugLogEl, debugBtn: debugBtnEl } = getPanelElements(panel);
    if (body) {
      // Prevent stale aria-live values from being announced while new data loads.
      // aria-busy="true" on the panel suppresses announcements in most screen readers,
      // but aria-hidden here provides an additional safeguard for older AT.
      body.setAttribute('aria-hidden', 'true');
    }
    // Clear stale error text so the role="alert" error row is empty when it next
    // enters the accessibility tree (display:none → flex on showError).  Some ATs
    // announce the element's content at re-entry; leaving old text here causes them
    // to first announce the previous error and then the new one (double-announcement).
    if (errorTextEl) errorTextEl.textContent = '';
    // Hide the debug log if it was left open from a previous error state.
    hideDebugLog(debugLogEl, debugBtnEl);
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
    // display of body, loading spinner, and error row are driven by
    // data-fmc-state CSS rules — no inline style manipulation needed here.
    const { body, error, errorText } = getPanelElements(panel);
    // Hide the body from screen readers in error state: the results area contains
    // stale or empty values (e.g. '--') that would confuse AT when the error alert
    // fires. Mirrors the aria-hidden="true" set by showLoading(); only updatePanel()
    // should expose body content by removing the attribute.
    body?.setAttribute('aria-hidden', 'true');
    if (error) {
      if (errorText) errorText.textContent = msg || 'Unknown error';
      // Toggle retry button visibility via CSS data attribute — consistent with the
      // CSS-driven panel state approach used throughout (data-fmc-state, aria-hidden)
      // rather than mixing in inline display/opacity styles.
      error.setAttribute('data-fmc-can-retry', canRetry ? 'true' : 'false');
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

    // display/opacity of body, loading spinner, and error row are driven by
    // data-fmc-state CSS rules — no inline style manipulation needed here.
    const { body, errorText: errorTextEl, creditDebit: creditDebitEl, creditDebitLabel, delta: deltaEl, cash: cashEl, buyingPower: bpEl, debugLog: debugLogEl, debugBtn: debugBtnEl } = getPanelElements(panel);
    body?.removeAttribute('aria-hidden');
    // Clear stale error text — mirrors the same guard in showLoading(). When the
    // extension later re-enters error state from result state, the role="alert" row
    // must be empty as it enters the accessibility tree to avoid double-announcement.
    if (errorTextEl) errorTextEl.textContent = '';
    // Hide the debug log if it was left open from a previous error state — same
    // rationale as in showLoading(): the Debug button is inside the hidden error row,
    // so the user would have no way to close it after results are displayed.
    hideDebugLog(debugLogEl, debugBtnEl);

    const status = getStatus(impact.projectedCreditDebit);
    panel.setAttribute('data-fmc-status', status);

    // Column 1: Margin Credit/Debit + delta sublabel
    if (creditDebitLabel) {
      creditDebitLabel.textContent = impact.projectedCreditDebit >= 0 ? PT.CREDIT_LABEL : PT.DEBIT_LABEL;
    }
    if (creditDebitEl) {
      creditDebitEl.textContent = formatCurrency(impact.projectedCreditDebit);
      creditDebitEl.className = `fmc-value fmc-status-${status}`;
    }
    if (deltaEl) {
      if (impact.delta !== null) {
        deltaEl.textContent = `${formatDelta(impact.delta)} ${PT.DELTA_SUFFIX}`;
        deltaEl.className = ['fmc-sublabel',
          impact.delta < 0 ? CSS.NEGATIVE : impact.delta > 0 ? CSS.POSITIVE : null
        ].filter(Boolean).join(' ');
      } else {
        deltaEl.textContent = PT.DELTA_NO_BASELINE;
        deltaEl.className = 'fmc-sublabel';
      }
    }

    // Column 2: Cash Withdrawable
    if (cashEl) {
      cashEl.textContent = formatCurrency(impact.cashWithdrawable);
      // Negative cash withdrawable means the account is already over-borrowed (margin interest
      // would accrue even before this trade). Show as DEBIT to alert the user, not neutral.
      cashEl.className = signClass(impact.cashWithdrawable);
    }

    // Column 3: Buying Power
    if (bpEl) {
      bpEl.textContent = formatCurrency(impact.projectedBuyingPower);
      bpEl.className = signClass(impact.projectedBuyingPower);
    }
  }

  /**
   * Appends an entry to the panel's debug log ring buffer and refreshes the
   * visible debug log if it is currently open.
   * @param {string} entry - Log message to append (will be prefixed with a timestamp).
   */
  function addDebugLog(entry) {
    const ts = _timeFormatter.format(new Date());
    const raw = `[${ts}] ${entry}`;
    const truncated = raw.length > MAX_LOG_ENTRY_LEN ? raw.slice(0, MAX_LOG_ENTRY_LEN) + '\u2026' : raw;
    debugLog.push(truncated);
    if (debugLog.length > MAX_LOG) debugLog.shift();
    // Update visible log if open — use panelRefs to avoid a global getElementById
    // call that could theoretically find a detached element from a stale panel.
    const panel = getPanel();
    if (!panel) return;
    const logEl = panelRefs.get(panel)?.debugLog;
    if (logEl && logEl.style.display !== 'none') {
      logEl.textContent = debugLog.join('\n');
      // Keep the view pinned to the newest entries as new log lines arrive.
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  /** Clears all entries from the debug log ring buffer. */
  function clearDebugLog() {
    debugLog.length = 0;
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
