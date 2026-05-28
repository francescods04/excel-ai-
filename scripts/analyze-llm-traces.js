#!/usr/bin/env node

const { readLlmTraces, summarizeLlmTraces, TRACE_DIR } = require('../server/utils/llmTrace');

function parseArgs(argv) {
  const out = {
    limit: 20,
    showRecords: true,
    descending: true,
  };

  for (const arg of argv) {
    if (arg.startsWith('--since=')) {
      out.sinceMs = Date.parse(arg.slice('--since='.length));
      continue;
    }
    if (arg.startsWith('--limit=')) {
      out.limit = Number(arg.slice('--limit='.length)) || out.limit;
      continue;
    }
    if (arg.startsWith('--turn=')) {
      out.turnId = arg.slice('--turn='.length);
      continue;
    }
    if (arg.startsWith('--event=')) {
      out.eventType = arg.slice('--event='.length);
      continue;
    }
    if (arg === '--summary-only') {
      out.showRecords = false;
      continue;
    }
  }

  return out;
}

function sortEntries(obj = {}) {
  return Object.entries(obj).sort((a, b) => (b[1]?.count || 0) - (a[1]?.count || 0));
}

function printSummary(summary) {
  console.log(`Trace dir: ${TRACE_DIR}`);
  console.log(`Records: ${summary.count}`);
  console.log(`Requests: ${summary.requests} | Responses: ${summary.responses} | Errors: ${summary.errors} | Fallbacks: ${summary.fallbacks}`);
  console.log(`Latency avg: ${summary.avgLatencyMs}ms | Prompt tokens: ${summary.promptTokens} | Completion tokens: ${summary.completionTokens}`);

  const topModels = sortEntries(summary.byModel).slice(0, 5);
  if (topModels.length > 0) {
    console.log('\nTop models:');
    for (const [model, data] of topModels) {
      console.log(`- ${model}: count=${data.count}, responses=${data.responses}, errors=${data.errors}, latencyMs=${data.latencyMs}`);
    }
  }

  const topLabels = sortEntries(summary.byLabel).slice(0, 8);
  if (topLabels.length > 0) {
    console.log('\nTop labels:');
    for (const [label, data] of topLabels) {
      console.log(`- ${label}: count=${data.count}, responses=${data.responses}, errors=${data.errors}, latencyMs=${data.latencyMs}`);
    }
  }
}

function previewRecord(record) {
  const messageSummary = record.messageSummary
    ? ` msgs=${record.messageSummary.count}/${record.messageSummary.chars}c`
    : '';
  const responseChars = typeof record.responseText === 'string' ? ` resp=${record.responseText.length}c` : '';
  const turnPart = record.turnId ? ` turn=${record.turnId}` : '';
  const errorPart = record.error?.message ? ` error="${record.error.message}"` : '';
  return `${record.ts} ${record.eventType} ${record.provider || 'n/a'}/${record.model || 'n/a'} label="${record.label || ''}"${turnPart}${messageSummary}${responseChars}${errorPart}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = summarizeLlmTraces(args);
  printSummary(summary);

  if (!args.showRecords) return;

  const records = readLlmTraces(args);
  if (records.length === 0) {
    console.log('\nNo matching trace records.');
    return;
  }

  console.log(`\nRecent records (${records.length}):`);
  for (const record of records) {
    console.log(`- ${previewRecord(record)}`);
  }
}

main();
