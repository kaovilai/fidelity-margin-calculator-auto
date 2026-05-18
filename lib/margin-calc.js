// MarginCalc — parses API response and computes margin impact
const MarginCalc = (() => {

  /**
   * Parses raw GraphQL response data from the margin calculator API.
   * @param {Object} data - Raw API response from MarginAPI.fetchMarginCalc.
   * @returns {Object|null} The balance object from the response, or null if not present.
   */
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

  /**
   * Computes margin impact from the projected API response, optionally delta-compared to a baseline.
   * @param {Object} projectedData - Raw API response from MarginAPI.fetchMarginCalc.
   * @param {Object|null} baselineData - Previous raw API response to diff against, or null for no delta.
   * @returns {{
   *   currentCreditDebit: number|null,
   *   projectedCreditDebit: number,
   *   delta: number|null,
   *   cashWithdrawable: number,
   *   projectedBuyingPower: number
   * }|null} Impact object, or null if projected data contains no balance.
   */
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

  return { computeImpact };
})();
