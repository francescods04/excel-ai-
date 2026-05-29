'use strict';

// Wiring tests for the stepwise turn layer (Fase 2). The engine itself is
// covered by test_agent_step.js; here we verify execution-engine resolution
// (rollout safety) and stepTurn input guards. Full end-to-end drive is
// exercised by the client driver (Fase 3).

const assert = require('assert');

// Preserve + restore env we mutate.
const ENV_KEYS = ['AGENT_EXEC_ENGINE', 'VERCEL', 'NODE_ENV'];
const saved = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
function clearEnv() { for (const k of ENV_KEYS) delete process.env[k]; }

const turns = require('../../server/runtime/turns.js');

(async function main() {
  /* resolveExecutionEngine matrix */
  clearEnv();
  assert.strictEqual(turns.resolveExecutionEngine({}), 'legacy', 'default local → legacy');

  clearEnv(); process.env.AGENT_EXEC_ENGINE = 'stepwise';
  assert.strictEqual(turns.resolveExecutionEngine({}), 'stepwise', 'env stepwise wins');

  clearEnv(); process.env.AGENT_EXEC_ENGINE = 'legacy';
  assert.strictEqual(turns.resolveExecutionEngine({}), 'legacy', 'env legacy wins');

  clearEnv(); process.env.VERCEL = '1';
  assert.strictEqual(turns.resolveExecutionEngine({}), 'stepwise', 'vercel/prod default → stepwise');

  clearEnv(); process.env.NODE_ENV = 'production';
  assert.strictEqual(turns.resolveExecutionEngine({}), 'stepwise', 'NODE_ENV=production → stepwise');

  // per-turn override beats everything
  clearEnv(); process.env.VERCEL = '1';
  assert.strictEqual(turns.resolveExecutionEngine({ executionEngine: 'legacy' }), 'legacy', 'per-turn override wins over prod default');
  clearEnv();
  assert.strictEqual(turns.resolveExecutionEngine({ executionEngine: 'stepwise' }), 'stepwise', 'per-turn override wins over local default');

  console.log('OK resolveExecutionEngine matrix (env / prod / per-turn override)');

  /* stepTurn guards */
  clearEnv();
  await assert.rejects(
    () => turns.stepTurn('does-not-exist-123', null, null),
    /non trovato/,
    'stepTurn rejects unknown turnId'
  );
  console.log('OK stepTurn rejects unknown turnId');

  // restore env
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  console.log('\nstepwise turn wiring tests completed.');
})().catch(err => {
  console.error('FAIL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
