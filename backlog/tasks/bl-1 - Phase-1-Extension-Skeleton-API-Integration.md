---
id: BL-1
title: 'Phase 1: Extension Skeleton + API Integration'
status: Done
assignee: []
created_date: '2026-04-16 06:07'
updated_date: '2026-04-16 06:11'
labels: []
dependencies: []
references:
  - sample-curl-from-browser.txt.sample
  - curl-resp.sample
priority: high
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Set up the Chrome extension foundation (Manifest V3) and implement the core API integration layer. This phase produces the manifest, GraphQL query builder, and response interpreter — everything needed to call Fidelity's margin calculator API and interpret results.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 manifest.json created with correct Manifest V3 structure, content script matching Fidelity domains
- [ ] #2 margin-api.js builds valid GraphQL requests from trade parameters and calls API via fetch with same-origin cookies
- [ ] #3 margin-calc.js parses API response, extracts balance fields, computes projected margin credit/debit, wiggle room, and cash withdrawable without margin
- [ ] #4 Extension loads as unpacked extension in Chrome without errors
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Implementation Plan: Phase 1 — Extension Skeleton + API Integration

### 1. manifest.json (DONE — already exists)

The manifest is already created with the correct structure:
- `manifest_version: 3`
- `host_permissions`: `*://digital.fidelity.com/*` — grants cookie/fetch access to Fidelity's domain
- `content_scripts`: matches `*://digital.fidelity.com/ftgw/digital/*` (broad match as recommended in README)
  - Loads all JS files in order: margin-api.js, margin-calc.js, detector.js, injector.js, main.js
  - Loads content/styles.css
  - `run_at: document_idle` — waits for page load since Angular SPA dynamically renders trade tickets
- `background.service_worker`: background.js (minimal placeholder)
- No `permissions` array needed — same-origin cookies auto-attach, no `cookies` or `activeTab` permission needed

**Key decision**: All JS is loaded as content scripts (not ES modules) since MV3 content scripts don't support `import`. Files use IIFE pattern with globals (`MarginAPI`, `MarginCalc`, `TradeDetector`, `MarginInjector`).

### 2. margin-api.js — GraphQL Request Builder (DONE — already exists)

**Endpoint**: `POST /ftgw/digital/margincalcex/api/graphql?op=GetTradeCalculator` (relative URL — works because content script runs on same origin)

**Query structure**: Uses a *simplified* query compared to the sample cURL:
- Only requests `balance` fields (no `positions`, `optPairs`, `underlyingSecurities`, `logos`)
- This avoids the `INTERNAL_SERVER_ERROR` on `logos` fields seen in curl-resp.sample (the API has a bug where logos cannot serialize to primitive values)
- Reduces response payload significantly

**Request variables shape**:
```
tradeCalculatorInput: {
  accountNum: "X12345678",          // from DOM
  executeOpenOrdersInd: false,      // don't factor in open orders
  priceSourceInd: "S",              // server-side pricing
  executeHpoTxnsInd: true,          // include hypothetical transactions
  balancesOnlyInd: false/true,      // true for baseline (no trade), false for projected
  rbrAddonsInd: true,               // include risk-based requirement add-ons
  tradeOrders: { orders: [...] },   // the hypothetical trade
  priceList: []                     // current positions with prices — EMPTY for now (see gotchas)
}
```

**Order object shape**:
```
{
  orderSymbol: "-AVGO260522P370",   // option symbol with - prefix
  orderType: "O",                    // O=option, E=equity
  orderAction: "SO",                 // BO/SO/BC/SC/B/S
  orderQty: 1,                       // number of contracts
  price: 11.75                       // limit price
}
```

**Headers**: Minimal — `content-type: application/json`, `accept: */*`, `apollographql-client-version: 0.0.0`. Uses `credentials: 'include'` for same-origin cookie attachment.

**Two API calls per trade evaluation**:
1. `fetchBaseline(accountNum)` — empty orders, `balancesOnlyInd: true` — gets current margin state
2. `fetchMarginCalc(accountNum, orders)` — with the hypothetical trade — gets projected margin state

**Error handling**: Filters out `logos` errors (known API bug) and only throws on non-logo errors.

### 3. margin-calc.js — Response Parser & Impact Calculator (DONE — already exists)

**Response path**: `data.getTradeCalculator.marginCalcResp.balance`

**Key balance fields extracted**:
| Field | Meaning |
|-------|---------|
| `marginCreditDebit` | Core metric. Positive = credit (cash available), negative = debit (paying interest) |
| `marginBuyingPower` | Remaining margin buying power after trade |
| `nonMarginBuyingPower` | Buying power without using margin |
| `coreCash` | Cash in money market (FDRXX/SPAXX) |
| `avlToTradeWithoutMarginImpact` | Max trade size with zero margin impact |

**Computed values** (from `computeImpact(baseline, projected)`):
| Computed Field | Formula | Meaning |
|---------------|---------|---------|
| `currentCreditDebit` | `baseline.marginCreditDebit` | Current margin state before trade |
| `projectedCreditDebit` | `projected.marginCreditDebit` | Margin state after trade |
| `delta` | `projected - current` | How much this trade moves the margin needle |
| `isMarginDebit` | `projectedCreditDebit < 0` | Will you be paying interest? |
| `cashWithdrawable` | `max(0, projectedCreditDebit)` | Cash you can withdraw without touching margin |

**"Wiggle room"** is effectively `projectedCreditDebit` when positive — it represents how much additional debit you can absorb before crossing into interest-bearing territory. This is currently represented by `cashWithdrawable` in the UI. A more explicit wiggle room field could be added later.

### 4. Supporting Files (DONE)

- **content/detector.js**: MutationObserver-based trade ticket detection, DOM field extraction, option symbol construction, debounced change detection
- **content/injector.js**: DOM injection after `#mxregin` element, loading/error/data states, currency formatting
- **content/main.js**: Orchestrator tying detector -> API -> calc -> injector, with baseline caching (60s TTL) and stale request cancellation
- **content/styles.css**: Panel styling matching Fidelity's design language
- **background.js**: Minimal placeholder (no logic needed for MVP)

### 5. Remaining Work for Phase 1 Completion

The skeleton code exists but has these gaps:

#### 5a. priceList Population (HIGH PRIORITY)
The `priceList` is currently hardcoded to `[]`. The sample cURL shows it should contain current positions with their prices. This matters because:
- The API uses priceList to calculate margin requirements for *existing* positions
- Without it, the projected balance may not accurately reflect the actual margin impact
- The sample shows entries like `{symbol, cusip, priceInd: "initial", longShortInd, price, isCurrency: false}`

**Decision needed**: For Phase 1, `priceList: []` may be acceptable — the API seems to use its own server-side prices (`priceSourceInd: "S"`). The sample has `priceInd: "initial"` which suggests these are baseline prices the page loaded with. The margin calculator page pre-populates this from account data. We may need to make a baseline call to get positions, then feed them back.

**Alternative**: Set `priceSourceInd: "S"` and rely on server pricing entirely. The response we see in curl-resp.sample has positions populated even though we only requested balance fields — so the server already knows positions.

#### 5b. Multi-Leg Order Support
`detector.js` currently only reads leg 0. Multi-leg support (spreads, straddles, etc.) would iterate `#action_dropdown-{i}`, `#quantity-{i}`, etc. for i = 0, 1, 2, 3. Low priority for Phase 1 but the data structure (orders array) already supports it.

#### 5c. Equity Ticket Support
`detector.js` only handles options ticket selectors. The equity ticket uses `#float_trade_SE` with `eq-ticket__*` selectors. This is out of scope for Phase 1 but should be noted.

#### 5d. XSRF Token Handling
The sample cURL shows several XSRF tokens in cookies. The content script's `fetch` with `credentials: 'include'` should auto-attach cookies, but some Fidelity endpoints may require an explicit `X-XSRF-TOKEN` header. The cookies include `MARGIN-CALCULATOR-XSRF-TOKEN`, `XSRF-TOKEN`, and endpoint-specific ones. If the API returns 403, we'll need to read the relevant XSRF cookie and set it as a header.

#### 5e. Testing Strategy
No automated tests exist. Phase 1 acceptance should include:
- Load extension on Fidelity options trade page
- Verify panel appears below Max Gain/Max Loss/Break Even row
- Verify API call succeeds and displays projected margin credit/debit
- Verify error handling when session expired (HTTP 401/403)

### 6. Key Gotchas

1. **Option symbol format**: `-AVGO260522P370` = dash + ticker + YYMMDD + P/C + strike (no decimal for whole numbers, but fractional strikes like `16.5` keep the decimal). The `formatStrike` function handles this correctly.

2. **API logos bug**: The response always errors on `logos` fields with "Cannot convert object to primitive value". Our simplified query excludes logos entirely.

3. **Angular SPA navigation**: Fidelity uses Angular with client-side routing. The content script must use MutationObserver (not page load events) to detect trade ticket appearance. This is already implemented.

4. **Account number format**: DOM shows `(X12345678)` with parens — must strip them. Already handled in `getAccountNumber()`.

5. **balancesOnlyInd**: Set to `true` for baseline calls (no hypothetical trade), `false` when simulating a trade. This is correctly implemented.

6. **Debouncing**: 500ms debounce on field changes to avoid API spam. Already implemented.

7. **Stale request handling**: Uses incrementing `currentRequest` counter to discard responses from outdated requests. Already implemented.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Research Observations & Open Questions

### Observations

1. **Code is substantially complete**: All 7 files for Phase 1 already exist with working implementations. This task is closer to "review and test" than "implement from scratch." The architecture is clean: IIFE modules loaded as content scripts, MutationObserver for SPA detection, debounced API calls with baseline caching.

2. **API response has known bugs**: The `logos` field in positions and optPairs always returns `INTERNAL_SERVER_ERROR: "Cannot convert object to primitive value"`. This is a Fidelity server-side bug, not ours. Our simplified query avoids requesting logos entirely, which is the right approach.

3. **priceList is the biggest accuracy risk**: The sample cURL sends a priceList of all current positions with their prices. Our implementation sends an empty priceList and relies on `priceSourceInd: "S"` (server-side pricing). This *may* cause margin calculations to differ from what Fidelity's own margin calculator page shows, especially if the user has complex positions where price movements since last refresh affect margin requirements. This needs real-world testing.

4. **XSRF tokens might be needed**: The sample cURL shows `MARGIN-CALCULATOR-XSRF-TOKEN` and `XSRF-TOKEN` cookies. The fetch API will attach all cookies automatically via `credentials: 'include'`, but some endpoints additionally require the XSRF token as a custom header (anti-CSRF pattern). If we get 403 errors in testing, we'll need to read `document.cookie` for the XSRF token value and add it as an `X-XSRF-TOKEN` header.

5. **Cash withdrawable definition corrected**: Per Fidelity's glossary, "cash withdrawable without margin" = projected `avlToTradeWithoutMarginImpact` — this is the max dollar amount you can withdraw without creating a margin debit. Note: `marginCreditDebit` is a separate concept showing net cash owed to/from you after trade execution, NOT the safe withdrawal amount.

6. **Response data is rich**: Even with the simplified query (balance only), we get 18 balance fields including `marginEquityPct` (100% in the sample = fully equity-funded), `totalSecurityRequirements` ($1,408.61), `totalOptionRequirements` ($24,275.50). These could be displayed in an expanded view later.

7. **Existing positions in response**: The full response (curl-resp.sample) shows the account holds: FDRXX cash ($5,409.83), multiple naked puts (MSFT, HOOD, ARKK, TSLA, AVGO), a covered call (SOFI stock + short call), T-Bills ($21,954.54 total), and long SOFI260515C17 (at 0 shares — likely closed). Total option requirements are $24,275.50, driving the margin calculations.

### Open Questions

1. **Will the API work without CSRF headers?** The content script runs on the same origin so cookies attach automatically, but Fidelity may require explicit CSRF header validation. Needs testing.

2. **Does empty priceList degrade accuracy?** The server has access to current prices via `priceSourceInd: "S"`, so it *should* compute correct margins. But the margin calculator page sends positions — there might be a reason. Testing will reveal this.

3. **Rate limiting?** No evidence of rate limiting in the API, but we should observe for 429 responses. The 500ms debounce provides some protection. Consider adding exponential backoff.

4. **Session expiry handling?** When the Fidelity session expires, the API will likely return 401 or redirect to login. Current error handling will show "Margin API HTTP 401" — might want a friendlier message like "Session expired — please log in."

5. **Multi-account switching?** The baseline cache is keyed by account number, which handles switching correctly. But when the user switches accounts, we should clear the injection panel until new data loads.

### Risks

- **API contract stability**: We're using an internal/undocumented GraphQL API. Fidelity could change field names, require new headers, or add authentication at any time.
- **Content Security Policy**: Fidelity's CSP might block inline styles or scripts in the future. Our CSS is loaded from a separate file (good), and we don't use inline scripts (good).
- **Performance**: MutationObserver on `document.body` with `subtree: true` could be expensive on complex Fidelity pages. If performance issues arise, consider narrowing the observation target.
<!-- SECTION:NOTES:END -->
