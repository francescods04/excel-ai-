const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const WIKI_BASE_DIR = path.join(__dirname, '..', '..', 'docs', 'wiki');

/**
 * Load all wiki pages from a domain directory.
 * Returns array of { title, content, filePath, domain }.
 */
function loadWikiDomain(domain) {
  const domainDir = path.join(WIKI_BASE_DIR, domain);
  if (!fs.existsSync(domainDir)) {
    logger.warn(`[WikiLoader] Domain directory not found: ${domainDir}`);
    return [];
  }

  const pages = [];
  const files = fs.readdirSync(domainDir)
    .filter(f => f.endsWith('.md') && !f.startsWith('__'))
    .map(f => ({ name: f, path: path.join(domainDir, f) }));

  for (const file of files) {
    try {
      const content = fs.readFileSync(file.path, 'utf8');
      const title = content.match(/^#\s+(.+)$/m)?.[1] || file.name.replace('.md', '');
      pages.push({
        title,
        content,
        filePath: file.path,
        domain,
        fileName: file.name
      });
    } catch (err) {
      logger.warn(`[WikiLoader] Failed to read ${file.path}: ${err.message}`);
    }
  }

  logger.info(`[WikiLoader] Loaded ${pages.length} pages from domain "${domain}"`);
  return pages;
}

/**
 * Load all available wiki domains.
 */
function loadAllDomains() {
  if (!fs.existsSync(WIKI_BASE_DIR)) return {};
  const domains = fs.readdirSync(WIKI_BASE_DIR)
    .filter(d => fs.statSync(path.join(WIKI_BASE_DIR, d)).isDirectory());

  const result = {};
  for (const domain of domains) {
    result[domain] = loadWikiDomain(domain);
  }
  return result;
}

/**
 * Search wiki pages by keyword (simple text search).
 * Returns array of matching pages sorted by relevance score.
 */
function searchWiki(keyword, domains = null) {
  const targetDomains = domains || Object.keys(loadAllDomains());
  const matches = [];
  const lowerKeyword = keyword.toLowerCase();

  for (const domain of targetDomains) {
    const pages = loadWikiDomain(domain);
    for (const page of pages) {
      const score = computeRelevanceScore(page.content, lowerKeyword);
      if (score > 0) {
        matches.push({ ...page, score });
      }
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches;
}

function computeRelevanceScore(content, keyword) {
  const lowerContent = content.toLowerCase();
  let score = 0;

  // Title match (highest weight)
  const titleMatch = content.match(/^#\s+(.+)$/m);
  if (titleMatch && titleMatch[1].toLowerCase().includes(keyword)) {
    score += 100;
  }

  // Exact phrase match
  const phraseCount = (lowerContent.match(new RegExp(keyword, 'g')) || []).length;
  score += phraseCount * 10;

  // Section header match
  const headerMatches = (lowerContent.match(new RegExp(`^##?\\s+.*${keyword}.*`, 'gm')) || []).length;
  score += headerMatches * 20;

  // Cross-reference match
  const xrefMatches = (lowerContent.match(new RegExp(`\\[\\[.*${keyword}.*\\]\\]`, 'g')) || []).length;
  score += xrefMatches * 5;

  return score;
}

/**
 * Get relevant wiki context for a prompt.
 * Searches across domains and returns concatenated content of top matches.
 */
function getWikiContextForPrompt(query, domains = ['finance', 'excel', 'accounting'], maxChars = 4000) {
  const matches = searchWiki(query, domains);
  if (matches.length === 0) return '';

  let context = '--- WIKI KNOWLEDGE BASE ---\n\n';
  let chars = context.length;

  for (const match of matches.slice(0, 5)) {
    const snippet = match.content.slice(0, 1500);
    const section = `## ${match.title} (${match.domain})\n${snippet}\n\n`;
    if (chars + section.length > maxChars) break;
    context += section;
    chars += section.length;
  }

  context += '--- END WIKI ---\n\n';
  return context;
}

/**
 * List all wiki domains and their page counts.
 */
function listWikiDomains() {
  if (!fs.existsSync(WIKI_BASE_DIR)) return [];
  return fs.readdirSync(WIKI_BASE_DIR)
    .filter(d => fs.statSync(path.join(WIKI_BASE_DIR, d)).isDirectory())
    .map(domain => {
      const pages = loadWikiDomain(domain);
      return { domain, pageCount: pages.length };
    });
}

module.exports = {
  loadWikiDomain,
  loadAllDomains,
  searchWiki,
  getWikiContextForPrompt,
  listWikiDomains,
  WIKI_BASE_DIR
};
