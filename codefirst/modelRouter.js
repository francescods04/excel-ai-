'use strict';

/**
 * Model Router — selects the best DeepSeek model for each task type.
 *
 * Strategy:
 * - pro   = high-quality, slower, more expensive. Use for: plan, generate_critical, repair, deep_critic.
 * - flash = fast, cheaper, good for large context. Use for: research, generate_simple, structural_critic.
 *
 * The router also respects any user-provided modelOverride.
 */

const MODEL_TIERS = {
  pro: 'deepseek-v4-pro',
  flash: 'deepseek-v4-flash',
};

const TASK_DEFAULTS = {
  research: 'flash',
  plan: 'pro',
  generate_simple: 'flash',
  generate_critical: 'pro',
  structural_critic: 'flash',
  deep_critic: 'pro',
  repair: 'pro',
  default: 'flash',
};

function selectModel(taskType, options = {}) {
  const { modelOverride = null, preferPro = false, preferFlash = false } = options;

  // 1. Explicit override always wins
  if (modelOverride) return modelOverride;

  // 2. Global env override for testing
  const envModel = process.env.LLM_MODEL_DEFAULT;
  if (envModel) return envModel;

  // 3. Prefer flags
  if (preferPro) return MODEL_TIERS.pro;
  if (preferFlash) return MODEL_TIERS.flash;

  // 4. Task-based default
  const tier = TASK_DEFAULTS[taskType] || TASK_DEFAULTS.default;
  return MODEL_TIERS[tier];
}

module.exports = {
  selectModel,
  MODEL_TIERS,
  TASK_DEFAULTS,
};
