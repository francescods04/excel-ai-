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

  // post-init marker on the turn is honored
  clearEnv(); process.env.VERCEL = '1';
  assert.strictEqual(turns.resolveExecutionEngine({ executionEngine: 'legacy' }), 'legacy', 'turn marker wins over prod default');
  clearEnv();
  assert.strictEqual(turns.resolveExecutionEngine({ executionEngine: 'stepwise' }), 'stepwise', 'turn marker wins over local default');

  // explicit client override beats env and the post-init marker
  clearEnv(); process.env.AGENT_EXEC_ENGINE = 'stepwise';
  assert.strictEqual(turns.resolveExecutionEngine({ executionEngineOverride: 'legacy' }), 'legacy', 'client override beats env');
  clearEnv();
  assert.strictEqual(turns.resolveExecutionEngine({ executionEngineOverride: 'stepwise', executionEngine: 'legacy' }), 'stepwise', 'client override beats turn marker');

  console.log('OK resolveExecutionEngine matrix (env / prod / marker / client override)');

  /* stepTurn guards */
  clearEnv();
  await assert.rejects(
    () => turns.stepTurn('does-not-exist-123', null, null),
    /non trovato/,
    'stepTurn rejects unknown turnId'
  );
  console.log('OK stepTurn rejects unknown turnId');

  /* resolveStaleStep: concurrency / lost-response guard */
  {
    // matching seq → proceed (null)
    assert.strictEqual(
      turns.resolveStaleStep({ agentStepSeq: 3, agentState: { status: 'running' } }, 3),
      null,
      'matching seq → proceed'
    );
    // null clientSeq → proceed (back-compat)
    assert.strictEqual(
      turns.resolveStaleStep({ agentStepSeq: 3, agentState: { status: 'running' } }, null),
      null,
      'null clientSeq → proceed'
    );

    // client one behind + recorded lastStepResult → re-deliver it (idempotent)
    const lost = { control: 'emit_actions', payload: { actions: [{ type: 'setCellRange' }] }, stepSeq: 4 };
    const redeliver = turns.resolveStaleStep(
      { agentStepSeq: 4, agentState: { status: 'running' }, lastStepResult: lost },
      3
    );
    assert.strictEqual(redeliver.control, 'emit_actions', 'lost response → re-deliver same control');
    assert.deepStrictEqual(redeliver.payload.actions, lost.payload.actions, 're-deliver same actions');
    assert.strictEqual(redeliver.stepSeq, 4, 're-deliver same stepSeq');
    assert.strictEqual(redeliver.stale, true, 'marked stale');

    // stale mismatch, awaiting_client pending → re-emit requests (no advance)
    const reqs = [{ id: 'r1', toolName: 'workbook.readSheet', params: {} }];
    const reEmit = turns.resolveStaleStep(
      { agentStepSeq: 9, agentState: { status: 'awaiting_client', pending: { requests: reqs } } },
      2
    );
    assert.strictEqual(reEmit.control, 'await_client', 'stale await → re-emit await_client');
    assert.deepStrictEqual(reEmit.payload.requests, reqs, 're-emit pending requests');
    assert.strictEqual(reEmit.stepSeq, 9, 're-emit keeps current seq');

    // stale mismatch, paused pending → re-emit question
    const paused = turns.resolveStaleStep(
      { agentStepSeq: 5, agentState: { status: 'paused', pending: { question: [{ question: 'Q?' }] } } },
      1
    );
    assert.strictEqual(paused.control, 'paused', 'stale paused → re-emit paused');
    assert.ok(Array.isArray(paused.payload.question), 're-emit question payload');

    // stale mismatch, running → continue
    const cont = turns.resolveStaleStep({ agentStepSeq: 7, agentState: { status: 'running' } }, 1);
    assert.strictEqual(cont.control, 'continue', 'stale running → continue');

    console.log('OK resolveStaleStep (proceed / lost-response re-delivery / stale re-emit)');
  }

  /* action-result gating: client formula errors are terminal blockers */
  {
    const turn = {
      actionExecutions: [
        {
          taskId: 'agent-loop',
          itemId: 'batch-1',
          status: 'completed',
          errorCount: 0,
          isUndo: false,
          errors: []
        },
        {
          taskId: 'agent-loop',
          itemId: 'batch-2',
          status: 'error',
          errorCount: 2,
          isUndo: false,
          errors: [
            {
              type: 'formulaError',
              sheet: 'Cash Flow - Single Location',
              target: 'B5',
              message: 'Excel evaluated written formula to #REF!'
            }
          ]
        },
        {
          taskId: 'undo',
          itemId: 'undo',
          status: 'error',
          errorCount: 1,
          isUndo: true,
          errors: [{ message: 'Undo failed' }]
        }
      ]
    };
    const blockers = turns.getBlockingActionExecutionErrors(turn);
    assert.strictEqual(blockers.length, 1, 'only non-undo Excel write errors block completion');
    assert.strictEqual(blockers[0].itemId, 'batch-2');
    const summary = turns.summarizeActionExecutionErrors(blockers);
    assert.ok(summary.includes('Cash Flow - Single Location!B5'), 'summary includes failing formula address');
    assert.ok(summary.includes('#REF!'), 'summary includes Excel formula error');
    console.log('OK action-result gating detects formula errors and ignores undo failures');
  }

  // restore env
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  console.log('\nstepwise turn wiring tests completed.');
})().catch(err => {
  console.error('FAIL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
