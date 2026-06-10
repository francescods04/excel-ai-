'use strict';

// Code-agent-style targeted fixer.
//
// Pattern (from Claude Code / Codex / Aider):
//   Instead of "rewrite whole file" loop, take each bug and dispatch a tiny
//   focused LLM call: "Cell X has formula Y. Bug: Z. Return ONLY the
//   corrected formula." Each call has minimal scope so the LLM stays focused.
//
// Compared to slice-loop regeneration:
//   - Slice loop: LLM sees 5000-token prompt, has to regenerate ~50-200 cells,
//     produces a different result with possibly new bugs.
//   - Targeted fixer: LLM sees ~300-token prompt, returns ONE formula.
//     Surgical, parallelizable, low-stakes.
//
// We parallelize fixes across bugs and apply the resulting patches atomically.

const { callLLM, resetUsageStats, getUsageStats } = require('../server/tools/llm');
const logger = require('../server/utils/logger');
const { indexCells, extractCellRefs } = require('./cellDepValidator');

const SYSTEM_PROMPT = `You are a precise Excel formula fixer. Given:
- The cell address that has a bug
- The current (buggy) formula
- A description of the bug
- Context about nearby cells and upstream sheets (labels + addresses)

You return ONLY a JSON object: {"formula": "=...", "explanation": "one line"}.
The formula must be valid Excel. Cross-sheet refs must use $. Sheet names with special chars must be quoted: 'Cash Flow'!$B$5.

Do NOT add commentary. Do NOT regenerate other cells. Just the ONE corrected formula.
If you cannot determine the fix with confidence, return {"formula": null, "explanation": "uncertain because X"}.`;

// Pick relevant context: cells in same sheet near the bug + upstream labels
function buildContextForBug(actions, bugLocation, bugDetail) {
  const [sheet, addr] = bugLocation.split('!');
  if (!sheet || !addr) return null;
  const m = addr.match(/^([A-Z]+)(\d+)$/); if (!m) return null;
  const targetRow = Number(m[2]);

  // Per-sheet cell maps + col-A row labels
  const sheets = {};
  for (const a of actions) {
    if (a.type !== 'setCellRange' || !a.cells) continue;
    const sh = a.sheet || a.sheetName;
    if (!sheets[sh]) sheets[sh] = { cells: new Map(), rowLabels: new Map() };
    for (const [cellAddr, spec] of Object.entries(a.cells)) {
      if (!spec) continue;
      const s = typeof spec === 'object' ? spec : { value: spec };
      sheets[sh].cells.set(cellAddr, { value: s.value, formula: s.formula });
      const p = cellAddr.match(/^([A-Z]+)(\d+)$/);
      if (p && p[1] === 'A' && typeof s.value === 'string' && s.value.trim()) {
        sheets[sh].rowLabels.set(Number(p[2]), s.value.trim());
      }
    }
  }

  const currentSheet = sheets[sheet];
  if (!currentSheet) return null;

  // 1) The buggy cell itself
  const buggyCell = currentSheet.cells.get(addr);
  const buggyFormula = buggyCell?.formula || null;

  // 2) Nearby cells (same sheet, ±3 rows, all cols A-K)
  const nearbyRows = [];
  for (let r = Math.max(1, targetRow - 3); r <= targetRow + 3; r++) {
    const label = currentSheet.rowLabels.get(r);
    const rowCells = [];
    for (const [cellAddr, cell] of currentSheet.cells) {
      const p = cellAddr.match(/^([A-Z]+)(\d+)$/);
      if (!p) continue;
      if (Number(p[2]) !== r) continue;
      if (p[1].length > 1) continue; // skip extended cols for brevity
      const v = cell.formula ? `f:${cell.formula.slice(0, 60)}` : (cell.value !== undefined ? `v:${JSON.stringify(cell.value).slice(0, 30)}` : '');
      rowCells.push(`${cellAddr}=${v}`);
    }
    if (label || rowCells.length > 0) {
      nearbyRows.push(`R${r}${label ? `[${label}]` : ''}: ${rowCells.slice(0, 8).join(' | ')}`);
    }
  }

  // 3) Upstream label index (so LLM can find correct cell to reference)
  const upstreamIdx = {};
  for (const [otherSheet, otherData] of Object.entries(sheets)) {
    if (otherSheet === sheet) continue;
    const labels = [];
    for (const [row, label] of [...otherData.rowLabels].sort((a, b) => a[0] - b[0])) {
      const valCell = otherData.cells.get(`B${row}`);
      const val = valCell ? (valCell.formula ? '(formula)' : JSON.stringify(valCell.value)) : '(empty)';
      labels.push(`B${row}=[${label}] val:${val}`);
    }
    if (labels.length > 0) upstreamIdx[otherSheet] = labels.slice(0, 30);
  }

  return {
    sheet,
    addr,
    buggyFormula,
    nearbyRows,
    upstreamIdx,
  };
}

// Generate one targeted fix for one bug
async function fixOneBug({ bug, actions, modelOverride = null, timeoutMs = 25000 }) {
  const start = Date.now();
  const ctx = buildContextForBug(actions, bug.location, bug.detail);
  if (!ctx) {
    return { skipped: true, reason: 'no context', elapsedMs: Date.now() - start };
  }

  const userText = [
    `## Cell to fix: ${ctx.sheet}!${ctx.addr}`,
    `## Current (buggy) formula: ${ctx.buggyFormula || '(none, cell may have value)'}`,
    `## Bug description (${bug.severity} ${bug.kind}): ${bug.detail}`,
    '',
    '## Same-sheet context (rows near the bug):',
    ...ctx.nearbyRows.slice(0, 8),
    '',
    '## Upstream sheets (label index for cross-sheet refs):',
    JSON.stringify(ctx.upstreamIdx, null, 2).slice(0, 3000),
    '',
    'Return JSON {"formula": "=...", "explanation": "..."} or {"formula": null, "explanation": "..."} if uncertain.',
  ].join('\n');

  resetUsageStats();
  try {
    const result = await callLLM({
      system: SYSTEM_PROMPT,
      userText,
      timeoutMs,
      modelOverride,
      role: null,
      thinkingDisabled: true,
      jsonMode: true,
      label: `fix_${ctx.sheet}_${ctx.addr}`,
    });
    const usage = getUsageStats();
    if (!result || typeof result !== 'object') {
      return { skipped: true, reason: 'invalid response', elapsedMs: Date.now() - start, tokens: usage };
    }
    if (!result.formula) {
      return { skipped: true, reason: result.explanation || 'no formula', elapsedMs: Date.now() - start, tokens: usage };
    }
    return {
      patch: { sheet: ctx.sheet, addr: ctx.addr, formula: String(result.formula).trim() },
      explanation: result.explanation || '',
      tokens: usage,
      elapsedMs: Date.now() - start,
    };
  } catch (e) {
    return { skipped: true, reason: e.message, elapsedMs: Date.now() - start };
  }
}

// A patch that references its own cell creates an Excel circular reference —
// the fixer occasionally invents OFFSET(self,...) patterns that look clever but
// break the workbook (observed: 47 self_reference criticals from one pass).
function patchIsSelfReferencing(patch) {
  const refs = extractCellRefs(patch.formula);
  return refs.some(r => (!r.sheet || r.sheet === patch.sheet) && r.addr === patch.addr);
}

// Apply patches to actions array. Returns count applied.
function applyPatches(actions, patches) {
  if (!patches || patches.length === 0) return 0;
  let applied = 0;
  for (const patch of patches) {
    if (!patch || !patch.sheet || !patch.addr || !patch.formula) continue;
    if (patchIsSelfReferencing(patch)) {
      logger.warn(`[TargetedFixer] Rejected self-referencing patch at ${patch.sheet}!${patch.addr}: ${patch.formula.slice(0, 80)}`);
      continue;
    }
    // Find existing setCellRange action that touches this address
    let found = false;
    for (const a of actions) {
      if (a.type !== 'setCellRange' || !a.cells) continue;
      if ((a.sheet || a.sheetName) !== patch.sheet) continue;
      if (a.cells[patch.addr]) {
        const cur = a.cells[patch.addr];
        if (typeof cur === 'object') {
          cur.formula = patch.formula;
          delete cur.value;
        } else {
          a.cells[patch.addr] = { formula: patch.formula };
        }
        applied++;
        found = true;
        break;
      }
    }
    if (!found) {
      // Append new action
      actions.push({ type: 'setCellRange', sheet: patch.sheet, cells: { [patch.addr]: { formula: patch.formula } } });
      applied++;
    }
  }
  return applied;
}

// Dispatch all bugs as parallel fixes. Caps concurrency to avoid rate limits.
async function dispatchTargetedFixes({ bugs, actions, modelOverride = null, maxConcurrency = 6, timeoutMs = 25000 }) {
  if (!Array.isArray(bugs) || bugs.length === 0) return { patches: [], applied: 0, skipped: 0, tokens: { promptTokens: 0, completionTokens: 0, calls: 0 } };
  const start = Date.now();

  // Dedup by location (avoid fixing the same cell twice)
  const seen = new Set();
  const dedupedBugs = [];
  for (const b of bugs) {
    if (!b || !b.location) continue;
    if (seen.has(b.location)) continue;
    seen.add(b.location);
    dedupedBugs.push(b);
  }
  // Cap to avoid runaway cost
  const MAX_FIXES = 40;
  const target = dedupedBugs.slice(0, MAX_FIXES);

  // Parallel pool
  const results = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= target.length) return;
      const r = await fixOneBug({ bug: target[idx], actions, modelOverride, timeoutMs });
      results.push(r);
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, target.length) }, () => worker()));

  const patches = results.filter(r => r.patch).map(r => r.patch);

  // Verify-then-keep, like a coding agent running tests after an edit:
  // snapshot the patched cells, apply, re-validate; any patch whose cell now
  // raises a NEW critical gets rolled back to the original formula/value.
  const { validateFormulas } = require('./formulaValidator');
  const preCriticals = new Set(
    validateFormulas(actions).filter(i => i.severity === 'critical').map(i => i.location)
  );
  const originals = new Map();
  for (const p of patches) {
    for (const a of actions) {
      if (a.type !== 'setCellRange' || !a.cells) continue;
      if ((a.sheet || a.sheetName) !== p.sheet) continue;
      if (a.cells[p.addr] !== undefined) {
        const cur = a.cells[p.addr];
        originals.set(`${p.sheet}!${p.addr}`, typeof cur === 'object' ? { ...cur } : { value: cur });
        break;
      }
    }
  }

  let applied = applyPatches(actions, patches);

  let reverted = 0;
  if (applied > 0) {
    const postCriticals = validateFormulas(actions).filter(i => i.severity === 'critical').map(i => i.location);
    const newCriticals = new Set(postCriticals.filter(l => !preCriticals.has(l)));
    if (newCriticals.size > 0) {
      for (const p of patches) {
        const loc = `${p.sheet}!${p.addr}`;
        if (!newCriticals.has(loc)) continue;
        const orig = originals.get(loc);
        for (const a of actions) {
          if (a.type !== 'setCellRange' || !a.cells) continue;
          if ((a.sheet || a.sheetName) !== p.sheet) continue;
          if (a.cells[p.addr] !== undefined) {
            a.cells[p.addr] = orig !== undefined ? orig : { value: 0 };
            reverted++;
            break;
          }
        }
      }
      if (reverted > 0) {
        applied -= reverted;
        logger.warn(`[TargetedFixer] Rolled back ${reverted} patches that introduced new critical issues`);
      }
    }
  }

  const skipped = results.filter(r => r.skipped).length;
  const tokens = results.reduce((acc, r) => {
    if (!r.tokens) return acc;
    return {
      promptTokens: acc.promptTokens + (r.tokens.promptTokens || 0),
      completionTokens: acc.completionTokens + (r.tokens.completionTokens || 0),
      calls: acc.calls + (r.tokens.calls || 0),
    };
  }, { promptTokens: 0, completionTokens: 0, calls: 0 });
  logger.info(`[TargetedFixer] ${target.length} bugs → ${applied} patches applied, ${skipped} skipped (${Date.now() - start}ms, ${tokens.calls} calls)`);
  return { patches, applied, skipped, tokens, elapsedMs: Date.now() - start };
}

module.exports = { dispatchTargetedFixes, fixOneBug, applyPatches, buildContextForBug };
