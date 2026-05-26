'use strict';

const logger = require('../utils/logger');
const { callLLM } = require('./llm');
const { webSearch, webFetch, extractTicker } = require('./web');

let openbb = null;
try { openbb = require('./openbb'); } catch (_) { /* optional */ }

// Lightweight LLM extractor: given a chunk of text, pull competitor names + tickers.
const COMPETITOR_EXTRACT_SYSTEM = `You are an investment-research extractor that builds a competitor universe for a target company.
The snippets you receive come from web SERP, Wikipedia, Yahoo Finance and DuckDuckGo, and they will often be ABOUT the target itself, not just about competitors. Your job: combine that information with your own world knowledge of the target company's industry and infer the most credible peer set.

Return ONLY JSON of shape:
{
  "industry": "string (e.g. 'Electric Vehicles / Automotive', 'Cloud Software', 'Specialty Retail')",
  "competitors": [
    { "name": "Apple Inc.", "ticker": "AAPL", "rationale": "Direct rival in consumer electronics / smartphones / wearables.", "confidence": 0.0-1.0 }
  ],
  "notes": "1-2 sentences on the competitive landscape (concentration, fragmentation, market trends)"
}

Rules:
- Use BOTH the snippets and your general knowledge to assemble the peer set. Snippets confirm context; your knowledge fills the standard rivals.
- Prefer publicly listed companies where possible (the user will likely build a comps model with these).
- Up to 12 competitors. Order by relevance (most direct rival first).
- ALWAYS include at least 4-8 companies if the target is well-known, even if the snippets don't explicitly list them.
- Set ticker to the most common exchange ticker (e.g. "AAPL", "BMW.DE", "7203.T"). If unsure, null.
- Confidence: 0.9+ for textbook direct rivals, 0.6-0.8 for plausible peers, 0.4-0.5 for tangential.
- Do NOT include the target itself in the competitor list.`;

function dedupeCompetitors(list) {
  const seen = new Map();
  for (const c of list || []) {
    if (!c || typeof c !== 'object') continue;
    const key = (c.ticker || c.name || '').toString().trim().toLowerCase();
    if (!key) continue;
    if (!seen.has(key)) {
      seen.set(key, { ...c });
    } else {
      const prior = seen.get(key);
      if ((c.confidence || 0) > (prior.confidence || 0)) prior.confidence = c.confidence;
      if (!prior.ticker && c.ticker) prior.ticker = c.ticker;
      if (!prior.rationale && c.rationale) prior.rationale = c.rationale;
    }
  }
  return Array.from(seen.values()).sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
}

async function findCompetitors(params = {}) {
  const company = String(params.company || params.companyName || '').trim();
  const ticker = (params.ticker || (company ? extractTicker(company) : null) || '').toString().trim().toUpperCase() || null;
  const maxResults = Math.min(Number(params.maxResults) || 10, 20);
  const includeWeb = params.includeWeb !== false;
  const includePeers = params.includePeers !== false;

  if (!company && !ticker) {
    throw new Error('research.competitors requires a company name or ticker');
  }

  const sources = [];
  const allCompetitors = [];
  let industry = null;
  const errors = [];

  // 1) OpenBB peers (works only when ticker known and openbb-api is up)
  if (includePeers && ticker && openbb) {
    try {
      const peerData = await openbb.equity.peers.peers(ticker, {});
      const peerList = Array.isArray(peerData?.results) ? peerData.results : (Array.isArray(peerData) ? peerData : []);
      for (const p of peerList.slice(0, maxResults)) {
        const peerTicker = p?.symbol || p?.ticker || (typeof p === 'string' ? p : null);
        const peerName = p?.name || p?.shortName || p?.longName || peerTicker;
        if (peerName || peerTicker) {
          allCompetitors.push({
            name: peerName || peerTicker,
            ticker: peerTicker || null,
            rationale: 'OpenBB peer set (yfinance similar tickers).',
            confidence: 0.75,
            source: 'openbb.peers'
          });
        }
      }
      sources.push('openbb.peers');
    } catch (e) {
      errors.push(`openbb.peers: ${e.message}`);
    }
  }

  // 2) Web search → SERP + Wikipedia + Yahoo + DDG
  const searchSnippets = [];
  if (includeWeb) {
    const queries = ticker
      ? [`${company || ticker} top competitors`, `${ticker} competitors list`, `${company || ticker} industry rivals`]
      : [`${company} top competitors`, `${company} competitors and alternatives`, `${company} industry rivals`];
    for (const q of queries) {
      try {
        const res = await webSearch({ query: q, maxResults: 8 });
        if (Array.isArray(res?.results)) {
          for (const item of res.results) {
            if (item?.title || item?.snippet) {
              searchSnippets.push({ title: item.title, snippet: item.snippet, source: item.source, url: item.url });
            }
            // Capture industry hint from Yahoo Finance financials block
            if (item?.source === 'Yahoo Finance' && item?.financials?.industry) {
              industry = industry || item.financials.industry;
            }
          }
        }
      } catch (e) {
        errors.push(`web.search "${q}": ${e.message}`);
      }
    }
    sources.push('web.search');
  }

  // 3) LLM extraction: turn snippets into structured competitor list.
  let llmExtracted = null;
  if (searchSnippets.length > 0) {
    const userText = [
      `Target company: ${company || ticker}${ticker && company ? ' (' + ticker + ')' : ''}`,
      industry ? `Known industry hint: ${industry}` : '',
      `Source snippets (deduplicate competitors across them):\n${JSON.stringify(searchSnippets.slice(0, 30), null, 2)}`,
      `Return JSON only.`
    ].filter(Boolean).join('\n\n');
    try {
      const result = await callLLM({
        system: COMPETITOR_EXTRACT_SYSTEM,
        userText,
        timeoutMs: 120000,
        label: `Competitor extractor ${company || ticker}`,
        cachePrompt: true,
        role: 'builder_analytical'
      });
      if (result && typeof result === 'object') {
        if (Array.isArray(result.competitors)) {
          for (const c of result.competitors) {
            allCompetitors.push({
              name: c?.name,
              ticker: c?.ticker || null,
              rationale: c?.rationale,
              confidence: typeof c?.confidence === 'number' ? c.confidence : 0.6,
              source: 'llm.extract'
            });
          }
        }
        industry = industry || result.industry || null;
        llmExtracted = { industry: result.industry, notes: result.notes };
      }
    } catch (e) {
      errors.push(`llm.extract: ${e.message}`);
    }
  }

  const merged = dedupeCompetitors(allCompetitors).slice(0, maxResults);

  // 4) Optional enrichment: for each competitor with a ticker, fetch quote snapshot.
  if (params.enrichWithQuotes && merged.some(c => c.ticker)) {
    const yahoo = require('./yahoo');
    for (const c of merged) {
      if (!c.ticker) continue;
      try {
        const q = await yahoo.quote({ ticker: c.ticker });
        if (q?.regularMarketPrice) {
          c.snapshot = {
            price: q.regularMarketPrice,
            marketCap: q.marketCap,
            pe: q.trailingPE,
            sector: q.sector,
            industry: q.industry
          };
        }
      } catch (_) { /* tolerate missing */ }
    }
  }

  return {
    target: { company: company || null, ticker },
    industry,
    competitors: merged,
    notes: llmExtracted?.notes,
    sourcesUsed: sources,
    snippetCount: searchSnippets.length,
    errors: errors.length > 0 ? errors : undefined
  };
}

module.exports = { findCompetitors };
