// MarginCalc — parses API response and computes margin impact
const MarginCalc = (() => {

  function parseResponse(data) {
    const resp = data?.data?.getTradeCalculator?.marginCalcResp;
    if (!resp || !resp.balance) {
      return null;
    }
    return resp.balance;
  }

  // Coerce an API balance field value to a finite number.
  // The Fidelity API should always return numbers, but defensive coercion prevents
  // NaN/Infinity from propagating to the UI if the API returns unexpected types.
  function toFiniteNumber(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  // Compute margin impact from projected data, optionally comparing to baseline.
  // baselineData can be null — in that case delta is not computed.
  function computeImpact(projectedData, baselineData) {
    const projected = parseResponse(projectedData);

    if (!projected) {
      return null;
    }

    const projectedCreditDebit = toFiniteNumber(projected.marginCreditDebit);
    const cashWithdrawable = toFiniteNumber(projected.avlToTradeWithoutMarginImpact);

    let currentCreditDebit = null;
    let delta = null;
    if (baselineData) {
      const baseline = parseResponse(baselineData);
      if (baseline) {
        currentCreditDebit = toFiniteNumber(baseline.marginCreditDebit);
        delta = projectedCreditDebit - currentCreditDebit;
      }
    }

    return {
      currentCreditDebit,
      projectedCreditDebit,
      delta,
      cashWithdrawable,
      projectedBuyingPower: toFiniteNumber(projected.marginBuyingPower)
    };
  }

  return { parseResponse, computeImpact };
})();
