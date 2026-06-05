# Mega Scenario Pipeline — Detailed Plan

**Goal**: Production-grade output on 20+ sheet, 5k-10k cell, institutional-grade financial models (LBO institutional, bank stress test, REIT multi-asset).

**Current baseline** (iter13):
- Simple/medium (≤12 sheets, ≤1500 cells): **100/100 reliable** (DCF, LBO, 3-stmt, vairano, M&A)
- Mega (22+ sheets, 2500+ cells): subagent score 22/100 (deal-breaker bugs)

**Target**: mega scenarios consistently ≥75/100 with all critical formulas correct.

---

## Phase 0 — State of the pipeline

### Working components
| Module | Role | Status |
|---|---|---|
| `enhanced.js` | Orchestrator + topological layering | Solid |
| `sliceLoop.js` | Agentic per-slice loop (write→validate→fix→retry) | Solid |
| `targetedFixer.js` | Per-bug LLM patch (Claude Code style) | Solid |
| `cellDepValidator.js` | Deterministic ref/circularity check | Solid |
| `financeLint.js` | Finance domain lints (Mix, IRR-array, sensitivity, etc.) | Working |
| `semanticAutoFix.js` | Mix normalize, time-series fill, ref repair | Working |
| `aiReviewer.js` | Pro-tier peer review per slice | Opt-in |
| `semanticCritic.js` | Workbook-wide semantic audit | Single pass |
| `actionSanitizer.js` | TABLE strip, sheet canonical, == defense | Solid |

### Mega-scenario failure modes (from iter12 audit)
1. **Sources_Uses imbalance**: $59M off (1.15%). Equity Purchase uses Revenue×Multiple instead of EBITDA×Multiple.
2. **Operating_Model 4×Y0 revenue**: LLM puts LTM revenue in every Q without /4.
3. **EBITDA confused with COGS**: 32% margin treated as gross margin then subtracted twice.
4. **Sensitivity grids broken**: both axes drive same direction; IRR ranges slide column-wise.
5. **Interest expense = 0 flat** despite $875M debt.
6. **Two parallel WACCs** in same sheet not reconciled.

### Root causes
- LLM can't track unit semantics across 22 sheets without explicit contracts
- Time-series density (24 quarterly cols) overwhelms single-shot codegen
- Sensitivity grids are conceptually freeform — no DSL constraining them
- No post-write balance enforcement (Sources=Uses, BS balance)

---

## Phase 1 — Foundation: Symbol layer completion

**Goal**: LLM never references raw cell addresses cross-sheet. Uses concept names. Pipeline deterministically resolves.

### 1A. Extend symbol map to be authoritative

Current `extractSymbolMap` (enhanced.js) tags rows with `[@concept]` based on regex patterns. Extend:

```js
// Per-sheet symbol table:
{
  sheet: 'Assumptions_Operating',
  symbols: {
    'revenue_ltm': { address: '$B$3', value: 450000000, unit: 'EUR', label: 'LTM Revenue' },
    'rev_growth_y1': { address: '$B$4', value: 0.10, unit: 'pct', label: 'Revenue Growth Y1' },
    'rev_growth_y2': { address: '$B$5', value: 0.09, unit: 'pct' },
    ...
    'ebitda_margin': { address: '$B$9', value: 0.32, unit: 'pct' },
    'tax_rate': { address: '$B$12', value: 0.24, unit: 'pct' }
  }
}
```

### 1B. Symbol resolver pre-codegen

Before each downstream slice generates, inject a **symbol-resolution prompt section**:

```
## SYMBOLS YOU CAN REFERENCE (use exact addresses):
- Assumptions_Operating:
  - @revenue_ltm = $B$3 (EUR, "LTM Revenue", val: 450000000)
  - @ebitda_margin = $B$9 (pct, "EBITDA Margin", val: 0.32)
  - @tax_rate = $B$12 (pct, "Tax Rate", val: 0.24)
- Assumptions_Financing:
  - @entry_multiple = $B$17 (x, "Entry Multiple x LTM EBITDA", val: 11)
  - @exit_multiple = $B$25 (x, "Exit Multiple", val: 10)

When writing a formula that needs the EBITDA margin, USE Assumptions_Operating!$B$9 — NOT some other row.
```

### 1C. Post-codegen symbol verification

After slice runs, scan each formula for cross-sheet refs. For each ref:
- Look up the target cell's row label
- Check it semantically matches what the local cell expects
- If mismatch (e.g. D&A row refs "Shares Outstanding") → flag as `wrong_symbol_ref` for targeted fixer

**Files**: `enhanced.js`, new `symbolLayer.js`

**Estimated quality gain**: +20-25 on mega scenarios (kills the wrong-row bug class).

**Estimated implementation**: 1-2 sessions (~4-6 hours).

---

## Phase 2 — Sensitivity DSL with axis binding

**Goal**: Sensitivity tables generated from structured spec, not freeform LLM. Eliminates dead-grid + axis-confusion bugs.

### 2A. Planner emits sensitivity_spec for each sensitivity sheet

Add to planner output JSON:
```json
{
  "sheet": "Sensitivity_IRR",
  "sensitivity_spec": {
    "x_axis": { "concept": "entry_multiple", "values": [9, 10, 11, 12, 13], "header_row": 3, "first_col": "B" },
    "y_axis": { "concept": "exit_multiple", "values": [8, 9, 10, 11, 12], "first_row": 4, "header_col": "A" },
    "output_metric": "sponsor_irr",
    "base_formula": "=IRR(Returns_Equity!$B$10:$H$10)",
    "x_substitution": "replace @entry_multiple with B$<header_row>",
    "y_substitution": "replace @exit_multiple with $A<row>"
  }
}
```

### 2B. Deterministic sensitivity generator

`sensitivityGen.js`:
1. Take the spec
2. Write headers (x-axis row, y-axis col)
3. For each interior cell (r,c), substitute symbol refs with mixed-ref (col-locked or row-locked)
4. Emit setCellRange action with all 25 cells

No LLM creativity needed for sensitivity body. Determined by axes.

### 2C. Fallback if planner doesn't emit spec

If the LLM-generated section has no sensitivity_spec but its name matches `Sensitivity*`:
- Try to detect axes by scanning row 1-3 (headers) and col A (row headers)
- Build spec from detected axes
- Regenerate body deterministically

**Files**: new `sensitivityGen.js`, hook into `enhanced.js` post-slice

**Estimated quality gain**: +10-15 on scenarios with sensitivity sheets.

**Estimated implementation**: 1 session (~3-4 hours).

---

## Phase 3 — Skeleton-then-fill for huge time series

**Goal**: 60-month or 24-quarter time series reliably full-density. LLM writes Y1/Q1 only; deterministic code expands.

### 3A. Two-pass slice for time-series

In `runSlice`, detect huge time series (`is_time_series` + `periods >= 24`). Branch to micro-step:

**Pass A (LLM)**: write only Y1 columns (B:M for 12-mo, B:E for 4-Q) + row-by-row formula template with explicit `$` markers indicating which refs are absolute. Output also includes:
```json
{
  "fill_directives": [
    {"src_range": "B4:E4", "fill_range": "F4:Y4", "growth_anchor": "Assumptions!$B$5", "compound": "annually"},
    {"src_range": "B5:E5", "fill_range": "F5:Y5", "growth_anchor": null, "compound": null}
  ]
}
```

**Pass B (deterministic)**: read fill_directives, expand templates programmatically:
- For each fill range, copy source column formula
- Shift relative refs by column delta
- Apply growth_anchor at each year boundary
- For "compound annually", multiply by `(1+growth)^year_index`

No LLM call in Pass B. Output guaranteed dense.

### 3B. If LLM doesn't emit fill_directives

Heuristic fallback (current `expandTimeSeriesColumns` in `semanticAutoFix.js`) handles simple cases but breaks on year boundaries. Improve by:
- Detect Y1/Y2/Y3/.../Y5 headers in row 1
- Group columns into year buckets (4 cols/year)
- Within Y1: shift col refs
- At Y2 boundary: apply growth annualy
- Apply growth_anchor heuristically (look for cell labeled "growth" in Assumptions)

**Files**: extend `microStep.js`, improve `semanticAutoFix.expandTimeSeriesColumns`

**Estimated quality gain**: +15-20 on huge time series (Operating Model quarterly, fastfood 60-mo).

**Estimated implementation**: 1-2 sessions (~5-6 hours).

---

## Phase 4 — Balance/consistency invariant enforcement

**Goal**: After codegen, deterministically verify model-level invariants (Sources=Uses, BS balance, Mix=1). Auto-fix or feed back as targeted bugs.

### 4A. Planner emits invariants

Extend planner prompt rule:
```
For each model, list invariants the codegen must satisfy:
{
  "invariants": [
    {"kind": "balance", "left": "Sources_Uses!Total_Sources", "right": "Sources_Uses!Total_Uses", "tolerance": 0.01},
    {"kind": "balance", "left": "Balance_Sheet!Total_Assets", "right": "Balance_Sheet!Total_Liab_Equity", "tolerance": 0.01},
    {"kind": "sum_to_one", "range": "Menu!E3:E30"},
    {"kind": "growth_sequence", "row": "Revenue", "expected_cagr": 0.10, "tolerance": 0.03},
    {"kind": "nonzero_if_dependency", "cell": "Operating_Model!B10", "depends_on": "Debt_Schedule!B26", "reason": "Interest expense must be > 0 if debt > 0"}
  ]
}
```

### 4B. Mini formula evaluator

Build `formulaEval.js` — a tiny JS Excel formula evaluator covering:
- Cell references (relative + absolute, cross-sheet)
- Arithmetic (+, -, *, /, ^)
- Aggregation (SUM, AVERAGE, MIN, MAX, COUNT)
- Conditionals (IF, IFERROR)
- Lookup (VLOOKUP basic, INDEX, MATCH)
- Financial (IRR via numerical, NPV)
- Iterative solver for circular refs (Cash plug pattern) — 100 iterations max

Cap complexity: handle 80% of formulas the LLM writes. For unsupported formulas, return `#NOEVAL` and skip the invariant.

### 4C. Invariant runner

After codegen:
1. Evaluate workbook
2. For each invariant, compute LHS and RHS
3. If violated by > tolerance → feed back as bug to targetedFixer
4. After 1 fix pass, re-evaluate and re-check
5. Cap at 2 invariant-loop iterations

### 4D. Specific auto-fixes for common invariants

- `sum_to_one` violated: divide each cell by current sum (already implemented in Mix normalizer)
- `balance` violated: identify the imbalance amount, find a "plug" cell (e.g. "Cash on Hand" in Sources_Uses), adjust its value/formula
- `nonzero_if_dependency` violated: high-confidence targeted fix to replace 0 with formula based on the dependency

**Files**: new `formulaEval.js`, new `invariantChecker.js`, planner prompt update

**Estimated quality gain**: +10-15 on all scenarios. Eliminates Sources/Uses imbalance, BS check failures, Mix sum errors.

**Estimated implementation**: 2-3 sessions (~8-12 hours). Formula evaluator is the bulk.

---

## Phase 5 — Judge + rejection sampling for critical slices

**Goal**: Critical slices (Assumptions, P&L, Returns, Sensitivity, WACC) get N=3 parallel generations; pro-tier judge picks best.

### 5A. Identify critical slices

Heuristic: sheets matching pattern `Assumptions|Operating_Model|Returns|Sensitivity|WACC|Sources_Uses|Balance_Sheet`.

### 5B. Rejection sampling pool

In `runSlice`, for critical slices:
1. Generate N=3 candidates in parallel (flash + 2× flash with slight prompt variation)
2. Run deterministic + AI reviewer on each
3. Pro-tier judge scores each: { coverage, correctness, cross_ref_validity, formula_quality }
4. Pick highest-scored
5. Continue agentic loop on the winner

### 5C. Token budget management

Budget per scenario: 1M tokens. Mega LBO ran ~370k. With rejection sampling N=3 on ~6 critical slices, add ~150k. Total ~520k — within budget.

**Files**: extend `sliceLoop.js`, reuse existing `consensusGen.js` with judge pass

**Estimated quality gain**: +10-15 on complex/mega.

**Estimated implementation**: 1 session (~3-4 hours).

---

## Phase 6 — Test strategy

### Test suite progression

1. **Smoke tests** (already passing): DCF, LBO, 3-stmt, vairano, M&A
2. **Mega scenarios**: lbo_institutional, bank_stress_test, franchise_rollout, saas_full
3. **New ultra-mega** (after Phase 1-5): full PE deliverable with 25 sheets + monitoring dashboard

### Subagent audit cadence

After each Phase implementation:
1. Run bench on mega scenarios
2. Spawn subagent per scenario
3. Subagent identifies remaining systemic bugs
4. Feed top 3 systemic bugs into next phase prioritization

### Success criteria

- **Phase 1+2 done**: lbo_institutional ≥50/100 from subagent audit
- **Phase 3+4 done**: mega scenarios ≥75/100 reliably
- **Phase 5 done**: 90/100 on the harder scenarios (bank stress, ultra-mega)

---

## Phase 7 — Implementation order + time estimate

| Phase | Priority | Effort | Quality Gain | When |
|---|---|---|---|---|
| 1: Symbol layer completion | P0 | 4-6h | +20-25 | Next |
| 2: Sensitivity DSL | P0 | 3-4h | +10-15 | After 1 |
| 4: Invariant evaluator | P1 | 8-12h | +10-15 | After 2 |
| 3: Skeleton-then-fill | P1 | 5-6h | +15-20 | Parallel w/ 4 |
| 5: Judge + rejection | P2 | 3-4h | +10-15 | After 3+4 |

**Total estimated effort**: 23-32 hours across 5-7 sessions.

**Cumulative quality lift estimate**: +65-90 points on mega scenarios → realistic target 75-90/100.

---

## Phase 8 — Risk mitigation

### Known risks

1. **Symbol concept regex too broad**: e.g. "tax rate" matches "tax filing rate". Mitigation: prefer exact label match, use regex only as fallback. Log all symbol resolutions in dev logs.

2. **Sensitivity DSL too rigid**: planner may emit malformed spec. Mitigation: validate spec at receive time; fallback to current freeform if invalid.

3. **Formula evaluator incomplete**: 20% of formulas unsupported. Mitigation: skip invariant check for cells with unsupported formulas; don't block on `#NOEVAL`.

4. **Pro tokens budget overrun**: rejection sampling N=3 with pro judge could double cost. Mitigation: rate-limit guard at 600k tokens/scenario; degrade to N=2 or N=1 if over.

5. **Determinism breaks user mental model**: deterministic auto-fills may produce slightly different cells than LLM intent. Mitigation: keep LLM as primary; auto-fill only as backup. Log all auto-fills clearly.

### Rollback plan

Each phase shipped behind env flag:
- `CF_SYMBOL_LAYER=1` (Phase 1)
- `CF_SENSITIVITY_DSL=1` (Phase 2)
- `CF_SKELETON_FILL=1` (Phase 3)
- `CF_INVARIANTS=1` (Phase 4)
- `CF_REJECTION_SAMPLING=1` (Phase 5)

Default OFF until benched. Enable after subagent confirms quality lift.

---

## Phase 9 — Success metric definition

**Primary**: average score on bench across 4 mega scenarios after subagent audit.

**Secondary**:
- Wall time ≤ 20 minutes for mega scenario (currently 16 min)
- Token cost ≤ 1M per mega scenario
- Pass rate ≥ 70% (vs current 20%)
- Subagent verdict "usable-with-caveats" or better on ≥3 of 4 mega scenarios

**Stretch goal**: 1 scenario rated "production-grade" by subagent.

---

## TL;DR — what we're building

```
LLM picks wrong row?
  → Symbol layer (Phase 1) eliminates wrong-row class

LLM messes up time series?
  → Skeleton-then-fill (Phase 3) makes density deterministic

LLM produces dead sensitivity?
  → Sensitivity DSL (Phase 2) generates from spec

Sources don't balance?
  → Invariant runner (Phase 4) detects + auto-fixes

LLM variance kills quality?
  → Rejection sampling (Phase 5) picks best of N
```

Pipeline becomes **deterministic where it can be, LLM-driven where it must be**. Like Codex/Aider: small focused LLM calls, large deterministic scaffolding.

Start with Phase 1 (symbol layer completion) — highest ROI, foundation for others.
