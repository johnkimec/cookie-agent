import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chunkText, MAX_CHUNK_TOKENS } from "./chunk.ts";
import { FakeEmbedder } from "./embedder.ts";
import {
  DEFAULT_EMBED_BATCH_SIZE,
  prefixDocument,
  QUERY_PREFIX,
} from "./http-embedder.ts";
import {
  ContentIndexer,
  INDEX_PASS_CHUNK_CAP,
  INDEX_TURN_ATTEMPT_LIMIT,
} from "./index-content.ts";
import { openMemoryDatabase } from "./migrate.ts";
import { SqliteVecIndex } from "./sqlite-vec-index.ts";
import { EMBEDDING_DIMENSIONS } from "./types.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cookie-vec-"));
  dirs.push(dir);
  return join(dir, "cookie.db");
}

describe("sqlite-vec index", () => {
  it("upserts, ranks, and deletes by id from both tables", async () => {
    const db = openMemoryDatabase(tempDbPath());
    const index = new SqliteVecIndex(db);
    const near = new Float32Array(EMBEDDING_DIMENSIONS);
    near[0] = 1;
    const far = new Float32Array(EMBEDDING_DIMENSIONS);
    far[1] = 1;
    await index.upsert("vec_facts", "near", near);
    await index.upsert("vec_facts", "far", far);
    await index.upsert("vec_chunks", "near", near);

    const hits = await index.knn("vec_facts", near, 2);
    expect(hits[0]?.id).toBe("near");
    expect(hits[0]?.distance).toBeLessThan(1e-5);
    expect(hits[1]?.id).toBe("far");
    expect(await index.knn("vec_facts", near, 0)).toEqual([]);

    const shifted = new Float32Array(EMBEDDING_DIMENSIONS);
    shifted[2] = 1;
    await index.upsert("vec_facts", "near", shifted);
    expect((await index.knn("vec_facts", shifted, 1))[0]?.id).toBe("near");

    await index.delete(["near"]);
    expect((await index.knn("vec_facts", far, 2)).map((hit) => hit.id)).toEqual(
      ["far"],
    );
    expect(await index.knn("vec_chunks", near, 2)).toEqual([]);
    await index.delete([]);
    await index.delete(["missing"]);
    expect((await index.knn("vec_facts", far, 1)).map((hit) => hit.id)).toEqual(
      ["far"],
    );

    const wrong = new Float32Array(3);
    await expect(index.upsert("vec_facts", "bad", wrong)).rejects.toThrow(
      /768/,
    );
    db.close();
  });
});

describe("content indexer", () => {
  it("chunks a long turn, indexes a fact, and skips a second pass", async () => {
    const db = openMemoryDatabase(tempDbPath());
    const calls: string[] = [];
    const embedder = {
      async embed(text: string): Promise<Float32Array> {
        calls.push(text);
        return vectorFor(text);
      },
    };
    const indexer = new ContentIndexer({
      db,
      embedder,
      vectors: new SqliteVecIndex(db),
      now: () => 50,
      model: "test-embed",
    });
    db.prepare(
      "INSERT INTO sessions (id, surface, started_at) VALUES ('ses', 'popup', 1)",
    ).run();
    const long = `${"alpha ".repeat(700)}midterm`;
    expect(chunkText(long).length).toBeGreaterThan(1);
    for (const piece of chunkText(long)) {
      expect(piece.length).toBeLessThanOrEqual(MAX_CHUNK_TOKENS * 4);
    }
    db.prepare(
      `INSERT INTO turns (id, session_id, role, content, created_at)
       VALUES ('t1', 'ses', 'user', ?, 2)`,
    ).run(long);
    db.prepare(
      `INSERT INTO facts (id, text, kind, confidence, created_at)
       VALUES ('f1', 'ECE midterm is Friday', 'event', 1, 3)`,
    ).run();

    const first = await indexer.indexPending();
    expect(first.skipped).toBe(false);
    expect(first.turns).toBe(1);
    expect(first.facts).toBe(1);
    expect(first.chunks).toBe(chunkText(long).length);
    expect(calls.every((text) => text.startsWith("search_document: "))).toBe(
      true,
    );
    expect(calls.some((text) => text.includes(QUERY_PREFIX))).toBe(false);
    expect(calls).toHaveLength(first.chunks + 1);

    const rows = db
      .prepare("SELECT chunk_id, text FROM chunks ORDER BY chunk_id")
      .all() as Array<{ chunk_id: string; text: string }>;
    expect(rows[0]?.chunk_id).toBe("t1#0");
    expect(rows.some((row) => row.text.includes("midterm"))).toBe(true);

    const beforeSecond = calls.length;
    const query = await embedder.embed(prefixDocument("ECE midterm is Friday"));
    const index = new SqliteVecIndex(db);
    expect((await index.knn("vec_facts", query, 1))[0]?.id).toBe("f1");

    const second = await indexer.indexPending();
    expect(second).toEqual({ turns: 0, facts: 0, chunks: 0, skipped: false });
    expect(calls).toHaveLength(beforeSecond + 1);
    db.close();
  });

  it("writes nothing when the embedder is down", async () => {
    const db = openMemoryDatabase(tempDbPath());
    const indexer = new ContentIndexer({
      db,
      embedder: new FakeEmbedder(),
      vectors: new SqliteVecIndex(db),
      available: async () => false,
    });
    db.prepare(
      "INSERT INTO sessions (id, surface, started_at) VALUES ('ses', 'popup', 1)",
    ).run();
    db.prepare(
      `INSERT INTO turns (id, session_id, role, content, created_at)
       VALUES ('t1', 'ses', 'user', 'ECE midterm is Friday', 2)`,
    ).run();
    const stats = await indexer.indexPending();
    expect(stats.skipped).toBe(true);
    expect(db.prepare("SELECT count(*) AS n FROM embed_index").get()).toEqual({
      n: 0,
    });
    expect(await new SqliteVecIndex(db).knn("vec_chunks", unit(), 1)).toEqual(
      [],
    );
    db.close();
  });

  it("indexes about 64 chunks per pass and leaves the rest", async () => {
    const db = openMemoryDatabase(tempDbPath());
    let embedded = 0;
    const indexer = new ContentIndexer({
      db,
      embedder: {
        async embed(text: string): Promise<Float32Array> {
          embedded += 1;
          return vectorFor(text);
        },
      },
      vectors: new SqliteVecIndex(db),
      now: () => 50,
      model: "test-embed",
    });
    db.prepare(
      "INSERT INTO sessions (id, surface, started_at) VALUES ('ses', 'popup', 1)",
    ).run();
    const insert = db.prepare(
      `INSERT INTO turns (id, session_id, role, content, created_at)
       VALUES (?, 'ses', 'user', ?, ?)`,
    );
    const total = INDEX_PASS_CHUNK_CAP + DEFAULT_EMBED_BATCH_SIZE;
    for (let index = 0; index < total; index += 1) {
      insert.run(`t${index}`, `note ${index}`, index + 2);
    }
    const first = await indexer.indexPending();
    expect(first).toEqual({
      turns: INDEX_PASS_CHUNK_CAP,
      facts: 0,
      chunks: INDEX_PASS_CHUNK_CAP,
      skipped: false,
    });
    expect(embedded).toBe(INDEX_PASS_CHUNK_CAP);
    const second = await indexer.indexPending();
    expect(second.chunks).toBe(DEFAULT_EMBED_BATCH_SIZE);
    expect(second.skipped).toBe(false);
    expect(embedded).toBe(total);
    expect(db.prepare("SELECT count(*) AS n FROM chunks").get()).toEqual({
      n: total,
    });
    const third = await indexer.indexPending();
    expect(third).toEqual({ turns: 0, facts: 0, chunks: 0, skipped: false });
    db.close();
  });

  it("commits an embed batch before the next batch runs", async () => {
    const db = openMemoryDatabase(tempDbPath());
    let embedded = 0;
    const indexer = new ContentIndexer({
      db,
      embedder: {
        async embed(text: string): Promise<Float32Array> {
          embedded += 1;
          if (embedded > DEFAULT_EMBED_BATCH_SIZE) {
            throw new Error("stop after the first batch");
          }
          return vectorFor(text);
        },
      },
      vectors: new SqliteVecIndex(db),
      now: () => 50,
      model: "test-embed",
    });
    db.prepare(
      "INSERT INTO sessions (id, surface, started_at) VALUES ('ses', 'popup', 1)",
    ).run();
    const insert = db.prepare(
      `INSERT INTO turns (id, session_id, role, content, created_at)
       VALUES (?, 'ses', 'user', ?, ?)`,
    );
    for (let index = 0; index < DEFAULT_EMBED_BATCH_SIZE + 4; index += 1) {
      insert.run(`b${index}`, `batch ${index}`, index + 2);
    }
    const stopped = await indexer.indexPending();
    expect(stopped.skipped).toBe(true);
    expect(stopped.chunks).toBe(DEFAULT_EMBED_BATCH_SIZE);
    expect(db.prepare("SELECT count(*) AS n FROM embed_index").get()).toEqual({
      n: DEFAULT_EMBED_BATCH_SIZE,
    });
    expect(db.prepare("SELECT count(*) AS n FROM chunks").get()).toEqual({
      n: DEFAULT_EMBED_BATCH_SIZE,
    });
    db.close();
  });

  it("deletes vectors for superseded or expired facts and does not embed them", async () => {
    const db = openMemoryDatabase(tempDbPath());
    const calls: string[] = [];
    let now = 1_000;
    let up = true;
    const embedder = {
      async embed(text: string): Promise<Float32Array> {
        calls.push(text);
        return vectorFor(text);
      },
    };
    const indexer = new ContentIndexer({
      db,
      embedder,
      vectors: new SqliteVecIndex(db),
      now: () => now,
      model: "test-embed",
      available: async () => up,
    });
    db.prepare(
      `INSERT INTO facts (id, text, kind, confidence, valid_until, created_at)
       VALUES ('live', 'ECE midterm is Friday', 'event', 1, 5000, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO facts (id, text, kind, confidence, valid_until, created_at)
       VALUES ('old', 'already expired', 'event', 1, 100, 2)`,
    ).run();
    const indexed = await indexer.indexPending();
    expect(indexed.facts).toBe(1);
    expect(calls.some((text) => text.includes("already expired"))).toBe(false);
    const index = new SqliteVecIndex(db);
    const query = vectorFor(prefixDocument("ECE midterm is Friday"));
    expect(
      (await index.knn("vec_facts", query, 5)).map((hit) => hit.id),
    ).toEqual(["live"]);

    db.prepare(
      `INSERT INTO facts (id, text, kind, confidence, valid_until, created_at)
       VALUES ('tomb', 'tombstone', 'event', 1, 1, 3)`,
    ).run();
    db.prepare(
      "UPDATE facts SET superseded_by = 'tomb' WHERE id = 'live'",
    ).run();
    const before = calls.length;
    const dropped = await indexer.indexPending();
    expect(dropped.facts).toBe(0);
    expect(calls).toHaveLength(before);
    expect(await index.knn("vec_facts", query, 5)).toEqual([]);
    expect(
      db
        .prepare("SELECT count(*) AS n FROM embed_index WHERE source = 'fact'")
        .get(),
    ).toEqual({ n: 0 });

    db.prepare(
      `INSERT INTO facts (id, text, kind, confidence, created_at)
       VALUES ('keep', 'keep this fact', 'event', 1, 4)`,
    ).run();
    up = true;
    expect((await indexer.indexPending()).facts).toBe(1);
    const kept = vectorFor(prefixDocument("keep this fact"));
    expect((await index.knn("vec_facts", kept, 1))[0]?.id).toBe("keep");
    db.prepare(
      "UPDATE facts SET superseded_by = 'tomb' WHERE id = 'keep'",
    ).run();
    up = false;
    const whileDown = await indexer.indexPending();
    expect(whileDown.skipped).toBe(true);
    expect(await index.knn("vec_facts", kept, 1)).toEqual([]);
    now = 9_000;
    db.prepare(
      `INSERT INTO facts (id, text, kind, confidence, valid_until, created_at)
       VALUES ('soon', 'expires later', 'event', 1, 8000, 5)`,
    ).run();
    up = true;
    expect((await indexer.indexPending()).facts).toBe(0);
    expect(calls.some((text) => text.includes("expires later"))).toBe(false);
    db.close();
  });

  it("redoes a multi-chunk turn that fails midway through a later batch", async () => {
    const db = openMemoryDatabase(tempDbPath());
    let calls = 0;
    let failAt = 17;
    const indexer = new ContentIndexer({
      db,
      vectors: new SqliteVecIndex(db),
      now: () => 5,
      model: "m",
      embedder: {
        async embed(_text: string): Promise<Float32Array> {
          calls += 1;
          if (calls === failAt) {
            throw new Error("x");
          }
          return vectorFor(String(calls));
        },
      },
    });
    db.prepare(
      "INSERT INTO sessions (id, surface, started_at) VALUES ('s', 'popup', 1)",
    ).run();
    const insert = db.prepare(
      `INSERT INTO turns (id, session_id, role, content, created_at)
       VALUES (?, 's', 'user', ?, ?)`,
    );
    for (let index = 0; index < 10; index += 1) {
      insert.run(`a${index}`, `short ${index}`, index + 1);
    }
    const long = Array.from({ length: 3000 }, (_, index) => `w${index}`).join(
      " ",
    );
    const expected = chunkText(long).length;
    expect(expected).toBeGreaterThan(8);
    insert.run("big", long, 100);
    const first = await indexer.indexPending();
    expect(first.skipped).toBe(true);
    expect(first.chunks).toBe(16);
    expect(countRows(db, "embed_index", "source_id = 'big'")).toBe(6);
    failAt = -1;
    const second = await indexer.indexPending();
    expect(second.skipped).toBe(false);
    expect(countRows(db, "embed_index", "source_id = 'big'")).toBe(expected);
    expect(countRows(db, "chunks", "first_turn = 'big'")).toBe(expected);
    expect(countRows(db, "vec_chunks")).toBe(10 + expected);
    expect(countRows(db, "embed_index")).toBe(10 + expected);
    const third = await indexer.indexPending();
    expect(third).toEqual({ turns: 0, facts: 0, chunks: 0, skipped: false });
    db.close();
  });

  it("indexes a live fact when dead-fact cleanup throws", async () => {
    const db = openMemoryDatabase(tempDbPath());
    const inner = new SqliteVecIndex(db);
    const indexer = new ContentIndexer({
      db,
      embedder: {
        async embed(text: string): Promise<Float32Array> {
          return vectorFor(text);
        },
      },
      vectors: {
        upsert: (table, id, embedding) => inner.upsert(table, id, embedding),
        knn: (table, query, k) => inner.knn(table, query, k),
        delete: async (ids: string[]) => {
          if (ids.includes("dead")) {
            throw new Error("sweep throws");
          }
          await inner.delete(ids);
        },
      },
      now: () => 1_000,
      model: "test-embed",
    });
    db.prepare(
      `INSERT INTO facts (id, text, kind, confidence, valid_until, created_at)
       VALUES ('dead', 'already expired', 'event', 1, 100, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO embed_index (
         id, vec_table, source, source_id, model, tokens, created_at
       ) VALUES ('dead', 'vec_facts', 'fact', 'dead', 'test-embed', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO facts (id, text, kind, confidence, created_at)
       VALUES ('live', 'ECE midterm is Friday', 'event', 1, 2)`,
    ).run();
    const stderr = captureStderr();
    try {
      const indexed = await indexer.indexPending();
      expect(indexed.facts).toBe(1);
      expect(indexed.skipped).toBe(false);
      expect(stderr.text()).toContain(
        "cookie-core: dead-fact cleanup failed: sweep throws",
      );
    } finally {
      stderr.restore();
    }
    expect(countRows(db, "embed_index", "source_id = 'live'")).toBe(1);
    const query = vectorFor(prefixDocument("ECE midterm is Friday"));
    expect((await inner.knn("vec_facts", query, 1))[0]?.id).toBe("live");
    db.close();
  });

  it("skips a turn after repeated failures and still indexes later work", async () => {
    const db = openMemoryDatabase(tempDbPath());
    const bad = Array.from({ length: 20 }, () => "b".repeat(2000)).join(" ");
    expect(chunkText(bad).length).toBeGreaterThanOrEqual(
      DEFAULT_EMBED_BATCH_SIZE,
    );
    let badEmbeds = 0;
    const indexer = new ContentIndexer({
      db,
      embedder: {
        async embed(text: string): Promise<Float32Array> {
          if (text.includes("bbbb")) {
            badEmbeds += 1;
            throw new Error("bad turn");
          }
          return vectorFor(text);
        },
      },
      vectors: new SqliteVecIndex(db),
      now: () => 50,
      model: "test-embed",
    });
    db.prepare(
      "INSERT INTO sessions (id, surface, started_at) VALUES ('ses', 'popup', 1)",
    ).run();
    db.prepare(
      `INSERT INTO turns (id, session_id, role, content, created_at)
       VALUES ('old', 'ses', 'user', ?, 1)`,
    ).run(bad);
    db.prepare(
      `INSERT INTO turns (id, session_id, role, content, created_at)
       VALUES ('new', 'ses', 'user', 'fresh note', 2)`,
    ).run();
    db.prepare(
      `INSERT INTO facts (id, text, kind, confidence, created_at)
       VALUES ('early', 'keep this fact', 'event', 1, 3)`,
    ).run();
    for (let attempt = 0; attempt < INDEX_TURN_ATTEMPT_LIMIT; attempt += 1) {
      const failed = await indexer.indexPending();
      expect(failed.skipped).toBe(true);
      expect(countRows(db, "embed_index", "source_id = 'new'")).toBe(0);
    }
    expect(badEmbeds).toBe(INDEX_TURN_ATTEMPT_LIMIT);
    expect(countRows(db, "embed_index", "source_id = 'early'")).toBe(1);
    expect(countRows(db, "embed_index", "source_id = 'old'")).toBe(0);
    db.prepare(
      `INSERT INTO facts (id, text, kind, confidence, created_at)
       VALUES ('later', 'index after the limit', 'event', 1, 4)`,
    ).run();
    const recovered = await indexer.indexPending();
    expect(recovered.skipped).toBe(false);
    expect(recovered.turns).toBe(1);
    expect(recovered.facts).toBe(1);
    expect(badEmbeds).toBe(INDEX_TURN_ATTEMPT_LIMIT);
    expect(countRows(db, "embed_index", "source_id = 'new'")).toBe(1);
    expect(countRows(db, "embed_index", "source_id = 'later'")).toBe(1);
    expect(countRows(db, "embed_index", "source_id = 'old'")).toBe(0);
    db.close();
  });

  it("skips a turn listed in forgotten_turns and indexes its sibling", async () => {
    const db = openMemoryDatabase(tempDbPath());
    const calls: string[] = [];
    const indexer = new ContentIndexer({
      db,
      embedder: {
        async embed(text: string): Promise<Float32Array> {
          calls.push(text);
          return vectorFor(text);
        },
      },
      vectors: new SqliteVecIndex(db),
      now: () => 50,
      model: "test-embed",
    });
    db.prepare(
      "INSERT INTO sessions (id, surface, started_at) VALUES ('ses', 'popup', 1)",
    ).run();
    const insert = db.prepare(
      `INSERT INTO turns (id, session_id, role, content, created_at)
       VALUES (?, 'ses', 'user', ?, ?)`,
    );
    insert.run("old", "forget this turn", 1);
    insert.run("sib", "keep this turn", 2);
    db.exec("CREATE TABLE forgotten_turns (turn_id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO forgotten_turns (turn_id) VALUES ('old')").run();
    const indexed = await indexer.indexPending();
    expect(indexed.turns).toBe(1);
    expect(indexed.skipped).toBe(false);
    expect(countRows(db, "embed_index", "source_id = 'old'")).toBe(0);
    expect(countRows(db, "embed_index", "source_id = 'sib'")).toBe(1);
    expect(calls.some((text) => text.includes("forget this turn"))).toBe(false);
    db.close();
  });

  it("skips a forgotten_turns row keyed by id", async () => {
    const db = openMemoryDatabase(tempDbPath());
    const indexer = new ContentIndexer({
      db,
      embedder: {
        async embed(text: string): Promise<Float32Array> {
          return vectorFor(text);
        },
      },
      vectors: new SqliteVecIndex(db),
      now: () => 50,
      model: "test-embed",
    });
    db.prepare(
      "INSERT INTO sessions (id, surface, started_at) VALUES ('ses', 'popup', 1)",
    ).run();
    db.prepare(
      `INSERT INTO turns (id, session_id, role, content, created_at)
       VALUES ('old', 'ses', 'user', 'forget this turn', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO turns (id, session_id, role, content, created_at)
       VALUES ('sib', 'ses', 'user', 'keep this turn', 2)`,
    ).run();
    db.exec("CREATE TABLE forgotten_turns (id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO forgotten_turns (id) VALUES ('old')").run();
    const indexed = await indexer.indexPending();
    expect(indexed.turns).toBe(1);
    expect(countRows(db, "embed_index", "source_id = 'old'")).toBe(0);
    expect(countRows(db, "embed_index", "source_id = 'sib'")).toBe(1);
    db.close();
  });

  it("skips turns named by forgottenTurnIds when the table is absent", async () => {
    const db = openMemoryDatabase(tempDbPath());
    const indexer = new ContentIndexer({
      db,
      embedder: {
        async embed(text: string): Promise<Float32Array> {
          return vectorFor(text);
        },
      },
      vectors: new SqliteVecIndex(db),
      now: () => 50,
      model: "test-embed",
      forgottenTurnIds: () => ["old"],
    });
    db.prepare(
      "INSERT INTO sessions (id, surface, started_at) VALUES ('ses', 'popup', 1)",
    ).run();
    db.prepare(
      `INSERT INTO turns (id, session_id, role, content, created_at)
       VALUES ('old', 'ses', 'user', 'forget this turn', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO turns (id, session_id, role, content, created_at)
       VALUES ('sib', 'ses', 'user', 'keep this turn', 2)`,
    ).run();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'forgotten_turns'")
      .all();
    expect(tables).toEqual([]);
    const indexed = await indexer.indexPending();
    expect(indexed.turns).toBe(1);
    expect(countRows(db, "embed_index", "source_id = 'old'")).toBe(0);
    expect(countRows(db, "embed_index", "source_id = 'sib'")).toBe(1);
    db.close();
  });
});

function countRows(
  db: { prepare(sql: string): { get(): unknown } },
  table: string,
  where?: string,
): number {
  const sql =
    where === undefined
      ? `SELECT count(*) AS n FROM ${table}`
      : `SELECT count(*) AS n FROM ${table} WHERE ${where}`;
  const row = db.prepare(sql).get() as { n: number };
  return row.n;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
    );
    return true;
  }) as typeof process.stderr.write;
  return {
    text: () => chunks.join(""),
    restore: () => {
      process.stderr.write = original;
    },
  };
}

function vectorFor(text: string): Float32Array {
  const out = new Float32Array(EMBEDDING_DIMENSIONS);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash >>>= 0;
  out[hash % EMBEDDING_DIMENSIONS] = 1;
  return out;
}

function unit(): Float32Array {
  const out = new Float32Array(EMBEDDING_DIMENSIONS);
  out[0] = 1;
  return out;
}
