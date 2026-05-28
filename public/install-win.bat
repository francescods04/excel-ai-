@echo off
:: Excel AI Add-in — Windows Installer
:: Fai doppio clic su questo file per installare.
title Excel AI — Installer
setlocal enabledelayedexpansion

set "BASE_URL=https://francescodelsesto.com"
set "CATALOG_DIR=%LOCALAPPDATA%\ExcelAI"
set "MANIFEST_FILE=%CATALOG_DIR%\manifest.xml"

:: Extract domain (remove https://)
set "DOMAIN=%BASE_URL:https://=%"

cls
echo.
echo   Excel AI — Assistente per Excel
echo   %BASE_URL%
echo.
echo   Questo installer aggiungera l'add-in "Excel AI" al tuo Excel.
echo   Nessuna modifica al sistema. Solo un file di configurazione.
echo.
echo   Premi un tasto per iniziare...
pause >nul

cls
echo.
echo   Installazione in corso...
echo.

:: Create folder
if not exist "%CATALOG_DIR%" mkdir "%CATALOG_DIR%" 2>nul
if not exist "%CATALOG_DIR%" (
  echo   [ERRORE] Impossibile creare %CATALOG_DIR%
  pause >nul
  exit /b 1
)

:: Write manifest XML
(
echo ^<?xml version="1.0" encoding="UTF-8"?^>
echo ^<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="TaskPaneApp"^>
echo   ^<Id^>a1b2c3d4-e5f6-7890-abcd-ef1234567890^</Id^>
echo   ^<Version^>1.0.0.0^</Version^>
echo   ^<ProviderName^>Excel AI^</ProviderName^>
echo   ^<DefaultLocale^>it-IT^</DefaultLocale^>
echo   ^<DisplayName DefaultValue="Excel AI"/^>
echo   ^<Description DefaultValue="Assistente AI per commercialisti e CPA"/^>
echo   ^<IconUrl DefaultValue="%BASE_URL%/assets/icon-32.png"/^>
echo   ^<HighResolutionIconUrl DefaultValue="%BASE_URL%/assets/icon-80.png"/^>
echo   ^<AppDomains^>
echo     ^<AppDomain^>%DOMAIN%^</AppDomain^>
echo   ^</AppDomains^>
echo   ^<Hosts^>
echo     ^<Host Name="Workbook"/^>
echo   ^</Hosts^>
echo   ^<DefaultSettings^>
echo     ^<SourceLocation DefaultValue="%BASE_URL%/src/taskpane.html"/^>
echo   ^</DefaultSettings^>
echo   ^<Permissions^>ReadWriteDocument^</Permissions^>
echo ^</OfficeApp^>
) > "%MANIFEST_FILE%"

if exist "%MANIFEST_FILE%" (
  echo   [OK] File di configurazione creato
) else (
  echo   [ERRORE] Impossibile creare il file
  pause >nul
  exit /b 1
)

:: Register trusted catalog via registry
set "REG_KEY=HKCU\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs"

:: Create key if it doesn't exist
reg add "%REG_KEY%" /f >nul 2>&1

:: Find a free slot number (0-9) and write catalog path
set "SLOT="
for /l %%i in (0,1,9) do (
  reg query "%REG_KEY%" /v "%%i" >nul 2>&1
  if errorlevel 1 if not defined SLOT set "SLOT=%%i"
)
if not defined SLOT set "SLOT=0"

:: Use forward slashes for the catalog path in registry
set "CATALOG_PATH=%CATALOG_DIR:\=/%"

reg add "%REG_KEY%" /v "%SLOT%" /t REG_SZ /d "%CATALOG_PATH%" /f >nul 2>&1
if not errorlevel 1 (
  echo   [OK] Aggiunto a Excel
) else (
  echo   [INFO] Configurazione manuale necessaria:
  echo     Apri Excel ^> File ^> Opzioni ^> Centro protezione
  echo     ^> Cataloghi attendibili ^> Aggiungi: %CATALOG_DIR%
)

echo.
echo   ======================================
echo     Installazione completata
echo   ======================================
echo.
echo   Prossimi passi:
echo   1. Apri Microsoft Excel
echo   2. Inserisci ^> Componenti aggiuntivi ^> Cartella condivisa
echo   3. Seleziona "Excel AI"
echo   4. Registrati con la tua email
echo.

:: Try to find and open Excel
for %%p in (
  "C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE"
  "C:\Program Files (x86)\Microsoft Office\root\Office16\EXCEL.EXE"
  "C:\Program Files\Microsoft Office\Office16\EXCEL.EXE"
  "%ProgramFiles%\Microsoft Office\root\Office16\EXCEL.EXE"
) do (
  if exist %%p (
    start "" %%p 2>nul
    goto :done
  )
)
:done

echo   Premi un tasto per chiudere...
pause >nul
exit /b 0
