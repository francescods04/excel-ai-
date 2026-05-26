#!/bin/bash
# Excel AI — macOS Installer
# bash <(curl -s https://excel-ai-sigma.vercel.app/install.sh)

MANIFEST_DIR="$HOME/Library/Containers/com.microsoft.Excel/Data/Documents/wef"
MANIFEST_FILE="$MANIFEST_DIR/manifest.xml"

mkdir -p "$MANIFEST_DIR"

BASE_URL="${1:-https://excel-ai-sigma.vercel.app}"
APP_DOMAIN=$(echo "$BASE_URL" | sed -E 's|^https?://||')

echo ""
echo "  Excel AI — Assistente per commercialisti e CPA"
echo "  $BASE_URL"
echo ""

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
  echo "  [OK] Add-in installato!"
  echo "  Apri Excel → tab Home → Excel AI"
  echo ""
  if pgrep -iq microsoft.excel; then
    echo "  Excel è aperto. Riavvia per vedere l'add-in."
  fi
else
  echo "  ERRORE: impossibile scrivere il manifest."
  exit 1
fi
