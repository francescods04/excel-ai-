const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

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

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-trace-'));
  process.env.LLM_TRACE_DIR = tempDir;
  process.env.LLM_TRACE_ENABLED = 'true';
  process.env.LLM_TRACE_CAPTURE_CONTENT = 'true';
  delete process.env.PLANNER_THINKING_ENABLED;
  delete process.env.TRIAGE_THINKING_ENABLED;
  delete process.env.ARCHITECT_THINKING_ENABLED;

  function loadLlmModule() {
    delete require.cache[require.resolve('../../server/tools/llm')];
    return require('../../server/tools/llm');
  }

  delete require.cache[require.resolve('../../server/utils/llmTrace')];
  delete require.cache[require.resolve('../../server/utils/executionContext')];

  const { writeLlmTrace, readLlmTraces, summarizeLlmTraces } = require('../../server/utils/llmTrace');
  const { runWithExecutionContext, getExecutionContext } = require('../../server/utils/executionContext');
  let { _buildTraceContext, _resolveRoleConfig, _readDeepSeekSseStream } = loadLlmModule();

  await test('execution context survives async boundaries', async () => {
    await runWithExecutionContext({ turnId: 'turn-ctx', phase: 'planning' }, async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      const ctx = getExecutionContext();
      assert.strictEqual(ctx.turnId, 'turn-ctx');
      assert.strictEqual(ctx.phase, 'planning');
    });
  });

  await test('trace context builder tolerates null trace input', async () => {
    await runWithExecutionContext({ turnId: 'turn-safe', userId: 'user-safe', phase: 'execution' }, async () => {
      const trace = _buildTraceContext(null);
      assert.strictEqual(trace.turnId, 'turn-safe');
      assert.strictEqual(trace.userId, 'user-safe');
      assert.strictEqual(trace.phase, 'execution');
      assert.ok(trace.traceId);
    });
  });

  await test('role routing keeps planner and triage on flash without thinking by default', async () => {
    const plannerCfg = _resolveRoleConfig('planner');
    const triageCfg = _resolveRoleConfig('triage');
    const architectCfg = _resolveRoleConfig('architect');

    assert.strictEqual(plannerCfg.model, 'deepseek-v4-flash');
    assert.strictEqual(plannerCfg.thinkingDisabled, true);
    assert.strictEqual(triageCfg.model, 'deepseek-v4-flash');
    assert.strictEqual(triageCfg.thinkingDisabled, true);
    assert.strictEqual(architectCfg.model, 'deepseek-v4-flash');
  });

  await test('planner thinking can be re-enabled explicitly via env', async () => {
    process.env.PLANNER_THINKING_ENABLED = 'true';
    ({ _resolveRoleConfig } = loadLlmModule());
    const plannerCfg = _resolveRoleConfig('planner');
    assert.strictEqual(plannerCfg.thinkingDisabled, false);
    assert.strictEqual(plannerCfg.reasoningEffort, 'medium');
    delete process.env.PLANNER_THINKING_ENABLED;
    ({ _resolveRoleConfig } = loadLlmModule());
  });

  await test('deepseek stream parser accumulates SSE chunks', async () => {
    const stream = new PassThrough();
    const chunks = [];
    const promise = _readDeepSeekSseStream(stream, { maxTotalMs: 1000 }, (delta, text, isDone) => {
      chunks.push({ delta, text, isDone });
    });

    stream.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n');
    stream.write('data: {"choices":[{"delta":{"content":"lo"}}]}\r\n');
    stream.end('data: [DONE]\n');

    const result = await promise;
    assert.strictEqual(result, 'hello');
    assert.strictEqual(chunks.at(-1).isDone, true);
  });

  await test('deepseek stream timeout swallows late reset errors', async () => {
    const stream = new PassThrough();
    const promise = _readDeepSeekSseStream(stream, { maxTotalMs: 5 }, () => {});

    await assert.rejects(promise, /Stream timeout after 5ms/);
    assert.strictEqual(stream.destroyed, true);
    stream.emit('error', Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
  });

  await test('llm trace writes, reads and summarizes structured records', async () => {
    writeLlmTrace({
      ts: '2026-05-27T10:00:00.000Z',
      eventType: 'llm.request',
      traceId: 'trace-1',
      turnId: 'turn-1',
      label: 'Planner LLM',
      role: 'planner',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      attempt: 'primary',
      messages: [
        { role: 'system', content: 'You are a planner.' },
        { role: 'user', content: 'Build a DCF for ACME.' },
      ],
    });

    writeLlmTrace({
      ts: '2026-05-27T10:00:01.000Z',
      eventType: 'llm.response',
      traceId: 'trace-1',
      turnId: 'turn-1',
      label: 'Planner LLM',
      role: 'planner',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      attempt: 'primary',
      latencyMs: 850,
      usage: { prompt_tokens: 120, completion_tokens: 80 },
      responseText: '{"plan":"ok"}',
      response: { plan: 'ok' },
    });

    writeLlmTrace({
      ts: '2026-05-27T10:00:01.500Z',
      eventType: 'llm.fallback',
      traceId: 'trace-1',
      turnId: 'turn-1',
      label: 'Planner LLM',
      role: 'planner',
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      attempt: 'fallback',
    });

    writeLlmTrace({
      ts: '2026-05-27T10:00:02.000Z',
      eventType: 'llm.error',
      traceId: 'trace-2',
      turnId: 'turn-1',
      label: 'NarratorAgent LLM',
      role: 'narrator',
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      attempt: 'fallback',
      latencyMs: 1200,
      error: { message: 'timeout', status: 504 },
    });

    const records = readLlmTraces({ turnId: 'turn-1', limit: 10 });
    assert.strictEqual(records.length, 4);
    assert.strictEqual(records[0].eventType, 'llm.error');
    assert.strictEqual(records[3].eventType, 'llm.request');
    assert.ok(Array.isArray(records[3].messages));
    assert.strictEqual(records[3].messageSummary.count, 2);

    const summary = summarizeLlmTraces({ turnId: 'turn-1', limit: 10 });
    assert.strictEqual(summary.count, 4);
    assert.strictEqual(summary.requests, 1);
    assert.strictEqual(summary.responses, 1);
    assert.strictEqual(summary.errors, 1);
    assert.strictEqual(summary.fallbacks, 1);
    assert.strictEqual(summary.promptTokens, 120);
    assert.strictEqual(summary.completionTokens, 80);
    assert.ok(summary.byModel['deepseek-v4-pro']);
    assert.ok(summary.byLabel['Planner LLM']);
    assert.ok(summary.byRole.planner);
    assert.strictEqual(summary.byRole.planner.requests, 1);
    assert.strictEqual(summary.byRole.planner.responses, 1);
    assert.ok(summary.byAttempt.primary);
    assert.strictEqual(summary.byAttempt.fallback.count, 2);
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
