const axios = require('axios');
require('dotenv').config();
const logger = require('../utils/logger');
const { track } = require('../telemetry/tracker');

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

function tryParseJSON(content) {
  try { return { ok: true, value: JSON.parse(content) }; } catch (_) {}
  try { return { ok: true, value: JSON.parse(extractJSON(content)) }; } catch (e) { return { ok: false, error: e }; }
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

/* ---------- Role-based routing ---------- */
const ROLE_CONFIG = {
  planner:            { modelTier: 'flash', thinking: true,  effort: 'medium' },
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

async function callDeepSeek(messages, options = {}) {
  const model = options.model || DEEPSEEK_MODEL;
  const requestTimeoutMs = safeTimeoutMs(options.requestTimeoutMs, 120000);
  const jsonMode = options.jsonMode !== undefined ? options.jsonMode : true;

  const body = { model, messages, temperature: 0.2, max_tokens: MAX_TOKENS };
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
    if (parsed.ok) {
      const result = parsed.value;
      if (usage) result._usage = usage;
      return result;
    }
    return { raw: content, jsonError: parsed.error.message, _usage: usage };
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
  logger.info(`[LLM] OpenRouter fallback → ${model}`);
  const start = Date.now();

  const body = { model, messages, temperature: 0.2, max_tokens: MAX_TOKENS };
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

    logger.info(`[LLM] OpenRouter ← ${model} in ${elapsed}ms`);
    const parsed = tryParseJSON(content);
    if (parsed.ok) {
      const result = parsed.value;
      if (usage) result._usage = usage;
      return result;
    }
    return { raw: content, jsonError: parsed.error.message, _usage: usage };
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
}) {
  let thinkingDisabled = false;
  let reasoningEffort = null;
  if (role) {
    const roleCfg = resolveRoleConfig(role);
    if (roleCfg) {
      if (!modelOverride) modelOverride = roleCfg.model;
      thinkingDisabled = roleCfg.thinkingDisabled;
      reasoningEffort = roleCfg.reasoningEffort;
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

  try {
    logger.info(`[LLM] ${label} → [${provider}] ${primaryModel}`);
    const result = await withTimeout(
      DEEPSEEK_API_KEY
        ? callDeepSeek(msgs, { model: primaryModel, requestTimeoutMs: timeoutMs, thinkingDisabled, reasoningEffort })
        : callOpenRouter(msgs, { model: OPENROUTER_MODEL, requestTimeoutMs: timeoutMs }),
      timeoutMs, label
    );
    const elapsed = Date.now() - start;
    if (result?._usage) {
      track({ eventType: 'llm.response', latencyMs: elapsed, tokensIn: result._usage.prompt_tokens, tokensOut: result._usage.completion_tokens, model: primaryModel, success: 1 });
    }
    logger.info(`[LLM] ${label} done ← ${primaryModel} in ${elapsed}ms`);
    return result;
  } catch (error) {
    const elapsed = Date.now() - start;
    track({ eventType: 'llm.error', latencyMs: elapsed, model: primaryModel, success: 0, properties: { error: error.message } });

    const rescueModel = resolveFallbackModel(primaryModel, fallbackModel);
    logger.warn(`[LLM] ${label} failed on ${primaryModel}: ${error.message}. Fallback: ${rescueModel || 'none'}`);

    if (!shouldRetryWithFallback(error, rescueModel)) throw error;

    // Fallback: usa OpenRouter se disponibile
    if (OPENROUTER_API_KEY) {
      logger.info(`[LLM] ${label} retry via OpenRouter → ${OPENROUTER_FALLBACK_MODEL}`);
      const rescueStart = Date.now();
      const rescueResult = await withTimeout(
        callOpenRouter(msgs, { model: OPENROUTER_FALLBACK_MODEL || rescueModel, requestTimeoutMs: fallbackTimeoutMs }),
        fallbackTimeoutMs, `${label} fallback`
      );
      track({ eventType: 'llm.response', latencyMs: Date.now() - rescueStart, model: OPENROUTER_FALLBACK_MODEL, success: 1 });
      return rescueResult;
    }

    // Fallback: stesso DeepSeek, modello diverso
    logger.info(`[LLM] ${label} retry → ${rescueModel}`);
    const rescueStart = Date.now();
    const rescueResult = await withTimeout(
      callDeepSeek(msgs, { model: rescueModel, requestTimeoutMs: fallbackTimeoutMs, thinkingDisabled: true }),
      fallbackTimeoutMs, `${label} fallback`
    );
    track({ eventType: 'llm.response', latencyMs: Date.now() - rescueStart, model: rescueModel, success: 1 });
    return rescueResult;
  }
}

/* ---------- Streaming ---------- */
const readline = require('readline');

async function callDeepSeekStream(messages, options = {}, onChunk) {
  const model = options.model || DEEPSEEK_MODEL;
  const requestTimeoutMs = safeTimeoutMs(options.requestTimeoutMs, 120000);
  const jsonMode = options.jsonMode !== undefined ? options.jsonMode : true;

  const body = { model, messages, temperature: 0.2, max_tokens: MAX_TOKENS, stream: true };
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

    function finish(err, value) {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(value);
    }

    let timeoutId;
    if (options.maxTotalMs && options.maxTotalMs > 0) {
      timeoutId = setTimeout(() => finish(new Error(`Stream timeout after ${options.maxTotalMs}ms`)), options.maxTotalMs);
    }

    rl.on('line', (line) => {
      if (done || settled) return;
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') {
        done = true;
        if (timeoutId) clearTimeout(timeoutId);
        onChunk('', accumulated, true);
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
      if (timeoutId) clearTimeout(timeoutId);
      if (!done) onChunk('', accumulated, true);
      finish(null, accumulated);
    });

    stream.on('error', (err) => {
      if (timeoutId) clearTimeout(timeoutId);
      finish(err);
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
}) {
  let thinkingDisabled = false;
  let reasoningEffort = null;
  if (role) {
    const roleCfg = resolveRoleConfig(role);
    if (roleCfg) {
      if (!modelOverride) modelOverride = roleCfg.model;
      thinkingDisabled = roleCfg.thinkingDisabled;
      reasoningEffort = roleCfg.reasoningEffort;
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

  try {
    logger.info(`[LLM] ${label} stream → ${primaryModel}`);
    const accumulated = await callDeepSeekStream(finalMessages, {
      model: primaryModel,
      maxTotalMs: maxStreamMs,
      requestTimeoutMs: maxStreamMs,
      thinkingDisabled,
      reasoningEffort,
    }, onChunk);
    logger.info(`[LLM] ${label} stream done ← ${primaryModel} (${accumulated.length} chars)`);
    return accumulated;
  } catch (error) {
    logger.error(`[LLM] ${label} stream error: ${error.message}`);
    throw error;
  }
}

module.exports = { callLLM, callLLMStreaming, setLLMConfig, getLLMConfig };
