const Ajv = require('ajv');
const yahoo = require('../tools/yahoo');
const { runLayoutAgent, runFormulaAgent, runFormatAgent } = require('../agents/specialists');
const { searchTools } = require('../utils/toolSearch');

const ajv = new Ajv({ removeAdditional: 'failing', useDefaults: true, coerceTypes: 'array' });

/* ---------- JSON Schema helpers ---------- */

const SCHEMA_A1 = {
  type: 'string',
  pattern: '^(\'?[^\\\\/?*\\[\\]:]+?\'?|\'[^\']+\')?!\\$?[A-Z]+\\$?\\d+(?::\\$?[A-Z]+\\$?\\d+)?$'
};

const SCHEMA_SHEET_NAME = {
  type: 'string',
  minLength: 1,
  maxLength: 31,
  pattern: '^[^\\\\/?*\\[\\]:]+$'
};

const SCHEMA_FORMULA_CELL = {
  type: 'object',
  required: ['target', 'value'],
  properties: {
    target: SCHEMA_A1,
    value: { type: 'string', minLength: 1 },
    sheet: SCHEMA_SHEET_NAME
  }
};

const SCHEMA_CHART_TYPE = {
  type: 'string',
  'enum': [
    'ColumnClustered', 'ColumnStacked', 'ColumnStacked100',
    'BarClustered', 'BarStacked', 'BarStacked100',
    'Line', 'LineMarkers', 'LineStacked', 'LineStacked100',
    'PieOfPie', 'Pie', 'Doughnut',
    'Area', 'AreaStacked', 'AreaStacked100',
    'XYScatter', 'XYScatterLines', 'XYScatterLinesNoMarkers',
    'Bubble', 'Bubble3DEffect',
    'Radar', 'RadarFilled', 'RadarMarkers',
    'Waterfall', 'Treemap', 'Sunburst', 'Histogram', 'Boxwhisker',
    'Pareto', 'Funnel', 'Map', 'ComboChartChangeType'
  ]
};

/* ---------- ToolRegistry class ---------- */

class ToolRegistry {
  constructor() {
    this._tools = new Map();
    this._meta = new Map();
    this._validators = new Map();
  }

  register(name, handler, definition = {}) {
    this._tools.set(name, handler);
    this._meta.set(name, {
      description: definition.description || '',
      inputs: definition.inputs || [],
      outputs: definition.outputs || [],
      schema: definition.schema || null,
      outputSchema: definition.outputSchema || null,
      category: definition.category || 'mutation',
      costHint: definition.costHint || 'medium',
      requiresApproval: definition.requiresApproval || 'auto',
      ...definition
    });

    // Compila validatore JSON Schema se presente
    if (definition.schema) {
      this._validators.set(name, ajv.compile(definition.schema));
    }
  }

  get(name) {
    return this._tools.get(name);
  }

  has(name) {
    return this._tools.has(name);
  }

  list() {
    return Array.from(this._tools.keys());
  }

  /** Ritorna array di tool con category */
  listByCategory() {
    const result = {};
    for (const [name, meta] of this._meta.entries()) {
      const cat = meta.category || 'unknown';
      if (!result[cat]) result[cat] = [];
      result[cat].push(name);
    }
    return result;
  }

  meta(name) {
    return this._meta.get(name) || null;
  }

  getMetadata() {
    const lines = [];
    for (const [name, meta] of this._meta.entries()) {
      lines.push(`- ${name}: ${meta.description}`);
      if (meta.inputs.length > 0) {
        lines.push(`  inputs: ${meta.inputs.join(', ')}`);
      }
    }
    return lines.join('\n');
  }

  /** Valida params contro lo schema del tool. Ritorna { ok, errors } */
  validateParams(name, params) {
    const validator = this._validators.get(name);
    if (!validator) return { ok: true, errors: null };
    const valid = validator(params);
    if (!valid) {
      return {
        ok: false,
        errors: validator.errors.map(e => `${e.instancePath || '/'} ${e.message}`)
      };
    }
    return { ok: true, errors: null };
  }

  /** Produce array di function calling schema per provider (OpenAI / Anthropic) */
  toolUseSchemas(provider = 'openai') {
    const entries = [];
    for (const [name, meta] of this._meta.entries()) {
      if (!meta.schema) continue; // skip tools senza schema
      entries.push({
        type: 'function',
        function: {
          name,
          description: meta.description,
          parameters: meta.schema
        }
      });
    }
    return entries;
  }

  /** Schema compatto per prompt planner (non JSON Schema) */
  getSchemasForLLM() {
    const lines = [];
    for (const [name, meta] of this._meta.entries()) {
      lines.push(`- ${name}: ${meta.description}`);
      if (meta.inputs.length > 0) {
        const required = meta.schema?.required || [];
        const inputs = meta.inputs
          .map(i => required.includes(i) ? `${i}*` : i)
          .join(', ');
        lines.push(`  params: ${inputs}`);
      }
    }
    return lines.join('\n');
  }
}

const registry = new ToolRegistry();

/* ---------- Dynamic registration helper ---------- */
const tools = {};

function registerTool(name, handler, definition = {}) {
  registry.register(name, handler, definition);
  tools[name] = handler;
}

/* ---------- Resolver parametri ---------- */
function resolveParams(params, results) {
  if (Array.isArray(params)) {
    return params.map(value => resolveParams(value, results));
  }
  if (!params || typeof params !== 'object') return params;
  const resolved = {};
  for (const [key, val] of Object.entries(params)) {
    if (typeof val === 'string' && val.startsWith('$results.')) {
      const path = val.replace('$results.', '').split('.');
      let cur = results;
      for (const p of path) {
        cur = cur ? cur[p] : undefined;
      }
      resolved[key] = cur !== undefined ? cur : val;
    } else if (Array.isArray(val) || typeof val === 'object') {
      resolved[key] = resolveParams(val, results);
    } else {
      resolved[key] = val;
    }
  }
  return resolved;
}

function attachSheetToActions(actions, sheet) {
  if (!sheet || !Array.isArray(actions)) return actions || [];
  return actions.map(action => (
    action && typeof action === 'object' && !action.sheet
      ? { ...action, sheet }
      : action
  ));
}

/* ========== Tool definitions (con schema JSON) ========== */

registerTool('yahoo.quote', async (params) => {
  const data = await yahoo.quote(params.ticker);
  return { data, actions: [] };
}, {
  description: 'Recupera quote Yahoo Finance per un ticker',
  inputs: ['ticker'],
  schema: {
    type: 'object',
    required: ['ticker'],
    properties: {
      ticker: { type: 'string', minLength: 1, maxLength: 10, pattern: '^[A-Z0-9.]+$' }
    }
  },
  category: 'read',
  costHint: 'low'
});

registerTool('yahoo.historical', async (params) => {
  const data = await yahoo.historical(params.ticker, params.period);
  return { data, actions: [] };
}, {
  description: 'Recupera dati storici Yahoo Finance per un ticker e periodo',
  inputs: ['ticker', 'period'],
  schema: {
    type: 'object',
    required: ['ticker', 'period'],
    properties: {
      ticker: { type: 'string', minLength: 1, maxLength: 10, pattern: '^[A-Z0-9.]+$' },
      period: { type: 'string', 'enum': ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max'] }
    }
  },
  category: 'read',
  costHint: 'low'
});

registerTool('yahoo.fundamentals', async (params) => {
  const data = await yahoo.fundamentals(params.ticker);
  return { data, actions: [] };
}, {
  description: 'Recupera dati fondamentali Yahoo Finance (market cap, PE, EPS, dividendo, beta)',
  inputs: ['ticker'],
  schema: {
    type: 'object',
    required: ['ticker'],
    properties: {
      ticker: { type: 'string', minLength: 1, maxLength: 10, pattern: '^[A-Z0-9.]+$' }
    }
  },
  category: 'read',
  costHint: 'low'
});

registerTool('llm.planLayout', async (params, memory) => {
  const result = await runLayoutAgent(params, memory);
  return { data: result, actions: [] };
}, {
  description: 'Progetta il layout di un modello Excel: sezioni, celle, naming, dipendenze. Output: JSON con sezioni[] e cells[]',
  inputs: ['model', 'sheets'],
  schema: {
    type: 'object',
    required: ['model', 'sheets'],
    properties: {
      model: { type: 'string', 'enum': ['dcf', 'lbo', 'comps', 'ddm', 'wacc', 'three_statement', 'custom'], description: 'Tipo di modello finance' },
      sheets: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Fogli esistenti' },
      params: { type: 'object', description: 'Parametri specifici del modello (ticker, years, etc.)' }
    }
  },
  category: 'analysis',
  costHint: 'high'
});

registerTool('llm.writeFormulas', async (params, memory) => {
  const result = await runFormulaAgent(params, memory);
  return {
    data: result,
    actions: attachSheetToActions(result.actions || [], params.sheet)
  };
}, {
  description: 'Genera formule Excel per una sezione del modello. Riceve layout e contesto, produce azioni runFormula',
  inputs: ['sheet', 'section'],
  schema: {
    type: 'object',
    required: ['sheet', 'section'],
    properties: {
      sheet: SCHEMA_SHEET_NAME,
      section: { type: 'string', description: 'Sezione del modello: assumptions, wacc, dcf, lbo, summary, etc.' },
      model: { type: 'string', 'enum': ['dcf', 'lbo', 'comps', 'ddm', 'wacc', 'three_statement', 'custom'] },
      startRow: { type: 'integer', minimum: 1 },
      startCol: { type: 'string', pattern: '^[A-Z]+$' }
    }
  },
  category: 'analysis',
  costHint: 'high'
});

registerTool('llm.planFormat', async (params, memory) => {
  const result = await runFormatAgent(params, memory);
  const defaultSheet = params.sheet || (Array.isArray(params.sheets) && params.sheets.length === 1 ? params.sheets[0] : undefined);
  return {
    data: result,
    actions: attachSheetToActions(result.actions || [], defaultSheet)
  };
}, {
  description: 'Pianifica la formattazione Excel: colori, font, bordi, number format, conditional formatting. Output: azioni setCellFormat/addConditionalFormat',
  inputs: ['sheet'],
  schema: {
    type: 'object',
    required: ['sheet'],
    properties: {
      sheet: SCHEMA_SHEET_NAME,
      formatType: { type: 'string', 'enum': ['headers', 'conditional', 'full', 'numbers', 'percents', 'currency'] },
      section: { type: 'string' },
      model: { type: 'string', 'enum': ['dcf', 'lbo', 'comps', 'ddm', 'wacc', 'three_statement', 'custom'] }
    }
  },
  category: 'mutation',
  costHint: 'low'
});

registerTool('excel.createSheet', async (params) => {
  return {
    data: { sheetName: params.name },
    actions: [{ type: 'createSheet', name: params.name, sheet: params.name }]
  };
}, {
  description: 'Crea un nuovo foglio Excel',
  inputs: ['name'],
  schema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: SCHEMA_SHEET_NAME
    }
  },
  category: 'mutation',
  costHint: 'low',
  requiresApproval: 'always'
});

registerTool('excel.setValues', async (params) => {
  return {
    data: { target: params.target },
    actions: [{ type: 'fillRange', target: params.target, value: params.value, sheet: params.sheet }]
  };
}, {
  description: 'Imposta valori in un range Excel',
  inputs: ['target', 'value'],
  schema: {
    type: 'object',
    required: ['target', 'value'],
    properties: {
      sheet: SCHEMA_SHEET_NAME,
      target: SCHEMA_A1,
      value: {}  // any: può essere array 2D, stringa, numero
    }
  },
  category: 'mutation',
  costHint: 'low'
});

registerTool('excel.setFormulas', async (params) => {
  const actions = (params.formulas || []).map(f => ({
    type: 'runFormula',
    target: f.target,
    value: f.value,
    sheet: f.sheet || params.sheet
  }));
  return { data: { count: actions.length }, actions };
}, {
  description: 'Imposta un array di formule in un range Excel. Ogni formula deve iniziare con =',
  inputs: ['formulas'],
  schema: {
    type: 'object',
    required: ['formulas'],
    properties: {
      sheet: SCHEMA_SHEET_NAME,
      formulas: {
        type: 'array',
        minItems: 1,
        items: SCHEMA_FORMULA_CELL
      }
    }
  },
  category: 'mutation',
  costHint: 'low'
});

registerTool('excel.addChart', async (params) => {
  return {
    data: { target: params.target },
    actions: [{
      type: 'createChart',
      target: params.target,
      sheet: params.sheet,
      options: { chartType: params.chartType || 'ColumnClustered', title: params.title }
    }]
  };
}, {
  description: 'Aggiunge un grafico Excel in un foglio',
  inputs: ['target', 'chartType'],
  schema: {
    type: 'object',
    required: ['target', 'chartType'],
    properties: {
      sheet: SCHEMA_SHEET_NAME,
      target: SCHEMA_A1,
      chartType: SCHEMA_CHART_TYPE,
      title: { type: 'string' }
    }
  },
  category: 'mutation',
  costHint: 'low'
});

registerTool('excel.applyFormat', async (params, memory) => {
  const sourceResultId = params.fromResult || params.planRef;
  const actions = params.actions || (sourceResultId && memory.results[sourceResultId]?.actions) || [];
  return {
    data: { count: actions.length },
    actions: attachSheetToActions(actions, params.sheet)
  };
}, {
  description: 'Applica formattazione a un foglio da un risultato precedente di planFormat',
  inputs: ['sheet', 'fromResult'],
  schema: {
    type: 'object',
    required: ['sheet'],
    properties: {
      sheet: SCHEMA_SHEET_NAME,
      fromResult: { type: 'string', description: 'ID del task planFormat precedente' },
      planRef: { type: 'string', description: 'Riferimento alternativo al piano' }
    }
  },
  category: 'mutation',
  costHint: 'low'
});

registerTool('excel.setConditionalFormat', async (params) => {
  return {
    data: { target: params.target },
    actions: [{
      type: 'addConditionalFormat',
      target: params.target,
      sheet: params.sheet,
      options: params.options
    }]
  };
}, {
  description: 'Aggiunge formattazione condizionale a un range (evidenzia valori, barre dati, scale colore)',
  inputs: ['target', 'options'],
  schema: {
    type: 'object',
    required: ['target', 'options'],
    properties: {
      sheet: SCHEMA_SHEET_NAME,
      target: SCHEMA_A1,
      options: {
        type: 'object',
        properties: {
          type: { type: 'string', 'enum': ['cellValue', 'colorScale', 'dataBar', 'iconSet', 'topBottom', 'text', 'dateOccurring'] },
          operator: { type: 'string', 'enum': ['GreaterThan', 'LessThan', 'Between', 'EqualTo', 'NotEqualTo', 'GreaterThanOrEqual', 'LessThanOrEqual'] },
          value1: {}, value2: {},
          color: { type: 'string', pattern: '^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$' },
          fontColor: { type: 'string', pattern: '^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$' }
        }
      }
    }
  },
  category: 'mutation',
  costHint: 'low'
});

// workbook.read* — no schema (params dipendono dal client)
registerTool('workbook.readWorkbook', async (params, memory) => {
  if (!memory.runtime?.requestClientTool) {
    throw new Error('Runtime workbook non disponibile per workbook.readWorkbook');
  }
  const data = await memory.runtime.requestClientTool('workbook.readWorkbook', params);
  return { data, actions: [] };
}, {
  description: 'Legge lo stato completo del workbook dal client Excel',
  inputs: ['maxRows', 'maxCols'],
  category: 'read',
  costHint: 'medium',
  requiresApproval: 'never'
});

registerTool('workbook.readSheet', async (params, memory) => {
  if (!memory.runtime?.requestClientTool) {
    throw new Error('Runtime workbook non disponibile per workbook.readSheet');
  }
  const data = await memory.runtime.requestClientTool('workbook.readSheet', params);
  return { data, actions: [] };
}, {
  description: 'Legge un foglio specifico dal client Excel',
  inputs: ['sheet', 'maxRows', 'maxCols'],
  schema: {
    type: 'object',
    required: ['sheet'],
    properties: {
      sheet: SCHEMA_SHEET_NAME,
      maxRows: { type: 'integer', minimum: 1, maximum: 10000 },
      maxCols: { type: 'integer', minimum: 1, maximum: 100 }
    }
  },
  category: 'read',
  costHint: 'medium',
  requiresApproval: 'never'
});

registerTool('workbook.readRange', async (params, memory) => {
  if (!memory.runtime?.requestClientTool) {
    throw new Error('Runtime workbook non disponibile per workbook.readRange');
  }
  const data = await memory.runtime.requestClientTool('workbook.readRange', params);
  return { data, actions: [] };
}, {
  description: 'Legge un range specifico dal client Excel',
  inputs: ['sheet', 'target'],
  schema: {
    type: 'object',
    required: ['sheet', 'target'],
    properties: {
      sheet: SCHEMA_SHEET_NAME,
      target: SCHEMA_A1
    }
  },
  category: 'read',
  costHint: 'medium',
  requiresApproval: 'never'
});

registerTool('workbook.writeRange', async (params) => {
  const action = {
    type: 'writeRange',
    sheet: params.sheet,
    target: params.target,
    value: params.value,
    values: params.values,
    formulas: params.formulas
  };
  return {
    data: {
      sheet: params.sheet,
      target: params.target,
      hasValues: params.values !== undefined || params.value !== undefined,
      hasFormulas: params.formulas !== undefined
    },
    actions: [action]
  };
}, {
  description: 'Scrive valori e/o formule in un range Excel. Supporta array 2D di valori e formule',
  inputs: ['sheet', 'target'],
  schema: {
    type: 'object',
    required: ['sheet', 'target'],
    properties: {
      sheet: SCHEMA_SHEET_NAME,
      target: SCHEMA_A1,
      value: {},
      values: { type: 'array', items: { type: 'array' } },
      formulas: { type: 'array', items: { type: 'array', items: { type: 'string' } } }
    },
    anyOf: [
      { required: ['value'] },
      { required: ['values'] },
      { required: ['formulas'] }
    ]
  },
  category: 'mutation',
  costHint: 'low',
  requiresApproval: 'always'
});

registerTool('excel.getRangeAsCsv', async (params, memory) => {
  if (!memory.runtime?.requestClientTool) {
    throw new Error('Runtime workbook non disponibile per excel.getRangeAsCsv');
  }
  const data = await memory.runtime.requestClientTool('workbook.readRange', {
    sheet: params.sheet,
    target: params.target,
    maxRows: params.maxRows || 500,
    format: 'csv',
    includeHeaders: params.includeHeaders !== false
  });
  return { data, actions: [] };
}, {
  description: 'Legge un range Excel come CSV string per analisi pandas',
  inputs: ['sheet', 'target'],
  schema: {
    type: 'object',
    required: ['sheet', 'target'],
    properties: {
      sheet: SCHEMA_SHEET_NAME,
      target: SCHEMA_A1,
      maxRows: { type: 'integer', minimum: 1, maximum: 5000 },
      includeHeaders: { type: 'boolean' }
    }
  },
  category: 'read',
  costHint: 'low',
  requiresApproval: 'never'
});

registerTool('excel.setCellRange', async (params) => {
  return {
    data: { sheet: params.sheet, cellCount: Object.keys(params.cells || {}).length },
    actions: [{
      type: 'setCellRange',
      sheet: params.sheet,
      cells: params.cells,
      copyToRange: params.copyToRange,
      allow_overwrite: params.allow_overwrite
    }]
  };
}, {
  description: 'Scrive celle usando una mappa A1 -> {value, formula, note, cellStyles, borderStyles}. Supporta copyToRange e allow_overwrite.',
  inputs: ['sheet', 'cells'],
  schema: {
    type: 'object',
    required: ['sheet', 'cells'],
    properties: {
      sheet: SCHEMA_SHEET_NAME,
      cells: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: {
            value: {},
            formula: { type: 'string' },
            note: { type: 'string' },
            cellStyles: { type: 'object' },
            borderStyles: { type: 'object' }
          }
        }
      },
      copyToRange: { type: 'string' },
      allow_overwrite: { type: 'boolean' }
    }
  },
  category: 'mutation',
  costHint: 'low',
  requiresApproval: 'always'
});

// ─────────────────────────────────────────────
//  Multi-sheet operations (rename, delete, duplicate)
// ─────────────────────────────────────────────

registerTool('excel.renameSheet', async (params) => {
  if (!params.oldName || !params.newName) {
    throw new Error('renameSheet requires oldName and newName');
  }
  return {
    data: { oldName: params.oldName, newName: params.newName },
    actions: [{ type: 'renameSheet', oldName: params.oldName, newName: params.newName }]
  };
}, {
  description: 'Rinomina un foglio esistente. Usa oldName per il nome attuale e newName per il nuovo nome.',
  inputs: ['oldName', 'newName'],
  schema: {
    type: 'object',
    required: ['oldName', 'newName'],
    properties: {
      oldName: { type: 'string', description: 'Nome attuale del foglio' },
      newName: { type: 'string', description: 'Nuovo nome del foglio' }
    }
  },
  category: 'mutation',
  costHint: 'low',
  requiresApproval: 'always'
});

registerTool('excel.deleteSheet', async (params) => {
  if (!params.name) throw new Error('deleteSheet requires name');
  return {
    data: { deleted: params.name },
    actions: [{ type: 'deleteSheet', name: params.name }]
  };
}, {
  description: 'Elimina un foglio dal workbook. ATTENZIONE: azione irreversibile!',
  inputs: ['name'],
  schema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'Nome del foglio da eliminare' }
    }
  },
  category: 'mutation',
  costHint: 'low',
  requiresApproval: 'always'
});

registerTool('excel.duplicateSheet', async (params) => {
  if (!params.source) throw new Error('duplicateSheet requires source sheet name');
  const newName = params.newName || (params.source + ' (copy)');
  return {
    data: { source: params.source, duplicate: newName },
    actions: [{ type: 'duplicateSheet', source: params.source, newName }]
  };
}, {
  description: 'Duplica un foglio esistente (copia esatta). Se newName non specificato, usa "SheetName (copy)".',
  inputs: ['source', 'newName'],
  schema: {
    type: 'object',
    required: ['source'],
    properties: {
      source: { type: 'string', description: 'Nome del foglio sorgente da duplicare' },
      newName: { type: 'string', description: 'Nome del nuovo foglio (default: "nome (copy)")' }
    }
  },
  category: 'mutation',
  costHint: 'low',
  requiresApproval: 'always'
});

// ─────────────────────────────────────────────
//  Cross-sheet operations (copyRange, named ranges)
// ─────────────────────────────────────────────

registerTool('excel.copyRange', async (params) => {
  if (!params.from || !params.to) throw new Error('copyRange requires from and to range addresses');
  return {
    data: { fromSheet: params.fromSheet, toSheet: params.toSheet, from: params.from, to: params.to },
    actions: [{
      type: 'copyRange',
      fromSheet: params.fromSheet,
      toSheet: params.toSheet,
      from: params.from,
      to: params.to
    }]
  };
}, {
  description: 'Copia un range da un foglio all\'altro (formule, valori, formattazione). Esempio: copyRange(fromSheet:"Input", from:"A1:B10", toSheet:"Summary", to:"A1").',
  inputs: ['fromSheet', 'from', 'toSheet', 'to'],
  schema: {
    type: 'object',
    required: ['from', 'to'],
    properties: {
      fromSheet: { type: 'string', description: 'Foglio sorgente (default: foglio attivo)' },
      from: { type: 'string', description: 'Range sorgente in A1 notation (es. "A1:B10")' },
      toSheet: { type: 'string', description: 'Foglio destinazione (default: stesso foglio)' },
      to: { type: 'string', description: 'Range destinazione in A1 notation (es. "C5")' }
    }
  },
  category: 'mutation',
  costHint: 'low',
  requiresApproval: 'always'
});

registerTool('excel.createNamedRange', async (params) => {
  if (!params.name) throw new Error('createNamedRange requires a name');
  const refersTo = params.refersTo || `=${params.sheet || ''}!${params.target || '$A$1'}`;
  return {
    data: { name: params.name, refersTo },
    actions: [{ type: 'createNamedRange', name: params.name, refersTo }]
  };
}, {
  description: 'Crea un nome definito che può essere usato come riferimento nelle formule su TUTTI i fogli. Ideale per input comuni (Revenue, WACC, TaxRate).',
  inputs: ['name', 'refersTo', 'sheet', 'target'],
  schema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'Nome definito (es. "Revenue", "TaxRate", "WACC")' },
      refersTo: { type: 'string', description: 'Riferimento completo (es. "=Assumptions!B3")' },
      sheet: { type: 'string', description: 'Foglio contenente il riferimento' },
      target: { type: 'string', description: 'Cella target (es. "B3"), usato con sheet per costruire il riferimento' }
    }
  },
  category: 'mutation',
  costHint: 'low',
  requiresApproval: 'always'
});

registerTool('workbook.listNamedRanges', async (params, memory) => {
  if (!memory.runtime?.requestClientTool) {
    throw new Error('Runtime workbook non disponibile per workbook.listNamedRanges');
  }
  const data = await memory.runtime.requestClientTool('workbook.listNamedRanges', params || {});
  return { data, actions: [] };
}, {
  description: 'Elenca tutti i nomi definiti (named ranges) nel workbook, con i loro riferimenti.',
  inputs: [],
  category: 'read',
  costHint: 'low',
  requiresApproval: 'never'
});

registerTool('askUserQuestion', async (params, memory) => {
  if (!memory.runtime?.requestUserInput) {
    throw new Error('Runtime input non disponibile per askUserQuestion');
  }
  const response = await memory.runtime.requestUserInput({
    type: 'question',
    title: params.title || 'Domanda',
    prompt: params.prompt || '',
    questions: params.questions
  });
  return { data: response?.values || response, actions: [] };
}, {
  description: 'Presenta opzioni tappabili all\'utente. Usa per chiedere conferme o scelte.',
  inputs: ['questions'],
  schema: {
    type: 'object',
    required: ['questions'],
    properties: {
      title: { type: 'string' },
      prompt: { type: 'string' },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            header: { type: 'string' },
            question: { type: 'string' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' }
                }
              }
            },
            multiSelect: { type: 'boolean' }
          }
        }
      }
    }
  },
  category: 'mutation',
  costHint: 'medium'
});

registerTool('todoWrite', async (params) => {
  return {
    data: { todos: params.todos },
    actions: [{
      type: 'todoWrite',
      todos: params.todos
    }]
  };
}, {
  description: 'Aggiorna la lista task visibile nel pannello Steps.',
  inputs: ['todos'],
  schema: {
    type: 'object',
    required: ['todos'],
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] }
          }
        }
      }
    }
  },
  category: 'mutation',
  costHint: 'low'
});

registerTool('requestUserInput', async (params, memory) => {
  if (!memory.runtime?.requestUserInput) {
    throw new Error('Runtime input non disponibile per requestUserInput');
  }
  const response = await memory.runtime.requestUserInput(params);
  return { data: response?.values || response, actions: [] };
}, {
  description: 'Richiede input all\'utente con campi specificati. Blocca il flusso finché l\'utente non risponde.',
  inputs: ['fields'],
  category: 'mutation',
  costHint: 'medium'
});

registerTool('requestPermissions', async (params, memory) => {
  if (!memory.runtime?.requestPermissions) {
    throw new Error('Runtime permessi non disponibile per requestPermissions');
  }
  const response = await memory.runtime.requestPermissions(params);
  return { data: response, actions: [] };
}, {
  description: 'Richiede conferma all\'utente per eseguire azioni distruttive. Blocca finché l\'utente non approva/rifiuta.',
  inputs: ['actions', 'preview'],
  category: 'mutation',
  costHint: 'medium'
});

const { webSearch, webFetch } = require('./web');

/* ---------- OpenBB Financial Data ---------- */
let openbb = null;
try { openbb = require('./openbb'); } catch (e) { /* OpenBB non disponibile */ }

function _openbbOrError() {
  if (!openbb) throw new Error('OpenBB non disponibile. Avviare openbb-api con: openbb-api --port 6900');
  return openbb;
}

function _compactResults(data, maxRows = 20) {
  if (!data) return data;
  if (data.results) {
    const r = data.results;
    return { ...data, results: Array.isArray(r) && r.length > maxRows ? r.slice(0, maxRows) : r, _truncated: Array.isArray(r) && r.length > maxRows };
  }
  return data;
}

// ---- Equity data ----
registerTool('openbb.equity.quote', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.equity.quote(params.symbol, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Quote azionario da OpenBB (prezzo, volume, bid/ask, variazione giornaliera). Provider default: yfinance',
  inputs: ['symbol'],
  schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string', minLength: 1, maxLength: 20 } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.equity.historical', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.equity.historical(params.symbol, params.start_date, params.end_date, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Serie storica prezzi azionari (OHLCV) da OpenBB. Richiede start_date e end_date (YYYY-MM-DD). Provider default: yfinance',
  inputs: ['symbol', 'start_date', 'end_date'],
  schema: { type: 'object', required: ['symbol', 'start_date', 'end_date'], properties: { symbol: { type: 'string' }, start_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, end_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.equity.profile', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.equity.profile(params.symbol, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Profilo aziendale da OpenBB: descrizione, settore, dipendenti, market cap, exchange, beta, dividend yield. Provider default: yfinance',
  inputs: ['symbol'],
  schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string', minLength: 1, maxLength: 20 } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.equity.search', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.equity.search(params.query, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Cerca simboli azionari per nome azienda o ticker parziale. Provider default: yfinance',
  inputs: ['query'],
  schema: { type: 'object', required: ['query'], properties: { query: { type: 'string', minLength: 2 } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.equity.fundamentals.balance', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.equity.fundamental.balance(params.symbol, params.period || 'annual', params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Bilancio patrimoniale (balance sheet): cash, crediti, inventory, asset, debiti, equity. Provider default: yfinance',
  inputs: ['symbol'],
  schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' }, period: { type: 'string', enum: ['annual', 'quarter'] } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.equity.fundamentals.income', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.equity.fundamental.income(params.symbol, params.period || 'annual', params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Conto economico (income statement): revenue, COGS, gross profit, EBITDA, EBIT, net income, EPS. Provider default: yfinance',
  inputs: ['symbol'],
  schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' }, period: { type: 'string', enum: ['annual', 'quarter'] } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.equity.fundamentals.cash', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.equity.fundamental.cash(params.symbol, params.period || 'annual', params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Rendiconto finanziario (cash flow): operating/investing/financing cash flow, FCF, CapEx, dividends. Provider default: yfinance',
  inputs: ['symbol'],
  schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' }, period: { type: 'string', enum: ['annual', 'quarter'] } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.equity.fundamentals.metrics', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.equity.fundamental.metrics(params.symbol, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Metriche finanziarie chiave: PE, forward PE, PEG, EV/EBITDA, ROE, ROA, margini, crescita ricavi, quick ratio, debt/equity. Provider default: yfinance',
  inputs: ['symbol'],
  schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.equity.fundamentals.ratios', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.equity.fundamental.ratios(params.symbol, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Set esteso di ratio finanziari: valuation, profitability, liquidity, efficiency, leverage. Provider default: yfinance',
  inputs: ['symbol'],
  schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.equity.fundamentals.income_growth', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.equity.fundamental.incomeGrowth(params.symbol, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Crescita anno-su-anno delle voci del conto economico (revenue growth, EBITDA growth, etc.). Provider default: yfinance',
  inputs: ['symbol'],
  schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.equity.fundamentals.balance_growth', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.equity.fundamental.balanceGrowth(params.symbol, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Crescita anno-su-anno delle voci del bilancio patrimoniale. Provider default: yfinance',
  inputs: ['symbol'],
  schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.equity.fundamentals.cash_growth', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.equity.fundamental.cashGrowth(params.symbol, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Crescita anno-su-anno del rendiconto finanziario (FCF growth, CapEx growth). Provider default: yfinance',
  inputs: ['symbol'],
  schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.equity.fundamentals.management', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.equity.fundamental.management(params.symbol, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Team esecutivo e management della società. Provider default: yfinance',
  inputs: ['symbol'],
  schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.equity.fundamentals.esg', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.equity.fundamental.esgScore(params.symbol, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Punteggio ESG (Environmental, Social, Governance) della società. Provider default: yfinance',
  inputs: ['symbol'],
  schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.equity.estimates.consensus', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.equity.estimates.consensus(params.symbol, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Stime consensus degli analisti: target price, EPS, ricavi, EBITDA stimati. Provider default: yfinance',
  inputs: ['symbol'],
  schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.equity.peers', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.equity.peers.peers(params.symbol, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Lista di aziende comparabili (peers) per un dato ticker. Provider default: yfinance',
  inputs: ['symbol'],
  schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.equity.performance', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.equity.performance(params.symbol, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Performance prezzo per vari periodi (1D, 1W, 1M, 3M, 6M, YTD, 1Y, 3Y, 5Y). Provider default: yfinance',
  inputs: ['symbol'],
  schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' } } },
  category: 'read', costHint: 'low'
});

// ---- Fixed Income ----
registerTool('openbb.fixedincome.treasury', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.fixedincome.treasuryRates(params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Tassi Treasury USA attuali per tutte le scadenze (1mo, 3mo, 6mo, 1y, 2y, 3y, 5y, 7y, 10y, 20y, 30y). Provider default: federal_reserve. USARE per determinare il risk-free rate nei modelli DCF/WACC.',
  inputs: [],
  schema: { type: 'object', properties: {} },
  category: 'read', costHint: 'low'
});

registerTool('openbb.fixedincome.yield_curve', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.fixedincome.yieldCurve(params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Curva dei rendimenti Treasury USA (yield curve) con dati storici. Provider default: federal_reserve',
  inputs: [],
  schema: { type: 'object', properties: {} },
  category: 'read', costHint: 'low'
});

registerTool('openbb.fixedincome.effr', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.fixedincome.effr(params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Effective Federal Funds Rate (tasso FED). Provider default: federal_reserve',
  inputs: [],
  schema: { type: 'object', properties: {} },
  category: 'read', costHint: 'low'
});

registerTool('openbb.fixedincome.sofr', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.fixedincome.sofr(params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Secured Overnight Financing Rate — tasso di riferimento overnight. Provider default: federal_reserve',
  inputs: [],
  schema: { type: 'object', properties: {} },
  category: 'read', costHint: 'low'
});

// ---- Economy ----
registerTool('openbb.economy.cpi', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.economy.cpi(params.country || 'united_states', params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Indice dei prezzi al consumo (CPI/inflazione) per paese. Provider default: oecd. Usa country=united_states,italy,united_kingdom per multi-paese.',
  inputs: ['country'],
  schema: { type: 'object', properties: { country: { type: 'string' } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.economy.gdp_real', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.economy.gdpReal(params.country || 'united_states', params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Crescita PIL reale (GDP growth) per paese. Provider default: oecd',
  inputs: ['country'],
  schema: { type: 'object', properties: { country: { type: 'string' } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.economy.unemployment', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.economy.unemployment(params.country || 'united_states', params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Tasso di disoccupazione per paese. Provider default: oecd',
  inputs: ['country'],
  schema: { type: 'object', properties: { country: { type: 'string' } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.economy.interest_rates', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.economy.interestRates(params.country || 'united_states', params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Tassi di interesse a breve/lungo termine per paese. Provider default: oecd',
  inputs: ['country'],
  schema: { type: 'object', properties: { country: { type: 'string' } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.economy.risk_premium', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.economy.riskPremium(params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Market Risk Premium (ERP) per paese. Utile per calcolo WACC e CAPM.',
  inputs: [],
  schema: { type: 'object', properties: {} },
  category: 'read', costHint: 'low'
});

registerTool('openbb.economy.money_measures', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.economy.moneyMeasures(params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Aggregati monetari M1/M2 USA. Provider default: federal_reserve',
  inputs: [],
  schema: { type: 'object', properties: {} },
  category: 'read', costHint: 'low'
});

registerTool('openbb.economy.gdp_forecast', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.economy.gdpForecast(params.country || 'united_states', params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Previsioni PIL (GDP forecast) per paese. Provider default: oecd',
  inputs: ['country'],
  schema: { type: 'object', properties: { country: { type: 'string' } } },
  category: 'read', costHint: 'low'
});

// ---- Index ----
registerTool('openbb.index.snapshots', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.index.snapshots(params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Snapshot dei principali indici azionari (S&P 500, Nasdaq, Dow Jones, VIX). Provider default: cboe',
  inputs: [],
  schema: { type: 'object', properties: {} },
  category: 'read', costHint: 'low'
});

registerTool('openbb.index.historical', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.index.historical(params.symbol, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Serie storica di un indice (es. ^GSPC per S&P 500, ^IXIC per Nasdaq, ^DJI per Dow Jones)',
  inputs: ['symbol'],
  schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' } } },
  category: 'read', costHint: 'low'
});

// ---- ETF ----
registerTool('openbb.etf.info', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.etf.info(params.symbol, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Informazioni ETF: nome, categoria, AUM, expense ratio, provider. Provider default: yfinance',
  inputs: ['symbol'],
  schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' } } },
  category: 'read', costHint: 'low'
});

registerTool('openbb.etf.holdings', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.etf.holdings(params.symbol, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Posizioni (holdings) di un ETF con pesi percentuali. Provider default: yfinance',
  inputs: ['symbol'],
  schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' } } },
  category: 'read', costHint: 'low'
});

// ---- Currency ----
registerTool('openbb.currency.historical', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.currency.historical(params.symbol, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Serie storica tassi di cambio. Formato simbolo: EURUSD=X, USDJPY=X. Provider default: yfinance',
  inputs: ['symbol'],
  schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' } } },
  category: 'read', costHint: 'low'
});

// ---- Crypto ----
registerTool('openbb.crypto.historical', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.crypto.historical(params.symbol, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Serie storica prezzi crypto. Formato simbolo (yfinance): BTC-USD, ETH-USD. Provider default: yfinance',
  inputs: ['symbol'],
  schema: { type: 'object', required: ['symbol'], properties: { symbol: { type: 'string' } } },
  category: 'read', costHint: 'low'
});

// ---- Technical Analysis (processed data, needs input data array) ----
registerTool('openbb.technical.ema', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.technical.ema(params.data, params.target, params.length || 50, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Exponential Moving Average su serie di prezzi. Richiede data array con campo "close".',
  inputs: ['data', 'target'],
  schema: { type: 'object', required: ['data'], properties: { data: { type: 'array' }, target: { type: 'string' }, length: { type: 'integer', minimum: 1, maximum: 500 } } },
  category: 'analysis', costHint: 'low'
});

registerTool('openbb.technical.rsi', async (params) => {
  const ob = _openbbOrError();
  const data = await ob.technical.rsi(params.data, params.target, params.length || 14, params);
  return { data: _compactResults(data), actions: [] };
}, {
  description: 'Relative Strength Index (RSI) su serie di prezzi.',
  inputs: ['data'],
  schema: { type: 'object', required: ['data'], properties: { data: { type: 'array' }, target: { type: 'string' }, length: { type: 'integer', minimum: 1, maximum: 500 } } },
  category: 'analysis', costHint: 'low'
});

/* ---------- Fine OpenBB Tools ---------- */

registerTool('web.search', async (params) => {
  const data = await webSearch(params);
  return { data, actions: [] };
}, {
  description: 'Web search via Wikipedia, Yahoo Finance, DuckDuckGo Instant Answer, SEC EDGAR. Returns structured results (title, URL, snippet). For financial queries, automatically fetches stock quotes, key ratios, and SEC filing links. For general queries, returns Wikipedia articles. For URLs, fetches page content.',
  inputs: ['query'],
  schema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Search query, company name, ticker, or full URL' },
      ticker: { type: 'string', description: 'Optional ticker symbol (e.g. AAPL). Auto-detected from query if not provided.' },
      maxResults: { type: 'integer', description: 'Max results (1-15, default 8)' }
    }
  },
  category: 'read',
  costHint: 'medium'
});

registerTool('web.fetch', async (params) => {
  const data = await webFetch(params);
  return { data, actions: [] };
}, {
  description: 'Fetch a web page and extract readable text content. Use for investor relations pages, SEC filings, official press releases, or any URL found by web_search.',
  inputs: ['url'],
  schema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'URL to fetch and extract text from' }
    }
  },
  category: 'read',
  costHint: 'medium'
});

/* ---------- Skills ---------- */
const { readSkill } = require('../skills/loader');

registerTool('skill.read', async (params) => {
  const data = readSkill(params.name);
  return { data, actions: [] };
}, {
  description: 'Load a skill document on-demand (DCF, LBO, WACC, comps, 3-statement, audit, clean-data). Returns structured instructions and formulas.',
  inputs: ['name'],
  schema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'Skill name: dcf-model, wacc-model, lbo-model, comps-analysis, three-statement, clean-data, audit-xls' }
    }
  },
  category: 'read',
  costHint: 'low'
});

registerTool('search_tools', async (params) => {
  const results = searchTools(params.query, params.top_k || 5);
  return {
    data: {
      query: params.query,
      results: results.map(r => ({
        name: r.name,
        description: r.description,
        score: r.score,
        parameters: r.parameters
      }))
    },
    actions: []
  };
}, {
  description: 'Search available tools by keyword or description using BM25 relevance scoring.',
  inputs: ['query'],
  schema: {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'What you want to do, e.g. "calculate WACC" or "download stock prices"' },
      top_k: { type: 'number', description: 'Max results to return (default 5)' }
    }
  },
  category: 'read',
  costHint: 'low'
});

/* ---------- Execution ---------- */

function dedupKey(toolName, params) {
  return `${toolName}:${JSON.stringify(params)}`;
}

async function executeTool(toolName, params, memory) {
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool non trovato: ${toolName}`);
  const resolved = resolveParams(params, memory?.results);

  // Validazione JSON Schema (se disponibile)
  const validation = registry.validateParams(toolName, resolved);
  if (!validation.ok) {
    const meta = registry.meta(toolName);
    const schemaWarn = meta?.schema ? ' (schema check fallito)' : '';
    console.warn(`[ToolRegistry] Param validation warning for ${toolName}${schemaWarn}: ${validation.errors?.join('; ')}`);
    // Non blocchiamo: soft validation. Il tool handler ha comunque la responsabilità finale.
  }

  // Deduplication: if same tool+params already executed in this turn, return cached result
  if (memory && typeof memory === 'object') {
    if (!memory._dedupCache) memory._dedupCache = new Map();
    const key = dedupKey(toolName, resolved);
    if (memory._dedupCache.has(key)) {
      return memory._dedupCache.get(key);
    }
    const result = await tool(resolved, memory);
    memory._dedupCache.set(key, result);
    return result;
  }

  return tool(resolved, memory);
}

module.exports = { executeTool, tools, registry };
