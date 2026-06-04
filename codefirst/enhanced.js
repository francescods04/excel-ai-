'use strict';

const fs = require('fs');
const path = require('path');
const { callLLM, resetUsageStats, getUsageStats } = require('../server/tools/llm');
const { executeCode } = require('./bridge');
const { generateCode } = require('./codegen');
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
  const { callLLMFn = callLLM, modelOverride = null } = options;

  const systemPrompt = loadPrompt('codegen-v2');
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
    '## Instructions',
    'Write Python code using excel_builder that implements this plan. Follow the formatting conventions specified in the plan.',
    'CRITICAL: Every computed value MUST be a formula. Never hardcode Python calculations.',
    'CRITICAL: Match the density specified in the plan. If plan says 60 months, generate ALL 60.',
    'CRITICAL: Apply formatting as specified per section (header style, input style, formula style).',
    'Return ONLY {"code": "..."}',
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
      label: 'codefirst_codegen_v2',
    });

    let code = null;
    if (result && typeof result === 'object') {
      if (result.code && typeof result.code === 'string') {
        code = result.code;
      } else {
        const vals = Object.values(result).filter(v => typeof v === 'string');
        if (vals.length === 1) code = vals[0];
      }
    }

    if (code && code.includes('from excel_builder')) {
      code = code.replace(/```python\s*/g, '').replace(/```\s*$/g, '').trim();
    }

    const usage = getUsageStats();

    logger.info(`[Enhanced] CodeGen done (${Date.now() - start}ms): ${code ? code.length : 0} chars`);

    return {
      code,
      codeTokens: usage,
      codeTimeMs: Date.now() - start,
    };
  } catch (error) {
    logger.error(`[Enhanced] CodeGen failed: ${error.message}`);
    return { code: null, error: error.message };
  }
}

async function reviewCode(code, objective, plan, options = {}) {
  const { callLLMFn = callLLM, modelOverride = null } = options;
  const systemPrompt = loadPrompt('critic');

  const userPrompt = [
    '## User Objective',
    objective.slice(0, 2000),
    '',
    '## Code Plan',
    JSON.stringify(plan?.sections?.map(s => ({ sheet: s.sheet, title: s.title, key_formulas: s.key_formulas })) || {}, null, 2).slice(0, 3000),
    '',
    '## Generated Python Code',
    '```python',
    code.slice(0, 15000),
    '```',
    '',
    'Review this code. Report issues. Return JSON.',
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

async function refineCode(code, objective, plan, criticIssues, options = {}) {
  const { callLLMFn = callLLM, modelOverride = null } = options;

  const systemPrompt = loadPrompt('codegen-v2');
  const planSummary = JSON.stringify(plan, null, 2).slice(0, 4000);
  const issuesSummary = criticIssues
    .filter(i => i.severity === 'critical' || i.severity === 'high')
    .map(i => `[${i.severity}] ${i.location}: ${i.description}\n  FIX: ${i.fix}`)
    .join('\n');

  const userPrompt = [
    '## Original Objective',
    objective,
    '',
    '## Code Plan',
    '```json', planSummary, '```',
    '',
    '## Previous Code (needs fixes)',
    '```python', code.slice(0, 8000), '```',
    '',
    '## CRITIC ISSUES TO FIX',
    issuesSummary,
    '',
    '## Instructions',
    'Fix ALL the critical and high-severity issues listed above. Keep everything else the same.',
    'Return ONLY {"code": "..."}',
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

    let code = null;
    if (result && typeof result === 'object') {
      if (result.code && typeof result.code === 'string') code = result.code;
      else {
        const vals = Object.values(result).filter(v => typeof v === 'string');
        if (vals.length === 1) code = vals[0];
      }
    }
    if (code && code.includes('from excel_builder')) {
      code = code.replace(/```python\s*/g, '').replace(/```\s*$/g, '').trim();
    }

    const usage = getUsageStats();
    logger.info(`[Enhanced] Refiner done (${Date.now() - start}ms): ${code ? code.length : 0} chars`);

    return { code, refinerTokens: usage, refinerTimeMs: Date.now() - start };
  } catch (error) {
    logger.warn(`[Enhanced] Refiner failed: ${error.message}`);
    return { code: null };
  }
}

async function executeAndStream(code, options = {}) {
  const { onProgress } = options;
  const start = Date.now();

  if (onProgress) onProgress('executing', { message: 'Running Python code...' });

  const execResult = await executeCode(code, { timeoutMs: 60000 });

  logger.info(`[Enhanced] Execution done (${Date.now() - start}ms): ${execResult.actions.length} batches, ${execResult.cellCount} cells`);

  return {
    actions: execResult.actions,
    cellCount: execResult.cellCount,
    executionMs: Date.now() - start,
  };
}

async function enhancedPipeline(objective, context = {}, options = {}) {
  const {
    modelOverride = null,
    skipCritic = false,
    onProgress = null,
  } = options;

  const totalStart = Date.now();
  const pipeline = { phases: {} };

  // Phase 1: Plan
  if (onProgress) onProgress('planning', { message: 'Analyzing request and creating blueprint...' });
  const planResult = await planWorkbook(objective, context, { modelOverride });
  pipeline.phases.plan = planResult;

  if (!planResult.plan || !planResult.plan.sections) {
    logger.warn('[Enhanced] Plan failed or empty, falling back to direct codegen');
    const directResult = await generateCode(objective, context, { recordTokenUsage: true, timeoutMs: 180000, modelOverride });
    if (directResult.code) {
      const exec = await executeAndStream(directResult.code, { onProgress });
      return { ...exec, code: directResult.code, pipeline: 'direct', tokenUsage: directResult.tokenUsage };
    }
    return { status: 'failed', error: 'Code generation failed' };
  }

  // Phase 2: Code Generation with plan
  if (onProgress) onProgress('generating', { message: `Building ${planResult.plan.sections.length} sections...` });
  const codeResult = await generateWithPlan(objective, context, planResult.plan, { modelOverride });
  pipeline.phases.codegen = codeResult;

  if (!codeResult.code) {
    return { status: 'failed', error: codeResult.error || 'Code generation failed', pipeline };
  }

  // Phase 3: Critic + Refine (optional)
  if (!skipCritic) {
    if (onProgress) onProgress('reviewing', { message: 'Reviewing code quality...' });
    const reviewResult = await reviewCode(codeResult.code, objective, planResult.plan, { modelOverride });
    pipeline.phases.critic = reviewResult;

    const hasCritical = reviewResult.review && !reviewResult.review.approved
      && reviewResult.review.issues?.some(i => i.severity === 'critical');

    if (hasCritical) {
      logger.warn(`[Enhanced] Critic found critical issues, refining...`);
      if (onProgress) onProgress('refining', { message: 'Fixing critical issues...' });

      const refined = await refineCode(codeResult.code, objective, planResult.plan,
        reviewResult.review.issues, { modelOverride });
      pipeline.phases.refiner = refined;

      if (refined.code) {
        pipeline.phases.codegen.code = refined.code;
        logger.info(`[Enhanced] Refiner produced new code (${refined.code.length} chars)`);
      }
    }
  }

  // Phase 4: Execute
  if (onProgress) onProgress('executing', { message: 'Writing to Excel...' });
  const execResult = await executeAndStream(codeResult.code, { onProgress });
  pipeline.phases.execution = execResult;

  const totalMs = Date.now() - totalStart;
  const totalTokens = {
    promptTokens: (planResult.planTokens?.promptTokens || 0) + (codeResult.codeTokens?.promptTokens || 0) + (pipeline.phases.critic?.reviewTokens?.promptTokens || 0),
    completionTokens: (planResult.planTokens?.completionTokens || 0) + (codeResult.codeTokens?.completionTokens || 0) + (pipeline.phases.critic?.reviewTokens?.completionTokens || 0),
    calls: (planResult.planTokens?.calls || 0) + (codeResult.codeTokens?.calls || 0) + (pipeline.phases.critic?.reviewTokens?.calls || 0),
  };

  logger.info(`[Enhanced] Pipeline complete (${totalMs}ms): ${execResult.cellCount} cells, ${totalTokens.promptTokens + totalTokens.completionTokens} tokens, ${totalTokens.calls} LLM calls`);

  return {
    status: 'ok',
    code: codeResult.code,
    codeLength: codeResult.code.length,
    cellCount: execResult.cellCount,
    actions: execResult.actions,
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
  return parts.join('\n');
}

module.exports = { enhancedPipeline, planWorkbook, generateWithPlan, reviewCode, selectSkills };
