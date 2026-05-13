const { callLLM, callLLMStreaming } = require('../tools/llm');
const { tools } = require('../tools/registry');
const logger = require('../utils/logger');
const streaming = require('./streaming');
const { analyzeWorkbookContext } = require('../utils/sheetParser');
const { inferEquityIntent } = require('../utils/equityIntent');
const { getAnalystDepth } = require('../models/analystDepth');

const PLANNER_TIMEOUT_MS = Number(process.env.PLANNER_TIMEOUT_MS) || 300000;
const PLANNER_FALLBACK_TIMEOUT_MS = Number(process.env.PLANNER_FALLBACK_TIMEOUT_MS) || 180000;
const PLANNER_MODEL = process.env.PLANNER_MODEL || process.env.OPENROUTER_PLANNER_MODEL || '';
const PLANNER_FALLBACK_MODEL = process.env.PLANNER_FALLBACK_MODEL || '';

const PLANNER_SYSTEM_PROMPT = `You are a world-class Excel AI agent for any workbook domain.
Your task is to understand, analyze, repair, transform, model and format Microsoft Excel workbooks through safe, grounded tool use.
You are especially strong at finance, but finance is only one domain. The product must work for sales, operations, HR, inventory, project management, pricing, research, budgets, scientific data and custom business models.

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
- data: workbook reads, semantic understanding, external data where relevant
- layout: sheet structure, cell maps, section design
- formula: Excel formulas and transformations (must reference cells, never hardcode)
- format: professional formatting adapted to the workbook domain

TOOLS:
- data (equity): yahoo.quote, yahoo.historical, yahoo.fundamentals
- data (OpenBB): openbb.equity.quote, openbb.equity.historical, openbb.equity.profile, openbb.equity.fundamentals.balance, openbb.equity.fundamentals.income, openbb.equity.fundamentals.cash, openbb.equity.fundamentals.metrics, openbb.equity.fundamentals.ratios, openbb.equity.fundamentals.income_growth, openbb.equity.fundamentals.balance_growth, openbb.equity.fundamentals.cash_growth, openbb.equity.estimates.consensus, openbb.equity.peers, openbb.equity.performance, openbb.equity.fundamentals.management, openbb.equity.fundamentals.esg
- data (macro): openbb.fixedincome.treasury, openbb.fixedincome.yield_curve, openbb.fixedincome.effr, openbb.economy.cpi, openbb.economy.gdp_real, openbb.economy.unemployment, openbb.economy.interest_rates, openbb.economy.risk_premium, openbb.economy.money_measures, openbb.economy.gdp_forecast
- data (market): openbb.index.snapshots, openbb.index.historical, openbb.etf.info, openbb.etf.holdings, openbb.currency.historical, openbb.crypto.historical
- AI-assisted finance: finance.dcf.buildSection (sections: shell, sources, assumptions, wacc, dcf, sensitivity, scenarios, summary, audit, format, all; formula sections use an analyst LLM with deterministic fallback)
- read/intelligence: workbook.readWorkbook, workbook.understand, workbook.scanDeep, workbook.buildGraph, workbook.readSheet, workbook.readRange
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
Sheets: Summary, Sources, Assumptions, WACC, DCF, Sensitivity, Scenarios, Audit

IMPORTANT: A natural request like "voglio fare un DCF di Apple", "fammi DCF AAPL", or "build DCF for Microsoft" means FULL DCF BUILD. Do not treat it as a repair task. Use the complete sequence: workbook scan, workbook graph, market data, DCF shell, assumptions, WACC, DCF projection, sensitivity, formatting.
For any request that depends on workbook content, read the workbook and run workbook.understand early. This gives the model a domain-agnostic semantic map of sheet roles, tables, measures, dimensions, key cells, formula zones, risks and likely next actions.
For multi-sheet analysis, audits, repair, formatting or model completion, also build a WorkbookGraph early with workbook.buildGraph or workbook.scanDeep so later tasks can reason over dependencies and formulas.

1) Assumptions Sheet:
   - Section headers (grey background, white bold text)
   - Revenue drivers: Revenue, Revenue Growth %, EBITDA Margin %
   - Tax & Capital: Tax Rate %, D&A % of Revenue, CapEx % of Revenue, NWC % of Revenue
   - Terminal: Terminal Growth Rate %
   - Market data (if public): Beta, Risk-Free Rate, Market Risk Premium, Cost of Debt, Target D/E

2) WACC Sheet:
   - Think like an analyst before writing formulas: define how WACC is built, identify missing inputs, then expose those inputs visibly.
   - Cost of Equity (CAPM): =RiskFree + Beta*MarketRiskPremium
   - Beta must not be a blind hardcode: use observed beta, peer/sector beta cross-check, unlever peer beta, relever to target D/E, then select a visible beta.
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

5) Sources Sheet:
   - Source register for every major input
   - Market-data/fundamental-data provenance
   - Data quality checks and analyst review flags

6) Scenarios Sheet:
   - Downside / Base / Upside cases
   - Explicit revenue, margin, WACC and terminal-growth deltas
   - Case-level implied share price and upside/downside

7) Summary Sheet:
   - Enterprise value, equity value, implied share price, current price and premium/discount
   - Scenario snapshot and key assumption summary
   - Clear investment-committee output view

8) Audit Sheet:
   - Formula integrity checks
   - Terminal value sanity checks
   - Bridge checks and model readiness status

CRITICAL RULES:
- EVERY data row MUST have a descriptive label in Column A. Never output naked numbers.
- Formulas must reference other sheets (e.g., =Assumptions!B3) — never hardcode constants.
- DEPTH POLICY: beta is only one example. Every finance section must include the underlying analyst method, required evidence, visible assumptions, sanity checks and review flags. Revenue, margins, taxes, CapEx, NWC, WACC, terminal value, sensitivity, scenarios, summary and audit all need the same level of professional reasoning.
- If the user already has financial data in the active sheet (EBITDA, Revenue, etc.), USE IT. Do NOT ask for input. The system automatically extracts known financial labels and values from the workbook.
- WORKBOOK-FIRST DATA POLICY: if inferredData.highConfidenceInputs contains Revenue plus EBITDA/EBITDA Margin/Net Income, treat workbook data as the primary source. Do not invent a ticker, Yahoo task, or OpenBB equity task for that company unless the user explicitly named a public ticker/company. External data is only supplemental for missing macro/market assumptions.
- For private/unlisted/local-company contexts, build the model from workbook.scanDeep/workbook.buildGraph + finance.dcf.buildSection with sourcePriority:"workbook_first"; mark missing market assumptions as analyst-review items instead of forcing external data.
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
t4: data/yahoo.historical (ticker:AAPL, period:5y) [optional if public]
t5: layout/llm.planLayout (model:DCF, sheets:[Summary,Sources,Assumptions,WACC,DCF,Sensitivity,Scenarios,Audit], context from t1,t2,t3,t4)
t6: excel.createSheet (name:Summary) deps:[t5]
t7: excel.createSheet (name:Sources) deps:[t5]
t8: excel.createSheet (name:Assumptions) deps:[t5]
t9: excel.createSheet (name:WACC) deps:[t5]
t10: excel.createSheet (name:DCF) deps:[t5]
t11: excel.createSheet (name:Sensitivity) deps:[t5]
t12: excel.createSheet (name:Scenarios) deps:[t5]
t13: excel.createSheet (name:Audit) deps:[t5]
t14: formula/llm.writeFormulas (section:sources.data_map) deps:[t5,t7]
t15: formula/llm.writeFormulas (section:assumptions.inputs) deps:[t5,t8]
t16: formula/llm.writeFormulas (section:assumptions.macro) deps:[t5,t8]
t17: formula/llm.writeFormulas (section:wacc.cost_of_equity) deps:[t5,t9]
t18: formula/llm.writeFormulas (section:wacc.wacc_calc) deps:[t5,t9]
t19: formula/llm.writeFormulas (section:dcf.revenue_build) deps:[t5,t10]
t20: formula/llm.writeFormulas (section:dcf.ebitda_build) deps:[t5,t10]
t21: formula/llm.writeFormulas (section:dcf.fcf_build) deps:[t5,t10]
t22: formula/llm.writeFormulas (section:dcf.terminal_value) deps:[t5,t10]
t23: formula/llm.writeFormulas (section:dcf.enterprise_value) deps:[t5,t10]
t24: formula/llm.writeFormulas (section:dcf.equity_value) deps:[t5,t10]
t25: formula/llm.writeFormulas (section:sensitivity.data_table) deps:[t5,t11,t23,t24]
t26: formula/llm.writeFormulas (section:scenarios.case_matrix) deps:[t5,t12,t24]
t27: formula/llm.writeFormulas (section:summary.output_view) deps:[t5,t6,t25,t26]
t28: formula/llm.writeFormulas (section:audit.model_checks) deps:[t5,t13,t27]
t29: format/llm.planFormat (mode:institutional_finance) deps:[t14,t15,t16,t17,t18,t19,t20,t21,t22,t23,t24,t25,t26,t27,t28]
t30: excel.applyFormat (fromResult:t29) deps:[t29]

EXAMPLE for existing workbook:
t1: data/workbook.readSheet (sheet:ActiveSheet, includeUsedRange:true)
t2: layout/llm.planLayout (model:DCF, sheets:[Summary,Sources,Assumptions,WACC,DCF,Sensitivity,Scenarios,Audit]) deps:[t1]
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

function truncateText(value, maxLength = 240) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}

function extractSheetNamesFromActions(actions = []) {
  const sheets = [];
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    const sheet = action.sheet || action.sheetName || action.name;
    if (sheet) sheets.push(sheet);
  }
  return normalizeSheetSet(sheets).slice(0, 16);
}

function summarizeActionForPrompt(action = {}) {
  if (!action || typeof action !== 'object') return null;
  return {
    type: action.type,
    sheet: action.sheet || action.sheetName || action.name,
    target: action.target || action.range || action.address,
    cell: action.cell,
    name: action.name
  };
}

function compactParentPlan(parentPlan) {
  if (!parentPlan || typeof parentPlan !== 'object' || !Array.isArray(parentPlan.tasks)) return null;
  return {
    objective: truncateText(parentPlan.objective, 260),
    taskCount: parentPlan.tasks.length,
    tasks: parentPlan.tasks.slice(0, 48).map(task => {
      const params = task?.params || {};
      return {
        id: task?.id,
        agent: task?.agent,
        tool: task?.tool,
        status: task?.status,
        description: truncateText(task?.description, 220),
        deps: Array.isArray(task?.deps) ? task.deps.slice(0, 10) : [],
        section: params.section,
        sheet: params.sheet,
        sheets: Array.isArray(params.sheets) ? params.sheets.slice(0, 16) : undefined,
        scope: params.scope,
        mode: params.mode,
        sourcePriority: params.sourcePriority,
        usesResults: Array.isArray(params.usesResults) ? params.usesResults.slice(0, 12) : undefined
      };
    })
  };
}

function compactParentResults(parentResults) {
  if (!parentResults || typeof parentResults !== 'object') return null;
  const entries = Object.entries(parentResults).slice(0, 48);
  const results = {};
  for (const [taskId, result] of entries) {
    if (!result || typeof result !== 'object') continue;
    const data = result.data && typeof result.data === 'object' ? result.data : {};
    const directActions = Array.isArray(result.actions) ? result.actions : [];
    const plannedActions = Array.isArray(data.actions) ? data.actions : [];
    const actionSampleSource = directActions.length > 0 ? directActions : plannedActions;
    const sheets = normalizeSheetSet([
      data.sheet,
      data.sheetName,
      data.activeSheet,
      ...(Array.isArray(data.sheets) ? data.sheets.map(sheet => (
        typeof sheet === 'string' ? sheet : (sheet?.name || sheet?.sheetName || sheet?.sheet)
      )) : []),
      ...extractSheetNamesFromActions(actionSampleSource)
    ]).slice(0, 16);

    results[taskId] = {
      resultKey: `parent:${taskId}`,
      builder: data.builder,
      section: data.section || data.analystDepth?.section,
      modelType: data.modelType,
      theme: data.theme,
      strategy: data.strategy,
      sourceType: data.sourceType,
      sheet: data.sheet || data.sheetName || data.activeSheet,
      sheets,
      actionCount: directActions.length,
      plannedActionCount: plannedActions.length,
      error: truncateText(result.error || data.error, 220),
      summary: truncateText(data.summary, 260),
      sampleActions: actionSampleSource.slice(0, 8).map(summarizeActionForPrompt).filter(Boolean)
    };
  }
  return {
    resultCount: Object.keys(parentResults).length,
    results
  };
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
    lastModelState: context.lastModelState && typeof context.lastModelState === 'object' ? {
      modelType: context.lastModelState.modelType || null,
      sheets: Array.isArray(context.lastModelState.sheets) ? context.lastModelState.sheets.slice(0, 16) : [],
      turnId: context.lastModelState.turnId || null,
      keyCells: context.lastModelState.keyCells || {}
    } : null,
    parentPlan: compactParentPlan(context.parentPlan),
    parentResults: compactParentResults(context.parentResults),
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

function workbookHasLocalFinancials(planningContext = {}) {
  const inputs = Array.isArray(planningContext?.inferredData?.highConfidenceInputs)
    ? planningContext.inferredData.highConfidenceInputs
    : [];
  const canonicals = new Set(inputs.map(input => input.canonical));
  return canonicals.has('Revenue') &&
    (canonicals.has('EBITDA') || canonicals.has('EBITDA Margin') || canonicals.has('Net Income'));
}

function workbookLooksPrivate(planningContext = {}) {
  const haystack = JSON.stringify({
    sheets: planningContext.workbookSheets || [],
    inferred: planningContext.inferredData || {},
    active: planningContext.activeSheet,
    usedRange: planningContext.usedRange,
    allSheetsData: planningContext.allSheetsData || {}
  });
  return /\b(private|privata|non quotata|unlisted)\b/i.test(haystack);
}

function isCompanyExternalDataTask(task = {}) {
  const tool = String(task.tool || '');
  if (tool.startsWith('yahoo.')) return true;
  if (tool.startsWith('openbb.equity.')) return true;
  if (tool.startsWith('openbb.etf.') || tool.startsWith('openbb.index.') || tool.startsWith('openbb.crypto.')) return true;
  return false;
}

function enforceWorkbookFirstPlan(normalized, planningContext = {}, objective = '') {
  if (!normalized || !Array.isArray(normalized.tasks)) return normalized;
  const hasLocalFinancials = workbookHasLocalFinancials(planningContext);
  if (!hasLocalFinancials) return normalized;

  const explicitEquityIntent = inferEquityIntent(objective);
  const explicitPublicTarget = !!explicitEquityIntent?.ticker || !!explicitEquityIntent?.isPublicCompanyTarget;
  const localPrivate = workbookLooksPrivate(planningContext);
  if (explicitPublicTarget && !localPrivate) return normalized;

  const removedIds = new Set(
    normalized.tasks
      .filter(isCompanyExternalDataTask)
      .map(task => task.id)
  );
  if (removedIds.size === 0) {
    return {
      ...normalized,
      tasks: normalized.tasks.map(task => patchWorkbookFirstTask(task, removedIds, explicitPublicTarget, localPrivate))
    };
  }

  const tasks = normalized.tasks
    .filter(task => !removedIds.has(task.id))
    .map(task => patchWorkbookFirstTask(task, removedIds, explicitPublicTarget, localPrivate));

  logger.info(`[Planner] Workbook-first guardrail removed ${removedIds.size} external company-data tasks`);
  return { ...normalized, tasks };
}

function patchWorkbookFirstTask(task, removedIds, explicitPublicTarget, localPrivate) {
  const params = task.params && typeof task.params === 'object' ? { ...task.params } : {};
  const deps = Array.isArray(task.deps) ? task.deps.filter(dep => !removedIds.has(dep)) : [];
  if (Array.isArray(params.usesResults)) {
    params.usesResults = params.usesResults.filter(id => !removedIds.has(id));
  }
  if (params.context && typeof params.context === 'object' && Array.isArray(params.context.externalData)) {
    params.context = {
      ...params.context,
      externalData: params.context.externalData.filter(id => !removedIds.has(id))
    };
  }
  if (task.tool === 'finance.dcf.buildSection') {
    params.sourcePriority = 'workbook_first';
    if (!explicitPublicTarget) delete params.ticker;
    if (localPrivate && !explicitPublicTarget) params.localCompanyType = 'private';
  }
  if (['llm.planLayout', 'llm.writeFormulas', 'llm.planFormat'].includes(task.tool)) {
    params.sourcePriority = 'workbook_first';
  }
  return { ...task, params, deps };
}

function hasWorkbookContext(planningContext = {}) {
  return Boolean(
    planningContext.activeSheet ||
    planningContext.usedRange ||
    planningContext.allSheetsData ||
    (Array.isArray(planningContext.workbookSheets) && planningContext.workbookSheets.length > 0)
  );
}

function isWorkbookReadTool(tool = '') {
  return [
    'workbook.readWorkbook',
    'workbook.readSheet',
    'workbook.scanDeep',
    'workbook.buildGraph'
  ].includes(tool);
}

function isAiReasoningTool(tool = '') {
  return tool === 'workbook.buildGraph' ||
    tool === 'llm.planLayout' ||
    tool === 'llm.writeFormulas' ||
    tool === 'llm.planFormat' ||
    tool === 'finance.dcf.buildSection';
}

function nextTaskId(tasks = []) {
  const used = new Set(tasks.map(task => task.id));
  for (let i = 1; i < 500; i++) {
    const id = `t${i}`;
    if (!used.has(id)) return id;
  }
  return `t${tasks.length + 1}_${Date.now()}`;
}

function ensureWorkbookUnderstandingPlan(normalized, planningContext = {}, objective = '') {
  if (!normalized || !Array.isArray(normalized.tasks)) return normalized;
  if (process.env.PLANNER_WORKBOOK_UNDERSTANDING === 'false') return normalized;
  if (normalized.tasks.some(task => task.tool === 'workbook.understand')) return normalized;

  const hasContext = hasWorkbookContext(planningContext);
  const readTask = normalized.tasks.find(task => ['workbook.readWorkbook', 'workbook.readSheet'].includes(task.tool));
  const hasWorkbookRead = !!readTask || normalized.tasks.some(task => isWorkbookReadTool(task.tool));
  const needsSemanticContext = normalized.tasks.some(task => isAiReasoningTool(task.tool));
  if (!hasContext || (!hasWorkbookRead && !needsSemanticContext) || !needsSemanticContext) return normalized;

  const understandId = nextTaskId(normalized.tasks);
  const understandTask = {
    id: understandId,
    agent: 'data',
    tool: 'workbook.understand',
    description: 'Comprendi semanticamente workbook, tabelle, misure, dimensioni e zone formula',
    params: {
      objective: objective || normalized.objective || '',
      ...(readTask ? { fromResult: readTask.id } : {}),
      maxRows: 120,
      maxCols: 60
    },
    deps: readTask ? [readTask.id] : [],
    requiresApproval: false,
    status: 'pending'
  };

  const tasks = [...normalized.tasks, understandTask].map(task => {
    if (task.id === understandId) return task;
    if (!isAiReasoningTool(task.tool)) return task;
    if (readTask && task.id === readTask.id) return task;
    const deps = new Set(Array.isArray(task.deps) ? task.deps : []);
    if (!deps.has(understandId)) deps.add(understandId);
    const params = task.params && typeof task.params === 'object' ? { ...task.params } : {};
    if (['llm.planLayout', 'llm.writeFormulas', 'llm.planFormat', 'finance.dcf.buildSection'].includes(task.tool)) {
      const usesResults = new Set(Array.isArray(params.usesResults) ? params.usesResults : []);
      usesResults.add(understandId);
      params.usesResults = Array.from(usesResults);
      params.workbookUnderstanding = understandId;
    }
    return { ...task, params, deps: Array.from(deps) };
  });

  logger.info('[Planner] Added workbook.understand semantic grounding task');
  return { ...normalized, tasks };
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

const CONTINUITY_MODEL_SHEETS = ['Summary', 'Sources', 'Assumptions', 'WACC', 'DCF', 'Sensitivity', 'Scenarios', 'Audit'];

function existingSheetNames(context = {}) {
  return Array.isArray(context.workbookSheets) ? context.workbookSheets.filter(Boolean).map(String) : [];
}

function normalizeSheetSet(sheets = []) {
  const seen = new Set();
  const out = [];
  for (const sheet of sheets) {
    const name = typeof sheet === 'string' ? sheet : (sheet?.name || sheet?.sheetName || sheet?.sheet);
    if (!name) continue;
    const key = String(name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(String(name));
  }
  return out;
}

function pickExistingModelSheets(context = {}) {
  const existing = existingSheetNames(context);
  const lowerExisting = new Map(existing.map(sheet => [sheet.toLowerCase(), sheet]));
  const modelSheets = CONTINUITY_MODEL_SHEETS
    .map(sheet => lowerExisting.get(sheet.toLowerCase()))
    .filter(Boolean);
  return modelSheets.length >= 2 ? modelSheets : [];
}

function hasWholeWorkbookIntent(objective = '') {
  const text = String(objective || '').toLowerCase();
  return /\b(all|every|entire|whole|workbook|model)\b/.test(text) ||
    /(tutto|tutta|tutti|tutte|intero|intera|modello|cartella|workbook)/.test(text);
}

function getContinuityTargetSheets(context = {}, fallbackSheet = null, options = {}) {
  const existingModelSheets = pickExistingModelSheets(context);
  if (options.preferExistingModel && existingModelSheets.length > 0) return existingModelSheets;

  const lastSheets = normalizeSheetSet(context.lastModelState?.sheets || []);
  if (lastSheets.length > 0) return lastSheets;
  if (existingModelSheets.length > 0) return existingModelSheets;
  const recentSheets = normalizeSheetSet(context.recentSheets || []);
  if (recentSheets.length > 0) return recentSheets;
  return fallbackSheet ? [fallbackSheet] : [];
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

function getPlanCacheContextHash(context) {
  const sheetsHash = (context?.workbookSheets || []).slice().sort().join(',');
  const lastModel = context?.lastModelState && typeof context.lastModelState === 'object'
    ? [
      context.lastModelState.turnId || '',
      context.lastModelState.modelType || '',
      ...(Array.isArray(context.lastModelState.sheets) ? context.lastModelState.sheets.slice(0, 16).sort() : [])
    ].join('|')
    : '';
  const parentPlan = context?.parentPlan && typeof context.parentPlan === 'object'
    ? [
      truncateText(context.parentPlan.objective, 120) || '',
      ...(Array.isArray(context.parentPlan.tasks) ? context.parentPlan.tasks.slice(0, 36).map(task => (
        `${task?.id || ''}:${task?.tool || ''}:${task?.params?.section || task?.section || ''}:${task?.params?.sheet || task?.sheet || ''}`
      )) : [])
    ].join('|')
    : '';
  const parentResults = context?.parentResults && typeof context.parentResults === 'object'
    ? Object.entries(context.parentResults).slice(0, 36).map(([id, result]) => {
      const data = result?.data || {};
      const actions = Array.isArray(result?.actions) ? result.actions.length : 0;
      const planned = Array.isArray(data?.actions) ? data.actions.length : 0;
      return `${id}:${data.builder || ''}:${data.section || data.analystDepth?.section || ''}:${data.sheet || data.sheetName || ''}:${actions}:${planned}`;
    }).join('|')
    : '';
  return `sheets=${sheetsHash};last=${lastModel};parentPlan=${parentPlan};parentResults=${parentResults}`;
}

function getPlanCacheKey(objective, context) {
  const normalizedObjective = String(objective).toLowerCase()
    .replace(/[.,;:!?()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${normalizedObjective}::${getPlanCacheContextHash(context)}`;
}

function getSemanticCacheKey(tokens, context) {
  return `${tokens.join('|')}::${getPlanCacheContextHash(context)}`;
}

function cacheContextHashFromKey(key) {
  return String(key).split('::').slice(1).join('::');
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
    const contextHash = cacheContextHashFromKey(key);
    for (const [cachedKey, cachedEntry] of planCache.entries()) {
      if (!cachedEntry.tokens || cachedEntry.tokens.length === 0) continue;
      // Only consider entries with the same workbook/continuity context.
      if (cacheContextHashFromKey(cachedKey) !== contextHash) continue;
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

function buildAgenticDcfPlan(objective, context, equityIntent = {}) {
  const ticker = equityIntent.ticker || null;
  const companyName = equityIntent.companyName || ticker || null;
  const workbookName = companyName || context?.activeSheet || 'Workbook';
  const hasLocalFinancials = workbookHasLocalFinancials(context);
  const localPrivate = workbookLooksPrivate(context);
  const tasks = [
    {
      id: 't1',
      agent: 'data',
      tool: 'workbook.readWorkbook',
      description: 'Scan workbook for existing model/data context and reusable finance inputs',
      params: { maxRows: 80, maxCols: 32, includeFormulas: true },
      deps: [],
      requiresApproval: false
    },
    {
      id: 't2',
      agent: 'data',
      tool: 'workbook.buildGraph',
      description: 'Build WorkbookGraph for cross-sheet formulas, sheet roles, existing data and model risks',
      params: { fromResult: 't1', workbookName, source: 'planner.dcf_prefetch' },
      deps: ['t1'],
      requiresApproval: false
    }
  ];

  const dataDeps = ['t1', 't2'];
  let nextId = 3;
  function addDataTask(tool, description, params, deps = []) {
    const id = `t${nextId}`;
    tasks.push({
      id,
      agent: 'data',
      tool,
      description,
      params,
      deps,
      requiresApproval: false
    });
    dataDeps.push(id);
    nextId++;
    return id;
  }

  if (ticker) {
    addDataTask('yahoo.quote', `Fetch live quote, market cap and trading metadata for ${ticker}`, { ticker });
    addDataTask('yahoo.fundamentals', `Fetch financial fundamentals for ${ticker}`, { ticker });
    addDataTask('yahoo.historical', `Fetch five-year price history for ${ticker} to sanity-check beta and market context`, { ticker, period: '5y' });

    if (process.env.OPENBB_AGENTIC_ENABLED === 'true') {
      addDataTask('openbb.equity.profile', `Fetch OpenBB company profile for ${ticker}`, { symbol: ticker });
      addDataTask('openbb.equity.fundamentals.income', `Fetch OpenBB income statements for ${ticker}`, { symbol: ticker, period: 'annual', limit: 5 });
      addDataTask('openbb.equity.fundamentals.balance', `Fetch OpenBB balance sheets for ${ticker}`, { symbol: ticker, period: 'annual', limit: 5 });
      addDataTask('openbb.equity.fundamentals.cash', `Fetch OpenBB cash-flow statements for ${ticker}`, { symbol: ticker, period: 'annual', limit: 5 });
      addDataTask('openbb.equity.fundamentals.metrics', `Fetch OpenBB valuation and operating metrics for ${ticker}`, { symbol: ticker, period: 'annual', limit: 5 });
      addDataTask('openbb.equity.fundamentals.ratios', `Fetch OpenBB financial ratios for ${ticker}`, { symbol: ticker, period: 'annual', limit: 5 });
      addDataTask('openbb.equity.estimates.consensus', `Fetch OpenBB consensus estimates for ${ticker}`, { symbol: ticker });
      addDataTask('openbb.equity.peers', `Fetch OpenBB peer set for ${ticker}`, { symbol: ticker });
      addDataTask('openbb.fixedincome.treasury', 'Fetch current Treasury curve for risk-free-rate support', {});
      addDataTask('openbb.economy.risk_premium', 'Fetch equity risk premium support for WACC', {});
    }
  }

  const baseParams = {
    objective,
    projectionYears: 5,
    mode: 'ai_assisted',
    analysisDepth: 'institutional',
    usesResults: dataDeps
  };
  if (companyName) baseParams.companyName = companyName;
  if (ticker) baseParams.ticker = ticker;
  if (hasLocalFinancials) baseParams.sourcePriority = 'workbook_first';
  if (hasLocalFinancials && localPrivate && !ticker) baseParams.localCompanyType = 'private';

  const sections = [
    {
      section: 'shell',
      agent: 'layout',
      description: 'Create institutional DCF workbook shell: Summary, Sources, Assumptions, WACC, DCF, Sensitivity, Scenarios and Audit',
      deps: dataDeps
    },
    {
      section: 'sources',
      agent: 'layout',
      description: 'Build source book and data-quality map from fetched market/fundamental data',
      deps: [`t${nextId}`]
    },
    {
      section: 'assumptions',
      agent: 'formula',
      description: 'AI-build assumption spine from company data, market inputs and workbook context',
      deps: [`t${nextId + 1}`]
    },
    {
      section: 'wacc',
      agent: 'formula',
      description: 'AI-build WACC from CAPM, debt cost, tax rate, capital structure and beta peer/sector cross-check',
      deps: [`t${nextId + 2}`]
    },
    {
      section: 'dcf',
      agent: 'formula',
      description: 'AI-build operating forecast, free-cash-flow bridge, terminal value and implied share price',
      deps: [`t${nextId + 3}`]
    },
    {
      section: 'sensitivity',
      agent: 'formula',
      description: 'AI-build WACC x terminal-growth sensitivity grids',
      deps: [`t${nextId + 4}`]
    },
    {
      section: 'scenarios',
      agent: 'formula',
      description: 'Build downside/base/upside scenario layer around the DCF output',
      deps: [`t${nextId + 4}`]
    },
    {
      section: 'summary',
      agent: 'formula',
      description: 'Build valuation summary tying DCF, sensitivity and scenarios into an investment-committee view',
      deps: [`t${nextId + 5}`, `t${nextId + 6}`]
    },
    {
      section: 'audit',
      agent: 'formula',
      description: 'Build model audit checks for assumptions, formulas, bridge integrity and readiness',
      deps: [`t${nextId + 7}`]
    },
    {
      section: 'format',
      agent: 'format',
      description: 'Apply institutional finance formatting across every DCF workbook sheet',
      deps: [`t${nextId + 8}`]
    }
  ];

  for (const entry of sections) {
    tasks.push({
      id: `t${nextId}`,
      agent: entry.agent,
      tool: 'finance.dcf.buildSection',
      description: entry.description,
      params: { ...baseParams, section: entry.section, analystDepth: getAnalystDepth(entry.section) },
      deps: entry.deps,
      requiresApproval: false
    });
    nextId++;
  }

  logger.info(`[Planner] Agentic DCF plan generated for ${ticker || companyName || 'workbook financials'} (${tasks.length} tasks)`);
  return { objective, tasks };
}

function buildDcfCompletionPlan(objective, context, equityIntent = {}) {
  const ticker = equityIntent.ticker || null;
  const companyName = equityIntent.companyName || ticker || null;
  const workbookName = companyName || context?.activeSheet || 'Workbook';
  const hasLocalFinancials = workbookHasLocalFinancials(context);
  const localPrivate = workbookLooksPrivate(context);
  const existingSheets = context?.workbookSheets || [];
  const hasAllDcfSheets = ['Summary', 'Sources', 'Assumptions', 'WACC', 'DCF', 'Sensitivity', 'Scenarios', 'Audit'].every(sheet =>
    existingSheets.some(existing => existing.toLowerCase() === sheet.toLowerCase())
  );

  const tasks = [
    {
      id: 't1',
      agent: 'data',
      tool: 'workbook.readWorkbook',
      description: 'Read workbook before completing the DCF model',
      params: { maxRows: 80, maxCols: 32, includeFormulas: true },
      deps: [],
      requiresApproval: false
    },
    {
      id: 't2',
      agent: 'data',
      tool: 'workbook.buildGraph',
      description: 'Build WorkbookGraph to locate incomplete sheets, broken formulas and reusable model inputs',
      params: { fromResult: 't1', workbookName, source: 'planner.dcf_completion' },
      deps: ['t1'],
      requiresApproval: false
    }
  ];

  const dataDeps = ['t1', 't2'];
  let nextId = 3;
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
    objective,
    projectionYears: 5,
    mode: 'template',
    analysisDepth: 'institutional',
    usesResults: dataDeps
  };
  if (companyName) baseParams.companyName = companyName;
  if (ticker) baseParams.ticker = ticker;
  if (hasLocalFinancials) baseParams.sourcePriority = 'workbook_first';
  if (hasLocalFinancials && localPrivate && !ticker) baseParams.localCompanyType = 'private';

  let previousDeps = dataDeps;
  if (!hasAllDcfSheets) {
    tasks.push({
      id: `t${nextId}`,
      agent: 'layout',
      tool: 'finance.dcf.buildSection',
      description: 'Ensure DCF workbook shell exists',
      params: { ...baseParams, section: 'shell', analystDepth: getAnalystDepth('sources') },
      deps: dataDeps,
      requiresApproval: false
    });
    previousDeps = [`t${nextId}`];
    nextId++;
  }

  const sections = [
    { section: 'sources', agent: 'layout', description: 'Complete Sources and data-quality map' },
    { section: 'assumptions', agent: 'formula', description: 'Complete Assumptions with all required DCF drivers' },
    { section: 'wacc', agent: 'formula', description: 'Complete WACC formulas from assumptions' },
    { section: 'dcf', agent: 'formula', description: 'Complete 5-year DCF projection and valuation bridge' },
    { section: 'sensitivity', agent: 'formula', description: 'Complete WACC x terminal growth sensitivity tables' },
    { section: 'scenarios', agent: 'formula', description: 'Complete downside/base/upside scenario layer' },
    { section: 'summary', agent: 'formula', description: 'Complete valuation summary and output dashboard' },
    { section: 'audit', agent: 'formula', description: 'Complete model audit and readiness checks' },
    { section: 'format', agent: 'format', description: 'Re-apply institutional DCF formatting' }
  ];

  for (const entry of sections) {
    tasks.push({
      id: `t${nextId}`,
      agent: entry.agent,
      tool: 'finance.dcf.buildSection',
      description: entry.description,
      params: { ...baseParams, section: entry.section, analystDepth: getAnalystDepth(entry.section) },
      deps: previousDeps,
      requiresApproval: false
    });
    previousDeps = [`t${nextId}`];
    nextId++;
  }

  logger.info(`[Planner] DCF completion/repair plan generated for ${ticker || companyName || 'workbook financials'}`);
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
  const hasLocalFinancials = workbookHasLocalFinancials(context);
  const wantsValuation = [
    'valuation',
    'valutazione',
    'valuta questa azienda',
    'valutami questa azienda',
    'analizza questa azienda',
    'analisi azienda',
    'full valuation'
  ].some(keyword => lowerObjective.includes(keyword));
  const isCompanyAnalysis = hasLocalFinancials && ['azienda', 'company', 'business', 'analizza', 'analisi'].some(keyword => lowerObjective.includes(keyword));
  const isFinanceModel = !!equityIntent.model || wantsValuation || isCompanyAnalysis || ['dcf', 'wacc', 'lbo', 'valuation', 'valutazione', 'forecast', 'modello'].some(keyword => lowerObjective.includes(keyword));
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
    return buildAgenticDcfPlan(objective, context, equityIntent);
  }

  const shouldBuildFullValuation = !isModification && !isWacc && !isSensitivity && !isFormat && (
    isDcf ||
    wantsValuation ||
    (hasLocalFinancials && isFinanceModel)
  ) && (
    wantsNewModel ||
    wantsCompletion ||
    hasLocalFinancials ||
    equityIntent.isPublicCompanyTarget ||
    lowerObjective.includes('full')
  );

  if (shouldBuildFullValuation) {
    logger.info('[Planner] Full valuation request routed to agentic DCF workbook-first pipeline');
    return buildAgenticDcfPlan(objective, context, equityIntent);
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
    const targetSheets = getContinuityTargetSheets(context, activeSheet, {
      preferExistingModel: hasWholeWorkbookIntent(objective)
    });
    const targetSheet = targetSheets.includes(activeSheet) ? activeSheet : (targetSheets[0] || activeSheet);
    return {
      objective,
      tasks: [
        { id: 't1', agent: 'data', tool: 'workbook.readWorkbook', description: 'Leggi struttura, formule e used range del workbook corrente', params: { maxRows: 120, maxCols: 40, includeFormulas: true, includeNumberFormats: true }, deps: [], requiresApproval: false },
        { id: 't2', agent: 'data', tool: 'workbook.buildGraph', description: 'Mappa fogli, tabelle e aree da formattare con WorkbookGraph', params: { fromResult: 't1', source: 'planner.format' }, deps: ['t1'], requiresApproval: false },
        {
          id: 't3',
          agent: 'format',
          tool: 'llm.planFormat',
          description: targetSheets.length > 1
            ? `Prepara formattazione professionale sul modello corrente (${targetSheets.join(', ')})`
            : 'Prepara formattazione professionale sul foglio corrente',
          params: { sheet: targetSheet, sheets: targetSheets, objective, mode: 'finance_cleanup', scope: targetSheets.length > 1 ? 'workbook' : 'sheet', usesResults: ['t1', 't2'] },
          deps: ['t2'],
          requiresApproval: false
        },
        { id: 't4', agent: 'format', tool: 'excel.applyFormat', description: 'Applica formattazione', params: { fromResult: 't3', sheet: targetSheet }, deps: ['t3'], requiresApproval: false }
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
        params: { maxRows: 100, maxCols: 32, includeFormulas: true },
        deps: [],
        requiresApproval: false
      },
      {
        id: 't2',
        agent: 'data',
        tool: 'workbook.buildGraph',
        description: 'Costruisci WorkbookGraph per capire dipendenze e rischi prima della modifica',
        params: { fromResult: 't1', source: 'planner.incremental' },
        deps: ['t1'],
        requiresApproval: false
      },
      {
        id: 't3',
        agent: 'data',
        tool: 'workbook.readSheet',
        description: 'Leggi foglio attivo per contesto',
        params: { sheet: activeSheet, maxRows: 30, maxCols: 12 },
        deps: ['t2'],
        requiresApproval: false
      }
    ];
    let nextId = 4;
    const deps = ['t2', 't3'];

    // If formatting-related modification, only run format agent
    if (['formatta', 'format', 'stile', 'colore', 'color', 'riformatta'].some(k => lowerObjective.includes(k))) {
      const targetSheets = getContinuityTargetSheets(context, activeSheet);
      const targetSheet = targetSheets.includes(activeSheet) ? activeSheet : (targetSheets[0] || activeSheet);
      tasks.push({
        id: `t${nextId}`,
        agent: 'format',
        tool: 'llm.planFormat',
        description: `Aggiorna formattazione: ${objective}`,
        params: { sheet: targetSheet, sheets: targetSheets, objective, mode: 'finance_cleanup', scope: targetSheets.length > 1 ? 'workbook' : 'sheet', usesResults: ['t1', 't2', 't3'] },
        deps,
        requiresApproval: false
      });
      tasks.push({
        id: `t${nextId + 1}`,
        agent: 'format',
        tool: 'excel.applyFormat',
        description: 'Applica formattazione aggiornata',
        params: { fromResult: `t${nextId}`, sheet: targetSheet },
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
        params: { sheet: activeSheet, objective, mode: 'repair_existing_model', section: 'full_model_review', usesResults: ['t1', 't2', 't3'] },
        deps,
        requiresApproval: false
      });
      tasks.push({
        id: `t${nextId + 1}`,
        agent: 'format',
        tool: 'llm.planFormat',
        description: 'Mantieni/pulisci formattazione dopo modifica',
        params: { sheet: activeSheet, objective, mode: 'finance_cleanup', scope: 'workbook', usesResults: ['t1', 't2', 't3'] },
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

  const shouldBuildFullDcf = !isModification && (isDcf || wantsValuation || hasLocalFinancials) && (
    wantsNewModel ||
    wantsCompletion ||
    hasLocalFinancials ||
    equityIntent.isPublicCompanyTarget ||
    lowerObjective.includes('full') ||
    lowerObjective.includes('completo')
  );

  if (shouldBuildFullDcf) {
    return buildAgenticDcfPlan(objective, context, equityIntent);
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
        params: {
          sheet: 'DCF',
          sheets: desiredSheets,
          objective,
          mode: 'institutional_finance',
          scope: 'workbook',
          usesResults: [...Object.values(sheetTaskIds), ...formulaDeps]
        },
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
        params: { maxRows: 100, maxCols: 32, includeFormulas: true },
        deps: [],
        requiresApproval: false
      },
      {
        id: 't2',
        agent: 'data',
        tool: 'workbook.buildGraph',
        description: 'Costruisci WorkbookGraph per analisi multi-foglio e dipendenze formule',
        params: { fromResult: 't1', source: 'planner.generic_repair' },
        deps: ['t1'],
        requiresApproval: false
      },
      {
        id: 't3',
        agent: 'data',
        tool: 'workbook.readSheet',
        description: `Leggi il foglio attivo ${activeSheet}`,
        params: { sheet: activeSheet, maxRows: 30, maxCols: 12 },
        deps: ['t2'],
        requiresApproval: false
      },
      {
        id: 't4',
        agent: 'formula',
        tool: 'llm.writeFormulas',
        description: 'Analizza e correggi formule e riferimenti del modello nel foglio attivo',
        params: { sheet: activeSheet, objective, mode: 'repair_existing_model', section: 'full_model_review', usesResults: ['t1', 't2', 't3'] },
        deps: ['t3'],
        requiresApproval: false
      },
      {
        id: 't5',
        agent: 'format',
        tool: 'llm.planFormat',
        description: 'Prepara una pulizia visiva professionale del modello',
        params: { sheet: activeSheet, objective, mode: 'finance_cleanup', scope: 'workbook', usesResults: ['t1', 't2', 't3', 't4'] },
        deps: ['t4'],
        requiresApproval: false
      },
      {
        id: 't6',
        agent: 'format',
        tool: 'excel.applyFormat',
        description: 'Applica la formattazione proposta',
        params: { fromResult: 't5', sheet: activeSheet },
        deps: ['t5'],
        requiresApproval: false
      }
    ]
  };
}

function inferAgent(toolName) {
  if (toolName.startsWith('yahoo.')) return 'data';
  if (toolName.startsWith('openbb.')) return 'data';
  if (toolName.startsWith('finance.dcf.')) return 'formula';
  if (toolName.startsWith('workbook.') || toolName === 'requestUserInput' || toolName === 'requestPermissions') return 'data';
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
    'buildgraph': 'workbook.buildGraph',
    'workbookgraph': 'workbook.buildGraph',
    'scandeep': 'workbook.scanDeep',
    'readsheet': 'workbook.readSheet',
    'readrange': 'workbook.readRange'
  };
  const key = String(toolName).toLowerCase().replace(/[^a-z0-9]/g, '');
  return fuzzyMap[key] || toolName;
}

function taskAnalystDepthSection(task, planObjective = '') {
  const params = task.params || {};
  const haystack = `${planObjective} ${task.description || ''} ${params.objective || ''} ${params.model || ''} ${params.mode || ''} ${params.section || ''}`.toLowerCase();
  if (task.tool === 'finance.dcf.buildSection') return params.section || 'dcf';
  if (task.tool === 'llm.planFormat') return 'format';
  if (task.tool === 'llm.planLayout' && /(dcf|valuation|valutazione|finance|financial|wacc|modello)/.test(haystack)) return 'shell';
  if (task.tool === 'llm.writeFormulas' && /(dcf|valuation|valutazione|finance|financial|wacc|sensitivity|scenario|modello|model|repair|audit|review|formula)/.test(haystack)) {
    return params.section || params.mode || 'audit';
  }
  return null;
}

function applyAnalystDepthDefaults(task, planObjective = '') {
  const section = taskAnalystDepthSection(task, planObjective);
  if (!section) return task;
  const params = task.params && typeof task.params === 'object' ? { ...task.params } : {};
  if (!params.analysisDepth) params.analysisDepth = 'institutional';
  if (!params.analystDepth) params.analystDepth = getAnalystDepth(section);
  return { ...task, params };
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
    const withDepth = applyAnalystDepthDefaults(normalized, result.objective || '');

    if (taskMap.has(withDepth.id)) {
      throw new Error(`Planner ha restituito task duplicato: ${withDepth.id}`);
    }
    if (!withDepth.tool || !KNOWN_TOOLS.has(withDepth.tool)) {
      throw new Error(`Tool non valido nel piano: ${withDepth.tool || '(mancante)'}`);
    }

    taskMap.set(withDepth.id, withDepth);
    return withDepth;
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

function isAiManagedPlanningCandidate(objective = '', context = {}, domainPlan = null) {
  if (!domainPlan || !Array.isArray(domainPlan.tasks)) return false;
  const hasDcfRuntime = domainPlan.tasks.some(task => task.tool === 'finance.dcf.buildSection');
  if (!hasDcfRuntime) return false;
  const lowerObjective = String(objective || '').toLowerCase();
  const complexIntent = [
    'valuation',
    'valutazione',
    'full',
    'completa',
    'completo',
    'analizza',
    'analisi',
    'azienda',
    'company',
    'dcf',
    'modello'
  ].some(keyword => lowerObjective.includes(keyword));
  return complexIntent || workbookHasLocalFinancials(context);
}

function shouldUseDomainPlaybookFirst(turnId, options = {}, objective = '', context = {}, domainPlan = null) {
  if (options.forceLLMPlanner) return false;
  if (options.domainPlaybookFirst === true) return true;
  if (process.env.PLANNER_DOMAIN_FIRST === 'true') return true;
  if (process.env.PLANNER_LLM_FIRST === 'true') return false;
  if (!turnId) return true;
  if (process.env.AI_MANAGED_PLANNING === 'false') return true;
  if (isAiManagedPlanningCandidate(objective, context, domainPlan)) return false;
  return true;
}

function compactDomainPlanForPrompt(domainPlan) {
  if (!domainPlan || !Array.isArray(domainPlan.tasks)) return null;
  const tasks = domainPlan.tasks.map(task => ({
    id: task.id,
    agent: task.agent,
    tool: task.tool,
    description: task.description,
    section: task.params?.section,
    deps: task.deps || [],
    sourcePriority: task.params?.sourcePriority,
    mode: task.params?.mode
  }));
  return {
    intent: 'reference_playbook_not_a_forced_plan',
    rules: [
      'AI owns the plan: choose the right steps from workbook context and user objective.',
      'Use workbook data first when local financials are present; avoid external market data unless the user named a public ticker or a needed input is missing.',
      'For full valuation/DCF builds prefer finance.dcf.buildSection sections over low-level llm.writeFormulas microtasks.',
      'If you deviate from this playbook, keep the plan at least as complete: sources, assumptions, WACC, DCF, sensitivity, scenarios, summary, audit, formatting.'
    ],
    candidateTasks: tasks
  };
}

function isWeakFinancePlan(normalized, domainPlan) {
  if (!normalized || !domainPlan || !Array.isArray(normalized.tasks) || !Array.isArray(domainPlan.tasks)) {
    return false;
  }

  const domainSections = domainPlan.tasks
    .filter(task => task.tool === 'finance.dcf.buildSection')
    .map(task => task.params?.section)
    .filter(Boolean);
  const isDcfDomainPlan = domainSections.includes('dcf') && domainSections.includes('assumptions');
  if (!isDcfDomainPlan) return false;

  const hasFullModelReview = normalized.tasks.some(task =>
    task.tool === 'llm.writeFormulas' && task.params?.section === 'full_model_review'
  );
  if (hasFullModelReview) return true;

  const normalizedSections = normalized.tasks
    .filter(task => task.tool === 'finance.dcf.buildSection')
    .map(task => task.params?.section)
    .filter(Boolean);
  const legacyFormulaBuilds = normalized.tasks.filter(task =>
    task.tool === 'llm.writeFormulas' && task.params?.mode === 'build_finance_model'
  );
  const legacyDcfLayout = normalized.tasks.some(task =>
    task.tool === 'llm.planLayout' && String(task.params?.model || '').toLowerCase() === 'dcf'
  );
  if (normalizedSections.length === 0 && (legacyFormulaBuilds.length >= 3 || legacyDcfLayout)) return true;

  const hasCoreDcfSections = ['assumptions', 'wacc', 'dcf', 'sensitivity'].every(section =>
    normalizedSections.includes(section)
  );
  const hasData = normalized.tasks.some(task => task.tool === 'yahoo.quote' || task.tool === 'yahoo.fundamentals');
  const hasWorkbookRead = normalized.tasks.some(task => task.tool === 'workbook.readWorkbook');

  if (!hasCoreDcfSections && normalized.tasks.length < 10) return true;
  if (!hasData && domainPlan.tasks.some(task => task.tool.startsWith('yahoo.'))) return true;
  if (!hasWorkbookRead) return true;

  return false;
}

function prepareNormalizedPlan(rawPlan, planningContext = {}, objective = '') {
  let normalized = normalizeAndValidatePlan(rawPlan);
  normalized = enforceWorkbookFirstPlan(normalized, planningContext, objective);
  normalized = ensureWorkbookUnderstandingPlan(normalized, planningContext, objective);
  ensureNoCycles(normalized.tasks);
  return normalized;
}

function normalizeDomainPlan(domainPlan, cacheKey, objectiveTokens, planningContext = {}, objective = '') {
  const normalized = prepareNormalizedPlan(domainPlan, planningContext, objective);
  setCachedPlan(cacheKey, normalized, objectiveTokens);
  return normalized;
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
  const domainPlan = buildFinanceFallbackPlan(objective, planningContext);
  const plannerModel = options.modelOverride || PLANNER_MODEL || undefined;

  // Domain playbook: fast path for deterministic contexts; for live complex
  // finance turns the LLM planner sees it as a reference and still decides.
  if (domainPlan && shouldUseDomainPlaybookFirst(turnId, options, objective, planningContext, domainPlan)) {
    logger.info('[Planner] Domain playbook attivato');
    return normalizeDomainPlan(domainPlan, cacheKey, objectiveTokens, planningContext, objective);
  }

  const conversationCtx = planningContext.conversationHistory || '';
  const recentSheets = Array.isArray(planningContext.recentSheets) && planningContext.recentSheets.length > 0
    ? `Fogli creati di recente: ${planningContext.recentSheets.join(', ')}\n`
    : '';
  const domainGuide = compactDomainPlanForPrompt(domainPlan);
  const domainGuideText = domainGuide
    ? `\n\nPlaybook di riferimento disponibile al runtime (NON è un piano obbligatorio: usalo come set di primitive e guardrail; tu resti responsabile di decidere cosa fare):\n${JSON.stringify(domainGuide, null, 2)}`
    : '';
  const continuityInstruction = planningContext.parentPlan || planningContext.parentResults
    ? 'CONTESTO DI CONTINUITA: questo turn ha un parent turn. Usa parentPlan, parentResults, lastModelState e recentSheets per lavorare in modo incrementale sul modello gia creato. Durante l esecuzione i risultati del parent sono disponibili come usesResults/result key "parent:<taskId>" (vedi parentResults.results.*.resultKey). Se la richiesta e una modifica (colori, formattazione, formule, assunzioni, fix), non ricreare il workbook: identifica i fogli/azioni gia esistenti e pianifica solo lettura minima + modifica mirata + verifica.\n'
    : '';
  const userPromptBase = `${conversationCtx}${recentSheets}${continuityInstruction}Crea un piano di esecuzione per: "${objective}".\n\nContesto Excel attuale (compattato):\n${JSON.stringify(planningContext, null, 2)}${domainGuideText}`;
  logger.info('[Planner] Chiamata LLM in corso...');

  // Attempt streaming first if turnId is provided (for progress UX)
  if (turnId) {
    try {
      const start = Date.now();
      const accumulated = await callLLMStreaming({
        system: PLANNER_SYSTEM_PROMPT,
        userText: userPromptBase,
        timeoutMs: PLANNER_TIMEOUT_MS,
        modelOverride: plannerModel,
        label: 'Planner LLM stream',
        onChunk: (delta, text, isDone) => {
          if (delta || isDone) {
            streaming.sendLLMProgress(turnId, text, isDone);
          }
        },
        thinkingDisabled: true
      });
      const elapsed = Date.now() - start;
      logger.info(`[Planner] LLM stream done in ${elapsed}ms (${accumulated.length} chars)`);

      let result = tryParsePlan(accumulated);
      let normalized = prepareNormalizedPlan(result, planningContext, objective);
      if (isWeakFinancePlan(normalized, domainPlan)) {
        logger.warn('[Planner] Piano LLM finance troppo debole; uso il domain playbook agentico');
        return normalizeDomainPlan(domainPlan, cacheKey, objectiveTokens, planningContext, objective);
      }
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
        cachePrompt: true,
        thinkingDisabled: true
      });
      const elapsed = Date.now() - start;

      if (result && result.jsonError) {
        result = tryParsePlan(result);
      }

      let normalized = prepareNormalizedPlan(result, planningContext, objective);
      if (isWeakFinancePlan(normalized, domainPlan)) {
        logger.warn('[Planner] Piano LLM finance troppo debole; uso il domain playbook agentico');
        return normalizeDomainPlan(domainPlan, cacheKey, objectiveTokens, planningContext, objective);
      }
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

  if (domainPlan) {
    logger.warn(`[Planner] Fallback euristico attivato dopo errore LLM: ${lastError.message}`);
    return normalizeDomainPlan(domainPlan, cacheKey, objectiveTokens, planningContext, objective);
  }
  throw lastError;
}

module.exports = {
  plan,
  compactPlanningContext,
  enforceWorkbookFirstPlan,
  ensureWorkbookUnderstandingPlan,
  workbookHasLocalFinancials,
  shouldUseDomainPlaybookFirst,
  compactDomainPlanForPrompt
};
