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

function compileTurnSummary(objective, taskResults, errors) {
  const tasks = [];
  let totalActions = 0;
  let totalFormulas = 0;
  const sheets = new Set();
  const warnings = [];

  if (taskResults && typeof taskResults === 'object') {
    for (const [taskId, result] of Object.entries(taskResults)) {
      const actions = Array.isArray(result?.actions) ? result.actions : [];
      const formulaActions = actions.filter(a => a.type === 'runFormula');
      const sheetActions = actions.filter(a => a.type === 'createSheet');

      for (const a of actions) {
        if (a.sheet) sheets.add(a.sheet);
        if (a.name && a.type === 'createSheet') sheets.add(a.name);
      }

      tasks.push({
        taskId,
        actionCount: actions.length,
        formulaCount: formulaActions.length,
        sheets: sheetActions.map(a => a.name)
      });

      totalActions += actions.length;
      totalFormulas += formulaActions.length;
    }
  }

  if (errors?.length > 0) {
    warnings.push(...errors.map(e => typeof e === 'string' ? e : (e.error || e.message || String(e))));
  }

  return {
    tasks,
    totalActions,
    totalFormulas,
    sheets: [...sheets],
    warnings: warnings.slice(0, 5)
  };
}

async function runNarratorAgent(objective, taskResults, errors = []) {
  logger.info('[NarratorAgent] Avvio sintesi turn');
  const summary = compileTurnSummary(objective, taskResults, errors);

  // Se non ci sono azioni, sintesi deterministica (no LLM)
  if (summary.totalActions === 0) {
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

  const userText = [
    `Obiettivo: ${summarizeObjective(objective)}`,
    `Azioni totali: ${summary.totalActions}`,
    `Formule: ${summary.totalFormulas}`,
    `Fogli coinvolti: ${summary.sheets.join(', ') || '(nessuno)'}`,
    `Task eseguiti: ${summary.tasks.length}`,
    summary.warnings.length > 0 ? `Warning: ${summary.warnings.join('; ')}` : ''
  ].filter(Boolean).join('\n');

  const start = Date.now();
  try {
    const result = await callLLM({
      system: NARRATOR_SYSTEM_PROMPT,
      userText,
      timeoutMs: NARRATOR_TIMEOUT_MS,
      fallbackTimeoutMs: NARRATOR_FALLBACK_TIMEOUT_MS,
      label: 'NarratorAgent LLM'
    });

    logger.info(`[NarratorAgent] Completato in ${Date.now() - start}ms`);
    return {
      message: result.message || 'Turn completato con successo.',
      sheetsCreated: result.sheetsCreated || [],
      sheetsModified: result.sheetsModified || summary.sheets,
      formulaCount: result.formulaCount ?? summary.totalFormulas,
      warnings: result.warnings || summary.warnings,
      suggestions: result.suggestions || [],
      raw: result
    };
  } catch (e) {
    logger.warn(`[NarratorAgent] Fallback dopo errore LLM: ${e.message}`);

    // Fallback deterministico senza LLM
    const fallbackMessage = summary.totalActions > 0
      ? `Ho completato ${summary.totalActions} azioni su ${summary.sheets.length} fogli (${summary.totalFormulas} formule).`
      : `Turn completato.`;

    return {
      message: fallbackMessage,
      sheetsCreated: [],
      sheetsModified: summary.sheets,
      formulaCount: summary.totalFormulas,
      warnings: summary.warnings,
      suggestions: [],
      raw: { _fallback: true }
    };
  }
}

module.exports = { runNarratorAgent, compileTurnSummary };
