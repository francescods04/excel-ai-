const { analyzeWorkbookContext } = require('../utils/sheetParser');
const { getAnalystDepth, getDcfModelAnalystWorkplan } = require('./analystDepth');

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
  currency: '#,##0.0',
  percent: '0.00%',
  multiple: '0.00x',
  shares: '#,##0.0',
  perShare: '#,##0.00',
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
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toMillions(value) {
  const n = finiteNumber(value);
  if (n == null) return null;
  return Math.abs(n) > 10000000 ? n / 1000000 : n;
}

function toRatio(value) {
  const n = finiteNumber(value);
  if (n == null) return null;
  if (Math.abs(n) > 1.5 && Math.abs(n) <= 100) return n / 100;
  return n;
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

function walkText(value, out = [], depth = 0, seen = new Set()) {
  if (value == null || depth > 5 || out.length > 2500) return out;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text) out.push(text);
    return out;
  }
  if (typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) walkText(entry, out, depth + 1, seen);
    return out;
  }
  for (const entry of Object.values(value)) walkText(entry, out, depth + 1, seen);
  return out;
}

function resultDataAsWorkbookContext(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.allSheetsData || data.usedRangeData) return data;
  if (!Array.isArray(data.sheets)) return null;
  const allSheetsData = {};
  for (const sheet of data.sheets) {
    if (!sheet?.name || !Array.isArray(sheet.preview)) continue;
    allSheetsData[sheet.name] = {
      isActive: sheet.name === data.activeSheet,
      usedRange: sheet.usedRange || null,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      preview: sheet.preview,
      formulas: sheet.formulas,
      numberFormat: sheet.numberFormat
    };
  }
  return Object.keys(allSheetsData).length > 0
    ? { activeSheet: data.activeSheet, workbookSheets: data.workbookSheets, allSheetsData }
    : (data.selectedValues ? data : null);
}

function collectWorkbookAnalyses(memory = {}) {
  const analyses = [];
  if (memory.context) {
    const parsed = analyzeWorkbookContext(memory.context);
    if (parsed.inferredInputs.length > 0) analyses.push({ parsed, context: memory.context });
  }
  const results = memory?.results && typeof memory.results === 'object' ? memory.results : {};
  for (const result of Object.values(results)) {
    if (!result || result.ok === false) continue;
    const ctx = resultDataAsWorkbookContext(result.data ?? result);
    if (!ctx) continue;
    const parsed = analyzeWorkbookContext(ctx);
    if (parsed.inferredInputs.length > 0) analyses.push({ parsed, context: ctx });
  }
  return analyses;
}

function findCompanyNameFromWorkbook(memory = {}, analyses = []) {
  const textValues = [];
  if (memory.context) textValues.push(...walkText(memory.context));
  for (const { context } of analyses) textValues.push(...walkText(context));
  const candidates = textValues
    .map(text => text.replace(/\s+/g, ' ').trim())
    .filter(text => text.length >= 3 && text.length <= 80)
    .filter(text => !/^(sheet|scenario|actual|forecast|period|year|data|currency|units)$/i.test(text));

  const legalName = candidates.find(text => /\b(SPA|S\.P\.A\.|SRL|S\.R\.L\.|SA|AG|LTD|PLC|INC|CORP|GROUP)\b/i.test(text));
  return legalName || candidates.find(text => /^[A-Z0-9 .,&'-]{3,}$/.test(text)) || null;
}

function inferCurrencyFromWorkbook(memory = {}, analyses = []) {
  const text = [
    ...walkText(memory.context),
    ...analyses.flatMap(({ context }) => walkText(context))
  ].join(' ');
  if (/[€]|\bEUR\b/i.test(text)) return 'EUR';
  if (/\bGBP\b|£/i.test(text)) return 'GBP';
  if (/\bCHF\b/i.test(text)) return 'CHF';
  if (/\bUSD\b|\$/i.test(text)) return 'USD';
  return null;
}

function normalizeTextForInference(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function inferReportingUnitFromWorkbook(memory = {}, analyses = []) {
  const rawText = [
    ...walkText(memory.context),
    ...analyses.flatMap(({ context }) => walkText(context))
  ].join(' ');
  const lower = rawText.toLowerCase();
  const text = normalizeTextForInference(rawText);
  if (/\bk\s*€|\bkeur\b|\bk eur\b/.test(lower) || /\b(en )?(milliers|migliaia|thousands)\b/.test(text)) return 'thousands';
  if (/\bm\s*€|\bmeur\b|\bm eur\b/.test(lower) || /\b(en )?(millions|milioni)\b/.test(text)) return 'millions';
  if (/\bmd\s*€|\bmdeur\b|\bmd eur\b/.test(lower) || /\b(milliards|miliardi|billions)\b/.test(text)) return 'billions';
  return null;
}

function currencySymbol(currency) {
  const code = String(currency || 'USD').toUpperCase();
  if (code === 'EUR') return '€';
  if (code === 'GBP') return '£';
  if (code === 'CHF') return 'CHF';
  if (code === 'USD') return '$';
  return code;
}

function currencyUnitLabel(currency) {
  const code = String(currency || 'USD').toUpperCase();
  return `${code} in millions except per-share data`;
}

function amountLabel(inputs) {
  return `${inputs.currencySymbol || currencySymbol(inputs.currency)}M`;
}

function perShareLabel(inputs) {
  return inputs.currencySymbol || currencySymbol(inputs.currency);
}

function pickWorkbookInput(inputs, canonicals) {
  const wanted = new Set(canonicals);
  return inputs
    .filter(input => wanted.has(input.canonical) && finiteNumber(input.value) != null)
    .sort((a, b) => {
      const priorityDelta = (b.priority || 0) - (a.priority || 0);
      if (priorityDelta) return priorityDelta;
      const actualDelta = Number(!!a.isForecast) - Number(!!b.isForecast);
      if (actualDelta) return actualDelta;
      const aPeriod = periodSortValue(a);
      const bPeriod = periodSortValue(b);
      if (aPeriod != null && bPeriod != null && aPeriod !== bPeriod) return bPeriod - aPeriod;
      if (aPeriod != null && bPeriod == null) return -1;
      if (aPeriod == null && bPeriod != null) return 1;
      const rowDelta = (a.row ?? 999999) - (b.row ?? 999999);
      if (rowDelta) return rowDelta;
      return (a.col ?? 999999) - (b.col ?? 999999);
    })[0] || null;
}

function periodSortValue(input) {
  const order = finiteNumber(input?.periodOrder);
  if (order != null) return order;
  const year = finiteNumber(input?.fiscalYear);
  if (year != null) return year;
  return null;
}

function sortSeriesLatestFirst(values = []) {
  const withValues = values.filter(input => finiteNumber(input.value) != null);
  const actualValues = withValues.filter(input => !input.isForecast);
  const candidates = actualValues.length >= 2 ? actualValues : withValues;
  const hasPeriod = candidates.some(input => periodSortValue(input) != null);
  return [...candidates].sort((a, b) => {
    if (hasPeriod) {
      const aPeriod = periodSortValue(a);
      const bPeriod = periodSortValue(b);
      if (aPeriod != null && bPeriod != null && aPeriod !== bPeriod) return bPeriod - aPeriod;
      if (aPeriod != null && bPeriod == null) return -1;
      if (aPeriod == null && bPeriod != null) return 1;
    }
    return (a.col ?? 999999) - (b.col ?? 999999);
  });
}

function pickWorkbookSeries(inputs, canonical) {
  const groups = new Map();
  inputs
    .filter(input => input.canonical === canonical && finiteNumber(input.value) != null)
    .forEach(input => {
      const key = `${input.sheet || ''}:${input.row}:${input.label}`;
      const group = groups.get(key) || {
        label: input.label,
        canonical,
        row: input.row,
        sheet: input.sheet,
        priority: input.priority || 0,
        values: []
      };
      group.priority = Math.max(group.priority, input.priority || 0);
      group.values.push(input);
      groups.set(key, group);
    });

  const series = [...groups.values()]
    .filter(group => group.values.length > 0)
    .sort((a, b) => {
      const countDelta = b.values.length - a.values.length;
      if (countDelta) return countDelta;
      const priorityDelta = (b.priority || 0) - (a.priority || 0);
      if (priorityDelta) return priorityDelta;
      return (a.row ?? 999999) - (b.row ?? 999999);
    })[0]?.values || [];
  return sortSeriesLatestFirst(series);
}

function average(values) {
  const nums = values.map(finiteNumber).filter(n => n != null);
  if (nums.length === 0) return null;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function median(values) {
  const nums = values.map(finiteNumber).filter(n => n != null).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function latestToOldestRatios(numeratorSeries, denominatorSeries) {
  const count = Math.min(numeratorSeries.length, denominatorSeries.length);
  const ratios = [];
  for (let i = 0; i < count; i++) {
    const numerator = finiteNumber(numeratorSeries[i]?.value);
    const denominator = finiteNumber(denominatorSeries[i]?.value);
    if (numerator != null && denominator && denominator !== 0) ratios.push(numerator / denominator);
  }
  return ratios;
}

function workbookAmountToMillions(value, reportingUnit = null) {
  const n = finiteNumber(value);
  if (n == null) return null;
  if (reportingUnit === 'thousands') return n / 1000;
  if (reportingUnit === 'millions') return n;
  if (reportingUnit === 'billions') return n * 1000;
  return toMillions(n);
}

function periodLabel(input, fallback = 'Historical') {
  return input?.period || (input?.fiscalYear ? `${input.fiscalYear}A` : fallback);
}

function revenueGrowthAnalysis(revenueSeries, terminalGrowthRate = DEFAULTS.terminalGrowthRate, reportingUnit = null) {
  const values = sortSeriesLatestFirst(revenueSeries)
    .map(input => ({
      input,
      label: periodLabel(input),
      cell: input.cell,
      rawValue: input.rawValue,
      value: finiteNumber(input.value),
      valueMillions: workbookAmountToMillions(input.value, reportingUnit)
    }))
    .filter(item => item.value != null && item.value > 0);

  if (values.length < 2) {
    return {
      path: DEFAULTS.revenueGrowth,
      values,
      rates: [],
      latestGrowth: null,
      medianGrowth: null,
      cagr: null,
      startingGrowth: DEFAULTS.revenueGrowth[0],
      terminalAnchor: DEFAULTS.revenueGrowth[DEFAULTS.revenueGrowth.length - 1],
      method: 'No sufficient historical revenue series; using fallback growth curve.'
    };
  }

  const rates = [];
  for (let i = 0; i < values.length - 1; i++) {
    const current = values[i];
    const prior = values[i + 1];
    if (prior.value > 0) {
      rates.push({
        label: `${current.label} / ${prior.label}`,
        value: current.value / prior.value - 1,
        current,
        prior
      });
    }
  }
  const usableRates = rates.map(rate => rate.value).filter(rate => Number.isFinite(rate) && rate > -0.8 && rate < 2.0);
  const latestGrowth = usableRates[0] ?? null;
  const medianGrowth = median(usableRates);
  const oldestIndex = Math.min(values.length, 5) - 1;
  const latest = values[0];
  const oldest = values[oldestIndex];
  const latestOrder = periodSortValue(latest.input);
  const oldestOrder = periodSortValue(oldest.input);
  const periods = latestOrder != null && oldestOrder != null && latestOrder > oldestOrder
    ? latestOrder - oldestOrder
    : oldestIndex;
  const cagr = oldest.value > 0 && periods > 0 ? (latest.value / oldest.value) ** (1 / periods) - 1 : null;
  const startingGrowth = clamp(median([latestGrowth, medianGrowth, cagr]), -0.10, 0.20, DEFAULTS.revenueGrowth[0]);
  const terminalAnchor = clamp(terminalGrowthRate + 0.015, -0.02, 0.08, 0.04);
  const path = Array.from({ length: DEFAULTS.projectionYears }, (_, index) => {
    const t = DEFAULTS.projectionYears === 1 ? 1 : index / (DEFAULTS.projectionYears - 1);
    return startingGrowth + (terminalAnchor - startingGrowth) * t;
  });
  return {
    path,
    values,
    rates,
    latestGrowth,
    medianGrowth,
    cagr,
    startingGrowth,
    terminalAnchor,
    method: `Growth bridge uses latest YoY (${latestGrowth == null ? 'n/a' : `${(latestGrowth * 100).toFixed(1)}%`}), median YoY (${medianGrowth == null ? 'n/a' : `${(medianGrowth * 100).toFixed(1)}%`}) and CAGR (${cagr == null ? 'n/a' : `${(cagr * 100).toFixed(1)}%`}), then fades toward terminal growth.`
  };
}

function sourceSummaryFor(series) {
  return series.slice(0, 5).map(input => `${periodLabel(input)}: ${input.rawValue} at ${input.cell}`).join(' | ');
}

function aiSchemaInputs(aiSchema) {
  if (!aiSchema || !Array.isArray(aiSchema.mappings)) return [];
  const confidenceScore = { high: 120, medium: 90, low: 45 };
  return aiSchema.mappings.map(input => ({
    label: input.label || input.canonical,
    canonical: input.canonical,
    value: input.value,
    rawValue: input.rawValue,
    cell: input.cell,
    confidence: input.confidence === 'low' ? 'medium' : 'high',
    priority: (confidenceScore[input.confidence] || 75) + 100,
    period: input.period || null,
    fiscalYear: input.fiscalYear ?? null,
    periodOrder: input.periodOrder ?? input.fiscalYear ?? null,
    isForecast: !!input.isForecast,
    isActual: !input.isForecast,
    row: input.row,
    col: input.col,
    sheet: input.sheet,
    aiMapped: true,
    rationale: input.rationale || ''
  })).filter(input => input.canonical && finiteNumber(input.value) != null);
}

function inferWorkbookDcfInputs(memory = {}, params = {}) {
  const analyses = collectWorkbookAnalyses(memory);
  const aiSchema = params.aiSchema || memory.aiWorkbookSchema || null;
  const deterministicInputs = analyses.flatMap(({ parsed }) => parsed.inferredInputs || [])
    .filter(input => input.confidence === 'high');
  const inputs = [
    ...aiSchemaInputs(aiSchema),
    ...deterministicInputs
  ];
  if (inputs.length === 0) return { hasWorkbookFinancials: false, sourceRefs: {} };

  const revenueInput = pickWorkbookInput(inputs, ['Revenue']);
  const ebitdaInput = pickWorkbookInput(inputs, ['EBITDA']);
  const ebitdaMarginInput = pickWorkbookInput(inputs, ['EBITDA Margin']);
  const netIncomeInput = pickWorkbookInput(inputs, ['Net Income']);
  const daInput = pickWorkbookInput(inputs, ['D&A']);
  const preTaxInput = pickWorkbookInput(inputs, ['Pre-Tax Income']);
  const taxInput = pickWorkbookInput(inputs, ['Income Taxes']);
  const cashInput = pickWorkbookInput(inputs, ['Cash & Equivalents']);
  const debtInput = pickWorkbookInput(inputs, ['Total Debt']);
  const netDebtInput = pickWorkbookInput(inputs, ['Net Debt']);
  const debtEquityInput = pickWorkbookInput(inputs, ['Debt / Equity']);
  const nwcInput = pickWorkbookInput(inputs, ['Net Working Capital']);
  const sharesInput = pickWorkbookInput(inputs, ['Shares Outstanding', 'Diluted Shares']);
  const sharePriceInput = pickWorkbookInput(inputs, ['Share Price']);
  const revenueSeries = pickWorkbookSeries(inputs, 'Revenue');
  const ebitdaSeries = pickWorkbookSeries(inputs, 'EBITDA');
  const daSeries = pickWorkbookSeries(inputs, 'D&A');
  const preTaxSeries = pickWorkbookSeries(inputs, 'Pre-Tax Income');
  const taxSeries = pickWorkbookSeries(inputs, 'Income Taxes');
  const nwcSeries = pickWorkbookSeries(inputs, 'Net Working Capital');

  const sourceRefs = {};
  for (const input of [
    revenueInput,
    ebitdaInput,
    ebitdaMarginInput,
    netIncomeInput,
    daInput,
    preTaxInput,
    taxInput,
    cashInput,
    debtInput,
    netDebtInput,
    debtEquityInput,
    nwcInput,
    sharesInput,
    sharePriceInput
  ]) {
    if (input?.canonical && input?.cell && !sourceRefs[input.canonical]) sourceRefs[input.canonical] = input.cell;
  }

  const workbookText = [
    ...walkText(memory.context),
    ...analyses.flatMap(({ context }) => walkText(context))
  ].join(' ');
  const normalizedWorkbookText = normalizeTextForInference(workbookText);
  const isPrivateCompany = typeof aiSchema?.isPrivateCompany === 'boolean'
    ? aiSchema.isPrivateCompany
    : /\b(private|privata|non quotata|unlisted|non cotee|non cote|societe privee)\b/i.test(normalizedWorkbookText);
  const hasWorkbookFinancials = !!(revenueInput && (ebitdaInput || ebitdaMarginInput || netIncomeInput));
  return {
    hasWorkbookFinancials,
    companyName: aiSchema?.companyName || findCompanyNameFromWorkbook(memory, analyses),
    currency: aiSchema?.currency || inferCurrencyFromWorkbook(memory, analyses),
    reportingUnit: aiSchema?.reportingUnit || inferReportingUnitFromWorkbook(memory, analyses),
    aiSchemaUsed: !!aiSchema?.mappings?.length,
    aiSchemaWarnings: aiSchema?.warnings || [],
    isPrivateCompany,
    revenue: revenueInput?.value ?? null,
    ebitda: ebitdaInput?.value ?? null,
    ebitdaMargin: ebitdaMarginInput ? toRatio(ebitdaMarginInput.value) : null,
    netIncome: netIncomeInput?.value ?? null,
    da: daInput?.value ?? null,
    preTaxIncome: preTaxInput?.value ?? null,
    incomeTaxes: taxInput?.value ?? null,
    cash: cashInput?.value ?? null,
    debt: debtInput?.value ?? null,
    netDebt: netDebtInput?.value ?? null,
    debtEquity: debtEquityInput ? toRatio(debtEquityInput.value) : null,
    nwc: nwcInput?.value ?? null,
    shares: sharesInput?.value ?? null,
    sharePrice: sharePriceInput?.value ?? null,
    series: {
      revenue: revenueSeries,
      ebitda: ebitdaSeries,
      da: daSeries,
      preTaxIncome: preTaxSeries,
      incomeTaxes: taxSeries,
      nwc: nwcSeries
    },
    sourceRefs,
    sourceSummary: inputs.slice(0, 12).map(input => `${input.aiMapped ? 'AI map ' : ''}${input.canonical}: ${input.rawValue} at ${input.cell}`)
  };
}

function inferDcfInputs(params = {}, memory = {}) {
  const chunks = collectResultData(memory);
  const workbookInputs = inferWorkbookDcfInputs(memory, params);
  const sourceType = workbookInputs.hasWorkbookFinancials ? 'workbook' : 'external';
  const ticker = String(
    params.ticker ||
    (workbookInputs.hasWorkbookFinancials && workbookInputs.isPrivateCompany ? 'PRIVATE' : null) ||
    firstString(chunks, ['symbol']) ||
    'TICKER'
  ).toUpperCase();
  const companyName = params.companyName ||
    workbookInputs.companyName ||
    firstString(chunks, ['longName', 'shortName', 'displayName']) ||
    ticker;
  const useExternalMarketData = !(workbookInputs.hasWorkbookFinancials && workbookInputs.isPrivateCompany);
  const price = useExternalMarketData ? firstNumber(chunks, ['regularMarketPrice', 'currentPrice', 'price', 'previousClose']) : null;
  const marketCap = useExternalMarketData ? firstNumber(chunks, ['marketCap']) : null;
  const shares = useExternalMarketData ? firstNumber(chunks, ['sharesOutstanding', 'impliedSharesOutstanding']) : null;
  const revenue = workbookInputs.revenue ?? firstNumber(chunks, ['totalRevenue', 'revenue']);
  const ebitda = workbookInputs.ebitda ?? firstNumber(chunks, ['ebitda']);
  const beta = workbookInputs.hasWorkbookFinancials && workbookInputs.isPrivateCompany
    ? null
    : firstNumber(chunks, ['beta']);
  const totalCash = workbookInputs.cash ?? firstNumber(chunks, ['totalCash', 'cash', 'cashAndCashEquivalents']);
  const totalDebt = workbookInputs.debt ?? workbookInputs.netDebt ?? firstNumber(chunks, ['totalDebt', 'debt']);
  const reportingUnit = workbookInputs.reportingUnit || null;
  const workbookMoney = value => workbookAmountToMillions(value, reportingUnit);

  const baseRevenueMillions = (workbookInputs.revenue != null ? workbookMoney(workbookInputs.revenue) : toMillions(revenue)) || DEFAULTS.baseRevenueMillions;
  const ebitdaMillions = workbookInputs.ebitda != null ? workbookMoney(workbookInputs.ebitda) : toMillions(ebitda);
  const ebitdaMargin = ebitdaMillions && baseRevenueMillions
    ? clamp(ebitdaMillions / baseRevenueMillions, 0.05, 0.65, DEFAULTS.ebitdaMargin)
    : workbookInputs.ebitdaMargin != null
      ? clamp(workbookInputs.ebitdaMargin, 0.05, 0.65, DEFAULTS.ebitdaMargin)
    : DEFAULTS.ebitdaMargin;
  const daRatios = latestToOldestRatios(workbookInputs.series?.da || [], workbookInputs.series?.revenue || []);
  const historicalDaPercentRevenue = median(daRatios);
  const taxRatios = latestToOldestRatios(workbookInputs.series?.incomeTaxes || [], workbookInputs.series?.preTaxIncome || [])
    .map(Math.abs)
    .filter(ratio => ratio >= 0 && ratio <= 0.6);
  const historicalTaxRate = median(taxRatios);
  const latestNwc = finiteNumber(workbookInputs.nwc);
  const historicalNwcPercentRevenue = latestNwc != null && baseRevenueMillions
    ? workbookMoney(latestNwc) / baseRevenueMillions
    : null;
  const growthAnalysis = revenueGrowthAnalysis(workbookInputs.series?.revenue || [], DEFAULTS.terminalGrowthRate, reportingUnit);
  const revenueGrowth = growthAnalysis.path || DEFAULTS.revenueGrowth;
  const cashMillions = Math.max(0, (workbookInputs.cash != null ? workbookMoney(workbookInputs.cash) : toMillions(totalCash)) || DEFAULTS.cashMillions);
  const debtMillions = Math.max(0, ((workbookInputs.debt != null || workbookInputs.netDebt != null) ? workbookMoney(totalDebt) : toMillions(totalDebt)) || DEFAULTS.debtMillions);
  const marketCapMillions = Math.max(0, toMillions(marketCap) || 0);
  const hasLocalShareCount = finiteNumber(workbookInputs.shares) != null;
  const hasMarketShareCount = finiteNumber(shares) != null;
  const hasSharePrice = finiteNumber(workbookInputs.sharePrice) != null || finiteNumber(price) != null;
  const privateOwnershipMode = !!(workbookInputs.hasWorkbookFinancials && workbookInputs.isPrivateCompany && !hasLocalShareCount && !hasMarketShareCount);
  const sharePrice = Math.max(0, finiteNumber(workbookInputs.sharePrice) ?? finiteNumber(price) ?? DEFAULTS.sharePrice);
  const localSharesMillions = toMillions(workbookInputs.shares);
  const sharesMillions = localSharesMillions ||
    toMillions(shares) ||
    (marketCapMillions && sharePrice ? marketCapMillions / sharePrice : null) ||
    (workbookInputs.hasWorkbookFinancials && workbookInputs.isPrivateCompany ? 1 : DEFAULTS.sharesMillions);
  const targetDebtToEquity = workbookInputs.debtEquity != null
    ? clamp(workbookInputs.debtEquity, 0, 1.5, DEFAULTS.targetDebtToEquity)
    : (marketCapMillions > 0 ? clamp(debtMillions / marketCapMillions, 0, 1.5, DEFAULTS.targetDebtToEquity) : DEFAULTS.targetDebtToEquity);
  const currency = params.currency || workbookInputs.currency || 'USD';
  const latestRevenuePeriod = workbookInputs.series?.revenue?.[0];
  const baseYear = Number.isInteger(latestRevenuePeriod?.fiscalYear)
    ? latestRevenuePeriod.fiscalYear
    : new Date().getFullYear() - 1;

  return {
    ticker,
    companyName,
    currency,
    currencySymbol: currencySymbol(currency),
    unitLabel: currencyUnitLabel(currency),
    reportingUnit,
    sourceType,
    aiSchemaUsed: !!workbookInputs.aiSchemaUsed,
    aiSchemaWarnings: workbookInputs.aiSchemaWarnings || [],
    sourceRefs: workbookInputs.sourceRefs || {},
    sourceSummary: workbookInputs.sourceSummary || [],
    isPrivateCompany: !!workbookInputs.isPrivateCompany,
    debtIsNetDebt: workbookInputs.debt == null && workbookInputs.netDebt != null,
    projectionYears: Number(params.projectionYears) || DEFAULTS.projectionYears,
    baseYear,
    revenueGrowth,
    historicalGrowth: growthAnalysis,
    ebitdaMargin,
    taxRate: clamp(historicalTaxRate, 0.05, 0.40, DEFAULTS.taxRate),
    daPercentRevenue: clamp(historicalDaPercentRevenue, 0.005, 0.15, DEFAULTS.daPercentRevenue),
    capexPercentRevenue: clamp(historicalDaPercentRevenue, 0.005, 0.18, DEFAULTS.capexPercentRevenue),
    nwcPercentRevenue: clamp(historicalNwcPercentRevenue, -0.20, 0.20, DEFAULTS.nwcPercentRevenue),
    riskFreeRate: DEFAULTS.riskFreeRate,
    marketRiskPremium: DEFAULTS.marketRiskPremium,
    beta: clamp(beta, 0.4, 2.5, workbookInputs.isPrivateCompany ? 0.85 : DEFAULTS.beta),
    preTaxCostOfDebt: DEFAULTS.preTaxCostOfDebt,
    targetDebtToEquity,
    terminalGrowthRate: DEFAULTS.terminalGrowthRate,
    baseRevenueMillions,
    cashMillions,
    debtMillions,
    sharesMillions,
    sharePrice,
    marketCapMillions,
    hasShareCount: hasLocalShareCount || hasMarketShareCount || !privateOwnershipMode,
    hasSharePrice,
    privateOwnershipMode,
    historicalSourceSummary: {
      revenue: sourceSummaryFor(workbookInputs.series?.revenue || []),
      ebitda: sourceSummaryFor(workbookInputs.series?.ebitda || []),
      da: sourceSummaryFor(workbookInputs.series?.da || []),
      tax: sourceSummaryFor(workbookInputs.series?.incomeTaxes || []),
      nwc: sourceSummaryFor(workbookInputs.series?.nwc || [])
    }
  };
}

function set(cells, address, spec) {
  cells[address] = spec;
}

function makeSetCellRangeAction(sheet, cells) {
  return { type: 'setCellRange', sheet, cells, allow_overwrite: true };
}

function buildShellActions(inputs) {
  const sheets = ['Summary', 'Sources', 'Assumptions', 'WACC', 'DCF', 'Sensitivity', 'Scenarios', 'Audit'];
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
  const currency = inputs.currency || 'USD';
  const amount = amountLabel(inputs);
  const perShare = perShareLabel(inputs);
  const sourceLabel = inputs.sourceType === 'workbook'
    ? (inputs.aiSchemaUsed ? 'AI-understood workbook local data' : 'Workbook local data')
    : 'External market data';
  const refs = inputs.sourceRefs || {};
  const refFor = (...keys) => keys.map(key => refs[key]).find(Boolean);
  const sourceNote = (ref, fallback = 'Analyst assumption; replace with sourced value when available') =>
    ref ? `Local source: ${ref}` : (inputs.sourceType === 'workbook' ? `Review: ${fallback}` : fallback);
  const explain = (row, method, source) => {
    set(cells, `C${row}`, cell(method, STYLE.label));
    set(cells, `D${row}`, cell(source, STYLE.check));
  };

  set(cells, 'A1', cell(`${inputs.companyName} (${inputs.ticker}) - DCF Assumptions`, STYLE.title));
  set(cells, 'A3', cell('Company & Source', STYLE.section));
  set(cells, 'B3', cell('Input', STYLE.header));
  set(cells, 'C3', cell('How Derived', STYLE.header));
  set(cells, 'D3', cell('Source / Review', STYLE.header));
  set(cells, 'A4', cell('Company', STYLE.label));
  set(cells, 'B4', cell(inputs.companyName, STYLE.input));
  explain(4, 'Detected from user request, workbook identity, or market-data profile.', sourceNote(null, 'confirm legal entity / reporting perimeter'));
  set(cells, 'A5', cell('Ticker', STYLE.label));
  set(cells, 'B5', cell(inputs.ticker, STYLE.input));
  explain(5, 'Resolved from user request or equity-intent parser; PRIVATE used for local private-company workbooks.', inputs.ticker === 'PRIVATE' ? 'Local private-company context' : 'Ticker / symbol to verify');
  set(cells, 'A6', cell('Currency', STYLE.label));
  set(cells, 'B6', cell(currency, STYLE.input));
  explain(6, 'Detected from workbook currency markers; otherwise defaulted to USD.', inputs.currency ? 'Workbook / request currency' : 'Review currency');
  set(cells, 'A7', cell('Units', STYLE.label));
  set(cells, 'B7', cell(inputs.unitLabel || currencyUnitLabel(currency), STYLE.input));
  explain(7, 'Model normalizes monetary values to millions and keeps per-share data separate.', 'Model convention');
  set(cells, 'A8', cell('Primary Data Source', STYLE.label));
  set(cells, 'B8', cell(sourceLabel, STYLE.input));
  explain(8, inputs.aiSchemaUsed ? 'AI schema-understanding mapped workbook cells across language/layout; deterministic parser is only a validation fallback.' : 'Workbook-first when local financials are high-confidence; external tools only supplement missing inputs.', inputs.sourceType === 'workbook' ? 'Workbook-first' : 'External data / fallback');

  set(cells, 'A9', cell('Historical / Market Inputs', STYLE.section));
  set(cells, 'B9', cell('Input', STYLE.header));
  set(cells, 'C9', cell('How Derived', STYLE.header));
  set(cells, 'D9', cell('Source / Review', STYLE.header));
  set(cells, 'A10', cell(`Base Revenue (${amount})`, STYLE.label));
  set(cells, 'B10', cell(inputs.baseRevenueMillions, fmt(inputStyle, { numberFormat: NUM_FORMATS.currency })));
  explain(10, 'Mapped latest high-confidence revenue figure and converted to millions.', sourceNote(refFor('Revenue'), 'revenue not sourced; using fallback base revenue'));
  set(cells, 'A11', cell('EBITDA Margin (%)', STYLE.label));
  set(cells, 'B11', cell(inputs.ebitdaMargin, pctInputStyle));
  explain(11, 'Calculated as EBITDA / revenue when available; otherwise normalized fallback within plausible range.', sourceNote(refFor('EBITDA', 'EBITDA Margin'), 'EBITDA/margin not sourced'));
  set(cells, 'A12', cell('Tax Rate (%)', STYLE.label));
  set(cells, 'B12', cell(inputs.taxRate, pctInputStyle));
  explain(12, 'Calculated from income taxes / pre-tax income when available; otherwise normalized effective tax assumption.', sourceNote(refFor('Income Taxes', 'Tax Rate', 'Taxes'), 'tax rate requires analyst confirmation'));
  set(cells, 'A13', cell('D&A % of Revenue (%)', STYLE.label));
  set(cells, 'B13', cell(inputs.daPercentRevenue, pctInputStyle));
  explain(13, 'Derived from historical depreciation/amortization as a percent of revenue where available.', sourceNote(refFor('D&A', 'Depreciation'), 'D&A intensity requires historical support'));
  set(cells, 'A14', cell('CapEx % of Revenue (%)', STYLE.label));
  set(cells, 'B14', cell(inputs.capexPercentRevenue, pctInputStyle));
  explain(14, 'Capital intensity assumption tied to revenue; uses CapEx history when available, otherwise D&A proxy / analyst fallback.', sourceNote(refFor('CapEx', 'Capital Expenditures', 'D&A'), 'CapEx intensity requires historical support'));
  set(cells, 'A15', cell('NWC % of Revenue (%)', STYLE.label));
  set(cells, 'B15', cell(inputs.nwcPercentRevenue, pctInputStyle));
  explain(15, 'Working-capital investment modeled from local NWC / revenue when available; negative values indicate cash-generative working capital.', sourceNote(refFor('Net Working Capital', 'Working Capital'), 'NWC intensity requires balance-sheet support'));

  set(cells, 'A17', cell('Projection Assumptions', STYLE.section));
  set(cells, 'B17', cell('Input', STYLE.header));
  set(cells, 'C17', cell('How Derived', STYLE.header));
  set(cells, 'D17', cell('Source / Review', STYLE.header));
  inputs.revenueGrowth.forEach((growth, index) => {
    set(cells, `A${18 + index}`, cell(`Revenue Growth Y${index + 1} (%)`, STYLE.label));
    set(cells, `B${18 + index}`, cell(growth, pctInputStyle));
    explain(18 + index, `Forecast fade path for year ${index + 1}. ${inputs.historicalGrowth?.method || 'Uses fallback curve when no historical series is available.'}`, inputs.historicalSourceSummary?.revenue ? `Local trend: ${inputs.historicalSourceSummary.revenue}` : 'Review: growth assumption');
  });
  set(cells, 'A23', cell('Terminal Growth Rate (%)', STYLE.label));
  set(cells, 'B23', cell(inputs.terminalGrowthRate, pctInputStyle));
  explain(23, 'Long-term growth assumption kept below WACC and sanity-checked against GDP/inflation range.', 'Review: terminal growth support');

  set(cells, 'A25', cell('WACC Inputs', STYLE.section));
  set(cells, 'B25', cell('Input', STYLE.header));
  set(cells, 'C25', cell('How Derived', STYLE.header));
  set(cells, 'D25', cell('Source / Review', STYLE.header));
  set(cells, 'A26', cell('Risk-Free Rate (%)', STYLE.label));
  set(cells, 'B26', cell(inputs.riskFreeRate, pctInputStyle));
  explain(26, 'Current long-dated sovereign yield proxy for valuation currency / market.', 'Review: update from treasury / BTP curve');
  set(cells, 'A27', cell('Market Risk Premium (%)', STYLE.label));
  set(cells, 'B27', cell(inputs.marketRiskPremium, pctInputStyle));
  explain(27, 'Equity risk premium input for CAPM cost of equity.', 'Review: ERP source / country risk');
  set(cells, 'A28', cell('Beta', STYLE.label));
  set(cells, 'B28', cell(inputs.beta, fmt(inputStyle, { numberFormat: '0.00x' })));
  explain(28, 'Observed beta when public; otherwise sector/peer beta selected and cross-checked in WACC.', sourceNote(refFor('Beta'), 'beta must be supported by peer/sector evidence'));
  set(cells, 'A29', cell('Pre-Tax Cost of Debt (%)', STYLE.label));
  set(cells, 'B29', cell(inputs.preTaxCostOfDebt, pctInputStyle));
  explain(29, 'Pre-tax borrowing cost before tax shield; should reflect current credit spread or debt yield.', 'Review: debt cost support');
  set(cells, 'A30', cell('Target Debt / Equity', STYLE.label));
  set(cells, 'B30', cell(inputs.targetDebtToEquity, fmt(inputStyle, { numberFormat: '0.00x' })));
  explain(30, 'Derived from local debt/equity if available; otherwise debt divided by market value of equity.', sourceNote(refFor('Debt / Equity'), 'capital structure requires support'));

  set(cells, 'A32', cell('Equity Bridge', STYLE.section));
  set(cells, 'B32', cell('Input', STYLE.header));
  set(cells, 'C32', cell('How Derived', STYLE.header));
  set(cells, 'D32', cell('Source / Review', STYLE.header));
  set(cells, 'A33', cell(`Cash & Equivalents (${amount})`, STYLE.label));
  set(cells, 'B33', cell(inputs.cashMillions, fmt(inputStyle, { numberFormat: NUM_FORMATS.currency })));
  explain(33, 'Cash and equivalents used to bridge enterprise value to equity value.', sourceNote(refFor('Cash & Equivalents'), 'cash not sourced; verify balance sheet'));
  set(cells, 'A34', cell(`${inputs.debtIsNetDebt ? 'Net Debt' : 'Total Debt'} (${amount})`, STYLE.label));
  set(cells, 'B34', cell(inputs.debtMillions, fmt(inputStyle, { numberFormat: NUM_FORMATS.currency })));
  explain(34, 'Debt or net debt used in the EV-to-equity bridge.', sourceNote(refFor('Total Debt', 'Net Debt'), 'debt not sourced; verify balance sheet'));
  set(cells, 'A35', cell(inputs.privateOwnershipMode ? 'Ownership Units (100%=1.0)' : 'Shares Outstanding (M)', STYLE.label));
  set(cells, 'B35', cell(inputs.sharesMillions, fmt(inputStyle, { numberFormat: NUM_FORMATS.shares })));
  explain(35, inputs.privateOwnershipMode ? 'Private-company valuation uses one ownership unit equal to 100% of equity value.' : 'Diluted shares from market data/workbook; fallback uses market cap divided by price where possible.', inputs.privateOwnershipMode ? 'Private ownership basis; no invented share count' : sourceNote(refFor('Shares Outstanding', 'Diluted Shares'), 'share count requires support'));
  set(cells, 'A36', cell(inputs.privateOwnershipMode ? `Reference Share Price (${perShare})` : `Current Share Price (${perShare})`, STYLE.label));
  set(cells, 'B36', cell(inputs.sharePrice, fmt(inputStyle, { numberFormat: NUM_FORMATS.perShare })));
  explain(36, 'Current share price for premium/discount; zero for private-company models unless provided.', sourceNote(refFor('Share Price'), inputs.isPrivateCompany ? 'private model: no public share price' : 'share price requires market quote'));
  set(cells, 'A37', cell(inputs.privateOwnershipMode ? `Reference Equity Value (${amount})` : `Current Market Cap (${amount})`, STYLE.label));
  set(cells, 'B37', formula('=IF(B36>0,B35*B36,0)', fmt(STYLE.formula, { numberFormat: NUM_FORMATS.currency })));
  explain(37, inputs.privateOwnershipMode ? 'Formula: optional reference price times ownership units; remains zero when no market reference exists.' : 'Formula: shares outstanding multiplied by current share price.', 'Calculated from B35 and B36');

  set(cells, 'A40', cell('Historical Revenue Growth Bridge', STYLE.section));
  set(cells, 'A41', cell('Metric', STYLE.header));
  set(cells, 'B41', cell('Value', STYLE.header));
  set(cells, 'C41', cell('How Derived', STYLE.header));
  set(cells, 'D41', cell('Source / Review', STYLE.header));
  (inputs.historicalGrowth?.values || []).slice(0, 4).forEach((item, index) => {
    const row = 42 + index;
    set(cells, `A${row}`, cell(`Historical Revenue ${item.label}`, STYLE.label));
    set(cells, `B${row}`, cell(item.valueMillions, fmt(inputStyle, { numberFormat: NUM_FORMATS.currency })));
    explain(row, 'Revenue cell mapped from workbook and normalized to model units.', item.cell || 'Workbook revenue series');
  });
  (inputs.historicalGrowth?.rates || []).slice(0, 4).forEach((rate, index) => {
    const row = 47 + index;
    set(cells, `A${row}`, cell(`Historical YoY Growth ${rate.label}`, STYLE.label));
    set(cells, `B${row}`, cell(rate.value, pctInputStyle));
    explain(row, 'Formula logic: current historical revenue divided by prior historical revenue minus one.', `${rate.current?.cell || 'current'} vs ${rate.prior?.cell || 'prior'}`);
  });
  set(cells, 'A52', cell('Historical Revenue CAGR (%)', STYLE.label));
  set(cells, 'B52', cell(inputs.historicalGrowth?.cagr ?? '', pctInputStyle));
  explain(52, 'CAGR from latest historical revenue to oldest usable historical revenue period.', inputs.historicalGrowth?.values?.length >= 2 ? 'Calculated from local revenue series' : 'Review: insufficient history');
  set(cells, 'A53', cell('Median Historical YoY Growth (%)', STYLE.label));
  set(cells, 'B53', cell(inputs.historicalGrowth?.medianGrowth ?? '', pctInputStyle));
  explain(53, 'Median of usable historical YoY growth rates after excluding impossible outliers.', inputs.historicalGrowth?.rates?.length ? 'Calculated from local revenue series' : 'Review: insufficient history');
  set(cells, 'A54', cell('Selected Starting Growth (%)', STYLE.total));
  set(cells, 'B54', cell(inputs.historicalGrowth?.startingGrowth ?? inputs.revenueGrowth[0], fmt(STYLE.total, { numberFormat: NUM_FORMATS.percent })));
  explain(54, 'Starting point for forecast fade path: blend of latest YoY, median YoY and CAGR, bounded by sanity caps.', inputs.historicalGrowth?.method || 'Fallback growth curve');

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
  set(cells, 'A5', cell('Selected Beta', STYLE.label));
  set(cells, 'B5', formula('=B28', multiple));
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

  set(cells, 'A21', cell('Beta Evidence & Peer Cross-Check', STYLE.section));
  set(cells, 'A22', cell('Observed Levered Beta', STYLE.label));
  set(cells, 'B22', formula('=Assumptions!$B$28', multiple));
  set(cells, 'A23', cell('Peer / Sector Levered Beta', STYLE.label));
  set(cells, 'B23', formula('=Assumptions!$B$28', multiple));
  set(cells, 'A24', cell('Target Debt / Equity', STYLE.label));
  set(cells, 'B24', formula('=B15', multiple));
  set(cells, 'A25', cell('Tax Rate (%)', STYLE.label));
  set(cells, 'B25', formula('=B11', pct));
  set(cells, 'A26', cell('Unlevered Peer Beta', STYLE.label));
  set(cells, 'B26', formula('=B23/(1+(1-B25)*B24)', multiple));
  set(cells, 'A27', cell('Relevered Peer Beta', STYLE.label));
  set(cells, 'B27', formula('=B26*(1+(1-B25)*B24)', multiple));
  set(cells, 'A28', cell('Selected Beta', STYLE.total));
  set(cells, 'B28', formula('=AVERAGE(B22,B27)', fmt(STYLE.total, { numberFormat: NUM_FORMATS.multiple })));
  set(cells, 'A29', cell('Beta Cross-Check', STYLE.check));
  set(cells, 'B29', formula('=IF(ABS(B28-B22)<=0.25,"OK","Review")', STYLE.check));
  set(cells, 'A30', cell('Method Note', STYLE.label));
  set(cells, 'B30', cell('Use observed beta plus peer/sector beta; unlever peers, then relever to target D/E.', STYLE.check));

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
  const amount = amountLabel(inputs);
  const perShare = perShareLabel(inputs);
  const outputIsOwnership = !!inputs.privateOwnershipMode;
  const valueOutputLabel = outputIsOwnership
    ? `Equity Value / 100% Ownership (${amount})`
    : `Implied Share Price (${perShare})`;
  const valueOutputFormat = outputIsOwnership ? totalMoney : fmt(STYLE.total, { numberFormat: NUM_FORMATS.perShare });
  const referencePriceLabel = outputIsOwnership
    ? `Reference Share Price (${perShare})`
    : `Current Share Price (${perShare})`;

  set(cells, 'A1', cell(`${inputs.companyName} (${inputs.ticker}) - Discounted Cash Flow`, STYLE.title));
  set(cells, 'A2', cell('Metric', STYLE.header));
  set(cells, 'B2', cell(`${inputs.baseYear}A`, STYLE.header));
  for (let i = 0; i < inputs.projectionYears; i++) {
    set(cells, `${col(2 + i)}2`, cell(`${inputs.baseYear + i + 1}E`, STYLE.header));
  }
  set(cells, 'H2', cell('Terminal / Value', STYLE.header));

  const labelRows = [
    [4, 'Revenue Growth (%)'],
    [5, `Revenue (${amount})`],
    [6, 'EBITDA Margin (%)'],
    [7, `EBITDA (${amount})`],
    [8, 'D&A % Revenue (%)'],
    [9, `D&A (${amount})`],
    [10, `EBIT (${amount})`],
    [11, 'Tax Rate (%)'],
    [12, `Tax (${amount})`],
    [13, `NOPAT (${amount})`],
    [15, 'CapEx % Revenue (%)'],
    [16, `CapEx (${amount})`],
    [17, 'NWC % Revenue (%)'],
    [18, `Change in NWC (${amount})`],
    [20, `Unlevered FCF (${amount})`],
    [22, 'WACC (%)'],
    [23, 'Discount Factor'],
    [24, `PV of FCF (${amount})`],
    [26, 'Terminal Growth Rate (%)'],
    [27, `Terminal Value (${amount})`],
    [28, `PV of Terminal Value (${amount})`],
    [30, `Enterprise Value (${amount})`],
    [31, `(+) Cash & Equivalents (${amount})`],
    [32, `(-) ${inputs.debtIsNetDebt ? 'Net Debt' : 'Total Debt'} (${amount})`],
    [33, `Equity Value (${amount})`],
    [34, outputIsOwnership ? 'Ownership Units (100%=1.0)' : 'Shares Outstanding (M)'],
    [35, valueOutputLabel],
    [37, referencePriceLabel],
    [38, outputIsOwnership ? 'Premium / (Discount) to Reference (%)' : 'Premium / (Discount) to Current (%)'],
    [40, `EV Bridge Check (${amount})`]
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
  set(cells, 'H35', formula('=H33/H34', valueOutputFormat));
  set(cells, 'H37', formula('=Assumptions!$B$36', fmt(STYLE.formula, { numberFormat: NUM_FORMATS.perShare })));
  set(cells, 'H38', formula('=IF(H37>0,H35/H37-1,"")', totalPct));
  set(cells, 'H40', formula('=H33+H32-H31-H30', fmt(STYLE.check, { numberFormat: NUM_FORMATS.currency })));

  return [makeSetCellRangeAction('DCF', cells)];
}

function buildSensitivityActions(inputs = {}) {
  const cells = {};
  const money = fmt(STYLE.formula, { numberFormat: NUM_FORMATS.currency });
  const pct = fmt(STYLE.input, { numberFormat: NUM_FORMATS.percent });
  const perShare = fmt(STYLE.formula, { numberFormat: NUM_FORMATS.perShare });
  const valueStyle = inputs.privateOwnershipMode ? money : perShare;
  const valueLabel = inputs.privateOwnershipMode ? 'Equity Value Sensitivity' : 'Implied Share Price Sensitivity';

  set(cells, 'A1', cell('Sensitivity Analysis', STYLE.title));
  set(cells, 'A3', cell(valueLabel, STYLE.section));
  set(cells, 'B4', cell('WACC \\ g', STYLE.header));
  [0.015, 0.02, 0.025, 0.03, 0.035].forEach((growth, idx) => {
    set(cells, `${col(2 + idx)}4`, cell(growth, pct));
  });
  [0.08, 0.09, 0.10, 0.11, 0.12].forEach((wacc, rowIdx) => {
    const row = 5 + rowIdx;
    set(cells, `B${row}`, cell(wacc, pct));
    for (let idx = 0; idx < 5; idx++) {
      const c = col(2 + idx);
      set(cells, `${c}${row}`, formula(`=IFERROR(((SUM(DCF!$C$24:$G$24)+DCF!$G$20*(1+${c}$4)/($B${row}-${c}$4)/(1+$B${row})^5)+DCF!$H$31-DCF!$H$32)/DCF!$H$34,0)`, valueStyle));
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

function buildSourcesActions(inputs) {
  const cells = {};
  const money = fmt(STYLE.formula, { numberFormat: NUM_FORMATS.currency });
  const pct = fmt(STYLE.formula, { numberFormat: NUM_FORMATS.percent });
  const multiple = fmt(STYLE.formula, { numberFormat: NUM_FORMATS.multiple });
  const number = fmt(STYLE.formula, { numberFormat: NUM_FORMATS.number });
  const currency = inputs.currency || 'USD';
  const amount = amountLabel(inputs);
  const perShare = perShareLabel(inputs);
  const local = inputs.sourceType === 'workbook';
  const refs = inputs.sourceRefs || {};
  const historicalSource = local
    ? (inputs.aiSchemaUsed ? 'AI schema map of workbook local financial data' : 'Workbook local financial data')
    : 'External fundamentals / workbook fallback';
  const marketSource = local && inputs.isPrivateCompany ? 'Not in workbook; analyst fallback' : 'External market data / workbook fallback';
  const ownershipSource = inputs.privateOwnershipMode ? 'Private ownership basis; no public share count' : marketSource;

  set(cells, 'A1', cell(`${inputs.companyName} (${inputs.ticker}) - Source Book`, STYLE.title));
  set(cells, 'A3', cell('Model Scope', STYLE.section));
  set(cells, 'A4', cell('Company', STYLE.label));
  set(cells, 'B4', cell(inputs.companyName, STYLE.input));
  set(cells, 'A5', cell('Ticker', STYLE.label));
  set(cells, 'B5', cell(inputs.ticker, STYLE.input));
  set(cells, 'A6', cell('Valuation Date', STYLE.label));
  set(cells, 'B6', cell(new Date().toISOString().slice(0, 10), STYLE.input));
  set(cells, 'A7', cell('Units', STYLE.label));
  set(cells, 'B7', cell(inputs.unitLabel || currencyUnitLabel(currency), STYLE.input));

  set(cells, 'A10', cell('Source Register', STYLE.section));
  set(cells, 'A11', cell('Input Area', STYLE.header));
  set(cells, 'B11', cell('Primary Source', STYLE.header));
  set(cells, 'C11', cell('Workbook Cell', STYLE.header));
  set(cells, 'D11', cell('Status', STYLE.header));
  [
    ['Base Revenue', historicalSource, refs.Revenue || 'Assumptions!B10'],
    ['EBITDA Margin', local ? 'Workbook EBITDA / revenue' : 'External fundamentals / analyst fallback', refs.EBITDA || refs['EBITDA Margin'] || 'Assumptions!B11'],
    ['Cash & Debt', local ? 'Workbook balance sheet / net debt' : 'External balance-sheet fallback', refs['Cash & Equivalents'] || refs['Total Debt'] || refs['Net Debt'] || 'Assumptions!B33:B34'],
    [inputs.privateOwnershipMode ? 'Ownership / Market Reference' : 'Shares & Share Price', ownershipSource, refs['Shares Outstanding'] || refs['Share Price'] || 'Assumptions!B35:B36'],
    ['Beta', marketSource, 'Assumptions!B28'],
    ['WACC Assumptions', 'Market data + visible analyst assumptions', 'Assumptions!B26:B30'],
    ['Historical Growth Bridge', local ? 'Workbook revenue series + AI/validated period mapping' : 'Market/fallback growth curve', 'Assumptions!A40:D54'],
    ['Terminal Growth', 'Long-term GDP / inflation sanity range', 'Assumptions!B23']
  ].forEach(([label, source, ref], index) => {
    const row = 12 + index;
    set(cells, `A${row}`, cell(label, STYLE.label));
    set(cells, `B${row}`, cell(source, STYLE.label));
    set(cells, `C${row}`, cell(ref, STYLE.check));
    set(cells, `D${row}`, cell(Object.values(refs).includes(ref) ? 'Local' : 'Review', STYLE.check));
  });

  set(cells, 'A22', cell('Key Data Extract', STYLE.section));
  set(cells, 'A23', cell('Metric', STYLE.header));
  set(cells, 'B23', cell('Value', STYLE.header));
  set(cells, 'C23', cell('Used In', STYLE.header));
  const extracts = [
    [`Revenue (${amount})`, '=Assumptions!$B$10', 'DCF revenue build', money],
    ['EBITDA Margin (%)', '=Assumptions!$B$11', 'DCF operating build', pct],
    ['Tax Rate (%)', '=Assumptions!$B$12', 'NOPAT', pct],
    ['Beta', '=Assumptions!$B$28', 'CAPM', multiple],
    [`Cash (${amount})`, '=Assumptions!$B$33', 'Equity bridge', money],
    [`${inputs.debtIsNetDebt ? 'Net Debt' : 'Debt'} (${amount})`, '=Assumptions!$B$34', 'Equity bridge', money],
    [inputs.privateOwnershipMode ? 'Ownership Units' : 'Shares (M)', '=Assumptions!$B$35', inputs.privateOwnershipMode ? '100% equity value basis' : 'Per-share value', number],
    [inputs.privateOwnershipMode ? `Reference Share Price (${perShare})` : `Current Share Price (${perShare})`, '=Assumptions!$B$36', inputs.privateOwnershipMode ? 'Optional market reference' : 'Upside/downside', fmt(STYLE.formula, { numberFormat: NUM_FORMATS.perShare })]
  ];
  extracts.forEach(([label, valueFormula, usedIn, style], index) => {
    const row = 24 + index;
    set(cells, `A${row}`, cell(label, STYLE.label));
    set(cells, `B${row}`, formula(valueFormula, style));
    set(cells, `C${row}`, cell(usedIn, STYLE.label));
  });

  set(cells, 'A35', cell('Data Quality Checklist', STYLE.section));
  set(cells, 'A36', cell('Check', STYLE.header));
  set(cells, 'B36', cell('Result', STYLE.header));
  set(cells, 'C36', cell('Action', STYLE.header));
  const checks = [
    ['Revenue available', '=IF(Assumptions!$B$10>0,"OK","Review")', 'Confirm latest annual revenue'],
    [inputs.privateOwnershipMode ? 'Private ownership basis' : 'Shares available', inputs.privateOwnershipMode ? '=IF(Assumptions!$B$35=1,"OK","Review")' : '=IF(Assumptions!$B$35>0,"OK","Review")', inputs.privateOwnershipMode ? 'Do not invent public share count for private company' : 'Confirm diluted shares'],
    ['Cash / revenue sane', '=IF(Assumptions!$B$33/Assumptions!$B$10<2,"OK","Review")', 'Reject line-item cash mistaken for full balance-sheet bridge'],
    ['WACC sane', '=IF(AND(WACC!$B$19>0.05,WACC!$B$19<0.20),"OK","Review")', 'Review capital costs'],
    ['Terminal spread positive', '=IF(WACC!$B$19>Assumptions!$B$23,"OK","Review")', 'WACC must exceed terminal growth']
  ];
  checks.forEach(([label, resultFormula, action], index) => {
    const row = 37 + index;
    set(cells, `A${row}`, cell(label, STYLE.label));
    set(cells, `B${row}`, formula(resultFormula, STYLE.check));
    set(cells, `C${row}`, cell(action, STYLE.label));
  });

  set(cells, 'A43', cell('Analyst Depth Workplan', STYLE.section));
  set(cells, 'A44', cell('Area', STYLE.header));
  set(cells, 'B44', cell('Method', STYLE.header));
  set(cells, 'C44', cell('Required Analysis', STYLE.header));
  set(cells, 'D44', cell('Visible Output', STYLE.header));
  getDcfModelAnalystWorkplan().slice(1, 7).forEach((depth, index) => {
    const row = 45 + index;
    set(cells, `A${row}`, cell(depth.section, STYLE.label));
    set(cells, `B${row}`, cell(depth.method, STYLE.label));
    set(cells, `C${row}`, cell(depth.requiredAnalyses.slice(0, 2).join(' | '), STYLE.label));
    set(cells, `D${row}`, cell(depth.visibleOutputs.join(' | '), STYLE.check));
  });

  return [makeSetCellRangeAction('Sources', cells)];
}

function buildScenariosActions(inputs = {}) {
  const cells = {};
  const pctInput = fmt(STYLE.input, { numberFormat: NUM_FORMATS.percent });
  const pctFormula = fmt(STYLE.formula, { numberFormat: NUM_FORMATS.percent });
  const perShare = fmt(STYLE.formula, { numberFormat: NUM_FORMATS.perShare });
  const money = fmt(STYLE.formula, { numberFormat: NUM_FORMATS.currency });
  const amount = amountLabel(inputs);
  const perShareCurrency = perShareLabel(inputs);
  const valueStyle = inputs.privateOwnershipMode ? money : perShare;
  const valueLabel = inputs.privateOwnershipMode ? `Equity Value / 100% Ownership (${amount})` : `Implied Share Price (${perShareCurrency})`;
  const referenceLabel = inputs.privateOwnershipMode ? 'Upside / Downside vs Reference' : 'Upside / Downside';

  set(cells, 'A1', cell('Scenario Analysis', STYLE.title));
  set(cells, 'A3', cell('Operating Case Matrix', STYLE.section));
  ['Scenario', 'Revenue Haircut / Uplift', 'EBITDA Margin Delta', 'WACC', 'Terminal Growth', valueLabel, referenceLabel].forEach((label, index) => {
    set(cells, `${col(index)}4`, cell(label, STYLE.header));
  });

  const rows = [
    ['Downside', -0.10, -0.03, 0.11, 0.015],
    ['Base', 0.00, 0.00, 0.10, 0.025],
    ['Upside', 0.10, 0.03, 0.09, 0.035]
  ];
  rows.forEach(([name, revenueAdj, marginAdj, wacc, growth], index) => {
    const row = 5 + index;
    set(cells, `A${row}`, cell(name, STYLE.label));
    set(cells, `B${row}`, cell(revenueAdj, pctInput));
    set(cells, `C${row}`, cell(marginAdj, pctInput));
    set(cells, `D${row}`, cell(wacc, pctInput));
    set(cells, `E${row}`, cell(growth, pctInput));
    set(cells, `F${row}`, formula(`=IFERROR(((SUM(DCF!$C$24:$G$24)*(1+B${row})+DCF!$G$20*(1+C${row})*(1+E${row})/(D${row}-E${row})/(1+D${row})^5)+DCF!$H$31-DCF!$H$32)/DCF!$H$34,0)`, valueStyle));
    set(cells, `G${row}`, formula(`=IF(DCF!$H$37>0,F${row}/DCF!$H$37-1,"")`, pctFormula));
  });

  set(cells, 'A11', cell('Valuation Bridge by Case', STYLE.section));
  ['Metric', 'Downside', 'Base', 'Upside'].forEach((label, index) => {
    set(cells, `${col(index)}12`, cell(label, STYLE.header));
  });
  const bridgeRows = [
    [`Enterprise Value (${amount})`, '=IFERROR(SUM(DCF!$C$24:$G$24)*(1+B5)+DCF!$G$20*(1+C5)*(1+E5)/(D5-E5)/(1+D5)^5,0)', '=DCF!$H$30', '=IFERROR(SUM(DCF!$C$24:$G$24)*(1+B7)+DCF!$G$20*(1+C7)*(1+E7)/(D7-E7)/(1+D7)^5,0)'],
    [`Equity Value (${amount})`, '=B13+DCF!$H$31-DCF!$H$32', '=DCF!$H$33', '=D13+DCF!$H$31-DCF!$H$32'],
    [valueLabel, '=B14/DCF!$H$34', '=DCF!$H$35', '=D14/DCF!$H$34'],
    [inputs.privateOwnershipMode ? `Reference Share Price (${perShareCurrency})` : `Current Share Price (${perShareCurrency})`, '=DCF!$H$37', '=DCF!$H$37', '=DCF!$H$37'],
    [inputs.privateOwnershipMode ? 'Premium / (Discount) vs Reference (%)' : 'Premium / (Discount) (%)', '=IF(B16>0,B15/B16-1,"")', '=IF(C16>0,C15/C16-1,"")', '=IF(D16>0,D15/D16-1,"")']
  ];
  bridgeRows.forEach(([label, downside, base, upside], index) => {
    const row = 13 + index;
    set(cells, `A${row}`, cell(label, STYLE.label));
    const style = row <= 14 ? money : (row === 15 ? valueStyle : (row === 16 ? fmt(STYLE.formula, { numberFormat: NUM_FORMATS.perShare }) : pctFormula));
    set(cells, `B${row}`, formula(downside, style));
    set(cells, `C${row}`, formula(base, style));
    set(cells, `D${row}`, formula(upside, style));
  });

  return [makeSetCellRangeAction('Scenarios', cells)];
}

function buildSummaryActions(inputs) {
  const cells = {};
  const money = fmt(STYLE.formula, { numberFormat: NUM_FORMATS.currency });
  const pct = fmt(STYLE.formula, { numberFormat: NUM_FORMATS.percent });
  const perShare = fmt(STYLE.formula, { numberFormat: NUM_FORMATS.perShare });
  const amount = amountLabel(inputs);
  const perShareCurrency = perShareLabel(inputs);
  const valueStyle = inputs.privateOwnershipMode ? money : perShare;
  const valueLabel = inputs.privateOwnershipMode ? `Equity Value / 100% Ownership (${amount})` : `Implied Share Price (${perShareCurrency})`;
  const referenceLabel = inputs.privateOwnershipMode ? `Reference Share Price (${perShareCurrency})` : `Current Share Price (${perShareCurrency})`;

  set(cells, 'A1', cell(`${inputs.companyName} (${inputs.ticker}) - Valuation Summary`, STYLE.title));
  set(cells, 'A3', cell('Executive Valuation Output', STYLE.section));
  set(cells, 'A4', cell('Metric', STYLE.header));
  set(cells, 'B4', cell('Value', STYLE.header));
  set(cells, 'C4', cell('Source', STYLE.header));
  const outputs = [
    [`Enterprise Value (${amount})`, '=DCF!$H$30', 'DCF!H30', money],
    [`Equity Value (${amount})`, '=DCF!$H$33', 'DCF!H33', money],
    [valueLabel, '=DCF!$H$35', 'DCF!H35', valueStyle],
    [referenceLabel, '=DCF!$H$37', 'DCF!H37', perShare],
    [inputs.privateOwnershipMode ? 'Premium / (Discount) vs Reference (%)' : 'Premium / (Discount) (%)', '=DCF!$H$38', 'DCF!H38', pct],
    ['WACC (%)', '=WACC!$B$19', 'WACC!B19', pct],
    ['Terminal Growth (%)', '=Assumptions!$B$23', 'Assumptions!B23', pct]
  ];
  outputs.forEach(([label, valueFormula, source, style], index) => {
    const row = 5 + index;
    set(cells, `A${row}`, cell(label, row === 7 ? STYLE.total : STYLE.label));
    set(cells, `B${row}`, formula(valueFormula, row === 7
      ? fmt(STYLE.total, { numberFormat: inputs.privateOwnershipMode ? NUM_FORMATS.currency : NUM_FORMATS.perShare })
      : style));
    set(cells, `C${row}`, cell(source, STYLE.check));
  });

  set(cells, 'A15', cell('Scenario Snapshot', STYLE.section));
  ['Scenario', valueLabel, inputs.privateOwnershipMode ? 'Upside / Downside vs Reference' : 'Upside / Downside'].forEach((label, index) => {
    set(cells, `${col(index)}16`, cell(label, STYLE.header));
  });
  ['Downside', 'Base', 'Upside'].forEach((label, index) => {
    const row = 17 + index;
    const scenarioRow = 5 + index;
    set(cells, `A${row}`, cell(label, STYLE.label));
    set(cells, `B${row}`, formula(`=Scenarios!$F$${scenarioRow}`, valueStyle));
    set(cells, `C${row}`, formula(`=Scenarios!$G$${scenarioRow}`, pct));
  });

  set(cells, 'A23', cell('Key Operating Assumptions', STYLE.section));
  set(cells, 'A24', cell('Driver', STYLE.header));
  set(cells, 'B24', cell('Base Case', STYLE.header));
  set(cells, 'C24', cell('Model Link', STYLE.header));
  const assumptions = [
    [`Base Revenue (${amount})`, '=Assumptions!$B$10', 'Assumptions!B10', money],
    ['EBITDA Margin (%)', '=Assumptions!$B$11', 'Assumptions!B11', pct],
    ['Tax Rate (%)', '=Assumptions!$B$12', 'Assumptions!B12', pct],
    ['CapEx % Revenue (%)', '=Assumptions!$B$14', 'Assumptions!B14', pct],
    [inputs.privateOwnershipMode ? 'Ownership Units (100%=1.0)' : 'Shares Outstanding (M)', '=Assumptions!$B$35', 'Assumptions!B35', fmt(STYLE.formula, { numberFormat: NUM_FORMATS.shares })]
  ];
  assumptions.forEach(([label, valueFormula, source, style], index) => {
    const row = 25 + index;
    set(cells, `A${row}`, cell(label, STYLE.label));
    set(cells, `B${row}`, formula(valueFormula, style));
    set(cells, `C${row}`, cell(source, STYLE.check));
  });

  return [makeSetCellRangeAction('Summary', cells)];
}

function buildAuditActions(inputs = {}) {
  const cells = {};

  set(cells, 'A1', cell('Model Audit & QA', STYLE.title));
  set(cells, 'A3', cell('Readiness Checks', STYLE.section));
  set(cells, 'A4', cell('Check', STYLE.header));
  set(cells, 'B4', cell('Result', STYLE.header));
  set(cells, 'C4', cell('Why It Matters', STYLE.header));
  const checks = [
    ['Assumptions populated', '=IF(COUNTA(Assumptions!$A$1:$D$54)>=110,"OK","Review")', 'DCF needs a complete assumption spine with visible method, source and historical growth bridge'],
    ['WACC calculated', '=IF(AND(WACC!$B$19>0,WACC!$B$19<0.30),"OK","Review")', 'Valuation cannot discount cash flows without WACC'],
    ['Terminal spread positive', '=IF(WACC!$B$19>Assumptions!$B$23,"OK","Review")', 'Terminal value breaks if WACC is below growth'],
    ['Enterprise value positive', '=IF(DCF!$H$30>0,"OK","Review")', 'DCF output should produce positive enterprise value'],
    [inputs.privateOwnershipMode ? 'Private ownership basis' : 'Share count positive', inputs.privateOwnershipMode ? '=IF(DCF!$H$34=1,"OK","Review")' : '=IF(DCF!$H$34>0,"OK","Review")', inputs.privateOwnershipMode ? 'Private valuation should show 100% equity basis rather than fake per-share output' : 'Per-share value needs diluted shares'],
    ['Cash / revenue sanity', '=IF(Assumptions!$B$33/Assumptions!$B$10<2,"OK","Review")', 'Cash bridge must not dwarf operating scale unless explicitly supported'],
    ['Market input support', '=IF(COUNTIF(Assumptions!$D$26:$D$30,"Review*")=0,"OK","Review")', 'WACC inputs need market/peer support before presentation'],
    ['Bridge check clean', '=IF(ABS(DCF!$H$40)<1,"OK","Review")', 'EV to equity bridge should tie'],
    ['Sensitivity grid populated', '=IF(COUNTA(Sensitivity!$C$5:$G$9)>=25,"OK","Review")', 'Investment committee needs range, not point estimate'],
    ['Scenario cases populated', '=IF(COUNTA(Scenarios!$F$5:$G$7)>=6,"OK","Review")', 'Downside/base/upside cases should be visible']
  ];
  checks.forEach(([label, resultFormula, why], index) => {
    const row = 5 + index;
    set(cells, `A${row}`, cell(label, STYLE.label));
    set(cells, `B${row}`, formula(resultFormula, STYLE.check));
    set(cells, `C${row}`, cell(why, STYLE.label));
  });

  set(cells, 'A16', cell('Overall Status', STYLE.section));
  set(cells, 'A17', cell('Model Status', STYLE.total));
  set(cells, 'B17', formula('=IF(COUNTIF($B$5:$B$14,"Review")=0,"Ready for analyst review","Needs analyst review")', STYLE.total));
  set(cells, 'A19', cell('Recommended Next Analyst Steps', STYLE.section));
  [
    'Validate latest fiscal-year statements against the company filing.',
    'Replace fallback assumptions with management guidance or consensus where available.',
    'Add segment-level revenue build if the workbook has segment data.',
    'Cross-check implied valuation against public comps before presenting.'
  ].forEach((text, index) => {
    set(cells, `A${20 + index}`, cell(`${index + 1}. ${text}`, STYLE.label));
  });

  set(cells, 'A26', cell('Depth Coverage Checks', STYLE.section));
  set(cells, 'A27', cell('Area', STYLE.header));
  set(cells, 'B27', cell('Result', STYLE.header));
  set(cells, 'C27', cell('Analyst Standard', STYLE.header));
  [
    ['Sources', '=IF(COUNTA(Sources!$A$11:$D$50)>=35,"OK","Review")', 'Source register plus analyst workplan must be populated'],
    ['Assumptions', '=IF(COUNTA(Assumptions!$A$1:$D$54)>=110,"OK","Review")', 'Input spine must cover operating, WACC, equity bridge and historical growth drivers with method/source'],
    ['WACC', '=IF(COUNTA(WACC!$A$21:$B$30)>=18,"OK","Review")', 'Discount rate must include beta evidence and cross-checks'],
    ['DCF', '=IF(COUNTA(DCF!$A$5:$H$40)>=120,"OK","Review")', 'Operating forecast, FCF, terminal value and bridge must be explicit'],
    ['Sensitivity / Scenarios', '=IF(AND(COUNTA(Sensitivity!$C$5:$G$18)>=50,COUNTA(Scenarios!$F$5:$G$7)>=6),"OK","Review")', 'Valuation must show range of outcomes']
  ].forEach(([area, resultFormula, standard], index) => {
    const row = 28 + index;
    set(cells, `A${row}`, cell(area, STYLE.label));
    set(cells, `B${row}`, formula(resultFormula, STYLE.check));
    set(cells, `C${row}`, cell(standard, STYLE.label));
  });

  return [makeSetCellRangeAction('Audit', cells)];
}

function buildFormatActions() {
  const ranges = [
    ['Summary', 'A1:C32', { horizontalAlignment: 'Left' }],
    ['Sources', 'A1:D50', { horizontalAlignment: 'Left' }],
    ['Assumptions', 'A1:D56', { horizontalAlignment: 'Left' }],
    ['WACC', 'A1:A30', { horizontalAlignment: 'Left' }],
    ['DCF', 'A1:A40', { horizontalAlignment: 'Left' }],
    ['Sensitivity', 'A1:A18', { horizontalAlignment: 'Left' }],
    ['Scenarios', 'A1:G18', { horizontalAlignment: 'Left' }],
    ['Audit', 'A1:C32', { horizontalAlignment: 'Left' }],
    ['Summary', 'B1:C32', { horizontalAlignment: 'Right' }],
    ['Sources', 'B1:D50', { horizontalAlignment: 'Right' }],
    ['Assumptions', 'B1:B56', { horizontalAlignment: 'Right' }],
    ['Assumptions', 'C1:D56', { horizontalAlignment: 'Left', wrapText: true }],
    ['WACC', 'B1:B30', { horizontalAlignment: 'Right' }],
    ['DCF', 'B1:H40', { horizontalAlignment: 'Right' }],
    ['Sensitivity', 'B1:G18', { horizontalAlignment: 'Right' }],
    ['Scenarios', 'B1:G18', { horizontalAlignment: 'Right' }],
    ['Audit', 'B1:C32', { horizontalAlignment: 'Right' }],
    ['Summary', 'A1:C1', STYLE.title],
    ['Sources', 'A1:D1', STYLE.title],
    ['Assumptions', 'A1:D1', STYLE.title],
    ['WACC', 'A1:B1', STYLE.title],
    ['DCF', 'A1:H1', STYLE.title],
    ['Sensitivity', 'A1:G1', STYLE.title],
    ['Scenarios', 'A1:G1', STYLE.title],
    ['Audit', 'A1:C1', STYLE.title]
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
    case 'sources':
    case 'source':
    case 'research':
      actions = buildSourcesActions(inputs);
      break;
    case 'scenarios':
    case 'scenario':
      actions = buildScenariosActions(inputs);
      break;
    case 'summary':
    case 'output':
      actions = buildSummaryActions(inputs);
      break;
    case 'audit':
    case 'checks':
      actions = buildAuditActions(inputs);
      break;
    case 'format':
    case 'formatting':
      actions = buildFormatActions();
      break;
    case 'all':
      actions = [
        ...buildShellActions(inputs),
        ...buildSourcesActions(inputs),
        ...buildAssumptionsActions(inputs),
        ...buildWaccActions(inputs),
        ...buildDcfActions(inputs),
        ...buildSensitivityActions(inputs),
        ...buildScenariosActions(inputs),
        ...buildSummaryActions(inputs),
        ...buildAuditActions(inputs),
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
      analystDepth: getAnalystDepth(section === 'all' ? 'audit' : section),
      assumptions: {
        baseRevenueMillions: inputs.baseRevenueMillions,
        ebitdaMargin: inputs.ebitdaMargin,
        taxRate: inputs.taxRate,
        terminalGrowthRate: inputs.terminalGrowthRate,
        beta: inputs.beta,
        cashMillions: inputs.cashMillions,
        debtMillions: inputs.debtMillions,
        privateOwnershipMode: inputs.privateOwnershipMode
      },
      qualityFlags: [
        inputs.cashMillions > inputs.baseRevenueMillions * 2 ? 'cash_exceeds_2x_revenue' : null,
        inputs.privateOwnershipMode ? 'private_ownership_output' : null,
        inputs.aiSchemaUsed ? 'ai_workbook_schema' : null,
        inputs.sourceType === 'workbook' ? 'workbook_first' : null
      ].filter(Boolean)
    },
    actions
  };
}

module.exports = {
  buildDcfSection,
  inferDcfInputs
};
