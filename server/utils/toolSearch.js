const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','by','for','from','has','he','in','is','it',
  'its','of','on','that','the','to','was','will','with','you','your','i','me','my',
  'we','our','us','this','these','those','or','if','then','else','when','where',
  'what','which','who','how','all','any','both','each','few','more','most','other',
  'some','such','no','nor','not','only','own','same','so','than','too','very','can',
  'just','should','now','use','using','used','get','set','do','does','did','done'
]);

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t));
}

function buildIndex(tools) {
  // tools: array of {name, description, parameters}
  const docs = tools.map(t => {
    const paramText = Object.entries(t.parameters?.properties || {})
      .map(([k, v]) => `${k} ${v.description || ''} ${v.type || ''}`)
      .join(' ');
    const text = `${t.name} ${t.description || ''} ${paramText}`;
    return { tool: t, tokens: tokenize(text), text };
  });

  const N = docs.length;
  const df = {};
  docs.forEach(doc => {
    const seen = new Set(doc.tokens);
    seen.forEach(t => { df[t] = (df[t] || 0) + 1; });
  });

  const avgdl = docs.reduce((sum, d) => sum + d.tokens.length, 0) / N || 1;

  return { docs, df, N, avgdl };
}

function scoreDocs(index, query, k1 = 1.2, b = 0.75) {
  const qTokens = tokenize(query);
  const scores = new Map();

  index.docs.forEach(doc => {
    let score = 0;
    const dl = doc.tokens.length || 1;
    const freq = {};
    doc.tokens.forEach(t => { freq[t] = (freq[t] || 0) + 1; });

    qTokens.forEach(qt => {
      const f = freq[qt] || 0;
      if (f === 0) return;
      const idf = Math.log(1 + (index.N - (index.df[qt] || 0) + 0.5) / ((index.df[qt] || 0) + 0.5));
      const denom = f + k1 * (1 - b + b * dl / index.avgdl);
      score += idf * (f * (k1 + 1)) / denom;
    });

    if (score > 0) scores.set(doc.tool, score);
  });

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1]);
}

/* ---------- Global singleton index for tool search ---------- */
let _globalIndex = null;
let _globalTools = [];

function initializeTools(toolDefinitions) {
  _globalTools = toolDefinitions;
  _globalIndex = buildIndex(toolDefinitions.map(d => d.function || d));
}

function searchTools(query, topK = 5) {
  if (!_globalIndex) return [];
  const scored = scoreDocs(_globalIndex, query);
  return scored.slice(0, topK).map(([tool, score]) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    score: Math.round(score * 1000) / 1000
  }));
}

module.exports = { buildIndex, scoreDocs, tokenize, initializeTools, searchTools };
