# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome extension (Manifest V3) that overlays margin impact information on Fidelity trade pages. It detects trade ticket inputs, calls Fidelity's margin calculator GraphQL API using the browser's session cookies, and injects projected margin debit/credit info next to the buying power display.

## Development

No build tooling — plain JavaScript, loaded as an unpacked Chrome extension:
1. `chrome://extensions` → Enable Developer mode → Load unpacked → select this directory

To test changes, click the reload button on the extension card in `chrome://extensions`.

## API

**Endpoint:** `POST https://digital.fidelity.com/ftgw/digital/margincalcex/api/graphql?op=GetTradeCalculator`

Auth is handled by same-origin cookies (no separate auth needed). The GraphQL query and response shapes are documented in `sample-curl-from-browser.txt.sample` (request) and `curl-resp.sample` (response).

Key response fields for margin impact: `balance.marginCreditDebit` (positive=credit, negative=debit/interest), `balance.avlToTradeWithoutMarginImpact`, `balance.coreCash`, `balance.marginBuyingPower`.

**Cash withdrawable without margin** = projected `avlToTradeWithoutMarginImpact`. This is the amount user can withdraw post-trade without incurring margin interest.

### API Requirements (confirmed via testing)

- **Orders**: REQUIRED — empty `orders: []` always returns 400 LWC_ERROR. No "baseline" call possible.
- **PriceList**: REQUIRED — empty `priceList: []` returns 400. Must include current positions with accurate prices.
- **Query shape**: Server whitelists the full GraphQL query. Simplified queries are rejected.
- **Page context**: NOT required — API works from any `digital.fidelity.com` page, not just the margin calculator.
- **Referrer**: Must be `https://digital.fidelity.com/ftgw/digital/margincalcex/` (set via `declarativeNetRequest` rules).

### Positions / PriceList

Positions are fetched from the portfolio GraphQL API (`/ftgw/digital/portfolio/api/graphql?ref_at=portsum`, operation `GetPositions`) and converted to priceList format.

**Price derivation from portfolio API** (critical — wrong prices = wildly wrong margin calculations):
- Equities/mutual funds: `price = mktVal / qty`
- Options: `price = mktVal / (qty * 100)` (contract multiplier)
- Bonds/T-bills: `price = (mktVal / qty) * 100` (per $100 face value)
- `longShortInd`: positive qty = LONG, negative = SHORT
- Option symbols: strip leading `-` (portfolio uses `-AAPL...`, priceList uses `AAPL...`)

### Architecture: Single-Call (no baseline)

Since empty orders = 400, the extension uses a single-call approach:
1. Fetch positions from portfolio API → build priceList (cached 5 min)
2. When trade detected: call margin calc with user's order + priceList
3. Show projected margin state; delta computed from previous cached result

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
  // 1. Get positions from portfolio API
  const posResp = await fetch('/ftgw/digital/portfolio/api/graphql?ref_at=portsum', {
    method: 'POST',
    headers: {'content-type': 'application/json', 'accept': '*/*'},
    credentials: 'include',
    body: JSON.stringify({
      operationName: 'GetPositions',
      variables: {acctList: [{acctNum: 'ACCT_NUM', acctType: 'Brokerage', acctSubType: 'Brokerage', preferenceDetail: false}]},
      query: POSITIONS_QUERY  // see lib/positions.js for full query
    })
  });
  // 2. Parse positions → build priceList (see lib/positions.js for conversion logic)
  // 3. Call margin calc with order + priceList
  const resp = await fetch('/ftgw/digital/margincalcex/api/graphql?op=GetTradeCalculator', {
    method: 'POST',
    headers: {'accept':'*/*','content-type':'application/json','apollographql-client-version':'0.0.0'},
    credentials: 'include',
    referrer: 'https://digital.fidelity.com/ftgw/digital/margincalcex/',
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
- Verify results against Fidelity's own Margin Calculator page (`/ftgw/digital/margincalcex/`) to validate accuracy

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
