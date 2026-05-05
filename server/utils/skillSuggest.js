/*
 * Auto-skill suggest: detect keywords in user messages and recommend skill preloading.
 * This saves one tool call when the user clearly asks for a known financial modeling task.
 */

const SKILL_KEYWORDS = {
  'dcf-model': [
    'dcf', 'discounted cash flow', 'free cash flow', 'fcff', 'fcfe', 'enterprise value',
    'unlevered', 'levered', 'terminal value', 'perpetuity growth', 'exit multiple',
    'cost of equity', 'wacc', 'npv', 'intrinsic value'
  ],
  'wacc-model': [
    'wacc', 'weighted average cost of capital', 'cost of debt', 'cost of equity',
    'capital structure', 'debt/equity ratio', 'ke', 'kd', 'beta levered'
  ],
  'lbo-model': [
    'lbo', 'leveraged buyout', 'buyout', 'pe model', 'sponsor returns',
    'irr', 'moic', 'entry multiple', 'exit multiple', 'debt schedule',
    'revolver', 'credit facility', 'sponsor equity'
  ],
  'comps-analysis': [
    'comps', 'comparable', 'trading comps', 'precedent transaction',
    'ev/ebitda', 'p/e ratio', 'multiple analysis', 'valuation multiple',
    'peer analysis', 'benchmark'
  ],
  'three-statement': [
    'three statement', '3 statement', 'financial model', 'income statement',
    'balance sheet', 'cash flow statement', 'forecast', 'projection',
    'revenue build', 'operating model', 'integrated model'
  ],
  'clean-data': [
    'clean data', 'normalize data', 'data quality', 'remove duplicates',
    'fill blanks', 'standardize', 'parse', 'import data', 'etl'
  ],
  'audit-xls': [
    'audit', 'check formula', 'find error', 'circular reference', 'broken link',
    'validate', 'review model', 'model audit', 'sensitivity check'
  ]
};

function detectSkills(text) {
  const lower = String(text).toLowerCase();
  const matched = new Set();
  for (const [skill, keywords] of Object.entries(SKILL_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        matched.add(skill);
        break;
      }
    }
  }
  return Array.from(matched);
}

module.exports = { detectSkills, SKILL_KEYWORDS };
