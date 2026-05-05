'use strict';

import { parseTargetReference } from './parseTarget.js';

async function ensureWorksheet(context, sheetCache, sheetName, options) {
  const opts = options || {};
  if (!sheetName || typeof sheetName !== 'string' || sheetName.trim() === '') {
    throw new Error(`ensureWorksheet: sheet name is required (got: ${JSON.stringify(sheetName)}). If writing to a new sheet, call create_sheet first.`);
  }
  const name = sheetName.trim();
  if (sheetCache.has(name)) return sheetCache.get(name);

  const probe = context.workbook.worksheets.getItemOrNullObject(name);
  probe.load('name');
  await context.sync();
  if (!probe.isNullObject) {
    sheetCache.set(name, probe);
    return probe;
  }

  if (!opts.createIfMissing) {
    throw new Error(`Sheet "${name}" not found. Call create_sheet first, or pass createIfMissing:true.`);
  }

  try {
    const createdSheet = context.workbook.worksheets.add(name);
    sheetCache.set(name, createdSheet);
    await context.sync();
    return createdSheet;
  } catch (err) {
    try {
      const existing = context.workbook.worksheets.getItem(name);
      sheetCache.set(name, existing);
      await context.sync();
      return existing;
    } catch (innerErr) {
      throw new Error(`Failed to create or find sheet "${name}": ${err.message || innerErr.message}`);
    }
  }
}

async function getActiveSheetName(context) {
  const sheet = context.workbook.worksheets.getActiveWorksheet();
  sheet.load('name');
  await context.sync();
  return sheet.name;
}

export { ensureWorksheet, getActiveSheetName };
