const HARNESS_VERSION = 'excel-harness-v1';

const AGENT_PROFILES = {
  plan: {
    name: 'plan',
    mode: 'primary',
    role: 'Read-only planning agent for workbook analysis and task decomposition.',
    stepBudget: 40,
    permissions: { read: 'allow', mutation: 'deny', externalData: 'ask', userInput: 'ask' }
  },
  build: {
    name: 'build',
    mode: 'primary',
    role: 'Full workbook build agent that can coordinate reads, writes, formatting and verification.',
    stepBudget: 160,
    permissions: { read: 'allow', mutation: 'ask', externalData: 'ask', userInput: 'ask' }
  },
  workbookScout: {
    name: 'workbookScout',
    mode: 'subagent',
    role: 'Read workbook structure, formulas, semantic meaning and data-quality signals.',
    stepBudget: 24,
    permissions: { read: 'allow', mutation: 'deny', externalData: 'deny', userInput: 'deny' }
  },
  marketScout: {
    name: 'marketScout',
    mode: 'subagent',
    role: 'Collect external market, macro and company data when workbook data is insufficient or public-company context is explicit.',
    stepBudget: 32,
    permissions: { read: 'allow', mutation: 'deny', externalData: 'allow', userInput: 'deny' }
  },
  modelArchitect: {
    name: 'modelArchitect',
    mode: 'subagent',
    role: 'Design workbook layout, model sections, sheet structure and named ranges.',
    stepBudget: 36,
    permissions: { read: 'allow', mutation: 'ask', externalData: 'ask', userInput: 'ask' }
  },
  modelAnalyst: {
    name: 'modelAnalyst',
    mode: 'subagent',
    role: 'Perform deep business, finance, accounting and analytical reasoning before writing workbook outputs.',
    stepBudget: 96,
    permissions: { read: 'allow', mutation: 'ask', externalData: 'ask', userInput: 'ask' }
  },
  formulaEngineer: {
    name: 'formulaEngineer',
    mode: 'subagent',
    role: 'Write robust Excel formulas, references, checks and transformations.',
    stepBudget: 64,
    permissions: { read: 'allow', mutation: 'ask', externalData: 'deny', userInput: 'ask' }
  },
  formatDesigner: {
    name: 'formatDesigner',
    mode: 'subagent',
    role: 'Apply professional formatting that reflects workbook semantics, domain and user intent.',
    stepBudget: 36,
    permissions: { read: 'allow', mutation: 'ask', externalData: 'deny', userInput: 'ask' }
  },
  auditReviewer: {
    name: 'auditReviewer',
    mode: 'subagent',
    role: 'Review model integrity, formula risks, source quality and readiness without rewriting the workbook.',
    stepBudget: 48,
    permissions: { read: 'allow', mutation: 'deny', externalData: 'ask', userInput: 'ask' }
  }
};

const LEGACY_AGENT_MAP = {
  data: 'workbookScout',
  layout: 'modelArchitect',
  formula: 'formulaEngineer',
  format: 'formatDesigner',
  audit: 'auditReviewer',
  analyst: 'modelAnalyst'
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getHarnessAgentProfile(agentName) {
  const key = LEGACY_AGENT_MAP[agentName] || agentName || 'build';
  return AGENT_PROFILES[key] || AGENT_PROFILES.build;
}

function isExternalDataTool(tool = '') {
  return /^(openbb|yahoo)\./.test(String(tool));
}

function isWorkbookReadTool(tool = '') {
  return /^workbook\.(read|scan|buildGraph|understand|listNamedRanges)/.test(String(tool));
}

function isFormatTool(tool = '') {
  return tool === 'llm.planFormat' || tool === 'excel.applyFormat' || tool === 'excel.setConditionalFormat';
}

function isLayoutTool(tool = '') {
  return tool === 'llm.planLayout' ||
    tool === 'excel.createSheet' ||
    tool === 'excel.renameSheet' ||
    tool === 'excel.deleteSheet' ||
    tool === 'excel.duplicateSheet' ||
    tool === 'excel.copyRange' ||
    tool === 'excel.createNamedRange';
}

function isFormulaTool(tool = '') {
  return tool === 'llm.writeFormulas' ||
    tool === 'workbook.writeRange' ||
    tool === 'excel.setValues' ||
    tool === 'excel.setFormulas' ||
    tool === 'excel.addChart' ||
    tool.startsWith('excel.set');
}

function inferHarnessAgent(task = {}) {
  const tool = String(task.tool || '');
  const section = String(task.params?.section || '').toLowerCase();
  const text = `${task.description || ''} ${task.params?.objective || ''} ${task.params?.mode || ''}`.toLowerCase();

  if (tool === 'finance.dcf.buildSection') {
    if (section === 'format') return 'formatDesigner';
    if (section === 'shell' || section === 'sources') return 'modelArchitect';
    if (section === 'audit') return 'auditReviewer';
    return 'modelAnalyst';
  }
  if (isExternalDataTool(tool)) return 'marketScout';
  if (isWorkbookReadTool(tool)) return 'workbookScout';
  if (isFormatTool(tool)) return 'formatDesigner';
  if (isLayoutTool(tool)) return 'modelArchitect';
  if (isFormulaTool(tool)) return 'formulaEngineer';
  if (section === 'audit' || /\baudit\b|review|verifica|controll/.test(text)) return 'auditReviewer';
  return getHarnessAgentProfile(task.agent).name;
}

function inferRiskLevel(task = {}, toolMeta = null) {
  const tool = String(task.tool || '');
  if (toolMeta?.requiresApproval === 'always') return 'high';
  if (toolMeta?.category === 'mutation') return 'medium';
  if (tool === 'excel.deleteSheet' || tool === 'excel.renameSheet') return 'high';
  if (tool === 'execute_office_js' || tool === 'execute_python') return 'high';
  if (isExternalDataTool(tool)) return 'medium';
  return 'low';
}

function shouldRequireApproval(task = {}, toolMeta = null, profile = null) {
  if (task.requiresApproval === true) return true;
  if (profile?.permissions?.mutation === 'deny') return false;
  if (toolMeta?.requiresApproval === 'always') return true;
  if (toolMeta?.category === 'mutation') return false;
  return false;
}

function applyExcelHarnessToTask(task = {}, registry = null) {
  const toolMeta = registry?.meta?.(task.tool) || null;
  const harnessAgent = inferHarnessAgent(task);
  const profile = getHarnessAgentProfile(harnessAgent);
  const risk = inferRiskLevel(task, toolMeta);
  const nextTask = {
    ...task,
    agent: task.agent || LEGACY_AGENT_MAP[harnessAgent] || harnessAgent,
    requiresApproval: shouldRequireApproval(task, toolMeta, profile)
  };
  nextTask.harness = {
    version: HARNESS_VERSION,
    agent: profile.name,
    mode: profile.mode,
    role: profile.role,
    stepBudget: task.stepBudget || profile.stepBudget,
    risk,
    permissions: clone(profile.permissions),
    toolCategory: toolMeta?.category || null,
    toolRequiresApproval: toolMeta?.requiresApproval || 'auto'
  };
  return nextTask;
}

function applyExcelHarnessToPlan(plan = {}, registry = null) {
  const tasks = Array.isArray(plan.tasks)
    ? plan.tasks.map(task => applyExcelHarnessToTask(task, registry))
    : [];
  return {
    ...plan,
    harness: {
      version: HARNESS_VERSION,
      primaryAgents: ['plan', 'build'],
      subagents: ['workbookScout', 'marketScout', 'modelArchitect', 'modelAnalyst', 'formulaEngineer', 'formatDesigner', 'auditReviewer']
    },
    tasks
  };
}

function getHarnessPromptSummary() {
  const lines = [
    'EXCEL HARNESS AGENTS:',
    '- plan: read-only primary agent for analysis and task decomposition.',
    '- build: primary agent for approved workbook-changing work.',
    '- workbookScout: read-only workbook structure/formula/semantic inspection.',
    '- marketScout: external data collection only when justified.',
    '- modelArchitect: layout, sheet design, named ranges and model structure.',
    '- modelAnalyst: deep domain reasoning, valuation/accounting/business analysis.',
    '- formulaEngineer: robust Excel formulas and transformations.',
    '- formatDesigner: semantic formatting and visual polish.',
    '- auditReviewer: read-only integrity and readiness review.',
    'Use the most specific agent for each task. Read-only agents must not produce Excel mutations.'
  ];
  return lines.join('\n');
}

module.exports = {
  HARNESS_VERSION,
  AGENT_PROFILES,
  applyExcelHarnessToPlan,
  applyExcelHarnessToTask,
  getHarnessAgentProfile,
  getHarnessPromptSummary,
  inferHarnessAgent
};
