import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryDatabase } from "./migrate.ts";
import { SqliteMemoryStore } from "./sqlite-store.ts";
import type { TurnRecord } from "./types.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cookie-sqlite-store-"));
  dirs.push(dir);
  return join(dir, "cookie.db");
}

function turn(
  id: string,
  sessionId: string,
  content: string,
  createdAt: number,
): TurnRecord {
  return {
    id,
    sessionId,
    role: "user",
    content,
    tainted: false,
    model: null,
    egress: false,
    escalatedFrom: null,
    tokensIn: null,
    tokensCached: null,
    tokensOut: null,
    costUsd: null,
    latencyMs: null,
    createdAt,
  };
}

describe("sqlite memory store", () => {
  it("appends turns and refuses updates and deletes", () => {
    const path = tempDbPath();
    const store = SqliteMemoryStore.open(path);
    store.appendSession({
      id: "ses-1",
      surface: "popup",
      startedAt: 1,
      endedAt: null,
      summary: null,
    });
    store.appendTurn(turn("t1", "ses-1", "ECE midterm is Friday", 10));
    store.appendTurn(turn("t2", "ses-1", "bring the notebook", 20));

    expect(store.recentTurns("ses-1", 2).map((row) => row.content)).toEqual([
      "ECE midterm is Friday",
      "bring the notebook",
    ]);
    expect(() => store.appendTurn(turn("t1", "ses-1", "changed", 10))).toThrow(
      /turn already exists/,
    );
    expect(() => store.appendTurn(turn("t3", "ses-missing", "x", 30))).toThrow(
      /unknown session/,
    );
    store.close();

    const db = openMemoryDatabase(path);
    expect(() => {
      db.prepare("UPDATE turns SET content = ? WHERE id = ?").run(
        "rewritten",
        "t1",
      );
    }).toThrow(/append-only/);
    expect(() => {
      db.prepare("DELETE FROM turns WHERE id = ?").run("t1");
    }).toThrow(/append-only/);
    const kept = db
      .prepare("SELECT content FROM turns WHERE id = ?")
      .get("t1") as { content: string };
    expect(kept.content).toBe("ECE midterm is Friday");
    db.close();
  });

  it("keeps turns_fts in step when a turn is appended", () => {
    const path = tempDbPath();
    const store = SqliteMemoryStore.open(path);
    store.beginConversation("ses-1");
    store.appendTurn(turn("t1", "ses-1", "ECE midterm is Friday", 10));
    store.appendTurn(turn("t2", "ses-1", "packing list for the trip", 20));

    expect(store.searchTurns("midterm").map((row) => row.id)).toEqual(["t1"]);
    expect(store.searchTurns("packing").map((row) => row.id)).toEqual(["t2"]);
    expect(store.searchTurns("")).toEqual([]);
    store.close();

    const db = openMemoryDatabase(path);
    const turns = db.prepare("SELECT COUNT(*) AS n FROM turns").get() as {
      n: number;
    };
    const indexed = db.prepare("SELECT COUNT(*) AS n FROM turns_fts").get() as {
      n: number;
    };
    expect(indexed.n).toBe(turns.n);
    expect(indexed.n).toBe(2);
    db.close();
  });

  it("ends the open session when a new conversation id arrives", () => {
    let clock = 1_000;
    const store = SqliteMemoryStore.open(tempDbPath(), {
      now: () => clock,
    });
    store.beginConversation("conv-a");
    store.appendTurn(turn("a1", "conv-a", "first", 1_000));
    clock = 2_000;
    const next = store.beginConversation("conv-b");

    expect(next.id).toBe("conv-b");
    expect(next.endedAt).toBeNull();
    expect(store.session("conv-a")?.endedAt).toBe(2_000);
    expect(store.recentTurns("conv-a", 10).map((row) => row.id)).toEqual([
      "a1",
    ]);
    expect(store.recentTurns("conv-b", 10)).toEqual([]);
    expect(() => store.appendTurn(turn("a2", "conv-a", "late", 3))).toThrow(
      /session ended/,
    );
    store.close();
  });

  it("keeps the same conversation open when the clock moves", () => {
    let clock = 0;
    const store = SqliteMemoryStore.open(tempDbPath(), {
      now: () => clock,
    });
    store.beginConversation("conv-1");
    store.appendTurn(turn("t1", "conv-1", "still here", 0));
    clock = 10 * 60 * 1000;
    store.beginConversation("conv-1");
    expect(store.session("conv-1")?.endedAt).toBeNull();
    expect(store.recentTurns("conv-1", 10).map((row) => row.content)).toEqual([
      "still here",
    ]);
    store.close();
  });

  it("keeps turns after the database is closed and opened again", () => {
    const path = tempDbPath();
    const first = SqliteMemoryStore.open(path, { now: () => 50 });
    first.beginConversation("conv-1");
    first.appendTurn(turn("t1", "conv-1", "ECE midterm is Friday", 50));
    first.close();

    const second = SqliteMemoryStore.open(path, { now: () => 80 });
    expect(second.session("conv-1")).toMatchObject({
      id: "conv-1",
      endedAt: null,
      startedAt: 50,
    });
    expect(second.recentTurns("conv-1", 10)).toMatchObject([
      { id: "t1", content: "ECE midterm is Friday", egress: false },
    ]);
    expect(second.searchTurns("midterm").map((row) => row.id)).toEqual(["t1"]);
    second.close();
  });
});
