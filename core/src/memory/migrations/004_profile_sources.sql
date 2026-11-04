-- Profile provenance. source_turns is a JSON array of turn ids.
-- source_turn stays the first id so a single-source reader still works.
-- Migration 001 is not edited. A row that already has source_turn is copied in.

ALTER TABLE profile ADD COLUMN source_turns TEXT NOT NULL DEFAULT '[]';

UPDATE profile
SET source_turns = json_array(source_turn)
WHERE source_turn IS NOT NULL AND length(source_turn) > 0;
