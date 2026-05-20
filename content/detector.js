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

  // Keys are compared case-insensitively in mapAction(), so only one entry per action is needed.
  const ACTION_MAP = Object.freeze({
    'Buy To Open': 'BO',
    'Sell To Open': 'SO',
    'Buy To Close': 'BC',
    'Sell To Close': 'SC',
    'Buy': 'B',
    'Sell': 'S',
    'Sell Short': 'SS',
    'Buy To Cover': 'BC'
  });

  const MONTH_MAP = Object.freeze({
    'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
    'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
    'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
  });

  // Normalized (lowercase) lookup built once from ACTION_MAP.
  const ACTION_MAP_LOWER = Object.fromEntries(
    Object.entries(ACTION_MAP).map(([k, v]) => [k.toLowerCase(), v])
  );

  // --- Shared parsing helpers ---

  /**
   * Parses a price or quantity string that may contain thousands-separator commas.
   * @param {string} str - Input string (e.g. `'1,234.56'`).
   * @returns {number} Parsed float, or `NaN` if not parseable.
   */
  function parsePriceInput(str) {
    return parseFloat((str || '').replace(/,/g, ''));
  }

  /**
   * Returns `true` when the order type string indicates a limit order.
   * @param {string} orderType - Order type label from the trade ticket dropdown.
   * @returns {boolean}
   */
  function isLimitOrderType(orderType) {
    return !!orderType?.toLowerCase().includes('limit');
  }

  /**
   * Returns the numeric order price to send to the margin API.
   * For limit orders with an unparseable price, logs a warning and returns `null` to
   * signal the caller to abort building the order. For non-limit orders (where an
   * empty price field is expected), returns `0`.
   * @param {string} limitPriceStr - Raw limit price string from the ticket input.
   * @param {string} orderType - Order type label from the ticket dropdown.
   * @param {string} symbol - Underlying symbol (used in the warning message).
   * @returns {number|null} Numeric price, `0` for market orders, or `null` to abort.
   */
  function resolveOrderPrice(limitPriceStr, orderType, symbol) {
    const price = parsePriceInput(limitPriceStr);
    if (!Number.isFinite(price)) {
      if (isLimitOrderType(orderType) && symbol) {
        warn(`Limit price is unparseable — selector may have changed: ${limitPriceStr}`);
        return null;
      }
      return 0;
    }
    return price;
  }

  // --- Page context detection ---

  /**
   * Returns `true` if an element has a non-`none` inline `display` style.
   * Fidelity's Angular popup sets `style.display` directly via JS; checking for
   * `'block'` only would break if they switch to `'flex'` or `'inline-block'`.
   * @param {Element|null} el - DOM element to inspect.
   * @returns {boolean}
   */
  function isInlineVisible(el) {
    if (!el) return false;
    const d = el.style.display;
    return d !== '' && d !== 'none';
  }

  /**
   * Detects which trade ticket page context is currently active.
   * @returns {'popup-options'|'popup-equity'|'dedicated-options'|null}
   *   The active context, or `null` if no trade ticket is visible.
   */
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

  /** @returns {boolean} `true` if any supported trade ticket is currently visible. */
  function isTradeTicketVisible() {
    return detectPageContext() !== null;
  }

  /** @returns {boolean} `true` if the visible trade ticket is an options ticket (popup or dedicated page). */
  function isOptionsTicket() {
    const ctx = detectPageContext();
    return ctx === CTX.POPUP_OPTIONS || ctx === CTX.DEDICATED_OPTIONS;
  }

  /** @returns {boolean} `true` if the visible trade ticket is a floating equity ticket. */
  function isEquityTicket() {
    return detectPageContext() === CTX.POPUP_EQUITY;
  }

  // --- Helpers ---

  /**
   * Reads the text content of a Fidelity dropdown binding span.
   * @param {string} selector - CSS selector for the `.binding-val` span.
   * @returns {string} Trimmed text, or `''` if the element is not found.
   */
  function getDropdownValue(selector) {
    return document.querySelector(selector)?.textContent.trim() ?? '';
  }

  /**
   * Reads the trimmed value of a form input element.
   * @param {string} selector - CSS selector for the input.
   * @returns {string} Trimmed value, or `''` if the element is not found.
   */
  function getInputValue(selector) {
    return document.querySelector(selector)?.value.trim() ?? '';
  }

  // --- Account number ---

  /**
   * Reads the brokerage account number from the visible trade ticket.
   * @param {string} [ctx] - Pre-computed page context from `detectPageContext()`.
   *   Pass this to avoid a redundant DOM read when context is already known.
   * @returns {string|null} Account number string, or `null` if not found.
   */
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

  /**
   * Extracts the brokerage account number from the floating equity ticket header.
   * Reads the last parenthetical in the account label to avoid capturing account-type
   * prefixes that Fidelity sometimes includes (e.g. `"Individual (non-retirement) (X12345678)"`).
   * @returns {string|null} Account number, or `null` if no parenthetical is found.
   */
  function getEquityAccountNumber() {
    // Try primary selector first, fall back to secondary
    const el = document.querySelector(`${DOM.EQUITY_CONTAINER} ${DOM.EQ_ACCOUNT_LABEL}`) ||
               document.querySelector(`${DOM.EQUITY_CONTAINER} ${DOM.EQ_ACCOUNT_DD}`);
    if (!el) return null;
    // Match the LAST parenthetical to avoid picking up account type labels
    // that Fidelity sometimes prefixes, e.g. "Individual (non-retirement) (X12345678)".
    const matches = [...el.textContent.matchAll(/\(([^)]+)\)/g)];
    return matches.at(-1)?.[1].trim() ?? null;
  }

  // --- Call/Put for leg N ---

  /**
   * Reads the selected call/put radio value for a given option leg.
   * Checks both `aria-checked` (Angular custom components) and `.checked` (native input).
   * @param {number} legIndex - Zero-based leg index.
   * @returns {'C'|'P'|''} `'C'` for call, `'P'` for put, `''` if neither is selected.
   */
  function getCallPut(legIndex) {
    const callRadio = document.getElementById(`${DOM.LEG_CALL_PREFIX}-${legIndex}-call`);
    if (callRadio?.getAttribute('aria-checked') === 'true' || callRadio?.checked) return 'C';
    const putRadio = document.getElementById(`${DOM.LEG_CALL_PREFIX}-${legIndex}-put`);
    if (putRadio?.getAttribute('aria-checked') === 'true' || putRadio?.checked) return 'P';
    return '';
  }

  // --- Expiration / Strike parsing ---

  /**
   * Converts a Fidelity expiration date string to the API format `YYMMDD`.
   * Example: `'May 22, 2026'` → `'260522'`.
   * Logs a warning and returns `''` if the format is unrecognized.
   * @param {string} expStr - Expiration string as displayed in the trade ticket.
   * @returns {string} Six-character date code, or `''` if parsing fails.
   */
  function parseExpiration(expStr) {
    if (!expStr) return '';
    const match = expStr.match(/(\w+)\s+(\d+),\s+(\d{4})/);
    if (!match) return '';
    const [, month, day, year] = match;
    const mm = MONTH_MAP[month];
    if (!mm) {
      warn(`Unrecognized month abbreviation in expiration — Fidelity may have changed format: ${expStr}`);
      return '';
    }
    const yy = year.slice(2);
    const dd = day.padStart(2, '0');
    return yy + mm + dd;
  }

  /**
   * Strips trailing zeros and thousands-separator commas from a strike price string.
   * Example: `'370.00'` → `'370'`, `'16.50'` → `'16.5'`, `'1,234.00'` → `'1234'`.
   * Commas must be stripped before parsing — high-priced strikes (e.g. AMZN, BRK) may
   * be displayed with commas, which would cause `parseFloat` to truncate the value.
   * @param {string} strikeStr - Strike price string from the ticket dropdown.
   * @returns {string} Normalized strike string, or `''` if not parseable.
   */
  function formatStrike(strikeStr) {
    if (!strikeStr) return '';
    const num = parseFloat(strikeStr.replace(/,/g, ''));
    if (!Number.isFinite(num)) return '';
    return num.toString();
  }

  /**
   * Builds an option order symbol in the format expected by the margin calculator API.
   * Example: `buildOrderSymbol('AVGO', 'May 22, 2026', 'P', '370.00')` → `'-AVGO260522P370'`
   * @param {string} symbol - Underlying ticker symbol (e.g. `'AVGO'`).
   * @param {string} expiration - Expiration date string as displayed by Fidelity (e.g. `'May 22, 2026'`).
   * @param {string} callPut - `'C'` for call, `'P'` for put.
   * @param {string} strike - Strike price string (e.g. `'370.00'` or `'1,234.50'`).
   * @returns {string} Formatted option symbol, or `''` if any component is missing or unparseable.
   */
  function buildOrderSymbol(symbol, expiration, callPut, strike) {
    if (!symbol || !expiration || !callPut || !strike) return '';
    const expCode = parseExpiration(expiration);
    const strikeCode = formatStrike(strike);
    if (!expCode || !strikeCode) return '';
    return `-${symbol}${expCode}${callPut}${strikeCode}`;
  }

  /**
   * Maps a Fidelity trade action label to the margin API action code.
   * @param {string} actionText - Action text as displayed in the trade ticket (e.g. `'Buy To Open'`).
   * @returns {string} API action code (e.g. `'BO'`), or `''` if unrecognized.
   */
  function mapAction(actionText) {
    if (!actionText) return '';
    const mapped = ACTION_MAP_LOWER[actionText.trim().toLowerCase()];
    if (!mapped) {
      warn(`Unrecognized trade action — Fidelity may have added a new action type: ${actionText}`);
    }
    return mapped || '';
  }

  // --- Multi-leg options extraction ---

  const MAX_LEGS = FMC_CONSTANTS.DETECTOR.MAX_LEGS; // Fidelity supports up to 4 legs; 8 is a safe upper bound
  const OBSERVER_THROTTLE_MS = FMC_CONSTANTS.DETECTOR.OBSERVER_THROTTLE_MS; // throttle MutationObserver → check() to reduce DOM queries

  /**
   * Counts the number of active option legs by probing for `leg-row-{i}` elements.
   * Returns at least `1` even if `leg-row-0` is absent (single-leg tickets may not
   * render the row wrapper).
   * @returns {number} Number of active legs (≥ 1).
   */
  function getLegCount() {
    let count = 0;
    while (count < MAX_LEGS && document.getElementById(`${DOM.LEG_ROW_PREFIX}-${count}`)) {
      count++;
    }
    return Math.max(count, 1); // at least 1 leg even if leg-row-0 missing
  }

  /**
   * Returns the raw form values for a single option leg.
   * @param {number} legIndex - Zero-based leg index.
   * @returns {{action: string, quantity: string, callPut: string, expiration: string, strike: string}}
   */
  function getLegParams(legIndex) {
    return {
      action: getDropdownValue(`${DOM.LEG_ACTION_SEL_BASE}-${legIndex} .binding-val`),
      quantity: getInputValue(`${DOM.LEG_QTY_SEL_BASE}-${legIndex}`),
      callPut: getCallPut(legIndex),
      expiration: getDropdownValue(`${DOM.LEG_EXP_SEL_BASE}-${legIndex} .binding-val`),
      strike: getDropdownValue(`${DOM.LEG_STRIKE_SEL_BASE}-${legIndex} .binding-val`)
    };
  }

  /**
   * Returns `true` when all required fields for an option leg are filled in:
   * action, a positive finite quantity, call/put selection, expiration, and strike.
   * @param {{action: string, quantity: string, callPut: string, expiration: string, strike: string}} leg
   * @returns {boolean}
   */
  function isLegComplete(leg) {
    const qty = parsePriceInput(leg.quantity);
    return !!(leg.action && Number.isFinite(qty) && qty > 0 && leg.callPut && leg.expiration && leg.strike);
  }

  // --- Options trade params (all legs) ---

  /**
   * Reads all raw parameters from the options trade ticket for all active legs.
   * @returns {{symbol: string, limitPrice: string, orderType: string,
   *   legs: Array<{action: string, quantity: string, callPut: string, expiration: string, strike: string}>}}
   */
  function getOptionsTradeParams() {
    const symbol = getInputValue(DOM.OPT_SYMBOL).toUpperCase();
    const limitPrice = getInputValue(DOM.OPT_LIMIT_PRICE);
    const orderType = getDropdownValue(DOM.OPT_ORDER_TYPE);
    const legCount = getLegCount();

    const legs = Array.from({ length: legCount }, (_, i) => getLegParams(i));

    return { symbol, limitPrice, orderType, legs };
  }

  // --- Equity trade params ---

  /**
   * Reads all raw parameters from the floating equity trade ticket.
   * Falls back to secondary selectors for action, order type, and limit price fields
   * where Fidelity uses two alternate selector patterns.
   * @returns {{symbol: string, action: string, quantity: string, orderType: string, limitPrice: string}}
   */
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

  /**
   * Returns the raw trade form parameters for the current ticket type.
   * @param {string} [ctx] - Pre-computed page context from `detectPageContext()`.
   * @returns {Object|null} Raw parameters object (shape varies by ticket type), or `null` if no ticket is visible.
   */
  // ctx: optional pre-computed detectPageContext() result to avoid redundant DOM reads
  function getTradeParams(ctx = detectPageContext()) {
    if (ctx === CTX.POPUP_EQUITY) return getEquityTradeParams();
    if (ctx === CTX.POPUP_OPTIONS || ctx === CTX.DEDICATED_OPTIONS) return getOptionsTradeParams();
    return null;
  }

  // --- Build API orders ---

  /**
   * Builds the margin calculator API order array from the current trade ticket form.
   * Returns an empty array if the ticket is not visible or form fields are incomplete.
   * @param {string} [ctx] - Pre-computed page context from `detectPageContext()`.
   * @returns {Array<{orderSymbol: string, orderType: string, orderAction: string,
   *   orderQty: number, price: number}>} Order array (may be empty).
   */
  // ctx: optional pre-computed detectPageContext() result to avoid redundant DOM reads
  function buildOrders(ctx = detectPageContext()) {
    if (!ctx) return [];
    if (ctx === CTX.POPUP_EQUITY) return buildEquityOrders();
    return buildOptionsOrders();
  }

  /**
   * Converts raw options trade parameters to margin API order objects for all complete legs.
   * Skips legs with an unrecognized action, non-positive quantity, or unparseable order symbol.
   * Returns an empty array if the limit price is unparseable for a limit order.
   * @returns {Array<{orderSymbol: string, orderType: string, orderAction: string, orderQty: number, price: number}>}
   */
  function buildOptionsOrders() {
    const params = getOptionsTradeParams();
    const orderPrice = resolveOrderPrice(params.limitPrice, params.orderType, params.symbol);
    if (orderPrice === null) return [];

    return params.legs.flatMap(leg => {
      const orderAction = mapAction(leg.action);
      // Use Math.round(parsePriceInput(...)) to strip thousands-separator commas before
      // parsing — consistent with how prices are parsed and with isLegComplete.
      const qty = Math.round(parsePriceInput(leg.quantity));
      if (!orderAction || !Number.isFinite(qty) || qty <= 0) return [];

      const orderSymbol = buildOrderSymbol(
        params.symbol, leg.expiration, leg.callPut, leg.strike
      );
      if (!orderSymbol) return [];

      return [{ orderSymbol, orderType: ORDER_TYPE.OPTIONS, orderAction, orderQty: qty, price: orderPrice }];
    });
  }

  /**
   * Converts raw equity trade parameters to a single-element margin API order array.
   * Returns an empty array if action, symbol, or quantity is missing/invalid, or if
   * the limit price is unparseable for a limit order.
   * @returns {Array<{orderSymbol: string, orderType: string, orderAction: string, orderQty: number, price: number}>}
   */
  function buildEquityOrders() {
    const params = getEquityTradeParams();
    const orderAction = mapAction(params.action);
    // Use Math.round(parsePriceInput(...)) to strip thousands-separator commas before
    // parsing — consistent with how prices are parsed and with hasRequiredFields.
    // parseInt would silently truncate fractional quantities (e.g. 1.9 → 1), while
    // rounding is more accurate and consistent with what the user entered.
    const qty = Math.round(parsePriceInput(params.quantity));
    if (!orderAction || !Number.isFinite(qty) || qty <= 0 || !params.symbol) return [];

    // Market orders may not have a price — use 0.
    // Limit orders should always have a numeric price at this point because hasRequiredFields
    // validates it before buildEquityOrders is called, but warn defensively just in case.
    const orderPrice = resolveOrderPrice(params.limitPrice, params.orderType, params.symbol);
    if (orderPrice === null) return [];

    return [{
      orderSymbol: params.symbol,
      orderType: ORDER_TYPE.EQUITY,
      orderAction,
      orderQty: qty,
      price: orderPrice
    }];
  }

  // --- Completeness checks ---

  /**
   * Returns `true` when all fields required to build a valid margin API request are filled in.
   * For limit orders, this includes a parseable limit price. For options, at least one
   * complete leg (action, quantity, call/put, expiration, strike) must be present.
   * @param {string} [ctx] - Pre-computed page context from `detectPageContext()`.
   * @param {Object} [params] - Pre-computed trade params from `getTradeParams(ctx)`.
   *   When provided, skips the internal `getTradeParams` DOM read — callers that already
   *   hold the params object should pass it to avoid a redundant DOM traversal.
   * @returns {boolean}
   */
  // _ctx: optional pre-computed detectPageContext() result to avoid redundant DOM reads
  function hasRequiredFields(ctx = detectPageContext(), params) {
    if (!ctx) return false;

    if (ctx === CTX.POPUP_EQUITY) {
      const p = params ?? getEquityTradeParams();
      // Limit orders require a parseable price — truthy-only check is insufficient because
      // partially-typed values like "." or "1a" are truthy but parse to NaN, which would
      // cause buildEquityOrders to send price:0 to the margin API, producing wrong results.
      // Mirrors the Number.isFinite guard already present in the options branch below.
      // Use parsePriceInput to strip commas consistently with buildEquityOrders.
      const qty = parsePriceInput(p.quantity);
      const limitPriceOk = !isLimitOrderType(p.orderType) ||
        Number.isFinite(parsePriceInput(p.limitPrice));
      return !!(p.symbol && p.action && Number.isFinite(qty) && qty > 0 && limitPriceOk);
    }

    // Options — need symbol, at least one complete leg, and for limit orders a parseable price.
    // Market orders intentionally have no limit price; they should still trigger a calculation.
    const p = params ?? getOptionsTradeParams();
    if (!p.symbol) return false;
    if (isLimitOrderType(p.orderType) && !Number.isFinite(parsePriceInput(p.limitPrice))) return false;
    return p.legs.some(isLegComplete);
  }

  // --- Fingerprinting for change detection ---

  /**
   * Returns a stable string fingerprint of the current trade form state.
   * Used to detect changes between `MutationObserver` callbacks and avoid
   * redundant API calls when the form hasn't actually changed.
   * @param {string} [ctx] - Pre-computed page context from `detectPageContext()`.
   * @param {Object} [params] - Pre-computed trade params from `getTradeParams(ctx)`.
   *   When provided, skips the internal `getTradeParams` DOM read — callers that already
   *   hold the params object should pass it to avoid a redundant DOM traversal.
   * @returns {string} Fingerprint string, or `''` if no ticket is visible.
   */
  // ctx: optional pre-computed detectPageContext() result to avoid redundant DOM reads
  function getParamsFingerprint(ctx = detectPageContext(), params) {
    if (!ctx) return '';

    // Include account number so that switching accounts with identical trade params
    // still produces a distinct fingerprint, triggering a fresh 'ready' event and
    // recalculation for the new account instead of silently reusing stale results.
    const accountNum = getAccountNumber(ctx) ?? '';

    if (ctx === CTX.POPUP_EQUITY) {
      const p = params ?? getEquityTradeParams();
      return `EQ|${accountNum}|${p.symbol}|${p.action}|${p.quantity}|${p.orderType}|${p.limitPrice}`;
    }

    const p = params ?? getOptionsTradeParams();
    const legParts = p.legs.map(l =>
      `${l.action}:${l.quantity}:${l.callPut}:${l.expiration}:${l.strike}`
    ).join('|');
    // Include orderType so switching between limit and market orders (which changes the
    // price sent to the API from limitPrice to 0) produces a distinct fingerprint and
    // triggers a fresh API call rather than reusing a stale cached limit-order result.
    return `OPT|${accountNum}|${p.symbol}|${p.orderType}|${legParts}|${p.limitPrice}`;
  }

  // --- Input listener ID helpers ---
  // Derived once from DOM constants so observe() re-calls do not recompute them.
  /**
   * Strips the leading `#` from a CSS ID selector string.
   * Example: `'#foo'` → `'foo'`.
   * Logs a warning if the selector does not start with `#` so a future refactor
   * that drops the prefix produces an obvious error rather than silently matching nothing.
   * @param {string} sel - CSS ID selector (must start with `'#'`).
   * @returns {string} Raw element ID without the leading `#`.
   */
  function selectorId(sel) {
    if (!sel.startsWith('#')) {
      warn('selectorId: expected a CSS ID selector starting with "#", got:', sel);
      return sel;
    }
    return sel.slice(1);
  }
  const OPT_LIMIT_ID = selectorId(DOM.OPT_LIMIT_PRICE);   // 'dest-limitPrice'
  const OPT_SYM_ID   = selectorId(DOM.OPT_SYMBOL);         // 'symbol_search'
  const EQ_SYM_ID    = selectorId(DOM.EQ_SYMBOL);          // 'eq-ticket-dest-symbol'
  const EQ_QTY_ID    = selectorId(DOM.EQ_QTY);             // 'eqt-shared-quantity'
  const EQ_LIMIT_ID  = selectorId(DOM.EQ_LIMIT_PRIMARY);   // 'eqt-shared-limit-price'
  const LEG_QTY_BASE = selectorId(DOM.LEG_QTY_SEL_BASE);  // 'quantity' (quantity-{i})
  // Escape LEG_QTY_BASE before embedding in a regex — guards against a future rename
  // introducing special regex characters that would silently produce wrong matches.
  const legQtyRe     = new RegExp(`^${LEG_QTY_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`);
  // Set of static input IDs the input listener watches. Set.has() is O(1) vs O(n)
  // repeated === checks and keeps the condition in inputListener easier to maintain.
  const WATCHED_INPUT_IDS = new Set([OPT_LIMIT_ID, EQ_QTY_ID, EQ_LIMIT_ID, EQ_SYM_ID, OPT_SYM_ID]);

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
    // Initialize to 'closed' so the first check() call with no visible ticket does not
    // fire a spurious 'closed' event. The initial state of "no ticket open" is already
    // implied; main.js initialises currentRequest/lastResult/panel to safe defaults.
    let lastEventType = 'closed';

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
          try { callback({ type: 'closed' }); } catch (e) { warn('observer callback error:', e); }
        }
        return;
      }

      // Read trade params once: used by both hasRequiredFields and getParamsFingerprint
      // to avoid a redundant DOM traversal and ensure both see the same snapshot.
      const params = getTradeParams(ctx);
      if (!hasRequiredFields(ctx, params)) {
        // Cancel pending 'ready' debounce — form is no longer complete.
        clearTimeout(debounceTimer);
        debounceTimer = null;
        // Reset fingerprint so that if the user restores the form to the exact
        // same state, the equality check below doesn't suppress the new 'ready'
        // event and the calculation re-fires correctly.
        lastFingerprint = '';
        if (lastEventType !== 'incomplete') {
          lastEventType = 'incomplete';
          try { callback({ type: 'incomplete' }); } catch (e) { warn('observer callback error:', e); }
        }
        return;
      }

      const fp = getParamsFingerprint(ctx, params);
      if (fp === lastFingerprint) {
        // Trade params unchanged — but if the injection target is present and the panel
        // was removed by an Angular re-render, clear the fingerprint so the ready event
        // re-fires and the panel is re-injected.  Only clear when the target element
        // itself is still in the DOM; if it is gone too (Fidelity layout change), keep
        // the fingerprint to avoid a retry storm on every mutation.
        if (!MarginInjector?.getPanel() &&
            document.getElementById(FMC_CONSTANTS.INJECTION.TARGET_ID)) {
          lastFingerprint = '';
        } else {
          return;
        }
      }
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
            context: currentCtx,
            accountNum: getAccountNumber(currentCtx),
            orders: buildOrders(currentCtx)
          });
        } catch (e) { warn('observer callback error:', e); }
      }, debounceMs);
    }

    if (!document.body) {
      warn('observe() called before document.body is available — no observers set up');
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
    //
    // Additionally, filter out mutations that originate exclusively from the extension's
    // own injected panel. Every showLoading/showError/updatePanel call modifies style and
    // class attributes on panel child elements, which would otherwise trigger a redundant
    // scheduleCheck() → check() cycle (the fingerprint check in check() would short-circuit
    // it, but the extra setTimeout + DOM query overhead is wasteful and adds up during
    // active trades where the panel is updated frequently).
    observer = new MutationObserver((mutations) => {
      // MarginInjector is defined in injector.js which is loaded after detector.js,
      // but observe() is only called at runtime (from main.js init), by which point
      // all content scripts are loaded and MarginInjector is available.
      const panel = MarginInjector?.getPanel() ?? null;
      // Node.contains() returns true when the argument is the node itself (DOM spec),
      // so panel === m.target is already covered and the redundant check can be omitted.
      if (panel && mutations.every(m => panel.contains(m.target))) return;
      scheduleCheck();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'hidden', 'aria-checked', 'class']
    });

    // Listen for input events on trade fields (options + equity).
    // Route through the same throttle as MutationObserver so that rapid typing
    // (e.g. typing a quantity or limit price) doesn't fire multiple redundant
    // check() calls within a single 50ms window. The debounce inside check()
    // still guards the actual API call regardless.
    inputListener = (e) => {
      const id = e.target?.id ?? '';
      if (legQtyRe.test(id) || WATCHED_INPUT_IDS.has(id)) {
        scheduleCheck();
      }
    };
    document.addEventListener('input', inputListener, true);

    // Initial check
    check();
  }

  /**
   * Disconnects the MutationObserver and removes the input listener.
   * Cancels any pending debounce or throttle timer.
   * Safe to call even if `observe()` was never called.
   */
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
