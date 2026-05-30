/*
 * Auto-skill suggest: detect keywords in user messages and recommend skill preloading.
 * This saves one tool call when the user clearly asks for a known financial modeling task.
 */

const SKILL_KEYWORDS = {
  'business-plan': [
    'business plan', 'bp', 'investor', 'investors', 'investitori', 'institutional',
    'istituzional', 'catena', 'chain', 'fast food', 'restaurant', 'ristorante',
    'menu', 'single location', 'location', 'milano', 'milan', 'owned location',
    'not franchise', 'franchising', 'unit economics', 'use of funds', 'payback'
  ],
  'formatting-finance': [
    'formatting', 'formattazione', 'format', 'polish', 'precisione', 'preciso',
    'investor-ready', 'presentation-ready', 'presentazione', 'ib-grade',
    'stile', 'dashboard', 'kpi', 'readable', 'leggibile'
  ],
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

// Rank skills by how SPECIFICALLY they matched the user message (number of
// distinct keyword hits) and cap the auto-preload size. Each skill markdown is
// ~10–15KB in the prompt: loading 4 skills adds 50KB before the first LLM call
// and slows planning. Capping at 2 keeps the most-relevant context while
// trimming the prompt by ~30KB.
const MAX_AUTO_PRELOAD =
  Number(process.env.AGENT_AUTO_SKILL_MAX) > 0
    ? Number(process.env.AGENT_AUTO_SKILL_MAX)
    : 2;

function detectSkills(text) {
  const lower = String(text).toLowerCase();
  const scored = [];
  const restaurantBusinessPlan =
    /(business plan|\bbp\b|investor|investitori|institutional|istituzional)/i.test(lower) &&
    /(restaurant|ristorante|fast food|menu|single location|location|milano|milan|catena|owned location|franchising)/i.test(lower);
  const explicitLbo =
    /\b(lbo|leveraged buyout|buyout|entry multiple|exit multiple|sponsor returns|sponsor equity|debt schedule|moic)\b/i.test(lower);
  for (const [skill, keywords] of Object.entries(SKILL_KEYWORDS)) {
    let hits = 0;
    let firstIdx = Infinity;
    for (const kw of keywords) {
      const idx = lower.indexOf(kw);
      if (idx >= 0) {
        hits += 1;
        if (idx < firstIdx) firstIdx = idx;
      }
    }
    if (skill === 'business-plan' && restaurantBusinessPlan) hits += 4;
    if (skill === 'formatting-finance' && /(formatting|formattazione|polish|investor-ready|presentation-ready|precisione)/i.test(lower)) hits += 2;
    if (skill === 'lbo-model' && restaurantBusinessPlan && !explicitLbo) hits = 0;
    if (hits > 0) scored.push({ skill, hits, firstIdx });
  }
  // Most keyword hits first; tie-break by earliest mention in the message.
  scored.sort((a, b) => b.hits - a.hits || a.firstIdx - b.firstIdx);
  return scored.slice(0, MAX_AUTO_PRELOAD).map(s => s.skill);
}

module.exports = { detectSkills, SKILL_KEYWORDS, MAX_AUTO_PRELOAD };
