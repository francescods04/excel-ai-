'use strict';

/**
 * Generic finance model catalog.
 *
 * The catalog lists the financial model types the agent can build (DCF, LBO,
 * M&A/Accretion-Dilution, Three-Statement, Comps, Credit, DDM) along with
 * suggested section/focus-area playbooks. It is NOT a forced template: the
 * agent uses these as a reference and is encouraged to decide granularity
 * and structure based on user intent + workbook context. Each playbook has
 * a compact (single-pass) and granular (sub-task) section list so the
 * planner (or LLM) can pick.
 */

const MODEL_TYPES = [
  // Finance models
  'dcf', 'lbo', 'm_a', 'three_statement', 'comps', 'credit', 'ddm',
  // Non-finance task types
  'data_analysis', 'dashboard', 'etl_cleanup', 'forecasting', 'optimization', 'custom'
];

const MODEL_ALIASES = {
  dcf: ['dcf', 'discounted cash flow', 'valuation', 'valutazione', 'enterprise value', 'implied share price'],
  lbo: ['lbo', 'leveraged buyout', 'buyout', 'private equity', 'sponsor return', 'irr deal', 'moc multiple'],
  m_a: ['m&a', 'm a ', ' m a$', 'merger', 'acquisition', 'accretion', 'dilution', 'transaction analysis', 'pro forma'],
  three_statement: ['three statement', '3-statement', '3 statement', 'integrated model', 'p&l balance cash flow', 'financial statement model', 'three-statement'],
  comps: ['comps', 'trading comps', 'comparable companies', 'comparable analysis', 'peer multiples', 'precedent transactions'],
  credit: ['credit analysis', 'credit model', 'covenant', 'debt capacity', 'rating model', 'leverage profile', 'icr'],
  ddm: ['ddm', 'dividend discount', 'gordon growth dividend', 'h-model dividend'],
  data_analysis: ['analisi dati', 'data analysis', 'analizza dati', 'analizza i dati', 'analyse data', 'analyze data', 'profilatura', 'profiling', 'esplora dati', 'explore data', 'descrittiva', 'descriptive statistics', 'correlazion', 'correlation', 'regression', 'regressione', 'cluster', 'classification', 'classificazione', 'pivot', 'group by', 'aggregat', 'distribuzione', 'distribution', 'data quality', 'qualità dati', 'outlier', 'anomal'],
  dashboard: ['dashboard', 'cruscotto', 'kpi', 'reporting', 'visualizzazione', 'visualization', 'grafici', 'charts', 'panel', 'pannello', 'monitor'],
  etl_cleanup: ['etl', 'pulizia dati', 'data cleaning', 'clean data', 'sistema i dati', 'normalizza', 'normalize', 'dedupe', 'deduplicate', 'merge sheets', 'unisci fogli', 'split column', 'separa colonna', 'standardizza'],
  forecasting: ['forecast', 'previsione', 'previsioni', 'time series', 'serie storica', 'arima', 'sarima', 'prophet', 'forecasting', 'predici'],
  optimization: ['optimization', 'ottimizzazione', 'solver', 'goal seek', 'linear programming', 'lp ', 'minimize', 'maximize', 'minimizza', 'massimizza']
};

const MODEL_DEFAULT_SHEETS = {
  dcf:             ['Summary', 'Sources', 'Assumptions', 'WACC', 'DCF', 'Sensitivity', 'Scenarios', 'Audit'],
  lbo:             ['Summary', 'Sources', 'Assumptions', 'Transaction', 'Sources_Uses', 'Operating_Model', 'Debt_Schedule', 'Cash_Flow', 'Returns', 'Sensitivity', 'Scenarios', 'Audit'],
  m_a:             ['Summary', 'Sources', 'Target', 'Acquirer', 'Synergies', 'Financing', 'Pro_Forma', 'Accretion_Dilution', 'Sensitivity', 'Audit'],
  three_statement: ['Summary', 'Sources', 'Assumptions', 'P_and_L', 'Balance_Sheet', 'Cash_Flow', 'Ratios', 'Audit'],
  comps:           ['Summary', 'Sources', 'Peer_Set', 'Trading_Comps', 'Transaction_Comps', 'Multiples_Stats', 'Implied_Valuation', 'Audit'],
  credit:          ['Summary', 'Sources', 'Assumptions', 'Operating_Model', 'Debt_Schedule', 'Coverage_Ratios', 'Covenant_Tests', 'Stress_Cases', 'Audit'],
  ddm:             ['Summary', 'Sources', 'Assumptions', 'Dividend_Forecast', 'DDM_Valuation', 'Sensitivity', 'Scenarios', 'Audit'],
  data_analysis:   ['Summary', 'Source_Data', 'Schema_Profile', 'Cleaned_Data', 'Aggregations', 'Distributions', 'Correlations', 'Insights', 'Charts'],
  dashboard:       ['Dashboard', 'Source_Data', 'KPIs', 'Trends', 'Breakdowns', 'Filters'],
  etl_cleanup:     ['Source_Data', 'Cleaning_Log', 'Cleaned_Data', 'Audit'],
  forecasting:     ['Summary', 'Source_Data', 'Decomposition', 'Forecast', 'Backtest', 'Scenarios', 'Audit'],
  optimization:    ['Summary', 'Inputs', 'Variables', 'Constraints', 'Objective', 'Solution', 'Sensitivity'],
  custom:          ['Summary', 'Inputs', 'Calculations', 'Outputs', 'Audit']
};

// Compact playbooks: one task per major section.
const COMPACT_PLAYBOOKS = {
  dcf: [
    { ref: 'shell',       section: 'shell',       focusArea: null, agent: 'layout',  description: 'Create institutional DCF workbook shell' },
    { ref: 'sources',     section: 'sources',     focusArea: null, agent: 'layout',  description: 'Build source book and data-quality map' },
    { ref: 'assumptions', section: 'assumptions', focusArea: null, agent: 'formula', description: 'AI-build assumption spine from company data, market inputs and workbook context' },
    { ref: 'wacc',        section: 'wacc',        focusArea: null, agent: 'formula', description: 'AI-build WACC from CAPM, debt cost, tax rate, capital structure and beta peer cross-check' },
    { ref: 'dcf',         section: 'dcf',         focusArea: null, agent: 'formula', description: 'AI-build operating forecast, FCF bridge, terminal value and implied share price' },
    { ref: 'sensitivity', section: 'sensitivity', focusArea: null, agent: 'formula', description: 'AI-build WACC x terminal-growth sensitivity grids' },
    { ref: 'scenarios',   section: 'scenarios',   focusArea: null, agent: 'formula', description: 'Build downside/base/upside scenario layer around the DCF output' },
    { ref: 'summary',     section: 'summary',     focusArea: null, agent: 'formula', description: 'Build valuation summary tying DCF, sensitivity and scenarios into an investment-committee view' },
    { ref: 'audit',       section: 'audit',       focusArea: null, agent: 'formula', description: 'Build model audit checks for assumptions, formulas, bridge integrity and readiness' },
    { ref: 'format',      section: 'format',      focusArea: null, agent: 'format',  description: 'Apply institutional finance formatting across every DCF workbook sheet' }
  ],
  lbo: [
    { ref: 'shell',       section: 'shell',         focusArea: null, agent: 'layout',  description: 'Create institutional LBO workbook shell (Summary, Sources, Assumptions, Transaction, Sources_Uses, Operating_Model, Debt_Schedule, Cash_Flow, Returns, Sensitivity, Scenarios, Audit)' },
    { ref: 'sources',     section: 'sources',       focusArea: null, agent: 'layout',  description: 'Build source book and data-quality map for the LBO inputs' },
    { ref: 'assumptions', section: 'assumptions',   focusArea: null, agent: 'formula', description: 'AI-build LBO assumption spine: entry/exit multiples, leverage, growth, margins, capex, NWC, tax, sponsor return targets' },
    { ref: 'transaction', section: 'transaction',   focusArea: null, agent: 'formula', description: 'AI-build transaction summary: entry EV, equity purchase price, premium paid, fees, advisor costs' },
    { ref: 'sources_uses',section: 'sources_uses',  focusArea: null, agent: 'formula', description: 'AI-build Sources & Uses with tranched debt (term loans, mezz, HY), sponsor equity, rollover, refinanced debt' },
    { ref: 'operating',   section: 'operating_model',focusArea: null,agent: 'formula', description: 'AI-build 5-year operating P&L with revenue growth, EBITDA bridge, D&A, interest, tax, net income' },
    { ref: 'debt_schedule',section: 'debt_schedule',focusArea: null, agent: 'formula', description: 'AI-build debt schedule per tranche: beg balance, mandatory amortization, cash sweep, ending balance, interest expense, fees' },
    { ref: 'cash_flow',   section: 'cash_flow',     focusArea: null, agent: 'formula', description: 'AI-build cash flow available for debt service: EBITDA - tax - capex - NWC change, allocated to mandatory amort then sweep' },
    { ref: 'returns',     section: 'returns',       focusArea: null, agent: 'formula', description: 'AI-build sponsor returns: exit EV (EBITDA exit multiple), exit equity value, MOIC, IRR, cash-on-cash, year-by-year sponsor equity bridge' },
    { ref: 'sensitivity', section: 'sensitivity',   focusArea: null, agent: 'formula', description: 'AI-build IRR/MOIC sensitivity: entry x exit multiple, leverage x growth' },
    { ref: 'scenarios',   section: 'scenarios',     focusArea: null, agent: 'formula', description: 'Build downside/base/upside scenarios with different leverage, growth, exit assumptions' },
    { ref: 'summary',     section: 'summary',       focusArea: null, agent: 'formula', description: 'Build LBO summary dashboard: deal economics, sponsor returns, leverage profile, key risks' },
    { ref: 'audit',       section: 'audit',         focusArea: null, agent: 'formula', description: 'Build LBO audit checks: sources = uses, debt repayment integrity, returns reconciliation, covenant warnings' },
    { ref: 'format',      section: 'format',        focusArea: null, agent: 'format',  description: 'Apply institutional formatting across every LBO sheet' }
  ],
  m_a: [
    { ref: 'shell',           section: 'shell',          focusArea: null, agent: 'layout',  description: 'Create institutional M&A workbook shell (Summary, Sources, Target, Acquirer, Synergies, Financing, Pro_Forma, Accretion_Dilution, Sensitivity, Audit)' },
    { ref: 'sources',         section: 'sources',        focusArea: null, agent: 'layout',  description: 'Build source book and data-quality map for the transaction inputs' },
    { ref: 'target',          section: 'target',         focusArea: null, agent: 'formula', description: 'AI-build Target standalone P&L, share count, current share price, EV bridge, balance-sheet snapshot' },
    { ref: 'acquirer',        section: 'acquirer',       focusArea: null, agent: 'formula', description: 'AI-build Acquirer standalone P&L, share count, current share price, EV bridge, balance-sheet snapshot' },
    { ref: 'synergies',       section: 'synergies',      focusArea: null, agent: 'formula', description: 'AI-build synergy assumptions: revenue synergies (run-rate, ramp), cost synergies, integration costs, phasing' },
    { ref: 'financing',       section: 'financing',      focusArea: null, agent: 'formula', description: 'AI-build deal financing mix: cash, stock, new debt; exchange ratio; premium paid; transaction fees' },
    { ref: 'pro_forma',       section: 'pro_forma',      focusArea: null, agent: 'formula', description: 'AI-build Pro Forma P&L: Target + Acquirer + Synergies - Integration Costs - New Interest Expense; pro forma EPS' },
    { ref: 'accretion',       section: 'accretion_dilution',focusArea: null,agent: 'formula',description: 'AI-build accretion/dilution analysis: standalone vs pro forma EPS, accretion% by year, breakeven synergies' },
    { ref: 'sensitivity',     section: 'sensitivity',    focusArea: null, agent: 'formula', description: 'AI-build accretion/dilution sensitivity: synergy size x integration costs; cash/stock mix x premium' },
    { ref: 'summary',         section: 'summary',        focusArea: null, agent: 'formula', description: 'Build M&A summary dashboard: deal economics, accretion profile, premium, synergy assumptions' },
    { ref: 'audit',           section: 'audit',          focusArea: null, agent: 'formula', description: 'Build M&A audit: share-count bridge, EPS reconciliation, financing balance check' },
    { ref: 'format',          section: 'format',         focusArea: null, agent: 'format',  description: 'Apply institutional formatting across every M&A sheet' }
  ],
  three_statement: [
    { ref: 'shell',         section: 'shell',         focusArea: null, agent: 'layout',  description: 'Create three-statement workbook shell (Summary, Sources, Assumptions, P&L, Balance_Sheet, Cash_Flow, Ratios, Audit)' },
    { ref: 'sources',       section: 'sources',       focusArea: null, agent: 'layout',  description: 'Build source book' },
    { ref: 'assumptions',   section: 'assumptions',   focusArea: null, agent: 'formula', description: 'AI-build assumption spine: revenue drivers, margins, capex, NWC days (DSO/DIO/DPO), tax, dividends, debt policy' },
    { ref: 'p_and_l',       section: 'p_and_l',       focusArea: null, agent: 'formula', description: 'AI-build P&L: revenue, COGS, opex, EBITDA, D&A, EBIT, interest, tax, net income, EPS (5y horizon)' },
    { ref: 'balance_sheet', section: 'balance_sheet', focusArea: null, agent: 'formula', description: 'AI-build Balance Sheet: cash, receivables, inventory, payables, PPE, debt, equity. NWC = DSO/DIO/DPO formulas. PPE = prior + capex - D&A. Equity = prior + NI - dividends.' },
    { ref: 'cash_flow',     section: 'cash_flow',     focusArea: null, agent: 'formula', description: 'AI-build Cash Flow Statement: CFO (NI + D&A - NWC delta), CFI (-capex), CFF (debt issuance/repayment, dividends, buybacks), ending cash reconciles to balance sheet' },
    { ref: 'ratios',        section: 'ratios',        focusArea: null, agent: 'formula', description: 'AI-build ratio analysis: profitability, liquidity, leverage, coverage, returns (ROIC, ROE, ROA)' },
    { ref: 'audit',         section: 'audit',         focusArea: null, agent: 'formula', description: 'AI-build audit checks: BS balances (=Assets-Liabilities-Equity = 0), CFS reconciles to BS cash, NI flows correctly' },
    { ref: 'format',        section: 'format',        focusArea: null, agent: 'format',  description: 'Apply institutional formatting' }
  ],
  comps: [
    { ref: 'shell',              section: 'shell',           focusArea: null, agent: 'layout',  description: 'Create Comps workbook shell (Summary, Sources, Peer_Set, Trading_Comps, Transaction_Comps, Multiples_Stats, Implied_Valuation, Audit)' },
    { ref: 'sources',            section: 'sources',         focusArea: null, agent: 'layout',  description: 'Build source book' },
    { ref: 'peer_set',           section: 'peer_set',        focusArea: null, agent: 'formula', description: 'AI-build peer set: 8-12 comparables with rationale (sector, size, geography), screening criteria, inclusion/exclusion notes' },
    { ref: 'trading_comps',      section: 'trading_comps',   focusArea: null, agent: 'formula', description: 'AI-build trading-comps table: peer LTM revenue, EBITDA, EPS; current EV, market cap; EV/Revenue, EV/EBITDA, P/E multiples (LTM and forward)' },
    { ref: 'transaction_comps',  section: 'transaction_comps',focusArea: null,agent: 'formula', description: 'AI-build precedent-transactions table: target, acquirer, date, deal value, premium paid, EV/Revenue, EV/EBITDA' },
    { ref: 'stats',              section: 'multiples_stats', focusArea: null, agent: 'formula', description: 'AI-build multiples statistics: min, 25th, median, mean, 75th, max for each multiple set' },
    { ref: 'implied_valuation',  section: 'implied_valuation',focusArea: null,agent: 'formula', description: 'AI-build implied valuation for target: apply median/mean peer multiples to target metrics, range of implied EV/equity/share price' },
    { ref: 'summary',            section: 'summary',         focusArea: null, agent: 'formula', description: 'Build Comps summary: peer-implied valuation range vs current, premium/discount' },
    { ref: 'audit',              section: 'audit',           focusArea: null, agent: 'formula', description: 'Build Comps audit: peer-data freshness, outlier flags, multiple sanity checks' },
    { ref: 'format',             section: 'format',          focusArea: null, agent: 'format',  description: 'Apply institutional formatting' }
  ],
  credit: [
    { ref: 'shell',           section: 'shell',           focusArea: null, agent: 'layout',  description: 'Create Credit Analysis workbook shell (Summary, Sources, Assumptions, Operating_Model, Debt_Schedule, Coverage_Ratios, Covenant_Tests, Stress_Cases, Audit)' },
    { ref: 'sources',         section: 'sources',         focusArea: null, agent: 'layout',  description: 'Build source book' },
    { ref: 'assumptions',     section: 'assumptions',     focusArea: null, agent: 'formula', description: 'AI-build credit assumption spine: revenue, EBITDA, capex, NWC, tax, debt tranches, covenant levels' },
    { ref: 'operating',       section: 'operating_model', focusArea: null, agent: 'formula', description: 'AI-build 5y operating P&L driving EBITDA and cash generation' },
    { ref: 'debt_schedule',   section: 'debt_schedule',   focusArea: null, agent: 'formula', description: 'AI-build debt schedule per tranche: balance, mandatory amort, cash sweep, interest, balance ending' },
    { ref: 'coverage',        section: 'coverage_ratios', focusArea: null, agent: 'formula', description: 'AI-build coverage ratios per year: Net Debt/EBITDA, EBITDA/Interest, FCCR, DSCR, Debt/Capital' },
    { ref: 'covenants',       section: 'covenant_tests',  focusArea: null, agent: 'formula', description: 'AI-build covenant tests vs thresholds: pass/fail per year, headroom %' },
    { ref: 'stress',          section: 'stress_cases',    focusArea: null, agent: 'formula', description: 'AI-build downside stress cases: EBITDA cliff scenarios, recovery analysis' },
    { ref: 'summary',         section: 'summary',         focusArea: null, agent: 'formula', description: 'Build credit summary: rating implication, key ratios, covenant headroom' },
    { ref: 'audit',           section: 'audit',           focusArea: null, agent: 'formula', description: 'Build credit audit: debt-schedule integrity, ratio reconciliation, covenant calculations' },
    { ref: 'format',          section: 'format',          focusArea: null, agent: 'format',  description: 'Apply institutional formatting' }
  ],
  data_analysis: [
    { ref: 'profile_data',   section: 'schema_profile',  focusArea: null, agent: 'data',    description: 'Profile every data sheet: column types, row counts, null %, unique values, value ranges, candidate keys' },
    { ref: 'clean_data',     section: 'clean_data',      focusArea: null, agent: 'formula', description: 'Clean and normalize data: trim text, standardize dates, coerce numerics, deduplicate, handle nulls. Output Cleaned_Data sheet with formulas linked to source' },
    { ref: 'aggregations',   section: 'aggregations',    focusArea: null, agent: 'formula', description: 'Build aggregations: GROUPBY equivalents via SUMIFS/COUNTIFS/AVERAGEIFS, segment breakdowns, top-N rankings, time bucketing' },
    { ref: 'distributions',  section: 'distributions',   focusArea: null, agent: 'formula', description: 'Build distribution analysis: histogram buckets, percentiles (QUARTILE/PERCENTILE), skewness, kurtosis indicators, outlier flags' },
    { ref: 'correlations',   section: 'correlations',    focusArea: null, agent: 'formula', description: 'Build pairwise correlation matrix via CORREL for numeric columns; flag |r|>0.7 strong relationships' },
    { ref: 'insights',       section: 'insights',        focusArea: null, agent: 'formula', description: 'Generate insight bullets referencing computed values: top drivers, trends, anomalies, segment outperformers' },
    { ref: 'charts',         section: 'charts',          focusArea: null, agent: 'format',  description: 'Add chart objects for the most informative views: top trend, top breakdown, distribution shape' },
    { ref: 'summary',        section: 'summary',         focusArea: null, agent: 'formula', description: 'Build summary header with dataset size, quality metrics, headline findings' }
  ],
  dashboard: [
    { ref: 'source',     section: 'source_data', focusArea: null, agent: 'data',    description: 'Reference source data location and shape' },
    { ref: 'kpis',       section: 'kpis',        focusArea: null, agent: 'formula', description: 'Build KPI tiles: total, MoM/YoY change, vs target, sparkline data' },
    { ref: 'trends',     section: 'trends',      focusArea: null, agent: 'formula', description: 'Build trend tables driving line/area charts' },
    { ref: 'breakdowns', section: 'breakdowns',  focusArea: null, agent: 'formula', description: 'Build category breakdowns for bar/pie charts' },
    { ref: 'filters',    section: 'filters',     focusArea: null, agent: 'formula', description: 'Build filter cells with named ranges and downstream formulas that respect filter state' },
    { ref: 'dashboard',  section: 'dashboard',   focusArea: null, agent: 'format',  description: 'Build the Dashboard sheet: KPI tiles, charts, filters in a clean grid' }
  ],
  forecasting: [
    { ref: 'source',        section: 'source_data',    focusArea: null, agent: 'data',    description: 'Reference time-series source' },
    { ref: 'decomposition', section: 'decomposition',  focusArea: null, agent: 'formula', description: 'Decompose into trend (moving average), seasonality (period averages), residual' },
    { ref: 'forecast',      section: 'forecast',       focusArea: null, agent: 'formula', description: 'Build forecast using FORECAST.ETS / TREND / GROWTH formulas with confidence interval' },
    { ref: 'backtest',      section: 'backtest',       focusArea: null, agent: 'formula', description: 'Backtest on holdout period: MAE, MAPE, RMSE' },
    { ref: 'scenarios',     section: 'scenarios',      focusArea: null, agent: 'formula', description: 'Scenario forecasts: optimistic/base/pessimistic with parameter overrides' },
    { ref: 'summary',       section: 'summary',        focusArea: null, agent: 'formula', description: 'Forecast summary and recommendation' }
  ],
  ddm: [
    { ref: 'shell',       section: 'shell',       focusArea: null, agent: 'layout',  description: 'Create DDM workbook shell (Summary, Sources, Assumptions, Dividend_Forecast, DDM_Valuation, Sensitivity, Audit)' },
    { ref: 'sources',     section: 'sources',     focusArea: null, agent: 'layout',  description: 'Build source book' },
    { ref: 'assumptions', section: 'assumptions', focusArea: null, agent: 'formula', description: 'AI-build DDM assumptions: payout ratio, dividend growth (high/transition/stable), required return, terminal growth' },
    { ref: 'dividend',    section: 'dividend_forecast',focusArea:null,agent:'formula', description: 'AI-build dividend forecast over high/transition/stable phases (H-model)' },
    { ref: 'ddm',         section: 'ddm_valuation',focusArea: null, agent: 'formula', description: 'AI-build DDM valuation: PV of explicit dividends + terminal value (Gordon), implied share price' },
    { ref: 'sensitivity', section: 'sensitivity', focusArea: null, agent: 'formula', description: 'AI-build DDM sensitivity: required return x terminal growth' },
    { ref: 'summary',     section: 'summary',     focusArea: null, agent: 'formula', description: 'Build DDM summary dashboard' },
    { ref: 'audit',       section: 'audit',       focusArea: null, agent: 'formula', description: 'Build DDM audit checks' },
    { ref: 'format',      section: 'format',      focusArea: null, agent: 'format',  description: 'Apply institutional formatting' }
  ]
};

// Granular playbooks: same sections but with focused sub-tasks where it matters.
// Only DCF is fully granular today. LBO/M&A/etc. fall back to compact + AI-decided depth.
const GRANULAR_PLAYBOOKS = {
  dcf: [
    { ref: 'shell',                 section: 'shell',       focusArea: null,                  agent: 'layout',  description: 'Create institutional DCF workbook shell' },
    { ref: 'sources',               section: 'sources',     focusArea: null,                  agent: 'layout',  description: 'Build source book and data-quality map' },
    { ref: 'assumptions.company',   section: 'assumptions', focusArea: 'company_market',      agent: 'formula', description: 'Assumptions block A: company identity, current market data, historical anchors' },
    { ref: 'assumptions.revenue',   section: 'assumptions', focusArea: 'revenue_drivers',     agent: 'formula', description: 'Assumptions block B: revenue drivers, growth decomposition, mix, pricing and volume' },
    { ref: 'assumptions.costs',     section: 'assumptions', focusArea: 'costs_margins',       agent: 'formula', description: 'Assumptions block C: COGS, opex, EBITDA bridge, D&A' },
    { ref: 'assumptions.capital',   section: 'assumptions', focusArea: 'capital_working_tax', agent: 'formula', description: 'Assumptions block D: capex, working capital, tax, terminal growth, financing' },
    { ref: 'wacc.equity',           section: 'wacc',        focusArea: 'cost_of_equity',      agent: 'formula', description: 'WACC block A: risk-free, ERP, levered beta, CAPM cost of equity' },
    { ref: 'wacc.debt',             section: 'wacc',        focusArea: 'cost_of_debt',        agent: 'formula', description: 'WACC block B: cost of debt, credit spread, tax shield' },
    { ref: 'wacc.structure',        section: 'wacc',        focusArea: 'beta_capital_struct', agent: 'formula', description: 'WACC block C: beta peer cross-check, unlever/relever, weighted WACC' },
    { ref: 'dcf.revenue',           section: 'dcf',         focusArea: 'revenue_buildup',     agent: 'formula', description: 'DCF block A: 5y revenue build-up' },
    { ref: 'dcf.operating',         section: 'dcf',         focusArea: 'operating_buildup',   agent: 'formula', description: 'DCF block B: EBITDA, EBIT, NOPAT bridge per year' },
    { ref: 'dcf.fcf',               section: 'dcf',         focusArea: 'fcf_bridge',          agent: 'formula', description: 'DCF block C: NOPAT to UFCF (capex, NWC delta, D&A)' },
    { ref: 'dcf.valuation',         section: 'dcf',         focusArea: 'valuation',           agent: 'formula', description: 'DCF block D: PV, TV, EV bridge, equity bridge, implied share price' },
    { ref: 'sensitivity.wacc',      section: 'sensitivity', focusArea: 'wacc_growth',         agent: 'formula', description: 'Sensitivity block A: WACC x terminal growth grid' },
    { ref: 'sensitivity.drivers',   section: 'sensitivity', focusArea: 'driver_grids',        agent: 'formula', description: 'Sensitivity block B: revenue growth x EBITDA margin grid' },
    { ref: 'sensitivity.exit',      section: 'sensitivity', focusArea: 'exit_multiple',       agent: 'formula', description: 'Sensitivity block C: exit EV/EBITDA multiple grid' },
    { ref: 'scenarios.cases',       section: 'scenarios',   focusArea: 'cases',               agent: 'formula', description: 'Scenarios block A: downside/base/upside driver override tables' },
    { ref: 'scenarios.output',      section: 'scenarios',   focusArea: 'selector_output',     agent: 'formula', description: 'Scenarios block B: scenario selector and live valuation switch' },
    { ref: 'summary',               section: 'summary',     focusArea: null,                  agent: 'formula', description: 'Summary: investment-committee dashboard' },
    { ref: 'audit.formula',         section: 'audit',       focusArea: 'formula_checks',      agent: 'formula', description: 'Audit block A: formula-level checks' },
    { ref: 'audit.business',        section: 'audit',       focusArea: 'business_checks',     agent: 'formula', description: 'Audit block B: business-level checks' },
    { ref: 'format',                section: 'format',      focusArea: null,                  agent: 'format',  description: 'Apply institutional formatting' }
  ]
};

// High-level prompt contracts per section, per model. The AI receives the
// matching string when building. These are intentionally short and high-signal;
// detailed analyst-depth playbooks come from analystDepth.js.
const SECTION_CONTRACTS = {
  dcf: {
    assumptions: `Build only the Assumptions sheet. Include company/source, historical market inputs, projection assumptions, WACC inputs, equity bridge inputs. For every assumption row, populate Column C "How Derived" and Column D "Source / Review".`,
    wacc:        `Build only the WACC sheet. Pull inputs from Assumptions. Include CAPM cost of equity, after-tax cost of debt, weights, final WACC, and a beta evidence section comparing observed beta vs peer/sector beta (unlever/relever).`,
    dcf:         `Build only the DCF sheet. Include 5 forecast years, terminal value, EV, equity bridge, implied share price, current price, premium/discount, bridge check.`,
    projection:  `Build only the DCF projection sheet content.`,
    sensitivity: `Build only the Sensitivity sheet. Include WACC x terminal-growth tables for implied share price and EV. Use formulas, not Excel data-table syntax.`,
    scenarios:   `Build only the Scenarios sheet. Downside/base/upside driver overrides, scenario selector, live valuation under each case via formulas.`,
    summary:     `Build only the Summary sheet (investment-committee output). Pull DCF, sensitivity midpoint, scenario range, recommendation.`,
    audit:       `Build only the Audit sheet. Executable =IF(condition,"OK","ERR") checks for assumption ranges, bridge integrity, formula coverage, cross-sheet integrity.`,
    sources:     `Build only the Sources sheet. Catalog every external/workbook data input with source, confidence, review status.`,
    shell:       `Create the DCF workbook shell using createSheet for: Summary, Sources, Assumptions, WACC, DCF, Sensitivity, Scenarios, Audit.`
  },
  lbo: {
    assumptions:    `Build the LBO Assumptions sheet. Include entry multiple, leverage (Net Debt / EBITDA at close), debt tranches (term loans, mezz, HY) with rates and tenors, sponsor equity ticket, growth & margin profile, capex/NWC/tax, exit multiple range, exit year.`,
    transaction:    `Build the Transaction sheet. Compute entry EV (=EBITDA_LTM * entry_multiple), equity purchase price, premium paid vs prior market cap, transaction fees, advisory costs, deal closing date.`,
    sources_uses:   `Build the Sources & Uses sheet. Uses: equity purchase price + refinanced debt + fees. Sources: new debt tranches + sponsor equity + management rollover. Sum-check both sides via formulas.`,
    operating_model:`Build the Operating Model sheet. 5y P&L: revenue growth, EBITDA margin, D&A, EBIT, interest expense (pulled from Debt_Schedule), tax, net income.`,
    debt_schedule:  `Build the Debt Schedule sheet. Per tranche per year: beg balance, mandatory amortization, optional cash sweep (=MIN(available_FCF, balance_after_mandatory)), ending balance, interest expense (=avg balance * rate), fees. Allocate sweep across tranches by seniority.`,
    cash_flow:      `Build the Cash Flow sheet. Cash available for debt service per year: EBITDA - cash tax - capex - NWC change. Track distribution to mandatory amort first, then sweep.`,
    returns:        `Build the Returns sheet. Exit year EBITDA * exit multiple = exit EV; - ending debt = exit equity. MOIC = exit_equity / sponsor_initial_equity. IRR via XIRR or Newton iteration (no Excel circular ref). Cash-on-cash if any dividends.`,
    sensitivity:    `Build the Sensitivity sheet. Tables: IRR/MOIC by entry x exit multiple; IRR by leverage x EBITDA growth.`,
    scenarios:      `Build the Scenarios sheet. Downside/base/upside driver overrides (lower growth, margin compression, higher rates, lower exit multiple).`,
    summary:        `Build the LBO Summary dashboard: deal economics, sponsor returns (MOIC, IRR), leverage profile, key risks.`,
    audit:          `Build the Audit sheet. =IF formula checks: Sources = Uses, ending debt balance matches debt-schedule output, returns reconcile to exit equity, interest expense ties.`,
    sources:        `Build the Sources sheet. Inputs catalog: deal assumptions, debt rate sources, exit multiple references.`,
    shell:          `Create LBO workbook shell using createSheet for: Summary, Sources, Assumptions, Transaction, Sources_Uses, Operating_Model, Debt_Schedule, Cash_Flow, Returns, Sensitivity, Scenarios, Audit.`
  },
  m_a: {
    target:          `Build the Target sheet. Target's standalone P&L (3-5y), share count, current share price, EV (market cap + net debt), summary balance sheet.`,
    acquirer:        `Build the Acquirer sheet. Acquirer's standalone P&L, share count, current share price, EV, balance sheet.`,
    synergies:       `Build the Synergies sheet. Revenue synergies (run-rate, ramp%, year-by-year realization), cost synergies (COGS, opex), integration costs (one-time and ongoing), tax effect, phasing.`,
    financing:       `Build the Financing sheet. Deal mix: cash %, stock % (exchange ratio = offer_price / acquirer_share_price), new debt with rate. Premium paid vs target undisturbed price. Fees.`,
    pro_forma:       `Build the Pro Forma sheet. PF P&L = Target + Acquirer + Synergies - Integration Costs - New Interest Expense - Foregone Interest on Cash. PF share count = Acquirer + (Stock consideration / Acquirer share price). PF EPS.`,
    accretion_dilution:`Build the Accretion/Dilution sheet. Standalone Acquirer EPS vs PF EPS, accretion% by year, breakeven synergies, accretion/dilution waterfall.`,
    sensitivity:     `Build M&A sensitivity tables: synergy size x integration costs; cash/stock mix x premium paid; deal financing rate x EPS impact.`,
    summary:         `Build M&A summary dashboard.`,
    audit:           `Build M&A audit: share-count bridge, EPS reconciliation, financing balance.`,
    sources:         `Build the Sources sheet.`,
    shell:           `Create M&A workbook shell.`
  },
  three_statement: {
    assumptions:    `Build assumptions for the integrated model: revenue drivers, margin profile, capex, NWC days (DSO/DIO/DPO), tax rate, dividend policy, debt policy.`,
    p_and_l:        `Build the P&L sheet. 5y revenue/COGS/opex/EBITDA/D&A/EBIT/interest/tax/net income with formulas referencing Assumptions and Debt_Schedule (interest).`,
    balance_sheet:  `Build the Balance Sheet. NWC items (=DSO/365 * revenue, etc.), PPE = prior PPE + capex - D&A, Cash from Cash Flow Statement, Debt from Debt Schedule, Equity = prior + NI - dividends. Balance check row (Assets - Liabilities - Equity = 0).`,
    cash_flow:      `Build the Cash Flow Statement. CFO = NI + D&A - NWC delta, CFI = -capex, CFF = debt issuance - repayment - dividends - buybacks. Ending cash flows into Balance Sheet cash.`,
    ratios:         `Build ratio analysis: profitability (EBITDA margin, NI margin, ROE, ROA, ROIC), liquidity (current ratio, quick ratio), leverage (Debt/EBITDA, Debt/Capital), coverage (interest coverage, FCCR, DSCR).`,
    audit:          `Build audit checks: BS balances (=0), CFS cash reconciles to BS cash, retained earnings = prior + NI - dividends, no broken cross-references.`,
    sources:        `Build the Sources sheet.`,
    shell:          `Create three-statement workbook shell.`,
    summary:        `Build the Summary sheet.`
  },
  comps: {
    peer_set:        `Build the Peer Set sheet. 8-12 comparables with selection rationale (sector, size, geography), inclusion/exclusion notes.`,
    trading_comps:   `Build Trading Comps table. Per peer: LTM revenue, LTM EBITDA, LTM EPS, current EV (market cap + net debt), current market cap. Compute EV/Revenue, EV/EBITDA, P/E (LTM and forward).`,
    transaction_comps:`Build Precedent Transactions table. Per deal: target, acquirer, announcement date, deal value, premium, EV/Revenue, EV/EBITDA.`,
    multiples_stats: `Build multiples statistics row block: min, 25th percentile, median, mean, 75th percentile, max for each multiple. Use Excel QUARTILE/MEDIAN/AVERAGE/MIN/MAX functions.`,
    implied_valuation:`Build implied valuation for the target: apply median and 75th percentile peer multiples to target metrics. Output implied EV / equity / share price range.`,
    summary:         `Build Comps summary.`,
    audit:           `Build Comps audit (outlier flags, freshness checks).`,
    sources:         `Build the Sources sheet.`,
    shell:           `Create Comps workbook shell.`
  },
  credit: {
    assumptions:    `Build credit assumptions: revenue, EBITDA, capex, NWC, tax, debt tranches with rates, covenant thresholds (max Net Debt/EBITDA, min EBITDA/Interest, min FCCR).`,
    operating_model:`Build 5y operating P&L driving EBITDA and FCF.`,
    debt_schedule:  `Build debt schedule per tranche: balance, mandatory amort, cash sweep, interest, ending balance.`,
    coverage_ratios:`Build coverage ratios per year: Net Debt/EBITDA, EBITDA/Interest, FCCR=(EBITDA-capex-tax)/(interest+mandatory_amort), DSCR.`,
    covenant_tests: `Build covenant tests vs thresholds: pass/fail per year (=IF), headroom %.`,
    stress_cases:   `Build downside stress cases (EBITDA cliff, refinancing risk).`,
    summary:        `Build credit summary: rating implication, key ratios, covenant headroom.`,
    audit:          `Build credit audit: debt-schedule integrity, ratio reconciliation.`,
    sources:        `Build the Sources sheet.`,
    shell:          `Create Credit workbook shell.`
  },
  data_analysis: {
    schema_profile: `Build Schema_Profile sheet. For each source column: name, inferred type, count, null count, null%, unique count, sample values, min, max, mean (numeric), most-frequent value. Use COUNTA/COUNTIF/COUNT/MIN/MAX/AVERAGE/MEDIAN/STDEV formulas referencing the source range.`,
    clean_data:     `Build Cleaned_Data sheet by referencing Source_Data with cleaning formulas: TRIM/PROPER/LOWER for text; IFERROR(VALUE,...) for numeric coercion; DATEVALUE for dates; deduplicate notes/flag rows. Add a "data_quality_flag" column with =IF logic.`,
    aggregations:   `Build Aggregations sheet. For each meaningful dimension: GROUPBY-equivalent rows via SUMIFS/COUNTIFS/AVERAGEIFS, ranked from largest. Add time aggregation if a date column exists (YEAR/MONTH bucketing).`,
    distributions:  `Build Distributions sheet. Histogram bucket count (FREQUENCY), percentiles (PERCENTILE/QUARTILE), basic stats (mean, median, stdev, skew indicators), outlier flag (=IF(ABS(z)>3,"OUTLIER","")).`,
    correlations:   `Build Correlations sheet. Pairwise CORREL matrix of all numeric columns. Flag |r|>=0.7 strong correlations and |r|<=0.2 weak. Add a one-line insight per strong pair.`,
    insights:       `Build Insights sheet. 5-10 insight bullets, each referencing a computed value in another sheet via formulas: top contributors, fastest-growing segments, anomalies, structural observations.`,
    charts:         `Add charts via createChart actions on the most informative views in Aggregations / Distributions / Trends.`,
    summary:        `Build the Summary header: dataset size, quality score (% non-null), headline findings linked to Insights.`,
    source_data:    `Reference the source data area on its sheet. Do not duplicate rows; instead set named-range pointers or formula references for downstream sheets.`
  },
  dashboard: {
    kpis:       `Build KPI tile cells. Each KPI: current value (formula), prior period (formula), delta (=Curr - Prior), delta% (=Delta/Prior), vs-target if target available. Use Excel number formats but no inline hardcodes.`,
    trends:     `Build trend tables (rows = period, columns = metric). Drive line/area charts.`,
    breakdowns: `Build category breakdown tables (rows = category, columns = metric). Drive bar/donut charts.`,
    filters:    `Build a Filters sheet/section with named ranges. Downstream formulas reference filter cells via INDEX/MATCH/CHOOSE.`,
    dashboard:  `Build the Dashboard sheet: arrange KPI tiles in top row, charts below, filters on side. Use createChart actions referencing the trend/breakdown ranges.`,
    source_data:`Reference the source data range without duplicating rows.`
  },
  forecasting: {
    decomposition:`Build decomposition: trend (=AVERAGE on rolling window or =SLOPE/INTERCEPT for linear), seasonality (=AVERAGEIFS by period within seasonal cycle), residual (=Actual - Trend - Seasonality).`,
    forecast:    `Build forecast: FORECAST.ETS for ETS, TREND/GROWTH for regression. Add 95% confidence interval via FORECAST.ETS.CONFINT. Show H-period-ahead values.`,
    backtest:    `Build holdout backtest: split last N periods, compute MAE (=ABS(actual-pred)), MAPE (=ABS((actual-pred)/actual)), RMSE (=SQRT(AVERAGE((actual-pred)^2))).`,
    scenarios:   `Build optimistic/base/pessimistic scenarios with growth-rate overrides.`,
    summary:     `Forecast summary: headline forecast for next period, accuracy metrics, methodology note.`,
    source_data: `Reference time-series source range.`
  },
  ddm: {
    assumptions:       `Build DDM assumptions: current dividend, payout ratio, high-growth %, high-growth period, transition period, stable growth, required return.`,
    dividend_forecast: `Build dividend forecast (H-model): high-growth phase, linear transition phase, stable phase. Year-by-year dividend per share.`,
    ddm_valuation:     `Build DDM valuation: PV of explicit dividends + terminal value (Gordon = D_stable*(1+g)/(k-g)). Implied share price.`,
    sensitivity:       `Build DDM sensitivity: required return x terminal growth.`,
    summary:           `Build DDM summary.`,
    audit:             `Build DDM audit checks.`,
    sources:           `Build the Sources sheet.`,
    shell:             `Create DDM workbook shell.`,
    scenarios:         `Build DDM scenarios.`
  }
};

const GRANULAR_KEYWORDS = [
  'granular', 'granulare', 'institutional', 'istituzionale', 'professional', 'professionale',
  'deep', 'detailed', 'dettagliato', 'comprehensive', 'esaustivo',
  '1000', '500 row', 'full institutional', 'complete model',
  'investment committee', 'institutional grade', 'analyst grade'
];

function lowerObjective(objective) {
  return String(objective || '').toLowerCase();
}

function inferFinanceModelType(objective, context = null) {
  const text = lowerObjective(objective);
  if (!text) return 'custom';
  for (const [modelType, aliases] of Object.entries(MODEL_ALIASES)) {
    for (const alias of aliases) {
      // Use regex when alias contains spaces or anchors, otherwise plain includes
      if (alias.startsWith(' ') || alias.endsWith('$') || alias.includes('  ')) {
        try {
          const re = new RegExp(alias.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          if (re.test(text)) return modelType;
        } catch (_) { /* ignore */ }
        continue;
      }
      if (text.includes(alias)) return modelType;
    }
  }
  // Fall back: heuristic from workbook context (existing sheet names hint at model)
  const sheets = Array.isArray(context?.workbookSheets) ? context.workbookSheets.map(s => String(s).toLowerCase()) : [];
  if (sheets.some(s => s.includes('debt_schedule') || s.includes('sources_uses'))) return 'lbo';
  if (sheets.some(s => s.includes('balance_sheet') && s.includes('cash_flow'))) return 'three_statement';
  if (sheets.some(s => s.includes('synergies') || s.includes('accretion'))) return 'm_a';
  if (sheets.some(s => s.includes('trading_comps') || s.includes('peer_set'))) return 'comps';
  // Data-analysis fallback when workbook has a single large data sheet and the user didn't ask for finance
  const looksLikeFinance = /(\bdcf\b|valutaz|valuation|lbo|wacc|m&a|fusion|acquis|three\W?statement|balance sheet|p&l|comps|comparable)/i.test(text);
  if (!looksLikeFinance) return 'custom';
  return 'dcf';
}

function inferIsFinanceModel(modelType) {
  return ['dcf', 'lbo', 'm_a', 'three_statement', 'comps', 'credit', 'ddm'].includes(modelType);
}

function isFinanceObjective(objective) {
  const text = lowerObjective(objective);
  if (!text) return false;
  const financeAliases = ['dcf', 'lbo', 'wacc', 'valutaz', 'valuation', 'm&a', 'merger', 'acquisit', 'three statement', '3-statement', 'comps', 'ddm', 'credit analysis', 'covenant'];
  return financeAliases.some(a => text.includes(a));
}

function shouldUseGranular(objective) {
  const text = lowerObjective(objective);
  if (!text) return false;
  return GRANULAR_KEYWORDS.some(keyword => text.includes(keyword));
}

function getModelPlaybook(modelType, objective = '') {
  const type = MODEL_TYPES.includes(modelType) ? modelType : 'dcf';
  const granular = shouldUseGranular(objective);
  if (granular && GRANULAR_PLAYBOOKS[type]) return GRANULAR_PLAYBOOKS[type];
  return COMPACT_PLAYBOOKS[type] || COMPACT_PLAYBOOKS.dcf;
}

function getModelDefaultSheets(modelType) {
  const type = MODEL_TYPES.includes(modelType) ? modelType : 'dcf';
  return MODEL_DEFAULT_SHEETS[type] || MODEL_DEFAULT_SHEETS.dcf;
}

function getModelSectionContract(modelType, section) {
  const type = MODEL_TYPES.includes(modelType) ? modelType : 'dcf';
  const contracts = SECTION_CONTRACTS[type] || {};
  const key = String(section || '').toLowerCase();
  return contracts[key] || SECTION_CONTRACTS.dcf[key] || `Build the ${key} section of the ${type} model.`;
}

function hasDeterministicTemplate(modelType) {
  return modelType === 'dcf';
}

module.exports = {
  MODEL_TYPES,
  MODEL_ALIASES,
  COMPACT_PLAYBOOKS,
  GRANULAR_PLAYBOOKS,
  SECTION_CONTRACTS,
  GRANULAR_KEYWORDS,
  inferFinanceModelType,
  inferIsFinanceModel,
  isFinanceObjective,
  shouldUseGranular,
  getModelPlaybook,
  getModelDefaultSheets,
  getModelSectionContract,
  hasDeterministicTemplate
};
