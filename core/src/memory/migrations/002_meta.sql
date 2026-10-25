-- Derived-memory bookkeeping. Turns stay append-only in migration 001.
-- consolidation.localDay and other job markers live here, not on sessions.

CREATE TABLE memory_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
