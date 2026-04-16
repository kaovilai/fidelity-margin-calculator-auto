# Fidelity Margin Calculator Auto

Chrome extension that overlays margin impact information on Fidelity trade pages. When you're entering a trade, it automatically calculates whether the trade will result in a margin debit or credit, and how much room you have before incurring margin interest.

## Problem

Fidelity's trade ticket shows "available to trade" but doesn't clearly show:
- Whether a specific trade will push your account into margin debit (and trigger interest charges)
- How much cushion you have before crossing into margin debit territory
- The projected margin credit/debit balance after the trade

You have to manually navigate to the Margin Calculator page, re-enter the trade details, and interpret the results. This extension automates that.

## How It Works

1. **Detects trade context** — monitors Fidelity trade ticket pages and the dedicated order page for trade input
2. **Extracts trade details** — reads the symbol, action (buy/sell), quantity, price, and order type from the DOM
3. **Calls Margin Calculator API** — uses the same GraphQL endpoint (`/ftgw/digital/margincalcex/api/graphql?op=GetTradeCalculator`) that Fidelity's own Margin Calculator page uses
4. **Displays results inline** — injects a panel next to the Max Gain / Max Loss / Break Even row showing:
   - Projected `marginCreditDebit` after trade
   - Delta from current margin credit/debit
   - Whether the trade causes margin debit (interest-bearing)
   - Wiggle room: how much more you can trade before hitting margin debit
   - Cash available to withdraw without using margin after trade settles

The request reuses the browser's existing session cookies (same-origin), so no separate authentication is needed.

## Target Pages

| Page | URL Pattern | Detection |
|------|-------------|-----------|
| Trade Ticket (popup) | `digital.fidelity.com/ftgw/digital/trade-equity/*` | `#trade-container-shell` visible |
| Trade Ticket (popup) | `digital.fidelity.com/ftgw/digital/options-research/*` | `#trade-container-shell` visible |
| Trade Ticket (popup) | `digital.fidelity.com/ftgw/digital/portfolio/summary*` | `#trade-container-shell` visible |
| Options Trade (full page) | `digital.fidelity.com/ftgw/digital/trade-options*` | `body.option-trade-ticket` |
| Margin Calculator | `digital.fidelity.com/ftgw/digital/margincalcex/*` | Dedicated page |

The floating trade ticket popup (`#trade-container-shell`) can appear on many Fidelity pages — portfolio summary, option chain, research, etc. The content script should match broadly on `digital.fidelity.com/ftgw/digital/*` rather than specific paths.

## Key API Details

**Endpoint:**
```
POST https://digital.fidelity.com/ftgw/digital/margincalcex/api/graphql?op=GetTradeCalculator
```

**Key Request Fields:**
- `accountNum` — Fidelity account number
- `tradeOrders.orders[]` — hypothetical trade(s) to simulate
  - `orderSymbol` — e.g. `-AVGO260522P370` (option) or `AAPL` (equity)
  - `orderAction` — `BO` (buy to open), `SO` (sell to open), `BC` (buy to close), `SC` (sell to close), `B` (buy), `S` (sell)
  - `orderQty` — number of shares/contracts
  - `price` — limit price
  - `orderType` — `O` (option), `E` (equity)
- `priceList[]` — current positions with prices for recalculation

**Key Response Fields:**
- `balance.marginCreditDebit` — positive = credit (good), negative = debit (interest charged). When positive, this is the cash you can withdraw without touching margin. When negative, you're paying interest on this amount.
- `balance.coreCash` — cash in core position (e.g. FDRXX/SPAXX money market)
- `balance.marginBuyingPower` — remaining margin buying power
- `balance.nonMarginBuyingPower` — buying power without using margin
- `balance.avlToTradeWithoutMarginImpact` — max trade size with no margin impact
- `balance.totalAccountValue` — total account value
- `balance.marginEquityPct` — margin equity percentage

**Cash available to withdraw without margin** = projected `marginCreditDebit` (if positive). This tells you how much cash you can pull out after the trade settles without going into margin debit. If `marginCreditDebit` goes negative, any withdrawal would increase margin debit and interest charges.

## DOM Selectors

The extension works on three page contexts. Options form field IDs are shared across all:

**Floating popup** (portfolio summary, option chain, research, etc.):
- Detected by `#trade-container-shell[style*="display: block"]`
- Active trade type: `#float_trade_O[style*="display: block"]` (`O`=Options, `SE`=Stocks/ETFs)
- Container classes: `ott-float-container pad-view`
- The equity ticket (`#float_trade_SE`) uses different selectors (`eq-ticket__*`) — see below

**Dedicated trade page** (`/ftgw/digital/trade-options`):
- Detected by `body.option-trade-ticket`
- No `#trade-container-shell` or `#float_trade_*` wrappers
- Container classes: `trade-destination phone-view`

**Options form field selectors** (shared across all contexts):

| Field | Selector | Notes |
|-------|----------|-------|
| Account | `ott-account-dropdown .binding-val .accountNum` | e.g. `(X12345678)` — strip parens |
| Symbol | `#symbol_search` | Input value, e.g. `AVGO` |
| Action | `#action_dropdown-0 .binding-val` | `Buy To Open`, `Sell To Open`, `Buy To Close`, `Sell To Close` |
| Quantity | `#quantity-0` | Input value (number of contracts) |
| Call/Put | `#call-put-0-call`, `#call-put-0-put` | Radio buttons — check `aria-checked="true"` |
| Expiration | `#exp_dropdown-0 .binding-val` | e.g. `May 22, 2026` |
| Strike | `#strike_dropdown-0 .binding-val` | e.g. `370.00` |
| Limit Price | `#dest-limitPrice` | Input value |
| Order Type | `#ordertype-dropdown .binding-val` | `Limit`, `Market`, etc. |
| Trade Type | `#tradeType_dropdown .binding-val` | `Margin` or `Cash` |

**Injection target** (next to Max Gain / Max Loss / Break Even):
- `ott-max-gain-loss .max-gain-loss-container` (`#mxregin`) — row with Max Gain, Max Loss, Break Even columns
- Inject additional columns or a new row after this container
- Parent element: `ott-order-details-row .optional-items`

**Other reference sections:**
- `ott-balances-display .balances` — Margin/Non-Margin Buying Power (top of ticket)
- `ott-next-steps .estimated-info` — Estimated Order Value and fees (bottom of ticket)

**Equity ticket selectors** (stocks/ETFs via `#float_trade_SE`):
- Symbol: `#eq-ticket-dest-symbol`
- Action/Quantity/Order Type: `eq-ticket__more-trade-selections__*` classes
- Account: `#eq-ticket-account-label`
- Uses `eq-ticket__*` class prefixes instead of `ott-*`

**Multi-leg trades** (options): Leg rows use indexed IDs (`#action_dropdown-0`, `#action_dropdown-1`, etc.). The "Add Leg" button is `#dest-add-leg`.

**Option symbol construction**: The API expects symbols like `-AVGO260522P370` built from:
- `-` prefix (option indicator)
- Symbol (`AVGO`)
- Date (`260522` = 2026-05-22, format YYMMDD)
- Type (`P` = Put, `C` = Call)
- Strike (`370`)

## Architecture

```
fidelity-margin-calculator-auto/
├── manifest.json              # Chrome extension manifest v3
├── background.js              # Service worker: manages state, handles API calls
├── content/
│   ├── detector.js            # Detects trade ticket presence and extracts trade details
│   ├── injector.js            # Injects margin info panel into the page DOM
│   └── styles.css             # Styles for injected panel (matches Fidelity's design)
├── lib/
│   ├── margin-api.js          # GraphQL query builder and API caller
│   └── margin-calc.js         # Interprets API response, computes wiggle room
├── popup/
│   ├── popup.html             # Extension popup (settings, status)
│   └── popup.js               # Popup logic
├── icons/                     # Extension icons
├── curl-resp.sample           # Sample API response (reference)
└── sample-curl-from-browser.txt.sample  # Sample curl command (reference)
```

## Implementation Plan

### Phase 1: Extension Skeleton + API Integration
1. Create `manifest.json` (Manifest V3) with content script matching Fidelity domains
2. Implement `margin-api.js` — build GraphQL request from trade parameters, call API using `fetch` (same-origin cookies auto-attached)
3. Implement `margin-calc.js` — parse response, extract balance fields, compute:
   - Current vs projected margin credit/debit
   - Wiggle room = `marginCreditDebit` (projected) if positive, or how far into debit
   - Whether trade triggers margin interest
   - Cash available to withdraw without margin after settlement

### Phase 2: Trade Ticket Detection
4. Implement `detector.js` — MutationObserver on Fidelity pages to detect:
   - Trade ticket modal opening
   - Order form field changes (symbol, qty, price, action)
   - Account selector value
5. Extract trade parameters from DOM elements
6. Debounce detection to avoid excessive API calls

### Phase 3: UI Injection
7. Implement `injector.js` — find the Max Gain / Max Loss / Break Even section (`#mxregin`) in DOM
8. Create and inject margin info panel with:
   - Green/red indicator for credit/debit status
   - Projected margin credit/debit amount
   - Cash available to withdraw without margin post-settlement
   - Wiggle room before margin interest
   - Loading/error states
9. Style to match Fidelity's existing UI (`styles.css`)

### Phase 4: Background Service Worker
10. `background.js` — coordinate between content scripts, manage caching
11. Cache recent margin calc results to reduce API calls
12. Handle account switching

### Phase 5: Polish
13. Extension popup for settings (enable/disable, thresholds)
14. Error handling for expired sessions, API failures
15. Rate limiting to avoid hammering the API

## Development

```bash
# Load unpacked extension in Chrome:
# 1. Navigate to chrome://extensions
# 2. Enable Developer mode
# 3. Click "Load unpacked" and select this directory
```

## Security Notes

- Extension only runs on `digital.fidelity.com`
- No data leaves the browser — all requests go to Fidelity's own API
- No credentials stored — uses existing browser session cookies
- No external servers or analytics

## Disclaimer and Terms of Service Compliance

**This extension is not affiliated with, endorsed by, or associated with Fidelity Investments in any way.** Use at your own risk. The author is not responsible for any account restrictions, losses, or other consequences that may result from using this extension.

### Why the author believes this extension is compliant with Fidelity's TOS

Fidelity's Terms of Use prohibit "Third-Party Access Tools" providing "high-speed, automated, or repeated access." The author believes this extension falls outside the spirit and intended scope of that prohibition for the following reasons:

1. **No credential sharing or external access.** Fidelity's enforcement actions have consistently targeted third-party data aggregators and screen scraping services that require users to share login credentials and access accounts from external servers. This extension does neither — it runs entirely within the user's own authenticated browser session on `digital.fidelity.com`.

2. **No data exfiltration.** All API requests go to Fidelity's own servers, and all responses stay within the browser. No data is sent to external servers, analytics services, or third parties.

3. **User-initiated, human-rate access.** The extension only makes API calls when the user actively opens a trade ticket and enters parameters. With debouncing and caching, it generates traffic comparable to a user manually visiting Fidelity's Margin Calculator page — typically 1-3 calls per trade setup.

4. **Same information, different location.** The extension surfaces margin impact data that is already available to the user on Fidelity's own Margin Calculator page. It does not expose new data or capabilities — it makes existing information more convenient to access in context.

5. **Read-only operation.** The extension never places trades, modifies account settings, or takes any action on behalf of the user. It only retrieves and displays margin calculation results.

6. **Precedent.** Multiple Chrome extensions that interact with Fidelity pages exist on the Chrome Web Store (including extensions that automate trade execution across accounts), without reported enforcement action against users.

7. **Legal landscape.** The Supreme Court's *Van Buren v. United States* (2021) ruling narrowed the Computer Fraud and Abuse Act, holding that TOS violations alone do not constitute "unauthorized access." The DOJ's 2022 revised policy further clarified that prosecution should not be brought solely for TOS violations.

### Risks to be aware of

- Fidelity's TOS grants them the right to "terminate or suspend your access to the Fidelity Websites for any violation of the provisions of these Terms or for any reason whatsoever at its sole discretion and without prior notice."
- The margin calculator GraphQL API is an internal, undocumented endpoint — Fidelity could change or restrict it at any time.
- This analysis is not legal advice. Consult a licensed attorney for a definitive assessment.
