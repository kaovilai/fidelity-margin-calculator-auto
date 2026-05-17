// MarginCalc — parses API response and computes margin impact
const MarginCalc = (() => {

  function parseResponse(data) {
    const resp = data?.data?.getTradeCalculator?.marginCalcResp;
    if (!resp || !resp.balance) {
      return null;
    }
    return resp.balance;
  }

  // Compute margin impact from projected data, optionally comparing to baseline.
  // baselineData can be null — in that case delta is not computed.
  function computeImpact(projectedData, baselineData) {
    const projected = parseResponse(projectedData);

    if (!projected) {
      return null;
    }

    const projectedCreditDebit = projected.marginCreditDebit ?? 0;
    const cashWithdrawable = projected.avlToTradeWithoutMarginImpact ?? 0;

    let currentCreditDebit = null;
    let delta = null;
    if (baselineData) {
      const baseline = parseResponse(baselineData);
      if (baseline) {
        currentCreditDebit = baseline.marginCreditDebit ?? 0;
        delta = projectedCreditDebit - currentCreditDebit;
      }
    }

    return {
      currentCreditDebit,
      projectedCreditDebit,
      delta,
      cashWithdrawable,
      projectedBuyingPower: projected.marginBuyingPower ?? 0
    };
  }

  return { parseResponse, computeImpact };
})();
