// Option-chain annotator — on Fidelity's option chain page, hover a bid/ask to learn whether
// that trade would cause margin debit or leave less withdrawable cash than you want, without
// opening an order ticket. The hovered cell is calculated exactly (one trade-calculator call);
// other strikes of the same expiry/type/side are estimated from the strikes already calculated.
'use strict';
(() => {
  // Only the option chain page — the trade-ticket panel is handled by content/main.js.
  if (!location.pathname.includes('/option-chain')) return;

  const LOG_PREFIX = '[FMC-CHAIN]';
  const log = makeDebugLog(LOG_PREFIX);
  const { STORAGE_KEY_SETTINGS, STORAGE_KEY_STATUS, STORAGE_KEY_CHAIN_ACCOUNT, CHAIN_LIMITS, ERROR_TYPES } = FMC_CONSTANTS;
  const { PRICELIST: BASE_TTL_MS, PROJECTED: EXACT_TTL_MS } = FMC_CONSTANTS.CACHE_TTL_MS;
  const E = ChainEstimate;

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

  let settings = { ...FMC_CONSTANTS.DEFAULT_SETTINGS };
  let base = null;          // { account, priceList, baselineData, bal: {credit, house, avl}, ts }
  let basePromise = null;
  const exactCache = new Map();   // key → { result, ts }
  const samples = new Map();      // groupKey → Map(strike → {strike, eff})
  let hoverTimer = null;
  let hoverBtn = null;
  let observer = null;
  let repaintTimer = null;
  let pillText = '';

  const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const fmt = (n) => (Number.isFinite(n) ? currency.format(n) : '--');
  const clampNum = (raw, min, max, fallback) => {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  // --- Settings ---
  function normalizeSettings() {
    settings.chainQty = Math.round(clampNum(settings.chainQty, 1, CHAIN_LIMITS.QTY_MAX, 1));
    settings.minWithdrawable = clampNum(settings.minWithdrawable, 0, CHAIN_LIMITS.MIN_WITHDRAWABLE_MAX, 0);
  }

  async function loadSettings() {
    try {
      const result = await chrome.storage.sync.get(STORAGE_KEY_SETTINGS);
      const loaded = result[STORAGE_KEY_SETTINGS];
      if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) settings = { ...settings, ...loaded };
    } catch (err) {
      log('could not load settings:', err.message);
    }
    normalizeSettings();
  }

  // --- Page context ---
  /** Underlying ticker for the chain currently shown (symbol box, falling back to the URL). */
  function getUnderlying() {
    const box = document.querySelector('[role="combobox"][aria-label="SYMBOL"], input[aria-label="SYMBOL"]');
    const fromBox = (box?.value ?? box?.textContent ?? '').trim().toUpperCase();
    const fromUrl = new URLSearchParams(location.search).get('symbol')?.trim().toUpperCase();
    return /^[A-Z0-9.]{1,10}$/.test(fromBox) ? fromBox : (fromUrl || null);
  }

  /**
   * Asks Fidelity for the account list (same call the margin calculator page makes) and picks
   * the default tradable brokerage account, else the first tradable one.
   * @returns {Promise<string|null>}
   */
  async function fetchDefaultAccount() {
    const resp = await fetch(FMC_CONSTANTS.API.ACCOUNTS_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: '*/*' },
      credentials: 'include',
      body: JSON.stringify({
        acctCategory: 'Brokerage',
        filters: { returnAcctTradeAttrDetail: true, returnPreferenceDetail: true }
      })
    });
    if (isSessionExpiredResponse(resp)) throw Object.assign(new Error('Session expired'), { type: ERROR_TYPES.SESSION_EXPIRED });
    if (!resp.ok) return null;
    const list = (await resp.json())?.data?.getAccountContext?.acctDetails;
    if (!Array.isArray(list)) return null;
    const usable = list.filter(a => a.acctNum && a.acctSubType === 'Brokerage' && a.acctTradeAttrDetail?.isTradable && !a.preferenceDetail?.isHidden);
    return (usable.find(a => a.preferenceDetail?.isDefaultAcct) ?? usable[0])?.acctNum ?? null;
  }

  /**
   * Account number, in order of preference: the open trade ticket, the account last used by the
   * trade-ticket panel, the account remembered for chain hints, then Fidelity's default account.
   * @returns {Promise<string|null>}
   */
  async function getAccount() {
    const ticket = document.querySelector('ott-account-dropdown, #trade-container-shell')?.textContent ?? '';
    const m = /\(([A-Z]?\d{8,9})\)/.exec(ticket);
    if (m) return m[1];
    try {
      const r = await chrome.storage.local.get([STORAGE_KEY_STATUS, STORAGE_KEY_CHAIN_ACCOUNT]);
      const known = r[STORAGE_KEY_STATUS]?.accountNum ?? r[STORAGE_KEY_CHAIN_ACCOUNT];
      if (known) return known;
      const fetched = await fetchDefaultAccount();
      if (fetched) await chrome.storage.local.set({ [STORAGE_KEY_CHAIN_ACCOUNT]: fetched });
      return fetched;
    } catch (err) {
      if (err?.type === ERROR_TYPES.SESSION_EXPIRED) throw err;
      log('account lookup failed:', err);
      return null;
    }
  }

  // --- Status pill ---
  function setPill(text, kind) {
    pillText = text;
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

  // --- Baseline (current positions + balance) ---
  function readBalance(baselineData) {
    const b = baselineData?.data?.getTradeCalculator?.marginCalcResp?.balance;
    if (!b) return null;
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    return { credit: num(b.marginCreditDebit), house: num(b.houseBalance), avl: num(b.avlToTradeWithoutMarginImpact) };
  }

  async function ensureBase(account) {
    if (base && base.account === account && Date.now() - base.ts < BASE_TTL_MS) return base;
    if (basePromise) return basePromise;
    basePromise = (async () => {
      const { priceList, baselineData, holdings } = await PositionsAPI.fetchStatus(account);
      const bal = readBalance(baselineData);
      if (!priceList.length || !bal) {
        throw Object.assign(new Error('No positions or balance found for this account'), { type: ERROR_TYPES.CLIENT_ERROR });
      }
      // New baseline invalidates everything derived from the old one.
      samples.clear();
      exactCache.clear();
      base = { account, priceList, baselineData, holdings: holdings ?? {}, bal, ts: Date.now() };
      return base;
    })().finally(() => { basePromise = null; });
    return basePromise;
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
    const held = base?.holdings?.[E.optionSymbol(underlying, cell).slice(1)] ?? 0;
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

  function describe(cell, order, r, kind) {
    const lines = [
      `${ACTION_TEXT[order.action]} ${order.qty}× ${cell.expiry} $${cell.strike} ${cell.type} @ ${fmt(cell.price)} — ${kind}`,
      `Cash withdrawable after: ${fmt(r.avl)} (min ${fmt(settings.minWithdrawable)})`,
      `Margin ${r.credit >= 0 ? 'credit' : 'debit'} after: ${fmt(r.credit)}`,
      `House ${r.house >= 0 ? 'surplus' : 'call'}: ${fmt(r.house)}`,
      `Premium: ${r.premium >= 0 ? '+' : ''}${fmt(r.premium)}`
    ];
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
      const b = await ensureBase(account);
      const order = orderFor(underlying, cell);
      const key = exactKey(underlying, cell, order);
      if (exactCache.has(key) && Date.now() - exactCache.get(key).ts < EXACT_TTL_MS) { idlePill(); return; }
      await RateLimiter.acquire();
      const qty = order.qty;
      const orders = [{
        orderSymbol: E.optionSymbol(underlying, cell),
        orderType: 'O',
        orderAction: order.action,
        orderQty: qty,
        price: cell.price
      }];
      const projected = await MarginAPI.fetchMarginCalc(account, orders, () => {}, b.priceList);
      const impact = MarginCalc.computeImpact(projected, b.baselineData, orders);
      if (!impact) throw new Error('No balance in margin response');

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

  // --- Events ---
  function onOver(ev) {
    if (!settings.chainEnabled) return;
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
      if (!settings.chainEnabled || !base) return;
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
      if (muts.some(m => m.type === 'childList' && m.addedNodes.length > 0 && m.target.id !== PILL_ID)) scheduleRepaint();
    });
    observer.observe(document.body, { childList: true, subtree: true });
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
    document.getElementById(PILL_ID)?.remove();
  }

  async function init() {
    await loadSettings();
    if (settings.chainEnabled) enable();
    chrome.storage.onChanged.addListener((changes, area) => {
      const next = changes[STORAGE_KEY_SETTINGS]?.newValue;
      if (area !== 'sync' || !next || typeof next !== 'object') return;
      const wasEnabled = settings.chainEnabled;
      settings = { ...settings, ...next };
      normalizeSettings();
      // Quantity / threshold changes make cached results stale.
      exactCache.clear();
      samples.clear();
      if (settings.chainEnabled && !wasEnabled) enable();
      else if (!settings.chainEnabled && wasEnabled) disable();
      else if (settings.chainEnabled) { idlePill(); scheduleRepaint(); }
    });
  }

  init().catch(err => log('Fatal init error:', err));
})();
