# Contributing

Guida per sviluppatori che vogliono contribuire al progetto Excel AI Agent.

---

## Primo setup

```bash
git clone <repo-url>
cd excel
npm install
cp .env.example .env
# Edita .env con chiave API DeepSeek (o altro provider)
./start-dev.sh
```

Il server parte su `http://localhost:3000` e `https://localhost:3443`.

Per generare certificati SSL locali (necessari per Excel Desktop):

```bash
brew install mkcert   # macOS
mkcert -install
make certs
```

---

## Convenzioni codice

### JavaScript

Tutto il codice applicativo è **vanilla JavaScript** (no TypeScript, eccetto Remotion per i video).

```js
// Backend: CommonJS
const { logger } = require('./server/utils/logger');
module.exports = { doSomething };

// Frontend: ES modules bundlati
import { getState } from './store/state.js';
export function init() { ... }
```

### Naming

- `camelCase` per variabili e funzioni
- `PascalCase` per classi
- `kebab-case` per nomi file
- Costanti in `UPPER_SNAKE_CASE`

### Async

```js
// OK — async/await
async function loadData() {
  const data = await fetch(...);
  return process(data);
}

// NO — callback raw
function loadData(cb) {
  fetch(..., cb); // mai
}
```

### Logging (backend)

Usa il logger Pino centralizzato, mai `console.log`:

```js
const logger = require('./server/utils/logger');
logger.info({ turnId: '...' }, 'Messaggio');
logger.warn({ error: err.message }, 'Avviso');
logger.debug({ tool }, 'Dettaglio debug');
```

### Variabili d'ambiente

Tutti i parametri configurabili vanno via `process.env`. Aggiungi la variabile in `.env.example` con commento.

```js
const model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro'; // OK
const model = 'deepseek-v4-pro'; // NO — hardcoded
```

---

## Testing

### Struttura

```
test/unit/test_*.js     # 22 file, uno per modulo
test-backend.js         # Test integrazione backend
test-e2e-mock-client.js # Test E2E simulato
test-llm-fallback.js    # Test fallback LLM
```

### Eseguire i test

```bash
npm test          # Tutti i 22 test unitari
node test/unit/test_architect.js  # Test singolo
```

### Scrivere test

I test usano solo `assert` nativo di Node.js, nessun framework. Ogni file è auto-eseguibile:

```js
const assert = require('assert');

function testNamingExample() {
  const result = someModule.doSomething();
  assert.strictEqual(result, expected, 'Descrizione del test');
}

function testEdgeCase() {
  assert.throws(() => someModule.doSomething(null));
}

// Esegui i test
testNamingExample();
testEdgeCase();

console.log('All tests passed');
process.exit(0);
```

### Checklist per un nuovo test

1. Crea `test/unit/test_<nome>.js`
2. Usa il pattern: `require` in cima, funzioni di test, esecuzione a fine file
3. `process.exit(0)` a fine file, `process.exit(1)` su fallimento (via assert)
4. Aggiungi il file alla lista `npm test` in `package.json`

---

## Flusso di sviluppo

### 1. Branch

- `main` — produzione, protetto
- Feature branch: `feature/<descrizione>` o `fix/<descrizione>`

### 2. Modifiche al backend

1. Modifica il codice in `server/`
2. Verifica che il server parta: `npm run dev`
3. Testa con `curl` o il task pane di Excel
4. Esegui i test: `npm test`

### 3. Modifiche al frontend

1. Modifica il codice in `src/`
2. Rigenera il bundle: `npm run build`
3. Ricarica il task pane in Excel (tasto destro → Ricarica)
4. **Committa sempre il bundle** (`src/taskpane.bundle.js`) dopo le modifiche

### 4. Aggiungere una skill (knowledge domain)

Le skill sono definite in `skills/*.md` e caricate automaticamente:

1. Crea `skills/<nome-skill>.md`
2. Scrivi le istruzioni in formato Markdown (verranno incluse nel system prompt)
3. Nessun codice da modificare — il loader in `server/skills/loader.js` carica tutto automaticamente

### 5. Aggiungere un provider LLM

1. Aggiungi il provider in `server/tools/llm.js` (funzione `callLLM`)
2. Aggiungi le variabili d'ambiente in `.env.example`
3. Documenta in `README.md`

### 6. Aggiungere un'azione Excel

1. Definisci lo schema in `server/tools/schemas.js`
2. Registra il tool in `server/tools/registry.js`
3. Implementa l'esecuzione lato frontend in `src/excel/writers.js`
4. Aggiungi UI di conferma in `src/ui/approvalModal.js` se l'azione modifica il workbook

---

## Architettura

### Flusso di un turn

```
User Request
    │
    ▼
┌──────────┐
│  Triage  │  Classifica: tipo task, complessità, servono specialisti?
└────┬─────┘
     │
     ▼
┌────────────┐
│ Architect  │  Decompone in slice indipendenti + piano esecuzione
└────┬───────┘
     │
     ▼
┌───────────┐
│ Execution │  Ogni slice eseguita da uno specialista (parallelo/sequenziale)
└────┬──────┘
     │
     ▼
┌──────────┐
│  Critic  │  Valida l'output e le azioni Excel prima di applicarle
└────┬─────┘
     │
     ▼
┌───────────┐
│ Narrator  │  Spiega cosa è stato fatto → SSE stream → UI
└───────────┘
```

### Agenti principali

| Agente | File | Ruolo |
|--------|------|-------|
| Triage | `server/agents/triage.js` | Classifica la richiesta |
| Architect | `server/agents/architect.js` | Decompone in slice |
| Conductor | `server/agents/conductor.js` | Orchestra parallelo |
| Specialists | `server/agents/specialists.js` | Agenti specializzati per dominio |
| Critic | `server/agents/critic.js` | Validazione output |
| Agent Loop | `server/agents/agentLoop.js` | Loop reattivo con tool calling |

### Tool registry

`server/tools/registry.js` — tutti i tool esposti all'AI. Un tool ha:
- `name`, `description`, `parameters` (JSON Schema)
- `execute(args, context)` → promessa

### Safety

- `server/runtime/safetyLimits.js` — Limiti per turn (max azioni, iterazioni, stagnazione)
- `server/runtime/undo.js` — Undo stack
- `server/runtime/actionPreview.js` — Preview prima dell'esecuzione

---

## Build e bundle

```bash
npm run build             # src/main.js → src/taskpane.bundle.js (esbuild)
npm run check             # Test + build (pre-commit CI)
ADDIN_BASE_URL=https://app.example.com npm run manifest:prod  # Manifest produzione
```

Il bundle frontend (`src/taskpane.bundle.js`) è committato per consentire deploy senza build.

---

## Office.js — note importanti

- Tutte le API Office.js sono **asincrone**.
- Ogni batch di operazioni richiede `context.sync()`.
- Le operazioni di scrittura su Excel richiedono `Excel.run()`.
- La selezione corrente si ottiene da `context.workbook.getSelectedRange()`.

```js
await Excel.run(async (context) => {
  const sheet = context.workbook.worksheets.getActiveWorksheet();
  const range = sheet.getRange('A1');
  range.values = [['Hello']];
  range.format.fill.color = 'yellow';
  await context.sync();
});
```

---

## Domande?

- Apri una issue su GitHub
- Leggi `AGENTS.md` per le convenzioni da seguire con AI coding tools
- Leggi `docs/architecture/` per dettagli architetturali
