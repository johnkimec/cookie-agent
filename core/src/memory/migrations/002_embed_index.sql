-- Migration 002. Bookkeeping for local embeddings.
-- vec_facts and vec_chunks already exist (migration 001). Do not recreate them.
-- One row per vector id. source is turn or fact. source_id is that row's id.

CREATE TABLE embed_index (
  id         TEXT PRIMARY KEY,
  vec_table  TEXT NOT NULL,
  source     TEXT NOT NULL,
  source_id  TEXT NOT NULL,
  model      TEXT NOT NULL,
  tokens     INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX embed_index_source ON embed_index(source, source_id);
