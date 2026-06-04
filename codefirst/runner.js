#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { generateCode } = require('./codegen');
const logger = require('../server/utils/logger');

function summarizeActions(actions) {
  const summary = {
    totalActions: actions.length,
    createSheet: 0,
    setCellRange: 0,
    fillRange: 0,
    bulkSetFormat: 0,
    setCellFormat: 0,
    setNotes: 0,
    other: 0,
    totalCells: 0,
    totalFormulas: 0,
    sheets: new Set(),
  };

  for (const a of actions) {
    if (a.sheet) summary.sheets.add(a.sheet);
    switch (a.type) {
      case 'createSheet':
        summary.createSheet++;
        break;
      case 'setCellRange':
        summary.setCellRange++;
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
        if (a.formula) summary.totalFormulas++;
        break;
      case 'bulk_set_format':
        summary.bulkSetFormat++;
        break;
      case 'setCellFormat':
        summary.setCellFormat++;
        break;
      case 'setNotes':
        summary.setNotes++;
        break;
      default:
        summary.other++;
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

  if (!genResult.actions || !Array.isArray(genResult.actions)) {
    return {
      status: 'codegen_failed',
      error: genResult.error || 'No actions generated',
      tokenUsage: genResult.tokenUsage,
      elapsedMs: Date.now() - start,
    };
  }

  logger.info(`[Runner] Generated ${genResult.actions.length} actions directly`);

  const summary = summarizeActions(genResult.actions);
  const totalElapsed = Date.now() - start;

  return {
    status: 'ok',
    actions: genResult.actions,
    summary: {
      ...summary,
      sheets: [...summary.sheets],
    },
    cellCount: summary.totalCells,
    tokenUsage: genResult.tokenUsage,
    timings: {
      codegenMs: genResult.elapsedMs,
      totalMs: totalElapsed,
    },
  };
}

module.exports = { run, summarizeActions };
