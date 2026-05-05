const axios = require('axios');
const logger = require('../utils/logger');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const DDG_API = 'https://api.duckduckgo.com';

// Common company name → ticker mappings (case-insensitive key)
const COMPANY_TICKER = {
  'apple': 'AAPL', 'microsoft': 'MSFT', 'google': 'GOOGL', 'alphabet': 'GOOGL',
  'amazon': 'AMZN', 'meta': 'META', 'facebook': 'META', 'tesla': 'TSLA',
  'nvidia': 'NVDA', 'netflix': 'NFLX', 'berkshire hathaway': 'BRK-B',
  'jpmorgan': 'JPM', 'jp morgan': 'JPM', 'bank of america': 'BAC',
  'goldman sachs': 'GS', 'morgan stanley': 'MS', 'citigroup': 'C',
  'walmart': 'WMT', 'exxon': 'XOM', 'chevron': 'CVX', 'johnson': 'JNJ',
  'pfizer': 'PFE', 'coca cola': 'KO', 'coca-cola': 'KO', 'pepsi': 'PEP',
  'disney': 'DIS', 'intel': 'INTC', 'amd': 'AMD', 'ibm': 'IBM',
  'oracle': 'ORCL', 'salesforce': 'CRM', 'adobe': 'ADBE', 'uber': 'UBER',
  'airbnb': 'ABNB', 'spotify': 'SPOT', 'palantir': 'PLTR', 'snap': 'SNAP',
  'starbucks': 'SBUX', 'nike': 'NKE', 'mcdonalds': 'MCD', 'visa': 'V',
  'mastercard': 'MA', 'paypal': 'PYPL', 'coinbase': 'COIN', 'robinhood': 'HOOD',
  'samsung': '005930.KS', 'toyota': 'TM', 'sony': 'SONY', 'nintendo': 'NTDOY',
  'alibaba': 'BABA', 'baidu': 'BIDU', 'tencent': 'TCEHY', 'byd': 'BYDDY',
  'ferrari': 'RACE', 'enel': 'ENEL.MI', 'eni': 'ENI.MI', 'intesa': 'ISP.MI',
  'unicredit': 'UCG.MI', 'stellantis': 'STLA', 'generali': 'G.MI',
  'siemens': 'SIEGY', 'bmw': 'BMWYY', 'volkswagen': 'VWAGY', 'nestle': 'NSRGY',
  'novartis': 'NVS', 'roche': 'RHHBY', 'hsbc': 'HSBC', 'barclays': 'BCS',
  'bp': 'BP', 'shell': 'SHEL', 'totalenergies': 'TTE', 'airbus': 'EADSY',
};

// LRU cache for Wikipedia searches and Yahoo Finance quotes
const MAX_CACHE = 200;
const cache = new Map();
const CACHE_TTL = {
  wiki: 30 * 60 * 1000,       // 30 min
  quote: 5 * 60 * 1000,        // 5 min
  ddg: 60 * 60 * 1000,         // 1 hour
};

function cached(key, ttlKey) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > (CACHE_TTL[ttlKey] || 300000)) { cache.delete(key); return undefined; }
  return entry.data;
}

function cacheSet(key, data) {
  if (cache.size >= MAX_CACHE) { const first = cache.keys().next().value; cache.delete(first); }
  cache.set(key, { data, ts: Date.now() });
}

/* ===================================================================
   WEB SEARCH — multi-source: Wikipedia + Yahoo Finance + DDG + SEC
   =================================================================== */
async function webSearch(params) {
  const query = (params.query || '').trim();
  const ticker = params.ticker || extractTicker(query);
  const maxResults = params.maxResults || 8;

  const cacheKey = `ws:${query}:${ticker}:${maxResults}`;
  const cachedResult = cached(cacheKey, 'wiki');
  if (cachedResult) return cachedResult;

  const results = [];
  const sources = [];

  // 1 ─── WIKIPEDIA SEARCH (primary search engine) ─────────────
  try {
    const wikiResults = await wikiSearch(query, maxResults);
    for (const w of wikiResults) {
      results.push({
        source: 'Wikipedia',
        title: w.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(w.title.replace(/ /g, '_'))}`,
        snippet: stripHtml(w.snippet),
        pageId: w.pageid,
      });
    }
    if (wikiResults.length > 0) sources.push('Wikipedia');
  } catch (e) {
    logger.warn(`[WebSearch] Wikipedia error: ${e.message}`);
  }

  // 2 ─── YAHOO FINANCE (if ticker detected) ──────────────────
  if (ticker) {
    try {
      const qk = `yfq:${ticker}`;
      let quote = cached(qk, 'quote');
      if (!quote) {
        quote = await yahooFinance.quote(ticker);
        if (quote) cacheSet(qk, quote);
      }
      if (quote?.regularMarketPrice) {
        const fmtMcap = quote.marketCap
          ? (quote.marketCap >= 1e12 ? `$${(quote.marketCap/1e12).toFixed(2)}T` :
             quote.marketCap >= 1e9 ? `$${(quote.marketCap/1e9).toFixed(1)}B` : `$${(quote.marketCap/1e6).toFixed(0)}M`)
          : 'N/A';
        results.push({
          source: 'Yahoo Finance',
          title: `${ticker} — ${quote.shortName || quote.longName || 'Quote'}`,
          url: `https://finance.yahoo.com/quote/${ticker}`,
          snippet: `Price: $${quote.regularMarketPrice} | Market Cap: ${fmtMcap} | P/E: ${quote.trailingPE?.toFixed(1) || 'N/A'} | EPS: ${quote.epsTrailingTwelveMonths || 'N/A'} | 52W Range: ${quote.fiftyTwoWeekLow}–${quote.fiftyTwoWeekHigh}`,
          financials: {
            price: quote.regularMarketPrice,
            marketCap: quote.marketCap,
            pe: quote.trailingPE,
            eps: quote.epsTrailingTwelveMonths,
            beta: quote.beta,
            dividendYield: quote.dividendYield,
            revenue: quote.totalRevenue,
            grossMargins: quote.grossMargins,
            ebitda: quote.ebitda,
            freeCashflow: quote.freeCashflow,
            debtToEquity: quote.debtToEquity,
            returnOnEquity: quote.returnOnEquity,
            sector: quote.sector,
            industry: quote.industry,
            website: quote.website,
          },
        });
        sources.push('Yahoo Finance');
      } else {
        logger.warn(`[WebSearch] Yahoo Finance: no price data for ticker ${ticker}`);
      }
    } catch (e) {
      logger.warn(`[WebSearch] Yahoo Finance error for ${ticker}: ${e.message}`);
    }
  }

  // 3 ─── DDG INSTANT ANSWER (quick facts, no key needed) ─────
  try {
    const ddgKey = `ddg:${query.slice(0, 80)}`;
    let ddg = cached(ddgKey, 'ddg');
    if (!ddg) {
      const resp = await axios.get(DDG_API, {
        params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 },
        timeout: 8000,
      });
      ddg = resp.data;
      cacheSet(ddgKey, ddg);
    }
    if (ddg.AbstractText) {
      results.push({
        source: ddg.AbstractSource || 'DuckDuckGo',
        title: ddg.Heading || 'Overview',
        url: ddg.AbstractURL || '',
        snippet: ddg.AbstractText.slice(0, 600),
      });
      sources.push('DuckDuckGo');
    }
    if (ddg.RelatedTopics?.length) {
      for (const rt of ddg.RelatedTopics.slice(0, 3)) {
        if (rt.Text) {
          results.push({
            source: 'DuckDuckGo',
            title: rt.Result ? stripHtml(rt.Result) : 'Related',
            url: rt.FirstURL || '',
            snippet: stripHtml(rt.Text).slice(0, 300),
          });
        }
      }
    }
  } catch (e) {
    logger.warn(`[WebSearch] DDG Instant Answer error: ${e.message}`);
  }

  // 4 ─── SEC EDGAR (valid tickers only) ───────────────────
  if (ticker && results.some(r => r.source === 'Yahoo Finance')) {
    results.push({
      source: 'SEC EDGAR',
      title: `SEC Filings — ${ticker}`,
      url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(ticker)}&type=10-K&dateb=&owner=include&count=40`,
      snippet: `Official SEC filings (10-K annual, 10-Q quarterly, 8-K current reports) for ${ticker}. Use for verified financial statements.`,
    });
    sources.push('SEC EDGAR');
  }

  // 5 ─── DIRECT URL FETCH (if query is a URL) ────────────────
  if (query.startsWith('http://') || query.startsWith('https://')) {
    try {
      const page = await webFetch({ url: query });
      if (page) {
        results.push({
          source: 'Direct Fetch',
          title: page.title || query,
          url: query,
          snippet: page.text?.slice(0, 800) || '',
        });
        sources.push('Direct Fetch');
      }
    } catch (e) {
      logger.warn(`[WebSearch] Direct fetch error: ${e.message}`);
    }
  }

  const output = {
    results,
    count: results.length,
    sources: [...new Set(sources)],
  };

  if (results.length === 0) {
    output.note = 'No results found from any source. Try a more specific query or provide the data directly.';
  }

  cacheSet(cacheKey, output);
  return output;
}

/* ===================================================================
   WEB FETCH — get page content as clean text
   =================================================================== */
async function webFetch(params) {
  const url = (params.url || '').trim();
  if (!url) throw new Error('URL required');

  logger.info(`[WebFetch] Fetching ${url}`);

  let html;
  try {
    const response = await axios.get(url, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15000,
      maxRedirects: 5,
      responseType: 'text',
    });
    html = response.data;
  } catch (error) {
    logger.error(`[WebFetch] HTTP error for ${url}: ${error.message}`);
    throw new Error(`Failed to fetch ${url}: ${error.message}`);
  }

  if (!html || typeof html !== 'string') {
    throw new Error(`Empty or non-HTML response from ${url}`);
  }

  const text = htmlToText(html);
  const title = extractTitle(html);

  return {
    url,
    title,
    text: text.slice(0, 6000),  // cap for LLM context
    length: text.length,
  };
}

/* ===================================================================
   WIKIPEDIA HELPERS
   =================================================================== */
async function wikiSearch(query, limit = 8) {
  const resp = await axios.get(WIKI_API, {
    params: {
      action: 'query', list: 'search', srsearch: query,
      format: 'json', srlimit: limit, origin: '*',
    },
    headers: {
      'User-Agent': 'ExcelAIAgent/1.0 (https://github.com/excel-ai; mail@example.com)',
      'Accept': 'application/json',
    },
    timeout: 10000,
  });
  return resp.data?.query?.search || [];
}

/* ===================================================================
   TICKER EXTRACTION — regex + known company map
   =================================================================== */
function extractTicker(query) {
  // URLs are not ticker-bearing queries
  if (query.startsWith('http://') || query.startsWith('https://')) return null;

  // 1. Try uppercase ticker pattern (1-5 chars + optional exchange suffix)
  const tickerMatch = query.match(/\b([A-Z]{1,5}(?:\.[A-Z]{1,2})?)\b/);
  if (tickerMatch) {
    // Filter out common false positives (all-caps words that aren't tickers)
    const t = tickerMatch[1];
    const falsePositives = new Set([
      'THE', 'A', 'AN', 'FOR', 'AND', 'INC', 'LTD', 'LLC', 'CEO', 'CFO', 'IPO', 'ETF', 'USA',
      'DCF', 'EPS', 'PE', 'EBIT', 'EBITDA', 'GDP', 'CPI', 'WACC', 'CAPM', 'ROE', 'ROA',
      'ROIC', 'ROCE', 'NPV', 'IRR', 'FCF', 'COGS', 'SGNA', 'OPEX', 'CAPEX', 'YOY', 'YTD',
      'CAGR', 'DDM', 'FCFF', 'FCFE', 'EV', 'WIP', 'AI', 'ML', 'IT', 'R', 'C',
      'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD', 'SEK', 'NOK',
      'NYSE', 'NASDAQ', 'FTSE', 'SPX', 'NDX', 'DJI', 'VIX',
    ]);
    if (!falsePositives.has(t)) return t;
  }

  // 2. Check known company name → ticker map (word-boundary match)
  const lower = query.toLowerCase();
  for (const [name, sym] of Object.entries(COMPANY_TICKER)) {
    const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(lower)) return sym;
  }

  return null;
}

/* ===================================================================
   HTML → TEXT
   =================================================================== */
function htmlToText(html) {
  if (!html) return '';
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim().replace(/\s+/g, ' ') : '';
}

function stripHtml(text) {
  if (!text) return '';
  return text.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

module.exports = { webSearch, webFetch, extractTicker };
