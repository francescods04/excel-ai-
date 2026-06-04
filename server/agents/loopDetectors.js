/**
 * Loop / stagnation detectors for the agent run loop.
 * ===================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * The agent has no hard iteration cap (a deliberate product choice — the user
 * prefers it run until the work is genuinely done rather than being killed at
 * an arbitrary count). The safety net instead is a family of *behavioural*
 * detectors that watch the recent tool trail and the rolling workbook-health
 * log, and decide when the agent is no longer making progress and should be
 * nudged (soft) or aborted (hard).
 *
 * These functions were extracted verbatim from agentLoop.js so the two run
 * loops that consume them (the legacy `runAgentLoop` and the stepwise
 * `runAgentStep` engine) share ONE implementation, and so the behaviour can be
 * unit-tested in isolation (test/unit/test_runtime_safety.js,
 * test_semantic_loop.js, test_same_tool_reject.js).
 *
 * THE DETECTORS (and the production incident each was built for)
 * --------------------------------------------------------------
 *   detectToolStagnation        — repeat / alternating / read-thrash /
 *                                  tight-read-thrash / destructive loops on the
 *                                  tool-call trail. (LBO run 2026-05-30:
 *                                  formula_not_landing → 8+ re-reads.)
 *   detectSemanticErrorLoop     — same (sheet, rootCause) workbook error
 *                                  recurring across scans even when the agent
 *                                  varies its tools. Soft → replan hint, hard →
 *                                  abort.
 *   detectSameToolRejectLoop    — same WRITE tool rejected with an error N
 *                                  times in a row with zero actions emitted.
 *                                  (MEAT CREW / turn ia3yjxxm 2026-06-03: 10
 *                                  consecutive bulk_set_cell_ranges all rejected
 *                                  for a missing `cells` field.)
 *   detectNoProgress            — N consecutive iterations with no successful
 *                                  mutation at all (reads/think/plan only).
 *
 * SIGNATURE HELPERS
 * -----------------
 *   buildToolStagnationSignature / normalizeStagnationValue — produce a stable,
 *   bounded string key for a tool call so identical calls compare equal.
 *   extractSheetHint / extractReadTargetKey — pull the sheet / target out of a
 *   call so read-thrash can tell "5 reads of the same range" (a loop) from "5
 *   reads of 5 different sheets" (legitimate multi-sheet exploration).
 *
 * MESSAGE FORMATTERS
 * ------------------
 *   formatToolStagnationReason — render a stagnation result into a stable abort
 *     reason string used in telemetry and the abort path.
 *   buildSemanticLoopReplanMessage — the "STOP TACTICAL FIXES" replan prompt
 *     injected on a soft semantic loop.
 *
 * PURITY
 * ------
 * Every export here is pure (no I/O, no module state beyond env-derived
 * constants read once at load). Safe to call on the hot path and trivially
 * testable.
 *
 * TUNING
 * ------
 * Thresholds are env-overridable (AGENT_STAGNATION_MAX_REPEAT,
 * AGENT_SEMANTIC_LOOP_SOFT/HARD/WINDOW, AGENT_NO_PROGRESS_LIMIT,
 * AGENT_SAME_TOOL_REJECT_LIMIT, AGENT_READS_WITHOUT_WRITE_LIMIT, …). Each
 * constant documents the incident that set its default.
 */

'use strict';

/* ----------------------------- Constants ----------------------------- */

// Tools whose calls are watched for stagnation. Reads dominate (a confused
// agent re-reads), plus the sheet-lifecycle ops that feed the destructive loop.
const STAGNATION_WATCH_TOOLS = new Set([
  'read_workbook',
  'read_sheet',
  'get_range_as_csv',
  'get_cell_ranges',
  'build_workbook_graph',
  'execute_office_js',
  'read_format_summary',
  'delete_sheet',
  'create_sheet',
  'bulk_create_sheets'
]);
const STAGNATION_MAX_REPEAT = Math.max(3, Number(process.env.AGENT_STAGNATION_MAX_REPEAT) || 4);
const STAGNATION_ALT_CYCLES = Math.max(2, Number(process.env.AGENT_STAGNATION_ALT_CYCLES) || 3);
// Trail-trim bound used by the run loops to cap how many recent tool calls they
// retain — derived from the alternating window so the longest pattern still fits.
const STAGNATION_MAX_TRAIL = Math.max(8, (STAGNATION_ALT_CYCLES * 2) + 2);
// Read-thrash: when the agent runs N consecutive read-only tool calls without
// any mutation in between, it's stuck in a "verify → re-verify → re-verify"
// loop. Triggered repeatedly after the formula_not_landing confusion that
// killed the LBO run on 2026-05-30: 8+ reads on the same area while convinced
// writes weren't taking effect. We treat any stretch of READS_WITHOUT_WRITE
// pure reads as terminal stagnation — bigger than the per-signature repeat
// limit because read params often differ slightly between iterations.
// Bumped from 5 → 8 (2026-05-30 fast-food run): slice workers got the new
// READ-BEFORE-YOU-WRITE directive plus had to inspect multiple upstream sheets
// (Assumptions, Revenue, Capex). opex_and_ebitda legitimately needed 5 reads
// just to sample Assumptions sections + the Revenue total row before writing,
// and was killed before its first write. 8 allows the inspection phase without
// re-allowing the LBO-style "verify → re-verify" loop we originally guarded.
// Lowered 8 → 6: cap "verify → re-verify" loops sooner. 6 still allows
// inspection of 2-3 upstream sheets (Assumptions + 1-2 others) plus one
// targeted re-read of a structure that came back truncated. 5 was too
// tight — complex slices like multi-upstream cash_flow hit the cap during
// legitimate inspection. Tunable via AGENT_READS_WITHOUT_WRITE_LIMIT.
const READS_WITHOUT_WRITE_LIMIT = Math.max(4, Number(process.env.AGENT_READS_WITHOUT_WRITE_LIMIT) || 6);
const READ_ONLY_TOOLS_FOR_STAGNATION = new Set([
  'read_workbook',
  'read_sheet',
  'get_range_as_csv',
  'get_cell_ranges',
  'build_workbook_graph',
  'read_format_summary'
]);

// Semantic-error loop thresholds (see detectSemanticErrorLoop). soft → inject a
// replan hint and keep going; hard → abort. Defaults soft=3, hard=5, window=12.
const SEMANTIC_LOOP_SOFT = Math.max(2, Number(process.env.AGENT_SEMANTIC_LOOP_SOFT) || 3);
const SEMANTIC_LOOP_HARD = Math.max(SEMANTIC_LOOP_SOFT + 1, Number(process.env.AGENT_SEMANTIC_LOOP_HARD) || 5);
const SEMANTIC_LOOP_WINDOW = Math.max(SEMANTIC_LOOP_HARD * 2, Number(process.env.AGENT_SEMANTIC_LOOP_WINDOW) || 12);

// No-progress: abort after this many consecutive iterations with no successful
// mutation. The user's preferred safety net in place of a hard iteration cap.
const NO_PROGRESS_LIMIT = Math.max(4, Number(process.env.AGENT_NO_PROGRESS_LIMIT) || 12);
const PRODUCTIVE_TOOLS = new Set([
  'set_cell_range',
  'bulk_set_cell_ranges',
  'create_sheet',
  'bulk_create_sheets',
  'rename_sheet',
  'delete_sheet',
  'duplicate_sheet',
  'set_format',
  'bulk_set_format',
  'format_workbook',
  'copy_range',
  'create_named_range',
  'bulk_create_named_ranges',
  'execute_excel_formula',
  'execute_office_js',
  'execute_python',
  'add_chart',
  'bulk_set_notes',
  'set_notes',
  'add_conditional_format',
  'plan_format',
  'apply_format_plan',
  'build_dcf_section'
]);

// Same-tool-reject: same WRITE tool consecutively rejected with an error N
// times in a row. Catches the "LLM emits broken bulk → server rejects → LLM
// emits the same broken bulk again" loop before the broader NO_PROGRESS_LIMIT
// (12) kicks in. Targeted at the schema-validation-rejection failure mode
// observed 2026-06-03 turn ia3yjxxm loops 13-22: 10 consecutive
// bulk_set_cell_ranges calls all rejected for a missing `cells` field.
const SAME_TOOL_REJECT_LIMIT = Math.max(3, Number(process.env.AGENT_SAME_TOOL_REJECT_LIMIT) || 5);
const WRITE_TOOLS_FOR_REJECT_GUARD = new Set([
  'set_cell_range',
  'bulk_set_cell_ranges',
  'set_format',
  'bulk_set_format',
  'execute_excel_formula'
]);

/* --------------------------- Signature helpers --------------------------- */

/**
 * Produce a stable, size-bounded normalization of a params object so two
 * "equivalent" tool calls hash to the same signature. Strings are truncated to
 * 160 chars, arrays to 8 items, object keys sorted, recursion capped at depth 4.
 */
function normalizeStagnationValue(value, depth = 0) {
  if (value == null) return value;
  if (depth >= 4) return '[depth-limit]';
  if (typeof value === 'string') {
    return value.length > 160 ? `${value.slice(0, 160)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 8).map(item => normalizeStagnationValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = normalizeStagnationValue(value[key], depth + 1);
      return acc;
    }, {});
  }
  return String(value);
}

/** Build the canonical "toolName:{normalized-json-params}" stagnation signature. */
function buildToolStagnationSignature(toolName, params = {}) {
  return `${toolName}:${JSON.stringify(normalizeStagnationValue(params))}`;
}

// Pull the "target" of a read call out of a stagnation signature so the
// tight_read_thrash detector can compare re-reads of the same range. The
// signature is "toolName:{json}" — we extract the most likely range/sheet
// keys and join them.
function extractReadTargetKey(signature) {
  if (typeof signature !== 'string') return null;
  const colon = signature.indexOf(':');
  if (colon < 0) return null;
  let body;
  try { body = JSON.parse(signature.slice(colon + 1)); } catch { return null; }
  if (!body || typeof body !== 'object') return null;
  // Sheet first
  const sheet = body.sheet || body.sheetName || (Array.isArray(body.ranges) && body.ranges[0] && body.ranges[0].sheet) || null;
  // Then a stable target descriptor
  const target = body.target || body.range || body.addr || body.address
    || (Array.isArray(body.ranges) && body.ranges[0] && (body.ranges[0].target || body.ranges[0].range))
    || null;
  if (!sheet && !target) return null;
  return `${sheet || '?'}::${target || '?'}`;
}

// Best-effort sheet name pulled from a tool-call params object, used by the
// read-thrash detector to distinguish "5 reads on the same sheet" (real loop)
// from "5 reads each on a different sheet" (legitimate multi-sheet exploration).
function extractSheetHint(params) {
  if (!params || typeof params !== 'object') return null;
  if (typeof params.sheet === 'string' && params.sheet) return params.sheet;
  if (typeof params.sheetName === 'string' && params.sheetName) return params.sheetName;
  if (typeof params.name === 'string' && params.name) return params.name;
  if (Array.isArray(params.names) && params.names.length > 0) return String(params.names[0]);
  if (typeof params.target === 'string' && params.target.includes('!')) {
    return params.target.split('!')[0].replace(/'/g, '');
  }
  if (Array.isArray(params.ranges)) {
    const first = params.ranges.find(r => typeof r === 'string' && r.includes('!'));
    if (first) return first.split('!')[0].replace(/'/g, '');
  }
  if (Array.isArray(params.calls)) {
    const sheets = params.calls.map(c => c && extractSheetHint(c.params || c)).filter(Boolean);
    if (sheets.length > 0) return sheets.join(','); // multi-sheet parallel batch
  }
  return null;
}

/* ------------------------------ Detectors ------------------------------ */

function detectToolStagnation(trail, maxRepeat = STAGNATION_MAX_REPEAT, altCycles = STAGNATION_ALT_CYCLES) {
  if (!Array.isArray(trail) || trail.length === 0) return null;
  const last = trail[trail.length - 1];
  if (!last || !STAGNATION_WATCH_TOOLS.has(last.toolName)) return null;

  // Read-thrash: last N reads with no write between them AND high overlap on
  // target sheet. "Different sheets each iteration" is legitimate multi-sheet
  // exploration (e.g. read 9 sheets to plan a formatting pass) — NOT thrash.
  // We only trip the guard when the agent keeps hammering the SAME area while
  // being confused that writes didn't land.
  if (trail.length >= READS_WITHOUT_WRITE_LIMIT) {
    const tail = trail.slice(-READS_WITHOUT_WRITE_LIMIT);
    if (tail.every(entry => READ_ONLY_TOOLS_FOR_STAGNATION.has(entry.toolName))) {
      // Count how many entries share the most common sheet hint. If the agent
      // is exploring distinct sheets, distinct hints will dominate and we
      // bail. Entries with no hint count toward the "unknown" bucket — if
      // ALL entries are unknown that's also fine (probably workbook-wide
      // reads like build_workbook_graph).
      const sheetCounts = new Map();
      for (const e of tail) {
        const key = e.sheetHint || '__unknown__';
        sheetCounts.set(key, (sheetCounts.get(key) || 0) + 1);
      }
      // Pick the most frequent NAMED sheet (ignore __unknown__).
      let topNamedSheet = null;
      let topNamedCount = 0;
      for (const [key, count] of sheetCounts) {
        if (key !== '__unknown__' && count > topNamedCount) {
          topNamedSheet = key;
          topNamedCount = count;
        }
      }
      const distinctNamedSheets = [...sheetCounts.keys()].filter(k => k !== '__unknown__').length;
      // Thrash only when a NAMED sheet captures ≥80% of the reads AND we have
      // ≤2 distinct named sheets. All-unknown trails get a separate guard: if
      // every signature is also identical we already catch that as `repeat`,
      // otherwise we let the agent explore.
      if (topNamedSheet && (topNamedCount / tail.length) >= 0.8 && distinctNamedSheets <= 2) {
        return {
          pattern: 'read_thrash',
          entries: tail
        };
      }
    }
  }

  if (trail.length >= maxRepeat) {
    const repeated = trail.slice(-maxRepeat);
    if (repeated.every(entry => entry.signature === last.signature)) {
      return {
        pattern: 'repeat',
        entries: repeated
      };
    }
  }

  // Tight read-thrash: 5+ reads on the SAME sheet+target with DIFFERENT
  // signatures (so they're not just identical repeats) and no write in
  // between. Catches "agent writes ok, then re-reads the same range 4-5
  // times with slightly different target strings because the result is
  // empty/confusing" — the case the wide READS_WITHOUT_WRITE_LIMIT=8
  // misses but burns 4-5 iters. Threshold is 5 (not 3) so a worker that
  // legitimately needs 3-4 reads to scout a sheet (e.g. inspecting
  // Assumptions to find the right rows for downstream formulas) isn't
  // killed off; 5 identical reads IS a real loop.
  if (trail.length >= 3) {
    const tightWindow = trail.slice(-7);
    const readsOnly = tightWindow.every(e => READ_ONLY_TOOLS_FOR_STAGNATION.has(e.toolName));
    const distinctSignatures = new Set(tightWindow.map(e => e.signature)).size;
    if (readsOnly && distinctSignatures >= 2) {
      // Group by sheet+target to see if any one pair repeats ≥5x in the window.
      const pairCounts = new Map();
      for (const e of tightWindow) {
        const sheetKey = e.sheetHint || '__unknown__';
        const targetKey = extractReadTargetKey(e.signature) || '__no_target__';
        const key = `${sheetKey}::${targetKey}`;
        pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
      }
      for (const [key, count] of pairCounts) {
        if (count >= 5) {
          const [sheet, target] = key.split('::');
          if (sheet === '__unknown__' && target === '__no_target__') continue;
          return {
            pattern: 'tight_read_thrash',
            entries: tightWindow,
            sheet: sheet === '__unknown__' ? null : sheet,
            target: target === '__no_target__' ? null : target
          };
        }
      }
    }
  }

  const alternatingWindow = altCycles * 2;
  if (trail.length >= alternatingWindow) {
    const alternating = trail.slice(-alternatingWindow);
    const first = alternating[0];
    const second = alternating[1];
    if (
      first &&
      second &&
      first.signature !== second.signature &&
      STAGNATION_WATCH_TOOLS.has(first.toolName) &&
      STAGNATION_WATCH_TOOLS.has(second.toolName) &&
      alternating.every((entry, index) => (
        index % 2 === 0
          ? entry.signature === first.signature
          : entry.signature === second.signature
      ))
    ) {
      return {
        pattern: 'alternating',
        entries: alternating
      };
    }
  }

  // Destructive loop: delete_sheet → create_sheet/bulk_create_sheets for the
  // same sheet, repeated ≥2 times. Indicates the agent is stuck in a
  // "delete and start over" cycle instead of fixing the data in place.
  const destructiveWindow = 8;
  if (trail.length >= destructiveWindow) {
    const window = trail.slice(-destructiveWindow);
    const deleteOps = window.filter(e => e.toolName === 'delete_sheet');
    if (deleteOps.length >= 2) {
      const deletedSheets = new Set(deleteOps.map(e => e.sheetHint).filter(Boolean));
      const createdSheets = new Set(
        window.filter(e => e.toolName === 'create_sheet' || e.toolName === 'bulk_create_sheets')
          .map(e => e.sheetHint).filter(Boolean)
      );
      const overlapping = [...deletedSheets].filter(s => createdSheets.has(s));
      if (overlapping.length >= 1) {
        return {
          pattern: 'destructive_loop',
          entries: window,
          sheet: overlapping[0]
        };
      }
    }
  }
  return null;
}

// Semantic-error loop detector. Watches the healthSeen array (rolling list
// of workbook errors caught by the health scanner with their rootCause
// classification) and trips when the SAME (sheet, rootCause) pair recurs
// repeatedly across iterations — even when the agent VARIES the tool it
// uses between writes and reads. The original detectToolStagnation only
// catches same-signature loops, so a "write #VALUE! → read → re-write
// same wrong way → #VALUE! → read …" cycle slips through.
//
// Returns null, or `{ pattern: 'semantic_error_loop', rootCause, sheet,
//   count, severity }`. Severity is:
//   - 'soft' for count in [softThreshold, hardThreshold)  → inject replan
//     hint, keep the run going
//   - 'hard' for count >= hardThreshold                    → abort
//
// Defaults: soft = 3, hard = 5. Tunable via AGENT_SEMANTIC_LOOP_SOFT /
// AGENT_SEMANTIC_LOOP_HARD env vars. Returns null when fewer than
// softThreshold matching entries are present, so single transient errors
// never trigger.
function detectSemanticErrorLoop(healthSeen, {
  softThreshold = SEMANTIC_LOOP_SOFT,
  hardThreshold = SEMANTIC_LOOP_HARD,
  windowSize = SEMANTIC_LOOP_WINDOW
} = {}) {
  if (!Array.isArray(healthSeen) || healthSeen.length === 0) return null;
  const window = healthSeen.slice(-windowSize);
  // Bucket by (sheet, rootCause). Ignore entries without a classified
  // rootCause (the legacy ones predate the classifier).
  const buckets = new Map();
  for (const e of window) {
    if (!e || typeof e !== 'object') continue;
    const sheet = e.sheet || '?';
    const rc = e.rootCause;
    if (!rc || rc === 'unknown') continue;
    const key = `${sheet}::${rc}`;
    if (!buckets.has(key)) buckets.set(key, { sheet, rootCause: rc, count: 0, samples: [] });
    const b = buckets.get(key);
    b.count += 1;
    if (b.samples.length < 3) b.samples.push(`${e.sheet || '?'}!${e.addr || '?'}`);
  }
  let worst = null;
  for (const b of buckets.values()) {
    if (b.count < softThreshold) continue;
    if (!worst || b.count > worst.count) worst = b;
  }
  if (!worst) return null;
  const severity = worst.count >= hardThreshold ? 'hard' : 'soft';
  return {
    pattern: 'semantic_error_loop',
    rootCause: worst.rootCause,
    sheet: worst.sheet,
    count: worst.count,
    severity,
    samples: worst.samples
  };
}

function buildSemanticLoopReplanMessage(sig) {
  if (!sig) return '';
  const samples = (sig.samples || []).slice(0, 3).join(', ');
  return `STOP TACTICAL FIXES — the same root cause "${sig.rootCause}" has been re-emerging in sheet "${sig.sheet}" for ${sig.count} consecutive workbook scans (e.g. ${samples}). Patching individual cells is not converging. STEP BACK and address the underlying structure: identify the ONE upstream cell whose contents are driving the cascade (likely a misplaced label, an empty driver, or a wrong reference), fix THAT cell with a correct value/formula, and only then revisit the dependent cells. If the section cannot be repaired in 2-3 writes, abandon it and call done with a summary of what is blocking you.`;
}

// Fast-fail: same WRITE tool consecutively rejected with an error N times in
// a row. Catches the "LLM emits broken bulk → server rejects → LLM emits
// the same broken bulk again" loop before the broader NO_PROGRESS_LIMIT (12)
// kicks in.
function detectSameToolRejectLoop(results, options = {}) {
  const limit = options.limit || SAME_TOOL_REJECT_LIMIT;
  if (!Array.isArray(results) || results.length < limit) return null;
  // Walk backwards: collect the last `limit` tool-type entries. If ALL are
  // the SAME write tool AND ALL have errors AND none produced actions → loop.
  const tail = [];
  for (let i = results.length - 1; i >= 0 && tail.length < limit; i--) {
    const r = results[i];
    if (!r || r.type !== 'tool') continue;
    tail.push(r);
  }
  if (tail.length < limit) return null;
  const firstTool = tail[0].tool;
  if (!WRITE_TOOLS_FOR_REJECT_GUARD.has(firstTool)) return null;
  for (const r of tail) {
    if (r.tool !== firstTool) return null;
    const res = r.result;
    if (!res || typeof res !== 'object') return null;
    const hasErr = (typeof res.error === 'string' && res.error.length > 0) ||
                   (Array.isArray(res.errors) && res.errors.length > 0);
    if (!hasErr) return null;
    if (Array.isArray(res.actions) && res.actions.length > 0) return null;
  }
  // Extract a sample of the rejection reason for the abort message.
  const sampleErr = tail[0].result?.error || (tail[0].result?.errors?.[0]?.reason) || 'unknown';
  return {
    pattern: 'same_tool_reject_loop',
    tool: firstTool,
    count: tail.length,
    sampleReason: String(sampleErr).slice(0, 200)
  };
}

// No-progress detector: scan recent tool results and abort if the agent has
// not produced any successful mutation (write / format / create) within a
// long stretch. This is the user's preferred safety net — no hard iter cap,
// but if the agent is wasting iterations on reads/think/plan with no actual
// change to the workbook, we cut it off.
function detectNoProgress(results, options = {}) {
  const limit = options.limit || NO_PROGRESS_LIMIT;
  if (!Array.isArray(results) || results.length === 0) return null;
  // Walk backwards. We need `limit` consecutive iters with NO productive
  // tool result. Productive = tool in PRODUCTIVE_TOOLS whose result has no
  // `error` field and isn't in our blocked/stagnation results.
  let unproductiveRun = 0;
  let firstUnproductive = null;
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i];
    if (!r) continue;
    // Treat blocked/stagnation as unproductive (they are pushes that didn't
    // produce a real action).
    if (r.type === 'error' || r.type === 'done' || r.type === 'ask_user' || r.type === 'todo_write') {
      // Pause the run counter but don't break — a done can be followed by a
      // gate that re-issues, so we keep walking.
      continue;
    }
    if (r.type !== 'tool') {
      continue;
    }
    const toolName = r.tool;
    const result = r.result;
    const hasError = result && typeof result === 'object' && (
      (typeof result.error === 'string' && result.error.length > 0) ||
      (Array.isArray(result.errors) && result.errors.length > 0)
    );
    if (PRODUCTIVE_TOOLS.has(toolName) && !hasError) {
      // Productive tool result found — agent IS making progress.
      return null;
    }
    unproductiveRun += 1;
    if (firstUnproductive === null) firstUnproductive = i;
    if (unproductiveRun >= limit) {
      return {
        pattern: 'no_progress',
        startIndex: firstUnproductive,
        unproductiveRun,
        lastTool: toolName
      };
    }
  }
  return null;
}

// Has the agent's recent history shown bulk_set_cell_ranges *failing*? Used to
// break the dueling-guards deadlock: the micro-write / sequential-force guards
// push the agent toward bulk_set_cell_ranges to save iterations, but when bulk
// is the tool that keeps getting rejected (flash loses JSON coherence on a
// large payload, or omits the `cells` field), forcing back to bulk just feeds
// the failing tool until detectSameToolRejectLoop aborts the whole run
// (MEAT CREW 2026-06-02). When this returns true the push-to-bulk guards stand
// down and let the smaller, *succeeding* set_cell_range writes through.
//
// Scans the last `lookback` real tool results. A bulk call that errored with
// zero emitted actions counts as a rejection; a bulk call that DID emit actions
// proves bulk currently works, so we short-circuit to false. Guard-injected
// `{type:'error'}` blocks are not `type:'tool'` and are correctly ignored.
function hasRecentBulkRejections(results, { lookback = 6, minRejects = 2, tool = 'bulk_set_cell_ranges' } = {}) {
  if (!Array.isArray(results) || results.length === 0) return false;
  let seen = 0;
  let rejects = 0;
  for (let i = results.length - 1; i >= 0 && seen < lookback; i--) {
    const r = results[i];
    if (!r || r.type !== 'tool') continue;
    seen++;
    if (r.tool !== tool) continue;
    const res = r.result;
    const hasErr = res && typeof res === 'object' && (
      (typeof res.error === 'string' && res.error.length > 0) ||
      (Array.isArray(res.errors) && res.errors.length > 0)
    );
    const hasActions = res && typeof res === 'object' && Array.isArray(res.actions) && res.actions.length > 0;
    if (hasActions) return false; // a recent bulk succeeded → bulk works, allow the push
    if (hasErr) rejects++;
  }
  return rejects >= minRejects;
}

/* --------------------------- Message formatters --------------------------- */

function formatToolStagnationReason(stagnation) {
  if (!stagnation || !Array.isArray(stagnation.entries) || stagnation.entries.length === 0) {
    return 'stagnation_detected';
  }
  if (stagnation.pattern === 'repeat') {
    return `stagnation_repeat:${stagnation.entries[0].toolName}:x${stagnation.entries.length}`;
  }
  if (stagnation.pattern === 'alternating' && stagnation.entries.length >= 2) {
    const first = stagnation.entries[0].toolName;
    const second = stagnation.entries[1].toolName;
    return `stagnation_cycle:${first}->${second}:x${Math.floor(stagnation.entries.length / 2)}`;
  }
  if (stagnation.pattern === 'read_thrash') {
    const tools = stagnation.entries.map(e => e.toolName).join(',');
    return `stagnation_read_thrash:${stagnation.entries.length}_reads_no_write:[${tools}]`;
  }
  if (stagnation.pattern === 'tight_read_thrash') {
    return `stagnation_tight_read_thrash:${stagnation.sheet || '?'}::${stagnation.target || '?'}`;
  }
  if (stagnation.pattern === 'destructive_loop') {
    return `stagnation_destructive_loop:${stagnation.sheet || 'unknown_sheet'}`;
  }
  return `stagnation_${stagnation.pattern}`;
}

module.exports = {
  // constants
  STAGNATION_WATCH_TOOLS,
  STAGNATION_MAX_REPEAT,
  STAGNATION_ALT_CYCLES,
  STAGNATION_MAX_TRAIL,
  READS_WITHOUT_WRITE_LIMIT,
  READ_ONLY_TOOLS_FOR_STAGNATION,
  SEMANTIC_LOOP_SOFT,
  SEMANTIC_LOOP_HARD,
  SEMANTIC_LOOP_WINDOW,
  NO_PROGRESS_LIMIT,
  PRODUCTIVE_TOOLS,
  SAME_TOOL_REJECT_LIMIT,
  WRITE_TOOLS_FOR_REJECT_GUARD,
  // signature helpers
  normalizeStagnationValue,
  buildToolStagnationSignature,
  extractReadTargetKey,
  extractSheetHint,
  // detectors
  detectToolStagnation,
  detectSemanticErrorLoop,
  buildSemanticLoopReplanMessage,
  detectSameToolRejectLoop,
  detectNoProgress,
  hasRecentBulkRejections,
  // formatters
  formatToolStagnationReason
};
