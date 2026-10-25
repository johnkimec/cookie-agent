import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "./migrate.ts";
import { EMBEDDING_DIMENSIONS } from "./types.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cookie-memory-"));
  dirs.push(dir);
  return join(dir, "cookie.db");
}

const EXPECTED_OBJECTS = [
  "sessions",
  "turns",
  "tool_calls",
  "profile",
  "journal",
  "journal_day",
  "facts",
  "facts_fts",
  "turns_fts",
  "vec_facts",
  "vec_chunks",
  "chunks",
  "trust_grants",
  "checkins",
  "memory_meta",
];

describe("migration 001", () => {
  it("opens a WAL file, lists the memory tables, and is idempotent", () => {
    const path = tempDbPath();
    const db = openMemoryDatabase(path);
    const names = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table', 'index')",
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    for (const name of EXPECTED_OBJECTS) {
      expect(names).toContain(name);
    }
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    db.close();

    const again = openMemoryDatabase(path);
    expect(again.pragma("user_version", { simple: true })).toBe(2);
    expect(again.prepare("SELECT count(*) AS n FROM facts").get()).toEqual({
      n: 0,
    });
    again.close();
  });

  it("applies migration 002 on a database that stopped at version 1", () => {
    const path = tempDbPath();
    const opened = openMemoryDatabase(path);
    opened.exec("DROP TABLE memory_meta");
    opened.pragma("user_version = 1");
    opened.close();

    const upgraded = openMemoryDatabase(path);
    const names = (
      upgraded
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .all("memory_meta") as Array<{ name: string }>
    ).map((row) => row.name);
    expect(names).toEqual(["memory_meta"]);
    expect(upgraded.pragma("user_version", { simple: true })).toBe(2);
    upgraded.close();
  });

  it("keeps facts_fts and turns_fts in step on insert, update, and delete", () => {
    const db = openMemoryDatabase(tempDbPath());
    db.prepare(
      "INSERT INTO sessions (id, surface, started_at) VALUES (?, ?, ?)",
    ).run("ses-1", "popup", 1);
    db.prepare(
      `INSERT INTO turns (
        id, session_id, role, content, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run("turn-1", "ses-1", "user", "ECE midterm is Friday", 2);
    db.prepare(
      `INSERT INTO facts (
        id, text, kind, confidence, source_turn, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("fact-1", "ECE midterm is Friday", "event", 0.9, "turn-1", 3);

    const matchFacts = (query: string) =>
      db
        .prepare("SELECT text FROM facts_fts WHERE facts_fts MATCH ?")
        .all(query);
    const matchTurns = (query: string) =>
      db
        .prepare("SELECT content FROM turns_fts WHERE turns_fts MATCH ?")
        .all(query);

    expect(matchFacts("midterm")).toEqual([{ text: "ECE midterm is Friday" }]);
    expect(matchTurns("midterm")).toEqual([
      { content: "ECE midterm is Friday" },
    ]);

    db.prepare("UPDATE facts SET text = ? WHERE id = ?").run(
      "ECE midterm moved to Monday",
      "fact-1",
    );
    expect(matchFacts("Friday")).toEqual([]);
    expect(matchFacts("Monday")).toEqual([
      { text: "ECE midterm moved to Monday" },
    ]);

    db.prepare("DELETE FROM facts WHERE id = ?").run("fact-1");
    expect(matchFacts("Monday")).toEqual([]);

    expect(() => {
      db.prepare(
        `INSERT INTO turns (
          id, session_id, role, content, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run("turn-missing", "ses-missing", "user", "orphan", 4);
    }).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("stores a 768-d vector under a text primary key and returns it from KNN", () => {
    const db = openMemoryDatabase(tempDbPath());
    const embedding = new Float32Array(EMBEDDING_DIMENSIONS);
    embedding[0] = 1;
    const other = new Float32Array(EMBEDDING_DIMENSIONS);
    other[1] = 1;
    db.prepare("INSERT INTO vec_facts (fact_id, embedding) VALUES (?, ?)").run(
      "fact-near",
      embedding,
    );
    db.prepare("INSERT INTO vec_facts (fact_id, embedding) VALUES (?, ?)").run(
      "fact-far",
      other,
    );
    const nearest = db
      .prepare(
        `SELECT fact_id, distance FROM vec_facts
         WHERE embedding MATCH ? AND k = 1`,
      )
      .get(embedding) as { fact_id: string; distance: number };
    expect(nearest.fact_id).toBe("fact-near");
    expect(nearest.distance).toBeLessThan(1e-5);
    db.close();
  });
});
