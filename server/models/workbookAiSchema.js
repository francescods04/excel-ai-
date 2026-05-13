const { callLLM } = require('../tools/llm');
const logger = require('../utils/logger');
const { analyzeWorkbookContext, parseNumber } = require('../utils/sheetParser');

const WORKBOOK_AI_SCHEMA_TIMEOUT_MS = Number(process.env.WORKBOOK_AI_SCHEMA_TIMEOUT_MS) || 300000;
const WORKBOOK_AI_SCHEMA_FALLBACK_TIMEOUT_MS = Number(process.env.WORKBOOK_AI_SCHEMA_FALLBACK_TIMEOUT_MS) || 180000;
const schemaPromiseCache = new WeakMap();

const CANONICALS = new Set([
  'Revenue',
  'Revenue Growth',
  'EBITDA',
  'EBITDA Margin',
  'EBIT',
  'Net Income',
  'D&A',
  'CapEx',
  'Pre-Tax Income',
  'Income Taxes',
  'Tax Rate',
  'Net Working Capital',
  'Cash & Equivalents',
  'Total Debt',
  'Net Debt',
  'Debt / Equity',
  'Shares Outstanding',
  'Diluted Shares',
  'Share Price',
  'Total Assets',
  'Total Liabilities',
  'Shareholders Equity'
]);

const SYSTEM_PROMPT = `You are a multilingual financial statement schema analyst embedded in Excel.

Your job is to understand arbitrary workbook layouts, languages, accounting labels and reporting units.
Do NOT build a model. Do NOT invent numbers. Map workbook cells to canonical finance concepts.

Return ONLY valid JSON:
{
  "language": "fr|it|en|de|es|mixed|unknown",
  "companyName": string|null,
  "currency": "EUR|USD|GBP|CHF|..."|null,
  "reportingUnit": "units|thousands|millions|billions"|null,
  "isPrivateCompany": boolean|null,
  "periodColumns": [
    { "sheet": string, "col": number, "period": string, "fiscalYear": number|null, "isForecast": boolean }
  ],
  "mappings": [
    {
      "canonical": "Revenue|EBITDA|EBITDA Margin|EBIT|Net Income|D&A|CapEx|Pre-Tax Income|Income Taxes|Tax Rate|Net Working Capital|Cash & Equivalents|Total Debt|Net Debt|Debt / Equity|Shares Outstanding|Diluted Shares|Share Price|Total Assets|Total Liabilities|Shareholders Equity",
      "label": string,
      "sheet": string,
      "cell": string,
      "row": number,
      "col": number,
      "period": string|null,
      "fiscalYear": number|null,
      "isForecast": boolean,
      "confidence": "high|medium|low",
      "rationale": string
    }
  ],
  "warnings": [string]
}

Rules:
- Use the workbook language and structure. A French analyst's "chiffre d'affaires", "EBE", "BFR", "trésorerie" must be understood from context, not from a fixed glossary.
- Prefer complete statement totals over sub-lines. For cash, prefer total cash/liquid assets over petty cash. For debt, distinguish gross debt from net debt.
- Identify whether values are reported in units, thousands, millions or billions from workbook headers like "en milliers d'euros", "K€", "M€", "EURm".
- Periods matter: map actual historical years separately from forecasts/budgets.
- Never fabricate a cell or value. Every mapping must point to a visible workbook cell from the supplied snapshot.`;

function colIndexToLetter(colIndex) {
  let result = '';
  let n = Number(colIndex);
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result || 'A';
}

function cellAddress(sheet, rowIndex, colIndex) {
  return `${sheet}!${colIndexToLetter(colIndex + 1)}${rowIndex + 1}`;
}

function normalizeCellRef(ref) {
  return String(ref || '')
    .trim()
    .replace(/\$/g, '')
    .replace(/^'([^']+)'!/, '$1!');
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

function collectWorkbookContexts(memory = {}) {
  const contexts = [];
  if (memory.context) contexts.push(memory.context);
  const results = memory?.results && typeof memory.results === 'object' ? memory.results : {};
  for (const result of Object.values(results)) {
    if (!result || result.ok === false) continue;
    const ctx = resultDataAsWorkbookContext(result.data ?? result);
    if (ctx) contexts.push(ctx);
  }
  return contexts;
}

function compactWorkbookContext(memory = {}) {
  const contexts = collectWorkbookContexts(memory);
  const sheets = [];
  const cellLookup = new Map();

  for (const context of contexts) {
    const allSheetsData = context?.allSheetsData && typeof context.allSheetsData === 'object'
      ? context.allSheetsData
      : {};
    for (const [sheetName, info] of Object.entries(allSheetsData)) {
      if (!Array.isArray(info?.preview) || info.preview.length === 0) continue;
      const rows = info.preview.slice(0, 160).map(row => Array.isArray(row) ? row.slice(0, 80) : []);
      sheets.push({
        name: sheetName,
        isActive: !!info.isActive,
        usedRange: info.usedRange || null,
        rows
      });
      rows.forEach((row, r) => {
        row.forEach((value, c) => {
          cellLookup.set(cellAddress(sheetName, r, c), { value, row: r, col: c, sheet: sheetName });
        });
      });
    }
  }

  const parsed = contexts
    .map(context => analyzeWorkbookContext(context))
    .filter(result => result.inferredInputs?.length > 0)
    .map(result => ({
      summary: result.summary.slice(0, 8000),
      inferredInputs: result.inferredInputs.slice(0, 80).map(input => ({
        canonical: input.canonical,
        label: input.label,
        rawValue: input.rawValue,
        cell: input.cell,
        period: input.period,
        fiscalYear: input.fiscalYear,
        priority: input.priority
      }))
    }));

  return { sheets, parsed, cellLookup };
}

function normalizeReportingUnit(unit) {
  const value = String(unit || '').toLowerCase();
  if (['units', 'unit'].includes(value)) return 'units';
  if (['thousand', 'thousands', 'k', 'keur'].includes(value)) return 'thousands';
  if (['million', 'millions', 'm', 'meur'].includes(value)) return 'millions';
  if (['billion', 'billions', 'bn'].includes(value)) return 'billions';
  return null;
}

function normalizeAiSchema(result, cellLookup) {
  if (!result || typeof result !== 'object' || result.jsonError) return null;
  const mappings = [];
  for (const mapping of Array.isArray(result.mappings) ? result.mappings : []) {
    if (!mapping || typeof mapping !== 'object') continue;
    const canonical = String(mapping.canonical || '').trim();
    if (!CANONICALS.has(canonical)) continue;
    const cell = normalizeCellRef(mapping.cell || (
      mapping.sheet && Number.isInteger(mapping.row) && Number.isInteger(mapping.col)
        ? cellAddress(mapping.sheet, mapping.row, mapping.col)
        : ''
    ));
    const found = cellLookup.get(cell);
    if (!found) continue;
    const value = parseNumber(found.value);
    if (value == null) continue;
    mappings.push({
      canonical,
      label: String(mapping.label || canonical).trim(),
      sheet: mapping.sheet || found.sheet,
      cell,
      row: Number.isInteger(mapping.row) ? mapping.row : found.row,
      col: Number.isInteger(mapping.col) ? mapping.col : found.col,
      period: mapping.period || null,
      fiscalYear: Number.isInteger(mapping.fiscalYear) ? mapping.fiscalYear : null,
      periodOrder: Number.isInteger(mapping.fiscalYear) ? mapping.fiscalYear : null,
      isForecast: !!mapping.isForecast,
      confidence: ['high', 'medium', 'low'].includes(mapping.confidence) ? mapping.confidence : 'medium',
      rationale: String(mapping.rationale || '').slice(0, 240),
      rawValue: found.value,
      value
    });
  }

  if (mappings.length === 0) return null;
  return {
    language: result.language || 'unknown',
    companyName: result.companyName || null,
    currency: result.currency || null,
    reportingUnit: normalizeReportingUnit(result.reportingUnit),
    isPrivateCompany: typeof result.isPrivateCompany === 'boolean' ? result.isPrivateCompany : null,
    periodColumns: Array.isArray(result.periodColumns) ? result.periodColumns : [],
    mappings,
    warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 12) : []
  };
}

function shouldUseWorkbookAiSchema(params = {}, memory = {}) {
  if (params.aiSchemaEnabled === false) return false;
  if (process.env.WORKBOOK_AI_SCHEMA_ENABLED !== 'true' && params.aiSchemaEnabled !== true) return false;
  const { sheets } = compactWorkbookContext(memory);
  return sheets.length > 0 && sheets.some(sheet => sheet.rows.length > 2);
}

async function inferWorkbookSchemaWithAi(params = {}, memory = {}) {
  if (memory.aiWorkbookSchema) return memory.aiWorkbookSchema;
  if (memory.__workbookAiSchemaPromise) return memory.__workbookAiSchemaPromise;
  if (!shouldUseWorkbookAiSchema(params, memory)) return null;

  const cacheKey = memory.results && typeof memory.results === 'object'
    ? memory.results
    : (memory.context && typeof memory.context === 'object' ? memory.context : null);
  if (cacheKey && schemaPromiseCache.has(cacheKey)) {
    return schemaPromiseCache.get(cacheKey);
  }

  const compact = compactWorkbookContext(memory);
  const userText = [
    `Objective: ${params.objective || 'Build/analyze a financial model from this workbook.'}`,
    `Workbook snapshot, preserving row/column positions:\n${JSON.stringify(compact.sheets, null, 2)}`,
    compact.parsed.length
      ? `Deterministic parser hints. These are hints only; override them when workbook context says otherwise:\n${JSON.stringify(compact.parsed, null, 2)}`
      : '',
    'Return the schema JSON only.'
  ].filter(Boolean).join('\n\n');

  memory.__workbookAiSchemaPromise = callLLM({
    system: SYSTEM_PROMPT,
    userText,
    timeoutMs: WORKBOOK_AI_SCHEMA_TIMEOUT_MS,
    fallbackTimeoutMs: WORKBOOK_AI_SCHEMA_FALLBACK_TIMEOUT_MS,
    modelOverride: memory?.llm?.modelOverride || undefined,
    label: 'Workbook AI schema inference',
    cachePrompt: true,
    thinkingDisabled: false,
    reasoningEffort: 'high'
  })
    .then(result => {
      const schema = normalizeAiSchema(result, compact.cellLookup);
      if (schema) {
        logger.info(`[Workbook AI Schema] mapped ${schema.mappings.length} finance cells (${schema.language || 'unknown'})`);
        memory.aiWorkbookSchema = schema;
      } else {
        logger.warn('[Workbook AI Schema] no validated mappings returned; deterministic parser will handle workbook');
      }
      return schema;
    })
    .catch(error => {
      logger.warn(`[Workbook AI Schema] failed: ${error.message}`);
      return null;
    });

  if (cacheKey) schemaPromiseCache.set(cacheKey, memory.__workbookAiSchemaPromise);
  return memory.__workbookAiSchemaPromise;
}

module.exports = {
  inferWorkbookSchemaWithAi,
  compactWorkbookContext,
  normalizeAiSchema
};
