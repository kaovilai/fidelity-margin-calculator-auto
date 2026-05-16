// PositionsAPI — fetches account positions from Fidelity's portfolio GraphQL API
// and converts them to the priceList format needed by the margin calculator API.
const PositionsAPI = (() => {
  const ENDPOINT = '/ftgw/digital/portfolio/api/graphql?ref_at=portsum';

  // Exact query captured from Fidelity's portfolio summary page
  const QUERY = `query GetPositions($acctList: [PositionAccountInput], $customerId: String) {
  getPosition(acctList: $acctList, customerId: $customerId) {
    sysMsgs {
      sysMsg {
        code
        detail
        message
        source
        type
        __typename
      }
      __typename
    }
    position {
      portfolioDetail {
        portfolioPositionCount
        __typename
      }
      acctDetails {
        acctDetail {
          acctNum
          positionDetails {
            positionDetail {
              symbol
              cusip
              holdingPct
              optionUnderlyingSymbol
              securityType
              securitySubType
              hasIntradayPricingInd
              marketValDetail {
                marketVal
                totalGainLoss
                __typename
              }
              securityDetail {
                isLoaned
                isHardToBorrow
                bondDetail {
                  maturityDate
                  hasAutoRoll
                  __typename
                }
                __typename
              }
              securityDescription
              quantity
              __typename
            }
            __typename
          }
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}
`;

  function debugLog(msg) {
    console.log('[FMC-POS]', msg);
    if (typeof MarginInjector !== 'undefined' && MarginInjector.addDebugLog) {
      MarginInjector.addDebugLog(msg);
    }
  }

  // Convert portfolio position to margin calc priceList entry
  function positionToPriceListEntry(pos) {
    const isOption = pos.securityType === 'Option';
    const isBond = pos.securityType === 'Bond';
    const qty = Math.abs(pos.quantity);
    const mktVal = Math.abs(pos.marketValDetail.marketVal);
    // Options: mktVal is total (qty * 100 * price), so price = mktVal / (qty * 100)
    // Bonds: priced per $100 face value, so price = (mktVal / qty) * 100
    // Everything else (equities, mutual funds): price = mktVal / qty
    let price;
    if (isOption) {
      price = mktVal / (qty * 100);
    } else if (isBond) {
      price = (mktVal / qty) * 100;
    } else {
      price = mktVal / qty;
    }
    // Strip leading - from option symbols (portfolio uses -AAPL..., priceList uses AAPL...)
    const sym = (pos.symbol || '').replace(/^-/, '');

    return {
      symbol: sym || '',
      cusip: pos.cusip,
      priceInd: 'initial',
      longShortInd: pos.quantity > 0 ? 'LONG' : 'SHORT',
      price: Math.round(price * 100) / 100,
      isCurrency: false
    };
  }

  // Fetch positions for a single account and return priceList array
  async function fetchPriceList(accountNum) {
    debugLog('Fetching positions for ' + accountNum);

    let resp;
    try {
      resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept': '*/*' },
        credentials: 'include',
        body: JSON.stringify({
          operationName: 'GetPositions',
          variables: {
            acctList: [{
              acctNum: accountNum,
              acctType: 'Brokerage',
              acctSubType: 'Brokerage',
              preferenceDetail: false
            }]
          },
          query: QUERY
        })
      });
    } catch (e) {
      debugLog('Network error fetching positions: ' + e.message);
      return [];
    }

    if (!resp.ok) {
      debugLog('Positions API HTTP ' + resp.status);
      return [];
    }

    let data;
    try {
      data = await resp.json();
    } catch (e) {
      debugLog('Invalid JSON from positions API');
      return [];
    }

    let acctDetails;
    try {
      acctDetails = data.data.getPosition.position.acctDetails.acctDetail;
    } catch (e) {
      debugLog('Unexpected positions response shape');
      return [];
    }

    const target = acctDetails.find(a => a.acctNum === accountNum);
    if (!target || !target.positionDetails || !target.positionDetails.positionDetail) {
      debugLog('No positions found for account ' + accountNum);
      return [];
    }

    const positions = target.positionDetails.positionDetail;
    const priceList = positions
      .filter(p => p.cusip && p.marketValDetail)
      .map(positionToPriceListEntry);

    debugLog('Built priceList with ' + priceList.length + ' entries from ' + positions.length + ' positions');
    return priceList;
  }

  return { fetchPriceList };
})();
