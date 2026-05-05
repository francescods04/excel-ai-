#!/bin/bash
# ============================================================
# Excel AI Agent - Dev Startup Script (macOS)
# Avvia automaticamente: opencode serve + Node.js server + Excel
# ============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║         Excel AI Agent - Dev Launcher (macOS)              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ─────────────────────────────────────────────────────────────
# 1. Verifica dipendenze
# ─────────────────────────────────────────────────────────────
echo "📦 Verifica dipendenze..."

if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js non trovato. Installalo da https://nodejs.org${NC}"
    exit 1
fi

if ! command -v opencode &> /dev/null; then
    echo -e "${YELLOW}⚠️  opencode CLI non trovato. Provider OpenCode non disponibile.${NC}"
    echo "   Installa con: npm install -g opencode"
fi

if ! command -v lsof &> /dev/null; then
    echo -e "${RED}❌ lsof non trovato. Installalo: brew install lsof${NC}"
    exit 1
fi

# ─────────────────────────────────────────────────────────────
# 2. Carica .env per sapere quale provider usare
# ─────────────────────────────────────────────────────────────
AI_PROVIDER="opencode"
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

echo -e "🤖 Provider AI configurato: ${BLUE}${AI_PROVIDER}${NC}"
echo ""

# ─────────────────────────────────────────────────────────────
# 3. Avvia opencode serve (se necessario)
# ─────────────────────────────────────────────────────────────
if [ "$AI_PROVIDER" == "opencode" ]; then
    echo "🔍 Controllo opencode serve (porta 4096)..."
    if lsof -Pi :4096 -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo -e "${GREEN}✅ opencode serve già in esecuzione${NC}"
    else
        echo "🚀 Avvio opencode serve..."
        nohup opencode serve --port 4096 --hostname 127.0.0.1 > opencode-serve.log 2>&1 &
        sleep 3
        if lsof -Pi :4096 -sTCP:LISTEN -t >/dev/null 2>&1; then
            echo -e "${GREEN}✅ opencode serve avviato (porta 4096)${NC}"
        else
            echo -e "${RED}❌ Errore avvio opencode serve. Controlla opencode-serve.log${NC}"
            exit 1
        fi
    fi
    echo ""
fi

# ─────────────────────────────────────────────────────────────
# 4. Verifica certificati HTTPS
# ─────────────────────────────────────────────────────────────
if [ ! -f certs/cert.pem ] || [ ! -f certs/key.pem ]; then
    echo "🔒 Generazione certificati HTTPS self-signed..."
    mkdir -p certs

    # Generate CA if missing
    if [ ! -f ca.crt ] || [ ! -f ca.key ]; then
        openssl genrsa -out ca.key 2048 2>/dev/null
        openssl req -x509 -new -nodes -key ca.key -sha256 -days 365 -out ca.crt \
            -subj "/CN=Excel AI Dev CA" 2>/dev/null
    fi

    # Generate server cert with proper SAN (DNS:localhost + IP:127.0.0.1)
    openssl genrsa -out certs/key.pem 2048 2>/dev/null
    openssl req -new -key certs/key.pem -out /tmp/excel-ai-server.csr \
        -subj "/CN=localhost" 2>/dev/null

    cat > /tmp/excel-ai-san.ext << 'SANEOF'
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=@alt_names

[alt_names]
DNS.1=localhost
IP.1=127.0.0.1
SANEOF

    openssl x509 -req -in /tmp/excel-ai-server.csr -CA ca.crt -CAkey ca.key \
        -CAcreateserial -out certs/cert.pem -days 365 -sha256 \
        -extfile /tmp/excel-ai-san.ext 2>/dev/null

    rm -f /tmp/excel-ai-server.csr /tmp/excel-ai-san.ext

    echo -e "${GREEN}✅ Certificati HTTPS creati (CA + server cert con SAN)${NC}"
fi

echo ""

health_check() {
    curl -s http://127.0.0.1:3000/api/health 2>/dev/null
}

# ─────────────────────────────────────────────────────────────
# 5. Avvia server Node.js (se necessario)
# ─────────────────────────────────────────────────────────────
echo "🔍 Controllo server Node.js (porta 3000)..."
if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    EXISTING_HEALTH="$(health_check)"
    if echo "$EXISTING_HEALTH" | grep -q '"app":"excel-ai-agent"'; then
        echo -e "${GREEN}✅ Server Excel AI Agent già in esecuzione${NC}"
    else
        echo -e "${RED}❌ La porta 3000 è occupata da un server non compatibile.${NC}"
        echo -e "${YELLOW}   Probabile causa: hai avviato un server statico (es. npm run serve vecchio / http-server).${NC}"
        echo -e "${YELLOW}   Esegui ./stop-dev.sh oppure libera la porta 3000, poi rilancia ./start-dev.sh.${NC}"
        exit 1
    fi
else
    echo "🚀 Avvio server Node.js..."
    nohup node server/server.js > server.log 2>&1 &
    sleep 3
    if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
        STARTED_HEALTH="$(health_check)"
        if echo "$STARTED_HEALTH" | grep -q '"app":"excel-ai-agent"'; then
            echo -e "${GREEN}✅ Server Node.js avviato (http://localhost:3000)${NC}"
        else
            echo -e "${RED}❌ La porta 3000 è attiva ma non risponde come Excel AI Agent.${NC}"
            echo -e "${RED}   Controlla server.log e assicurati che nessun altro server stia usando localhost:3000.${NC}"
            exit 1
        fi
    else
        echo -e "${RED}❌ Errore avvio server Node.js. Controlla server.log${NC}"
        exit 1
    fi
fi
echo ""

# ─────────────────────────────────────────────────────────────
# 6. Avvia OpenBB API server (se OPENBB_ENABLED=true e venv esiste)
# ─────────────────────────────────────────────────────────────
if [ "${OPENBB_ENABLED:-false}" = "true" ] || [ -f .venv-openbb/bin/activate ]; then
    echo "🔍 Controllo OpenBB API server (porta 6900)..."
    if lsof -Pi :6900 -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo -e "${GREEN}✅ OpenBB API già in esecuzione (porta 6900)${NC}"
    else
        if [ -f .venv-openbb/bin/activate ]; then
            echo "🚀 Avvio OpenBB API server..."
            nohup bash -c "source $SCRIPT_DIR/.venv-openbb/bin/activate && OPENBB_API_AUTH=false openbb-api --port 6900 --host 127.0.0.1" > openbb-api.log 2>&1 &
            # Attendi che il server risponda (max 30 secondi)
            for i in $(seq 1 30); do
                if curl -s http://127.0.0.1:6900/api/v1/equity/price/quote?symbol=AAPL\&provider=yfinance >/dev/null 2>&1; then
                    echo -e "${GREEN}✅ OpenBB API avviato (porta 6900)${NC}"
                    break
                fi
                if [ $i -eq 30 ]; then
                    echo -e "${YELLOW}⚠️  OpenBB API non risponde dopo 30s. I tool OpenBB non saranno disponibili.${NC}"
                    echo -e "${YELLOW}   Controlla openbb-api.log${NC}"
                fi
                sleep 1
            done
        else
            echo -e "${YELLOW}⚠️  .venv-openbb non trovato. Installa OpenBB con:${NC}"
            echo -e "   ${BLUE}python3 -m venv .venv-openbb && source .venv-openbb/bin/activate && pip install 'openbb[all]'${NC}"
        fi
    fi
    echo ""
fi

# ─────────────────────────────────────────────────────────────
# 7. Apri Excel
# ─────────────────────────────────────────────────────────────
echo "📊 Apertura Microsoft Excel..."
if pgrep -x "Microsoft Excel" > /dev/null; then
    echo -e "${YELLOW}⚠️  Excel è già aperto. Portalo in primo piano.${NC}"
else
    open -a "Microsoft Excel"
    sleep 2
    echo -e "${GREEN}✅ Excel aperto${NC}"
fi
echo ""

# ─────────────────────────────────────────────────────────────
# 8. Istruzioni per caricare il manifest
# ─────────────────────────────────────────────────────────────
MANIFEST_PATH="$SCRIPT_DIR/manifest.xml"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  📋 ISTRUZIONI PER CARICARE L'ADD-IN IN EXCEL               ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "1. In Excel, clicca sulla scheda ${YELLOW}Developer${NC}"
echo "   (Se non la vedi: Excel → Preferences → Ribbon & Toolbar → spunta Developer)"
echo ""
echo "2. Clicca su ${YELLOW}Add-ins → My Add-ins → Upload My Add-in${NC}"
echo ""
echo "3. Seleziona il file:"
echo "   ${BLUE}${MANIFEST_PATH}${NC}"
echo ""
echo "4. Clicca ${YELLOW}Open${NC} — il pannello AI Agent si aprirà automaticamente!"
echo ""
echo "──────────────────────────────────────────────────────────────"
echo ""
echo -e "🌐 Server attivi:"
echo -e "   • Node.js:  ${BLUE}http://localhost:3000${NC}  |  ${BLUE}https://localhost:3443${NC}"
if [ "$AI_PROVIDER" == "opencode" ]; then
    echo -e "   • OpenCode: ${BLUE}http://127.0.0.1:4096${NC}"
fi
if [ -f .venv-openbb/bin/activate ]; then
    echo -e "   • OpenBB:   ${BLUE}http://127.0.0.1:6900${NC}"
fi
echo ""
echo -e "📝 Log file:"
echo -e "   • Server Node: ${BLUE}server.log${NC}"
if [ "$AI_PROVIDER" == "opencode" ]; then
    echo -e "   • OpenCode:    ${BLUE}opencode-serve.log${NC}"
fi
echo ""
echo "──────────────────────────────────────────────────────────────"
echo ""
echo -e "💡 ${YELLOW}Per fermare tutto:${NC} esegui ./stop-dev.sh"
echo ""

# ─────────────────────────────────────────────────────────────
# 9. Mostra log in tempo reale (opzionale)
# ─────────────────────────────────────────────────────────────
read -p "Vuoi vedere i log del server in tempo reale? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo "📡 Log server (Ctrl+C per uscire, i server restano attivi):"
    echo "──────────────────────────────────────────────────────────────"
    tail -f server.log
fi
