'use strict';

const fs = require('fs');
const path = require('path');
const { callLLM, resetUsageStats, getUsageStats } = require('../server/tools/llm');
const logger = require('../server/utils/logger');

const PROMPTS_DIR = path.join(__dirname, 'prompts');

function loadPrompt(name) {
  return fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf-8');
}

/**
 * Analyze raw data (e.g., AIDA export, CSV, JSON) and produce a structured
 * financial research report. This is NOT domain-specific — it extracts whatever
 * the data contains and lets the LLM classify and interpret.
 *
 * @param {Object} data — extracted raw data (rows, metrics, text)
 * @param {string} objective — user's original objective
 * @param {Object} options
 * @returns {Object} researchReport
 */
async function researchData(data, objective, options = {}) {
  const { callLLMFn = callLLM, modelOverride = null } = options;
  const systemPrompt = loadPrompt('researcher');

  const dataJson = JSON.stringify(data, null, 2).slice(0, 12000);

  const userPrompt = [
    '## User Objective',
    objective,
    '',
    '## Extracted Data (JSON)',
    '```json',
    dataJson,
    '```',
    '',
    'Analyze this data. Return a structured research report.',
  ].join('\n');

  resetUsageStats();
  const start = Date.now();

  const result = await callLLMFn({
    system: systemPrompt,
    userText: userPrompt,
    timeoutMs: 120000,
    modelOverride,
    role: 'analyst',
    thinkingDisabled: false,
    jsonMode: true,
    label: 'codefirst_researcher',
  });

  const usage = getUsageStats();
  logger.info(`[Researcher] Done (${Date.now() - start}ms): domain=${result?.domain}, metrics=${result?.key_metrics?.length}`);

  return {
    report: result,
    researchTokens: usage,
    researchTimeMs: Date.now() - start,
  };
}

/**
 * Build a rich context object from a research report that downstream agents
 * (planner, codegen, critic) can consume.
 */
function buildResearchContext(researchReport, objective) {
  const report = researchReport?.report || {};
  const ctx = {
    domain: report.domain || 'general_finance',
    sub_domain: report.sub_domain || '',
    company_name: report.company_name || '',
    industry: report.industry || '',
    key_metrics: report.key_metrics || [],
    historical_series: report.historical_series || {},
    derived_assumptions: report.derived_assumptions || [],
    risk_factors: report.risk_factors || [],
    comparable_companies: report.comparable_companies || [],
    macro_environment: report.macro_environment || {},
    analyst_notes: report.analyst_notes || [],
    data_quality: report.data_quality || 'good',
    missing_data: report.missing_data || [],
  };

  // Build a dense text block for prompt injection
  const parts = [
    `=== RESEARCH CONTEXT ===`,
    `Domain: ${ctx.domain}${ctx.sub_domain ? ` / ${ctx.sub_domain}` : ''}`,
    `Company: ${ctx.company_name || 'N/A'}`,
    `Industry: ${ctx.industry || 'N/A'}`,
    `Data Quality: ${ctx.data_quality}`,
    '',
    `=== KEY METRICS ===`,
    ...(ctx.key_metrics.map(m => `- ${m.name}: ${m.value} ${m.unit || ''} (${m.year || 'latest'}) [source: ${m.source || 'data'}]`)),
    '',
    `=== HISTORICAL SERIES ===`,
    ...(Object.entries(ctx.historical_series).map(([k, v]) => {
      if (Array.isArray(v) && v.length > 0) {
        const latest = v[0];
        const prev = v[1] || null;
        const trend = prev ? `${((latest - prev) / Math.abs(prev) * 100).toFixed(1)}% YoY` : 'N/A';
        return `- ${k}: ${JSON.stringify(v.slice(0, 5))}… (latest trend: ${trend})`;
      }
      return `- ${k}: ${JSON.stringify(v).slice(0, 80)}`;
    })),
    '',
    `=== DERIVED ASSUMPTIONS (use these as BASE CASE) ===`,
    ...(ctx.derived_assumptions.map(a => `- ${a.name}: ${a.value} (${a.rationale}) [confidence: ${a.confidence || 'medium'}]`)),
    '',
    `=== RISK FACTORS ===`,
    ...(ctx.risk_factors.map(r => `- ${r.category}: ${r.description} (impact: ${r.impact || 'medium'})`)),
    '',
    `=== MISSING DATA / OPEN QUESTIONS ===`,
    ...(ctx.missing_data.map(m => `- ${m.item}: ${m.impact}`)),
    '',
    `=== ANALYST NOTES ===`,
    ...(ctx.analyst_notes.map(n => `- ${n}`)),
  ];

  ctx.promptBlock = parts.join('\n');
  return ctx;
}

module.exports = {
  researchData,
  buildResearchContext,
};
