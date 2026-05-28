const { callLLM } = require('../tools/llm');
const logger = require('../utils/logger');
const { validateTaskOutput } = require('../agents/critic');
const { getWikiContextForPrompt } = require('../wiki/loader');
const { buildDcfSection, inferDcfInputs } = require('./dcfTemplate');
const { formatAnalystDepthForPrompt, getAnalystDepth } = require('./analystDepth');
const { inferWorkbookSchemaWithAi } = require('./workbookAiSchema');
const {
  getModelSectionContract,
  hasDeterministicTemplate,
  getModelDefaultSheets,
  MODEL_TYPES: CATALOG_MODEL_TYPES
} = require('./financeModelCatalog');

const DCF_AI_TIMEOUT_MS = Number(process.env.DCF_AI_TIMEOUT_MS) || 600000;
const DCF_AI_FALLBACK_TIMEOUT_MS = Number(process.env.DCF_AI_FALLBACK_TIMEOUT_MS) || 360000;

const DCF_SHEETS = ['Summary', 'Sources', 'Assumptions', 'WACC', 'DCF', 'Sensitivity', 'Scenarios', 'Audit'];
const AI_SECTIONS = new Set([
  'assumptions', 'wacc', 'dcf', 'projection', 'sensitivity',
  'scenarios', 'scenario', 'summary', 'output', 'audit', 'checks',
  'sources', 'source', 'research'
]);
const AI_RUNTIME_ONLY_SECTIONS = new Set(['shell', 'format']);
const DCF_DETERMINISTIC_FAST_PATH_SECTIONS = new Set(['shell', 'sources', 'source', 'research', 'format']);
const SECTION_REQUIREMENTS = {
  assumptions: {
    sheet: 'Assumptions',
    minCells: 110,
    required: [
      'B10', 'B11', 'B12', 'B13', 'B14', 'B15',
      'B18', 'B19', 'B20', 'B21', 'B22', 'B23',
      'B26', 'B27', 'B28', 'B29', 'B30',
      'B33', 'B34', 'B35', 'B36', 'B37',
      'A40', 'A42', 'B42', 'A47', 'B47', 'B52', 'B53', 'B54',
      'C10', 'C11', 'C12', 'C14', 'C23', 'C26', 'C28', 'C33', 'C37',
      'D10', 'D11', 'D12', 'D14', 'D23', 'D26', 'D28', 'D33', 'D37'
    ],
    mustMatchTemplate: [
      'B10', 'B11', 'B12', 'B13', 'B14', 'B15',
      'B18', 'B19', 'B20', 'B21', 'B22', 'B23',
      'B26', 'B27', 'B28', 'B29', 'B30',
      'B33', 'B34', 'B35', 'B36', 'B37',
      'B52', 'B53', 'B54'
    ]
  },
  wacc: {
    sheet: 'WACC',
    minCells: 30,
    required: ['B4', 'B5', 'B6', 'B7', 'B10', 'B11', 'B12', 'B15', 'B16', 'B17', 'B19', 'B22', 'B23', 'B26', 'B27', 'B28', 'B29'],
    mustMatchTemplate: ['B4', 'B5', 'B6', 'B7', 'B10', 'B11', 'B12', 'B15', 'B16', 'B17', 'B19', 'B26', 'B27', 'B28', 'B29']
  },
  dcf: {
    sheet: 'DCF',
    minCells: 120,
    required: ['B5', 'C5', 'G20', 'C24', 'G24', 'H27', 'H28', 'H30', 'H33', 'H35', 'H40'],
    mustMatchTemplate: ['B5', 'C5', 'G20', 'C24', 'G24', 'H27', 'H28', 'H30', 'H33', 'H35', 'H40']
  },
  projection: {
    sheet: 'DCF',
    minCells: 120,
    required: ['B5', 'C5', 'G20', 'C24', 'G24', 'H27', 'H28', 'H30', 'H33', 'H35', 'H40'],
    mustMatchTemplate: ['B5', 'C5', 'G20', 'C24', 'G24', 'H27', 'H28', 'H30', 'H33', 'H35', 'H40']
  },
  sensitivity: {
    sheet: 'Sensitivity',
    minCells: 60,
    required: ['B4', 'C4', 'G4', 'B5', 'C5', 'G9', 'B13', 'C13', 'G13', 'B14', 'C14', 'G18'],
    mustMatchTemplate: ['C5', 'G9', 'C14', 'G18']
  }
};

const DCF_SECTION_SYSTEM_PROMPT = `You are an expert investment-banking analyst and Excel model builder embedded in Microsoft Excel.

You build one DCF workbook section at a time. The workbook, not chat, is the deliverable.

Return ONLY valid JSON. No markdown. No prose.

Output schema:
{
  "actions": [
    {
      "type": "setCellRange",
      "sheet": "Assumptions",
      "cells": {
        "A1": { "value": "Title", "cellStyles": { "bold": true } },
        "B10": { "value": 391035, "note": "Source: Yahoo Finance via app data; verify before relying." },
        "B37": { "formula": "=B35*B36" }
      },
      "allow_overwrite": true
    }
  ]
}

Operational rules:
1. Produce exactly one logical section. Prefer one setCellRange action per sheet section.
2. Every visible row must be auditable: professional label in Column A or a clear table header.
3. Put calculations in Excel formulas. Do not compute final valuation numbers in chat or hardcode them into formulas.
4. Business assumptions belong in visible input cells; downstream formulas must reference those cells.
5. Use absolute references for assumptions and cross-sheet drivers.
6. Do not use Excel comments/notes. If source text is needed, make it visible in nearby cells or labels.
7. Sensitivity tables must use direct formulas and an odd-sized grid around the base case.
8. If prior critic feedback is supplied, fix those exact issues while preserving the schema.
9. Use only supported action types: setCellRange, setCellValue, runFormula, setCellFormat, addConditionalFormat, createSheet.
10. Excel formulas must start with "=" and use valid A1 references.
11. Apply the analyst-depth playbook for the section. Do not collapse methodology into one or two generic rows.
12. On the Assumptions sheet, every key input row must include side-by-side methodology: Column C = how the value was derived, Column D = source/review status.`;

const SECTION_CONTRACTS = {
  assumptions: `Build only the Assumptions sheet. Include company/source, historical market inputs, projection assumptions, WACC inputs, and equity bridge inputs. Use values for inputs and formulas only where a calculation is required, such as current market cap. For every assumption row, add Column C "How Derived" and Column D "Source / Review" explaining the method, source priority, fallback logic and analyst-review status.`,
  wacc: `Build only the WACC sheet. Pull inputs from Assumptions. Include CAPM cost of equity, after-tax cost of debt, debt/equity weights, final WACC, and a beta evidence section that compares observed beta with peer/sector beta, unlevering and relevering peer beta to target D/E before selecting beta.`,
  dcf: `Build only the DCF sheet. Include five forecast years, terminal value, enterprise value, equity bridge, implied share price, current price, premium/discount, and a bridge check.`,
  projection: `Build only the DCF projection sheet content. Include five forecast years, terminal value, enterprise value, equity bridge, implied share price, current price, premium/discount, and a bridge check.`,
  sensitivity: `Build only the Sensitivity sheet. Include WACC x terminal-growth tables for implied share price and enterprise value. Use formulas, not Excel data-table syntax.`,
  scenarios: `Build only the Scenarios sheet. Create downside/base/upside scenario layer with scenario-specific driver overrides (revenue growth, EBITDA margin, terminal growth, WACC). Reference Assumptions and DCF cells so each scenario recomputes implied share price using formulas, not hardcoded outputs. Include a scenario selector and INDEX/CHOOSE-style switching for live valuation under each case.`,
  summary: `Build only the Summary sheet (investment-committee output). Pull DCF implied price, current price, premium/discount, EV bridge, sensitivity midpoint, scenario range, and key drivers from Assumptions/WACC/DCF/Sensitivity/Scenarios using formulas. Add a one-line recommendation cell and key-driver commentary rows that reference live values, not static text.`,
  audit: `Build only the Audit sheet. Write executable formula checks (=IF(condition,"OK","ERR")) covering: assumption ranges (margins 0-100%, tax 0-50%, terminal growth < WACC), bridge integrity (EV = sum of PV + TV PV; Equity = EV - Debt + Cash), formula coverage across forecast years, cross-sheet reference integrity, and circular-reference flags. Use formulas only; no static "OK" strings. Include an aggregate pass/fail counter at the top.`,
  sources: `Build only the Sources sheet. Catalog every external and workbook data input used: data field, value, source URL/feed, timestamp, confidence/review status. Use formulas to pull live values from Assumptions where they originate, so Sources stays in sync. Add a data-quality summary row counting verified vs. unverified inputs.`,
  shell: `Create the institutional DCF workbook shell. Use createSheet actions for: Summary, Sources, Assumptions, WACC, DCF, Sensitivity, Scenarios, Audit. Add a one-line title and section markers per sheet using setCellRange (headers only, no calculations). Skip any sheet already present in workbook context.`,
  format: `Apply professional workbook formatting only. Do not change formulas or values. Use setCellFormat and addConditionalFormat actions with explicit sheet names. Make headers, section bands, input cells, formula cells, output cells, notes/methodology columns, and sensitivity/scenario grids visually distinct and readable across the full DCF workbook.`
};

const FOCUS_AREA_CONTRACTS = {
  company_market: `Focus on Assumptions rows 1-22 ONLY. Build: workbook title (A1), company identity block (ticker, company name, sector, country, currency, reporting date), current market block (price, shares out, market cap, EV bridge inputs - net debt, minority interest, cash), and historical anchor row (last reported revenue, EBITDA margin, capex/sales). For every input, populate Column C (How Derived) and Column D (Source / Review) with concrete methodology and source citation. Do NOT write into rows >=23.`,
  revenue_drivers: `Focus on Assumptions rows 23-40 ONLY. Build the revenue projection driver block: organic growth rate per forecast year, price/volume split (when relevant), product/segment mix percentages, M&A contribution toggle. Cells must be visible inputs (no hidden formulas). For each row, populate Column C (How Derived) and Column D (Source / Review) explaining whether the value comes from consensus, management guidance, peer average, or analyst judgment. Do NOT write into rows <23 or >=41.`,
  costs_margins: `Focus on Assumptions rows 41-58 ONLY. Build cost structure assumptions: COGS as % revenue, gross margin %, opex breakdown (SG&A, R&D, other), EBITDA margin, D&A as % revenue or as % capex base, stock-based comp policy. Visible inputs only. Column C (How Derived) and Column D (Source / Review) for each row. Do NOT write into rows <41 or >=59.`,
  capital_working_tax: `Focus on Assumptions rows 59-90 ONLY. Build capital, working capital and financing assumptions: capex as % revenue or absolute schedule, depreciation life, NWC as % revenue or days-based (DSO, DIO, DPO), effective tax rate, terminal growth rate, debt outstanding, debt cost rate, dividend/buyback policy. Visible inputs. Column C/D per row. Do NOT write into rows <59.`,
  cost_of_equity: `Focus on WACC sheet rows 1-13 ONLY. Build cost of equity block: risk-free rate (with source - typically 10y Treasury), equity risk premium (with source - Damodaran/Duff&Phelps), levered beta (initial value - to be cross-checked later), CAPM cost of equity formula (=Rf + Beta*ERP), and a small-cap size premium adjustment row if applicable. Pull risk-free, ERP, beta from Assumptions where they live. Do NOT write rows >=14.`,
  cost_of_debt: `Focus on WACC sheet rows 14-22 ONLY. Build cost of debt block: pre-tax cost of debt (from Assumptions or interest expense / debt), credit spread vs Rf, target debt rating row, effective tax rate (from Assumptions), after-tax cost of debt formula =Kd*(1-t). Do NOT write rows <14 or >=23.`,
  beta_capital_struct: `Focus on WACC sheet rows 23-40 ONLY. Build beta peer cross-check and final WACC: peer beta table (3-5 peers with levered beta, D/E ratio), unlevered beta formula per peer (=BetaL/(1+(1-t)*D/E)), median unlevered beta, relever to target D/E, target capital structure weights, weighted average WACC formula =We*Ke + Wd*Kd*(1-t). Do NOT write rows <23.`,
  revenue_buildup: `Focus on DCF sheet revenue rows (header band + 5-year revenue lines, typically rows 5-12 for the revenue block). Build: forecast year headers (Y1-Y5), revenue line per driver pulling growth from Assumptions, total revenue per year, YoY growth percent per year. Use formulas referencing Assumptions, not hardcoded numbers.`,
  operating_buildup: `Focus on DCF sheet operating bridge rows (typically rows 13-22). Build per forecast year: COGS (formula = Revenue * COGS%), Gross profit, SG&A, R&D, Other opex, EBITDA (formula bridge), D&A, EBIT, tax (=EBIT * effective tax), NOPAT. Reference Assumptions for all % drivers. No hardcoded values.`,
  fcf_bridge: `Focus on DCF sheet FCF bridge rows (typically rows 23-30). Build per year: NOPAT + D&A - Capex - Change in NWC = Unlevered FCF. Capex pulled from Assumptions. NWC delta computed from NWC% * Revenue change. Show explicit subtotals.`,
  valuation: `Focus on DCF sheet valuation block (typically rows 31-45). Build: discount factor per year (=1/(1+WACC)^t), PV of each UFCF, sum PV of explicit period, terminal value (Gordon growth =UFCF_last*(1+g)/(WACC-g) AND exit multiple alternative), PV of terminal value, Enterprise Value, equity bridge (-Debt +Cash -Minority +Associates), Equity Value, shares outstanding, Implied share price, current price, premium/discount %, bridge check row (=EV ?= sum PV + TV PV).`,
  wacc_growth: `Focus on Sensitivity sheet rows 1-18 ONLY. Build WACC (rows) x terminal growth (cols) grid: 5x5 or 7x7 grid around base case, formulas reference DCF valuation with substituted WACC/g via INDEX/MATCH or direct formula injection. Output: implied share price per grid cell, EV per grid cell. Headers in row 3 and column B. Do NOT write rows >=19.`,
  driver_grids: `Focus on Sensitivity sheet rows 19-36 ONLY. Build revenue growth (rows) x EBITDA margin (cols) grid: 5x5, formulas reference DCF with substituted drivers. Output cells show implied share price. Include grid headers.`,
  exit_multiple: `Focus on Sensitivity sheet rows 37-55 ONLY. Build exit EV/EBITDA multiple grid: multiple (rows) x WACC (cols), recomputes implied share price using exit-multiple terminal value (=Final_Year_EBITDA * Multiple). Headers and grid only.`,
  cases: `Focus on Scenarios sheet rows 1-20 ONLY. Build driver override table: 3 columns (Downside, Base, Upside), rows for key drivers (Revenue growth, EBITDA margin, Capex %, Terminal growth, WACC adjustment). Use realistic spreads (e.g., Downside = Base - 200bps growth, etc.). Visible numeric inputs.`,
  selector_output: `Focus on Scenarios sheet rows 21-40 ONLY. Build scenario selector (e.g., B22 dropdown-style input) and live output rows: implied share price per scenario using CHOOSE or INDEX/MATCH against driver table, scenario probability weights (optional), probability-weighted target price. Show all three scenarios side-by-side for transparency.`,
  formula_checks: `Focus on Audit sheet rows 1-22 ONLY. Write executable formula checks (=IF(condition,"OK","ERR")) covering: assumption range bounds (margin 0-100%, tax 0-50%, terminal growth < WACC, growth < 50% per year), bridge integrity (EV = sum PV + TV PV; Equity = EV - Debt + Cash - Minority), forecast horizon coverage, cross-sheet reference integrity (every DCF formula points to existing cells), terminal value sanity (TV/EV < 75%). Include an aggregate counter (=COUNTIF(B:B,"OK") and similar).`,
  business_checks: `Focus on Audit sheet rows 23-45 ONLY. Write formula checks for business reasonableness: gross margin trend (=IF(MIN(forecast_margins)>=Last_Hist_Margin-500bps,"OK","ERR")), EBITDA margin convergence vs peer, ROIC vs WACC (=IF(ROIC>WACC,"OK","ERR")) sustainability test, capex vs D&A long-run ratio, NWC days vs historical, share count growth flag. Each check produces explicit OK/ERR formula output, not static text.`
};

function summarizeValue(value, depth = 0) {
  if (depth > 2) return '[depth-limit]';
  if (Array.isArray(value)) {
    const rows = value.length;
    const cols = Array.isArray(value[0]) ? value[0].length : 1;
    const preview = JSON.stringify(value.slice(0, 2)).slice(0, 220);
    return `[array ${rows}x${cols}] ${preview}`;
  }
  if (!value || typeof value !== 'object') {
    const text = String(value ?? '');
    return text.length > 220 ? `${text.slice(0, 220)}...` : text;
  }
  const entries = Object.entries(value).slice(0, 14);
  return Object.fromEntries(entries.map(([key, entryValue]) => [key, summarizeValue(entryValue, depth + 1)]));
}

function compactResultsForDcf(memory = {}, usesResults = []) {
  const results = memory?.results && typeof memory.results === 'object' ? memory.results : {};
  const keys = Array.isArray(usesResults) && usesResults.length > 0
    ? usesResults.filter(key => Object.prototype.hasOwnProperty.call(results, key))
    : Object.keys(results);

  return Object.fromEntries(keys.map(taskId => {
    const result = results[taskId];
    const actions = Array.isArray(result?.actions) ? result.actions : [];
    return [
      taskId,
      {
        data: summarizeValue(result?.data ?? result),
        actionCount: actions.length,
        actionPreview: actions.slice(0, 5).map(action => ({
          type: action?.type,
          sheet: action?.sheet,
          target: action?.target,
          cellCount: action?.cells && typeof action.cells === 'object' ? Object.keys(action.cells).length : undefined
        }))
      }
    ];
  }));
}

function stripCellSpec(spec) {
  if (!spec || typeof spec !== 'object') return { value: spec };
  const out = {};
  if (Object.prototype.hasOwnProperty.call(spec, 'value')) out.value = spec.value;
  if (Object.prototype.hasOwnProperty.call(spec, 'formula')) out.formula = spec.formula;
  return out;
}

function compactTemplateActions(actions = []) {
  return actions.map(action => {
    if (action?.type !== 'setCellRange' || !action.cells) {
      return {
        type: action?.type,
        sheet: action?.sheet,
        target: action?.target,
        value: action?.value,
        formula: action?.formula
      };
    }
    return {
      type: 'setCellRange',
      sheet: action.sheet,
      allow_overwrite: action.allow_overwrite,
      cells: Object.fromEntries(
        Object.entries(action.cells).map(([addr, spec]) => [addr, stripCellSpec(spec)])
      )
    };
  });
}

function normalizeCellSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { value: spec };
  }
  const normalized = {};
  if (Object.prototype.hasOwnProperty.call(spec, 'value')) normalized.value = spec.value;
  if (Object.prototype.hasOwnProperty.call(spec, 'formula')) normalized.formula = spec.formula;
  if (!normalized.formula && typeof normalized.value === 'string' && normalized.value.trim().startsWith('=')) {
    normalized.formula = normalized.value.trim();
    delete normalized.value;
  }
  if (spec.cellStyles && typeof spec.cellStyles === 'object') normalized.cellStyles = spec.cellStyles;
  if (spec.borderStyles && typeof spec.borderStyles === 'object') normalized.borderStyles = spec.borderStyles;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'value') && !normalized.formula) {
    normalized.value = spec.text ?? spec.label ?? '';
  }
  return normalized;
}

function normalizeActions(rawActions, fallbackSheet) {
  if (!Array.isArray(rawActions)) return [];
  const actions = [];
  for (const action of rawActions) {
    if (!action || typeof action !== 'object') continue;
    if (action.type === 'setCellRange' && action.cells && typeof action.cells === 'object') {
      actions.push({
        type: 'setCellRange',
        sheet: action.sheet || fallbackSheet,
        cells: Object.fromEntries(
          Object.entries(action.cells).map(([addr, spec]) => [addr, normalizeCellSpec(spec)])
        ),
        copyToRange: action.copyToRange,
        allow_overwrite: action.allow_overwrite !== false
      });
      continue;
    }
    if (action.type === 'runFormula') {
      actions.push({
        type: 'runFormula',
        sheet: action.sheet || fallbackSheet,
        target: action.target,
        value: action.value || action.formula
      });
      continue;
    }
    if (action.type === 'setCellValue') {
      actions.push({
        type: 'setCellValue',
        sheet: action.sheet || fallbackSheet,
        target: action.target,
        value: action.value
      });
      continue;
    }
    if (['setCellFormat', 'addConditionalFormat', 'createSheet'].includes(action.type)) {
      actions.push({ ...action, sheet: action.sheet || fallbackSheet });
    }
  }
  return actions.filter(action => {
    if (action.type === 'createSheet') return !!(action.name || action.sheet);
    if (action.type === 'setCellRange') return !!action.sheet && Object.keys(action.cells || {}).length > 0;
    return !!action.sheet && !!action.target;
  });
}

function getSheetCells(actions = [], sheetName) {
  const cells = {};
  for (const action of actions) {
    if (action?.type !== 'setCellRange' || !action.cells) continue;
    if (action.sheet !== sheetName) continue;
    Object.assign(cells, action.cells);
  }
  return cells;
}

function specSignature(spec) {
  if (!spec || typeof spec !== 'object') return JSON.stringify(spec ?? null);
  if (spec.formula !== undefined) return `f:${String(spec.formula).replace(/\s+/g, '').toUpperCase()}`;
  if (spec.value !== undefined) return `v:${JSON.stringify(spec.value)}`;
  return 'empty';
}

function validateDcfSectionContract(section, actions, fallbackActions) {
  const requirement = SECTION_REQUIREMENTS[section];
  if (!requirement) return { ok: true, errors: [] };

  const cells = getSheetCells(actions, requirement.sheet);
  const fallbackCells = getSheetCells(fallbackActions, requirement.sheet);
  const errors = [];
  const cellCount = Object.keys(cells).length;

  if (cellCount < requirement.minCells) {
    errors.push(`${section} returned ${cellCount} cells; minimum complete section is ${requirement.minCells}`);
  }

  for (const address of requirement.required) {
    if (!cells[address]) {
      errors.push(`${section} missing required cell ${requirement.sheet}!${address}`);
    }
  }

  for (const address of requirement.mustMatchTemplate || []) {
    if (!cells[address] || !fallbackCells[address]) continue;
    const actual = specSignature(cells[address]);
    const expected = specSignature(fallbackCells[address]);
    if (actual !== expected) {
      errors.push(`${section} changed protected cell ${requirement.sheet}!${address}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function fallbackWithBuilder(fallback, builder, extra = {}) {
  return {
    ...fallback,
    data: {
      ...(fallback.data || {}),
      builder,
      ...extra
    }
  };
}

function shouldUseAi(params = {}, options = {}) {
  if (process.env.DCF_AI_BUILDER_ENABLED === 'false') return false;
  if (params.mode === 'template' && !options.runtimeAiOnly) return false;
  const section = String(params.section || '').toLowerCase();
  return AI_SECTIONS.has(section) || (options.runtimeAiOnly && AI_RUNTIME_ONLY_SECTIONS.has(section));
}

function isRuntimeAiOnly(memory = {}) {
  return process.env.HARNESS_AI_ONLY !== 'false' && !!memory?.runtime;
}

function allowDeterministicTemplatesInRuntime() {
  return process.env.DCF_ALLOW_TEMPLATE_IN_RUNTIME === 'true';
}

// Section-level role classifier. Bench evidence:
//   - Hard finance reasoning (DCF valuation, WACC math, LBO debt schedule, returns) → builder_hard (pro+think high)
//   - Analytical insight (correlations, business audit, insights, scenarios reasoning) → builder_analytical (flash+think medium)
//   - Structural / mechanical (shell, sources, format, source_data, schema_profile) → builder_structural (flash, no thinking)
const HARD_SECTIONS = new Set([
  // DCF
  'wacc', 'dcf', 'projection',
  // LBO
  'debt_schedule', 'sources_uses', 'returns', 'transaction', 'cash_flow', 'operating_model',
  // M&A
  'accretion_dilution', 'pro_forma', 'synergies', 'financing',
  // Three-statement
  'balance_sheet', 'p_and_l',
  // Credit
  'covenant_tests', 'coverage_ratios',
  // DDM
  'ddm_valuation', 'dividend_forecast'
]);
const HARD_FOCUS_AREAS = new Set([
  'beta_capital_struct', 'cost_of_equity', 'cost_of_debt',
  'fcf_bridge', 'valuation', 'operating_buildup', 'revenue_buildup',
  'wacc_growth', 'exit_multiple', 'driver_grids'
]);
const ANALYTICAL_SECTIONS = new Set([
  // DCF
  'assumptions', 'sensitivity', 'scenarios', 'summary', 'audit', 'checks',
  // Data analysis
  'correlations', 'insights', 'distributions', 'aggregations',
  // Forecasting
  'decomposition', 'forecast', 'backtest',
  // Credit
  'stress_cases',
  // Comps
  'multiples_stats', 'implied_valuation', 'trading_comps', 'transaction_comps'
]);
const ANALYTICAL_FOCUS_AREAS = new Set([
  'business_checks', 'cases', 'selector_output',
  'revenue_drivers', 'costs_margins', 'capital_working_tax', 'company_market'
]);

const CRITIC_SYSTEM_PROMPT = `You are a senior model auditor. Review proposed Excel cell actions (a JSON array of setCellRange/setCellValue/runFormula/createSheet/setCellFormat operations) for an institutional finance / data model.

Check for:
1. Formula correctness: every "=..." formula has valid syntax, references existing addresses, no circular dependencies, no division-by-zero risk without guard.
2. Cross-sheet integrity: cross-sheet references match sheet names that exist in the build plan.
3. Label completeness: every numeric cell row has a descriptive label in column A or adjacent.
4. Coverage: section contract requirements are covered (assumptions present, formulas chained, terminal/bridge formulas closed).
5. Logical consistency: tax rate within 0-50%, growth within reasonable bounds, margins 0-100%.
6. No hardcoded results in cells that should be formula-driven.

Return ONLY JSON: { "ok": boolean, "issues": [{ "sheet": "...", "cell": "...", "severity": "error|warning", "issue": "...", "fix": "..." }] }

Be strict but fair. Only flag real problems. If actions look correct, return { "ok": true, "issues": [] }.`;

async function runAiCritic({ modelType, section, focusArea, actions, sectionContract, inputs, allowedSheets }) {
  if (!Array.isArray(actions) || actions.length === 0) return { ok: false, issues: [{ severity: 'error', issue: 'no_actions' }] };
  const compactActions = compactTemplateActions(actions);
  const userText = [
    `Model: ${modelType}`,
    `Section: ${section}${focusArea ? '.' + focusArea : ''}`,
    `Section contract: ${sectionContract}`,
    `Allowed sheets: ${allowedSheets.join(', ')}`,
    `Inputs context (compact): ${JSON.stringify(inputs).slice(0, 1500)}`,
    `Proposed actions to review:\n${JSON.stringify(compactActions, null, 2).slice(0, 8000)}`,
    'Audit and return JSON only.'
  ].join('\n\n');
  try {
    const result = await callLLM({
      system: CRITIC_SYSTEM_PROMPT,
      userText,
      timeoutMs: Number(process.env.AI_CRITIC_TIMEOUT_MS) || 90000,
      label: `AI critic ${modelType}/${section}`,
      cachePrompt: true,
      role: 'critic'
    });
    if (!result || typeof result !== 'object') return { ok: true, issues: [] };
    return {
      ok: !!result.ok || !Array.isArray(result.issues) || result.issues.length === 0,
      issues: Array.isArray(result.issues) ? result.issues.slice(0, 12) : []
    };
  } catch (err) {
    logger.warn(`[AI Critic] Failed for ${modelType}/${section}: ${err.message}`);
    // Critic failure should not block the build; pass through.
    return { ok: true, issues: [], critic_unavailable: err.message };
  }
}

async function runRefiner({ originalUserText, criticIssues, role }) {
  const refinerSystemPrompt = `${DCF_SECTION_SYSTEM_PROMPT}\n\nIMPORTANT: a prior version of your output was reviewed and found to have issues. Fix EVERY issue listed below while preserving the rest. Return the FULL corrected JSON, not a patch.`;
  const issuesText = criticIssues.map((it, i) => `${i + 1}. [${it.severity || 'issue'}] ${it.sheet ? it.sheet + '!' + (it.cell || '') + ' — ' : ''}${it.issue}${it.fix ? ' → fix: ' + it.fix : ''}`).join('\n');
  const userText = `${originalUserText}\n\nIssues to fix:\n${issuesText}`;
  return callLLM({
    system: refinerSystemPrompt,
    userText,
    timeoutMs: Number(process.env.AI_REFINER_TIMEOUT_MS) || 240000,
    label: 'AI refiner',
    cachePrompt: true,
    role: role || 'refiner'
  });
}

function pickBuilderRole(modelType, section, focusArea) {
  const sec = String(section || '').toLowerCase();
  const focus = String(focusArea || '').toLowerCase();
  if (focus) {
    if (HARD_FOCUS_AREAS.has(focus)) return 'builder_hard';
    if (ANALYTICAL_FOCUS_AREAS.has(focus)) return 'builder_analytical';
  }
  if (HARD_SECTIONS.has(sec)) return 'builder_hard';
  if (ANALYTICAL_SECTIONS.has(sec)) return 'builder_analytical';
  if (['shell', 'sources', 'format', 'formatting', 'source_data', 'schema_profile', 'clean_data', 'peer_set'].includes(sec)) return 'builder_structural';
  return 'builder_analytical';
}

function sheetForSection(section) {
  if (section === 'assumptions') return 'Assumptions';
  if (section === 'wacc') return 'WACC';
  if (section === 'sensitivity') return 'Sensitivity';
  if (section === 'scenarios' || section === 'scenario') return 'Scenarios';
  if (section === 'summary' || section === 'output') return 'Summary';
  if (section === 'audit' || section === 'checks') return 'Audit';
  if (section === 'sources' || section === 'source' || section === 'research') return 'Sources';
  return 'DCF';
}

async function buildDcfSectionAi(params = {}, memory = {}) {
  const modelType = (params.modelType && CATALOG_MODEL_TYPES.includes(params.modelType)) ? params.modelType : 'dcf';
  const isDcf = modelType === 'dcf';
  const section = String(params.section || (isDcf ? 'all' : 'summary')).toLowerCase();
  const focusArea = params.focusArea ? String(params.focusArea).toLowerCase() : null;
  const isGranularSubTask = !!focusArea;
  const hasTemplate = hasDeterministicTemplate(modelType);
  const runtimeAiOnly = isRuntimeAiOnly(memory);
  const useAiSectionBuilder = isDcf ? shouldUseAi(params, { runtimeAiOnly }) : true; // non-DCF models always use pure AI
  const runtimeTemplateAllowed = !runtimeAiOnly || allowDeterministicTemplatesInRuntime();
  const useDeterministicFastPath = isDcf && DCF_DETERMINISTIC_FAST_PATH_SECTIONS.has(section) && runtimeTemplateAllowed;
  const aiSchema = useAiSectionBuilder ? await inferWorkbookSchemaWithAi(params, memory) : null;
  const enrichedParams = aiSchema ? { ...params, aiSchema } : params;
  const enrichedMemory = aiSchema ? { ...memory, aiWorkbookSchema: aiSchema } : memory;
  const allowTemplateAssist = hasTemplate && runtimeTemplateAllowed;
  // Build a deterministic fallback only when the runtime is allowed to use templates.
  const fallback = allowTemplateAssist
    ? buildDcfSection(enrichedParams, enrichedMemory)
    : { data: { model: modelType, section, builder: runtimeAiOnly ? 'ai_only_runtime' : 'no_deterministic_template' }, actions: [] };

  if (!useAiSectionBuilder || useDeterministicFastPath) {
    if (!allowTemplateAssist && fallback.actions.length === 0) {
      throw new Error('Deterministic template path requested, but templates are disabled in live runtime. Use AI-assisted generation instead.');
    }
    const fallbackBuilder = section === 'format'
      ? 'adaptive-format'
      : (useDeterministicFastPath ? 'template-fastpath' : (params.mode === 'template' ? 'template-requested' : 'template'));
    return fallbackWithBuilder(fallback, fallbackBuilder);
  }

  const inputs = isDcf ? inferDcfInputs(enrichedParams, enrichedMemory) : {
    modelType,
    objective: params.objective,
    sheet: params.sheet,
    sheets: params.sheets,
    targetSheets: getModelDefaultSheets(modelType)
  };
  const analystDepth = params.analystDepth && typeof params.analystDepth === 'object'
    ? params.analystDepth
    : (isDcf ? getAnalystDepth(section) : { section, requiredAnalyses: [], visibleOutputs: [] });
  const templateGuide = allowTemplateAssist ? compactTemplateActions(fallback.actions) : null;
  const context = compactResultsForDcf(memory, params.usesResults);
  const wikiQuery = isDcf
    ? `dcf ${section} ${focusArea || ''} excel formulas`.trim()
    : `${modelType} ${section} ${focusArea || ''} excel formulas analyst`.trim();
  const wikiContext = getWikiContextForPrompt(wikiQuery, ['finance', 'excel', 'analytics'], 3500);
  const criticBlock = Array.isArray(params.criticErrors) && params.criticErrors.length > 0
    ? params.criticErrors.map((error, index) => `${index + 1}. ${error}`).join('\n')
    : '';

  const focusContract = focusArea ? (FOCUS_AREA_CONTRACTS[focusArea] || null) : null;
  const headlineSection = focusArea ? `${section}.${focusArea}` : section;
  const sectionContract = isDcf
    ? (SECTION_CONTRACTS[section] || SECTION_CONTRACTS.projection)
    : getModelSectionContract(modelType, section);
  const aiOnlyInstruction = runtimeAiOnly
    ? 'AI-only runtime: do not assume there is a hidden deterministic template. Use the section contract, workbook context, prior task results and finance logic as the source of truth.'
    : '';

  const userText = [
    `Build ${modelType.toUpperCase()} section: ${headlineSection}`,
    `Model type: ${modelType}`,
    `Objective: ${params.objective || `Build a high-quality ${modelType} model`}`,
    `Section contract: ${sectionContract}`,
    focusContract ? `Focused sub-task contract (THIS is what you must produce - do NOT produce the full section):\n${focusContract}` : '',
    isGranularSubTask ? `IMPORTANT: this is a granular sub-task. Only write cells described by the focused contract. Do NOT overwrite cells from other sub-tasks of the same sheet. Use setCellRange with explicit cell addresses that fit your row band only.` : '',
    isDcf ? `Analyst-depth playbook for this section:\n${formatAnalystDepthForPrompt(analystDepth.section || section)}` : '',
    `Inputs / context inferred from workbook+market data:\n${JSON.stringify(inputs, null, 2)}`,
    `Previous task results, compacted (includes prior sub-tasks on this and other sheets — read them to keep formulas and cell addresses consistent):\n${JSON.stringify(context, null, 2)}`,
    aiOnlyInstruction,
    allowTemplateAssist
      ? (isGranularSubTask
          ? `Reference template (do NOT mimic verbatim, it covers the whole section — only the cells matching your focused contract are relevant):\n${JSON.stringify(templateGuide.slice(0, 2), null, 2)}`
          : `Executable template guide. This is the minimum correct structure; improve source notes, labels, and formulas only if you keep the same auditability:\n${JSON.stringify(templateGuide, null, 2)}`)
      : (runtimeAiOnly
          ? `AI-only runtime active. Design the section from first principles using the contract above. Target sheets for this model: ${JSON.stringify(getModelDefaultSheets(modelType))}.`
          : `No deterministic template exists for ${modelType}. Design the section from first principles using the contract above. Target sheets for this model: ${JSON.stringify(getModelDefaultSheets(modelType))}.`),
    criticBlock ? `Previous critic errors to fix:\n${criticBlock}` : '',
    wikiContext ? `Relevant ${modelType}/excel knowledge:\n${wikiContext}` : '',
    'Spend tokens generously. Reason deeply. Return JSON only.'
  ].filter(Boolean).join('\n\n');

  try {
    logger.info(`[DCF AI] Building section "${section}" with AI assistance`);
    // Role-based model selection per section. Hard/analytical/structural maps onto bench results.
    const role = pickBuilderRole(modelType, section, focusArea);
    const llmResult = await callLLM({
      system: DCF_SECTION_SYSTEM_PROMPT,
      userText,
      timeoutMs: DCF_AI_TIMEOUT_MS,
      fallbackTimeoutMs: DCF_AI_FALLBACK_TIMEOUT_MS,
      modelOverride: memory?.llm?.modelOverride || undefined,
      label: `${modelType.toUpperCase()} section ${section}${focusArea ? '.' + focusArea : ''}`,
      cachePrompt: true,
      role
    });

    const rawActions = Array.isArray(llmResult)
      ? llmResult
      : (Array.isArray(llmResult?.actions) ? llmResult.actions : []);
    const actions = normalizeActions(rawActions, sheetForSection(section));
    if (actions.length === 0) {
      throw new Error('AI returned no executable DCF actions');
    }

    const allowedSheets = isDcf ? DCF_SHEETS : getModelDefaultSheets(modelType);
    let finalActions = actions;

    const determCritic = validateTaskOutput({ data: {}, actions: finalActions }, { sheets: allowedSheets, references: new Set() });
    if (!determCritic.ok) {
      const summary = determCritic.errors.map(entry => entry.error).slice(0, 6).join('; ');
      throw new Error(`deterministic critic rejected AI section: ${summary}`);
    }
    if (isDcf && !isGranularSubTask) {
      const contract = validateDcfSectionContract(section, finalActions, fallback.actions);
      if (!contract.ok) {
        throw new Error(`section contract rejected AI output: ${contract.errors.slice(0, 6).join('; ')}`);
      }
    }

    // AI critic + refiner loop (multi-agent verification).
    // Only run on hard / analytical sections where formula correctness matters.
    // Structural sections (shell, sources, format) skip the loop to save latency.
    const aiCriticEnabled = process.env.AI_CRITIC_ENABLED !== 'false';
    const builderRoleForLoop = pickBuilderRole(modelType, section, focusArea);
    const skipCritic = builderRoleForLoop === 'builder_structural';
    let aiCriticReport = null;
    let refinerApplied = false;
    if (aiCriticEnabled && !skipCritic) {
      aiCriticReport = await runAiCritic({ modelType, section, focusArea, actions: finalActions, sectionContract, inputs, allowedSheets });
      const errorIssues = (aiCriticReport.issues || []).filter(it => it.severity === 'error');
      const maxRefinerPasses = Number(process.env.AI_REFINER_MAX_PASSES ?? 1);
      let pass = 0;
      while (errorIssues.length > 0 && pass < maxRefinerPasses) {
        pass++;
        logger.info(`[AI Critic] ${errorIssues.length} errori, refiner pass ${pass}/${maxRefinerPasses}`);
        try {
          const refinerResult = await runRefiner({ originalUserText: userText, criticIssues: errorIssues, role: 'refiner' });
          const refinedRaw = Array.isArray(refinerResult) ? refinerResult : (Array.isArray(refinerResult?.actions) ? refinerResult.actions : []);
          const refinedActions = normalizeActions(refinedRaw, sheetForSection(section));
          if (refinedActions.length === 0) break;
          const refinedDeterm = validateTaskOutput({ data: {}, actions: refinedActions }, { sheets: allowedSheets, references: new Set() });
          if (!refinedDeterm.ok) {
            logger.warn(`[AI Refiner] Refined output failed deterministic critic, keeping original`);
            break;
          }
          finalActions = refinedActions;
          refinerApplied = true;
          // Re-run critic on refined output
          aiCriticReport = await runAiCritic({ modelType, section, focusArea, actions: finalActions, sectionContract, inputs, allowedSheets });
          const newErrors = (aiCriticReport.issues || []).filter(it => it.severity === 'error');
          if (newErrors.length === 0) break;
          errorIssues.length = 0;
          errorIssues.push(...newErrors);
        } catch (refinerErr) {
          logger.warn(`[AI Refiner] Pass ${pass} failed: ${refinerErr.message}`);
          break;
        }
      }
    }

    return {
      data: {
        ...(fallback.data || {}),
        builder: 'ai-assisted',
        modelType,
        section,
        focusArea: focusArea || undefined,
        aiSchemaUsed: !!aiSchema,
        analystDepth,
        fallbackActionCount: fallback.actions.length,
        actionCount: finalActions.length,
        warnings: determCritic.warnings || [],
        aiCritic: aiCriticReport ? {
          ok: aiCriticReport.ok,
          issueCount: (aiCriticReport.issues || []).length,
          issues: (aiCriticReport.issues || []).slice(0, 4),
          refinerApplied,
          critic_unavailable: aiCriticReport.critic_unavailable
        } : null
      },
      actions: finalActions
    };
  } catch (error) {
    if (runtimeAiOnly) {
      logger.warn(`[DCF AI] Section "${section}" failed in AI-only runtime: ${error.message}`);
      throw error;
    }
    logger.warn(`[DCF AI] Section "${section}" fell back to template: ${error.message}`);
    return fallbackWithBuilder(fallback, 'template-fallback', { aiError: error.message, aiSchemaUsed: !!aiSchema });
  }
}

module.exports = {
  buildDcfSectionAi,
  compactResultsForDcf,
  normalizeActions,
  validateDcfSectionContract,
  DCF_SECTION_SYSTEM_PROMPT
};
