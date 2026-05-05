// Undo turn V1.1: produce action inverse derivabili senza snapshot client.
// V1.1 supporta: createSheet (→ deleteSheet), createChart (→ deleteChart),
//   renameSheet (→ renameSheet inverse), duplicateSheet (→ deleteSheet).
// V2 (futuro): snapshot pre-mutation lato client per setCellValue/runFormula/fillRange/writeRange/copyRange.

const logger = require('../utils/logger');

const SUPPORTED_INVERSE = {
  createSheet: (action) => ({
    type: 'deleteSheet',
    name: action.name || action.sheet,
    sheet: action.name || action.sheet
  }),
  createChart: (action) => ({
    type: 'deleteChart',
    sheet: action.sheet,
    chartName: action.options?.title || null
  }),
  renameSheet: (action) => ({
    type: 'renameSheet',
    oldName: action.newName,
    newName: action.oldName,
    note: `undo: restored name from "${action.newName}" back to "${action.oldName}"`
  }),
  duplicateSheet: (action) => ({
    type: 'deleteSheet',
    name: action.newName,
    note: `undo: deleting duplicated sheet "${action.newName}"`
  })
};

/**
 * Estrae actions inverse da un turn completed o running.
 * Ordine: reverse rispetto all'esecuzione (LIFO).
 */
function buildUndoActions(turn) {
  if (!turn || !turn.results) return { actions: [], skipped: [] };
  const actions = [];
  const skipped = [];

  // Itera task in ordine inverso (assumendo turn.plan.tasks è in topological order)
  const taskIds = (turn.plan?.tasks || []).map(t => t.id).reverse();

  for (const taskId of taskIds) {
    const result = turn.results[taskId];
    if (!result || !Array.isArray(result.actions)) continue;
    // Reverse anche all'interno del task
    for (let i = result.actions.length - 1; i >= 0; i--) {
      const action = result.actions[i];
      const builder = SUPPORTED_INVERSE[action.type];
      if (builder) {
        actions.push(builder(action));
      } else if (['setCellValue', 'runFormula', 'fillRange', 'writeRange', 'setCellFormat', 'addConditionalFormat'].includes(action.type)) {
        skipped.push({ taskId, type: action.type, target: action.target, reason: 'no-snapshot-v1' });
      }
    }
  }

  return { actions, skipped };
}

function summarizeUndo({ actions, skipped }) {
  return {
    inverseCount: actions.length,
    skippedCount: skipped.length,
    types: actions.reduce((acc, a) => { acc[a.type] = (acc[a.type] || 0) + 1; return acc; }, {}),
    skippedTypes: skipped.reduce((acc, s) => { acc[s.type] = (acc[s.type] || 0) + 1; return acc; }, {})
  };
}

logger.info('[Undo] V1.1 initialized (createSheet/createChart/renameSheet/duplicateSheet inverse)');

module.exports = {
  buildUndoActions,
  summarizeUndo,
  SUPPORTED_INVERSE
};
