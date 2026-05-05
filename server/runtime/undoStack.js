const logger = require('../utils/logger');

/* ---------- Granular Undo Stack ---------- */

const undoStacks = new Map(); // turnId -> [{ type, sheet, target, previousValues, previousFormats }]
const redoStacks = new Map(); // turnId -> [...]

function getUndoStack(turnId) {
  if (!undoStacks.has(turnId)) undoStacks.set(turnId, []);
  return undoStacks.get(turnId);
}

function getRedoStack(turnId) {
  if (!redoStacks.has(turnId)) redoStacks.set(turnId, []);
  return redoStacks.get(turnId);
}

/* ---------- Push undo snapshot before mutation ---------- */

function pushUndoAction(turnId, action, previousState) {
  const stack = getUndoStack(turnId);
  stack.push({
    timestamp: Date.now(),
    type: action.type,
    sheet: action.sheet,
    target: action.target,
    previousState
  });
  // Clear redo stack on new action
  redoStacks.set(turnId, []);
  logger.info(`[Undo] Pushed ${action.type} ${action.sheet}!${action.target} to undo stack (size=${stack.length})`);
}

/* ---------- Build undo actions from snapshot ---------- */

function buildUndoActions(turnId) {
  const stack = getUndoStack(turnId);
  if (stack.length === 0) return null;

  const entry = stack.pop();
  const redoStack = getRedoStack(turnId);
  redoStack.push(entry);

  const actions = [];

  if (entry.previousState) {
    if (entry.previousState.values) {
      actions.push({
        type: 'writeRange',
        sheet: entry.sheet,
        target: entry.target,
        values: entry.previousState.values
      });
    }
    if (entry.previousState.formulas) {
      actions.push({
        type: 'writeRange',
        sheet: entry.sheet,
        target: entry.target,
        formulas: entry.previousState.formulas
      });
    }
    if (entry.previousState.formats) {
      actions.push({
        type: 'setCellFormat',
        sheet: entry.sheet,
        target: entry.target,
        options: entry.previousState.formats
      });
    }
  }

  if (entry.type === 'createSheet' && entry.sheet) {
    actions.push({
      type: 'deleteSheet',
      sheet: entry.sheet
    });
  }

  logger.info(`[Undo] Built ${actions.length} undo actions for ${entry.type}`);
  return actions;
}

function buildRedoActions(turnId) {
  const stack = getRedoStack(turnId);
  if (stack.length === 0) return null;

  const entry = stack.pop();
  const undoStack = getUndoStack(turnId);
  undoStack.push(entry);

  // For redo, we would need to store the "next" state. For simplicity, redo just re-applies the original action.
  // In a full implementation, we'd store the action itself.
  return [];
}

function clearUndoStack(turnId) {
  undoStacks.delete(turnId);
  redoStacks.delete(turnId);
}

module.exports = {
  pushUndoAction,
  buildUndoActions,
  buildRedoActions,
  clearUndoStack,
  getUndoStack
};
