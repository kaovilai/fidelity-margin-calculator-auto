// Money-market optimizer — adds an "Optimize" button next to money-market positions on the
// positions page. It reads Fidelity's current money-market yields (fund screener, via the
// background worker), computes each fund's AFTER-TAX yield for your tax situation, and suggests the
// best fund your balance actually qualifies for (minimum initial investment / minimum balance
// respected). Fidelity's "Cash Available to Withdraw" includes core AND other Fidelity money-market
// funds, so exchanging between them does not reduce it (collected funds only; the margin calculator
// does not accept money-market funds as orders, so this cannot be what-if tested). It can PRE-FILL Fidelity's mutual-fund exchange ticket for a suggested move, but
// never clicks Preview Order or submits: you review and submit yourself.
'use strict';
(() => {
  if (!location.pathname.includes('/portfolio/positions')) return;

  const log = makeDebugLog('[FMC-MMF]');
  const M = MmfModel;
  const { MESSAGE_TYPES, STORAGE_KEY_SETTINGS } = FMC_CONSTANTS;
  const PANEL_ID = 'fmc-mmf-panel';
  const BTN_CLASS = 'fmc-mmf-btn';
  const CALL_TIMEOUT_MS = 25000;

  let enabled = true;
  let observer = null;
  let scanTimer = null;
  let panel = null;
  const view = { ticker: null, account: null, reserve: 0, reserveEdited: false };
  let fillBusy = false;

  const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const fmt = (n) => (Number.isFinite(n) ? currency.format(n) : '--');
  const pct = (n) => `${n.toFixed(2)}%`;

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') node.className = v;
      else if (k === 'textContent') node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c) node.append(c);
    return node;
  }

  /** One request to the background worker with a generous timeout (these are real network fetches). */
  function ask(type, payload) {
    return new Promise((resolve) => {
      if (!chrome.runtime?.sendMessage) { resolve({ error: 'no runtime' }); return; }
      const timer = setTimeout(() => resolve({ error: 'timed out' }), CALL_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage({ type, payload, _fmc: true }, (resp) => {
          clearTimeout(timer);
          resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : (resp ?? { error: 'no response' }));
        });
      } catch (e) { clearTimeout(timer); resolve({ error: e.message }); }
    });
  }

  // --- Buttons on money-market rows ---
  /** The symbol cell of every money-market row in the pinned (left) grid section. */
  function mmfCells() {
    const out = [];
    for (const row of document.querySelectorAll('.ag-pinned-left-cols-container [role="row"]')) {
      const cell = row.querySelector('[col-id="sym"]');
      const ticker = cell?.innerText?.trim().split(/\s+/)[0];
      if (cell && ticker && M.MMF_TICKER_RE.test(ticker)) out.push({ row, cell, ticker });
    }
    return out;
  }

  /** Account number for a pinned row: the matching center-grid row (same aria-rowindex) shows it. */
  function accountFor(row) {
    const idx = row.getAttribute('aria-rowindex');
    const center = idx ? document.querySelector(`.ag-center-cols-container [aria-rowindex="${idx}"]`) : null;
    return /[A-Z]\d{8}/.exec(center?.innerText ?? '')?.[0] ?? null;
  }

  const FAB_ID = 'fmc-mmf-fab';

  /** Account number for the always-visible button: the URL hash (#ZXXXXXXXX) or the last-used account. */
  async function pageAccount() {
    const fromHash = /[A-Z]\d{8}/.exec(location.hash)?.[0];
    if (fromHash) return fromHash;
    try {
      const r = await chrome.storage.local.get([FMC_CONSTANTS.STORAGE_KEY_CHAIN_ACCOUNT, FMC_CONSTANTS.STORAGE_KEY_STATUS]);
      return r[FMC_CONSTANTS.STORAGE_KEY_STATUS]?.accountNum ?? r[FMC_CONSTANTS.STORAGE_KEY_CHAIN_ACCOUNT] ?? null;
    } catch { return null; }
  }

  /**
   * An always-visible "Optimize cash" button. Row buttons only exist for money-market rows that are
   * rendered (the grid is virtualized) and the core fund usually has no row at all, so this makes the
   * optimizer reachable regardless of scrolling.
   */
  function ensureFab() {
    if (document.getElementById(FAB_ID)) return;
    const fab = el('button', { id: FAB_ID, type: 'button', className: BTN_CLASS, textContent: 'Optimize cash', title: 'Find the best after-tax money-market fund for this account (read-only until you click Fill ticket)' });
    fab.addEventListener('click', async () => open(null, await pageAccount()));
    document.body.append(fab);
  }

  function scan() {
    if (!enabled) return;
    ensureFab();
    const live = new Set();
    for (const { row, cell, ticker } of mmfCells()) {
      const wrapper = cell.querySelector('.ag-cell-wrapper') ?? cell;
      let btn = wrapper.querySelector(`.${BTN_CLASS}`);
      if (btn && btn.dataset.ticker !== ticker) { btn.remove(); btn = null; } // ag-grid recycled the row
      if (!btn) {
        btn = el('button', { type: 'button', className: BTN_CLASS, textContent: 'Optimize', title: 'Find the best after-tax money-market fund for this balance (read-only)' });
        btn.dataset.ticker = ticker;
        btn.addEventListener('click', (ev) => { ev.stopPropagation(); open(ticker, accountFor(row)); });
        wrapper.append(btn);
      }
      live.add(btn);
    }
    for (const b of document.querySelectorAll(`.${BTN_CLASS}:not(#${FAB_ID})`)) if (!live.has(b)) b.remove();
  }

  function schedule() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 300);
  }

  // --- Plan ---
  /** Dollars by money-market ticker (NAV is $1.00, so shares == dollars). */
  function mmfHoldings(holdings) {
    const out = {};
    for (const [sym, shares] of Object.entries(holdings)) if (M.MMF_TICKER_RE.test(sym) && shares > 0) out[sym] = shares;
    return out;
  }

  async function compute() {
    const { account, reserve } = view;
    const out = { error: null };
    if (!account) { out.error = 'Could not determine the account for this row.'; return out; }
    await TaxContext.ready();
    const [status, fundsResp] = await Promise.all([PositionsAPI.fetchStatus(account), ask(MESSAGE_TYPES.FETCH_MMF_YIELDS)]);
    if (fundsResp.error) { out.error = `Could not load money-market yields (${fundsResp.error}).`; return out; }
    const funds = M.parseFunds(fundsResp);
    const holdings = mmfHoldings(status.holdings);
    const total = Object.values(holdings).reduce((sum, d) => sum + d, 0);
    const bal = status.baselineData?.data?.getTradeCalculator?.marginCalcResp?.balance;
    const withdrawable = Number(bal?.avlToTradeWithoutMarginImpact);
    // Fidelity's "Cash Available to Withdraw" counts core AND other Fidelity money-market funds, so
    // exchanging between them does not reduce it (collected funds only). Nothing is held back by default.
    const lockedDefault = 0;
    if (!view.reserveEdited) view.reserve = lockedDefault;
    out.rates = TaxContext.rates();
    out.holdings = holdings;
    out.total = total;
    out.withdrawable = withdrawable;
    out.lockedDefault = lockedDefault;
    out.byTicker = new Map(funds.map(f => [f.ticker, f]));
    out.minGap = Number.isFinite(Number(TaxContext.settings.mmfMinGap)) ? Number(TaxContext.settings.mmfMinGap) : FMC_CONSTANTS.DEFAULT_SETTINGS.mmfMinGap;
    out.plan = M.plan({ funds, holdings, rates: out.rates, reserve: view.reserve, minGap: out.minGap });
    return out;
  }

  // --- Fill Fidelity's exchange ticket (never submits) ---
  const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));
  // getClientRects (not offsetParent, which is null for fixed-position overlays such as dropdowns).
  const visible = (e) => !!e && e.getClientRects().length > 0;

  async function waitFor(fn, timeout = 6000, step = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn();
      if (v) return v;
      await sleepMs(step);
    }
    return null;
  }

  /** Sets an input's value the way a user typing would, so Angular's forms see it. */
  function setValue(input, value) {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** A full pointer sequence — Fidelity's custom dropdown options ignore a bare script `.click()`. */
  function realClick(el) {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  /** Clicks the visible option (role=option) whose text matches, within an optional scope. */
  function clickOption(re, scope = document) {
    const opt = [...scope.querySelectorAll('[role="option"]')].find(o => visible(o) && re.test(o.innerText.trim()));
    if (!opt) return false;
    realClick(opt);
    return true;
  }

  /** Opens a custom dropdown button and picks an option by text. */
  async function pickDropdown(button, optionRe) {
    button.click();
    const ok = await waitFor(() => [...document.querySelectorAll('[role="option"]')].some(o => visible(o) && optionRe.test(o.innerText.trim())), 3000);
    if (!ok) return false;
    clickOption(optionRe);
    await sleepMs(400);
    return true;
  }

  /**
   * Opens Fidelity's mutual-fund ticket, selects Exchange, and fills account check, fund to sell,
   * dollar amount and fund to buy. Stops there — it never clicks Preview Order.
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  async function fillExchangeTicket({ account, from, to, dollars }) {
    // Floor to whole cents with a tiny epsilon: 2334.99 * 100 is 233498.99999999997 in floating point.
    const amount = (Math.floor(dollars * 100 + 1e-6) / 100).toFixed(2);
    try {
      // 1. Always start from a FRESH ticket. A finished order leaves the ticket on its confirmation
      //    screen ("Order received" / "Enter new order") with no Action dropdown, and an earlier fill
      //    leaves a half-filled form — so close it and reopen it every time.
      const shellEl = () => document.querySelector('#trade-container-shell');
      // The shell element stays in the DOM when closed; it only has content while a ticket is open.
      const ticketOpen = () => visible(shellEl()) && (shellEl()?.innerText ?? '').trim().length > 0;
      if (ticketOpen()) {
        const closeBtn = [...shellEl().querySelectorAll('button')].find(x => /Close window/i.test(x.getAttribute('aria-label') || x.title || x.innerText || ''));
        if (closeBtn) { realClick(closeBtn); await waitFor(() => !ticketOpen(), 4000); await sleepMs(600); }
      }
      const tradeBtn = [...document.querySelectorAll('nav[aria-label="Action bar"] button, [aria-label="Action bar"] button')].find(x => /^\s*Trade\s*$/i.test(x.innerText));
      if (!tradeBtn) return { ok: false, message: "Couldn't find Fidelity's Trade button — open the ticket yourself and try again." };
      tradeBtn.click();
      if (!await waitFor(() => ticketOpen(), 6000)) return { ok: false, message: 'The trade ticket did not open.' };

      // 2. Mutual Funds → Exchange. Decide by the TRADE dropdown's own label, not by whether a (possibly
      //    stale, about-to-be-replaced) mutual-fund form is visible, and let a reopened ticket settle first.
      await sleepMs(1800);
      const tradeTypeBtn = () => [...(shellEl()?.querySelectorAll('button') ?? [])].find(x => visible(x) && /^TRADE\b/i.test(x.innerText.trim()));
      const onMutualFunds = () => /Mutual Funds/i.test(tradeTypeBtn()?.innerText ?? '') && visible(document.querySelector('#float_trade_MF'));
      if (!onMutualFunds()) {
        const typeBtn = await waitFor(tradeTypeBtn, 4000);
        if (!typeBtn || !await pickDropdown(typeBtn, /^Mutual Funds$/i)) return { ok: false, message: "Couldn't switch the ticket to Mutual Funds." };
        if (!await waitFor(onMutualFunds, 6000)) return { ok: false, message: 'The mutual fund ticket did not appear.' };
        await sleepMs(800);
      }
      let root = document.querySelector('#float_trade_MF'); // re-read after a ticket reset (the form can be re-created)
      const buttons = () => [...root.querySelectorAll('button')].filter(visible);
      const findAction = () => buttons().find(b => /^(ACTION\s*)?(Action|Buy|Sell|Exchange|Buy Recurring)\b/i.test(b.innerText.trim()) && !/TRADE|ACCOUNT/i.test(b.innerText));
      const actionBtn = await waitFor(findAction, 6000);
      if (!actionBtn) return { ok: false, message: "Couldn't find the Action dropdown." };
      await sleepMs(1200); // a freshly (re)opened form is still settling; re-query the button below
      let picked = /Exchange/i.test((findAction() ?? actionBtn).innerText);
      if (!picked) picked = await pickDropdown(findAction() ?? actionBtn, /^Exchange$/i);
      if (!picked) { await sleepMs(1200); const retry = findAction(); picked = !!retry && await pickDropdown(retry, /^Exchange$/i); }
      if (!picked) return { ok: false, message: "Couldn't select Exchange." };
      if (!await waitFor(() => root.querySelector('input[id="mf-ticket-dest-symbol-Fund to Sell"]'), 5000)) return { ok: false, message: 'The Exchange form did not appear.' };

      // 3. Account must already match — never guess which account to trade in.
      // The account label can still be loading right after the form appears — wait for it.
      const acctReady = await waitFor(() => {
        const b = buttons().find(x => /^ACCOUNT\b/i.test(x.innerText.trim()));
        return b && /\([A-Z]?\d{8,9}\)/.test(b.innerText) ? b : null;
      }, 6000);
      if (!acctReady || !acctReady.innerText.includes(account)) {
        return { ok: false, message: `The ticket is set to a different account than ${account}${acctReady ? ` (${acctReady.innerText.replace(/\s+/g, ' ').trim()})` : ''}. Switch the account in the ticket, then click again.` };
      }

      // 4. Fund to sell, dollars, fund to buy.
      const fillFund = async (id, ticker) => {
        const input = root.querySelector(`input[id="${id}"]`);
        if (!input) return false;
        setValue(input, ticker);
        await waitFor(() => [...document.querySelectorAll('[role="option"]')].some(o => visible(o) && new RegExp(`\\b${ticker}\\b`).test(o.innerText)), 4000);
        clickOption(new RegExp(`\\b${ticker}\\b`));
        await sleepMs(500);
        return true;
      };
      if (!await fillFund('mf-ticket-dest-symbol-Fund to Sell', from)) return { ok: false, message: "Couldn't fill Fund to Sell." };

      // The core (sweep) fund can't be exchanged out — Fidelity debits it when you BUY something.
      // Then the right action is a Buy of the target, funded from core cash.
      const classify = () => {
        if (root.querySelector('#mf-shared-quantity') && visible(root.querySelector('#mf-shared-quantity'))) return 'exchange';
        if (/can't be traded directly|cannot be traded directly/i.test(root.innerText)) return 'core';
        return null;
      };
      let which = await waitFor(classify, 5000);
      if (!which) {
        // After a (non-core) fund is chosen the form can reset its Action dropdown to unselected —
        // pick Exchange again so the quantity and Fund to Buy fields appear.
        const again = findAction();
        if (again) await pickDropdown(again, /^Exchange$/i);
        which = await waitFor(classify, 8000);
      }
      if (which === 'core') return await fillBuy();
      if (which !== 'exchange') return { ok: false, message: "Couldn't find the Quantity field." };

      setValue(root.querySelector('#mf-shared-quantity'), amount);
      await sleepMs(300);
      if (!await fillFund('mf-ticket-dest-symbol-Fund to Buy', to)) return { ok: false, message: "Couldn't fill Fund to Buy." };

      // Read back what Fidelity's form actually holds.
      const read = (id) => root.querySelector(`input[id="${id}"]`)?.value ?? '';
      const sellVal = read('mf-ticket-dest-symbol-Fund to Sell'), buyVal = read('mf-ticket-dest-symbol-Fund to Buy'), qtyVal = root.querySelector('#mf-shared-quantity')?.value ?? '';
      const ok = sellVal.toUpperCase().includes(from) && buyVal.toUpperCase().includes(to) && Number(String(qtyVal).replace(/[$,]/g, '')) === Number(amount);
      return { ok, message: ok
        ? `Filled: exchange $${amount} from ${from} into ${to}. Review it in Fidelity's ticket and click Preview Order yourself.`
        : `Filled partially (sell: "${sellVal}", amount: "${qtyVal}", buy: "${buyVal}"). Check the ticket before continuing.` };

      /** Buy ticket for the target, paid from core cash (used when the source is the core fund). */
      async function fillBuy() {
        // Entering the core fund leaves the form without its Action dropdown — reinitialize it by
        // switching the ticket type away and back.
        const typeBtn = buttons().find(x => /^TRADE/i.test(x.innerText.trim()));
        if (!typeBtn || !await pickDropdown(typeBtn, /^Stocks\/ETFs$/i)) return { ok: false, message: `${from} is your core fund and can't be exchanged directly; the ticket couldn't be reset to switch to a Buy.` };
        await sleepMs(1500);
        const back = await waitFor(() => document.querySelector('#dest-dropdownlist-button-trade'), 4000);
        if (!back || !await pickDropdown(back, /^Mutual Funds$/i)) return { ok: false, message: 'The ticket could not return to Mutual Funds.' };
        if (!await waitFor(() => visible(document.querySelector('#float_trade_MF')), 6000)) return { ok: false, message: 'The mutual fund ticket did not reappear.' };
        root = document.querySelector('#float_trade_MF');
        const act = await waitFor(findAction, 6000);
        if (!act || !await pickDropdown(act, /^Buy$/i)) return { ok: false, message: `${from} is your core fund and can't be exchanged directly, and the Buy action couldn't be selected.` };
        if (!await waitFor(() => root.querySelector('input[id="mf-ticket-dest-symbol-Symbol"]'), 5000)) return { ok: false, message: 'The Buy form did not appear.' };
        if (!await fillFund('mf-ticket-dest-symbol-Symbol', to)) return { ok: false, message: "Couldn't fill the fund to buy." };
        const qtyField = () => { const e = root.querySelector('#mf-shared-quantity'); return visible(e) ? e : null; };
        let q = await waitFor(qtyField, 4000);
        if (!q) {
          // The default Buy only commits once it is clicked again after the fund is chosen.
          const again = findAction();
          if (again) await pickDropdown(again, /^Buy$/i);
          q = await waitFor(qtyField, 7000);
        }
        if (!q) return { ok: false, message: "Couldn't find the Quantity field on the Buy ticket." };
        setValue(q, amount);
        await sleepMs(400);
        const buyVal = root.querySelector('input[id="mf-ticket-dest-symbol-Symbol"]')?.value ?? '';
        const qtyVal = q.value ?? '';
        const ok = buyVal.toUpperCase().includes(to) && Number(String(qtyVal).replace(/[$,]/g, '')) === Number(amount);
        return { ok, message: ok
          ? `${from} is your core fund (can't be exchanged), so this is a BUY of $${amount} of ${to} paid from core cash. Review it in Fidelity's ticket and click Preview Order yourself.`
          : `Filled partially (buy: "${buyVal}", amount: "${qtyVal}"). Check the ticket before continuing.` };
      }
    } catch (err) {
      log('fill failed:', err);
      return { ok: false, message: `Could not fill the ticket (${err?.message || 'unknown error'}).` };
    }
  }

  // --- Panel ---
  function closePanel() { panel?.remove(); panel = null; }

  function row(label, value, cls) {
    return el('div', { className: 'fmc-mmf-row' }, el('span', { textContent: label }), el('span', { className: cls ?? '', textContent: value }));
  }

  async function open(ticker, account) {
    view.ticker = ticker; view.account = account;
    closePanel();
    panel = el('div', { id: PANEL_ID, role: 'dialog', 'aria-label': 'Money-market optimizer' });
    document.body.append(panel);
    render({ loading: true });
    try { render(await compute()); } catch (err) { log('compute failed:', err); render({ error: err?.message || 'Something went wrong.' }); }
  }

  function render(res) {
    if (!panel) return;
    panel.replaceChildren();
    const close = el('button', { type: 'button', className: 'fmc-mmf-close', textContent: '✕', 'aria-label': 'Close' });
    close.addEventListener('click', closePanel);
    panel.append(el('div', { className: 'fmc-mmf-head' }, el('strong', { textContent: `Optimize cash${view.account ? ` — ${view.account}` : ''}` }), close));
    if (res.loading) { panel.append(el('div', { className: 'fmc-mmf-note', textContent: 'Loading yields, tax rates and balances…' })); return; }
    if (res.error) { panel.append(el('div', { className: 'fmc-mmf-note fmc-mmf-bad', textContent: res.error })); return; }

    const r = res.rates;
    const taxErr = TaxContext.lastError();
    panel.append(el('div', { className: 'fmc-mmf-note', textContent: `After-tax at ${r.federal}% federal (${r.federalSource}) + ${r.state}% ${r.stateCode} (${r.stateSource}). Yields are 7-day, from Fidelity's fund screener.${taxErr ? ` Live tax rates unavailable (${taxErr}).` : ''}` }));

    // Current holdings
    const sec = el('div', { className: 'fmc-mmf-sec' }, el('div', { className: 'fmc-mmf-title', textContent: 'Your money-market balances' }));
    const entries = Object.entries(res.holdings);
    if (entries.length === 0) sec.append(el('div', { className: 'fmc-mmf-note', textContent: 'No money-market positions found in this account.' }));
    for (const [t, d] of entries) {
      const f = res.byTicker.get(t);
      const at = f ? M.afterTax(f, r) : null;
      sec.append(row(`${t}${t === view.ticker ? '  ◀' : ''}`, `${fmt(d)}${at !== null ? ` · ${pct(at)} after tax` : ''}`));
    }
    panel.append(sec);

    // Reserve input
    const reserveIn = el('input', { type: 'number', min: '0', step: '100', value: String(view.reserve), 'aria-label': 'Dollars to keep where they are' });
    reserveIn.addEventListener('change', () => { view.reserve = Math.max(0, Number(reserveIn.value) || 0); view.reserveEdited = true; open(view.ticker, view.account); });
    panel.append(el('label', { className: 'fmc-mmf-reserve' }, 'Keep in place ($) ', reserveIn));

    // Recommendation
    const plan = res.plan;
    const rec = el('div', { className: 'fmc-mmf-sec' }, el('div', { className: 'fmc-mmf-title', textContent: 'Suggestion' }));
    if (!plan.target) {
      rec.append(el('div', { className: 'fmc-mmf-note', textContent: `Nothing worth moving: no fund you qualify for beats your balances by at least ${res.minGap.toFixed(2)} points after tax (change the minimum gap in the extension settings).` }));
    } else {
      const moves = plan.moves;
      const total = plan.amountIn;
      rec.append(row(`Move into ${plan.target.ticker}`, `${fmt(total)} · ${pct(plan.target.afterTax)} after tax`, 'fmc-mmf-good'));
      for (const m of moves) {
        const fillBtn = el('button', { type: 'button', className: 'fmc-mmf-fill', textContent: 'Fill ticket', title: `Fill Fidelity's exchange ticket: sell ${fmt(m.dollars)} of ${m.from}, buy ${plan.target.ticker}. You review and submit.` });
        const status = el('div', { className: 'fmc-mmf-note' });
        fillBtn.addEventListener('click', async () => {
          // One fill at a time: two interleaved runs would close/reopen the ticket under each other.
          if (fillBusy) { status.textContent = 'Another ticket fill is still running — wait for it to finish.'; return; }
          fillBusy = true;
          const allFill = [...document.querySelectorAll('.fmc-mmf-fill')];
          for (const b of allFill) b.disabled = true;
          status.className = 'fmc-mmf-note'; status.textContent = 'Filling…';
          let r;
          try { r = await fillExchangeTicket({ account: view.account, from: m.from, to: plan.target.ticker, dollars: m.dollars }); }
          finally { fillBusy = false; for (const b of allFill) b.disabled = false; }
          status.textContent = r.message;
          status.className = `fmc-mmf-note ${r.ok ? 'fmc-mmf-good' : 'fmc-mmf-bad'}`;
        });
        rec.append(el('div', { className: 'fmc-mmf-row' }, el('span', { textContent: `  from ${m.from}` }), el('span', { textContent: fmt(m.dollars) }), fillBtn), status);
      }
      rec.append(row('Estimated gain', `+${fmt(plan.annualGain)}/yr`, 'fmc-mmf-good'));
      if (plan.target.minInitial > 0 || plan.target.minBalance > 0) {
        rec.append(el('div', { className: 'fmc-mmf-note', textContent: `${plan.target.ticker} minimums: ${fmt(plan.target.minInitial)} to open, ${fmt(plan.target.minBalance)} balance — this amount qualifies.` }));
      }
      rec.append(el('div', { className: 'fmc-mmf-note', textContent: "Cash Available to Withdraw counts core and other Fidelity money-market funds, so exchanging between them does not reduce it — provided the money is fully collected (don't move unsettled sale proceeds). Fidelity reflects buys on trade date and sells on settlement date, so check the balance after the exchange." }));
      if (plan.skipped.length) {
        const sk = el('div', { className: 'fmc-mmf-skip' }, 'Higher after-tax but unavailable at this balance:');
        for (const sItem of plan.skipped.slice(0, 4)) sk.append(el('div', { textContent: `${sItem.ticker} ${pct(sItem.afterTax)} — ${sItem.reason}` }));
        rec.append(sk);
      }
    }
    panel.append(rec);
    panel.append(el('div', { className: 'fmc-mmf-foot', textContent: 'Fill ticket only enters the fields in Fidelity\'s exchange ticket — it never clicks Preview Order or submits. You review and submit each exchange yourself. Not tax advice.' }));
  }

  // --- Lifecycle ---
  function start() {
    if (observer) return;
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    schedule();
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    clearTimeout(scanTimer);
    for (const b of document.querySelectorAll(`.${BTN_CLASS}`)) b.remove();
    closePanel();
  }

  async function init() {
    try {
      const r = await chrome.storage.sync.get(STORAGE_KEY_SETTINGS);
      if (r[STORAGE_KEY_SETTINGS]?.mmfEnabled === false) enabled = false;
    } catch { /* defaults */ }
    if (enabled) start();
    chrome.storage.onChanged.addListener((changes, area) => {
      const next = changes[STORAGE_KEY_SETTINGS]?.newValue;
      if (area !== 'sync' || !next) return;
      const now = next.mmfEnabled !== false;
      if (now && !enabled) { enabled = true; start(); }
      else if (!now && enabled) { enabled = false; stop(); }
    });
  }

  init().catch(err => log('Fatal init error:', err));
})();
