'use strict';

// detectSemanticErrorLoop: same root cause + same sheet recurring across
// the healthSeen rolling window. Counterpart to detectToolStagnation
// (which only catches same-signature loops on the trail of tool calls).
//
// Soft severity at SOFT (default 3) → caller injects replan hint.
// Hard severity at HARD (default 5) → caller aborts the run.

const assert = require('assert');
const { detectSemanticErrorLoop, buildSemanticLoopReplanMessage } = require('../../server/agents/agentLoop.js');

// 1) Below soft threshold → null
{
  const seen = [
    { sheet: 'Assumptions', addr: 'B15', rootCause: 'string-in-numeric' },
    { sheet: 'Assumptions', addr: 'B16', rootCause: 'string-in-numeric' }
  ];
  assert.strictEqual(detectSemanticErrorLoop(seen), null);
  console.log('OK semanticLoop returns null below soft threshold');
}

// 2) At soft threshold (3) → soft severity
{
  const seen = [
    { sheet: 'Revenue Model', addr: 'B12', rootCause: 'string-in-numeric' },
    { sheet: 'Revenue Model', addr: 'C12', rootCause: 'string-in-numeric' },
    { sheet: 'Revenue Model', addr: 'D12', rootCause: 'string-in-numeric' }
  ];
  const r = detectSemanticErrorLoop(seen);
  assert.ok(r, 'should fire');
  assert.strictEqual(r.pattern, 'semantic_error_loop');
  assert.strictEqual(r.severity, 'soft');
  assert.strictEqual(r.rootCause, 'string-in-numeric');
  assert.strictEqual(r.sheet, 'Revenue Model');
  assert.strictEqual(r.count, 3);
  console.log('OK semanticLoop fires soft at count=3');
}

// 3) At hard threshold (5) → hard severity
{
  const seen = Array.from({ length: 5 }, (_, i) => ({
    sheet: 'Revenue Model', addr: `B${12 + i}`, rootCause: 'string-in-numeric'
  }));
  const r = detectSemanticErrorLoop(seen);
  assert.ok(r, 'should fire');
  assert.strictEqual(r.severity, 'hard');
  assert.strictEqual(r.count, 5);
  console.log('OK semanticLoop fires hard at count=5');
}

// 4) Multiple sheets/causes — pick the highest-count bucket
{
  const seen = [
    { sheet: 'A', addr: 'A1', rootCause: 'empty-in-numeric' },
    { sheet: 'A', addr: 'A2', rootCause: 'empty-in-numeric' },
    { sheet: 'B', addr: 'A1', rootCause: 'string-in-numeric' },
    { sheet: 'B', addr: 'A2', rootCause: 'string-in-numeric' },
    { sheet: 'B', addr: 'A3', rootCause: 'string-in-numeric' },
    { sheet: 'B', addr: 'A4', rootCause: 'string-in-numeric' }
  ];
  const r = detectSemanticErrorLoop(seen);
  assert.ok(r);
  assert.strictEqual(r.sheet, 'B');
  assert.strictEqual(r.rootCause, 'string-in-numeric');
  assert.strictEqual(r.count, 4);
  console.log('OK semanticLoop picks worst bucket across mixed inputs');
}

// 5) "unknown" rootCause never trips the detector
{
  const seen = Array.from({ length: 10 }, (_, i) => ({
    sheet: 'X', addr: `A${i}`, rootCause: 'unknown'
  }));
  assert.strictEqual(detectSemanticErrorLoop(seen), null);
  console.log('OK semanticLoop ignores rootCause=unknown');
}

// 6) Different sheets, same rootCause → does NOT cluster across sheets
{
  const seen = [
    { sheet: 'A', addr: 'A1', rootCause: 'string-in-numeric' },
    { sheet: 'B', addr: 'A1', rootCause: 'string-in-numeric' },
    { sheet: 'C', addr: 'A1', rootCause: 'string-in-numeric' }
  ];
  assert.strictEqual(detectSemanticErrorLoop(seen), null);
  console.log('OK semanticLoop does not cluster across distinct sheets');
}

// 7) Window cap — distant errors don't keep counting forever
{
  const noise = Array.from({ length: 20 }, (_, i) => ({
    sheet: 'NoiseSheet', addr: `A${i}`, rootCause: 'unknown' // ignored by detector
  }));
  const seen = [
    { sheet: 'X', addr: 'A1', rootCause: 'string-in-numeric' },
    { sheet: 'X', addr: 'A2', rootCause: 'string-in-numeric' },
    { sheet: 'X', addr: 'A3', rootCause: 'string-in-numeric' },
    ...noise
  ];
  // The 3 X-rooted errors are now outside the default windowSize=12 → null
  assert.strictEqual(detectSemanticErrorLoop(seen), null);
  console.log('OK semanticLoop respects window cap');
}

// 8) Replan message names the sheet and rootCause
{
  const sig = { pattern: 'semantic_error_loop', rootCause: 'string-in-numeric', sheet: 'Revenue Model', count: 4, samples: ['Revenue Model!B12', 'Revenue Model!C12'] };
  const msg = buildSemanticLoopReplanMessage(sig);
  assert.ok(/STOP TACTICAL FIXES/.test(msg));
  assert.ok(/Revenue Model/.test(msg));
  assert.ok(/string-in-numeric/.test(msg));
  assert.ok(/4 consecutive/.test(msg));
  console.log('OK replan message names sheet, root cause, and count');
}

console.log('\nsemantic loop tests completed.');
