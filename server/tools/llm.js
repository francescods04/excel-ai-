const axios = require('axios');
require('dotenv').config();
const logger = require('../utils/logger');
const { track } = require('../telemetry/tracker');
const { logMetric } = require('../utils/metrics');
const { writeLlmTrace, makeTraceId } = require('../utils/llmTrace');
const { getExecutionContext } = require('../utils/executionContext');

/* ---------- Configurazione LLM (DeepSeek primario, OpenRouter fallback) ---------- */
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
const DEEPSEEK_FALLBACK_MODEL = process.env.DEEPSEEK_FALLBACK_MODEL || 'deepseek-v4-flash';
const DEEPSEEK_REASONING_EFFORT = process.env.DEEPSEEK_REASONING_EFFORT || 'high';
const DEEPSEEK_THINKING_ENABLED = process.env.DEEPSEEK_THINKING_ENABLED !== 'false';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4-pro';
const OPENROUTER_FALLBACK_MODEL = process.env.OPENROUTER_FALLBACK_MODEL || 'qwen/qwen3-coder';

const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:3000';
const MAX_TOKENS = 131072;
const DEFAULT_LLM_TIMEOUT_MS = 300000;
const DEFAULT_LLM_FALLBACK_TIMEOUT_MS = 180000;

/* ---------- Dynamic config ---------- */
let dynamicConfig = { model: null, fallbackModel: null };

function setLLMConfig(config) {
  dynamicConfig = { ...dynamicConfig, ...config };
  logger.info(`[LLM] Runtime config → model=${dynamicConfig.model || 'default'}`);
}

function getLLMConfig() {
  return { ...dynamicConfig, provider: 'deepseek' };
}

/* ---------- Cache drift detection (DeepSeek auto-caches) ---------- */
const _lastSystemHash = new Map();
function _hashSystem(text) {
  if (!text) return '';
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function checkSystemPrefixStability(provider, systemText) {
  const h = _hashSystem(systemText);
  const prev = _lastSystemHash.get(provider);
  _lastSystemHash.set(provider, h);
  if (prev && prev !== h) {
    logger.warn(`[Cache] ${provider} system prompt changed (${prev} → ${h}). Cache invalidated.`);
  }
  return { hash: h, changed: !!prev && prev !== h };
}

/* ---------- JSON helpers ---------- */
function extractJSON(text) {
  if (!text) return '';
  const codeBlock = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (codeBlock) return codeBlock[1].trim();
  const start = text.indexOf('{');
  if (start === -1) return text.trim();
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1).trim(); }
  }
  return text.slice(start).trim();
}

// Escape raw control chars (\n, \t, \r, \b, \f, \0..\x1F) that appear INSIDE JSON
// string literals — common LLM emission bug that JSON.parse rejects with
// "Bad control character in string literal". State machine tracks string scope so
// structural newlines outside strings (which are valid JSON whitespace) are kept.
function repairJsonControlChars(s) {
  let out = '';
  let inStr = false, escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escape) { out += c; escape = false; continue; }
      if (c === '\\') { out += c; escape = true; continue; }
      if (c === '"') { out += c; inStr = false; continue; }
      const code = c.charCodeAt(0);
      if (code < 0x20) {
        if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        else if (c === '\t') out += '\\t';
        else if (c === '\b') out += '\\b';
        else if (c === '\f') out += '\\f';
        else out += '\\u' + code.toString(16).padStart(4, '0');
        continue;
      }
      out += c;
    } else {
      if (c === '"') { out += c; inStr = true; continue; }
      out += c;
    }
  }
  return out;
}

function tryParseJSON(content) {
  try { return { ok: true, value: JSON.parse(content) }; } catch (_) {}
  try { return { ok: true, value: JSON.parse(extractJSON(content)) }; } catch (_) {}
  // Repair pass: escape bare control chars in string literals, then try again.
  try { return { ok: true, value: JSON.parse(repairJsonControlChars(content)) }; } catch (_) {}
  try { return { ok: true, value: JSON.parse(repairJsonControlChars(extractJSON(content))) }; } catch (e) { return { ok: false, error: e }; }
}

function safeTimeoutMs(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function withTimeout(promise, ms, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function toErrorDetails(error) {
  if (!error) return null;
  return {
    message: error.message || String(error),
    code: error.code || null,
    status: error.response?.status || null,
  };
}

function buildTraceContext(trace = {}) {
  const traceInput = trace && typeof trace === 'object' ? trace : {};
  const executionContext = getExecutionContext();
  return {
    traceId: traceInput.traceId || makeTraceId(),
    turnId: traceInput.turnId || executionContext.turnId || null,
    userId: traceInput.userId || executionContext.userId || null,
    phase: traceInput.phase || executionContext.phase || null,
    workflow: traceInput.workflow || executionContext.workflow || null,
    parentTurnId: traceInput.parentTurnId || executionContext.parentTurnId || null,
    source: traceInput.source || executionContext.source || null,
  };
}

function readBooleanEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return defaultValue;
}

// Bench validated (2026-05-29): flash + no-thinking beat flash + full-thinking
// across quality (72 vs 60), wall-clock (183s vs 448s) and tokens (13.3M vs
// 20.1M). Default all roles to thinking-off — re-enable per-role via env if
// you need it back (PLANNER_THINKING_ENABLED, TRIAGE_THINKING_ENABLED,
// ARCHITECT_THINKING_ENABLED).
const PLANNER_THINKING_DEFAULT = readBooleanEnv('PLANNER_THINKING_ENABLED', false);
const TRIAGE_THINKING_DEFAULT = readBooleanEnv('TRIAGE_THINKING_ENABLED', false);
const ARCHITECT_THINKING_DEFAULT = readBooleanEnv('ARCHITECT_THINKING_ENABLED', false);
const ARCHITECT_MAX_TOKENS = Number(process.env.ARCHITECT_MAX_TOKENS) || 32768;

/* ---------- Role-based routing ---------- */
const ROLE_CONFIG = {
  planner:            { modelTier: 'flash', thinking: PLANNER_THINKING_DEFAULT, effort: process.env.PLANNER_REASONING_EFFORT || 'medium' },
  triage:             { modelTier: 'flash', thinking: TRIAGE_THINKING_DEFAULT, effort: process.env.TRIAGE_REASONING_EFFORT || 'low' },
  architect:          { modelTier: 'flash', thinking: ARCHITECT_THINKING_DEFAULT, effort: process.env.ARCHITECT_REASONING_EFFORT || 'medium', maxTokens: ARCHITECT_MAX_TOKENS },
  builder_hard:       { modelTier: 'pro',   thinking: true,  effort: 'high' },
  builder_analytical: { modelTier: 'flash', thinking: true,  effort: 'medium' },
  builder_structural: { modelTier: 'flash', thinking: false, effort: null },
  critic:             { modelTier: 'flash', thinking: false, effort: null },
  refiner:            { modelTier: 'flash', thinking: true,  effort: 'low' },
  narrator:           { modelTier: 'flash', thinking: false, effort: null },
  schema_infer:       { modelTier: 'flash', thinking: false, effort: null },
  verifier:           { modelTier: 'flash', thinking: true,  effort: 'medium' },
};

function tierToModel(tier) {
  if (tier === 'flash') return DEEPSEEK_FALLBACK_MODEL || 'deepseek-v4-flash';
  return DEEPSEEK_MODEL || 'deepseek-v4-pro';
}

function resolveRoleConfig(role) {
  if (!role || !ROLE_CONFIG[role]) return null;
  const base = ROLE_CONFIG[role];
  return {
    model: tierToModel(base.modelTier),
    thinkingDisabled: !base.thinking,
    reasoningEffort: base.effort,
    maxTokens: base.maxTokens || null,
  };
}

function resolvePrimaryModel(modelOverride, role = null) {
  if (modelOverride) return modelOverride;
  if (role) {
    const cfg = resolveRoleConfig(role);
    if (cfg && cfg.model) return cfg.model;
  }
  if (dynamicConfig.model) return dynamicConfig.model;
  return DEEPSEEK_MODEL;
}

function resolveFallbackModel(primaryModel, fallbackModelOverride) {
  if (fallbackModelOverride !== undefined) return fallbackModelOverride || '';
  if (dynamicConfig.fallbackModel) return dynamicConfig.fallbackModel;
  if (DEEPSEEK_FALLBACK_MODEL === primaryModel) return '';
  return DEEPSEEK_FALLBACK_MODEL;
}

function shouldRetryWithFallback(error, fallbackModel) {
  if (!fallbackModel) return false;
  if (!error) return false;
  const message = String(error.message || error);
  if (error.response && error.response.status >= 400 && error.response.status < 500) {
    if ([400, 401, 403, 422].includes(error.response.status)) return false;
  }
  if (message.includes('timeout')) return true;
  if (error.code === 'ECONNABORTED' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') return true;
  if (error.response && error.response.status >= 500) return true;
  if (message.includes('Cannot read properties of null')) return true;
  if (message.includes('Unexpected token') || message.includes('JSON parse')) return true;
  if (message.includes('network') || message.includes('ECONN')) return true;
  return false;
}

/* ---------- DeepSeek API calls ---------- */

/* ---------- Usage accumulator (opt-in, for benchmarks / cost measurement) ----------
 * No-op in production until resetUsageStats() is called. Records token usage per
 * model across the non-streaming provider calls (callDeepSeek / callOpenRouter).
 * Streaming calls don't report usage, so the bench forces AGENT_USE_STREAMING=false. */
let _usageStats = null;

function resetUsageStats() {
  _usageStats = { calls: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, byModel: {} };
}

function recordUsage(model, usage) {
  if (!_usageStats || !usage) return;
  const pt = usage.prompt_tokens || 0;
  const ct = usage.completion_tokens || 0;
  const hit = usage.prompt_cache_hit_tokens || 0;
  const miss = usage.prompt_cache_miss_tokens != null ? usage.prompt_cache_miss_tokens : Math.max(0, pt - hit);
  _usageStats.calls += 1;
  _usageStats.promptTokens += pt;
  _usageStats.completionTokens += ct;
  _usageStats.cacheHitTokens += hit;
  _usageStats.cacheMissTokens += miss;
  const m = _usageStats.byModel[model] || (_usageStats.byModel[model] = { calls: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 });
  m.calls += 1; m.promptTokens += pt; m.completionTokens += ct; m.cacheHitTokens += hit; m.cacheMissTokens += miss;
}

function getUsageStats() {
  return _usageStats ? JSON.parse(JSON.stringify(_usageStats)) : null;
}

async function callDeepSeek(messages, options = {}) {
  const model = options.model || DEEPSEEK_MODEL;
  const requestTimeoutMs = safeTimeoutMs(options.requestTimeoutMs, 120000);
  const jsonMode = options.jsonMode !== undefined ? options.jsonMode : true;
  const maxTokens = Number(options.maxTokens) > 0 ? Number(options.maxTokens) : MAX_TOKENS;

  const body = { model, messages, temperature: 0.2, max_tokens: maxTokens };
  if (jsonMode) body.response_format = { type: 'json_object' };

  if (options.thinkingDisabled) {
    body.thinking = { type: 'disabled' };
  } else if (DEEPSEEK_THINKING_ENABLED) {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = options.reasoningEffort || DEEPSEEK_REASONING_EFFORT;
  }

  const thinkingInfo = body.thinking?.type === 'enabled' ? ` thinking=enabled effort=${body.reasoning_effort}` : '';
  logger.info(`[LLM] DeepSeek → ${model} (timeout ${requestTimeoutMs}ms${thinkingInfo})`);
  const start = Date.now();

  try {
    const response = await axios.post(
      'https://api.deepseek.com/chat/completions',
      body,
      {
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: requestTimeoutMs,
      }
    );
    const elapsed = Date.now() - start;
    const choice = response.data?.choices?.[0];
    const content = choice?.message?.content || '';
    if (!content) throw new Error(`DeepSeek returned empty content for ${model}`);

    const usage = response.data?.usage
      ? {
          prompt_tokens: response.data.usage.prompt_tokens,
          completion_tokens: response.data.usage.completion_tokens,
          prompt_cache_hit_tokens: response.data.usage.prompt_cache_hit_tokens,
          prompt_cache_miss_tokens: response.data.usage.prompt_cache_miss_tokens,
        }
      : null;
    recordUsage(model, usage);

    let cacheInfo = '';
    if (usage?.prompt_cache_hit_tokens != null) {
      const hit = usage.prompt_cache_hit_tokens;
      const miss = usage.prompt_cache_miss_tokens || 0;
      const total = hit + miss;
      const pct = total > 0 ? ((hit / total) * 100).toFixed(1) : '0.0';
      cacheInfo = ` cache=${pct}% hit`;
    }
    logger.info(`[LLM] DeepSeek ← ${model} in ${elapsed}ms (${content.length} chars)${cacheInfo}`);

    const parsed = tryParseJSON(content);
    let result;
    if (parsed.ok) {
      result = parsed.value;
      if (usage) result._usage = usage;
    } else {
      result = { raw: content, jsonError: parsed.error.message, _usage: usage };
    }
    return {
      result,
      meta: {
        provider: 'deepseek',
        model,
        elapsedMs: elapsed,
        rawContent: content,
        usage,
        jsonError: parsed.ok ? null : parsed.error.message,
      }
    };
  } catch (error) {
    const elapsed = Date.now() - start;
    logger.error(`[LLM] DeepSeek error ← ${model} after ${elapsed}ms: ${error.message}`);
    throw error;
  }
}

/* ---------- OpenRouter API (fallback) ---------- */

async function callOpenRouter(messages, options = {}) {
  const model = options.model || OPENROUTER_MODEL;
  const requestTimeoutMs = safeTimeoutMs(options.requestTimeoutMs, 120000);
  const jsonMode = options.jsonMode !== undefined ? options.jsonMode : true;
  const maxTokens = Number(options.maxTokens) > 0 ? Number(options.maxTokens) : MAX_TOKENS;
  logger.info(`[LLM] OpenRouter fallback → ${model}`);
  const start = Date.now();

  const body = { model, messages, temperature: 0.2, max_tokens: maxTokens };
  if (jsonMode) body.response_format = { type: 'json_object' };

  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      body,
      {
        headers: {
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': PUBLIC_URL,
          'X-Title': 'Excel AI Agent',
        },
        timeout: requestTimeoutMs,
      }
    );
    const elapsed = Date.now() - start;
    const choice = response.data?.choices?.[0];
    const content = choice?.message?.content || '';
    if (!content) throw new Error(`OpenRouter returned empty content for ${model}`);

    const usage = response.data?.usage
      ? { prompt_tokens: response.data.usage.prompt_tokens, completion_tokens: response.data.usage.completion_tokens }
      : null;
    recordUsage(model, usage);

    logger.info(`[LLM] OpenRouter ← ${model} in ${elapsed}ms`);
    const parsed = tryParseJSON(content);
    let result;
    if (parsed.ok) {
      result = parsed.value;
      if (usage) result._usage = usage;
    } else {
      result = { raw: content, jsonError: parsed.error.message, _usage: usage };
    }
    return {
      result,
      meta: {
        provider: 'openrouter',
        model,
        elapsedMs: elapsed,
        rawContent: content,
        usage,
        jsonError: parsed.ok ? null : parsed.error.message,
      }
    };
  } catch (error) {
    const elapsed = Date.now() - start;
    logger.error(`[LLM] OpenRouter error ← ${model} after ${elapsed}ms: ${error.message}`);
    throw error;
  }
}

/* ---------- Unified call ---------- */
async function callLLM({
  system, messages, userText,
  timeoutMs = DEFAULT_LLM_TIMEOUT_MS,
  fallbackTimeoutMs = DEFAULT_LLM_FALLBACK_TIMEOUT_MS,
  modelOverride, fallbackModel,
  label = 'LLM call',
  systemReminder = null,
  role = null,
  thinkingDisabled = false,
  reasoningEffort = null,
  maxTokens = null,
  trace = null,
  jsonMode = true,
}) {
  let effectiveThinkingDisabled = thinkingDisabled;
  let effectiveReasoningEffort = reasoningEffort;
  let effectiveMaxTokens = maxTokens;
  if (role) {
    const roleCfg = resolveRoleConfig(role);
    if (roleCfg) {
      if (!modelOverride) modelOverride = roleCfg.model;
      effectiveThinkingDisabled = roleCfg.thinkingDisabled;
      effectiveReasoningEffort = roleCfg.reasoningEffort;
      if (!effectiveMaxTokens && roleCfg.maxTokens) effectiveMaxTokens = roleCfg.maxTokens;
      label = `${label} [role=${role}]`;
    }
  }

  let msgs = messages || [
    { role: 'system', content: system },
    { role: 'user', content: userText },
  ];

  if (systemReminder) {
    const lastUserIdx = msgs.findLastIndex(m => m.role === 'user');
    if (lastUserIdx >= 0) {
      msgs[lastUserIdx] = {
        ...msgs[lastUserIdx],
        content: `<system-reminder>\n${systemReminder}\n</system-reminder>\n\n${msgs[lastUserIdx].content}`,
      };
    }
  }

  if (!DEEPSEEK_API_KEY && !OPENROUTER_API_KEY) {
    throw new Error('Nessuna API key LLM configurata (DEEPSEEK_API_KEY o OPENROUTER_API_KEY)');
  }

  const primaryModel = resolvePrimaryModel(modelOverride, role);
  const systemText = typeof system === 'string' ? system : (msgs.find(m => m.role === 'system')?.content || '');

  if (systemText) checkSystemPrefixStability('deepseek', systemText);

  const start = Date.now();
  const provider = DEEPSEEK_API_KEY ? 'deepseek' : 'openrouter';
  const traceContext = buildTraceContext(trace);

  writeLlmTrace({
    eventType: 'llm.request',
    ...traceContext,
    label,
    role,
    provider,
    model: DEEPSEEK_API_KEY ? primaryModel : OPENROUTER_MODEL,
    attempt: 'primary',
    jsonMode,
    messages: msgs,
  });

  try {
    logger.info(`[LLM] ${label} → [${provider}] ${primaryModel}`);
    const response = await withTimeout(
      DEEPSEEK_API_KEY
        ? callDeepSeek(msgs, { model: primaryModel, requestTimeoutMs: timeoutMs, thinkingDisabled: effectiveThinkingDisabled, reasoningEffort: effectiveReasoningEffort, jsonMode, maxTokens: effectiveMaxTokens })
        : callOpenRouter(msgs, { model: OPENROUTER_MODEL, requestTimeoutMs: timeoutMs, jsonMode, maxTokens: effectiveMaxTokens }),
      timeoutMs, label
    );
    const elapsed = Date.now() - start;
    const result = response.result;
    const usage = response.meta?.usage || result?._usage || null;
    if (result?._usage) {
      track({ eventType: 'llm.response', latencyMs: elapsed, tokensIn: result._usage.prompt_tokens, tokensOut: result._usage.completion_tokens, model: primaryModel, success: 1, userId: traceContext.userId, sessionId: traceContext.turnId });
    }
    logMetric({
      type: 'llm',
      event: 'response',
      label,
      role,
      provider: response.meta?.provider || provider,
      model: response.meta?.model || primaryModel,
      latency_ms: elapsed,
      prompt_tokens: usage?.prompt_tokens || 0,
      completion_tokens: usage?.completion_tokens || 0,
      turnId: traceContext.turnId,
      traceId: traceContext.traceId,
    });
    writeLlmTrace({
      eventType: 'llm.response',
      ...traceContext,
      label,
      role,
      provider: response.meta?.provider || provider,
      model: response.meta?.model || primaryModel,
      attempt: 'primary',
      latencyMs: elapsed,
      usage,
      responseText: response.meta?.rawContent,
      response: result,
      extra: {
        jsonError: response.meta?.jsonError || null,
      }
    });
    logger.info(`[LLM] ${label} done ← ${primaryModel} in ${elapsed}ms`);
    return result;
  } catch (error) {
    const elapsed = Date.now() - start;
    track({ eventType: 'llm.error', latencyMs: elapsed, model: primaryModel, success: 0, properties: { error: error.message }, userId: traceContext.userId, sessionId: traceContext.turnId });
    logMetric({
      type: 'llm',
      event: 'error',
      label,
      role,
      provider,
      model: primaryModel,
      latency_ms: elapsed,
      error: error.message,
      turnId: traceContext.turnId,
      traceId: traceContext.traceId,
    });
    writeLlmTrace({
      eventType: 'llm.error',
      ...traceContext,
      label,
      role,
      provider,
      model: primaryModel,
      attempt: 'primary',
      latencyMs: elapsed,
      error: toErrorDetails(error),
    });

    const rescueModel = resolveFallbackModel(primaryModel, fallbackModel);
    logger.warn(`[LLM] ${label} failed on ${primaryModel}: ${error.message}. Fallback: ${rescueModel || 'none'}`);

    if (!shouldRetryWithFallback(error, rescueModel)) throw error;

    const fallbackProvider = OPENROUTER_API_KEY ? 'openrouter' : 'deepseek';
    const fallbackTargetModel = OPENROUTER_API_KEY ? (OPENROUTER_FALLBACK_MODEL || rescueModel) : rescueModel;
    writeLlmTrace({
      eventType: 'llm.fallback',
      ...traceContext,
      label,
      role,
      provider: fallbackProvider,
      model: fallbackTargetModel,
      attempt: 'fallback',
      extra: {
        fromProvider: provider,
        fromModel: primaryModel,
        reason: error.message,
      }
    });

    // Fallback: usa OpenRouter se disponibile
    if (OPENROUTER_API_KEY) {
      logger.info(`[LLM] ${label} retry via OpenRouter → ${OPENROUTER_FALLBACK_MODEL}`);
      const rescueStart = Date.now();
      const rescueResponse = await withTimeout(
        callOpenRouter(msgs, { model: OPENROUTER_FALLBACK_MODEL || rescueModel, requestTimeoutMs: fallbackTimeoutMs, jsonMode, maxTokens: effectiveMaxTokens }),
        fallbackTimeoutMs, `${label} fallback`
      );
      const rescueElapsed = Date.now() - rescueStart;
      const rescueResult = rescueResponse.result;
      const usage = rescueResponse.meta?.usage || rescueResult?._usage || null;
      track({ eventType: 'llm.response', latencyMs: rescueElapsed, model: OPENROUTER_FALLBACK_MODEL, success: 1, userId: traceContext.userId, sessionId: traceContext.turnId });
      logMetric({
        type: 'llm',
        event: 'response',
        label,
        role,
        provider: rescueResponse.meta?.provider || 'openrouter',
        model: rescueResponse.meta?.model || OPENROUTER_FALLBACK_MODEL || rescueModel,
        latency_ms: rescueElapsed,
        prompt_tokens: usage?.prompt_tokens || 0,
        completion_tokens: usage?.completion_tokens || 0,
        turnId: traceContext.turnId,
        traceId: traceContext.traceId,
      });
      writeLlmTrace({
        eventType: 'llm.response',
        ...traceContext,
        label,
        role,
        provider: rescueResponse.meta?.provider || 'openrouter',
        model: rescueResponse.meta?.model || OPENROUTER_FALLBACK_MODEL || rescueModel,
        attempt: 'fallback',
        latencyMs: rescueElapsed,
        usage,
        responseText: rescueResponse.meta?.rawContent,
        response: rescueResult,
        extra: {
          fallbackFromModel: primaryModel,
          jsonError: rescueResponse.meta?.jsonError || null,
        }
      });
      return rescueResult;
    }

    // Fallback: stesso DeepSeek, modello diverso
    logger.info(`[LLM] ${label} retry → ${rescueModel}`);
    const rescueStart = Date.now();
    const rescueResponse = await withTimeout(
      callDeepSeek(msgs, { model: rescueModel, requestTimeoutMs: fallbackTimeoutMs, thinkingDisabled: true, jsonMode, maxTokens: effectiveMaxTokens }),
      fallbackTimeoutMs, `${label} fallback`
    );
    const rescueElapsed = Date.now() - rescueStart;
    const rescueResult = rescueResponse.result;
    const usage = rescueResponse.meta?.usage || rescueResult?._usage || null;
    track({ eventType: 'llm.response', latencyMs: rescueElapsed, model: rescueModel, success: 1, userId: traceContext.userId, sessionId: traceContext.turnId });
    logMetric({
      type: 'llm',
      event: 'response',
      label,
      role,
      provider: rescueResponse.meta?.provider || 'deepseek',
      model: rescueResponse.meta?.model || rescueModel,
      latency_ms: rescueElapsed,
      prompt_tokens: usage?.prompt_tokens || 0,
      completion_tokens: usage?.completion_tokens || 0,
      turnId: traceContext.turnId,
      traceId: traceContext.traceId,
    });
    writeLlmTrace({
      eventType: 'llm.response',
      ...traceContext,
      label,
      role,
      provider: rescueResponse.meta?.provider || 'deepseek',
      model: rescueResponse.meta?.model || rescueModel,
      attempt: 'fallback',
      latencyMs: rescueElapsed,
      usage,
      responseText: rescueResponse.meta?.rawContent,
      response: rescueResult,
      extra: {
        fallbackFromModel: primaryModel,
        jsonError: rescueResponse.meta?.jsonError || null,
      }
    });
    return rescueResult;
  }
}

/* ---------- Streaming ---------- */
const readline = require('readline');

async function callDeepSeekStream(messages, options = {}, onChunk) {
  const model = options.model || DEEPSEEK_MODEL;
  const requestTimeoutMs = safeTimeoutMs(options.requestTimeoutMs, 120000);
  const jsonMode = options.jsonMode !== undefined ? options.jsonMode : true;
  const maxTokens = Number(options.maxTokens) > 0 ? Number(options.maxTokens) : MAX_TOKENS;

  const body = { model, messages, temperature: 0.2, max_tokens: maxTokens, stream: true };
  if (jsonMode) body.response_format = { type: 'json_object' };

  if (options.thinkingDisabled) {
    body.thinking = { type: 'disabled' };
  } else if (DEEPSEEK_THINKING_ENABLED) {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = options.reasoningEffort || DEEPSEEK_REASONING_EFFORT;
  }

  logger.info(`[LLM] DeepSeek stream → ${model}`);

  const response = await axios.post(
    'https://api.deepseek.com/chat/completions',
    body,
    {
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: requestTimeoutMs,
      responseType: 'stream',
    }
  );

  const stream = response.data;
  let accumulated = '';
  let done = false;
  let settled = false;

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let timeoutId;
    function finish(err, value, cleanupStream = false) {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (cleanupStream) {
        try { rl.close(); } catch (_) {}
        try {
          if (!stream.destroyed) stream.destroy();
        } catch (_) {}
      }
      if (err) reject(err); else resolve(value);
    }

    if (options.maxTotalMs && options.maxTotalMs > 0) {
      timeoutId = setTimeout(() => finish(new Error(`Stream timeout after ${options.maxTotalMs}ms`), null, true), options.maxTotalMs);
    }

    rl.on('line', (line) => {
      if (done || settled) return;
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') {
        done = true;
        onChunk('', accumulated, true);
        finish(null, accumulated, true);
        return;
      }
      try {
        const parsed = JSON.parse(data);
        const deltaContent = parsed.choices?.[0]?.delta?.content || '';
        const deltaReasoning = parsed.choices?.[0]?.delta?.reasoning_content || '';
        const delta = deltaContent || deltaReasoning;
        if (delta) {
          accumulated += delta;
          onChunk(delta, accumulated, false);
        }
      } catch (_) {}
    });

    rl.on('close', () => {
      if (settled) return;
      if (!done) onChunk('', accumulated, true);
      finish(null, accumulated);
    });

    rl.on('error', (err) => {
      finish(err, null, true);
    });

    stream.on('aborted', () => {
      finish(new Error('Stream aborted'), null, true);
    });

    stream.on('error', (err) => {
      finish(err, null, true);
    });
  });
}

async function callLLMStreaming({
  system, messages, userText,
  timeoutMs = DEFAULT_LLM_TIMEOUT_MS,
  modelOverride,
  label = 'LLM stream',
  onChunk,
  systemReminder = null,
  role = null,
  thinkingDisabled = false,
  reasoningEffort = null,
  maxTokens = null,
  trace = null,
  jsonMode = true,
}) {
  let effectiveThinkingDisabled = thinkingDisabled;
  let effectiveReasoningEffort = reasoningEffort;
  let effectiveMaxTokens = maxTokens;
  if (role) {
    const roleCfg = resolveRoleConfig(role);
    if (roleCfg) {
      if (!modelOverride) modelOverride = roleCfg.model;
      effectiveThinkingDisabled = roleCfg.thinkingDisabled;
      effectiveReasoningEffort = roleCfg.reasoningEffort;
      if (!effectiveMaxTokens && roleCfg.maxTokens) effectiveMaxTokens = roleCfg.maxTokens;
      label = `${label} [role=${role}]`;
    }
  }

  let msgs = messages || [
    { role: 'system', content: system },
    { role: 'user', content: userText },
  ];

  if (systemReminder) {
    const lastUserIdx = msgs.findLastIndex(m => m.role === 'user');
    if (lastUserIdx >= 0) {
      msgs[lastUserIdx] = {
        ...msgs[lastUserIdx],
        content: `<system-reminder>\n${systemReminder}\n</system-reminder>\n\n${msgs[lastUserIdx].content}`,
      };
    }
  }

  const primaryModel = resolvePrimaryModel(modelOverride, role);
  const systemText = typeof system === 'string' ? system : (msgs.find(m => m.role === 'system')?.content || '');

  const finalMessages = systemText
    ? [{ role: 'system', content: systemText }, ...msgs.filter(m => m.role !== 'system')]
    : msgs;

  if (systemText) checkSystemPrefixStability('deepseek', systemText);

  const maxStreamMs = timeoutMs || 300000;
  const traceContext = buildTraceContext(trace);

  writeLlmTrace({
    eventType: 'llm.request',
    ...traceContext,
    label,
    role,
    provider: 'deepseek',
    model: primaryModel,
    attempt: 'primary',
    jsonMode,
    extra: { streaming: true },
    messages: finalMessages,
  });

  try {
    logger.info(`[LLM] ${label} stream → ${primaryModel}`);
    const startedAt = Date.now();
    const accumulated = await callDeepSeekStream(finalMessages, {
      model: primaryModel,
      maxTotalMs: maxStreamMs,
      requestTimeoutMs: maxStreamMs,
      thinkingDisabled: effectiveThinkingDisabled,
      reasoningEffort: effectiveReasoningEffort,
      maxTokens: effectiveMaxTokens,
      jsonMode,
    }, onChunk);
    const elapsed = Date.now() - startedAt;
    logMetric({
      type: 'llm',
      event: 'response',
      label,
      role,
      provider: 'deepseek',
      model: primaryModel,
      latency_ms: elapsed,
      turnId: traceContext.turnId,
      traceId: traceContext.traceId,
    });
    writeLlmTrace({
      eventType: 'llm.response',
      ...traceContext,
      label,
      role,
      provider: 'deepseek',
      model: primaryModel,
      attempt: 'primary',
      latencyMs: elapsed,
      responseText: accumulated,
      response: { raw: accumulated },
      extra: { streaming: true }
    });
    logger.info(`[LLM] ${label} stream done ← ${primaryModel} (${accumulated.length} chars)`);
    return accumulated;
  } catch (error) {
    logMetric({
      type: 'llm',
      event: 'error',
      label,
      role,
      provider: 'deepseek',
      model: primaryModel,
      error: error.message,
      turnId: traceContext.turnId,
      traceId: traceContext.traceId,
    });
    writeLlmTrace({
      eventType: 'llm.error',
      ...traceContext,
      label,
      role,
      provider: 'deepseek',
      model: primaryModel,
      attempt: 'primary',
      error: toErrorDetails(error),
      extra: { streaming: true }
    });
    logger.error(`[LLM] ${label} stream error: ${error.message}`);
    throw error;
  }
}

module.exports = {
  callLLM,
  callLLMStreaming,
  setLLMConfig,
  getLLMConfig,
  resetUsageStats,
  getUsageStats,
  _buildTraceContext: buildTraceContext,
  _resolveRoleConfig: resolveRoleConfig
};
