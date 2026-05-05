# Multi-Agent Conductor Architecture

## Overview

The conductor enables parallel execution of specialized agent teams for complex financial modeling tasks (DCF, LBO, Comps, etc.). Instead of a single agent handling everything serially, the conductor spawns multiple **specialist agents** that work in parallel and return results to a **synthesizer** that merges outputs into the final workbook.

## When to Use

| Scenario | Single Agent | Multi-Agent |
|----------|-------------|-------------|
| Simple data cleaning | ✅ | ❌ Overkill |
| DCF with 50+ line items | ✅ | ⚠️ Optional |
| Full 3-statement + DCF + Comps | ❌ Too slow | ✅ Recommended |
| LBO with complex debt schedules | ⚠️ Slow | ✅ Recommended |
| Sensitivity tables (6+ variables) | ⚠️ Slow | ✅ Recommended |

## Architecture

```
User Request
    │
    ▼
┌─────────────────┐
│   Conductor     │  ← Decides teams, delegates, monitors
│  (Orchestrator) │
└────────┬────────┘
         │
    ┌────┴────┬────────┬────────┐
    ▼         ▼        ▼        ▼
┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐
│Assump.│ │  DCF  │ │ Comps │ │ Sens  │  ← Specialist Agents (parallel)
│ Agent │ │ Agent │ │ Agent │ │ Agent │
└───┬───┘ └───┬───┘ └───┬───┘ └───┬───┘
    │         │         │         │
    └─────────┴─────────┴─────────┘
                    │
                    ▼
            ┌───────────────┐
            │  Synthesizer  │  ← Merges outputs, resolves conflicts
            │   (Reducer)   │
            └───────┬───────┘
                    │
                    ▼
            ┌───────────────┐
            │ Final Actions │  ← write_cells, formatting, charts
            │   → Client    │
            └───────────────┘
```

## Agent Teams

### 1. Assumptions Agent
- **Prompt**: `system-prompt-analyst.md` + assumptions skill
- **Input**: Raw data, historicals, management guidance
- **Output**: Structured assumptions table (revenue growth, margins, capex, etc.)
- **Tools**: `read_workbook`, `web_search`, `set_cell_range`

### 2. DCF Agent
- **Prompt**: `system-prompt-ib-grade.md` + DCF skill
- **Input**: Assumptions table, WACC, terminal growth
- **Output**: FCF projections, valuation, sensitivity grid
- **Tools**: `read_workbook`, `set_cell_range`, `calculate_formula`

### 3. Comps Agent
- **Prompt**: `system-prompt-analyst.md` + comps skill
- **Input**: Peer tickers, market data
- **Output**: Trading comps table, precedent transactions
- **Tools**: `read_workbook`, `web_search`, `set_cell_range`

### 4. Sensitivity Agent
- **Prompt**: `system-prompt-ib-fast.md`
- **Input**: Base case model, variable ranges
- **Output**: Data tables, tornado charts, scenario matrices
- **Tools**: `read_workbook`, `set_cell_range`, `calculate_formula`

## Conductor Protocol

### Phase 1: Planning (Sequential)
The conductor calls the **planner** (existing `planner.js`) to decompose the user request into tasks. Each task is tagged with a `team` field.

```json
{
  "objective": "Build full DCF for AAPL",
  "tasks": [
    { "id": "T1", "team": "assumptions", "description": "..." },
    { "id": "T2", "team": "dcf", "description": "...", "dependsOn": ["T1"] },
    { "id": "T3", "team": "sensitivity", "description": "...", "dependsOn": ["T2"] }
  ]
}
```

### Phase 2: Execution (Parallel where possible)
The conductor builds a **dependency graph** and executes tasks in waves:
- Wave 1: All tasks with no dependencies (parallel)
- Wave 2: Tasks whose dependencies are satisfied
- etc.

### Phase 3: Synthesis (Sequential)
The **synthesizer** agent receives all team outputs and:
1. Merges cell writes into a single `set_cell_range` batch
2. Resolves range conflicts (e.g., DCF and Comps both writing to Sheet1)
3. Adds cross-references (e.g., Comps valuation → DCF summary)
4. Generates final narration

## Implementation Sketch

### `server/agents/conductor.js`

```js
async function runConductor(turn, context, options) {
  // 1. Plan
  const plan = await planner.generatePlan(turn.objective, context);

  // 2. Build dependency graph
  const graph = buildDepGraph(plan.tasks);

  // 3. Execute waves
  const results = new Map();
  for (const wave of graph.waves) {
    const waveResults = await Promise.all(
      wave.map(task => runSpecialist(task, context, options))
    );
    for (const r of waveResults) results.set(r.taskId, r);
  }

  // 4. Synthesize
  const synthesis = await runSynthesizer(plan, results, context, options);

  return synthesis;
}
```

### `runSpecialist(task, context, options)`

Each specialist is a lightweight `runAgentLoop` call with:
- **Narrowed system prompt** (team-specific variant)
- **Pre-loaded skill** (e.g., DCF skill)
- **Restricted tool set** (only tools relevant to the team)
- **Shared context** (read-only access to other teams' outputs)

### Shared State

Teams communicate via a **shared key-value store** (per-turn):

```js
const shared = new Map(); // In-memory, per-turn
shared.set('assumptions.revenueGrowth', [...]);
shared.set('dcf.enterpriseValue', 1234);
```

The synthesizer reads from this store to build cross-references.

## Performance Gains

| Task | Single Agent | Multi-Agent | Speedup |
|------|-------------|-------------|---------|
| 3-Statement + DCF | 8-12 min | 4-6 min | ~2x |
| LBO + Sensitivity | 10-15 min | 5-7 min | ~2x |
| Full Pitch Book | 20-30 min | 8-12 min | ~2.5x |

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Race conditions on cell writes | Synthesizer owns all writes; teams only produce **intents** |
| Context duplication (token waste) | Each specialist gets only relevant skills + shared state snippets |
| LLM rate limits | Add `p-limit` concurrency control (max 3 parallel agents) |
| Debugging complexity | Each team logs to its own `turnId.subTeam` log file |

## Future Enhancements

- **Human-in-the-loop approval** between waves
- **Dynamic replanning** if a team fails or returns low-confidence results
- **Agent memory** — specialists learn from past models (via `update_instructions`)
