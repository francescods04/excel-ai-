# Excel AI Agent

Add-in per Microsoft Excel che permette di controllare il foglio di calcolo tramite linguaggio naturale (italiano o inglese), con AI multi-agente specializzata in modellistica finanziaria (DCF, LBO, WACC, Comps, Business Plan).

---

## Indice

- [Panoramica](#panoramica)
- [Prerequisiti](#prerequisiti)
- [Installazione rapida](#installazione-rapida)
- [Configurazione AI](#configurazione-ai)
- [Utilizzo](#utilizzo)
- [Struttura del progetto](#struttura-del-progetto)
- [Sviluppo](#sviluppo)
- [Testing](#testing)
- [Deploy](#deploy)
- [Documentazione](#documentazione)
- [Troubleshooting](#troubleshooting)

---

## Panoramica

L'add-in si installa nella barra multifunzione di Excel e apre un task panel laterale con interfaccia chat. L'utente scrive cosa vuole fare; l'AI:

1. Analizza il foglio attivo e il contesto (contenuto celle, range selezionato, formule)
2. Genera un piano di azioni (modello finanziario, formattazione, formule)
3. Chiede conferma prima di scrivere sul workbook
4. Esegue le azioni approvate e mostra i risultati

### Architettura (alto livello)

```
Excel (Desktop/Online)  ←→  Task Pane (Office.js)  ←→  Backend Node.js (Express)
                                                           │
                              ┌─────────────────────────────┤
                              ▼                             ▼
                      LLM API (DeepSeek, OpenRouter,    Python Bridge (OpenBB,
                      Xiaomi, OpenAI-compatibile)       BrowserUse, Yahoo Finance)
```

### Cosa sa fare

| Categoria | Esempi |
|-----------|--------|
| **Modelli finanziari** | DCF, LBO, WACC, Comps, 3-Statement, Business Plan |
| **Formattazione** | Colori, font, bordi, allineamenti, number format, conditional formatting |
| **Formule** | SOMMA, MEDIA, CERCA.VERT, forecast, array formulas |
| **Dati** | Riempimento range, import dati strutturati, pulizia dati |
| **Grafici** | Chart da comando AI, aggiornamento dinamico |
| **Analisi** | Sensitivity tables, scenario analysis, auditing formule |

### Runtime agentici

Il backend supporta due modalità operative:

- **Architect + Agent Loop** (default) — Un "architect" decompone la richiesta in slice, ogni slice viene eseguita da uno specialista. Supporta esecuzione parallela e stepwise.
- **Legacy Planner → Executor** — Flusso sequenziale planner/executor, mantenuto per retrocompatibilità.

---

## Prerequisiti

- **Node.js** ≥ 18.17
- **Microsoft Excel** Desktop 2016+ o Excel Online
- **Chiave API LLM** (DeepSeek raccomandato) — vedi [Configurazione AI](#configurazione-ai)
- (Opzionale) **OpenBB** Python environment per dati finanziari avanzati

---

## Installazione rapida

```bash
# 1. Clona il progetto
git clone <repo-url> && cd excel

# 2. Installa dipendenze
npm install

# 3. Configura l'AI
cp .env.example .env
# Edita .env con le tue API key (vedi sezione successiva)

# 4. Avvia ambiente di sviluppo
./start-dev.sh
```

Lo script `start-dev.sh` avvia automaticamente: server Node.js con HTTPS, Excel, e tutti i servizi necessari.

Per fermare tutto: `./stop-dev.sh`

### Avvio manuale

```bash
npm run dev          # Server con hot-reload (nodemon)
npm start            # Server in produzione
npm run build        # Rigenera il bundle frontend (src/taskpane.bundle.js)
```

### Caricare l'add-in in Excel

1. Apri Excel → **Inserisci** → **Componenti aggiuntivi** → **Carica componente aggiuntivo personalizzato**
2. Seleziona `manifest.xml` dalla root del progetto
3. Per Excel Online: usa lo [sideload](https://docs.microsoft.com/en-us/office/dev/add-ins/testing/sideload-office-add-ins-for-testing) o esponi il server con ngrok

---

## Configurazione AI

Il backend supporta 5 provider LLM. Copia `.env.example` in `.env` e scegli:

### Provider raccomandati

| Provider | Vantaggi | Svantaggi |
|----------|----------|-----------|
| **DeepSeek** (v4-pro) | Context caching automatico, reasoning nativo, API diretta | Serve API key separata |
| **OpenRouter** | Velocissimo (10-15s), accesso a molti modelli | Costo per token |
| **OpenCode Go** (locale) | Nessun costo API se hai già abbonamento | Più lento (1-2 min) |

### Provider opzionali

| Provider | Configurazione |
|----------|---------------|
| **Xiaomi MiMo** | Token subscription con crediti inclusi, API OpenAI-compatibile |
| **OpenAI-compatibile** | Qualsiasi endpoint `/v1/chat/completions` (Together AI, Azure, etc.) |

Per i dettagli di configurazione di ogni provider, vedi `.env.example`.

### Tuning performance

Per rendere il loop agentico più veloce:

```env
AGENT_LOOP_MODEL=deepseek-v4-flash      # Modello più veloce per il loop
AGENT_THINKING_EVERY_ITER=false         # Disabilita reasoning su ogni iterazione
AGENT_THINKING_INTERVAL=6               # Riabilita reasoning ogni N iterazioni
AGENT_FORCE_THINKING_AFTER_ERROR=true   # Forza reasoning dopo errori
ARCHITECT_THINKING_ENABLED=true         # Reasoning attivo solo per architect
```

---

## Utilizzo

1. Apri il task panel cliccando su **AI Agent** nella barra Home di Excel
2. Scrivi un comando nella chat:

```
"Crea un DCF a 5 anni per AAPL con WACC 9% e terminal growth 2.5%"
"Colora di rosso tutte le celle con valori negativi nella colonna F"
"Fai un'analisi di sensitività sul DCF variando WACC tra 8% e 12%"
"Formatta il range A1:D20 come tabella professionale con header in grassetto"
```

3. L'AI genera un piano → confermi le modifiche → esecuzione con feedback live

### Flusso di un turn

```
User message  →  Triage (classificazione)  →  Architect (piano a slice)
  →  Esecuzione slice (parallela o sequenziale)  →  Critic (validazione)
  →  Azioni Excel (via SSE)  →  Narrazione risultati
```

Endpoint API principali:

```
POST /api/turn/start       Inizia un turn
POST /api/turn/approve     Approva il piano
POST /api/turn/respond     Rispondi a richiesta input
GET  /api/turn/stream/:id   SSE stream stato turn
GET  /api/turn/:id          Stato turn corrente
GET  /api/health            Health check (tool count, provider)
```

---

## Struttura del progetto

```
excel/
├── src/                    # Frontend — Office.js task pane
│   ├── main.js             # Entry point (bundlato via esbuild)
│   ├── taskpane.{html,css,js}  # Task pane UI
│   ├── api/                # Client API (agent, config, turn)
│   ├── excel/              # Interazione con Excel (context, readers, writers, sheetOps)
│   ├── ui/                 # Componenti UI (chat, approval, code panel, steps, tabs)
│   ├── store/              # Stato client (state, turnMemory)
│   └── auth/               # Autenticazione
│
├── server/                 # Backend — Node.js + Express
│   ├── server.js           # Entry point server
│   ├── agents/             # Agenti AI (architect, conductor, critic, planner, triage, ...)
│   ├── runtime/            # Runtime turn-based (turns, undo, safety, prefetch, ...)
│   ├── tools/              # Integrazioni esterne (LLM, web, yahoo, openbb, browser, ...)
│   ├── models/             # Modelli finanziari (DCF, LBO, format templates, workbook graph)
│   ├── utils/              # Utility (trace, logger, metrics, pricing, instructions, ...)
│   ├── wiki/               # Caricamento knowledge base
│   ├── skills/             # Loader delle skill definitions
│   └── supabase/           # Client Supabase per auth/database
│
├── skills/                 # Skill definitions in Markdown (dcf, lbo, wacc, comps, ...)
├── docs/                   # Documentazione
│   ├── architecture/       # Architettura multi-agente, SaaS roadmap
│   └── wiki/               # Knowledge base (accounting, excel, finance)
├── test/                   # Test (unitari in test/unit/, E2E in root)
├── api/                    # Vercel serverless entry point
├── bench/                  # Benchmark e confronto modelli
├── supabase/               # Migrazioni SQL
├── public/                 # Landing page, video, installer
└── scripts/                # Script utility (build manifest, analisi trace)
```

Vedi [`docs/PROJECT_STRUCTURE.md`](docs/PROJECT_STRUCTURE.md) per una mappa dettagliata.

---

## Sviluppo

### Script npm

```bash
npm run dev              # Server con nodemon (hot reload)
npm start                # Server in produzione
npm run build            # Rigenera src/taskpane.bundle.js
npm test                 # Esegue tutti i test unitari (22 file)
npm run check            # Test + build frontend
npm run logs:llm         # Analizza trace LLM
npm run manifest:prod    # Genera manifest per produzione
npm run validate:manifest:prod  # Valida il manifest di produzione
```

### Build frontend

Il frontend è scritto in vanilla JS (ES modules) e bundlato con **esbuild**:

```bash
npm run build            # src/main.js → src/taskpane.bundle.js
```

Il bundle è committato in git per consentire il deploy senza step di build.

### Manifest

`manifest.xml` è configurato per sviluppo locale (`localhost`). Per produzione:

```bash
ADDIN_BASE_URL=https://app.example.com npm run manifest:prod
# Output: dist/manifest.xml
```

### Trace LLM

Il backend salva trace strutturati delle chiamate LLM in `data/llm-traces/YYYY-MM-DD.jsonl`. Config:

```env
LLM_TRACE_ENABLED=true
LLM_TRACE_CAPTURE_CONTENT=true
LLM_TRACE_DIR=data/llm-traces
```

### Benchmark modelli

```bash
npm run bench:modes -- 1 dcf_institutional planned_dag,agent_loop
npm run bench:cost
npm run bench:cost:report
```

---

## Testing

```bash
npm test          # Esegue tutti i 22 test unitari in sequenza
npm run check     # Test + build frontend (CI pre-commit)
```

I test coprono:
- Agenti (architect, triage, stepwise, parallel orchestrator)
- Runtime (safety, undo, turns, action preview, client read cache)
- Modelli (DCF backend, workbook graph, finance bundle)
- Strumenti (LLM trace, execute RPC, tool result cap, parallel calls)
- Infrastruttura (preflight, schema drift, production manifest)

Vedi [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) per le convenzioni di test.

---

## Deploy

### Vercel (serverless)

Il progetto include `vercel.json` e l'entry point `api/index.js` per deploy serverless.

```bash
vercel deploy --prod
```

### VPS (tradizionale)

```bash
make deploy     # rsync + pm2 restart
```

### Excel Online

Se usi Excel Online, il server deve essere raggiungibile pubblicamente:

```bash
npx ngrok http 3000
# Aggiorna manifest.xml con l'URL ngrok
```

---

## Documentazione

| Documento | Descrizione |
|-----------|-------------|
| [`CONTRIBUTING.md`](docs/CONTRIBUTING.md) | Guida per contribuire al progetto |
| [`PROJECT_STRUCTURE.md`](docs/PROJECT_STRUCTURE.md) | Mappa dettagliata della codebase |
| [`architecture/multi-agent-conductor.md`](docs/architecture/multi-agent-conductor.md) | Architettura multi-agente |
| [`architecture/saas-roadmap.md`](docs/architecture/saas-roadmap.md) | Roadmap SaaS |
| [`deepseek-context-caching.md`](docs/deepseek-context-caching.md) | Ottimizzazione context caching DeepSeek |
| [`wiki/`](docs/wiki/) | Knowledge base (contabilità, Excel, finanza) |
| [`AGENTS.md`](AGENTS.md) | Istruzioni per AI agents (Claude, OpenCode) |

---

## Troubleshooting

| Problema | Soluzione |
|----------|-----------|
| `Cannot POST /api/turn/start` | Server statico in esecuzione su porta 3000. Esegui `./stop-dev.sh && ./start-dev.sh` |
| Task pane vuoto / errore caricamento | Verifica che il server sia in ascolto su HTTPS (`https://localhost:3443`) |
| L'add-in non compare in Excel | Carica manualmente `manifest.xml` da Inserisci → Componenti aggiuntivi |
| Certificati SSL non validi | Esegui `make certs` (richiede `mkcert`) per rigenerare i certificati locali |
| Errore API key LLM | Verifica `.env` — il server logga il provider attivo all'avvio |
| Timeout chiamate AI | Aumenta `LLM_TIMEOUT_MS` in `.env` o verifica la connessione al provider |

---

## Licenza

MIT
