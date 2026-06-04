'use strict';

const fs = require('fs');
const path = require('path');
const { callLLM, resetUsageStats, getUsageStats } = require('../server/tools/llm');
const { listSkills, readSkill } = require('../server/skills/loader');
const logger = require('../server/utils/logger');

const PROMPTS_DIR = path.join(__dirname, 'prompts');

function loadPrompt(name) {
  return fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf-8');
}

function selectSkills(objective) {
  const skills = listSkills();
  const lower = objective.toLowerCase();
  const matches = [];

  const triggers = {
    'dcf-model': ['dcf', 'discounted cash flow', 'valutazione', 'wacc', 'terminal value', 'npv'],
    'lbo-model': ['lbo', 'leveraged buyout', 'private equity', 'debt schedule'],
    'business-plan': ['business plan', 'startup', 'p&l', 'profit and loss', 'fast-food', 'catena', 'ricavi'],
    'real-estate-dev-italy': ['immobiliare', 'vairano', 'costruzione', 'piano', 'mq', 'progetto immobiliare', 'sviluppo immobiliare', 'residenziale'],
    'three-statement': ['3-statement', 'three statement', 'balance sheet', 'stato patrimoniale'],
    'comps-analysis': ['comps', 'comparables', 'multiples', 'trading'],
    'wacc-model': ['wacc', 'weighted average cost', 'capm', 'beta'],
    'formatting-finance': ['formattazione', 'formatting', 'ib grade'],
    'audit-xls': ['audit', 'check', 'verify', 'errori', 'error check'],
  };

  for (const skill of skills) {
    const words = triggers[skill.name] || [];
    const triggered = words.some(w => lower.includes(w));
    if (triggered) matches.push(skill.name);
  }

  return matches.slice(0, 3);
}

async function planWorkbook(objective, context, options = {}) {
  const { callLLMFn = callLLM, modelOverride = null } = options;
  const systemPrompt = loadPrompt('planner');
  const skillNames = selectSkills(objective);
  let skillContent = '';

  if (skillNames.length > 0) {
    const loaded = skillNames.map(n => readSkill(n)).filter(Boolean);
    skillContent = loaded.map(s =>
      `### Domain Skill: ${s.name}\n${(s.content || '').slice(0, 3000)}`
    ).join('\n\n');
  }

  const contextStr = buildContextSummary(context);
  const userPrompt = [
    '## User Objective',
    objective,
    '',
    '## Workbook Context',
    contextStr || '(empty workbook — build from scratch)',
    '',
    skillContent ? '## Domain Knowledge' : '',
    skillContent,
    '',
    'Generate a detailed CODE PLAN for building this workbook. Be specific about formulas, density, formatting, and cross-sheet dependencies.',
  ].filter(Boolean).join('\n');

  resetUsageStats();
  const start = Date.now();

  const result = await callLLMFn({
    system: systemPrompt,
    userText: userPrompt,
    timeoutMs: 120000,
    modelOverride,
    role: null,
    thinkingDisabled: true,
    jsonMode: true,
    label: 'codefirst_planner',
  });

  const plan = result;
  const usage = getUsageStats();

  logger.info(`[Enhanced] Planner done (${Date.now() - start}ms): ${plan?.sections?.length || 0} sections, ${plan?.estimated_cells || '?'} cells`);

  return {
    plan,
    planTokens: usage,
    planTimeMs: Date.now() - start,
    skillNames,
  };
}

async function generateWithPlan(objective, context, plan, options = {}) {
  const { callLLMFn = callLLM, modelOverride = null, sliceFocus = null, timeoutMs = 180000, label = 'codefirst_codegen_v3', researchContext = null } = options;

  const systemPrompt = loadPrompt('codegen-v3');
  const planSummary = JSON.stringify(plan, null, 2);
  const contextStr = buildContextSummary(context);

  const userPrompt = [
    '## User Objective',
    objective,
    '',
    '## Workbook Context',
    contextStr || '(empty workbook — build from scratch)',
    '',
    '## CODE PLAN (follow this structure exactly)',
    '```json',
    planSummary,
    '```',
    '',
    sliceFocus ? `## FOCUS — Generate ONLY the "${sliceFocus}" sheet section. Other sheets exist or will be generated separately; reference them with cross-sheet refs as needed.` : '',
    '',
    '## Instructions',
    'Generate JSON actions that implement this plan. Follow the formatting conventions specified in the plan.',
    'CRITICAL: Every computed value MUST use "formula", never hardcoded "value".',
    'CRITICAL: Match the density specified in the plan. If plan says 60 months, generate ALL 60.',
    'CRITICAL: Apply formatting as specified per section (header style, input style, formula style).',
    'Return ONLY {"actions": [...]}',
  ].filter(Boolean).join('\n');

  resetUsageStats();
  const start = Date.now();

  try {
    const result = await callLLMFn({
      system: systemPrompt,
      userText: userPrompt,
      timeoutMs,
      modelOverride,
      role: null,
      thinkingDisabled: true,
      jsonMode: true,
      label,
    });

    let actions = null;
    let code = null;

    if (result && typeof result === 'object') {
      if (Array.isArray(result.actions)) {
        actions = result.actions;
      } else if (Array.isArray(result)) {
        actions = result;
      }
      if (result.code && typeof result.code === 'string') code = result.code;
    }

    if (!actions && result && typeof result === 'string') {
      try { const parsed = JSON.parse(result); actions = parsed.actions || parsed; } catch (_) {}
    }

    const usage = getUsageStats();

    logger.info(`[Enhanced] CodeGen done (${Date.now() - start}ms): ${actions ? actions.length : 0} actions`);

    return {
      actions,
      code,
      codeTokens: usage,
      codeTimeMs: Date.now() - start,
    };
  } catch (error) {
    logger.error(`[Enhanced] CodeGen failed: ${error.message}`);
    return { actions: null, error: error.message };
  }
}

function planComplexity(plan) {
  if (!plan?.sections) return { sections: 0, estCells: 0 };
  const sections = plan.sections.length;
  const estCells = Number(plan.estimated_cells) || sections * 30;
  return { sections, estCells };
}

function buildSlices(plan) {
  const sections = plan?.sections || [];
  const slices = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const sheet = s.sheet || 'Sheet1';
    const rawEst = Number(s.estimated_cells) || 0;
    const est = rawEst || (s.is_time_series && s.periods ? Math.min(s.periods * 8, 480) : 60);
    slices.push({
      id: `${sheet}_${i}`,
      label: s.title ? `${sheet} — ${s.title}` : sheet,
      sheet,
      section: s,
      estCells: est,
    });
  }
  return slices;
}

function countSetCellRangeCells(actions) {
  if (!Array.isArray(actions)) return 0;
  return actions.reduce((sum, a) =>
    sum + (a.type === 'setCellRange' && a.cells ? Object.keys(a.cells).length : 0), 0);
}

function detectSilentFailures(sliceResults, { threshold = 5 } = {}) {
  if (!Array.isArray(sliceResults) || sliceResults.length === 0) return [];
  const silentFails = [];
  for (const r of sliceResults) {
    if (!r || !Array.isArray(r.actions)) {
      silentFails.push(r);
      continue;
    }
    const dataCells = countSetCellRangeCells(r.actions);
    if (dataCells < threshold && r.actions.length < 3) {
      silentFails.push(r);
    }
  }
  return silentFails;
}

async function generateStepwise(objective, context, plan, options = {}) {
  const { modelOverride = null, onProgress = null, parallel = true, maxConcurrency = 12, validateSlice = null, researchContext = null } = options;
  const slices = buildSlices(plan);
  if (slices.length === 0) return { actions: [], codeTokens: { promptTokens: 0, completionTokens: 0, calls: 0 }, codeTimeMs: 0, sliceResults: [], stepwise: true };

  const allSheets = [...new Set(slices.map(s => s.sheet))];
  logger.info(`[Enhanced] Stepwise codegen: ${slices.length} slices across ${allSheets.length} sheets [${allSheets.join(', ')}]`);

  const createActions = allSheets.map(s => ({ type: 'createSheet', sheet: s }));
  const sheetCreated = new Set(allSheets);

  const totals = { promptTokens: 0, completionTokens: 0, calls: 0 };
  let totalMs = 0;

  async function runSlice(slice, idx) {
    if (onProgress) onProgress('generating', { message: `Building "${slice.label}" (${idx + 1}/${slices.length})...` });
    const subPlan = {
      sections: [slice.section],
      global_conventions: plan.global_conventions || {},
      model_type: plan.model_type,
      cross_sheet_deps: plan.cross_sheet_deps,
      estimated_cells: slice.estCells,
    };
    const isHeavyTimeSeries = slice.section.is_time_series && (slice.section.periods || 0) >= 24;
    const baseTimeout = slice.estCells > 400 || isHeavyTimeSeries ? 300000 : (slice.estCells > 200 ? 180000 : 120000);
    const exported = slice.section.exported_cells || [];
    const exportedNote = exported.length > 0 ? ` CRITICAL: This sheet MUST expose these cells for other sheets: ${exported.join(', ')}.` : '';
    const focusLine = `the "${slice.label}" section in sheet "${slice.sheet}"${slice.section.row_range ? ` rows ${slice.section.row_range}` : ''}. This section MUST contain at least ${slice.estCells} cells (formulas, values, and labels combined). Do not skip rows or summarize; emit every cell.${exportedNote}`;
    const subResult = await generateWithPlan(objective, context, subPlan, {
      modelOverride,
      sliceFocus: focusLine,
      timeoutMs: baseTimeout,
      label: `cf_slice_${slice.id}`,
      researchContext,
    });
    if (subResult.codeTokens) {
      totals.promptTokens += subResult.codeTokens.promptTokens || 0;
      totals.completionTokens += subResult.codeTokens.completionTokens || 0;
      totals.calls += subResult.codeTokens.calls || 0;
    }
    totalMs += subResult.codeTimeMs || 0;

    // Inline validation: if caller provided validateSlice, check for critical formula errors early
    let validatedActions = subResult.actions || [];
    if (validateSlice && validatedActions.length > 0) {
      try {
        const v = validateSlice(validatedActions);
        if (!v.valid) {
          logger.warn(`[Enhanced] Slice "${slice.label}" has ${v.criticalCount} critical formula issues. Retrying with validation feedback.`);
          const feedback = `CRITICAL FORMULA ERRORS detected in previous output for "${slice.label}": ${v.issues.map(i => `${i.location}: ${i.detail}`).join('; ')}. Fix these before emitting cells.`;
          const retryVal = await generateWithPlan(
            `${objective}\n\n${feedback}\n\nREMEMBER: This section MUST contain at least ${slice.estCells} cells.`,
            context, subPlan,
            { modelOverride, sliceFocus: focusLine, timeoutMs: baseTimeout, label: `cf_slice_${slice.id}_valfix`, researchContext }
          );
          if (retryVal.codeTokens) {
            totals.promptTokens += retryVal.codeTokens.promptTokens || 0;
            totals.completionTokens += retryVal.codeTokens.completionTokens || 0;
            totals.calls += retryVal.codeTokens.calls || 0;
          }
          totalMs += retryVal.codeTimeMs || 0;
          if (retryVal.actions && retryVal.actions.length > 0) {
            validatedActions = retryVal.actions;
          }
        }
      } catch (e) {
        logger.warn(`[Enhanced] validateSlice callback error: ${e.message}`);
      }
    }

    if (validatedActions.length > 0) {
      return { slice, actions: validatedActions, error: null };
    }

    logger.warn(`[Enhanced] Slice "${slice.label}" failed (${subResult.error}). Retrying with reduced density.`);
    const retry = await generateWithPlan(
      `${objective}\n\nNOTE: previous attempt timed out. For "${slice.label}" use only annual columns or split rows; keep output under 200 cells.`,
      context, subPlan,
      { modelOverride, sliceFocus: focusLine, timeoutMs: 180000, label: `cf_slice_${slice.id}_retry` }
    );
    if (retry.codeTokens) {
      totals.promptTokens += retry.codeTokens.promptTokens || 0;
      totals.completionTokens += retry.codeTokens.completionTokens || 0;
      totals.calls += retry.codeTokens.calls || 0;
    }
    totalMs += retry.codeTimeMs || 0;
    return { slice, actions: retry.actions || [], error: retry.error || subResult.error };
  }

  const sliceResults = [];
  if (parallel) {
    let cursor = 0;
    async function worker() {
      while (true) {
        const idx = cursor++;
        if (idx >= slices.length) return;
        try {
          sliceResults.push(await runSlice(slices[idx], idx));
        } catch (e) {
          sliceResults.push({ slice: slices[idx], actions: [], error: e.message });
        }
      }
    }
    const workers = Array.from({ length: Math.min(maxConcurrency, slices.length) }, () => worker());
    await Promise.all(workers);
  } else {
    for (let i = 0; i < slices.length; i++) {
      sliceResults.push(await runSlice(slices[i], i));
    }
  }

  // Post-codegen quality gate:
  // 1. Silent failures: slice with <5 data cells
  // 2. Low density: slice with <50% of estimated cells
  const SILENT_FAIL_THRESHOLD = 5;
  const LOW_DENSITY_RATIO = 0.5;
  const slicesToRetry = [];
  for (const r of sliceResults) {
    const cells = countSetCellRangeCells(r.actions);
    if (cells < SILENT_FAIL_THRESHOLD) {
      slicesToRetry.push({ r, slice: r.slice, reason: `silent (${cells} cells)` });
    } else if (r.slice.estCells > 20 && cells < r.slice.estCells * LOW_DENSITY_RATIO) {
      slicesToRetry.push({ r, slice: r.slice, reason: `low density (${cells}/${r.slice.estCells})` });
    }
  }
  if (slicesToRetry.length > 0) {
    logger.warn(`[Enhanced] ${slicesToRetry.length} slices need retry: ${slicesToRetry.map(s => s.slice.label + ' ' + s.reason).join('; ')}`);
    await Promise.all(slicesToRetry.map(async ({ r }) => {
      const slice = r.slice;
      const subPlan = {
        sections: [slice.section],
        global_conventions: plan.global_conventions || {},
        model_type: plan.model_type,
        estimated_cells: slice.estCells,
      };
      const repair = await generateWithPlan(
        `${objective}\n\nCRITICAL: previous attempt for "${slice.label}" produced too few cells (${countSetCellRangeCells(r.actions)} vs expected ${slice.estCells}). You MUST emit at least ${slice.estCells} setCellRange cells with formulas/values for this section. Do not skip rows, periods, or formulas.`,
        context, subPlan,
        {
          modelOverride,
          sliceFocus: `the "${slice.label}" section in sheet "${slice.sheet}". MUST contain at least ${slice.estCells} cells.`,
          timeoutMs: 180000,
          label: `cf_slice_${slice.id}_density_repair`,
          researchContext,
        }
      );
      if (repair.codeTokens) {
        totals.promptTokens += repair.codeTokens.promptTokens || 0;
        totals.completionTokens += repair.codeTokens.completionTokens || 0;
        totals.calls += repair.codeTokens.calls || 0;
      }
      totalMs += repair.codeTimeMs || 0;
      if (repair.actions && repair.actions.length > 0) {
        const repairCells = countSetCellRangeCells(repair.actions);
        if (repairCells >= slice.estCells * LOW_DENSITY_RATIO) {
          r.actions = repair.actions;
          r.repaired = true;
        }
      }
    }));
  }

  const allActions = [...createActions];
  for (const r of sliceResults) {
    for (const a of r.actions) {
      if (a.type === 'createSheet' && sheetCreated.has(a.sheet)) continue;
      if (a.type === 'createSheet') sheetCreated.add(a.sheet);
      allActions.push(a);
    }
  }

  const failedSlices = sliceResults.filter(r => !r.actions || r.actions.length === 0);
  const repairedCount = sliceResults.filter(r => r.repaired).length;
  logger.info(`[Enhanced] Stepwise done: ${sliceResults.length - failedSlices.length}/${sliceResults.length} slices OK${repairedCount ? `, ${repairedCount} repaired` : ''}, ${allActions.length} actions, ${totals.calls} LLM calls`);

  return {
    actions: allActions,
    codeTokens: totals,
    codeTimeMs: totalMs,
    sliceResults: sliceResults.map(r => ({ slice: r.slice.label, actionCount: r.actions.length, error: r.error })),
    stepwise: true,
  };
}

async function reviewCode(actionsOrCode, objective, plan, options = {}) {
  const { callLLMFn = callLLM, modelOverride = null } = options;
  const systemPrompt = loadPrompt('critic-v3');

  const actionsJson = Array.isArray(actionsOrCode)
    ? JSON.stringify(actionsOrCode).slice(0, 15000)
    : String(actionsOrCode).slice(0, 15000);

  const userPrompt = [
    '## User Objective',
    objective.slice(0, 2000),
    '',
    '## Code Plan',
    JSON.stringify(plan?.sections?.map(s => ({ sheet: s.sheet, title: s.title, key_formulas: s.key_formulas })) || {}, null, 2).slice(0, 3000),
    '',
    '## Generated Actions',
    '```json',
    actionsJson,
    '```',
    '',
    'Review these actions. Report issues. Return JSON.',
  ].join('\n');

  resetUsageStats();
  const start = Date.now();

  try {
    const result = await callLLMFn({
      system: systemPrompt,
      userText: userPrompt,
      timeoutMs: 60000,
      modelOverride,
      role: null,
      thinkingDisabled: true,
      jsonMode: true,
      label: 'codefirst_critic',
    });

    const usage = getUsageStats();

    logger.info(`[Enhanced] Critic done (${Date.now() - start}ms): approved=${result?.approved}, score=${result?.score}, issues=${result?.issues?.length || 0}`);

    return {
      review: result,
      reviewTokens: usage,
      reviewTimeMs: Date.now() - start,
    };
  } catch (error) {
    logger.warn(`[Enhanced] Critic failed (non-blocking): ${error.message}`);
    return { review: null };
  }
}

async function refineCode(actionsOrCode, objective, plan, criticIssues, options = {}) {
  const { callLLMFn = callLLM, modelOverride = null } = options;

  const systemPrompt = loadPrompt('codegen-v3');
  const planSummary = JSON.stringify(plan, null, 2).slice(0, 4000);
  const issuesSummary = criticIssues
    .filter(i => i.severity === 'critical' || i.severity === 'high')
    .map(i => `[${i.severity}] ${i.location}: ${i.description}\n  FIX: ${i.fix}`)
    .join('\n');

  const actionsJson = Array.isArray(actionsOrCode)
    ? JSON.stringify(actionsOrCode).slice(0, 8000)
    : String(actionsOrCode).slice(0, 8000);

  const userPrompt = [
    '## Original Objective',
    objective,
    '',
    '## Code Plan',
    '```json', planSummary, '```',
    '',
    '## Previous Actions (needs fixes)',
    '```json', actionsJson, '```',
    '',
    '## CRITIC ISSUES TO FIX',
    issuesSummary,
    '',
    '## Instructions',
    'Fix ALL the critical and high-severity issues listed above. Keep everything else the same.',
    'Return ONLY {"actions": [...]}',
  ].join('\n');

  resetUsageStats();
  const start = Date.now();

  try {
    const result = await callLLMFn({
      system: systemPrompt,
      userText: userPrompt,
      timeoutMs: 180000,
      modelOverride,
      role: null,
      thinkingDisabled: true,
      jsonMode: true,
      label: 'codefirst_refiner',
    });

    let actions = null;
    if (result && typeof result === 'object') {
      if (Array.isArray(result.actions)) actions = result.actions;
      else if (Array.isArray(result)) actions = result;
    }
    if (!actions && result && typeof result === 'string') {
      try { const parsed = JSON.parse(result); actions = parsed.actions || parsed; } catch (_) {}
    }

    const usage = getUsageStats();
    logger.info(`[Enhanced] Refiner done (${Date.now() - start}ms): ${actions ? actions.length : 0} actions`);

    return { actions, refinerTokens: usage, refinerTimeMs: Date.now() - start };
  } catch (error) {
    logger.warn(`[Enhanced] Refiner failed: ${error.message}`);
    return { actions: null };
  }
}

function actionsFromResult(actions) {
  if (!actions || !Array.isArray(actions)) return { actions: [], cellCount: 0 };
  const cellCount = actions.reduce((sum, a) => {
    if (a.type === 'setCellRange' && a.cells) return sum + Object.keys(a.cells).length;
    return sum;
  }, 0);
  return { actions, cellCount };
}

function looksLikeEdit(objective, context) {
  if (!context) return false;
  const sheets = context.workbookSheets || context.allSheets || (context.allSheetsData ? Object.keys(context.allSheetsData) : []);
  if (!sheets || sheets.length === 0) return false;
  if (!objective || typeof objective !== 'string') return false;
  const lo = objective.toLowerCase();
  // Skip if it looks like a "create from scratch" request even with context present.
  const createSignals = ['crea ', 'create ', 'genera ', 'build ', 'da zero', 'from scratch', 'nuovo foglio', 'new sheet'];
  if (createSignals.some(s => lo.includes(s))) return false;
  const editSignals = [
    'cambia', 'modifica', 'aggiorna', 'imposta', 'metti', 'porta',
    'change', 'update', ' set ', 'modify', 'adjust', 'increase', 'decrease',
    'invece di', 'al posto di', 'aumenta', 'diminuisci', 'riduci',
    'now change', 'ma ora', 'fai diventare', 'rendi ', 'sostituisci',
    'ora il', 'ora la', 'ora porta', 'ora cambia',
  ];
  // Word-boundary check so "set" doesn't match inside other words.
  return editSignals.some(s => lo.startsWith(s) || lo.includes(' ' + s) || lo.includes(s + ' '));
}

function buildEditContext(context) {
  if (!context) return '(no workbook context provided)';
  const parts = [];
  const sheets = context.sheets || [];
  if (context.workbookSheets) parts.push(`Sheets: ${context.workbookSheets.join(', ')}`);
  if (context.activeSheet) parts.push(`Active: ${context.activeSheet}`);
  for (const s of sheets.slice(0, 12)) {
    parts.push(`\n--- ${s.name} (${s.rowCount || '?'} × ${s.columnCount || '?'}) ---`);
    const preview = s.preview || [];
    const formulas = s.formulas || [];
    for (let r = 0; r < Math.min(preview.length, 30); r++) {
      const row = preview[r] || [];
      const frow = formulas[r] || [];
      const cells = [];
      for (let c = 0; c < Math.min(row.length, 12); c++) {
        const v = row[c];
        const f = frow[c];
        const colLetter = String.fromCharCode(65 + c);
        const addr = `${colLetter}${r + 1}`;
        if (f && String(f).startsWith('=')) cells.push(`${addr}=${f}`);
        else if (v !== '' && v !== null && v !== undefined) cells.push(`${addr}:${v}`);
      }
      if (cells.length > 0) parts.push(cells.join(' | '));
    }
  }
  return parts.join('\n');
}

async function editPipeline(objective, context, options = {}) {
  const { modelOverride = null, onProgress = null } = options;
  const totalStart = Date.now();

  if (onProgress) onProgress('editing', { message: 'Identificazione celle da modificare...' });
  const systemPrompt = loadPrompt('edit');
  const ctxStr = buildEditContext(context);

  const userPrompt = [
    '## User Instruction',
    objective,
    '',
    '## Workbook Context (existing values + formulas)',
    ctxStr,
    '',
    '## Task',
    'Emit setCellRange actions for ONLY the cells that need to change. Return {"actions":[...], "explanation":"..."} or {"actions":[], "question":"..."} if ambiguous.',
  ].join('\n');

  resetUsageStats();
  let result;
  try {
    result = await callLLM({
      system: systemPrompt,
      userText: userPrompt,
      timeoutMs: 45000,
      modelOverride,
      role: null,
      thinkingDisabled: true,
      jsonMode: true,
      label: 'codefirst_edit',
    });
  } catch (e) {
    return { status: 'failed', error: e.message, totalMs: Date.now() - totalStart };
  }

  const actions = Array.isArray(result?.actions) ? result.actions : [];
  const usage = getUsageStats();
  logger.info(`[Enhanced] Edit done (${Date.now() - totalStart}ms): ${actions.length} actions, "${result?.explanation || ''}"`);

  if (actions.length === 0 && result?.question) {
    return {
      status: 'clarification_needed',
      question: result.question,
      explanation: result.explanation || null,
      totalMs: Date.now() - totalStart,
      totalTokens: usage,
    };
  }

  const { sanitizeActions } = require('./actionSanitizer');
  const sanitized = sanitizeActions(actions);

  return {
    status: 'ok',
    mode: 'edit',
    actions: sanitized.actions,
    cellCount: sanitized.actions.reduce((s, a) => s + (a.cells ? Object.keys(a.cells).length : 0), 0),
    explanation: result?.explanation || null,
    totalMs: Date.now() - totalStart,
    totalTokens: usage,
    sanitizerStats: sanitized.stats,
  };
}

async function enhancedPipeline(objective, context = {}, options = {}) {
  const {
    modelOverride = null,
    skipCritic = true,
    onProgress = null,
    forceMode = null, // 'edit' | 'create' | null
  } = options;
  const { sanitizeActions } = require('./actionSanitizer');

  // Auto-route to edit mode when an existing workbook is present and the
  // instruction looks like an edit. Big speedup: single LLM call ~5-15s vs
  // full plan+codegen cycle ~60s+.
  const mode = forceMode || (looksLikeEdit(objective, context) ? 'edit' : 'create');
  if (mode === 'edit') {
    logger.info(`[Enhanced] Routing to edit mode: "${objective.slice(0, 80)}..."`);
    return editPipeline(objective, context, options);
  }

  const totalStart = Date.now();
  const pipeline = { phases: {} };

  // Phase 1: Plan
  if (onProgress) onProgress('planning', { message: 'Analyzing request and creating blueprint...' });
  const planResult = await planWorkbook(objective, context, { modelOverride });
  pipeline.phases.plan = planResult;

  if (!planResult.plan || !planResult.plan.sections) {
    logger.warn('[Enhanced] Plan failed or empty, falling back to direct codegen');
    const minimalPlan = { sections: [{ sheet: 'Sheet1', title: objective, key_formulas: [] }], global_conventions: {} };
    const directResult = await generateWithPlan(objective, context, minimalPlan, { modelOverride });
    if (directResult.actions && Array.isArray(directResult.actions)) {
      const sanitized = sanitizeActions(directResult.actions);
      const cellInfo = actionsFromResult(sanitized.actions);
      return {
        status: 'ok',
        actions: cellInfo.actions,
        cellCount: cellInfo.cellCount,
        plan: minimalPlan,
        review: null,
        pipeline: { phases: { plan: planResult, codegen: directResult }, mode: 'direct' },
        totalTokens: directResult.codeTokens,
        totalMs: Date.now() - totalStart,
        skillNames: [],
        sanitizerStats: sanitized.stats,
      };
    }
    return { status: 'failed', error: 'Code generation failed' };
  }

  // Phase 2: Code Generation. Stepwise per-sheet for big plans, single-shot for small.
  const cx = planComplexity(planResult.plan);
  const stepwiseOverride = options.stepwise; // null | true | false
  const useStepwise = stepwiseOverride === true
    || (stepwiseOverride !== false && (cx.sections > 4 || cx.estCells > 250));

  if (onProgress) onProgress('generating', { message: `Building ${cx.sections} sections${useStepwise ? ' (stepwise)' : ''}...` });

  let codeResult;
  if (useStepwise) {
    codeResult = await generateStepwise(objective, context, planResult.plan, {
      modelOverride,
      onProgress,
      parallel: options.parallelSlices !== false,
    });
  } else {
    codeResult = await generateWithPlan(objective, context, planResult.plan, { modelOverride });
  }
  pipeline.phases.codegen = codeResult;
  pipeline.codegenMode = useStepwise ? 'stepwise' : 'single-shot';

  if (!codeResult.actions || !Array.isArray(codeResult.actions) || codeResult.actions.length === 0) {
    return { status: 'failed', error: codeResult.error || 'Code generation failed', pipeline };
  }

  // Phase 3: Critic + Refine (disabled — unreliable on some models)
  if (!skipCritic) {
    if (onProgress) onProgress('reviewing', { message: 'Validating actions...' });
    const reviewResult = await reviewCode(codeResult.actions, objective, planResult.plan, { modelOverride });
    pipeline.phases.critic = reviewResult;

    const hasCritical = reviewResult.review && !reviewResult.review.approved
      && reviewResult.review.issues?.some(i => i.severity === 'critical');

    if (hasCritical && reviewResult.review.score < 40) {
      logger.warn(`[Enhanced] Critic found critical issues (score ${reviewResult.review.score}), refining...`);
      if (onProgress) onProgress('refining', { message: 'Fixing critical issues...' });

      const refined = await refineCode(codeResult.actions, objective, planResult.plan,
        reviewResult.review.issues, { modelOverride });
      pipeline.phases.refiner = refined;

      if (refined.actions && Array.isArray(refined.actions) && refined.actions.length >= codeResult.actions.length * 0.6) {
        codeResult.actions = refined.actions;
        logger.info(`[Enhanced] Refiner produced new actions (${refined.actions.length} total)`);
      } else {
        logger.warn(`[Enhanced] Refiner output too small (${refined.actions ? refined.actions.length : 0} vs ${codeResult.actions.length}), keeping original`);
      }
    } else if (reviewResult.review && !reviewResult.review.approved) {
      logger.info(`[Enhanced] Critic issues non-critical (score ${reviewResult.review.score}), skipping refiner`);
    }
  }

  // Phase 4: Sanitize actions (drop bad fillRange, bound whole-column targets, expand shorthand)
  const sanitized = sanitizeActions(codeResult.actions);
  if (sanitized.stats.dropped + sanitized.stats.expanded + sanitized.stats.bounded > 0) {
    logger.info(`[Enhanced] Sanitizer: dropped=${sanitized.stats.dropped} expanded=${sanitized.stats.expanded} bounded=${sanitized.stats.bounded} kept=${sanitized.stats.kept}`);
  }
  codeResult.actions = sanitized.actions;

  // Phase 5: Structural formula validation. Catches broken cross-sheet refs,
  // self-references, division-by-zero BEFORE Excel sees them.
  const { validateFormulas } = require('./formulaValidator');
  const validationIssues = validateFormulas(codeResult.actions, context);
  const criticalIssues = validationIssues.filter(i => i.severity === 'critical');
  if (validationIssues.length > 0) {
    logger.info(`[Enhanced] Validator: ${criticalIssues.length} critical, ${validationIssues.filter(i => i.severity === 'high').length} high, ${validationIssues.filter(i => i.severity === 'medium').length} medium`);
  }
  pipeline.validation = { issueCount: validationIssues.length, critical: criticalIssues.length, issues: validationIssues.slice(0, 20) };

  const cellInfo = actionsFromResult(codeResult.actions);
  pipeline.phases.execution = { ...cellInfo, executionMs: 0 };
  pipeline.sanitizer = sanitized.stats;

  const totalMs = Date.now() - totalStart;
  const totalTokens = {
    promptTokens: (planResult.planTokens?.promptTokens || 0) + (codeResult.codeTokens?.promptTokens || 0) + (pipeline.phases.critic?.reviewTokens?.promptTokens || 0),
    completionTokens: (planResult.planTokens?.completionTokens || 0) + (codeResult.codeTokens?.completionTokens || 0) + (pipeline.phases.critic?.reviewTokens?.completionTokens || 0),
    calls: (planResult.planTokens?.calls || 0) + (codeResult.codeTokens?.calls || 0) + (pipeline.phases.critic?.reviewTokens?.calls || 0),
  };

  logger.info(`[Enhanced] Pipeline complete (${totalMs}ms): ${cellInfo.cellCount} cells, ${totalTokens.promptTokens + totalTokens.completionTokens} tokens, ${totalTokens.calls} LLM calls`);

  return {
    status: 'ok',
    code: codeResult.code || null,
    codeLength: codeResult.code ? codeResult.code.length : 0,
    cellCount: cellInfo.cellCount,
    actions: cellInfo.actions,
    plan: planResult.plan,
    review: pipeline.phases.critic?.review || null,
    pipeline,
    totalTokens,
    totalMs,
    skillNames: planResult.skillNames,
  };
}

function buildContextSummary(context) {
  if (!context || Object.keys(context).length === 0) return '';
  const parts = [];
  const sheets = Array.isArray(context.workbookSheets) ? context.workbookSheets
    : (Array.isArray(context.allSheets) ? context.allSheets
      : (context.allSheetsData ? Object.keys(context.allSheetsData) : []));
  if (sheets.length > 0) {
    parts.push(`Existing sheets: ${sheets.slice(0, 20).join(', ')}`);
    if (context.activeSheet) parts.push(`Active sheet: ${context.activeSheet}`);
    if (context.sheets) {
      for (const s of context.sheets.slice(0, 8)) {
        parts.push(`  ${s.name}: ${s.usedRange?.rowCount || '?'} rows × ${s.usedRange?.columnCount || '?'} cols`);
      }
    }
  }
  if (context._researchContext) {
    parts.push('\n=== RESEARCH CONTEXT ===\n' + String(context._researchContext).slice(0, 6000));
  }
  return parts.join('\n');
}

module.exports = { enhancedPipeline, editPipeline, looksLikeEdit, planWorkbook, generateWithPlan, generateStepwise, reviewCode, selectSkills, detectSilentFailures, countSetCellRangeCells, buildSlices, buildContextSummary, actionsFromResult };
