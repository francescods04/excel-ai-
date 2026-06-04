'use strict';

const { planWorkbook, generateWithPlan, generateStepwise, actionsFromResult, buildSlices } = require('./enhanced');
const { researchData, buildResearchContext } = require('./researcher');
const { runCritic } = require('./financialCritic');
const { repairActions, applyPatches } = require('./repairAgent');
const { sanitizeActions } = require('./actionSanitizer');
const { validateFormulas } = require('./formulaValidator');
const logger = require('../server/utils/logger');

const MAX_AUTORESEARCH_ITERATIONS = 3;
const SCORE_APPROVAL_THRESHOLD = 80;

/**
 * Autoresearch Loop: iterative research → plan → generate → validate → critic → repair
 *
 * This is domain-agnostic. It uses the Research Agent to build context from any data,
 * then iteratively improves the generated Excel actions until quality converges.
 */
async function autoresearchPipeline(objective, context = {}, options = {}) {
  const {
    modelOverride = null,
    data = null, // optional pre-extracted data (e.g., AIDA JSON)
    onProgress = null,
    maxIterations = MAX_AUTORESEARCH_ITERATIONS,
    skipResearch = false,
  } = options;

  const totalStart = Date.now();
  const timeline = [];

  function log(phase, detail) {
    timeline.push({ ts: Date.now() - totalStart, phase, detail });
    logger.info(`[Autoresearch] ${phase}: ${detail}`);
    if (onProgress) onProgress(phase, { message: detail });
  }

  // ===== Phase 0: Research =====
  let researchContext = null;
  if (!skipResearch && data) {
    log('researching', 'Analyzing provided data...');
    const researchResult = await researchData(data, objective, { modelOverride });
    researchContext = buildResearchContext(researchResult, objective);
    log('researching', `Domain=${researchContext.domain}, metrics=${researchContext.key_metrics.length}, assumptions=${researchContext.derived_assumptions.length}`);
  } else {
    researchContext = buildResearchContext({ report: { domain: 'general_finance' } }, objective);
  }

  // ===== Phase 1: Plan =====
  log('planning', 'Building blueprint...');
  const enrichedContext = {
    ...context,
    _researchContext: researchContext?.promptBlock || '',
  };
  const planResult = await planWorkbook(objective, enrichedContext, {
    modelOverride,
  });

  // If we have research context, we enrich the plan manually
  let plan = planResult.plan;
  if (!plan || !plan.sections) {
    log('planning', 'Plan empty, using fallback');
    plan = { sections: [{ sheet: 'Sheet1', title: objective, key_formulas: [] }], global_conventions: {} };
  }

  // Prepend research-derived assumptions as a synthetic section if not present
  if (researchContext && researchContext.derived_assumptions.length > 0) {
    const hasAssumptions = plan.sections.some(s => /assumptions|inputs|drivers/i.test(s.sheet + s.title));
    if (!hasAssumptions) {
      plan.sections.unshift({
        sheet: 'Assumptions',
        title: 'Research-Driven Assumptions',
        row_range: 'A1:B50',
        description: 'Base-case assumptions derived from historical data and industry context.',
        key_formulas: [],
        density_note: `${researchContext.derived_assumptions.length} assumption rows`,
        cross_refs: [],
        is_time_series: false,
      });
    }
  }

  log('planning', `Plan: ${plan.sections.length} sections, ~${plan.estimated_cells || '?'} cells`);

  // ===== Phase 2: Initial Generation =====
  log('generating', 'Initial code generation...');
  let currentActions = [];
  let currentCodeResult = null;

  const cx = { sections: plan.sections.length, estCells: Number(plan.estimated_cells) || plan.sections.length * 60 };
  const useStepwise = cx.sections > 4 || cx.estCells > 250;

  if (useStepwise) {
    currentCodeResult = await generateStepwise(objective, enrichedContext, plan, {
      modelOverride,
      onProgress: (phase, msg) => log('generating', msg.message || phase),
      parallel: true,
    });
  } else {
    currentCodeResult = await generateWithPlan(objective, enrichedContext, plan, { modelOverride });
  }

  if (!currentCodeResult.actions || currentCodeResult.actions.length === 0) {
    return { status: 'failed', error: 'Initial code generation failed', timeline };
  }

  currentActions = currentCodeResult.actions;
  log('generating', `Initial: ${currentActions.length} actions`);

  // ===== Iterative Improvement Loop =====
  let iteration = 0;
  let lastScore = 0;
  let converged = false;

  while (iteration < maxIterations && !converged) {
    iteration += 1;
    log('validating', `Iteration ${iteration}/${maxIterations}`);

    // 2a. Structural sanitize
    const sanitized = sanitizeActions(currentActions);
    currentActions = sanitized.actions;
    if (sanitized.stats.dropped > 0 || sanitized.stats.bounded > 0) {
      log('validating', `Sanitizer: dropped=${sanitized.stats.dropped} bounded=${sanitized.stats.bounded}`);
    }

    // 2b. Formula validation
    const valIssues = validateFormulas(currentActions, context);
    const criticalVal = valIssues.filter(i => i.severity === 'critical');
    if (criticalVal.length > 0) {
      log('validating', `FormulaValidator: ${criticalVal.length} critical, ${valIssues.length} total`);
    }

    // 2c. Deep Critic
    log('reviewing', 'Running deep critic...');
    const criticResult = await runCritic(currentActions, objective, plan, researchContext, { modelOverride });
    log('reviewing', `Critic: score=${criticResult.score}, approved=${criticResult.approved}, issues=${criticResult.issues.length}`);

    // 2d. Convergence check
    if (criticResult.approved && criticalVal.length === 0) {
      log('converged', `Score ${criticResult.score} >= threshold with no critical structural issues.`);
      converged = true;
      break;
    }

    if (criticResult.score >= lastScore && Math.abs(criticResult.score - lastScore) < 3 && iteration > 1) {
      log('converged', `Score stalled at ${criticResult.score}. Stopping.`);
      converged = true;
      break;
    }
    lastScore = criticResult.score;

    // 2e. Repair
    if (criticResult.issues.length === 0 && criticalVal.length === 0) {
      log('converged', 'No issues found. Stopping.');
      converged = true;
      break;
    }

    const allIssues = [
      ...criticResult.issues,
      ...valIssues.map(v => ({ ...v, source: 'formula_validator' })),
    ];

    // On last iteration, only fix critical issues
    const issuesToFix = iteration === maxIterations
      ? allIssues.filter(i => i.severity === 'critical')
      : allIssues;

    if (issuesToFix.length === 0) {
      log('converged', 'No actionable issues. Stopping.');
      converged = true;
      break;
    }

    log('repairing', `Fixing ${issuesToFix.length} issues (${issuesToFix.filter(i => i.severity === 'critical').length} critical)...`);
    const repairResult = await repairActions(currentActions, issuesToFix, objective, plan, researchContext, { modelOverride });

    if (repairResult.patchActions.length === 0) {
      log('repairing', 'Repairer produced no patches. Stopping.');
      break;
    }

    currentActions = applyPatches(currentActions, repairResult.patchActions);
    log('repairing', `Applied ${repairResult.patchActions.length} patches. Total actions: ${currentActions.length}`);
  }

  // Final sanitize after all patches
  const finalSanitized = sanitizeActions(currentActions);
  currentActions = finalSanitized.actions;

  const cellInfo = actionsFromResult(currentActions);
  const totalMs = Date.now() - totalStart;

  log('complete', `${cellInfo.cellCount} cells, ${iteration} iterations, ${totalMs}ms`);

  return {
    status: 'ok',
    actions: currentActions,
    cellCount: cellInfo.cellCount,
    plan,
    researchContext,
    iterations: iteration,
    converged,
    lastScore,
    timeline,
    totalMs,
  };
}

module.exports = {
  autoresearchPipeline,
  MAX_AUTORESEARCH_ITERATIONS,
};
