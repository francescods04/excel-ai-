#!/bin/bash
# Installa il manifest dell'add-in in Excel su macOS
# Basta eseguire: bash install.sh

MANIFEST_DIR="$HOME/Library/Containers/com.microsoft.Excel/Data/Documents/wef"
MANIFEST_FILE="$MANIFEST_DIR/manifest.xml"

mkdir -p "$MANIFEST_DIR"

# Se il server è locale, usa localhost; altrimenti chiedi URL
BASE_URL="$1"

if [ -z "$BASE_URL" ]; then
  echo "Usage: bash install.sh <URL>"
  echo "  bash install.sh http://localhost:3000"
  echo "  bash install.sh https://excel-ai-sigma.vercel.app"
  exit 1
fi

# Estrai il dominio senza protocollo per AppDomain
APP_DOMAIN=$(echo "$BASE_URL" | sed -E 's|^https?://||')

echo "📋 Generazione manifest per: $BASE_URL"

cat > "$MANIFEST_FILE" << MANIFESTEOF
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
  xmlns:ov="http://schemas.microsoft.com/office/taskpaneappversionoverrides"
  xsi:type="TaskPaneApp">

  <Id>1c7b92c5-2c4d-4b1e-9f3a-8e2d5f4c3a2b</Id>
  <Version>1.0.0.0</Version>
  <ProviderName>Excel AI</ProviderName>
  <DefaultLocale>it-IT</DefaultLocale>
  <DisplayName DefaultValue="Excel AI" />
  <Description DefaultValue="AI assistant for Excel - natural language to actions" />
  <IconUrl DefaultValue="$BASE_URL/assets/icon-32.png" />
  <HighResolutionIconUrl DefaultValue="$BASE_URL/assets/icon-80.png" />
  <SupportUrl DefaultValue="$BASE_URL/support" />

  <AppDomains>
    <AppDomain>$APP_DOMAIN</AppDomain>
  </AppDomains>

  <Hosts>
    <Host Name="Workbook" />
  </Hosts>

  <DefaultSettings>
    <SourceLocation DefaultValue="$BASE_URL/src/taskpane.html" />
  </DefaultSettings>

  <Permissions>ReadWriteDocument</Permissions>

  <VersionOverrides xmlns="http://schemas.microsoft.com/office/taskpaneappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Hosts>
      <Host xsi:type="Workbook">
        <DesktopFormFactor>
          <ExtensionPoint xsi:type="PrimaryCommandSurface">
            <OfficeTab id="TabHome">
              <Group id="CommandsGroup">
                <Label resid="CommandsGroup.Label" />
                <Icon>
                  <bt:Image size="16" resid="Icon.16x16" />
                  <bt:Image size="32" resid="Icon.32x32" />
                  <bt:Image size="80" resid="Icon.80x80" />
                </Icon>
                <Control xsi:type="Button" id="TaskpaneButton">
                  <Label resid="TaskpaneButton.Label" />
                  <Supertip>
                    <Title resid="TaskpaneButton.Label" />
                    <Description resid="TaskpaneButton.Tooltip" />
                  </Supertip>
                  <Icon>
                    <bt:Image size="16" resid="Icon.16x16" />
                    <bt:Image size="32" resid="Icon.32x32" />
                    <bt:Image size="80" resid="Icon.80x80" />
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <TaskpaneId>ButtonId1</TaskpaneId>
                    <SourceLocation resid="Taskpane.Url" />
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>
    <Resources>
      <bt:Images>
        <bt:Image id="Icon.16x16" DefaultValue="$BASE_URL/assets/icon-16.png"/>
        <bt:Image id="Icon.32x32" DefaultValue="$BASE_URL/assets/icon-32.png"/>
        <bt:Image id="Icon.80x80" DefaultValue="$BASE_URL/assets/icon-80.png"/>
      </bt:Images>
      <bt:Urls>
        <bt:Url id="Commands.Url" DefaultValue="$BASE_URL/src/commands.html" />
        <bt:Url id="Taskpane.Url" DefaultValue="$BASE_URL/src/taskpane.html" />
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="CommandsGroup.Label" DefaultValue="Excel AI" />
        <bt:String id="TaskpaneButton.Label" DefaultValue="Apri Excel AI" />
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="TaskpaneButton.Tooltip" DefaultValue="Apri il pannello AI per controllare Excel in linguaggio naturale" />
      </bt:LongStrings>
    </Resources>
  </VersionOverrides>
</OfficeApp>
MANIFESTEOF

echo "✅ Manifest installato in: $MANIFEST_FILE"
echo ""
echo "Ora apri Excel. L'add-in 'Excel AI' appare nella tab Home."
echo "Se Excel è già aperto, riavvialo."

# Prova ad aprire Excel
if ! pgrep -q "Microsoft Excel"; then
  echo ""
  echo "🚀 Avvio Excel..."
  open -a "Microsoft Excel"
else
  echo "📌 Excel già in esecuzione. Riavvia per vedere l'add-in."
fi
