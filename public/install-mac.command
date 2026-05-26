#!/bin/bash
# Excel AI Add-in — macOS Installer
# Fai doppio clic su questo file per installare.

BASE_URL="https://excel-ai-sigma.vercel.app"
MANIFEST_DIR="$HOME/Library/Containers/com.microsoft.Excel/Data/Documents/wef"
MANIFEST_FILE="$MANIFEST_DIR/manifest.xml"
APP_DOMAIN=$(echo "$BASE_URL" | sed -E 's|^https?://||')

# ── Finestra di benvenuto ──
osascript -e '
display dialog "Excel AI — Assistente per Excel

Questo installer aggiungera l'\''add-in \"Excel AI\" al tuo Excel.

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

MANIFEST="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<OfficeApp
  xmlns=\"http://schemas.microsoft.com/office/appforoffice/1.1\"
  xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"
  xsi:type=\"TaskPaneApp\">
  <Id>$(uuidgen 2>/dev/null || echo "a1b2c3d4-e5f6-7890-abcd-ef1234567890")</Id>
  <Version>1.0.0.0</Version>
  <ProviderName>Excel AI</ProviderName>
  <DefaultLocale>it-IT</DefaultLocale>
  <DisplayName DefaultValue=\"Excel AI\"/>
  <Description DefaultValue=\"Assistente AI per commercialisti e CPA\"/>
  <IconUrl DefaultValue=\"$BASE_URL/assets/icon-32.png\"/>
  <HighResolutionIconUrl DefaultValue=\"$BASE_URL/assets/icon-80.png\"/>
  <AppDomains>
    <AppDomain>$APP_DOMAIN</AppDomain>
  </AppDomains>
  <Hosts>
    <Host Name=\"Workbook\"/>
  </Hosts>
  <DefaultSettings>
    <SourceLocation DefaultValue=\"$BASE_URL/src/taskpane.html\"/>
  </DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>
</OfficeApp>"

echo "$MANIFEST" > "$MANIFEST_FILE"

if [ -f "$MANIFEST_FILE" ]; then
  echo "  ✅ Add-in installato con successo!"
  echo ""
  echo "  📌 Cosa fare ora:"
  echo "     1. Apri Microsoft Excel"
  echo "     2. Cerca \"Excel AI\" nella tab Home"
  echo "     3. Registrati con la tua email"
  echo ""

  # Avvia Excel se installato
  if pgrep -iq microsoft.excel; then
    echo "  ⚠️  Excel è già aperto. Riavvia per vedere l'add-in."
  else
    open -a "Microsoft Excel" 2>/dev/null && echo "  🚀 Avvio di Excel..."
  fi

  osascript -e '
display dialog "Add-in Excel AI installato!

Apri Excel e cerca \"Excel AI\" nella tab Home.

Se Excel e gia aperto, riavvialo." with title "Installazione completata" buttons {"OK"} default button "OK" with icon note
' 2>/dev/null &
else
  osascript -e '
display dialog "Errore durante l'\''installazione.

Contatta assistenza@excel-ai-sigma.vercel.app" with title "Errore" buttons {"OK"} default button "OK" with icon stop
' 2>/dev/null &
fi

exit 0
