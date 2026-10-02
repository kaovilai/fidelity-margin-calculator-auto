// TaxContext — the user's resolved marginal tax rates, shared by every content script that shows an
// after-tax figure (option yields, money-market optimizer). Settings come from chrome.storage.sync;
// live federal/state rates come from the background worker (cached 30 days) and are resolved by
// TaxRates. Until the live rates arrive, the configured fallbacks (24% federal, 4.25% state) apply,
// so callers can always render immediately and refine when `onChange` fires.
'use strict';
const TaxContext = (() => {
  const { STORAGE_KEY_SETTINGS, MESSAGE_TYPES } = FMC_CONSTANTS;
  const LIVE_TIMEOUT_MS = 25000;
  const log = makeDebugLog('[FMC-TAX]');

  const settings = { ...FMC_CONSTANTS.DEFAULT_SETTINGS };
  const listeners = [];
  let live = null;
  let liveState = null;     // state the cached live data was fetched for
  let readyPromise = null;

  const number = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

  function config() {
    return {
      filing: settings.taxFiling || 'single',
      income: number(settings.taxIncome) ?? 150000,
      state: String(settings.taxState || 'NC').toUpperCase(),
      federalOverride: number(settings.taxFederalOverride),
      stateOverride: number(settings.taxStateOverride),
      federalFallback: 24,
      stateFallback: 4.25
    };
  }

  /** The resolved rates right now (live if available, else configured/fallback). */
  function rates() {
    return TaxRates.resolve({ config: config(), live });
  }

  const enabled = () => settings.yieldAfterTax === true;

  /** Fraction of income kept after federal + state tax (e.g. 0.7175). */
  function keepFraction() {
    const r = rates();
    return Math.max(0, 1 - (r.federal + r.state) / 100);
  }

  /** Human-readable rate summary, e.g. "24% fed + 4.25% NC". */
  function label() {
    const r = rates();
    return `${r.federal}% fed + ${r.state}% ${r.stateCode}`;
  }

  /**
   * Returns option stats scaled to after-tax when the user enabled it (premium is taxed as
   * ordinary short-term income), flagged `afterTax: true`. Probability is unaffected.
   * @param {Object|null} stats - RollModel.optionStats output.
   */
  function apply(stats) {
    if (!stats || !enabled()) return stats;
    const k = keepFraction();
    return { ...stats, period: stats.period * k, annual: stats.annual * k, afterTax: true };
  }

  function request(state) {
    return new Promise((resolve) => {
      if (!chrome.runtime?.sendMessage) { resolve(null); return; }
      const timer = setTimeout(() => resolve(null), LIVE_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage({ type: MESSAGE_TYPES.FETCH_TAX_RATES, payload: { state }, _fmc: true }, (resp) => {
          clearTimeout(timer);
          resolve(chrome.runtime.lastError || !resp || resp.error ? null : resp);
        });
      } catch { clearTimeout(timer); resolve(null); }
    });
  }

  async function refreshLive() {
    const state = config().state;
    if (live && liveState === state) return;
    const data = await request(state);
    if (data) { live = data; liveState = state; log('live rates:', JSON.stringify(rates())); }
    for (const cb of listeners) cb();
  }

  async function loadSettings() {
    try {
      const r = await chrome.storage.sync.get(STORAGE_KEY_SETTINGS);
      const loaded = r[STORAGE_KEY_SETTINGS];
      if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) Object.assign(settings, loaded);
    } catch { /* defaults */ }
  }

  /**
   * Resolves once settings are loaded and, if after-tax figures are needed (`wantLive`), the live
   * rates have been requested. Safe to call repeatedly.
   * @param {boolean} [wantLive=true]
   */
  function ready(wantLive = true) {
    if (!readyPromise) {
      readyPromise = loadSettings().then(() => {
        chrome.storage.onChanged.addListener((changes, area) => {
          const next = changes[STORAGE_KEY_SETTINGS]?.newValue;
          if (area !== 'sync' || !next || typeof next !== 'object') return;
          Object.assign(settings, next);
          refreshLive().catch(() => {});
          for (const cb of listeners) cb();
        });
      });
    }
    return readyPromise.then(() => (wantLive && (enabled() || settings.mmfEnabled !== false) ? refreshLive() : undefined));
  }

  /** Registers `cb()` for changes to the settings or the resolved live rates. */
  function onChange(cb) { listeners.push(cb); }

  return { ready, rates, enabled, keepFraction, label, apply, onChange, settings };
})();
