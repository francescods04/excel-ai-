// reconcileStuckSlices: the limbo breaker. On Vercel a multi-instance
// lost-update race on the Supabase rehydrate (stepArchitectWave reloads turn
// state at the top of every /step) can persist a worker's terminal agent
// object WITHOUT the matching ingest mutation that flips its slice to
// 'succeeded'. The slice is then stuck: sliceStates==='running' but
// agent.status==='completed', so advanceRunningSlices skips it, no client batch
// exists, isComplete never trips → infinite 'continue' polls and every
// dependent slice starves. Observed MEAT CREW fastfood_bp 2026-06-03: the
// `menu` worker finished (iter 5, 52 writes) but stayed 'running', blocking the
// whole 9-wave downstream chain. This test pins the harvest behavior.
const assert = require('assert');
const { reconcileStuckSlices } = require('../../server/agents/architectStepwise');

let pass = 0;
function check(name, cond) {
  if (cond) { console.log(`OK ${name}`); pass++; }
  else { console.error(`FAIL ${name}`); process.exitCode = 1; }
}

function baseState(overrides = {}) {
  return {
    blueprint: {
      slices: [
        { id: 'menu', title: 'Menu', deps: [], scope: { sheets_owned: ['Menu'] } },
        { id: 'cost_of_goods', title: 'COGS', deps: ['menu'], scope: { sheets_owned: ['Cost of Goods'] } },
        { id: 'verify', title: 'Verify', deps: ['menu'], scope: { sheets_owned: [], ranges_owned: [] } }
      ]
    },
    sliceStates: { menu: 'running', cost_of_goods: 'pending', verify: 'running' },
    sliceResults: {},
    sliceAgents: {},
    sliceWriteCounts: {},
    sliceWriteCells: {},
    ...overrides
  };
}

// 1. The exact MEAT CREW shape: completed agent + writes, stuck 'running'.
{
  const st = baseState();
  st.sliceAgents.menu = { status: 'completed', iteration: 5, summary: 'Created Menu sheet' };
  st.sliceWriteCounts.menu = 52;
  st.sliceWriteCells.menu = 271;
  // verify is a read-only slice (no owned scope) that also completed w/o writes.
  st.sliceAgents.verify = { status: 'completed', iteration: 3 };
  const changed = reconcileStuckSlices(st);
  check('MEAT CREW: reconcile reports change', changed === true);
  check('menu harvested to succeeded', st.sliceStates.menu === 'succeeded');
  check('menu result carries writes/cells', st.sliceResults.menu.writes === 52 && st.sliceResults.menu.cells === 271);
  check('menu result flagged reconciled', st.sliceResults.menu.reconciled === true);
  check('menu agent deleted', !st.sliceAgents.menu);
  check('read-only verify slice succeeds with zero writes', st.sliceStates.verify === 'succeeded');
  check('dependent cost_of_goods now unblocked (still pending, dep succeeded)',
    st.sliceStates.cost_of_goods === 'pending' && st.sliceStates.menu === 'succeeded');
}

// 2. Genuinely-running worker is left untouched.
{
  const st = baseState();
  st.sliceAgents.menu = { status: 'running', iteration: 2 };
  st.sliceAgents.verify = { status: 'running', iteration: 1 };
  const changed = reconcileStuckSlices(st);
  check('running worker untouched -> no change', changed === false);
  check('running menu stays running', st.sliceStates.menu === 'running');
}

// 3. Worker waiting on the client (pending) is left untouched.
{
  const st = baseState();
  st.sliceAgents.menu = { status: 'running', pending: { kind: 'await_client' } };
  st.sliceAgents.verify = { status: 'running', pending: { kind: 'await_client' } };
  const changed = reconcileStuckSlices(st);
  check('pending worker untouched -> no change', changed === false);
}

// 4. Content slice terminal/agent-gone WITH writes -> degraded success (keep data).
{
  const st = baseState();
  delete st.sliceAgents.menu; // agent vanished in serialization
  st.sliceWriteCounts.menu = 30;
  st.sliceWriteCells.menu = 90;
  st.sliceAgents.verify = { status: 'completed' };
  reconcileStuckSlices(st);
  check('agent-gone-with-writes -> succeeded (degraded)',
    st.sliceStates.menu === 'succeeded' && st.sliceResults.menu.degraded === true);
}

// 5. Content slice terminal with NO writes -> failed (let cascade prune).
{
  const st = baseState();
  st.sliceAgents.menu = { status: 'completed', iteration: 4 };
  st.sliceWriteCounts.menu = 0;
  st.sliceAgents.verify = { status: 'completed' };
  reconcileStuckSlices(st);
  check('completed content slice with zero writes -> failed (confabulation guard)',
    st.sliceStates.menu === 'failed' && st.sliceResults.menu.status === 'failed_reconciled');
}

// 6. Aborted terminal worker with no writes -> failed.
{
  const st = baseState();
  st.sliceAgents.menu = { status: 'aborted', iteration: 7 };
  st.sliceWriteCounts.menu = 0;
  st.sliceAgents.verify = { status: 'completed' };
  reconcileStuckSlices(st);
  check('aborted worker no writes -> failed', st.sliceStates.menu === 'failed');
}

console.log(`\nslice-limbo reconcile tests completed (${pass} passed).`);
