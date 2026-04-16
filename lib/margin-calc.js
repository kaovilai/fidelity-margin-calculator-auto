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

    const projectedCreditDebit = projected.marginCreditDebit || 0;
    const isMarginDebit = projectedCreditDebit < 0;
    const cashWithdrawable = projected.avlToTradeWithoutMarginImpact || 0;

    let currentCreditDebit = null;
    let delta = null;
    if (baselineData) {
      const baseline = parseResponse(baselineData);
      if (baseline) {
        currentCreditDebit = baseline.marginCreditDebit || 0;
        delta = projectedCreditDebit - currentCreditDebit;
      }
    }

    return {
      currentCreditDebit,
      projectedCreditDebit,
      delta,
      isMarginDebit,
      cashWithdrawable,
      projectedBuyingPower: projected.marginBuyingPower || 0,
      projectedNonMarginBP: projected.nonMarginBuyingPower || 0,
      projectedCoreCash: projected.coreCash || 0,
      avlWithoutMarginImpact: projected.avlToTradeWithoutMarginImpact || 0
    };
  }

  return { parseResponse, computeImpact };
})();
