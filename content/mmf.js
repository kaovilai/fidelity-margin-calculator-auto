// Money-market optimizer — adds an "Optimize" button next to money-market positions on the
// positions page. It reads Fidelity's current money-market yields (fund screener, via the
// background worker), computes each fund's AFTER-TAX yield for your tax situation, and suggests the
// best fund your balance actually qualifies for (minimum initial investment / minimum balance
// respected). A calculator what-if checks the move does not reduce your withdrawable cash, and the
// amount is scaled down if it would. READ-ONLY: it never places, fills or submits an order.
'use strict';
(() => {
  if (!location.pathname.includes('/portfolio/positions')) return;

  const log = makeDebugLog('[FMC-MMF]');
  const M = MmfModel;
  const { MESSAGE_TYPES, STORAGE_KEY_SETTINGS } = FMC_CONSTANTS;
  const PANEL_ID = 'fmc-mmf-panel';
  const BTN_CLASS = 'fmc-mmf-btn';
  const CALL_TIMEOUT_MS = 25000;
  // A what-if may differ from the baseline by rounding only.
  const AVL_TOLERANCE = 0.5;

  let enabled = true;
  let observer = null;
  let scanTimer = null;
  let panel = null;
  const view = { ticker: null, account: null, reserve: 0 };

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

  function scan() {
    if (!enabled) return;
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
    for (const b of document.querySelectorAll(`.${BTN_CLASS}`)) if (!live.has(b)) b.remove();
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

  /** What-if exchange orders: sell each source, buy the target (all at the $1.00 NAV). */
  function exchangeOrders(plan, ratio) {
    const sells = plan.moves.map(m => ({ orderSymbol: m.from, orderType: 'E', orderAction: 'S', orderQty: Math.floor(m.dollars * ratio * 100) / 100, price: 1 }));
    const total = sells.reduce((s, o) => s + o.orderQty, 0);
    return [...sells, { orderSymbol: plan.target.ticker, orderType: 'E', orderAction: 'B', orderQty: Math.round(total * 100) / 100, price: 1 }];
  }

  /**
   * Runs the calculator what-if for a fraction `ratio` of the plan and reports withdrawable cash
   * before/after. Returns null if the calculator can't evaluate the exchange.
   */
  async function whatIf(account, base, plan, ratio) {
    try {
      const orders = exchangeOrders(plan, ratio);
      if (orders.some(o => o.orderQty <= 0)) return null;
      await RateLimiter.acquire();
      const projected = await MarginAPI.fetchMarginCalc(account, orders, () => {}, base.priceList);
      const impact = MarginCalc.computeImpact(projected, base.baselineData, orders);
      if (!impact) return null;
      const before = base.baselineData?.data?.getTradeCalculator?.marginCalcResp?.balance?.avlToTradeWithoutMarginImpact;
      return { before: Number(before), after: impact.cashWithdrawable, creditDelta: impact.delta };
    } catch (err) {
      log('what-if failed:', err?.message);
      return null;
    }
  }

  /** Finds the largest fraction of the plan (down to ~1/16) that does not reduce withdrawable cash. */
  async function safeRatio(account, base, plan) {
    let result = await whatIf(account, base, plan, 1);
    if (!result) return { ratio: 1, result: null };
    if (result.after >= result.before - AVL_TOLERANCE) return { ratio: 1, result };
    let lo = 0, hi = 1, best = null;
    for (let i = 0; i < 4; i++) {
      const mid = (lo + hi) / 2;
      const r = await whatIf(account, base, plan, mid);
      if (r && r.after >= r.before - AVL_TOLERANCE) { lo = mid; best = { ratio: mid, result: r }; } else hi = mid;
    }
    return best ?? { ratio: 0, result };
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
    out.rates = TaxContext.rates();
    out.holdings = holdings;
    out.byTicker = new Map(funds.map(f => [f.ticker, f]));
    out.plan = M.plan({ funds, holdings, rates: out.rates, reserve });
    if (out.plan.target) {
      out.safe = await safeRatio(account, status, out.plan);
    }
    return out;
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
    panel.append(el('div', { className: 'fmc-mmf-note', textContent: `After-tax at ${r.federal}% federal (${r.federalSource}) + ${r.state}% ${r.stateCode} (${r.stateSource}). Yields are 7-day, from Fidelity's fund screener.` }));

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
    reserveIn.addEventListener('change', () => { view.reserve = Math.max(0, Number(reserveIn.value) || 0); open(view.ticker, view.account); });
    panel.append(el('label', { className: 'fmc-mmf-reserve' }, 'Keep in place ($) ', reserveIn));

    // Recommendation
    const plan = res.plan;
    const rec = el('div', { className: 'fmc-mmf-sec' }, el('div', { className: 'fmc-mmf-title', textContent: 'Suggestion' }));
    if (!plan.target) {
      rec.append(el('div', { className: 'fmc-mmf-note', textContent: 'Nothing to improve: no fund you qualify for beats your current balances after tax.' }));
    } else {
      const ratio = res.safe?.ratio ?? 1;
      const verified = !!res.safe?.result;
      const moves = plan.moves.map(m => ({ ...m, dollars: Math.floor(m.dollars * ratio * 100) / 100 })).filter(m => m.dollars > 0);
      const total = moves.reduce((s, m) => s + m.dollars, 0);
      const gain = moves.reduce((s, m) => {
        const src = res.byTicker.get(m.from);
        const sat = src ? M.afterTax(src, r) : null;
        return s + (sat === null ? 0 : (m.dollars * (plan.target.afterTax - sat)) / 100);
      }, 0);
      if (total <= 0) {
        rec.append(el('div', { className: 'fmc-mmf-note fmc-mmf-bad', textContent: `Moving cash into ${plan.target.ticker} would reduce your withdrawable cash, so no amount is suggested.` }));
      } else {
        rec.append(row(`Move into ${plan.target.ticker}`, `${fmt(total)} · ${pct(plan.target.afterTax)} after tax`, 'fmc-mmf-good'));
        for (const m of moves) rec.append(row(`  from ${m.from}`, fmt(m.dollars)));
        rec.append(row('Estimated gain', `+${fmt(gain)}/yr`, 'fmc-mmf-good'));
        if (plan.target.minInitial > 0 || plan.target.minBalance > 0) {
          rec.append(el('div', { className: 'fmc-mmf-note', textContent: `${plan.target.ticker} minimums: ${fmt(plan.target.minInitial)} to open, ${fmt(plan.target.minBalance)} balance — this amount qualifies.` }));
        }
        if (verified) {
          const w = res.safe.result;
          rec.append(row('Withdrawable cash', `${fmt(w.before)} → ${fmt(w.after)} ${w.after >= w.before - AVL_TOLERANCE ? '✓ unchanged' : '✗'}`, w.after >= w.before - AVL_TOLERANCE ? 'fmc-mmf-good' : 'fmc-mmf-bad'));
          if (ratio < 1) rec.append(el('div', { className: 'fmc-mmf-note', textContent: 'Amount reduced so your withdrawable cash does not drop.' }));
        } else {
          rec.append(el('div', { className: 'fmc-mmf-note fmc-mmf-bad', textContent: 'The calculator could not evaluate this exchange, so the effect on withdrawable cash is unverified.' }));
        }
      }
      if (plan.skipped.length) {
        const sk = el('div', { className: 'fmc-mmf-skip' }, 'Higher after-tax but unavailable at this balance:');
        for (const s of plan.skipped.slice(0, 4)) sk.append(el('div', { textContent: `${s.ticker} ${pct(s.afterTax)} — ${s.reason}` }));
        rec.append(sk);
      }
    }
    panel.append(rec);
    panel.append(el('div', { className: 'fmc-mmf-foot', textContent: 'Read-only: nothing is placed or filled in. Make the exchange yourself in Fidelity (Trade → Mutual Funds → Exchange). Not tax advice.' }));
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
