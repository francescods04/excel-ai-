/**
 * Shared JSON Schemas for Excel tools.
 *
 * Single source of truth used by:
 *   - server/tools/registry.js  (server-side, for runtime validation via Ajv)
 *   - server/agents/agentLoop.js (LLM-side, for OpenAI function-calling spec)
 *
 * When extending a tool's schema, edit ONLY here. Both consumers re-import.
 */

const SHEET_NAME = {
  type: 'string',
  minLength: 1,
  maxLength: 31,
  description: 'Worksheet tab name (must match existing sheet exactly)'
};

const A1_RANGE = {
  type: 'string',
  pattern: '^[A-Z]+\\d+(?::[A-Z]+\\d+)?$',
  description: 'A1 notation range, e.g. "A1" or "B2:D10"'
};

const CELL_STYLES = {
  type: 'object',
  properties: {
    fontColor: { type: 'string', description: 'Hex color e.g. "#0000FF"' },
    backgroundColor: { type: 'string', description: 'Hex color e.g. "#FFFFE0"' },
    bold: { type: 'boolean' },
    italic: { type: 'boolean' },
    fontSize: { type: 'number' },
    fontName: { type: 'string' },
    numberFormat: { type: 'string', description: 'Excel number format e.g. "#,##0.00"' },
    horizontalAlignment: { type: 'string', enum: ['Left', 'Center', 'Right'] },
    verticalAlignment: { type: 'string', enum: ['Top', 'Center', 'Bottom'] },
    wrapText: { type: 'boolean' },
    columnWidth: { type: 'number' },
    rowHeight: { type: 'number' },
    borderBottomColor: { type: 'string' },
    borderTopColor: { type: 'string' },
    borders: { type: 'object' }
  }
};

const CELL_SPEC = {
  type: 'object',
  properties: {
    value: { description: 'Static cell value (text, number, boolean). Do NOT put formulas here.' },
    formula: { type: 'string', description: 'Formula starting with "=", e.g. "=SUM(A1:A10)"' },
    note: { type: 'string' },
    cellStyles: CELL_STYLES,
    borderStyles: { type: 'object' },
    style_preset: { type: 'string', description: 'IB-grade shortcut applied as default cellStyles (your explicit cellStyles fields still override). One of: header, subheader, table_header, section, label, input, input_pct, input_int, input_eur, input_usd, formula, formula_pct, formula_int, formula_eur, formula_usd, output, output_pct, output_eur, output_usd, output_multiple, output_per_share, total, subtotal, internal_link, external_link, check_ok, check_warn, check_error, scenario_base, scenario_upside, scenario_downside, currency, percent, multiple, per_share, date, year, assumption. Use this to merge write + format into ONE iteration.' }
  }
};

/**
 * set_cell_range / excel.setCellRange — primary write tool.
 * Map of A1 addresses to cell specs. Supports copyToRange for pattern fill.
 */
const SET_CELL_RANGE = {
  type: 'object',
  required: ['sheet', 'cells'],
  properties: {
    sheet: SHEET_NAME,
    cells: {
      type: 'object',
      description: 'Map A1 address → cell spec',
      additionalProperties: CELL_SPEC
    },
    copyToRange: { type: 'string', description: 'Optional: copy the pattern to this range (e.g. "B2:B100")' },
    allow_overwrite: { type: 'boolean', description: 'If false (default), preflight reads target and fails if non-empty.' }
  }
};

/**
 * get_cell_ranges / excel.getCellRanges — batch multi-range read.
 */
const GET_CELL_RANGES = {
  type: 'object',
  required: ['sheetName', 'ranges'],
  properties: {
    sheetName: SHEET_NAME,
    ranges: {
      type: 'array',
      minItems: 1,
      items: { type: 'string' },
      description: 'Array of A1 ranges (e.g. ["A1:C10", "E1:F5"])'
    },
    includeStyles: { type: 'boolean', default: true },
    cellLimit: { type: 'integer', minimum: 1, maximum: 10000, default: 2000 }
  }
};

/**
 * get_range_as_csv / excel.getRangeAsCsv — CSV export for pandas.
 */
const GET_RANGE_AS_CSV = {
  type: 'object',
  required: ['sheet', 'target'],
  properties: {
    sheet: SHEET_NAME,
    target: A1_RANGE,
    maxRows: { type: 'integer', minimum: 1, maximum: 5000, default: 500 },
    includeHeaders: { type: 'boolean', default: true }
  }
};

module.exports = {
  // Primitives (re-exported for use in registry's other tool schemas)
  SHEET_NAME,
  A1_RANGE,
  CELL_STYLES,
  CELL_SPEC,
  // Tool schemas (single source of truth)
  SET_CELL_RANGE,
  GET_CELL_RANGES,
  GET_RANGE_AS_CSV
};
