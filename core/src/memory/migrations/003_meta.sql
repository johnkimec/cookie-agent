-- Derived-memory bookkeeping. Turns stay append-only in migration 001.
-- PR #20 owns migration 002 (embed_index). This file is version 3.
-- consolidation.localDay and other job markers live in memory_meta.
-- forgotten_turns stores a turn id, an ISO date, and the removed fact
-- ids. It stores no fact text. The raw turn stays in turns.
-- TODO: a hard-erase option that deletes the turn row comes later,
-- after John has tested this flow.

CREATE TABLE IF NOT EXISTS memory_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE forgotten_turns (
  turn_id      TEXT PRIMARY KEY REFERENCES turns(id),
  forgotten_at TEXT NOT NULL,
  fact_ids     TEXT NOT NULL
);
