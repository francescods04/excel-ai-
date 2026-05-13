const { callLLM } = require('../tools/llm');
const logger = require('../utils/logger');
const { buildWorkbookGraph } = require('./workbookGraph');

const UNDERSTANDING_TIMEOUT_MS = Number(process.env.WORKBOOK_UNDERSTANDING_TIMEOUT_MS) || 300000;
const UNDERSTANDING_FALLBACK_TIMEOUT_MS = Number(process.env.WORKBOOK_UNDERSTANDING_FALLBACK_TIMEOUT_MS) || 180000;

const SYSTEM_PROMPT = `You are a domain-agnostic Excel workbook intelligence agent.

Your job is to understand arbitrary Excel workbooks before any mutation happens.
This is not a finance-only task. Workbooks may be sales trackers, HR models, inventory files, project plans, pricing tools, survey data, budgets, scientific sheets, or custom operations dashboards.

Return ONLY valid JSON:
{
  "workbookPurpose": string,
  "domain": string,
  "language": string,
  "confidence": "high|medium|low",
  "sheets": [
    {
      "name": string,
      "role": "source_data|calculation_model|report_dashboard|assumptions_inputs|lookup_reference|staging|unknown",
      "summary": string,
      "usedRange": string|null,
      "tables": [
        {
          "name": string,
          "range": string,
          "anchorCell": string,
          "headerRow": number|null,
          "headers": [string],
          "grain": string,
          "measures": [string],
          "dimensions": [string],
          "timeFields": [string]
        }
      ],
      "keyCells": [{ "cell": string, "label": string, "meaning": string }],
      "formulaZones": [{ "range": string, "meaning": string }],
      "risks": [string]
    }
  ],
  "crossSheetRelationships": [{ "from": string, "to": string, "meaning": string }],
  "recommendedNextActions": [string],
  "questionsForUser": [string]
}

Rules:
- Ground every range/cell in the workbook snapshot. Do not invent sheet names or cell addresses.
- Identify the workbook's actual domain and business purpose from labels and structure.
- Prefer a useful semantic map over a verbose one.
- If a workbook has multiple possible domains, say "mixed" and explain per sheet.
- questionsForUser should contain only genuinely blocking questions; otherwise return [].
- Do not propose destructive actions.`;

function normalizeCellRef(ref) {
  return String(ref || '')
    .trim()
    .replace(/\$/g, '')
    .replace(/^'([^']+)'!/, '$1!');
}

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

function colLetterToIndex(colLetters) {
  const text = String(colLetters || '').toUpperCase();
  let value = 0;
  for (let i = 0; i < text.length; i++) {
    value = value * 26 + (text.charCodeAt(i) - 64);
  }
  return value;
}

function cellAddress(sheet, rowIndex, colIndex) {
  return `${sheet}!${colIndexToLetter(colIndex + 1)}${rowIndex + 1}`;
}

function parseA1(ref, defaultSheet = null) {
  const normalized = normalizeCellRef(ref);
  const match = normalized.match(/^(?:(.+)!)?([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
  if (!match) return null;
  return {
    sheet: match[1] || defaultSheet,
    startCol: colLetterToIndex(match[2]),
    startRow: Number(match[3]),
    endCol: match[4] ? colLetterToIndex(match[4]) : colLetterToIndex(match[2]),
    endRow: match[5] ? Number(match[5]) : Number(match[3])
  };
}

function resultDataAsWorkbookContext(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.allSheetsData || data.usedRangeData || data.selectedValues) return data;
  if (data.sheet && Array.isArray(data.values)) {
    return {
      activeSheet: data.sheet,
      workbookSheets: [data.sheet],
      allSheetsData: {
        [data.sheet]: {
          isActive: true,
          usedRange: data.usedRange || data.target || null,
          rowCount: data.rowCount,
          columnCount: data.columnCount,
          preview: data.values,
          formulas: data.formulas
        }
      }
    };
  }
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
      formulas: sheet.formulas
    };
  }
  return Object.keys(allSheetsData).length > 0
    ? { activeSheet: data.activeSheet, workbookSheets: data.workbookSheets, allSheetsData }
    : null;
}

function resolveWorkbookInput(params = {}, memory = {}) {
  const sourceResultId = params.fromResult || params.resultId;
  if (sourceResultId && memory?.results?.[sourceResultId]) {
    return resultDataAsWorkbookContext(memory.results[sourceResultId].data ?? memory.results[sourceResultId])
      || memory.results[sourceResultId].data
      || memory.results[sourceResultId];
  }
  if (params.snapshot) return params.snapshot;
  if (params.workbook) return params.workbook;
  if (memory.context) return memory.context;
  return null;
}

function collectSheets(input = {}) {
  const allSheetsData = input?.allSheetsData && typeof input.allSheetsData === 'object'
    ? input.allSheetsData
    : {};
  return Object.entries(allSheetsData)
    .filter(([, info]) => Array.isArray(info?.preview) && info.preview.length > 0)
    .map(([name, info]) => ({
      name,
      isActive: !!info.isActive || input.activeSheet === name,
      usedRange: info.usedRange || null,
      rowCount: info.rowCount || info.preview.length,
      columnCount: info.columnCount || Math.max(...info.preview.map(row => Array.isArray(row) ? row.length : 0), 0),
      preview: info.preview,
      formulas: info.formulas
    }));
}

function compactWorkbookForPrompt(input = {}, maxRows = 80, maxCols = 40) {
  return collectSheets(input).map(sheet => ({
    name: sheet.name,
    isActive: sheet.isActive,
    usedRange: sheet.usedRange,
    rowCount: sheet.rowCount,
    columnCount: sheet.columnCount,
    rows: sheet.preview
      .slice(0, maxRows)
      .map(row => (Array.isArray(row) ? row.slice(0, maxCols) : [])),
    formulas: Array.isArray(sheet.formulas)
      ? sheet.formulas.slice(0, Math.min(maxRows, 30)).map(row => (Array.isArray(row) ? row.slice(0, Math.min(maxCols, 20)) : []))
      : undefined
  }));
}

function buildWorkbookIndex(input = {}) {
  const sheets = collectSheets(input);
  const sheetMap = new Map();
  const cellLookup = new Set();
  for (const sheet of sheets) {
    sheetMap.set(sheet.name.toLowerCase(), sheet);
    sheet.preview.forEach((row, r) => {
      if (!Array.isArray(row)) return;
      row.forEach((_, c) => {
        cellLookup.add(cellAddress(sheet.name, r, c));
      });
    });
  }
  return { sheets, sheetMap, cellLookup };
}

function rangeExists(ref, workbookIndex, defaultSheet = null) {
  const parsed = parseA1(ref, defaultSheet);
  if (!parsed?.sheet) return false;
  const sheet = workbookIndex.sheetMap.get(String(parsed.sheet).toLowerCase());
  if (!sheet) return false;
  if (parsed.startRow < 1 || parsed.startCol < 1) return false;
  if (parsed.endRow < parsed.startRow || parsed.endCol < parsed.startCol) return false;
  return parsed.startRow <= sheet.rowCount &&
    parsed.endRow <= sheet.rowCount &&
    parsed.startCol <= sheet.columnCount &&
    parsed.endCol <= sheet.columnCount;
}

function inferHeaderRow(preview = []) {
  let best = null;
  for (let r = 0; r < Math.min(preview.length, 20); r++) {
    const row = Array.isArray(preview[r]) ? preview[r] : [];
    const strings = row.filter(value => typeof value === 'string' && value.trim()).length;
    const nums = row.filter(value => typeof value === 'number' || (typeof value === 'string' && /^-?\d+([.,]\d+)?%?$/.test(value.trim()))).length;
    if (strings >= 2 && strings >= nums) {
      best = { row: r + 1, headers: row.map(value => String(value || '').trim()).filter(Boolean) };
      break;
    }
  }
  return best;
}

function classifySheetRole(sheet) {
  const text = JSON.stringify(sheet.preview.slice(0, 20)).toLowerCase();
  const hasFormulas = Array.isArray(sheet.formulas) && sheet.formulas.flat().some(Boolean);
  if (/dashboard|summary|report|cockpit|overview|kpi/.test(text) || /dashboard|summary|report/i.test(sheet.name)) return 'report_dashboard';
  if (/assumption|input|param|setting|scenario|hypoth/.test(text) || /assumption|input/i.test(sheet.name)) return 'assumptions_inputs';
  if (hasFormulas || /calc|model|forecast|budget|projection/.test(text)) return 'calculation_model';
  if (/lookup|mapping|reference|master|liste|anagrafica/.test(text) || /lookup|mapping|reference/i.test(sheet.name)) return 'lookup_reference';
  return 'source_data';
}

function fallbackUnderstanding(input = {}, objective = '') {
  const sheets = collectSheets(input);
  const graph = buildWorkbookGraph(input, { source: 'workbook.understand.fallback' });
  return {
    workbookPurpose: objective || 'Workbook analysis',
    domain: 'unknown',
    language: 'unknown',
    confidence: 'low',
    sheets: sheets.map(sheet => {
      const header = inferHeaderRow(sheet.preview);
      const usedRange = sheet.usedRange || `${sheet.name}!A1:${colIndexToLetter(Math.max(sheet.columnCount, 1))}${Math.max(sheet.rowCount, 1)}`;
      return {
        name: sheet.name,
        role: classifySheetRole(sheet),
        summary: `${sheet.rowCount} rows x ${sheet.columnCount} columns`,
        usedRange,
        tables: header ? [{
          name: `${sheet.name} table`,
          range: usedRange,
          anchorCell: `${sheet.name}!A${header.row}`,
          headerRow: header.row,
          headers: header.headers.slice(0, 30),
          grain: 'unknown',
          measures: [],
          dimensions: header.headers.slice(0, 8),
          timeFields: header.headers.filter(value => /date|year|month|period|anno|mese|jour|mois|annee/i.test(value)).slice(0, 6)
        }] : [],
        keyCells: [],
        formulaZones: [],
        risks: []
      };
    }),
    crossSheetRelationships: (graph.edges || []).slice(0, 20).map(edge => ({
      from: edge.from || edge.source || '',
      to: edge.to || edge.target || '',
      meaning: edge.type || 'formula/reference dependency'
    })),
    recommendedNextActions: [
      'Confirm workbook objective and target output before mutating cells.',
      'Use table headers and formula dependencies as the primary grounding context.'
    ],
    questionsForUser: [],
    builder: 'deterministic-fallback'
  };
}

function normalizeUnderstanding(raw, input = {}, objective = '') {
  if (!raw || typeof raw !== 'object' || raw.jsonError) return null;
  const workbookIndex = buildWorkbookIndex(input);
  const knownSheets = new Set(workbookIndex.sheets.map(sheet => sheet.name.toLowerCase()));
  const out = {
    workbookPurpose: String(raw.workbookPurpose || objective || 'Workbook analysis').slice(0, 300),
    domain: String(raw.domain || 'unknown').slice(0, 80),
    language: String(raw.language || 'unknown').slice(0, 40),
    confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'medium',
    sheets: [],
    crossSheetRelationships: Array.isArray(raw.crossSheetRelationships) ? raw.crossSheetRelationships.slice(0, 30) : [],
    recommendedNextActions: Array.isArray(raw.recommendedNextActions) ? raw.recommendedNextActions.slice(0, 12) : [],
    questionsForUser: Array.isArray(raw.questionsForUser) ? raw.questionsForUser.slice(0, 5) : [],
    builder: 'ai-understanding'
  };

  for (const sheet of Array.isArray(raw.sheets) ? raw.sheets : []) {
    const sheetName = String(sheet?.name || '').trim();
    if (!sheetName || !knownSheets.has(sheetName.toLowerCase())) continue;
    const role = ['source_data', 'calculation_model', 'report_dashboard', 'assumptions_inputs', 'lookup_reference', 'staging', 'unknown'].includes(sheet.role)
      ? sheet.role
      : 'unknown';
    const tables = [];
    for (const table of Array.isArray(sheet.tables) ? sheet.tables : []) {
      const range = normalizeCellRef(table.range);
      const anchorCell = normalizeCellRef(table.anchorCell || range?.split(':')[0]);
      if (!rangeExists(range, workbookIndex, sheetName) || !rangeExists(anchorCell, workbookIndex, sheetName)) continue;
      tables.push({
        name: String(table.name || 'Table').slice(0, 80),
        range,
        anchorCell,
        headerRow: Number.isInteger(table.headerRow) ? table.headerRow : null,
        headers: Array.isArray(table.headers) ? table.headers.map(String).slice(0, 40) : [],
        grain: String(table.grain || 'unknown').slice(0, 160),
        measures: Array.isArray(table.measures) ? table.measures.map(String).slice(0, 20) : [],
        dimensions: Array.isArray(table.dimensions) ? table.dimensions.map(String).slice(0, 20) : [],
        timeFields: Array.isArray(table.timeFields) ? table.timeFields.map(String).slice(0, 12) : []
      });
    }
    const keyCells = (Array.isArray(sheet.keyCells) ? sheet.keyCells : [])
      .map(entry => ({ ...entry, cell: normalizeCellRef(entry.cell) }))
      .filter(entry => rangeExists(entry.cell, workbookIndex, sheetName))
      .slice(0, 30)
      .map(entry => ({
        cell: entry.cell,
        label: String(entry.label || '').slice(0, 80),
        meaning: String(entry.meaning || '').slice(0, 180)
      }));
    const formulaZones = (Array.isArray(sheet.formulaZones) ? sheet.formulaZones : [])
      .map(entry => ({ ...entry, range: normalizeCellRef(entry.range) }))
      .filter(entry => rangeExists(entry.range, workbookIndex, sheetName))
      .slice(0, 20)
      .map(entry => ({
        range: entry.range,
        meaning: String(entry.meaning || '').slice(0, 180)
      }));
    out.sheets.push({
      name: sheetName,
      role,
      summary: String(sheet.summary || '').slice(0, 300),
      usedRange: sheet.usedRange && rangeExists(sheet.usedRange, workbookIndex, sheetName) ? normalizeCellRef(sheet.usedRange) : null,
      tables,
      keyCells,
      formulaZones,
      risks: Array.isArray(sheet.risks) ? sheet.risks.map(String).slice(0, 10) : []
    });
  }

  if (out.sheets.length === 0) return null;
  return out;
}

async function understandWorkbook(params = {}, memory = {}) {
  const input = resolveWorkbookInput(params, memory);
  if (!input) {
    return {
      data: {
        workbookPurpose: params.objective || 'Workbook analysis',
        domain: 'unknown',
        confidence: 'low',
        sheets: [],
        recommendedNextActions: ['Read the workbook before reasoning about it.'],
        questionsForUser: [],
        builder: 'no-workbook-context'
      },
      actions: []
    };
  }

  if (process.env.WORKBOOK_UNDERSTANDING_ENABLED === 'false') {
    return { data: fallbackUnderstanding(input, params.objective), actions: [] };
  }

  const compact = compactWorkbookForPrompt(input, params.maxRows || 80, params.maxCols || 40);
  const userText = [
    `User objective: ${params.objective || memory.objective || 'Understand this workbook.'}`,
    `Workbook snapshot:\n${JSON.stringify(compact, null, 2)}`,
    'Return JSON only.'
  ].join('\n\n');

  try {
    const raw = await callLLM({
      system: SYSTEM_PROMPT,
      userText,
      timeoutMs: UNDERSTANDING_TIMEOUT_MS,
      fallbackTimeoutMs: UNDERSTANDING_FALLBACK_TIMEOUT_MS,
      modelOverride: memory?.llm?.modelOverride || undefined,
      label: 'Workbook semantic understanding',
      cachePrompt: true,
      thinkingDisabled: false,
      reasoningEffort: 'high'
    });
    const normalized = normalizeUnderstanding(raw, input, params.objective || memory.objective || '');
    if (!normalized) throw new Error('AI workbook understanding returned no validated sheets/tables');
    logger.info(`[WorkbookUnderstanding] ${normalized.domain}/${normalized.confidence}: ${normalized.sheets.length} sheets`);
    return { data: normalized, actions: [] };
  } catch (error) {
    logger.warn(`[WorkbookUnderstanding] fallback: ${error.message}`);
    return {
      data: {
        ...fallbackUnderstanding(input, params.objective || memory.objective || ''),
        aiError: error.message
      },
      actions: []
    };
  }
}

module.exports = {
  understandWorkbook,
  normalizeUnderstanding,
  fallbackUnderstanding,
  compactWorkbookForPrompt
};
