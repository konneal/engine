CREATE TABLE IF NOT EXISTS api_keys (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  key_hash   TEXT NOT NULL UNIQUE,
  day_limit  INTEGER NOT NULL DEFAULT 2000,
  created_at TEXT NOT NULL,
  revoked    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS queries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  day          TEXT NOT NULL,
  tier         TEXT NOT NULL,
  route        TEXT,
  model        TEXT,
  ok           INTEGER,
  answer_chars INTEGER,
  query_hash   TEXT,
  lang         TEXT
);

CREATE TABLE IF NOT EXISTS spend (
  day      TEXT NOT NULL,
  tier     TEXT NOT NULL,
  model    TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, tier, model)
);

CREATE TABLE IF NOT EXISTS feedback (
  query_hash TEXT NOT NULL,
  rating     INTEGER NOT NULL,
  ts         TEXT NOT NULL
);
