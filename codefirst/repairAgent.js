'use strict';

const { callLLM, resetUsageStats, getUsageStats } = require('../server/tools/llm');
const logger = require('../server/utils/logger');
const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, 'prompts');

function loadPrompt(name) {
  return fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf-8');
}

/**
 * Repair Agent: receives a set of critic issues and the current action set,
 * and generates PATCH actions that fix ONLY the reported issues.
 *
 * Design principle: NEVER rewrite the whole model. Only patch the broken cells.
 */
async function repairActions(actions, issues, objective, plan, researchContext, options = {}) {
  const { callLLMFn = callLLM, modelOverride = null, timeoutMs = 120000 } = options;
  const systemPrompt = loadPrompt('repairer');

  // Group issues by severity and deduplicate by location
  const issueMap = new Map();
  for (const issue of issues) {
    const key = `${issue.location || issue.sheet || 'unknown'}|${issue.kind || issue.category || 'issue'}`;
    if (!issueMap.has(key)) issueMap.set(key, issue);
  }
  const uniqueIssues = Array.from(issueMap.values());

  // Sort: critical first, then high, then others
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  uniqueIssues.sort((a, b) => (severityOrder[a.severity] || 99) - (severityOrder[b.severity] || 99));

  // NEW: group issues by sheet for better repairer focus
  const issuesBySheet = new Map();
  for (const issue of uniqueIssues) {
    const sheet = (issue.location && issue.location.includes('!')) ? issue.location.split('!')[0] : (issue.sheet || 'unknown');
    if (!issuesBySheet.has(sheet)) issuesBySheet.set(sheet, []);
    issuesBySheet.get(sheet).push(issue);
  }

  // Extract the relevant subset of actions for each issue to minimize context
  // Extract specific cells mentioned in issues (e.g. "Sheet!B5" or "Sheet!B2:B10")
  const affectedCells = new Map(); // sheet -> Set of cell addrs
  const affectedSheets = new Set();
  for (const issue of uniqueIssues) {
    const loc = issue.location || (issue.sheet && issue.target ? `${issue.sheet}!${issue.target}` : '');
    if (!loc) continue;
    if (loc.includes('!')) {
      const [sh, addr] = loc.split('!');
      affectedSheets.add(sh);
      if (!affectedCells.has(sh)) affectedCells.set(sh, new Set());
      // If addr looks like a range, expand it (simple: just add start and end)
      if (addr && addr.includes(':')) {
        affectedCells.get(sh).add(addr.split(':')[0].toUpperCase());
        affectedCells.get(sh).add(addr.split(':')[1].toUpperCase());
      } else if (addr) {
        affectedCells.get(sh).add(addr.toUpperCase());
      }
    } else {
      affectedSheets.add(loc);
    }
  }

  // Build focused snippet: only cells directly referenced by issues + a few neighbors
  const snippetActions = [];
  for (const a of actions) {
    if (a.type === 'createSheet') {
      snippetActions.push(a);
      continue;
    }
    const sh = a.sheet || a.sheetName;
    if (!affectedSheets.has(sh)) continue;
    if (a.type === 'setCellRange' && a.cells) {
      const wanted = affectedCells.get(sh);
      if (!wanted || wanted.size === 0) {
        // No specific cells known — include up to 30 cells from this sheet as context
        const entries = Object.entries(a.cells).slice(0, 30);
        if (entries.length > 0) {
          snippetActions.push({ type: 'setCellRange', sheet: sh, cells: Object.fromEntries(entries) });
        }
      } else {
        // Include only wanted cells
        const filtered = {};
        for (const [addr, spec] of Object.entries(a.cells)) {
          const bare = addr.toUpperCase();
          if (wanted.has(bare)) filtered[addr] = spec;
        }
        if (Object.keys(filtered).length > 0) {
          snippetActions.push({ type: 'setCellRange', sheet: sh, cells: filtered });
        }
      }
    }
  }

  const actionsJson = JSON.stringify(snippetActions).slice(0, 12000);
  const issuesJson = JSON.stringify(uniqueIssues.slice(0, 10)).slice(0, 8000);

  const userPrompt = [
    '## User Objective',
    objective.slice(0, 1500),
    '',
    '## Research Context',
    researchContext?.promptBlock || '(no research context)',
    '',
    '## Plan Summary',
    JSON.stringify(plan?.sections?.map(s => ({ sheet: s.sheet, title: s.title })) || []).slice(0, 2000),
    '',
    '## Issues to Fix (prioritize CRITICAL, HIGH, and MEDIUM)',
    '```json',
    issuesJson,
    '```',
    '',
    '## Relevant Current Actions (affected sheets only)',
    '```json',
    actionsJson,
    '```',
    '',
    '## Instructions',
    'Generate ONLY patch actions (setCellRange, setCellFormat, setNotes) that fix the reported issues.',
    '- Do NOT recreate sheets.',
    '- Do NOT rewrite cells that are not mentioned in the issues.',
    '- If a formula is wrong, emit a setCellRange with the corrected formula for that exact cell.',
    '- If a numberFormat is missing, emit a setCellFormat for the correct range.',
    '- If a hardcoded value should be a formula, emit a setCellRange with the formula.',
    '- Return {"actions": [...]} with ONLY the patch actions.',
  ].join('\n');

  resetUsageStats();
  const start = Date.now();

  try {
    const result = await callLLMFn({
      system: systemPrompt,
      userText: userPrompt,
      timeoutMs,
      modelOverride,
      role: 'builder_hard',
      thinkingDisabled: false,
      jsonMode: true,
      label: 'codefirst_repairer',
    });

    let patchActions = [];
    if (result && Array.isArray(result.actions)) {
      patchActions = result.actions;
    } else if (Array.isArray(result)) {
      patchActions = result;
    }

    const usage = getUsageStats();
    logger.info(`[Repairer] Done (${Date.now() - start}ms): ${patchActions.length} patch actions`);

    return {
      patchActions,
      repairTokens: usage,
      repairTimeMs: Date.now() - start,
      issuesFixed: uniqueIssues.length,
    };
  } catch (error) {
    logger.error(`[Repairer] Failed: ${error.message}`);
    return { patchActions: [], repairTokens: { promptTokens: 0, completionTokens: 0, calls: 0 }, repairTimeMs: Date.now() - start };
  }
}

/**
 * Apply patches to the base action set. Patch cells override base cells.
 */
function applyPatches(baseActions, patchActions) {
  if (!patchActions || patchActions.length === 0) return baseActions;

  // Clone base
  const merged = JSON.parse(JSON.stringify(baseActions));

  // Index base setCellRange by sheet+addr for fast override
  const cellIndex = new Map(); // "sheet!addr" -> { actionIdx, addr }
  for (let i = 0; i < merged.length; i++) {
    const a = merged[i];
    if (a.type !== 'setCellRange' || !a.cells) continue;
    const sh = a.sheet || a.sheetName || 'Sheet1';
    for (const addr of Object.keys(a.cells)) {
      cellIndex.set(`${sh}!${addr}`, { actionIdx: i, addr });
    }
  }

  for (const patch of patchActions) {
    if (patch.type === 'setCellRange' && patch.cells) {
      const sh = patch.sheet || patch.sheetName || 'Sheet1';
      for (const [addr, spec] of Object.entries(patch.cells)) {
        const key = `${sh}!${addr}`;
        if (cellIndex.has(key)) {
          const { actionIdx } = cellIndex.get(key);
          merged[actionIdx].cells[addr] = spec;
        } else {
          // Cell not in base — need to add it. Find or create an action for this sheet
          let targetAction = merged.find(a => a.type === 'setCellRange' && (a.sheet || a.sheetName) === sh);
          if (!targetAction) {
            targetAction = { type: 'setCellRange', sheet: sh, cells: {} };
            merged.push(targetAction);
          }
          targetAction.cells[addr] = spec;
          cellIndex.set(key, { actionIdx: merged.indexOf(targetAction), addr });
        }
      }
    } else {
      // Non-setCellRange patches appended as-is
      merged.push(patch);
    }
  }

  return merged;
}

module.exports = {
  repairActions,
  applyPatches,
};
