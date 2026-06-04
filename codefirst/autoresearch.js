'use strict';

const { planWorkbook, generateWithPlan, generateStepwise, actionsFromResult, buildSlices } = require('./enhanced');
const { researchData, buildResearchContext } = require('./researcher');
const { runCritic } = require('./financialCritic');
const { repairActions, applyPatches } = require('./repairAgent');
const { sanitizeActions } = require('./actionSanitizer');
const { validateFormulas } = require('./formulaValidator');
const { validateCrossSliceConsistency } = require('./crossSliceValidator');
const { deterministicRepair } = require('./deterministicRepair');
const { integrationPass } = require('./integrationPass');
const logger = require('../server/utils/logger');

const DEFAULT_MAX_ITERATIONS = 3;
const DEFAULT_SCORE_THRESHOLD = 90;

/* ---------- Time budgets (ms) ---------- */
const TIME_BUDGET = {
  research: 30000,
  plan: 30000,
  generate: 90000,
  critic: 60000,
  repair: 60000,
};

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
    maxIterations = DEFAULT_MAX_ITERATIONS,
    skipResearch = false,
    scoreThreshold = DEFAULT_SCORE_THRESHOLD,
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
  // FAST PATH: simple plans (<5 sections, <200 cells) → single-shot, no stepwise overhead
  const useStepwise = cx.sections > 5 || cx.estCells > 200;

  const genStart = Date.now();
  if (useStepwise) {
    currentCodeResult = await generateStepwise(objective, enrichedContext, plan, {
      modelOverride,
      researchContext,
      onProgress: (phase, msg) => log('generating', msg.message || phase),
      parallel: true,
      // NEW: inline structural validation per slice to catch errors early
      validateSlice: (sliceActions) => {
        const sIssues = validateFormulas(sliceActions, context);
        const critical = sIssues.filter(i => i.severity === 'critical');
        return { issues: sIssues, criticalCount: critical.length, valid: critical.length === 0 };
      },
    });
  } else {
    currentCodeResult = await generateWithPlan(objective, enrichedContext, plan, {
      modelOverride,
      researchContext,
    });
  }
  const genMs = Date.now() - genStart;
  log('generating', `Initial: ${currentCodeResult.actions?.length || 0} actions in ${genMs}ms (stepwise=${useStepwise})`);

  if (!currentCodeResult.actions || currentCodeResult.actions.length === 0) {
    return { status: 'failed', error: 'Initial code generation failed', timeline };
  }

  currentActions = currentCodeResult.actions;

  // NEW: Cross-slice consistency check (fast, catches inter-sheet gaps)
  let crossIssues = validateCrossSliceConsistency(currentActions, plan);
  if (crossIssues.length > 0) {
    log('validating', `Cross-slice validator: ${crossIssues.length} issues (${crossIssues.filter(i => i.severity === 'critical').length} critical)`);
  }

  // NEW: Integration pass — generate missing interface cells that other sheets reference
  const missingRefs = crossIssues
    .filter(i => i.kind === 'empty_xsheet_cell' || i.kind === 'empty_xsheet_ref')
    .map(i => {
      const loc = i.location || '';
      const formula = i.formula || '';
      // Parse target sheet and cell from formula or detail
      const m = formula.match(/(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))!(\$?)([A-Z]+)(\$?)(\d+)/);
      if (!m) return null;
      const targetSheet = m[1] || m[2];
      const targetCell = `${m[4]}${m[6]}`;
      return { sourceLocation: loc, targetSheet, targetCell, formula };
    }).filter(Boolean);

  if (missingRefs.length > 0) {
    log('integrating', `Integration pass for ${missingRefs.length} missing cross-sheet cells...`);
    const integrationStart = Date.now();
    const integrationResult = await integrationPass(currentActions, missingRefs, objective, plan, { modelOverride });
    if (integrationResult.patchActions.length > 0) {
      currentActions = applyPatches(currentActions, integrationResult.patchActions);
      log('integrating', `Applied ${integrationResult.patchActions.length} integration patches in ${Date.now() - integrationStart}ms`);
      // Re-run cross-slice validation after integration
      crossIssues = validateCrossSliceConsistency(currentActions, plan);
      log('validating', `Cross-slice validator after integration: ${crossIssues.length} issues (${crossIssues.filter(i => i.severity === 'critical').length} critical)`);
    }
  }

  // ===== Iterative Improvement Loop =====
  let iteration = 0;
  let lastScore = 0;
  let converged = false;
  let structuralScoreOnly = 0;

  while (iteration < maxIterations && !converged) {
    iteration += 1;
    log('validating', `Iteration ${iteration}/${maxIterations}`);

    // 2a. Structural sanitize
    const sanitized = sanitizeActions(currentActions);
    currentActions = sanitized.actions;
    if (sanitized.stats.dropped > 0 || sanitized.stats.bounded > 0) {
      log('validating', `Sanitizer: dropped=${sanitized.stats.dropped} bounded=${sanitized.stats.bounded}`);
    }

    // 2b. Formula validation (fast, deterministic)
    const valStart = Date.now();
    const valIssues = validateFormulas(currentActions, context);
    const valMs = Date.now() - valStart;
    const criticalVal = valIssues.filter(i => i.severity === 'critical');
    if (criticalVal.length > 0) {
      log('validating', `FormulaValidator: ${criticalVal.length} critical, ${valIssues.length} total (${valMs}ms)`);
    }

    // 2c. Structural critic (fast)
    const structStart = Date.now();
    const { structuralValidation } = require('./financialCritic');
    const structuralIssues = structuralValidation(currentActions);
    const structMs = Date.now() - structStart;
    const criticalStructural = structuralIssues.filter(i => i.severity === 'critical');
    structuralScoreOnly = Math.max(0, 100 - structuralIssues.length * 2 - criticalStructural.length * 10);
    log('reviewing', `Structural critic: ${structuralIssues.length} issues, score=${structuralScoreOnly} (${structMs}ms)`);

    // ADAPTIVE THRESHOLD: try 90 first, then 85, then 80
    const adaptiveThreshold = iteration === 1 ? 90 : (iteration === 2 ? 85 : 80);

    // 2d. PRIMARY CONVERGENCE: structural score is stable and deterministic
    // If structural score >= adaptiveThreshold with no critical issues, approve immediately.
    // Deep critic is advisory only — we run it for logging but do not block on it.
    const hasCritical = criticalVal.length > 0 || criticalStructural.length > 0;
    if (structuralScoreOnly >= adaptiveThreshold && !hasCritical) {
      log('converged', `Structural score ${structuralScoreOnly} >= ${adaptiveThreshold}, no critical issues. Approved.`);
      converged = true;
      lastScore = structuralScoreOnly;
      break;
    }

    // 2e. Deep critic — advisory, does not block approval
    let criticResult = null;
    if (structuralScoreOnly >= 55) {
      log('reviewing', 'Running deep critic (advisory)...');
      const criticStart = Date.now();
      criticResult = await runCritic(currentActions, objective, plan, researchContext, {
        modelOverride,
        skipStructural: true,
        structuralIssues,
        timeoutMs: TIME_BUDGET.critic,
      });
      const criticMs = Date.now() - criticStart;
      log('reviewing', `Deep critic: score=${criticResult.score}, approved=${criticResult.approved}, issues=${criticResult.issues.length} (${criticMs}ms)`);
    } else {
      criticResult = {
        approved: false,
        score: structuralScoreOnly,
        issues: structuralIssues.map(i => ({ ...i, source: 'structural' })),
        structuralIssues,
        deepReview: null,
        tokens: { promptTokens: 0, completionTokens: 0, calls: 0 },
        timeMs: 0,
      };
      log('reviewing', `Skipped deep critic (structural score ${structuralScoreOnly} < 55)`);
    }

    // 2f. Convergence check (fallback if structural is not adaptiveThreshold but deep critic says OK)
    const effectiveScore = Math.max(structuralScoreOnly, criticResult.score);

    if (effectiveScore >= adaptiveThreshold && !hasCritical) {
      log('converged', `Score ${effectiveScore} >= ${adaptiveThreshold} with no critical issues.`);
      converged = true;
      break;
    }

    // Stagnation: stop if score doesn't improve
    if (effectiveScore >= lastScore && Math.abs(effectiveScore - lastScore) < 5 && iteration > 1) {
      log('converged', `Score stalled at ${effectiveScore}. Stopping.`);
      converged = true;
      break;
    }
    lastScore = effectiveScore;

    // 2g. Repair — two-phase: deterministic first, then LLM for conceptual issues
    const allIssues = [
      ...criticResult.issues,
      ...valIssues.map(v => ({ ...v, source: 'formula_validator' })),
      ...crossIssues.map(c => ({ ...c, source: 'cross_slice' })),
    ];

    // Deduplicate by location+kind
    const issueMap = new Map();
    for (const issue of allIssues) {
      const key = `${issue.location || issue.sheet || 'unknown'}|${issue.kind || issue.category || 'issue'}`;
      if (!issueMap.has(key)) issueMap.set(key, issue);
    }
    const uniqueIssues = Array.from(issueMap.values());

    // On last iteration, only fix critical issues
    const issuesToFix = iteration === maxIterations
      ? uniqueIssues.filter(i => i.severity === 'critical')
      : uniqueIssues;

    // Phase 1: deterministic repair (fast, no LLM)
    const detPatches = deterministicRepair(currentActions, issuesToFix);
    if (detPatches.length > 0) {
      currentActions = applyPatches(currentActions, detPatches);
      log('repairing', `Applied ${detPatches.length} deterministic patches.`);
    }

    // Phase 2: LLM repair for conceptual issues that deterministic can't fix
    const remainingAfterDet = issuesToFix.filter(issue => !detPatches.some(p => {
      // rough match: if patch sheet matches issue sheet, consider it handled
      const pSheet = p.sheet || p.sheetName;
      const iSheet = issue.location ? issue.location.split('!')[0] : issue.sheet;
      return pSheet === iSheet;
    }));

    // Cap issues sent to repairer to top 10 by severity (keep prompt small, avoid timeouts)
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    remainingAfterDet.sort((a, b) => (severityOrder[a.severity] || 99) - (severityOrder[b.severity] || 99));
    const cappedIssues = remainingAfterDet.slice(0, 10);

    if (cappedIssues.length === 0) {
      if (detPatches.length > 0) {
        log('repairing', 'All issues handled deterministically. Continuing.');
        continue; // re-run critic with fixed actions
      }
      log('converged', 'No actionable issues. Stopping.');
      converged = true;
      break;
    }

    log('repairing', `Fixing ${cappedIssues.length} issues (${cappedIssues.filter(i => i.severity === 'critical').length} critical) with LLM...`);
    const repairStart = Date.now();
    const repairResult = await repairActions(currentActions, cappedIssues, objective, plan, researchContext, {
      modelOverride,
      timeoutMs: TIME_BUDGET.repair,
    });
    const repairMs = Date.now() - repairStart;

    if (repairResult.patchActions.length === 0) {
      if (detPatches.length > 0) {
        log('repairing', `LLM repairer produced no patches (${repairMs}ms), but deterministic patches applied.`);
      } else {
        log('repairing', `Repairer produced no patches (${repairMs}ms). Stopping.`);
        break;
      }
    } else {
      currentActions = applyPatches(currentActions, repairResult.patchActions);
      log('repairing', `Applied ${repairResult.patchActions.length} LLM patches in ${repairMs}ms. Total actions: ${currentActions.length}`);
    }
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
    lastScore: lastScore || structuralScoreOnly,
    timeline,
    totalMs,
    timeBudgets: TIME_BUDGET,
  };
}

module.exports = {
  autoresearchPipeline,
  MAX_AUTORESEARCH_ITERATIONS: DEFAULT_MAX_ITERATIONS,
};
