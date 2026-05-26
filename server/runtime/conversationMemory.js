// Conversation memory persistente: sliding window in RAM + flush atomico su file.
// Persiste su server/memory/{userId}.json (default 'default'). Compaction LLM > MAX_MEMORY_TURNS.
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const MEMORY_DIR = path.join(__dirname, '..', 'memory');
const USER_ID = process.env.MEMORY_USER_ID || 'default';
const MAX_MEMORY_TURNS = Number(process.env.MEMORY_MAX_TURNS) || 15;
const COMPACT_THRESHOLD = Number(process.env.MEMORY_COMPACT_THRESHOLD) || 30;

let memory = [];
let summary = '';
let pendingWrite = null;
const WRITE_DEBOUNCE_MS = 500;

function memoryFilePath(userId = USER_ID) {
  return path.join(MEMORY_DIR, `${userId}.json`);
}

function ensureDir() {
  try {
    if (!fs.existsSync(MEMORY_DIR)) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
    }
  } catch (_) {
    // Vercel serverless: read-only filesystem
  }
}

function load() {
  try {
    ensureDir();
    const fp = memoryFilePath();
    if (!fs.existsSync(fp)) return;
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    memory = Array.isArray(raw.turns) ? raw.turns : [];
    summary = typeof raw.summary === 'string' ? raw.summary : '';
    logger.info(`[Memory] Loaded ${memory.length} turns + summary(${summary.length} chars) from ${fp}`);
  } catch (err) {
    logger.warn(`[Memory] Load failed: ${err.message}`);
    memory = [];
    summary = '';
  }
}

function flush() {
  try {
    ensureDir();
    const fp = memoryFilePath();
    const tmp = `${fp}.tmp`;
    const data = JSON.stringify({ summary, turns: memory, updatedAt: new Date().toISOString() }, null, 2);
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, fp);
  } catch (err) {
    logger.error(`[Memory] Flush failed: ${err.message}`);
  }
}

function scheduleFlush() {
  if (pendingWrite) clearTimeout(pendingWrite);
  pendingWrite = setTimeout(() => { pendingWrite = null; flush(); }, WRITE_DEBOUNCE_MS);
}

async function compact() {
  if (memory.length <= MAX_MEMORY_TURNS) return;
  const toCompact = memory.slice(0, memory.length - MAX_MEMORY_TURNS);
  // Compaction deterministica (no LLM): concatena + tronca. LLM compaction TODO se serve.
  const compactedLines = toCompact.map(t => {
    const sheets = t.sheetsCreated?.length > 0 ? ` [${t.sheetsCreated.join(',')}]` : '';
    return `- ${t.objective}${sheets}`;
  });
  summary = (summary ? summary + '\n' : '') + compactedLines.join('\n');
  // Tronca summary se diventa enorme
  if (summary.length > 4000) summary = summary.slice(-4000);
  memory = memory.slice(memory.length - MAX_MEMORY_TURNS);
  logger.info(`[Memory] Compacted ${toCompact.length} turns into summary (${summary.length} chars)`);
}

function addTurnMemory({ turnId, objective, planSummary, sheetsCreated, modelType, keyCells }) {
  memory.push({
    turnId,
    objective: String(objective || ''),
    planSummary: String(planSummary || ''),
    sheetsCreated: Array.isArray(sheetsCreated) ? sheetsCreated : [],
    modelType: modelType || null,
    keyCells: keyCells || null,
    timestamp: new Date().toISOString()
  });
  if (memory.length > COMPACT_THRESHOLD) {
    void compact();
  }
  scheduleFlush();
}

function getConversationContext() {
  if (memory.length === 0 && !summary) return '';
  const recent = memory.slice(-15);
  const lines = recent.map((entry, idx) => {
    const sheets = entry.sheetsCreated.length > 0 ? ` (fogli: ${entry.sheetsCreated.join(', ')})` : '';
    const model = entry.modelType ? ` [modello: ${entry.modelType}]` : '';
    return `Turn ${idx + 1}: "${entry.objective}"${sheets}${model}\nRisultato: ${entry.planSummary}`;
  });
  const summaryBlock = summary ? `STORICO COMPATTATO:\n${summary}\n\n` : '';
  const recentBlock = lines.length > 0 ? `CONVERSAZIONE RECENTE:\n${lines.join('\n---\n')}\n\n` : '';
  return summaryBlock + recentBlock;
}

function isDurableModelEntry(entry) {
  if (!entry || !entry.modelType || !Array.isArray(entry.sheetsCreated) || entry.sheetsCreated.length === 0) {
    return false;
  }
  const modelType = String(entry.modelType || '').toLowerCase();
  return modelType !== 'custom';
}

function toModelState(entry) {
  return {
    modelType: entry.modelType,
    sheets: entry.sheetsCreated,
    turnId: entry.turnId,
    keyCells: entry.keyCells || {}
  };
}

function selectLastModelState(turns = []) {
  const entries = Array.isArray(turns) ? turns : [];

  // Prefer the latest durable model state over a later partial styling/edit turn.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (isDurableModelEntry(entry)) return toModelState(entry);
  }

  // Fallback for non-finance/custom workbooks: keep the latest touched workbook area.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.modelType && entry.sheetsCreated.length > 0) {
      return toModelState(entry);
    }
  }
  return null;
}

function getLastModelState() {
  return selectLastModelState(memory);
}

function getRecentSheets() {
  const sheets = new Set();
  for (let i = memory.length - 1; i >= 0; i--) {
    for (const s of memory[i].sheetsCreated) sheets.add(s);
  }
  return Array.from(sheets);
}

function clearMemory() {
  memory = [];
  summary = '';
  scheduleFlush();
}

// Carica all'import
load();

// Flush sincrono su exit
process.on('beforeExit', () => {
  if (pendingWrite) {
    clearTimeout(pendingWrite);
    pendingWrite = null;
    flush();
  }
});

module.exports = {
  addTurnMemory,
  getConversationContext,
  getRecentSheets,
  getLastModelState,
  selectLastModelState,
  clearMemory,
  _flush: flush // testing
};
