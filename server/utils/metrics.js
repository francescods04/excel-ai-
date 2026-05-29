const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const METRICS_DIR = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'metrics')
  : path.join(__dirname, '..', 'metrics');
if (!fs.existsSync(METRICS_DIR)) {
  try { fs.mkdirSync(METRICS_DIR, { recursive: true }); } catch (_) {}
}

function getTodayFile() {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(METRICS_DIR, `${date}.jsonl`);
}

function logMetric(record) {
  const line = JSON.stringify({
    ts: Date.now(),
    ...record
  });
  try {
    fs.appendFileSync(getTodayFile(), line + '\n');
  } catch (e) {
    logger.warn(`[Metrics] Cannot write metric: ${e.message}`);
  }
}

function readMetrics(sinceMs = null) {
  try {
    const files = fs.readdirSync(METRICS_DIR).filter(f => f.endsWith('.jsonl')).sort();
    const records = [];
    for (const file of files) {
      const content = fs.readFileSync(path.join(METRICS_DIR, file), 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const r = JSON.parse(line);
          if (!sinceMs || r.ts >= sinceMs) records.push(r);
        } catch (_) {}
      }
    }
    return records;
  } catch (e) {
    return [];
  }
}

function summarizeMetrics(sinceMs = null) {
  const records = readMetrics(sinceMs);
  if (records.length === 0) return { count: 0 };

  const byProvider = {};
  const byModel = {};
  let totalLatency = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let successCount = 0;
  let errorCount = 0;

  for (const r of records) {
    const provider = r.provider || 'unknown';
    const model = r.model || 'unknown';
    if (!byProvider[provider]) byProvider[provider] = { count: 0, latency: 0, errors: 0 };
    if (!byModel[model]) byModel[model] = { count: 0, latency: 0, errors: 0 };

    byProvider[provider].count++;
    byModel[model].count++;
    if (r.latency_ms) {
      byProvider[provider].latency += r.latency_ms;
      byModel[model].latency += r.latency_ms;
      totalLatency += r.latency_ms;
    }
    if (r.error) {
      byProvider[provider].errors++;
      byModel[model].errors++;
      errorCount++;
    } else {
      successCount++;
    }
    if (r.prompt_tokens) totalPromptTokens += r.prompt_tokens;
    if (r.completion_tokens) totalCompletionTokens += r.completion_tokens;
  }

  return {
    count: records.length,
    since: sinceMs ? new Date(sinceMs).toISOString() : 'all',
    latency: {
      avg_ms: Math.round(totalLatency / records.length),
      total_ms: totalLatency
    },
    tokens: {
      prompt_total: totalPromptTokens,
      completion_total: totalCompletionTokens,
      estimated_cost_usd: Math.round((totalPromptTokens * 0.0006 + totalCompletionTokens * 0.0025)) / 1000 // OpenRouter Kimi K2.6 rates
    },
    success_rate: Math.round((successCount / records.length) * 100),
    byProvider,
    byModel
  };
}

module.exports = { logMetric, readMetrics, summarizeMetrics };
