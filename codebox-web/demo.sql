-- Demo-Bestand fuer die Vorfuehrung.
--
-- Legt den Zugang "demo" mit dem Passwort "codebox2026" an und
-- drei Beispieldateien, eine davon bereits geteilt.
--
-- Einspielen:
--   npx wrangler d1 execute codebox --local --file=./demo.sql
--
-- Zweimal einspielen schadet nicht: Die Zeilen haben feste
-- Kennungen und werden ersetzt, nicht verdoppelt.

INSERT OR REPLACE INTO users (id, nickname, password_hash, salt, created_at)
VALUES ('45172e86-4042-4a6e-b5e4-4a457255d2fa', 'demo', '853b303853e9fac4e8237d3564555d93f88aae127ccffff0582346900bae5046', '09e3a09872b9404c6d0ebf16e618200b', '2026-09-09T22:08:21.872Z');

INSERT OR REPLACE INTO files (id, user_id, name, content, size, share_code, created_at)
VALUES ('demo-datei-1', '45172e86-4042-4a6e-b5e4-4a457255d2fa', 'hallo.cpp', '#include <iostream>

// Das erste Programm, das jeder schreibt.
int main() {
    std::cout << "Hallo, Welt!" << std::endl;
    return 0;
}
', 139, 'K3M92X', '2026-09-09T22:08:21.872Z');

INSERT OR REPLACE INTO files (id, user_id, name, content, size, share_code, created_at)
VALUES ('demo-datei-2', '45172e86-4042-4a6e-b5e4-4a457255d2fa', 'primzahlen.cpp', '#include <iostream>
#include <vector>

// Sieb des Eratosthenes: streicht alle Vielfachen weg,
// was stehen bleibt, ist prim.
int main() {
    const int bis = 100;
    std::vector<bool> ist_prim(bis + 1, true);
    ist_prim[0] = ist_prim[1] = false;

    for (int i = 2; i * i <= bis; i++) {
        if (!ist_prim[i]) continue;
        for (int j = i * i; j <= bis; j += i) ist_prim[j] = false;
    }

    for (int i = 2; i <= bis; i++) {
        if (ist_prim[i]) std::cout << i << " ";
    }
    std::cout << std::endl;
}
', 524, NULL, '2026-09-09T22:08:21.872Z');

INSERT OR REPLACE INTO files (id, user_id, name, content, size, share_code, created_at)
VALUES ('demo-datei-3', '45172e86-4042-4a6e-b5e4-4a457255d2fa', 'notizen.md', '# Notizen zum Praktikum

- Worker laeuft lokal mit `npx wrangler dev`
- Datenbank liegt unter `.wrangler/` und uebersteht den Neustart
- Das Werkzeug meldet sich mit `codebox login` an

## Offen

- [ ] Eigene Domain eintragen
- [x] Teilen zuruecknehmen
', 253, NULL, '2026-09-09T22:08:21.872Z');

