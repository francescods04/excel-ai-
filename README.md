# AI Agent for Excel

Un add-in per Microsoft Excel che permette di controllare il foglio di calcolo tramite linguaggio naturale, sfruttando modelli AI.

## Funzionalità

- **Controllo naturale**: Scrivi in italiano o inglese cosa vuoi fare su Excel
- **Formattazione intelligente**: Cambia colori, font, allineamenti delle celle
- **Formule e calcoli**: Inserisci somme, medie, forecast e formule complesse
- **Inserimento dati**: Riempi range con dati strutturati
- **Grafici**: Crea chart direttamente dai comandi AI
- **Contesto aware**: L'AI sa qual è il foglio attivo e il range selezionato

## Architettura

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│   Excel      │◄────►│  Task Pane   │◄────►│   Backend    │
│  (Desktop/   │      │  (Office.js) │      │   (Node.js)  │
│   Online)    │      │              │      │              │
└──────────────┘      └──────────────┘      └──────┬───────┘
                                                    │
              ┌─────────────────────────────────────┘
              │
    ┌─────────▼──────────┐     ┌──────────▼─────────┐
    │   OpenCode Server  │     │   OpenRouter API   │
    │   (locale)         │     │   (online)         │
    │   opencode-go      │     │   kimi-k2.6        │
    └────────────────────┘     └────────────────────┘
```

### Runtime agentico

La codebase supporta due runtime:

- **Legacy job runtime**: `planner -> executor -> SSE`, mantenuto per retrocompatibilità.
- **Nuovo turn/item runtime**: ispirato a Codex, con turn espliciti, item streammati e approvazione del piano prima dell'esecuzione.

Nel nuovo flusso agentico:

1. La UI apre un turn con `POST /api/turn/start`
2. Il backend genera un `plan` item
3. L'utente approva il piano
4. Durante l'esecuzione il runtime puo' chiedere:
   - letture strutturate del workbook (`workbook.readWorkbook`, `workbook.readSheet`, `workbook.readRange`)
   - input utente (`requestUserInput`)
   - conferme/preview prima delle scritture Excel
5. Il backend esegue i `taskExecution` item e streamma lo stato via SSE

Endpoint principali:

```bash
POST /api/turn/start
POST /api/turn/approve
POST /api/turn/respond
GET  /api/turn/stream/:turnId
GET  /api/turn/:turnId
```

## Prerequisiti

- Node.js 18+
- Microsoft Excel (Desktop 2016+ o Excel Online)
- **Per OpenCode**: `opencode` CLI installato e configurato
- **Per OpenRouter**: API key da [openrouter.ai](https://openrouter.ai/keys) (alternativa online)

## Installazione

1. **Clona o scarica il progetto** nella cartella corrente.

2. **Installa le dipendenze**:
   ```bash
   npm install
   ```

3. **Configura l'AI** scegliendo un provider (vedi sezione [Configurazione AI](#configurazione-ai)).

4. **Avvia tutto con uno script** (raccomandato):
   ```bash
   ./start-dev.sh
   ```
   Questo script:
   - Verifica le dipendenze (Node.js, opencode CLI)
   - Avvia automaticamente `opencode serve` (se necessario)
   - Avvia il server Node.js con HTTPS
   - Apre Microsoft Excel
   - Mostra le istruzioni per caricare il manifest

   Per fermare tutto:
   ```bash
   ./stop-dev.sh
   ```

   Oppure avvia manualmente:
   ```bash
   npm run dev
   ```
   Il server girerà su `http://localhost:3000` e `https://localhost:3443`.

5. **Installa l'add-in in Excel**:
   - Apri Excel
   - Vai su **Inserisci** > **Componenti aggiuntivi** > **Carica componente aggiuntivo personalizzato**
   - Seleziona il file `manifest.xml` dalla cartella del progetto
   - Se usi Excel Online, carica il manifest tramite il tool [Office Add-ins sideload](https://docs.microsoft.com/en-us/office/dev/add-ins/testing/sideload-office-add-ins-for-testing)

## Uso

1. Apri il pannello laterale cliccando su **AI Agent** nella barra Home.
2. Scrivi un comando nella chat, ad esempio:
   - *"Colora di rosso le celle con valori negativi"*
   - *"Fai la somma della colonna A"*
   - *"Crea un forecast per i prossimi 3 mesi basato sui dati in B1:B12"*
   - *"Formatta il range A1:D10 come tabella con bordi e intestazioni in grassetto"*
3. L'agente genera un piano, chiede conferma per le modifiche al workbook e poi applica le azioni approvate.

## Configurazione AI

Il backend supporta **tre provider AI**. Copia `.env.example` in `.env` e scegli una configurazione:

### Opzione 1 — OpenCode Go (raccomandata per sviluppo locale)

Usa il server locale di OpenCode con il modello `kimi-k2.6`.

```env
AI_PROVIDER=opencode
OPENCODE_SERVER_URL=http://127.0.0.1:4096
OPENCODE_PROVIDER=opencode-go
OPENCODE_MODEL=kimi-k2.6
```

**Requisiti aggiuntivi**:
- Assicurati che `opencode` CLI sia installato: `which opencode`
- Configura la tua key OpenCode Go in `~/.local/share/opencode/auth.json`:
  ```json
  {
    "opencode-go": {
      "type": "api",
      "key": "sk-..."
    }
  }
  ```
- Avvia il server OpenCode in background: `opencode serve --port 4096`

**Pro**: nessun costo aggiuntivo se hai già OpenCode Go
**Contro**: più lento (~1-2 min per risposta con kimi-k2.6)

### Opzione 2 — OpenRouter (raccomandata per velocità)

Usa l'API online di OpenRouter con il modello `moonshotai/kimi-k2.6`.

```env
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=moonshotai/kimi-k2.6
OPENROUTER_FALLBACK_MODEL=openai/gpt-4o-mini
LLM_TIMEOUT_MS=90000
LLM_FALLBACK_TIMEOUT_MS=45000
PLANNER_TIMEOUT_MS=150000
PLANNER_FALLBACK_TIMEOUT_MS=60000
```

**Pro**: molto più veloce (~10-15s), nessun server locale da gestire
**Contro**: costo per token utilizzato (vedi tariffe OpenRouter)

### Opzione 3 — OpenAI-compatible generico

Usa qualsiasi provider compatibile con l'API OpenAI (Together AI, Fireworks, Azure, ecc.).

```env
AI_PROVIDER=openai
AI_API_URL=https://api.openai.com/v1/chat/completions
AI_API_KEY=sk-...
AI_MODEL=gpt-4o
```

### Opzione 4 — Xiaomi MiMo Direct (token subscription)

Usa l'API diretta Xiaomi MiMo con token di abbonamento (crediti inclusi). OpenAI-compatibile nativamente.

```env
AI_PROVIDER=xiaomi
XIAOMI_API_URL=https://token-plan-ams.xiaomimimo.com/v1/chat/completions
XIAOMI_API_KEY=tp-...
XIAOMI_MODEL=mimo-v2.5-pro
XIAOMI_FALLBACK_MODEL=deepseek/deepseek-v4-flash
```

**Pro**: crediti gratis con abbonamento, API diretta (senza passare da OpenRouter), supporta streaming e JSON mode
**Contro**: solo modelli Xiaomi MiMo disponibili

### Opzione 5 — DeepSeek API diretta (raccomandata per reasoning + context caching)

Usa l'API nativa DeepSeek con il modello `deepseek-v4-pro`. Supporta **Context Caching automatico su disco**, **reasoning avanzato** (`thinking`) e **streaming**.

```env
AI_PROVIDER=deepseek
DEEPSEEK_API_URL=https://api.deepseek.com/chat/completions
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-v4-pro
DEEPSEEK_FALLBACK_MODEL=deepseek-chat
DEEPSEEK_REASONING_EFFORT=high
DEEPSEEK_THINKING_ENABLED=true
```

**Pro**: Context Caching automatico riduce costi e latenza su conversazioni ripetute; reasoning nativo migliora la qualità dei piani DCF/WACC; API diretta senza intermediari.
**Contro**: necessita chiave API DeepSeek separata.

#### Ottimizzare il Context Caching DeepSeek

DeepSeek costruisce automaticamente una cache su disco quando rileva prefissi di messaggi ripetuti. Per massimizzare i *cache hit*:

1. **Mantieni stabile il system prompt**: non inserire timestamp, ID casuali o testo variabile nel system prompt del planner o degli specialisti.
2. **Appendi messaggi nelle conversazioni multi-turn**: quando passi la history a `callLLM`, aggiungi i nuovi messaggi in coda invece di ricostruire l'array da zero.
3. **Riusa il contesto del workbook**: se leggi lo stesso foglio in turn successivi, includi i dati nello stesso formato per sfruttare il prefisso comune.
4. **Monitora la cache**: nei log del server cerca `cache_pct=XX%` per ogni risposta DeepSeek. Valori alti (>50%) indicano prefissi ben riutilizzati.

### Modalità demo

Se non configuri nessuna API key e lasci `AI_PROVIDER=openai` senza key, l'add-in funziona in **modalità demo** con risposte predefinite per testare l'interfaccia.

## Azioni supportate

L'AI può generare questi tipi di azioni:

| Azione | Descrizione |
|--------|-------------|
| `setCellValue` | Imposta un valore in una cella o range |
| `runFormula` | Inserisce una formula Excel |
| `setCellFormat` | Cambia formattazione (colori, font, numeri) |
| `fillRange` | Riempie un range con dati (array 2D) |
| `writeRange` | Scrive valori o formule in un range specifico |
| `createChart` | Crea un grafico dai dati selezionati |
| `getSelectedRange` | Richiede informazioni sul range selezionato |

## Sviluppo

- **Frontend attivo**: `src/taskpane.html`, `src/main.js`, moduli in `src/ui`, `src/excel`, `src/api`
- **Backend**: `server/server.js`
- **Runtime agentico nuovo**: `server/runtime/turns.js`
- **Manifest**: `manifest.xml`

### Script disponibili

```bash
npm run dev     # Avvia server con nodemon (hot reload)
npm start       # Avvia server in produzione
npm run build   # Rigenera src/taskpane.bundle.js da src/main.js
npm test        # Esegue i test unitari principali
npm run check   # Test + build frontend
npm run serve   # Alias di npm start: avvia il backend completo
npm run serve:static  # Solo file statici; non usare per l'add-in agentico
```

### Manifest production

`manifest.xml` resta configurato per sviluppo locale. Per generare un manifest HTTPS pronto per validazione/deploy:

```bash
ADDIN_BASE_URL=https://app.example.com npm run manifest:prod
ADDIN_BASE_URL=https://app.example.com npm run validate:manifest:prod
```

Il file generato finisce in `dist/manifest.xml` e sostituisce gli URL `localhost` con l'origine pubblica indicata.

## Troubleshooting

- Se il task pane si apre ma compare `Cannot POST /api/turn/start` oppure il messaggio `Errore avvio turn`, molto probabilmente `localhost:3000` e' occupato da un server statico o non aggiornato.
- In quel caso esegui `./stop-dev.sh` e poi `./start-dev.sh`.
- Il backend corretto espone `GET /api/health` e `POST /api/turn/start`.

## Note su Excel Online

Se usi Excel Online, assicurati che il server sia raggiungibile pubblicamente o usa `ngrok` per esporre localhost:

```bash
npx ngrok http 3000
```

Poi aggiorna gli URL in `manifest.xml` con l'URL di ngrok.

## Licenza

MIT
