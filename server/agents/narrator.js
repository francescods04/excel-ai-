const { callLLM } = require('../tools/llm');
const logger = require('../utils/logger');

const NARRATOR_TIMEOUT_MS = Number(process.env.NARRATOR_TIMEOUT_MS) || 15000;
const NARRATOR_FALLBACK_TIMEOUT_MS = Number(process.env.NARRATOR_FALLBACK_TIMEOUT_MS) || 8000;

const NARRATOR_SYSTEM_PROMPT = `Sei l'assistente di sintesi di un agente Excel AI.
Il tuo compito è produrre un riassunto conciso e utile di ciò che è stato fatto in questo turn.

Regole:
- Rispondi in italiano, tono professionale ma amichevole.
- Descrivi cosa è stato creato/modificato, non il processo.
- Elenca i fogli creati/modificati e le formule principali scritte.
- Se ci sono stati errori o warning, menzionali brevemente.
- Suggerisci 1-2 azioni successive che l'utente potrebbe voler fare (modificare ipotesi, cambiare periodo, aggiungere grafico).
- Se non ci sono actions (solo lettura dati), descrivi brevemente i dati ottenuti.
- Mantieni la risposta sotto le 250 parole.

Rispondi SOLO con JSON valido:
{
  "message": "string (riassunto principale)",
  "sheetsCreated": ["nome1", "nome2"],
  "sheetsModified": ["nome1"],
  "formulaCount": 0,
  "warnings": ["string"],
  "suggestions": ["suggerimento 1", "suggerimento 2"]
}`;

const NARRATOR_FALLBACK_SYSTEM_PROMPT = `Sei un assistente di sintesi. Riassumi in italiano cosa è stato fatto.
Rispondi SOLO con JSON: { "message": "string", "suggestions": ["string"] }`;

function summarizeObjective(objective) {
  if (!objective) return 'task';
  const text = String(objective);
  return text.length > 120 ? text.slice(0, 120) + '...' : text;
}

function countFormulasInAction(action) {
  if (!action) return 0;
  if (action.type === 'runFormula') return 1;
  if (action.type === 'setCellValue' && typeof action.value === 'string' && action.value.trim().startsWith('=')) return 1;
  if (action.type === 'setCellRange' && action.cells && typeof action.cells === 'object') {
    let count = 0;
    for (const spec of Object.values(action.cells)) {
      if (!spec || typeof spec !== 'object') continue;
      if (typeof spec.formula === 'string' && spec.formula.trim().startsWith('=')) { count++; continue; }
      if (typeof spec.value === 'string' && spec.value.trim().startsWith('=')) count++;
    }
    return count;
  }
  return 0;
}

function compileTurnSummary(objective, taskResults, errors, postSnapshot = null) {
  const tasks = [];
  let totalActions = 0;
  let totalFormulas = 0;
  const sheets = new Set();
  const warnings = [];

  if (taskResults && typeof taskResults === 'object') {
    for (const [taskId, result] of Object.entries(taskResults)) {
      if (taskId === '__postExecutionSnapshot') continue;
      const actions = Array.isArray(result?.actions) ? result.actions : [];
      const sheetActions = actions.filter(a => a.type === 'createSheet');
      let taskFormulas = 0;
      for (const a of actions) {
        if (a.sheet) sheets.add(a.sheet);
        if (a.name && a.type === 'createSheet') sheets.add(a.name);
        taskFormulas += countFormulasInAction(a);
      }

      tasks.push({
        taskId,
        actionCount: actions.length,
        formulaCount: taskFormulas,
        sheets: sheetActions.map(a => a.name)
      });

      totalActions += actions.length;
      totalFormulas += taskFormulas;
    }
  }

  if (errors?.length > 0) {
    warnings.push(...errors.map(e => typeof e === 'string' ? e : (e.error || e.message || String(e))));
  }

  let workbookState = null;
  if (postSnapshot && typeof postSnapshot === 'object') {
    const data = postSnapshot.data || postSnapshot;
    const liveSheets = Array.isArray(data?.sheets) ? data.sheets : [];
    let liveFormulaCount = 0;
    let liveValueCells = 0;
    const sheetBreakdown = [];
    for (const sheet of liveSheets) {
      const formulas = Array.isArray(sheet?.formulas) ? sheet.formulas : [];
      const preview = Array.isArray(sheet?.preview) ? sheet.preview : [];
      let fCount = 0;
      let vCount = 0;
      for (const row of formulas) {
        if (!Array.isArray(row)) continue;
        for (const cell of row) {
          if (typeof cell === 'string' && cell.trim().startsWith('=')) fCount++;
        }
      }
      for (const row of preview) {
        if (!Array.isArray(row)) continue;
        for (const cell of row) {
          if (cell !== '' && cell !== null && cell !== undefined) vCount++;
        }
      }
      liveFormulaCount += fCount;
      liveValueCells += vCount;
      sheetBreakdown.push({ name: sheet?.name, formulas: fCount, valueCells: vCount });
      if (sheet?.name) sheets.add(sheet.name);
    }
    workbookState = {
      capturedAt: postSnapshot.meta?.capturedAt || postSnapshot.capturedAt || null,
      activeSheet: data?.activeSheet || null,
      sheetCount: liveSheets.length,
      liveFormulaCount,
      liveValueCells,
      sheetBreakdown
    };
  }

  return {
    tasks,
    totalActions,
    totalFormulas,
    sheets: [...sheets],
    warnings: warnings.slice(0, 5),
    workbookState
  };
}

function buildDeterministicNarration(summary, objective, reportedFormulas, extra = {}) {
  const hasWorkbookOutput = summary.totalActions > 0 || reportedFormulas > 0;
  const sheetSummary = summary.sheets.length > 0 ? ` su ${summary.sheets.length} fogli` : '';
  const formulaSummary = reportedFormulas > 0 ? ` con ${reportedFormulas} formule` : '';
  const message = hasWorkbookOutput
    ? `Ho completato ${summary.totalActions} azioni${sheetSummary}${formulaSummary}.`
    : `Turn completato per: ${summarizeObjective(objective)}.`;

  return {
    message,
    sheetsCreated: [],
    sheetsModified: summary.sheets,
    formulaCount: reportedFormulas,
    warnings: summary.warnings,
    suggestions: summary.sheets.length > 0 ? ['Posso rifinire ipotesi, formattazione o controlli se vuoi.'] : [],
    workbookState: summary.workbookState,
    raw: { _fallback: true, ...extra }
  };
}

async function runNarratorAgent(objective, taskResults, errors = [], options = {}) {
  logger.info('[NarratorAgent] Avvio sintesi turn');
  const postSnapshot = options && options.postSnapshot ? options.postSnapshot : (taskResults && taskResults.__postExecutionSnapshot) || null;
  const summary = compileTurnSummary(objective, taskResults, errors, postSnapshot);
  const liveFormulas = summary.workbookState ? summary.workbookState.liveFormulaCount : null;
  const liveValueCells = summary.workbookState ? summary.workbookState.liveValueCells : null;
  const reportedFormulas = liveFormulas !== null ? liveFormulas : summary.totalFormulas;

  // Se non ci sono azioni emesse né stato live, sintesi deterministica (no LLM)
  if (summary.totalActions === 0 && (!summary.workbookState || (liveFormulas === 0 && liveValueCells === 0))) {
    const msg = errors.length > 0
      ? `Nessuna azione eseguita. Errori: ${summary.warnings.slice(0, 3).join('; ')}`
      : `Nessuna azione eseguita per: ${summarizeObjective(objective)}`;
    logger.info('[NarratorAgent] Fast-path deterministico (0 azioni)');
    return {
      message: msg,
      sheetsCreated: [],
      sheetsModified: summary.sheets,
      formulaCount: 0,
      warnings: summary.warnings,
      suggestions: []
    };
  }

  const workbookStateLine = summary.workbookState
    ? `Stato workbook reale post-mutazione: ${summary.workbookState.sheetCount} fogli, ${liveFormulas} formule, ${liveValueCells} celle con valore.`
    : '';
  const sheetBreakdownLine = summary.workbookState && summary.workbookState.sheetBreakdown.length > 0
    ? `Breakdown per foglio (live): ${summary.workbookState.sheetBreakdown.map(s => `${s.name}=${s.formulas}f/${s.valueCells}v`).join('; ')}`
    : '';

  if (process.env.NARRATOR_USE_LLM !== 'true') {
    logger.info('[NarratorAgent] Sintesi deterministica attiva');
    return buildDeterministicNarration(summary, objective, reportedFormulas, { deterministic: true });
  }

  const userText = [
    `Obiettivo: ${summarizeObjective(objective)}`,
    `Azioni totali emesse dall'agente: ${summary.totalActions}`,
    `Formule emesse dall'agente: ${summary.totalFormulas}`,
    workbookStateLine,
    sheetBreakdownLine,
    `Fogli coinvolti: ${summary.sheets.join(', ') || '(nessuno)'}`,
    `Task eseguiti: ${summary.tasks.length}`,
    summary.warnings.length > 0 ? `Warning: ${summary.warnings.join('; ')}` : '',
    summary.workbookState
      ? `NON dichiarare il workbook vuoto se le formule live sono > 0. Basa il riassunto sullo stato live, non sul piano.`
      : ''
  ].filter(Boolean).join('\n');

  const start = Date.now();
  try {
    const result = await callLLM({
      system: NARRATOR_SYSTEM_PROMPT,
      userText,
      timeoutMs: NARRATOR_TIMEOUT_MS,
      fallbackTimeoutMs: NARRATOR_FALLBACK_TIMEOUT_MS,
      label: 'NarratorAgent LLM',
      role: 'narrator'
    });

    logger.info(`[NarratorAgent] Completato in ${Date.now() - start}ms`);
    return {
      message: result.message || 'Turn completato con successo.',
      sheetsCreated: result.sheetsCreated || [],
      sheetsModified: result.sheetsModified || summary.sheets,
      formulaCount: result.formulaCount ?? reportedFormulas,
      warnings: result.warnings || summary.warnings,
      suggestions: result.suggestions || [],
      workbookState: summary.workbookState,
      raw: result
    };
  } catch (e) {
    logger.warn(`[NarratorAgent] Fallback dopo errore LLM: ${e.message}`);
    return buildDeterministicNarration(summary, objective, reportedFormulas);
  }
}

module.exports = { runNarratorAgent, compileTurnSummary };
