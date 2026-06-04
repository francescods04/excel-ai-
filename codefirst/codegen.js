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
  parts.push('Write Python code that builds this spreadsheet using the excel_builder library.');
  parts.push('Return ONLY the JSON object with the "code" field.');
  parts.push('');

  return parts.join('\n');
}

function validateCode(code, objective) {
  const warnings = [];

  if ((code.match(/value.*round\(/g) || []).length > 0) {
    warnings.push('HARDCODED: Python round() in value= — use formula= instead');
  }
  if ((code.match(/growth_factor\s*=|factor\s*=\s*\d|multiplier\s*=\s*\d/g) || []).length > 0) {
    warnings.push('HARDCODED: growth_factor/computed variable — use Excel formula referencing Assumptions');
  }
  if ((code.match(/revenue\s*=\s*.*\*\s*.*\*\s*/g) || []).length > 0 &&
      (code.match(/formula.*revenue/g) || []).length === 0) {
    warnings.push('HARDCODED: revenue computed in Python — should be formula referencing assumptions');
  }
  if ((code.match(/ebitda\s*=\s*revenue\s*-\s*/gi) || []).length > 0) {
    warnings.push('HARDCODED: EBITDA computed in Python — should use formula');
  }

  const writeCalls = [...code.matchAll(/write\(/g)];
  const valueKw = [...code.matchAll(/['"]value['"]\s*:\s*\d+/g)];
  const numberFormat = [...code.matchAll(/numberFormat/g)];
  if (valueKw.length > 5 && numberFormat.length < 2) {
    warnings.push('FORMATTING: numeric values without numberFormat — add currency/% formatting');
  }

  const singleCreate = new Set([...code.matchAll(/create_sheet\(['"](\w+)['"]\)/g)].map(m => m[1]));
  const loopCreate = [...code.matchAll(/for\s+\w+\s+in\s*(\[.*?\]|\(.*?\))/g)]
    .flatMap(m => {
      const arrStr = m[1];
      const strMatches = [...arrStr.matchAll(/['"](\w+)['"]/g)];
      return strMatches.map(sm => sm[1]);
    });
  const sheetCreateAll = new Set([...singleCreate, ...loopCreate]);
  const writeSheetRefs = new Set([...code.matchAll(/write\(['"](\w+)['"]/g)].map(m => m[1]));
  for (const s of writeSheetRefs) {
    if (!sheetCreateAll.has(s) && s !== 'Sheet1') {
      warnings.push(`MISSING: sheet "${s}" is written but never created with create_sheet()`);
    }
  }

  if (!code.includes('finalize()')) {
    warnings.push('MISSING: finalize() call at end of script');
  }
  if (!code.includes('from excel_builder')) {
    warnings.push('MISSING: from excel_builder import *');
  }

  return warnings;
}

function cleanGeneratedCode(raw) {
  let code = (raw || '').trim();

  code = code.replace(/```python\s*/g, '').replace(/```\s*$/g, '');

  if (code.startsWith('{') && code.endsWith('}')) {
    try {
      const parsed = JSON.parse(code);
      if (parsed.code && typeof parsed.code === 'string') {
        return parsed.code.trim();
      }
    } catch (_) {}
  }

  if (code.startsWith('"code":') || code.includes('"code":')) {
    const m = code.match(/"code"\s*:\s*"((?:\\.|[^"\\])*)"/s);
    if (m) return JSON.parse(`"${m[1]}"`).trim();
  }

  if (code.includes('from excel_builder') || code.includes('create_sheet') || code.includes('finalize()')) {
    return code;
  }

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

  logger.info(`[CodeGen] Generating code for: "${objective.slice(0, 120)}..."`);

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

    let code = null;
    let rawText = null;

    if (result && typeof result === 'object') {
      rawText = JSON.stringify(result);
      if (result.code && typeof result.code === 'string') {
        code = result.code;
      } else {
        const vals = Object.values(result).filter(v => typeof v === 'string');
        if (vals.length === 1) code = vals[0];
        else if (result.code) code = String(result.code);
      }
    } else if (typeof result === 'string') {
      rawText = result;
      code = cleanGeneratedCode(result);
    }

    if (code) {
      code = cleanGeneratedCode(code);
    }

    const warnings = code ? validateCode(code, objective) : [];
    if (warnings.length > 0) {
      logger.warn(`[CodeGen] ${warnings.length} quality warnings: ${warnings.slice(0, 3).join('; ')}`);
    }

    const tokenUsage = recordTokenUsage ? getUsageStats() : null;

    logger.info(`[CodeGen] Done (${elapsed}ms, ${code ? code.length : 0} chars of code, ${warnings.length} warnings)`);

    return {
      code,
      rawText,
      elapsedMs: elapsed,
      tokenUsage,
      warnings,
      jsonError: null,
    };
  } catch (error) {
    const elapsed = Date.now() - start;
    logger.error(`[CodeGen] Failed (${elapsed}ms): ${error.message}`);
    return {
      code: null,
      rawText: null,
      elapsedMs: elapsed,
      tokenUsage: recordTokenUsage ? getUsageStats() : null,
      error: error.message,
    };
  }
}

module.exports = { generateCode, buildUserPrompt, loadSystemPrompt };
