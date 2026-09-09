<#
.SYNOPSIS
    Uebersetzt codebox.exe und sagt genau, was dabei passiert.

.DESCRIPTION
    Sucht den Compiler, zeigt seine Version, uebersetzt und faengt jede
    Ausgabe ab -- auch die, die PowerShell sonst verschluckt. Am Ende steht
    entweder der Pfad zur fertigen Datei oder der vollstaendige Fehlertext.

    Dieses Skript gibt es, weil ein von Hand abgetippter Uebersetzungsbefehl
    zwei Fallen hat: Wer ihn aus einer Nachricht kopiert, holt sich
    moeglicherweise lange Striche statt Bindestriche, und die Fehlerausgabe
    eines nativen Programms kommt in PowerShell nicht immer an. Hier stehen
    die Zeichen fest, und die Ausgabe wird eingesammelt.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\scripts\build-windows.ps1
#>

[CmdletBinding()]
param(
    [string] $Verzeichnis = "C:\Users\ikwyg\Documents\Developer\CodeBox"
)

$ErrorActionPreference = "Continue"

function Info([string] $Text)    { Write-Host "    $Text" }
function Gut([string] $Text)     { Write-Host "    $Text" -ForegroundColor Green }
function Warnung([string] $Text) { Write-Host "    $Text" -ForegroundColor Yellow }
function Fehler([string] $Text)  { Write-Host "    $Text" -ForegroundColor Red }

$cli = Join-Path $Verzeichnis "codebox-cli"
$quelle = Join-Path $cli "src\main.cpp"
$ziel = Join-Path $cli "codebox.exe"

Write-Host ""
Write-Host "  codebox.exe uebersetzen" -ForegroundColor White
Write-Host ""

# --- Quelltext da? ---

if (-not (Test-Path $quelle)) {
    Fehler "Die Quelldatei fehlt: $quelle"
    Fehler "Stimmt -Verzeichnis? Erwartet wird darin der Ordner codebox-cli\src."
    exit 1
}
Gut ("Quelltext: " + $quelle + " (" + (Get-Item $quelle).Length + " Bytes)")

# --- Compiler finden ---

$gpp = ""
foreach ($kandidat in @("C:\msys64\ucrt64\bin\g++.exe",
                        "C:\msys64\mingw64\bin\g++.exe")) {
    if (Test-Path $kandidat) { $gpp = $kandidat; break }
}
if (-not $gpp) {
    $imPfad = Get-Command g++ -ErrorAction SilentlyContinue
    if ($imPfad) { $gpp = $imPfad.Source }
}

if (-not $gpp) {
    Fehler "Kein C++-Compiler gefunden."
    Info "Installieren:"
    Info "  winget install MSYS2.MSYS2"
    Info "  C:\msys64\usr\bin\bash.exe -lc `"pacman -S --noconfirm --needed mingw-w64-ucrt-x86_64-gcc`""
    exit 1
}
Gut "Compiler: $gpp"

$version = & $gpp "--version" 2>&1 | Select-Object -First 1
if ($LASTEXITCODE -ne 0) {
    Fehler "Der Compiler laesst sich nicht ausfuehren (Rueckgabewert $LASTEXITCODE)."
    Fehler ($version | Out-String)
    exit 1
}
Gut "Version:  $version"

# --- Uebersetzen ---

Push-Location $cli
try {
    $protokoll = Join-Path $env:TEMP "codebox-bau.txt"

    function Bauen([string[]] $Schalter, [string] $Beschreibung) {
        Write-Host ""
        Info "Versuch: $Beschreibung"
        Info ("  " + $gpp + " " + ($Schalter -join " "))

        # Alle Ausgabestroeme in eine Datei: Was ein natives Programm nach
        # stderr schreibt, kommt in PowerShell sonst nicht zuverlaessig an.
        & $gpp @Schalter *> $protokoll
        $code = $LASTEXITCODE

        $text = ""
        if (Test-Path $protokoll) { $text = (Get-Content $protokoll -Raw) }

        if ($code -eq 0 -and (Test-Path $ziel)) {
            if ($text -and $text.Trim() -ne "") {
                Warnung "Der Compiler hatte Anmerkungen:"
                Write-Host $text
            }
            return $true
        }

        Fehler "Fehlgeschlagen (Rueckgabewert $code)."
        if ($text -and $text.Trim() -ne "") {
            Write-Host ""
            Write-Host "--- Ausgabe des Compilers ---" -ForegroundColor Yellow
            Write-Host $text
            Write-Host "--- Ende der Ausgabe ---" -ForegroundColor Yellow
        } else {
            Fehler "Der Compiler hat nichts ausgegeben."
        }
        return $false
    }

    if (Test-Path $ziel) { Remove-Item $ziel -Force }

    $fertig = Bauen @("-std=c++17", "-Wall", "-Wextra", "-O2", "-static",
                      "src/main.cpp", "-o", "codebox.exe") "statisch gebunden"

    if (-not $fertig) {
        $fertig = Bauen @("-std=c++17", "src/main.cpp", "-o", "codebox.exe") "ohne Zusatzschalter"
        if ($fertig) {
            Warnung "Ohne -static gebaut. Fehlt beim Start eine DLL, gehoert"
            Warnung "C:\msys64\ucrt64\bin in den Path."
        }
    }

    Write-Host ""
    if ($fertig) {
        $groesse = [math]::Round((Get-Item $ziel).Length / 1KB)
        Write-Host "  Fertig: $ziel ($groesse KB)" -ForegroundColor Green
        Write-Host ""
        Write-Host "  Ausprobieren:"
        Write-Host "    cd `"$cli`""
        Write-Host "    .\codebox.exe --help"
        Write-Host "    .\codebox.exe login        # http://localhost:8787, demo / codebox2026"
    } else {
        Write-Host "  Es hat nicht geklappt." -ForegroundColor Red
        Write-Host "  Die Ausgabe oben zeigt, woran es liegt. Das vollstaendige"
        Write-Host "  Protokoll steht in: $protokoll"
        exit 1
    }
} finally {
    Pop-Location
}
