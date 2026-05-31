# AGENTS.md — AI Agent Instructions

Istruzioni per agenti AI (OpenCode, Claude Code, Cursor) che lavorano su questa codebase.

---

## Comandi essenziali

```bash
npm test              # Esegue tutti i 22 test unitari in sequenza
npm run build         # Bundla il frontend (src/main.js → src/taskpane.bundle.js)
npm run check         # Test + build (pre-commit)
npm run dev           # Server con nodemon hot-reload
npm run logs:llm      # Analizza i trace LLM salvati
```

Il progetto **non ha un linter** configurato. Non eseguire `npm run lint` — non esiste.

---

## Struttura

```
src/           Frontend — vanilla JS (Office.js task pane), bundlato con esbuild
server/        Backend — Node.js + Express, architettura multi-agente
  agents/      Agenti AI (architect, conductor, critic, planner, triage, streaming, ...)
  runtime/     Turn lifecycle (turns, undo, safety, action preview, prefetch, ...)
  tools/       Integrazioni esterne (LLM, web search, Yahoo Finance, OpenBB, browser)
  models/      Modelli dominio finance (DCF builder, format templates, workbook graph)
  utils/       Utility condivise (trace, logger, metrics, pricing, instructions, ...)
skills/        Skill definitions in Markdown (dcf, lbo, wacc, comps, ...)
docs/          Documentazione progetto
test/unit/     22 file di test unitari
api/           Vercel serverless entry point
bench/         Benchmark e confronto modelli
```

## Convenzioni codice

### JavaScript (tutta la codebase è JS, non TS)

- **No TypeScript**. Tutto il codice applicativo è vanilla JS. `tsconfig.json` esiste solo per Remotion (video).
- **No commenti** a meno che non siano essenziali. Il codice deve essere auto-documentante.
- **Moduli CommonJS** (`require`/`module.exports`) nel backend. Il frontend usa ES modules bundlati.
- **Naming**: camelCase per variabili/funzioni, PascalCase per classi, kebab-case per file.
- **Async**: `async/await` ovunque, mai callback raw. Promise.all per parallelismo.
- **Error handling**: try/catch con log via `logger` (Pino). Mai silent catch.
- **Env vars**: tutte le config via `process.env`, mai valori hardcodati. Template in `.env.example`.

### Backend (`server/`)

- **Express** con middleware body-parser, cors.
- **Logging**: Pino (`server/utils/logger.js`). Usa `logger.info/error/warn/debug`.
- **LLM calls**: passano tutte da `server/tools/llm.js` (`callLLM`). Mai chiamare API LLM direttamente.
- **Schema validation**: `server/tools/schemas.js` con AJV.
- **Turn lifecycle**: `server/runtime/turns.js` gestisce lo stato di ogni turn (creazione, approvazione, esecuzione, SSE streaming).
- **Skills**: lazy-load da `skills/*.md` via `server/skills/loader.js`.
- **Database**: SQLite via `server/db/init.js` + Supabase per produzione.

### Frontend (`src/`)

- **Office.js**: API asincrone con `context.sync()`. Pattern: `Excel.run(async (context) => { await context.sync(); })`.
- **UI components**: ogni file in `src/ui/` è uno o più componenti. No framework, vanilla DOM manipulation.
- **State management**: `src/store/state.js` (globale) + `src/store/turnMemory.js` (per-turn).
- **Bundle**: `src/main.js` è l'entry point, bundlato in `src/taskpane.bundle.js` via esbuild. Il bundle è committato.

## Pattern architetturali

### Agenti AI

```
User Request → Triage (classificazione) → Architect (piano a slice)
  → Esecuzione slice (parallela/sequenziale) → Critic (validazione)
  → Narrazione → Azioni Excel (SSE)
```

- **Triage** (`server/agents/triage.js`): Classifica la richiesta (tipo task, complessità, servono specialisti?)
- **Architect** (`server/agents/architect.js`, `architectStepwise.js`): Decompone in slice indipendenti
- **Conductor** (`server/agents/conductor.js`): Orchestra esecuzione parallela di più specialisti
- **Specialists** (`server/agents/specialists.js`): Agenti specializzati (finance, formatting, data)
- **Critic** (`server/agents/critic.js`): Valida l'output prima di applicarlo al workbook
- **Planner** (`server/agents/planner.js`): Legacy — genera piano sequenziale per task semplici
- **Agent Loop** (`server/agents/agentLoop.js`): Loop reattivo con tool calling

### Tool registry

Tutti i tool sono registrati in `server/tools/registry.js`. Un tool ha:
- `name`, `description`, `parameters` (JSON Schema)
- `execute(args, context)` — implementazione
- I tool sono esposti all'AI come function definitions

### Safety

- `server/runtime/safetyLimits.js`: Limiti per turn (max azioni, max iterazioni, rilevamento stagnazione)
- `server/runtime/undo.js`: Undo stack per revert modifiche
- `server/runtime/actionPreview.js`: Preview azioni prima dell'esecuzione

### Finance models

- `server/models/dcfAiBuilder.js`: Costruzione DCF assistita da AI
- `server/models/dcfTemplate.js`: Template DCF deterministico
- `server/models/financeModelCatalog.js`: Catalogo modelli disponibili
- `server/models/workbookGraph.js`: Rappresentazione grafo del workbook (dipendenze celle)

## Test

### Struttura

```
test/unit/test_*.js     # 22 file, uno per modulo
test-backend.js         # Test integrazione backend
test-e2e-mock-client.js # Test E2E con client mock
test-llm-fallback.js    # Test fallback LLM
```

### Convenzioni test

- **No framework**: test puri Node.js con `assert` nativo. Nessun jest/mocha.
- **Naming**: `test/unit/test_<modulo>.js`
- **Esecuzione**: ogni file è auto-eseguibile. `npm test` li esegue in sequenza.
- **Exit code**: 0 = success, 1 = failure. I test usano `process.exit(1)` su assertion fallita.
- **Mocking**: mock manuali inline, nessuna libreria di mocking.

### Aggiungere un test

1. Crea `test/unit/test_<nome>.js`
2. Segui il pattern: `require`, test functions, `process.exit(0)` a fine file
3. Aggiungi a `npm test` in `package.json`

## Modifiche comuni

### Aggiungere un'azione Excel

1. Definisci lo schema in `server/tools/schemas.js`
2. Registra il tool in `server/tools/registry.js`
3. Implementa lato frontend in `src/excel/writers.js`
4. Aggiungi la UI di conferma in `src/ui/approvalModal.js` se necessario

### Aggiungere un provider LLM

1. Aggiungi il provider in `server/tools/llm.js` (`callLLM`)
2. Aggiungi env vars in `.env.example`
3. Aggiungi documentazione in README.md

### Aggiungere una skill

1. Crea `skills/<nome-skill>.md` con istruzioni per l'AI
2. Verifica che venga caricato automaticamente da `server/skills/loader.js`

## Note importanti

- **`.env` non è committato**. Usa `.env.example` come riferimento. Non mettere mai API key nel codice.
- **Il frontend bundle è committato** (`src/taskpane.bundle.js`). Dopo modifiche al frontend, esegui `npm run build` e committa il bundle.
- **I file in `server/turns/`, `server/metrics/`, `data/`** sono gitignorati (runtime data).
- **I certificati SSL** (`certs/`, `ca.*`) sono gitignorati. Usa `make certs` per rigenerarli.
- **Office.js** API sono asincrone e richiedono `context.sync()` dopo ogni batch di operazioni.
