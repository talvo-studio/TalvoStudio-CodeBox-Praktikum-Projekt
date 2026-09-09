<#
.SYNOPSIS
    Richtet CodeBox auf einem Windows-Rechner ein: Website und Werkzeug.

.DESCRIPTION
    Erledigt der Reihe nach alles, was zwischen einem leeren Rechner und einer
    vorführbaren CodeBox steht:

      1. Prueft Git und Node und bietet an, Fehlendes per winget zu holen.
      2. Holt den Quelltext ins Zielverzeichnis (oder bringt ihn auf Stand).
      3. Installiert die Abhaengigkeiten der Website.
      4. Legt die lokale Datenbank an und spielt den Demo-Bestand ein.
      5. Uebersetzt das C++-Werkzeug, wenn ein Compiler da ist oder
         installiert werden darf.
      6. Startet die Website auf http://localhost:8787.

    Das Skript darf beliebig oft laufen. Ein zweiter Aufruf richtet nichts neu
    ein, sondern startet, was schon da ist: die Datenbank wird nie geleert.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1

.EXAMPLE
    # Nur die Website, ohne das Werkzeug zu uebersetzen:
    .\setup-windows.ps1 -OhneWerkzeug

.EXAMPLE
    # Anderer Ort, Server nicht starten:
    .\setup-windows.ps1 -Verzeichnis D:\Projekte\CodeBox -KeinStart
#>

[CmdletBinding()]
param(
    [string] $Verzeichnis = "C:\Users\ikwyg\Documents\Developer\CodeBox",
    [string] $RepoUrl = "https://github.com/talvo-studio/TalvoStudio-CodeBox-Praktikum-Projekt.git",
    [string] $Zweig = "claude/codebox-repo-mac-setup-8cb8p3",
    [int]    $Port = 8787,
    [switch] $OhneWerkzeug,
    [switch] $KeinStart
)

$ErrorActionPreference = "Stop"

# --------------------------------------------------------------------------
# Ausgabe
# --------------------------------------------------------------------------

$script:Nummer = 0

function Schritt([string] $Text) {
    $script:Nummer++
    Write-Host ""
    Write-Host ("[{0}] {1}" -f $script:Nummer, $Text) -ForegroundColor Cyan
}

function Info([string] $Text)    { Write-Host "    $Text" }
function Gut([string] $Text)     { Write-Host "    $Text" -ForegroundColor Green }
function Warnung([string] $Text) { Write-Host "    $Text" -ForegroundColor Yellow }

function Abbruch([string] $Text) {
    Write-Host ""
    Write-Host "  Abbruch: $Text" -ForegroundColor Red
    Write-Host ""
    exit 1
}

function Frage([string] $Text) {
    $antwort = Read-Host "    $Text [j/N]"
    return ($antwort -eq "j" -or $antwort -eq "J" -or $antwort -eq "y" -or $antwort -eq "Y")
}

function PfadNeuLesen {
    $maschine = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    $benutzer = [System.Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$maschine;$benutzer"
}

function Vorhanden([string] $Befehl) {
    return [bool] (Get-Command $Befehl -ErrorAction SilentlyContinue)
}

Write-Host ""
Write-Host "  CodeBox -- Einrichtung unter Windows" -ForegroundColor White
Write-Host "  Ziel: $Verzeichnis"

if ($Verzeichnis -match "OneDrive" -or $Verzeichnis -match "\\Documents\\") {
    Write-Host ""
    Warnung "Hinweis: Liegt dieser Ordner in OneDrive, synchronisiert OneDrive"
    Warnung "spaeter zehntausende Dateien aus node_modules mit. Falls es haengt,"
    Warnung "das Skript mit -Verzeichnis C:\Dev\CodeBox erneut starten."
}

# --------------------------------------------------------------------------
# 1. Werkzeuge
# --------------------------------------------------------------------------

Schritt "Werkzeuge pruefen"

if (-not (Vorhanden "git")) {
    Warnung "Git fehlt."
    if ((Vorhanden "winget") -and (Frage "Git jetzt per winget installieren?")) {
        winget install --id Git.Git --silent --accept-package-agreements --accept-source-agreements
        PfadNeuLesen
    }
    if (-not (Vorhanden "git")) {
        Abbruch "Git wird gebraucht. Installieren, PowerShell neu oeffnen, Skript erneut starten."
    }
}
Gut ("Git: " + (git --version))

$nodeOk = $false
if (Vorhanden "node") {
    $roh = (node -v)
    $haupt = 0
    if ($roh -match "^v(\d+)\.") { $haupt = [int] $Matches[1] }
    if ($haupt -ge 20) { $nodeOk = $true; Gut "Node: $roh" }
    else { Warnung "Node $roh ist zu alt, gebraucht wird 20 oder neuer." }
} else {
    Warnung "Node fehlt."
}

if (-not $nodeOk) {
    if ((Vorhanden "winget") -and (Frage "Node jetzt per winget installieren?")) {
        winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
        PfadNeuLesen
        if (Vorhanden "node") { Gut ("Node: " + (node -v)) }
    }
    if (-not (Vorhanden "node")) {
        Abbruch "Node wird gebraucht. Nach der Installation PowerShell neu oeffnen und das Skript erneut starten."
    }
}

if (-not (Vorhanden "npm.cmd")) {
    Abbruch "npm wurde nicht gefunden. PowerShell neu oeffnen und das Skript erneut starten."
}
# npm.cmd statt npm: umgeht die Execution Policy, die npm.ps1 blockieren kann.
$npm = "npm.cmd"

if (Vorhanden "curl.exe") {
    Gut "curl: vorhanden (das Werkzeug benutzt es fuers Netz)"
} else {
    Warnung "curl.exe wurde nicht gefunden. Windows 10 und 11 bringen es mit;"
    Warnung "ohne curl kann das Kommandozeilen-Werkzeug nichts abrufen."
}

# --------------------------------------------------------------------------
# 2. Quelltext
# --------------------------------------------------------------------------

Schritt "Quelltext bereitstellen"

if (Test-Path (Join-Path $Verzeichnis ".git")) {
    Info "Repository liegt schon da, hole den aktuellen Stand."
    try {
        git -C $Verzeichnis pull --ff-only
    } catch {
        Warnung "Konnte nicht aktualisieren (eigene Aenderungen?). Weiter mit dem vorhandenen Stand."
    }
} elseif ((Test-Path $Verzeichnis) -and ((Get-ChildItem $Verzeichnis -Force | Measure-Object).Count -gt 0)) {
    Abbruch "$Verzeichnis ist nicht leer und enthaelt kein Repository. Leeren oder -Verzeichnis anders setzen."
} else {
    $eltern = Split-Path $Verzeichnis -Parent
    if ($eltern -and -not (Test-Path $eltern)) {
        New-Item -ItemType Directory -Path $eltern -Force | Out-Null
    }
    Info "Klone $RepoUrl ($Zweig)"
    git clone --branch $Zweig $RepoUrl $Verzeichnis
    if ($LASTEXITCODE -ne 0) { Abbruch "git clone ist fehlgeschlagen." }
}

$web = Join-Path $Verzeichnis "codebox-web"
$cli = Join-Path $Verzeichnis "codebox-cli"
if (-not (Test-Path $web)) { Abbruch "In $Verzeichnis fehlt der Ordner codebox-web." }
Gut "Quelltext liegt in $Verzeichnis"

# --------------------------------------------------------------------------
# 3. Website einrichten
# --------------------------------------------------------------------------

Push-Location $web
try {
    Schritt "Abhaengigkeiten der Website installieren"
    & $npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Abbruch "npm install ist fehlgeschlagen." }
    Gut "Pakete installiert."

    Schritt "Einladungscode hinterlegen"
    $devVars = Join-Path $web ".dev.vars"
    if (Test-Path $devVars) {
        Warnung ".dev.vars ist schon da und bleibt unangetastet."
    } else {
        Copy-Item (Join-Path $web ".dev.vars.example") $devVars
        Gut ".dev.vars angelegt (Einladungscode: bfia25)."
    }

    Schritt "Datenbank anlegen und Demo-Bestand einspielen"
    & $npm run db:local
    if ($LASTEXITCODE -ne 0) { Abbruch "Die Tabellen liessen sich nicht anlegen." }
    & $npm run demo:local
    if ($LASTEXITCODE -ne 0) { Warnung "Der Demo-Bestand liess sich nicht einspielen. Die Seite laeuft trotzdem." }
    Gut "Datenbank bereit."
} finally {
    Pop-Location
}

# --------------------------------------------------------------------------
# 4. Das Werkzeug uebersetzen
# --------------------------------------------------------------------------

$werkzeug = ""

if ($OhneWerkzeug) {
    Schritt "Werkzeug uebersprungen (-OhneWerkzeug)"
} else {
    Schritt "Das C++-Werkzeug uebersetzen"

    $gpp = ""
    if (Vorhanden "g++") {
        $gpp = "g++"
    } elseif (Test-Path "C:\msys64\ucrt64\bin\g++.exe") {
        $gpp = "C:\msys64\ucrt64\bin\g++.exe"
    }

    if (-not $gpp) {
        Warnung "Kein C++-Compiler gefunden."
        if ((Vorhanden "winget") -and (Frage "MSYS2 samt GCC jetzt installieren? (grosser Download)")) {
            winget install --id MSYS2.MSYS2 --silent --accept-package-agreements --accept-source-agreements
            if (Test-Path "C:\msys64\usr\bin\bash.exe") {
                Info "Installiere GCC in MSYS2 (das dauert einige Minuten) ..."
                & "C:\msys64\usr\bin\bash.exe" -lc "pacman -S --noconfirm --needed mingw-w64-ucrt-x86_64-gcc"
                if (Test-Path "C:\msys64\ucrt64\bin\g++.exe") { $gpp = "C:\msys64\ucrt64\bin\g++.exe" }
            }
        }
    }

    if ($gpp) {
        Push-Location $cli
        try {
            & $gpp -std=c++17 -Wall -Wextra -O2 "src/main.cpp" -o "codebox.exe"
            if ($LASTEXITCODE -eq 0 -and (Test-Path (Join-Path $cli "codebox.exe"))) {
                $werkzeug = Join-Path $cli "codebox.exe"
                Gut "codebox.exe uebersetzt: $werkzeug"
            } else {
                Warnung "Das Uebersetzen ist fehlgeschlagen. Die Website laeuft trotzdem."
            }
        } finally {
            Pop-Location
        }
    } else {
        Warnung "Ohne Compiler kein Werkzeug. Die Website laeuft trotzdem."
        Info "Nachholen: MSYS2 von msys2.org, dann im Fenster 'MSYS2 UCRT64':"
        Info "  pacman -S mingw-w64-ucrt-x86_64-gcc"
        Info "Danach dieses Skript noch einmal starten."
    }
}

# --------------------------------------------------------------------------
# 5. Fertig
# --------------------------------------------------------------------------

$adresse = "http://localhost:$Port"

Write-Host ""
Write-Host "  Fertig." -ForegroundColor Green
Write-Host ""
Write-Host "  Website:  $adresse"
Write-Host "  Zugang:   demo"
Write-Host "  Passwort: codebox2026" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Zum Vorfuehren:"
Write-Host "    1. Auf $adresse anmelden, unter 'Meine CodeBox' liegen drei Dateien."
Write-Host "    2. Eine Datei oeffnen, auf 'Teilen' druecken, den Code kopieren."
Write-Host "    3. Den Link in einem privaten Fenster oeffnen - ohne Anmeldung sichtbar."
Write-Host "    4. Bereits geteilt: $adresse/s/K3M92X"

if ($werkzeug -ne "") {
    Write-Host ""
    Write-Host "  Und auf der Kommandozeile (zweites Fenster, waehrend der Server laeuft):"
    Write-Host "    cd `"$cli`""
    Write-Host "    .\codebox.exe login          # Adresse $adresse, demo / codebox2026"
    Write-Host "    .\codebox.exe list"
    Write-Host "    .\codebox.exe share src\main.cpp"
    Write-Host "    .\codebox.exe download K3M92X"
}

Write-Host ""
Write-Host "  Spaeter wieder starten:"
Write-Host "    cd `"$web`""
Write-Host "    npm run dev"
Write-Host ""

if ($KeinStart) {
    Info "Server nicht gestartet (-KeinStart)."
} else {
    Write-Host "  Starte die Website. Beenden mit Strg+C." -ForegroundColor Cyan
    Write-Host ""
    Start-Job { param($u) Start-Sleep -Seconds 8; Start-Process $u } -ArgumentList $adresse | Out-Null
    Push-Location $web
    try {
        & $npm run dev
    } finally {
        Pop-Location
    }
}
