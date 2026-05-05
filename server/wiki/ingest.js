const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const logger = require('../utils/logger');
const { callLLM } = require('../tools/llm');

const WIKI_BASE_DIR = path.join(__dirname, '..', '..', 'docs', 'wiki');
const RAW_DIR = path.join(WIKI_BASE_DIR, 'raw');

/**
 * Ingest a PDF file into the wiki system.
 * Extracts text, then uses LLM to create/update wiki pages.
 */
async function ingestPdf(filePath, options = {}) {
  const { domain = 'finance', maxChunkSize = 8000, overlap = 500 } = options;
  const fileName = path.basename(filePath);

  logger.info(`[WikiIngest] Starting ingestion of ${fileName} into domain "${domain}"`);

  // 1. Extract text from PDF
  const buffer = fs.readFileSync(filePath);
  const pdfData = await pdfParse(buffer);
  const fullText = pdfData.text;

  logger.info(`[WikiIngest] Extracted ${fullText.length} chars from ${fileName} (${pdfData.numpages} pages)`);

  // 2. Split into chunks with overlap
  const chunks = splitIntoChunks(fullText, maxChunkSize, overlap);
  logger.info(`[WikiIngest] Split into ${chunks.length} chunks`);

  // 3. Process each chunk
  const domainDir = path.join(WIKI_BASE_DIR, domain);
  if (!fs.existsSync(domainDir)) {
    fs.mkdirSync(domainDir, { recursive: true });
  }

  // Ensure schema and index exist
  ensureDomainStructure(domain);

  const processedPages = [];
  for (let i = 0; i < chunks.length; i++) {
    logger.info(`[WikiIngest] Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);
    const pages = await processChunk(chunks[i], domain, fileName, i + 1, chunks.length);
    processedPages.push(...pages);
  }

  // 4. Update index
  await updateDomainIndex(domain, processedPages);

  // 5. Log the ingest
  logIngest(domain, fileName, pdfData.numpages, processedPages.length);

  logger.info(`[WikiIngest] Completed: ${processedPages.length} pages created/updated in domain "${domain}"`);
  return {
    fileName,
    domain,
    pages: pdfData.numpages,
    chunks: chunks.length,
    wikiPages: processedPages
  };
}

function splitIntoChunks(text, maxSize, overlap) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxSize;
    if (end >= text.length) {
      chunks.push(text.slice(start));
      break;
    }

    // Try to break at paragraph boundary
    const searchWindow = text.slice(end - 200, end + 200);
    const paragraphBreak = searchWindow.search(/\n\s*\n/);
    if (paragraphBreak >= 0) {
      end = end - 200 + paragraphBreak + 2;
    } else {
      // Try to break at sentence boundary
      const sentenceBreak = searchWindow.search(/[.!?]\s+/);
      if (sentenceBreak >= 0) {
        end = end - 200 + sentenceBreak + 2;
      }
    }

    chunks.push(text.slice(start, end));
    start = end - overlap;
  }

  return chunks;
}

async function processChunk(chunk, domain, sourceFile, chunkNum, totalChunks) {
  const systemPrompt = `You are a wiki maintainer AI. Your job is to extract structured knowledge from text and create/update markdown wiki pages.

Rules:
- Create concise, factual markdown pages
- Use [[Page Name]] for cross-references to related concepts
- Focus on concepts, formulas, techniques, and best practices
- Ignore table of contents, headers, page numbers
- Every claim should be precise and actionable
- Use professional terminology
- If a concept already exists in the wiki, enhance it rather than duplicating

Output format: Respond with a JSON object:
{
  "pages": [
    {
      "title": "Page Title",
      "fileName": "Page Title.md",
      "content": "# Page Title\n\n...markdown content..."
    }
  ]
}`;

  const userPrompt = `Extract wiki pages from this text chunk (${chunkNum}/${totalChunks}) from "${sourceFile}".

Domain: ${domain}

Text:
---
${chunk}
---

Create 1-3 wiki pages that capture the key concepts, formulas, techniques, or best practices from this text. Each page should be self-contained but can reference other concepts with [[Page Name]].`;

  try {
    const result = await callLLM({
      system: systemPrompt,
      userText: userPrompt,
      timeoutMs: 120000,
      fallbackTimeoutMs: 60000,
      label: `WikiIngest chunk ${chunkNum}/${totalChunks}`
    });

    let parsed;
    if (typeof result === 'object' && result.pages) {
      parsed = result;
    } else if (typeof result === 'object' && result.raw) {
      parsed = JSON.parse(result.raw.replace(/```json\s*/g, '').replace(/```\s*/g, ''));
    } else {
      // Try to extract JSON from text
      const jsonMatch = JSON.stringify(result).match(/\{[\s\S]*"pages"[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { pages: [] };
    }

    const pages = parsed.pages || [];
    const savedPages = [];

    for (const page of pages) {
      if (!page.title || !page.content) continue;
      const fileName = sanitizeFileName(page.fileName || page.title);
      const filePath = path.join(WIKI_BASE_DIR, domain, fileName);

      // If page exists, merge content
      if (fs.existsSync(filePath)) {
        const existing = fs.readFileSync(filePath, 'utf8');
        const merged = await mergeWikiPages(existing, page.content, sourceFile);
        fs.writeFileSync(filePath, merged);
        savedPages.push({ title: page.title, fileName, action: 'updated' });
      } else {
        fs.writeFileSync(filePath, page.content);
        savedPages.push({ title: page.title, fileName, action: 'created' });
      }
    }

    return savedPages;
  } catch (err) {
    logger.error(`[WikiIngest] Failed to process chunk ${chunkNum}: ${err.message}`);
    return [];
  }
}

async function mergeWikiPages(existing, newContent, sourceFile) {
  const systemPrompt = `You are a wiki merger AI. Merge new content into an existing wiki page, preserving what exists and adding new information. Avoid duplication. Update cross-references. Maintain markdown formatting.`;

  const userPrompt = `Merge this new content into the existing wiki page.

Source: ${sourceFile}

Existing page:
---
${existing}
---

New content to integrate:
---
${newContent}
---

Output the complete merged page as markdown. Preserve the existing structure and add new sections only where they provide new information.`;

  try {
    const result = await callLLM({
      system: systemPrompt,
      userText: userPrompt,
      timeoutMs: 120000,
      fallbackTimeoutMs: 60000,
      label: 'WikiIngest merge'
    });

    if (typeof result === 'string') return result;
    if (result.raw) return result.raw.replace(/```markdown\s*/g, '').replace(/```\s*/g, '');
    return existing + '\n\n' + newContent;
  } catch (err) {
    logger.warn(`[WikiIngest] Merge failed, appending instead: ${err.message}`);
    return existing + `\n\n<!-- Updated from ${sourceFile} -->\n\n` + newContent;
  }
}

function ensureDomainStructure(domain) {
  const domainDir = path.join(WIKI_BASE_DIR, domain);
  if (!fs.existsSync(domainDir)) {
    fs.mkdirSync(domainDir, { recursive: true });
  }

  // Create schema if missing
  const schemaPath = path.join(domainDir, '__schema__.md');
  if (!fs.existsSync(schemaPath)) {
    fs.writeFileSync(schemaPath, `# ${domain.charAt(0).toUpperCase() + domain.slice(1)} Wiki Schema\n\n## Purpose\nKnowledge base for ${domain}.\n\n## Conventions\n- Cross-reference with [[Page Name]]\n- Update index.md when adding pages\n\n## Maintenance\n1. Update relevant pages on new sources\n2. Add new pages for new concepts\n3. Update index.md\n4. Log updates in log.md\n`);
  }

  // Create index if missing
  const indexPath = path.join(domainDir, 'index.md');
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, `# Index — ${domain.charAt(0).toUpperCase() + domain.slice(1)} Wiki\n\n*(Auto-generated on first ingest)*\n`);
  }

  // Create log if missing
  const logPath = path.join(domainDir, 'log.md');
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, `# Log — ${domain.charAt(0).toUpperCase() + domain.slice(1)} Wiki\n\n## Ingest History\n`);
  }
}

async function updateDomainIndex(domain, newPages) {
  const indexPath = path.join(WIKI_BASE_DIR, domain, 'index.md');
  let indexContent = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : `# Index\n`;

  // Add new page references if not already present
  for (const page of newPages) {
    const link = `[[${page.title}]]`;
    if (!indexContent.includes(link)) {
      indexContent += `- ${link}\n`;
    }
  }

  fs.writeFileSync(indexPath, indexContent);
}

function logIngest(domain, fileName, pages, wikiPagesCount) {
  const logPath = path.join(WIKI_BASE_DIR, domain, 'log.md');
  const timestamp = new Date().toISOString().split('T')[0];
  const entry = `## [${timestamp}] ingest | ${fileName}\n- Pages in PDF: ${pages}\n- Wiki pages created/updated: ${wikiPagesCount}\n\n`;

  let logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : `# Log\n\n`;
  logContent += entry;
  fs.writeFileSync(logPath, logContent);
}

function sanitizeFileName(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) + '.md';
}

/**
 * Scan raw directory and ingest all PDFs.
 */
async function ingestAllRawPdfs(options = {}) {
  if (!fs.existsSync(RAW_DIR)) {
    logger.info('[WikiIngest] Raw directory does not exist, creating...');
    fs.mkdirSync(RAW_DIR, { recursive: true });
    return { ingested: [], message: 'Created raw directory. Add PDFs and run again.' };
  }

  const pdfs = fs.readdirSync(RAW_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));
  if (pdfs.length === 0) {
    return { ingested: [], message: 'No PDFs found in raw directory.' };
  }

  const results = [];
  for (const pdf of pdfs) {
    const filePath = path.join(RAW_DIR, pdf);
    try {
      const result = await ingestPdf(filePath, options);
      results.push(result);
    } catch (err) {
      logger.error(`[WikiIngest] Failed to ingest ${pdf}: ${err.message}`);
      results.push({ fileName: pdf, error: err.message });
    }
  }

  return { ingested: results, message: `Processed ${results.length} PDFs` };
}

module.exports = {
  ingestPdf,
  ingestAllRawPdfs,
  splitIntoChunks,
  RAW_DIR
};
