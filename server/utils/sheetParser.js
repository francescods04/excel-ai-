/**
 * Sheet Parser — auto-discovery di dati finanziari da matrici Excel grezze
 * Estrae label/valore, headers, e input finanziari noti.
 */

const FINANCE_KEYWORDS = new Map([
  ['revenue', 'Revenue'],
  ['sales', 'Revenue'],
  ['total revenue', 'Revenue'],
  ['ebitda', 'EBITDA'],
  ['operating income', 'EBIT'],
  ['ebit', 'EBIT'],
  ['net income', 'Net Income'],
  ['net profit', 'Net Income'],
  ['profit', 'Net Income'],
  ['free cash flow', 'FCF'],
  ['fcf', 'FCF'],
  ['capex', 'CapEx'],
  ['capital expenditure', 'CapEx'],
  ['depreciation', 'D&A'],
  ['amortization', 'D&A'],
  ['tax rate', 'Tax Rate'],
  ['tax', 'Tax Rate'],
  ['growth', 'Revenue Growth'],
  ['growth rate', 'Revenue Growth'],
  ['margin', 'EBITDA Margin'],
  ['ebitda margin', 'EBITDA Margin'],
  ['operating margin', 'EBIT Margin'],
  ['net margin', 'Net Margin'],
  ['wacc', 'WACC'],
  ['beta', 'Beta'],
  ['risk free', 'Risk-Free Rate'],
  ['risk-free', 'Risk-Free Rate'],
  ['market risk premium', 'Market Risk Premium'],
  ['erp', 'Market Risk Premium'],
  ['equity risk premium', 'Market Risk Premium'],
  ['terminal growth', 'Terminal Growth Rate'],
  ['perpetuity growth', 'Terminal Growth Rate'],
  ['debt', 'Total Debt'],
  ['cash', 'Cash & Equivalents'],
  ['shares', 'Shares Outstanding'],
  ['shares outstanding', 'Shares Outstanding'],
  ['diluted shares', 'Diluted Shares'],
  ['share price', 'Share Price'],
  ['stock price', 'Share Price'],
  ['ev/ebitda', 'EV/EBITDA'],
  ['p/e', 'P/E'],
  ['price earnings', 'P/E'],
  ['eps', 'EPS'],
  ['book value', 'Book Value'],
  ['total assets', 'Total Assets'],
  ['total liabilities', 'Total Liabilities'],
  ['shareholders equity', 'Shareholders Equity'],
  ['equity', 'Shareholders Equity'],
  ['roi', 'ROI'],
  ['roe', 'ROE'],
  ['return on equity', 'ROE'],
  ['roic', 'ROIC'],
  ['return on invested capital', 'ROIC'],
  ['gross profit', 'Gross Profit'],
  ['gross margin', 'Gross Margin'],
  ['cost of goods sold', 'COGS'],
  ['cogs', 'COGS'],
  ['sg&a', 'SG&A'],
  ['rnd', 'R&D'],
  ['research and development', 'R&D'],
  ['interest expense', 'Interest Expense'],
  ['dso', 'DSO'],
  ['dio', 'DIO'],
  ['dpo', 'DPO'],
  ['nwc', 'Net Working Capital'],
  ['working capital', 'Net Working Capital'],
]);

function isNumberLike(value) {
  if (typeof value === 'number') return true;
  if (typeof value !== 'string') return false;
  const cleaned = value.replace(/[$%,\s]/g, '');
  return !isNaN(parseFloat(cleaned)) && isFinite(parseFloat(cleaned));
}

function parseNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[$,%\s]/g, '');
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : null;
}

function isHeaderLike(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length === 0) return false;
  // Anni tipo 2024, 2025, FY2024, Q1 2024
  if (/^(FY)?\d{4}$/i.test(text)) return true;
  if (/^(Q[1-4]|H[1-2])\s*\d{4}$/i.test(text)) return true;
  // Label comuni
  if (/^(Year|Period|Scenario|Actual|Budget|Forecast|Projected)$/i.test(text)) return true;
  return false;
}

function normalizeLabel(text) {
  if (typeof text !== 'string') return '';
  return text.toLowerCase().replace(/[^a-z0-9\s&]/g, '').trim();
}

function classifyLabel(labelText) {
  const normalized = normalizeLabel(labelText);
  for (const [key, canonical] of FINANCE_KEYWORDS) {
    if (normalized.includes(key)) return canonical;
  }
  return null;
}

function inferUnit(values) {
  // Stima se i numeri sono in milioni/miliardi/unità
  const nums = values.map(parseNumber).filter(n => n !== null);
  if (nums.length === 0) return null;
  const maxAbs = Math.max(...nums.map(Math.abs));
  if (maxAbs >= 1e9) return 'billions';
  if (maxAbs >= 1e6) return 'millions';
  if (maxAbs >= 1e3) return 'thousands';
  return 'units';
}

function inferDataType(values) {
  const nums = values.map(parseNumber).filter(n => n !== null);
  if (nums.length === 0) return 'text';
  // Se tutti i valori sono tra -1 e 1 (escluso 0), probabilmente percentuali
  const allRatios = nums.every(n => Math.abs(n) <= 1 && n !== 0);
  const anyPercentSymbol = values.some(v => typeof v === 'string' && v.includes('%'));
  if (allRatios || anyPercentSymbol) return 'percentage';
  return 'number';
}

/**
 * Analizza una matrice 2D (rows x cols) estraendo struttura finanziaria
 */
function parseSheetMatrix(matrix, sheetName = 'Sheet1') {
  if (!Array.isArray(matrix) || matrix.length === 0) {
    return { inferredInputs: [], headers: [], dataRows: [], summary: '' };
  }

  const maxCols = Math.max(...matrix.map(row => (Array.isArray(row) ? row.length : 0)));
  const inferredInputs = [];
  const headers = [];
  const dataRows = [];
  const usedCells = new Set();

  // 1. Scansiona per coppie label/valore
  for (let r = 0; r < matrix.length; r++) {
    const row = matrix[r] || [];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      const key = `${r},${c}`;
      if (usedCells.has(key)) continue;

      // Se è una stringa (potenziale label) e a destra c'è un numero
      if (typeof cell === 'string' && cell.trim().length > 0 && c + 1 < maxCols) {
        const rightCell = (matrix[r] || [])[c + 1];
        if (isNumberLike(rightCell)) {
          const canonical = classifyLabel(cell);
          const value = parseNumber(rightCell);
          inferredInputs.push({
            label: cell.trim(),
            canonical: canonical || cell.trim(),
            value,
            rawValue: rightCell,
            cell: `${sheetName}!${colIndexToLetter(c + 1)}${r + 1}`,
            confidence: canonical ? 'high' : 'medium',
            row,
            col: c + 1
          });
          usedCells.add(key);
          usedCells.add(`${r},${c + 1}`);
        }
      }

      // Se è una stringa e sotto c'è un numero (layout verticale)
      if (typeof cell === 'string' && cell.trim().length > 0 && r + 1 < matrix.length) {
        const belowCell = (matrix[r + 1] || [])[c];
        if (isNumberLike(belowCell) && !usedCells.has(`${r + 1},${c}`)) {
          const canonical = classifyLabel(cell);
          const value = parseNumber(belowCell);
          inferredInputs.push({
            label: cell.trim(),
            canonical: canonical || cell.trim(),
            value,
            rawValue: belowCell,
            cell: `${sheetName}!${colIndexToLetter(c)}${r + 2}`,
            confidence: canonical ? 'high' : 'medium',
            row: r + 1,
            col: c
          });
          usedCells.add(key);
          usedCells.add(`${r + 1},${c}`);
        }
      }
    }
  }

  // 2. Identifica headers (righe con tanti valori header-like)
  for (let r = 0; r < matrix.length; r++) {
    const row = matrix[r] || [];
    const headerCandidates = row.filter(isHeaderLike);
    if (headerCandidates.length >= 2) {
      headers.push({
        row: r,
        values: headerCandidates,
        raw: row
      });
    }
  }

  // 3. Data rows: righe con numeri
  for (let r = 0; r < matrix.length; r++) {
    const row = matrix[r] || [];
    const nums = row.filter(isNumberLike);
    const strings = row.filter(v => typeof v === 'string' && v.trim().length > 0);
    if (nums.length >= 2 || (strings.length >= 1 && nums.length >= 1)) {
      dataRows.push({ row: r, values: row });
    }
  }

  // 4. Unità e tipo
  const allValues = inferredInputs.map(i => i.rawValue);
  const unit = inferUnit(allValues);
  const dataType = inferDataType(allValues);

  // 5. Riassunto testuale per il prompt
  const lines = [];
  if (inferredInputs.length > 0) {
    lines.push(`Inferred ${inferredInputs.length} financial inputs (${unit || 'unknown unit'}):`);
    for (const inp of inferredInputs.slice(0, 20)) {
      lines.push(`  - ${inp.canonical}: ${inp.rawValue} (${inp.confidence} confidence) at ${inp.cell}`);
    }
  }
  if (headers.length > 0) {
    lines.push(`Headers found: ${headers.map(h => h.values.join(', ')).join(' | ')}`);
  }

  return {
    inferredInputs,
    headers,
    dataRows,
    unit,
    dataType,
    summary: lines.join('\n')
  };
}

function colIndexToLetter(colIndex) {
  let result = '';
  let n = colIndex;
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

/**
 * Wrapper per i dati grezzi del workbook
 */
function analyzeWorkbookContext(rawContext) {
  const sheets = [];
  const allInferredInputs = [];
  const seen = new Set(); // dedupe by sheet name once we have a "fullSheet" entry

  // Multi-sheet preview from allSheetsData (preferred — covers every sheet)
  if (rawContext?.allSheetsData && typeof rawContext.allSheetsData === 'object') {
    for (const [sheetName, info] of Object.entries(rawContext.allSheetsData)) {
      if (!info || !Array.isArray(info.preview) || info.preview.length === 0) continue;
      const parsed = parseSheetMatrix(info.preview, sheetName);
      const inputs = parsed.inferredInputs.map(i => ({ ...i, sheet: sheetName }));
      allInferredInputs.push(...inputs);
      sheets.push({
        name: sheetName,
        type: 'fullSheet',
        isActive: !!info.isActive,
        usedRange: info.usedRange || null,
        ...parsed,
        inferredInputs: inputs
      });
      seen.add(sheetName);
    }
  } else if (rawContext?.sheetData && typeof rawContext.sheetData === 'object') {
    // Legacy fallback: sheetData map
    for (const [sheetName, data] of Object.entries(rawContext.sheetData)) {
      if (!Array.isArray(data) || data.length === 0) continue;
      const parsed = parseSheetMatrix(data, sheetName);
      const inputs = parsed.inferredInputs.map(i => ({ ...i, sheet: sheetName }));
      allInferredInputs.push(...inputs);
      sheets.push({ name: sheetName, type: 'fullSheet', ...parsed, inferredInputs: inputs });
      seen.add(sheetName);
    }
  }

  // Active sheet selection (only add if not already covered)
  const activeName = rawContext?.activeSheet;
  if (
    rawContext?.selectedValues &&
    Array.isArray(rawContext.selectedValues) &&
    rawContext.selectedValues.length > 0 &&
    activeName &&
    !seen.has(activeName)
  ) {
    const parsed = parseSheetMatrix(rawContext.selectedValues, activeName || 'Selection');
    const inputs = parsed.inferredInputs.map(i => ({ ...i, sheet: activeName }));
    allInferredInputs.push(...inputs);
    sheets.push({ name: activeName || 'Selection', type: 'selectedRange', ...parsed, inferredInputs: inputs });
  }

  // Active sheet used range fallback
  if (
    rawContext?.usedRangeData &&
    Array.isArray(rawContext.usedRangeData) &&
    rawContext.usedRangeData.length > 0 &&
    activeName &&
    !seen.has(activeName)
  ) {
    const parsed = parseSheetMatrix(rawContext.usedRangeData, activeName || 'ActiveSheet');
    const inputs = parsed.inferredInputs.map(i => ({ ...i, sheet: activeName }));
    allInferredInputs.push(...inputs);
    sheets.push({ name: activeName || 'ActiveSheet', type: 'usedRange', ...parsed, inferredInputs: inputs });
  }

  return {
    sheets,
    inferredInputs: allInferredInputs,
    inferredInputsByCanonical: Object.fromEntries(
      allInferredInputs
        .filter(i => i.canonical && i.confidence === 'high')
        .map(i => [`${i.sheet || ''}::${i.canonical}`, i])
    ),
    summary: sheets.map(s => `Sheet "${s.name}"${s.isActive ? ' (active)' : ''}:\n${s.summary}`).join('\n\n')
  };
}

module.exports = {
  parseSheetMatrix,
  analyzeWorkbookContext,
  FINANCE_KEYWORDS
};
