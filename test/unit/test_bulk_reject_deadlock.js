// hasRecentBulkRejections: the Fix-C deadlock breaker. The micro-write /
// sequential-force guards push the agent toward bulk_set_cell_ranges, but when
// bulk is the tool that keeps getting rejected (flash loses JSON coherence on a
// large payload), forcing back to bulk feeds the failing tool until the run
// aborts (MEAT CREW 2026-06-02). This helper tells those guards to stand down.
const assert = require('assert');
const { hasRecentBulkRejections } = require('../../server/agents/loopDetectors');

const bulkReject = (reason = 'broken') => ({ type: 'tool', tool: 'bulk_set_cell_ranges', result: { error: reason } });
const bulkOk = () => ({ type: 'tool', tool: 'bulk_set_cell_ranges', result: { actions: [{ a: 1 }] } });
const smallOk = () => ({ type: 'tool', tool: 'set_cell_range', result: { actions: [{ a: 1 }] } });

let pass = 0;
function check(name, cond) {
  if (cond) { console.log(`OK ${name}`); pass++; }
  else { console.error(`FAIL ${name}`); process.exitCode = 1; }
}

check('empty input -> false', hasRecentBulkRejections([]) === false);
check('non-array -> false', hasRecentBulkRejections(null) === false);
check('single bulk reject below minRejects -> false', hasRecentBulkRejections([bulkReject()]) === false);
check('two bulk rejects -> true', hasRecentBulkRejections([bulkReject(), bulkReject()]) === true);
check('rejects interleaved with small writes still counts -> true',
  hasRecentBulkRejections([bulkReject(), smallOk(), bulkReject()]) === true);
check('a recent bulk SUCCESS short-circuits to false (bulk works)',
  hasRecentBulkRejections([bulkReject(), bulkReject(), bulkOk()]) === false);
check('guard-injected {type:error} blocks are ignored',
  hasRecentBulkRejections([{ type: 'error', error: 'guard' }, { type: 'error', error: 'guard' }]) === false);
check('rejects older than lookback window are not counted',
  hasRecentBulkRejections(
    [bulkReject(), bulkReject(), smallOk(), smallOk(), smallOk(), smallOk(), smallOk()],
    { lookback: 4 }
  ) === false);
check('custom minRejects=1 fires on a single reject',
  hasRecentBulkRejections([bulkReject()], { minRejects: 1 }) === true);
check('MEAT CREW shape: 3 consecutive bulk rejects -> true',
  hasRecentBulkRejections([bulkReject('missing cells'), bulkReject('missing cells'), bulkReject('missing cells')]) === true);

console.log(`\nbulk-reject deadlock tests completed (${pass} passed).`);
