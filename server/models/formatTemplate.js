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

const PALETTE_LIBRARY = {
  blue: DEFAULT_PALETTE,
  red: RED_PALETTE,
  green: {
    name: 'green',
    titleFill: '#14532D',
    headerFill: '#263238',
    sectionFill: '#D9EAD3',
    sectionFont: '#14532D',
    inputFill: '#E2F0D9',
    inputFont: '#107C41',
    totalFill: '#EEF7EE',
    checkFill: '#FFF2CC',
    bodyFont: '#111827',
    mutedFont: '#404040',
    white: '#FFFFFF',
    heatLow: '#F4CCCC',
    heatMid: '#FFFFFF',
    heatHigh: '#D9EAD3'
  },
  charcoal: {
    name: 'charcoal',
    titleFill: '#111827',
    headerFill: '#374151',
    sectionFill: '#E5E7EB',
    sectionFont: '#111827',
    inputFill: '#E0F2FE',
    inputFont: '#075985',
    totalFill: '#F3F4F6',
    checkFill: '#FEF3C7',
    bodyFont: '#111827',
    mutedFont: '#4B5563',
    white: '#FFFFFF',
    heatLow: '#FEE2E2',
    heatMid: '#FFFFFF',
    heatHigh: '#DCFCE7'
  },
  amber: {
    name: 'amber',
    titleFill: '#92400E',
    headerFill: '#292524',
    sectionFill: '#FEF3C7',
    sectionFont: '#78350F',
    inputFill: '#FFFBEB',
    inputFont: '#B45309',
    totalFill: '#F5F5F4',
    checkFill: '#E0F2FE',
    bodyFont: '#111827',
    mutedFont: '#57534E',
    white: '#FFFFFF',
    heatLow: '#FECACA',
    heatMid: '#FFFFFF',
    heatHigh: '#BBF7D0'
  }
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

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function hexToRgb(hex) {
  const cleaned = String(hex || '').replace('#', '').trim();
  if (!/^[0-9a-f]{6}$/i.test(cleaned)) return null;
  return {
    r: parseInt(cleaned.slice(0, 2), 16),
    g: parseInt(cleaned.slice(2, 4), 16),
    b: parseInt(cleaned.slice(4, 6), 16)
  };
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b]
    .map(v => Math.max(0, Math.min(255, Math.round(v))))
    .map(v => v.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

function mix(hexA, hexB, weight = 0.5) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return hexA;
  return rgbToHex({
    r: a.r * (1 - weight) + b.r * weight,
    g: a.g * (1 - weight) + b.g * weight,
    b: a.b * (1 - weight) + b.b * weight
  });
}

function derivePaletteFromAccent(name, accentHex) {
  return {
    name,
    titleFill: mix(accentHex, '#000000', 0.35),
    headerFill: mix(accentHex, '#111827', 0.70),
    sectionFill: mix(accentHex, '#FFFFFF', 0.82),
    sectionFont: mix(accentHex, '#000000', 0.30),
    inputFill: mix(accentHex, '#FFFFFF', 0.90),
    inputFont: mix(accentHex, '#000000', 0.18),
    totalFill: '#F3F4F6',
    checkFill: '#FFF2CC',
    bodyFont: '#111827',
    mutedFont: '#404040',
    white: '#FFFFFF',
    heatLow: '#F4CCCC',
    heatMid: '#FFFFFF',
    heatHigh: mix(accentHex, '#FFFFFF', 0.76)
  };
}

function choosePalette(params = {}) {
  const text = normalizeText(`${params.objective || ''} ${params.theme || ''}`);
  const hexMatch = text.match(/#([0-9a-f]{6})\b/i);
  if (hexMatch) return derivePaletteFromAccent(hexMatch[0], hexMatch[0]);
  if (/(rosso|rossa|red|burgundy|maroon|crimson|bordeaux)/.test(text)) return RED_PALETTE;
  if (/(verde|green|emerald|smeraldo)/.test(text)) return PALETTE_LIBRARY.green;
  if (/(nero|black|charcoal|antracite|slate|grigio scuro)/.test(text)) return PALETTE_LIBRARY.charcoal;
  if (/(oro|gold|amber|giallo|yellow)/.test(text)) return PALETTE_LIBRARY.amber;
  return DEFAULT_PALETTE;
}

function classifyFormatIntent(params = {}) {
  const text = normalizeText(`${params.objective || ''} ${params.mode || ''} ${params.theme || ''} ${params.formatType || ''}`);
  const hasStyleDirective = /(colou?r|colori|colore|palette|tema|theme|stile|look|brand|rosso|verde|blu|nero|oro|amber|charcoal|bordeaux|#[0-9a-f]{6})/.test(text);
  const wantsFullCleanup = /(completo|full|pulizia|cleanup|professionale|professional|investment banking|ib|istituzionale)/.test(text);
  const colorOnly = hasStyleDirective && /(solo|soltanto|cambia|change|restyle|restyle|rendi|fammi|usa)/.test(text) && !/(modello|formula|crea|build|costruisci)/.test(text);
  const scope = params.scope === 'workbook' ? 'workbook' : (params.scope === 'sheet' ? 'sheet' : (hasStyleDirective ? 'workbook' : 'sheet'));
  return {
    strategy: colorOnly ? 'semantic_restyle' : (wantsFullCleanup ? 'full_cleanup' : 'semantic_restyle'),
    scope,
    hasStyleDirective,
    preserveExistingLayout: colorOnly || hasStyleDirective
  };
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

function addBaseSheetFormatting(actions, sheet, info, palette, intent = {}) {
  const range = parseRange(info.usedRange, info.rowCount || 40, info.columnCount || 8);
  if (range.endRow < range.startRow) range.endRow = range.startRow + Math.max(1, info.rowCount || 1) - 1;
  if (range.endCol < range.startCol) range.endCol = range.startCol + Math.max(1, info.columnCount || 1) - 1;

  const used = a1(range.startCol, range.startRow, range.endCol, range.endRow);
  if (intent.strategy !== 'semantic_restyle') {
    actions.push(fmt(sheet, used, { backgroundColor: palette.white, fontColor: palette.bodyFont }));
  }
  actions.push(fmt(sheet, a1(range.startCol, range.startRow, range.startCol, range.endRow), { horizontalAlignment: 'Left', fontColor: palette.bodyFont }));
  if (range.endCol > range.startCol) {
    actions.push(fmt(sheet, a1(range.startCol + 1, range.startRow, range.endCol, range.endRow), { horizontalAlignment: 'Right' }));
  }
  actions.push(fmt(sheet, a1(range.startCol, range.startRow, range.endCol, range.startRow), { backgroundColor: palette.titleFill, fontColor: palette.white, bold: true, horizontalAlignment: 'Left' }));

  if (range.endRow > range.startRow && intent.strategy !== 'semantic_restyle') {
    actions.push(fmt(sheet, a1(range.startCol, range.startRow + 1, range.endCol, range.startRow + 1), { backgroundColor: palette.headerFill, fontColor: palette.white, bold: true, horizontalAlignment: 'Center' }));
  }

  applyDetectedRows(actions, sheet, info, range, palette);
  return range;
}

function addDcfSheetFormatting(actions, sheet, palette) {
  const p = palette;
  const heat = { minColor: p.heatLow || '#F4CCCC', midColor: p.heatMid || '#FFFFFF', maxColor: p.heatHigh || '#D9EAD3' };
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
      actions.push(cond(sheet, 'C5:G9', { colorScale: heat }));
      actions.push(cond(sheet, 'C14:G18', { colorScale: heat }));
      break;
    case 'scenarios':
      actions.push(fmt(sheet, 'A1:G1', { backgroundColor: p.titleFill, fontColor: p.white, bold: true }));
      ['A3:G3', 'A11:D11'].forEach(target => actions.push(fmt(sheet, target, { backgroundColor: p.sectionFill, fontColor: p.sectionFont, bold: true })));
      ['A4:G4', 'A12:D12'].forEach(target => actions.push(fmt(sheet, target, { backgroundColor: p.headerFill, fontColor: p.white, bold: true, horizontalAlignment: 'Center' })));
      actions.push(fmt(sheet, 'B5:E7', { backgroundColor: p.inputFill, fontColor: p.inputFont, numberFormat: NUM_FORMATS.percent }));
      actions.push(fmt(sheet, 'F5:F7', { numberFormat: NUM_FORMATS.perShare }));
      actions.push(fmt(sheet, 'G5:G7', { numberFormat: NUM_FORMATS.percent }));
      actions.push(cond(sheet, 'F5:G7', { colorScale: heat }));
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
  const intent = classifyFormatIntent(params);
  const sheets = collectWorkbookSheets(params, memory);
  const actions = [];

  for (const info of sheets) {
    addBaseSheetFormatting(actions, info.name, info, palette, intent);
    addDcfSheetFormatting(actions, info.name, palette);
  }

  const planned = dedupeActions(actions);
  return {
    data: {
      builder: 'adaptive-format',
      theme: palette.name,
      strategy: intent.strategy,
      scope: intent.scope,
      sheetCount: sheets.length,
      actionCount: planned.length
    },
    actions: planned
  };
}

module.exports = {
  buildProfessionalFormatPlan,
  collectWorkbookSheets,
  choosePalette,
  classifyFormatIntent,
  parseRange
};
