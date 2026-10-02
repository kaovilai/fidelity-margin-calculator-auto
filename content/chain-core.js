// ChainCore — shared plumbing for the option-chain features (content/chain.js hover hints and
// content/roll.js roll assistant): settings, page context, account, baseline (positions +
// current balance), and rate-limited margin calculations. `null` outside the option chain page.
'use strict';
const ChainCore = (() => {
  // The standalone option chain page and Fidelity Trader+ Web (its dashboard embeds the same chain).
  const ON_CHAIN_PAGE = location.pathname.includes('/option-chain') || location.pathname.includes('/traderplus');
  if (!ON_CHAIN_PAGE) return null;

  const log = makeDebugLog('[FMC-CORE]');
  const { STORAGE_KEY_SETTINGS, STORAGE_KEY_STATUS, STORAGE_KEY_CHAIN_ACCOUNT, CHAIN_LIMITS, ERROR_TYPES } = FMC_CONSTANTS;
  const { PRICELIST: BASE_TTL_MS } = FMC_CONSTANTS.CACHE_TTL_MS;

  // Mutated in place (never replaced) so modules can hold the reference.
  const settings = { ...FMC_CONSTANTS.DEFAULT_SETTINGS };
  const settingsListeners = [];
  const baseListeners = [];
  let base = null;
  let basePromise = null;

  const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const fmt = (n) => (Number.isFinite(n) ? currency.format(n) : '--');
  const clampNum = (raw, min, max, fallback) => {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  // --- Settings ---
  function normalize() {
    settings.chainQty = Math.round(clampNum(settings.chainQty, 1, CHAIN_LIMITS.QTY_MAX, 1));
    settings.minWithdrawable = clampNum(settings.minWithdrawable, 0, CHAIN_LIMITS.MIN_WITHDRAWABLE_MAX, 0);
    settings.borrowRate = clampNum(settings.borrowRate, 0, CHAIN_LIMITS.BORROW_RATE_MAX, 4.88);
  }

  async function loadSettings() {
    try {
      const result = await chrome.storage.sync.get(STORAGE_KEY_SETTINGS);
      const loaded = result[STORAGE_KEY_SETTINGS];
      if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) Object.assign(settings, loaded);
    } catch (err) {
      log('could not load settings:', err.message);
    }
    normalize();
    chrome.storage.onChanged.addListener((changes, area) => {
      const next = changes[STORAGE_KEY_SETTINGS]?.newValue;
      if (area !== 'sync' || !next || typeof next !== 'object') return;
      const prev = { ...settings };
      Object.assign(settings, next);
      normalize();
      for (const cb of settingsListeners) cb(settings, prev);
    });
  }

  /** Registers `cb(settings, previousSettings)` for settings changes made in the popup. */
  function onSettings(cb) { settingsListeners.push(cb); }

  // --- Page context ---
  /** Underlying ticker for the chain currently shown (symbol box, falling back to the URL). */
  function getUnderlying() {
    // Trader+ Web: the active symbol is shown in the quote panel (`.symbol-info .code`) and chart title.
    const tp = (document.querySelector('.symbol-info .code, cq-symbol')?.textContent ?? '').trim().toUpperCase();
    if (location.pathname.includes('/traderplus') && /^[A-Z0-9.]{1,10}$/.test(tp)) return tp;
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

  // --- Baseline (current positions + balance) ---
  function readBalance(baselineData) {
    const b = baselineData?.data?.getTradeCalculator?.marginCalcResp?.balance;
    if (!b) return null;
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    return { credit: num(b.marginCreditDebit), house: num(b.houseBalance), avl: num(b.avlToTradeWithoutMarginImpact) };
  }

  /** The cached baseline, or null if none has been fetched yet. */
  function peekBase() { return base; }

  /** Registers `cb()` to run whenever a fresh baseline replaces the old one (derived data is stale). */
  function onNewBase(cb) { baseListeners.push(cb); }

  /**
   * Fetches (or returns the cached) baseline for `account`: price list, current balance, and
   * signed holdings by symbol — all from one current-status call.
   * @param {string} account
   * @returns {Promise<{account: string, priceList: Array, baselineData: Object, holdings: Object,
   *   bal: {credit: number, house: number, avl: number}, ts: number}>}
   */
  async function ensureBase(account) {
    if (base && base.account === account && Date.now() - base.ts < BASE_TTL_MS) return base;
    if (basePromise) return basePromise;
    basePromise = (async () => {
      const { priceList, baselineData, holdings } = await PositionsAPI.fetchStatus(account);
      const bal = readBalance(baselineData);
      if (!priceList.length || !bal) {
        throw Object.assign(new Error('No positions or balance found for this account'), { type: ERROR_TYPES.CLIENT_ERROR });
      }
      base = { account, priceList, baselineData, holdings: holdings ?? {}, bal, ts: Date.now() };
      for (const cb of baseListeners) cb();
      return base;
    })().finally(() => { basePromise = null; });
    return basePromise;
  }

  /**
   * Runs one rate-limited trade-calculator request for `orders` against the cached baseline.
   * @param {string} account
   * @param {Array<Object>} orders
   * @returns {Promise<Object>} MarginCalc impact (projected credit, house balance, withdrawable
   *   cash and their changes from the current balance).
   */
  async function calculate(account, orders) {
    const b = await ensureBase(account);
    // A newer request displaces a waiting one; abandon it instead of sending without a token.
    const slot = await RateLimiter.acquire();
    if (slot.cancelled) throw Object.assign(new Error('superseded by a newer request'), { cancelled: true });
    const projected = await MarginAPI.fetchMarginCalc(account, orders, () => {}, b.priceList);
    const impact = MarginCalc.computeImpact(projected, b.baselineData, orders);
    if (!impact) throw new Error('No balance in margin response');
    return impact;
  }

  return { settings, loadSettings, onSettings, getUnderlying, getAccount, ensureBase, peekBase, onNewBase, calculate, fmt, clampNum, log };
})();
