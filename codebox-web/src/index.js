/**
 * CodeBox — Quelltext ablegen und über einen kurzen Code teilen.
 *
 * Ein Cloudflare Worker mit einer D1-Datenbank. Zwei Türen führen hinein:
 *
 *   - Die Wege für Menschen geben HTML zurück, arbeiten mit Formularen und
 *     einem Sitzungs-Cookie und leiten nach jedem POST weiter.
 *   - Die Wege unter /api/ geben JSON zurück und erwarten einen Token im
 *     Authorization-Kopf. Sie leiten nie weiter — das Werkzeug auf der
 *     Kommandozeile könnte damit nichts anfangen.
 *
 * Beide Türen benutzen dieselben Prüfungen (pruefeDatei, saubererName) und
 * dieselbe Sitzungsverwaltung. Eine Prüfung, die nur im Formular steckt,
 * wäre eine Tür ohne Schloss.
 */

/* ------------------------------------------------------------------ *
 * Einstellungen
 * ------------------------------------------------------------------ */

/** Wiederholungen beim Passwort-Hash. Absichtlich langsam. */
const ITERATIONEN = 100000;

/** Wie lange eine Anmeldung gilt. */
const SITZUNG_TAGE = 7;

const MAX_BYTES = 256 * 1024;
const MAX_DATEIEN = 100;

/**
 * Erlaubt wird aufgezählt, nicht verboten. Eine Verbotsliste vergisst immer
 * etwas. `.html` fehlt hier mit Absicht.
 */
const ERLAUBTE_ENDUNGEN = [
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".java",
  ".py", ".js", ".ts", ".php", ".rb", ".go", ".rs",
  ".sql", ".sh", ".css", ".json", ".xml", ".yml", ".yaml",
  ".md", ".txt", ".csv",
];

/**
 * 32 Zeichen ohne I, O, 0 und 1: Die verwechselt man beim Vorlesen und
 * beim Abtippen von einem Zettel.
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LAENGE = 6;

/* ------------------------------------------------------------------ *
 * Kleine Helfer
 * ------------------------------------------------------------------ */

function zuHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function ausHex(hex) {
  const aus = new Uint8Array(hex.length / 2);
  for (let i = 0; i < aus.length; i++) {
    aus[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return aus;
}

/**
 * Fremder Text darf nie ungeprüft in eine HTML-Seite: Sonst führt der
 * Browser aus, was jemand hochgeladen hat (Cross-Site-Scripting).
 * Das & muss zuerst ersetzt werden, sonst verdoppelt sich die Ersetzung.
 */
function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function groesse(bytes) {
  if (bytes < 1024) return bytes + " B";
  return Math.round(bytes / 1024) + " KB";
}

function datum(iso) {
  const d = new Date(iso);
  const zwei = (n) => String(n).padStart(2, "0");
  return zwei(d.getDate()) + "." + zwei(d.getMonth() + 1) + "." + d.getFullYear();
}

async function sha256Hex(text) {
  const bits = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return zuHex(new Uint8Array(bits));
}

/* ------------------------------------------------------------------ *
 * Passwörter
 *
 * Gespeichert wird nie das Passwort, sondern ein Hash mit eigenem Salt je
 * Nutzer. bcrypt und argon2 laufen auf Workers nicht — PBKDF2 steckt in
 * crypto.subtle und ist genau dafür da.
 * ------------------------------------------------------------------ */

async function hashMitSalt(passwort, saltHex) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passwort),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: ausHex(saltHex), iterations: ITERATIONEN },
    key,
    256,
  );
  return zuHex(new Uint8Array(bits));
}

async function passwortSpeichern(passwort) {
  const saltHex = zuHex(crypto.getRandomValues(new Uint8Array(16)));
  return { saltHex, hashHex: await hashMitSalt(passwort, saltHex) };
}

async function passwortPruefen(passwort, saltHex, hashHex) {
  return gleichLang(await hashMitSalt(passwort, saltHex), hashHex);
}

/**
 * Vergleicht immer bis zum Ende. Ein Vergleich, der beim ersten Unterschied
 * abbricht, verrät über die Dauer, wie weit man richtig lag.
 */
function gleichLang(a, b) {
  if (a.length !== b.length) return false;
  let unterschied = 0;
  for (let i = 0; i < a.length; i++) {
    unterschied |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return unterschied === 0;
}

/* ------------------------------------------------------------------ *
 * Sitzungen
 * ------------------------------------------------------------------ */

const COOKIE = "session";

function cookieLesen(request, name) {
  const kopf = request.headers.get("Cookie") || "";
  for (const teil of kopf.split(";")) {
    const [k, ...rest] = teil.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

function sitzungsCookie(token) {
  return (
    COOKIE + "=" + token +
    "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=" +
    SITZUNG_TAGE * 24 * 60 * 60
  );
}

/** Löschen heißt: dasselbe Cookie mit Max-Age 0 noch einmal setzen. */
const LOESCH_COOKIE = COOKIE + "=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

async function sitzungAnlegen(userId, env, quelle) {
  const token = zuHex(crypto.getRandomValues(new Uint8Array(32)));
  const ablauf = new Date(Date.now() + SITZUNG_TAGE * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at, source) VALUES (?, ?, ?, ?)",
  )
    .bind(await sha256Hex(token), userId, ablauf, quelle || "web")
    .run();
  return token;
}

async function sitzungPruefen(tokenHash, env) {
  const zeile = await env.DB.prepare(
    "SELECT u.id, u.nickname, s.expires_at FROM sessions s " +
      "JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
  )
    .bind(tokenHash)
    .first();

  if (!zeile) return null;

  if (zeile.expires_at < new Date().toISOString()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }
  return { id: zeile.id, nickname: zeile.nickname };
}

/** Für den Browser: Sitzung aus dem Cookie. */
async function nutzerAusAnfrage(request, env) {
  const token = cookieLesen(request, COOKIE);
  if (!token) return null;
  return sitzungPruefen(await sha256Hex(token), env);
}

/** Für das Kommandozeilen-Werkzeug: Sitzung aus dem Authorization-Kopf. */
async function nutzerAusToken(request, env) {
  const kopf = request.headers.get("Authorization") || "";
  if (!kopf.startsWith("Bearer ")) return null;
  return sitzungPruefen(await sha256Hex(kopf.slice(7)), env);
}

/* ------------------------------------------------------------------ *
 * Dateien: Prüfungen und Teilen
 * ------------------------------------------------------------------ */

/**
 * Ein Dateiname kommt von einem fremden Rechner. Übrig bleibt der letzte
 * Teil hinter dem letzten Schrägstrich, und darin nur harmlose Zeichen.
 */
function saubererName(roh) {
  const nurName = String(roh).split(/[\\/]/).pop();
  const sauber = nurName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  return sauber === "" || sauber === "." || sauber === ".." ? "datei.txt" : sauber;
}

function endungVon(name) {
  const punkt = name.lastIndexOf(".");
  return punkt === -1 ? "" : name.slice(punkt).toLowerCase();
}

/** Gibt einen Fehlertext zurück — oder null, wenn alles in Ordnung ist. */
function pruefeDatei(name, inhalt) {
  const endung = endungVon(name);
  if (!ERLAUBTE_ENDUNGEN.includes(endung)) {
    return (
      (endung ? "„" + endung + "“ geht nicht. " : "Ohne Dateiendung geht es nicht. ") +
      "CodeBox nimmt Quelltext: " + ERLAUBTE_ENDUNGEN.join(" ") + "."
    );
  }
  if (inhalt.length === 0) return "Die Datei ist leer.";
  if (inhalt.length > MAX_BYTES) {
    return (
      "Die Datei ist " + groesse(inhalt.length) + " groß. Erlaubt sind höchstens " +
      groesse(MAX_BYTES) + "."
    );
  }
  return null;
}

async function anzahlDateien(userId, env) {
  const { anzahl } = await env.DB.prepare(
    "SELECT COUNT(*) AS anzahl FROM files WHERE user_id = ?",
  )
    .bind(userId)
    .first();
  return anzahl;
}

function neuerCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LAENGE));
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

/**
 * Gibt den Teil-Code zurück. Ist die Datei schon geteilt, bleibt der alte
 * Code — zweimal auf "Teilen" zu drücken soll keinen zweiten Link erzeugen.
 */
async function teilen(dateiId, nutzerId, env) {
  const vorhanden = await env.DB.prepare(
    "SELECT share_code FROM files WHERE id = ? AND user_id = ?",
  )
    .bind(dateiId, nutzerId)
    .first();

  if (!vorhanden) return null;
  if (vorhanden.share_code) return vorhanden.share_code;

  // Bei über einer Milliarde Möglichkeiten ist eine Kollision so gut wie
  // ausgeschlossen — aber "so gut wie" ist nicht "ausgeschlossen".
  for (let versuch = 0; versuch < 5; versuch++) {
    const code = neuerCode();
    try {
      await env.DB.prepare(
        "UPDATE files SET share_code = ? WHERE id = ? AND user_id = ?",
      )
        .bind(code, dateiId, nutzerId)
        .run();
      return code;
    } catch (fehler) {
      // Code war vergeben — nächster Versuch.
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Oberfläche
 * ------------------------------------------------------------------ */

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  max-width: 44rem; margin: 0 auto; padding: 1.5rem 1rem 4rem;
  color: #1a1a1a; background: #fdfdfc; line-height: 1.6;
}
a { color: #2b5fd9; }
nav {
  display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
  padding-bottom: 1rem; margin-bottom: 2rem; border-bottom: 1px solid #e7e7e4;
  font-size: 0.9rem;
}
nav .marke { font-weight: 600; color: #1a1a1a; text-decoration: none; }
nav .rechts { margin-left: auto; display: flex; align-items: center; gap: 0.75rem; }
nav .wer { color: #777; }
h1 { font-size: 1.6rem; margin: 0 0 0.5rem; }
h2 { font-size: 1.1rem; margin: 2.5rem 0 0.5rem; }
label { display: block; margin-top: 1rem; font-size: 0.9rem; color: #555; }
input[type=text], input[type=password], input:not([type]) {
  width: 100%; padding: 0.5rem; font: inherit;
  border: 1px solid #ccc; border-radius: 4px; background: #fff;
}
input[type=file] { margin-top: 0.5rem; font: inherit; max-width: 100%; }
button, .knopf {
  display: inline-block; margin-top: 1rem; padding: 0.6rem 1.2rem; font: inherit;
  background: #1a1a1a; color: #fff; border: 0; border-radius: 4px;
  cursor: pointer; text-decoration: none;
}
button.gefahr { background: #b00020; }
button.leise { background: none; color: #2b5fd9; padding: 0; margin: 0; }
form.inline { display: inline; }
table { width: 100%; border-collapse: collapse; margin: 1rem 0; display: block; overflow-x: auto; }
th, td { text-align: left; padding: 0.5rem 0.5rem 0.5rem 0; border-bottom: 1px solid #ececea; white-space: nowrap; }
th { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #888; font-weight: 600; }
td.zahl, th.zahl { text-align: right; }
pre {
  background: #f6f6f4; padding: 1rem; overflow-x: auto; border-radius: 4px;
  font-size: 0.85rem; line-height: 1.5; border: 1px solid #ececea;
}
.fehler { color: #b00020; }
.leer, .hinweis { color: #777; font-size: 0.9rem; }
.teilen { background: #f6f6f4; border: 1px solid #ececea; border-radius: 4px; padding: 1rem; margin: 1rem 0; }
.teilen .code { font-size: 1.4rem; font-weight: 600; letter-spacing: 0.1em; }
.code-eingabe { text-transform: uppercase; }
footer { margin-top: 4rem; padding-top: 1rem; border-top: 1px solid #e7e7e4; color: #999; font-size: 0.8rem; }
`;

/**
 * Das Seitengerüst. Steht an genau einer Stelle — so kann der Content-Type
 * nicht vergessen werden und die Navigation nicht auseinanderlaufen.
 *
 * optionen.oeffentlich: schlanke Navigation für Seiten, die Fremde sehen.
 * optionen.status:      Statuscode, etwa 404.
 */
function seite(titel, inhalt, nutzer, optionen) {
  const opt = optionen || {};
  const nav = opt.oeffentlich
    ? '<a class="marke" href="/">CodeBox</a>'
    : nutzer
      ? '<a class="marke" href="/">CodeBox</a>' +
        '<a href="/box">Meine CodeBox</a>' +
        '<a href="/statistik">Zahlen</a>' +
        '<span class="rechts"><span class="wer">' + escapeHtml(nutzer.nickname) + "</span>" +
        '<form method="post" action="/abmelden" class="inline">' +
        '<button class="leise">Abmelden</button></form></span>'
      : '<a class="marke" href="/">CodeBox</a>' +
        '<span class="rechts"><a href="/anmelden">Anmelden</a>' +
        '<a href="/registrieren">Registrieren</a></span>';

  const html =
    '<!doctype html><html lang="de"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<link rel="stylesheet" href="/style.css">' +
    "<title>" + escapeHtml(titel) + " — CodeBox</title></head><body>" +
    "<nav>" + nav + "</nav>" +
    inhalt +
    "<footer>CodeBox — Quelltext teilen</footer>" +
    "</body></html>";

  return new Response(html, {
    status: opt.status || 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function nichtGefunden(nutzer, oeffentlich) {
  return seite(
    "Nicht gefunden",
    "<h1>Nicht gefunden</h1><p>Diese Seite gibt es nicht.</p>" +
      '<p><a href="/">Zur Startseite</a></p>',
    nutzer,
    { status: 404, oeffentlich: oeffentlich },
  );
}

/** Antwort mit Weiterleitung und optional einem Cookie. */
function weiter(ziel, cookie) {
  const kopf = { Location: ziel };
  if (cookie) kopf["Set-Cookie"] = cookie;
  return new Response(null, { status: 303, headers: kopf });
}

function zurAnmeldung(url) {
  return weiter("/anmelden?weiter=" + encodeURIComponent(url.pathname));
}

/**
 * Ein Ziel aus der Adresse darf nur auf die eigene Seite zeigen.
 * "//fremde.example" wäre eine fremde Adresse.
 */
function sicheresZiel(wert) {
  if (typeof wert === "string" && wert.startsWith("/") && !wert.startsWith("//")) {
    return wert;
  }
  return "/box";
}

/** Der nackte Dateiinhalt — niemals als text/html. */
function alsDatei(name, inhalt) {
  return new Response(inhalt, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": 'attachment; filename="' + saubererName(name) + '"',
    },
  });
}

/* ------------------------------------------------------------------ *
 * Formulare
 * ------------------------------------------------------------------ */

function registrierFormular(fehler, nickname) {
  return seite(
    "Registrieren",
    "<h1>Konto anlegen</h1>" +
      (fehler ? '<p class="fehler">' + escapeHtml(fehler) + "</p>" : "") +
      '<form method="post" action="/registrieren">' +
      '<label for="n">Nickname</label>' +
      '<input id="n" name="nickname" value="' + escapeHtml(nickname || "") +
      '" required minlength="3" maxlength="20" autofocus>' +
      '<label for="p">Passwort</label>' +
      '<input id="p" name="passwort" type="password" required minlength="8">' +
      '<label for="p2">Passwort wiederholen</label>' +
      '<input id="p2" name="passwort2" type="password" required>' +
      '<label for="c">Einladungscode</label>' +
      '<input id="c" name="code" required>' +
      "<button>Konto anlegen</button></form>" +
      '<p class="hinweis">Schon ein Konto? <a href="/anmelden">Anmelden</a></p>',
    null,
  );
}

function anmeldeFormular(fehler, nickname, ziel) {
  return seite(
    "Anmelden",
    "<h1>Anmelden</h1>" +
      (fehler ? '<p class="fehler">' + escapeHtml(fehler) + "</p>" : "") +
      '<form method="post" action="/anmelden?weiter=' + encodeURIComponent(ziel) + '">' +
      '<label for="n">Nickname</label>' +
      '<input id="n" name="nickname" value="' + escapeHtml(nickname || "") +
      '" required autofocus>' +
      '<label for="p">Passwort</label>' +
      '<input id="p" name="passwort" type="password" required>' +
      "<button>Anmelden</button></form>" +
      '<p class="hinweis">Noch kein Konto? <a href="/registrieren">Registrieren</a></p>',
    null,
  );
}

/* ------------------------------------------------------------------ *
 * Die Schnittstelle für das Kommandozeilen-Werkzeug
 * ------------------------------------------------------------------ */

function json(daten, status) {
  return new Response(JSON.stringify(daten), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function api(request, env, url) {
  const pfad = url.pathname;

  if (pfad === "/api/login" && request.method === "POST") {
    const daten = await request.json().catch(() => ({}));
    const nickname = String(daten.nickname || "").trim();

    const zeile = await env.DB.prepare(
      "SELECT id, nickname, password_hash, salt FROM users WHERE nickname = ?",
    )
      .bind(nickname)
      .first();

    const stimmt =
      zeile && (await passwortPruefen(String(daten.passwort || ""), zeile.salt, zeile.password_hash));

    if (!stimmt) return json({ fehler: "Nickname oder Passwort stimmt nicht." }, 401);

    const token = await sitzungAnlegen(zeile.id, env, "cli");
    return json({ token: token, nickname: zeile.nickname });
  }

  // Alles Weitere braucht einen gültigen Token.
  const nutzer = await nutzerAusToken(request, env);
  if (!nutzer) return json({ fehler: "Nicht angemeldet." }, 401);

  if (pfad === "/api/files" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, name, size, share_code, created_at FROM files " +
        "WHERE user_id = ? ORDER BY created_at DESC",
    )
      .bind(nutzer.id)
      .all();
    return json({ dateien: results });
  }

  if (pfad === "/api/files" && request.method === "POST") {
    const daten = await request.json().catch(() => ({}));
    const name = saubererName(String(daten.name || ""));
    const inhalt = String(daten.inhalt || "");

    // Dieselben Prüfungen wie im Formular — nicht kopiert, dieselbe Funktion.
    const fehler = pruefeDatei(name, inhalt);
    if (fehler) return json({ fehler: fehler }, 400);

    if ((await anzahlDateien(nutzer.id, env)) >= MAX_DATEIEN) {
      return json(
        { fehler: "Deine CodeBox ist voll (" + MAX_DATEIEN + " Dateien)." },
        400,
      );
    }

    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO files (id, user_id, name, content, size, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(id, nutzer.id, name, inhalt, inhalt.length, new Date().toISOString())
      .run();

    return json({ id: id, name: name, size: inhalt.length }, 201);
  }

  if (pfad.startsWith("/api/files/")) {
    const rest = pfad.slice("/api/files/".length);

    if (rest.endsWith("/share") && request.method === "POST") {
      const code = await teilen(rest.slice(0, -"/share".length), nutzer.id, env);
      if (!code) return json({ fehler: "Datei nicht gefunden." }, 404);
      return json({ code: code, link: url.origin + "/s/" + code });
    }

    if (request.method === "GET") {
      const datei = await env.DB.prepare(
        "SELECT id, name, content, size, share_code, created_at FROM files " +
          "WHERE id = ? AND user_id = ?",
      )
        .bind(rest, nutzer.id)
        .first();
      if (!datei) return json({ fehler: "Datei nicht gefunden." }, 404);
      return json(datei);
    }
  }

  return json({ fehler: "Diesen Weg gibt es nicht." }, 404);
}

/* ------------------------------------------------------------------ *
 * Die Weiche
 * ------------------------------------------------------------------ */

async function behandle(request, env) {
  const url = new URL(request.url);
  const pfad = url.pathname;

  // Die Schnittstelle zuerst: Sie hat eigene Regeln und gibt nie HTML zurück.
  if (pfad.startsWith("/api/")) return api(request, env, url);

  if (pfad === "/style.css") {
    return new Response(CSS, {
      headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "max-age=3600" },
    });
  }

  const nutzer = await nutzerAusAnfrage(request, env);

  /* ---------- öffentlich: geteilte Dateien ---------- */

  // Das Speziellere zuerst, sonst fängt /s/<code> auch /s/<code>/raw ab.
  if (pfad.startsWith("/s/") && pfad.endsWith("/raw")) {
    const code = pfad.slice(3, -4).toUpperCase();
    const datei = await env.DB.prepare(
      "SELECT name, content FROM files WHERE share_code = ?",
    )
      .bind(code)
      .first();
    if (!datei) return new Response("Nicht gefunden", { status: 404 });
    return alsDatei(datei.name, datei.content);
  }

  if (pfad.startsWith("/s/")) {
    const code = pfad.slice(3).toUpperCase();
    const datei = await env.DB.prepare(
      "SELECT name, content, size, created_at FROM files WHERE share_code = ?",
    )
      .bind(code)
      .first();

    if (!datei) {
      return seite(
        "Code unbekannt",
        "<h1>Diesen Code gibt es nicht</h1>" +
          "<p>Vertippt? Ein Code besteht aus 6 Zeichen. Vielleicht wurde die " +
          "Datei auch nicht mehr geteilt.</p>" +
          '<p><a href="/">Zur Startseite</a></p>',
        null,
        { oeffentlich: true, status: 404 },
      );
    }

    return seite(
      datei.name,
      "<h1>" + escapeHtml(datei.name) + "</h1>" +
        '<p class="hinweis">' + groesse(datei.size) + " · " + datum(datei.created_at) +
        " · geteilt über CodeBox</p>" +
        "<pre><code>" + escapeHtml(datei.content) + "</code></pre>" +
        '<p><a class="knopf" href="/s/' + escapeHtml(code) + '/raw">Herunterladen</a></p>' +
        '<p class="hinweis">CodeBox ist ein Ablageort für Quelltext. ' +
        '<a href="/">Mehr dazu</a></p>',
      null,
      { oeffentlich: true },
    );
  }

  if (pfad === "/oeffnen") {
    const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      return seite(
        "Code öffnen",
        '<h1>Code öffnen</h1><p class="fehler">Ein Code besteht aus 6 Buchstaben ' +
          "und Ziffern.</p>" + '<p><a href="/">Zurück</a></p>',
        nutzer,
      );
    }
    return weiter("/s/" + code);
  }

  /* ---------- Startseite ---------- */

  if (pfad === "/") {
    const { anzahl } = await env.DB.prepare(
      "SELECT COUNT(*) AS anzahl FROM users",
    ).first();

    return seite(
      "Start",
      "<h1>CodeBox</h1>" +
        "<p>Quelltext ablegen, im Browser ansehen und über einen kurzen Code " +
        "weitergeben. Wer den Code hat, kommt an die Datei — ohne Konto, ohne " +
        "Anmeldung.</p>" +
        "<h2>Code einlösen</h2>" +
        '<form method="get" action="/oeffnen">' +
        '<input class="code-eingabe" name="code" placeholder="ABC123" required ' +
        'maxlength="6" aria-label="Code">' +
        "<button>Öffnen</button></form>" +
        (nutzer
          ? '<h2>Deine Ablage</h2><p><a href="/box">Zu deiner CodeBox</a></p>'
          : '<h2>Mitmachen</h2><p>Zum Hochladen brauchst du ein Konto und einen ' +
            'Einladungscode. <a href="/registrieren">Konto anlegen</a></p>') +
        '<p class="hinweis">' + anzahl + " Nutzer registriert.</p>",
      nutzer,
    );
  }

  /* ---------- Registrieren ---------- */

  if (pfad === "/registrieren" && request.method === "GET") {
    if (nutzer) return weiter("/box");
    return registrierFormular(null, "");
  }

  if (pfad === "/registrieren" && request.method === "POST") {
    const daten = await request.formData();
    const nickname = String(daten.get("nickname") || "").trim();
    const passwort = String(daten.get("passwort") || "");
    const passwort2 = String(daten.get("passwort2") || "");
    const code = String(daten.get("code") || "").trim();

    if (!env.INVITE_CODE) {
      return registrierFormular(
        "Auf diesem Server ist kein Einladungscode hinterlegt. " +
          "Ohne INVITE_CODE ist die Registrierung geschlossen.",
        nickname,
      );
    }
    if (!gleichLang(code, env.INVITE_CODE)) {
      return registrierFormular("Der Einladungscode stimmt nicht.", nickname);
    }
    if (!/^[a-zA-Z0-9_-]{3,20}$/.test(nickname)) {
      return registrierFormular(
        "Der Nickname braucht 3 bis 20 Zeichen: Buchstaben, Ziffern, _ oder -.",
        nickname,
      );
    }
    if (passwort.length < 8) {
      return registrierFormular("Das Passwort braucht mindestens 8 Zeichen.", nickname);
    }
    if (passwort !== passwort2) {
      return registrierFormular("Die beiden Passwörter sind nicht gleich.", nickname);
    }

    const { saltHex, hashHex } = await passwortSpeichern(passwort);

    try {
      await env.DB.prepare(
        "INSERT INTO users (id, nickname, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(crypto.randomUUID(), nickname, hashHex, saltHex, new Date().toISOString())
        .run();
    } catch (fehler) {
      // UNIQUE auf nickname — die Datenbank lehnt den zweiten Eintrag ab.
      return registrierFormular("Diesen Nickname gibt es schon.", nickname);
    }

    return weiter("/anmelden");
  }

  /* ---------- Anmelden und abmelden ---------- */

  if (pfad === "/anmelden" && request.method === "GET") {
    if (nutzer) return weiter("/box");
    return anmeldeFormular(null, "", sicheresZiel(url.searchParams.get("weiter")));
  }

  if (pfad === "/anmelden" && request.method === "POST") {
    const daten = await request.formData();
    const nickname = String(daten.get("nickname") || "").trim();
    const passwort = String(daten.get("passwort") || "");
    const ziel = sicheresZiel(url.searchParams.get("weiter"));

    const zeile = await env.DB.prepare(
      "SELECT id, password_hash, salt FROM users WHERE nickname = ?",
    )
      .bind(nickname)
      .first();

    const stimmt = zeile && (await passwortPruefen(passwort, zeile.salt, zeile.password_hash));

    // Eine gemeinsame Meldung für beide Fälle: Sonst ließe sich ausprobieren,
    // welche Nicknames es gibt.
    if (!stimmt) {
      return anmeldeFormular("Nickname oder Passwort stimmt nicht.", nickname, ziel);
    }

    const token = await sitzungAnlegen(zeile.id, env, "web");
    return weiter(ziel, sitzungsCookie(token));
  }

  if (pfad === "/abmelden" && request.method === "POST") {
    const token = cookieLesen(request, COOKIE);
    if (token) {
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?")
        .bind(await sha256Hex(token))
        .run();
    }
    return weiter("/", LOESCH_COOKIE);
  }

  /* ---------- Die eigene CodeBox ---------- */

  if (pfad === "/box") {
    if (!nutzer) return zurAnmeldung(url);

    const suche = String(url.searchParams.get("q") || "").trim();

    const abfrage = suche
      ? env.DB.prepare(
          "SELECT id, name, size, share_code, created_at FROM files " +
            "WHERE user_id = ? AND name LIKE ? ORDER BY created_at DESC",
        ).bind(nutzer.id, "%" + suche + "%")
      : env.DB.prepare(
          "SELECT id, name, size, share_code, created_at FROM files " +
            "WHERE user_id = ? ORDER BY created_at DESC",
        ).bind(nutzer.id);

    const { results } = await abfrage.all();

    const suchfeld =
      '<form method="get" action="/box">' +
      '<input name="q" value="' + escapeHtml(suche) + '" placeholder="Dateiname suchen" ' +
      'aria-label="Suchen">' +
      "<button>Suchen</button>" +
      (suche ? ' <a href="/box">Alle zeigen</a>' : "") +
      "</form>";

    const liste =
      results.length === 0
        ? suche
          ? '<p class="leer">Nichts gefunden für „' + escapeHtml(suche) + "“.</p>"
          : '<p class="leer">Noch nichts drin. Lad deine erste Datei hoch — danach ' +
            "kannst du sie über einen kurzen Code teilen.</p>"
        : "<table><thead><tr><th>Datei</th><th class=\"zahl\">Größe</th>" +
          "<th>Hochgeladen</th><th>Code</th></tr></thead><tbody>" +
          results
            .map(
              (z) =>
                '<tr><td><a href="/f/' + encodeURIComponent(z.id) + '">' +
                escapeHtml(z.name) + "</a></td>" +
                '<td class="zahl">' + groesse(z.size) + "</td>" +
                "<td>" + datum(z.created_at) + "</td>" +
                "<td>" + (z.share_code ? escapeHtml(z.share_code) : "—") + "</td></tr>",
            )
            .join("") +
          "</tbody></table>";

    return seite(
      "Meine CodeBox",
      "<h1>Meine CodeBox</h1>" +
        suchfeld +
        liste +
        "<h2>Datei hochladen</h2>" +
        '<form method="post" action="/upload" enctype="multipart/form-data">' +
        '<input type="file" name="datei" required>' +
        "<button>Hochladen</button></form>" +
        '<p class="hinweis">Quelltext bis ' + groesse(MAX_BYTES) + ", höchstens " +
        MAX_DATEIEN + " Dateien. Erlaubt: " + ERLAUBTE_ENDUNGEN.join(" ") + "</p>",
      nutzer,
    );
  }

  if (pfad === "/upload" && request.method === "POST") {
    if (!nutzer) return zurAnmeldung(url);

    const daten = await request.formData();
    const datei = daten.get("datei");

    // Auch das prüfen, was "nicht passieren kann": Wer das Formular von Hand
    // schickt, kann statt einer Datei einen Text senden.
    if (!datei || typeof datei.text !== "function" || datei.size === 0) {
      return hochladeFehler("Bitte eine Datei auswählen.", nutzer);
    }

    const inhalt = await datei.text();
    const name = saubererName(datei.name);

    const fehler = pruefeDatei(name, inhalt);
    if (fehler) return hochladeFehler(fehler, nutzer);

    if ((await anzahlDateien(nutzer.id, env)) >= MAX_DATEIEN) {
      return hochladeFehler(
        "Deine CodeBox ist voll (" + MAX_DATEIEN +
          " Dateien). Lösch etwas, bevor du Neues hochlädst.",
        nutzer,
      );
    }

    await env.DB.prepare(
      "INSERT INTO files (id, user_id, name, content, size, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), nutzer.id, name, inhalt, inhalt.length, new Date().toISOString())
      .run();

    return weiter("/box");
  }

  /* ---------- Eine einzelne Datei ---------- */

  if (pfad.startsWith("/f/") && pfad.endsWith("/raw")) {
    if (!nutzer) return zurAnmeldung(url);

    const id = decodeURIComponent(pfad.slice(3, -4));
    const datei = await env.DB.prepare(
      "SELECT name, content FROM files WHERE id = ? AND user_id = ?",
    )
      .bind(id, nutzer.id)
      .first();

    if (!datei) return new Response("Nicht gefunden", { status: 404 });
    return alsDatei(datei.name, datei.content);
  }

  if (pfad.startsWith("/f/") && request.method === "GET") {
    if (!nutzer) return zurAnmeldung(url);

    const id = decodeURIComponent(pfad.slice(3));

    // "Gehört mir" steht in der Abfrage, nicht in einem if danach.
    const datei = await env.DB.prepare(
      "SELECT id, name, content, size, created_at, share_code FROM files " +
        "WHERE id = ? AND user_id = ?",
    )
      .bind(id, nutzer.id)
      .first();

    if (!datei) {
      // Die Meldung unterscheidet nicht, ob es die Datei nicht gibt oder ob
      // sie jemand anderem gehört. Sonst ließe sich das Vorhandensein raten.
      return seite(
        "Nicht gefunden",
        "<h1>Nicht gefunden</h1><p>Diese Datei gibt es nicht — oder sie gehört " +
          'jemand anderem.</p><p><a href="/box">Zur CodeBox</a></p>',
        nutzer,
        { status: 404 },
      );
    }

    const teilBereich = datei.share_code
      ? '<div class="teilen"><p>Geteilt. Code: <span class="code">' +
        escapeHtml(datei.share_code) + "</span></p>" +
        '<label for="link">Link zum Weitergeben</label>' +
        '<input id="link" readonly onclick="this.select()" value="' +
        escapeHtml(url.origin + "/s/" + datei.share_code) + '">' +
        '<form method="post" action="/nicht-mehr-teilen">' +
        '<input type="hidden" name="id" value="' + escapeHtml(datei.id) + '">' +
        "<button>Nicht mehr teilen</button></form></div>"
      : '<form method="post" action="/teilen">' +
        '<input type="hidden" name="id" value="' + escapeHtml(datei.id) + '">' +
        "<button>Teilen</button></form>";

    return seite(
      datei.name,
      "<h1>" + escapeHtml(datei.name) + "</h1>" +
        '<p class="hinweis">' + groesse(datei.size) + " · " + datum(datei.created_at) + "</p>" +
        "<pre><code>" + escapeHtml(datei.content) + "</code></pre>" +
        teilBereich +
        '<p><a class="knopf" href="/f/' + encodeURIComponent(datei.id) +
        '/raw">Herunterladen</a></p>' +
        '<form method="post" action="/loeschen" ' +
        "onsubmit=\"return confirm('Wirklich löschen? Das lässt sich nicht rückgängig machen.')\">" +
        '<input type="hidden" name="id" value="' + escapeHtml(datei.id) + '">' +
        '<button class="gefahr">Löschen</button></form>' +
        '<p><a href="/box">Zurück zur CodeBox</a></p>',
      nutzer,
    );
  }

  /* ---------- Teilen, zurücknehmen, löschen ---------- */

  if (pfad === "/teilen" && request.method === "POST") {
    if (!nutzer) return zurAnmeldung(url);
    const daten = await request.formData();
    const id = String(daten.get("id") || "");

    const code = await teilen(id, nutzer.id, env);
    if (!code) {
      return seite(
        "Teilen",
        '<h1>Teilen</h1><p class="fehler">Das hat nicht geklappt. Versuch es ' +
          'noch einmal.</p><p><a href="/box">Zur CodeBox</a></p>',
        nutzer,
      );
    }
    return weiter("/f/" + encodeURIComponent(id));
  }

  if (pfad === "/nicht-mehr-teilen" && request.method === "POST") {
    if (!nutzer) return zurAnmeldung(url);
    const daten = await request.formData();
    const id = String(daten.get("id") || "");

    // NULL, nicht der leere Text: Bei UNIQUE ist das der Unterschied.
    await env.DB.prepare(
      "UPDATE files SET share_code = NULL WHERE id = ? AND user_id = ?",
    )
      .bind(id, nutzer.id)
      .run();

    return weiter("/f/" + encodeURIComponent(id));
  }

  if (pfad === "/loeschen" && request.method === "POST") {
    if (!nutzer) return zurAnmeldung(url);
    const daten = await request.formData();
    const id = String(daten.get("id") || "");

    await env.DB.prepare("DELETE FROM files WHERE id = ? AND user_id = ?")
      .bind(id, nutzer.id)
      .run();

    return weiter("/box");
  }

  /* ---------- Zahlen ---------- */

  if (pfad === "/statistik") {
    if (!nutzer) return zurAnmeldung(url);

    const summe = await env.DB.prepare(
      "SELECT COUNT(*) AS dateien, COALESCE(SUM(size), 0) AS zeichen, " +
        "COUNT(share_code) AS geteilt, COALESCE(MAX(size), 0) AS groesste " +
        "FROM files WHERE user_id = ?",
    )
      .bind(nutzer.id)
      .first();

    if (summe.dateien === 0) {
      return seite(
        "Zahlen",
        "<h1>Zahlen</h1>" +
          '<p class="leer">Noch nichts hochgeladen — hier steht etwas, sobald ' +
          'die erste Datei da ist.</p><p><a href="/box">Zur CodeBox</a></p>',
        nutzer,
      );
    }

    // Die Endung steckt im Namen und ist keine eigene Spalte. In SQL wäre das
    // umständlich: SQLite kennt kein REVERSE, und INSTR findet den ersten
    // Punkt, nicht den letzten. Bei höchstens hundert Dateien ist es ehrlicher,
    // nur die Namen zu holen und hier zu zählen — mit derselben Funktion, die
    // auch beim Hochladen die Endung bestimmt.
    const { results: namen } = await env.DB.prepare(
      "SELECT name FROM files WHERE user_id = ?",
    )
      .bind(nutzer.id)
      .all();

    const zaehler = new Map();
    for (const zeile of namen) {
      const endung = endungVon(zeile.name) || "(ohne)";
      zaehler.set(endung, (zaehler.get(endung) || 0) + 1);
    }
    const endungen = [...zaehler.entries()]
      .map(([endung, anzahl]) => ({ endung, anzahl }))
      .sort((a, b) => b.anzahl - a.anzahl || a.endung.localeCompare(b.endung));

    const groesste = await env.DB.prepare(
      "SELECT name, size FROM files WHERE user_id = ? ORDER BY size DESC LIMIT 1",
    )
      .bind(nutzer.id)
      .first();

    return seite(
      "Zahlen",
      "<h1>Zahlen</h1>" +
        "<table><tbody>" +
        "<tr><td>Dateien</td><td class=\"zahl\">" + summe.dateien + "</td></tr>" +
        "<tr><td>Text insgesamt</td><td class=\"zahl\">" + groesse(summe.zeichen) + "</td></tr>" +
        "<tr><td>davon geteilt</td><td class=\"zahl\">" + summe.geteilt + "</td></tr>" +
        "<tr><td>Größte Datei</td><td class=\"zahl\">" +
        escapeHtml(groesste.name) + " · " + groesse(groesste.size) + "</td></tr>" +
        "</tbody></table>" +
        "<h2>Sprachen</h2>" +
        (endungen.length === 0
          ? '<p class="leer">Keine Dateiendungen gefunden.</p>'
          : "<table><tbody>" +
            endungen
              .map(
                (z) =>
                  "<tr><td>" + escapeHtml(z.endung) + '</td><td class="zahl">' +
                  z.anzahl + "</td></tr>",
              )
              .join("") +
            "</tbody></table>") +
        '<p><a href="/box">Zur CodeBox</a></p>',
      nutzer,
    );
  }

  return nichtGefunden(nutzer);
}

function hochladeFehler(text, nutzer) {
  return seite(
    "Hochladen",
    '<h1>Hochladen</h1><p class="fehler">' + escapeHtml(text) + "</p>" +
      '<p><a href="/box">Zurück zur CodeBox</a></p>',
    nutzer,
  );
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await behandle(request, env);
    } catch (fehler) {
      // Die technische Meldung gehört ins Protokoll, nicht auf die Seite:
      // Sie verrät Interna. Verschlucken darf man sie aber auch nicht.
      console.error(fehler);
      return new Response("Da ist bei uns etwas schiefgegangen.", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  },
};
