// MmfModel — pure helpers for the money-market optimizer (content/mmf.js): parsing Fidelity's
// fund screener data, after-tax yields, minimum-balance eligibility, and sizing a move into the
// best fund the balance actually qualifies for. No DOM, no network.
'use strict';
const MmfModel = (() => {
  // Names (shortName) that identify a state-specific muni fund, e.g. "FID NY MUNI MM".
  const STATE_RE = /\b(NY|NJ|MA|CA)\b/;
  const MUNI_RE = /MUNI|TAX[- ]?EX/i;
  const MMF_TICKER_RE = /^[A-Z]{3,4}XX$/;

  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

  /**
   * Fund kind drives how its income is taxed:
   *   - 'taxable'      government/prime/Treasury (repo) funds — federal + state income tax
   *   - 'treasuryOnly' only Treasury interest — federal tax, state-exempt
   *   - 'muni'         national muni — federally exempt, state tax applies
   *   - 'stateMuni'    single-state muni — exempt federally and in that state (`stateCode`)
   * @param {string} shortName
   * @returns {{kind: string, stateCode: string|null}}
   */
  function classify(shortName) {
    const n = (shortName ?? '').toUpperCase();
    if (MUNI_RE.test(n)) {
      const m = STATE_RE.exec(n);
      return m ? { kind: 'stateMuni', stateCode: m[1] } : { kind: 'muni', stateCode: null };
    }
    if (/TREAS(URY)?\s+ONLY/.test(n)) return { kind: 'treasuryOnly', stateCode: null };
    return { kind: 'taxable', stateCode: null };
  }

  /**
   * Parses the screener's `search/v1/funds` response (subject areas fundInformation, dailyNAV,
   * fundFeatures) into a flat list.
   * @param {Object} resp
   * @returns {Array<{ticker: string, name: string, y7: number, minInitial: number,
   *   minBalance: number, kind: string, stateCode: string|null}>} Yields are percents (3.55).
   */
  function parseFunds(resp) {
    const list = Array.isArray(resp?.funds) ? resp.funds : [];
    return list.flatMap(f => {
      const ticker = f?.fundInformation?.ticker;
      const y7 = num(f?.dailyNAV?.daily7DayYield);
      if (!ticker || !MMF_TICKER_RE.test(ticker) || !Number.isFinite(y7)) return [];
      const shortName = f.fundInformation.shortName ?? '';
      const minInitial = num(f?.fundFeatures?.minInitialInvAmount);
      const minBalance = num(f?.fundFeatures?.minBalanceAmount);
      return [{
        ticker,
        name: shortName,
        y7,
        // Unknown minimums are treated as unreachable rather than assumed zero.
        minInitial: Number.isFinite(minInitial) ? minInitial : Infinity,
        minBalance: Number.isFinite(minBalance) ? minBalance : Infinity,
        ...classify(shortName)
      }];
    });
  }

  /**
   * After-tax yield (percent). `rates` are percents: {federal, state}.
   * Returns null for a single-state muni outside the investor's state (not a sensible target).
   */
  function afterTax(fund, rates) {
    const fed = (rates.federal ?? 0) / 100;
    const st = (rates.state ?? 0) / 100;
    switch (fund.kind) {
      case 'taxable':      return fund.y7 * (1 - fed - st);
      case 'treasuryOnly': return fund.y7 * (1 - fed);
      case 'muni':         return fund.y7 * (1 - st);
      case 'stateMuni':    return rates.stateCode && fund.stateCode === rates.stateCode ? fund.y7 : null;
      default:             return null;
    }
  }

  /**
   * Can `amount` dollars be moved into `fund`? Minimum initial investment applies only if the
   * fund isn't already held; the minimum balance applies to the resulting balance either way.
   * @param {Object} fund
   * @param {number} amount - Dollars moving in.
   * @param {number} existing - Dollars already held in this fund.
   * @returns {{ok: boolean, reason: string|null}}
   */
  function qualifies(fund, amount, existing) {
    if (existing <= 0 && amount < fund.minInitial) {
      return { ok: false, reason: `needs $${fund.minInitial.toLocaleString('en-US')} to open` };
    }
    if (existing + amount < fund.minBalance) {
      return { ok: false, reason: `needs a $${fund.minBalance.toLocaleString('en-US')} minimum balance` };
    }
    return { ok: true, reason: null };
  }

  /**
   * Plans a move of money-market balances into the highest after-tax fund the balance qualifies for.
   * Only balances in funds that yield LESS (after tax) than the target are moved. Funds ranked above
   * the chosen target that were skipped because of minimums are reported with the reason.
   * @param {Object} p
   * @param {Array} p.funds - parseFunds() output.
   * @param {Object<string, number>} p.holdings - Dollars by money-market ticker in the account.
   * @param {{federal: number, state: number, stateCode?: string}} p.rates
   * @param {number} [p.reserve=0] - Dollars to leave untouched in total.
   * @param {number} [p.minGap=0] - Minimum after-tax advantage (percentage points) a target must have
   *   over a balance before that balance is worth moving; smaller differences aren't worth an exchange.
   * @returns {{target: Object|null, moves: Array<{from: string, dollars: number}>, amountIn: number,
   *   annualGain: number, skipped: Array<{ticker: string, afterTax: number, reason: string}>,
   *   ranked: Array}} annualGain is dollars per year at today's yields.
   */
  function plan({ funds, holdings, rates, reserve = 0, minGap = 0 }) {
    const byTicker = new Map(funds.map(f => [f.ticker, f]));
    const scored = funds
      .map(f => ({ fund: f, at: afterTax(f, rates) }))
      .filter(s => s.at !== null)
      .sort((a, b) => b.at - a.at);
    const held = Object.entries(holdings).filter(([, d]) => d > 0);
    let reserveLeft = Math.max(0, reserve);
    const skipped = [];
    for (const { fund, at } of scored) {
      // Balances yielding less after tax than this candidate are the ones worth moving.
      const sources = held
        .filter(([t]) => t !== fund.ticker)
        .map(([t, d]) => ({ t, d, at: byTicker.has(t) ? afterTax(byTicker.get(t), rates) : null }))
        .filter(s => s.at === null || s.at < at - Math.max(minGap, 0) - 1e-9);
      let movable = sources.reduce((s, x) => s + x.d, 0) - reserveLeft;
      movable = Math.floor(Math.max(0, movable) * 100 + 1e-6) / 100;
      if (movable <= 0) continue;
      const existing = holdings[fund.ticker] ?? 0;
      const q = qualifies(fund, movable, existing);
      if (!q.ok) { skipped.push({ ticker: fund.ticker, afterTax: at, reason: q.reason }); continue; }
      // Take from the lowest-yielding sources first, honouring the reserve.
      let toMove = movable;
      const moves = [];
      for (const s of sources.sort((a, b) => (a.at ?? -1) - (b.at ?? -1))) {
        if (toMove <= 0) break;
        const dollars = Math.min(s.d, toMove);
        moves.push({ from: s.t, dollars: Math.round(dollars * 100) / 100 });
        toMove -= dollars;
      }
      const annualGain = moves.reduce((sum, m) => {
        const src = byTicker.get(m.from);
        const srcAt = src ? afterTax(src, rates) : null;
        return sum + (srcAt === null ? 0 : (m.dollars * (at - srcAt)) / 100);
      }, 0);
      return { target: { ...fund, afterTax: at }, moves, amountIn: moves.reduce((s, m) => s + m.dollars, 0), annualGain, skipped, ranked: scored };
    }
    return { target: null, moves: [], amountIn: 0, annualGain: 0, skipped, ranked: scored };
  }

  /**
   * Alert persistence for the daily check: a new leader must be recommended on `needed` consecutive
   * checks before the user is told, and is told only once until the recommendation changes or lapses.
   * Prevents flip-flopping between funds a few basis points apart from producing repeat alerts.
   * @param {{target: string|null, days: number, notified: string|null}|undefined} prev - Prior state.
   * @param {string|null} candidate - Today's recommended target ticker (already gap-filtered), or null.
   * @param {number} needed - Consecutive checks required.
   * @returns {{state: {target: string|null, days: number, notified: string|null}, notify: boolean}}
   */
  function advanceStreak(prev, candidate, needed) {
    if (!candidate) return { state: { target: null, days: 0, notified: null }, notify: false };
    const same = prev?.target === candidate;
    const days = same ? (prev.days ?? 0) + 1 : 1;
    const alreadyNotified = same && prev.notified === candidate;
    const notify = days >= needed && !alreadyNotified;
    return { state: { target: candidate, days, notified: notify ? candidate : (same ? prev.notified ?? null : null) }, notify };
  }

  return { classify, parseFunds, afterTax, qualifies, plan, advanceStreak, MMF_TICKER_RE };
})();
