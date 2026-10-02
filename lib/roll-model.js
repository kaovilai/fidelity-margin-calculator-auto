// RollModel — pure helpers for the roll assistant (content/roll.js): parsing held option
// symbols, pricing the two legs of a roll, generating and ranking roll candidates, and building
// the two-order trade-calculator request. No DOM, no network.
'use strict';
const RollModel = (() => {
  const CONTRACT_SHARES = 100;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Held-option symbols as the current-status API reports them: ticker + YYMMDD + P/C + strike.
  const OCC_RE = /^([A-Z][A-Z0-9.]*?)(\d{2})(\d{2})(\d{2})([PC])(\d+(?:\.\d+)?)$/;

  /**
   * Parses an option symbol such as `F271217P10` (a leading `-` is tolerated).
   * @param {string} sym
   * @returns {{underlying: string, expiryCode: string, expiry: string, type: 'put'|'call',
   *   strike: number}|null}
   */
  function parseOcc(sym) {
    const m = OCC_RE.exec((sym ?? '').replace(/^-/, ''));
    if (!m) return null;
    const month = Number(m[3]);
    const day = Number(m[4]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const strike = Number(m[6]);
    if (!Number.isFinite(strike) || strike <= 0) return null;
    return {
      underlying: m[1],
      expiryCode: `${m[2]}${m[3]}${m[4]}`,
      expiry: `20${m[2]}-${m[3]}-${m[4]}`,
      type: m[5] === 'P' ? 'put' : 'call',
      strike
    };
  }

  /** Short label such as `Dec 17 '27 $10 put`. */
  function describeOption(opt) {
    const [y, mo, d] = opt.expiry.split('-');
    return `${MONTHS[Number(mo) - 1]} ${Number(d)} '${y.slice(2)} $${opt.strike} ${opt.type}`;
  }

  /**
   * `settlementTypes` value the chain endpoint expects, e.g. `Oct 16 2026|M`.
   * @param {string} isoDate - `2026-10-16`.
   * @param {string} [periodicity='M'] - `M` (monthly) or `W` (weekly) from option-expirations.
   */
  function settlementType(isoDate, periodicity = 'M') {
    const [y, mo, d] = isoDate.split('-');
    return `${MONTHS[Number(mo) - 1]} ${d} ${y}|${periodicity}`;
  }

  /** `10/16/2026` — the chain endpoint's `expirationDates` format. */
  function usDate(isoDate) {
    const [y, mo, d] = isoDate.split('-');
    return `${mo}/${d}/${y}`;
  }

  /**
   * Which orders roll a held position: close it, then open the same side again.
   * @param {number} shares - Signed shares held (negative = short).
   * @returns {{short: boolean, closeAction: string, openAction: string, qty: number}}
   */
  function legsFor(shares) {
    const short = shares < 0;
    return {
      short,
      closeAction: short ? 'BC' : 'SC',
      openAction: short ? 'SO' : 'BO',
      qty: Math.abs(shares)
    };
  }

  const valid = (n) => Number.isFinite(n) && n > 0;
  const mid = (q) => Math.round(((q.bid + q.ask) / 2) * 100) / 100;

  /**
   * Price to close the held leg: a short is bought back at the ask, a long is sold at the bid
   * ("natural"); "mid" uses the midpoint. Null if the quote is unusable.
   * @param {{bid: number, ask: number}} quote
   * @param {boolean} short
   * @param {'natural'|'mid'} mode
   */
  function closePrice(quote, short, mode) {
    if (!quote || !valid(quote.bid + quote.ask) || !valid(quote.ask)) return null;
    const p = mode === 'mid' ? mid(quote) : (short ? quote.ask : quote.bid);
    return valid(p) ? p : null;
  }

  /** Price to open the new leg: a short is sold at the bid, a long bought at the ask. */
  function openPrice(quote, short, mode) {
    if (!quote || !valid(quote.ask)) return null;
    const p = mode === 'mid' ? mid(quote) : (short ? quote.bid : quote.ask);
    return valid(p) ? p : null;
  }

  /**
   * Net cash of a roll in dollars: positive = credit. Null when either price is unusable.
   * @param {number|null} close - Price paid (short) / received (long) to close.
   * @param {number|null} open - Price received (short) / paid (long) to open.
   * @param {boolean} short
   * @param {number} qty - Contracts.
   */
  function rollNet(close, open, short, qty) {
    if (!valid(close) || !valid(open) || !valid(qty)) return null;
    const perShare = short ? open - close : close - open;
    return Math.round(perShare * CONTRACT_SHARES * qty * 100) / 100;
  }

  /**
   * Rows of one option type from a `slo-chain/v1` response.
   * @param {Object} resp
   * @param {'put'|'call'} type
   * @returns {Array<{strike: number, bid: number, ask: number, symbol: string, delta: number|null,
   *   iv: number|null, volume: number|null, openInterest: number|null}>}
   */
  function chainRows(resp, type) {
    const rows = resp?.callsAndPuts;
    if (!Array.isArray(rows)) return [];
    return rows.flatMap(r => {
      const bid = Number(r[`${type}Bid`]);
      const ask = Number(r[`${type}Ask`]);
      const symbol = r[`${type}Selection`];
      const strike = Number(r.strike);
      const delta = Number(r[`${type}Delta`]);
      const iv = Number(r[`${type}ImpliedVolatility`]);
      const volume = Number(r[`${type}Volume`]);
      const openInterest = Number(r[`${type}OpenInterest`]);
      if (!Number.isFinite(strike) || !Number.isFinite(bid) || !Number.isFinite(ask) || !symbol) return [];
      return [{
        strike, bid, ask, symbol,
        delta: Number.isFinite(delta) ? delta : null,
        iv: Number.isFinite(iv) && iv > 0 ? iv : null,
        volume: Number.isFinite(volume) ? volume : null,
        openInterest: Number.isFinite(openInterest) ? openInterest : null
      }];
    });
  }

  /**
   * Builds and prices roll candidates from per-expiry chain rows.
   * Candidates are in the same expiry or later; the source contract itself is excluded.
   * @param {Object} p
   * @param {{type: string, strike: number, expiry: string}} p.source
   * @param {{bid: number, ask: number}} p.sourceQuote
   * @param {number} p.shares - Signed shares held.
   * @param {Map<string, Array>} p.rowsByExpiry - ISO expiry → chainRows output.
   * @param {'natural'|'mid'} [p.mode='natural']
   * @param {number} [p.window=0.25] - Keep strikes within ±window × source strike.
   * @param {number} [p.maxFavorableDelta=0.5] - Rolling toward the money (up for puts, down for
   *   calls) is only offered for strikes with |delta| at or below this — i.e. not in the money.
   *   Rolling away from the money (the adverse direction) is unrestricted: after a big move the
   *   right strike may well still be in the money.
   * @returns {Array<{expiry: string, strike: number, symbol: string, direction: 'out'|'up'|'down',
   *   closePrice: number, openPrice: number, net: number}>}
   */
  function candidates({ source, sourceQuote, shares, rowsByExpiry, mode = 'natural', window = 0.25, maxFavorableDelta = 0.5 }) {
    const { short, qty } = legsFor(shares);
    const close = closePrice(sourceQuote, short, mode);
    if (close === null) return [];
    const out = [];
    for (const [expiry, rows] of rowsByExpiry) {
      if (expiry < source.expiry) continue;
      for (const row of rows) {
        if (expiry === source.expiry && row.strike === source.strike) continue;
        if (Math.abs(row.strike - source.strike) > window * source.strike) continue;
        const adverse = row.strike !== source.strike && (adverseDirection(source.type) === 'down' ? row.strike < source.strike : row.strike > source.strike);
        const favorable = row.strike !== source.strike && !adverse;
        if (favorable && row.delta !== null && Math.abs(row.delta) > maxFavorableDelta) continue;
        const open = openPrice(row, short, mode);
        const net = rollNet(close, open, short, qty);
        if (net === null) continue;
        out.push({
          expiry,
          strike: row.strike,
          symbol: row.symbol,
          direction: row.strike === source.strike ? 'out' : (row.strike > source.strike ? 'up' : 'down'),
          closePrice: close,
          openPrice: open,
          net,
          delta: row.delta ?? null,
          iv: row.iv ?? null
        });
      }
    }
    return out;
  }

  /**
   * Best `n` candidates per direction, highest net credit first (ties: sooner expiry, then
   * strike closest to the source).
   * @param {Array} cands - Output of candidates().
   * @param {{strike: number}} source
   * @param {number} [n=5]
   * @param {boolean} [creditOnly=false]
   * @returns {{out: Array, up: Array, down: Array}}
   */
  function topByDirection(cands, source, n = 5, creditOnly = false) {
    const groups = { out: [], up: [], down: [] };
    for (const c of cands) {
      if (creditOnly && c.net < 0) continue;
      groups[c.direction].push(c);
    }
    for (const dir of Object.keys(groups)) {
      groups[dir].sort((a, b) =>
        b.net - a.net ||
        (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0) ||
        Math.abs(a.strike - source.strike) - Math.abs(b.strike - source.strike));
      groups[dir] = groups[dir].slice(0, n);
    }
    return groups;
  }

  /**
   * Direction in which a roll moves AWAY from the money for the position's type — the way you
   * roll when the stock moves against you: down for puts, up for calls.
   * @param {'put'|'call'} type
   * @returns {'down'|'up'}
   */
  function adverseDirection(type) {
    return type === 'put' ? 'down' : 'up';
  }

  /**
   * The "neutral frontier": for each expiry, how far you can roll in the adverse direction while
   * the roll still nets at least `target` dollars (0 = no money paid in). Net improves toward the
   * money, so the furthest strike that still clears `target` is the answer; the next strike beyond
   * it (net below target) is returned for context. Expiries where even the nearest candidate
   * misses `target` are listed with `best: null`.
   * @param {Array} cands - Output of candidates().
   * @param {{type: string, strike: number}} source
   * @param {number} [target=0] - Minimum acceptable net (dollars; negative allows a small debit).
   * @returns {Array<{expiry: string, best: Object|null, beyond: Object|null}>} Sorted by expiry.
   */
  function neutralFrontier(cands, source, target = 0) {
    const dir = adverseDirection(source.type);
    const byExpiry = new Map();
    for (const c of cands) {
      // Candidates strictly in the adverse direction (or the same strike when rolling out only).
      const along = dir === 'down' ? c.strike <= source.strike : c.strike >= source.strike;
      if (!along) continue;
      if (!byExpiry.has(c.expiry)) byExpiry.set(c.expiry, []);
      byExpiry.get(c.expiry).push(c);
    }
    const result = [];
    for (const [expiry, rows] of byExpiry) {
      // Order from the source strike outward in the adverse direction.
      rows.sort((a, b) => (dir === 'down' ? b.strike - a.strike : a.strike - b.strike));
      let best = null;
      let beyond = null;
      for (const r of rows) {
        if (r.net >= target) best = r;
        else { beyond = r; break; }
      }
      result.push({ expiry, best, beyond });
    }
    return result.sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : 0));
  }

  /**
   * Annualized yield of a SHORT option if all of its extrinsic (time) value is captured — i.e. it
   * decays fully while the intrinsic part stays at risk. Capital is the cash-secured basis:
   * the strike for a put, the underlying price for a (covered) call.
   *
   *   extrinsic = max(0, premium − intrinsic);  yield = extrinsic / capital × 365 / days
   *
   * @param {Object} p
   * @param {'put'|'call'} p.type
   * @param {number} p.strike
   * @param {number} p.price - Option price per share (the bid you would sell at).
   * @param {number} p.underlying - Underlying price per share.
   * @param {string} p.expiry - ISO date.
   * @param {string} [p.today] - ISO date (default: today, local).
   * @returns {{extrinsic: number, capital: number, days: number, annual: number}|null}
   *   `annual` is a fraction (0.062 = 6.2%/yr). Null when inputs are unusable or no extrinsic remains.
   */
  function annualizedYield({ type, strike, price, underlying, expiry, today }) {
    if (!valid(strike) || !valid(price) || !valid(underlying)) return null;
    const intrinsic = type === 'put' ? Math.max(0, strike - underlying) : Math.max(0, underlying - strike);
    const extrinsic = Math.round((price - intrinsic) * 100) / 100;
    if (extrinsic <= 0) return null;
    const capital = type === 'put' ? strike : underlying;
    const day = (iso) => Date.parse(`${iso}T00:00:00Z`);
    const t0 = today ?? new Date().toLocaleDateString('en-CA'); // local date as YYYY-MM-DD
    const days = Math.max(1, Math.round((day(expiry) - day(t0)) / 86400000));
    const period = extrinsic / capital;
    return { extrinsic, capital, days, period, annual: period * (365 / days) };
  }

  // Standard normal CDF (Abramowitz & Stegun 7.1.26 erf approximation; error < 1.5e-7).
  function normCdf(x) {
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const poly = ((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592;
    const erf = 1 - poly * t * Math.exp(-(x * x) / 2);
    return 0.5 * (1 + (x >= 0 ? erf : -erf));
  }

  /**
   * Probability that a SHORT option is profitable at expiration: the underlying finishes beyond
   * the breakeven (strike − premium for a put, strike + premium for a call). Lognormal model
   * with zero drift and the option's implied volatility; falls back to 1 − |delta| (the chance
   * of finishing out of the money) when IV is unavailable.
   * @param {Object} p
   * @param {'put'|'call'} p.type
   * @param {number} p.strike
   * @param {number} p.price - Premium received per share.
   * @param {number} p.underlying
   * @param {number} p.days - Calendar days to expiry (≥ 1).
   * @param {number|null} [p.iv] - Implied volatility as a fraction (0.45 = 45%).
   * @param {number|null} [p.delta]
   * @returns {number|null} Probability in [0, 1], or null if it cannot be estimated.
   */
  function profitProbability({ type, strike, price, underlying, days, iv, delta }) {
    if (valid(iv) && valid(underlying) && valid(days)) {
      const breakeven = type === 'put' ? strike - price : strike + price;
      if (breakeven <= 0) return type === 'put' ? 1 : null;
      const sd = iv * Math.sqrt(days / 365);
      const d2 = (Math.log(underlying / breakeven) - (sd * sd) / 2) / sd;
      return Math.min(1, Math.max(0, type === 'put' ? normCdf(d2) : normCdf(-d2)));
    }
    return Number.isFinite(delta) ? Math.min(1, Math.max(0, 1 - Math.abs(delta))) : null;
  }

  /**
   * Everything the UI shows for a short option: period return, annualized return, and profit
   * probability, if all extrinsic value is captured.
   * @returns {{extrinsic: number, capital: number, days: number, period: number, annual: number,
   *   pop: number|null}|null}
   */
  function optionStats(p) {
    const y = annualizedYield(p);
    if (!y) return null;
    return { ...y, pop: profitProbability({ ...p, days: y.days }) };
  }

  /** `2.4% · 62%/yr · POP 81%` (POP omitted when unknown). */
  function formatStats(s) {
    const pct = (f) => `${(f * 100).toFixed(f >= 0.1 ? 0 : 1)}%`;
    // `afterTax` is set by TaxContext.apply() when the user chose after-tax yields.
    return `${pct(s.period)} · ${pct(s.annual)}/yr${s.afterTax ? ' after-tax' : ''}${s.pop != null ? ` · POP ${Math.round(s.pop * 100)}%` : ''}`;
  }

  /** `6.2%` style text for an annual yield fraction. */
  function formatYield(annual) {
    return `${(annual * 100).toFixed(annual >= 0.1 ? 0 : 1)}%`;
  }

  /**
   * The two orders of a roll for the trade-calculator request (close first, then open).
   * @param {string} sourceSymbol - Held option symbol (with or without leading `-`).
   * @param {string} targetSymbol - New option symbol (with or without leading `-`).
   * @param {number} shares - Signed shares held.
   * @param {number} closePx
   * @param {number} openPx
   * @returns {Array<{orderSymbol: string, orderType: string, orderAction: string, orderQty: number, price: number}>}
   */
  function buildOrders(sourceSymbol, targetSymbol, shares, closePx, openPx) {
    const { closeAction, openAction, qty } = legsFor(shares);
    const sym = (s) => (s.startsWith('-') ? s : `-${s}`);
    return [
      { orderSymbol: sym(sourceSymbol), orderType: 'O', orderAction: closeAction, orderQty: qty, price: closePx },
      { orderSymbol: sym(targetSymbol), orderType: 'O', orderAction: openAction, orderQty: qty, price: openPx }
    ];
  }

  return {
    parseOcc, describeOption, settlementType, usDate, legsFor, closePrice, openPrice,
    rollNet, chainRows, candidates, topByDirection, adverseDirection, neutralFrontier, buildOrders,
    annualizedYield, formatYield, profitProbability, optionStats, formatStats
  };
})();
