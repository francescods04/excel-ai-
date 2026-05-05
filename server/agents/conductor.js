// server/agents/conductor.js
// Multi-Agent Conductor — Orchestrates parallel specialist agents
//
// This is a SKETCH / MVP. It demonstrates the architecture described in
// docs/architecture/multi-agent-conductor.md
//
// Usage (from agentLoop.js when plan has multiple teams):
//   const { runConductor } = require('./conductor');
//   const result = await runConductor(turn, context, options);

const { runAgentLoop, TOOL_DEFINITIONS, getSystemPrompt, PROMPT_VARIANTS } = require('./agentLoop');
const logger = require('../utils/logger');

const CONDUCTOR_MAX_PARALLEL = Number(process.env.CONDUCTOR_MAX_PARALLEL) || 3;

/**
 * Build a dependency graph from tasks.
 * Returns waves: array of arrays, where each wave can run in parallel.
 */
function buildDepGraph(tasks) {
  const pending = new Set(tasks.map(t => t.id));
  const completed = new Set();
  const waves = [];

  while (pending.size > 0) {
    const wave = [];
    for (const id of pending) {
      const task = tasks.find(t => t.id === id);
      const deps = task.dependsOn || [];
      if (deps.every(d => completed.has(d))) {
        wave.push(task);
      }
    }
    if (wave.length === 0) {
      throw new Error(`Cyclic dependency detected in tasks: ${[...pending].join(', ')}`);
    }
    for (const t of wave) {
      pending.delete(t.id);
      completed.add(t.id);
    }
    waves.push(wave);
  }
  return { waves, tasks };
}

/**
 * Run a single specialist agent for a task.
 * Uses a narrowed system prompt and restricted tool set.
 */
async function runSpecialist(task, turn, context, options, sharedState) {
  const team = task.team || 'default';
  logger.info(`[Conductor] Starting specialist: ${task.id} (team=${team})`);

  // Narrow system prompt for the team
  const variantMap = {
    assumptions: 'analyst',
    dcf: 'default',
    comps: 'analyst',
    sensitivity: 'fast',
    default: 'default'
  };
  const variant = variantMap[team] || 'default';
  const systemPrompt = getSystemPrompt(variant);

  // Restrict tools to relevant subset
  const teamTools = getTeamTools(team);

  // Build a mini-turn for the specialist
  const specialistTurn = {
    id: `${turn.id}.${task.id}`,
    objective: task.description,
    items: [],
    log: [],
    sharedState // read-only access to other teams' outputs
  };

  // Override tool definitions for this specialist
  const specialistOptions = {
    ...options,
    systemPrompt,
    toolDefinitions: teamTools,
    maxIterations: 20,
    isSpecialist: true
  };

  const result = await runAgentLoop(specialistTurn, context, specialistOptions);
  logger.info(`[Conductor] Specialist ${task.id} completed: ${result.success ? 'success' : 'error'}`);

  return {
    taskId: task.id,
    team,
    success: result.success,
    actions: result.actions || [],
    narration: result.narration,
    sharedOutputs: result.sharedOutputs || {}
  };
}

/**
 * Return a subset of TOOL_DEFINITIONS relevant to a team.
 */
function getTeamTools(team) {
  const all = TOOL_DEFINITIONS;
  const always = ['search_tools', 'read_instructions', 'update_instructions'];
  const map = {
    assumptions: ['read_workbook', 'read_sheet', 'read_range', 'set_cell_range', 'web_search', 'web_fetch'],
    dcf: ['read_workbook', 'read_sheet', 'read_range', 'set_cell_range', 'calculate_formula'],
    comps: ['read_workbook', 'read_sheet', 'read_range', 'set_cell_range', 'web_search', 'web_fetch'],
    sensitivity: ['read_workbook', 'read_sheet', 'read_range', 'set_cell_range', 'calculate_formula'],
    default: all.map(t => t.name)
  };
  const names = new Set([...(map[team] || map.default), ...always]);
  return all.filter(t => names.has(t.name));
}

/**
 * Synthesize outputs from all specialists into a single coherent result.
 * This runs sequentially after all waves complete.
 */
async function runSynthesizer(plan, resultsMap, context, options) {
  logger.info(`[Conductor] Synthesizing ${resultsMap.size} specialist outputs...`);

  const allActions = [];
  const allNarrations = [];
  const sharedOutputs = {};

  for (const [taskId, result] of resultsMap) {
    if (result.success) {
      allActions.push(...(result.actions || []));
      if (result.narration) allNarrations.push(result.narration);
      Object.assign(sharedOutputs, result.sharedOutputs || {});
    } else {
      allNarrations.push(`[${taskId}] ERROR: ${result.error || 'Unknown error'}`);
    }
  }

  // Conflict resolution: if multiple actions target the same sheet+range,
  // keep only the first (or last — policy can be configurable)
  const seenRanges = new Set();
  const dedupedActions = [];
  for (const action of allActions) {
    const key = `${action.sheet || ''}:${action.target || JSON.stringify(action.cells || {})}`;
    if (seenRanges.has(key)) {
      logger.warn(`[Conductor] Dropping duplicate action: ${key}`);
      continue;
    }
    seenRanges.add(key);
    dedupedActions.push(action);
  }

  return {
    success: true,
    actions: dedupedActions,
    narration: {
      message: allNarrations.join('\n\n'),
      type: 'final'
    },
    sharedOutputs
  };
}

/**
 * Main entry point.
 */
async function runConductor(turn, context, options) {
  logger.info('[Conductor] Starting multi-agent orchestration');

  if (!turn.plan || !Array.isArray(turn.plan.tasks)) {
    throw new Error('Conductor requires a plan with tasks');
  }

  // 1. Build dependency graph
  const graph = buildDepGraph(turn.plan.tasks);
  logger.info(`[Conductor] Dependency graph: ${graph.waves.length} waves, ${turn.plan.tasks.length} tasks`);

  // 2. Execute waves
  const results = new Map();
  const sharedState = new Map(); // Shared key-value store across teams

  for (let i = 0; i < graph.waves.length; i++) {
    const wave = graph.waves[i];
    logger.info(`[Conductor] Wave ${i + 1}/${graph.waves.length}: ${wave.length} tasks`);

    // Respect max parallelism
    const batches = [];
    for (let j = 0; j < wave.length; j += CONDUCTOR_MAX_PARALLEL) {
      batches.push(wave.slice(j, j + CONDUCTOR_MAX_PARALLEL));
    }

    for (const batch of batches) {
      const batchResults = await Promise.all(
        batch.map(task => runSpecialist(task, turn, context, options, sharedState))
      );
      for (const r of batchResults) {
        results.set(r.taskId, r);
        // Merge shared outputs into global state
        Object.entries(r.sharedOutputs || {}).forEach(([k, v]) => sharedState.set(k, v));
      }
    }
  }

  // 3. Synthesize
  const synthesis = await runSynthesizer(turn.plan, results, context, options);

  logger.info('[Conductor] Orchestration complete');
  return synthesis;
}

module.exports = { runConductor, buildDepGraph, runSpecialist, runSynthesizer };
