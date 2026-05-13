'use strict';

const FORMULA_REF_RE = /(?:'([^']+)'|([A-Za-z0-9_ .-]+))!\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?/g;
const ERROR_VALUES = new Set(['#REF!', '#VALUE!', '#DIV/0!', '#NAME?', '#N/A', '#NUM!', '#NULL!']);

function asMatrix(value) {
  if (!Array.isArray(value)) return [];
  if (value.length === 0) return [];
  if (Array.isArray(value[0])) return value;
  return [value];
}

function unwrapData(input) {
  let cur = input || {};
  if (cur.result && typeof cur.result === 'object') cur = cur.result;
  if (cur.data && typeof cur.data === 'object') cur = cur.data;
  return cur || {};
}

function normalizeSheets(input) {
  const data = unwrapData(input);
  if (Array.isArray(data.sheets)) {
    return data.sheets.map(sheet => ({
      name: sheet.name || sheet.sheet || 'Sheet',
      usedRange: sheet.usedRange || sheet.address || null,
      rowCount: Number(sheet.rowCount) || 0,
      columnCount: Number(sheet.columnCount) || 0,
      values: asMatrix(sheet.values || sheet.preview),
      formulas: asMatrix(sheet.formulas),
      numberFormat: asMatrix(sheet.numberFormat)
    }));
  }

  if (data.allSheetsData && typeof data.allSheetsData === 'object') {
    return Object.entries(data.allSheetsData).map(([name, sheet]) => ({
      name,
      usedRange: sheet.usedRange || sheet.address || null,
      rowCount: Number(sheet.rowCount) || 0,
      columnCount: Number(sheet.columnCount) || 0,
      values: asMatrix(sheet.values || sheet.preview),
      formulas: asMatrix(sheet.formulas),
      numberFormat: asMatrix(sheet.numberFormat)
    }));
  }

  if (data.sheet || data.name || data.values || data.preview) {
    return [{
      name: data.sheet || data.name || 'Sheet',
      usedRange: data.usedRange || data.address || null,
      rowCount: Number(data.rowCount) || 0,
      columnCount: Number(data.columnCount) || 0,
      values: asMatrix(data.values || data.preview),
      formulas: asMatrix(data.formulas),
      numberFormat: asMatrix(data.numberFormat)
    }];
  }

  return [];
}

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function rowText(row) {
  return (row || []).map(textOf).filter(Boolean).join(' ').toLowerCase();
}

function workbookText(values) {
  return values.map(rowText).filter(Boolean).join(' ');
}

function isNonEmpty(value) {
  return textOf(value) !== '';
}

function cellAddress(rowIndex, colIndex) {
  let n = colIndex + 1;
  let col = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    col = String.fromCharCode(65 + rem) + col;
    n = Math.floor((n - 1) / 26);
  }
  return `${col}${rowIndex + 1}`;
}

function rangeAddress(startRow, startCol, endRow, endCol) {
  return `${cellAddress(startRow, startCol)}:${cellAddress(endRow, endCol)}`;
}

function classifySheet(name, values) {
  const sheetName = String(name || '').toLowerCase();
  if (/\bwacc\b/.test(sheetName)) return 'wacc';
  if (/sensitivity|sensitivita|sensitività/.test(sheetName)) return 'sensitivity';
  if (/scenario/.test(sheetName)) return 'scenario';
  if (/summary|dashboard|output/.test(sheetName)) return 'output';
  if (/\bdcf\b|valuation|model|modello/.test(sheetName)) return 'model';
  if (/assumptions?|inputs?/.test(sheetName)) return 'assumptions';
  if (/sources?|provenance/.test(sheetName)) return 'sources';
  if (/audit|checks?/.test(sheetName)) return 'audit';

  const key = `${sheetName} ${workbookText(values)}`;
  const tests = [
    ['wacc', /\bwacc\b|cost of equity|risk[- ]?free|beta|capm|cost of debt/],
    ['sensitivity', /sensitivity|data table|wacc x|scenario matrix/],
    ['scenario', /scenario|downside|base case|upside|case output/],
    ['output', /\bsummary\b|dashboard|investment committee|implied share price|enterprise value/],
    ['sources', /sources?|provenance|data quality|as of|provider|market data/],
    ['audit', /audit|check|integrity|error check|balance check|readiness/],
    ['model', /\bdcf\b|valuation|forecast|projection|free cash flow|terminal value|ebitda|nopat/],
    ['assumptions', /\bassumptions?\b|\binput\b|driver|tax rate|terminal growth|market risk premium/],
    ['raw_data', /raw data|export|download|transactions|ledger|trial balance/],
    ['lookup', /lookup|mapping|dictionary|reference table/]
  ];
  for (const [role, re] of tests) {
    if (re.test(key)) return role;
  }
  return 'unknown';
}

function detectBusinessObjects(name, role, values) {
  const key = `${name || ''} ${workbookText(values)}`.toLowerCase();
  const candidates = [
    { type: 'dcf', role: 'model', re: /\bdcf\b|discounted cash flow|unlevered fcf|terminal value|pv of fcf|enterprise value/ },
    { type: 'wacc', role: 'wacc', re: /\bwacc\b|capm|cost of equity|risk[- ]?free|market risk premium|cost of debt/ },
    { type: 'sensitivity', role: 'sensitivity', re: /sensitivity|data table|terminal growth|wacc x|implied share price/ },
    { type: 'scenario', role: 'scenario', re: /scenario|downside|base case|upside/ },
    { type: 'financial_statement', role: 'raw_data', re: /income statement|balance sheet|cash flow|revenue|ebitda|net income|total debt/ },
    { type: 'assumption_set', role: 'assumptions', re: /assumption|driver|growth|margin|tax rate|capex|working capital/ },
    { type: 'audit', role: 'audit', re: /audit|integrity|check|status|error/ }
  ];

  return candidates
    .filter(candidate => candidate.re.test(key) || candidate.role === role)
    .map(candidate => ({
      type: candidate.type,
      sheet: name,
      confidence: candidate.role === role ? 0.85 : 0.7,
      evidence: candidate.re.test(key) ? 'name_or_preview_keywords' : 'sheet_role'
    }));
}

function detectHeaders(values) {
  const headers = [];
  const maxRows = Math.min(values.length, 12);
  for (let r = 0; r < maxRows; r++) {
    const row = values[r] || [];
    const nonEmpty = row.map((value, c) => ({ value: textOf(value), c })).filter(item => item.value);
    if (nonEmpty.length >= 2) {
      headers.push({
        row: r + 1,
        cells: nonEmpty.slice(0, 12).map(item => ({ address: cellAddress(r, item.c), value: item.value }))
      });
    }
  }
  return headers.slice(0, 5);
}

function detectTables(values) {
  const tables = [];
  let r = 0;
  while (r < values.length) {
    const row = values[r] || [];
    const populated = row.map((value, c) => ({ c, value })).filter(item => isNonEmpty(item.value));
    if (populated.length < 2) {
      r++;
      continue;
    }

    let endRow = r;
    let maxCol = Math.max(...populated.map(item => item.c));
    let nonEmptyBodyRows = 0;
    for (let look = r + 1; look < values.length; look++) {
      const body = (values[look] || []).map((value, c) => ({ c, value })).filter(item => isNonEmpty(item.value));
      if (body.length === 0) break;
      maxCol = Math.max(maxCol, ...body.map(item => item.c));
      endRow = look;
      if (body.length >= 2) nonEmptyBodyRows++;
    }

    if (nonEmptyBodyRows >= 1) {
      tables.push({
        headerRow: r + 1,
        range: rangeAddress(r, populated[0].c, endRow, maxCol),
        columns: populated.slice(0, 20).map(item => textOf(item.value)),
        bodyRows: Math.max(0, endRow - r)
      });
      r = endRow + 1;
    } else {
      r++;
    }
  }
  return tables.slice(0, 12);
}

function extractFormulaRefs(formula) {
  const refs = [];
  if (!formula || typeof formula !== 'string') return refs;
  FORMULA_REF_RE.lastIndex = 0;
  let match;
  while ((match = FORMULA_REF_RE.exec(formula)) !== null) {
    const sheet = (match[1] || match[2] || '').trim();
    const start = `${match[3]}${match[4]}`;
    const end = match[5] && match[6] ? `${match[5]}${match[6]}` : null;
    refs.push({
      sheet,
      target: end ? `${start}:${end}` : start
    });
  }
  return refs;
}

function detectIssues(sheetName, values, formulas) {
  const issues = [];
  const rowCount = Math.max(values.length, formulas.length);
  for (let r = 0; r < rowCount; r++) {
    const valueRow = values[r] || [];
    const formulaRow = formulas[r] || [];
    const colCount = Math.max(valueRow.length, formulaRow.length);
    for (let c = 0; c < colCount; c++) {
      const value = textOf(valueRow[c]).toUpperCase();
      const formula = textOf(formulaRow[c]).toUpperCase();
      const addr = cellAddress(r, c);
      const foundError = ERROR_VALUES.has(value) ? value : (ERROR_VALUES.has(formula) ? formula : null);
      if (foundError) {
        issues.push({
          severity: foundError === '#REF!' ? 'error' : 'warn',
          type: 'excel_error',
          sheet: sheetName,
          cell: addr,
          message: `${foundError} detected`
        });
      }
      if (formula.includes('#REF!')) {
        issues.push({
          severity: 'error',
          type: 'broken_reference',
          sheet: sheetName,
          cell: addr,
          message: 'Formula contains #REF!'
        });
      }
    }
  }
  return issues;
}

function analyzeFormulas(sheetName, formulas) {
  const formulaCells = [];
  const refsBySheet = {};
  const dependencyEdges = [];
  let formulaCount = 0;
  let crossSheetCount = 0;

  formulas.forEach((row, r) => {
    (row || []).forEach((formulaValue, c) => {
      const formula = textOf(formulaValue);
      if (!formula.startsWith('=')) return;
      formulaCount++;
      const refs = extractFormulaRefs(formula);
      const crossSheetRefs = refs.filter(ref => ref.sheet && ref.sheet !== sheetName);
      if (crossSheetRefs.length > 0) crossSheetCount++;
      for (const ref of crossSheetRefs) {
        refsBySheet[ref.sheet] = (refsBySheet[ref.sheet] || 0) + 1;
        dependencyEdges.push({
          from: `${sheetName}!${cellAddress(r, c)}`,
          to: `${ref.sheet}!${ref.target}`,
          type: 'formula_reference'
        });
      }
      if (formulaCells.length < 300) {
        formulaCells.push({
          cell: cellAddress(r, c),
          formula: formula.length > 240 ? `${formula.slice(0, 237)}...` : formula,
          refs,
          crossSheetRefs
        });
      }
    });
  });

  return { formulaCells, formulaCount, crossSheetCount, refsBySheet, dependencyEdges };
}

function sheetStats(values) {
  const rowCount = values.length;
  const columnCount = values.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
  const possible = rowCount * columnCount;
  const nonEmpty = values.reduce((sum, row) => sum + (row || []).filter(isNonEmpty).length, 0);
  return {
    previewRows: rowCount,
    previewColumns: columnCount,
    nonEmptyCells: nonEmpty,
    density: possible > 0 ? Number((nonEmpty / possible).toFixed(3)) : 0
  };
}

function buildWorkbookGraph(input, options = {}) {
  const data = unwrapData(input);
  const sheets = normalizeSheets(data);
  const graph = {
    version: 1,
    workbook: {
      id: options.workbookId || data.workbookId || null,
      name: options.workbookName || data.workbookName || data.name || 'Active workbook',
      source: options.source || data.source || 'excel',
      activeSheet: data.activeSheet || null,
      sheetCount: Array.isArray(data.workbookSheets) ? data.workbookSheets.length : sheets.length
    },
    sheets: [],
    formulas: {
      count: 0,
      crossSheetCount: 0,
      refsBySheet: {},
      dependencyEdges: []
    },
    issues: [],
    businessObjects: [],
    summary: {
      sheetCount: 0,
      nonEmptySheetCount: 0,
      formulaCount: 0,
      issueCount: 0,
      roles: {},
      detectedModels: []
    }
  };

  for (const sheet of sheets) {
    const values = asMatrix(sheet.values || sheet.preview);
    const formulas = asMatrix(sheet.formulas);
    const stats = sheetStats(values);
    const role = classifySheet(sheet.name, values);
    const formulaInfo = analyzeFormulas(sheet.name, formulas);
    const issues = detectIssues(sheet.name, values, formulas);
    const objects = detectBusinessObjects(sheet.name, role, values);

    graph.sheets.push({
      name: sheet.name,
      usedRange: sheet.usedRange || null,
      rowCount: sheet.rowCount || stats.previewRows,
      columnCount: sheet.columnCount || stats.previewColumns,
      role,
      density: stats.density,
      previewRows: stats.previewRows,
      previewColumns: stats.previewColumns,
      nonEmptyCells: stats.nonEmptyCells,
      formulaCount: formulaInfo.formulaCount,
      formulaCells: formulaInfo.formulaCells,
      errorCount: issues.filter(issue => issue.severity === 'error').length,
      headers: detectHeaders(values),
      tables: detectTables(values)
    });

    graph.formulas.count += formulaInfo.formulaCount;
    graph.formulas.crossSheetCount += formulaInfo.crossSheetCount;
    graph.formulas.dependencyEdges.push(...formulaInfo.dependencyEdges);
    for (const [refSheet, count] of Object.entries(formulaInfo.refsBySheet)) {
      graph.formulas.refsBySheet[refSheet] = (graph.formulas.refsBySheet[refSheet] || 0) + count;
    }
    graph.issues.push(...issues);
    graph.businessObjects.push(...objects);
  }

  graph.summary.sheetCount = graph.sheets.length;
  graph.summary.nonEmptySheetCount = graph.sheets.filter(sheet => sheet.nonEmptyCells > 0).length;
  graph.summary.formulaCount = graph.formulas.count;
  graph.summary.issueCount = graph.issues.length;
  for (const sheet of graph.sheets) {
    graph.summary.roles[sheet.role] = (graph.summary.roles[sheet.role] || 0) + 1;
  }
  graph.summary.detectedModels = Array.from(new Set(
    graph.businessObjects
      .filter(item => item.confidence >= 0.65)
      .map(item => item.type)
  ));

  return graph;
}

module.exports = {
  buildWorkbookGraph,
  normalizeSheets,
  extractFormulaRefs,
  classifySheet
};
