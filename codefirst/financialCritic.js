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

const FINANCIAL_SANITY_RULES = [
  {
    id: 'margin_bounds',
    description: 'Margins must be between -200% and +200% (absolute values for ratios)',
    check: (actions) => {
      const issues = [];
      for (const a of actions) {
        if (a.type !== 'setCellRange' || !a.cells) continue;
        for (const [addr, spec] of Object.entries(a.cells)) {
          const v = spec?.value;
          if (typeof v === 'number' && Math.abs(v) > 2) {
            // Heuristic: if a cell looks like a percentage margin but is >200%
            // and the label contains margin keywords
            // We can't know the label here, so we flag suspiciously large numbers
            // in cells that also have percent format
            const fmt = spec?.cellStyles?.numberFormat || '';
            if (/%/.test(fmt) && Math.abs(v) > 2) {
              issues.push({
                severity: 'high',
                kind: 'suspicious_margin',
                location: `${a.sheet || ''}!${addr}`,
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
      const computedLabels = /(ebitda|ebit|utile|profit|loss|cash flow|wacc|npv|irr|value|debt|equity|margin|return|yield|ratio|coverage|turnover)/i;
      for (const a of actions) {
        if (a.type !== 'setCellRange' || !a.cells) continue;
        for (const [addr, spec] of Object.entries(a.cells)) {
          if (spec?.value !== undefined && spec?.formula === undefined && typeof spec.value === 'number') {
            // Try to infer if this is a computed cell from surrounding labels
            // Since we don't have labels here, we'll flag ALL numeric values
            // that aren't in a known input-style cell
            const fmt = spec?.cellStyles || {};
            const isInputStyle = fmt.backgroundColor === '#FFF2CC' || fmt.backgroundColor === '#E6F2FF' || fmt.fontColor === '#0000FF';
            if (!isInputStyle) {
              issues.push({
                severity: 'medium',
                kind: 'possible_hardcoded_computed',
                location: `${a.sheet || ''}!${addr}`,
                detail: `numeric value ${spec.value} without formula and without input styling. If computed, use formula.`,
              });
            }
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
  const { callLLMFn = callLLM, modelOverride = null } = options;
  const systemPrompt = loadPrompt('deep-critic');

  const actionsJson = JSON.stringify(actions).slice(0, 12000);
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
    '## Generated Actions (first 12K chars)',
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
      timeoutMs: 120000,
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
  // Layer 1: fast structural checks
  const structuralIssues = structuralValidation(actions);
  if (structuralIssues.length > 0) {
    logger.info(`[Critic] Structural issues: ${structuralIssues.length}`);
  }

  // Layer 2: LLM deep critic
  const deep = await deepCritic(actions, objective, plan, researchContext, options);

  const allIssues = [
    ...structuralIssues.map(i => ({ ...i, source: 'structural' })),
    ...(deep.review?.issues || []).map(i => ({ ...i, source: 'llm' })),
  ];

  const score = deep.review?.score || (allIssues.length === 0 ? 85 : Math.max(0, 85 - allIssues.length * 5));
  const approved = (deep.review?.approved && structuralIssues.filter(i => i.severity === 'critical').length === 0)
    || (score >= 80 && structuralIssues.filter(i => i.severity === 'critical').length === 0);

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
