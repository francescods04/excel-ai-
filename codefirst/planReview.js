'use strict';

// Plan review gate — general variance killer.
//
// The plan is the highest-leverage LLM call: a missing section, an incomplete
// reads_from list or absent exported_cells cascades into broken refs and lost
// sheets downstream (observed: a run that dropped PnL entirely). A pro-tier
// reviewer validates the plan AGAINST THE OBJECTIVE (no domain rules) and
// returns STRUCTURED patch ops that we apply deterministically — the reviewer
// never rewrites the whole plan, so it cannot truncate or corrupt it.

const { callLLM, resetUsageStats, getUsageStats } = require('../server/tools/llm');
const logger = require('../server/utils/logger');
const { MODEL_TIERS } = require('./modelRouter');

const REVIEW_SYSTEM = `You are a senior reviewer of spreadsheet build plans. You receive the USER OBJECTIVE and the PLAN (sections per sheet, cross-sheet dependencies, exported cells, invariants). Find STRUCTURAL gaps that will break generation:

1. missing_section — the objective requires a sheet/topic the plan does not cover (e.g. objective lists required sheets and one is absent)
2. missing_dep — a section's description/formulas clearly read from another sheet that is not in its reads_from list
3. missing_exports — a sheet that other sheets read from declares no exported_cells for the rows they will need
4. missing_invariant — a hard constraint stated in the objective (a balance, a total, a required equality) with no corresponding invariant

Do NOT comment on style, naming, or modeling choices. Only structural gaps that cause broken references or missing content.

Return ONLY JSON with patch operations (max 12):
{"patches":[
 {"op":"add_section","section":{"sheet":"...","title":"...","description":"...","estimated_cells":60,"is_time_series":false,"exported_cells":["B4 = ..."],"row_range":"A1:F20"}},
 {"op":"add_dep","sheet":"PnL","reads_from":["Revenue_Build"]},
 {"op":"add_exports","sheet":"Operating_Model","exported_cells":["B4:Y4 = EBITDA"]},
 {"op":"add_invariant","invariant":{"kind":"balance","left":"Sources_Uses!Total Sources","right":"Sources_Uses!Total Uses"}}
]}
Return {"patches":[]} if the plan is structurally sound. Be conservative: only patch real gaps.`;

function summarizePlanForReview(plan) {
  const sections = (plan.sections || []).map(s => ({
    sheet: s.sheet,
    title: s.title,
    description: String(s.description || '').slice(0, 200),
    is_time_series: !!s.is_time_series,
    periods: s.periods,
    exported_cells: (s.exported_cells || []).slice(0, 12),
  }));
  return JSON.stringify({
    sections,
    cross_sheet_deps: plan.cross_sheet_deps || {},
    invariants: (plan.invariants || []).slice(0, 20),
  }, null, 1);
}

function applyPlanPatches(plan, patches) {
  const stats = { sectionsAdded: 0, depsAdded: 0, exportsAdded: 0, invariantsAdded: 0 };
  if (!Array.isArray(patches)) return stats;
  const sheetSet = new Set((plan.sections || []).map(s => s.sheet));

  for (const p of patches.slice(0, 12)) {
    if (!p || !p.op) continue;
    if (p.op === 'add_section' && p.section && p.section.sheet && !sheetSet.has(p.section.sheet)) {
      plan.sections.push(p.section);
      sheetSet.add(p.section.sheet);
      stats.sectionsAdded++;
    } else if (p.op === 'add_dep' && p.sheet && Array.isArray(p.reads_from)) {
      if (!plan.cross_sheet_deps) plan.cross_sheet_deps = {};
      const entry = plan.cross_sheet_deps[p.sheet] || { reads_from: [] };
      if (!Array.isArray(entry.reads_from)) entry.reads_from = [];
      for (const dep of p.reads_from) {
        if (dep !== p.sheet && sheetSet.has(dep) && !entry.reads_from.includes(dep)) {
          entry.reads_from.push(dep);
          stats.depsAdded++;
        }
      }
      plan.cross_sheet_deps[p.sheet] = entry;
    } else if (p.op === 'add_exports' && p.sheet && Array.isArray(p.exported_cells)) {
      const section = (plan.sections || []).find(s => s.sheet === p.sheet);
      if (section) {
        if (!Array.isArray(section.exported_cells)) section.exported_cells = [];
        for (const e of p.exported_cells) {
          if (typeof e === 'string' && !section.exported_cells.includes(e)) {
            section.exported_cells.push(e);
            stats.exportsAdded++;
          }
        }
      }
    } else if (p.op === 'add_invariant' && p.invariant && p.invariant.kind) {
      if (!Array.isArray(plan.invariants)) plan.invariants = [];
      plan.invariants.push(p.invariant);
      stats.invariantsAdded++;
    }
  }
  return stats;
}

async function reviewPlan(plan, objective, { modelOverride = null, timeoutMs = 90000 } = {}) {
  const userText = [
    '## USER OBJECTIVE',
    String(objective || '').slice(0, 3000),
    '',
    '## PLAN (summary)',
    summarizePlanForReview(plan),
    '',
    'Find structural gaps. Return JSON patches only.',
  ].join('\n');

  resetUsageStats();
  const start = Date.now();
  let result = null;
  try {
    result = await callLLM({
      system: REVIEW_SYSTEM,
      userText,
      timeoutMs,
      modelOverride: process.env.CF_PLAN_REVIEW_MODEL || modelOverride || MODEL_TIERS.pro,
      role: null,
      thinkingDisabled: true,
      jsonMode: true,
      label: 'cf_plan_review',
    });
  } catch (e) {
    logger.warn(`[PlanReview] Failed: ${e.message}`);
    return { stats: null, tokens: getUsageStats(), elapsedMs: Date.now() - start };
  }
  const tokens = getUsageStats();
  const patches = (result && Array.isArray(result.patches)) ? result.patches : [];
  const stats = applyPlanPatches(plan, patches);
  const total = stats.sectionsAdded + stats.depsAdded + stats.exportsAdded + stats.invariantsAdded;
  logger.info(`[PlanReview] ${patches.length} patches → +${stats.sectionsAdded} sections, +${stats.depsAdded} deps, +${stats.exportsAdded} exports, +${stats.invariantsAdded} invariants (${Date.now() - start}ms)`);
  return { stats, patchCount: total, tokens, elapsedMs: Date.now() - start };
}

module.exports = { reviewPlan, applyPlanPatches, summarizePlanForReview };
