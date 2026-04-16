---
id: BL-2
title: 'Phase 2: Trade Ticket Detection'
status: Done
assignee: []
created_date: '2026-04-16 06:07'
updated_date: '2026-04-16 06:11'
labels: []
dependencies:
  - BL-1
references:
  - trade-popup-html.example
  - trade-options.html.sample
  - portfolio-summary.html.example
priority: high
ordinal: 2000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement DOM observation to detect when trade tickets appear on Fidelity pages and extract trade parameters (symbol, action, quantity, price, order type, account) from the form fields. Must handle both floating popup tickets and dedicated trade pages, plus equity vs options ticket variants.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 detector.js uses MutationObserver to detect trade ticket modal opening on all target pages
- [ ] #2 Extracts trade parameters from DOM: symbol, action, qty, price, order type, account, call/put, expiration, strike
- [ ] #3 Handles floating popup (#trade-container-shell) and dedicated page (body.option-trade-ticket) contexts
- [ ] #4 Detects options (#float_trade_O) vs equity (#float_trade_SE) ticket variants with correct selectors
- [ ] #5 Supports multi-leg trades with indexed IDs (action_dropdown-0, action_dropdown-1, etc.)
- [ ] #6 Debounces detection to avoid excessive API calls on rapid field changes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Implementation Plan for detector.js

### 1. Page Context Detection

Implement a `detectPageContext()` function that returns one of: `'popup-options'`, `'popup-equity'`, `'dedicated-options'`, or `null`.

**Detection logic (in priority order):**

1. **Dedicated options page**: Check `document.body.classList.contains('option-trade-ticket')`. The `<body>` element has this class on the full-page trade-options route (`/ftgw/digital/trade-options*`). No wrapper like `#trade-container-shell` exists here. The `init-component` has class `phone-view` (not `pad-view`). Container class on `trade-destination` div is `phone-view`.

2. **Floating popup visible**: Check `document.querySelector('#trade-container-shell')` exists AND has `style` containing `display: block`. Inside:
   - **Options active**: `#float_trade_O` has `style="display: block"` -- container classes are `ott-float-container pad-view`
   - **Equity active**: `#float_trade_SE` has `style="display: block"` -- uses `eq-ticket__*` selector family
   - Other tabs exist (`#float_trade_MF`, `#float_trade_DA`, etc.) -- ignore these

### 2. MutationObserver Strategy

**What to observe:**
- Attach a MutationObserver to `document.body` with `{ childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'aria-checked', 'aria-selected', 'value'] }`.

**Rationale:** Fidelity is an Angular SPA that dynamically loads trade tickets. The `#trade-container-shell` div already exists in the DOM but toggles between `display: block` and `display: none`. Angular also updates `aria-checked`, `aria-selected`, and `class` attributes when selections change, and `.binding-val` span `textContent` when dropdown values change.

**Phased observer approach:**
1. **Phase A -- Presence observer**: Watch for trade ticket becoming visible. Target: `document.body`, watch `childList: true, subtree: true`. On mutation, check if any trade ticket context is now active.
2. **Phase B -- Field observer**: Once a trade ticket is detected, attach a more targeted observer to the trade form container to watch for field value changes. On dedicated page, target `init-component` or `#init-form`. On popup, target `#float_trade_O` or `#float_trade_SE`.

**What mutations trigger extraction:**
- `childList` mutations (Angular re-renders dropdown contents, adds/removes leg rows)
- `attributes` changes on: `#call-put-N-call`/`#call-put-N-put` (`aria-checked`), dropdown buttons (`.binding-val` text changes via Angular), `#quantity-N` and `#dest-limitPrice` (value changes), account dropdown selection changes

**Optimization:** Use a coarse filter -- only re-extract when mutations touch elements inside known containers (`.option-form-row`, `.account-selector`, `.ott-symbol-search`, `.eq-ticket__*`).

### 3. Complete Selector Map

#### 3a. Options Ticket (shared across popup and dedicated page)

| Field | Selector | Value Extraction | Notes |
|---|---|---|---|
| Account Number | `ott-account-dropdown .binding-val .accountNum` | `el.textContent.trim().replace(/[()]/g, '')` | Format: `(X12345678)` -- strip parens. Nested spans: `.accountName` + `.accountNum` |
| Symbol | `#symbol_search` | `el.value` (input element) | Uppercase text, e.g. `AVGO` |
| Action (leg N) | `#action_dropdown-${N} .binding-val` | `el.textContent.trim()` | Values: `Buy To Open`, `Sell To Open`, `Buy To Close`, `Sell To Close` |
| Quantity (leg N) | `#quantity-${N}` | `parseInt(el.value, 10)` | Input type="number", `min="1"` |
| Call/Put (leg N) | `#call-put-${N}-call`, `#call-put-${N}-put` | Check `aria-checked="true"` on each radio | Two radio inputs per leg. `aria-checked` is the reliable indicator |
| Expiration (leg N) | `#exp_dropdown-${N} .binding-val` | `el.textContent.trim()` | Format: ` May 22, 2026 ` (with spaces/newlines -- must trim). May include trailing HTML comments |
| Strike (leg N) | `#strike_dropdown-${N} .binding-val` | `el.textContent.trim()` | Format: ` 370.00 ` (with whitespace) |
| Limit Price | `#dest-limitPrice` | `parseFloat(el.value)` | Input element. Only present when Order Type is Limit/Stop Limit |
| Order Type | `#ordertype-dropdown .binding-val` | `el.textContent.trim()` | Values: `Limit`, `Market`, `Stop Loss`, `Stop Limit`, `Trailing Stop ($)`, `Trailing Stop Limit ($)` |
| Trade Type | `#tradeType_dropdown .binding-val` | `el.textContent.trim()` | Values: `Margin`, `Cash` |
| Strategy | `.strategyBtn.activeButton` | `el.getAttribute('data-strategy')` or `el.textContent.trim()` | `Calls & Puts`, `Spread`, or from More Strategies dropdown |
| Leg container | `#leg-row-${N}` | Presence check | Each leg row has `id="leg-row-N"` |

#### 3b. Equity Ticket (popup only, inside `#float_trade_SE`)

| Field | Selector (scoped to `#float_trade_SE`) | Value Extraction | Notes |
|---|---|---|---|
| Account | `#dest-acct-dropdown` or `.selected-account-dropdown-label` | `.textContent.trim()` then parse `(X12345678)` | Format: ` Individual (X12345678) ` inside `.truncate` div. Use regex `/\(([A-Z0-9]+)\)/` to extract |
| Symbol | `#eq-ticket-dest-symbol` | `el.value.toUpperCase()` | Input type="text" with `text-uppercase` class |
| Action | `#dest-dropdownlist-button-action .selected-dropdown-item` or `#selected-dropdown-itemaction` | `el.textContent.trim()` | Values: `Buy`, `Sell`, `Sell Short`, `Buy to Cover` |
| Quantity | `#eqt-shared-quantity` | `parseInt(el.value, 10)` | Input inside `quantity` component |
| Order Type | `#dest-dropdownlist-button-ordertype .selected-dropdown-item` or `#selected-dropdown-itemordertype` | `el.textContent.trim()` | Values: `Market`, `Limit`, `Stop Loss`, `Stop Limit`, etc. |
| Time in Force | `#dest-dropdownlist-button-timeinforce .selected-dropdown-item` or `#selected-dropdown-itemtimeinforce` | `el.textContent.trim()` | `Day`, `Good 'til Canceled`, etc. |
| Quantity Type | `.eq-ticket__more-trade-label` | `el.textContent.trim()` | `Shares`, `Dollars` |

#### 3c. Injection Target (both options contexts)

| Target | Selector | Confirmed |
|---|---|---|
| Max Gain/Loss container | `#mxregin` or `ott-max-gain-loss .max-gain-loss-container` | Yes -- identical ID in both popup and dedicated page |
| Parent container | `ott-order-details-row .optional-items` | The `#mxregin` div sits inside `.form-item-container.ott-max-gain-loss` |

### 4. Field Value Extraction & Normalization

```
function extractTradeParams(context) {
  // context: 'popup-options' | 'dedicated-options' | 'popup-equity'
  
  // For options:
  // Account: querySelector('ott-account-dropdown .binding-val .accountNum')
  //   -> textContent.trim().replace(/[()]/g, '')
  //   e.g. "(X12345678)" -> "X12345678"
  
  // Action mapping for API:
  //   "Buy To Open"   -> "BO"
  //   "Sell To Open"  -> "SO"  
  //   "Buy To Close"  -> "BC"
  //   "Sell To Close" -> "SC"
  //   (equity: "Buy" -> "B", "Sell" -> "S")
  
  // Expiration parsing:
  //   " May 22, 2026 " -> trim -> parse with Date or manual
  //   -> YYMMDD format: "260522"
  //   Handle: new Date("May 22, 2026") -> getFullYear()%100, month+1, day
  //   Pad month/day to 2 digits
  
  // Strike normalization:
  //   " 370.00 " -> trim -> parseFloat -> remove trailing zeros
  //   "370.00" -> "370", "16.50" -> "16.5"
  //   API format: no decimal if whole number, keep decimal if fractional
  //   Key: strip trailing ".00" but keep ".5" etc.
  
  // Call/Put:
  //   Check aria-checked="true" on #call-put-N-call -> "C"
  //   Check aria-checked="true" on #call-put-N-put -> "P"
}
```

### 5. Option Symbol Construction

Build API symbol from extracted fields: `-{SYMBOL}{YYMMDD}{P|C}{STRIKE}`

```
function buildOptionSymbol(symbol, expiration, callPut, strike) {
  // symbol: "AVGO"
  // expiration: "May 22, 2026" (raw from DOM)
  // callPut: "C" or "P"  
  // strike: "370.00" (raw from DOM)
  
  // 1. Parse expiration date
  const date = new Date(expiration.trim());
  const yy = String(date.getFullYear() % 100).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  
  // 2. Normalize strike
  //    "370.00" -> "370"
  //    "16.50"  -> "16.5" 
  //    "0.50"   -> "0.5"
  let strikeStr = parseFloat(strike.trim()).toString();
  
  // 3. Build symbol
  return `-${symbol.toUpperCase()}${yy}${mm}${dd}${callPut}${strikeStr}`;
  // Result: "-AVGO260522P370"
}
```

**Edge cases for strike formatting:**
- From the sample curl, `SOFI260515C18` shows no decimal for whole-number strikes
- `SOFI260424C16.5` shows single decimal for half-strikes  
- Need to verify: does `parseFloat("370.00").toString()` produce `"370"`? Yes it does.

### 6. Multi-Leg Detection

**How legs are structured:**
- Each leg is an `ott-order-leg-row` component with `id="leg-row-N"` (N = 0, 1, 2, 3...)
- Field IDs are indexed: `#action_dropdown-0`, `#action_dropdown-1`, `#quantity-0`, `#quantity-1`, etc.
- The "Add Leg" button has `id="dest-add-leg"` (desktop) or `id="dest-mobile-add-leg"` (mobile)

**Detection approach:**
1. Query all elements matching `[id^="leg-row-"]` to find all visible legs
2. For each leg N, extract action, quantity, call/put, expiration, strike using indexed selectors
3. Build one `orders[]` array entry per leg for the API request
4. Watch for `childList` mutations that add/remove `ott-order-leg-row` elements (signal a leg was added/removed)

**Multi-leg strategies:**
- Spreads: 2 legs with different strikes and/or expirations
- Iron Condors: 4 legs
- Custom: up to 4 legs (based on Tier 3 approval)
- Each leg shares the same symbol (`#symbol_search`) but has independent action, qty, call/put, expiration, strike

### 7. Debounce Strategy

**Timing:** 500ms debounce after the last DOM mutation that affects trade parameters.

**What triggers recalc:**
- Any change to: account, symbol, action, quantity, call/put, expiration, strike, limit price, order type, trade type
- Adding or removing a leg

**Implementation:**
```
let debounceTimer = null;
const DEBOUNCE_MS = 500;

function onTradeFieldChanged() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const params = extractTradeParams(currentContext);
    if (params && isComplete(params)) {
      // Compare with last params to avoid duplicate API calls
      const paramsKey = JSON.stringify(params);
      if (paramsKey !== lastParamsKey) {
        lastParamsKey = paramsKey;
        triggerMarginCalc(params);
      }
    }
  }, DEBOUNCE_MS);
}
```

**Completeness check (`isComplete`):**
- For options: account, symbol, at least one leg with action + quantity + call/put + expiration + strike all non-empty
- For equity: account, symbol, action, quantity all non-empty
- Limit price required only if order type is Limit

### 8. Edge Cases

**Symbol change:** When user changes symbol in `#symbol_search`, Angular clears and reloads expiration/strike dropdowns. The observer will see mutations as Angular removes old options and adds new ones. The debounce prevents firing during this transition. After 500ms, re-extract all fields -- if expiration/strike are not yet populated (still loading), skip the API call.

**Account switch:** User selects different account from `ott-account-dropdown`. The account number changes, requiring a new API call with the new `accountNum`. The `priceList` (existing positions) also changes per account -- for Phase 2 we extract the account number; fetching the position list is Phase 1's responsibility.

**Popup close/reopen:** When `#trade-container-shell` style changes to `display: none`, clean up the field observer. When it becomes `display: block` again, re-attach.

**Ticket type switch:** User switches between Options (`#float_trade_O`) and Stocks/ETFs (`#float_trade_SE`) inside the floating popup. Detect by monitoring which child div of `float_trade_apps` has `display: block`.

**Loading states:** Some dropdowns show a `<span class="loading"></span>` element while data is being fetched (observed on expiration and strike dropdowns). Check that `.binding-val` actually has content before considering the field populated.

**Strategy changes:** User selects a different strategy (e.g., Spread -> Straddle). This may add/remove legs and change pre-populated values. The leg count detection via `[id^="leg-row-"]` handles this automatically.

**Empty/partial form:** On initial load with no symbol entered, most fields are empty. The completeness check prevents API calls until all required fields are filled.

### 9. Module Exports

```
// detector.js exports:
// - init(): Sets up MutationObservers, returns cleanup function
// - onTradeDetected(callback): Register callback for when trade params change
// - getCurrentContext(): Returns current page context or null
// - extractTradeParams(): Returns current trade parameters object
```

### 10. Trade Parameters Object Shape

```
{
  context: 'popup-options' | 'dedicated-options' | 'popup-equity',
  account: 'X12345678',
  symbol: 'AVGO',
  tradeType: 'Margin' | 'Cash',
  orderType: 'Limit' | 'Market' | ...,
  limitPrice: 11.75,  // null if Market order
  legs: [
    {
      action: 'SO',           // API code
      actionText: 'Sell To Open', // original text for display
      quantity: 1,
      callPut: 'P',           // 'C' or 'P' (options only)
      expiration: '260522',   // YYMMDD (options only)
      strike: '370',          // normalized (options only)
      orderSymbol: '-AVGO260522P370', // constructed (options only)
      orderType: 'O',         // 'O' for option, 'E' for equity
    }
  ]
}
```
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## DOM Quirks and Observations from HTML Samples

### Whitespace in `.binding-val` spans
All dropdown `.binding-val` elements contain significant leading/trailing whitespace and sometimes embedded newlines and HTML comments (`<!---->`). Example from expiration: `" May 22, 2026 "`. Always `.trim()` before parsing. Some values also have a trailing `<!---->` comment node inside the span -- using `.textContent` naturally ignores these.

### Angular comment nodes
The DOM is littered with `<!---->` comment nodes from Angular's `*ngIf`/`*ngFor` directives. These appear between elements and inside spans. `.textContent` handles them gracefully, but `.innerHTML` would be unreliable for value extraction.

### Equity ticket uses entirely different component architecture
The equity ticket (`#float_trade_SE`) uses `ap122489-ett-component` with a `pvd-ett-*` (Fidelity's "Prism" design system) component library. Selectors are completely different from the options ticket:
- Uses `dropdownlist-ett-ap122489` custom elements instead of simple `<button>` dropdowns
- Selected values are in `#selected-dropdown-item{field}` divs (e.g., `#selected-dropdown-itemaction`)
- Account format inside equity ticket is different: ` Individual (X12345678) ` as a single string in a `.truncate` div, vs. separate `.accountName`/`.accountNum` spans in options ticket

### `display: block` vs `display: none` for ticket type detection
The active ticket type inside `float_trade_apps` is determined solely by inline `style="display: block"` vs `style="display: none"`. There are 7+ ticket types: `float_trade_SE` (Stocks/ETFs), `float_trade_O` (Options), `float_trade_MF` (Mutual Funds), `float_trade_DA`, `float_trade_AUT`, `float_trade_MT`, `float_trade_ALT`, `float_trade_TXN`. We only care about `_O` and `_SE`.

### Dedicated page vs popup have the same Angular components
The dedicated trade-options page and the floating popup options ticket use the exact same Angular `options-trade-ticket` component with the same `init-component`, `ott-order-leg-row`, etc. The only structural difference:
- Popup: `init-component` has class `scrollable trade ott-float-container pad-view`
- Dedicated: `init-component` has class `phone-view` (no `ott-float-container`)
This means the selectors for individual fields are identical in both contexts.

### Account dropdown has grouped options
The account dropdown groups accounts into "Default Account", "Accounts with Option Approval", and "All Other Accounts". The selected account always has both `.accountName` and `.accountNum` spans in the `.binding-val`. Not all accounts may support options or margin.

### Radio buttons for Call/Put use `aria-checked`, not `checked`
The call/put radio inputs (`#call-put-N-call`, `#call-put-N-put`) are Angular-controlled. The native `checked` property may not be reliable -- use `getAttribute('aria-checked') === 'true'` instead.

### Strategy bar buttons use `data-strategy` attribute
The strategy buttons in the "More Strategies" dropdown have `data-strategy="Iron Condor"` etc. The active simple strategy button has class `activeButton` with `aria-pressed="true"`.

### Expiration dropdown contains Earnings markers
The expiration dropdown can include disabled entries marking earnings dates: `<button role="option" aria-disabled="true" class="disabled"><span class="earn">...</span></button>`. These are not selectable but could confuse a naive DOM query that looks at all `button[role="option"]` elements.

### Strike values always show 2 decimal places in DOM
Strikes are displayed as `370.00`, `16.50`, etc. in the DOM, but the API expects `370` (no decimal for whole numbers) and `16.5` (minimal decimal). The `parseFloat().toString()` normalization handles this correctly.

### Loading states on dropdowns
Expiration and strike dropdowns have a `<span class="loading"></span>` sibling that appears when data is being fetched (e.g., after changing symbol). During loading, `.binding-val` may be empty or stale. Must check for the loading indicator before treating the field as populated.

### Equity ticket has no Max Gain/Loss section
The equity ticket (`#float_trade_SE`) does not have the `ott-max-gain-loss` / `#mxregin` injection target. For equity trades, we need a different injection point -- possibly the commission/estimated value area (`.eqt-commission__pricing-container`) or the balance area (`#eq-ticket__account-balance`).

### Risk: Angular may re-render entire subtrees
Angular's change detection can replace entire DOM subtrees when data changes (e.g., switching accounts replaces the leg rows). MutationObserver callbacks should not cache element references long-term -- always re-query selectors when extracting values.

### The `data-tradestatus` attribute on `init-component`
The `init-component` element has `data-tradestatus="Init"` which changes as the trade progresses (Init -> Preview -> Placed). This could be useful for knowing when to stop showing margin info (after preview/placement). However, this needs further investigation during implementation.
<!-- SECTION:NOTES:END -->
