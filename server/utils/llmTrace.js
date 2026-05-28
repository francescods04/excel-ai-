const fs = require('fs');
const path = require('path');

const logger = require('./logger');

const TRACE_DIR = process.env.LLM_TRACE_DIR || path.join(__dirname, '..', '..', 'data', 'llm-traces');
const TRACE_ENABLED = process.env.LLM_TRACE_ENABLED !== 'false';
const TRACE_CAPTURE_CONTENT = process.env.LLM_TRACE_CAPTURE_CONTENT !== 'false';
const TRACE_MAX_STRING_CHARS = Math.max(500, Number(process.env.LLM_TRACE_MAX_STRING_CHARS) || 50000);
const TRACE_MAX_ARRAY_ITEMS = Math.max(10, Number(process.env.LLM_TRACE_MAX_ARRAY_ITEMS) || 200);
const TRACE_MAX_OBJECT_KEYS = Math.max(10, Number(process.env.LLM_TRACE_MAX_OBJECT_KEYS) || 200);
const TRACE_MAX_FILES_TO_SCAN = Math.max(1, Number(process.env.LLM_TRACE_MAX_FILES_TO_SCAN) || 31);

let dirReady = false;

function ensureTraceDir() {
  if (!TRACE_ENABLED || dirReady) return;
  try {
    fs.mkdirSync(TRACE_DIR, { recursive: true });
    dirReady = true;
  } catch (error) {
    logger.warn(`[LLMTrace] Cannot create trace dir ${TRACE_DIR}: ${error.message}`);
  }
}

function makeTraceId() {
  return `llm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function truncateString(value, maxChars = TRACE_MAX_STRING_CHARS) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  const removed = text.length - maxChars;
  return `${text.slice(0, maxChars)}… [truncated ${removed} chars]`;
}

function sanitizeValue(value, depth = 0) {
  if (value == null) return value;
  if (depth > 8) return '[max-depth]';
  if (typeof value === 'string') {
    return TRACE_CAPTURE_CONTENT ? truncateString(value) : `[content omitted (${value.length} chars)]`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const items = value.slice(0, TRACE_MAX_ARRAY_ITEMS).map(item => sanitizeValue(item, depth + 1));
    if (value.length > TRACE_MAX_ARRAY_ITEMS) {
      items.push(`[${value.length - TRACE_MAX_ARRAY_ITEMS} more items truncated]`);
    }
    return items;
  }
  if (typeof value === 'object') {
    const out = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, TRACE_MAX_OBJECT_KEYS)) {
      out[key] = sanitizeValue(value[key], depth + 1);
    }
    if (keys.length > TRACE_MAX_OBJECT_KEYS) {
      out.__truncatedKeys = keys.length - TRACE_MAX_OBJECT_KEYS;
    }
    return out;
  }
  return truncateString(String(value));
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch (_) {
    return String(content);
  }
}

function sanitizeMessages(messages = []) {
  return messages.map((message, index) => {
    const text = contentToText(message?.content);
    return {
      index,
      role: message?.role || 'unknown',
      chars: text.length,
      content: TRACE_CAPTURE_CONTENT ? truncateString(text) : `[content omitted (${text.length} chars)]`,
    };
  });
}

function summarizeMessages(messages = []) {
  const summary = {
    count: messages.length,
    chars: 0,
    byRole: {},
  };
  for (const message of messages) {
    const role = message?.role || 'unknown';
    const chars = contentToText(message?.content).length;
    summary.chars += chars;
    summary.byRole[role] = {
      count: (summary.byRole[role]?.count || 0) + 1,
      chars: (summary.byRole[role]?.chars || 0) + chars,
    };
  }
  return summary;
}

function getTraceFileName(tsIso) {
  const date = String(tsIso || new Date().toISOString()).slice(0, 10);
  return path.join(TRACE_DIR, `${date}.jsonl`);
}

function writeLlmTrace(record = {}) {
  if (!TRACE_ENABLED) return false;
  ensureTraceDir();
  const payload = {
    ts: record.ts || new Date().toISOString(),
    ...record,
  };

  if (Array.isArray(record.messages)) {
    payload.messageSummary = summarizeMessages(record.messages);
    payload.messages = sanitizeMessages(record.messages);
  }
  if (record.response !== undefined) payload.response = sanitizeValue(record.response);
  if (record.responseText !== undefined) payload.responseText = sanitizeValue(record.responseText);
  if (record.error !== undefined) payload.error = sanitizeValue(record.error);
  if (record.extra !== undefined) payload.extra = sanitizeValue(record.extra);
  if (record.context !== undefined) payload.context = sanitizeValue(record.context);

  try {
    fs.appendFileSync(getTraceFileName(payload.ts), JSON.stringify(payload) + '\n');
    return true;
  } catch (error) {
    logger.warn(`[LLMTrace] Cannot write trace: ${error.message}`);
    return false;
  }
}

function listTraceFiles() {
  try {
    return fs.readdirSync(TRACE_DIR)
      .filter(name => name.endsWith('.jsonl'))
      .sort()
      .slice(-TRACE_MAX_FILES_TO_SCAN);
  } catch (_) {
    return [];
  }
}

function matchesFilters(record, filters = {}) {
  if (filters.turnId && record.turnId !== filters.turnId) return false;
  if (filters.traceId && record.traceId !== filters.traceId) return false;
  if (filters.eventType && record.eventType !== filters.eventType) return false;
  if (filters.label && record.label !== filters.label) return false;
  if (filters.role && record.role !== filters.role) return false;
  if (filters.attempt && record.attempt !== filters.attempt) return false;
  if (filters.provider && record.provider !== filters.provider) return false;
  if (filters.model && record.model !== filters.model) return false;
  if (filters.sinceMs) {
    const ts = Date.parse(record.ts || '');
    if (!Number.isFinite(ts) || ts < filters.sinceMs) return false;
  }
  return true;
}

function makeSummaryBucket() {
  return {
    count: 0,
    requests: 0,
    responses: 0,
    errors: 0,
    fallbacks: 0,
    latencyMs: 0,
    avgLatencyMs: 0,
    promptTokens: 0,
    completionTokens: 0,
  };
}

function updateSummaryBucket(bucket, record) {
  bucket.count += 1;
  if (record.eventType === 'llm.request') bucket.requests += 1;
  if (record.eventType === 'llm.response') bucket.responses += 1;
  if (record.eventType === 'llm.error') bucket.errors += 1;
  if (record.eventType === 'llm.fallback') bucket.fallbacks += 1;
  if (record.latencyMs) bucket.latencyMs += record.latencyMs;
  if (record.usage?.prompt_tokens) bucket.promptTokens += record.usage.prompt_tokens;
  if (record.usage?.completion_tokens) bucket.completionTokens += record.usage.completion_tokens;
}

function readLlmTraces(filters = {}) {
  const limit = Math.max(1, Number(filters.limit) || 100);
  const descending = filters.descending !== false;
  const files = listTraceFiles();
  const fileOrder = descending ? [...files].reverse() : files;
  const records = [];

  outer:
  for (const file of fileOrder) {
    const filePath = path.join(TRACE_DIR, file);
    let lines;
    try {
      lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    } catch (_) {
      continue;
    }
    const lineOrder = descending ? [...lines].reverse() : lines;
    for (const line of lineOrder) {
      try {
        const record = JSON.parse(line);
        if (!matchesFilters(record, filters)) continue;
        records.push(record);
        if (records.length >= limit) break outer;
      } catch (_) {
        // Skip malformed lines
      }
    }
  }
  return records;
}

function summarizeLlmTraces(filters = {}) {
  const records = readLlmTraces({ ...filters, limit: filters.summaryLimit || 10000, descending: true });
  const summary = {
    count: records.length,
    requests: 0,
    responses: 0,
    errors: 0,
    fallbacks: 0,
    totalLatencyMs: 0,
    avgLatencyMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    newestTs: records[0]?.ts || null,
    oldestTs: records[records.length - 1]?.ts || null,
    byModel: {},
    byLabel: {},
    byRole: {},
    byAttempt: {},
    byProvider: {},
    byEventType: {},
  };

  for (const record of records) {
    if (record.eventType === 'llm.request') summary.requests += 1;
    if (record.eventType === 'llm.response') summary.responses += 1;
    if (record.eventType === 'llm.error') summary.errors += 1;
    if (record.eventType === 'llm.fallback') summary.fallbacks += 1;

    if (record.latencyMs) summary.totalLatencyMs += record.latencyMs;
    if (record.usage?.prompt_tokens) summary.promptTokens += record.usage.prompt_tokens;
    if (record.usage?.completion_tokens) summary.completionTokens += record.usage.completion_tokens;

    const modelKey = record.model || 'unknown';
    if (!summary.byModel[modelKey]) {
      summary.byModel[modelKey] = makeSummaryBucket();
    }
    updateSummaryBucket(summary.byModel[modelKey], record);

    const labelKey = record.label || 'unknown';
    if (!summary.byLabel[labelKey]) {
      summary.byLabel[labelKey] = makeSummaryBucket();
    }
    updateSummaryBucket(summary.byLabel[labelKey], record);

    const roleKey = record.role || 'unknown';
    if (!summary.byRole[roleKey]) {
      summary.byRole[roleKey] = makeSummaryBucket();
    }
    updateSummaryBucket(summary.byRole[roleKey], record);

    const attemptKey = record.attempt || 'unknown';
    if (!summary.byAttempt[attemptKey]) {
      summary.byAttempt[attemptKey] = makeSummaryBucket();
    }
    updateSummaryBucket(summary.byAttempt[attemptKey], record);

    const providerKey = record.provider || 'unknown';
    if (!summary.byProvider[providerKey]) {
      summary.byProvider[providerKey] = makeSummaryBucket();
    }
    updateSummaryBucket(summary.byProvider[providerKey], record);

    const eventTypeKey = record.eventType || 'unknown';
    if (!summary.byEventType[eventTypeKey]) {
      summary.byEventType[eventTypeKey] = makeSummaryBucket();
    }
    updateSummaryBucket(summary.byEventType[eventTypeKey], record);
  }

  const responseLatencyDivisor = summary.responses || 1;
  summary.avgLatencyMs = Math.round(summary.totalLatencyMs / responseLatencyDivisor);
  for (const bucket of [
    ...Object.values(summary.byModel),
    ...Object.values(summary.byLabel),
    ...Object.values(summary.byRole),
    ...Object.values(summary.byAttempt),
    ...Object.values(summary.byProvider),
    ...Object.values(summary.byEventType),
  ]) {
    const divisor = bucket.responses || 1;
    bucket.avgLatencyMs = Math.round(bucket.latencyMs / divisor);
  }
  return summary;
}

module.exports = {
  TRACE_DIR,
  TRACE_ENABLED,
  TRACE_CAPTURE_CONTENT,
  makeTraceId,
  writeLlmTrace,
  readLlmTraces,
  summarizeLlmTraces,
};
