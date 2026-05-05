#!/usr/bin/osascript
-- ============================================================
-- Excel AI Agent - AppleScript Launcher (macOS)
-- Apre Excel e mostra istruzioni per caricare l'add-in
-- ============================================================

-- 1. Verifica se Excel è aperto, altrimenti aprilo
tell application "System Events"
    if not (exists process "Microsoft Excel") then
        tell application "Microsoft Excel" to activate
        delay 3
    end if
end tell

-- 2. Porta Excel in primo piano
tell application "Microsoft Excel" to activate

-- 3. Crea un nuovo workbook vuoto se non ce n'è uno attivo
tell application "Microsoft Excel"
    if (count of workbooks) = 0 then
        make new workbook
    end if
end tell

-- 4. Mostra dialog con istruzioni
display dialog "Excel AI Agent è pronto!" & return & return & "Ora segui questi passaggi:" & return & return & "1. Clicca sulla scheda INSERT in alto" & return & "2. Clicca su ADD-INS (icona puzzle)" & return & "3. Seleziona MY ADD-INS" & return & "4. Clicca su AI AGENT FOR EXCEL" & return & return & "Se non lo vedi, clicca + (plus) in basso e carica il manifest.xml" buttons {"Apri Excel", "Ho capito"} default button "Ho capito" with icon note

-- 5. Se l'utente clicca "Apri Excel", portalo in primo piano
if button returned of result = "Apri Excel" then
    tell application "Microsoft Excel" to activate
end if