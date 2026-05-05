#!/bin/bash
# ============================================================
# Excel AI Agent - Stop Script (macOS)
# Ferma tutti i processi di sviluppo
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║         Excel AI Agent - Stop Script (macOS)               ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ─────────────────────────────────────────────────────────────
# 1. Ferma server Node.js
# ─────────────────────────────────────────────────────────────
echo "🔍 Ricerca server Node.js (porta 3000)..."
NODE_PID=$(lsof -Pi :3000 -sTCP:LISTEN -t 2>/dev/null)
if [ -n "$NODE_PID" ]; then
    echo -e "${YELLOW}🛑 Fermando server Node.js (PID: $NODE_PID)...${NC}"
    kill "$NODE_PID" 2>/dev/null
    sleep 1
    if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
        kill -9 "$NODE_PID" 2>/dev/null
    fi
    echo -e "${GREEN}✅ Server Node.js fermato${NC}"
else
    echo -e "${GREEN}✅ Server Node.js non in esecuzione${NC}"
fi

# ─────────────────────────────────────────────────────────────
# 2. Ferma opencode serve
# ─────────────────────────────────────────────────────────────
echo ""
echo "🔍 Ricerca opencode serve (porta 4096)..."
OPEN_PID=$(lsof -Pi :4096 -sTCP:LISTEN -t 2>/dev/null)
if [ -n "$OPEN_PID" ]; then
    echo -e "${YELLOW}🛑 Fermando opencode serve (PID: $OPEN_PID)...${NC}"
    kill "$OPEN_PID" 2>/dev/null
    sleep 1
    if lsof -Pi :4096 -sTCP:LISTEN -t >/dev/null 2>&1; then
        kill -9 "$OPEN_PID" 2>/dev/null
    fi
    echo -e "${GREEN}✅ opencode serve fermato${NC}"
else
    echo -e "${GREEN}✅ opencode serve non in esecuzione${NC}"
fi

# ─────────────────────────────────────────────────────────────
# 3. Ferma OpenBB API server
# ─────────────────────────────────────────────────────────────
echo ""
echo "🔍 Ricerca OpenBB API (porta 6900)..."
OBB_PID=$(lsof -Pi :6900 -sTCP:LISTEN -t 2>/dev/null)
if [ -n "$OBB_PID" ]; then
    echo -e "${YELLOW}🛑 Fermando OpenBB API (PID: $OBB_PID)...${NC}"
    kill "$OBB_PID" 2>/dev/null
    sleep 1
    if lsof -Pi :6900 -sTCP:LISTEN -t >/dev/null 2>&1; then
        kill -9 "$OBB_PID" 2>/dev/null
    fi
    echo -e "${GREEN}✅ OpenBB API fermato${NC}"
else
    echo -e "${GREEN}✅ OpenBB API non in esecuzione${NC}"
fi

echo ""
echo -e "${GREEN}🎉 Tutto fermato!${NC}"
echo ""
echo "──────────────────────────────────────────────────────────────"
echo "Per riavviare: ./start-dev.sh"
echo "──────────────────────────────────────────────────────────────"