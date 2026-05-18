// TradeDetector — detects trade ticket presence and extracts trade parameters
// Supports: options (single + multi-leg) and equity tickets, popup + dedicated page
const TradeDetector = (() => {
  const warn = makeWarnLog('[FMC-DET]');

  // Page context identifiers returned by detectPageContext()
  const CTX = Object.freeze({
    POPUP_OPTIONS: 'popup-options',
    POPUP_EQUITY: 'popup-equity',
    DEDICATED_OPTIONS: 'dedicated-options'
  });

  // DOM element IDs and selectors for Fidelity's trade ticket UI.
  // Centralised here so a Fidelity page-layout change only requires edits in one place.
  const DOM = Object.freeze({
    TRADE_SHELL:          'trade-container-shell',
    FLOAT_OPTIONS:        'float_trade_O',
    FLOAT_EQUITY:         'float_trade_SE',
    EQUITY_CONTAINER:     '#float_trade_SE',
    DEDICATED_BODY_CLASS: 'option-trade-ticket',

    // Options ticket — account
    OPT_ACCOUNT:          'ott-account-dropdown .binding-val .accountNum',

    // Options ticket — order form fields
    OPT_SYMBOL:           '#symbol_search',
    OPT_LIMIT_PRICE:      '#dest-limitPrice',
    OPT_ORDER_TYPE:       '#ordertype-dropdown .binding-val',
    OPT_TRADE_TYPE:       '#tradeType_dropdown .binding-val',

    // Equity ticket — account (relative selectors; prepend EQUITY_CONTAINER)
    EQ_ACCOUNT_LABEL:     '.selected-account-dropdown-label',
    EQ_ACCOUNT_DD:        '#dest-acct-dropdown',

    // Equity ticket — order form fields (relative selectors; prepend EQUITY_CONTAINER)
    EQ_SYMBOL:            '#eq-ticket-dest-symbol',
    EQ_ACTION_PRIMARY:    '#dest-dropdownlist-button-action .selected-dropdown-item',
    EQ_ACTION_FALLBACK:   '#selected-dropdown-itemaction',
    EQ_QTY:               '#eqt-shared-quantity',
    EQ_ORDER_TYPE_PRIMARY: '#dest-dropdownlist-button-ordertype .selected-dropdown-item',
    EQ_ORDER_TYPE_FALLBACK: '#selected-dropdown-itemordertype',
    EQ_LIMIT_PRIMARY:     '#eqt-shared-limit-price',
    EQ_LIMIT_FALLBACK:    '#dest-limitPrice',

    // Per-leg selectors — append '-{legIndex}' (or '-{legIndex} .binding-val') to get full selector
    LEG_ROW_PREFIX:       'leg-row',
    LEG_CALL_PREFIX:      'call-put',
    LEG_ACTION_SEL_BASE:  '#action_dropdown',
    LEG_QTY_SEL_BASE:     '#quantity',
    LEG_EXP_SEL_BASE:     '#exp_dropdown',
    LEG_STRIKE_SEL_BASE:  '#strike_dropdown'
  });

  // Order type codes sent to the margin calculator API
  const ORDER_TYPE = Object.freeze({
    OPTIONS: 'O',
    EQUITY: 'E'
  });

  const ACTION_MAP = Object.freeze({
    'Buy To Open': 'BO',
    'Sell To Open': 'SO',
    'Buy To Close': 'BC',
    'Sell To Close': 'SC',
    'Buy': 'B',
    'Sell': 'S',
    'Sell Short': 'SS',
    'Buy to Cover': 'BC',   // lowercase 'to' — kept for backward compat
    'Buy To Cover': 'BC'    // Title Case variant — Fidelity may display either form
  });

  const MONTH_MAP = Object.freeze({
    'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
    'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
    'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
  });

  // --- Page context detection ---

  // Returns true if an element has a non-hidden inline display style.
  // Fidelity's Angular popup uses JS to set style.display directly; checking
  // for 'block' only would break if they switch to 'flex' or 'inline-block'.
  function isInlineVisible(el) {
    if (!el) return false;
    const d = el.style.display;
    return d !== '' && d !== 'none';
  }

  // Returns 'popup-options' | 'popup-equity' | 'dedicated-options' | null
  function detectPageContext() {
    // Dedicated options page (full page, no popup shell)
    if (document.body?.classList.contains(DOM.DEDICATED_BODY_CLASS)) {
      return CTX.DEDICATED_OPTIONS;
    }
    // Floating popup
    const shell = document.getElementById(DOM.TRADE_SHELL);
    if (isInlineVisible(shell)) {
      const optDiv = document.getElementById(DOM.FLOAT_OPTIONS);
      if (isInlineVisible(optDiv)) return CTX.POPUP_OPTIONS;
      const eqDiv = document.getElementById(DOM.FLOAT_EQUITY);
      if (isInlineVisible(eqDiv)) return CTX.POPUP_EQUITY;
    }
    return null;
  }

  function isTradeTicketVisible() {
    return detectPageContext() !== null;
  }

  function isOptionsTicket() {
    const ctx = detectPageContext();
    return ctx === CTX.POPUP_OPTIONS || ctx === CTX.DEDICATED_OPTIONS;
  }

  function isEquityTicket() {
    return detectPageContext() === CTX.POPUP_EQUITY;
  }

  // --- Helpers ---

  function getDropdownValue(selector) {
    return document.querySelector(selector)?.textContent.trim() ?? '';
  }

  function getInputValue(selector) {
    return document.querySelector(selector)?.value.trim() ?? '';
  }

  // --- Account number ---

  // ctx: optional pre-computed detectPageContext() result to avoid redundant DOM reads
  function getAccountNumber(ctx = detectPageContext()) {
    if (ctx === CTX.POPUP_EQUITY) {
      return getEquityAccountNumber();
    }
    // Options ticket (popup or dedicated) — same selector
    const el = document.querySelector(DOM.OPT_ACCOUNT);
    if (!el) return null;
    return el.textContent.trim().replace(/[()]/g, '').trim();
  }

  function getEquityAccountNumber() {
    // Try primary selector first, fall back to secondary
    const el = document.querySelector(DOM.EQUITY_CONTAINER + ' ' + DOM.EQ_ACCOUNT_LABEL) ||
               document.querySelector(DOM.EQUITY_CONTAINER + ' ' + DOM.EQ_ACCOUNT_DD);
    if (!el) return null;
    // Match the LAST parenthetical to avoid picking up account type labels
    // that Fidelity sometimes prefixes, e.g. "Individual (non-retirement) (X12345678)".
    const matches = [...el.textContent.matchAll(/\(([^)]+)\)/g)];
    return matches.length ? matches[matches.length - 1][1].trim() : null;
  }

  // --- Call/Put for leg N ---

  function getCallPut(legIndex) {
    const callRadio = document.getElementById(`${DOM.LEG_CALL_PREFIX}-${legIndex}-call`);
    if (callRadio?.getAttribute('aria-checked') === 'true' || callRadio?.checked) return 'C';
    const putRadio = document.getElementById(`${DOM.LEG_CALL_PREFIX}-${legIndex}-put`);
    if (putRadio?.getAttribute('aria-checked') === 'true' || putRadio?.checked) return 'P';
    return '';
  }

  // --- Expiration / Strike parsing ---

  // "May 22, 2026" -> "260522"
  function parseExpiration(expStr) {
    if (!expStr) return '';
    const match = expStr.match(/(\w+)\s+(\d+),\s+(\d{4})/);
    if (!match) return '';
    const [, month, day, year] = match;
    const mm = MONTH_MAP[month];
    if (!mm) {
      warn('Unrecognized month abbreviation in expiration — Fidelity may have changed format: ' + expStr);
      return '';
    }
    const yy = year.slice(2);
    const dd = day.padStart(2, '0');
    return yy + mm + dd;
  }

  // "370.00" -> "370", "16.50" -> "16.5", "1,234.00" -> "1234"
  // Strips thousand-separator commas before parsing — Fidelity may display high-priced
  // strikes (e.g. AMZN, BRK) with commas, which would cause parseFloat to truncate.
  function formatStrike(strikeStr) {
    if (!strikeStr) return '';
    const num = parseFloat(strikeStr.replace(/,/g, ''));
    if (Number.isNaN(num)) return '';
    return num.toString();
  }

  // Builds option symbol: -AVGO260522P370
  function buildOrderSymbol(symbol, expiration, callPut, strike) {
    if (!symbol || !expiration || !callPut || !strike) return '';
    const expCode = parseExpiration(expiration);
    const strikeCode = formatStrike(strike);
    if (!expCode || !strikeCode) return '';
    return `-${symbol}${expCode}${callPut}${strikeCode}`;
  }

  function mapAction(actionText) {
    const mapped = ACTION_MAP[actionText];
    if (!mapped && actionText) {
      warn('Unrecognized trade action — Fidelity may have added a new action type: ' + actionText);
    }
    return mapped || '';
  }

  // --- Multi-leg options extraction ---

  const MAX_LEGS = FMC_CONSTANTS.DETECTOR.MAX_LEGS; // Fidelity supports up to 4 legs; 8 is a safe upper bound
  const OBSERVER_THROTTLE_MS = FMC_CONSTANTS.DETECTOR.OBSERVER_THROTTLE_MS; // throttle MutationObserver → check() to reduce DOM queries

  function getLegCount() {
    let count = 0;
    while (count < MAX_LEGS && document.getElementById(`${DOM.LEG_ROW_PREFIX}-${count}`)) {
      count++;
    }
    return Math.max(count, 1); // at least 1 leg even if leg-row-0 missing
  }

  function getLegParams(legIndex) {
    return {
      action: getDropdownValue(`${DOM.LEG_ACTION_SEL_BASE}-${legIndex} .binding-val`),
      quantity: getInputValue(`${DOM.LEG_QTY_SEL_BASE}-${legIndex}`),
      callPut: getCallPut(legIndex),
      expiration: getDropdownValue(`${DOM.LEG_EXP_SEL_BASE}-${legIndex} .binding-val`),
      strike: getDropdownValue(`${DOM.LEG_STRIKE_SEL_BASE}-${legIndex} .binding-val`)
    };
  }

  function isLegComplete(leg) {
    const qty = parseFloat(leg.quantity);
    return !!(leg.action && Number.isFinite(qty) && qty > 0 && leg.callPut && leg.expiration && leg.strike);
  }

  // --- Options trade params (all legs) ---

  function getOptionsTradeParams() {
    const symbol = getInputValue(DOM.OPT_SYMBOL).toUpperCase();
    const limitPrice = getInputValue(DOM.OPT_LIMIT_PRICE);
    const orderType = getDropdownValue(DOM.OPT_ORDER_TYPE);
    const tradeType = getDropdownValue(DOM.OPT_TRADE_TYPE);
    const legCount = getLegCount();

    const legs = [];
    for (let i = 0; i < legCount; i++) {
      const leg = getLegParams(i);
      leg.legIndex = i;
      legs.push(leg);
    }

    return { symbol, limitPrice, orderType, tradeType, legs };
  }

  // --- Equity trade params ---

  function getEquityTradeParams() {
    const c = DOM.EQUITY_CONTAINER;
    const symbol = getInputValue(`${c} ${DOM.EQ_SYMBOL}`);
    const action = getDropdownValue(`${c} ${DOM.EQ_ACTION_PRIMARY}`) ||
                   getDropdownValue(`${c} ${DOM.EQ_ACTION_FALLBACK}`);
    const quantity = getInputValue(`${c} ${DOM.EQ_QTY}`);
    const orderType = getDropdownValue(`${c} ${DOM.EQ_ORDER_TYPE_PRIMARY}`) ||
                      getDropdownValue(`${c} ${DOM.EQ_ORDER_TYPE_FALLBACK}`);
    const limitPrice = getInputValue(`${c} ${DOM.EQ_LIMIT_PRIMARY}`) ||
                       getInputValue(`${c} ${DOM.EQ_LIMIT_FALLBACK}`);

    return {
      symbol: symbol.toUpperCase(),
      action,
      quantity,
      orderType,
      limitPrice
    };
  }

  // --- Unified getTradeParams ---

  // ctx: optional pre-computed detectPageContext() result to avoid redundant DOM reads
  function getTradeParams(ctx = detectPageContext()) {
    if (ctx === CTX.POPUP_EQUITY) return getEquityTradeParams();
    if (ctx === CTX.POPUP_OPTIONS || ctx === CTX.DEDICATED_OPTIONS) return getOptionsTradeParams();
    return null;
  }

  // --- Build API orders ---

  // ctx: optional pre-computed detectPageContext() result to avoid redundant DOM reads
  function buildOrders(ctx = detectPageContext()) {
    if (ctx === CTX.POPUP_EQUITY) return buildEquityOrders();
    return buildOptionsOrders();
  }

  function buildOptionsOrders() {
    const params = getOptionsTradeParams();
    const price = parseFloat(params.limitPrice.replace(/,/g, ''));
    if (Number.isNaN(price)) {
      // Only warn when the symbol is already set — unparseable price with a symbol present
      // likely means a limit price selector stopped matching after a Fidelity page update.
      if (params.symbol) {
        warn('Limit price is unparseable — selector may have changed: ' + params.limitPrice);
      }
      return [];
    }

    const orders = [];
    for (const leg of params.legs) {
      const orderAction = mapAction(leg.action);
      // Use Math.round(parseFloat(...)) to match buildEquityOrders: consistent rounding
      // vs parseInt, which would silently truncate fractional inputs.
      const qty = Math.round(parseFloat(leg.quantity));
      if (!orderAction || !Number.isFinite(qty) || qty <= 0) continue;

      const orderSymbol = buildOrderSymbol(
        params.symbol, leg.expiration, leg.callPut, leg.strike
      );
      if (!orderSymbol) continue;

      orders.push({
        orderSymbol,
        orderType: ORDER_TYPE.OPTIONS,
        orderAction,
        orderQty: qty,
        price
      });
    }
    return orders;
  }

  function buildEquityOrders() {
    const params = getEquityTradeParams();
    const orderAction = mapAction(params.action);
    // Use Math.round to match the parseFloat-based completeness check in hasRequiredFields;
    // parseInt would silently truncate fractional quantities (e.g. 1.9 → 1), while
    // rounding is more accurate and consistent with what the user entered.
    const qty = Math.round(parseFloat(params.quantity));
    const price = parseFloat((params.limitPrice || '').replace(/,/g, ''));

    if (!orderAction || !Number.isFinite(qty) || qty <= 0 || !params.symbol) return [];
    // Market orders may not have a price — use 0.
    // Limit orders should always have a numeric price at this point because hasRequiredFields
    // validates it before buildEquityOrders is called, but warn defensively just in case.
    if (!Number.isFinite(price) && params.symbol) {
      const isLimit = params.orderType && params.orderType.toLowerCase().includes('limit');
      if (isLimit) {
        warn('Limit price is unparseable — selector may have changed: ' + params.limitPrice);
        return [];
      }
    }
    const orderPrice = Number.isFinite(price) ? price : 0;

    return [{
      orderSymbol: params.symbol,
      orderType: ORDER_TYPE.EQUITY,
      orderAction,
      orderQty: qty,
      price: orderPrice
    }];
  }

  // --- Completeness checks ---

  // _ctx: optional pre-computed detectPageContext() result to avoid redundant DOM reads
  function hasRequiredFields(ctx = detectPageContext()) {
    if (!ctx) return false;

    if (ctx === CTX.POPUP_EQUITY) {
      const p = getEquityTradeParams();
      // Limit orders require a parseable price — truthy-only check is insufficient because
      // partially-typed values like "." or "1a" are truthy but parse to NaN, which would
      // cause buildEquityOrders to send price:0 to the margin API, producing wrong results.
      // Mirrors the Number.isFinite guard already present in the options branch below.
      const isLimit = p.orderType && p.orderType.toLowerCase().includes('limit');
      const qty = parseFloat(p.quantity);
      const limitPriceOk = !isLimit ||
        Number.isFinite(parseFloat((p.limitPrice || '').replace(/,/g, '')));
      return !!(p.symbol && p.action && Number.isFinite(qty) && qty > 0 && limitPriceOk);
    }

    // Options — need symbol, a parseable price, and at least one complete leg
    const p = getOptionsTradeParams();
    if (!p.symbol) return false;
    const limitPrice = parseFloat((p.limitPrice || '').replace(/,/g, ''));
    if (!Number.isFinite(limitPrice)) return false;
    return p.legs.some(isLegComplete);
  }

  // --- Fingerprinting for change detection ---

  // ctx: optional pre-computed detectPageContext() result to avoid redundant DOM reads
  function getParamsFingerprint(ctx = detectPageContext()) {
    if (!ctx) return '';

    if (ctx === CTX.POPUP_EQUITY) {
      const p = getEquityTradeParams();
      return `EQ|${p.symbol}|${p.action}|${p.quantity}|${p.orderType}|${p.limitPrice}`;
    }

    const p = getOptionsTradeParams();
    const legParts = p.legs.map(l =>
      `${l.action}:${l.quantity}:${l.callPut}:${l.expiration}:${l.strike}`
    ).join('|');
    return `OPT|${p.symbol}|${legParts}|${p.limitPrice}`;
  }

  // --- Input listener ID helpers ---
  // Derived once from DOM constants so observe() re-calls do not recompute them.
  // selectorId strips the leading '#' from a CSS ID selector (e.g. '#foo' -> 'foo').
  // Using a guard so a future refactor that drops the '#' prefix produces an obvious
  // error rather than silently matching nothing.
  function selectorId(sel) { return sel.startsWith('#') ? sel.slice(1) : sel; }
  const OPT_LIMIT_ID = selectorId(DOM.OPT_LIMIT_PRICE);   // 'dest-limitPrice'
  const OPT_SYM_ID   = selectorId(DOM.OPT_SYMBOL);         // 'symbol_search'
  const EQ_SYM_ID    = selectorId(DOM.EQ_SYMBOL);          // 'eq-ticket-dest-symbol'
  const EQ_QTY_ID    = selectorId(DOM.EQ_QTY);             // 'eqt-shared-quantity'
  const EQ_LIMIT_ID  = selectorId(DOM.EQ_LIMIT_PRIMARY);   // 'eqt-shared-limit-price'
  const LEG_QTY_BASE = selectorId(DOM.LEG_QTY_SEL_BASE);  // 'quantity' (quantity-{i})
  const legQtyRe     = new RegExp(`^${LEG_QTY_BASE}-\\d+$`);

  // --- Observer ---

  let observer = null;
  let debounceTimer = null;
  let inputListener = null;
  let throttleTimer = null;

  /**
   * Starts observing the Fidelity trade ticket DOM for changes and calls callback
   * with a typed event whenever the form state changes.
   * Re-calling replaces the previous observer and cancels any pending debounce.
   * @param {(event: {
   *   type: 'ready' | 'incomplete' | 'closed',
   *   context?: string,
   *   accountNum?: string | null,
   *   orders?: Array<{orderSymbol: string, orderType: string, orderAction: string,
   *     orderQty: number, price: number}>
   * }) => void} callback - Called when form state changes. 'ready' includes accountNum and orders.
   * @param {number} [debounceMs=500] - Delay in ms before firing 'ready' after last detected change.
   */
  function observe(callback, debounceMs = FMC_CONSTANTS.DEFAULT_SETTINGS.debounceMs) {
    if (observer) observer.disconnect();
    // Cancel any pending debounce from a previous observe() call so the old
    // callback cannot fire after the observer is replaced.
    clearTimeout(debounceTimer);
    debounceTimer = null;
    clearTimeout(throttleTimer);
    throttleTimer = null;
    // Remove previous input listener to avoid stacking listeners across re-init
    if (inputListener) {
      document.removeEventListener('input', inputListener, true);
      inputListener = null;
    }

    let lastFingerprint = '';
    let lastEventType = '';

    function check() {
      const ctx = detectPageContext();
      if (!ctx) {
        // Clear fingerprint so same params re-trigger 'ready' after ticket reopens
        lastFingerprint = '';
        // Cancel any pending debounced 'ready' callback — it must not fire after the
        // ticket closes, as the injection target will be gone and handleTradeReady
        // would attempt work with a stale requestId.
        clearTimeout(debounceTimer);
        debounceTimer = null;
        if (lastEventType !== 'closed') {
          lastEventType = 'closed';
          try { callback({ type: 'closed' }); } catch (e) { console.error('[FMC] observer callback error:', e); }
        }
        return;
      }

      if (!hasRequiredFields(ctx)) {
        // Cancel pending 'ready' debounce — form is no longer complete.
        clearTimeout(debounceTimer);
        debounceTimer = null;
        // Reset fingerprint so that if the user restores the form to the exact
        // same state, the equality check below doesn't suppress the new 'ready'
        // event and the calculation re-fires correctly.
        lastFingerprint = '';
        if (lastEventType !== 'incomplete') {
          lastEventType = 'incomplete';
          try { callback({ type: 'incomplete' }); } catch (e) { console.error('[FMC] observer callback error:', e); }
        }
        return;
      }

      const fp = getParamsFingerprint(ctx);
      if (fp === lastFingerprint) return;
      lastFingerprint = fp;
      lastEventType = 'ready';

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        // Re-check context inside the callback: if the trade ticket was closed or
        // its type changed during the debounce window without producing a mutation
        // (e.g. a rapid open/close cycle), skip the stale event.  A fresh check()
        // will be triggered by the next mutation to handle the new state.
        const currentCtx = detectPageContext();
        if (currentCtx !== ctx) return;
        try {
          callback({
            type: 'ready',
            context: ctx,
            accountNum: getAccountNumber(ctx),
            orders: buildOrders(ctx)
          });
        } catch (e) { console.error('[FMC] observer callback error:', e); }
      }, debounceMs);
    }

    if (!document.body) {
      console.warn('[FMC-DET] observe() called before document.body is available — no observers set up');
      return;
    }

    // Shared throttle: schedule a check() at most once per OBSERVER_THROTTLE_MS window.
    // Used by both the MutationObserver and the input listener so the throttle is shared
    // rather than duplicated — a mutation and an input event arriving in the same window
    // still only produce one check() call.
    function scheduleCheck() {
      if (throttleTimer) return;
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        check();
      }, OBSERVER_THROTTLE_MS);
    }

    // Throttle MutationObserver callbacks: Fidelity is an Angular SPA that
    // produces hundreds of mutations per second during navigation and rendering.
    // Running check() on every mutation wastes CPU — OBSERVER_THROTTLE_MS throttle
    // keeps the UI responsive while avoiding redundant DOM queries between mutations.
    observer = new MutationObserver(scheduleCheck);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'aria-checked', 'class']
    });

    // Listen for input events on trade fields (options + equity).
    // Route through the same throttle as MutationObserver so that rapid typing
    // (e.g. typing a quantity or limit price) doesn't fire multiple redundant
    // check() calls within a single 50ms window. The debounce inside check()
    // still guards the actual API call regardless.
    inputListener = (e) => {
      const id = e.target?.id ?? '';
      if (legQtyRe.test(id) ||
          id === OPT_LIMIT_ID ||
          id === EQ_QTY_ID ||
          id === EQ_LIMIT_ID ||
          id === EQ_SYM_ID ||
          id === OPT_SYM_ID) {
        scheduleCheck();
      }
    };
    document.addEventListener('input', inputListener, true);

    // Initial check
    check();
  }

  function disconnect() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (inputListener) {
      document.removeEventListener('input', inputListener, true);
      inputListener = null;
    }
    clearTimeout(debounceTimer);
    debounceTimer = null;
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }

  return {
    detectPageContext,
    isTradeTicketVisible,
    isOptionsTicket,
    isEquityTicket,
    getAccountNumber,
    getTradeParams,
    buildOrders,
    buildOrderSymbol,
    mapAction,
    hasRequiredFields,
    getParamsFingerprint,
    observe,
    disconnect
  };
})();
