'use strict';

const logger = require('../utils/logger');

function validateOrchestratorResult(blueprint, sliceStates, sliceResults, sliceWriteCounts) {
  const slices = Array.isArray(blueprint?.slices) ? blueprint.slices : (Array.isArray(blueprint) ? blueprint : []);
  const issues = [];

  for (const slice of slices) {
    const sliceId = slice.id;
    const st = sliceStates[sliceId] || 'unknown';
    const writes = sliceWriteCounts[sliceId] || 0;
    const result = sliceResults[sliceId] || {};

    if (st === 'failed' && writes > 0) {
      issues.push({
        severity: 'high',
        type: 'partial_data',
        sliceId,
        title: slice.title,
        message: `${slice.title}: fallito dopo ${writes} celle scritte. I dati potrebbero essere incompleti. Verificare i fogli dipendenti.`,
        suggestion: `Rivedere il foglio "${(slice.scope && slice.scope.sheets_owned && slice.scope.sheets_owned[0]) || sliceId}"`
      });
    }

    if (st === 'failed' && writes === 0) {
      issues.push({
        severity: 'high',
        type: 'no_data',
        sliceId,
        title: slice.title,
        message: `${slice.title}: fallito senza scrivere dati. I fogli dipendenti potrebbero avere formule #REF!.`
      });
    }

    if (st === 'skipped') {
      issues.push({
        severity: 'medium',
        type: 'skipped',
        sliceId,
        title: slice.title,
        message: `${slice.title}: saltato (dipendenza fallita: ${result.reason || 'sconosciuta'}).`
      });
    }

    if (st === 'retrying') {
      issues.push({
        severity: 'low',
        type: 'retrying',
        sliceId,
        title: slice.title,
        message: `${slice.title}: in retry #${result.retry || '?'}.`
      });
    }

    if (st === 'succeeded' && writes < 5 && slice.estimated_iters > 5) {
      issues.push({
        severity: 'low',
        type: 'low_write',
        sliceId,
        title: slice.title,
        message: `${slice.title}: completato con solo ${writes} scritture (stimate ${slice.estimated_iters} iter). Contenuto potrebbe essere insufficiente.`
      });
    }

    if (st === 'succeeded' && result.iteration >= 25) {
      issues.push({
        severity: 'low',
        type: 'near_cap',
        sliceId,
        title: slice.title,
        message: `${slice.title}: completato al ${result.iteration}° iter (vicino al cap). Possibile contenuto troncato.`
      });
    }
  }

  const total = slices.length;
  const succeeded = Object.values(sliceStates).filter(s => s === 'succeeded').length;
  const failed = Object.values(sliceStates).filter(s => s === 'failed').length;
  const skipped = Object.values(sliceStates).filter(s => s === 'skipped').length;

  if (failed > 0 && succeeded > 0) {
    issues.unshift({
      severity: 'high',
      type: 'partial_completion',
      message: `Orchestratore completato con ${succeeded}/${total} slice ok (${failed} fallite, ${skipped} saltate). I fogli Excel potrebbero essere incompleti.`
    });
  }

  if (issues.length > 0) {
    logger.warn(`[BackgroundValidator] ${issues.length} issue(s) after orchestrator completion`);
  }

  return { ok: issues.length === 0, issues, summary: { total, succeeded, failed, skipped } };
}

function buildValidationSummary(validationResult) {
  if (!validationResult || validationResult.ok) return null;
  const { issues } = validationResult;
  if (!Array.isArray(issues) || issues.length === 0) return null;

  const high = issues.filter(i => i.severity === 'high');
  const medium = issues.filter(i => i.severity === 'medium');

  const lines = [];
  if (high.length > 0) {
    lines.push(`⚠️ ${high.length} problema${high.length > 1 ? 'i' : ''} critic${high.length > 1 ? 'i' : 'o'}:`);
    for (const issue of high) lines.push(`  - ${issue.message}`);
  }
  if (medium.length > 0) {
    lines.push(`📋 ${medium.length} avviso${medium.length > 1 ? 'i' : ''}:`);
    for (const issue of medium) lines.push(`  - ${issue.message}`);
  }

  return lines.join('\n');
}

module.exports = {
  validateOrchestratorResult,
  buildValidationSummary
};
