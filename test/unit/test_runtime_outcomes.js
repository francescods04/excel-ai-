const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function test(name, fn) {
  try {
    await fn();
    console.log(`OK ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

function writeTurn(dir, filename, payload) {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(payload, null, 2));
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-outcomes-'));
  process.env.ADMIN_TURNS_DIR = tempDir;

  delete require.cache[require.resolve('../../server/utils/runtimeOutcomeSummary')];
  const {
    classifyAgentLoopReason,
    extractAgentLoopOutcome,
    readRuntimeOutcomes,
    summarizeRuntimeOutcomes,
  } = require('../../server/utils/runtimeOutcomeSummary');

  await test('classifyAgentLoopReason keeps stagnation detail and normalizes max iterations', () => {
    assert.deepStrictEqual(
      classifyAgentLoopReason('aborted', 'stagnation_repeat:get_cell_ranges:x4'),
      { category: 'stagnation', detail: 'stagnation_repeat:get_cell_ranges:x4' }
    );
    assert.deepStrictEqual(
      classifyAgentLoopReason('max_iterations', 'Reached max iterations'),
      { category: 'max_iterations', detail: 'max_iterations' }
    );
  });

  writeTurn(tempDir, 'turn-1.json', {
    id: 'turn-1',
    status: 'completed',
    createdAt: '2026-05-28T08:00:00.000Z',
    updatedAt: '2026-05-28T08:04:00.000Z',
    strategy: { reason: 'continuity_incremental_edit', promptVariant: 'fast' },
    items: [
      {
        taskId: 'agent-loop',
        completedAt: '2026-05-28T08:04:00.000Z',
        result: { status: 'completed', summary: 'Done', escalated: false }
      }
    ],
    results: {
      'agent-loop': {
        data: {
          builder: 'agent-loop',
          strategy: 'continuity_incremental_edit',
          promptVariant: 'fast',
          status: 'completed',
          summary: 'Done',
          iteration: 8
        }
      }
    }
  });

  writeTurn(tempDir, 'turn-2.json', {
    id: 'turn-2',
    status: 'completed',
    createdAt: '2026-05-28T09:00:00.000Z',
    updatedAt: '2026-05-28T09:12:00.000Z',
    strategy: { reason: 'agent_loop_escalation', promptVariant: 'fast' },
    items: [
      {
        taskId: 'agent-loop',
        completedAt: '2026-05-28T09:12:00.000Z',
        result: { status: 'max_iterations', summary: 'Reached max iterations', escalated: true }
      }
    ],
    results: {
      'agent-loop': {
        data: {
          builder: 'agent-loop',
          strategy: 'continuity_incremental_edit',
          promptVariant: 'fast',
          status: 'max_iterations',
          summary: 'Reached max iterations',
          iteration: 45
        }
      },
      'agent-loop:attempt': {
        data: {
          builder: 'agent-loop',
          strategy: 'continuity_incremental_edit',
          promptVariant: 'fast',
          status: 'max_iterations',
          summary: 'Reached max iterations',
          iteration: 45,
          escalated: true
        }
      }
    }
  });

  writeTurn(tempDir, 'turn-3.json', {
    id: 'turn-3',
    status: 'error',
    createdAt: '2026-05-28T10:00:00.000Z',
    updatedAt: '2026-05-28T10:06:00.000Z',
    strategy: { reason: 'continuity_incremental_edit', promptVariant: 'default' },
    items: [
      {
        taskId: 'agent-loop',
        completedAt: '2026-05-28T10:06:00.000Z',
        result: { status: 'aborted', summary: 'stagnation_repeat:get_cell_ranges:x4', escalated: false }
      }
    ],
    results: {
      'agent-loop': {
        data: {
          builder: 'agent-loop',
          strategy: 'continuity_incremental_edit',
          promptVariant: 'default',
          status: 'aborted',
          summary: 'stagnation_repeat:get_cell_ranges:x4',
          iteration: 12
        }
      }
    }
  });

  await test('extractAgentLoopOutcome pulls structured outcome from turn payloads', () => {
    const turn = JSON.parse(fs.readFileSync(path.join(tempDir, 'turn-2.json'), 'utf8'));
    const outcome = extractAgentLoopOutcome(turn);
    assert.strictEqual(outcome.turnId, 'turn-2');
    assert.strictEqual(outcome.escalated, true);
    assert.strictEqual(outcome.reasonCategory, 'max_iterations');
    assert.strictEqual(outcome.iteration, 45);
  });

  await test('readRuntimeOutcomes returns newest-first saved outcomes', () => {
    const outcomes = readRuntimeOutcomes({ limit: 10 });
    assert.strictEqual(outcomes.length, 3);
    assert.strictEqual(outcomes[0].turnId, 'turn-3');
    assert.strictEqual(outcomes[2].turnId, 'turn-1');
  });

  await test('summarizeRuntimeOutcomes aggregates escalation and reason counts', () => {
    const summary = summarizeRuntimeOutcomes({ summaryLimit: 10 });
    assert.strictEqual(summary.count, 3);
    assert.strictEqual(summary.completed, 1);
    assert.strictEqual(summary.aborted, 1);
    assert.strictEqual(summary.maxIterations, 1);
    assert.strictEqual(summary.escalated, 1);
    assert.strictEqual(summary.avgIterations, 22);
    assert.strictEqual(summary.avgEscalatedIterations, 45);
    assert.strictEqual(summary.byReasonCategory.stagnation.count, 1);
    assert.strictEqual(summary.byReasonDetail['stagnation_repeat:get_cell_ranges:x4'].count, 1);
    assert.strictEqual(summary.byPromptVariant.fast, 2);
    assert.strictEqual(summary.byStrategyReason.continuity_incremental_edit, 3);
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
