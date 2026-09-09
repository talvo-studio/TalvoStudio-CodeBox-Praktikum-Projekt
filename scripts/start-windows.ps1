<#
.SYNOPSIS
    Startet die CodeBox-Website. Fuer jeden Tag nach der Einrichtung.

.DESCRIPTION
    Wechselt in den richtigen Ordner, raeumt einen liegengebliebenen Server
    weg und startet die Seite. Das Fenster muss offen bleiben, solange die
    Seite laufen soll -- beenden mit Strg+C.

    Wird der Server ueber das Schliessen des Fensters beendet statt mit
    Strg+C, bleibt unter Windows manchmal ein workerd-Prozess zurueck und
    haelt den Port fest. Genau das raeumt dieses Skript ab.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\start-windows.ps1

.EXAMPLE
    # Auf einem anderen Port, falls 8787 dauerhaft belegt ist:
    .\start-windows.ps1 -Port 8788
#>

[CmdletBinding()]
param(
    [string] $Verzeichnis = "C:\Users\ikwyg\Documents\Developer\CodeBox",
    [int]    $Port = 8787,
    [switch] $KeinBrowser
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

$web = Join-Path $Verzeichnis "codebox-web"

Write-Host ""
Write-Host "  CodeBox starten" -ForegroundColor White

if (-not (Test-Path $web)) {
    Abbruch "Den Ordner $web gibt es nicht. Mit -Verzeichnis den richtigen Ort angeben."
}
if (-not (Test-Path (Join-Path $web "node_modules"))) {
    Abbruch "In $web fehlt node_modules. Zuerst setup-windows.ps1 laufen lassen."
}

# --- Liegengebliebenen Server finden und wegraeumen ---

$belegt = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($belegt) {
    $pids = @($belegt | Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($einPid in $pids) {
        $prozess = Get-Process -Id $einPid -ErrorAction SilentlyContinue
        if (-not $prozess) { continue }

        Warnung ("Port $Port ist belegt von " + $prozess.ProcessName + " (PID " + $einPid + ").")

        if ($prozess.ProcessName -in @("workerd", "node")) {
            Info "Das ist ein liegengebliebener Server. Beende ihn."
            Stop-Process -Id $einPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        } else {
            Abbruch ("Auf Port $Port laeuft " + $prozess.ProcessName +
                     " -- das ist nicht CodeBox. Mit -Port 8788 auf einen anderen Port ausweichen.")
        }
    }

    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        Abbruch "Port $Port ist immer noch belegt. Mit -Port 8788 ausweichen."
    }
    Gut "Port $Port ist wieder frei."
}

# --- Starten ---

$adresse = "http://localhost:$Port"

Write-Host ""
Write-Host "  Website:  $adresse"
Write-Host "  Zugang:   demo  /  codebox2026"
Write-Host ""
Write-Host "  Dieses Fenster offen lassen. Beenden mit Strg+C." -ForegroundColor Cyan
Write-Host "  Das Werkzeug braucht ein zweites Fenster." -ForegroundColor Cyan
Write-Host ""

if (-not $KeinBrowser) {
    Start-Job { param($u) Start-Sleep -Seconds 8; Start-Process $u } -ArgumentList $adresse | Out-Null
}

Push-Location $web
try {
    # npx.cmd statt npx: umgeht die Execution Policy, die npx.ps1 blockieren kann.
    & "npx.cmd" wrangler dev --port $Port
} finally {
    Pop-Location
}
