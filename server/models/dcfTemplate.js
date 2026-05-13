const DEFAULTS = {
  projectionYears: 5,
  revenueGrowth: [0.05, 0.045, 0.04, 0.035, 0.03],
  ebitdaMargin: 0.30,
  taxRate: 0.21,
  daPercentRevenue: 0.035,
  capexPercentRevenue: 0.035,
  nwcPercentRevenue: 0.01,
  riskFreeRate: 0.04,
  marketRiskPremium: 0.055,
  beta: 1.10,
  preTaxCostOfDebt: 0.045,
  targetDebtToEquity: 0.10,
  terminalGrowthRate: 0.025,
  baseRevenueMillions: 100000,
  cashMillions: 0,
  debtMillions: 0,
  sharesMillions: 1000,
  sharePrice: 0
};

const STYLE = {
  title: { backgroundColor: '#1F4E78', fontColor: '#FFFFFF', bold: true, horizontalAlignment: 'Left' },
  section: { backgroundColor: '#D9E1F2', fontColor: '#000000', bold: true },
  header: { backgroundColor: '#404040', fontColor: '#FFFFFF', bold: true, horizontalAlignment: 'Center' },
  label: { fontColor: '#000000', bold: false },
  input: { backgroundColor: '#E6F2FF', fontColor: '#0000FF' },
  formula: { backgroundColor: '#FFFFFF', fontColor: '#000000' },
  total: { backgroundColor: '#F2F2F2', fontColor: '#000000', bold: true },
  check: { backgroundColor: '#FFF2CC', fontColor: '#000000', italic: true }
};

const NUM_FORMATS = {
  currency: '$#,##0.0',
  percent: '0.00%',
  multiple: '0.00x',
  shares: '#,##0.0',
  perShare: '$#,##0.00',
  number: '#,##0.0'
};

function sanitizeSheetName(name) {
  return String(name || '')
    .replace(/[\\/?*[\]:]/g, '')
    .slice(0, 31) || 'Sheet';
}

function cell(value, cellStyles = {}) {
  return { value, cellStyles };
}

function formula(value, cellStyles = {}) {
  return { formula: value, cellStyles };
}

function fmt(base, extra = {}) {
  return { ...base, ...extra };
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toMillions(value) {
  const n = finiteNumber(value);
  if (n == null) return null;
  return Math.abs(n) > 10000000 ? n / 1000000 : n;
}

function clamp(value, min, max, fallback) {
  const n = finiteNumber(value);
  if (n == null) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findNumberByKeys(value, candidateKeys, depth = 0, seen = new Set()) {
  if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return null;
  seen.add(value);
  const wanted = new Set(candidateKeys.map(normalizeKey));

  for (const [key, entry] of Object.entries(value)) {
    if (wanted.has(normalizeKey(key))) {
      const n = finiteNumber(entry);
      if (n != null) return n;
    }
  }

  for (const entry of Object.values(value)) {
    const n = findNumberByKeys(entry, candidateKeys, depth + 1, seen);
    if (n != null) return n;
  }
  return null;
}

function collectResultData(memory) {
  const chunks = [];
  const results = memory?.results && typeof memory.results === 'object' ? memory.results : {};
  for (const result of Object.values(results)) {
    if (!result || result.ok === false) continue;
    if (result.data !== undefined) chunks.push(result.data);
    else chunks.push(result);
  }
  return chunks;
}

function firstNumber(chunks, keys) {
  for (const chunk of chunks) {
    const n = findNumberByKeys(chunk, keys);
    if (n != null) return n;
  }
  return null;
}

function firstString(chunks, keys) {
  const wanted = new Set(keys.map(normalizeKey));
  function walk(value, depth = 0, seen = new Set()) {
    if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return null;
    seen.add(value);
    for (const [key, entry] of Object.entries(value)) {
      if (wanted.has(normalizeKey(key)) && typeof entry === 'string' && entry.trim()) {
        return entry.trim();
      }
    }
    for (const entry of Object.values(value)) {
      const found = walk(entry, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }
  for (const chunk of chunks) {
    const found = walk(chunk);
    if (found) return found;
  }
  return null;
}

function inferDcfInputs(params = {}, memory = {}) {
  const chunks = collectResultData(memory);
  const ticker = String(params.ticker || firstString(chunks, ['symbol']) || 'TICKER').toUpperCase();
  const companyName = params.companyName || firstString(chunks, ['longName', 'shortName', 'displayName']) || ticker;
  const price = firstNumber(chunks, ['regularMarketPrice', 'currentPrice', 'price', 'previousClose']);
  const marketCap = firstNumber(chunks, ['marketCap']);
  const shares = firstNumber(chunks, ['sharesOutstanding', 'impliedSharesOutstanding']);
  const revenue = firstNumber(chunks, ['totalRevenue', 'revenue']);
  const ebitda = firstNumber(chunks, ['ebitda']);
  const beta = firstNumber(chunks, ['beta']);
  const totalCash = firstNumber(chunks, ['totalCash', 'cash', 'cashAndCashEquivalents']);
  const totalDebt = firstNumber(chunks, ['totalDebt', 'debt']);

  const baseRevenueMillions = toMillions(revenue) || DEFAULTS.baseRevenueMillions;
  const ebitdaMillions = toMillions(ebitda);
  const ebitdaMargin = ebitdaMillions && baseRevenueMillions
    ? clamp(ebitdaMillions / baseRevenueMillions, 0.05, 0.65, DEFAULTS.ebitdaMargin)
    : DEFAULTS.ebitdaMargin;
  const cashMillions = Math.max(0, toMillions(totalCash) || DEFAULTS.cashMillions);
  const debtMillions = Math.max(0, toMillions(totalDebt) || DEFAULTS.debtMillions);
  const marketCapMillions = Math.max(0, toMillions(marketCap) || 0);
  const sharePrice = Math.max(0, finiteNumber(price) || DEFAULTS.sharePrice);
  const sharesMillions = toMillions(shares) || (marketCapMillions && sharePrice ? marketCapMillions / sharePrice : DEFAULTS.sharesMillions);

  return {
    ticker,
    companyName,
    projectionYears: Number(params.projectionYears) || DEFAULTS.projectionYears,
    baseYear: new Date().getFullYear() - 1,
    revenueGrowth: DEFAULTS.revenueGrowth,
    ebitdaMargin,
    taxRate: DEFAULTS.taxRate,
    daPercentRevenue: DEFAULTS.daPercentRevenue,
    capexPercentRevenue: DEFAULTS.capexPercentRevenue,
    nwcPercentRevenue: DEFAULTS.nwcPercentRevenue,
    riskFreeRate: DEFAULTS.riskFreeRate,
    marketRiskPremium: DEFAULTS.marketRiskPremium,
    beta: clamp(beta, 0.4, 2.5, DEFAULTS.beta),
    preTaxCostOfDebt: DEFAULTS.preTaxCostOfDebt,
    targetDebtToEquity: marketCapMillions > 0 ? clamp(debtMillions / marketCapMillions, 0, 1.5, DEFAULTS.targetDebtToEquity) : DEFAULTS.targetDebtToEquity,
    terminalGrowthRate: DEFAULTS.terminalGrowthRate,
    baseRevenueMillions,
    cashMillions,
    debtMillions,
    sharesMillions,
    sharePrice,
    marketCapMillions
  };
}

function set(cells, address, spec) {
  cells[address] = spec;
}

function makeSetCellRangeAction(sheet, cells) {
  return { type: 'setCellRange', sheet, cells, allow_overwrite: true };
}

function buildShellActions(inputs) {
  const sheets = ['Assumptions', 'WACC', 'DCF', 'Sensitivity'];
  const actions = sheets.map(name => ({ type: 'createSheet', name, sheet: name }));
  for (const sheet of sheets) {
    const cells = {};
    set(cells, 'A1', cell(`${inputs.companyName} (${inputs.ticker}) - ${sheet}`, STYLE.title));
    actions.push(makeSetCellRangeAction(sheet, cells));
  }
  return actions;
}

function buildAssumptionsActions(inputs) {
  const cells = {};
  const inputStyle = fmt(STYLE.input, { numberFormat: NUM_FORMATS.number });
  const pctInputStyle = fmt(STYLE.input, { numberFormat: NUM_FORMATS.percent });

  set(cells, 'A1', cell(`${inputs.companyName} (${inputs.ticker}) - DCF Assumptions`, STYLE.title));
  set(cells, 'A3', cell('Company & Source', STYLE.section));
  set(cells, 'A4', cell('Company', STYLE.label));
  set(cells, 'B4', cell(inputs.companyName, STYLE.input));
  set(cells, 'A5', cell('Ticker', STYLE.label));
  set(cells, 'B5', cell(inputs.ticker, STYLE.input));
  set(cells, 'A6', cell('Currency', STYLE.label));
  set(cells, 'B6', cell('USD', STYLE.input));
  set(cells, 'A7', cell('Units', STYLE.label));
  set(cells, 'B7', cell('$ in millions except per-share data', STYLE.input));

  set(cells, 'A9', cell('Historical / Market Inputs', STYLE.section));
  set(cells, 'A10', cell('Base Revenue ($M)', STYLE.label));
  set(cells, 'B10', cell(inputs.baseRevenueMillions, fmt(inputStyle, { numberFormat: NUM_FORMATS.currency })));
  set(cells, 'A11', cell('EBITDA Margin (%)', STYLE.label));
  set(cells, 'B11', cell(inputs.ebitdaMargin, pctInputStyle));
  set(cells, 'A12', cell('Tax Rate (%)', STYLE.label));
  set(cells, 'B12', cell(inputs.taxRate, pctInputStyle));
  set(cells, 'A13', cell('D&A % of Revenue (%)', STYLE.label));
  set(cells, 'B13', cell(inputs.daPercentRevenue, pctInputStyle));
  set(cells, 'A14', cell('CapEx % of Revenue (%)', STYLE.label));
  set(cells, 'B14', cell(inputs.capexPercentRevenue, pctInputStyle));
  set(cells, 'A15', cell('NWC % of Revenue (%)', STYLE.label));
  set(cells, 'B15', cell(inputs.nwcPercentRevenue, pctInputStyle));

  set(cells, 'A17', cell('Projection Assumptions', STYLE.section));
  inputs.revenueGrowth.forEach((growth, index) => {
    set(cells, `A${18 + index}`, cell(`Revenue Growth Y${index + 1} (%)`, STYLE.label));
    set(cells, `B${18 + index}`, cell(growth, pctInputStyle));
  });
  set(cells, 'A23', cell('Terminal Growth Rate (%)', STYLE.label));
  set(cells, 'B23', cell(inputs.terminalGrowthRate, pctInputStyle));

  set(cells, 'A25', cell('WACC Inputs', STYLE.section));
  set(cells, 'A26', cell('Risk-Free Rate (%)', STYLE.label));
  set(cells, 'B26', cell(inputs.riskFreeRate, pctInputStyle));
  set(cells, 'A27', cell('Market Risk Premium (%)', STYLE.label));
  set(cells, 'B27', cell(inputs.marketRiskPremium, pctInputStyle));
  set(cells, 'A28', cell('Beta', STYLE.label));
  set(cells, 'B28', cell(inputs.beta, fmt(inputStyle, { numberFormat: '0.00x' })));
  set(cells, 'A29', cell('Pre-Tax Cost of Debt (%)', STYLE.label));
  set(cells, 'B29', cell(inputs.preTaxCostOfDebt, pctInputStyle));
  set(cells, 'A30', cell('Target Debt / Equity', STYLE.label));
  set(cells, 'B30', cell(inputs.targetDebtToEquity, fmt(inputStyle, { numberFormat: '0.00x' })));

  set(cells, 'A32', cell('Equity Bridge', STYLE.section));
  set(cells, 'A33', cell('Cash & Equivalents ($M)', STYLE.label));
  set(cells, 'B33', cell(inputs.cashMillions, fmt(inputStyle, { numberFormat: NUM_FORMATS.currency })));
  set(cells, 'A34', cell('Total Debt ($M)', STYLE.label));
  set(cells, 'B34', cell(inputs.debtMillions, fmt(inputStyle, { numberFormat: NUM_FORMATS.currency })));
  set(cells, 'A35', cell('Shares Outstanding (M)', STYLE.label));
  set(cells, 'B35', cell(inputs.sharesMillions, fmt(inputStyle, { numberFormat: NUM_FORMATS.shares })));
  set(cells, 'A36', cell('Current Share Price ($)', STYLE.label));
  set(cells, 'B36', cell(inputs.sharePrice, fmt(inputStyle, { numberFormat: NUM_FORMATS.perShare })));
  set(cells, 'A37', cell('Current Market Cap ($M)', STYLE.label));
  set(cells, 'B37', formula('=B35*B36', fmt(STYLE.formula, { numberFormat: NUM_FORMATS.currency })));

  return [makeSetCellRangeAction('Assumptions', cells)];
}

function buildWaccActions() {
  const cells = {};
  const pct = fmt(STYLE.formula, { numberFormat: NUM_FORMATS.percent });
  const multiple = fmt(STYLE.formula, { numberFormat: NUM_FORMATS.multiple });

  set(cells, 'A1', cell('Weighted Average Cost of Capital', STYLE.title));
  set(cells, 'A3', cell('Cost of Equity', STYLE.section));
  set(cells, 'A4', cell('Risk-Free Rate (%)', STYLE.label));
  set(cells, 'B4', formula('=Assumptions!$B$26', pct));
  set(cells, 'A5', cell('Beta', STYLE.label));
  set(cells, 'B5', formula('=Assumptions!$B$28', multiple));
  set(cells, 'A6', cell('Market Risk Premium (%)', STYLE.label));
  set(cells, 'B6', formula('=Assumptions!$B$27', pct));
  set(cells, 'A7', cell('Cost of Equity (CAPM) (%)', STYLE.total));
  set(cells, 'B7', formula('=B4+B5*B6', fmt(STYLE.total, { numberFormat: NUM_FORMATS.percent })));

  set(cells, 'A9', cell('Cost of Debt', STYLE.section));
  set(cells, 'A10', cell('Pre-Tax Cost of Debt (%)', STYLE.label));
  set(cells, 'B10', formula('=Assumptions!$B$29', pct));
  set(cells, 'A11', cell('Tax Rate (%)', STYLE.label));
  set(cells, 'B11', formula('=Assumptions!$B$12', pct));
  set(cells, 'A12', cell('After-Tax Cost of Debt (%)', STYLE.total));
  set(cells, 'B12', formula('=B10*(1-B11)', fmt(STYLE.total, { numberFormat: NUM_FORMATS.percent })));

  set(cells, 'A14', cell('Capital Structure', STYLE.section));
  set(cells, 'A15', cell('Debt / Equity', STYLE.label));
  set(cells, 'B15', formula('=Assumptions!$B$30', multiple));
  set(cells, 'A16', cell('Equity Weight (%)', STYLE.label));
  set(cells, 'B16', formula('=1/(1+B15)', pct));
  set(cells, 'A17', cell('Debt Weight (%)', STYLE.label));
  set(cells, 'B17', formula('=B15/(1+B15)', pct));
  set(cells, 'A19', cell('WACC (%)', STYLE.total));
  set(cells, 'B19', formula('=B16*B7+B17*B12', fmt(STYLE.total, { numberFormat: NUM_FORMATS.percent })));

  return [makeSetCellRangeAction('WACC', cells)];
}

function col(index) {
  return String.fromCharCode('A'.charCodeAt(0) + index);
}

function buildDcfActions(inputs) {
  const cells = {};
  const money = fmt(STYLE.formula, { numberFormat: NUM_FORMATS.currency });
  const pct = fmt(STYLE.formula, { numberFormat: NUM_FORMATS.percent });
  const totalMoney = fmt(STYLE.total, { numberFormat: NUM_FORMATS.currency });
  const totalPct = fmt(STYLE.total, { numberFormat: NUM_FORMATS.percent });

  set(cells, 'A1', cell(`${inputs.companyName} (${inputs.ticker}) - Discounted Cash Flow`, STYLE.title));
  set(cells, 'A2', cell('Metric', STYLE.header));
  set(cells, 'B2', cell(`${inputs.baseYear}A`, STYLE.header));
  for (let i = 0; i < inputs.projectionYears; i++) {
    set(cells, `${col(2 + i)}2`, cell(`${inputs.baseYear + i + 1}E`, STYLE.header));
  }
  set(cells, 'H2', cell('Terminal / Value', STYLE.header));

  const labelRows = [
    [4, 'Revenue Growth (%)'],
    [5, 'Revenue ($M)'],
    [6, 'EBITDA Margin (%)'],
    [7, 'EBITDA ($M)'],
    [8, 'D&A % Revenue (%)'],
    [9, 'D&A ($M)'],
    [10, 'EBIT ($M)'],
    [11, 'Tax Rate (%)'],
    [12, 'Tax ($M)'],
    [13, 'NOPAT ($M)'],
    [15, 'CapEx % Revenue (%)'],
    [16, 'CapEx ($M)'],
    [17, 'NWC % Revenue (%)'],
    [18, 'Change in NWC ($M)'],
    [20, 'Unlevered FCF ($M)'],
    [22, 'WACC (%)'],
    [23, 'Discount Factor'],
    [24, 'PV of FCF ($M)'],
    [26, 'Terminal Growth Rate (%)'],
    [27, 'Terminal Value ($M)'],
    [28, 'PV of Terminal Value ($M)'],
    [30, 'Enterprise Value ($M)'],
    [31, '(+) Cash & Equivalents ($M)'],
    [32, '(-) Total Debt ($M)'],
    [33, 'Equity Value ($M)'],
    [34, 'Shares Outstanding (M)'],
    [35, 'Implied Share Price ($)'],
    [37, 'Current Share Price ($)'],
    [38, 'Premium / (Discount) to Current (%)'],
    [40, 'EV Bridge Check ($M)']
  ];
  labelRows.forEach(([row, label]) => set(cells, `A${row}`, cell(label, STYLE.label)));
  [4, 5, 7, 10, 13, 20, 24, 27, 28, 30, 33, 35, 38, 40].forEach(row => {
    if (cells[`A${row}`]) cells[`A${row}`].cellStyles = row >= 30 ? STYLE.total : STYLE.label;
  });

  set(cells, 'B4', cell(0, pct));
  set(cells, 'B5', formula('=Assumptions!$B$10', money));
  set(cells, 'B6', formula('=Assumptions!$B$11', pct));
  set(cells, 'B7', formula('=B5*B6', money));
  set(cells, 'B8', formula('=Assumptions!$B$13', pct));
  set(cells, 'B9', formula('=B5*B8', money));
  set(cells, 'B10', formula('=B7-B9', money));
  set(cells, 'B11', formula('=Assumptions!$B$12', pct));
  set(cells, 'B12', formula('=B10*B11', money));
  set(cells, 'B13', formula('=B10-B12', money));
  set(cells, 'B15', formula('=Assumptions!$B$14', pct));
  set(cells, 'B16', formula('=B5*B15', money));
  set(cells, 'B17', formula('=Assumptions!$B$15', pct));
  set(cells, 'B18', cell(0, money));
  set(cells, 'B20', formula('=B13+B9-B16-B18', totalMoney));

  for (let i = 0; i < inputs.projectionYears; i++) {
    const c = col(2 + i);
    const prev = col(1 + i);
    const growthRow = 18 + i;
    const yearNumber = i + 1;
    set(cells, `${c}4`, formula(`=Assumptions!$B$${growthRow}`, pct));
    set(cells, `${c}5`, formula(`=${prev}5*(1+${c}4)`, money));
    set(cells, `${c}6`, formula('=Assumptions!$B$11', pct));
    set(cells, `${c}7`, formula(`=${c}5*${c}6`, money));
    set(cells, `${c}8`, formula('=Assumptions!$B$13', pct));
    set(cells, `${c}9`, formula(`=${c}5*${c}8`, money));
    set(cells, `${c}10`, formula(`=${c}7-${c}9`, money));
    set(cells, `${c}11`, formula('=Assumptions!$B$12', pct));
    set(cells, `${c}12`, formula(`=${c}10*${c}11`, money));
    set(cells, `${c}13`, formula(`=${c}10-${c}12`, money));
    set(cells, `${c}15`, formula('=Assumptions!$B$14', pct));
    set(cells, `${c}16`, formula(`=${c}5*${c}15`, money));
    set(cells, `${c}17`, formula('=Assumptions!$B$15', pct));
    set(cells, `${c}18`, formula(`=(${c}5*${c}17)-(${prev}5*${prev}17)`, money));
    set(cells, `${c}20`, formula(`=${c}13+${c}9-${c}16-${c}18`, totalMoney));
    set(cells, `${c}22`, formula('=WACC!$B$19', pct));
    set(cells, `${c}23`, formula(`=1/(1+WACC!$B$19)^${yearNumber}`, fmt(STYLE.formula, { numberFormat: '0.000x' })));
    set(cells, `${c}24`, formula(`=${c}20*${c}23`, totalMoney));
  }

  set(cells, 'H26', formula('=Assumptions!$B$23', pct));
  set(cells, 'H27', formula('=G20*(1+H26)/(WACC!$B$19-H26)', totalMoney));
  set(cells, 'H28', formula('=H27/(1+WACC!$B$19)^5', totalMoney));
  set(cells, 'H30', formula('=SUM(C24:G24)+H28', totalMoney));
  set(cells, 'H31', formula('=Assumptions!$B$33', money));
  set(cells, 'H32', formula('=Assumptions!$B$34', money));
  set(cells, 'H33', formula('=H30+H31-H32', totalMoney));
  set(cells, 'H34', formula('=Assumptions!$B$35', fmt(STYLE.formula, { numberFormat: NUM_FORMATS.shares })));
  set(cells, 'H35', formula('=H33/H34', fmt(STYLE.total, { numberFormat: NUM_FORMATS.perShare })));
  set(cells, 'H37', formula('=Assumptions!$B$36', fmt(STYLE.formula, { numberFormat: NUM_FORMATS.perShare })));
  set(cells, 'H38', formula('=IFERROR(H35/H37-1,0)', totalPct));
  set(cells, 'H40', formula('=H33+H32-H31-H30', fmt(STYLE.check, { numberFormat: NUM_FORMATS.currency })));

  return [makeSetCellRangeAction('DCF', cells)];
}

function buildSensitivityActions() {
  const cells = {};
  const money = fmt(STYLE.formula, { numberFormat: NUM_FORMATS.currency });
  const pct = fmt(STYLE.input, { numberFormat: NUM_FORMATS.percent });
  const perShare = fmt(STYLE.formula, { numberFormat: NUM_FORMATS.perShare });

  set(cells, 'A1', cell('Sensitivity Analysis', STYLE.title));
  set(cells, 'A3', cell('Implied Share Price Sensitivity', STYLE.section));
  set(cells, 'B4', cell('WACC \\ g', STYLE.header));
  [0.015, 0.02, 0.025, 0.03, 0.035].forEach((growth, idx) => {
    set(cells, `${col(2 + idx)}4`, cell(growth, pct));
  });
  [0.08, 0.09, 0.10, 0.11, 0.12].forEach((wacc, rowIdx) => {
    const row = 5 + rowIdx;
    set(cells, `B${row}`, cell(wacc, pct));
    for (let idx = 0; idx < 5; idx++) {
      const c = col(2 + idx);
      set(cells, `${c}${row}`, formula(`=IFERROR(((SUM(DCF!$C$24:$G$24)+DCF!$G$20*(1+${c}$4)/($B${row}-${c}$4)/(1+$B${row})^5)+DCF!$H$31-DCF!$H$32)/DCF!$H$34,0)`, perShare));
    }
  });

  set(cells, 'A12', cell('Enterprise Value Sensitivity', STYLE.section));
  set(cells, 'B13', cell('WACC \\ g', STYLE.header));
  [0.015, 0.02, 0.025, 0.03, 0.035].forEach((growth, idx) => {
    set(cells, `${col(2 + idx)}13`, cell(growth, pct));
  });
  [0.08, 0.09, 0.10, 0.11, 0.12].forEach((wacc, rowIdx) => {
    const row = 14 + rowIdx;
    set(cells, `B${row}`, cell(wacc, pct));
    for (let idx = 0; idx < 5; idx++) {
      const c = col(2 + idx);
      set(cells, `${c}${row}`, formula(`=IFERROR(SUM(DCF!$C$24:$G$24)+DCF!$G$20*(1+${c}$13)/($B${row}-${c}$13)/(1+$B${row})^5,0)`, money));
    }
  });

  return [makeSetCellRangeAction('Sensitivity', cells)];
}

function buildFormatActions() {
  const ranges = [
    ['Assumptions', 'A1:A40', { horizontalAlignment: 'Left' }],
    ['WACC', 'A1:A22', { horizontalAlignment: 'Left' }],
    ['DCF', 'A1:A40', { horizontalAlignment: 'Left' }],
    ['Sensitivity', 'A1:A18', { horizontalAlignment: 'Left' }],
    ['Assumptions', 'B1:B40', { horizontalAlignment: 'Right' }],
    ['WACC', 'B1:B22', { horizontalAlignment: 'Right' }],
    ['DCF', 'B1:H40', { horizontalAlignment: 'Right' }],
    ['Sensitivity', 'B1:G18', { horizontalAlignment: 'Right' }],
    ['Assumptions', 'A1:B1', STYLE.title],
    ['WACC', 'A1:B1', STYLE.title],
    ['DCF', 'A1:H1', STYLE.title],
    ['Sensitivity', 'A1:G1', STYLE.title]
  ];

  return ranges.map(([sheet, target, options]) => ({ type: 'setCellFormat', sheet, target, options }));
}

function buildDcfSection(params = {}, memory = {}) {
  const inputs = inferDcfInputs(params, memory);
  const section = String(params.section || 'all').toLowerCase();
  let actions;

  switch (section) {
    case 'shell':
      actions = buildShellActions(inputs);
      break;
    case 'assumptions':
      actions = buildAssumptionsActions(inputs);
      break;
    case 'wacc':
      actions = buildWaccActions(inputs);
      break;
    case 'dcf':
    case 'projection':
      actions = buildDcfActions(inputs);
      break;
    case 'sensitivity':
      actions = buildSensitivityActions(inputs);
      break;
    case 'format':
    case 'formatting':
      actions = buildFormatActions();
      break;
    case 'all':
      actions = [
        ...buildShellActions(inputs),
        ...buildAssumptionsActions(inputs),
        ...buildWaccActions(inputs),
        ...buildDcfActions(inputs),
        ...buildSensitivityActions(inputs),
        ...buildFormatActions()
      ];
      break;
    default:
      throw new Error(`Unknown DCF section: ${params.section}`);
  }

  return {
    data: {
      model: 'dcf',
      section,
      ticker: inputs.ticker,
      companyName: inputs.companyName,
      projectionYears: inputs.projectionYears,
      actionCount: actions.length,
      assumptions: {
        baseRevenueMillions: inputs.baseRevenueMillions,
        ebitdaMargin: inputs.ebitdaMargin,
        taxRate: inputs.taxRate,
        terminalGrowthRate: inputs.terminalGrowthRate,
        beta: inputs.beta
      }
    },
    actions
  };
}

module.exports = {
  buildDcfSection,
  inferDcfInputs
};
