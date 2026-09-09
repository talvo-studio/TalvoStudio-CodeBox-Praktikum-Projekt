# CodeBox — die Website

Ein Cloudflare Worker mit einer D1-Datenbank. Nutzer legen Quelltext-Dateien
ab, sehen sie im Browser an und geben sie über einen kurzen Code weiter. Wer
den Code hat, kommt an die Datei — ohne Konto, ohne Anmeldung.

## Lokal starten

Voraussetzung: Node 20 oder neuer.

```
npm install
cp .dev.vars.example .dev.vars        # Windows: copy .dev.vars.example .dev.vars
npm run db:local                      # Tabellen anlegen
npm run demo:local                    # optional: Demo-Bestand
npm run dev                           # http://localhost:8787
```

Der Demo-Bestand legt den Zugang **demo** mit dem Passwort **codebox2026** an,
dazu drei Beispieldateien — eine davon bereits geteilt unter dem Code
`K3M92X`.

Ohne Demo-Bestand: auf `/registrieren` ein Konto anlegen. Dafür wird der
Einladungscode aus `.dev.vars` gebraucht (voreingestellt `bfia25`).

## Die Seiten

| Adresse | Wer darf | Wozu |
| --- | --- | --- |
| `/` | alle | Erklärung, Feld zum Einlösen eines Codes |
| `/registrieren` | alle | Konto anlegen, mit Einladungscode |
| `/anmelden`, `/abmelden` | alle | Sitzung beginnen und beenden |
| `/box` | angemeldet | eigene Dateien, Suche, Hochladen |
| `/f/<id>` | Besitzer | eine Datei ansehen, teilen, löschen |
| `/f/<id>/raw` | Besitzer | Original herunterladen |
| `/s/<code>` | alle | geteilte Datei ansehen |
| `/s/<code>/raw` | alle | geteilte Datei herunterladen |
| `/statistik` | angemeldet | Zahlen zur eigenen Box |

## Die Schnittstelle für das Werkzeug

Alles unter `/api/` gibt JSON zurück, leitet nie weiter und erwartet den
Token im Kopf `Authorization: Bearer <token>`.

| Weg | Wirkung |
| --- | --- |
| `POST /api/login` | Nickname und Passwort rein, Token raus |
| `GET /api/files` | Liste der eigenen Dateien |
| `POST /api/files` | Datei hochladen (`{"name": ..., "inhalt": ...}`) |
| `GET /api/files/<id>` | eine Datei samt Inhalt |
| `POST /api/files/<id>/share` | teilen, gibt Code und Link zurück |

Zum Ausprobieren ohne das Werkzeug (unter Windows in PowerShell `curl.exe`
schreiben, sonst greift ein anderer Befehl):

```
curl -X POST http://localhost:8787/api/login \
  -H "Content-Type: application/json" \
  -d '{"nickname":"demo","passwort":"codebox2026"}'

curl http://localhost:8787/api/files -H "Authorization: Bearer DEINTOKEN"
```

Die Prüfungen für Endung, Größe und Dateizahl sind dieselben Funktionen wie
im Formular-Weg — nicht kopiert, sondern derselbe Code. Eine Prüfung, die nur
im Formular steckt, wäre eine Tür ohne Schloss.

## Datenmodell

`schema.sql` legt drei Tabellen an:

```
users     id, nickname (UNIQUE), password_hash, salt, created_at
sessions  token_hash (PRIMARY KEY), user_id, expires_at, source
files     id, user_id, name, content, size, share_code (UNIQUE), created_at
```

Der Dateiinhalt liegt als Text in der Datenbank. Für Quelltext ist das genau
richtig — eine `.cpp` sind ein paar Kilobyte. Für Bilder oder Videos wäre es
falsch, dafür gibt es eigene Dienste.

`source` in `sessions` unterscheidet `web` von `cli`: So ist zu sehen, welche
Sitzung vom Browser kommt und welche vom Kommandozeilen-Werkzeug.

Einspielen — es gibt **zwei** Datenbanken, eine lokale für `wrangler dev` und
die echte bei Cloudflare. Eine Schema-Änderung muss in beide:

```
npm run db:local       # npx wrangler d1 execute codebox --local  --file=./schema.sql
npm run db:remote      # npx wrangler d1 execute codebox --remote --file=./schema.sql
```

Nachsehen, was drin steht:

```
npx wrangler d1 execute codebox --local --command "SELECT id, name, size FROM files"
```

## Was an Sicherheit eingebaut ist

| Thema | Umsetzung |
| --- | --- |
| Passwörter | PBKDF2-SHA256, 100 000 Runden, eigener Salt je Nutzer. Nie im Klartext gespeichert. bcrypt und argon2 laufen auf Workers nicht |
| Vergleiche | Passwort- und Codevergleich laufen immer bis zum Ende, damit die Dauer nichts verrät |
| Sitzungen | 32 zufällige Bytes; in der Datenbank liegt nur der SHA-256-Hash. Cookie mit `HttpOnly`, `Secure`, `SameSite=Lax`, sieben Tage |
| XSS | Jeder fremde Text wird escaped, bevor er in HTML landet — Inhalt, Dateiname, Nickname |
| Downloads | `text/plain`, `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` |
| SQL-Injection | Ausschließlich Platzhalter mit `.bind()`, nie zusammengeklebtes SQL |
| Fremdzugriff | „Gehört mir" steht in der Abfrage (`WHERE id = ? AND user_id = ?`), nicht in einer Prüfung danach |
| Uploads | Erlaubte Endungen werden aufgezählt, nicht verboten. 256 KB je Datei, 100 Dateien je Nutzer, Dateiname wird gesäubert |
| Weiterleitungen | Das Ziel nach dem Anmelden muss mit einem einzelnen `/` beginnen — sonst führt ein Link auf eine fremde Seite |
| Registrierung | Nur mit Einladungscode, der als Secret liegt und nicht im Quelltext steht |

Der Angriffstest aus der Aufgabenstellung: eine Datei mit
`<script>alert("kaputt")</script>` hochladen und aufrufen. Es darf kein
Fenster aufgehen — man muss den Text lesen können.

## Veröffentlichen

```
npx wrangler login
npx wrangler d1 create codebox      # gibt die database_id aus
```

Die ausgegebene ID in `wrangler.jsonc` eintragen, dann:

```
npm run db:remote
npx wrangler secret put INVITE_CODE
npm run deploy
```

Die Adresse steht danach in der Ausgabe. Live zusehen, was der Worker
protokolliert:

```
npm run tail
```

## Wenn etwas klemmt

**„D1 database not found"**
`npm run db:local` läuft noch nicht durch oder die `database_id` fehlt. Lokal
ist die ID beliebig, im Netz muss sie stimmen.

**Registrierung sagt, es sei kein Einladungscode hinterlegt**
`.dev.vars` fehlt (lokal) oder das Secret `INVITE_CODE` ist nicht gesetzt
(im Netz). Ohne Code bleibt die Registrierung absichtlich geschlossen.

**Der Port ist belegt**
`npx wrangler dev --port 8788` — dann in `codebox login` dieselbe Adresse
angeben.
