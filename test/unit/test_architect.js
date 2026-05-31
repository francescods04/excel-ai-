const assert = require('assert');
const {
  generateBlueprint,
  validateBlueprint,
  validateSliceActions,
  extractArchitectJson,
  buildSliceWorkerPrompt
} = require('../../server/agents/architect');

function makeMockLLM(scriptedResponses) {
  let i = 0;
  return async () => {
    const next = scriptedResponses[i++];
    if (next instanceof Error) throw next;
    return next;
  };
}

const SAMPLE_LBO_BLUEPRINT = {
  objective_restated: 'Build a 5-year LBO model for a tech acquisition',
  global_layout_notes: 'Years in row 3, blue font for inputs, black for formulas.',
  slices: [
    {
      id: 'assumptions',
      title: 'Assumptions sheet',
      deps: [],
      scope: { sheets_owned: ['Assumptions'], ranges_owned: [], may_read_from: [] },
      instructions: 'Build all input assumptions.',
      estimated_iters: 6
    },
    {
      id: 'sources_uses',
      title: 'Sources & Uses',
      deps: ['assumptions'],
      scope: { sheets_owned: ['Sources & Uses'], ranges_owned: [], may_read_from: ['Assumptions!B5:B20'] },
      instructions: 'Build S&U.',
      estimated_iters: 4
    },
    {
      id: 'income_statement',
      title: 'Income Statement',
      deps: ['assumptions'],
      scope: { sheets_owned: ['Income Statement'], ranges_owned: [], may_read_from: ['Assumptions!B5:B30'] },
      instructions: 'Build IS rev/EBITDA/D&A.',
      estimated_iters: 6
    },
    {
      id: 'debt_schedule',
      title: 'Debt Schedule',
      deps: ['sources_uses', 'income_statement'],
      scope: { sheets_owned: ['Debt Schedule'], ranges_owned: [], may_read_from: ['Sources & Uses!B5:B12', 'Income Statement!C8:G8'] },
      instructions: 'Build debt schedule.',
      estimated_iters: 7
    },
    {
      id: 'finalize',
      title: 'Formatting & verification',
      deps: ['assumptions', 'sources_uses', 'income_statement', 'debt_schedule'],
      scope: { sheets_owned: [], ranges_owned: [], may_read_from: ['Assumptions', 'Sources & Uses', 'Income Statement', 'Debt Schedule'] },
      instructions: 'Format and verify.',
      estimated_iters: 4
    }
  ]
};

function test_validateBlueprint_accepts_valid_dag() {
  const r = validateBlueprint(SAMPLE_LBO_BLUEPRINT);
  assert.ok(r.ok, `expected ok, got errors: ${(r.errors || []).join('; ')}`);
  assert.strictEqual(r.blueprint.slices.length, 5);
  assert.strictEqual(r.blueprint.waves.length, 4, 'should have 4 waves');
  // Wave 0: assumptions
  assert.deepStrictEqual(r.blueprint.waves[0], ['assumptions']);
  // Wave 1: sources_uses + income_statement (both depend only on assumptions)
  assert.ok(r.blueprint.waves[1].includes('sources_uses'));
  assert.ok(r.blueprint.waves[1].includes('income_statement'));
  // Wave 2: debt_schedule
  assert.deepStrictEqual(r.blueprint.waves[2], ['debt_schedule']);
  // Wave 3: finalize
  assert.deepStrictEqual(r.blueprint.waves[3], ['finalize']);
  console.log('  ✓ valid DAG accepted, waves computed correctly');
}

function test_validateBlueprint_detects_cycle() {
  const cyclic = JSON.parse(JSON.stringify(SAMPLE_LBO_BLUEPRINT));
  cyclic.slices[0].deps = ['finalize']; // make assumptions depend on finalize → cycle
  const r = validateBlueprint(cyclic);
  assert.ok(!r.ok, 'cycle should be rejected');
  assert.ok(r.errors.some(e => /cycle/i.test(e)), `expected cycle error, got ${r.errors.join('; ')}`);
  console.log('  ✓ cycle detected');
}

function test_validateBlueprint_detects_same_wave_conflict() {
  // Two slices in same wave own same sheet exclusively
  const conflict = {
    slices: [
      { id: 'a', title: 'A', deps: [], scope: { sheets_owned: ['Sheet1'], ranges_owned: [], may_read_from: [] }, instructions: 'x', estimated_iters: 3 },
      { id: 'b', title: 'B', deps: [], scope: { sheets_owned: ['Sheet1'], ranges_owned: [], may_read_from: [] }, instructions: 'x', estimated_iters: 3 }
    ]
  };
  const r = validateBlueprint(conflict);
  assert.ok(!r.ok, 'sheet conflict should be rejected');
  assert.ok(r.errors.some(e => /Sheet1/.test(e)), 'error should mention the conflicting sheet');
  console.log('  ✓ same-wave sheet conflict detected');
}

function test_validateBlueprint_allows_same_sheet_with_disjoint_ranges() {
  const split = {
    slices: [
      { id: 'a', title: 'A', deps: [], scope: { sheets_owned: ['IS'], ranges_owned: ['IS!A5:G15'], may_read_from: [] }, instructions: 'x', estimated_iters: 3 },
      { id: 'b', title: 'B', deps: [], scope: { sheets_owned: ['IS'], ranges_owned: ['IS!A20:G30'], may_read_from: [] }, instructions: 'x', estimated_iters: 3 }
    ]
  };
  const r = validateBlueprint(split);
  assert.ok(r.ok, `expected ok with disjoint ranges, got: ${(r.errors||[]).join('; ')}`);
  console.log('  ✓ same sheet with disjoint ranges allowed');
}

function test_validateBlueprint_rejects_empty_slices() {
  assert.ok(!validateBlueprint({ slices: [] }).ok);
  assert.ok(!validateBlueprint(null).ok);
  assert.ok(!validateBlueprint({}).ok);
  console.log('  ✓ rejects empty/invalid input');
}

function test_validateBlueprint_drops_phantom_deps() {
  const withPhantom = {
    slices: [
      { id: 'a', title: 'A', deps: ['nonexistent_dep'], scope: { sheets_owned: ['Sheet1'] }, instructions: 'x' }
    ]
  };
  const r = validateBlueprint(withPhantom);
  assert.ok(r.ok, `should normalize phantom deps, got: ${(r.errors||[]).join('; ')}`);
  assert.deepStrictEqual(r.blueprint.slices[0].deps, [], 'phantom dep should be dropped');
  console.log('  ✓ phantom deps dropped during normalization');
}

function test_validateBlueprint_drops_self_dep() {
  const withSelf = {
    slices: [{ id: 'a', title: 'A', deps: ['a'], scope: { sheets_owned: ['Sheet1'] }, instructions: 'x' }]
  };
  const r = validateBlueprint(withSelf);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.blueprint.slices[0].deps, []);
  console.log('  ✓ self-dep dropped');
}

function test_validateBlueprint_accepts_valid_slice_actions() {
  const withActions = {
    slices: [
      {
        id: 'assumptions',
        title: 'Assumptions',
        deps: [],
        scope: { sheets_owned: ['Assumptions'], ranges_owned: [], may_read_from: [] },
        instructions: 'Deterministic assumptions',
        estimated_iters: 3,
        actions: [
          { tool: 'bulk_create_sheets', params: { names: ['Assumptions'] } },
          {
            tool: 'bulk_set_cell_ranges',
            params: {
              writes: [
                {
                  sheet: 'Assumptions',
                  cells: {
                    A1: { value: 'Driver' },
                    B1: { value: 'Value' },
                    A5: { value: 'Daily covers' },
                    B5: { value: 200 }
                  }
                }
              ]
            }
          },
          {
            tool: 'bulk_set_format',
            params: {
              formats: [
                { sheet: 'Assumptions', target: 'A1:B1', options: { bold: true, backgroundColor: '#0D1F2D' } }
              ]
            }
          }
        ]
      }
    ]
  };
  const r = validateBlueprint(withActions);
  assert.ok(r.ok, `expected deterministic actions to validate, got: ${(r.errors || []).join('; ')}`);
  assert.strictEqual(r.blueprint.slices[0].actions.length, 3);
  assert.strictEqual(r.blueprint.slices[0].actions[1].tool, 'bulk_set_cell_ranges');
  console.log('  ✓ valid deterministic slice actions accepted');
}

function test_validateBlueprint_rejects_invalid_slice_actions() {
  const invalid = {
    slices: [
      {
        id: 'bad',
        title: 'Bad',
        deps: [],
        scope: { sheets_owned: ['Bad'], ranges_owned: [], may_read_from: [] },
        instructions: 'Bad deterministic actions',
        actions: [
          {
            tool: 'bulk_set_cell_ranges',
            params: {
              writes: [{ sheet: 'Bad' }]
            }
          }
        ]
      }
    ]
  };
  const r = validateBlueprint(invalid);
  assert.ok(!r.ok, 'invalid action shape should fail blueprint validation');
  assert.ok(
    r.errors.some(e => /bad actions\[0\].*cells/i.test(e)),
    `expected clear action/cells error, got: ${r.errors.join('; ')}`
  );
  console.log('  ✓ invalid deterministic action shape rejected clearly');
}

function test_validateSliceActions_rejects_extra_action_fields() {
  const r = validateSliceActions('x', [
    { tool: 'bulk_create_sheets', params: { names: ['X'] }, thought: 'hidden prose' }
  ]);
  assert.ok(!r.ok, 'extra action fields should be rejected');
  assert.ok(r.errors.some(e => /unsupported field.*thought/i.test(e)), `unexpected errors: ${r.errors.join('; ')}`);
  console.log('  ✓ extra deterministic action fields rejected');
}

function test_extractArchitectJson_handles_fences() {
  const fenced = '```json\n' + JSON.stringify(SAMPLE_LBO_BLUEPRINT) + '\n```';
  const parsed = extractArchitectJson(fenced);
  assert.ok(parsed && Array.isArray(parsed.slices));
  assert.strictEqual(parsed.slices.length, 5);
  console.log('  ✓ extractArchitectJson handles fences');
}

async function test_generateBlueprint_happy_path() {
  const mock = makeMockLLM([SAMPLE_LBO_BLUEPRINT]);
  const bp = await generateBlueprint({
    objective: 'crea modello LBO',
    context: { activeSheet: 'Sheet1', workbookSheets: ['Sheet1'] },
    triage: { complexity: 'institutional', parallelizable: true, mode: 'architect_then_parallel', estimated_iterations: 50, reasoning: 'x' },
    callLLMFn: mock
  });
  assert.strictEqual(bp.slices.length, 5);
  assert.ok(bp.waves.length === 4);
  console.log('  ✓ generateBlueprint happy path');
}

async function test_generateBlueprint_throws_on_invalid_dag() {
  const cyclic = JSON.parse(JSON.stringify(SAMPLE_LBO_BLUEPRINT));
  cyclic.slices[0].deps = ['finalize'];
  const mock = makeMockLLM([cyclic]);
  await assert.rejects(
    generateBlueprint({ objective: 'x', context: {}, callLLMFn: mock }),
    /cycle/i
  );
  console.log('  ✓ generateBlueprint rejects invalid blueprint');
}

async function test_generateBlueprint_throws_on_unparseable() {
  const mock = makeMockLLM([{ raw: 'gibberish', jsonError: 'fail' }]);
  await assert.rejects(generateBlueprint({ objective: 'x', context: {}, callLLMFn: mock }), /unparseable/i);
  console.log('  ✓ generateBlueprint rejects unparseable LLM response');
}

function test_buildSliceWorkerPrompt_contains_scope_and_instructions() {
  const slice = SAMPLE_LBO_BLUEPRINT.slices[3]; // debt_schedule
  const prompt = buildSliceWorkerPrompt(slice, SAMPLE_LBO_BLUEPRINT);
  assert.ok(prompt.includes('debt_schedule'));
  assert.ok(prompt.includes('Debt Schedule'));
  assert.ok(prompt.includes('Sources & Uses!B5:B12'), 'must include may_read_from references');
  assert.ok(prompt.includes('DO NOT write to sheets or ranges outside your scope'));
  assert.ok(prompt.includes('Years in row 3, blue font for inputs'), 'must include global layout notes');
  console.log('  ✓ slice worker prompt contains scope + instructions + layout notes');
}

(async () => {
  console.log('Architect tests:');
  test_validateBlueprint_accepts_valid_dag();
  test_validateBlueprint_detects_cycle();
  test_validateBlueprint_detects_same_wave_conflict();
  test_validateBlueprint_allows_same_sheet_with_disjoint_ranges();
  test_validateBlueprint_rejects_empty_slices();
  test_validateBlueprint_drops_phantom_deps();
  test_validateBlueprint_drops_self_dep();
  test_validateBlueprint_accepts_valid_slice_actions();
  test_validateBlueprint_rejects_invalid_slice_actions();
  test_validateSliceActions_rejects_extra_action_fields();
  test_extractArchitectJson_handles_fences();
  await test_generateBlueprint_happy_path();
  await test_generateBlueprint_throws_on_invalid_dag();
  await test_generateBlueprint_throws_on_unparseable();
  test_buildSliceWorkerPrompt_contains_scope_and_instructions();
  console.log('All architect tests passed.\n');
})().catch(err => {
  console.error('Architect test failed:', err);
  process.exit(1);
});
