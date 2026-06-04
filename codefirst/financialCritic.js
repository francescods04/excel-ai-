'use strict';

const { callLLM, resetUsageStats, getUsageStats } = require('../server/tools/llm');
const logger = require('../server/utils/logger');
const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, 'prompts');

function loadPrompt(name) {
  return fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf-8');
}

/* ---------- Domain-agnostic financial sanity checks ---------- */

/* ---------- Helpers ---------- */

function isInputCell(spec) {
  if (!spec || typeof spec !== 'object') return false;
  const fmt = spec.cellStyles || {};
  // Known input styling
  if (fmt.backgroundColor === '#FFF2CC' || fmt.backgroundColor === '#E6F2FF' || fmt.fontColor === '#0000FF') return true;
  // No formula and no numberFormat (raw numbers are likely inputs in assumptions/drivers)
  if (spec.formula === undefined && spec.value !== undefined && !fmt.numberFormat) return true;
  return false;
}

function isAssumptionSheet(sheetName) {
  if (!sheetName) return false;
  return /assumptions?|drivers?|inputs?|params?|config/i.test(String(sheetName));
}

const FINANCIAL_SANITY_RULES = [
  {
    id: 'margin_bounds',
    description: 'Margins must be between -200% and +200% (absolute values for ratios)',
    check: (actions) => {
      const issues = [];
      for (const a of actions) {
        if (a.type !== 'setCellRange' || !a.cells) continue;
        const sh = a.sheet || a.sheetName || '';
        for (const [addr, spec] of Object.entries(a.cells)) {
          const v = spec?.value;
          if (typeof v === 'number' && Math.abs(v) > 2) {
            const fmt = spec?.cellStyles?.numberFormat || '';
            if (/%/.test(fmt) && Math.abs(v) > 2) {
              issues.push({
                severity: 'high',
                kind: 'suspicious_margin',
                location: `${sh}!${addr}`,
                detail: `numberFormat is percent but value ${v} is >2 (200%). Probably decimal vs percentage confusion.`,
              });
            }
          }
        }
      }
      return issues;
    },
  },
  {
    id: 'no_value_for_computed',
    description: 'Computed financial metrics must use formula, not hardcoded value',
    check: (actions) => {
      const issues = [];
      for (const a of actions) {
        if (a.type !== 'setCellRange' || !a.cells) continue;
        const sh = a.sheet || a.sheetName || '';
        for (const [addr, spec] of Object.entries(a.cells)) {
          if (spec?.value !== undefined && spec?.formula === undefined && typeof spec.value === 'number') {
            // SKIP if this looks like an input cell (styled or on assumption sheet)
            if (isInputCell(spec) || isAssumptionSheet(sh)) continue;
            // SKIP if the cell is in a clear label row (e.g. A1, A2 label columns)
            const col = addr.replace(/\d+/, '');
            if (col === 'A' || col === 'B') continue; // likely labels
            // SKIP if the value is clearly a year (1900-2100) — years are labels/headers, not computed metrics
            if (Number.isInteger(spec.value) && spec.value >= 1900 && spec.value <= 2100) continue;
            // SKIP if the value is a small integer 1-10 — these are almost always period numbers / headers
            if (Number.isInteger(spec.value) && spec.value >= 1 && spec.value <= 10) continue;
            issues.push({
              severity: 'medium',
              kind: 'possible_hardcoded_computed',
              location: `${sh}!${addr}`,
              detail: `numeric value ${spec.value} without formula and without input styling. If computed, use formula.`,
            });
          }
        }
      }
      return issues;
    },
  },
  {
    id: 'cross_sheet_refs_exist',
    description: 'Cross-sheet references in formulas must reference existing sheets',
    check: (actions) => {
      const sheets = new Set();
      for (const a of actions) {
        if (a.type === 'createSheet' && a.sheet) sheets.add(a.sheet);
        if (a.sheet) sheets.add(a.sheet);
      }
      const issues = [];
      const xsheetRe = /(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))!/g;
      for (const a of actions) {
        if (a.type !== 'setCellRange' || !a.cells) continue;
        for (const [addr, spec] of Object.entries(a.cells)) {
          const formula = spec?.formula || (typeof spec?.value === 'string' && spec.value.startsWith('=') ? spec.value : null);
          if (!formula) continue;
          let m;
          while ((m = xsheetRe.exec(formula)) !== null) {
            const sheet = m[1] || m[2];
            if (!sheets.has(sheet)) {
              issues.push({
                severity: 'critical',
                kind: 'missing_sheet_ref',
                location: `${a.sheet || ''}!${addr}`,
                detail: `formula references sheet "${sheet}" which is never created`,
              });
            }
          }
        }
      }
      return issues;
    },
  },
  {
    id: 'time_series_consistency',
    description: 'Time series formulas should reference prior period, not hardcode',
    check: (actions) => {
      // This is a structural heuristic: if we see B2,C2,D2,E2,F2 with formulas
      // and B2 is a base year while C2-F2 should chain, we flag if any gap.
      // Simplified: just ensure no identical scalar values across >3 consecutive
      // cells in the same row that aren't labeled as inputs.
      const issues = [];
      const rowGroups = new Map(); // sheet!row -> { col: value|formula }
      for (const a of actions) {
        if (a.type !== 'setCellRange' || !a.cells) continue;
        const sh = a.sheet || a.sheetName || 'Sheet1';
        for (const [addr, spec] of Object.entries(a.cells)) {
          const bare = addr.includes('!') ? addr.split('!').pop() : addr;
          const m = /^([A-Z]+)(\d+)$/i.exec(bare);
          if (!m) continue;
          const col = m[1];
          const row = m[2];
          const key = `${sh}!${row}`;
          if (!rowGroups.has(key)) rowGroups.set(key, []);
          rowGroups.get(key).push({ col, spec });
        }
      }
      for (const [key, cells] of rowGroups) {
        // Sort by column
        cells.sort((a, b) => {
          const an = colToNum(a.col);
          const bn = colToNum(b.col);
          return an - bn;
        });
        // Check for 3+ identical hardcoded numeric values in a row
        const numericRuns = [];
        let runStart = null;
        let runVal = null;
        for (let i = 0; i < cells.length; i++) {
          const { spec } = cells[i];
          const isHardcoded = spec?.value !== undefined && spec?.formula === undefined && typeof spec.value === 'number';
          if (isHardcoded) {
            if (runVal === null || Math.abs(spec.value - runVal) < 0.0001) {
              if (runStart === null) runStart = i;
              runVal = spec.value;
            } else {
              if (runStart !== null && i - runStart >= 3) {
                numericRuns.push({ start: runStart, end: i - 1, val: runVal });
              }
              runStart = i;
              runVal = spec.value;
            }
          } else {
            if (runStart !== null && i - runStart >= 3) {
              numericRuns.push({ start: runStart, end: i - 1, val: runVal });
            }
            runStart = null;
            runVal = null;
          }
        }
        if (runStart !== null && cells.length - runStart >= 3) {
          numericRuns.push({ start: runStart, end: cells.length - 1, val: runVal });
        }
        for (const run of numericRuns) {
          issues.push({
            severity: 'high',
            kind: 'stale_time_series',
            location: `${key} cols ${cells[run.start].col}-${cells[run.end].col}`,
            detail: `${run.end - run.start + 1} consecutive cells have the identical hardcoded value ${run.val}. Time series should use formulas that reference prior periods or assumptions.`,
          });
        }
      }
      return issues;
    },
  },
];

function colToNum(col) {
  let n = 0;
  for (const ch of String(col).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/* ---------- Structural validation (fast, deterministic) ---------- */

function structuralValidation(actions) {
  const issues = [];
  for (const rule of FINANCIAL_SANITY_RULES) {
    try {
      const found = rule.check(actions);
      issues.push(...found);
    } catch (e) {
      logger.warn(`[FinancialCritic] Rule ${rule.id} crashed: ${e.message}`);
    }
  }
  return issues;
}

/* ---------- LLM-based deep critic ---------- */

async function deepCritic(actions, objective, plan, researchContext, options = {}) {
  const { callLLMFn = callLLM, modelOverride = null, timeoutMs = 120000 } = options;
  const systemPrompt = loadPrompt('deep-critic');

  // Build a focused action snippet: only include sheets that have structural issues
  // (if we know them) to reduce context size and improve focus.
  const structuralIssues = options.structuralIssues || [];
  const problematicSheets = new Set();
  for (const issue of structuralIssues) {
    const loc = issue.location || '';
    if (loc.includes('!')) problematicSheets.add(loc.split('!')[0]);
  }

  let actionsJson;
  if (problematicSheets.size > 0 && problematicSheets.size < (plan?.sections?.length || 999)) {
    // Focused: only problematic sheets + assumption sheets (for context)
    const focused = actions.filter(a => {
      const sh = a.sheet || a.sheetName || '';
      return problematicSheets.has(sh) || isAssumptionSheet(sh) || a.type === 'createSheet';
    });
    actionsJson = JSON.stringify(focused).slice(0, 12000);
  } else {
    actionsJson = JSON.stringify(actions).slice(0, 12000);
  }

  const planSummary = JSON.stringify(plan?.sections?.map(s => ({
    sheet: s.sheet, title: s.title, key_formulas: s.key_formulas,
  })) || []).slice(0, 3000);

  const userPrompt = [
    '## User Objective',
    objective.slice(0, 2000),
    '',
    '## Research Context',
    researchContext?.promptBlock || '(no research context)',
    '',
    '## Plan Summary',
    planSummary,
    '',
    '## Generated Actions (focused on problematic sheets)',
    '```json',
    actionsJson,
    '```',
    '',
    'Review thoroughly. Use the research context to verify that assumptions and projections are grounded in the real data. Return JSON review.',
  ].join('\n');

  resetUsageStats();
  const start = Date.now();

  try {
    const result = await callLLMFn({
      system: systemPrompt,
      userText: userPrompt,
      timeoutMs,
      modelOverride,
      role: 'auditor',
      thinkingDisabled: false,
      jsonMode: true,
      label: 'codefirst_deep_critic',
    });

    const usage = getUsageStats();
    logger.info(`[DeepCritic] Done (${Date.now() - start}ms): approved=${result?.approved}, score=${result?.score}, issues=${result?.issues?.length || 0}`);

    return {
      review: result,
      deepCriticTokens: usage,
      deepCriticTimeMs: Date.now() - start,
    };
  } catch (error) {
    logger.warn(`[DeepCritic] Failed: ${error.message}`);
    return { review: null };
  }
}

/* ---------- Orchestrator ---------- */

async function runCritic(actions, objective, plan, researchContext, options = {}) {
  const { skipStructural = false, structuralIssues: providedStructural = null } = options;

  // Layer 1: fast structural checks (skip if caller already ran them)
  let structuralIssues = providedStructural;
  if (!skipStructural || !structuralIssues) {
    structuralIssues = structuralValidation(actions);
  }
  if (structuralIssues.length > 0) {
    logger.info(`[Critic] Structural issues: ${structuralIssues.length}`);
  }

  // Layer 2: LLM deep critic
  const deep = await deepCritic(actions, objective, plan, researchContext, options);

  const allIssues = [
    ...structuralIssues.map(i => ({ ...i, source: 'structural' })),
    ...(deep.review?.issues || []).map(i => ({ ...i, source: 'llm' })),
  ];

  // Weighted scoring: critical = -15, high = -8, medium = -3, low = -1
  const severityWeight = { critical: 15, high: 8, medium: 3, low: 1 };
  let penalty = 0;
  for (const issue of allIssues) {
    penalty += severityWeight[issue.severity] || 1;
  }
  // Base score from LLM if available, else compute from issues
  let score = deep.review?.score;
  if (score === undefined || score === null) {
    score = Math.max(0, 100 - penalty);
  } else {
    // Blend LLM score with structural penalty (LLM may miss structural issues)
    const structuralPenalty = structuralIssues.reduce((sum, i) => sum + (severityWeight[i.severity] || 1), 0);
    score = Math.max(0, Math.min(100, score - structuralPenalty * 0.5));
  }

  const criticalCount = structuralIssues.filter(i => i.severity === 'critical').length +
    (deep.review?.issues || []).filter(i => i.severity === 'critical').length;
  const approved = (deep.review?.approved || score >= 80) && criticalCount === 0;

  return {
    approved,
    score,
    issues: allIssues,
    structuralIssues,
    deepReview: deep.review,
    tokens: deep.deepCriticTokens,
    timeMs: deep.deepCriticTimeMs,
  };
}

module.exports = {
  runCritic,
  structuralValidation,
  deepCritic,
};
