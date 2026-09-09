<#
.SYNOPSIS
    Macht "codebox" von jedem Ordner aus aufrufbar.

.DESCRIPTION
    Traegt den Ordner mit der codebox.exe in die PATH-Variable des eigenen
    Kontos ein. Danach reicht in einem neuen Fenster "codebox" -- ohne .\ und
    ohne .exe.

    Eingetragen wird der Projektordner selbst, nicht eine Kopie. So wirkt jedes
    erneute Uebersetzen sofort, ohne dass etwas nachkopiert werden muss.

    Mit -Entfernen wird der Eintrag wieder herausgenommen.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -Entfernen
#>

[CmdletBinding()]
param(
    [string] $Verzeichnis = "C:\Users\ikwyg\Documents\Developer\CodeBox",
    [switch] $Entfernen
)

$ErrorActionPreference = "Stop"

function Info([string] $Text)    { Write-Host "    $Text" }
function Gut([string] $Text)     { Write-Host "    $Text" -ForegroundColor Green }
function Warnung([string] $Text) { Write-Host "    $Text" -ForegroundColor Yellow }

function Abbruch([string] $Text) {
    Write-Host ""
    Write-Host "  Abbruch: $Text" -ForegroundColor Red
    Write-Host ""
    exit 1
}

$cli = Join-Path $Verzeichnis "codebox-cli"
$exe = Join-Path $cli "codebox.exe"

Write-Host ""
Write-Host "  codebox von ueberall aufrufbar machen" -ForegroundColor White
Write-Host ""

# --------------------------------------------------------------------------
# PATH lesen
#
# Bewusst ueber die .NET-Schnittstelle und nicht ueber setx: setx schneidet
# einen PATH, der laenger als 1024 Zeichen ist, kommentarlos ab. Wer sich das
# einmal eingefangen hat, sucht anschliessend tagelang nach Programmen, die
# "ploetzlich weg" sind.
#
# Und ausdruecklich der Benutzer-PATH, nicht der des Systems: Der gehoert dir,
# braucht keine Administratorrechte und betrifft niemanden sonst.
# --------------------------------------------------------------------------

$alt = [Environment]::GetEnvironmentVariable("Path", "User")
if ($null -eq $alt) { $alt = "" }

$teile = @($alt -split ";" | Where-Object { $_ -ne "" })
$drin = @($teile | Where-Object { $_.TrimEnd("\") -ieq $cli.TrimEnd("\") }).Count -gt 0

# --------------------------------------------------------------------------
# Entfernen
# --------------------------------------------------------------------------

if ($Entfernen) {
    if (-not $drin) {
        Info "Der Ordner steht nicht im PATH. Nichts zu tun."
        exit 0
    }
    $neu = ($teile | Where-Object { $_.TrimEnd("\") -ine $cli.TrimEnd("\") }) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $neu, "User")
    Gut "Eintrag entfernt: $cli"
    Info "Gilt ab dem naechsten Fenster."
    exit 0
}

# --------------------------------------------------------------------------
# Eintragen
# --------------------------------------------------------------------------

if (-not (Test-Path $exe)) {
    Warnung "codebox.exe gibt es noch nicht: $exe"
    Info "Zuerst uebersetzen:"
    Info "  powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1"
    Abbruch "Ohne die fertige Datei hat der Eintrag keinen Zweck."
}
Gut "Gefunden: $exe"

if ($drin) {
    Info "Der Ordner steht schon im PATH."
} else {
    $neu = if ($alt -eq "") { $cli } else { $alt.TrimEnd(";") + ";" + $cli }
    [Environment]::SetEnvironmentVariable("Path", $neu, "User")
    Gut "In den PATH deines Kontos eingetragen: $cli"
}

# Im laufenden Fenster gilt die Aenderung sonst noch nicht.
if (($env:Path -split ";") -notcontains $cli) {
    $env:Path = $env:Path.TrimEnd(";") + ";" + $cli
}

Write-Host ""
Write-Host "  Fertig." -ForegroundColor Green
Write-Host ""
Write-Host "  Ab jetzt reicht in einem NEUEN Fenster:"
Write-Host "    codebox --help"
Write-Host "    codebox share main.cpp"
Write-Host ""
Info "Bereits offene Fenster kennen den Eintrag noch nicht -- die lesen den"
Info "PATH nur beim Start. Dieses hier wurde eben mitversorgt."
Write-Host ""
Info "Wird der Projektordner spaeter verschoben, zeigt der Eintrag ins Leere."
Info "Dann dieses Skript im neuen Ordner noch einmal starten."
Write-Host ""
Info "Rueckgaengig machen:"
Info "  powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -Entfernen"
