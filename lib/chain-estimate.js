// ChainEstimate — pure helpers for the option-chain annotator (content/chain.js):
// parsing chain-cell labels, building option symbols, and estimating the margin impact of
// un-calculated strikes from strikes that were calculated exactly. No DOM, no network.
'use strict';
const ChainEstimate = (() => {
  const MONTHS = Object.freeze({
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
  });
  // Option contract multiplier — a contract covers 100 shares.
  const CONTRACT_SHARES = 100;
  // Estimates are flagged "verify" when the classification could flip within this band:
  // a relative term on the interpolated requirement plus a fixed dollar cushion.
  const UNCERTAINTY_REL = 0.15;
  const UNCERTAINTY_FIXED = 25;

  // e.g. "sell Oct 16 2026 24 put at bid of 1.29" (Fidelity's accessible name for a chain cell)
  const LABEL_RE = /^(sell|buy) ([a-z]{3}) (\d{1,2}) (\d{4}) (\d+(?:\.\d+)?) (call|put) at (bid|ask) of (\d+(?:\.\d+)?)$/i;

  /**
   * Parses a chain cell's accessible name into its trade parameters.
   * @param {string|null|undefined} label
   * @returns {{side: 'sell'|'buy', expiry: string, strike: number, type: 'call'|'put',
   *   quote: 'bid'|'ask', price: number, expiryCode: string}|null}
   *   `expiry` is ISO (2026-10-16); `expiryCode` is the OCC YYMMDD part (261016).
   *   Null when the label is not a chain cell or has no usable price.
   */
  function parseLabel(label) {
    const m = LABEL_RE.exec((label ?? '').trim());
    if (!m) return null;
    const month = MONTHS[m[2].toLowerCase()];
    if (!month) return null;
    const day = m[3].padStart(2, '0');
    const strike = Number(m[5]);
    const price = Number(m[8]);
    if (!Number.isFinite(strike) || strike <= 0 || !Number.isFinite(price) || price <= 0) return null;
    return {
      side: m[1].toLowerCase(),
      expiry: `${m[4]}-${month}-${day}`,
      expiryCode: `${m[4].slice(2)}${month}${day}`,
      strike,
      type: m[6].toLowerCase(),
      quote: m[7].toLowerCase(),
      price
    };
  }

  /**
   * Builds the order symbol Fidelity expects for an option, e.g. `-APLD261016P24`
   * (leading `-`, ticker, YYMMDD, P/C, strike without trailing zeros).
   * @param {string} underlying
   * @param {{expiryCode: string, type: string, strike: number}} cell - Output of parseLabel.
   * @returns {string}
   */
  function optionSymbol(underlying, cell) {
    return `-${underlying}${cell.expiryCode}${cell.type === 'put' ? 'P' : 'C'}${cell.strike}`;
  }

  /**
   * Signed net premium of the order in dollars: positive = cash received (sell),
   * negative = cash paid (buy). Exact — derived from the quoted price alone.
   * @param {{side: string, price: number}} cell
   * @param {number} qty
   * @returns {number}
   */
  function signedPremium(cell, qty) {
    return (cell.side === 'sell' ? 1 : -1) * cell.price * CONTRACT_SHARES * qty;
  }

  /**
   * Key grouping cells whose requirement curves are comparable: same underlying, expiry,
   * option type and side. Estimates are only interpolated within a group.
   * @param {string} underlying
   * @param {{expiry: string, type: string, side: string}} cell
   * @returns {string}
   */
  function groupKey(underlying, cell) {
    return `${underlying}|${cell.expiry}|${cell.type}|${cell.side}`;
  }

  /**
   * Effective requirement implied by one exact calculation: the part of the cash effect
   * that is NOT the premium, i.e. `premium − Δhouse`. For a naked short put this equals the
   * increase in margin requirement. Interpolating this (rather than the raw house change)
   * keeps the exactly-known premium out of the fit.
   * @param {number} premium - Signed premium of the calculated order.
   * @param {number} houseDelta - Projected minus current house balance.
   * @returns {number}
   */
  function effectiveRequirement(premium, houseDelta) {
    return premium - houseDelta;
  }

  /**
   * Estimates the effective requirement at `strike` from exact samples of the same group.
   *   - 0 samples → null
   *   - 1 sample  → proportional to strike (rough)
   *   - ≥2        → linear between the bracketing samples, or extrapolated from the nearest two
   * @param {Array<{strike: number, eff: number}>} samples
   * @param {number} strike
   * @returns {{eff: number, mode: 'exact'|'interp'|'extrap'|'scale'}|null}
   */
  function estimateEffective(samples, strike) {
    if (!samples || samples.length === 0) return null;
    const pts = [...samples].sort((a, b) => a.strike - b.strike);
    const hit = pts.find(p => p.strike === strike);
    if (hit) return { eff: hit.eff, mode: 'exact' };
    if (pts.length === 1) return { eff: pts[0].eff * (strike / pts[0].strike), mode: 'scale' };

    let lo = null, hi = null;
    for (const p of pts) {
      if (p.strike < strike) lo = p;
      else if (hi === null) hi = p;
    }
    let a, b, mode;
    if (lo && hi) { a = lo; b = hi; mode = 'interp'; }
    else if (!lo) { a = pts[0]; b = pts[1]; mode = 'extrap'; }
    else { a = pts[pts.length - 2]; b = pts[pts.length - 1]; mode = 'extrap'; }
    const slope = (b.eff - a.eff) / (b.strike - a.strike);
    return { eff: a.eff + slope * (strike - a.strike), mode };
  }

  /**
   * Classifies a projected outcome.
   *   - 'neg': margin debit (negative cash balance) or a house call
   *   - 'low': withdrawable cash below the user's minimum
   *   - 'ok' : otherwise
   * @param {{credit: number, house: number, avl: number}} p
   * @param {number} minWithdrawable
   * @returns {'neg'|'low'|'ok'}
   */
  function classify(p, minWithdrawable) {
    if (p.credit < 0 || p.house < 0) return 'neg';
    if (p.avl < minWithdrawable) return 'low';
    return 'ok';
  }

  /**
   * Projects the outcome of an order from the current balance, the exactly-known premium,
   * and an effective-requirement figure.
   * @param {{credit: number, house: number, avl: number}} base - Current balance.
   * @param {number} premium - Signed premium.
   * @param {number} eff - Effective requirement (see effectiveRequirement).
   * @returns {{credit: number, house: number, avl: number, houseDelta: number}}
   */
  function project(base, premium, eff) {
    const houseDelta = premium - eff;
    return {
      credit: base.credit + premium,
      house: base.house + houseDelta,
      // Withdrawable cash cannot be negative, nor exceed current + any cash received.
      avl: Math.min(Math.max(0, base.avl + houseDelta), base.avl + Math.max(premium, 0)),
      houseDelta
    };
  }

  /**
   * Full estimate for one cell from same-group samples.
   * @param {{credit: number, house: number, avl: number}} base
   * @param {{side: string, price: number, strike: number}} cell
   * @param {number} qty
   * @param {Array<{strike: number, eff: number}>} samples
   * @param {number} minWithdrawable
   * @returns {{credit: number, house: number, avl: number, state: string, mode: string,
   *   verify: boolean}|null} Null when there are no samples to estimate from.
   */
  function estimateCell(base, cell, qty, samples, minWithdrawable) {
    const est = estimateEffective(samples, cell.strike);
    if (!est) return null;
    const premium = signedPremium(cell, qty);
    const proj = project(base, premium, est.eff);
    const state = classify(proj, minWithdrawable);
    let verify = false;
    if (est.mode !== 'exact') {
      const u = UNCERTAINTY_REL * Math.abs(est.eff) + UNCERTAINTY_FIXED;
      verify = [-u, u].some(d => classify(project(base, premium, est.eff + d), minWithdrawable) !== state);
      // A single-sample proportional scale is a weak basis — always ask for verification.
      if (est.mode === 'scale') verify = true;
    }
    return { ...proj, state, mode: est.mode, verify };
  }

  return {
    parseLabel, optionSymbol, signedPremium, groupKey, effectiveRequirement,
    estimateEffective, classify, project, estimateCell
  };
})();
