const assert = require('assert');
const {
  generateBlueprint,
  validateBlueprint,
  validateSliceActions,
  extractVerbatimMenuFacts,
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

function test_validateBlueprint_accepts_declared_formula_sheet_refs() {
  const blueprint = {
    slices: [
      {
        id: 'assumptions',
        title: 'Assumptions',
        deps: [],
        scope: { sheets_owned: ['Assumptions'], ranges_owned: [], may_read_from: [] },
        instructions: 'Inputs',
        actions: [
          { tool: 'bulk_create_sheets', params: { names: ['Assumptions'] } },
          { tool: 'bulk_set_cell_ranges', params: { writes: [{ sheet: 'Assumptions', cells: { A1: { value: 'Driver' }, B1: { value: 100 } } }] } }
        ]
      },
      {
        id: 'cash_flow',
        title: 'Cash Flow',
        deps: ['assumptions'],
        scope: { sheets_owned: ['Cash Flow - Single Location'], ranges_owned: [], may_read_from: ['Assumptions!A1:B20'] },
        instructions: 'Cash flow',
        actions: [
          { tool: 'bulk_create_sheets', params: { names: ['Cash Flow - Single Location'] } },
          {
            tool: 'bulk_set_cell_ranges',
            params: {
              writes: [
                {
                  sheet: 'Cash Flow - Single Location',
                  cells: {
                    A1: { value: 'Cash Flow' },
                    B5: { formula: '=Assumptions!$B$1' }
                  }
                }
              ]
            }
          }
        ]
      }
    ]
  };
  const r = validateBlueprint(blueprint);
  assert.ok(r.ok, `expected declared sheet refs to pass, got: ${(r.errors || []).join('; ')}`);
  console.log('  ✓ deterministic formula refs to declared sheets accepted');
}

function test_validateBlueprint_rejects_undeclared_formula_sheet_refs() {
  const blueprint = {
    slices: [
      {
        id: 'cash_flow',
        title: 'Cash Flow',
        deps: [],
        scope: { sheets_owned: ['Cash Flow - Single Location'], ranges_owned: [], may_read_from: [] },
        instructions: 'Cash flow',
        actions: [
          { tool: 'bulk_create_sheets', params: { names: ['Cash Flow - Single Location'] } },
          {
            tool: 'bulk_set_cell_ranges',
            params: {
              writes: [
                {
                  sheet: 'Cash Flow - Single Location',
                  cells: {
                    A1: { value: 'Cash Flow' },
                    B5: { formula: '=CashFlow!$B$10' }
                  }
                }
              ]
            }
          }
        ]
      }
    ]
  };
  const r = validateBlueprint(blueprint);
  assert.ok(!r.ok, 'formula reference to undeclared sheet should fail');
  assert.ok(
    r.errors.some(e => /references sheet "CashFlow"/.test(e)),
    `expected missing sheet reference error, got: ${r.errors.join('; ')}`
  );
  console.log('  ✓ deterministic formula refs to undeclared sheets rejected');
}

const SAMPLE_MENU_OBJECTIVE = 'MEAT CREW menu: MOCHO’S BITES — 6,90 € CHICKEN TENDERS — 6,90 € L.A. — 14,50 € | M 21,90 € CRISPY — 14,50 € | M 21,90 € PASTRAMI — 19,00 € | M 26,40 € FREE REFILL — 4,50 €';

function test_extractVerbatimMenuFacts_reads_menu_items_and_prices() {
  const facts = extractVerbatimMenuFacts(SAMPLE_MENU_OBJECTIVE);
  assert.ok(facts.some(f => f.name === 'MOCHO’S BITES' && f.basePrice === 6.9), 'extracts starter price');
  assert.ok(facts.some(f => f.name === 'L.A.' && f.basePrice === 14.5 && f.menuPrice === 21.9), 'extracts menu price');
  assert.ok(facts.some(f => f.name === 'PASTRAMI' && f.menuPrice === 26.4), 'extracts sandwich menu price');
  console.log('  ✓ menu fact extractor reads verbatim items and prices');
}

function test_extractVerbatimMenuFacts_strips_menu_non_disponibile_annotation() {
  // Regression: the "(Menu non disponibile)" annotation between items used to
  // bleed across the next item's name via the \bMenu\b split, producing
  // "non disponibile) VEGGIE DELUXE" instead of "VEGGIE DELUXE" and breaking
  // architect verbatim coverage validation.
  const objective = [
    'TENDERS — 7,50 €',
    'Tenders Plant Based. (Menu non disponibile)',
    'VEGGIE DELUXE — 14,50 € | M 21,90 €',
    'JUNIOR — 8,50 €',
    'Patty singolo di Manzo e American Cheese. (Menu non disponibile)'
  ].join('\n');
  const facts = extractVerbatimMenuFacts(objective);
  const veggie = facts.find(f => f.basePrice === 14.5 && f.menuPrice === 21.9);
  assert.ok(veggie, 'VEGGIE DELUXE extracted with both prices');
  assert.strictEqual(veggie.name, 'VEGGIE DELUXE', `name should be "VEGGIE DELUXE", got: ${veggie.name}`);
  const junior = facts.find(f => f.basePrice === 8.5);
  assert.ok(junior, 'JUNIOR extracted');
  assert.ok(!/non disponibile/i.test(junior.name), `JUNIOR name leaked annotation: ${junior.name}`);
  console.log('  ✓ "(Menu non disponibile)" annotation does not leak into next item name');
}

function test_validateBlueprint_rejects_menu_category_summary_without_line_items() {
  const blueprint = {
    slices: [
      {
        id: 'revenue',
        title: 'Revenue',
        deps: [],
        scope: { sheets_owned: ['Revenue'], ranges_owned: [], may_read_from: [] },
        instructions: 'Category revenue summary',
        actions: [
          { tool: 'bulk_create_sheets', params: { names: ['Revenue'] } },
          {
            tool: 'bulk_set_cell_ranges',
            params: {
              writes: [
                {
                  sheet: 'Revenue',
                  cells: {
                    A1: { value: 'Revenue Breakdown' },
                    A5: { value: 'Starters' },
                    A6: { value: 'Burgers' },
                    B5: { value: 106560 },
                    B6: { value: 599400 }
                  }
                }
              ]
            }
          }
        ]
      }
    ]
  };
  const r = validateBlueprint(blueprint, { objective: SAMPLE_MENU_OBJECTIVE });
  assert.ok(!r.ok, 'category-only menu summary should fail verbatim source validation');
  assert.ok(
    r.errors.some(e => /verbatim menu coverage failed/i.test(e)),
    `expected verbatim menu coverage error, got: ${r.errors.join('; ')}`
  );
  console.log('  ✓ category-only menu summaries fail source-fidelity validation');
}

function test_validateBlueprint_accepts_menu_line_item_actions() {
  const blueprint = {
    slices: [
      {
        id: 'menu',
        title: 'Menu Detail',
        deps: [],
        scope: { sheets_owned: ['Menu'], ranges_owned: [], may_read_from: [] },
        instructions: 'Write menu line items exactly.',
        actions: [
          { tool: 'bulk_create_sheets', params: { names: ['Menu'] } },
          {
            tool: 'bulk_set_cell_ranges',
            params: {
              writes: [
                {
                  sheet: 'Menu',
                  cells: {
                    A1: { value: 'Item' }, B1: { value: 'Base Price' }, C1: { value: 'Menu Price' },
                    A2: { value: 'MOCHO’S BITES' }, B2: { value: 6.9 },
                    A3: { value: 'CHICKEN TENDERS' }, B3: { value: 6.9 },
                    A4: { value: 'L.A.' }, B4: { value: 14.5 }, C4: { value: 21.9 },
                    A5: { value: 'CRISPY' }, B5: { value: 14.5 }, C5: { value: 21.9 },
                    A6: { value: 'PASTRAMI' }, B6: { value: 19 }, C6: { value: 26.4 },
                    A7: { value: 'FREE REFILL' }, B7: { value: 4.5 }
                  }
                }
              ]
            }
          }
        ]
      }
    ]
  };
  const r = validateBlueprint(blueprint, { objective: SAMPLE_MENU_OBJECTIVE });
  assert.ok(r.ok, `expected menu line items to pass source validation, got: ${(r.errors || []).join('; ')}`);
  console.log('  ✓ menu line-item actions satisfy source-fidelity validation');
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
  test_validateBlueprint_accepts_declared_formula_sheet_refs();
  test_validateBlueprint_rejects_undeclared_formula_sheet_refs();
  test_extractVerbatimMenuFacts_reads_menu_items_and_prices();
  test_extractVerbatimMenuFacts_strips_menu_non_disponibile_annotation();
  test_validateBlueprint_rejects_menu_category_summary_without_line_items();
  test_validateBlueprint_accepts_menu_line_item_actions();
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
