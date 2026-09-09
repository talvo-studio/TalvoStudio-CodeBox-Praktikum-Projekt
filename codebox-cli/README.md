# codebox — das Werkzeug

Quelltext hochladen, auflisten, teilen und geteilte Dateien holen — ohne
Browser. Ein einziges Programm, das nach dem Übersetzen als eigene Datei auf
dem Rechner liegt und von überall aufgerufen werden kann.

```
codebox share main.cpp

    Code:  K3M92X
    Link:  http://localhost:8787/s/K3M92X
```

Diesen Code liest man jemandem vor, und der holt sich die Datei.

## Was drin steckt

C++17 und sonst nichts — keine fremde Bibliothek, ein einziger
Übersetzungsbefehl. Fürs Netz ruft das Programm `curl` auf, das auf Windows 10
und 11, macOS und Linux schon vorhanden ist.

Das ist eine bewusste Entscheidung: Die C++-Standardbibliothek kann kein
Netzwerk. Wer HTTPS selbst sprechen will, bindet eine fremde Bibliothek ein,
lässt sie übersetzen und liefert sie auf jedem Rechner mit. Ein anderes
Programm aufzurufen ist hier der kleinere Weg — und genau der Gedanke, nach
dem die Kommandozeile gebaut ist.

## Übersetzen

```
g++ -std=c++17 -Wall -Wextra -O2 src/main.cpp -o codebox
```

Oder kürzer, wenn `make` da ist:

```
make
```

Unter Windows heißt die entstandene Datei `codebox.exe`.

**Compiler, falls noch keiner da ist**

| System | Weg |
| --- | --- |
| Windows | MSYS2 von msys2.org, dann `pacman -S mingw-w64-ucrt-x86_64-gcc` im Fenster „MSYS2 UCRT64" |
| macOS | `xcode-select --install` |
| Linux | `sudo apt install g++` |

Prüfen, dass beides da ist:

```
g++ --version
curl --version
```

## Von überall aufrufbar machen

Bis hierher startet das Programm nur mit `./codebox` aus seinem Ordner. Damit
`codebox` in jedem Fenster funktioniert, muss die Datei dort liegen, wo das
System nach Befehlen sucht — dieser Ort heißt PATH.

**Linux und macOS**

```
make installieren
```

Das kopiert nach `~/.local/bin`. Steht der Ordner noch nicht im PATH, kommt
diese Zeile ans Ende von `~/.bashrc` oder `~/.zshrc`:

```
export PATH="$HOME/.local/bin:$PATH"
```

**Windows**

Die `codebox.exe` nach `C:\msys64\ucrt64\bin\` kopieren. Soll sie auch
außerhalb von MSYS2 laufen, gehört ihr Ordner in die Umgebungsvariable Path —
über „Umgebungsvariablen für dieses Konto bearbeiten" in den Einstellungen.

Danach in einem **neuen** Fenster prüfen: `codebox --help`

## Befehle

| Befehl | Wirkung |
| --- | --- |
| `codebox login` | Anmelden; Serveradresse, Nickname und Passwort werden abgefragt |
| `codebox list` | Eigene Dateien anzeigen, mit Größe, Datum und Teil-Code |
| `codebox upload <datei>` | Datei hochladen |
| `codebox share <datei>` | Hochladen und einen Teil-Code erzeugen |
| `codebox download <code>` | Geteilte Datei holen — ohne Anmeldung |

Beispiele:

```
codebox login
codebox upload main.cpp
codebox list
codebox share aufgabe3.cpp
codebox download K3M92X
codebox download K3M92X -o kopie.cpp
```

`download` weicht auf `name-2.cpp` aus, wenn im aktuellen Ordner schon eine
Datei so heißt — es überschreibt nie von selbst. Mit `-o` bestimmst du das
Ziel; dann gilt deine Angabe, auch wenn dort etwas liegt.

## Wo liegt der Zugang

```
~/.codebox/config          Linux, macOS
%USERPROFILE%\.codebox\config   Windows
```

Darin stehen Serveradresse, Zugangstoken und Nickname — **nicht** das
Passwort. Zum Abmelden die Datei löschen.

Die Datei wird so angelegt, dass nur der eigene Benutzer sie lesen darf.
Unter Windows greift diese Einschränkung nicht so wie unter Linux und macOS;
auf einem geteilten Rechner ist das ein Punkt, den man wissen sollte.

Der Token wird nie als Aufrufargument an curl übergeben, sondern über eine
Konfigurationsdatei, die danach gelöscht wird. Der Grund: Was beim Aufruf
mitgegeben wird, steht in der Prozessliste des Systems und ist für andere
Nutzer desselben Rechners sichtbar.

## Wenn etwas nicht geht

**„codebox" wird nicht gefunden**
Das Programm liegt noch nicht im PATH — siehe oben. Aus dem Projektordner
heraus geht es immer mit `./codebox` (Windows: `.\codebox.exe`).

**„Nicht angemeldet"**
`codebox login` ausführen.

**„Der Server ist nicht erreichbar"**
Läuft der Worker? Im Ordner `codebox-web` startet ihn `npx wrangler dev`.
Und stimmt die Adresse in der Konfigurationsdatei? `codebox login` fragt sie
neu ab.

**„Dein Zugang ist abgelaufen"**
Eine Sitzung gilt sieben Tage. `codebox login` erneuern.

**Der Compiler meldet Fehler zu `<filesystem>`**
Dann fehlt `-std=c++17` oder der Compiler ist zu alt. `g++ --version` prüfen;
gebraucht wird GCC 8 oder neuer.
