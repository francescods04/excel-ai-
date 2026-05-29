const MUTATION_ACTION_TYPES = new Set([
  'setCellValue',
  'runFormula',
  'setCellFormat',
  'fillRange',
  'setCellRange',
  'createChart',
  'addConditionalFormat',
  'setConditionalFormat',
  'createSheet',
  'renameSheet',
  'deleteSheet',
  'duplicateSheet',
  'copyRange',
  'createNamedRange',
  'writeRange',
  'runJavaScript',
  'suspendCalculation',
  'resumeCalculation',
  'deleteChart',
  'updateSetting'
]);

function getSheetName(action) {
  return action.sheet || action.sheetName || action.fromSheet || action.toSheet || action.oldName || action.name || null;
}

function getTarget(action) {
  return action.target || action.to || action.from || action.name || action.newName || action.refersTo || null;
}

function valuePreview(value) {
  if (Array.isArray(value)) {
    const rows = value.length;
    const cols = Array.isArray(value[0]) ? value[0].length : 1;
    const sample = JSON.stringify(value.slice(0, 2)).slice(0, 120);
    return `${rows}x${cols} (${sample}${sample.length >= 120 ? '…' : ''})`;
  }

  if (value == null) return '';
  const text = String(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function summarizeAction(action) {
  const sheet = getSheetName(action);
  const target = getTarget(action);

  switch (action.type) {
    case 'createSheet':
      return {
        kind: 'structure',
        label: `Crea il foglio ${sheet || target || 'nuovo foglio'}`,
        sheet,
        target
      };
    case 'renameSheet':
      return {
        kind: 'structure',
        label: `Rinomina il foglio ${action.oldName || action.name || 'selezionato'} in ${action.newName || action.to || 'nuovo nome'}`,
        sheet: action.oldName || action.name || sheet,
        target: action.newName || action.to || target
      };
    case 'deleteSheet':
      return {
        kind: 'structure',
        label: `Elimina il foglio ${action.name || sheet || target || 'selezionato'}`,
        sheet: action.name || sheet,
        target
      };
    case 'duplicateSheet':
      return {
        kind: 'structure',
        label: `Duplica il foglio ${action.source || action.name || sheet || 'selezionato'}`,
        sheet: action.source || action.name || sheet,
        target: action.newName || target,
        preview: action.newName ? `Nuovo foglio: ${action.newName}` : ''
      };
    case 'setCellValue':
      return {
        kind: 'write',
        label: `Scrive un valore in ${target || 'una cella'}`,
        sheet,
        target,
        preview: valuePreview(action.value)
      };
    case 'runFormula':
      return {
        kind: 'formula',
        label: `Inserisce una formula in ${target || 'una cella'}`,
        sheet,
        target,
        preview: valuePreview(action.value)
      };
    case 'fillRange':
    case 'writeRange':
    case 'setCellRange':
      return {
        kind: 'write',
        label: action.type === 'setCellRange'
          ? `Scrive ${Object.keys(action.cells || {}).length} celle`
          : `Aggiorna il range ${target || 'selezionato'}`,
        sheet,
        target,
        preview: valuePreview(action.cells || action.formulas || action.values || action.value)
      };
    case 'setCellFormat':
      return {
        kind: 'format',
        label: `Applica formattazione a ${target || 'un range'}`,
        sheet,
        target,
        preview: valuePreview(action.options)
      };
    case 'addConditionalFormat':
    case 'setConditionalFormat':
      return {
        kind: 'format',
        label: `Aggiunge formattazione condizionale a ${target || 'un range'}`,
        sheet,
        target,
        preview: valuePreview(action.options)
      };
    case 'setNotes':
      return {
        kind: 'annotate',
        label: `Aggiunge ${Array.isArray(action.notes) ? action.notes.length : 0} note alle celle`,
        sheet,
        target,
        preview: valuePreview((action.notes || []).map(n => `${n.sheet ? n.sheet + '!' : ''}${n.addr}: ${n.text}`).join(' | '))
      };
    case 'createChart':
      return {
        kind: 'visual',
        label: `Crea un grafico dal range ${target || 'specificato'}`,
        sheet,
        target,
        preview: valuePreview(action.options)
      };
    case 'copyRange':
      return {
        kind: 'write',
        label: `Copia ${action.from || 'un range'} in ${action.to || 'destinazione'}`,
        sheet: action.fromSheet || sheet,
        target: action.to || target,
        preview: [action.fromSheet, action.from, '->', action.toSheet, action.to].filter(Boolean).join(' ')
      };
    case 'createNamedRange':
      return {
        kind: 'structure',
        label: `Crea il nome definito ${action.name || target || 'nuovo nome'}`,
        sheet,
        target: action.name || target,
        preview: valuePreview(action.refersTo)
      };
    case 'runJavaScript':
      return {
        kind: 'code',
        label: 'Esegue codice Office.js avanzato',
        sheet,
        target,
        preview: valuePreview(action.code)
      };
    case 'suspendCalculation':
      return {
        kind: 'settings',
        label: 'Sospende il calcolo automatico di Excel',
        sheet: null,
        target: null
      };
    case 'resumeCalculation':
      return {
        kind: 'settings',
        label: 'Ripristina il calcolo automatico di Excel',
        sheet: null,
        target: null
      };
    default:
      return {
        kind: 'mutation',
        label: `Esegue l'azione ${action.type}`,
        sheet,
        target,
        preview: valuePreview(action.value || action.options)
      };
  }
}

function isMutationAction(action) {
  return !!action && MUTATION_ACTION_TYPES.has(action.type);
}

function hasMutationActions(actions) {
  return Array.isArray(actions) && actions.some(isMutationAction);
}

function buildActionPreview(actions, task) {
  const safeActions = Array.isArray(actions) ? actions.filter(Boolean) : [];
  const items = safeActions.map(summarizeAction);
  const affectedSheets = Array.from(new Set(items.map(item => item.sheet).filter(Boolean)));
  const affectedTargets = Array.from(new Set(items.map(item => item.target).filter(Boolean)));

  return {
    title: task?.description || task?.tool || 'Modifiche al workbook',
    totalActions: safeActions.length,
    mutationCount: safeActions.filter(isMutationAction).length,
    affectedSheets,
    affectedTargets,
    items
  };
}

module.exports = {
  buildActionPreview,
  hasMutationActions,
  isMutationAction,
  MUTATION_ACTION_TYPES
};
