const axios = require('axios');
const { spawn } = require('child_process');
const path = require('path');
const logger = require('../utils/logger');

const OPENBB_URL = (process.env.OPENBB_API_URL || 'http://127.0.0.1:6900').replace(/\/$/, '');
const OPENBB_TIMEOUT = Number(process.env.OPENBB_TIMEOUT_MS) || 30000;
const OPENBB_RETRY = Number(process.env.OPENBB_RETRY_COUNT) || 2;

// Track auto-start state
let _autoStartPromise = null;
let _autoStartDone = false;

const OPENBB_VENV = path.resolve(__dirname, '../../.venv-openbb/bin/activate');
const OPENBB_ENABLED = process.env.OPENBB_ENABLED === 'true';

const DEFAULT_PROVIDERS = {
  equity: 'yfinance',
  fixedincome: 'federal_reserve',
  economy: 'oecd',
  crypto: 'yfinance',
  currency: 'yfinance',
  etf: 'yfinance',
  index: 'cboe',
  derivatives: 'yfinance',
  technical: 'yfinance',
};

const MAX_CACHE = 500;
const cache = new Map();

const TTL = {
  quote: 5 * 60 * 1000,
  price: 5 * 60 * 1000,
  historical: 15 * 60 * 1000,
  fundamentals: 60 * 60 * 1000,
  ratios: 60 * 60 * 1000,
  metrics: 60 * 60 * 1000,
  profile: 24 * 60 * 60 * 1000,
  search: 24 * 60 * 60 * 1000,
  economy: 6 * 60 * 60 * 1000,
  rates: 15 * 60 * 1000,
  reference: 24 * 60 * 60 * 1000,
  default: 5 * 60 * 1000,
};

function cacheKey(path, params) {
  return `${path}:${JSON.stringify(params)}`;
}

function getCached(key, ttlCategory) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  const ttl = TTL[ttlCategory] || TTL.default;
  if (Date.now() - entry.timestamp > ttl) {
    cache.delete(key);
    return undefined;
  }
  return entry.data;
}

function setCached(key, data) {
  if (cache.size >= MAX_CACHE) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(key, { data, timestamp: Date.now() });
}

async function call(path, params = {}, ttlCategory = 'default') {
  // Auto-start OpenBB server if not running
  await ensureRunning();

  const key = cacheKey(path, params);
  const cached = getCached(key, ttlCategory);
  if (cached !== undefined) return cached;

  const url = `${OPENBB_URL}/api/v1/${path}`;
  logger.info(`[OpenBB] GET ${path} params=${JSON.stringify(params)}`);

  let lastError;
  for (let attempt = 0; attempt <= OPENBB_RETRY; attempt++) {
    try {
      const res = await axios.get(url, {
        params,
        timeout: OPENBB_TIMEOUT,
        headers: { 'User-Agent': 'excel-ai-agent/1.0' },
      });
      const data = res.data;

      if (data.results !== undefined) {
        setCached(key, data);
        return data;
      }
      if (data.detail) {
        const msg = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
        throw new Error(`OpenBB error: ${msg}`);
      }
      throw new Error(`OpenBB: unexpected response for ${path}`);
    } catch (e) {
      lastError = e;
      if (e.response) {
        const status = e.response.status;
        const detail = e.response.data?.detail;
        if (status === 422) {
          throw new Error(`OpenBB validation error: ${JSON.stringify(detail)}`);
        }
        if (status >= 400 && status < 500 && !(status === 429 || status === 408)) {
          throw new Error(`OpenBB client error ${status}: ${JSON.stringify(detail)}`);
        }
      }
      if (attempt < OPENBB_RETRY) {
        const delay = 500 * (attempt + 1);
        logger.warn(`[OpenBB] Retry ${attempt + 1}/${OPENBB_RETRY} in ${delay}ms: ${e.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

function providerFor(domain, overrides) {
  return overrides?.provider || DEFAULT_PROVIDERS[domain] || 'yfinance';
}

async function ensureRunning() {
  // Quick check: is it already up?
  try {
    await axios.get(`${OPENBB_URL}/api/v1/equity/price/quote`, {
      params: { symbol: 'AAPL', provider: 'yfinance' },
      timeout: 2000,
    });
    _autoStartDone = true;
    return;
  } catch {}

  // Don't try twice
  if (_autoStartPromise) return _autoStartPromise;
  if (_autoStartDone) return;
  if (!OPENBB_ENABLED) {
    logger.info('[OpenBB] OPENBB_ENABLED=false, skipping auto-start');
    _autoStartDone = true;
    return;
  }

  _autoStartPromise = (async () => {
    const fs = require('fs');
    if (!fs.existsSync(OPENBB_VENV)) {
      logger.warn('[OpenBB] .venv-openbb not found. Install: pip install openbb[all]');
      _autoStartDone = true;
      return;
    }

    logger.info('[OpenBB] Auto-starting openbb-api on port 6900...');
    const proc = spawn('bash', [
      '-c',
      `source "${OPENBB_VENV}" && OPENBB_API_AUTH=false openbb-api --port 6900 --host 127.0.0.1`
    ], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    proc.unref();

    // Wait up to 30s for it to come online
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        await axios.get(`${OPENBB_URL}/api/v1/equity/price/quote`, {
          params: { symbol: 'AAPL', provider: 'yfinance' },
          timeout: 5000,
        });
        logger.info('[OpenBB] Auto-start successful (port 6900)');
        _autoStartDone = true;
        return;
      } catch {}
    }
    logger.warn('[OpenBB] Auto-start timed out. Start manually: openbb-api --port 6900');
    _autoStartDone = true;
  })();

  return _autoStartPromise;
}

async function healthCheck() {
  try {
    const res = await axios.get(`${OPENBB_URL}/api/v1/equity/price/quote`, {
      params: { symbol: 'AAPL', provider: 'yfinance' },
      timeout: 10000,
    });
    return res.data && res.data.results ? true : false;
  } catch {
    return false;
  }
}

/* ================================================================
   EQUITY
   ================================================================ */
const equity = {
  async quote(symbol, overrides = {}) {
    const data = await call('equity/price/quote', {
      symbol, provider: providerFor('equity', overrides), ...overrides,
    }, 'quote');
    return data;
  },

  async historical(symbol, start_date, end_date, overrides = {}) {
    const data = await call('equity/price/historical', {
      symbol, start_date, end_date, provider: providerFor('equity', overrides), ...overrides,
    }, 'historical');
    return data;
  },

  async performance(symbol, overrides = {}) {
    return call('equity/price/performance', {
      symbol, provider: providerFor('equity', overrides), ...overrides,
    }, 'price');
  },

  async profile(symbol, overrides = {}) {
    return call('equity/profile', {
      symbol, provider: providerFor('equity', overrides), ...overrides,
    }, 'profile');
  },

  async search(query, overrides = {}) {
    return call('equity/search', {
      query, provider: providerFor('equity', overrides), ...overrides,
    }, 'search');
  },

  async marketSnapshots(overrides = {}) {
    return call('equity/market_snapshots', {
      provider: providerFor('equity', overrides), ...overrides,
    }, 'quote');
  },

  async historicalMarketCap(symbol, overrides = {}) {
    return call('equity/historical_market_cap', {
      symbol, provider: providerFor('equity', overrides), ...overrides,
    }, 'historical');
  },

  async screener(overrides = {}) {
    return call('equity/screener', {
      provider: providerFor('equity', overrides), ...overrides,
    }, 'quote');
  },

  fundamental: {
    async balance(symbol, period = 'annual', overrides = {}) {
      return call('equity/fundamental/balance', {
        symbol, period, provider: providerFor('equity', overrides), ...overrides,
      }, 'fundamentals');
    },

    async balanceGrowth(symbol, overrides = {}) {
      return call('equity/fundamental/balance_growth', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'fundamentals');
    },

    async income(symbol, period = 'annual', overrides = {}) {
      return call('equity/fundamental/income', {
        symbol, period, provider: providerFor('equity', overrides), ...overrides,
      }, 'fundamentals');
    },

    async incomeGrowth(symbol, overrides = {}) {
      return call('equity/fundamental/income_growth', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'fundamentals');
    },

    async cash(symbol, period = 'annual', overrides = {}) {
      return call('equity/fundamental/cash', {
        symbol, period, provider: providerFor('equity', overrides), ...overrides,
      }, 'fundamentals');
    },

    async cashGrowth(symbol, overrides = {}) {
      return call('equity/fundamental/cash_growth', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'fundamentals');
    },

    async metrics(symbol, overrides = {}) {
      return call('equity/fundamental/metrics', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'metrics');
    },

    async ratios(symbol, overrides = {}) {
      return call('equity/fundamental/ratios', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'ratios');
    },

    async dividends(symbol, overrides = {}) {
      return call('equity/fundamental/dividends', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'historical');
    },

    async trailingDividendYield(symbol, overrides = {}) {
      return call('equity/fundamental/trailing_dividend_yield', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'ratios');
    },

    async historicalEps(symbol, overrides = {}) {
      return call('equity/fundamental/historical_eps', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'fundamentals');
    },

    async historicalSplits(symbol, overrides = {}) {
      return call('equity/fundamental/historical_splits', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'fundamentals');
    },

    async employeeCount(symbol, overrides = {}) {
      return call('equity/fundamental/employee_count', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'profile');
    },

    async management(symbol, overrides = {}) {
      return call('equity/fundamental/management', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'profile');
    },

    async managementCompensation(symbol, overrides = {}) {
      return call('equity/fundamental/management_compensation', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'profile');
    },

    async esgScore(symbol, overrides = {}) {
      return call('equity/fundamental/esg_score', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'profile');
    },

    async revenuePerGeography(symbol, overrides = {}) {
      return call('equity/fundamental/revenue_per_geography', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'fundamentals');
    },

    async revenuePerSegment(symbol, overrides = {}) {
      return call('equity/fundamental/revenue_per_segment', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'fundamentals');
    },

    async filings(symbol, overrides = {}) {
      return call('equity/fundamental/filings', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'reference');
    },

    async transcript(symbol, year, quarter, overrides = {}) {
      return call('equity/fundamental/transcript', {
        symbol, year, quarter, provider: providerFor('equity', overrides), ...overrides,
      }, 'reference');
    },

    async reportedFinancials(symbol, period = 'annual', statement_type = 'income', overrides = {}) {
      return call('equity/fundamental/reported_financials', {
        symbol, period, statement_type, provider: providerFor('equity', overrides), ...overrides,
      }, 'fundamentals');
    },

    async managementDiscussionAnalysis(symbol, calendar_year, calendar_period, overrides = {}) {
      return call('equity/fundamental/management_discussion_analysis', {
        symbol, calendar_year, calendar_period, provider: providerFor('equity', overrides), ...overrides,
      }, 'reference');
    },
  },

  estimates: {
    async consensus(symbol, overrides = {}) {
      return call('equity/estimates/consensus', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'ratios');
    },

    async forwardEps(symbol, overrides = {}) {
      return call('equity/estimates/forward_eps', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'ratios');
    },

    async forwardPe(symbol, overrides = {}) {
      return call('equity/estimates/forward_pe', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'ratios');
    },

    async forwardSales(symbol, overrides = {}) {
      return call('equity/estimates/forward_sales', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'ratios');
    },

    async forwardEbitda(symbol, overrides = {}) {
      return call('equity/estimates/forward_ebitda', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'ratios');
    },

    async priceTarget(symbol, overrides = {}) {
      return call('equity/estimates/price_target', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'ratios');
    },
  },

  peers: {
    async peers(symbol, overrides = {}) {
      return call('equity/compare/peers', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'profile');
    },

    async companyFacts(symbol, overrides = {}) {
      return call('equity/compare/company_facts', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'profile');
    },
  },

  ownership: {
    async institutional(symbol, overrides = {}) {
      return call('equity/ownership/institutional', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'profile');
    },

    async majorHolders(symbol, overrides = {}) {
      return call('equity/ownership/major_holders', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'profile');
    },

    async insiderTrading(symbol, overrides = {}) {
      return call('equity/ownership/insider_trading', {
        symbol, provider: providerFor('equity', overrides), ...overrides,
      }, 'profile');
    },
  },

  calendar: {
    async dividend(overrides = {}) {
      return call('equity/calendar/dividend', {
        provider: providerFor('equity', overrides), ...overrides,
      }, 'reference');
    },

    async earnings(overrides = {}) {
      return call('equity/calendar/earnings', {
        provider: providerFor('equity', overrides), ...overrides,
      }, 'reference');
    },
  },
};

/* ================================================================
   FIXED INCOME
   ================================================================ */
const fixedincome = {
  async treasuryRates(overrides = {}) {
    return call('fixedincome/government/treasury_rates', {
      provider: providerFor('fixedincome', overrides), ...overrides,
    }, 'rates');
  },

  async yieldCurve(overrides = {}) {
    return call('fixedincome/government/yield_curve', {
      provider: providerFor('fixedincome', overrides), ...overrides,
    }, 'rates');
  },

  async treasuryAuctions(overrides = {}) {
    return call('fixedincome/government/treasury_auctions', {
      provider: providerFor('fixedincome', overrides), ...overrides,
    }, 'reference');
  },

  async tipsYields(overrides = {}) {
    return call('fixedincome/government/tips_yields', {
      provider: providerFor('fixedincome', overrides), ...overrides,
    }, 'rates');
  },

  async effr(overrides = {}) {
    return call('fixedincome/rate/effr', {
      provider: providerFor('fixedincome', overrides), ...overrides,
    }, 'rates');
  },

  async sofr(overrides = {}) {
    return call('fixedincome/rate/sofr', {
      provider: providerFor('fixedincome', overrides), ...overrides,
    }, 'rates');
  },

  async iorb(overrides = {}) {
    return call('fixedincome/rate/iorb', {
      provider: providerFor('fixedincome', overrides), ...overrides,
    }, 'rates');
  },

  async bondIndices(overrides = {}) {
    return call('fixedincome/bond_indices', {
      provider: providerFor('fixedincome', overrides), ...overrides,
    }, 'reference');
  },

  async mortgageIndices(overrides = {}) {
    return call('fixedincome/mortgage_indices', {
      provider: providerFor('fixedincome', overrides), ...overrides,
    }, 'reference');
  },

  async corporateSpotRates(overrides = {}) {
    return call('fixedincome/corporate/spot_rates', {
      provider: providerFor('fixedincome', overrides), ...overrides,
    }, 'rates');
  },

  async commercialPaper(overrides = {}) {
    return call('fixedincome/corporate/commercial_paper', {
      provider: providerFor('fixedincome', overrides), ...overrides,
    }, 'rates');
  },

  async treasuryEffr(overrides = {}) {
    return call('fixedincome/spreads/treasury_effr', {
      provider: providerFor('fixedincome', overrides), ...overrides,
    }, 'rates');
  },
};

/* ================================================================
   ECONOMY
   ================================================================ */
const economy = {
  async cpi(country = 'united_states', overrides = {}) {
    return call('economy/cpi', {
      country, provider: providerFor('economy', overrides), ...overrides,
    }, 'economy');
  },

  async gdpReal(country = 'united_states', overrides = {}) {
    return call('economy/gdp/real', {
      country, provider: providerFor('economy', overrides), ...overrides,
    }, 'economy');
  },

  async gdpNominal(country = 'united_states', overrides = {}) {
    return call('economy/gdp/nominal', {
      country, provider: providerFor('economy', overrides), ...overrides,
    }, 'economy');
  },

  async gdpForecast(country = 'united_states', overrides = {}) {
    return call('economy/gdp/forecast', {
      country, provider: providerFor('economy', overrides), ...overrides,
    }, 'economy');
  },

  async unemployment(country = 'united_states', overrides = {}) {
    return call('economy/unemployment', {
      country, provider: providerFor('economy', overrides), ...overrides,
    }, 'economy');
  },

  async interestRates(country = 'united_states', overrides = {}) {
    return call('economy/interest_rates', {
      country, provider: providerFor('economy', overrides), ...overrides,
    }, 'economy');
  },

  async riskPremium(overrides = {}) {
    return call('economy/risk_premium', {
      provider: providerFor('economy', overrides), ...overrides,
    }, 'reference');
  },

  async moneyMeasures(overrides = {}) {
    return call('economy/money_measures', {
      provider: providerFor('economy', overrides), ...overrides,
    }, 'economy');
  },

  async calendar(overrides = {}) {
    return call('economy/calendar', {
      provider: providerFor('economy', overrides), ...overrides,
    }, 'reference');
  },

  async centralBankHoldings(overrides = {}) {
    return call('economy/central_bank_holdings', {
      provider: providerFor('economy', overrides), ...overrides,
    }, 'economy');
  },

  async compositeLeadingIndicator(country = 'united_states', overrides = {}) {
    return call('economy/composite_leading_indicator', {
      country, provider: providerFor('economy', overrides), ...overrides,
    }, 'economy');
  },

  async countryProfile(country, overrides = {}) {
    return call('economy/country_profile', {
      country, provider: providerFor('economy', overrides), ...overrides,
    }, 'reference');
  },

  async housePriceIndex(country = 'united_states', overrides = {}) {
    return call('economy/house_price_index', {
      country, provider: providerFor('economy', overrides), ...overrides,
    }, 'economy');
  },

  async sharePriceIndex(country = 'united_states', overrides = {}) {
    return call('economy/share_price_index', {
      country, provider: providerFor('economy', overrides), ...overrides,
    }, 'economy');
  },

  async pce(overrides = {}) {
    return call('economy/pce', {
      provider: providerFor('economy', overrides), ...overrides,
    }, 'economy');
  },

  async totalFactorProductivity(overrides = {}) {
    return call('economy/total_factor_productivity', {
      provider: providerFor('economy', overrides), ...overrides,
    }, 'economy');
  },

  async fredSeries(symbol, overrides = {}) {
    return call('economy/fred_series', {
      symbol, provider: providerFor('economy', overrides), ...overrides,
    }, 'economy');
  },

  async indicators(symbol, country = 'united_states', overrides = {}) {
    return call('economy/indicators', {
      symbol, country, provider: providerFor('economy', overrides), ...overrides,
    }, 'economy');
  },
};

/* ================================================================
   INDEX
   ================================================================ */
const index = {
  async historical(symbol, overrides = {}) {
    return call('index/price/historical', {
      symbol, provider: providerFor('index', overrides), ...overrides,
    }, 'historical');
  },

  async snapshots(overrides = {}) {
    return call('index/snapshots', {
      provider: providerFor('index', overrides), ...overrides,
    }, 'quote');
  },

  async search(query, overrides = {}) {
    return call('index/search', {
      query, provider: providerFor('index', overrides), ...overrides,
    }, 'search');
  },

  async available(overrides = {}) {
    return call('index/available', {
      provider: providerFor('index', overrides), ...overrides,
    }, 'reference');
  },
};

/* ================================================================
   ETF
   ================================================================ */
const etf = {
  async historical(symbol, overrides = {}) {
    return call('etf/historical', {
      symbol, provider: providerFor('etf', overrides), ...overrides,
    }, 'historical');
  },

  async info(symbol, overrides = {}) {
    return call('etf/info', {
      symbol, provider: providerFor('etf', overrides), ...overrides,
    }, 'profile');
  },

  async search(query, overrides = {}) {
    return call('etf/search', {
      query, provider: providerFor('etf', overrides), ...overrides,
    }, 'search');
  },

  async holdings(symbol, overrides = {}) {
    return call('etf/holdings', {
      symbol, provider: providerFor('etf', overrides), ...overrides,
    }, 'fundamentals');
  },

  async sectors(symbol, overrides = {}) {
    return call('etf/sectors', {
      symbol, provider: providerFor('etf', overrides), ...overrides,
    }, 'fundamentals');
  },
};

/* ================================================================
   CURRENCY
   ================================================================ */
const currency = {
  async historical(symbol, overrides = {}) {
    return call('currency/price/historical', {
      symbol, provider: providerFor('currency', overrides), ...overrides,
    }, 'historical');
  },

  async referenceRates(overrides = {}) {
    return call('currency/reference_rates', {
      provider: providerFor('currency', overrides), ...overrides,
    }, 'rates');
  },
};

/* ================================================================
   CRYPTO
   ================================================================ */
const crypto = {
  async historical(symbol, overrides = {}) {
    return call('crypto/price/historical', {
      symbol, provider: providerFor('crypto', overrides), ...overrides,
    }, 'historical');
  },

  async search(query, overrides = {}) {
    return call('crypto/search', {
      query, provider: providerFor('crypto', overrides), ...overrides,
    }, 'search');
  },
};

/* ================================================================
   TECHNICAL
   ================================================================ */
const technical = {
  async ema(data, target = 'close', length = 50, overrides = {}) {
    return call('technical/ema', {
      data, target, length, provider: 'yfinance', ...overrides,
    }, 'price');
  },

  async sma(data, target = 'close', length = 50, overrides = {}) {
    return call('technical/sma', {
      data, target, length, provider: 'yfinance', ...overrides,
    }, 'price');
  },

  async rsi(data, target = 'close', length = 14, overrides = {}) {
    return call('technical/rsi', {
      data, target, length, provider: 'yfinance', ...overrides,
    }, 'price');
  },

  async macd(data, target = 'close', overrides = {}) {
    return call('technical/macd', {
      data, target, provider: 'yfinance', ...overrides,
    }, 'price');
  },

  async bbands(data, target = 'close', overrides = {}) {
    return call('technical/bbands', {
      data, target, provider: 'yfinance', ...overrides,
    }, 'price');
  },
};

/* ================================================================
   QUANTITATIVE
   ================================================================ */
const quantitative = {
  async summary(data, overrides = {}) {
    return call('quantitative/summary', { data, ...overrides }, 'price');
  },

  async capm(data, overrides = {}) {
    return call('quantitative/capm', { data, ...overrides }, 'ratios');
  },

  async sharpeRatio(data, overrides = {}) {
    return call('quantitative/performance/sharpe_ratio', { data, ...overrides }, 'ratios');
  },

  async sortinoRatio(data, overrides = {}) {
    return call('quantitative/performance/sortino_ratio', { data, ...overrides }, 'ratios');
  },
};

module.exports = {
  healthCheck,
  call,
  equity,
  fixedincome,
  economy,
  index,
  etf,
  currency,
  crypto,
  technical,
  quantitative,
};
