// Roll assistant — for the options you already hold on the current underlying. Pick a position
// and it finds rolls (close the held contract, open a new one) from live quotes: a "neutral
// frontier" per expiry (how far you can roll down-and-out — or up-and-out for calls — without
// paying money in), plus the best credits out / up / down. Net credit badges appear on the matching
// chain cells, and hovering or tapping a cell — or checking a candidate — runs one exact
// two-leg margin calculation. A finger has no hover: the first tap previews, the second opens the order.
// Active on the option chain page and Fidelity Trader+ Web (ChainCore is null elsewhere).
'use strict';
// Global (lexical) so content/chain.js can stand down its single-leg hover hints while rolling.
const RollMode = (() => {
  const C = ChainCore;
  if (!C) return { active: () => false, handles: () => false };

  const log = makeDebugLog('[FMC-ROLL]');
  const R = RollModel;
  const E = ChainEstimate;
  const { ERROR_TYPES, CHAIN_LIMITS } = FMC_CONSTANTS;
  const { settings, fmt, getUnderlying, getAccount, ensureBase } = C;

  const PANEL_ID = 'fmc-roll-panel';
  const CELL_SELECTOR = '[role="button"][aria-label], button[aria-label]';
  const EXPIRIES_SHOWN = 6;   // source expiry + the next five
  const TOP_PER_GROUP = 3;
  const ROLL_WINDOW = 0.25;               // keep in step with RollModel.candidates defaults
  const ROLL_MAX_FAVORABLE_DELTA = 0.5;
  const CELL_CLASSES = ['fmc-chain-cell', 'fmc-chain-exact', 'fmc-chain-ok', 'fmc-chain-low', 'fmc-chain-neg'];

  const state = {
    underlying: null,
    options: [],          // [{sym, shares, opt}] held on this underlying
    source: null,         // the selected entry of options
    mode: 'natural',      // 'natural' | 'mid'
    target: 0,            // minimum net ($) for the neutral frontier
    collapsed: false,
    loading: false,
    error: null,
    sourceQuote: null,
    px: null,             // underlying price (for yield)
    rows: new Map(),      // ISO expiry → chain rows for the source's option type
    cands: [],
    frontier: [],
    top: { out: [], up: [], down: [] },
    checks: new Map(),    // candidate key → { status: 'busy'|'done'|'error', result?, message? }
    marked: new Set()     // chain cells painted by hover
  };
  let loadSeq = 0;
  let hoverTimer = null;
  let hoverEl = null;
  let unwatch = null;
  let observer = null;
  let badgeTimer = null;
  let pollTimer = null;
  let panel = null;

  const active = () => !!state.source && settings.rollEnabled !== false;

  // --- DOM helpers ---
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

  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function shortDate(iso) {
    const [y, m, d] = iso.split('-');
    return `${MON[Number(m) - 1]} ${Number(d)} '${y.slice(2)}`;
  }
  const signed = (n) => `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n))}`;
  const adverseLabel = () => (state.source?.opt.type === 'put' ? 'Down & out' : 'Up & out');

  // --- Context: holdings on the current underlying ---
  async function refreshContext() {
    if (settings.rollEnabled === false) { hidePanel(); return; }
    const underlying = getUnderlying();
    if (!underlying) return;
    try {
      const account = await getAccount();
      if (!account) { hidePanel(); return; }
      const base = await ensureBase(account);
      const options = Object.entries(base.holdings)
        .map(([sym, shares]) => ({ sym, shares, opt: R.parseOcc(sym) }))
        .filter(o => o.opt && o.opt.underlying === underlying)
        .sort((a, b) => (a.opt.expiry < b.opt.expiry ? -1 : a.opt.expiry > b.opt.expiry ? 1 : a.opt.strike - b.opt.strike));
      const changed = underlying !== state.underlying || options.map(o => o.sym).join() !== state.options.map(o => o.sym).join();
      state.underlying = underlying;
      state.options = options;
      if (options.length === 0) { state.source = null; clearBadges(); hidePanel(); return; }
      if (!state.source || !options.some(o => o.sym === state.source.sym)) state.source = options[0];
      showPanel();
      if (changed) await loadRolls();
      else render();
    } catch (err) {
      log('context failed:', err);
      if (err?.type === ERROR_TYPES.SESSION_EXPIRED) { state.error = 'Fidelity session expired — refresh the page'; showPanel(); render(); }
    }
  }

  // --- Roll search ---
  async function loadRolls() {
    const src = state.source;
    if (!src) return;
    await TaxContext.ready();
    const seq = ++loadSeq;
    state.loading = true;
    state.error = null;
    state.checks.clear();
    clearBadges();
    render();
    try {
      const all = await ChainAPI.fetchExpirations(state.underlying);
      const expiries = all.filter(e => e.date >= src.opt.expiry).slice(0, EXPIRIES_SHOWN);
      if (!expiries.some(e => e.date === src.opt.expiry)) throw new Error('Held option expiry not found in the chain');
      const chains = await Promise.all(expiries.map(e => ChainAPI.fetchChain(state.underlying, e)));
      if (seq !== loadSeq) return;
      const rowsByExpiry = new Map(expiries.map((e, i) => [e.date, R.chainRows(chains[i], src.opt.type)]));
      state.px = await ChainAPI.fetchUnderlyingPrice(state.underlying).catch(() => null);
      const sourceRow = rowsByExpiry.get(src.opt.expiry).find(r => r.strike === src.opt.strike);
      if (!sourceRow) throw new Error('No quote for the held option');
      state.sourceQuote = { bid: sourceRow.bid, ask: sourceRow.ask };
      applyRows(rowsByExpiry);
    } catch (err) {
      if (seq !== loadSeq) return;
      log('roll search failed:', err);
      state.error = err?.message || 'Roll search failed';
      state.cands = []; state.frontier = []; state.top = { out: [], up: [], down: [] };
    } finally {
      if (seq === loadSeq) { state.loading = false; render(); scheduleBadges(); }
    }
  }

  /** Re-ranks when only the pricing mode changed (chains come from ChainAPI's short cache). */
  async function recomputeFromCache() {
    const src = state.source;
    if (!src) return;
    const seq = ++loadSeq;
    state.loading = true; render();
    try {
      const all = await ChainAPI.fetchExpirations(state.underlying);
      const expiries = all.filter(e => e.date >= src.opt.expiry).slice(0, EXPIRIES_SHOWN);
      const chains = await Promise.all(expiries.map(e => ChainAPI.fetchChain(state.underlying, e)));
      if (seq !== loadSeq) return;
      const rowsByExpiry = new Map(expiries.map((e, i) => [e.date, R.chainRows(chains[i], src.opt.type)]));
      applyRows(rowsByExpiry);
    } catch (err) {
      if (seq !== loadSeq) return;
      state.error = err?.message || 'Roll search failed';
    } finally {
      if (seq === loadSeq) { state.loading = false; render(); scheduleBadges(); }
    }
  }

  function applyRows(rowsByExpiry) {
    const src = state.source;
    state.rows = rowsByExpiry;
    state.cands = R.candidates({
      source: src.opt, sourceQuote: state.sourceQuote, shares: src.shares, rowsByExpiry, mode: state.mode
    });
    // Return / annualized return / profit probability of the NEW leg if its extrinsic value is
    // captured (short positions only).
    for (const c of state.cands) {
      c.stats = src.shares < 0 && state.px
        ? TaxContext.apply(R.optionStats({ type: src.opt.type, strike: c.strike, price: c.openPrice, underlying: state.px, expiry: c.expiry, iv: c.iv, delta: c.delta }))
        : null;
    }
    state.frontier = R.neutralFrontier(state.cands, src.opt, state.target);
    state.top = R.topByDirection(state.cands, src.opt, TOP_PER_GROUP, false);
  }

  // --- Exact two-leg check ---
  const candKey = (c) => `${c.expiry}|${c.strike}|${state.mode}`;

  async function runCheck(c) {
    const key = candKey(c);
    state.checks.set(key, { status: 'busy' });
    render();
    try {
      const src = state.source;
      const account = await getAccount();
      const orders = R.buildOrders(src.sym, c.symbol, src.shares, c.closePrice, c.openPrice);
      const impact = await C.calculate(account, orders);
      const result = { credit: impact.projectedCreditDebit, house: impact.houseBalance, avl: impact.cashWithdrawable, net: impact.premium };
      result.state = E.classify(result, settings.minWithdrawable);
      state.checks.set(key, { status: 'done', result });
    } catch (err) {
      log('check failed:', err);
      if (err?.cancelled) state.checks.delete(key);
      else state.checks.set(key, { status: 'error', message: err?.message || 'failed' });
    }
    render();
  }

  // --- Panel ---
  function showPanel() {
    if (panel?.isConnected) { panel.hidden = false; return; }
    panel = el('div', { id: PANEL_ID, role: 'region', 'aria-label': 'Roll assistant' });
    document.body.appendChild(panel);
    render();
  }

  function hidePanel() {
    if (panel) panel.hidden = true;
  }

  function resultChip(r) {
    return el('span', { className: `fmc-roll-chip fmc-roll-${r.state}`, title: `After the roll — margin ${r.credit >= 0 ? 'credit' : 'debit'} ${fmt(r.credit)}, house ${r.house >= 0 ? 'surplus' : 'call'} ${fmt(r.house)}, withdrawable ${fmt(r.avl)}` },
      `${r.state === 'neg' ? '✗' : r.state === 'low' ? '!' : '✓'} avl ${fmt(r.avl)}`);
  }

  function candRow(c, extraLabel) {
    const chk = state.checks.get(candKey(c));
    const btn = el('button', { type: 'button', className: 'fmc-roll-btn', textContent: chk?.status === 'busy' ? '…' : 'Check' });
    btn.disabled = chk?.status === 'busy';
    btn.addEventListener('click', () => runCheck(c));
    const row = el('div', { className: 'fmc-roll-row' },
      el('span', { className: 'fmc-roll-what', textContent: `${shortDate(c.expiry)} $${c.strike}${extraLabel ? ` ${extraLabel}` : ''}` }),
      el('span', { className: `fmc-roll-net ${c.net >= 0 ? 'fmc-roll-pos' : 'fmc-roll-negtxt'}`, textContent: signed(c.net) }),

      chk?.status === 'done' ? resultChip(chk.result) : (chk?.status === 'error' ? el('span', { className: 'fmc-roll-err', textContent: chk.message }) : null),
      btn);
    if (!c.stats) return row;
    const hit = c.stats.annual >= settings.borrowRate / 100;
    return el('div', { className: 'fmc-roll-cand' }, row, el('div', {
      className: `fmc-roll-stats ${hit ? 'fmc-roll-pos' : 'fmc-roll-dim'}`,
      title: `New leg: ${fmt(c.stats.extrinsic)}/share extrinsic over ${c.stats.days} days on ${fmt(c.stats.capital)}/share if fully captured (hurdle ${settings.borrowRate}%/yr)`,
      textContent: `${R.formatStats(c.stats)} ${hit ? '✓' : ''}`
    }));
  }

  function render() {
    if (!panel || panel.hidden) return;
    panel.replaceChildren();
    const src = state.source;
    if (!src) return;
    const short = src.shares < 0;

    const toggle = el('button', { type: 'button', className: 'fmc-roll-toggle', 'aria-expanded': String(!state.collapsed), textContent: state.collapsed ? '▸' : '▾' });
    toggle.addEventListener('click', () => { state.collapsed = !state.collapsed; render(); });
    panel.append(el('div', { className: 'fmc-roll-head' }, el('strong', { textContent: 'Roll assistant' }), toggle));
    if (state.collapsed) return;

    // Controls
    const posSel = el('select', { 'aria-label': 'Position to roll' });
    for (const o of state.options) {
      const opt = el('option', { value: o.sym, textContent: `${o.shares < 0 ? 'Short' : 'Long'} ${Math.abs(o.shares)} · ${R.describeOption(o.opt)}` });
      if (o.sym === src.sym) opt.selected = true;
      posSel.append(opt);
    }
    posSel.addEventListener('change', () => { state.source = state.options.find(o => o.sym === posSel.value); loadRolls(); });
    const modeSel = el('select', { 'aria-label': 'Pricing' },
      el('option', { value: 'natural', textContent: 'Natural (bid/ask)' }),
      el('option', { value: 'mid', textContent: 'Mid' }));
    modeSel.value = state.mode;
    modeSel.addEventListener('change', () => { state.mode = modeSel.value; state.checks.clear(); recomputeFromCache(); });
    const targetIn = el('input', { type: 'number', step: '10', value: String(state.target), 'aria-label': 'Minimum net credit ($)', title: '0 = no money paid in. Negative allows a small debit.' });
    targetIn.addEventListener('change', () => {
      const n = Number(targetIn.value);
      state.target = Number.isFinite(n) ? n : 0;
      if (state.cands.length) { state.frontier = R.neutralFrontier(state.cands, src.opt, state.target); render(); }
    });
    const refresh = el('button', { type: 'button', className: 'fmc-roll-btn', textContent: 'Refresh' });
    refresh.addEventListener('click', () => { ChainAPI.clear(); loadRolls(); });
    panel.append(
      el('div', { className: 'fmc-roll-controls' }, posSel,
        el('label', {}, 'Price ', modeSel),
        el('label', {}, 'Net ≥ $', targetIn), refresh));

    if (state.error) { panel.append(el('div', { className: 'fmc-roll-status fmc-roll-err', textContent: state.error })); return; }
    if (state.loading || !state.sourceQuote) { panel.append(el('div', { className: 'fmc-roll-status', textContent: 'Loading chains…' })); return; }

    const closePx = R.closePrice(state.sourceQuote, short, state.mode);
    panel.append(el('div', { className: 'fmc-roll-status', textContent:
      `${short ? 'Buy to close' : 'Sell to close'} ${Math.abs(src.shares)}× @ ${fmt(closePx)} (bid ${fmt(state.sourceQuote.bid)} / ask ${fmt(state.sourceQuote.ask)})` }));

    // Neutral frontier
    const sec1 = el('div', { className: 'fmc-roll-sec' },
      el('div', { className: 'fmc-roll-title', textContent: `${adverseLabel()} — furthest strike with net ≥ ${fmt(state.target)}` }));
    if (state.frontier.length === 0) sec1.append(el('div', { className: 'fmc-roll-empty', textContent: 'No candidates.' }));
    for (const f of state.frontier) {
      if (f.best) {
        sec1.append(candRow(f.best, f.best.strike === src.opt.strike ? '(same strike)' : ''));
        if (f.beyond) sec1.append(el('div', { className: 'fmc-roll-beyond', textContent: `next: $${f.beyond.strike} → ${signed(f.beyond.net)}` }));
      } else {
        sec1.append(el('div', { className: 'fmc-roll-beyond', textContent: `${shortDate(f.expiry)}: none ≥ ${fmt(state.target)}${f.beyond ? ` (best $${f.beyond.strike} → ${signed(f.beyond.net)})` : ''}` }));
      }
    }
    panel.append(sec1);

    // Best credits
    const titles = { out: 'Roll out (same strike)', up: 'Roll up (higher strike)', down: 'Roll down (lower strike)' };
    const sec2 = el('div', { className: 'fmc-roll-sec' }, el('div', { className: 'fmc-roll-title', textContent: 'Best credits' }));
    for (const dir of ['out', 'up', 'down']) {
      const rows = state.top[dir];
      if (!rows.length) continue;
      sec2.append(el('div', { className: 'fmc-roll-sub', textContent: titles[dir] }));
      for (const c of rows) sec2.append(candRow(c));
    }
    panel.append(sec2);
    panel.append(el('div', { className: 'fmc-roll-foot', textContent: `Net = new premium − closing cost, ${Math.abs(src.shares)}× contract(s); fees excluded. Green stats line = new leg's return / annualized return / profit probability if its extrinsic value is fully captured, at or above your ${settings.borrowRate}%/yr hurdle. “Check” runs an exact margin calculation.` }));
  }

  // --- Chain cell badges + hover check ---
  /** Returns the roll parameters for a chain cell, or null if the cell isn't a roll target. */
  function rollCell(btn) {
    if (!active() || !state.sourceQuote) return null;
    const cell = E.parseLabel(btn.getAttribute('aria-label'));
    const src = state.source;
    if (!cell || cell.type !== src.opt.type) return null;
    const short = src.shares < 0;
    if (cell.side !== (short ? 'sell' : 'buy')) return null;
    if (cell.expiry < src.opt.expiry) return null;
    if (cell.expiry === src.opt.expiry && cell.strike === src.opt.strike) return null;
    // Same relevance rules as the candidate list: nearby strikes only, and no in-the-money strikes
    // when rolling toward the money.
    if (Math.abs(cell.strike - src.opt.strike) > ROLL_WINDOW * src.opt.strike) return null;
    const adverse = cell.strike !== src.opt.strike && (R.adverseDirection(src.opt.type) === 'down' ? cell.strike < src.opt.strike : cell.strike > src.opt.strike);
    if (cell.strike !== src.opt.strike && !adverse) {
      const delta = state.rows.get(cell.expiry)?.find(r => r.strike === cell.strike)?.delta;
      if (Number.isFinite(delta) && Math.abs(delta) > ROLL_MAX_FAVORABLE_DELTA) return null;
    }
    const closePx = R.closePrice(state.sourceQuote, short, 'natural');
    const net = R.rollNet(closePx, cell.price, short, Math.abs(src.shares));
    if (net === null) return null;
    // Return stats of the new (short) leg, using the cached chain row for IV / delta.
    let stats = null;
    if (short && state.px) {
      const row = state.rows.get(cell.expiry)?.find(r => r.strike === cell.strike);
      stats = TaxContext.apply(R.optionStats({ type: cell.type, strike: cell.strike, price: cell.price, underlying: state.px, expiry: cell.expiry, iv: row?.iv ?? null, delta: row?.delta ?? null }));
    }
    return { cell, closePx, net, short, stats };
  }

  function clearBadges() {
    for (const b of document.querySelectorAll('[data-fmc-roll]')) {
      b.removeAttribute('data-fmc-roll');
      b.classList.remove('fmc-roll-badge', 'fmc-roll-badge-pos', 'fmc-roll-badge-neg');
    }
    clearMarks();
  }

  function clearMarks() {
    for (const b of state.marked) {
      b.classList.remove(...CELL_CLASSES);
      if (b.dataset.fmcRollTitle !== undefined) {
        if (b.dataset.fmcRollTitle) b.setAttribute('title', b.dataset.fmcRollTitle); else b.removeAttribute('title');
        delete b.dataset.fmcRollTitle;
      }
    }
    state.marked.clear();
  }

  function updateBadges() {
    if (!active() || !state.sourceQuote || state.loading) return;
    for (const btn of document.querySelectorAll(CELL_SELECTOR)) {
      const rc = rollCell(btn);
      if (!rc) {
        if (btn.hasAttribute('data-fmc-roll')) { btn.removeAttribute('data-fmc-roll'); btn.classList.remove('fmc-roll-badge', 'fmc-roll-badge-pos', 'fmc-roll-badge-neg'); }
        continue;
      }
      const label = `${rc.net >= 0 ? '+' : '−'}$${Math.abs(Math.round(rc.net))}${rc.stats ? ` · ${R.formatYield(rc.stats.annual)}${rc.stats.afterTax ? ' AT' : ''}` : ''}`;
      btn.setAttribute('data-fmc-roll', label);
      btn.classList.add('fmc-roll-badge');
      btn.classList.toggle('fmc-roll-badge-pos', rc.net >= 0);
      btn.classList.toggle('fmc-roll-badge-neg', rc.net < 0);
    }
  }

  function scheduleBadges() {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(updateBadges, 400);
  }

  async function hoverCheck(btn) {
    const rc = rollCell(btn);
    if (!rc || !btn.isConnected) {
      if (FMCTouch.armedEl() === btn) FMCTouch.show(btn, 'This contract is not a roll target.');
      return;
    }
    const src = state.source;
    try {
      const account = await getAccount();
      const targetSym = E.optionSymbol(state.underlying, rc.cell);
      const orders = R.buildOrders(src.sym, targetSym, src.shares, rc.closePx, rc.cell.price);
      const impact = await C.calculate(account, orders);
      const r = { credit: impact.projectedCreditDebit, house: impact.houseBalance, avl: impact.cashWithdrawable };
      r.state = E.classify(r, settings.minWithdrawable);
      if (!btn.isConnected) return;
      if (btn.dataset.fmcRollTitle === undefined) btn.dataset.fmcRollTitle = btn.getAttribute('title') ?? '';
      btn.classList.remove(...CELL_CLASSES);
      btn.classList.add('fmc-chain-cell', `fmc-chain-${r.state}`, 'fmc-chain-exact');
      const tip = [
        `Roll ${R.describeOption(src.opt)} → ${R.describeOption({ ...rc.cell, strike: rc.cell.strike })} — exact`,
        `Close ${fmt(rc.closePx)} · open ${fmt(rc.cell.price)} · net ${signed(rc.net)}`,
        `Cash withdrawable after: ${fmt(r.avl)} (min ${fmt(settings.minWithdrawable)})`,
        `Margin ${r.credit >= 0 ? 'credit' : 'debit'} after: ${fmt(r.credit)}`,
        `House ${r.house >= 0 ? 'surplus' : 'call'}: ${fmt(r.house)}`,
        rc.stats ? `New leg if extrinsic captured: ${R.formatStats(rc.stats)} (hurdle ${settings.borrowRate}%/yr) ${rc.stats.annual >= settings.borrowRate / 100 ? '✓' : '✗'}` : null
      ].filter(Boolean).join('\n');
      btn.setAttribute('title', tip);
      if (FMCTouch.armedEl() === btn) { FMCTouch.show(btn, tip); FMCTouch.extendArm(); }
      state.marked.add(btn);
    } catch (err) {
      log('hover check failed:', err);
      if (FMCTouch.armedEl() === btn) FMCTouch.show(btn, err?.message || 'Roll check failed');
    }
  }

  function onOver(ev) {
    if (ev.pointerType === 'touch' || FMCTouch.suppressHover()) return;
    if (!active()) return;
    const btn = ev.target instanceof Element ? ev.target.closest(CELL_SELECTOR) : null;
    if (!btn || btn === hoverEl || !rollCell(btn)) return;
    clearTimeout(hoverTimer);
    hoverEl = btn;
    hoverTimer = setTimeout(() => { if (hoverEl === btn) hoverCheck(btn); }, CHAIN_LIMITS.HOVER_DELAY_MS);
  }

  function onOut(ev) {
    if (ev.pointerType === 'touch' || FMCTouch.suppressHover()) return;
    if (!hoverEl) return;
    const to = ev.relatedTarget instanceof Element ? ev.relatedTarget.closest(CELL_SELECTOR) : null;
    if (to === hoverEl) return;
    clearTimeout(hoverTimer);
    hoverEl = null;
  }

  // --- Lifecycle ---
  function start() {
    document.addEventListener('pointerover', onOver, true);
    document.addEventListener('pointerout', onOut, true);
    unwatch = FMCTouch.watch({
      selector: CELL_SELECTOR,
      owner: (btn) => active() && rollCell(btn) !== null,
      onPreview: (btn) => {
        clearTimeout(hoverTimer);
        hoverEl = btn;
        FMCTouch.show(btn, 'Checking this roll…');
        hoverCheck(btn);
      }
    });
    observer = new MutationObserver((muts) => {
      if (muts.some(m => m.type === 'childList' && m.addedNodes.length > 0 && !m.target.closest?.(`#${PANEL_ID}`))) scheduleBadges();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // The symbol can change without a page load (Trader+ / SPA navigation).
    pollTimer = setInterval(() => {
      if (getUnderlying() !== state.underlying) refreshContext();
    }, 2000);
    refreshContext();
  }

  function stop() {
    document.removeEventListener('pointerover', onOver, true);
    document.removeEventListener('pointerout', onOut, true);
    unwatch?.();
    unwatch = null;
    FMCTouch.hide();
    observer?.disconnect();
    clearInterval(pollTimer);
    clearTimeout(hoverTimer);
    clearTimeout(badgeTimer);
    clearBadges();
    state.source = null;
    panel?.remove();
    panel = null;
  }

  async function init() {
    await C.loadSettings();
    if (settings.rollEnabled !== false) setTimeout(start, 1500); // let the page and chain.js settle
    C.onNewBase(() => { if (settings.rollEnabled !== false && panel) refreshContext(); });
    TaxContext.onChange(() => { if (state.source && state.sourceQuote && !state.loading) recomputeFromCache(); });
    C.onSettings((next, prev) => {
      if (next.rollEnabled !== false && prev.rollEnabled === false) start();
      else if (next.rollEnabled === false && prev.rollEnabled !== false) stop();
      else if (next.minWithdrawable !== prev.minWithdrawable) { state.checks.clear(); render(); }
    });
  }

  init().catch(err => log('Fatal init error:', err));
  /** True when the roll assistant owns hover for this chain cell (it is a roll target). */
  const handles = (btn) => active() && rollCell(btn) !== null;
  return { active, handles };
})();
