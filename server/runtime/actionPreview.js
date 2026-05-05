const MUTATION_ACTION_TYPES = new Set([
  'setCellValue',
  'runFormula',
  'setCellFormat',
  'fillRange',
  'createChart',
  'addConditionalFormat',
  'createSheet',
  'writeRange'
]);

function getSheetName(action) {
  return action.sheet || action.sheetName || null;
}

function getTarget(action) {
  return action.target || action.name || null;
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
      return {
        kind: 'write',
        label: `Aggiorna il range ${target || 'selezionato'}`,
        sheet,
        target,
        preview: valuePreview(action.formulas || action.values || action.value)
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
      return {
        kind: 'format',
        label: `Aggiunge formattazione condizionale a ${target || 'un range'}`,
        sheet,
        target,
        preview: valuePreview(action.options)
      };
    case 'createChart':
      return {
        kind: 'visual',
        label: `Crea un grafico dal range ${target || 'specificato'}`,
        sheet,
        target,
        preview: valuePreview(action.options)
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

function hasMutationActions(actions) {
  return Array.isArray(actions) && actions.some(action => MUTATION_ACTION_TYPES.has(action?.type));
}

function buildActionPreview(actions, task) {
  const safeActions = Array.isArray(actions) ? actions.filter(Boolean) : [];
  const items = safeActions.map(summarizeAction);
  const affectedSheets = Array.from(new Set(items.map(item => item.sheet).filter(Boolean)));
  const affectedTargets = Array.from(new Set(items.map(item => item.target).filter(Boolean)));

  return {
    title: task?.description || task?.tool || 'Modifiche al workbook',
    totalActions: safeActions.length,
    mutationCount: safeActions.filter(action => MUTATION_ACTION_TYPES.has(action.type)).length,
    affectedSheets,
    affectedTargets,
    items
  };
}

module.exports = {
  buildActionPreview,
  hasMutationActions
};
