const logger = require('../utils/logger');

/* ---------- Regex helpers ---------- */

// Cattura riferimenti A1 con foglio: SheetName!A1, 'Sheet Name'!A1, Sheet!B5:C10
// NOTA: NO flag /g — deve essere stateless per test() e exec() deterministici
const RE_A1_REF = /(?:'([^']+)'|([A-Za-z_]\w*))!\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?/i;

// Cattura riferimenti A1 semplici (senza foglio): A1, $A$1, B5:C10, $B$5:$C$10
const RE_A1_SIMPLE = /^\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?$/;

// Cattura solo il nome sheet da un ref qualificato
const RE_SHEET_REF = /^(?:'([^']+)'|([A-Za-z_]\w*))!/;

const RE_FUNCTION_CALL = /\b([A-Z]{2,30})\s*\(/g;

// Funzioni Excel comuni (whitelist per validazione aggiuntiva)
const BUILTIN_FUNCTIONS = new Set([
  'SUM', 'AVERAGE', 'COUNT', 'COUNTA', 'COUNTIF', 'COUNTIFS',
  'SUMIF', 'SUMIFS', 'AVERAGEIF', 'AVERAGEIFS',
  'MAX', 'MIN', 'MEDIAN', 'MODE', 'STDEV', 'VAR',
  'IF', 'IFS', 'IFERROR', 'IFNA', 'SWITCH', 'CHOOSE',
  'AND', 'OR', 'NOT', 'XOR',
  'VLOOKUP', 'HLOOKUP', 'XLOOKUP', 'INDEX', 'MATCH', 'INDIRECT', 'OFFSET',
  'NPV', 'IRR', 'XNPV', 'XIRR', 'PMT', 'PV', 'FV', 'RATE', 'NPER',
  'WACC', 'DCF', 'EVA',
  'CONCAT', 'CONCATENATE', 'TEXTJOIN', 'LEFT', 'RIGHT', 'MID', 'LEN', 'TRIM', 'UPPER', 'LOWER', 'PROPER',
  'DATE', 'YEAR', 'MONTH', 'DAY', 'TODAY', 'NOW', 'EDATE', 'EOMONTH',
  'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'ABS', 'INT', 'MOD', 'SQRT', 'POWER',
  'LN', 'LOG', 'EXP',
  'ISNUMBER', 'ISTEXT', 'ISBLANK', 'ISERROR', 'ISNA', 'ISLOGICAL',
  'CELL', 'ROW', 'COLUMN', 'ROWS', 'COLUMNS',
  'ARRAYFORMULA', 'TRANSPOSE', 'UNIQUE', 'FILTER', 'SORT', 'SORTN',
  'IMPORTDATA', 'IMPORTRANGE', 'IMPORTHTML', 'IMPORTXML',
  'QUERY', 'GOOGLEFINANCE', 'GOOGLETRANSLATE', 'DETECTLANGUAGE',
  'SPARKLINE', 'IMAGE'
]);

/* ---------- Formula-level checks ---------- */

function isParenthesesBalanced(formula) {
  let depth = 0;
  let inString = false;
  let stringChar = null;
  for (let i = 0; i < formula.length; i++) {
    const ch = formula[i];
    if (inString) {
      if (ch === stringChar && formula[i - 1] !== '\\') {
        inString = false;
        stringChar = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0) return false;
  }
  return depth === 0 && !inString;
}

function beginsWithEquals(formula) {
  return typeof formula === 'string' && formula.trim().startsWith('=');
}

function isNonEmpty(formula) {
  return typeof formula === 'string' && formula.trim().length > 1;
}

/**
 * Valida una singola formula.
 * @param {string} formulaString - La formula (es. "=SUM(Assumptions!B5:B10)")
 * @param {Object} layout - { sheets: string[], references: Set<string> } dal LayoutAgent
 * @returns {{ ok: boolean, errors: string[], refs: string[], funcs: string[] }}
 */
function validateFormula(formulaString, layout = {}) {
  const errors = [];
  const refs = [];
  const funcs = [];

  if (!isNonEmpty(formulaString)) {
    return { ok: false, errors: ['formula vuota'], refs: [], funcs: [] };
  }

  if (!beginsWithEquals(formulaString)) {
    errors.push('la formula non inizia con "="');
  }

  if (!isParenthesesBalanced(formulaString)) {
    errors.push('parentesi non bilanciate');
  }

  // Estrai riferimenti A1
  for (const match of formulaString.matchAll(RE_A1_REF)) {
    refs.push(match[0]);
  }

  // Estrai nomi funzione
  for (const funcMatch of formulaString.matchAll(RE_FUNCTION_CALL)) {
    funcs.push(funcMatch[1].toUpperCase());
  }

  // Validazione opzionale: check funzioni note
  if (process.env.CRITIC_STRICT === 'true') {
    for (const fn of funcs) {
      if (!BUILTIN_FUNCTIONS.has(fn)) {
        errors.push(`funzione sconosciuta o non standard: ${fn}()`);
      }
    }
  }

  // Validazione opzionale: check riferimenti contro layout
  if (layout.references instanceof Set && layout.references.size > 0 && refs.length > 0) {
    for (const ref of refs) {
      // Se il ref è cross-sheet, verifichiamo il nome foglio
      const sheetMatch = ref.match(RE_SHEET_REF);
      if (sheetMatch) {
        const sheetName = sheetMatch[1] || sheetMatch[2];
        const normalized = sheetName.replace(/^'|'$/g, '');
        if (layout.sheets && !layout.sheets.includes(normalized) && !layout.references.has(ref)) {
          errors.push(`riferimento a foglio sconosciuto: ${ref}`);
        }
      }
      // Ref semplice (no sheet) — non possiamo verificare senza contesto
    }
  }

  return { ok: errors.length === 0, errors, refs, funcs };
}

/* ---------- Action-level checks ---------- */

/**
 * Valida un array di actions (tipo runFormula, fillRange, createChart, etc.)
 * @param {Array} actions - Azioni da validare
 * @param {Object} layout - { sheets: string[], references: Set<string> }
 * @returns {{ ok: boolean, errors: Array<{action: Object, error: string}> }}
 */
function validateActions(actions, layout = {}) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(actions)) return { ok: true, errors: [] };

  // --- Check: every runFormula must have a setCellValue label in Column A of the same row ---
  const formulaRows = new Map(); // sheet -> Set of row numbers with runFormula
  const labelRows = new Map();   // sheet -> Set of row numbers with setCellValue in col A

  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    if (action.type === 'runFormula' && action.target && action.sheet) {
      const match = action.target.match(/([A-Z]+)(\d+)/);
      if (match) {
        const rowNum = parseInt(match[2], 10);
        if (!formulaRows.has(action.sheet)) formulaRows.set(action.sheet, new Set());
        formulaRows.get(action.sheet).add(rowNum);
      }
    }
    if (action.type === 'setCellValue' && action.target && action.sheet) {
      const match = action.target.match(/([A-Z]+)(\d+)/);
      if (match) {
        const col = match[1];
        const rowNum = parseInt(match[2], 10);
        if (col === 'A') {
          if (!labelRows.has(action.sheet)) labelRows.set(action.sheet, new Set());
          labelRows.get(action.sheet).add(rowNum);
        }
      }
    }
  }

  for (const [sheet, rows] of formulaRows.entries()) {
    const labels = labelRows.get(sheet) || new Set();
    for (const rowNum of rows) {
      if (!labels.has(rowNum)) {
        errors.push({ action: { type: 'runFormula', sheet, target: `?${rowNum}` }, error: `Row ${rowNum} in sheet "${sheet}" has a formula but NO label in Column A` });
      }
    }
  }

  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;

    switch (action.type) {
      case 'runFormula': {
        if (!action.value || typeof action.value !== 'string') {
          errors.push({ action, error: 'runFormula senza value' });
          continue;
        }
        const result = validateFormula(action.value, layout);
        if (!result.ok) {
          for (const err of result.errors) {
            errors.push({ action, error: `formula ${action.target || '?'}: ${err}` });
          }
        }
        break;
      }

      case 'fillRange': {
        if (!action.target) {
          errors.push({ action, error: 'fillRange senza target' });
        }
        // value può essere array 2D o scalare
        if (action.value === undefined && action.values === undefined) {
          errors.push({ action, error: 'fillRange senza value/values' });
        }
        if (Array.isArray(action.value) && !Array.isArray(action.value[0])) {
          errors.push({ action, error: 'fillRange.value deve essere array 2D' });
        }
        break;
      }

      case 'setCellValue': {
        const isValidTarget = action.target && (RE_A1_REF.test(action.target) || RE_A1_SIMPLE.test(action.target));
        if (!isValidTarget) {
          errors.push({ action, error: `setCellValue target non valido: ${action.target}` });
        }
        break;
      }

      case 'setCellRange': {
        // Validate all formulas in the cells map
        if (!action.cells || typeof action.cells !== 'object' || Object.keys(action.cells).length === 0) {
          errors.push({ action, error: 'setCellRange senza cells validi' });
          break;
        }
        if (!action.sheet) {
          errors.push({ action, error: 'setCellRange senza sheet' });
          break;
        }
        for (const [addr, spec] of Object.entries(action.cells)) {
          if (!spec || typeof spec !== 'object') continue;
          // Validate A1 address format
          const isValidAddr = RE_A1_SIMPLE.test(addr);
          if (!isValidAddr) {
            errors.push({ action, error: `setCellRange: indirizzo A1 non valido: ${addr}` });
            continue;
          }
          // Validate formula if present
          if (spec.formula && typeof spec.formula === 'string') {
            const result = validateFormula(spec.formula, layout);
            if (!result.ok) {
              for (const err of result.errors) {
                errors.push({ action, error: `setCellRange.${addr}: ${err}` });
              }
            }
          }
        }
        // Warn if batch is very large (risk of timeout)
        const cellCount = Object.keys(action.cells).length;
        if (cellCount > 200) {
          warnings.push(`setCellRange con ${cellCount} celle — considera di suddividere in batch più piccoli`);
        }
        break;
      }

      case 'runJavaScript': {
        if (!action.code || typeof action.code !== 'string' || action.code.trim().length === 0) {
          errors.push({ action, error: 'runJavaScript senza code' });
        } else if (action.code.length > 10000) {
          warnings.push(`runJavaScript code molto lungo (${action.code.length} chars)`);
        }
        break;
      }

      case 'writeRange': {
        if (!action.target) {
          errors.push({ action, error: 'writeRange senza target' });
        }
        if (!action.values && !action.formulas && action.value === undefined) {
          errors.push({ action, error: 'writeRange senza values/formulas/value' });
        }
        break;
      }

      case 'createChart': {
        if (!action.target) {
          errors.push({ action, error: 'createChart senza target' });
        }
        break;
      }

      case 'addConditionalFormat': {
        if (!action.target) {
          errors.push({ action, error: 'addConditionalFormat senza target' });
        }
        break;
      }

      case 'createSheet': {
        if (!action.name || typeof action.name !== 'string') {
          errors.push({ action, error: 'createSheet senza name valido' });
        } else if (action.name.length > 31) {
          errors.push({ action, error: `createSheet name troppo lungo (${action.name.length} > 31)` });
        } else if (/[\\\/\?*\[\]:]/.test(action.name)) {
          errors.push({ action, error: `createSheet name contiene caratteri non validi: ${action.name}` });
        }
        break;
      }

      case 'deleteSheet': {
        errors.push({ action, error: 'deleteSheet richiede approvazione esplicita' });
        break;
      }

      default:
        // Azioni sconosciute: possibile espansione futura, non blocchiamo
        break;
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/* ---------- Formula explanation (utility) ---------- */

/**
 * Spiega una formula in linguaggio naturale per debug.
 */
function explainFormula(formulaString) {
  const result = validateFormula(formulaString);
  const parts = [];
  parts.push(`Formula: ${formulaString}`);
  parts.push(`Sintassi: ${result.ok ? 'OK' : result.errors.join('; ')}`);
  if (result.refs.length > 0) {
    parts.push(`Riferimenti: ${result.refs.join(', ')}`);
  }
  if (result.funcs.length > 0) {
    parts.push(`Funzioni: ${result.funcs.join(', ')}`);
  }
  return parts.join('\n');
}

/* ---------- Batch validator facade ---------- */

/**
 * Valida l'output di un task (data + actions) contro il layout del turn.
 * @param {{ data: any, actions: Array }} taskOutput
 * @param {{ sheets: string[], references: Map|Set }} layout
 * @returns {{ ok: boolean, errors: Array, warnings: Array }}
 */
function validateTaskOutput(taskOutput, layout = {}) {
  const warnings = [];
  const errors = [];

  // 1. Check struttura base
  if (!taskOutput || typeof taskOutput !== 'object') {
    return { ok: false, errors: [{ error: 'taskOutput non è un oggetto' }], warnings: [] };
  }

  // 2. Validazione azioni
  if (taskOutput.actions) {
    const result = validateActions(taskOutput.actions, layout);
    if (!result.ok) {
      errors.push(...result.errors);
    }
    if (result.warnings && result.warnings.length > 0) {
      warnings.push(...result.warnings);
    }
  }

  // 3. Warning su dati mancanti o azioni vuote
  if (!taskOutput.actions || taskOutput.actions.length === 0) {
    if (!taskOutput.data || Object.keys(taskOutput.data).length === 0) {
      warnings.push('task output senza actions e senza data');
    } else {
      warnings.push('task output senza actions (solo data)');
    }
  }

  // 4. Conta formule in actions
  const formulaCount = (taskOutput.actions || []).filter(a => a.type === 'runFormula').length;
  const mutationCount = (taskOutput.actions || []).filter(
    a => a.type === 'runFormula' || a.type === 'fillRange' || a.type === 'writeRange' || a.type === 'createSheet'
  ).length;

  if (formulaCount > 0 && layout.sheets?.length === 0) {
    warnings.push(`${formulaCount} formule generate ma nessun foglio nel layout — potrebbero esserci #REF!`);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: { formulaCount, mutationCount }
  };
}

logger.info('[Critic] Initialized');

module.exports = {
  validateFormula,
  validateActions,
  validateTaskOutput,
  explainFormula,
  RE_A1_REF,
  BUILTIN_FUNCTIONS
};
