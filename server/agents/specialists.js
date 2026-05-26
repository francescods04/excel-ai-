const { callLLM } = require('../tools/llm');
const logger = require('../utils/logger');
const { getWikiContextForPrompt } = require('../wiki/loader');
const { buildProfessionalFormatPlan, classifyFormatIntent } = require('../models/formatTemplate');
const { getAnalystDepth } = require('../models/analystDepth');

const LAYOUT_TIMEOUT_MS = Number(process.env.LAYOUT_TIMEOUT_MS) || 240000;
const LAYOUT_FALLBACK_TIMEOUT_MS = Number(process.env.LAYOUT_FALLBACK_TIMEOUT_MS) || 150000;
const FORMULA_TIMEOUT_MS = Number(process.env.FORMULA_TIMEOUT_MS) || 300000;
const FORMULA_FALLBACK_TIMEOUT_MS = Number(process.env.FORMULA_FALLBACK_TIMEOUT_MS) || 180000;
const FORMULA_SECTION_TIMEOUT_MS = Number(process.env.FORMULA_SECTION_TIMEOUT_MS) || 300000;
const FORMULA_SECTION_FALLBACK_TIMEOUT_MS = Number(process.env.FORMULA_SECTION_FALLBACK_TIMEOUT_MS) || 180000;
const FORMAT_TIMEOUT_MS = Number(process.env.FORMAT_TIMEOUT_MS) || 240000;
const FORMAT_FALLBACK_TIMEOUT_MS = Number(process.env.FORMAT_FALLBACK_TIMEOUT_MS) || 150000;

function summarizeValue(value, depth = 0) {
  if (depth > 2) return '[depth-limit]';
  if (Array.isArray(value)) {
    const rows = value.length;
    const cols = Array.isArray(value[0]) ? value[0].length : 1;
    const preview = JSON.stringify(value.slice(0, 2)).slice(0, 180);
    return `[array ${rows}x${cols}] ${preview}`;
  }
  if (!value || typeof value !== 'object') {
    const text = String(value ?? '');
    return text.length > 180 ? `${text.slice(0, 180)}...` : text;
  }
  const entries = Object.entries(value).slice(0, 10);
  return Object.fromEntries(entries.map(([key, entryValue]) => [key, summarizeValue(entryValue, depth + 1)]));
}

function compactResultsForPrompt(results, usesResults) {
  const safeResults = results && typeof results === 'object' ? results : {};
  const keysToInclude = Array.isArray(usesResults) && usesResults.length > 0
    ? usesResults.filter(k => k in safeResults)
    : Object.keys(safeResults);
  return Object.fromEntries(
    keysToInclude.map(taskId => {
      const result = safeResults[taskId];
      if (!result) return [taskId, null];
      const actions = Array.isArray(result.actions) ? result.actions : [];
      return [
        taskId,
        {
          data: summarizeValue(result.data ?? result),
          actionCount: actions.length,
          actionPreview: actions.slice(0, 4).map(action => ({
            type: action.type,
            sheet: action.sheet,
            target: action.target
          }))
        }
      ];
    })
  );
}

function formatDepthForPrompt(depth) {
  const entry = depth && typeof depth === 'object' ? depth : getAnalystDepth(depth || 'dcf');
  return [
    `Depth level: ${entry.depthLevel || 'institutional'}`,
    `Section: ${entry.section || 'dcf'}`,
    `Method: ${entry.method || ''}`,
    `Required analyses:\n- ${(entry.requiredAnalyses || []).join('\n- ')}`,
    `Sanity checks:\n- ${(entry.sanityChecks || []).join('\n- ')}`,
    `Visible outputs:\n- ${(entry.visibleOutputs || []).join('\n- ')}`
  ].join('\n');
}

/* ---------- Investment Banking Grade System Prompts ---------- */

const LAYOUT_SYSTEM_PROMPT = `You are a Senior Investment Banking Associate designing Excel financial models at Goldman Sachs / JPMorgan.

Your task: design the exact cell layout for an institutional-grade DCF or valuation model.

RESPOND ONLY with valid JSON. No markdown, no commentary.

Output schema:
{
  "sheets": [
    {
      "name": "Assumptions",
      "sections": [
        {
          "title": "Revenue & Margin Drivers",
          "startCell": "A1",
          "rows": [
            { "label": "Revenue ($M)", "cells": ["A2","B2","C2","D2","E2","F2"], "type": "input" }
          ]
        }
      ]
    }
  ],
  "cellMap": {
    "A1": { "sheet": "Assumptions", "value": "DCF Model Assumptions", "type": "header" }
  }
}

MANDATORY LAYOUT RULES (violate = model rejected by VP):
1. Column A must contain DESCRIPTIVE LABELS for every single data row. No exceptions.
2. Row 1: Model title (merge A1:D1, bold, grey header).
3. Row 2: Year headers (e.g., "", "2024A", "2025E", "2026E", "2027E", "2028E", "2029E").
4. Input cells: Column B (or C if label is in A). Use blue shading convention.
5. Calculated cells: white background, black font.
6. Total / subtotal rows: bold, top border.
7. Percentage inputs: enter as decimals (0.25 = 25%).
8. Currency inputs: in millions ($M) unless specified otherwise.
9. Never hardcode numbers in formulas — always reference Assumptions sheet or prior year.
10. Every sheet must have a "Check" row at the bottom verifying DCF = Equity Value + Net Debt.`;

const FORMULA_SYSTEM_PROMPT = `You are a Senior Investment Banking Associate building Excel formulas for a DCF model at Goldman Sachs / JPMorgan.

CRITICAL: You must generate BOTH labels (setCellValue in Column A) AND formulas (runFormula) for EVERY row. Never output naked numbers without labels.

RESPOND ONLY with valid JSON. Schema:
{
  "actions": [
    { "type": "setCellValue", "sheet": "DCF", "target": "A5", "value": "Revenue ($M)" },
    { "type": "runFormula",   "sheet": "DCF", "target": "B5", "value": "=Assumptions!B3" },
    { "type": "runFormula",   "sheet": "DCF", "target": "C5", "value": "=B5*(1+Assumptions!$B$4)" }
  ]
}

FORMULA RULES (violate = model rejected):
1. EVERY data row MUST start with a setCellValue label in Column A. Use professional IB terminology in English.
2. ALL formulas must reference cells — never hardcode constants like 0.25 or 1000.
3. Use absolute references ($B$4) for assumptions that don't change across columns.
4. Use relative references (B5) for prior-year values that flow across columns.
5. Build formulas in this exact order for DCF:
   Revenue → EBITDA → D&A → EBIT → Tax → NOPAT → (+D&A) → (-CapEx) → (-Change in NWC) → Unlevered FCF
6. Terminal Value (Gordon Growth): =FCF_last * (1+g) / (WACC - g)
7. Discount Factor: =1/(1+WACC)^year_number
8. PV of FCF: =FCF * DiscountFactor
9. Enterprise Value: =SUM(PV_of_FCFs) + PV_of_TV
10. Equity Value: =EV + Cash - Total Debt
11. Implied Share Price: =EquityValue / SharesOutstanding
12. WACC formulas in WACC sheet:
    Cost of Equity (CAPM): =RiskFreeRate + Beta * MarketRiskPremium
    After-Tax Cost of Debt: =PreTaxCostOfDebt * (1 - TaxRate)
    WACC: =(Equity/(Equity+Debt))*CostOfEquity + (Debt/(Equity+Debt))*CostOfDebt*(1-TaxRate)
13. If existing data is found in the workbook (e.g., EBITDA = 150 in cell B3), REFERENCE that cell instead of using a placeholder.

LABEL NAMING CONVENTION (English, professional):
- Revenue ($M), Revenue Growth (%), EBITDA ($M), EBITDA Margin (%)
- D&A ($M), EBIT ($M), EBIT Margin (%)
- Tax ($M), Tax Rate (%), NOPAT ($M)
- CapEx ($M), CapEx % of Revenue (%)
- Change in NWC ($M), NWC % of Revenue (%)
- Unlevered FCF ($M), Discount Factor, PV of FCF ($M)
- Terminal Value ($M), PV of Terminal Value ($M)
- Enterprise Value ($M), (+) Cash & Equivalents ($M), (-) Total Debt ($M)
- Equity Value ($M), Shares Outstanding (M), Implied Share Price ($)
- Cost of Equity (%), Cost of Debt (%), WACC (%)

EXAMPLE — DCF Revenue Build (first 2 years shown, extend to 5+Terminal):
{ "type": "setCellValue", "sheet": "DCF", "target": "A5", "value": "Revenue ($M)" }
{ "type": "runFormula",   "sheet": "DCF", "target": "B5", "value": "=Assumptions!B3" }
{ "type": "runFormula",   "sheet": "DCF", "target": "C5", "value": "=B5*(1+Assumptions!$B$4)" }
{ "type": "setCellValue", "sheet": "DCF", "target": "A6", "value": "EBITDA ($M)" }
{ "type": "runFormula",   "sheet": "DCF", "target": "B6", "value": "=B5*Assumptions!$B$5" }
{ "type": "runFormula",   "sheet": "DCF", "target": "C6", "value": "=C5*Assumptions!$B$5" }

Remember: labels in English, formulas referencing cells, no hardcoded numbers.`;

const FORMULA_SECTION_SYSTEM_PROMPT = `You are an IB Associate writing formulas for ONE SECTION of a DCF model.

CRITICAL: For EVERY formula row you output, you MUST also output a setCellValue label in Column A. No exceptions.

RESPOND ONLY with valid JSON: { "actions": [{ "type": "runFormula"|"setCellValue", "sheet": "...", "target": "...", "value": "..." }] }

SECTION-SPECIFIC RULES:

assumptions.inputs:
- Labels in A, input values in B, description in C (optional).
- Revenue Growth (%), EBITDA Margin (%), Tax Rate (%), D&A % Revenue (%), CapEx % Revenue (%), NWC % Revenue (%)
- All values as decimals (e.g., 0.25 for 25%).

assumptions.macro:
- Risk-Free Rate (%), Market Risk Premium (%), Beta, Pre-Tax Cost of Debt (%), Target D/E, Terminal Growth Rate (%)

wacc.cost_of_equity:
- Label "Cost of Equity (CAPM) (%)", formula =RiskFree + Beta*MRP

wacc.wacc_calc:
- Label "WACC (%)", formula with D/E weighting

dcf.revenue_build:
- Year 0 = base year (from Assumptions or workbook data), Years 1-5 = prior*(1+growth)
- Label each year column in Row 2

dcf.ebitda_build:
- Revenue → EBITDA (Revenue*margin) → D&A (Revenue*D&A%) → EBIT (EBITDA-D&A) → Tax (EBIT*TaxRate) → NOPAT

dcf.fcf_build:
- NOPAT + D&A - CapEx - ChangeInNWC = Unlevered FCF
- ChangeInNWC = (NWC%*Revenue_current) - (NWC%*Revenue_prior)

dcf.terminal_value:
- Terminal Value = FCF_5 * (1+g) / (WACC - g)
- PV of TV = TV / (1+WACC)^5

dcf.enterprise_value:
- Discount Factor per year = 1/(1+WACC)^n
- PV of FCF = FCF * DF
- Enterprise Value = SUM(PV_FCF) + PV_TV

dcf.equity_value:
- (+) Cash, (-) Total Debt, (=) Equity Value
- Implied Share Price = EquityValue / SharesOutstanding

sensitivity.data_table:
- Row headers: WACC values (e.g., 8%, 9%, 10%, 11%, 12%)
- Column headers: Terminal Growth values (e.g., 1%, 1.5%, 2%, 2.5%, 3%)
- Cell formula references DCF!EquityValue or DCF!ImpliedSharePrice

LABELS MUST BE IN ENGLISH, PROFESSIONAL IB TERMINOLOGY.
Formulas must reference Assumptions sheet or prior cells. Never hardcode.`;

const FORMAT_SYSTEM_PROMPT = `You are a Senior IB Associate applying final formatting to a financial model.

RESPOND ONLY with valid JSON:
{ "actions": [{ "type": "setCellFormat", "sheet": "...", "target": "...", "options": { ... } }] }

You are not a mechanical template engine. Read the user objective and workbook context, then choose the smallest professional formatting plan that accomplishes it.

If the user asks to change colors/theme/palette/style:
- Preserve the existing workbook structure, formulas and layout.
- Recolor semantic surfaces only: title rows, section bands, table headers, input cells, total rows, checks, and sensitivity heatmaps.
- Do not blanket-reset the whole used range unless the user asks for a full cleanup.
- Use the exact requested color family or brand color when provided.

Supported actions only:
- setCellFormat with options: backgroundColor, fontColor, bold, italic, fontSize, fontName, numberFormat, horizontalAlignment, verticalAlignment, wrapText, columnWidth, rowHeight, borderBottomColor, borderTopColor, borders
- addConditionalFormat with options: colorScale, dataBar, iconSet, cellValue

INSTITUTIONAL FORMATTING STANDARDS (Goldman/JPMorgan style):

1. TITLE ROW (Row 1):
   - Merge A1 across all year columns
   - Background: #1F4E78 (dark blue), Font: white, bold, 14pt

2. HEADER ROW (Row 2 — year labels):
   - Background: #404040 (dark grey), Font: white, bold, 10pt
   - Bottom border: medium black

3. SECTION HEADERS (e.g., "Revenue Build", "DCF Valuation"):
   - Background: #D9E1F2 (light blue-grey), Font: black, bold, 10pt
   - Top border: thin black

4. INPUT CELLS (user-changeable assumptions):
   - Background: #E6F2FF (light blue), Font: dark blue (#0000FF), 10pt
   - Number format: currency $#,##0.0 or percentage 0.00%

5. CALCULATED CELLS (formulas):
   - Background: #FFFFFF (white), Font: black, 10pt
   - Number format: $#,##0.0 or 0.0%

6. TOTAL / SUBTOTAL ROWS:
   - Font: bold, 10pt
   - Top border: thin black
   - Background: #F2F2F2 (very light grey)

7. NEGATIVE NUMBERS:
   - Font color: #C00000 (red), format: ($#,##0.0) or -$#,##0.0

8. PERCENTAGES:
   - Format: 0.00%
   - Input percentages: blue font
   - Calculated percentages: black font

9. CURRENCY / LARGE NUMBERS:
   - In millions: $#,##0.0
   - In billions: $#,##0.00
   - Per-share: $#,##0.00

10. ALIGNMENT:
    - Column A (labels): left aligned, indent 1
    - All numeric columns: right aligned

11. BORDERS:
    - Data tables: thin gridlines inside, medium outside
    - Between sections: thin horizontal line

12. CHECK ROW:
    - Background: #FFF2CC (light yellow) if pass, #FCE4D6 (light red) if fail
    - Font: italic

Apply formatting to ALL sheets: Assumptions, WACC, DCF, Sensitivity.
Use consistent column widths where possible.`;

/* ---------- Sub-agent runners ---------- */

async function runLayoutAgent(params, memory) {
  logger.info('[LayoutAgent] Avvio layout planning');
  const context = JSON.stringify(compactResultsForPrompt(memory.results, params.usesResults), null, 2);

  // Inject relevant wiki knowledge
  const wikiContext = getWikiContextForPrompt('layout ' + (params.model || ''), ['finance', 'excel'], 3000);

  const user = `Design layout for: ${JSON.stringify(params)}\n\nPrevious task results:\n${context}\n\n${wikiContext}`;
  const start = Date.now();
  const result = await callLLM({
    system: LAYOUT_SYSTEM_PROMPT + (wikiContext ? '\n\nUse the WIKI KNOWLEDGE BASE provided above for best practices and conventions.' : ''),
    userText: user,
    timeoutMs: LAYOUT_TIMEOUT_MS,
    fallbackTimeoutMs: LAYOUT_FALLBACK_TIMEOUT_MS,
    label: 'LayoutAgent LLM',
    role: 'builder_structural'
  });
  logger.info(`[LayoutAgent] Completato in ${Date.now() - start}ms`);
  return result;
}

async function runFormulaAgent(params, memory) {
  const isSection = params.section && params.section !== 'full_model';
  const systemPrompt = isSection ? FORMULA_SECTION_SYSTEM_PROMPT : FORMULA_SYSTEM_PROMPT;
  const timeoutMs = isSection ? FORMULA_SECTION_TIMEOUT_MS : FORMULA_TIMEOUT_MS;
  const fallbackTimeoutMs = isSection ? FORMULA_SECTION_FALLBACK_TIMEOUT_MS : FORMULA_FALLBACK_TIMEOUT_MS;

  logger.info(`[FormulaAgent] ${isSection ? `Sezione "${params.section}"` : 'Modello completo'} — avvio${params.criticErrors ? ' (retry con feedback critic)' : ''}`);
  const context = JSON.stringify(compactResultsForPrompt(memory.results, params.usesResults), null, 2);

  // Se ci sono dati inferiti dal foglio, includili nel prompt
  const inferredBlock = memory?.context?.inferredData?.highConfidenceInputs?.length > 0
    ? `\n\nEXISTING DATA FOUND IN WORKBOOK (USE THESE CELLS WITH FULL "Sheet!Cell" REFERENCES, DO NOT ASK FOR INPUT):\n${memory.context.inferredData.highConfidenceInputs.map(i => `  - ${i.canonical}: ${i.value} at ${i.sheet ? `'${i.sheet}'!${i.cell}` : i.cell}`).join('\n')}`
    : '';

  const criticBlock = Array.isArray(params.criticErrors) && params.criticErrors.length > 0
    ? `\n\nPREVIOUS ATTEMPT ERRORS (fix them):\n${params.criticErrors.map((e, i) => `${i + 1}. ${e}`).join('\n')}`
    : '';

  // Inject relevant wiki knowledge for formulas
  const sectionQuery = params.section ? params.section.replace(/\./g, ' ') : (params.mode || 'finance model');
  const wikiContext = getWikiContextForPrompt(sectionQuery + ' formulas', ['finance', 'excel'], 3000);
  const analystDepth = params.analystDepth && typeof params.analystDepth === 'object'
    ? params.analystDepth
    : getAnalystDepth(params.section || params.mode || 'audit');
  const depthBlock = `\n\nANALYST DEPTH PLAYBOOK (mandatory, not optional):\n${formatDepthForPrompt(analystDepth)}\n\nApply this depth to the visible Excel output. If an input is missing, create a reviewable assumption/source flag instead of hiding the gap.`;

  const user = `Generate ${isSection ? `formulas for section "${params.section}"` : `formulas for full model`}: ${JSON.stringify(params)}\n\nLayout and previous results:\n${context}${inferredBlock}${criticBlock}${depthBlock}\n\n${wikiContext}`;
  const start = Date.now();
  const result = await callLLM({
    system: systemPrompt + '\n\nANALYST DEPTH RULE: beta is only one example. Every finance section must expose method, evidence, assumptions, checks and review flags in the workbook, not just formulas.' + (wikiContext ? '\n\nUse the WIKI KNOWLEDGE BASE provided above for correct formulas, conventions, and best practices.' : ''),
    userText: user,
    timeoutMs,
    fallbackTimeoutMs,
    label: `FormulaAgent ${isSection ? params.section : 'full'}`,
    role: 'builder_hard'
  });
  logger.info(`[FormulaAgent] Completato in ${Date.now() - start}ms`);
  if (result.actions && Array.isArray(result.actions)) {
    return result;
  }
  if (Array.isArray(result)) {
    return { actions: result };
  }
  return { actions: [] };
}

async function runFormatAgent(params, memory) {
  logger.info('[FormatAgent] Avvio formattazione');
  const fallback = buildProfessionalFormatPlan(params, memory);
  if (!shouldUseFormatLLM(params)) {
    logger.info(`[FormatAgent] Piano adattivo: ${fallback.actions.length} azioni su ${fallback.data.sheetCount} fogli (${fallback.data.strategy})`);
    return fallback;
  }

  const context = JSON.stringify(compactResultsForPrompt(memory.results, params.usesResults), null, 2);

  // Inject relevant wiki knowledge for formatting
  const wikiContext = getWikiContextForPrompt('formatting ' + (params.mode || 'institutional'), ['finance', 'excel'], 2000);
  const intent = classifyFormatIntent(params);
  const analystDepth = params.analystDepth && typeof params.analystDepth === 'object'
    ? params.analystDepth
    : getAnalystDepth('format');

  const user = `Generate formatting for: ${JSON.stringify(params)}

Interpreted style intent:
${JSON.stringify(intent, null, 2)}

Analyst-depth playbook:
${formatDepthForPrompt(analystDepth)}

Deterministic fallback plan summary:
${JSON.stringify({ data: fallback.data, sampleActions: fallback.actions.slice(0, 24) }, null, 2)}

Previous task results:
${context}

${wikiContext}`;
  const start = Date.now();
  try {
    const result = await callLLM({
      system: FORMAT_SYSTEM_PROMPT + (wikiContext ? '\n\nUse the WIKI KNOWLEDGE BASE provided above for formatting standards and conventions.' : ''),
      userText: user,
      timeoutMs: FORMAT_TIMEOUT_MS,
      fallbackTimeoutMs: FORMAT_FALLBACK_TIMEOUT_MS,
      label: 'FormatAgent LLM',
      role: 'builder_structural'
    });
    logger.info(`[FormatAgent] LLM completato in ${Date.now() - start}ms`);
    const rawActions = result?.actions && Array.isArray(result.actions)
      ? result.actions
      : (Array.isArray(result) ? result : []);
    const actions = normalizeFormatActions(rawActions, params.sheet);
    if (actions.length < 3) {
      throw new Error(`AI format plan too small (${actions.length} actions)`);
    }
    return {
      data: {
        ...fallback.data,
        builder: 'ai-assisted-format',
        actionCount: actions.length,
        fallbackActionCount: fallback.actions.length
      },
      actions
    };
  } catch (error) {
    logger.warn(`[FormatAgent] LLM fallback to adaptive format: ${error.message}`);
    return {
      ...fallback,
      data: {
        ...(fallback.data || {}),
        aiError: error.message
      }
    };
  }
}

function shouldUseFormatLLM(params = {}) {
  const flag = process.env.FORMAT_LLM_ENABLED;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  const text = `${params.objective || ''} ${params.mode || ''} ${params.theme || ''}`.toLowerCase();
  return /(colou?r|colori|colore|palette|tema|theme|stile|style|look|brand|elegante|luxury|minimal|minimalista|creative|design|#[0-9a-f]{6})/i.test(text);
}

const FORMAT_OPTION_KEYS = new Set([
  'backgroundColor',
  'fontColor',
  'bold',
  'italic',
  'fontSize',
  'fontName',
  'numberFormat',
  'horizontalAlignment',
  'verticalAlignment',
  'wrapText',
  'columnWidth',
  'rowHeight',
  'borderBottomColor',
  'borderTopColor',
  'borders'
]);

function normalizeFormatActions(rawActions, defaultSheet) {
  if (!Array.isArray(rawActions)) return [];
  const actions = [];
  for (const action of rawActions) {
    if (!action || typeof action !== 'object') continue;
    const type = normalizeFormatActionType(action.type);
    const sheet = action.sheet || action.sheetName || defaultSheet;
    const target = action.target || action.range || action.address;
    if (!sheet || !target) continue;
    if (type === 'setCellFormat') {
      const rawOptions = action.options || action.format || action.style || {};
      const options = {};
      for (const [key, value] of Object.entries(rawOptions)) {
        if (FORMAT_OPTION_KEYS.has(key) && value !== undefined && value !== null) options[key] = value;
      }
      if (Object.keys(options).length > 0) {
        actions.push({ type, sheet, target, options });
      }
      continue;
    }
    if (type === 'addConditionalFormat') {
      const options = action.options || action.rule || {};
      if (options && typeof options === 'object' && Object.keys(options).length > 0) {
        actions.push({ type, sheet, target, options });
      }
    }
  }
  return actions;
}

function normalizeFormatActionType(type) {
  const key = String(type || '').toLowerCase().replace(/[^a-z]/g, '');
  if (['setcellformat', 'setformat', 'formatrange', 'formatcells'].includes(key)) return 'setCellFormat';
  if (['addconditionalformat', 'setconditionalformat', 'conditionalformat'].includes(key)) return 'addConditionalFormat';
  return type;
}

module.exports = {
  runLayoutAgent,
  runFormulaAgent,
  runFormatAgent,
  normalizeFormatActions,
  shouldUseFormatLLM,
  FORMULA_SECTION_SYSTEM_PROMPT
};
