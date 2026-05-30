// Approximate pricing per 1M tokens (input / output) in USD.
// Keep these up to date with provider pricing pages.
const MODEL_PRICING = {
  // DeepSeek direct
  'deepseek-v4-pro': { input: 0.50, output: 2.00 },
  'deepseek-v4-flash': { input: 0.10, output: 0.40 },
  'deepseek-chat': { input: 0.27, output: 1.10 },

  // OpenRouter prefixes
  'deepseek/deepseek-v4-pro': { input: 0.55, output: 2.20 },
  'deepseek/deepseek-v4-flash': { input: 0.11, output: 0.44 },
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
  // Try normalized match (lowercase, strip extra spaces)
  const normalized = key.toLowerCase();
  for (const [k, v] of Object.entries(MODEL_PRICING)) {
    if (k.toLowerCase() === normalized) return v;
  }
  return MODEL_PRICING['unknown'];
}

/**
 * Estimate cost in USD for a single LLM call.
 * @param {string} model
 * @param {number} promptTokens
 * @param {number} completionTokens
 * @returns {number}
 */
function estimateCost(model, promptTokens = 0, completionTokens = 0) {
  const pricing = getPricing(model);
  const inCost = (promptTokens / 1_000_000) * pricing.input;
  const outCost = (completionTokens / 1_000_000) * pricing.output;
  return inCost + outCost;
}

/**
 * Estimate cost from an array of usage records like { model, tokens_in, tokens_out }.
 * @param {Array<{model?: string, tokens_in?: number, tokens_out?: number}>} records
 * @returns {{totalCost: number, byModel: Record<string, number>}}
 */
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
