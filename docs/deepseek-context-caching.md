# DeepSeek Context Caching — Guida all'uso nel Excel AI Agent

> DeepSeek API abilita il **Context Caching on Disk** automaticamente per tutti gli utenti. Non serve codice aggiuntivo: basta strutturare le richieste per massimizzare i prefissi comuni.

---

## Come funziona

1. Ogni richiesta scrive su disco i **prefissi** della conversazione ai confini della richiesta (fine input utente, fine output modello).
2. Se una richiesta successiva ha un **prefisso identico** a uno già persistito, DeepSeek recupera quella porzione dalla cache invece di riprocessarla.
3. Inoltre, se il sistema rileva un **prefisso comune** tra più richieste, lo persiste esplicitamente come unità cache indipendente.

---

## Campi di risposta

Nella sezione `usage` della risposta DeepSeek compaiono:

| Campo | Significato |
|-------|-------------|
| `prompt_cache_hit_tokens` | Token del prefisso trovati in cache |
| `prompt_cache_miss_tokens` | Token del prefisso NON trovati in cache |

Il nostro `server/tools/llm.js` logga automaticamente:

```
[LLM] DeepSeek response ← deepseek-v4-pro in 4200ms (1240 chars) cache_hit=1850 cache_miss=120 cache_pct=93.9%
```

---

## Best practice per massimizzare i cache hit

### 1. System prompt stabile

**Non** modificare il system prompt tra turn diversi.

```js
// ✅ CORRETTO — stesso system prompt ogni volta
const system = PLANNER_SYSTEM_PROMPT; // stringa costante

// ❌ SBAGLIATO — system prompt diverso ad ogni chiamata
const system = `${PLANNER_SYSTEM_PROMPT}\nTimestamp: ${Date.now()}`;
```

### 2. Conversazioni multi-turn: appendi, non ricostruire

```js
// ✅ CORRETTO — aggiungi solo il nuovo messaggio
messages.push({ role: 'assistant', content: lastReply });
messages.push({ role: 'user', content: newQuestion });

// ❌ SBAGLIATO — ricostruisci tutto da zero con testo diverso
const messages = buildFreshMessages(history);
```

### 3. Riutilizza il contesto workbook

Se leggi lo stesso range/foglio in turn successivi, mantieni la stessa rappresentazione:

```js
// ✅ CORRETTO — stesso formato di contesto
const context = `Workbook: ${sheetName}\nRange A1:D10:\n${JSON.stringify(data)}`;

// ❌ SBAGLIATO — formato diverso ad ogni turno
const context = `Dati attuali: ${JSON.stringify(data)}`; // manca sheet name
```

### 4. Attendi il warmup della cache

La prima richiesta di una nuova conversazione **non** avrà cache hit. Dalla seconda in poi, se il prefisso è identico, il sistema persistere il prefisso comune. Il warmup richiede pochi secondi.

### 5. Preferisci chiamate sequenziali con prefisso lungo

Una conversazione con system prompt lungo (es. 3k token) + contesto workbook (2k token) seguita da 5 domande brevi beneficia enormemente della cache:

- Turn 1: 5000 token in → miss totale
- Turn 2: 5200 token in → hit 5000, miss 200
- Turn 3: 5400 token in → hit 5000, miss 400
- ...risparmio ~90% dei token di input

---

## Parametri DeepSeek configurabili in `.env`

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `DEEPSEEK_API_KEY` | — | Chiave API (`sk-...`) |
| `DEEPSEEK_API_URL` | `https://api.deepseek.com/chat/completions` | Endpoint |
| `DEEPSEEK_MODEL` | `deepseek-v4-pro` | Modello primario |
| `DEEPSEEK_FALLBACK_MODEL` | `deepseek-chat` | Modello di fallback |
| `DEEPSEEK_REASONING_EFFORT` | `high` | Livello reasoning (`low` / `medium` / `high`) |
| `DEEPSEEK_THINKING_ENABLED` | `true` | Abilita `thinking: {type: 'enabled'}` |

---

## Note tecniche

- Il Context Caching è **best-effort**: non garantisce 100% hit rate.
- La cache viene cancellata automaticamente dopo ore/giorni di inattività.
- L'output rimane deterministico a parità di `temperature`; il caching non influisce sulla generazione.
- `reasoning_effort` e `thinking` sono supportati solo su modelli DeepSeek che espongono reasoning (es. `deepseek-v4-pro`).

---

## Troubleshooting

**Cache hit sempre 0?**
1. Verifica che il system prompt sia identico tra le chiamate.
2. Controlla che non ci siano timestamp o ID unici nei messaggi.
3. Aspetta 2-3 richieste: il sistema deve prima rilevare e persistere il prefisso comune.

**Timeout su prompt lunghi?**
Aumenta i timeout in `.env`:
```env
LLM_TIMEOUT_MS=120000
PLANNER_TIMEOUT_MS=180000
```

**Fallback non si attiva?**
Verifica che `DEEPSEEK_FALLBACK_MODEL` sia diverso dal primario e che la chiave API sia valida anche per il modello di fallback.
