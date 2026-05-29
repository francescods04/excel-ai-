#!/bin/bash
# Excel AI — macOS Installer (via curl)
# bash <(curl -s https://francescodelsesto.com/install.sh)

BASE_URL="${1:-https://excel-six-plum.vercel.app}"
MANIFEST_DIR="$HOME/Library/Containers/com.microsoft.Excel/Data/Documents/wef"
MANIFEST_FILE="$MANIFEST_DIR/manifest.xml"
ADDIN_ID="1c7b92c5-2c4d-4b1e-9f3a-8e2d5f4c3a2b"
ADDIN_MANIFEST_FILE="$MANIFEST_DIR/$ADDIN_ID.manifest.xml"

echo ""
echo "  AI Agent for Excel"
echo "  $BASE_URL"
echo ""

mkdir -p "$MANIFEST_DIR"

# Scarica il manifest COMPLETO dal server (include VersionOverrides, icone, ribbon)
curl -fsSL "$BASE_URL/manifest.xml" -o "$MANIFEST_FILE" 2>/dev/null
cp "$MANIFEST_FILE" "$ADDIN_MANIFEST_FILE" 2>/dev/null

if [ -f "$MANIFEST_FILE" ] && [ -f "$ADDIN_MANIFEST_FILE" ]; then
  WEF_CACHE="$HOME/Library/Containers/com.microsoft.Excel/Data/Library/Application Support/Microsoft/Office/16.0/Wef"
  if [ -d "$WEF_CACHE" ]; then
    find "$WEF_CACHE" -path "*/Manifests/${ADDIN_ID}_*" -type f -exec cp "$MANIFEST_FILE" {} \; 2>/dev/null
  fi

  echo "  [OK] Add-in installato!"
  echo ""
  echo "  📌 Prossimi passi:"
  echo "     1. Chiudi Excel (Cmd+Q)"
  echo "     2. Riapri Excel"
  echo "     3. Cerca \"AI Agent for Excel\" nella tab Home"
  echo ""
  if pgrep -iq microsoft.excel; then
    echo "  ⚠️  Excel è aperto. Chiudilo e riaprilo per vedere l'add-in."
  fi
else
  echo "  ERRORE: impossibile scaricare il manifest da $BASE_URL"
  exit 1
fi
