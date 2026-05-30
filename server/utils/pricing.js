// Pricing per 1M tokens (input / output) in USD.
// Source: DeepSeek official pricing page (2026-05-30)
//
// DeepSeek V4-Flash:
//   Cache hit:  $0.0028 / 1M input tokens
//   Cache miss: $0.14   / 1M input tokens
//   Output:     $0.28   / 1M output tokens
//
// DeepSeek V4-Pro:
//   Cache hit:  $0.003625 / 1M input tokens
//   Cache miss: $0.435    / 1M input tokens
//   Output:     $0.87    / 1M output tokens
//
// We default to CACHE MISS (full price) for conservative cost estimates.
// Set USE_CACHE_HIT=true to use the cheaper cached-input rate.

const USE_CACHE_HIT = process.env.PRICING_CACHE_HIT === 'true';

const MODEL_PRICING = {
  // DeepSeek direct
  'deepseek-v4-pro': { input: USE_CACHE_HIT ? 0.003625 : 0.435, output: 0.87 },
  'deepseek-v4-flash': { input: USE_CACHE_HIT ? 0.0028 : 0.14, output: 0.28 },
  'deepseek-chat': { input: USE_CACHE_HIT ? 0.0028 : 0.14, output: 0.28 },

  // OpenRouter prefixes (10% markup on top of direct DeepSeek)
  'deepseek/deepseek-v4-pro': { input: USE_CACHE_HIT ? 0.004 : 0.48, output: 0.96 },
  'deepseek/deepseek-v4-flash': { input: USE_CACHE_HIT ? 0.003 : 0.15, output: 0.31 },
  'moonshotai/kimi-k2.6': { input: 2.00, output: 8.00 },
  'openai/gpt-4o-mini': { input: 0.15, output: 0.60 },

  // OpenAI direct
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },

  // Xiaomi / local — unknown or free; treat as zero for dashboard
  'mimo-v2.5-pro': { input: 0, output: 0 },
  'kimi-k2.6': { input: 0, output: 0 },

  // Fallback for unknown models
  'unknown': { input: 0, output: 0 },
};

function getPricing(model = '') {
  const key = String(model).trim();
  if (MODEL_PRICING[key]) return MODEL_PRICING[key];
  const normalized = key.toLowerCase();
  for (const [k, v] of Object.entries(MODEL_PRICING)) {
    if (k.toLowerCase() === normalized) return v;
  }
  return MODEL_PRICING['unknown'];
}

function estimateCost(model, promptTokens = 0, completionTokens = 0) {
  const pricing = getPricing(model);
  const inCost = (promptTokens / 1_000_000) * pricing.input;
  const outCost = (completionTokens / 1_000_000) * pricing.output;
  return inCost + outCost;
}

function estimateCostBatch(records = []) {
  let totalCost = 0;
  const byModel = {};
  for (const r of records) {
    const model = r.model || 'unknown';
    const cost = estimateCost(model, r.tokens_in || 0, r.tokens_out || 0);
    totalCost += cost;
    byModel[model] = (byModel[model] || 0) + cost;
  }
  return { totalCost, byModel };
}

module.exports = { estimateCost, estimateCostBatch, getPricing, MODEL_PRICING };
