// Option-chain annotator — on Fidelity's option chain page, hover a bid/ask to learn whether
// that trade would cause margin debit or leave less withdrawable cash than you want, without
// opening an order ticket. The hovered cell is calculated exactly (one trade-calculator call);
// other strikes of the same expiry/type/side are estimated from the strikes already calculated.
'use strict';
(() => {
  // Only on the option chain / Trader+ pages (ChainCore is null elsewhere); the trade-ticket
  // panel is handled by content/main.js.
  const C = ChainCore;
  if (!C) return;
  const log = makeDebugLog('[FMC-CHAIN]');
  const { ERROR_TYPES, CHAIN_LIMITS } = FMC_CONSTANTS;
  const { PROJECTED: EXACT_TTL_MS } = FMC_CONSTANTS.CACHE_TTL_MS;
  const { settings, fmt, getUnderlying, getAccount, ensureBase } = C;
  const E = ChainEstimate;
  const R = RollModel;
  let underlyingPx = null;   // underlying price for yield calculations
  let pxFor = null;
  let yieldTimer = null;

  const CLS = Object.freeze({
    CELL: 'fmc-chain-cell',
    EXACT: 'fmc-chain-exact',
    ESTIMATE: 'fmc-chain-est',
    VERIFY: 'fmc-chain-verify',
    ok: 'fmc-chain-ok',
    low: 'fmc-chain-low',
    neg: 'fmc-chain-neg'
  });
  const STATE_CLASSES = [CLS.ok, CLS.low, CLS.neg, CLS.EXACT, CLS.ESTIMATE, CLS.VERIFY];
  const PILL_ID = 'fmc-chain-pill';
  // Chain cells are `<a role="button" aria-label="sell Oct 16 2026 24 put at bid of 1.36">`.
  const CELL_SELECTOR = '[role="button"][aria-label], button[aria-label]';

  const exactCache = new Map();   // key → { result, ts }
  const samples = new Map();      // groupKey → Map(strike → {strike, eff})
  let hoverTimer = null;
  let hoverBtn = null;
  let observer = null;
  let repaintTimer = null;

  // --- Status pill ---
  function setPill(text, kind) {
    let pill = document.getElementById(PILL_ID);
    if (!pill) {
      pill = document.createElement('div');
      pill.id = PILL_ID;
      pill.setAttribute('role', 'status');
      pill.setAttribute('aria-live', 'polite');
      document.body.appendChild(pill);
    }
    pill.textContent = text;
    pill.setAttribute('data-kind', kind || 'info');
  }

  function idlePill() {
    setPill(`Margin hints: hover a bid/ask · ${settings.chainQty}× · min withdrawable ${fmt(settings.minWithdrawable)}`, 'info');
  }

  // --- Cells ---
  function cellOf(btn) {
    return E.parseLabel(btn.getAttribute('aria-label'));
  }

  function sampleMap(key) {
    let m = samples.get(key);
    if (!m) { m = new Map(); samples.set(key, m); }
    return m;
  }

  /**
   * Decides what order a hovered cell represents. Buying a contract you are short, or selling
   * one you hold long, closes it (BC/SC, capped at the quantity held); anything else opens (BO/SO).
   * @param {string} underlying
   * @param {Object} cell - Output of ChainEstimate.parseLabel.
   * @returns {{action: string, qty: number, close: boolean}}
   */
  function orderFor(underlying, cell) {
    const wanted = settings.chainQty;
    const held = C.peekBase()?.holdings?.[E.optionSymbol(underlying, cell).slice(1)] ?? 0;
    if (cell.side === 'buy' && held < 0) return { action: 'BC', qty: Math.min(wanted, -held), close: true };
    if (cell.side === 'sell' && held > 0) return { action: 'SC', qty: Math.min(wanted, held), close: true };
    return { action: cell.side === 'sell' ? 'SO' : 'BO', qty: wanted, close: false };
  }

  /** Estimate groups keep opening and closing orders apart — their requirement curves differ. */
  function groupOf(underlying, cell, order) {
    return E.groupKey(underlying, order.close ? { ...cell, side: `${cell.side}-close` } : cell);
  }

  function exactKey(underlying, cell, order) {
    return `${underlying}|${cell.expiry}|${cell.type}|${order.action}|${cell.strike}|${cell.price}|${order.qty}`;
  }

  const ACTION_TEXT = Object.freeze({ SO: 'Sell to open', BO: 'Buy to open', SC: 'Sell to close', BC: 'Buy to close' });

  const rowLookup = new Map(); // `${underlying}|${expiry}|${type}` → Map(strike → chain row)

  /**
   * Return, annualized return and profit probability (fractions) if the sold option's extrinsic
   * value is fully captured, or null. IV/delta come from the cached chain rows when available.
   */
  function yieldOf(cell) {
    if (cell.side !== 'sell' || underlyingPx === null) return null;
    const row = rowLookup.get(`${pxFor}|${cell.expiry}|${cell.type}`)?.get(cell.strike);
    return R.optionStats({
      type: cell.type, strike: cell.strike, price: cell.price, underlying: underlyingPx,
      expiry: cell.expiry, iv: row?.iv ?? null, delta: row?.delta ?? null
    });
  }

  /** Loads chain rows (IV, delta) for every sell-cell expiry/type currently on screen. */
  async function loadRows(cells) {
    const need = new Map();
    for (const c of cells) {
      const key = `${pxFor}|${c.expiry}|${c.type}`;
      if (c.side === 'sell' && !rowLookup.has(key)) need.set(key, c);
    }
    if (need.size === 0) return;
    const exps = await ChainAPI.fetchExpirations(pxFor);
    await Promise.all([...need].map(async ([key, c]) => {
      const exp = exps.find(e => e.date === c.expiry);
      if (!exp) { rowLookup.set(key, new Map()); return; }
      const rows = R.chainRows(await ChainAPI.fetchChain(pxFor, exp), c.type);
      rowLookup.set(key, new Map(rows.map(r => [r.strike, r])));
    }));
  }

  function describe(cell, order, r, kind) {
    const lines = [
      `${ACTION_TEXT[order.action]} ${order.qty}× ${cell.expiry} $${cell.strike} ${cell.type} @ ${fmt(cell.price)} — ${kind}`,
      `Cash withdrawable after: ${fmt(r.avl)} (min ${fmt(settings.minWithdrawable)})`,
      `Margin ${r.credit >= 0 ? 'credit' : 'debit'} after: ${fmt(r.credit)}`,
      `House ${r.house >= 0 ? 'surplus' : 'call'}: ${fmt(r.house)}`,
      `Premium: ${r.premium >= 0 ? '+' : ''}${fmt(r.premium)}`
    ];
    const y = order.action === 'SO' ? yieldOf(cell) : null;
    if (y) {
      const hurdle = settings.borrowRate / 100;
      lines.push(`If extrinsic captured: ${R.formatStats(y)} (hurdle ${settings.borrowRate}%/yr) ${y.annual >= hurdle ? '✓' : '✗'}`);
    }
    if (r.state === 'neg') lines.push(r.credit < 0 ? 'Would put you into margin debit.' : 'Would trigger a house call.');
    else if (r.state === 'low') lines.push('Leaves less withdrawable cash than your minimum.');
    return lines.join('\n');
  }

  function clearMark(btn) {
    btn.classList.remove(CLS.CELL, ...STATE_CLASSES);
    if (btn.dataset.fmcTitle !== undefined) {
      if (btn.dataset.fmcTitle) btn.setAttribute('title', btn.dataset.fmcTitle); else btn.removeAttribute('title');
      delete btn.dataset.fmcTitle;
    }
  }

  function mark(btn, r, kind, verify) {
    if (btn.dataset.fmcTitle === undefined) btn.dataset.fmcTitle = btn.getAttribute('title') ?? '';
    btn.classList.remove(...STATE_CLASSES);
    btn.classList.add(CLS.CELL, CLS[r.state], kind === 'exact' ? CLS.EXACT : CLS.ESTIMATE);
    if (verify) btn.classList.add(CLS.VERIFY);
    btn.setAttribute('title', r.tip);
  }

  /** Paints every visible cell in the group of `refCell` from exact results, else estimates. */
  function repaintGroup(underlying, refCell) {
    const base = C.peekBase();
    if (!base) return;
    const key = groupOf(underlying, refCell, orderFor(underlying, refCell));
    const pts = [...(samples.get(key)?.values() ?? [])];
    for (const btn of document.querySelectorAll(CELL_SELECTOR)) {
      const cell = cellOf(btn);
      if (!cell) continue;
      const order = orderFor(underlying, cell);
      if (groupOf(underlying, cell, order) !== key) continue;
      const exact = exactCache.get(exactKey(underlying, cell, order));
      if (exact) {
        mark(btn, { ...exact.result, tip: describe(cell, order, exact.result, 'exact') }, 'exact', false);
        continue;
      }
      // Closing orders are specific to the strikes you hold — never estimated.
      if (order.close) { clearMark(btn); continue; }
      const est = E.estimateCell(base.bal, cell, order.qty, pts, settings.minWithdrawable);
      if (!est) { clearMark(btn); continue; }
      const qty = order.qty;
      const r = { ...est, premium: E.signedPremium(cell, qty) };
      const note = est.verify
        ? `estimate from ${pts.length} strike(s) — close to your limit, hover to calculate exactly`
        : `estimate from ${pts.length} strike(s) — hover to calculate exactly`;
      mark(btn, { ...r, tip: describe(cell, order, r, note) }, 'est', est.verify);
    }
  }

  // --- Exact calculation on hover ---
  async function calculate(btn) {
    const cell = cellOf(btn);
    const underlying = getUnderlying();
    if (!cell || !underlying) return;
    setPill('Margin hints: calculating…', 'busy');
    try {
      const account = await getAccount();
      if (!account) {
        setPill('Margin hints: could not determine your account — open a trade ticket once', 'warn');
        return;
      }
      await ensureBase(account);
      const order = orderFor(underlying, cell);
      const key = exactKey(underlying, cell, order);
      if (exactCache.has(key) && Date.now() - exactCache.get(key).ts < EXACT_TTL_MS) { idlePill(); return; }
      const qty = order.qty;
      const orders = [{
        orderSymbol: E.optionSymbol(underlying, cell),
        orderType: 'O',
        orderAction: order.action,
        orderQty: qty,
        price: cell.price
      }];
      const impact = await C.calculate(account, orders);

      const premium = E.signedPremium(cell, qty);
      const result = {
        credit: impact.projectedCreditDebit,
        house: impact.houseBalance,
        avl: impact.cashWithdrawable,
        premium
      };
      result.state = E.classify(result, settings.minWithdrawable);
      exactCache.set(key, { result, ts: Date.now() });
      if (impact.houseBalanceDelta !== null && !order.close) {
        sampleMap(groupOf(underlying, cell, order)).set(cell.strike, {
          strike: cell.strike,
          eff: E.effectiveRequirement(premium, impact.houseBalanceDelta)
        });
      }
      repaintGroup(underlying, cell);
      idlePill();
    } catch (err) {
      log('calculation failed:', err);
      const expired = err?.type === ERROR_TYPES.SESSION_EXPIRED;
      setPill(expired ? 'Margin hints: Fidelity session expired — refresh the page' : `Margin hints: ${err?.message || 'calculation failed'}`, 'error');
    }
  }

  // --- Yield badges (no API calls per cell: only the underlying price is fetched) ---
  async function ensurePrice() {
    const u = getUnderlying();
    if (!u) return;
    if (pxFor !== u || underlyingPx === null) {
      try {
        underlyingPx = await ChainAPI.fetchUnderlyingPrice(u);
        pxFor = u;
      } catch (err) {
        log('underlying price failed:', err.message);
        underlyingPx = null;
      }
    }
  }

  function clearYieldBadges() {
    for (const b of document.querySelectorAll('[data-fmc-yield]')) {
      b.removeAttribute('data-fmc-yield');
      b.classList.remove('fmc-yield-badge', 'fmc-yield-hit', 'fmc-yield-miss');
      if (!b.classList.contains(CLS.CELL)) b.removeAttribute('title');
    }
  }

  async function updateYieldBadges() {
    if (!settings.chainEnabled) return;
    await ensurePrice();
    if (underlyingPx === null) return;
    const hurdle = settings.borrowRate / 100;
    const buttons = [...document.querySelectorAll(CELL_SELECTOR)];
    const cells = buttons.map(cellOf).filter(Boolean);
    await loadRows(cells).catch(err => log('chain rows failed:', err.message));
    for (const btn of buttons) {
      const cell = cellOf(btn);
      const y = cell ? yieldOf(cell) : null;
      // Roll mode draws its own net-credit badge on target cells.
      if (!y || btn.hasAttribute('data-fmc-roll')) {
        if (btn.hasAttribute('data-fmc-yield')) {
          btn.removeAttribute('data-fmc-yield');
          btn.classList.remove('fmc-yield-badge', 'fmc-yield-hit', 'fmc-yield-miss');
          if (!btn.classList.contains(CLS.CELL)) btn.removeAttribute('title');
        }
        continue;
      }
      btn.setAttribute('data-fmc-yield', R.formatYield(y.annual));
      // Hover tooltip with the full picture — unless an exact/estimate tooltip already owns the title.
      if (!btn.classList.contains(CLS.CELL)) {
        btn.setAttribute('title', `If extrinsic captured: ${R.formatStats(y)} (hurdle ${settings.borrowRate}%/yr) ${y.annual >= hurdle ? '✓' : '✗'}\nHover for the margin impact.`);
      }
      btn.classList.add('fmc-yield-badge');
      btn.classList.toggle('fmc-yield-hit', y.annual >= hurdle);
      btn.classList.toggle('fmc-yield-miss', y.annual < hurdle);
    }
  }

  function scheduleYield() {
    clearTimeout(yieldTimer);
    yieldTimer = setTimeout(() => updateYieldBadges().catch(err => log('yield badges failed:', err)), 500);
  }

  // --- Events ---
  function onOver(ev) {
    if (!settings.chainEnabled) return;
    // The roll assistant owns hover for cells that are roll targets (two-leg calculations);
    // every other cell keeps the single-leg hints.
    if (typeof RollMode !== 'undefined' && ev.target instanceof Element) {
      const target = ev.target.closest(CELL_SELECTOR);
      if (target && RollMode.handles(target)) return;
    }
    const btn = ev.target instanceof Element ? ev.target.closest(CELL_SELECTOR) : null;
    if (!btn || btn === hoverBtn || !cellOf(btn)) return;
    clearTimeout(hoverTimer);
    hoverBtn = btn;
    hoverTimer = setTimeout(() => {
      if (hoverBtn === btn && btn.isConnected) calculate(btn).catch(err => log('hover error:', err));
    }, CHAIN_LIMITS.HOVER_DELAY_MS);
  }

  function onOut(ev) {
    if (!hoverBtn) return;
    const to = ev.relatedTarget instanceof Element ? ev.relatedTarget.closest(CELL_SELECTOR) : null;
    if (to === hoverBtn) return;
    clearTimeout(hoverTimer);
    hoverBtn = null;
  }

  /** Re-applies estimates when Fidelity re-renders rows (expiry change, scrolling, quote refresh). */
  function scheduleRepaint() {
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(() => {
      if (!settings.chainEnabled || !C.peekBase()) return;
      const underlying = getUnderlying();
      if (!underlying) return;
      const done = new Set();
      for (const btn of document.querySelectorAll(CELL_SELECTOR)) {
        const cell = cellOf(btn);
        if (!cell) continue;
        const key = groupOf(underlying, cell, orderFor(underlying, cell));
        if (done.has(key) || !samples.has(key)) continue;
        done.add(key);
        repaintGroup(underlying, cell);
      }
    }, 400);
  }

  function clearAllMarks() {
    for (const btn of document.querySelectorAll(`.${CLS.CELL}`)) clearMark(btn);
  }

  function enable() {
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    observer = new MutationObserver((muts) => {
      // Ignore our own class/title writes; react only to nodes being added.
      if (muts.some(m => m.type === 'childList' && m.addedNodes.length > 0 && m.target.id !== PILL_ID)) { scheduleRepaint(); scheduleYield(); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scheduleYield();
    idlePill();
  }

  function disable() {
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('mouseout', onOut, true);
    observer?.disconnect();
    observer = null;
    clearTimeout(hoverTimer);
    clearTimeout(repaintTimer);
    hoverBtn = null;
    clearAllMarks();
    clearTimeout(yieldTimer);
    clearYieldBadges();
    document.getElementById(PILL_ID)?.remove();
  }

  async function init() {
    await C.loadSettings();
    // A fresh baseline invalidates everything derived from the old one.
    C.onNewBase(() => { samples.clear(); exactCache.clear(); });
    if (settings.chainEnabled) enable();
    C.onSettings((next, prev) => {
      // Quantity / threshold changes make cached results stale.
      exactCache.clear();
      samples.clear();
      if (next.chainEnabled && !prev.chainEnabled) enable();
      else if (!next.chainEnabled && prev.chainEnabled) disable();
      else if (next.chainEnabled) { idlePill(); scheduleRepaint(); scheduleYield(); }
    });
  }

  init().catch(err => log('Fatal init error:', err));
})();
