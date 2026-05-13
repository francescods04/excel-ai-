const DEFAULT_PALETTE = {
  name: 'blue',
  titleFill: '#1F4E78',
  headerFill: '#404040',
  sectionFill: '#D9E1F2',
  sectionFont: '#000000',
  inputFill: '#E6F2FF',
  inputFont: '#0000FF',
  totalFill: '#F2F2F2',
  checkFill: '#FFF2CC',
  bodyFont: '#111827',
  mutedFont: '#404040',
  white: '#FFFFFF'
};

const RED_PALETTE = {
  name: 'red',
  titleFill: '#7F1D1D',
  headerFill: '#2F2F2F',
  sectionFill: '#F4CCCC',
  sectionFont: '#5F1B1B',
  inputFill: '#FCE4D6',
  inputFont: '#9C0006',
  totalFill: '#F2F2F2',
  checkFill: '#FFF2CC',
  bodyFont: '#111827',
  mutedFont: '#404040',
  white: '#FFFFFF'
};

const NUM_FORMATS = {
  currency: '$#,##0.0;[Red]($#,##0.0);-',
  percent: '0.00%;[Red](0.00%);-',
  multiple: '0.00x',
  perShare: '$#,##0.00;[Red]($#,##0.00);-',
  number: '#,##0.0;[Red](#,##0.0);-',
  text: '@'
};

function colToIndex(col) {
  return String(col || 'A').toUpperCase().split('').reduce((sum, ch) => sum * 26 + ch.charCodeAt(0) - 64, 0);
}

function indexToCol(index) {
  let n = Math.max(1, Number(index) || 1);
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function stripSheet(address) {
  return String(address || '').split('!').pop().replace(/\$/g, '');
}

function parseRange(address, fallbackRows = 1, fallbackCols = 1) {
  const bare = stripSheet(address);
  const match = bare.match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i);
  if (!match) {
    return {
      startCol: 1,
      startRow: 1,
      endCol: Math.max(1, fallbackCols),
      endRow: Math.max(1, fallbackRows)
    };
  }
  const startCol = colToIndex(match[1]);
  const startRow = Number(match[2]);
  return {
    startCol,
    startRow,
    endCol: match[3] ? colToIndex(match[3]) : startCol + Math.max(1, fallbackCols) - 1,
    endRow: match[4] ? Number(match[4]) : startRow + Math.max(1, fallbackRows) - 1
  };
}

function a1(startCol, startRow, endCol = startCol, endRow = startRow) {
  const start = `${indexToCol(startCol)}${startRow}`;
  const end = `${indexToCol(endCol)}${endRow}`;
  return start === end ? start : `${start}:${end}`;
}

function fmt(sheet, target, options) {
  return { type: 'setCellFormat', sheet, target, options };
}

function cond(sheet, target, options) {
  return { type: 'addConditionalFormat', sheet, target, options };
}

function choosePalette(params = {}) {
  const text = `${params.objective || ''} ${params.theme || ''}`.toLowerCase();
  if (/(rosso|rossa|red|burgundy|maroon|crimson)/.test(text)) return RED_PALETTE;
  return DEFAULT_PALETTE;
}

function collectWorkbookSheets(params = {}, memory = {}) {
  const byName = new Map();

  function addSheet(sheet) {
    if (!sheet || !sheet.name) return;
    byName.set(sheet.name, {
      name: sheet.name,
      usedRange: sheet.usedRange || null,
      rowCount: Number(sheet.rowCount) || 0,
      columnCount: Number(sheet.columnCount) || 0,
      preview: Array.isArray(sheet.preview) ? sheet.preview : []
    });
  }

  const results = memory?.results && typeof memory.results === 'object' ? memory.results : {};
  for (const result of Object.values(results)) {
    const data = result?.data || result;
    if (Array.isArray(data?.sheets)) data.sheets.forEach(addSheet);
    if (data?.allSheetsData && typeof data.allSheetsData === 'object') {
      for (const [name, info] of Object.entries(data.allSheetsData)) addSheet({ name, ...info });
    }
  }

  if (memory?.context?.allSheetsData && typeof memory.context.allSheetsData === 'object') {
    for (const [name, info] of Object.entries(memory.context.allSheetsData)) addSheet({ name, ...info });
  }

  const explicitSheets = Array.isArray(params.sheets) ? params.sheets : [];
  explicitSheets.forEach(name => addSheet({ name, rowCount: 40, columnCount: 8, preview: [] }));
  if (params.sheet && byName.size === 0) addSheet({ name: params.sheet, rowCount: 40, columnCount: 8, preview: [] });

  return Array.from(byName.values()).filter(sheet => sheet.rowCount > 0 || sheet.usedRange || sheet.name === params.sheet);
}

function nonEmptyCount(row) {
  return (row || []).filter(value => value !== '' && value !== null && value !== undefined).length;
}

function firstText(row) {
  return String((row || [])[0] ?? '').trim();
}

function classifyRow(row) {
  const first = firstText(row);
  const lower = first.toLowerCase();
  const count = nonEmptyCount(row);
  if (!first) return null;
  if (count >= 2 && /(metric|scenario|input|driver|wacc|year|case|value|source|check|result)/i.test(row.join(' '))) return 'header';
  if (count === 1 || /(source|scope|summary|output|assumption|projection|wacc input|cost of|capital structure|sensitivity|scenario|audit|readiness|status|valuation bridge|terminal|equity bridge)/.test(lower)) return 'section';
  if (/(total|enterprise value|equity value|implied share price|wacc|model status|premium|discount|bridge check)/.test(lower)) return 'total';
  if (/(check|status|review|ready)/.test(lower)) return 'check';
  return null;
}

function applyDetectedRows(actions, sheet, info, range, palette) {
  const preview = Array.isArray(info.preview) ? info.preview : [];
  const maxRows = Math.min(preview.length, 80);
  for (let idx = 0; idx < maxRows; idx++) {
    const row = preview[idx];
    const rowNumber = range.startRow + idx;
    const target = a1(range.startCol, rowNumber, range.endCol, rowNumber);
    const kind = classifyRow(row);
    if (kind === 'header') {
      actions.push(fmt(sheet, target, { backgroundColor: palette.headerFill, fontColor: palette.white, bold: true, horizontalAlignment: 'Center' }));
    } else if (kind === 'section') {
      actions.push(fmt(sheet, target, { backgroundColor: palette.sectionFill, fontColor: palette.sectionFont, bold: true, horizontalAlignment: 'Left' }));
    } else if (kind === 'total') {
      actions.push(fmt(sheet, target, { backgroundColor: palette.totalFill, fontColor: palette.bodyFont, bold: true }));
    } else if (kind === 'check') {
      actions.push(fmt(sheet, target, { backgroundColor: palette.checkFill, fontColor: palette.bodyFont, italic: true }));
    }
  }
}

function addBaseSheetFormatting(actions, sheet, info, palette) {
  const range = parseRange(info.usedRange, info.rowCount || 40, info.columnCount || 8);
  if (range.endRow < range.startRow) range.endRow = range.startRow + Math.max(1, info.rowCount || 1) - 1;
  if (range.endCol < range.startCol) range.endCol = range.startCol + Math.max(1, info.columnCount || 1) - 1;

  const used = a1(range.startCol, range.startRow, range.endCol, range.endRow);
  actions.push(fmt(sheet, used, { backgroundColor: palette.white, fontColor: palette.bodyFont }));
  actions.push(fmt(sheet, a1(range.startCol, range.startRow, range.startCol, range.endRow), { horizontalAlignment: 'Left', fontColor: palette.bodyFont }));
  if (range.endCol > range.startCol) {
    actions.push(fmt(sheet, a1(range.startCol + 1, range.startRow, range.endCol, range.endRow), { horizontalAlignment: 'Right' }));
  }
  actions.push(fmt(sheet, a1(range.startCol, range.startRow, range.endCol, range.startRow), { backgroundColor: palette.titleFill, fontColor: palette.white, bold: true, horizontalAlignment: 'Left' }));

  if (range.endRow > range.startRow) {
    actions.push(fmt(sheet, a1(range.startCol, range.startRow + 1, range.endCol, range.startRow + 1), { backgroundColor: palette.headerFill, fontColor: palette.white, bold: true, horizontalAlignment: 'Center' }));
  }

  applyDetectedRows(actions, sheet, info, range, palette);
  return range;
}

function addDcfSheetFormatting(actions, sheet, palette) {
  const p = palette;
  switch (sheet.toLowerCase()) {
    case 'summary':
      actions.push(fmt(sheet, 'A1:C1', { backgroundColor: p.titleFill, fontColor: p.white, bold: true }));
      actions.push(fmt(sheet, 'A3:C3', { backgroundColor: p.sectionFill, fontColor: p.sectionFont, bold: true }));
      actions.push(fmt(sheet, 'A15:C15', { backgroundColor: p.sectionFill, fontColor: p.sectionFont, bold: true }));
      actions.push(fmt(sheet, 'A23:C23', { backgroundColor: p.sectionFill, fontColor: p.sectionFont, bold: true }));
      actions.push(fmt(sheet, 'A4:C4', { backgroundColor: p.headerFill, fontColor: p.white, bold: true, horizontalAlignment: 'Center' }));
      actions.push(fmt(sheet, 'A16:C16', { backgroundColor: p.headerFill, fontColor: p.white, bold: true, horizontalAlignment: 'Center' }));
      actions.push(fmt(sheet, 'A24:C24', { backgroundColor: p.headerFill, fontColor: p.white, bold: true, horizontalAlignment: 'Center' }));
      actions.push(fmt(sheet, 'B5:B11', { numberFormat: NUM_FORMATS.currency }));
      actions.push(fmt(sheet, 'B7:B8', { numberFormat: NUM_FORMATS.perShare, bold: true }));
      actions.push(fmt(sheet, 'B9:B11', { numberFormat: NUM_FORMATS.percent }));
      break;
    case 'sources':
      actions.push(fmt(sheet, 'A1:D1', { backgroundColor: p.titleFill, fontColor: p.white, bold: true }));
      ['A3:D3', 'A10:D10', 'A22:C22', 'A35:C35'].forEach(target => actions.push(fmt(sheet, target, { backgroundColor: p.sectionFill, fontColor: p.sectionFont, bold: true })));
      ['A11:D11', 'A23:C23', 'A36:C36'].forEach(target => actions.push(fmt(sheet, target, { backgroundColor: p.headerFill, fontColor: p.white, bold: true, horizontalAlignment: 'Center' })));
      actions.push(fmt(sheet, 'D12:D18', { backgroundColor: p.checkFill, fontColor: p.bodyFont, italic: true }));
      break;
    case 'assumptions':
      actions.push(fmt(sheet, 'A1:B1', { backgroundColor: p.titleFill, fontColor: p.white, bold: true }));
      ['A3:B3', 'A9:B9', 'A17:B17', 'A25:B25', 'A32:B32'].forEach(target => actions.push(fmt(sheet, target, { backgroundColor: p.sectionFill, fontColor: p.sectionFont, bold: true })));
      ['B4:B7', 'B10:B15', 'B18:B23', 'B26:B30', 'B33:B36'].forEach(target => actions.push(fmt(sheet, target, { backgroundColor: p.inputFill, fontColor: p.inputFont })));
      actions.push(fmt(sheet, 'B11:B15', { numberFormat: NUM_FORMATS.percent }));
      actions.push(fmt(sheet, 'B18:B27', { numberFormat: NUM_FORMATS.percent }));
      actions.push(fmt(sheet, 'B29:B30', { numberFormat: NUM_FORMATS.percent }));
      actions.push(fmt(sheet, 'B10:B10', { numberFormat: NUM_FORMATS.currency }));
      actions.push(fmt(sheet, 'B33:B34', { numberFormat: NUM_FORMATS.currency }));
      actions.push(fmt(sheet, 'B36:B37', { numberFormat: NUM_FORMATS.perShare }));
      actions.push(fmt(sheet, 'B28:B30', { numberFormat: NUM_FORMATS.multiple }));
      break;
    case 'wacc':
      actions.push(fmt(sheet, 'A1:B1', { backgroundColor: p.titleFill, fontColor: p.white, bold: true }));
      ['A3:B3', 'A9:B9', 'A14:B14'].forEach(target => actions.push(fmt(sheet, target, { backgroundColor: p.sectionFill, fontColor: p.sectionFont, bold: true })));
      ['A7:B7', 'A12:B12', 'A19:B19'].forEach(target => actions.push(fmt(sheet, target, { backgroundColor: p.totalFill, fontColor: p.bodyFont, bold: true })));
      actions.push(fmt(sheet, 'B4:B19', { numberFormat: NUM_FORMATS.percent }));
      actions.push(fmt(sheet, 'B5:B5', { numberFormat: NUM_FORMATS.multiple }));
      actions.push(fmt(sheet, 'B15:B15', { numberFormat: NUM_FORMATS.multiple }));
      break;
    case 'dcf':
      actions.push(fmt(sheet, 'A1:H1', { backgroundColor: p.titleFill, fontColor: p.white, bold: true }));
      actions.push(fmt(sheet, 'A2:H2', { backgroundColor: p.headerFill, fontColor: p.white, bold: true, horizontalAlignment: 'Center' }));
      ['A20:H20', 'A24:H24', 'A27:H28', 'A30:H35', 'A38:H40'].forEach(target => actions.push(fmt(sheet, target, { backgroundColor: p.totalFill, fontColor: p.bodyFont, bold: true })));
      ['B5:H35', 'B37:H40'].forEach(target => actions.push(fmt(sheet, target, { numberFormat: NUM_FORMATS.currency })));
      ['B4:H4', 'B6:H6', 'B8:H8', 'B11:H11', 'B15:H15', 'B17:H17', 'B22:H22', 'H26:H26', 'H38:H38'].forEach(target => actions.push(fmt(sheet, target, { numberFormat: NUM_FORMATS.percent })));
      actions.push(fmt(sheet, 'H35:H37', { numberFormat: NUM_FORMATS.perShare }));
      break;
    case 'sensitivity':
      actions.push(fmt(sheet, 'A1:G1', { backgroundColor: p.titleFill, fontColor: p.white, bold: true }));
      ['A3:G3', 'A12:G12'].forEach(target => actions.push(fmt(sheet, target, { backgroundColor: p.sectionFill, fontColor: p.sectionFont, bold: true })));
      ['B4:G4', 'B13:G13'].forEach(target => actions.push(fmt(sheet, target, { backgroundColor: p.headerFill, fontColor: p.white, bold: true, horizontalAlignment: 'Center' })));
      actions.push(fmt(sheet, 'B5:B9', { backgroundColor: p.inputFill, fontColor: p.inputFont, numberFormat: NUM_FORMATS.percent }));
      actions.push(fmt(sheet, 'B14:B18', { backgroundColor: p.inputFill, fontColor: p.inputFont, numberFormat: NUM_FORMATS.percent }));
      actions.push(fmt(sheet, 'C5:G9', { numberFormat: NUM_FORMATS.perShare }));
      actions.push(fmt(sheet, 'C14:G18', { numberFormat: NUM_FORMATS.currency }));
      actions.push(cond(sheet, 'C5:G9', { colorScale: { minColor: '#F4CCCC', midColor: '#FFFFFF', maxColor: '#D9EAD3' } }));
      actions.push(cond(sheet, 'C14:G18', { colorScale: { minColor: '#F4CCCC', midColor: '#FFFFFF', maxColor: '#D9EAD3' } }));
      break;
    case 'scenarios':
      actions.push(fmt(sheet, 'A1:G1', { backgroundColor: p.titleFill, fontColor: p.white, bold: true }));
      ['A3:G3', 'A11:D11'].forEach(target => actions.push(fmt(sheet, target, { backgroundColor: p.sectionFill, fontColor: p.sectionFont, bold: true })));
      ['A4:G4', 'A12:D12'].forEach(target => actions.push(fmt(sheet, target, { backgroundColor: p.headerFill, fontColor: p.white, bold: true, horizontalAlignment: 'Center' })));
      actions.push(fmt(sheet, 'B5:E7', { backgroundColor: p.inputFill, fontColor: p.inputFont, numberFormat: NUM_FORMATS.percent }));
      actions.push(fmt(sheet, 'F5:F7', { numberFormat: NUM_FORMATS.perShare }));
      actions.push(fmt(sheet, 'G5:G7', { numberFormat: NUM_FORMATS.percent }));
      actions.push(cond(sheet, 'F5:G7', { colorScale: { minColor: '#F4CCCC', midColor: '#FFFFFF', maxColor: '#D9EAD3' } }));
      break;
    case 'audit':
      actions.push(fmt(sheet, 'A1:C1', { backgroundColor: p.titleFill, fontColor: p.white, bold: true }));
      ['A3:C3', 'A16:B16', 'A19:A19'].forEach(target => actions.push(fmt(sheet, target, { backgroundColor: p.sectionFill, fontColor: p.sectionFont, bold: true })));
      actions.push(fmt(sheet, 'A4:C4', { backgroundColor: p.headerFill, fontColor: p.white, bold: true, horizontalAlignment: 'Center' }));
      actions.push(fmt(sheet, 'B5:B12', { backgroundColor: p.checkFill, fontColor: p.bodyFont, italic: true }));
      actions.push(fmt(sheet, 'A17:B17', { backgroundColor: p.totalFill, fontColor: p.bodyFont, bold: true }));
      break;
    default:
      break;
  }
}

function dedupeActions(actions) {
  const seen = new Set();
  const out = [];
  for (const action of actions) {
    const key = `${action.type}|${action.sheet}|${action.target}|${JSON.stringify(action.options || {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(action);
  }
  return out;
}

function buildProfessionalFormatPlan(params = {}, memory = {}) {
  const palette = choosePalette(params);
  const sheets = collectWorkbookSheets(params, memory);
  const actions = [];

  for (const info of sheets) {
    addBaseSheetFormatting(actions, info.name, info, palette);
    addDcfSheetFormatting(actions, info.name, palette);
  }

  return {
    data: {
      builder: 'deterministic-format',
      theme: palette.name,
      sheetCount: sheets.length,
      actionCount: actions.length
    },
    actions: dedupeActions(actions)
  };
}

module.exports = {
  buildProfessionalFormatPlan,
  collectWorkbookSheets,
  choosePalette,
  parseRange
};
