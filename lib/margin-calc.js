// MarginCalc — parses API response and computes margin impact
'use strict';
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

  /**
   * Coerces an API balance field value to a finite number.
   * The Fidelity API should always return numbers, but this guard prevents
   * `NaN`/`Infinity` from propagating to the UI if the API returns unexpected types.
   * @param {*} v - Value to coerce (typically a number from the API response).
   * @param {number} [fallback=0] - Value to return when `v` cannot be coerced to a finite number.
   * @returns {number} A finite number.
   */
  function toFiniteNumber(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * Total margin requirement (option + security) from a balance object.
   * @param {Object} balance - Balance object from the API response.
   * @returns {number}
   */
  function totalRequirement(balance) {
    return toFiniteNumber(balance.totalOptionRequirements) + toFiniteNumber(balance.totalSecurityRequirements);
  }

  /**
   * Net premium of the order(s): positive = credit received (sell), negative = debit paid (buy).
   * Derived from the request itself, so it costs no extra network call. Option orders
   * (orderType 'O') carry a 100-share contract multiplier.
   * @param {Array<{orderType: string, orderAction: string, orderQty: number, price: number}>|undefined} orders
   * @returns {number|null} Net premium in dollars, or null if it cannot be computed.
   */
  function orderPremium(orders) {
    // Multi-leg tickets carry the net limit price on every leg (see detector.js), so a per-leg
    // premium sum would be wrong — report it as unknown rather than misleading.
    if (!Array.isArray(orders) || orders.length !== 1) return null;
    let total = 0;
    for (const o of orders) {
      const qty = Number(o.orderQty);
      const price = Number(o.price);
      if (!Number.isFinite(qty) || !Number.isFinite(price)) return null;
      const multiplier = o.orderType === 'O' ? 100 : 1;
      const sign = String(o.orderAction ?? '').startsWith('S') ? 1 : -1;
      total += sign * qty * price * multiplier;
    }
    return total;
  }

  /**
   * Computes margin impact from the projected API response, optionally delta-compared to a baseline.
   * @param {Object} projectedData - Raw API response from MarginAPI.fetchMarginCalc.
   * @param {Object|null} baselineData - Current-state response (or previous result) to diff against, or null for no delta.
   * @param {Array<Object>} [orders] - Orders that produced `projectedData`, used for the premium.
   * @returns {{
   *   projectedCreditDebit: number,
   *   delta: number|null,
   *   cashWithdrawable: number,
   *   projectedBuyingPower: number,
   *   requirement: number,
   *   requirementDelta: number|null,
   *   houseBalance: number,
   *   houseBalanceDelta: number|null,
   *   premium: number|null
   * }|null} Impact object, or null if projected data contains no balance.
   */
  function computeImpact(projectedData, baselineData, orders) {
    const projected = parseResponse(projectedData);

    if (!projected) {
      return null;
    }

    const projectedCreditDebit = toFiniteNumber(projected.marginCreditDebit);
    const cashWithdrawable = toFiniteNumber(projected.avlToTradeWithoutMarginImpact);
    const requirement = totalRequirement(projected);
    const houseBalance = toFiniteNumber(projected.houseBalance);

    let delta = null;
    let requirementDelta = null;
    let houseBalanceDelta = null;
    if (baselineData) {
      const baseline = parseResponse(baselineData);
      if (baseline) {
        delta = projectedCreditDebit - toFiniteNumber(baseline.marginCreditDebit);
        requirementDelta = requirement - totalRequirement(baseline);
        houseBalanceDelta = houseBalance - toFiniteNumber(baseline.houseBalance);
      }
    }

    return {
      projectedCreditDebit,
      delta,
      cashWithdrawable,
      projectedBuyingPower: toFiniteNumber(projected.marginBuyingPower),
      requirement,
      requirementDelta,
      houseBalance,
      houseBalanceDelta,
      premium: orderPremium(orders)
    };
  }

  return { computeImpact };
})();
