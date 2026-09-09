# CodeBox — Praktikumsprojekt, fertige Fassung

Quelltext ablegen, im Browser ansehen und über einen kurzen Code weitergeben.
Zwei Teile, die zusammengehören:

```
codebox-web/    Die Website: Cloudflare Worker mit D1-Datenbank
codebox-cli/    Das Werkzeug: ein C++17-Programm für die Kommandozeile
scripts/        Einrichtung auf einem Windows-Rechner
```

```
codebox share main.cpp

    Code:  K3M92X
    Link:  http://localhost:8787/s/K3M92X
```

Diesen Code liest man jemandem vor, und der holt sich die Datei — im Browser
oder mit `codebox download K3M92X`, ohne Konto.

## Wozu dieses Repository da ist

Das ist die **fertige Fassung** des Praktikumsprojekts „CodeBox — Quelltext
teilen (C++)" aus dem Praktikumsportal. Sie ist dazu da, das Ziel
vorzuführen: So sieht aus, was am Ende der Wochen dastehen soll.

Es ist ausdrücklich **nicht** die Arbeit eines Praktikanten und gehört nicht
als Vorlage in seine Hände — die Aufgabenstellung führt in 31 Schritten
dorthin, mit gestaffelten Tipps, und der Weg ist der Sinn der Sache. Wer den
fertigen Quelltext vorher sieht, überspringt genau das, was gelernt werden
soll.

## Auf einem Windows-Rechner starten

Drei Zeilen in PowerShell. Git muss vorhanden sein (`winget install Git.Git`),
alles Weitere holt das Skript auf Nachfrage.

```powershell
git clone https://github.com/talvo-studio/TalvoStudio-CodeBox-Praktikum-Projekt.git C:\Users\ikwyg\Documents\Developer\CodeBox
cd C:\Users\ikwyg\Documents\Developer\CodeBox
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
```

Das Skript prüft die Werkzeuge, installiert die Abhängigkeiten, legt die
Datenbank an, spielt einen Demo-Bestand ein, übersetzt das C++-Werkzeug und
startet die Website auf `http://localhost:8787`.

Anderer Ort: `-Verzeichnis D:\Projekte\CodeBox`. Ohne das Werkzeug:
`-OhneWerkzeug`. Nur einrichten, nicht starten: `-KeinStart`.

## Jeden Tag danach: starten

Die Website läuft nur, solange ihr Fenster offen ist. Zum Starten:

```powershell
powershell -ExecutionPolicy Bypass -File C:\Users\ikwyg\Documents\Developer\CodeBox\scripts\start-windows.ps1
```

Oder von Hand — wichtig ist der Ordner `codebox-web`, dort liegt die
`package.json`:

```powershell
cd C:\Users\ikwyg\Documents\Developer\CodeBox\codebox-web
npm run dev
```

Das Werkzeug braucht ein **zweites** Fenster, während das erste läuft.

## Auf macOS oder Linux starten

```bash
cd codebox-web
npm install
cp .dev.vars.example .dev.vars
npm run db:local          # Tabellen anlegen
npm run demo:local        # Demo-Bestand
npm run dev               # http://localhost:8787
```

In einem zweiten Fenster das Werkzeug:

```bash
cd codebox-cli
make
./codebox login           # Adresse http://localhost:8787, demo / codebox2026
./codebox list
./codebox share src/main.cpp
```

## Der Demo-Bestand

| | |
| --- | --- |
| Zugang | `demo` |
| Passwort | `codebox2026` |
| Einladungscode | `bfia25` (für eigene Registrierungen) |
| Bereits geteilt | `/s/K3M92X` — die Datei `hallo.cpp` |

Dazu drei Beispieldateien in der Box. Der Bestand ist Wegwerf-Material für
die Vorführung; er liegt in der lokalen Datenbank und geht niemanden etwas
an, der die Seite später wirklich betreibt.

## In fünf Minuten vorführen

1. `http://localhost:8787` — die Startseite erklärt in drei Sätzen, worum es geht.
2. Anmelden als `demo`, **Meine CodeBox** zeigt die Dateien mit Größe und Datum.
3. Eine Datei öffnen: Quelltext, Herunterladen, Löschen, **Teilen**.
4. Den erzeugten Link in einem privaten Fenster öffnen — ohne Anmeldung sichtbar.
5. Zweites Fenster, `codebox share <datei>` — derselbe Bestand, ohne Browser.
6. Der Angriffstest: `angriff.py` mit `<script>alert("kaputt")</script>`
   hochladen und aufrufen. Es geht kein Fenster auf, man liest den Text.
   Dreißig Sekunden, die mehr erklären als jede Folie.

## Was gebaut ist

**Website** — Registrierung mit Einladungscode, Anmeldung mit Sitzungs-Cookie,
Abmelden, geschützte Seiten mit Rücksprung zum Ziel, Hochladen mit Prüfung von
Endung, Größe und Anzahl, Liste mit Suche, Dateiansicht, Herunterladen,
Löschen mit Rückfrage, Teilen und Zurücknehmen, öffentliche Abholseite,
Code-Einlösefeld, Statistikseite, JSON-Schnittstelle für das Werkzeug,
Fehlerseite statt Absturz.

**Werkzeug** — `login`, `list`, `upload`, `share`, `download`, Hilfe. Verdeckte
Passworteingabe, Zugang in `~/.codebox/config`, Ausweichen statt Überschreiben
beim Herunterladen, verständliche Meldungen bei jedem Fehlerfall.

Dazu die Sicherheitsarbeit, die in der Aufgabenstellung den größten Raum
einnimmt: PBKDF2 mit Salt statt gespeicherter Passwörter, Sitzungsschlüssel
nur als Hash in der Datenbank, HTML-Escaping an jeder Stelle, wo fremder Text
ausgegeben wird, `nosniff` und `attachment` bei Downloads, Platzhalter statt
zusammengeklebtem SQL, Besitzprüfung in der Abfrage statt daneben, und
Zugangsdaten, die nie über die Kommandozeile an curl gehen.

Die Einzelheiten stehen in den beiden Anleitungen:
[codebox-web/README.md](codebox-web/README.md) und
[codebox-cli/README.md](codebox-cli/README.md).

## Ins Netz stellen

Lokal läuft alles ohne Cloudflare-Konto. Wer die Seite wirklich
veröffentlichen will, braucht eines — kostenlos, und für ein Schulprojekt
weit unterhalb jeder Grenze. Der Weg steht in
[codebox-web/README.md](codebox-web/README.md#veröffentlichen).
