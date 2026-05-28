#!/bin/bash
# Excel AI Add-in — macOS Installer
# Fai doppio clic su questo file per installare.
# Uso: trascina in Terminale, o doppio clic (se permesso da Sistema)

BASE_URL="https://francescodelsesto.com"
MANIFEST_DIR="$HOME/Library/Containers/com.microsoft.Excel/Data/Documents/wef"
MANIFEST_FILE="$MANIFEST_DIR/manifest.xml"
ADDIN_ID="1c7b92c5-2c4d-4b1e-9f3a-8e2d5f4c3a2b"
ADDIN_MANIFEST_FILE="$MANIFEST_DIR/$ADDIN_ID.manifest.xml"

# ── Finestra di benvenuto ──
osascript -e '
display dialog "Excel AI — Assistente per Excel

Questo installer aggiungera l'\''add-in \"AI Agent for Excel\" al tuo Excel.

Nessuna modifica al sistema. Solo un file di configurazione.

Vuoi procedere?" with title "Excel AI Installer" buttons {"Annulla", "Installa"} default button "Installa" with icon note
' 2>/dev/null
if [ $? -ne 0 ]; then exit 0; fi

clear
echo ""
echo "  ███████╗██╗  ██╗ ██████╗███████╗██╗         █████╗ ██╗"
echo "  ██╔════╝╚██╗██╔╝██╔════╝██╔════╝██║        ██╔══██╗██║"
echo "  █████╗   ╚███╔╝ ██║     █████╗  ██║        ███████║██║"
echo "  ██╔══╝   ██╔██╗ ██║     ██╔══╝  ██║        ██╔══██║██║"
echo "  ███████╗██╔╝ ██╗╚██████╗███████╗███████╗   ██║  ██║██║"
echo "  ╚══════╝╚═╝  ╚═╝ ╚═════╝╚══════╝╚══════╝   ╚═╝  ╚═╝╚═╝"
echo ""
echo "  Installazione in corso..."
echo ""

mkdir -p "$MANIFEST_DIR" 2>/dev/null

# Scarica il manifest COMPLETO (con VersionOverrides) dal server
echo "  📥 Download manifest da $BASE_URL ..."
curl -fsSL "$BASE_URL/manifest.xml" -o "$MANIFEST_FILE" 2>/dev/null
cp "$MANIFEST_FILE" "$ADDIN_MANIFEST_FILE" 2>/dev/null

if [ -f "$MANIFEST_FILE" ] && [ -f "$ADDIN_MANIFEST_FILE" ]; then
  WEF_CACHE="$HOME/Library/Containers/com.microsoft.Excel/Data/Library/Application Support/Microsoft/Office/16.0/Wef"
  if [ -d "$WEF_CACHE" ]; then
    find "$WEF_CACHE" -path "*/Manifests/${ADDIN_ID}_*" -type f -exec cp "$MANIFEST_FILE" {} \; 2>/dev/null
  fi

  echo "  ✅ Add-in installato con successo!"
  echo ""
  echo "  📌 Cosa fare ora:"
  echo "     1. Chiudi completamente Excel (Cmd+Q)"
  echo "     2. Riapri Microsoft Excel"
  echo "     3. Cerca \"AI Agent for Excel\" nella tab Home"
  echo ""

  # Avvia Excel se non è aperto
  if pgrep -iq microsoft.excel; then
    echo "  ⚠️  Excel è già aperto. Chiudilo e riaprilo per vedere l'add-in."
  else
    open -a "Microsoft Excel" 2>/dev/null && echo "  🚀 Avvio di Excel..."
  fi

  osascript -e '
display dialog "Add-in AI Agent for Excel installato!

1. Chiudi Excel (Cmd+Q) se è aperto
2. Riapri Excel
3. Cerca \"AI Agent for Excel\" nella tab Home" with title "Installazione completata" buttons {"OK"} default button "OK" with icon note
' 2>/dev/null &
else
  echo "  ❌ Errore: impossibile scaricare il manifest."
  echo "     Verifica che il sito $BASE_URL sia online."
  osascript -e '
display dialog "Errore durante l'\''installazione.

Impossibile scaricare il manifest da ' "$BASE_URL" '." with title "Errore" buttons {"OK"} default button "OK" with icon stop
' 2>/dev/null &
fi

exit 0
