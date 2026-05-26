# 🏗️ PIANO PRODOTTO — Excel AI Agent (versione demo → SaaS)

> **Principio guida**: Infrastruttura a costo zero. Unico processo. Unico server. Nessun servizio esterno pagato oltre al dominio e alle API LLM. Tutto gira dentro Node.js con SQLite.

---

## 📋 SOMMARIO ESECUTIVO

Il prototipo attuale richiede **24+ passaggi manuali**, 5 provider LLM, 60+ variabili d'ambiente, solo macOS. L'obiettivo è un backend cloud con **unico processo Node.js**, login utenti, telemetria su SQLite, e add-in installabile senza passaggi tecnici per l'utente.

### Architettura target (demo): TUTTO in un processo

```
┌──────────────────────────────────────────────────┐
│               UTENTE FINALE                       │
│  Excel (Win/Mac)  ←  Add-in sideload (1 click)   │
└──────────────────────┬───────────────────────────┘
                       │ HTTPS
┌──────────────────────▼───────────────────────────┐
│           SINGOLO PROCESSO NODE.JS                │
│           (VPS €5/mese Hetzner)                   │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐  │
│  │ Auth API │  │ LLM API  │  │ Excel Proxy    │  │
│  │ (JWT)    │  │ (proxy)  │  │ (SSE + Azioni) │  │
│  └────┬─────┘  └────┬─────┘  └───────┬────────┘  │
│       │              │                │           │
│  ┌────▼──────────────▼────────────────▼───────┐   │
│  │              SQLite (WAL mode)              │   │
│  │  • users, sessions, turns, actions          │   │
│  │  • events (telemetry), settings             │   │
│  │  • in-memory LRU cache per LLM              │   │
│  └─────────────────────────────────────────────┘   │
│                                                   │
│  ┌──────────────────────────────────────────┐     │
│  │  /admin  — dashboard interna              │     │
│  │  • utenti, utilizzo, costi, errori        │     │
│  │  • tutto da SQLite, zero tool esterni     │     │
│  └──────────────────────────────────────────┘     │
└───────────────────────────────────────────────────┘
```

### Stack tecnologico

| Componente | Demo (ora) | Produzione (dopo) |
|---|---|---|
| **Database** | SQLite via `better-sqlite3` | SQLite (basta per <10k utenti) |
| **Cache** | LRU in-memory (lru-cache) | LRU in-memory |
| **Queue** | In-memory array | SQLite-backed queue |
| **Telemetria** | Tabella `events` in SQLite | SQLite (basta per demo) |
| **Dashboard** | Pagina `/admin` HTML statico + API JSON | Stessa, migliorata |
| **Auth** | JWT con chiave simmetrica (HS256) | JWT (HS256 va bene) |
| **LLM** | OpenRouter (unico provider) | OpenRouter |
| **Deploy** | PM2 su VPS €5/mese (Hetzner CAX11) | Stesso + load balancer se serve |
| **SSL** | Caddy reverse proxy (auto Let's Encrypt) | Caddy |
| **Billing** | Nessuno (demo) | Stripe |
| **Frontend add-in** | Vanilla JS (task pane Office) | React + Vite |
| **Logging** | Pino → stdout → journald | Pino |

### Costi mensili (demo)

| Voce | Costo |
|------|-------|
| VPS Hetzner CAX11 (2 vCPU ARM, 4GB RAM) | **€4.51** |
| Dominio `.app` o `.com` (es. Namecheap) | **~€1/mese** |
| LLM API (OpenRouter, a consumo) | **~€50-200** (dipende dall'uso) |
| **TOTALE fisso** | **~€5.50/mese** |
| **TOTALE con LLM** | **~€55-205/mese** |

Nessun altro costo. Zero database managed, zero Redis, zero ClickHouse, zero Sentry, zero Grafana.

---

## 🗺️ ROADMAP — 5 FASI

---

## FASE 0: PULIZIA E FONDAZIONI (Settimana 1–2)

> **Obiettivo**: Togliere il superfluo, rendere il codice deployabile ovunque.

### 0.1 — Rimozione dipendenze inutili e dead code
```bash
# Rimuovere da package.json:
npm uninstall playwright        # 400MB, mai usato
npm uninstall pdf-parse         # non essenziale per demo
```
- **Rimuovere codice morto**:
  - Tutti i provider LLM tranne OpenRouter: eliminare `callDeepSeekAI()`, `callXiaomiAI()`, `callOpenCodeAI()`, `callOpenAICompat()`
  - `dynamicConfig` runtime switching (mai usato dagli utenti reali)
  - `AGENT_PROMPT_VARIANT`, `AGENT_THINKING_EVERY_ITER` e flag inutilizzati
  - Ruoli LLM: ridurre da 9 a 4 (planner, builder, critic, narrator)
  - File accumulati in `server/turns/`, `server/metrics/` (git clean)
  - `open-excel.scpt`, `start-dev.sh`, `stop-dev.sh` (sostituiti da Makefile)
  - `scripts/build-production-manifest.js` (manifest sarà generato dinamicamente)
  - `python_bridge/`, `server/tools/openbb.js`, `server/tools/python.js` (non servono per demo)
  - `server/wiki/` (PDF ingestion, non serve per demo)
  - `.venv-openbb/`
  - `ca.crt`, `ca.key`, `ca.srl`, `certs/` (rigenerati on-demand con mkcert)

### 0.2 — Sostituire file-system storage con SQLite
- **Installare `better-sqlite3`**: sincrono, performante, zero dipendenze esterne
- **Schema iniziale** (`server/db/schema.sql`):
  ```sql
  -- Utenti e auth
  CREATE TABLE users (
    id TEXT PRIMARY KEY,              -- UUID
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,      -- bcrypt
    name TEXT,
    plan TEXT DEFAULT 'free',         -- 'free' | 'pro'
    daily_quota INTEGER DEFAULT 10,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,              -- UUID
    user_id TEXT NOT NULL REFERENCES users(id),
    refresh_token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Turn e azioni
  CREATE TABLE turns (
    id TEXT PRIMARY KEY,              -- UUID
    user_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL,             -- 'planning'|'awaiting_approval'|'executing'|'completed'|'failed'
    input_message TEXT,               -- solo metadati (lunghezza, lingua), non il testo completo
    plan_json TEXT,                   -- JSON del piano
    task_count INTEGER,
    action_count INTEGER,
    error_type TEXT,
    error_message TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    total_latency_ms INTEGER
  );

  CREATE TABLE actions (
    id TEXT PRIMARY KEY,
    turn_id TEXT NOT NULL REFERENCES turns(id),
    task_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    params_json TEXT,
    result_json TEXT,
    success INTEGER DEFAULT 0,
    latency_ms INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE user_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    settings_json TEXT DEFAULT '{}',
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- Telemetria (tutto in una tabella)
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT DEFAULT (datetime('now')),  -- ISO 8601
    user_id TEXT,
    session_id TEXT,
    event_type TEXT NOT NULL,
    properties TEXT,                    -- JSON
    latency_ms INTEGER,
    tokens_in INTEGER,
    tokens_out INTEGER,
    model TEXT,
    success INTEGER
  );

  CREATE INDEX idx_events_ts ON events(ts);
  CREATE INDEX idx_events_type ON events(event_type);
  CREATE INDEX idx_events_user ON events(user_id);
  CREATE INDEX idx_turns_user ON turns(user_id);
  CREATE INDEX idx_turns_status ON turns(status);

  -- WAL mode per concorrenza
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  ```
- **Sostituire**:
  - `server/turns/turn-*.json` → tabella `turns`
  - `server/memory/default.json` → query su `turns` per userId
  - `server/metrics/YYYY-MM-DD.jsonl` → tabella `events`
  - `server/utils/logger.js` → Pino
  - In-memory `activeTurns` Map → resta in memoria (per caldo), ma persiste su SQLite

### 0.3 — Configurazione semplificata
- **Ridurre `.env` a 6 variabili**:
  ```bash
  PORT=3000
  PUBLIC_URL=https://excelai.example.com    # dominio pubblico
  JWT_SECRET=xxx                             # generato automaticamente se assente
  OPENROUTER_API_KEY=sk-or-v1-xxx
  OPENROUTER_MODEL=deepseek/deepseek-v4-pro
  OPENROUTER_FALLBACK_MODEL=qwen/qwen3-coder
  ```
  Fine. Stop. Non serve altro.
- Tutti i timeout, budget, flag → default sensati nel codice, non configurabili (per demo)
- `server/tools/llm.js` → rifattorizzato: solo `callOpenRouterAI()`, niente provider switching

### 0.4 — Makefile universale
```makefile
.PHONY: dev certs build start clean db-reset

dev:
	node --watch server/server.js

certs:
	mkcert -install
	mkcert -cert-file certs/cert.pem -key-file certs/key.pem localhost 127.0.0.1

build:
	node build.js

start:
	node server/server.js

clean:
	rm -rf dist node_modules certs

db-reset:
	rm -f data/app.db
	node -e "require('./server/db/init')()"
```

### 0.5 — Deploy su VPS (15 minuti)
1. Comprare VPS Hetzner CAX11 (€4.51/mese)
2. Installare Node.js 22: `curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs`
3. Installare Caddy: `apt install -y caddy`
4. Puntare DNS del dominio all'IP del VPS
5. Caddyfile (auto HTTPS via Let's Encrypt):
   ```
   excelai.example.com {
     reverse_proxy localhost:3000
   }
   ```
6. Clonare repo: `git clone ... && cd excel && npm ci --production`
7. Avviare: `pm2 start server/server.js --name excelai`
8. Fatto. Zero Docker, zero Kubernetes, zero PostgreSQL, zero Redis.

---

## FASE 1: AUTENTICAZIONE UTENTI (Settimana 3–4)

> **Obiettivo**: Login/registrazione funzionante, multi-utenza su SQLite.

### 1.1 — Backend auth
```
POST /api/auth/register    { email, password, name } → { accessToken, refreshToken }
POST /api/auth/login        { email, password } → { accessToken, refreshToken }
POST /api/auth/refresh      { refreshToken } → { accessToken }
POST /api/auth/logout       { refreshToken }
GET  /api/auth/me           → { user }  (da JWT)
```
- **JWT HS256**: chiave simmetrica da `JWT_SECRET` env var (generata automaticamente al primo avvio se mancante)
- **Access token**: 15 minuti, `{ userId, email, plan iat, exp }`
- **Refresh token**: 30 giorni, salvato come hash in `sessions`
- **bcrypt**: cost factor 10 (bilanciato per VPS piccola)
- **Rate limiting in-memory**: max 10 tentativi login per IP in 15 minuti (semplice Map con TTL, nessun Redis)
- **Middlewares**:
  - `authenticate` → verifica JWT su tutte le route tranne `auth/*`, `health`, `manifest`
  - `requirePlan(plan)` → per feature gated
  - `quotaCheck` → conta turn giornalieri dell'utente da SQLite

### 1.2 — UI di login nel task pane
- Prima schermata: card centrale con:
  - Tab "Accedi" / "Registrati"
  - Form email + password
  - "Accedi con Microsoft" (OAuth — opzionale, differibile)
- Post-login: JWT salvato in `localStorage`, header `Authorization: Bearer <token>` su ogni richiesta
- Auto-refresh: se 401, tenta refresh token, se fallisce → logout → login screen
- Logout: cancella `localStorage`, reindirizza a login

### 1.3 — Multi-tenancy
- Ogni query filtrata per `user_id`
- Ogni tabella ha colonna `user_id`
- Turn, azioni, impostazioni, eventi → tutti isolati per utente
- Admin (`plan = 'admin'`) vede tutto

### 1.4 — Quota giornaliera (senza Stripe per demo)
- Tabella `users.daily_quota` (default 10 per free, 100 per pro)
- Contatore resettato a mezzanotte UTC
- Upgrade manuale via admin panel o variabile d'ambiente `PRO_SEEDS=email1,email2`
- Nessun pagamento per ora → inserire utenti pro manualmente

---

## FASE 2: API LLM UNIFICATA (Settimana 5–6)

> **Obiettivo**: Un solo provider, routing intelligente, caching, zero configurazione utente.

### 2.1 — LLM Gateway semplificato
- **Unico client**: `callOpenRouter()` già esistente, già il più sofisticato
- **Rimozione totale** di: DeepSeek nativo, Xiaomi nativo, OpenCode locale, OpenAI compat
- **Fallback**: se OpenRouter fallisce → riprova col fallback model (es. `qwen/qwen3-coder` invece di `deepseek-v4-pro`)
- **Routing per ruolo e piano**:
  ```js
  // server/llm/router.js
  const MODEL_MAP = {
    free: {
      planner:  'qwen/qwen3-coder',
      builder:  'qwen/qwen3-coder',
      critic:   'microsoft/phi-4',
      narrator: 'microsoft/phi-4',
    },
    pro: {
      planner:  'deepseek/deepseek-v4-pro',
      builder:  'deepseek/deepseek-v4-flash',
      critic:   'qwen/qwen3-coder',
      narrator: 'qwen/qwen3-coder',
    }
  };
  ```
- **Thinking/reasoning**: abilitato solo per ruoli `planner` e `builder_hard`

### 2.2 — Caching LRU in-memory
- **Cache risposte LLM**: `lru-cache` con max 500 entries, TTL 10 minuti
  - Chiave: `sha256(role + JSON.stringify(messages) + model)`
  - Invalida quando contesto Excel cambia (nuovo `excelContextHash`)
- **Cache breakpoint OpenRouter**: già implementato, mantenere
- **Nessun Redis necessario**

### 2.3 — Chiave API centralizzata
- `OPENROUTER_API_KEY` nel `.env` del server
- Utente non vede mai provider, modelli, chiavi
- Per utenti pro: possibilità di inserire la propria chiave (criptata in `user_settings`) — rimandabile post-demo

---

## FASE 3: TELEMETRIA (Settimana 7–8)

> **Obiettivo**: Tracciare tutto su SQLite, dashboard accessibile da `/admin`.

### 3.1 — Eventi da tracciare
Tutto in `INSERT INTO events` asincrono (non blocca mai la richiesta):

```
turn.started       { inputLength, sheetsCount, usedRangeCells, language }
turn.plan_generated { taskCount, planLatencyMs, model }
turn.approved      { approvalLatencyMs }
turn.completed     { totalLatencyMs, actionCount, tokensUsed }
turn.failed        { errorType, errorMessage, stage }

llm.request        { model, role, promptTokens, stream }
llm.response       { completionTokens, latencyMs, cached }
llm.error          { statusCode, errorMessage, retryCount }

action.executed    { toolName, success, latencyMs }
action.failed      { toolName, errorMessage }
```

**MAI loggare**: contenuto celle Excel, password, messaggi utente completi, IP, JWT

### 3.2 — Raccolta asincrona
```js
// server/telemetry/tracker.js
const pending = [];

export function track(event) {
  pending.push({ ...event, ts: new Date().toISOString() });
}

// Flush ogni 5 secondi
setInterval(() => {
  if (pending.length === 0) return;
  const batch = pending.splice(0);
  const insert = db.prepare(
    'INSERT INTO events (user_id, session_id, event_type, properties, latency_ms, tokens_in, tokens_out, model, success) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const tx = db.transaction(() => batch.forEach(e => insert.run(...)));
  tx();
}, 5000);
```

### 3.3 — Dashboard `/admin`
- **Una singola pagina HTML** servita dallo stesso Express (protetta da admin auth)
- **API JSON per dati**:
  ```
  GET /api/admin/stats          → { users, turnsToday, errors24h, costToday }
  GET /api/admin/users          → lista utenti con usage
  GET /api/admin/events?type=X&from=Y&to=Z  → eventi filtrati
  GET /api/admin/costs          → spesa LLM per giorno/settimana/mese
  ```
- **Grafici**: Chart.js (CDN) sulla pagina `/admin`:
  - Turn al giorno (bar chart)
  - Error rate (line chart)
  - Costo LLM cumulativo (line chart)
  - Top 5 errori (table)
  - Utenti attivi (counter)
- **Zero Grafana, zero ClickHouse, zero servizi esterni**

### 3.4 — Retention e pulizia
- Eventi: mantenuti 90 giorni, poi `DELETE FROM events WHERE ts < date('now', '-90 days')`
- Turn: mantenuti 30 giorni
- Job notturno (setInterval ogni ora): pulizia automatica

---

## FASE 4: ESPERIENZA UTENTE E ONBOARDING (Settimana 9–11)

> **Obiettivo**: L'add-in è facile da installare e piacevole da usare.

### 4.1 — Installazione add-in semplificata
**Per demo (niente AppSource, troppo lunga l'approvazione)**:
1. L'utente scarica `manifest.xml` da `https://excelai.example.com/manifest.xml`
2. Apre Excel → Inserisci → Componenti aggiuntivi → Carica componente → sceglie il file
3. Fine. Un solo file, zero certificati, zero Developer tab su Mac (online funziona subito)
4. Su Windows serve abilitare la Developer tab una volta sola (istruzioni a schermo)

**File sharing alternativo (più veloce)**:
- Network share: cartella condivisa su OneDrive/SharePoint con il manifest → l'utente la aggiunge come "Catalogo condiviso" in Excel → l'add-in appare automaticamente

**Per produzione futura**: Microsoft AppSource (approvazione 2-5 giorni)

### 4.2 — Manifest dinamico
```js
// GET /manifest.xml
app.get('/manifest.xml', (req, res) => {
  const baseUrl = process.env.PUBLIC_URL || `https://${req.hostname}`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
           xsi:type="TaskPaneApp">
  <Id>${APP_ID}</Id>
  <Version>1.0.0</Version>
  <ProviderName>Excel AI</ProviderName>
  <DefaultLocale>it-IT</DefaultLocale>
  <DisplayName DefaultValue="Excel AI"/>
  <Description DefaultValue="AI assistant for Excel"/>
  <IconUrl DefaultValue="${baseUrl}/assets/icon-32.png"/>
  <HighResolutionIconUrl DefaultValue="${baseUrl}/assets/icon-80.png"/>
  <SupportUrl DefaultValue="${baseUrl}/support"/>
  <AppDomains><AppDomain>${baseUrl}</AppDomain></AppDomains>
  <Hosts><Host Name="Workbook"/></Hosts>
  <DefaultSettings>
    <SourceLocation DefaultValue="${baseUrl}/src/taskpane.html"/>
  </DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>
</OfficeApp>`;
  res.type('application/xml').send(manifest);
});
```

### 4.3 — Onboarding
- Dopo il login, welcome screen con 3 prompt di esempio cliccabili:
  - "Formatta la tabella selezionata con colori alternati"
  - "Somma la colonna B e scrivi il totale in B10"
  - "Crea un grafico a barre dai dati in A1:B10"
- Petit tooltip sul funzionamento: "Scrivi in italiano o inglese cosa vuoi fare in Excel"
- Spinner durante l'attesa della risposta LLM
- Il piano generato viene mostrato in una lista numerata con checkbox per ogni task → l'utente può deselezionare task prima di approvare

### 4.4 — Feedback e errori
- Dopo ogni turn completato: pollice su/giù
- Errori Office.js mappati in messaggi chiari:
  - `InvalidArgument` → "Il range non è valido. Seleziona le celle corrette e riprova."
  - `ItemNotFound` → "Foglio non trovato."
- Pulsante "Copia errore" per inviare segnalazioni

---

## FASE 5: PRODUZIONE E PRONTO PER UTENTI REALI (Settimana 12)

> **Obiettivo**: Il sistema è stabile, monitorato, pronto per i primi beta tester.

### 5.1 — Process management
- **PM2** in cluster mode: `pm2 start server/server.js -i max --name excelai`
- **Auto-restart** su crash: `pm2 start ... --max-restarts 10`
- **Log** a journald: `pm2 logs` per debugging
- **Avvio automatico** al boot: `pm2 startup && pm2 save`

### 5.2 — Backup automatico
```bash
# Cron job (ogni ora): backup SQLite su directory locale + rclone opzionale
#!/bin/bash
cp data/app.db "data/backups/app-$(date +%Y%m%d-%H%M).db"
# Opzionale: sync su Backblaze B2 (primi 10GB gratis)
# rclone copy data/backups/ b2:excelai-backups/
```
- Retention: ultimi 7 giorni di backup orari, ultimi 30 giorni di backup giornalieri
- Restore: `cp data/backups/app-YYYYMMDD-HHMM.db data/app.db && pm2 restart excelai`

### 5.3 — Monitoring fai-da-te
- **Health check**: `GET /api/health` → `{ ok: true, uptime, dbSize, memUsage }`
- **UptimeRobot** (free tier, 50 monitor): ping ogni 5 minuti su `/api/health`
- **Alert Telegram/Email**: se `/api/health` non risponde per 2 minuti
- **Rate limiting** in-memory: `express-rate-limit` su tutte le route
- **Memory watch**: se `process.memoryUsage().heapUsed > 1GB`, logga warning

### 5.4 — Testing minimo
- **Unit test**: Vitest su tool registry, critic, planner (logica pura)
- **Integration test**: Supertest su endpoint `/api/auth/*` e `/api/turn/*` con SQLite in-memory
- **Smoke test manuale**: flow completo (login → invia prompt → approva piano → verifica azioni) dopo ogni deploy
- **Nessun E2E su Excel** (troppo complesso per demo, Office.js non testabile fuori da Excel)

### 5.5 — Deploy one-click
```bash
# Sul VPS:
git pull
npm ci --production
pm2 restart excelai
```
Oppure con `deploy.sh`:
```bash
#!/bin/bash
set -e
echo "🔨 Building..."
npm run build
echo "📦 Deploying..."
rsync -avz --exclude node_modules --exclude .git --exclude data/backups \
  ./ user@vps:/opt/excelai/
ssh user@vps "cd /opt/excelai && npm ci --production && pm2 restart excelai"
echo "✅ Done"
```

### 5.6 — Checklist pre-beta
- [ ] Dominio con HTTPS (Caddy + Let's Encrypt)
- [ ] `.env` con `OPENROUTER_API_KEY` e `JWT_SECRET` sul VPS
- [ ] SQLite in WAL mode (`PRAGMA journal_mode=WAL`)
- [ ] PM2 avviato, auto-restart al boot
- [ ] Backup cron funzionante
- [ ] UptimeRobot configurato
- [ ] `/admin` dashboard visibile (protetta da password)
- [ ] Manifest accessibile pubblicamente via HTTPS
- [ ] Test registrazione → login → turn → completato funzionante
- [ ] 3-5 utenti amici/parenti testano e danno feedback

---

## 📊 RIEPILOGO

| Fase | Durata | Cosa | Costo infrastruttura |
|------|--------|------|---------------------|
| 0 — Pulizia | 2 sett. | Rimozione dead code, SQLite, Makefile, deploy VPS | €0 (solo VPS €4.51) |
| 1 — Auth | 2 sett. | Registrazione/login JWT, multi-utenza, quota tracking | €0 |
| 2 — LLM API | 2 sett. | Gateway OpenRouter unico, caching LRU, model routing | €0 |
| 3 — Telemetria | 2 sett. | Eventi su SQLite, dashboard `/admin`, retention | €0 |
| 4 — UX | 3 sett. | Manifest dinamico, onboarding, errori chiari, feedback | €0 |
| 5 — Produzione | 1 sett. | PM2, backup, monitoring base, checklist beta | €0 |

**Totale**: ~12 settimane, 1 sviluppatore, costo fisso €4.51/mese + LLM a consumo.

### Confronto col piano precedente

| Voce | Prima | Ora |
|------|-------|-----|
| PostgreSQL | €15-30/mese | **€0** (SQLite) |
| Redis | €10/mese | **€0** (in-memory LRU) |
| ClickHouse | €50-100/mese | **€0** (SQLite) |
| Sentry | €0-30/mese | **€0** |
| Grafana | self-hosted | **€0** (pagina `/admin`) |
| Kubernetes | complessità | **€0** (PM2) |
| Docker/compose | complessità | **€0** (processo singolo) |
| Microservizi | complessità | **€0** (monolite) |
| CI/CD pipeline | setup lungo | **€0** (deploy.sh + rsync) |
| **Costo fisso totale** | **~$80-200/mese** | **€4.51/mese** |
| **Complessità setup** | giorni | **15 minuti** |
| **Tempo sviluppo** | 24 settimane | **12 settimane** |

### Quando migrare a infrastruttura più complessa
- **>500 utenti attivi**: Valutare PostgreSQL se SQLite diventa collo di bottiglia
- **>100 richieste/sec**: Aggiungere secondo processo Node.js dietro load balancer
- **>10GB di telemetria**: Valutare ClickHouse se le query analitiche diventano lente
- **>1000 utenti**: Aggiungere Stripe per billing automatico
- **NON farlo prima**. SQLite regge tranquillamente 10k+ utenti su singolo server.

---

## 🔄 PROSSIMI PASSI IMMEDIATI (oggi/domani)

1. **[ ]** Rimuovere `playwright`, `pdf-parse` da `package.json`
2. **[ ]** Installare `better-sqlite3`, `lru-cache`, `pino`
3. **[ ]** Creare `server/db/init.js` con lo schema SQL e WAL mode
4. **[ ]** Ruotare le API key esposte nel repo (OpenRouter, DeepSeek, Xiaomi)
5. **[ ]** Ridurre `.env` a 6 variabili
6. **[ ]** Rifattorizzare `server/tools/llm.js`: eliminare 4 provider, tenere solo OpenRouter
7. **[ ]** Registrare dominio (es. `excelai.app`) — €12/anno
8. **[ ]** Comprare VPS Hetzner CAX11 — €4.51/mese
