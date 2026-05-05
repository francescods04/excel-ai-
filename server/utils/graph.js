function computeLevels(tasks) {
  const depsMap = new Map(tasks.map(task => [task.id, new Set(task.deps || [])]));
  const levelMap = new Map();
  const visiting = new Set();

  function getLevel(taskId) {
    if (levelMap.has(taskId)) return levelMap.get(taskId);
    if (visiting.has(taskId)) throw new Error('Ciclo dipendenze nel task graph');
    if (!depsMap.has(taskId)) throw new Error(`Task dipendenza non trovato: ${taskId}`);

    visiting.add(taskId);
    const deps = depsMap.get(taskId) || new Set();

    if (deps.size === 0) {
      levelMap.set(taskId, 0);
      visiting.delete(taskId);
      return 0;
    }

    const maxDepLevel = Math.max(...Array.from(deps).map(depId => getLevel(depId)));
    const level = maxDepLevel + 1;
    levelMap.set(taskId, level);
    visiting.delete(taskId);
    return level;
  }

  for (const task of tasks) {
    getLevel(task.id);
  }

  const levels = new Map();
  for (const [taskId, level] of levelMap.entries()) {
    if (!levels.has(level)) levels.set(level, []);
    levels.get(level).push(taskId);
  }
  return levels;
}

module.exports = { computeLevels };
