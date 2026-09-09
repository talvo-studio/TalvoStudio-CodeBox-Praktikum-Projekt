// codebox — Kommandozeilen-Werkzeug für CodeBox.
//
// Quelltext hochladen, auflisten, teilen und geteilte Dateien holen — ohne
// Browser. Bewusst ohne fremde Bibliotheken: nur die C++-Standardbibliothek,
// ein einziger Übersetzungsbefehl, und für die Netzverbindung das Programm
// curl, das auf jedem aktuellen Rechner schon liegt.
//
// Übersetzen:
//   g++ -std=c++17 -Wall -Wextra -O2 src/main.cpp -o codebox
//
// Der Grund für curl statt einer eigenen HTTP-Umsetzung: Die
// Standardbibliothek kann kein Netzwerk. Wer HTTPS selbst sprechen will,
// bindet eine fremde Bibliothek ein und muss sie auf jedem Rechner
// mitliefern. Ein anderes Programm aufzurufen ist hier der kleinere und
// ehrlichere Weg — und genau der Gedanke, nach dem die Kommandozeile
// gebaut ist: kleine Programme, die eins gut können.

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <random>
#include <sstream>
#include <string>
#include <vector>

#ifdef _WIN32
#include <conio.h>
#endif

namespace fs = std::filesystem;

static const std::string STANDARD_SERVER = "http://localhost:8787";

/* ================================================================== *
 * Kleine Helfer
 * ================================================================== */

static std::string dateiLesen(const fs::path& pfad) {
    std::ifstream ein(pfad, std::ios::binary);
    std::stringstream puffer;
    puffer << ein.rdbuf();
    return puffer.str();
}

static bool dateiSchreiben(const fs::path& pfad, const std::string& inhalt) {
    std::ofstream aus(pfad, std::ios::binary);
    if (!aus) return false;
    aus << inhalt;
    return aus.good();
}

static std::string kuerzen(const std::string& text) {
    const std::string leer = " \t\r\n";
    const auto anfang = text.find_first_not_of(leer);
    if (anfang == std::string::npos) return "";
    const auto ende = text.find_last_not_of(leer);
    return text.substr(anfang, ende - anfang + 1);
}

static std::string grossbuchstaben(std::string text) {
    for (char& c : text) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    return text;
}

/** Zählt Zeichen, nicht Bytes — für die Anzeige von Dateigrößen reicht das. */
static std::string groesse(long long bytes) {
    if (bytes < 1024) return std::to_string(bytes) + " B";
    return std::to_string((bytes + 512) / 1024) + " KB";
}

/* ================================================================== *
 * JSON — nur so viel, wie dieses Programm braucht
 * ================================================================== */

/**
 * Schreibt Text so um, dass er in einer JSON-Zeichenkette stehen darf.
 * Der Rückwärtsstrich muss zuerst ersetzt werden, sonst wird der eben
 * erzeugte gleich noch einmal umgeschrieben.
 */
static std::string jsonText(const std::string& roh) {
    std::string aus;
    aus.reserve(roh.size() + 16);
    for (unsigned char c : roh) {
        switch (c) {
            case '\\': aus += "\\\\"; break;
            case '"':  aus += "\\\""; break;
            case '\n': aus += "\\n";  break;
            case '\r': aus += "\\r";  break;
            case '\t': aus += "\\t";  break;
            case '\b': aus += "\\b";  break;
            case '\f': aus += "\\f";  break;
            default:
                if (c < 0x20) {
                    // Andere Steuerzeichen als \u00XX schreiben.
                    char puffer[8];
                    std::snprintf(puffer, sizeof(puffer), "\\u%04x", c);
                    aus += puffer;
                } else {
                    aus += static_cast<char>(c);
                }
        }
    }
    return aus;
}

/** Macht die Umschreibung von oben wieder rückgängig. */
static std::string jsonTextZurueck(const std::string& roh) {
    std::string aus;
    for (size_t i = 0; i < roh.size(); i++) {
        if (roh[i] != '\\' || i + 1 >= roh.size()) {
            aus += roh[i];
            continue;
        }
        const char naechstes = roh[++i];
        switch (naechstes) {
            case 'n': aus += '\n'; break;
            case 'r': aus += '\r'; break;
            case 't': aus += '\t'; break;
            case 'b': aus += '\b'; break;
            case 'f': aus += '\f'; break;
            case '"': aus += '"';  break;
            case '\\': aus += '\\'; break;
            case '/': aus += '/';  break;
            case 'u': {
                if (i + 4 >= roh.size()) break;
                const int wert = std::stoi(roh.substr(i + 1, 4), nullptr, 16);
                i += 4;
                // Als UTF-8 ausgeben. Ersatzpaare kommen in unseren
                // Antworten nicht vor, deshalb hier nur die drei Bereiche.
                if (wert < 0x80) {
                    aus += static_cast<char>(wert);
                } else if (wert < 0x800) {
                    aus += static_cast<char>(0xC0 | (wert >> 6));
                    aus += static_cast<char>(0x80 | (wert & 0x3F));
                } else {
                    aus += static_cast<char>(0xE0 | (wert >> 12));
                    aus += static_cast<char>(0x80 | ((wert >> 6) & 0x3F));
                    aus += static_cast<char>(0x80 | (wert & 0x3F));
                }
                break;
            }
            default: aus += naechstes;
        }
    }
    return aus;
}

/**
 * Holt den Wert zu einem Schlüssel aus einer JSON-Antwort.
 *
 * ACHTUNG: Das ist kein JSON-Leser. Die Funktion findet "schluessel": und
 * liest den Wert dahinter — mehr nicht. Steht derselbe Name im Text eines
 * anderen Wertes, findet sie das Falsche. Für die kurzen, festen Antworten
 * dieses Servers reicht das; für alles andere gehört ein richtiger Leser her.
 */
static std::string jsonWert(const std::string& text, const std::string& schluessel) {
    const std::string suche = "\"" + schluessel + "\":";
    const auto stelle = text.find(suche);
    if (stelle == std::string::npos) return "";

    size_t i = stelle + suche.size();
    while (i < text.size() && (text[i] == ' ' || text[i] == '\n')) i++;
    if (i >= text.size()) return "";

    if (text[i] == '"') {
        i++;
        std::string roh;
        while (i < text.size() && text[i] != '"') {
            if (text[i] == '\\' && i + 1 < text.size()) {
                roh += text[i];
                roh += text[i + 1];
                i += 2;
                continue;
            }
            roh += text[i++];
        }
        return jsonTextZurueck(roh);
    }

    // Zahl, true/false oder null.
    std::string wert;
    while (i < text.size() && text[i] != ',' && text[i] != '}' && text[i] != ']') {
        wert += text[i++];
    }
    return kuerzen(wert);
}

/**
 * Zerlegt die Liste aus /api/files in die einzelnen Einträge. Der Werteholer
 * oben findet immer nur den ersten Treffer — deshalb wird an den geschweiften
 * Klammern getrennt und jeder Teil einzeln gelesen.
 */
static std::vector<std::string> jsonEintraege(const std::string& text) {
    std::vector<std::string> teile;
    size_t i = 0;
    while (true) {
        const auto auf = text.find('{', i);
        if (auf == std::string::npos) break;
        const auto zu = text.find('}', auf);
        if (zu == std::string::npos) break;
        teile.push_back(text.substr(auf, zu - auf + 1));
        i = zu + 1;
    }
    return teile;
}

/* ================================================================== *
 * Konfiguration: ~/.codebox/config
 *
 * Eine Zeile je Eintrag, Name und Wert durch ein Gleichheitszeichen
 * getrennt. JSON wäre naheliegend, aber der Werteholer oben ist zum
 * Schreiben zu schwach — und von Hand lesbar ist das hier auch.
 * ================================================================== */

static fs::path heimatOrdner() {
    if (const char* h = std::getenv("HOME")) return fs::path(h);           // Linux, macOS
    if (const char* w = std::getenv("USERPROFILE")) return fs::path(w);    // Windows
    return fs::current_path();
}

static fs::path configOrdner() { return heimatOrdner() / ".codebox"; }
static fs::path configDatei()  { return configOrdner() / "config"; }

static std::map<std::string, std::string> configLesen() {
    std::map<std::string, std::string> daten;
    std::ifstream ein(configDatei());
    if (!ein) return daten;

    std::string zeile;
    while (std::getline(ein, zeile)) {
        if (zeile.empty() || zeile[0] == '#') continue;
        const auto gleich = zeile.find('=');
        if (gleich == std::string::npos) continue;
        daten[kuerzen(zeile.substr(0, gleich))] = kuerzen(zeile.substr(gleich + 1));
    }
    return daten;
}

/** Setzt die Rechte so, dass nur der Besitzer lesen darf. */
static void nurFuerMich(const fs::path& pfad) {
    std::error_code fehler;
    fs::permissions(pfad, fs::perms::owner_read | fs::perms::owner_write,
                    fs::perm_options::replace, fehler);
    // Unter Windows greift diese Einschränkung nicht. Kein Grund abzubrechen —
    // aber ein Grund, es in der README zu erwähnen, statt es zu verschweigen.
}

static bool configSchreiben(const std::map<std::string, std::string>& daten) {
    std::error_code fehler;
    fs::create_directories(configOrdner(), fehler);

    std::string inhalt = "# Zugang zu CodeBox. Zum Abmelden diese Datei loeschen.\n";
    for (const auto& [name, wert] : daten) inhalt += name + " = " + wert + "\n";

    if (!dateiSchreiben(configDatei(), inhalt)) return false;
    nurFuerMich(configDatei());
    return true;
}

static std::string serverAusConfig() {
    const auto daten = configLesen();
    const auto treffer = daten.find("server");
    return treffer == daten.end() || treffer->second.empty() ? STANDARD_SERVER
                                                             : treffer->second;
}

/* ================================================================== *
 * Eingabe
 * ================================================================== */

static std::string zeileLesen(const std::string& frage, const std::string& vorgabe) {
    if (vorgabe.empty()) {
        std::cout << frage << ": ";
    } else {
        std::cout << frage << " [" << vorgabe << "]: ";
    }
    std::cout.flush();

    std::string wert;
    std::getline(std::cin, wert);
    wert = kuerzen(wert);
    return wert.empty() ? vorgabe : wert;
}

/**
 * Passwort lesen, ohne es anzuzeigen. Das geht nur betriebssystemabhängig:
 * Windows liefert einzelne Tasten über _getch, auf Linux und macOS schaltet
 * man die Anzeige kurz ab.
 */
static std::string passwortLesen(const std::string& frage) {
    std::cout << frage << ": ";
    std::cout.flush();

    std::string wert;
#ifdef _WIN32
    for (;;) {
        const int taste = _getch();
        if (taste == '\r' || taste == '\n') break;
        if (taste == '\b' || taste == 127) {
            if (!wert.empty()) wert.pop_back();
            continue;
        }
        if (taste == 3) {           // Strg+C
            std::cout << "\n";
            std::exit(1);
        }
        wert += static_cast<char>(taste);
    }
#else
    const int aus = std::system("stty -echo 2>/dev/null");
    (void)aus;
    std::getline(std::cin, wert);
    const int an = std::system("stty echo 2>/dev/null");
    (void)an;
#endif
    std::cout << "\n";
    return wert;
}

/* ================================================================== *
 * Mit dem Server reden
 * ================================================================== */

struct Antwort {
    long status = 0;
    std::string text;
    std::string dateiname;   // aus Content-Disposition, falls vorhanden
};

/**
 * Pfade für die curl-Konfigurationsdatei aufbereiten.
 *
 * In dieser Datei werden Rückwärtsstriche innerhalb von Anführungszeichen als
 * Sonderzeichen gelesen — ein Windows-Pfad wie C:\Users\... zerfiele dabei.
 * curl kommt auf allen Systemen mit Schrägstrichen zurecht, also werden sie
 * getauscht. Die Anführungszeichen bleiben, sonst bricht ein Pfad mit
 * Leerzeichen im Namen.
 */
static std::string pfadFuerCurl(const fs::path& pfad) {
    std::string text = pfad.string();
    std::replace(text.begin(), text.end(), '\\', '/');
    return "\"" + text + "\"";
}

static fs::path tempPfad(const std::string& zweck) {
    static const std::string kennung = [] {
        std::random_device zufall;
        return std::to_string(zufall() % 1000000u);
    }();
    return fs::temp_directory_path() / ("codebox-" + kennung + "-" + zweck);
}

/**
 * Ruft curl auf und gibt Statuscode und Antworttext zurück.
 *
 * Alles, was curl braucht, steht in einer Konfigurationsdatei — nicht in der
 * Kommandozeile. Der Grund ist der Token: Was beim Aufruf mitgegeben wird,
 * steht in der Prozessliste des Systems und ist für andere Nutzer desselben
 * Rechners sichtbar. Auf einem Schulrechner ist das keine graue Theorie.
 */
static Antwort anfrage(const std::string& methode, const std::string& adresse,
                       const std::string& koerper, const std::string& token) {
    const fs::path konfig = tempPfad("anfrage.txt");
    const fs::path daten = tempPfad("daten.json");
    const fs::path ausgabe = tempPfad("antwort.txt");
    const fs::path kopfzeilen = tempPfad("kopf.txt");
    const fs::path statusDatei = tempPfad("status.txt");

    std::error_code fehler;
    for (const auto& p : {ausgabe, kopfzeilen, statusDatei}) fs::remove(p, fehler);

    {
        std::ofstream aus(konfig, std::ios::binary);
        aus << "url = \"" << adresse << "\"\n";
        aus << "request = \"" << methode << "\"\n";
        aus << "silent\n";
        aus << "show-error\n";
        aus << "output = " << pfadFuerCurl(ausgabe) << "\n";
        aus << "dump-header = " << pfadFuerCurl(kopfzeilen) << "\n";
        aus << "write-out = \"%{http_code}\"\n";
        if (!token.empty()) {
            aus << "header = \"Authorization: Bearer " << token << "\"\n";
        }
        if (!koerper.empty()) {
            aus << "header = \"Content-Type: application/json\"\n";
            aus << "data = \"@" << [&] {
                std::string t = daten.string();
                std::replace(t.begin(), t.end(), '\\', '/');
                return t;
            }() << "\"\n";
        }
    }
    if (!koerper.empty()) dateiSchreiben(daten, koerper);

    const std::string befehl =
        "curl --config " + pfadFuerCurl(konfig) + " > " + pfadFuerCurl(statusDatei);
    const int ergebnis = std::system(befehl.c_str());

    Antwort antwort;
    antwort.text = dateiLesen(ausgabe);

    const std::string status = kuerzen(dateiLesen(statusDatei));
    if (!status.empty()) {
        try {
            antwort.status = std::stol(status);
        } catch (const std::exception&) {
            antwort.status = 0;
        }
    }

    const std::string kopf = dateiLesen(kopfzeilen);
    const auto stelle = kopf.find("filename=\"");
    if (stelle != std::string::npos) {
        const auto anfang = stelle + 10;
        const auto ende = kopf.find('"', anfang);
        if (ende != std::string::npos) antwort.dateiname = kopf.substr(anfang, ende - anfang);
    }

    // Zugangsdaten liegen in der Konfigurationsdatei — die bleibt nicht liegen.
    for (const auto& p : {konfig, daten, ausgabe, kopfzeilen, statusDatei}) {
        fs::remove(p, fehler);
    }

    if (ergebnis != 0 && antwort.status == 0) {
        std::cerr << "Der Server ist nicht erreichbar. Laeuft er, und stimmt die\n"
                  << "Adresse in " << configDatei().string() << "?\n";
        std::exit(1);
    }
    return antwort;
}

/** Wie anfrage(), aber mit Token aus der Konfiguration und Fehlerbehandlung. */
static Antwort angemeldeteAnfrage(const std::string& methode, const std::string& pfad,
                                  const std::string& koerper) {
    const auto daten = configLesen();
    const auto treffer = daten.find("token");
    if (treffer == daten.end() || treffer->second.empty()) {
        std::cerr << "Nicht angemeldet. Fuehr zuerst 'codebox login' aus.\n";
        std::exit(1);
    }

    const Antwort antwort =
        anfrage(methode, serverAusConfig() + pfad, koerper, treffer->second);

    if (antwort.status == 401) {
        std::cerr << "Dein Zugang ist abgelaufen. Fuehr 'codebox login' noch mal aus.\n";
        std::exit(1);
    }
    if (antwort.status >= 400) {
        // Die Meldung des Servers weitergeben: Er hat sie so formuliert,
        // dass sie hilft.
        const std::string meldung = jsonWert(antwort.text, "fehler");
        std::cerr << (meldung.empty()
                          ? "Fehler " + std::to_string(antwort.status) + "."
                          : meldung)
                  << "\n";
        std::exit(1);
    }
    return antwort;
}

/* ================================================================== *
 * Die Befehle
 * ================================================================== */

static int befehlLogin() {
    auto daten = configLesen();

    const std::string server = [&] {
        std::string wert = zeileLesen("Serveradresse", serverAusConfig());
        while (!wert.empty() && wert.back() == '/') wert.pop_back();
        return wert;
    }();

    const std::string nickname = zeileLesen("Nickname", "");
    if (nickname.empty()) {
        std::cerr << "Ohne Nickname geht es nicht.\n";
        return 1;
    }
    const std::string passwort = passwortLesen("Passwort");

    const std::string koerper = "{\"nickname\":\"" + jsonText(nickname) +
                                "\",\"passwort\":\"" + jsonText(passwort) + "\"}";

    const Antwort antwort = anfrage("POST", server + "/api/login", koerper, "");

    if (antwort.status == 401) {
        std::cerr << "Nickname oder Passwort stimmt nicht.\n";
        return 1;
    }
    if (antwort.status != 200) {
        std::cerr << "Unerwartete Antwort vom Server (Status " << antwort.status << ").\n";
        return 1;
    }

    const std::string token = jsonWert(antwort.text, "token");
    if (token.empty()) {
        std::cerr << "Der Server hat keinen Zugang mitgeschickt.\n";
        return 1;
    }

    daten["server"] = server;
    daten["token"] = token;
    daten["nickname"] = jsonWert(antwort.text, "nickname");

    if (!configSchreiben(daten)) {
        std::cerr << "Der Zugang liess sich nicht speichern: "
                  << configDatei().string() << "\n";
        return 1;
    }

    std::cout << "Angemeldet als " << daten["nickname"] << ".\n";
    std::cout << "Zugang gespeichert in " << configDatei().string() << "\n";
    return 0;
}

static int befehlList() {
    const Antwort antwort = angemeldeteAnfrage("GET", "/api/files", "");
    const auto eintraege = jsonEintraege(antwort.text);

    if (eintraege.empty()) {
        std::cout << "Noch nichts in deiner CodeBox. Lad etwas hoch:\n";
        std::cout << "    codebox upload main.cpp\n";
        return 0;
    }

    std::cout << std::left << std::setw(30) << "DATEI"
              << std::right << std::setw(9) << "GROESSE"
              << "  " << std::left << std::setw(12) << "DATUM"
              << "CODE\n";

    for (const auto& eintrag : eintraege) {
        std::string name = jsonWert(eintrag, "name");
        if (name.size() > 29) name = name.substr(0, 28) + "~";

        const std::string code = jsonWert(eintrag, "share_code");
        const std::string datum = jsonWert(eintrag, "created_at").substr(0, 10);

        long long bytes = 0;
        try {
            bytes = std::stoll(jsonWert(eintrag, "size"));
        } catch (const std::exception&) {
            bytes = 0;
        }

        std::cout << std::left << std::setw(30) << name
                  << std::right << std::setw(9) << groesse(bytes)
                  << "  " << std::left << std::setw(12) << datum
                  << (code.empty() || code == "null" ? "-" : code) << "\n";
    }

    std::cout << "\n" << eintraege.size() << " Datei(en).\n";
    return 0;
}

/** Lädt hoch und gibt die Antwort zurück — codebox share baut darauf auf. */
static Antwort hochladen(const std::string& dateiname) {
    const fs::path pfad(dateiname);

    if (!fs::exists(pfad) || !fs::is_regular_file(pfad)) {
        std::cerr << "Die Datei '" << pfad.string() << "' gibt es nicht.\n";
        std::exit(1);
    }

    const std::string inhalt = dateiLesen(pfad);
    if (inhalt.empty()) {
        std::cerr << "Die Datei ist leer.\n";
        std::exit(1);
    }

    const std::string koerper = "{\"name\":\"" + jsonText(pfad.filename().string()) +
                                "\",\"inhalt\":\"" + jsonText(inhalt) + "\"}";

    return angemeldeteAnfrage("POST", "/api/files", koerper);
}

static int befehlUpload(const std::string& dateiname) {
    const Antwort antwort = hochladen(dateiname);
    std::cout << jsonWert(antwort.text, "name") << " hochgeladen ("
              << jsonWert(antwort.text, "size") << " Zeichen).\n";
    return 0;
}

static int befehlShare(const std::string& dateiname) {
    const Antwort hoch = hochladen(dateiname);
    const std::string id = jsonWert(hoch.text, "id");
    if (id.empty()) {
        std::cerr << "Der Server hat keine Kennung zur Datei mitgeschickt.\n";
        return 1;
    }

    const Antwort geteilt = angemeldeteAnfrage("POST", "/api/files/" + id + "/share", "");

    // Farben im Terminal sehen überall anders aus. Leerzeilen und Einrückung
    // funktionieren immer — und der Code soll vorgelesen werden können.
    std::cout << "\n    Code:  " << jsonWert(geteilt.text, "code") << "\n";
    std::cout << "    Link:  " << jsonWert(geteilt.text, "link") << "\n\n";
    std::cout << "Andere holen die Datei mit:\n";
    std::cout << "    codebox download " << jsonWert(geteilt.text, "code") << "\n";
    return 0;
}

static int befehlDownload(const std::string& rohCode, const std::string& ziel) {
    const std::string code = grossbuchstaben(kuerzen(rohCode));

    // Ohne Token: Geteilte Dateien sind öffentlich, das war ihr Sinn. Dieser
    // Befehl muss auch funktionieren, wenn nie 'codebox login' lief.
    const Antwort antwort =
        anfrage("GET", serverAusConfig() + "/s/" + code + "/raw", "", "");

    if (antwort.status == 404) {
        std::cerr << "Den Code '" << code << "' gibt es nicht.\n";
        return 1;
    }
    if (antwort.status != 200) {
        std::cerr << "Unerwartete Antwort vom Server (Status " << antwort.status << ").\n";
        return 1;
    }

    // Der Name kommt vom Server, also von einem anderen Menschen. Nur der
    // letzte Teil wird übernommen: '../../etwas' soll nicht aus dem
    // aktuellen Ordner ausbrechen. Dass der Server schon prüft, ändert daran
    // nichts — man traut keiner Seite, weil die andere geprüft hat.
    std::string name = ziel.empty() ? antwort.dateiname : ziel;
    if (name.empty()) name = code + ".txt";

    fs::path dateiZiel = fs::path(name).filename();
    if (dateiZiel.empty()) dateiZiel = code + ".txt";

    // Nur beim automatisch gewählten Namen ausweichen. Wer ein Ziel angibt,
    // hat es ausdrücklich gesagt.
    if (ziel.empty() && fs::exists(dateiZiel)) {
        const std::string stamm = dateiZiel.stem().string();
        const std::string endung = dateiZiel.extension().string();
        int n = 2;
        while (fs::exists(dateiZiel)) {
            dateiZiel = stamm + "-" + std::to_string(n) + endung;
            n++;
        }
        std::cout << "Es gibt schon eine Datei mit dem Namen. Speichere als "
                  << dateiZiel.string() << ".\n";
    }

    if (!dateiSchreiben(dateiZiel, antwort.text)) {
        std::cerr << "Konnte '" << dateiZiel.string() << "' nicht schreiben.\n";
        return 1;
    }

    std::cout << dateiZiel.string() << " gespeichert (" << antwort.text.size()
              << " Zeichen).\n";
    return 0;
}

static int hilfe() {
    std::cout <<
        "codebox — Quelltext hochladen, herunterladen und teilen.\n"
        "\n"
        "Aufruf:\n"
        "  codebox login                    Anmelden, Zugang wird gespeichert\n"
        "  codebox list                     Eigene Dateien anzeigen\n"
        "  codebox upload <datei>           Datei hochladen\n"
        "  codebox share <datei>            Hochladen und Code erzeugen\n"
        "  codebox download <code> [-o <datei>]\n"
        "                                   Geteilte Datei holen (ohne Anmeldung)\n"
        "\n"
        "Beispiel:\n"
        "  codebox share main.cpp\n"
        "\n"
        "Der Zugang liegt in " << configDatei().string() << ".\n"
        "Zum Abmelden diese Datei loeschen.\n";
    return 0;
}

/* ================================================================== *
 * Einstieg
 * ================================================================== */

int main(int argc, char* argv[]) {
    const std::vector<std::string> args(argv + 1, argv + argc);

    if (args.empty() || args[0] == "--help" || args[0] == "-h" || args[0] == "help") {
        return hilfe();
    }

    const std::string& befehl = args[0];

    if (befehl == "login") return befehlLogin();
    if (befehl == "list")  return befehlList();

    if (befehl == "upload" || befehl == "share") {
        if (args.size() < 2) {
            std::cerr << "Welche Datei? Beispiel: codebox " << befehl << " main.cpp\n";
            return 1;
        }
        return befehl == "upload" ? befehlUpload(args[1]) : befehlShare(args[1]);
    }

    if (befehl == "download") {
        if (args.size() < 2) {
            std::cerr << "Welcher Code? Beispiel: codebox download K3M92X\n";
            return 1;
        }
        std::string ziel;
        for (size_t i = 2; i < args.size(); i++) {
            if ((args[i] == "-o" || args[i] == "--ausgabe") && i + 1 < args.size()) {
                ziel = args[++i];
            }
        }
        return befehlDownload(args[1], ziel);
    }

    std::cerr << "Unbekannter Befehl: " << befehl << "\n";
    std::cerr << "'codebox --help' zeigt, was es gibt.\n";
    return 1;
}
