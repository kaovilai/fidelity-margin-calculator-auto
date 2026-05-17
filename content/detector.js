// TradeDetector — detects trade ticket presence and extracts trade parameters
// Supports: options (single + multi-leg) and equity tickets, popup + dedicated page
const TradeDetector = (() => {

  // Page context identifiers returned by detectPageContext()
  const CTX = {
    POPUP_OPTIONS: 'popup-options',
    POPUP_EQUITY: 'popup-equity',
    DEDICATED_OPTIONS: 'dedicated-options'
  };

  // Order type codes sent to the margin calculator API
  const ORDER_TYPE = {
    OPTIONS: 'O',
    EQUITY: 'E'
  };

  const ACTION_MAP = {
    'Buy To Open': 'BO',
    'Sell To Open': 'SO',
    'Buy To Close': 'BC',
    'Sell To Close': 'SC',
    'Buy': 'B',
    'Sell': 'S',
    'Sell Short': 'SS',
    'Buy to Cover': 'BC'
  };

  const MONTH_MAP = {
    'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
    'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
    'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
  };

  // --- Page context detection ---

  // Returns 'popup-options' | 'popup-equity' | 'dedicated-options' | null
  function detectPageContext() {
    // Dedicated options page (full page, no popup shell)
    if (document.body?.classList.contains('option-trade-ticket')) {
      return CTX.DEDICATED_OPTIONS;
    }
    // Floating popup
    const shell = document.getElementById('trade-container-shell');
    if (shell?.style.display === 'block') {
      const optDiv = document.getElementById('float_trade_O');
      if (optDiv?.style.display === 'block') return CTX.POPUP_OPTIONS;
      const eqDiv = document.getElementById('float_trade_SE');
      if (eqDiv?.style.display === 'block') return CTX.POPUP_EQUITY;
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
    const el = document.querySelector(selector);
    if (!el) return '';
    return el.textContent.trim();
  }

  function getInputValue(selector) {
    const el = document.querySelector(selector);
    if (!el) return '';
    return el.value || '';
  }

  // --- Account number ---

  // _ctx: optional pre-computed detectPageContext() result to avoid redundant DOM reads
  function getAccountNumber(_ctx) {
    const ctx = _ctx !== undefined ? _ctx : detectPageContext();
    if (ctx === CTX.POPUP_EQUITY) {
      return getEquityAccountNumber();
    }
    // Options ticket (popup or dedicated) — same selector
    const el = document.querySelector('ott-account-dropdown .binding-val .accountNum');
    if (!el) return null;
    return el.textContent.trim().replace(/[()]/g, '');
  }

  function getEquityAccountNumber() {
    // Try primary selector first, fall back to secondary
    const el = document.querySelector('#float_trade_SE .selected-account-dropdown-label') ||
               document.querySelector('#float_trade_SE #dest-acct-dropdown');
    if (!el) return null;
    const match = el.textContent.match(/\(([A-Z0-9]+)\)/);
    return match ? match[1] : null;
  }

  // --- Call/Put for leg N ---

  function getCallPut(legIndex) {
    const callRadio = document.getElementById(`call-put-${legIndex}-call`);
    if (callRadio?.getAttribute('aria-checked') === 'true') return 'C';
    const putRadio = document.getElementById(`call-put-${legIndex}-put`);
    if (putRadio?.getAttribute('aria-checked') === 'true') return 'P';
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
    if (!mm) return '';
    const yy = year.slice(2);
    const dd = day.padStart(2, '0');
    return yy + mm + dd;
  }

  // "370.00" -> "370", "16.50" -> "16.5"
  function formatStrike(strikeStr) {
    if (!strikeStr) return '';
    const num = parseFloat(strikeStr);
    if (isNaN(num)) return '';
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
    return ACTION_MAP[actionText] || '';
  }

  // --- Multi-leg options extraction ---

  const MAX_LEGS = 8; // Fidelity supports up to 4 legs; 8 is a safe upper bound

  function getLegCount() {
    let count = 0;
    while (count < MAX_LEGS && document.getElementById(`leg-row-${count}`)) {
      count++;
    }
    return Math.max(count, 1); // at least 1 leg even if leg-row-0 missing
  }

  function getLegParams(legIndex) {
    return {
      action: getDropdownValue(`#action_dropdown-${legIndex} .binding-val`),
      quantity: getInputValue(`#quantity-${legIndex}`),
      callPut: getCallPut(legIndex),
      expiration: getDropdownValue(`#exp_dropdown-${legIndex} .binding-val`),
      strike: getDropdownValue(`#strike_dropdown-${legIndex} .binding-val`)
    };
  }

  function isLegComplete(leg) {
    return !!(leg.action && leg.quantity && leg.callPut && leg.expiration && leg.strike);
  }

  // --- Options trade params (all legs) ---

  function getOptionsTradeParams() {
    const symbol = getInputValue('#symbol_search');
    const limitPrice = getInputValue('#dest-limitPrice');
    const orderType = getDropdownValue('#ordertype-dropdown .binding-val');
    const tradeType = getDropdownValue('#tradeType_dropdown .binding-val');
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
    const container = '#float_trade_SE';
    const symbol = getInputValue(`${container} #eq-ticket-dest-symbol`);
    const action = getDropdownValue(`${container} #dest-dropdownlist-button-action .selected-dropdown-item`) ||
                   getDropdownValue(`${container} #selected-dropdown-itemaction`);
    const quantity = getInputValue(`${container} #eqt-shared-quantity`);
    const orderType = getDropdownValue(`${container} #dest-dropdownlist-button-ordertype .selected-dropdown-item`) ||
                      getDropdownValue(`${container} #selected-dropdown-itemordertype`);
    const limitPrice = getInputValue(`${container} #eqt-shared-limit-price`) ||
                       getInputValue(`${container} #dest-limitPrice`);

    return {
      symbol: symbol.toUpperCase(),
      action,
      quantity,
      orderType,
      limitPrice,
      legs: [{ action, quantity }]
    };
  }

  // --- Unified getTradeParams ---

  // _ctx: optional pre-computed detectPageContext() result to avoid redundant DOM reads
  function getTradeParams(_ctx) {
    const ctx = _ctx !== undefined ? _ctx : detectPageContext();
    if (ctx === CTX.POPUP_EQUITY) return getEquityTradeParams();
    if (ctx === CTX.POPUP_OPTIONS || ctx === CTX.DEDICATED_OPTIONS) return getOptionsTradeParams();
    return null;
  }

  // --- Build API orders ---

  // _ctx: optional pre-computed detectPageContext() result to avoid redundant DOM reads
  function buildOrders(_ctx) {
    const ctx = _ctx !== undefined ? _ctx : detectPageContext();
    if (ctx === CTX.POPUP_EQUITY) return buildEquityOrders();
    return buildOptionsOrders();
  }

  function buildOptionsOrders() {
    const params = getOptionsTradeParams();
    const price = parseFloat(params.limitPrice);
    if (isNaN(price)) return [];

    const orders = [];
    for (const leg of params.legs) {
      const orderAction = mapAction(leg.action);
      const qty = parseInt(leg.quantity, 10);
      if (!orderAction || !qty) continue;

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
    const qty = parseInt(params.quantity, 10);
    const price = parseFloat(params.limitPrice);

    if (!orderAction || !qty || !params.symbol) return [];
    // Market orders may not have a price — use 0
    const orderPrice = isNaN(price) ? 0 : price;

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
  function hasRequiredFields(_ctx) {
    const ctx = _ctx !== undefined ? _ctx : detectPageContext();
    if (!ctx) return false;

    if (ctx === CTX.POPUP_EQUITY) {
      const p = getEquityTradeParams();
      return !!(p.symbol && p.action && p.quantity);
    }

    // Options — need symbol, price, and at least one complete leg
    const p = getOptionsTradeParams();
    if (!p.symbol || !p.limitPrice) return false;
    return p.legs.some(isLegComplete);
  }

  // --- Fingerprinting for change detection ---

  // _ctx: optional pre-computed detectPageContext() result to avoid redundant DOM reads
  function getParamsFingerprint(_ctx) {
    const ctx = _ctx !== undefined ? _ctx : detectPageContext();
    if (!ctx) return '';

    if (ctx === CTX.POPUP_EQUITY) {
      const p = getEquityTradeParams();
      return `EQ|${p.symbol}|${p.action}|${p.quantity}|${p.limitPrice}`;
    }

    const p = getOptionsTradeParams();
    const legParts = p.legs.map(l =>
      `${l.action}:${l.quantity}:${l.callPut}:${l.expiration}:${l.strike}`
    ).join('|');
    return `OPT|${p.symbol}|${legParts}|${p.limitPrice}`;
  }

  // --- Observer ---

  let observer = null;
  let debounceTimer = null;
  let inputListener = null;
  let throttleTimer = null; // throttles MutationObserver → check() to reduce DOM queries

  function observe(callback, debounceMs = 500) {
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
        if (lastEventType !== 'closed') {
          lastEventType = 'closed';
          try { callback({ type: 'closed' }); } catch { /* prevent observer from breaking */ }
        }
        return;
      }

      if (!hasRequiredFields(ctx)) {
        if (lastEventType !== 'incomplete') {
          lastEventType = 'incomplete';
          try { callback({ type: 'incomplete' }); } catch { /* prevent observer from breaking */ }
        }
        return;
      }

      const fp = getParamsFingerprint(ctx);
      if (fp === lastFingerprint) return;
      lastFingerprint = fp;
      lastEventType = 'ready';

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        try {
          callback({
            type: 'ready',
            context: ctx,
            accountNum: getAccountNumber(ctx),
            orders: buildOrders(ctx)
          });
        } catch { /* prevent observer from breaking */ }
      }, debounceMs);
    }

    if (!document.body) return;
    // Throttle MutationObserver callbacks: Fidelity is an Angular SPA that
    // produces hundreds of mutations per second during navigation and rendering.
    // Running check() on every mutation wastes CPU — 50ms throttle keeps the UI
    // responsive while avoiding redundant DOM queries between mutations.
    observer = new MutationObserver(() => {
      if (throttleTimer) return;
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        check();
      }, 50);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'aria-checked', 'value', 'class']
    });

    // Listen for input events on trade fields (options + equity)
    inputListener = (e) => {
      const id = e.target?.id ?? '';
      if (id.startsWith('quantity-') ||
          id === 'dest-limitPrice' ||
          id === 'eqt-shared-quantity' ||
          id === 'eqt-shared-limit-price' ||
          id === 'eq-ticket-dest-symbol' ||
          id === 'symbol_search') {
        check();
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
