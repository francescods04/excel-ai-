const axios = require('axios');
require('dotenv').config();
const logger = require('../utils/logger');

/* ---------- Configurazione LLM (unificata) ---------- */
const AI_PROVIDER = process.env.AI_PROVIDER || 'opencode';
const AI_API_URL = process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions';
const AI_API_KEY = process.env.AI_API_KEY || '';
// MODELLO UNICO: kimi-k2.6 su tutti i provider
const AI_MODEL = process.env.AI_MODEL || 'kimi-k2.6';
const AI_FALLBACK_MODEL = process.env.AI_FALLBACK_MODEL || '';

const OPENCODE_SERVER_URL = process.env.OPENCODE_SERVER_URL || 'http://127.0.0.1:4096';
const OPENCODE_PROVIDER = process.env.OPENCODE_PROVIDER || 'opencode-go';
const OPENCODE_MODEL = process.env.OPENCODE_MODEL || 'kimi-k2.6';
const OPENCODE_FALLBACK_MODEL = process.env.OPENCODE_FALLBACK_MODEL || '';
let opencodeSessionId = null;

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'moonshotai/kimi-k2.6';
// Nessun fallback diverso da kimi-k2.6
const OPENROUTER_FALLBACK_MODEL = process.env.OPENROUTER_FALLBACK_MODEL || '';

/* ---------- Xiaomi MiMo config ---------- */
const XIAOMI_API_KEY = process.env.XIAOMI_API_KEY || '';
const XIAOMI_API_URL = process.env.XIAOMI_API_URL || 'https://token-plan-ams.xiaomimimo.com/v1/chat/completions';
const XIAOMI_MODEL = process.env.XIAOMI_MODEL || 'xiaomi/mimo-v2.5-pro';
const XIAOMI_FALLBACK_MODEL = process.env.XIAOMI_FALLBACK_MODEL || '';

/* ---------- DeepSeek config ---------- */
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
const DEEPSEEK_FALLBACK_MODEL = process.env.DEEPSEEK_FALLBACK_MODEL || '';
const DEEPSEEK_REASONING_EFFORT = process.env.DEEPSEEK_REASONING_EFFORT || 'high';
const DEEPSEEK_THINKING_ENABLED = process.env.DEEPSEEK_THINKING_ENABLED !== 'false';

/* ---------- Dynamic model config (runtime switchable) ---------- */
let dynamicConfig = {
  provider: AI_PROVIDER,
  model: null, // null = use provider default
  fallbackModel: null,
  apiKey: null,
  apiUrl: null
};

function setLLMConfig(config) {
  dynamicConfig = { ...dynamicConfig, ...config };
  logger.info(`[LLM] Runtime config updated → provider=${dynamicConfig.provider}, model=${dynamicConfig.model || 'default'}`);
}

function getLLMConfig() {
  return { ...dynamicConfig };
}

const DEFAULT_LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 90000;
const DEFAULT_LLM_FALLBACK_TIMEOUT_MS = Number(process.env.LLM_FALLBACK_TIMEOUT_MS) || 45000;

const LLM_JSON_MODE = process.env.LLM_JSON_MODE !== 'false';
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 16384;

/* ---------- Cache optimization ---------- */
const CACHE_BREAKPOINT_ENABLED = process.env.CACHE_BREAKPOINT_ENABLED !== 'false';

/**
 * Anthropic-style 4-breakpoint cache optimization:
 * 1. system[0] (identity+workflow) → cache_control: ephemeral
 * 2. system[1] (skills+context) → cache_control: ephemeral
 * 3. Last message with tool definitions → cache_control: ephemeral
 * 4. Last assistant message → cache_control: ephemeral (rolling)
 *
 * DeepSeek: no explicit cache_control (cache is automatic on identical prefixes),
 * but we log prefix sizes to help manual optimization.
 */
class CacheMessageBuilder {
  constructor(provider, model) {
    this.provider = provider;
    this.model = model;
    this.supportsCacheControl = this._supportsCacheControl();
  }

  _supportsCacheControl() {
    // OpenRouter with Anthropic models supports cache_control via their API
    if (this.provider === 'openrouter') return true;
    // Native Anthropic (future)
    if (this.provider === 'anthropic') return true;
    return false;
  }

  /**
   * Split a system prompt into identity + skills/context parts.
   * Identity = first N lines (first paragraph + workflow)
   * Skills = remaining content
   */
  splitSystemPrompt(systemText) {
    if (!systemText || typeof systemText !== 'string') {
      return { identity: systemText || '', skills: '' };
    }
    const lines = systemText.split('\n');
    // Find first blank line after ~10 lines (heuristic: identity is compact)
    let splitIdx = lines.length;
    let blankCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '') blankCount++;
      if (blankCount >= 2 && i > 10) {
        splitIdx = i;
        break;
      }
    }
    const identity = lines.slice(0, splitIdx).join('\n').trim();
    const skills = lines.slice(splitIdx).join('\n').trim();
    return { identity, skills };
  }

  /**
   * Build cache-optimized messages array.
   * @param {Array} messages - Original messages
   * @param {string} systemText - Resolved system prompt text
   * @param {boolean} cachePrompt - Whether to apply cache breakpoints
   */
  build(messages, systemText, cachePrompt = false) {
    if (!CACHE_BREAKPOINT_ENABLED || !cachePrompt || !this.supportsCacheControl) {
      // DeepSeek path: no cache_control, but log prefix size
      if (this.provider === 'deepseek' && systemText) {
        const prefixLen = systemText.length;
        logger.debug(`[Cache] DeepSeek prefix size: ${prefixLen} chars (${Math.round(prefixLen / 4)} tokens est.)`);
      }
      return messages;
    }

    // OpenRouter / Anthropic path: apply 4-breakpoint pattern
    const { identity, skills } = this.splitSystemPrompt(systemText);
    const optimized = [];

    // Breakpoint 1: system[0] identity
    if (identity) {
      optimized.push({
        role: 'system',
        content: [
          { type: 'text', text: identity, cache_control: { type: 'ephemeral' } }
        ]
      });
    }

    // Breakpoint 2: system[1] skills/context
    if (skills) {
      optimized.push({
        role: 'system',
        content: [
          { type: 'text', text: skills, cache_control: { type: 'ephemeral' } }
        ]
      });
    }

    // Copy remaining messages (user, assistant, tool)
    let lastToolIdx = -1;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === 'system') continue; // Already handled above
      optimized.push(msg);
      if (msg.role === 'tool' || (msg.content && typeof msg.content === 'string' && msg.content.includes('Tool result'))) {
        lastToolIdx = optimized.length - 1;
      }
    }

    // Breakpoint 3: last tool/result message
    if (lastToolIdx >= 0) {
      const msg = optimized[lastToolIdx];
      if (typeof msg.content === 'string') {
        optimized[lastToolIdx] = {
          ...msg,
          content: [
            { type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }
          ]
        };
      }
    }

    // Breakpoint 4: last assistant message (rolling cache)
    const lastAssistantIdx = optimized.findLastIndex(m => m.role === 'assistant');
    if (lastAssistantIdx >= 0) {
      const msg = optimized[lastAssistantIdx];
      if (typeof msg.content === 'string') {
        optimized[lastAssistantIdx] = {
          ...msg,
          content: [
            { type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }
          ]
        };
      }
    }

    const originalTokens = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    logger.info(`[Cache] Built ${optimized.length} messages with 4 breakpoints (original: ${messages.length}, est. tokens: ${Math.round(originalTokens / 4)})`);
    return optimized;
  }
}

function safeTimeoutMs(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

/* ---------- OpenCode helpers ---------- */
async function getOrCreateOpenCodeSession() {
  if (opencodeSessionId) return opencodeSessionId;
  const resp = await axios.post(`${OPENCODE_SERVER_URL}/session`, { title: 'Excel AI Agent' });
  opencodeSessionId = resp.data.id;
  return opencodeSessionId;
}

function extractJSON(text) {
  if (!text) return '';
  const codeBlock = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (codeBlock) return codeBlock[1].trim();
  // Balanced-brace scan: first `{` to its matching `}`. Skips chars inside strings.
  const start = text.indexOf('{');
  if (start === -1) return text.trim();
  let depth = 0;
  let inStr = false;
  let escape = false;
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
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1).trim();
    }
  }
  return text.slice(start).trim();
}

function tryParseJSON(content) {
  try {
    return { ok: true, value: JSON.parse(content) };
  } catch (_) {
    try {
      return { ok: true, value: JSON.parse(extractJSON(content)) };
    } catch (e) {
      return { ok: false, error: e };
    }
  }
}

async function callOpenCodeAI(systemPrompt, userMessage, options = {}) {
  const modelID = options.model || OPENCODE_MODEL;
  const requestTimeoutMs = safeTimeoutMs(options.requestTimeoutMs, 300000);
  const sessionId = await getOrCreateOpenCodeSession();
  logger.info(`[LLM] OpenCode request → ${modelID} (timeout ${requestTimeoutMs}ms)`);
  const start = Date.now();
  try {
    const resp = await axios.post(
      `${OPENCODE_SERVER_URL}/session/${sessionId}/message`,
      {
        model: { providerID: OPENCODE_PROVIDER, modelID },
        system: systemPrompt,
        parts: [{ type: 'text', text: userMessage }]
      },
      { timeout: requestTimeoutMs }
    );
    const elapsed = Date.now() - start;
    const parts = resp.data.parts || [];
    const textParts = parts.filter(p => p.type === 'text');
    const rawContent = textParts.map(p => p.text).join('\n');
    logger.info(`[LLM] OpenCode response ← ${modelID} in ${elapsed}ms (${rawContent.length} chars)`);
    const parsed = tryParseJSON(rawContent);
    if (parsed.ok) return parsed.value;
    logger.warn(`[LLM] OpenCode JSON parse error: ${parsed.error.message}`);
    return { raw: rawContent, jsonError: parsed.error.message };
  } catch (error) {
    const elapsed = Date.now() - start;
    logger.error(`[LLM] OpenCode error ← ${modelID} after ${elapsed}ms: ${error.message}`);
    throw error;
  }
}

async function callOpenRouterAI(messages, options = {}) {
  const model = options.model || OPENROUTER_MODEL;
  const requestTimeoutMs = safeTimeoutMs(options.requestTimeoutMs, 120000);
  const jsonMode = options.jsonMode !== undefined ? options.jsonMode : LLM_JSON_MODE;
  logger.info(`[LLM] OpenRouter request → ${model} (timeout ${requestTimeoutMs}ms)`);
  const start = Date.now();

  // Anthropic-style 4-breakpoint cache optimization
  let bodyMessages = messages;
  if (options.cachePrompt && messages && messages.length > 0) {
    const builder = new CacheMessageBuilder('openrouter', model);
    bodyMessages = builder.build(messages, options.systemText || '', true);
  }

  const body = {
    model,
    messages: bodyMessages,
    temperature: 0.2,
    max_tokens: MAX_TOKENS
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  try {
  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    body,
    {
      headers: {
        'Authorization': `Bearer ${dynamicConfig.apiKey || OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://localhost:3000',
        'X-Title': 'Excel AI Agent'
      },
      timeout: requestTimeoutMs
    }
  );
    const elapsed = Date.now() - start;
    const choice = response.data?.choices?.[0];
    const content = choice?.message?.content || '';
    if (!content) {
      throw new Error(`OpenRouter returned empty content for ${model}: ${JSON.stringify(response.data)}`);
    }
    const usage = response.data?.usage
      ? { prompt_tokens: response.data.usage.prompt_tokens, completion_tokens: response.data.usage.completion_tokens }
      : null;
    logger.info(`[LLM] OpenRouter response ← ${model} in ${elapsed}ms (${content.length} chars)${usage ? ` usage: ${JSON.stringify(usage)}` : ''}`);
    const parsed = tryParseJSON(content);
    if (parsed.ok) {
      const result = parsed.value;
      if (usage) result._usage = usage;
      return result;
    }
    logger.warn(`[LLM] OpenRouter JSON parse error: ${parsed.error.message}`);
    return { raw: content, jsonError: parsed.error.message, _usage: usage };
  } catch (error) {
    const elapsed = Date.now() - start;
    logger.error(`[LLM] OpenRouter error ← ${model} after ${elapsed}ms: ${error.message}`);
    throw error;
  }
}

async function callOpenAICompat(messages, options = {}) {
  const model = options.model || AI_MODEL;
  const requestTimeoutMs = safeTimeoutMs(options.requestTimeoutMs, 120000);
  const jsonMode = options.jsonMode !== undefined ? options.jsonMode : LLM_JSON_MODE;
  const apiUrl = options.apiUrl || AI_API_URL;
  const apiKey = options.apiKey || AI_API_KEY;
  if (!apiKey) throw new Error('No API key configured');
  const body = {
    model,
    messages: messages,
    temperature: 0.2,
    max_tokens: MAX_TOKENS
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  if (options.thinkingDisabled) body.thinking = { type: 'disabled' };
  const response = await axios.post(
    apiUrl,
    body,
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: requestTimeoutMs
    }
  );
  const choice = response.data?.choices?.[0];
  const content = choice?.message?.content || '';
  if (!content) {
    throw new Error(`OpenAI-compat returned empty content for ${model}: ${JSON.stringify(response.data)}`);
  }
  const usage = response.data?.usage
    ? { prompt_tokens: response.data.usage.prompt_tokens, completion_tokens: response.data.usage.completion_tokens }
    : null;
  const parsed = tryParseJSON(content);
  if (parsed.ok) {
    const result = parsed.value;
    if (usage) result._usage = usage;
    return result;
  }
  logger.warn(`[LLM] OpenAI-compat JSON parse error: ${parsed.error.message}`);
  return { raw: content, jsonError: parsed.error.message, _usage: usage };
}

/* ---------- DeepSeek helpers ---------- */
async function callDeepSeekAI(messages, options = {}) {
  const model = options.model || DEEPSEEK_MODEL;
  const requestTimeoutMs = safeTimeoutMs(options.requestTimeoutMs, 120000);
  const jsonMode = options.jsonMode !== undefined ? options.jsonMode : LLM_JSON_MODE;
  const apiUrl = options.apiUrl || DEEPSEEK_API_URL;
  const apiKey = options.apiKey || DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('No DeepSeek API key configured');

  const body = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: MAX_TOKENS
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  if (options.thinkingDisabled) {
    body.thinking = { type: 'disabled' };
  } else if (DEEPSEEK_THINKING_ENABLED) {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = options.reasoningEffort || DEEPSEEK_REASONING_EFFORT;
  }

  logger.info(`[LLM] DeepSeek request → ${model} (timeout ${requestTimeoutMs}ms, thinking=${body.thinking?.type || 'default'}${body.reasoning_effort ? `, effort=${body.reasoning_effort}` : ''})`);
  const start = Date.now();
  const response = await axios.post(
    apiUrl,
    body,
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: requestTimeoutMs
    }
  );
  const elapsed = Date.now() - start;
  const choice = response.data?.choices?.[0];
  const content = choice?.message?.content || '';
  if (!content) {
    throw new Error(`DeepSeek returned empty content for ${model}: ${JSON.stringify(response.data)}`);
  }

  const usage = response.data?.usage
    ? {
        prompt_tokens: response.data.usage.prompt_tokens,
        completion_tokens: response.data.usage.completion_tokens,
        prompt_cache_hit_tokens: response.data.usage.prompt_cache_hit_tokens,
        prompt_cache_miss_tokens: response.data.usage.prompt_cache_miss_tokens
      }
    : null;

  let cacheInfo = '';
  if (usage?.prompt_cache_hit_tokens != null && usage?.prompt_cache_miss_tokens != null) {
    const hit = usage.prompt_cache_hit_tokens;
    const miss = usage.prompt_cache_miss_tokens;
    const total = hit + miss;
    const pct = total > 0 ? ((hit / total) * 100).toFixed(1) : '0.0';
    cacheInfo = ` cache_hit=${hit} cache_miss=${miss} cache_pct=${pct}%`;
  }
  logger.info(`[LLM] DeepSeek response ← ${model} in ${elapsed}ms (${content.length} chars)${cacheInfo}${usage ? ` usage: ${JSON.stringify(usage)}` : ''}`);

  const parsed = tryParseJSON(content);
  if (parsed.ok) {
    const result = parsed.value;
    if (usage) result._usage = usage;
    return result;
  }
  logger.warn(`[LLM] DeepSeek JSON parse error: ${parsed.error.message}`);
  return { raw: content, jsonError: parsed.error.message, _usage: usage };
}

async function callDeepSeekStream(messages, options = {}, onChunk) {
  const model = options.model || DEEPSEEK_MODEL;
  const requestTimeoutMs = safeTimeoutMs(options.requestTimeoutMs, 120000);
  const jsonMode = options.jsonMode !== undefined ? options.jsonMode : LLM_JSON_MODE;
  const apiUrl = options.apiUrl || DEEPSEEK_API_URL;
  const apiKey = options.apiKey || DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('No DeepSeek API key configured');

  const body = {
    model,
    messages,
    temperature: 0.2,
    stream: true
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  if (options.thinkingDisabled) {
    body.thinking = { type: 'disabled' };
  } else if (DEEPSEEK_THINKING_ENABLED) {
    body.thinking = { type: 'enabled' };
    body.reasoning_effort = options.reasoningEffort || DEEPSEEK_REASONING_EFFORT;
  }

  const response = await axios.post(
    apiUrl,
    body,
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: requestTimeoutMs,
      responseType: 'stream'
    }
  );

  const stream = response.data;
  let accumulated = '';
  let done = false;

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (done) return;
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') {
        done = true;
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
      } catch (e) {
        // Ignore malformed lines
      }
    });

    rl.on('close', () => {
      if (!done) {
        onChunk('', accumulated, true);
      }
      resolve(accumulated);
    });

    stream.on('error', (err) => {
      reject(err);
    });
  });
}

/* ---------- Timeout wrapper ---------- */
function withTimeout(promise, ms, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function resolvePrimaryModel(modelOverride) {
  if (modelOverride) return modelOverride;
  if (dynamicConfig.model) return dynamicConfig.model;
  if (dynamicConfig.provider === 'xiaomi') return XIAOMI_MODEL;
  if (dynamicConfig.provider === 'deepseek') return DEEPSEEK_MODEL;
  if (AI_PROVIDER === 'opencode') return OPENCODE_MODEL;
  if (AI_PROVIDER === 'openrouter') return OPENROUTER_MODEL;
  if (AI_PROVIDER === 'deepseek') return DEEPSEEK_MODEL;
  return AI_MODEL;
}

function resolveFallbackModel(primaryModel, fallbackModelOverride) {
  if (fallbackModelOverride !== undefined) return fallbackModelOverride || '';
  if (dynamicConfig.fallbackModel) return dynamicConfig.fallbackModel;
  if (dynamicConfig.provider === 'xiaomi') {
    if (XIAOMI_FALLBACK_MODEL === primaryModel) return '';
    return XIAOMI_FALLBACK_MODEL;
  }
  if (dynamicConfig.provider === 'deepseek') {
    if (DEEPSEEK_FALLBACK_MODEL === primaryModel) return '';
    return DEEPSEEK_FALLBACK_MODEL;
  }
  if (AI_PROVIDER === 'opencode') return OPENCODE_FALLBACK_MODEL;
  if (AI_PROVIDER === 'openrouter') {
    if (OPENROUTER_FALLBACK_MODEL === primaryModel) return '';
    return OPENROUTER_FALLBACK_MODEL;
  }
  if (AI_PROVIDER === 'deepseek') {
    if (DEEPSEEK_FALLBACK_MODEL === primaryModel) return '';
    return DEEPSEEK_FALLBACK_MODEL;
  }

  if (AI_FALLBACK_MODEL === primaryModel) return '';
  return AI_FALLBACK_MODEL;
}

function shouldRetryWithFallback(error, fallbackModel) {
  if (!fallbackModel) return false;
  if (!error) return false;

  const message = String(error.message || error);
  // Do NOT retry on client errors (bad request, auth, etc.)
  if (error.response && error.response.status >= 400 && error.response.status < 500) {
    const clientErrors = [400, 401, 403, 422];
    if (clientErrors.includes(error.response.status)) return false;
  }
  // Retry on server errors, timeouts, network issues, parse errors
  if (message.includes('timeout')) return true;
  if (error.code === 'ECONNABORTED') return true;
  if (error.code === 'ECONNRESET') return true;
  if (error.code === 'ETIMEDOUT') return true;
  if (error.response && error.response.status >= 500) return true;
  if (message.includes('Cannot read properties of null')) return true;
  if (message.includes('Cannot read property')) return true;
  if (message.includes('Unexpected token')) return true;
  if (message.includes('JSON parse')) return true;
  if (message.includes('network')) return true;
  if (message.includes('ECONN')) return true;
  return false;
}

function buildUserTextFromMessages(messages) {
  return (messages || [])
    .filter(message => message?.role !== 'system')
    .map(message => `[${message.role || 'user'}]\n${message.content || ''}`)
    .join('\n\n');
}

function buildSystemText(system, messages) {
  if (system) return system;
  return (messages || [])
    .filter(message => message?.role === 'system')
    .map(message => message.content || '')
    .join('\n\n');
}

async function executeProviderCall({ provider, system, messages, userText, model, timeoutMs, cachePrompt, thinkingDisabled, reasoningEffort }) {
  const requestTimeoutMs = safeTimeoutMs(timeoutMs, DEFAULT_LLM_TIMEOUT_MS) + 10000;

  if (provider === 'opencode') {
    return callOpenCodeAI(system, userText, { model, requestTimeoutMs });
  }
  if (provider === 'openrouter') {
    return callOpenRouterAI(messages, { model, requestTimeoutMs, cachePrompt, systemText: system });
  }
  if (provider === 'xiaomi') {
    logger.info(`[LLM] Xiaomi direct API → ${model}`);
    return callOpenAICompat(messages, {
      model,
      requestTimeoutMs,
      apiUrl: XIAOMI_API_URL,
      apiKey: dynamicConfig.apiKey || XIAOMI_API_KEY,
      thinkingDisabled: true
    });
  }
  if (provider === 'deepseek') {
    // Log prefix size for cache optimization even though DeepSeek cache is automatic
    if (system && CACHE_BREAKPOINT_ENABLED) {
      const builder = new CacheMessageBuilder('deepseek', model);
      builder.build(messages, system, false); // false = don't mutate, just log
    }
    return callDeepSeekAI(messages, {
      model,
      requestTimeoutMs,
      apiUrl: dynamicConfig.apiUrl || DEEPSEEK_API_URL,
      apiKey: dynamicConfig.apiKey || DEEPSEEK_API_KEY,
      thinkingDisabled,
      reasoningEffort
    });
  }
  return callOpenAICompat(messages, { model, requestTimeoutMs, thinkingDisabled });
}

/* ---------- Unified LLM call ---------- */
async function callLLM({
  system,
  messages,
  userText,
  timeoutMs = DEFAULT_LLM_TIMEOUT_MS,
  fallbackTimeoutMs = DEFAULT_LLM_FALLBACK_TIMEOUT_MS,
  modelOverride,
  fallbackModel,
  label = 'LLM call',
  cachePrompt = false,
  thinkingDisabled = false,
  reasoningEffort = null,
  systemReminder = null
}) {
  // messages ha priorità se passato
  let msgs = messages || [
    { role: 'system', content: system },
    { role: 'user', content: userText }
  ];

  // System-reminder injection: append contextual nudge to last user message without rebuilding system prompt
  if (systemReminder) {
    const lastUserIdx = msgs.findLastIndex(m => m.role === 'user');
    if (lastUserIdx >= 0) {
      const original = msgs[lastUserIdx].content;
      msgs[lastUserIdx] = {
        ...msgs[lastUserIdx],
        content: `<system-reminder>\n${systemReminder}\n</system-reminder>\n\n${original}`
      };
      logger.debug(`[LLM] Injected system-reminder (${systemReminder.length} chars) into message ${lastUserIdx}`);
    }
  }

  const provider = dynamicConfig.provider || AI_PROVIDER;
  if (provider !== 'opencode' && !msgs) {
    throw new Error('No LLM messages provided');
  }
  const activeApiKey = dynamicConfig.apiKey || AI_API_KEY || XIAOMI_API_KEY || OPENROUTER_API_KEY || DEEPSEEK_API_KEY;
  if ((provider === 'openai' || provider === 'xiaomi' || provider === 'deepseek') && !activeApiKey) {
    throw new Error(`No API key configured for provider: ${provider}`);
  }

  const primaryModel = resolvePrimaryModel(modelOverride);
  const systemText = buildSystemText(system, msgs);
  const userInput = userText || buildUserTextFromMessages(msgs);

  try {
    logger.info(`[LLM] ${label} start → [${provider}] ${primaryModel} (timeout ${timeoutMs}ms)`);
    const promise = executeProviderCall({
      provider,
      system: systemText,
      messages: msgs,
      userText: userInput,
      model: primaryModel,
      timeoutMs,
      cachePrompt,
      thinkingDisabled,
      reasoningEffort
    });
    const result = await withTimeout(promise, timeoutMs, label);
    logger.info(`[LLM] ${label} success ← [${provider}] ${primaryModel}`);
    return result;
  } catch (error) {
    const rescueModel = resolveFallbackModel(primaryModel, fallbackModel);
    logger.warn(`[LLM] ${label} failed on ${primaryModel}: ${error.message}. Fallback model: ${rescueModel || 'none'}`);
    if (!shouldRetryWithFallback(error, rescueModel)) {
      logger.error(`[LLM] ${label} no retry. Final error: ${error.message}`);
      throw error;
    }

    // When xiaomi fails with a non-xiaomi fallback model (e.g. deepseek), route through OpenRouter
    const rescueProvider = (provider === 'xiaomi' && rescueModel && !rescueModel.startsWith('mimo'))
      ? 'openrouter'
      : provider;
    logger.info(`[LLM] ${label} retry → ${rescueProvider}/${rescueModel} (timeout ${fallbackTimeoutMs}ms)`);
    const rescuePromise = executeProviderCall({
      provider: rescueProvider,
      system: systemText,
      messages: msgs,
      userText: userInput,
      model: rescueModel,
      timeoutMs: fallbackTimeoutMs,
      cachePrompt,
      thinkingDisabled,
      reasoningEffort
    });
    return withTimeout(rescuePromise, fallbackTimeoutMs, `${label} fallback`);
  }
}

/* ---------- Streaming helpers ---------- */
const { Readable } = require('stream');
const readline = require('readline');

async function callOpenRouterAIStream(messages, options = {}, onChunk) {
  const model = options.model || OPENROUTER_MODEL;
  const requestTimeoutMs = safeTimeoutMs(options.requestTimeoutMs, 120000);
  const jsonMode = options.jsonMode !== undefined ? options.jsonMode : LLM_JSON_MODE;
  logger.info(`[LLM] OpenRouter stream → ${model}`);

  const body = {
    model,
    messages,
    temperature: 0.2,
    stream: true
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const response = await axios.post(
    'https://openrouter.ai/api/v1/chat/completions',
    body,
    {
      headers: {
        'Authorization': `Bearer ${dynamicConfig.apiKey || OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://localhost:3000',
        'X-Title': 'Excel AI Agent'
      },
      timeout: requestTimeoutMs,
      responseType: 'stream'
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
      if (err) reject(err);
      else resolve(value);
    }

    let timeoutId;
    if (options.maxTotalMs && options.maxTotalMs > 0) {
      timeoutId = setTimeout(() => {
        finish(new Error(`Streaming max time exceeded (${options.maxTotalMs}ms)`));
      }, options.maxTotalMs);
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
        const deltaReasoning = parsed.choices?.[0]?.delta?.reasoning || '';
        const delta = deltaContent || deltaReasoning;
        if (delta) {
          accumulated += delta;
          onChunk(delta, accumulated, false);
        }
      } catch (e) {
        // Ignore malformed lines
      }
    });

    rl.on('close', () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (!done) {
        onChunk('', accumulated, true);
      }
      finish(null, accumulated);
    });

    stream.on('error', (err) => {
      if (timeoutId) clearTimeout(timeoutId);
      finish(err);
    });
  });
}

async function callOpenAICompatStream(messages, options = {}, onChunk) {
  const model = options.model || AI_MODEL;
  const requestTimeoutMs = safeTimeoutMs(options.requestTimeoutMs, 120000);
  const jsonMode = options.jsonMode !== undefined ? options.jsonMode : LLM_JSON_MODE;
  const apiUrl = options.apiUrl || AI_API_URL;
  const apiKey = options.apiKey || AI_API_KEY;
  if (!apiKey) throw new Error('No API key configured');

  const body = {
    model,
    messages,
    temperature: 0.2,
    stream: true
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  if (options.thinkingDisabled) body.thinking = { type: 'disabled' };

  const response = await axios.post(
    apiUrl,
    body,
    {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: requestTimeoutMs,
      responseType: 'stream'
    }
  );

  const stream = response.data;
  let accumulated = '';
  let done = false;

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (done) return;
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') {
        done = true;
        onChunk('', accumulated, true);
        return;
      }
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content || '';
        if (delta) {
          accumulated += delta;
          onChunk(delta, accumulated, false);
        }
      } catch (e) {
        // Ignore malformed lines
      }
    });

    rl.on('close', () => {
      if (!done) {
        onChunk('', accumulated, true);
      }
      resolve(accumulated);
    });

    stream.on('error', (err) => {
      reject(err);
    });
  });
}

async function callLLMStreaming({
  system,
  messages,
  userText,
  modelOverride,
  label = 'LLM stream',
  onChunk,
  thinkingDisabled = false,
  reasoningEffort = null,
  systemReminder = null
}) {
  let msgs = messages || [
    { role: 'system', content: system },
    { role: 'user', content: userText }
  ];

  // System-reminder injection for streaming calls
  if (systemReminder) {
    const lastUserIdx = msgs.findLastIndex(m => m.role === 'user');
    if (lastUserIdx >= 0) {
      const original = msgs[lastUserIdx].content;
      msgs[lastUserIdx] = {
        ...msgs[lastUserIdx],
        content: `<system-reminder>\n${systemReminder}\n</system-reminder>\n\n${original}`
      };
    }
  }

  const provider = dynamicConfig.provider || AI_PROVIDER;
  const primaryModel = resolvePrimaryModel(modelOverride);
  const systemText = buildSystemText(system, msgs);
  const userInput = userText || buildUserTextFromMessages(msgs);

  // Rebuild messages with system text resolved
  const finalMessages = systemText
    ? [{ role: 'system', content: systemText }, ...msgs.filter(m => m.role !== 'system')]
    : msgs;

  if (provider === 'openrouter' || provider === 'openai' || provider === 'xiaomi' || provider === 'deepseek') {
    logger.info(`[LLM] ${label} stream start → [${provider}] ${primaryModel}`);
    const start = Date.now();
    const maxStreamMs = Number(process.env.LLM_STREAM_MAX_MS) || 30000;
    try {
      let accumulated;
      if (provider === 'openrouter') {
        accumulated = await callOpenRouterAIStream(finalMessages, { model: primaryModel, maxTotalMs: maxStreamMs }, onChunk);
      } else if (provider === 'deepseek') {
        accumulated = await callDeepSeekStream(finalMessages, {
          model: primaryModel,
          maxTotalMs: maxStreamMs,
          apiUrl: dynamicConfig.apiUrl || DEEPSEEK_API_URL,
          apiKey: dynamicConfig.apiKey || DEEPSEEK_API_KEY,
          thinkingDisabled,
          reasoningEffort
        }, onChunk);
      } else {
        accumulated = await callOpenAICompatStream(finalMessages, {
          model: primaryModel,
          maxTotalMs: maxStreamMs,
          apiUrl: provider === 'xiaomi' ? XIAOMI_API_URL : undefined,
          apiKey: provider === 'xiaomi' ? (dynamicConfig.apiKey || XIAOMI_API_KEY) : undefined,
          thinkingDisabled: provider === 'xiaomi'
        }, onChunk);
      }
      const elapsed = Date.now() - start;
      logger.info(`[LLM] ${label} stream done ← [${provider}] ${primaryModel} in ${elapsed}ms (${accumulated.length} chars)`);
      return accumulated;
    } catch (error) {
      logger.error(`[LLM] ${label} stream error: ${error.message}`);
      throw error;
    }
  }

  // Fallback for non-streaming providers: call normally then emit full text
  logger.info(`[LLM] ${label} provider ${provider} does not support streaming; using regular call`);
  const result = await callLLM({ system, messages: finalMessages, userText: userInput, modelOverride, label });
  const text = result && typeof result === 'object' ? JSON.stringify(result) : String(result);
  onChunk(text, text, true);
  return text;
}

module.exports = { callLLM, callLLMStreaming, setLLMConfig, getLLMConfig };
