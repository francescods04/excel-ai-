'use strict';

const { callLLM } = require('../server/tools/llm');
const logger = require('../server/utils/logger');

/**
 * Integration Pass — generates missing interface cells after stepwise generation.
 *
 * Stepwise generation produces slices independently. Sometimes a slice references
 * a cell from another slice that was never emitted (e.g. DCF!B12 expected by Sanity).
 * This pass creates the missing cells with appropriate formulas/values.
 *
 * It is NOT domain-specific. It receives the set of missing references and the
 * current actions, and emits patch actions for the missing cells.
 */

async function integrationPass(actions, missingRefs, objective, plan, options = {}) {
  const { modelOverride = null } = options;
  if (!missingRefs || missingRefs.length === 0) return { patchActions: [] };

  // Group missing refs by target sheet
  const bySheet = new Map();
  for (const ref of missingRefs) {
    const sh = ref.targetSheet;
    if (!bySheet.has(sh)) bySheet.set(sh, []);
    bySheet.get(sh).push(ref);
  }

  const systemPrompt = [
    'You are a spreadsheet integration engineer.',
    'You receive a list of missing cross-sheet references and the current actions.',
    'Your job is to emit the MINIMUM set of patch actions that create the missing cells with correct formulas or values.',
    'Return ONLY {"actions": [...]} with setCellRange actions.',
  ].join('\n');

  const actionsJson = JSON.stringify(actions).slice(0, 8000);
  const missingJson = JSON.stringify(
    [...bySheet.entries()].map(([sheet, refs]) => ({
      sheet,
      missingCells: refs.map(r => r.targetCell),
      referencedBy: [...new Set(refs.map(r => r.sourceLocation))],
    }))
  ).slice(0, 4000);

  const userPrompt = [
    '## Objective',
    objective.slice(0, 1000),
    '',
    '## Missing Cross-Sheet References',
    'These cells are referenced by formulas but do not exist in the generated actions:',
    '```json',
    missingJson,
    '```',
    '',
    '## Current Actions (summary)',
    '```json',
    actionsJson,
    '```',
    '',
    '## Instructions',
    'For each missing cell, create a setCellRange action that adds the cell to the correct sheet.',
    '- Use formulas if the cell should be computed from other cells in the same sheet.',
    '- Use values if the cell is a label, assumption, or constant.',
    '- Do NOT create new sheets.',
    '- Do NOT modify existing cells.',
    '- Return ONLY {"actions": [...]}',
  ].join('\n');

  const start = Date.now();
  try {
    const result = await callLLM({
      system: systemPrompt,
      userText: userPrompt,
      timeoutMs: 30000,
      modelOverride,
      role: 'builder_structural',
      thinkingDisabled: true,
      jsonMode: true,
      label: 'codefirst_integration',
    });

    let patchActions = [];
    if (result && Array.isArray(result.actions)) {
      patchActions = result.actions;
    } else if (Array.isArray(result)) {
      patchActions = result;
    }

    logger.info(`[IntegrationPass] Done (${Date.now() - start}ms): ${patchActions.length} patch actions for ${missingRefs.length} missing refs`);
    return { patchActions };
  } catch (error) {
    logger.warn(`[IntegrationPass] Failed: ${error.message}`);
    return { patchActions: [] };
  }
}

module.exports = {
  integrationPass,
};
