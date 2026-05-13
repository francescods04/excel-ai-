/**
 * Sheet Parser — auto-discovery di dati finanziari da matrici Excel grezze
 * Estrae label/valore, headers, e input finanziari noti.
 */

const FINANCE_KEYWORDS = new Map([
  ['ebitda vendite', 'EBITDA Margin'],
  ['ebitda revenue', 'EBITDA Margin'],
  ['ebitda margin', 'EBITDA Margin'],
  ['debt equity', 'Debt / Equity'],
  ['debt ebitda', 'Debt / EBITDA'],
  ['ev ebitda', 'EV/EBITDA'],
  ['p e', 'P/E'],
  ['redditivita delle vendite', 'EBIT Margin'],
  ['ros', 'EBIT Margin'],
  ['redditivita del totale attivo', 'ROA'],
  ['roa', 'ROA'],
  ['redditivita del capitale proprio', 'ROE'],
  ['roe', 'ROE'],
  ['ricavi delle vendite', 'Revenue'],
  ['ricavi vendite', 'Revenue'],
  ['ricavi', 'Revenue'],
  ['fatturato', 'Revenue'],
  ['vendite', 'Revenue'],
  ['valore della produzione', 'Revenue'],
  ['revenue', 'Revenue'],
  ['sales', 'Revenue'],
  ['total revenue', 'Revenue'],
  ['margine operativo lordo', 'EBITDA'],
  ['mol', 'EBITDA'],
  ['ebitda', 'EBITDA'],
  ['risultato operativo', 'EBIT'],
  ['reddito operativo', 'EBIT'],
  ['operating income', 'EBIT'],
  ['ebit', 'EBIT'],
  ['utile netto', 'Net Income'],
  ['risultato netto', 'Net Income'],
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
  ['posizione finanziaria netta', 'Net Debt'],
  ['indebitamento finanziario netto', 'Net Debt'],
  ['net financial debt', 'Net Debt'],
  ['pfn', 'Net Debt'],
  ['debiti verso banche', 'Total Debt'],
  ['debiti v banche', 'Total Debt'],
  ['debiti finanziari', 'Total Debt'],
  ['debt', 'Total Debt'],
  ['disponibilita liquide', 'Cash & Equivalents'],
  ['liquidita', 'Cash & Equivalents'],
  ['cassa', 'Cash & Equivalents'],
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
  ['totale attivita', 'Total Assets'],
  ['totale attivo', 'Total Assets'],
  ['attivo totale', 'Total Assets'],
  ['total assets', 'Total Assets'],
  ['totale passivita', 'Total Liabilities'],
  ['totale passivo', 'Total Liabilities'],
  ['total liabilities', 'Total Liabilities'],
  ['patrimonio netto', 'Shareholders Equity'],
  ['mezzi propri', 'Shareholders Equity'],
  ['capitale proprio', 'Shareholders Equity'],
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
  return parseNumber(value) !== null;
}

function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const original = value.trim();
  if (!original || /^#+$/.test(original) || /^(n\.?d\.?|n\.?s\.?|na|n\/a)$/i.test(original)) return null;

  const hasPercent = original.includes('%');
  const hasThousandsUnit = /\b(migl|thousand|k)\b/i.test(original);
  const hasMillionsUnit = /\b(mln|million|mio)\b/i.test(original);
  const hasBillionsUnit = /\b(mld|billion|bn)\b/i.test(original);
  let cleaned = original
    .replace(/\u00a0/g, ' ')
    .replace(/[€$£¥%]/g, '')
    .replace(/\b(EUR|USD|GBP|CHF|JPY|migl|thousand|million|mio|mln|mld|billion|bn|k)\b/gi, '')
    .replace(/[^0-9,.\-()]/g, '')
    .trim();
  if (!cleaned || /^[-.,()]+$/.test(cleaned)) return null;

  let sign = 1;
  if (/^\(.*\)$/.test(cleaned)) {
    sign = -1;
    cleaned = cleaned.slice(1, -1);
  }

  const commaCount = (cleaned.match(/,/g) || []).length;
  const dotCount = (cleaned.match(/\./g) || []).length;
  if (commaCount > 0 && dotCount > 0) {
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const thousandsSep = decimalSep === ',' ? '.' : ',';
    cleaned = cleaned.split(thousandsSep).join('');
    cleaned = cleaned.replace(decimalSep, '.');
  } else if (commaCount > 0) {
    if (commaCount > 1) cleaned = cleaned.replace(/,/g, '');
    else cleaned = cleaned.replace(',', '.');
  } else if (dotCount > 0) {
    const parts = cleaned.split('.');
    const last = parts[parts.length - 1];
    if (dotCount > 1 || (last.length === 3 && parts[0].length <= 3)) {
      cleaned = parts.join('');
    }
  }

  let n = Number(cleaned) * sign;
  if (!Number.isFinite(n)) return null;
  if (hasPercent) n /= 100;
  if (hasThousandsUnit) n *= 1000;
  if (hasMillionsUnit) n *= 1000000;
  if (hasBillionsUnit) n *= 1000000000;
  return Number.isFinite(n) ? n : null;
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
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

  const addInput = ({ label, canonical, value, rawValue, row, col, confidence }) => {
    if (!canonical || value === null || value === undefined) return;
    const key = `${canonical}:${row}:${col}`;
    if (usedCells.has(key)) return;
    inferredInputs.push({
      label: String(label).trim(),
      canonical,
      value,
      rawValue,
      cell: cellAddress(sheetName, row, col),
      confidence,
      row,
      col
    });
    usedCells.add(key);
  };

  // 1. Scansiona per righe label/valori. I financial statements spesso hanno
  // label in colonna A e gli anni molte colonne più a destra.
  for (let r = 0; r < matrix.length; r++) {
    const row = matrix[r] || [];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (typeof cell !== 'string' || cell.trim().length === 0) continue;
      const canonical = classifyLabel(cell);
      if (!canonical) continue;

      let foundOnRow = false;
      for (let valueCol = c + 1; valueCol < row.length; valueCol++) {
        const rawValue = row[valueCol];
        if (!isNumberLike(rawValue)) continue;
        const value = parseNumber(rawValue);
        addInput({
          label: cell,
          canonical,
          value,
          rawValue,
          row: r,
          col: valueCol,
          confidence: 'high'
        });
        foundOnRow = true;
      }

      if (!foundOnRow && r + 1 < matrix.length) {
        const belowCell = (matrix[r + 1] || [])[c];
        if (isNumberLike(belowCell)) {
          addInput({
            label: cell,
            canonical,
            value: parseNumber(belowCell),
            rawValue: belowCell,
            row: r + 1,
            col: c,
            confidence: 'high'
          });
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

function cellAddress(sheetName, rowIndex, colIndex) {
  return `${sheetName}!${colIndexToLetter(colIndex + 1)}${rowIndex + 1}`;
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
  parseNumber,
  classifyLabel,
  FINANCE_KEYWORDS
};
