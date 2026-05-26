# Excel AI — Windows Installer
# Apri PowerShell come utente e incolla:
#   irm https://excel-ai-sigma.vercel.app/install.ps1 | iex
#
# Oppure scarica il file e fai doppio clic col destro → "Esegui con PowerShell"

param(
  [string]$BaseUrl = "https://excel-ai-sigma.vercel.app",
  [string]$CatalogName = "ExcelAI"
)

$ErrorActionPreference = "Stop"
$host.UI.RawUI.WindowTitle = "Excel AI — Installer"

Write-Host ""
Write-Host "  Excel AI — Assistente per commercialisti e CPA" -ForegroundColor Cyan
Write-Host "  $BaseUrl" -ForegroundColor DarkGray
Write-Host ""

# ── OS check ──
if (-not $IsWindows) {
  Write-Host "  Questo installer funziona solo su Windows." -ForegroundColor Red
  Write-Host "  Per macOS usa: bash <(curl -s $BaseUrl/install.sh)" -ForegroundColor Yellow
  exit 1
}

# ── Excel check ──
try {
  $excel = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\excel.exe" -ErrorAction SilentlyContinue
  if (-not $excel) {
    $excel = Get-ItemProperty "HKCU:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration" -ErrorAction SilentlyContinue
  }
} catch { }

# ── Create manifest ──
$catalogDir = "$env:LOCALAPPDATA\$CatalogName"
$manifestPath = "$catalogDir\manifest.xml"
$domain = $BaseUrl -replace '^https?://', ''

try {
  New-Item -ItemType Directory -Path $catalogDir -Force | Out-Null
}
catch {
  Write-Host "  ERRORE: Impossibile creare la cartella $catalogDir" -ForegroundColor Red
  Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

$manifest = @"
<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp
  xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:type="TaskPaneApp">
  <Id>a1b2c3d4-e5f6-7890-abcd-ef1234567890</Id>
  <Version>1.0.0.0</Version>
  <ProviderName>Excel AI</ProviderName>
  <DefaultLocale>it-IT</DefaultLocale>
  <DisplayName DefaultValue="Excel AI"/>
  <Description DefaultValue="Assistente AI per commercialisti e CPA"/>
  <IconUrl DefaultValue="$BaseUrl/assets/icon-32.png"/>
  <HighResolutionIconUrl DefaultValue="$BaseUrl/assets/icon-80.png"/>
  <AppDomains>
    <AppDomain>$domain</AppDomain>
  </AppDomains>
  <Hosts>
    <Host Name="Workbook"/>
  </Hosts>
  <DefaultSettings>
    <SourceLocation DefaultValue="$BaseUrl/src/taskpane.html"/>
  </DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>
</OfficeApp>
"@

try {
  Set-Content -Path $manifestPath -Value $manifest -Encoding UTF8
  Write-Host "  [OK] Manifest scritto in $manifestPath" -ForegroundColor Green
}
catch {
  Write-Host "  ERRORE: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

# ── Register in Trusted Catalog (HKCU — no admin needed) ──
$regPath = "HKCU:\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs"
try {
  if (-not (Test-Path $regPath)) {
    New-Item -Path $regPath -Force | Out-Null
  }
  $existing = (Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue).PSObject.Properties
  $maxId = 0
  foreach ($prop in $existing) {
    if ($prop.Name -match '^\d+$' -and [int]$prop.Name -gt $maxId) {
      $maxId = [int]$prop.Name
    }
  }
  $newId = $maxId + 1
  $catalogValue = $catalogDir -replace '\\', '/'
  New-ItemProperty -Path $regPath -Name $newId -Value $catalogValue -PropertyType String -Force | Out-Null
  Write-Host "  [OK] Trusted Catalog registrato (#$newId → $catalogDir)" -ForegroundColor Green
}
catch {
  Write-Host "  ATTENZIONE: Impossibile registrare il catalogo nel registro." -ForegroundColor Yellow
  Write-Host "  $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  Istruzioni manuali:" -ForegroundColor Yellow
  Write-Host "  1. Apri Excel" -ForegroundColor Yellow
  Write-Host "  2. File → Opzioni → Centro protezione → Impostazioni Centro protezione" -ForegroundColor Yellow
  Write-Host "  3. Cataloghi di componenti aggiuntivi attendibili" -ForegroundColor Yellow
  Write-Host "  4. Aggiungi: $catalogDir" -ForegroundColor Yellow
}

# ── Done ──
Write-Host ""
Write-Host "  Installazione completata!" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Come usare l'add-in:" -ForegroundColor White
Write-Host "  1. Apri Excel" -ForegroundColor White
Write-Host "  2. Vai su Inserisci → I miei componenti aggiuntivi → Cartella condivisa" -ForegroundColor White
Write-Host "  3. Seleziona 'Excel AI'" -ForegroundColor White
Write-Host ""
Write-Host "  Oppure, se il catalogo è registrato correttamente:" -ForegroundColor DarkGray
Write-Host "  L'add-in appare automaticamente nella tab Home." -ForegroundColor DarkGray
Write-Host ""

# ── Open Excel ──
try {
  $excelPath = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\excel.exe" -ErrorAction Stop).'(Default)'
  if ($excelPath) {
    Start-Process $excelPath
    Write-Host "  Avvio di Excel in corso..." -ForegroundColor Cyan
  }
} catch {
  Write-Host "  Apri Excel manualmente per vedere l'add-in." -ForegroundColor DarkGray
}
