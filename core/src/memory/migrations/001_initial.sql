-- cookie.db at <COOKIE_DATA_DIR>/cookie.db (WAL). D5, D-2026-10-25-02.
-- Schema from docs/cookie-agent.md Memory. FTS5 triggers keep the
-- external-content indexes in step with facts and turns.

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  surface     TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  summary     TEXT
);

CREATE TABLE turns (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  tainted     INTEGER NOT NULL DEFAULT 0,
  model       TEXT,
  egress      INTEGER NOT NULL DEFAULT 0,
  escalated_from TEXT,
  tokens_in   INTEGER,
  tokens_cached INTEGER,
  tokens_out  INTEGER,
  cost_usd    REAL,
  latency_ms  INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE tool_calls (
  id          TEXT PRIMARY KEY,
  turn_id     TEXT NOT NULL REFERENCES turns(id),
  tool        TEXT NOT NULL,
  args        TEXT NOT NULL,
  tier        INTEGER NOT NULL,
  approval    TEXT NOT NULL,
  status      TEXT NOT NULL,
  result      TEXT,
  undo        TEXT,
  idem_key    TEXT UNIQUE,
  started_at  INTEGER,
  finished_at INTEGER
);

CREATE TABLE profile (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0,
  shareable   INTEGER NOT NULL DEFAULT 1,
  source_turn TEXT REFERENCES turns(id),
  updated_at  INTEGER NOT NULL
);

CREATE TABLE journal (
  id          TEXT PRIMARY KEY,
  day         TEXT NOT NULL,
  entry       TEXT NOT NULL,
  session_id  TEXT REFERENCES sessions(id),
  created_at  INTEGER NOT NULL
);
CREATE INDEX journal_day ON journal(day);

CREATE TABLE facts (
  id            TEXT PRIMARY KEY,
  text          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  subject       TEXT,
  confidence    REAL NOT NULL,
  sensitive     INTEGER NOT NULL DEFAULT 0,
  valid_until   INTEGER,
  superseded_by TEXT REFERENCES facts(id),
  source_turn   TEXT REFERENCES turns(id),
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);

CREATE VIRTUAL TABLE facts_fts USING fts5(
  text,
  content='facts',
  content_rowid='rowid'
);

CREATE TRIGGER facts_fts_insert AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER facts_fts_delete AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER facts_fts_update AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, text)
  VALUES ('delete', old.rowid, old.text);
  INSERT INTO facts_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE VIRTUAL TABLE turns_fts USING fts5(
  content,
  content='turns',
  content_rowid='rowid'
);

CREATE TRIGGER turns_fts_insert AFTER INSERT ON turns BEGIN
  INSERT INTO turns_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER turns_fts_delete AFTER DELETE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER turns_fts_update AFTER UPDATE ON turns BEGIN
  INSERT INTO turns_fts(turns_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
  INSERT INTO turns_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE VIRTUAL TABLE vec_facts USING vec0(
  fact_id TEXT PRIMARY KEY,
  embedding float[768]
);

CREATE VIRTUAL TABLE vec_chunks USING vec0(
  chunk_id TEXT PRIMARY KEY,
  embedding float[768]
);

CREATE TABLE chunks (
  chunk_id   TEXT PRIMARY KEY,
  session_id TEXT,
  first_turn TEXT,
  last_turn  TEXT,
  text       TEXT
);

CREATE TABLE trust_grants (
  tool        TEXT NOT NULL,
  scope       TEXT NOT NULL,
  granted_at  INTEGER NOT NULL,
  uses        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tool, scope)
);

CREATE TABLE checkins (
  id            TEXT PRIMARY KEY,
  trigger       TEXT NOT NULL,
  scheduled_for INTEGER NOT NULL,
  ran_at        INTEGER,
  gate_model    TEXT,
  score         REAL,
  delivered     INTEGER NOT NULL DEFAULT 0,
  message       TEXT,
  reaction      TEXT
);
