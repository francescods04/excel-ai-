function isPrefetchSafeTask(task, registry) {
  if (!task || !task.tool) return false;
  const toolMeta = registry?.meta?.(task.tool);
  if (toolMeta?.costHint === 'high') return false;
  if (toolMeta?.category === 'read') return true;
  if (toolMeta?.requiresApproval === 'never') return true;
  const safePrefixes = ['yahoo.', 'workbook.read'];
  const safeTools = new Set(['requestUserInput']);
  return safePrefixes.some(prefix => task.tool.startsWith(prefix)) || safeTools.has(task.tool);
}

module.exports = {
  isPrefetchSafeTask
};
