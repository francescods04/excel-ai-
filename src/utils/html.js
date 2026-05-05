'use strict';

function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

function formatActionTarget(action) {
  const target = action.target || action.name || '';
  if (action.sheet && action.target) return `${action.sheet}!${action.target}`;
  return action.sheet || target;
}

function summarizeMatrix(value) {
  if (Array.isArray(value)) {
    const rows = value.length;
    const cols = Array.isArray(value[0]) ? value[0].length : 1;
    const sample = JSON.stringify(value.slice(0, 2)).slice(0, 140);
    return `${rows}x${cols} ${sample}${sample.length >= 140 ? '…' : ''}`;
  }
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

function isRangeWriteAction(action) {
  return ['setCellValue', 'runFormula', 'fillRange', 'writeRange'].includes(action?.type);
}

export { escapeHtml, escapeAttr, formatActionTarget, summarizeMatrix, isRangeWriteAction };
