const COMPANY_TICKERS = new Map([
  ['apple', { ticker: 'AAPL', companyName: 'Apple Inc.' }],
  ['apple inc', { ticker: 'AAPL', companyName: 'Apple Inc.' }],
  ['microsoft', { ticker: 'MSFT', companyName: 'Microsoft Corporation' }],
  ['amazon', { ticker: 'AMZN', companyName: 'Amazon.com, Inc.' }],
  ['alphabet', { ticker: 'GOOGL', companyName: 'Alphabet Inc.' }],
  ['google', { ticker: 'GOOGL', companyName: 'Alphabet Inc.' }],
  ['meta', { ticker: 'META', companyName: 'Meta Platforms, Inc.' }],
  ['facebook', { ticker: 'META', companyName: 'Meta Platforms, Inc.' }],
  ['tesla', { ticker: 'TSLA', companyName: 'Tesla, Inc.' }],
  ['nvidia', { ticker: 'NVDA', companyName: 'NVIDIA Corporation' }],
  ['nvdia', { ticker: 'NVDA', companyName: 'NVIDIA Corporation' }],
  ['nvida', { ticker: 'NVDA', companyName: 'NVIDIA Corporation' }],
  ['netflix', { ticker: 'NFLX', companyName: 'Netflix, Inc.' }],
  ['berkshire', { ticker: 'BRK.B', companyName: 'Berkshire Hathaway Inc.' }],
  ['berkshire hathaway', { ticker: 'BRK.B', companyName: 'Berkshire Hathaway Inc.' }],
  ['jpmorgan', { ticker: 'JPM', companyName: 'JPMorgan Chase & Co.' }],
  ['jp morgan', { ticker: 'JPM', companyName: 'JPMorgan Chase & Co.' }],
  ['goldman', { ticker: 'GS', companyName: 'The Goldman Sachs Group, Inc.' }],
  ['goldman sachs', { ticker: 'GS', companyName: 'The Goldman Sachs Group, Inc.' }],
  ['coca cola', { ticker: 'KO', companyName: 'The Coca-Cola Company' }],
  ['coca-cola', { ticker: 'KO', companyName: 'The Coca-Cola Company' }],
  ['pepsi', { ticker: 'PEP', companyName: 'PepsiCo, Inc.' }],
  ['pepsico', { ticker: 'PEP', companyName: 'PepsiCo, Inc.' }],
  ['visa', { ticker: 'V', companyName: 'Visa Inc.' }],
  ['mastercard', { ticker: 'MA', companyName: 'Mastercard Incorporated' }],
  ['walmart', { ticker: 'WMT', companyName: 'Walmart Inc.' }],
  ['disney', { ticker: 'DIS', companyName: 'The Walt Disney Company' }],
  ['adobe', { ticker: 'ADBE', companyName: 'Adobe Inc.' }],
  ['salesforce', { ticker: 'CRM', companyName: 'Salesforce, Inc.' }],
  ['oracle', { ticker: 'ORCL', companyName: 'Oracle Corporation' }],
  ['intel', { ticker: 'INTC', companyName: 'Intel Corporation' }],
  ['amd', { ticker: 'AMD', companyName: 'Advanced Micro Devices, Inc.' }],
  ['broadcom', { ticker: 'AVGO', companyName: 'Broadcom Inc.' }],
  ['costco', { ticker: 'COST', companyName: 'Costco Wholesale Corporation' }],
  ['mcdonalds', { ticker: 'MCD', companyName: "McDonald's Corporation" }],
  ["mcdonald's", { ticker: 'MCD', companyName: "McDonald's Corporation" }]
]);

const NON_TICKER_WORDS = new Set([
  'DCF', 'WACC', 'LBO', 'M&A', 'MA', 'FCF', 'EBITDA', 'EBIT', 'CAPEX', 'NWC',
  'US', 'USA', 'USD', 'EUR', 'GBP', 'FY', 'TTM', 'IRR', 'MOIC', 'EV'
]);

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9.&\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectModel(objective) {
  const normalized = normalizeText(objective);
  if (/\bdcf\b/.test(normalized) || normalized.includes('discounted cash flow') || normalized.includes('flussi di cassa scontati')) {
    return 'dcf';
  }
  if (/\bwacc\b/.test(normalized)) return 'wacc';
  if (/\blbo\b/.test(normalized)) return 'lbo';
  if (/\bcomps?\b/.test(normalized) || normalized.includes('comparables')) return 'comps';
  return null;
}

function extractExplicitTicker(objective) {
  const raw = String(objective || '');
  const paren = raw.match(/\(([A-Z][A-Z0-9.]{0,7})\)/);
  if (paren && !NON_TICKER_WORDS.has(paren[1])) return paren[1];

  const tokens = raw.match(/\b[A-Z][A-Z0-9.]{1,7}\b/g) || [];
  for (const token of tokens) {
    if (!NON_TICKER_WORDS.has(token)) return token;
  }
  return null;
}

function lookupCompany(objective) {
  const normalized = normalizeText(objective);
  let best = null;
  for (const [name, target] of COMPANY_TICKERS.entries()) {
    const safeName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|\\s)${safeName}(\\s|$)`);
    if (!re.test(normalized)) continue;
    if (!best || name.length > best.name.length) {
      best = { name, ...target };
    }
  }
  return best ? { ticker: best.ticker, companyName: best.companyName } : null;
}

function hasBuildIntent(objective) {
  const normalized = normalizeText(objective);
  const keywords = [
    'crea',
    'creami',
    'costruisci',
    'fammi',
    'fare',
    'voglio',
    'vorrei',
    'prepara',
    'completa',
    'completami',
    'finisci',
    'sistema',
    'build',
    'make',
    'create'
  ];
  return keywords.some(keyword => {
    const safe = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\s)${safe}(\\s|$)`).test(normalized);
  });
}

function inferEquityIntent(objective) {
  const model = detectModel(objective);
  const explicitTicker = extractExplicitTicker(objective);
  const company = lookupCompany(objective);
  const ticker = explicitTicker || company?.ticker || null;

  return {
    model,
    ticker,
    companyName: company?.companyName || (ticker ? ticker : null),
    hasBuildIntent: hasBuildIntent(objective),
    isPublicCompanyTarget: !!ticker
  };
}

module.exports = {
  inferEquityIntent,
  normalizeText,
  COMPANY_TICKERS
};
