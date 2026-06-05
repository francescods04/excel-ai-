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

// Sheet name patterns that benefit from the pro model. Critical reasoning sheets.
// Conservative: pro adds 3-5x latency per call. Only flag sheets with highest
// quality lever (Sensitivity = closed-form math, Returns = IRR/NPV logic).
const PRO_SHEET_PATTERNS = [
  'sensitivity', 'sensitivityaccrdil', 'sensitivityirr',
  'accretion_dilution', 'accretiondilution',
  'returns', 'valuation', 'investorreturns',
];

function isProSheet(sheetName) {
  const k = String(sheetName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return PRO_SHEET_PATTERNS.some(p => k.includes(p));
}

// Pick model for a slice based on its sheet type.
// Respects user override; CF_MODEL_ALL=pro|flash forces global override.
// Pro routing OPT-IN via CF_PRO_SLICES=1 — benchmarks showed mixed quality with 3-5x latency.
function pickModelForSlice(slice, userOverride) {
  if (userOverride) return userOverride;
  if (process.env.CF_MODEL_ALL === 'pro') return MODEL_TIERS.pro;
  if (process.env.CF_MODEL_ALL === 'flash') return MODEL_TIERS.flash;
  if (!process.env.CF_PRO_SLICES) return MODEL_TIERS.flash;
  if (!slice || !slice.sheet) return MODEL_TIERS.flash;
  return isProSheet(slice.sheet) ? MODEL_TIERS.pro : MODEL_TIERS.flash;
}

module.exports = {
  selectModel,
  pickModelForSlice,
  isProSheet,
  MODEL_TIERS,
  TASK_DEFAULTS,
};
