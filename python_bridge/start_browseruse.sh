#!/usr/bin/env bash
# Start the browser-use sidecar HTTP service (port 5099 by default).
# Usage: ./python_bridge/start_browseruse.sh
# Stop:  pkill -f browseruse_server.py
set -e
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

VENV="$PROJECT_ROOT/.venv-openbb"
if [ ! -x "$VENV/bin/python" ]; then
  echo "ERROR: venv not found at $VENV"
  exit 1
fi

# Install missing deps idempotently
"$VENV/bin/pip" install -q browser-use langchain-openai python-dotenv fastapi uvicorn || true

# Install Playwright Chromium for the venv if not yet installed
"$VENV/bin/python" -m playwright install chromium 2>&1 | tail -3 || true

exec "$VENV/bin/python" "$PROJECT_ROOT/python_bridge/browseruse_server.py"
