'use strict';

const PLAYBOOK = {
  shell: {
    method: 'Design the workbook architecture before writing model mechanics.',
    requiredAnalyses: [
      'Create the minimum sheet set required for an institutional valuation.',
      'Keep source data, assumptions, calculations, outputs and checks separated.',
      'Prepare a structure that supports incremental edits in later chat turns.'
    ],
    sanityChecks: [
      'Core valuation sheets exist before formula sections run.',
      'The shell does not overwrite source data unintentionally.'
    ],
    visibleOutputs: ['Model sheet architecture', 'clean tab separation', 'incremental edit targets']
  },
  sources: {
    method: 'Establish provenance before modeling.',
    requiredAnalyses: [
      'Map each model input to workbook, filing, market data or analyst fallback.',
      'Flag stale, missing or conflicting inputs instead of silently replacing them.',
      'Separate local workbook facts from external market assumptions.'
    ],
    sanityChecks: [
      'Every major value used downstream has a visible source row.',
      'Workbook-first data wins when local financials are high-confidence.'
    ],
    visibleOutputs: ['Source register', 'data-quality checklist', 'analyst workplan']
  },
  assumptions: {
    method: 'Build the assumption spine from evidence, not default constants.',
    requiredAnalyses: [
      'Identify historical base year, units, currency and source priority.',
      'Derive revenue, margin, tax, D&A, CapEx and NWC from local data where possible.',
      'Expose every fallback assumption as analyst-reviewable input.',
      'Separate operating drivers from market/WACC inputs and equity bridge inputs.'
    ],
    sanityChecks: [
      'Revenue, EBITDA margin and tax rate are plausible and non-empty.',
      'Capital intensity and working-capital assumptions are visible and linkable.'
    ],
    visibleOutputs: ['Input spine', 'source labels', 'review flags for fallbacks']
  },
  wacc: {
    method: 'Triangulate discount rate from market evidence and capital structure.',
    requiredAnalyses: [
      'Choose risk-free rate, ERP and cost of debt from visible sources or review flags.',
      'Compare observed beta with peer/sector beta and document selected beta.',
      'Unlever and relever peer beta to target D/E when peer evidence is available.',
      'Calculate after-tax debt cost and market-value capital weights.'
    ],
    sanityChecks: [
      'WACC is above terminal growth and within a plausible range.',
      'Selected beta differs materially from observed beta only with a review flag.'
    ],
    visibleOutputs: ['CAPM build', 'debt cost build', 'capital weights', 'beta evidence table']
  },
  dcf: {
    method: 'Build valuation from operating mechanics before outputs.',
    requiredAnalyses: [
      'Project revenue from explicit growth drivers and base-year data.',
      'Build EBITDA, D&A, EBIT, tax, NOPAT, CapEx and working capital step-by-step.',
      'Discount unlevered FCFs using WACC and calculate terminal value from normalized FCF.',
      'Bridge enterprise value to equity value and implied share price.'
    ],
    sanityChecks: [
      'FCF signs, margins and discount factors are coherent across forecast years.',
      'Terminal value spread is positive and terminal value contribution is reviewable.',
      'EV-to-equity bridge ties back to cash, debt and share count.'
    ],
    visibleOutputs: ['Operating forecast', 'FCF bridge', 'terminal value', 'equity bridge']
  },
  sensitivity: {
    method: 'Show range of outcomes, not a single point estimate.',
    requiredAnalyses: [
      'Center the table around base WACC and terminal growth.',
      'Build both implied share price and enterprise value grids.',
      'Use direct formulas that remain auditable without Excel data-table side effects.'
    ],
    sanityChecks: [
      'Base case appears in the grid.',
      'Outputs move in the expected direction as WACC and growth change.'
    ],
    visibleOutputs: ['WACC x terminal growth price grid', 'enterprise value grid', 'heatmap']
  },
  scenarios: {
    method: 'Frame downside/base/upside through operating and valuation drivers.',
    requiredAnalyses: [
      'Vary revenue, margin, WACC and terminal growth together by case.',
      'Tie scenario outputs back to the DCF base model.',
      'Show upside/downside versus current share price.'
    ],
    sanityChecks: [
      'Downside is not more favorable than base without a visible reason.',
      'Scenario outputs are populated for all cases.'
    ],
    visibleOutputs: ['Case matrix', 'valuation bridge by case', 'upside/downside']
  },
  summary: {
    method: 'Convert model mechanics into committee-ready conclusions.',
    requiredAnalyses: [
      'Surface enterprise value, equity value, implied share price and premium/discount.',
      'Summarize key operating and valuation assumptions driving the answer.',
      'Show scenario snapshot so the user sees range and risk.'
    ],
    sanityChecks: [
      'Summary numbers link to model outputs.',
      'No final answer is disconnected from assumptions, WACC, DCF or scenarios.'
    ],
    visibleOutputs: ['Valuation output', 'scenario snapshot', 'key assumptions']
  },
  audit: {
    method: 'Review the model like an analyst before presentation.',
    requiredAnalyses: [
      'Check formula integrity, source coverage and valuation mechanics.',
      'Check WACC, terminal spread, bridge, sensitivity and scenarios.',
      'List next analyst steps for remaining diligence.'
    ],
    sanityChecks: [
      'All core sheets are populated.',
      'All review flags are visible rather than hidden in logs.'
    ],
    visibleOutputs: ['Readiness checks', 'depth coverage checks', 'next analyst steps']
  },
  format: {
    method: 'Format meaningfully, preserving analytical structure.',
    requiredAnalyses: [
      'Style titles, sections, headers, inputs, formulas, totals and checks differently.',
      'Preserve existing formulas and model layout.',
      'Use widths, heights, borders and number formats to make the model reviewable.'
    ],
    sanityChecks: ['Formatting should reveal model semantics, not just repaint cells.'],
    visibleOutputs: ['Readable model surface', 'semantic colors', 'stable layout']
  }
};

function normalizeSection(section = '') {
  const key = String(section || '').toLowerCase().trim();
  if (PLAYBOOK[key]) return key;

  const prefix = key.split(/[.\-_:]/).find(Boolean);
  if (prefix && PLAYBOOK[prefix]) return prefix;
  if (/(projection|forecast|fcf|terminal|enterprise.?value|equity.?value|build_finance_model)/.test(key)) return 'dcf';
  if (/(source|research|data.?map|provenance)/.test(key)) return 'sources';
  if (/(assumption|macro|input|driver)/.test(key)) return 'assumptions';
  if (/(wacc|capm|beta|cost.?of.?equity|cost.?of.?debt|capital.?structure)/.test(key)) return 'wacc';
  if (/(sensitivity|data.?table)/.test(key)) return 'sensitivity';
  if (/(scenario|case.?matrix|downside|upside)/.test(key)) return 'scenarios';
  if (/(summary|output.?view|committee|conclusion)/.test(key)) return 'summary';
  if (/(audit|check|full.?model.?review|repair|review|readiness)/.test(key)) return 'audit';
  if (/(format|formatting|style|cleanup|colour|color|theme|palette)/.test(key)) return 'format';
  return PLAYBOOK[key] ? key : 'dcf';
}

function getAnalystDepth(section = '') {
  const key = normalizeSection(section);
  const entry = PLAYBOOK[key];
  return {
    depthLevel: 'institutional',
    section: key,
    method: entry.method,
    requiredAnalyses: [...entry.requiredAnalyses],
    sanityChecks: [...entry.sanityChecks],
    visibleOutputs: [...entry.visibleOutputs]
  };
}

function getDcfModelAnalystWorkplan() {
  return ['sources', 'assumptions', 'wacc', 'dcf', 'sensitivity', 'scenarios', 'summary', 'audit']
    .map(section => getAnalystDepth(section));
}

function formatAnalystDepthForPrompt(section = '') {
  const depth = getAnalystDepth(section);
  return [
    `Depth level: ${depth.depthLevel}`,
    `Method: ${depth.method}`,
    `Required analyses:\n- ${depth.requiredAnalyses.join('\n- ')}`,
    `Sanity checks:\n- ${depth.sanityChecks.join('\n- ')}`,
    `Visible outputs:\n- ${depth.visibleOutputs.join('\n- ')}`
  ].join('\n');
}

module.exports = {
  getAnalystDepth,
  getDcfModelAnalystWorkplan,
  formatAnalystDepthForPrompt
};
