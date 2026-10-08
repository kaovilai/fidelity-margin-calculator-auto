// TicketAssist — enhances the trade ticket's strike and expiration dropdowns, which otherwise
// show bare numbers/dates, with each option's volume and open interest (and a proportional bar),
// so you can pick liquid strikes and dates without leaving the ticket. Runs wherever the ticket
// appears (portfolio, option chain, research pages, Trader+). Read-only: the data comes from the
// same chain endpoint the margin calculator page uses, and the text is drawn with CSS (`::after`)
// so it can never leak into the value Fidelity copies from the selected option.
'use strict';
(() => {
  const log = makeDebugLog('[FMC-TICKET]');
  const R = RollModel;
  const { STORAGE_KEY_SETTINGS } = FMC_CONSTANTS;
  const LIST_SELECTOR = '[id^="strike_price_list-"], [id^="expirations_list-"]';
  const STRIKE_OPT = 'button.ott-strike-option-button';
  const EXP_OPT = 'button.ott-expiration-option-button';
  const EXPIRY_FETCH_CONCURRENCY = 4;
  const MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

  let enabled = true;
  let hurdle = FMC_CONSTANTS.DEFAULT_SETTINGS.borrowRate / 100;
  let observer = null;
  let scanTimer = null;

  /** 1234 → "1.2k", 1500000 → "1.5M". */
  function compact(n) {
    if (!Number.isFinite(n)) return '--';
    if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
    return String(Math.round(n));
  }

  /** `Nov 20, 2026` → `2026-11-20`, or null. */
  function isoFromTicket(text) {
    const m = /([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s+(\d{4})/.exec(text ?? '');
    const mo = m && MON[m[1].toLowerCase()];
    return mo ? `${m[3]}-${mo}-${m[2].padStart(2, '0')}` : null;
  }

  function legContext(leg) {
    const symbol = (document.querySelector('#symbol_search')?.value ?? '').trim().toUpperCase().match(/^[A-Z][A-Z0-9.]*/)?.[0];
    const isCall = document.getElementById(`call-put-${leg}-call`);
    const isPut = document.getElementById(`call-put-${leg}-put`);
    const radioType = (isCall?.getAttribute('aria-checked') === 'true' || isCall?.checked) ? 'call'
      : (isPut?.getAttribute('aria-checked') === 'true' || isPut?.checked) ? 'put' : null;
    // The Roll ticket has no call/put radios — the type only appears in the expiration label
    // ("Put Expiration") and in each expiration option ("Oct 09, 2026 Put").
    const type = radioType ?? /\b(call|put)\b/i.exec(
      document.querySelector(`#exp_dropdown_label-${leg}`)?.textContent
      ?? document.querySelector(`#expirations_list-${leg} button[role="option"]`)?.textContent ?? ''
    )?.[1].toLowerCase() ?? null;
    const expiry = isoFromTicket(document.querySelector(`#exp_dropdown-${leg} .binding-val`)?.textContent);
    return { symbol, type, expiry };
  }

  function mark(btn, volume, openInterest, maxVolume, stats) {
    btn.classList.add('fmc-vol-opt');
    btn.classList.toggle('fmc-vol-hit', !!stats && stats.annual >= hurdle);
    btn.dataset.fmcVol = `vol ${compact(volume)} · OI ${compact(openInterest)}${stats ? ` · ${R.formatStats(stats)}` : ''}`;
    // Square-root scale with a floor: strikes trade very unevenly, so a linear bar makes anything
    // below the busiest strike almost invisible.
    const pct = maxVolume > 0 && Number.isFinite(volume) && volume > 0
      ? Math.min(100, Math.max(6, Math.sqrt(volume / maxVolume) * 100)) : 0;
    btn.classList.toggle('fmc-vol-has', pct > 0);
    btn.style.setProperty('--fmc-vol-pct', `${pct.toFixed(1)}%`);
  }

  async function annotateStrikes(list, leg) {
    const { symbol, type, expiry } = legContext(leg);
    if (!symbol || !type || !expiry) return;
    const key = `strike|${symbol}|${type}|${expiry}|${document.querySelector(`#action_dropdown-${leg} .binding-val`)?.textContent?.trim()}|${TaxContext.enabled()}`;
    if (list.dataset.fmcVolKey === key) return;
    list.dataset.fmcVolKey = key;
    const exp = (await ChainAPI.fetchExpirations(symbol)).find(e => e.date === expiry);
    if (!exp) return;
    const rows = R.chainRows(await ChainAPI.fetchChain(symbol, exp), type);
    const byStrike = new Map(rows.map(r => [r.strike, r]));
    const maxVolume = Math.max(0, ...rows.map(r => r.volume ?? 0));
    // For sell-to-open legs also show the annualized yield if the extrinsic value is captured.
    const selling = /sell\s+to\s+open/i.test(document.querySelector(`#action_dropdown-${leg} .binding-val`)?.textContent ?? '');
    const px = selling ? await ChainAPI.fetchUnderlyingPrice(symbol).catch(() => null) : null;
    if (selling) await TaxContext.ready();
    for (const btn of list.querySelectorAll(STRIKE_OPT)) {
      const strike = parseFloat(btn.textContent);
      const row = byStrike.get(strike);
      if (!row) continue;
      const stats = px ? TaxContext.apply(R.optionStats({ type, strike, price: row.bid, underlying: px, expiry, iv: row.iv, delta: row.delta })) : null;
      mark(btn, row.volume, row.openInterest, maxVolume, stats);
    }
  }

  async function annotateExpirations(list, leg) {
    const { symbol, type } = legContext(leg);
    if (!symbol || !type) return;
    const key = `exp|${symbol}|${type}`;
    if (list.dataset.fmcVolKey === key) return;
    list.dataset.fmcVolKey = key;
    const known = new Map((await ChainAPI.fetchExpirations(symbol)).map(e => [e.date, e]));
    const totals = new Map(); // button → { volume, openInterest }
    const repaint = () => {
      const max = Math.max(0, ...[...totals.values()].map(t => t.volume));
      for (const [btn, t] of totals) mark(btn, t.volume, t.openInterest, max);
    };
    const load = async btn => {
      const exp = known.get(isoFromTicket(btn.textContent));
      if (!exp || !btn.isConnected) return;
      try {
        const rows = R.chainRows(await ChainAPI.fetchChain(symbol, exp), type);
        totals.set(btn, {
          volume: rows.reduce((s, r) => s + (r.volume ?? 0), 0),
          openInterest: rows.reduce((s, r) => s + (r.openInterest ?? 0), 0)
        });
        repaint();
      } catch (err) {
        requested.delete(btn); // allow a retry the next time it scrolls into view
        log('expiry volume failed:', err.message);
      }
    };
    // Lazy: each expiry is one chain request, so only options that scroll into view are fetched,
    // through a small worker pool (ChainAPI caches responses briefly).
    const requested = new Set();
    const visible = new Set();
    const queue = [];
    let active = 0;
    const pump = () => {
      while (active < EXPIRY_FETCH_CONCURRENCY && queue.length) {
        const btn = queue.shift();
        if (!visible.has(btn)) { requested.delete(btn); continue; } // scrolled past before its turn
        active++;
        load(btn).finally(() => { active--; pump(); });
      }
    };
    const io = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting) { visible.delete(e.target); continue; }
        visible.add(e.target);
        if (!requested.has(e.target)) { requested.add(e.target); queue.push(e.target); }
      }
      pump();
    });
    for (const btn of list.querySelectorAll(EXP_OPT)) io.observe(btn);
  }

  function scan() {
    if (!enabled) return;
    for (const list of document.querySelectorAll(LIST_SELECTOR)) {
      if (!list.querySelector('button[role="option"]')) continue;
      const m = /-(\d+)$/.exec(list.id);
      if (!m) continue;
      const task = list.id.startsWith('strike_price_list') ? annotateStrikes(list, Number(m[1])) : annotateExpirations(list, Number(m[1]));
      task.catch(err => { log('annotate failed:', err.message); delete list.dataset.fmcVolKey; });
    }
  }

  function schedule() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 200);
  }

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
    for (const b of document.querySelectorAll('.fmc-vol-opt')) {
      b.classList.remove('fmc-vol-opt', 'fmc-vol-has', 'fmc-vol-hit');
      delete b.dataset.fmcVol;
      b.style.removeProperty('--fmc-vol-pct');
    }
    for (const l of document.querySelectorAll('[data-fmc-vol-key]')) delete l.dataset.fmcVolKey;
  }

  async function init() {
    try {
      const r = await chrome.storage.sync.get(STORAGE_KEY_SETTINGS);
      if (r[STORAGE_KEY_SETTINGS]?.chainEnabled === false) enabled = false;
      const rate = Number(r[STORAGE_KEY_SETTINGS]?.borrowRate);
      if (Number.isFinite(rate)) hurdle = rate / 100;
    } catch { /* defaults */ }
    if (enabled) start();
    chrome.storage.onChanged.addListener((changes, area) => {
      const next = changes[STORAGE_KEY_SETTINGS]?.newValue;
      if (area !== 'sync' || !next) return;
      const rate = Number(next.borrowRate);
      if (Number.isFinite(rate)) hurdle = rate / 100;
      const now = next.chainEnabled !== false;
      if (now && !enabled) { enabled = true; start(); }
      else if (!now && enabled) { enabled = false; stop(); }
    });
  }

  init().catch(err => log('Fatal init error:', err));
})();
