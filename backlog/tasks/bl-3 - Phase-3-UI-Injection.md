---
id: BL-3
title: 'Phase 3: UI Injection'
status: Done
assignee: []
created_date: '2026-04-16 06:07'
updated_date: '2026-04-16 06:11'
labels: []
dependencies:
  - BL-2
references:
  - trade-popup-html.example
  - trade-options.html.sample
priority: high
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Inject margin impact information panel into Fidelity's trade ticket UI next to the Max Gain / Max Loss / Break Even row. Panel shows projected margin credit/debit, cash withdrawable without margin, wiggle room, and credit/debit status with visual indicators. Must match Fidelity's existing design language.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 injector.js locates ott-max-gain-loss .max-gain-loss-container (#mxregin) in DOM
- [ ] #2 Injects margin info panel with: green/red credit/debit indicator, projected amount, cash withdrawable, wiggle room
- [ ] #3 Shows loading and error states gracefully
- [ ] #4 styles.css matches Fidelity's existing UI design (fonts, colors, spacing)
- [ ] #5 Panel updates when margin calc results change
- [ ] #6 Panel removed/hidden when trade ticket closes
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
## Phase 3: UI Injection — Implementation Plan

### 1. DOM Location & Injection Strategy

**Target element (both popup and dedicated page):**
- Selector: `ott-max-gain-loss .max-gain-loss-container` (element has `id="mxregin"`)
- Parent hierarchy: `ott-order-details-row > .option-form-row.optional-items > .form-item-container.ott-max-gain-loss > ott-max-gain-loss.max-gain-loss-feature > #mxregin.max-gain-loss-container`

**Injection method:**
- Use `insertAdjacentElement('afterend', panel)` on the `#mxregin` container to place our margin info panel directly after the Max Gain / Max Loss / Break Even row, still inside the `ott-max-gain-loss` custom element
- Alternative: append a new `div.form-item-container` as a sibling after `.ott-max-gain-loss` inside `.optional-items` — this keeps it at the same layout level as the other form items
- **Recommended approach:** Insert a new row AFTER the `#mxregin` div, inside the `ott-max-gain-loss` element. This keeps it visually grouped with the gain/loss info and avoids disrupting Fidelity's form layout. The `ott-max-gain-loss` element already has conditional content (`<!----><!---->` comment nodes after `#mxregin`), so appending here is safe.

**Finding the target:**
```js
// Primary: works on both popup and dedicated page
const target = document.querySelector('#mxregin');
// Fallback: broader selector
const target = document.querySelector('ott-max-gain-loss .max-gain-loss-container');
```

**MutationObserver strategy:**
- Observe `document.body` with `{ childList: true, subtree: true }` for the appearance of `#mxregin`
- When detected, inject the panel
- Also observe for removal (ticket close) to clean up

### 2. Panel HTML Structure

```html
<div id="fmc-margin-panel" class="fmc-margin-panel" data-fmc-state="loading">
  <!-- Row matching the max-gain-loss-container flex layout -->
  <div class="fmc-margin-row">

    <!-- Column 1: Margin Credit/Debit status -->
    <div class="fmc-col">
      <span class="fmc-header">Margin Credit/Debit</span>
      <span class="fmc-value fmc-status-credit" data-fmc-field="marginCreditDebit">
        $1,203.99
      </span>
      <span class="fmc-delta" data-fmc-field="delta">
        +$150.00 from current
      </span>
    </div>

    <!-- Column 2: Cash Withdrawable -->
    <div class="fmc-col">
      <span class="fmc-header">Cash Withdrawable</span>
      <span class="fmc-value" data-fmc-field="cashWithdrawable">
        $1,203.99
      </span>
      <span class="fmc-sublabel">without margin interest</span>
    </div>

    <!-- Column 3: Wiggle Room -->
    <div class="fmc-col fmc-col-last">
      <span class="fmc-header">Wiggle Room</span>
      <span class="fmc-value fmc-status-safe" data-fmc-field="wiggleRoom">
        $1,203.99
      </span>
      <span class="fmc-sublabel">before margin interest</span>
    </div>

  </div>

  <!-- Loading state overlay -->
  <div class="fmc-loading" style="display: none;">
    <span class="fmc-spinner"></span>
    <span class="fmc-loading-text">Calculating margin impact...</span>
  </div>

  <!-- Error state overlay -->
  <div class="fmc-error" style="display: none;">
    <span class="fmc-error-icon">&#9888;</span>
    <span class="fmc-error-text" data-fmc-field="errorMsg">Unable to calculate</span>
    <button class="fmc-retry-btn">Retry</button>
  </div>

  <!-- Attribution / branding -->
  <div class="fmc-attribution">
    <span class="fmc-ext-badge">Margin Calc</span>
  </div>
</div>
```

**Data attributes for JS updates:**
- `data-fmc-state`: `"loading"` | `"result"` | `"error"` — controls which overlay is visible
- `data-fmc-field="marginCreditDebit"` — projected marginCreditDebit value
- `data-fmc-field="delta"` — change from current balance
- `data-fmc-field="cashWithdrawable"` — cash withdrawable without margin
- `data-fmc-field="wiggleRoom"` — room before crossing into debit
- `data-fmc-field="errorMsg"` — error message text

### 3. Information to Display

| Field | Source | Display |
|-------|--------|---------|
| Projected Margin Credit/Debit | `balance.marginCreditDebit` | Dollar amount, green if positive (credit), red if negative (debit) |
| Delta from Current | Computed: projected minus current `marginCreditDebit` | "+$X" or "-$X" with directional color |
| Wiggle Room | If credit: equals `marginCreditDebit`; if debit: shows how far into debit | Dollar amount with status indicator |
| Cash Withdrawable | `marginCreditDebit` when positive, else $0 | Dollar amount — how much cash can be withdrawn post-settlement without incurring interest |
| Credit/Debit Status | Sign of `marginCreditDebit` | Text label "CREDIT" or "DEBIT" with color coding |

### 4. Color Coding Strategy

Based on Fidelity's existing color palette extracted from HTML samples:

| Status | Color | Fidelity Precedent | Usage |
|--------|-------|---------------------|-------|
| Credit / Safe | `#368727` (Fidelity green) | Used in `.green-text`, icons, switches, loading spinner | marginCreditDebit > 0, positive delta |
| Debit / Danger | `#c81818` or `#d32f2f` (Fidelity red) | Used in negative indicators | marginCreditDebit < 0, negative delta |
| Warning / Close to threshold | `#b8860b` (dark goldenrod) or `#e67e22` (orange) | Not native to Fidelity; use sparingly | marginCreditDebit is positive but < $500 (configurable threshold) |
| Neutral / Loading | `#333333` | Standard text color throughout Fidelity UI | Loading states, labels, headers |
| Muted / Sublabel | `#717171` or `#999` | Used in secondary text, error icons | Sublabels, attribution |

**CSS classes:**
- `.fmc-status-credit` — green text and optional left border
- `.fmc-status-debit` — red text and optional left border
- `.fmc-status-warning` — amber/orange text for near-threshold
- `.fmc-status-safe` — green for ample wiggle room

**Threshold logic (in injector.js):**
```
if marginCreditDebit > 500:  status = "credit" (green)
if 0 < marginCreditDebit <= 500:  status = "warning" (amber)
if marginCreditDebit <= 0:  status = "debit" (red)
```
The $500 threshold should be configurable via extension settings.

### 5. Loading State UI

**Approach:** Simple text-based indicator with a small CSS spinner (matching Fidelity's `loading-indicator` aesthetic but much smaller). No skeleton screen — the panel area is small enough that a centered spinner with text is cleaner.

```html
<div class="fmc-loading">
  <span class="fmc-spinner"></span>
  <span class="fmc-loading-text">Calculating margin impact...</span>
</div>
```

**CSS spinner:** 16px circular border-based spinner using Fidelity's green (`#368727` / `#6F9824`), matching their `loading-indicator__orb` color scheme. Pure CSS animation, no images.

**Behavior:**
- Show immediately when trade parameters change and API call begins
- Hide and reveal results when response arrives
- If request takes >5s, update text to "Still calculating..."

### 6. Error State UI

Three error categories with distinct messaging:

| Error Type | Detection | Message | Action |
|------------|-----------|---------|--------|
| Session Expired | HTTP 401/403, or redirect response | "Session expired. Please refresh the page." | No retry button; show refresh link |
| API Error | HTTP 5xx, network error, malformed response | "Unable to calculate margin impact." | Show retry button |
| No Data | API returns null/empty balance | "No margin data available for this account." | No retry; informational only |
| Rate Limited | Too many requests in short window | "Please wait before recalculating." | Auto-retry after cooldown with countdown |

**Error panel structure:**
```html
<div class="fmc-error">
  <span class="fmc-error-icon">&#9888;</span>
  <span class="fmc-error-text">Unable to calculate margin impact.</span>
  <button class="fmc-retry-btn">Retry</button>
</div>
```

**Styling:** Warning icon in `#717171` (matching Fidelity's error component color from `.retry-component .error-component .icon`), text in `#333`, retry button styled like Fidelity's `.retry-button` (simple outlined button).

### 7. Ticket Close Detection & Cleanup

**Popup ticket (`#trade-container-shell`):**
- Monitor `#trade-container-shell` for `style` attribute changes (specifically `display: none` or removal)
- The close button is `.float-trade-container-close.dialog-close` — can listen for click on this as a secondary signal
- When `#trade-container-shell` disappears or gets `display: none`, remove `#fmc-margin-panel`

**Dedicated page (`/ftgw/digital/trade-options`):**
- Monitor for navigation away (SPA route change) using `MutationObserver` on `body` class changes or `popstate` events
- When `body.option-trade-ticket` class is removed, clean up

**Cleanup function:**
```js
function cleanupMarginPanel() {
  const panel = document.getElementById('fmc-margin-panel');
  if (panel) panel.remove();
  // Disconnect any active observers
  // Clear any pending API request timers
}
```

**MutationObserver pattern:**
- One top-level observer watches for `#mxregin` appearance/disappearance
- On appearance: inject panel, start listening for trade parameter changes
- On disappearance: call `cleanupMarginPanel()`, stop parameter listeners
- Use `WeakRef` or flags to avoid duplicate injection if observer fires multiple times

### 8. CSS Approach — Matching Fidelity's Design Language

**Font stack (from samples):**
- Primary: `"Fidelity Sans", Roboto, Arial, sans-serif` (Fidelity's custom font, falls back gracefully)
- Values/numbers: same font, slightly bolder weight

**Extracted design tokens from HTML samples:**
- Text color: `#333333` (primary), `#717171` (secondary), `#999` (disabled)
- Background: `#ffffff` (white), `#f5f5f5` (light gray for hover/alt rows)
- Borders: `#e9e9e9` (light dividers), `#ccc` (input borders)
- Green (positive/credit): `#368727`
- Link blue: `#0E67A9`
- Font sizes: 12px (labels), 14px (values), 11px (sublabels/metadata)
- Border radius: minimal — Fidelity uses sharp corners (`border-radius: 0` or `2px`)
- Spacing: 8px/12px/16px increments

**Layout approach:**
- Match the `#mxregin .max-gain-loss-container` flex layout: `display: flex; justify-content: space-between;`
- Each column uses `.max-gain-loss-col` pattern: `flex: 1; text-align: center;`
- Last column gets `flex: 1; text-align: center;` with no right border
- Header links are `font-size: 12px; color: #0E67A9; text-decoration: underline;`
- Data values are `font-size: 14px; font-weight: 500;`

**CSS isolation:**
- Prefix all classes with `fmc-` to avoid collisions with Fidelity's styles
- Do NOT use Shadow DOM (would break Fidelity's inherited font-face definitions)
- Use specific selectors: `#fmc-margin-panel .fmc-*`
- Load styles via `styles.css` injected by manifest.json content_scripts

**Visual design:**
- Add a subtle top border (`1px solid #e9e9e9`) to separate from the max gain/loss row
- Small `4px` top/bottom padding
- Optional: very subtle background tint (`rgba(54, 135, 39, 0.03)` for credit, `rgba(200, 24, 24, 0.03)` for debit) to make the panel stand out without being jarring
- Small "Margin Calc" badge in bottom-right corner (10px, `#999` color) so user knows this is from the extension

### 9. Popup vs. Dedicated Page Differences

| Aspect | Floating Popup | Dedicated Page |
|--------|---------------|----------------|
| Detection | `#trade-container-shell[style*="display: block"]` + `#float_trade_O[style*="display: block"]` | `body.option-trade-ticket` |
| Container class | `ott-float-container pad-view` | `phone-view` (no float container) |
| Width constraint | Popup is ~500px wide in "middle" mode, ~300px in "normal" mode | Full page width |
| Layout adjustment | May need to stack columns vertically in "normal" (phone) mode | Always horizontal |
| Close detection | `.float-trade-container-close` click or `display: none` | Page navigation / SPA route change |
| `#mxregin` location | Same Angular component, same selectors | Same Angular component, same selectors |
| Next-steps sibling | `ott-next-steps.trade.ott-float-container.pad-view` with `.estimated-info` inline | `ott-next-steps.phone-view` with block layout |

**Key finding:** The `#mxregin` element and its parent `ott-max-gain-loss` use IDENTICAL markup and selectors in both contexts. The same injection code works for both — no branching needed for the injection itself. Only the close-detection and responsive layout need context awareness.

**Responsive handling:**
- In popup "normal" (narrow) mode, the max-gain-loss columns already stack. Our panel should do the same via CSS:
  ```css
  @container (max-width: 400px) { /* or media query */
    .fmc-margin-row { flex-direction: column; }
    .fmc-col { text-align: left; border-bottom: 1px solid #e9e9e9; }
  }
  ```
- The popup has three size modes: normal (phone), middle (pad), maxmax (desktop) — controlled by buttons `.float-trade-container-normal`, `.float-trade-container-middle`, `.float-trade-container-maxmax`. We should handle all three gracefully.

### 10. Update Flow

1. `detector.js` sends trade parameters to `background.js`
2. `background.js` calls margin API via `margin-api.js`
3. `background.js` sends results back to content script
4. `injector.js` receives results and calls `updatePanel(data)`:
   - Set `data-fmc-state="result"` on `#fmc-margin-panel`
   - Update each `data-fmc-field` element's text content
   - Apply appropriate `fmc-status-*` classes based on values
   - Show/hide delta if current balance is available for comparison
5. On new trade parameter change: set `data-fmc-state="loading"`, repeat from step 1
6. On ticket close: call `cleanupMarginPanel()`

### 11. Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `content/injector.js` | Create | Panel injection, update, cleanup, MutationObserver |
| `content/styles.css` | Create | All panel styles, responsive layouts, animations |
| `manifest.json` | Modify | Add `styles.css` to `content_scripts[].css` |
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
## Design Observations from HTML Samples

### DOM Structure Findings

1. **Identical injection target in both contexts:** The `ott-max-gain-loss` custom element with `#mxregin` child uses the exact same Angular component (`_nghost-ng-c1494849532`) and class structure in both the floating popup (`trade-popup-html.example`) and dedicated page (`trade-options.html.sample`). This greatly simplifies implementation — one injection path serves both.

2. **Angular component boundary:** The `ott-max-gain-loss` element is a self-contained Angular component. Injecting after `#mxregin` but still inside this component avoids Angular's change detection potentially removing our injected content. However, if Angular re-renders the component, we may lose our panel — the MutationObserver must watch for this and re-inject.

3. **Conditional rendering markers:** After `#mxregin`, there are Angular comment nodes (`<!----><!---->`) suggesting conditional content that Fidelity may render in certain states. Our injection should go AFTER these comments (use `appendChild` on `ott-max-gain-loss` rather than `insertAfter` on `#mxregin`) to avoid conflicts.

4. **The `.max-gain-loss-col` pattern:** The existing columns use `flex: 1` with a `.last` class on the final column. Our panel should replicate this three-column layout to feel native. The existing columns show: header (link with underline), value (span with `.positive`/`.negative` class), optional subtext.

5. **Color classes already in use:** Fidelity uses `.positive` (green) and `.negative` (red) on `.max-gain-loss-data` spans. We should NOT reuse these class names to avoid CSS conflicts — our `fmc-status-credit`/`fmc-status-debit` prefixed classes are safer.

### Fidelity Design Language

- **Minimal ornamentation:** Fidelity's UI is clean, no shadows, no gradients, minimal border-radius. Our panel should match.
- **Green is king:** `#368727` is used everywhere — switches, icons, links, loading spinners. This is the primary accent color.
- **Information density:** The trade ticket packs a lot of info into small space. Our panel should be compact (no excessive padding).
- **Link-style headers:** Max Gain/Max Loss/Break Even headers are styled as links (`<a>` tags with `title` tooltips). Our headers can be plain text but should use the same font size (12px) and color (`#0E67A9` for interactive, `#333` for static).
- **Error patterns:** Fidelity uses a `.retry-component` with icon + description + retry button. Simple and functional. Our error state should follow this same minimal pattern.

### UX Considerations

1. **Don't block the Preview button:** The margin panel is informational. It should never prevent the user from clicking "Preview Order". Even in error state, the panel should be dismissible or non-blocking.

2. **Performance:** The panel injects into a live Angular SPA. DOM mutations should be minimal — update text content of existing elements rather than replacing innerHTML on each update. This avoids triggering Angular's change detection or layout thrashing.

3. **Visual hierarchy:** The margin panel is supplementary info, not primary. It should be visually subordinate to the Max Gain/Loss row. A slightly muted background or reduced font weight can achieve this without hiding important data.

4. **Negative margin debit is the most critical state:** When `marginCreditDebit` goes negative, the user is about to incur interest charges. This should be the MOST visually prominent state — bold red value, possibly with a subtle red background tint. This is the primary value proposition of the extension.

5. **Wiggle room context:** Showing "wiggle room" as a standalone number isn't enough. Adding a sublabel like "before margin interest" gives context. For debit states, change to "currently in debit by $X".

6. **First-time experience:** When the panel first appears, users need to understand what it is. The small "Margin Calc" badge serves this purpose. A tooltip on hover could explain: "Projected margin impact from the Margin Calculator extension."

7. **Popup resize handling:** The floating trade ticket has three size modes (normal/middle/maxmax). In "normal" (narrowest), the max gain/loss columns already stack vertically. Our panel must handle this gracefully — test all three sizes.

8. **Stale data indicator:** If the user changes trade parameters but the API call hasn't completed yet, briefly dim the existing values (opacity: 0.5) while showing the loading spinner. This tells the user that displayed values are stale and new ones are incoming.
<!-- SECTION:NOTES:END -->
