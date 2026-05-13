const { callLLM, callLLMStreaming } = require('../tools/llm');
const { tools } = require('../tools/registry');
const logger = require('../utils/logger');
const streaming = require('./streaming');
const { analyzeWorkbookContext } = require('../utils/sheetParser');
const { inferEquityIntent } = require('../utils/equityIntent');

const PLANNER_TIMEOUT_MS = Number(process.env.PLANNER_TIMEOUT_MS) || 150000;
const PLANNER_FALLBACK_TIMEOUT_MS = Number(process.env.PLANNER_FALLBACK_TIMEOUT_MS) || 60000;
const PLANNER_MODEL = process.env.PLANNER_MODEL || process.env.OPENROUTER_PLANNER_MODEL || '';
const PLANNER_FALLBACK_MODEL = process.env.PLANNER_FALLBACK_MODEL || '';

const PLANNER_SYSTEM_PROMPT = `You are a Senior Investment Banking Associate at Goldman Sachs / JPMorgan.
Your task is to build institutional-grade financial models in Microsoft Excel.
Every model must be presentation-ready: structured, labeled, color-coded, and internally consistent.

OUTPUT FORMAT — respond ONLY with valid JSON. No markdown, no prose outside JSON.
Schema:
{
  "objective": "string",
  "tasks": [
    {
      "id": "t1",
      "agent": "data|layout|formula|format",
      "tool": "nome.tool",
      "description": "string",
      "params": { },
      "deps": ["t0"],
      "requiresApproval": false
    }
  ]
}

AGENTS:
- data: external financial data (Yahoo Finance, OpenBB) or workbook reads
- layout: sheet structure, cell maps, section design
- formula: Excel formulas (THE MOST CRITICAL — must reference cells, never hardcode)
- format: professional IB formatting (blue inputs, black calcs, grey headers)

TOOLS:
- data (equity): yahoo.quote, yahoo.historical, yahoo.fundamentals
- data (OpenBB): openbb.equity.quote, openbb.equity.historical, openbb.equity.profile, openbb.equity.fundamentals.balance, openbb.equity.fundamentals.income, openbb.equity.fundamentals.cash, openbb.equity.fundamentals.metrics, openbb.equity.fundamentals.ratios, openbb.equity.fundamentals.income_growth, openbb.equity.fundamentals.balance_growth, openbb.equity.fundamentals.cash_growth, openbb.equity.estimates.consensus, openbb.equity.peers, openbb.equity.performance, openbb.equity.fundamentals.management, openbb.equity.fundamentals.esg
- data (macro): openbb.fixedincome.treasury, openbb.fixedincome.yield_curve, openbb.fixedincome.effr, openbb.economy.cpi, openbb.economy.gdp_real, openbb.economy.unemployment, openbb.economy.interest_rates, openbb.economy.risk_premium, openbb.economy.money_measures, openbb.economy.gdp_forecast
- data (market): openbb.index.snapshots, openbb.index.historical, openbb.etf.info, openbb.etf.holdings, openbb.currency.historical, openbb.crypto.historical
- AI-assisted finance: finance.dcf.buildSection (sections: shell, assumptions, wacc, dcf, sensitivity, format, all; formula sections use an analyst LLM with deterministic fallback)
- read: workbook.readWorkbook, workbook.readSheet, workbook.readRange
- layout: llm.planLayout
- formula: llm.writeFormulas
- format: llm.planFormat, excel.applyFormat
- primitives: excel.createSheet, excel.setValues, excel.setFormulas, excel.addChart, excel.setConditionalFormat, workbook.writeRange
- sheet management: excel.renameSheet, excel.deleteSheet, excel.duplicateSheet
- cross-sheet: excel.copyRange, excel.createNamedRange, workbook.listNamedRanges
- interaction: requestUserInput (AVOID if possible)

OPENBB PREFERRED OVER YAHOO — OpenBB provides real financial statements (balance sheet, income statement, cash flow), treasury rates, economic data, analyst estimates, and ESG scores. Yahoo Finance is a fallback for quick quotes only. For any DCF/WACC/valuation model, ALWAYS use:
- openbb.equity.fundamentals.balance + income + cash for REAL financial data (not Yahoo estimates)
- openbb.fixedincome.treasury for the actual risk-free rate (not hardcoded 4%)
- openbb.economy.risk_premium for country-specific ERP
- openbb.equity.estimates.consensus for forward growth assumptions
- openbb.equity.peers for comparable company analysis

INSTITUTIONAL DCF MODEL STRUCTURE (minimum standard):
Sheets: Assumptions, WACC, DCF, Sensitivity

IMPORTANT: A natural request like "voglio fare un DCF di Apple", "fammi DCF AAPL", or "build DCF for Microsoft" means FULL DCF BUILD. Do not treat it as a repair task. Use the complete sequence: workbook scan, market data, DCF shell, assumptions, WACC, DCF projection, sensitivity, formatting.

1) Assumptions Sheet:
   - Section headers (grey background, white bold text)
   - Revenue drivers: Revenue, Revenue Growth %, EBITDA Margin %
   - Tax & Capital: Tax Rate %, D&A % of Revenue, CapEx % of Revenue, NWC % of Revenue
   - Terminal: Terminal Growth Rate %
   - Market data (if public): Beta, Risk-Free Rate, Market Risk Premium, Cost of Debt, Target D/E

2) WACC Sheet:
   - Cost of Equity (CAPM): =RiskFree + Beta*MarketRiskPremium
   - Cost of Debt (after-tax): =PreTaxCostOfDebt*(1-TaxRate)
   - WACC: =(E/(D+E))*CostOfEquity + (D/(D+E))*CostOfDebt*(1-TaxRate)

3) DCF Sheet (5-year projection minimum):
   - Column A: labels (Revenue, EBITDA, D&A, EBIT, Tax, NOPAT, D&A, CapEx, Change in NWC, Unlevered FCF)
   - Year columns: Year 1-5 + Terminal
   - Revenue = prior * (1+growth)
   - EBITDA = Revenue * margin
   - EBIT = EBITDA - D&A
   - Tax = EBIT * tax rate
   - NOPAT = EBIT - Tax
   - Unlevered FCF = NOPAT + D&A - CapEx - ChangeInNWC
   - Discount Factor = 1/(1+WACC)^year
   - PV of FCF = FCF * Discount Factor
   - Terminal Value = FCF_n * (1+g) / (WACC - g)
   - PV of TV = TV / (1+WACC)^n
   - Enterprise Value = SUM(PV of FCF) + PV of TV
   - Equity Value = EV + Cash - Total Debt
   - Implied Share Price = Equity Value / Shares Outstanding

4) Sensitivity Sheet:
   - 2-way data table: WACC × Terminal Growth
   - Shows Enterprise Value and Implied Share Price

CRITICAL RULES:
- EVERY data row MUST have a descriptive label in Column A. Never output naked numbers.
- Formulas must reference other sheets (e.g., =Assumptions!B3) — never hardcode constants.
- If the user already has financial data in the active sheet (EBITDA, Revenue, etc.), USE IT. Do NOT ask for input. The system automatically extracts known financial labels and values from the workbook.
- Only use requestUserInput if a critical assumption is truly missing and cannot be inferred.
- All monetary values in millions or billions with 1 decimal place.
- All percentages as decimals (e.g., 0.25 for 25%) formatted as 0.00%.

CHUNKING — for complex models, split formula tasks by section (parallel execution):
- assumptions.inputs, assumptions.macro
- wacc.cost_of_equity, wacc.wacc_calc
- dcf.revenue_build, dcf.ebitda_build, dcf.fcf_build, dcf.terminal_value, dcf.enterprise_value, dcf.equity_value
Each formula task depends ONLY on layout + createSheet, NEVER on other formula tasks.

PARALLELIZE wherever possible. Tasks on different sheets can run in parallel.

If the request depends on existing workbook content, use workbook.read* tools first.

EXAMPLE DCF task graph (chunked, institutional grade):
t1: data/workbook.readWorkbook (maxRows:30, maxCols:20)
t2: data/yahoo.quote (ticker:AAPL) [optional if public]
t3: data/yahoo.fundamentals (ticker:AAPL) [optional if public]
t4: layout/llm.planLayout (model:DCF, sheets:[Assumptions,WACC,DCF,Sensitivity], context from t1,t2,t3)
t5: excel.createSheet (name:Assumptions) deps:[t4]
t6: excel.createSheet (name:WACC) deps:[t4]
t7: excel.createSheet (name:DCF) deps:[t4]
t8: excel.createSheet (name:Sensitivity) deps:[t4]
t9:  formula/llm.writeFormulas (section:assumptions.inputs) deps:[t4,t5]
t10: formula/llm.writeFormulas (section:assumptions.macro) deps:[t4,t5]
t11: formula/llm.writeFormulas (section:wacc.cost_of_equity) deps:[t4,t6]
t12: formula/llm.writeFormulas (section:wacc.wacc_calc) deps:[t4,t6]
t13: formula/llm.writeFormulas (section:dcf.revenue_build) deps:[t4,t7]
t14: formula/llm.writeFormulas (section:dcf.ebitda_build) deps:[t4,t7]
t15: formula/llm.writeFormulas (section:dcf.fcf_build) deps:[t4,t7]
t16: formula/llm.writeFormulas (section:dcf.terminal_value) deps:[t4,t7]
t17: formula/llm.writeFormulas (section:dcf.enterprise_value) deps:[t4,t7]
t18: formula/llm.writeFormulas (section:dcf.equity_value) deps:[t4,t7]
t19: formula/llm.writeFormulas (section:sensitivity.data_table) deps:[t4,t8,t17]
t20: format/llm.planFormat (mode:institutional_finance) deps:[t9,t10,t11,t12,t13,t14,t15,t16,t17,t18,t19]
t21: excel.applyFormat (fromResult:t20) deps:[t20]

EXAMPLE for existing workbook:
t1: data/workbook.readSheet (sheet:ActiveSheet, includeUsedRange:true)
t2: layout/llm.planLayout (model:DCF, sheets:[Assumptions,WACC,DCF]) deps:[t1]
[...]

REMEMBER: Output ONLY valid JSON.`;

const KNOWN_TOOLS = new Set(Object.keys(tools));

function truncateMatrix(value, maxRows = 10, maxCols = 8) {
  if (!Array.isArray(value)) return value;
  return value
    .slice(0, maxRows)
    .map(row => (Array.isArray(row) ? row.slice(0, maxCols) : row));
}

function compactAllSheetsData(allSheetsData, activeSheet) {
  if (!allSheetsData || typeof allSheetsData !== 'object') return null;
  const compact = {};
  for (const [name, info] of Object.entries(allSheetsData)) {
    if (!info) continue;
    const isActive = info.isActive || name === activeSheet;
    const rows = isActive ? 14 : 8;
    const cols = isActive ? 10 : 6;
    compact[name] = {
      isActive: !!isActive,
      usedRange: info.usedRange || null,
      rowCount: info.rowCount || 0,
      columnCount: info.columnCount || 0,
      truncated: !!info.truncated,
      empty: !!info.empty,
      omitted: !!info.omitted,
      preview: truncateMatrix(info.preview, rows, cols),
      formulas: isActive ? truncateMatrix(info.formulas, rows, cols) : undefined
    };
  }
  return compact;
}

function compactPlanningContext(context) {
  if (!context || typeof context !== 'object') return {};

  const parsed = analyzeWorkbookContext(context);

  return {
    activeSheet: context.activeSheet,
    workbookSheets: Array.isArray(context.workbookSheets) ? context.workbookSheets.slice(0, 24) : [],
    sheetCount: context.sheetCount || (Array.isArray(context.workbookSheets) ? context.workbookSheets.length : 0),
    selectedRange: context.selectedRange,
    selectionSize: context.selectionSize || null,
    selectedRangeTruncated: !!context.selectedRangeTruncated,
    selectedPreview: truncateMatrix(context.selectedValues, 8, 6),
    selectedFormulasPreview: truncateMatrix(context.selectedFormulas, 6, 6),
    usedRange: context.usedRange || null,
    usedRangeSize: context.usedRangeSize || null,
    usedRangeTruncated: !!context.usedRangeTruncated,
    usedRangePreview: truncateMatrix(context.usedRangeData, 12, 8),
    allSheetsData: compactAllSheetsData(context.allSheetsData, context.activeSheet),
    conversationHistory: context.conversationHistory || '',
    recentSheets: Array.isArray(context.recentSheets) ? context.recentSheets : [],
    inferredData: {
      inputCount: parsed.inferredInputs.length,
      highConfidenceInputs: parsed.inferredInputs.filter(i => i.confidence === 'high').map(i => ({
        canonical: i.canonical,
        value: i.value,
        cell: i.cell,
        sheet: i.sheet
      })),
      perSheetUnits: parsed.sheets.map(s => ({ name: s.name, unit: s.unit })).filter(s => s.unit),
      summary: parsed.summary
    }
  };
}

function findSheetPreview(context, sheetName) {
  const sheets = context?.allSheetsData || {};
  const entry = Object.entries(sheets).find(([name]) => name.toLowerCase() === sheetName.toLowerCase());
  return Array.isArray(entry?.[1]?.preview) ? entry[1].preview : [];
}

function findLabelValue(preview, labels) {
  const wanted = labels.map(label => String(label).toLowerCase());
  for (const row of preview || []) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const label = String(row[0] || '').toLowerCase().trim();
    if (wanted.some(w => label === w || label.includes(w))) {
      const value = row[1];
      if (value !== '' && value !== null && value !== undefined) return value;
    }
  }
  return null;
}

function inferExistingDcfIdentity(context = {}) {
  const assumptions = findSheetPreview(context, 'Assumptions');
  const ticker = findLabelValue(assumptions, ['ticker', 'symbol']);
  const companyName = findLabelValue(assumptions, ['company', 'company name']);
  return {
    ticker: ticker ? String(ticker).trim().toUpperCase() : null,
    companyName: companyName ? String(companyName).trim() : null
  };
}

const planCache = new Map();
const PLAN_CACHE_TTL_MS = 10 * 60 * 1000;
const SEMANTIC_CACHE_TTL_MS = 5 * 60 * 1000;
const SEMANTIC_THRESHOLD = 0.65;

const STOP_WORDS = new Set([
  // Italian
  'il','la','lo','i','gli','le','un','uno','una',
  'di','a','da','in','con','su','per','tra','fra',
  'e','o','ma','che','chi','cui','non','piu','molto','tutto',
  'questo','questa','quello','quella','come','sono','ho','fa',
  // English
  'the','a','an','and','or','but','for','to','of','in','on',
  'at','by','with','from','as','is','are','was','were','be',
  'been','have','has','had','do','does','did','will','would',
  'could','should','may','might','can','this','that','these',
  'those','it','its','my','your','his','her','our','their'
]);

function tokenize(text) {
  const normalized = String(text).toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')   // keep letters & numbers only
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = normalized.split(' ')
    .filter(t => t.length >= 2)
    .filter(t => !STOP_WORDS.has(t));
  // Deduplicate while preserving rough frequency order
  const seen = new Set();
  const unique = [];
  for (const t of tokens) {
    if (!seen.has(t)) { seen.add(t); unique.push(t); }
  }
  return unique;
}

function jaccardSimilarity(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function getPlanCacheKey(objective, context) {
  const normalizedObjective = String(objective).toLowerCase()
    .replace(/[.,;:!?()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sheetsHash = (context?.workbookSheets || []).slice().sort().join(',');
  return `${normalizedObjective}::${sheetsHash}`;
}

function getSemanticCacheKey(tokens, context) {
  const sheetsHash = (context?.workbookSheets || []).slice().sort().join(',');
  return `${tokens.join('|')}::${sheetsHash}`;
}

function getCachedPlan(key, objectiveTokens = null) {
  // 1. Exact match
  const entry = planCache.get(key);
  if (entry) {
    const ttl = Date.now() - entry.timestamp <= PLAN_CACHE_TTL_MS;
    if (ttl) return entry.plan;
    planCache.delete(key);
  }

  // 2. Semantic fallback (approximate token overlap)
  if (objectiveTokens && objectiveTokens.length > 0) {
    let bestMatch = null;
    let bestScore = 0;
    const now = Date.now();
    for (const [cachedKey, cachedEntry] of planCache.entries()) {
      if (!cachedEntry.tokens || cachedEntry.tokens.length === 0) continue;
      // Only consider entries with same workbook sheets (exact key suffix match)
      if (!key.endsWith(cachedKey.split('::').pop())) continue;
      const age = now - cachedEntry.timestamp;
      if (age > SEMANTIC_CACHE_TTL_MS) continue;
      const score = jaccardSimilarity(objectiveTokens, cachedEntry.tokens);
      if (score >= SEMANTIC_THRESHOLD && score > bestScore) {
        bestScore = score;
        bestMatch = cachedEntry;
      }
    }
    if (bestMatch) {
      logger.info(`[Planner] Semantic cache hit (Jaccard=${bestScore.toFixed(2)})`);
      return bestMatch.plan;
    }
  }
  return null;
}

function setCachedPlan(key, plan, objectiveTokens = null) {
  planCache.set(key, { plan, timestamp: Date.now(), tokens: objectiveTokens });
}

// Periodic cleanup of expired entries (runs lazily on access)
function cleanupExpiredCache() {
  const now = Date.now();
  for (const [k, entry] of planCache.entries()) {
    if (now - entry.timestamp > PLAN_CACHE_TTL_MS) {
      planCache.delete(k);
    }
  }
}

function buildDeterministicDcfPlan(objective, context, equityIntent = {}) {
  const ticker = equityIntent.ticker || null;
  const companyName = equityIntent.companyName || ticker || 'Target Company';
  const dataDeps = ['t1'];
  const tasks = [
    {
      id: 't1',
      agent: 'data',
      tool: 'workbook.readWorkbook',
      description: 'Scan workbook for existing model/data context',
      params: { maxRows: 30, maxCols: 20 },
      deps: [],
      requiresApproval: false
    }
  ];

  let nextId = 2;
  if (ticker) {
    tasks.push({
      id: `t${nextId}`,
      agent: 'data',
      tool: 'yahoo.quote',
      description: `Fetch live quote and market data for ${ticker}`,
      params: { ticker },
      deps: [],
      requiresApproval: false
    });
    dataDeps.push(`t${nextId}`);
    nextId++;

    tasks.push({
      id: `t${nextId}`,
      agent: 'data',
      tool: 'yahoo.fundamentals',
      description: `Fetch financial fundamentals for ${ticker}`,
      params: { ticker },
      deps: [],
      requiresApproval: false
    });
    dataDeps.push(`t${nextId}`);
    nextId++;
  }

  const baseParams = {
    companyName,
    objective,
    projectionYears: 5,
    mode: 'ai_assisted',
    usesResults: dataDeps
  };
  if (ticker) baseParams.ticker = ticker;

  const sections = [
    { section: 'shell', agent: 'layout', description: 'Create DCF workbook shell: Assumptions, WACC, DCF, Sensitivity', deps: dataDeps },
    { section: 'assumptions', agent: 'formula', description: 'AI-build DCF assumptions from market data with auditable source notes', deps: [`t${nextId}`] },
    { section: 'wacc', agent: 'formula', description: 'AI-build WACC calculation from CAPM and capital structure', deps: [`t${nextId + 1}`] },
    { section: 'dcf', agent: 'formula', description: 'AI-build 5-year DCF projection, terminal value, EV and implied share price', deps: [`t${nextId + 2}`] },
    { section: 'sensitivity', agent: 'formula', description: 'AI-build WACC x terminal growth sensitivity tables', deps: [`t${nextId + 3}`] },
    { section: 'format', agent: 'format', description: 'Apply institutional finance formatting across DCF sheets', deps: [`t${nextId + 4}`] }
  ];

  for (const entry of sections) {
    tasks.push({
      id: `t${nextId}`,
      agent: entry.agent,
      tool: 'finance.dcf.buildSection',
      description: entry.description,
      params: { ...baseParams, section: entry.section },
      deps: entry.deps,
      requiresApproval: false
    });
    nextId++;
  }

  logger.info(`[Planner] AI-assisted DCF plan generated for ${ticker || companyName}`);
  return { objective, tasks };
}

function buildDcfCompletionPlan(objective, context, equityIntent = {}) {
  const ticker = equityIntent.ticker || null;
  const companyName = equityIntent.companyName || ticker || 'Target Company';
  const existingSheets = context?.workbookSheets || [];
  const hasAllDcfSheets = ['Assumptions', 'WACC', 'DCF', 'Sensitivity'].every(sheet =>
    existingSheets.some(existing => existing.toLowerCase() === sheet.toLowerCase())
  );

  const dataDeps = ['t1'];
  const tasks = [
    {
      id: 't1',
      agent: 'data',
      tool: 'workbook.readWorkbook',
      description: 'Read workbook before completing the DCF model',
      params: { maxRows: 45, maxCols: 12 },
      deps: [],
      requiresApproval: false
    }
  ];

  let nextId = 2;
  if (ticker) {
    tasks.push({
      id: `t${nextId}`,
      agent: 'data',
      tool: 'yahoo.quote',
      description: `Refresh live quote and market data for ${ticker}`,
      params: { ticker },
      deps: [],
      requiresApproval: false
    });
    dataDeps.push(`t${nextId}`);
    nextId++;

    tasks.push({
      id: `t${nextId}`,
      agent: 'data',
      tool: 'yahoo.fundamentals',
      description: `Refresh financial fundamentals for ${ticker}`,
      params: { ticker },
      deps: [],
      requiresApproval: false
    });
    dataDeps.push(`t${nextId}`);
    nextId++;
  }

  const baseParams = {
    companyName,
    objective,
    projectionYears: 5,
    mode: 'template',
    usesResults: dataDeps
  };
  if (ticker) baseParams.ticker = ticker;

  let previousDeps = dataDeps;
  if (!hasAllDcfSheets) {
    tasks.push({
      id: `t${nextId}`,
      agent: 'layout',
      tool: 'finance.dcf.buildSection',
      description: 'Ensure DCF workbook shell exists',
      params: { ...baseParams, section: 'shell' },
      deps: dataDeps,
      requiresApproval: false
    });
    previousDeps = [`t${nextId}`];
    nextId++;
  }

  const sections = [
    { section: 'assumptions', agent: 'formula', description: 'Complete Assumptions with all required DCF drivers' },
    { section: 'wacc', agent: 'formula', description: 'Complete WACC formulas from assumptions' },
    { section: 'dcf', agent: 'formula', description: 'Complete 5-year DCF projection and valuation bridge' },
    { section: 'sensitivity', agent: 'formula', description: 'Complete WACC x terminal growth sensitivity tables' },
    { section: 'format', agent: 'format', description: 'Re-apply institutional DCF formatting' }
  ];

  for (const entry of sections) {
    tasks.push({
      id: `t${nextId}`,
      agent: entry.agent,
      tool: 'finance.dcf.buildSection',
      description: entry.description,
      params: { ...baseParams, section: entry.section },
      deps: previousDeps,
      requiresApproval: false
    });
    previousDeps = [`t${nextId}`];
    nextId++;
  }

  logger.info(`[Planner] DCF completion/repair plan generated for ${ticker || companyName}`);
  return { objective, tasks };
}

function buildFinanceFallbackPlan(objective, context) {
  const lowerObjective = String(objective || '').toLowerCase();
  const workbookIdentity = inferExistingDcfIdentity(context);
  const baseIntent = inferEquityIntent(objective);
  const equityIntent = {
    ...baseIntent,
    ticker: baseIntent.ticker || workbookIdentity.ticker,
    companyName: baseIntent.companyName || workbookIdentity.companyName,
    isPublicCompanyTarget: baseIntent.isPublicCompanyTarget || !!workbookIdentity.ticker
  };
  const activeSheet = context?.activeSheet || 'DCF';
  const isModification = ['modifica', 'cambia', 'aggiorna', 'correggi', 'fix', 'change', 'update', 'adjust', 'edit', 'ricalcola', 'riformatta', 'sistema'].some(k => lowerObjective.includes(k));
  const wantsCompletion = ['completa', 'completo', 'complete', 'finish', 'finisci', 'problemi', 'problems', 'repair'].some(k => lowerObjective.includes(k));
  const wantsNewModel = equityIntent.hasBuildIntent || ['crea', 'costruisci', 'build', 'new', 'nuovo'].some(keyword => lowerObjective.includes(keyword));
  const isDcf = equityIntent.model === 'dcf' || lowerObjective.includes('dcf');
  const isFinanceModel = !!equityIntent.model || ['dcf', 'wacc', 'lbo', 'valuation', 'forecast', 'modello'].some(keyword => lowerObjective.includes(keyword));
  const isWacc = lowerObjective.includes('wacc') && !lowerObjective.includes('dcf');
  const isSensitivity = ['sensitivity', 'sensitività', 'scenario'].some(k => lowerObjective.includes(k));
  const isFormat = ['formatta', 'format', 'formatting', 'stile'].some(k => lowerObjective.includes(k));
  const isAddSheet = ['aggiungi foglio', 'add sheet', 'create sheet', 'nuovo foglio'].some(k => lowerObjective.includes(k));

  // Detect if an existing finance model is already present in the workbook
  const existingSheets = context?.workbookSheets || [];
  const hasDcfSheets = ['Assumptions', 'WACC', 'DCF', 'Sensitivity'].every(s =>
    existingSheets.some(es => es.toLowerCase() === s.toLowerCase())
  );
  const existingModelSheets = existingSheets.filter(s =>
    ['Assumptions', 'WACC', 'DCF', 'Sensitivity'].some(m => s.toLowerCase() === m.toLowerCase())
  );

  if (isDcf && existingModelSheets.length > 0 && (wantsCompletion || isModification)) {
    return buildDcfCompletionPlan(objective, context, equityIntent);
  }

  if (isDcf && wantsCompletion && existingModelSheets.length === 0) {
    return buildDeterministicDcfPlan(objective, context, equityIntent);
  }

  if (isWacc) {
    return {
      objective,
      tasks: [
        { id: 't1', agent: 'data', tool: 'workbook.readWorkbook', description: 'Leggi il workbook corrente', params: { maxRows: 12, maxCols: 8 }, deps: [], requiresApproval: false },
        { id: 't2', agent: 'layout', tool: 'llm.planLayout', description: 'Progetta layout WACC', params: { model: 'WACC', objective, sheets: ['WACC'] }, deps: ['t1'], requiresApproval: false },
        { id: 't3', agent: 'layout', tool: 'excel.createSheet', description: 'Crea foglio WACC', params: { name: 'WACC' }, deps: ['t2'], requiresApproval: false },
        { id: 't4', agent: 'formula', tool: 'llm.writeFormulas', description: 'Genera formule WACC', params: { sheet: 'WACC', objective, mode: 'build_finance_model', section: 'wacc' }, deps: ['t2', 't3'], requiresApproval: false }
      ]
    };
  }

  if (isSensitivity) {
    return {
      objective,
      tasks: [
        { id: 't1', agent: 'data', tool: 'workbook.readWorkbook', description: 'Leggi il workbook corrente', params: { maxRows: 12, maxCols: 8 }, deps: [], requiresApproval: false },
        { id: 't2', agent: 'data', tool: 'workbook.readSheet', description: `Leggi foglio attivo ${activeSheet}`, params: { sheet: activeSheet, maxRows: 30, maxCols: 12 }, deps: ['t1'], requiresApproval: false },
        { id: 't3', agent: 'formula', tool: 'llm.writeFormulas', description: 'Costruisci data table sensitività', params: { sheet: activeSheet, objective, mode: 'sensitivity_analysis' }, deps: ['t2'], requiresApproval: false }
      ]
    };
  }

  if (isFormat) {
    return {
      objective,
      tasks: [
        { id: 't1', agent: 'data', tool: 'workbook.readWorkbook', description: 'Leggi il workbook corrente', params: { maxRows: 12, maxCols: 8 }, deps: [], requiresApproval: false },
        { id: 't2', agent: 'format', tool: 'llm.planFormat', description: 'Prepara formattazione professionale', params: { sheet: activeSheet, objective, mode: 'finance_cleanup' }, deps: ['t1'], requiresApproval: false },
        { id: 't3', agent: 'format', tool: 'excel.applyFormat', description: 'Applica formattazione', params: { fromResult: 't2', sheet: activeSheet }, deps: ['t2'], requiresApproval: false }
      ]
    };
  }

  // INCREMENTAL MODIFICATION: if user asks to modify an existing model
  if (isModification && hasDcfSheets) {
    logger.info('[Planner] Existing DCF model detected + modification keyword → incremental plan');
    const tasks = [
      {
        id: 't1',
        agent: 'data',
        tool: 'workbook.readWorkbook',
        description: 'Leggi lo stato attuale del workbook per modifiche incrementali',
        params: { maxRows: 30, maxCols: 20 },
        deps: [],
        requiresApproval: false
      },
      {
        id: 't2',
        agent: 'data',
        tool: 'workbook.readSheet',
        description: 'Leggi foglio attivo per contesto',
        params: { sheet: activeSheet, maxRows: 30, maxCols: 12 },
        deps: ['t1'],
        requiresApproval: false
      }
    ];
    let nextId = 3;
    const deps = ['t2'];

    // If formatting-related modification, only run format agent
    if (['formatta', 'format', 'stile', 'colore', 'color', 'riformatta'].some(k => lowerObjective.includes(k))) {
      tasks.push({
        id: `t${nextId}`,
        agent: 'format',
        tool: 'llm.planFormat',
        description: `Aggiorna formattazione: ${objective}`,
        params: { sheet: activeSheet, objective, mode: 'finance_cleanup' },
        deps: ['t2'],
        requiresApproval: false
      });
      tasks.push({
        id: `t${nextId + 1}`,
        agent: 'format',
        tool: 'excel.applyFormat',
        description: 'Applica formattazione aggiornata',
        params: { fromResult: `t${nextId}`, sheet: activeSheet },
        deps: [`t${nextId}`],
        requiresApproval: false
      });
    } else {
      // Generic modification: read workbook, let LLM decide what to change
      tasks.push({
        id: `t${nextId}`,
        agent: 'formula',
        tool: 'llm.writeFormulas',
        description: `Modifica modello esistente: ${objective}`,
        params: { sheet: activeSheet, objective, mode: 'repair_existing_model', section: 'full_model_review' },
        deps: ['t2'],
        requiresApproval: false
      });
      tasks.push({
        id: `t${nextId + 1}`,
        agent: 'format',
        tool: 'llm.planFormat',
        description: 'Mantieni/pulisci formattazione dopo modifica',
        params: { sheet: activeSheet, objective, mode: 'finance_cleanup' },
        deps: [`t${nextId}`],
        requiresApproval: false
      });
      tasks.push({
        id: `t${nextId + 2}`,
        agent: 'format',
        tool: 'excel.applyFormat',
        description: 'Applica formattazione',
        params: { fromResult: `t${nextId + 1}`, sheet: activeSheet },
        deps: [`t${nextId + 1}`],
        requiresApproval: false
      });
    }
    return { objective, tasks };
  }

  if (isAddSheet) {
    const sheetMatch = lowerObjective.match(/(?:foglio|sheet)\s+["']?([^"']+)["']?/);
    const sheetName = sheetMatch ? sheetMatch[1].trim() : 'NuovoFoglio';
    return {
      objective,
      tasks: [
        { id: 't1', agent: 'data', tool: 'workbook.readWorkbook', description: 'Leggi il workbook corrente', params: { maxRows: 12, maxCols: 8 }, deps: [], requiresApproval: false },
        { id: 't2', agent: 'layout', tool: 'excel.createSheet', description: `Crea foglio ${sheetName}`, params: { name: sheetName }, deps: ['t1'], requiresApproval: false }
      ]
    };
  }

  if (!isFinanceModel) return null;

  const shouldBuildFullDcf = isDcf && !isModification && (
    wantsNewModel ||
    wantsCompletion ||
    equityIntent.isPublicCompanyTarget ||
    lowerObjective.includes('full') ||
    lowerObjective.includes('completo')
  );

  if (shouldBuildFullDcf) {
    return buildDeterministicDcfPlan(objective, context, equityIntent);
  }

  if (wantsNewModel) {
    const desiredSheets = ['Assumptions', 'WACC', 'DCF', 'Sensitivity'];
    // Skip sheets that already exist (case-insensitive match)
    const sheetsToCreate = desiredSheets.filter(s =>
      !existingSheets.some(es => es.toLowerCase() === s.toLowerCase())
    );
    const existingModelMsg = existingModelSheets.length > 0
      ? ` (esistenti: ${existingModelSheets.join(', ')})`
      : '';
    logger.info(`[Planner] New model requested. Sheets to create: ${sheetsToCreate.join(', ') || 'none'}${existingModelMsg}`);

    const tasks = [
      {
        id: 't1',
        agent: 'data',
        tool: 'workbook.readWorkbook',
        description: 'Read current workbook for existing data',
        params: { maxRows: 30, maxCols: 20 },
        deps: [],
        requiresApproval: false
      },
      {
        id: 't2',
        agent: 'layout',
        tool: 'llm.planLayout',
        description: 'Design institutional-grade DCF layout',
        params: { model: 'DCF', objective, sheets: desiredSheets, existingSheets: existingModelSheets },
        deps: ['t1'],
        requiresApproval: false
      }
    ];

    // Create only missing sheets
    let sheetTaskIds = {};
    let nextId = 3;
    for (const sheetName of desiredSheets) {
      const existing = existingSheets.some(es => es.toLowerCase() === sheetName.toLowerCase());
      if (existing) {
        // Sheet already exists: add a read task instead of create
        tasks.push({
          id: `t${nextId}`,
          agent: 'data',
          tool: 'workbook.readSheet',
          description: `Read existing ${sheetName} sheet`,
          params: { sheet: sheetName, maxRows: 30, maxCols: 12 },
          deps: ['t2'],
          requiresApproval: false
        });
      } else {
        tasks.push({
          id: `t${nextId}`,
          agent: 'layout',
          tool: 'excel.createSheet',
          description: `Create ${sheetName} sheet`,
          params: { name: sheetName },
          deps: ['t2'],
          requiresApproval: false
        });
      }
      sheetTaskIds[sheetName.toLowerCase()] = `t${nextId}`;
      nextId++;
    }

    // Dynamic formula sections using sheetTaskIds to avoid duplicating existing sheets
    const formulaSections = [
      { sheet: 'Assumptions', section: 'assumptions.inputs', desc: 'Assumptions — revenue, margin, tax, capex drivers' },
      { sheet: 'Assumptions', section: 'assumptions.macro', desc: 'Assumptions — macro & terminal assumptions' },
      { sheet: 'WACC', section: 'wacc.cost_of_equity', desc: 'WACC — Cost of Equity (CAPM)' },
      { sheet: 'WACC', section: 'wacc.wacc_calc', desc: 'WACC — WACC calculation' },
      { sheet: 'DCF', section: 'dcf.revenue_build', desc: 'DCF — Revenue build (5-year)' },
      { sheet: 'DCF', section: 'dcf.ebitda_build', desc: 'DCF — EBITDA build' },
      { sheet: 'DCF', section: 'dcf.fcf_build', desc: 'DCF — Unlevered FCF build' },
      { sheet: 'DCF', section: 'dcf.terminal_value', desc: 'DCF — Terminal Value (Gordon Growth)' },
      { sheet: 'DCF', section: 'dcf.enterprise_value', desc: 'DCF — Enterprise Value & PV of FCFs' },
      { sheet: 'DCF', section: 'dcf.equity_value', desc: 'DCF — Equity Value & Implied Share Price' },
      { sheet: 'Sensitivity', section: 'sensitivity.data_table', desc: 'Sensitivity — 2-way data table (WACC × Terminal Growth)' }
    ];

    const formulaDeps = [];
    for (const fs of formulaSections) {
      const sheetDep = sheetTaskIds[fs.sheet.toLowerCase()];
      if (!sheetDep) {
        logger.warn(`[Planner] No task ID for sheet ${fs.sheet}, skipping formula section ${fs.section}`);
        continue;
      }
      const taskId = `t${nextId}`;
      tasks.push({
        id: taskId,
        agent: 'formula',
        tool: 'llm.writeFormulas',
        description: fs.desc,
        params: { sheet: fs.sheet, objective, mode: 'build_finance_model', section: fs.section, usesResults: ['t2'] },
        deps: ['t2', sheetDep],
        requiresApproval: false
      });
      formulaDeps.push(taskId);
      nextId++;
    }

    // Format task depends on all formula tasks
    if (formulaDeps.length > 0) {
      const formatPlanId = `t${nextId}`;
      tasks.push({
        id: formatPlanId,
        agent: 'format',
        tool: 'llm.planFormat',
        description: 'Apply institutional IB formatting',
        params: { sheet: 'DCF', objective, mode: 'institutional_finance' },
        deps: formulaDeps,
        requiresApproval: false
      });
      nextId++;
      tasks.push({
        id: `t${nextId}`,
        agent: 'format',
        tool: 'excel.applyFormat',
        description: 'Apply formatting to all sheets',
        params: { fromResult: formatPlanId, sheet: 'DCF' },
        deps: [formatPlanId],
        requiresApproval: false
      });
    }

    return { objective, tasks };
  }

  return {
    objective,
    tasks: [
      {
        id: 't1',
        agent: 'data',
        tool: 'workbook.readWorkbook',
        description: 'Leggi la panoramica del workbook corrente',
        params: { maxRows: 12, maxCols: 8 },
        deps: [],
        requiresApproval: false
      },
      {
        id: 't2',
        agent: 'data',
        tool: 'workbook.readSheet',
        description: `Leggi il foglio attivo ${activeSheet}`,
        params: { sheet: activeSheet, maxRows: 30, maxCols: 12 },
        deps: ['t1'],
        requiresApproval: false
      },
      {
        id: 't3',
        agent: 'formula',
        tool: 'llm.writeFormulas',
        description: 'Analizza e correggi formule e riferimenti del modello nel foglio attivo',
        params: { sheet: activeSheet, objective, mode: 'repair_existing_model', section: 'full_model_review' },
        deps: ['t2'],
        requiresApproval: false
      },
      {
        id: 't4',
        agent: 'format',
        tool: 'llm.planFormat',
        description: 'Prepara una pulizia visiva professionale del modello',
        params: { sheet: activeSheet, objective, mode: 'finance_cleanup' },
        deps: ['t3'],
        requiresApproval: false
      },
      {
        id: 't5',
        agent: 'format',
        tool: 'excel.applyFormat',
        description: 'Applica la formattazione proposta',
        params: { fromResult: 't4', sheet: activeSheet },
        deps: ['t4'],
        requiresApproval: false
      }
    ]
  };
}

function inferAgent(toolName) {
  if (toolName.startsWith('yahoo.')) return 'data';
  if (toolName.startsWith('openbb.')) return 'data';
  if (toolName.startsWith('finance.dcf.')) return 'formula';
  if (toolName.startsWith('workbook.read') || toolName === 'requestUserInput' || toolName === 'requestPermissions') return 'data';
  if (toolName === 'llm.planLayout' || toolName === 'excel.createSheet' || toolName === 'excel.renameSheet' || toolName === 'excel.deleteSheet' || toolName === 'excel.duplicateSheet' || toolName === 'excel.createNamedRange') return 'layout';
  if (toolName === 'llm.planFormat' || toolName === 'excel.applyFormat' || toolName === 'excel.setConditionalFormat') return 'format';
  if (toolName === 'llm.writeFormulas' || toolName.startsWith('excel.set') || toolName === 'excel.copyRange') return 'formula';
  return 'data';
}

function ensureNoCycles(tasks) {
  const taskMap = new Map(tasks.map(task => [task.id, task]));
  const visiting = new Set();
  const visited = new Set();

  function visit(taskId) {
    if (visiting.has(taskId)) {
      throw new Error(`Ciclo dipendenze nel task graph: ${taskId}`);
    }
    if (visited.has(taskId)) return;

    const task = taskMap.get(taskId);
    if (!task) {
      throw new Error(`Task dipendenza non trovato: ${taskId}`);
    }

    visiting.add(taskId);
    for (const dep of task.deps) {
      visit(dep);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const task of tasks) {
    visit(task.id);
  }
}

function sanitizeJSON(text) {
  if (typeof text !== 'string') return text;
  let cleaned = text;
  cleaned = cleaned.replace(/```json\s*/gi, '');
  cleaned = cleaned.replace(/```\s*/g, '');
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
  cleaned = cleaned.replace(/([{,]\s*)'([^']+)'(\s*:)/g, '$1"$2"$3');
  cleaned = cleaned.replace(/(:\s*)'([^']*)'(\s*[,}])/g, '$1"$2"$3');
  return cleaned.trim();
}

function tryParsePlan(raw) {
  if (typeof raw === 'object' && raw !== null && !raw.jsonError) return raw;
  const text = raw && raw.raw ? raw.raw : String(raw);
  const cleaned = sanitizeJSON(text);
  return JSON.parse(cleaned);
}

function normalizeToolName(toolName) {
  const fuzzyMap = {
  'createsheet': 'excel.createSheet',
  'addsheet': 'excel.createSheet',
  'renamesheet': 'excel.renameSheet',
  'deletesheet': 'excel.deleteSheet',
  'duplicatesheet': 'excel.duplicateSheet',
  'copyrange': 'excel.copyRange',
  'createnamedrange': 'excel.createNamedRange',
  'namedrange': 'excel.createNamedRange',
  'setvalues': 'excel.setValues',
    'setformulas': 'excel.setFormulas',
    'addchart': 'excel.addChart',
    'setconditionalformat': 'excel.setConditionalFormat',
    'conditionalformat': 'excel.setConditionalFormat',
    'writerange': 'workbook.writeRange',
    'readworkbook': 'workbook.readWorkbook',
    'readsheet': 'workbook.readSheet',
    'readrange': 'workbook.readRange'
  };
  const key = String(toolName).toLowerCase().replace(/[^a-z0-9]/g, '');
  return fuzzyMap[key] || toolName;
}

function normalizeAndValidatePlan(result) {
  if (!result || !Array.isArray(result.tasks) || result.tasks.length === 0) {
    throw new Error('Planner non ha restituito un task graph valido');
  }

  const taskMap = new Map();
  const normalizedTasks = result.tasks.map((task, idx) => {
    const tool = normalizeToolName(task.tool || '');
    const normalized = {
      id: task.id || `t${idx + 1}`,
      agent: task.agent || inferAgent(tool),
      tool,
      description: task.description || tool || `Task ${idx + 1}`,
      params: task.params && typeof task.params === 'object' ? { ...task.params } : {},
      deps: Array.isArray(task.deps) ? [...task.deps] : [],
      requiresApproval: !!task.requiresApproval,
      status: 'pending'
    };

    if (taskMap.has(normalized.id)) {
      throw new Error(`Planner ha restituito task duplicato: ${normalized.id}`);
    }
    if (!normalized.tool || !KNOWN_TOOLS.has(normalized.tool)) {
      throw new Error(`Tool non valido nel piano: ${normalized.tool || '(mancante)'}`);
    }

    taskMap.set(normalized.id, normalized);
    return normalized;
  });

  for (const task of normalizedTasks) {
    for (const dep of task.deps) {
      if (!taskMap.has(dep)) {
        throw new Error(`Dipendenza sconosciuta nel task ${task.id}: ${dep}`);
      }
    }

    if (task.tool === 'excel.applyFormat') {
      if (task.params.planRef && !task.params.fromResult) {
        task.params.fromResult = task.params.planRef;
      }

      if (!task.params.fromResult && task.deps.length === 1) {
        const dependency = taskMap.get(task.deps[0]);
        if (dependency && dependency.tool === 'llm.planFormat') {
          task.params.fromResult = dependency.id;
        }
      }
    }
  }

  ensureNoCycles(normalizedTasks);

  return {
    objective: result.objective || '',
    tasks: normalizedTasks
  };
}

let cacheAccessCount = 0;

async function plan(objective, context, turnId, options = {}) {
  // Lazy cleanup every ~20 accesses
  cacheAccessCount++;
  if (cacheAccessCount % 20 === 0) cleanupExpiredCache();

  const cacheKey = getPlanCacheKey(objective, context);
  const objectiveTokens = tokenize(objective);
  const cached = getCachedPlan(cacheKey, objectiveTokens);
  if (cached) {
    logger.info('[Planner] Cache hit per piano');
    return cached;
  }

  logger.info('[Planner] Avvio planning per:', objective);
  const planningContext = compactPlanningContext(context);

  // Fast-path deterministico: nessuna chiamata LLM per pattern noti
  const fallbackPlan = buildFinanceFallbackPlan(objective, planningContext);
  if (fallbackPlan) {
    logger.info('[Planner] Fast-path deterministico attivato');
    const normalized = normalizeAndValidatePlan(fallbackPlan);
    setCachedPlan(cacheKey, normalized, objectiveTokens);
    return normalized;
  }

  const conversationCtx = planningContext.conversationHistory || '';
  const recentSheets = Array.isArray(planningContext.recentSheets) && planningContext.recentSheets.length > 0
    ? `Fogli creati di recente: ${planningContext.recentSheets.join(', ')}\n`
    : '';
  const userPromptBase = `${conversationCtx}${recentSheets}Crea un piano di esecuzione per: "${objective}".\n\nContesto Excel attuale (compattato):\n${JSON.stringify(planningContext, null, 2)}`;
  const plannerModel = options.modelOverride || PLANNER_MODEL || undefined;
  logger.info('[Planner] Chiamata LLM in corso...');

  // Attempt streaming first if turnId is provided (for progress UX)
  if (turnId) {
    try {
      const start = Date.now();
      const accumulated = await callLLMStreaming({
        system: PLANNER_SYSTEM_PROMPT,
        userText: userPromptBase,
        modelOverride: plannerModel,
        label: 'Planner LLM stream',
        onChunk: (delta, text, isDone) => {
          if (delta || isDone) {
            streaming.sendLLMProgress(turnId, text, isDone);
          }
        }
      });
      const elapsed = Date.now() - start;
      logger.info(`[Planner] LLM stream done in ${elapsed}ms (${accumulated.length} chars)`);

      let result = tryParsePlan(accumulated);
      const normalized = normalizeAndValidatePlan(result);
      logger.info(`[Planner] Piano generato:`, normalized.tasks.length, 'task');
      setCachedPlan(cacheKey, normalized, objectiveTokens);
      return normalized;
    } catch (streamError) {
      logger.warn(`[Planner] Streaming failed, falling back to regular call: ${streamError.message}`);
    }
  }

  let lastError;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const start = Date.now();
      const systemExtra = attempt > 0 ? '\n\nIMPORTANTE: la risposta precedente non era JSON valido. Correggi e rispondi SOLO con JSON valido.' : '';
      const userExtra = attempt > 0 ? `\n\nErrore precedente: ${lastError.message}` : '';
      let result = await callLLM({
        system: PLANNER_SYSTEM_PROMPT + systemExtra,
        userText: userPromptBase + userExtra,
        timeoutMs: PLANNER_TIMEOUT_MS,
        fallbackTimeoutMs: PLANNER_FALLBACK_TIMEOUT_MS,
        modelOverride: plannerModel,
        fallbackModel: PLANNER_FALLBACK_MODEL || undefined,
        label: 'Planner LLM',
        cachePrompt: true
      });
      const elapsed = Date.now() - start;

      if (result && result.jsonError) {
        result = tryParsePlan(result);
      }

      const normalized = normalizeAndValidatePlan(result);
      logger.info(`[Planner] Piano generato in ${elapsed}ms:`, normalized.tasks.length, 'task');
      setCachedPlan(cacheKey, normalized, objectiveTokens);
      return normalized;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        logger.warn(`[Planner] Tentativo ${attempt + 1} fallito, retry: ${error.message}`);
      }
    }
  }

  const emergencyFallback = buildFinanceFallbackPlan(objective, planningContext);
  if (emergencyFallback) {
    logger.warn(`[Planner] Fallback euristico attivato dopo errore LLM: ${lastError.message}`);
    const normalized = normalizeAndValidatePlan(emergencyFallback);
    setCachedPlan(cacheKey, normalized, objectiveTokens);
    return normalized;
  }
  throw lastError;
}

module.exports = { plan };
