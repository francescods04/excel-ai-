#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { generateCode } = require('./codegen');
const { executeCode } = require('./bridge');
const logger = require('../server/utils/logger');

function summarizeActions(actions) {
  const summary = {
    totalActions: actions.length,
    createSheet: 0,
    setCellRange: 0,
    fillRange: 0,
    bulkSetFormat: 0,
    other: 0,
    totalCells: 0,
    totalFormulas: 0,
    sheets: new Set(),
  };

  for (const a of actions) {
    switch (a.type) {
      case 'createSheet':
        summary.createSheet++;
        if (a.sheet) summary.sheets.add(a.sheet);
        break;
      case 'setCellRange':
        summary.setCellRange++;
        if (a.sheet) summary.sheets.add(a.sheet);
        if (a.cells) {
          const entries = Object.entries(a.cells);
          summary.totalCells += entries.length;
          for (const [, cell] of entries) {
            if (cell.formula) summary.totalFormulas++;
          }
        }
        break;
      case 'fillRange':
        summary.fillRange++;
        if (a.sheet) summary.sheets.add(a.sheet);
        if (a.formula) summary.totalFormulas++;
        break;
      case 'bulk_set_format':
        summary.bulkSetFormat++;
        if (a.sheet) summary.sheets.add(a.sheet);
        break;
      default:
        summary.other++;
        if (a.sheet) summary.sheets.add(a.sheet);
        break;
    }
  }

  return summary;
}

async function run(objective, context = {}, options = {}) {
  const start = Date.now();

  const genResult = await generateCode(objective, context, {
    ...options,
    recordTokenUsage: true,
  });

  if (!genResult.code) {
    return {
      status: 'codegen_failed',
      error: genResult.error || 'No code generated',
      tokenUsage: genResult.tokenUsage,
      elapsedMs: Date.now() - start,
    };
  }

  logger.info(`[Runner] Executing generated code (${genResult.code.length} chars)`);

  let execResult;
  try {
    execResult = await executeCode(genResult.code, {
      timeoutMs: options.timeoutMs || 60000,
    });
  } catch (error) {
    return {
      status: 'execution_failed',
      error: error.message,
      code: genResult.code,
      tokenUsage: genResult.tokenUsage,
      elapsedMs: Date.now() - start,
    };
  }

  const summary = summarizeActions(execResult.actions);
  const totalElapsed = Date.now() - start;

  return {
    status: 'ok',
    code: genResult.code,
    codeLength: genResult.code.length,
    actions: execResult.actions,
    summary: {
      ...summary,
      sheets: [...summary.sheets],
    },
    cellCount: execResult.cellCount,
    stderr: execResult.stderr,
    tokenUsage: genResult.tokenUsage,
    timings: {
      codegenMs: genResult.elapsedMs,
      executionMs: execResult.elapsedMs,
      totalMs: totalElapsed,
    },
  };
}

module.exports = { run, summarizeActions };
