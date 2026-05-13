const { callLLM } = require('../tools/llm');
const logger = require('../utils/logger');
const { validateTaskOutput } = require('../agents/critic');
const { getWikiContextForPrompt } = require('../wiki/loader');
const { buildDcfSection, inferDcfInputs } = require('./dcfTemplate');

const DCF_AI_TIMEOUT_MS = Number(process.env.DCF_AI_TIMEOUT_MS) || 90000;
const DCF_AI_FALLBACK_TIMEOUT_MS = Number(process.env.DCF_AI_FALLBACK_TIMEOUT_MS) || 45000;

const DCF_SHEETS = ['Assumptions', 'WACC', 'DCF', 'Sensitivity'];
const AI_SECTIONS = new Set(['assumptions', 'wacc', 'dcf', 'projection', 'sensitivity']);
const SECTION_REQUIREMENTS = {
  assumptions: {
    sheet: 'Assumptions',
    minCells: 50,
    required: [
      'B10', 'B11', 'B12', 'B13', 'B14', 'B15',
      'B18', 'B19', 'B20', 'B21', 'B22', 'B23',
      'B26', 'B27', 'B28', 'B29', 'B30',
      'B33', 'B34', 'B35', 'B36', 'B37'
    ],
    mustMatchTemplate: [
      'B10', 'B11', 'B12', 'B13', 'B14', 'B15',
      'B18', 'B19', 'B20', 'B21', 'B22', 'B23',
      'B26', 'B27', 'B28', 'B29', 'B30',
      'B33', 'B34', 'B35', 'B36', 'B37'
    ]
  },
  wacc: {
    sheet: 'WACC',
    minCells: 30,
    required: ['B4', 'B5', 'B6', 'B7', 'B10', 'B11', 'B12', 'B15', 'B16', 'B17', 'B19', 'B22', 'B23', 'B26', 'B27', 'B28', 'B29'],
    mustMatchTemplate: ['B4', 'B5', 'B6', 'B7', 'B10', 'B11', 'B12', 'B15', 'B16', 'B17', 'B19', 'B26', 'B27', 'B28', 'B29']
  },
  dcf: {
    sheet: 'DCF',
    minCells: 120,
    required: ['B5', 'C5', 'G20', 'C24', 'G24', 'H27', 'H28', 'H30', 'H33', 'H35', 'H40'],
    mustMatchTemplate: ['B5', 'C5', 'G20', 'C24', 'G24', 'H27', 'H28', 'H30', 'H33', 'H35', 'H40']
  },
  projection: {
    sheet: 'DCF',
    minCells: 120,
    required: ['B5', 'C5', 'G20', 'C24', 'G24', 'H27', 'H28', 'H30', 'H33', 'H35', 'H40'],
    mustMatchTemplate: ['B5', 'C5', 'G20', 'C24', 'G24', 'H27', 'H28', 'H30', 'H33', 'H35', 'H40']
  },
  sensitivity: {
    sheet: 'Sensitivity',
    minCells: 60,
    required: ['B4', 'C4', 'G4', 'B5', 'C5', 'G9', 'B13', 'C13', 'G13', 'B14', 'C14', 'G18'],
    mustMatchTemplate: ['C5', 'G9', 'C14', 'G18']
  }
};

const DCF_SECTION_SYSTEM_PROMPT = `You are an expert investment-banking analyst and Excel model builder embedded in Microsoft Excel.

You build one DCF workbook section at a time. The workbook, not chat, is the deliverable.

Return ONLY valid JSON. No markdown. No prose.

Output schema:
{
  "actions": [
    {
      "type": "setCellRange",
      "sheet": "Assumptions",
      "cells": {
        "A1": { "value": "Title", "cellStyles": { "bold": true } },
        "B10": { "value": 391035, "note": "Source: Yahoo Finance via app data; verify before relying." },
        "B37": { "formula": "=B35*B36" }
      },
      "allow_overwrite": true
    }
  ]
}

Operational rules:
1. Produce exactly one logical section. Prefer one setCellRange action per sheet section.
2. Every visible row must be auditable: professional label in Column A or a clear table header.
3. Put calculations in Excel formulas. Do not compute final valuation numbers in chat or hardcode them into formulas.
4. Business assumptions belong in visible input cells; downstream formulas must reference those cells.
5. Use absolute references for assumptions and cross-sheet drivers.
6. Do not use Excel comments/notes. If source text is needed, make it visible in nearby cells or labels.
7. Sensitivity tables must use direct formulas and an odd-sized grid around the base case.
8. If prior critic feedback is supplied, fix those exact issues while preserving the schema.
9. Use only supported action types: setCellRange, setCellValue, runFormula, setCellFormat, addConditionalFormat, createSheet.
10. Excel formulas must start with "=" and use valid A1 references.`;

const SECTION_CONTRACTS = {
  assumptions: `Build only the Assumptions sheet. Include company/source, historical market inputs, projection assumptions, WACC inputs, and equity bridge inputs. Use values for inputs and formulas only where a calculation is required, such as current market cap.`,
  wacc: `Build only the WACC sheet. Pull inputs from Assumptions. Include CAPM cost of equity, after-tax cost of debt, debt/equity weights, final WACC, and a beta evidence section that compares observed beta with peer/sector beta, unlevering and relevering peer beta to target D/E before selecting beta.`,
  dcf: `Build only the DCF sheet. Include five forecast years, terminal value, enterprise value, equity bridge, implied share price, current price, premium/discount, and a bridge check.`,
  projection: `Build only the DCF projection sheet content. Include five forecast years, terminal value, enterprise value, equity bridge, implied share price, current price, premium/discount, and a bridge check.`,
  sensitivity: `Build only the Sensitivity sheet. Include WACC x terminal-growth tables for implied share price and enterprise value. Use formulas, not Excel data-table syntax.`
};

function summarizeValue(value, depth = 0) {
  if (depth > 2) return '[depth-limit]';
  if (Array.isArray(value)) {
    const rows = value.length;
    const cols = Array.isArray(value[0]) ? value[0].length : 1;
    const preview = JSON.stringify(value.slice(0, 2)).slice(0, 220);
    return `[array ${rows}x${cols}] ${preview}`;
  }
  if (!value || typeof value !== 'object') {
    const text = String(value ?? '');
    return text.length > 220 ? `${text.slice(0, 220)}...` : text;
  }
  const entries = Object.entries(value).slice(0, 14);
  return Object.fromEntries(entries.map(([key, entryValue]) => [key, summarizeValue(entryValue, depth + 1)]));
}

function compactResultsForDcf(memory = {}, usesResults = []) {
  const results = memory?.results && typeof memory.results === 'object' ? memory.results : {};
  const keys = Array.isArray(usesResults) && usesResults.length > 0
    ? usesResults.filter(key => Object.prototype.hasOwnProperty.call(results, key))
    : Object.keys(results);

  return Object.fromEntries(keys.map(taskId => {
    const result = results[taskId];
    const actions = Array.isArray(result?.actions) ? result.actions : [];
    return [
      taskId,
      {
        data: summarizeValue(result?.data ?? result),
        actionCount: actions.length,
        actionPreview: actions.slice(0, 5).map(action => ({
          type: action?.type,
          sheet: action?.sheet,
          target: action?.target,
          cellCount: action?.cells && typeof action.cells === 'object' ? Object.keys(action.cells).length : undefined
        }))
      }
    ];
  }));
}

function stripCellSpec(spec) {
  if (!spec || typeof spec !== 'object') return { value: spec };
  const out = {};
  if (Object.prototype.hasOwnProperty.call(spec, 'value')) out.value = spec.value;
  if (Object.prototype.hasOwnProperty.call(spec, 'formula')) out.formula = spec.formula;
  return out;
}

function compactTemplateActions(actions = []) {
  return actions.map(action => {
    if (action?.type !== 'setCellRange' || !action.cells) {
      return {
        type: action?.type,
        sheet: action?.sheet,
        target: action?.target,
        value: action?.value,
        formula: action?.formula
      };
    }
    return {
      type: 'setCellRange',
      sheet: action.sheet,
      allow_overwrite: action.allow_overwrite,
      cells: Object.fromEntries(
        Object.entries(action.cells).map(([addr, spec]) => [addr, stripCellSpec(spec)])
      )
    };
  });
}

function normalizeCellSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { value: spec };
  }
  const normalized = {};
  if (Object.prototype.hasOwnProperty.call(spec, 'value')) normalized.value = spec.value;
  if (Object.prototype.hasOwnProperty.call(spec, 'formula')) normalized.formula = spec.formula;
  if (!normalized.formula && typeof normalized.value === 'string' && normalized.value.trim().startsWith('=')) {
    normalized.formula = normalized.value.trim();
    delete normalized.value;
  }
  if (spec.cellStyles && typeof spec.cellStyles === 'object') normalized.cellStyles = spec.cellStyles;
  if (spec.borderStyles && typeof spec.borderStyles === 'object') normalized.borderStyles = spec.borderStyles;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'value') && !normalized.formula) {
    normalized.value = spec.text ?? spec.label ?? '';
  }
  return normalized;
}

function normalizeActions(rawActions, fallbackSheet) {
  if (!Array.isArray(rawActions)) return [];
  const actions = [];
  for (const action of rawActions) {
    if (!action || typeof action !== 'object') continue;
    if (action.type === 'setCellRange' && action.cells && typeof action.cells === 'object') {
      actions.push({
        type: 'setCellRange',
        sheet: action.sheet || fallbackSheet,
        cells: Object.fromEntries(
          Object.entries(action.cells).map(([addr, spec]) => [addr, normalizeCellSpec(spec)])
        ),
        copyToRange: action.copyToRange,
        allow_overwrite: action.allow_overwrite !== false
      });
      continue;
    }
    if (action.type === 'runFormula') {
      actions.push({
        type: 'runFormula',
        sheet: action.sheet || fallbackSheet,
        target: action.target,
        value: action.value || action.formula
      });
      continue;
    }
    if (action.type === 'setCellValue') {
      actions.push({
        type: 'setCellValue',
        sheet: action.sheet || fallbackSheet,
        target: action.target,
        value: action.value
      });
      continue;
    }
    if (['setCellFormat', 'addConditionalFormat', 'createSheet'].includes(action.type)) {
      actions.push({ ...action, sheet: action.sheet || fallbackSheet });
    }
  }
  return actions.filter(action => {
    if (action.type === 'createSheet') return !!(action.name || action.sheet);
    if (action.type === 'setCellRange') return !!action.sheet && Object.keys(action.cells || {}).length > 0;
    return !!action.sheet && !!action.target;
  });
}

function getSheetCells(actions = [], sheetName) {
  const cells = {};
  for (const action of actions) {
    if (action?.type !== 'setCellRange' || !action.cells) continue;
    if (action.sheet !== sheetName) continue;
    Object.assign(cells, action.cells);
  }
  return cells;
}

function specSignature(spec) {
  if (!spec || typeof spec !== 'object') return JSON.stringify(spec ?? null);
  if (spec.formula !== undefined) return `f:${String(spec.formula).replace(/\s+/g, '').toUpperCase()}`;
  if (spec.value !== undefined) return `v:${JSON.stringify(spec.value)}`;
  return 'empty';
}

function validateDcfSectionContract(section, actions, fallbackActions) {
  const requirement = SECTION_REQUIREMENTS[section];
  if (!requirement) return { ok: true, errors: [] };

  const cells = getSheetCells(actions, requirement.sheet);
  const fallbackCells = getSheetCells(fallbackActions, requirement.sheet);
  const errors = [];
  const cellCount = Object.keys(cells).length;

  if (cellCount < requirement.minCells) {
    errors.push(`${section} returned ${cellCount} cells; minimum complete section is ${requirement.minCells}`);
  }

  for (const address of requirement.required) {
    if (!cells[address]) {
      errors.push(`${section} missing required cell ${requirement.sheet}!${address}`);
    }
  }

  for (const address of requirement.mustMatchTemplate || []) {
    if (!cells[address] || !fallbackCells[address]) continue;
    const actual = specSignature(cells[address]);
    const expected = specSignature(fallbackCells[address]);
    if (actual !== expected) {
      errors.push(`${section} changed protected cell ${requirement.sheet}!${address}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function fallbackWithBuilder(fallback, builder, extra = {}) {
  return {
    ...fallback,
    data: {
      ...(fallback.data || {}),
      builder,
      ...extra
    }
  };
}

function shouldUseAi(params = {}) {
  if (process.env.DCF_AI_BUILDER_ENABLED === 'false') return false;
  if (params.mode === 'template') return false;
  const section = String(params.section || '').toLowerCase();
  return AI_SECTIONS.has(section);
}

function sheetForSection(section) {
  if (section === 'assumptions') return 'Assumptions';
  if (section === 'wacc') return 'WACC';
  if (section === 'sensitivity') return 'Sensitivity';
  return 'DCF';
}

async function buildDcfSectionAi(params = {}, memory = {}) {
  const section = String(params.section || 'all').toLowerCase();
  const fallback = buildDcfSection(params, memory);

  if (!shouldUseAi(params)) {
    return fallbackWithBuilder(fallback, params.mode === 'template' ? 'template-requested' : 'template');
  }

  const inputs = inferDcfInputs(params, memory);
  const templateGuide = compactTemplateActions(fallback.actions);
  const context = compactResultsForDcf(memory, params.usesResults);
  const wikiContext = getWikiContextForPrompt(`dcf ${section} excel formulas`, ['finance', 'excel'], 2500);
  const criticBlock = Array.isArray(params.criticErrors) && params.criticErrors.length > 0
    ? params.criticErrors.map((error, index) => `${index + 1}. ${error}`).join('\n')
    : '';

  const userText = [
    `Build DCF section: ${section}`,
    `Objective: ${params.objective || 'Build a complete DCF model'}`,
    `Section contract: ${SECTION_CONTRACTS[section] || SECTION_CONTRACTS.projection}`,
    `Company inputs inferred from data:\n${JSON.stringify(inputs, null, 2)}`,
    `Previous task results, compacted:\n${JSON.stringify(context, null, 2)}`,
    `Executable template guide. This is the minimum correct structure; improve source notes, labels, and formulas only if you keep the same auditability:\n${JSON.stringify(templateGuide, null, 2)}`,
    criticBlock ? `Previous critic errors to fix:\n${criticBlock}` : '',
    wikiContext ? `Relevant finance/excel knowledge:\n${wikiContext}` : '',
    'Return JSON only.'
  ].filter(Boolean).join('\n\n');

  try {
    logger.info(`[DCF AI] Building section "${section}" with AI assistance`);
    const llmResult = await callLLM({
      system: DCF_SECTION_SYSTEM_PROMPT,
      userText,
      timeoutMs: DCF_AI_TIMEOUT_MS,
      fallbackTimeoutMs: DCF_AI_FALLBACK_TIMEOUT_MS,
      modelOverride: memory?.llm?.modelOverride || undefined,
      label: `DCF section ${section}`,
      cachePrompt: true,
      thinkingDisabled: true
    });

    const rawActions = Array.isArray(llmResult)
      ? llmResult
      : (Array.isArray(llmResult?.actions) ? llmResult.actions : []);
    const actions = normalizeActions(rawActions, sheetForSection(section));
    if (actions.length === 0) {
      throw new Error('AI returned no executable DCF actions');
    }

    const critic = validateTaskOutput({ data: {}, actions }, { sheets: DCF_SHEETS, references: new Set() });
    if (!critic.ok) {
      const summary = critic.errors.map(entry => entry.error).slice(0, 6).join('; ');
      throw new Error(`critic rejected AI section: ${summary}`);
    }
    const contract = validateDcfSectionContract(section, actions, fallback.actions);
    if (!contract.ok) {
      throw new Error(`section contract rejected AI output: ${contract.errors.slice(0, 6).join('; ')}`);
    }

    return {
      data: {
        ...(fallback.data || {}),
        builder: 'ai-assisted',
        fallbackActionCount: fallback.actions.length,
        actionCount: actions.length,
        warnings: critic.warnings || []
      },
      actions
    };
  } catch (error) {
    logger.warn(`[DCF AI] Section "${section}" fell back to template: ${error.message}`);
    return fallbackWithBuilder(fallback, 'template-fallback', { aiError: error.message });
  }
}

module.exports = {
  buildDcfSectionAi,
  compactResultsForDcf,
  normalizeActions,
  validateDcfSectionContract,
  DCF_SECTION_SYSTEM_PROMPT
};
