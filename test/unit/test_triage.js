const assert = require('assert');
const {
  triageObjective,
  extractTriageJson,
  validateTriageDecision,
  buildSafeFallback,
  buildTriageUserContent,
  extractScaleHints
} = require('../../server/agents/triage');

function makeMockLLM(scriptedResponses) {
  let i = 0;
  return async () => {
    const next = scriptedResponses[i++];
    if (next instanceof Error) throw next;
    return next;
  };
}

async function test_triage_simple_objective_routes_to_single_agent() {
  const mock = makeMockLLM([{
    complexity: 'trivial',
    parallelizable: false,
    mode: 'single_agent',
    estimated_iterations: 4,
    reasoning: 'Single-cell formula tweak.'
  }]);
  const result = await triageObjective({
    objective: 'cambia la formula in B5',
    context: { activeSheet: 'Sheet1' },
    callLLMFn: mock
  });
  assert.strictEqual(result.complexity, 'trivial');
  assert.strictEqual(result.mode, 'single_agent');
  assert.strictEqual(result.estimated_iterations, 4);
  console.log('  ✓ trivial objective → single_agent');
}

async function test_triage_lbo_routes_to_architect() {
  const mock = makeMockLLM([{
    complexity: 'institutional',
    parallelizable: true,
    mode: 'architect_then_parallel',
    estimated_iterations: 50,
    reasoning: 'LBO is multi-sheet with parallelizable Assumptions/IS/Returns slices.'
  }]);
  const result = await triageObjective({
    objective: 'crea un modello LBO completo per una tech company, ~1000 righe',
    context: { activeSheet: 'Sheet1', workbookSheets: ['Sheet1'] },
    callLLMFn: mock
  });
  assert.strictEqual(result.complexity, 'institutional');
  assert.strictEqual(result.mode, 'architect_then_parallel');
  assert.strictEqual(result.parallelizable, true);
  console.log('  ✓ LBO objective → architect_then_parallel');
}

async function test_triage_incoherent_decision_is_corrected() {
  // LLM says architect_then_parallel but parallelizable=false → should downgrade to single_deep_plan
  const mock = makeMockLLM([{
    complexity: 'complex',
    parallelizable: false,
    mode: 'architect_then_parallel',
    estimated_iterations: 30,
    reasoning: 'Mistakenly requested parallel.'
  }]);
  const result = await triageObjective({
    objective: 'audit del modello esistente con focus su circular refs',
    context: {},
    callLLMFn: mock
  });
  assert.strictEqual(result.mode, 'single_deep_plan', 'should downgrade non-parallelizable parallel to single_deep_plan');
  console.log('  ✓ incoherent decision downgraded');
}

async function test_triage_trivial_with_heavy_mode_downgraded() {
  const mock = makeMockLLM([{
    complexity: 'trivial',
    parallelizable: true,
    mode: 'architect_then_parallel',
    estimated_iterations: 4,
    reasoning: 'wrong mode'
  }]);
  const result = await triageObjective({ objective: 'colora di rosso A1', context: {}, callLLMFn: mock });
  assert.strictEqual(result.mode, 'single_agent', 'trivial work must use single_agent');
  console.log('  ✓ trivial forced to single_agent');
}

async function test_triage_unparseable_uses_fallback() {
  const mock = makeMockLLM([{ raw: 'not json at all', jsonError: 'fail' }]);
  const result = await triageObjective({ objective: 'do something', context: {}, callLLMFn: mock });
  assert.strictEqual(result.mode, 'single_agent', 'fallback to single_agent on parse fail');
  assert.ok(result._meta.fallback, 'fallback flag set');
  console.log('  ✓ unparseable LLM response → safe fallback');
}

async function test_triage_llm_error_uses_fallback() {
  const mock = makeMockLLM([new Error('network down')]);
  const result = await triageObjective({ objective: 'do something', context: {}, callLLMFn: mock });
  assert.strictEqual(result.mode, 'single_agent');
  assert.ok(result._meta.fallback);
  console.log('  ✓ LLM throw → safe fallback');
}

async function test_triage_extracts_json_with_markdown_fences() {
  const fenced = '```json\n{"complexity":"complex","parallelizable":true,"mode":"architect_then_parallel","estimated_iterations":25,"reasoning":"x"}\n```';
  const parsed = extractTriageJson(fenced);
  assert.strictEqual(parsed.complexity, 'complex');
  console.log('  ✓ extractTriageJson handles markdown fences');
}

async function test_triage_extracts_json_with_prose() {
  const prose = 'Here is my decision: {"complexity":"moderate","parallelizable":false,"mode":"single_agent","estimated_iterations":10,"reasoning":"x"}';
  const parsed = extractTriageJson(prose);
  assert.strictEqual(parsed.complexity, 'moderate');
  console.log('  ✓ extractTriageJson handles surrounding prose');
}

async function test_triage_iterations_clamped() {
  const result = validateTriageDecision({
    complexity: 'complex',
    parallelizable: true,
    mode: 'architect_then_parallel',
    estimated_iterations: 5000,
    reasoning: 'x'
  }, 'obj');
  assert.ok(result.estimated_iterations <= 80, 'iters clamped to max');
  console.log('  ✓ iteration count clamped to safe range');
}

function test_extractScaleHints_reads_explicit_signals() {
  // Real estate prompt that under-delivered before: 10 piani × 1000mq + 1000 rows + sensitivity.
  const re = extractScaleHints('valutazione progetto immobiliare a vairano scalo, 10 piani di palazzo, 1000mq per piano +- analizza tutti i costi, vari scenario, sensitivity analysis e circa 1000 righe diverse');
  assert.strictEqual(re.rowsRequested, 1000, `expected 1000 rows, got ${re.rowsRequested}`);
  assert.strictEqual(re.units, 10, `expected 10 units (piani), got ${re.units}`);

  // Monthly + multi-year period spec.
  const dcf = extractScaleHints('build a 5 year DCF with monthly granularity and line-item detail');
  assert.strictEqual(dcf.periodGranularity, 'monthly');
  assert.strictEqual(dcf.periods, 60, `5 anni × 12 mesi = 60, got ${dcf.periods}`);
  assert.strictEqual(dcf.detailLevel, 'high');
  assert.ok(dcf.rowsRequested >= 500, `inferred row count should escalate with HIGH detail, got ${dcf.rowsRequested}`);

  // Plain objective: no scale signals — all null.
  const plain = extractScaleHints('cambia la formula in B5');
  assert.strictEqual(plain.rowsRequested, null);
  assert.strictEqual(plain.periods, null);
  assert.strictEqual(plain.units, null);
  assert.strictEqual(plain.detailLevel, null);

  console.log('  ✓ extractScaleHints reads rows/periods/units/detail signals');
}

async function test_triage_user_content_includes_context() {
  const txt = buildTriageUserContent({
    objective: 'build a DCF',
    context: { activeSheet: 'DCF', workbookSheets: ['DCF', 'Assumptions'], usedRange: 'A1:F30' },
    parentSummary: 'previously built revenue rows'
  });
  assert.ok(txt.includes('build a DCF'), 'includes objective');
  assert.ok(txt.includes('DCF, Assumptions'), 'includes sheet names');
  assert.ok(txt.includes('previously built revenue rows'), 'includes parent summary');
  console.log('  ✓ user content includes objective + state + parent');
}

(async () => {
  console.log('Triage tests:');
  await test_triage_simple_objective_routes_to_single_agent();
  await test_triage_lbo_routes_to_architect();
  await test_triage_incoherent_decision_is_corrected();
  await test_triage_trivial_with_heavy_mode_downgraded();
  await test_triage_unparseable_uses_fallback();
  await test_triage_llm_error_uses_fallback();
  await test_triage_extracts_json_with_markdown_fences();
  await test_triage_extracts_json_with_prose();
  await test_triage_iterations_clamped();
  await test_triage_user_content_includes_context();
  test_extractScaleHints_reads_explicit_signals();
  console.log('All triage tests passed.\n');
})().catch(err => {
  console.error('Triage test failed:', err);
  process.exit(1);
});
