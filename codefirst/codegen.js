'use strict';

const path = require('path');
const fs = require('fs');
const { callLLM, resetUsageStats, getUsageStats } = require('../server/tools/llm');
const logger = require('../server/utils/logger');

const SYSTEM_PROMPT_PATH = path.join(__dirname, 'codegen-system.md');

let _systemPromptCache = null;

function loadSystemPrompt() {
  if (_systemPromptCache) return _systemPromptCache;
  _systemPromptCache = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
  return _systemPromptCache;
}

function buildUserPrompt(objective, context = {}) {
  const parts = ['## Task', '', objective, ''];

  if (context.activeSheet || context.workbookSheets) {
    parts.push('## Existing Workbook Context');
    if (context.workbookSheets && context.workbookSheets.length > 0) {
      parts.push(`Existing sheets: ${context.workbookSheets.join(', ')}`);
    }
    if (context.activeSheet) {
      parts.push(`Active sheet: ${context.activeSheet}`);
    }
    if (context.sheets) {
      for (const s of context.sheets) {
        const rows = s.usedRange?.rowCount || '?';
        const cols = s.usedRange?.columnCount || '?';
        parts.push(`  ${s.name}: ${rows} rows × ${cols} cols`);
      }
    }
    parts.push('');
  }

  parts.push('## Instructions');
  parts.push('Generate JSON actions that build this spreadsheet.');
  parts.push('Use createSheet to create sheets, setCellRange to write cells with values/formulas/styles, fillRange to fill formulas across ranges.');
  parts.push('Return ONLY {"actions": [...]}');
  parts.push('');

  return parts.join('\n');
}

function validateActions(actions, objective) {
  const warnings = [];

  if (!Array.isArray(actions)) return ['INVALID: actions must be an array'];

  const actionTypes = new Set(actions.map(a => a.type));
  const sheets = new Set();
  const sheetRefs = new Set();

  for (const a of actions) {
    if (a.sheet) sheets.add(a.sheet);
    if (a.type === 'setCellRange' && a.cells) {
      for (const [addr, cell] of Object.entries(a.cells)) {
        const val = cell.value;
        if (typeof val === 'number' && !cell.formula) {
          const loc = cell.note || cell.value;
          if (String(loc).length > 5 && String(loc).match(/^\d{4,}$/)) {
            warnings.push(`SUSPICIOUS: large hardcoded number at ${addr}: ${val}`);
          }
        }
        if (cell.formula && typeof cell.formula === 'string') {
          const match = cell.formula.match(/[A-Za-z]+[!]/g);
          if (match) {
            match.forEach(m => sheetRefs.add(m.replace('!', '')));
          }
        }
      }
    }
    if (a.type === 'fillRange' && a.sheet && a.formula) {
      const match = a.formula.match(/[A-Za-z]+[!]/g);
      if (match) {
        match.forEach(m => sheetRefs.add(m.replace('!', '')));
      }
    }
  }

  for (const ref of sheetRefs) {
    if (!sheets.has(ref)) {
      warnings.push(`MISSING: formula references sheet "${ref}" which is never created`);
    }
  }

  const numericCells = actions
    .filter(a => a.type === 'setCellRange' && a.cells)
    .flatMap(a => Object.entries(a.cells))
    .filter(([, c]) => typeof c.value === 'number' && !c.cellStyles?.numberFormat);
  if (numericCells.length > 5) {
    warnings.push(`FORMATTING: ${numericCells.length} numeric cells without numberFormat`);
  }

  return warnings;
}

function cleanGeneratedCode(raw) {
  let code = (raw || '').trim();

  code = code.replace(/```json\s*/g, '').replace(/```\s*$/g, '');

  try {
    const parsed = JSON.parse(code);
    if (parsed.actions && Array.isArray(parsed.actions)) return parsed;
    if (Array.isArray(parsed)) return { actions: parsed };
  } catch (_) {}

  return code;
}

async function generateCode(objective, context = {}, options = {}) {
  const {
    modelOverride = null,
    timeoutMs = 120000,
    recordTokenUsage = false,
    label = 'CodeGen',
  } = options;

  const systemPrompt = loadSystemPrompt();
  const userPrompt = buildUserPrompt(objective, context);

  logger.info(`[CodeGen] Generating actions for: "${objective.slice(0, 120)}..."`);

  if (recordTokenUsage) {
    resetUsageStats();
  }

  const start = Date.now();

  try {
    const result = await callLLM({
      system: systemPrompt,
      userText: userPrompt,
      timeoutMs,
      modelOverride,
      role: null,
      thinkingDisabled: true,
      jsonMode: true,
      label,
      trace: { scenario: label, phase: 'codegen' },
    });

    const elapsed = Date.now() - start;

    let actions = null;
    let rawText = null;

    if (result && typeof result === 'object') {
      rawText = JSON.stringify(result);
      if (Array.isArray(result.actions)) {
        actions = result.actions;
      } else if (Array.isArray(result)) {
        actions = result;
      } else {
        const vals = Object.values(result).filter(v => Array.isArray(v));
        if (vals.length === 1) actions = vals[0];
        else if (result.actions) actions = Array.isArray(result.actions) ? result.actions : null;
      }
    } else if (typeof result === 'string') {
      rawText = result;
      const cleaned = cleanGeneratedCode(result);
      if (typeof cleaned === 'object' && cleaned.actions) actions = cleaned.actions;
      else if (Array.isArray(cleaned)) actions = cleaned;
    }

    const warnings = actions ? validateActions(actions, objective) : [];
    if (warnings.length > 0) {
      logger.warn(`[CodeGen] ${warnings.length} quality warnings: ${warnings.slice(0, 3).join('; ')}`);
    }

    const tokenUsage = recordTokenUsage ? getUsageStats() : null;

    logger.info(`[CodeGen] Done (${elapsed}ms, ${actions ? actions.length : 0} actions, ${warnings.length} warnings)`);

    return {
      actions,
      rawText,
      elapsedMs: elapsed,
      tokenUsage,
      warnings,
      error: null,
    };
  } catch (error) {
    const elapsed = Date.now() - start;
    logger.error(`[CodeGen] Failed (${elapsed}ms): ${error.message}`);
    return {
      actions: null,
      rawText: null,
      elapsedMs: elapsed,
      tokenUsage: recordTokenUsage ? getUsageStats() : null,
      error: error.message,
    };
  }
}

module.exports = { generateCode, buildUserPrompt, loadSystemPrompt };
