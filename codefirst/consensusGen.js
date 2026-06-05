'use strict';

// Multi-LLM consensus for critical slices. Runs N parallel codegen calls,
// picks the BEST output by validator score. Tradeoffs:
//   - Cost: N× tokens
//   - Latency: max(call_i) ≈ same as single (parallel)
//   - Quality: dominant variance term reduced
//
// Used selectively on layers where errors cascade most (inputs, consolidation).

const logger = require('../server/utils/logger');
const { validateCellDeps } = require('./cellDepValidator');

function scoreActions(actions, expectedSheet) {
  if (!Array.isArray(actions) || actions.length === 0) return { score: -1000, cellCount: 0 };
  const cellCount = actions.reduce((s, a) => {
    if (a.type === 'setCellRange' && a.cells) return s + Object.keys(a.cells).length;
    return s;
  }, 0);
  const formulaCount = actions.reduce((s, a) => {
    if (a.type !== 'setCellRange' || !a.cells) return s;
    return s + Object.values(a.cells).filter(c => typeof c === 'object' && c?.formula).length;
  }, 0);
  // Validator
  const depIssues = validateCellDeps(actions);
  const critical = depIssues.filter(d => d.severity === 'critical' && (!expectedSheet || d.location.startsWith(expectedSheet + '!'))).length;
  const high = depIssues.filter(d => d.severity === 'high' && (!expectedSheet || d.location.startsWith(expectedSheet + '!'))).length;
  // Score: more cells/formulas = better, more issues = worse
  const score = cellCount * 0.5 + formulaCount * 0.3 - critical * 50 - high * 10;
  return { score, cellCount, formulaCount, critical, high };
}

// Run N parallel generators, return the actions with the best score.
// generators is an array of async fns each returning {actions, codeTokens, codeTimeMs, error}.
async function consensusGenerate(generators, expectedSheet) {
  if (!generators || generators.length === 0) return null;
  if (generators.length === 1) return generators[0]();
  const start = Date.now();
  const results = await Promise.allSettled(generators.map(g => g()));
  const scored = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected') {
      scored.push({ idx: i, actions: [], codeTokens: { promptTokens: 0, completionTokens: 0, calls: 0 }, codeTimeMs: 0, score: -1000, error: r.reason?.message });
      continue;
    }
    const v = r.value;
    const s = scoreActions(v.actions, expectedSheet);
    scored.push({ idx: i, ...v, ...s });
  }
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  // Aggregate tokens: count ALL parallel calls (we paid for them).
  let totalPrompt = 0, totalCompletion = 0, totalCalls = 0;
  for (const r of scored) {
    totalPrompt += r.codeTokens?.promptTokens || 0;
    totalCompletion += r.codeTokens?.completionTokens || 0;
    totalCalls += r.codeTokens?.calls || 0;
  }
  logger.info(`[Consensus] ${generators.length} parallel codegen for ${expectedSheet || 'slice'}: best score=${best.score.toFixed(1)} (cells=${best.cellCount}, crit=${best.critical}, high=${best.high}); total ${Math.round(totalPrompt + totalCompletion)} tokens, ${Date.now() - start}ms wall`);
  return {
    actions: best.actions,
    codeTokens: { promptTokens: totalPrompt, completionTokens: totalCompletion, calls: totalCalls },
    codeTimeMs: Date.now() - start,
    consensus: { n: generators.length, scores: scored.map(s => ({ score: s.score, crit: s.critical, high: s.high })) },
  };
}

module.exports = { consensusGenerate, scoreActions };
