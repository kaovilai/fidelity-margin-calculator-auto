# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome extension (Manifest V3) that overlays margin impact information on Fidelity trade pages. It detects trade ticket inputs, calls Fidelity's margin calculator GraphQL API using the browser's session cookies, and injects projected margin debit/credit info next to the buying power display.

## Development

No build tooling — plain JavaScript, loaded as an unpacked Chrome extension:
1. `chrome://extensions` → Enable Developer mode → Load unpacked → select this directory

To test changes, click the reload button on the extension card in `chrome://extensions`.

## API

Fidelity moved the margin calculator to `/ftgw/digital/margin-calculator/` with a REST API under `/ftgw/digital/api-margin-calculator/api/` (the old `margincalcex` GraphQL endpoints are no longer used). Auth is same-origin cookies. Requests need `Referer: https://digital.fidelity.com/ftgw/digital/margin-calculator/` (set via `declarativeNetRequest` in `rules.json`).

**Positions + current balance:** `POST .../api/current-status/v1`
```json
{"accountNum":"Z…","executeOpenOrdersInd":null,"executeHpoTxnsInd":false,"balancesOnlyInd":false,"rbrAddonsInd":true}
```
Response `data.getCurrentStatus.marginCalcResp` has `balance` (current state), `positions[]` (`symbol`, `cusip`, `longShortInd`, `price`, `currencyInd`, ...), `optPairs`, `underlyingSecurities`. Per-unit prices are already provided (no mktVal/qty derivation needed).

**Projected margin:** `POST .../api/trade-calculator/v1`
```json
{"accountNum":"Z…","executeOpenOrdersInd":false,"priceSourceInd":"S","executeHpoTxnsInd":true,"balancesOnlyInd":false,"rbrAddonsInd":true,
 "tradeOrders":{"orders":[{"orderSymbol":"-APLD261016P24","orderType":"O","orderAction":"SO","orderQty":1,"price":1.26}]},
 "priceList":[{"symbol":"FDRXX","cusip":"316067107","priceInd":"initial","longShortInd":"LONG","price":1,"isCurrency":false}]}
```
Response `data.getTradeCalculator.marginCalcResp.balance` — same shape as before.

Key balance fields: `marginCreditDebit` (positive=credit, negative=debit/interest), `avlToTradeWithoutMarginImpact` (cash withdrawable without margin interest), `marginBuyingPower`, `houseBalance` (negative = house call), `totalOptionRequirements`, `totalSecurityRequirements`.

### Request requirements

- **orders**: required (empty `orders: []` is rejected). `orderSymbol` keeps the leading `-` for options; `orderAction` e.g. `SO` (sell to open).
- **priceList**: required. Build it from `current-status` positions, **skipping positions with no `symbol`** (T-bills carry only a CUSIP) — this mirrors what Fidelity's own page sends. Option symbols in the `priceList` have no leading `-` (`F271217P10`).
- **Page context**: API works from any `digital.fidelity.com` page.

### Architecture

1. `current-status/v1` → `priceList` + current `balance` (cached 5 min, one request).
2. When a trade is detected: `trade-calculator/v1` with the user's order + `priceList`.
3. Panel shows projected margin credit/debit with an exact delta vs the current balance (from step 1), plus extra figures derived from responses already fetched (margin requirement, house surplus/call, order premium) — no additional requests.

**Option chain hints** (`content/chain.js`, pure model in `lib/chain-estimate.js`): chain cells are `<a role="button" aria-label="sell Oct 16 2026 24 put at bid of 1.36">`. Hovering one runs an exact `trade-calculator/v1` order (`SO`/`BO`, symbol `-APLD261016P24`); results feed a per-(underlying, expiry, type, side) sample set of "effective requirement" = `premium − Δhouse` (verified: equals the margin-requirement increase for a naked short put), linearly interpolated by strike to estimate other cells. Premium and `marginCreditDebit` change are exact (credit delta = premium). Account comes from the open ticket, the panel's last account, a remembered value, or `accounts/v1` (default tradable `Brokerage` account). Estimates were within ~2% of exact calculations on APLD puts; withdrawable cash assumes it moves 1:1 with house balance (clamped at 0), which is only verified for sells.

A non-JSON `text/html` 2xx response (e.g. "Fidelity.com is Temporarily Unavailable") is treated as a retryable API error.

## DOM Integration

Two page contexts, same form field IDs:
- **Floating popup** (portfolio summary, option chain, research, etc.): detect via `#trade-container-shell` visible, active type via `#float_trade_O` (options) or `#float_trade_SE` (equities — uses different `eq-ticket__*` selectors)
- **Dedicated page** (`/ftgw/digital/trade-options`): detect via `body.option-trade-ticket`, no popup wrapper

Trade form fields use indexed IDs for multi-leg support: `#action_dropdown-0`, `#quantity-0`, `#strike_dropdown-0`, etc. Values are in `.binding-val` child spans. Full selector table is in README.md.

**Injection target:** `ott-max-gain-loss .max-gain-loss-container` (`#mxregin`) — the Max Gain / Max Loss / Break Even row. Inject margin info columns/row next to these. Use MutationObserver since Fidelity is an Angular SPA that loads trade tickets dynamically.

**Option symbol format for API:** `-AVGO260522P370` = `-` + ticker + YYMMDD + P/C + strike (no decimal).

## Testing with Playwright MCP

Use Playwright MCP tools for iterative API testing against live Fidelity sessions. This avoids console paste issues and enables automated A/B testing.

### Setup

1. User logs into Fidelity in the Playwright browser (navigate to any `digital.fidelity.com` page)
2. Use `browser_evaluate` to run fetch calls — session cookies are included automatically
3. Results return directly, no need to copy/paste from console

### Common Patterns

**Fetch positions → build priceList → call margin calc (end-to-end test):**
```js
// In browser_evaluate:
async () => {
  // 1. Get positions + current balance
  const st = await fetch('/ftgw/digital/api-margin-calculator/api/current-status/v1', {
    method: 'POST', headers: {'content-type': 'application/json', 'accept': '*/*'}, credentials: 'include',
    body: JSON.stringify({accountNum: 'ACCT_NUM', executeOpenOrdersInd: null, executeHpoTxnsInd: false, balancesOnlyInd: false, rbrAddonsInd: true})
  });
  const positions = (await st.json()).data.getCurrentStatus.marginCalcResp.positions;
  // 2. Build priceList (see lib/positions.js — skip positions with no symbol)
  // 3. Call margin calc with order + priceList (marginBody per the API section above)
  const resp = await fetch('/ftgw/digital/api-margin-calculator/api/trade-calculator/v1', {
    method: 'POST',
    headers: {'accept':'*/*','content-type':'application/json'},
    credentials: 'include',
    body: JSON.stringify(marginBody)
  });
  const data = await resp.json();
  const bal = data.data.getTradeCalculator.marginCalcResp.balance;
  return JSON.stringify(bal, null, 2);  // inspect all balance fields
}
```

**Intercept page's own API calls (capture query shapes):**
```js
// In browser_run_code:
async (page) => {
  let captured = null;
  page.on('requestfinished', async (req) => {
    if (req.url().includes('target-endpoint') && req.postData()?.includes('OperationName')) {
      captured = { body: req.postData(), resp: await (await req.response()).text() };
    }
  });
  await page.reload({waitUntil: 'load'});
  await page.waitForTimeout(8000);
  return captured ? JSON.parse(captured.body).query : 'Not captured';
}
```

**A/B testing (isolate which field causes failure):**
```js
// Change one variable at a time, compare status codes:
// Test 1: orders=[IBM put], priceList=[positions] → 200 ✓
// Test 2: orders=[], priceList=[positions]         → 400 ✗ (orders required)
// Test 3: orders=[IBM put], priceList=[]           → 400 ✗ (priceList required)
```

### Key Gotchas

- `browser_evaluate` runs in page context — `require()` not available, use `fetch()` directly
- `browser_run_code` runs in Node/Playwright context — can use `page.on('requestfinished', ...)` to intercept
- Portfolio page never reaches `networkidle` — use `waitUntil: 'load'` + `waitForTimeout(8000)`
- When inspecting large API responses, slice output: `JSON.stringify(data).slice(0, 5000)` to avoid truncation
- Session expires — if 401/403/redirect to login, user must re-login in Playwright browser
- Verify results against Fidelity's own Margin Calculator page (`/ftgw/digital/margin-calculator/`) to validate accuracy

## Reference Files

- `trade-popup-html.example` — DOM structure of the floating trade ticket popup (from option chain page)
- `trade-options.html.sample` — DOM structure of the dedicated full-page trade options ticket
- `portfolio-summary.html.example` — DOM structure of portfolio summary page (has floating popup with both options and equity ticket)
- `sample-curl-from-browser.txt.sample` — complete cURL with GraphQL query (contains sample cookies — scrub before committing)
- `curl-resp.sample` — API response shape with positions, balances, and option pairings

<!-- BACKLOG.MD MCP GUIDELINES START -->

<CRITICAL_INSTRUCTION>

## BACKLOG WORKFLOW INSTRUCTIONS

This project uses Backlog.md MCP for all task and project management activities.

**CRITICAL GUIDANCE**

- If your client supports MCP resources, read `backlog://workflow/overview` to understand when and how to use Backlog for this project.
- If your client only supports tools or the above request fails, call `backlog.get_backlog_instructions()` to load the tool-oriented overview. Use the `instruction` selector when you need `task-creation`, `task-execution`, or `task-finalization`.

- **First time working here?** Read the overview resource IMMEDIATELY to learn the workflow
- **Already familiar?** You should have the overview cached ("## Backlog.md Overview (MCP)")
- **When to read it**: BEFORE creating tasks, or when you're unsure whether to track work

These guides cover:
- Decision framework for when to create tasks
- Search-first workflow to avoid duplicates
- Links to detailed guides for task creation, execution, and finalization
- MCP tools reference

You MUST read the overview resource to understand the complete workflow. The information is NOT summarized here.

</CRITICAL_INSTRUCTION>

<!-- BACKLOG.MD MCP GUIDELINES END -->
