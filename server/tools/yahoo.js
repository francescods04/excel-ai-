const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const MAX_CACHE_ENTRIES = 200;
const cache = new Map();

const TTL_MS = {
  quote: 5 * 60 * 1000,
  historical: 5 * 60 * 1000,
  fundamentals: 60 * 60 * 1000
};

function cacheKey(fn, params) {
  return `${fn}:${JSON.stringify(params)}`;
}

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  const ttl = TTL_MS[entry.fn] || 60000;
  if (Date.now() - entry.timestamp > ttl) {
    cache.delete(key);
    return undefined;
  }
  return entry.data;
}

function setCached(key, fn, data) {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
  cache.set(key, { fn, data, timestamp: Date.now() });
}

async function withCache(fnName, key, fn) {
  const cached = getCached(key);
  if (cached !== undefined) return cached;
  const result = await fn();
  setCached(key, fnName, result);
  return result;
}

async function quote(ticker) {
  const key = cacheKey('quote', ticker);
  return withCache('quote', key, () => yahooFinance.quote(ticker));
}

async function historical(ticker, period = '1y') {
  const key = cacheKey('historical', { ticker, period });
  return withCache('historical', key, async () => {
    const end = new Date();
    const start = new Date();
    const map = { '1mo':1, '3mo':3, '6mo':6, '1y':12, '2y':24, '5y':60 };
    start.setMonth(start.getMonth() - (map[period] || 12));
    return yahooFinance.historical(ticker, { period1: start, period2: end });
  });
}

async function fundamentals(ticker) {
  const key = cacheKey('fundamentals', ticker);
  return withCache('fundamentals', key, async () => {
    try {
      const quoteData = await yahooFinance.quoteSummary(ticker, {
        modules: ['summaryDetail', 'defaultKeyStatistics', 'financialData']
      });
      return quoteData;
    } catch (e) {
      return { error: e.message };
    }
  });
}

module.exports = { quote, historical, fundamentals };
