import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chunkText, MAX_CHUNK_TOKENS } from "./chunk.ts";
import { FakeEmbedder } from "./embedder.ts";
import { prefixDocument, QUERY_PREFIX } from "./http-embedder.ts";
import { ContentIndexer } from "./index-content.ts";
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
});

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
