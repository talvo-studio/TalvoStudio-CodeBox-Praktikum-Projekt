-- Datenmodell von CodeBox.
--
-- Einspielen (beide Datenbanken, lokal und im Netz):
--   npx wrangler d1 execute codebox --local  --file=./schema.sql
--   npx wrangler d1 execute codebox --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  nickname      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- Gespeichert wird nur der Hash des Sitzungsschlüssels: Wer die Datenbank
-- liest, hat damit noch keine gültige Sitzung.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'web'
);

CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  content    TEXT NOT NULL,
  size       INTEGER NOT NULL,
  share_code TEXT UNIQUE,
  created_at TEXT NOT NULL
);

-- Register, damit die Dateien eines Nutzers gefunden werden, ohne dass die
-- Datenbank alle Zeilen durchgeht.
CREATE INDEX IF NOT EXISTS files_user ON files (user_id, created_at DESC);
