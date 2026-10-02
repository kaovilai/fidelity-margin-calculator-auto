// TaxRates — resolves the investor's marginal federal and state income-tax rates for the
// money-market optimizer. Pure parsing + selection; the pages are fetched by the background
// worker (cross-origin) and the parsed result is cached for 30 days by the caller.
//
// Live sources (best effort — every step falls back to the user's configured values):
//   • IRS "Federal income tax rates and brackets" — ordinary-income brackets by filing status
//   • Tax Foundation "State individual income tax rates" — flat state rates
'use strict';
const TaxRates = (() => {
  const STATE_NAMES = Object.freeze({
    AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
    CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
    IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
    ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
    MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
    NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
    ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
    RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
    UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia',
    WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia'
  });
  // No wage/interest income tax on money-market income.
  const NO_INCOME_TAX = new Set(['AK', 'FL', 'NV', 'NH', 'SD', 'TN', 'TX', 'WA', 'WY']);
  // IRS tables appear in this order on the page.
  const STATUS_ORDER = ['single', 'mfj', 'mfs', 'hoh'];

  /** Strips tags/entities so parsing works on plain text (also usable in a service worker). */
  function toText(html) {
    return String(html ?? '')
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ');
  }

  /**
   * Parses the IRS page text into ordinary-income brackets by filing status.
   * @param {string} text - Plain page text.
   * @returns {{year: number|null, brackets: Object<string, Array<{rate: number, from: number, to: number}>>}|null}
   */
  function parseIrsBrackets(text) {
    const re = /(\d{1,2})%\s+\$([\d,]+)\s+(\$[\d,]+|And up)/g;
    const groups = [];
    let current = null;
    for (const m of text.matchAll(re)) {
      const rate = Number(m[1]);
      const from = Number(m[2].replace(/,/g, ''));
      const to = /and up/i.test(m[3]) ? Infinity : Number(m[3].replace(/[$,]/g, ''));
      if (rate === 10 && from === 0) { current = []; groups.push(current); }
      if (current) current.push({ rate, from, to });
    }
    if (groups.length < 4) return null;
    const brackets = {};
    STATUS_ORDER.forEach((s, i) => { brackets[s] = groups[i]; });
    const y = /(\d{4}) tax rates/i.exec(text);
    return { year: y ? Number(y[1]) : null, brackets };
  }

  /** Marginal rate (percent) for taxable `income` in a bracket list, or null. */
  function marginalRate(brackets, income) {
    const b = (brackets ?? []).find(x => income >= x.from && income <= x.to);
    return b ? b.rate : null;
  }

  /**
   * Flat state income-tax rate (percent) from the Tax Foundation page text, `0` for states without
   * an income tax, or null when the state has graduated brackets or the row isn't found (the
   * caller then needs a configured value).
   * @param {string} text
   * @param {string} stateCode - Two-letter code.
   */
  function parseStateRate(text, stateCode) {
    if (NO_INCOME_TAX.has(stateCode)) return 0;
    const name = STATE_NAMES[stateCode];
    if (!name) return null;
    const row = new RegExp(`${name}(?: \\([a-z, ]+\\))?\\s+(\\d+(?:\\.\\d+)?)%\\s*>\\s*\\$0`).exec(text);
    if (!row) return null;
    // Graduated states continue on following rows prefixed with an em dash ("— North Dakota 2.50% > …").
    if (new RegExp(`—\\s+${name}\\s+\\d`).test(text)) return null;
    return Number(row[1]);
  }

  /**
   * Resolves the rates to use. Configured overrides win; otherwise live (cached) values; otherwise
   * the fallbacks. Each rate reports where it came from.
   * @param {Object} p
   * @param {{filing: string, income: number, state: string, federalOverride: number|null,
   *   stateOverride: number|null, federalFallback: number, stateFallback: number}} p.config
   * @param {{irs: Object|null, stateRates: Object<string, number|null>}|null} p.live
   * @returns {{federal: number, state: number, stateCode: string, federalSource: string, stateSource: string, year: number|null}}
   */
  function resolve({ config, live }) {
    let federal = null, federalSource = '';
    let state = null, stateSource = '';
    if (Number.isFinite(config.federalOverride)) { federal = config.federalOverride; federalSource = 'configured'; }
    else {
      const r = marginalRate(live?.irs?.brackets?.[config.filing], config.income);
      if (r !== null) { federal = r; federalSource = `IRS ${live.irs.year ?? ''}`.trim(); }
    }
    if (federal === null) { federal = config.federalFallback; federalSource = 'default'; }

    if (Number.isFinite(config.stateOverride)) { state = config.stateOverride; stateSource = 'configured'; }
    else {
      const s = live?.stateRates?.[config.state];
      if (Number.isFinite(s)) { state = s; stateSource = 'Tax Foundation'; }
    }
    if (state === null) { state = config.stateFallback; stateSource = 'default'; }
    return { federal, state, stateCode: config.state, federalSource, stateSource, year: live?.irs?.year ?? null };
  }

  return { STATE_NAMES, toText, parseIrsBrackets, marginalRate, parseStateRate, resolve };
})();
