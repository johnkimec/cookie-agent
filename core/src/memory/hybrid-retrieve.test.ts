import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatLog } from "./chat-log.ts";
import { prefixQuery } from "./http-embedder.ts";
import {
  DEFAULT_RRF_WEIGHTS,
  ftsOrQuery,
  HybridRetriever,
  readRrfWeights,
} from "./hybrid-retrieve.ts";
import { openMemoryDatabase } from "./migrate.ts";
import { fuseRrf } from "./rrf.ts";
import { SqliteMemoryStore } from "./sqlite-store.ts";
import { SqliteVecIndex } from "./sqlite-vec-index.ts";
import { EMBEDDING_DIMENSIONS } from "./types.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cookie-hybrid-"));
  dirs.push(dir);
  return join(dir, "cookie.db");
}

function axis(slot: number): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIMENSIONS);
  vector[slot] = 1;
  return vector;
}

function embedderFor(slots: Map<string, number>) {
  return {
    async embed(text: string): Promise<Float32Array> {
      const raw = text.startsWith("search_query: ")
        ? text.slice("search_query: ".length)
        : text;
      return axis(slots.get(raw) ?? 0);
    },
  };
}

describe("RRF weights", () => {
  it("defaults to vector 1 and bm25 0, and reads the knobs", () => {
    expect(DEFAULT_RRF_WEIGHTS).toEqual({ vector: 1, bm25: 0 });
    expect(readRrfWeights({})).toEqual({ vector: 1, bm25: 0 });
    expect(
      readRrfWeights({ COOKIE_RRF_VECTOR: "1", COOKIE_RRF_BM25: "1" }),
    ).toEqual({ vector: 1, bm25: 1 });
    expect(() => readRrfWeights({ COOKIE_RRF_BM25: "nope" })).toThrow(
      /COOKIE_RRF_BM25/,
    );
    expect(ftsOrQuery('ECE "midterm"')).toBe('"ECE" OR "midterm"');
    expect(
      fuseRrf(
        [
          { weight: 0, ids: ["a"] },
          { weight: 1, ids: ["b", "a"] },
        ],
        60,
      ).map((row) => row.id),
    ).toEqual(["b", "a"]);
  });
});

describe("hybrid retrieval", () => {
  it("drops superseded and expired facts in the BM25 leg before the limit", async () => {
    const db = openMemoryDatabase(tempPath());
    insertFact(db, "live", "picnic on Friday", null, null);
    insertFact(db, "dead", "picnic picnic picnic", "tomb", null);
    insertFact(db, "old", "picnic last year", null, 10);
    const retriever = new HybridRetriever({
      db,
      vectors: new SqliteVecIndex(db),
      embedder: embedderFor(new Map()),
      available: async () => false,
      now: () => 1000,
      pool: 1,
      weights: { vector: 0, bm25: 1 },
    });
    const memories = await retriever.retrieve("picnic");
    expect(memories.map((memory) => memory.id)).toEqual(["live"]);
    db.close();
  });

  it("drops superseded facts in the vector leg before they take the top slot", async () => {
    const db = openMemoryDatabase(tempPath());
    insertFact(db, "live", "alpha picnic", null, null);
    insertFact(db, "dead", "nearest picnic", "tomb", null);
    insertFact(db, "stale", "old picnic", null, 10);
    const index = new SqliteVecIndex(db);
    await index.upsert("vec_facts", "dead", axis(0));
    await index.upsert("vec_facts", "stale", axis(0));
    await index.upsert("vec_facts", "live", axis(1));
    const slots = new Map<string, number>([["picnic", 0]]);
    const retriever = new HybridRetriever({
      db,
      vectors: index,
      embedder: embedderFor(slots),
      now: () => 1000,
      pool: 1,
      weights: { vector: 1, bm25: 0 },
    });
    const memories = await retriever.retrieve("picnic");
    expect(memories.map((memory) => memory.id)).toEqual(["live"]);
    expect(prefixQuery("picnic").startsWith("search_query: ")).toBe(true);
    db.close();
  });

  it("uses BM25 when the embedder is down even if the BM25 weight is 0", async () => {
    const path = tempPath();
    const store = SqliteMemoryStore.open(path);
    store.appendSession({
      id: "ses",
      surface: "popup",
      startedAt: 1,
      endedAt: null,
      summary: null,
    });
    store.appendTurn({
      id: "t1",
      sessionId: "ses",
      role: "user",
      content: "The ECE midterm is Friday. Remember marmalade417.",
      tainted: false,
      model: null,
      egress: false,
      escalatedFrom: null,
      tokensIn: null,
      tokensCached: null,
      tokensOut: null,
      costUsd: null,
      latencyMs: null,
      createdAt: 2,
    });
    let embeds = 0;
    const retriever = new HybridRetriever({
      db: store.database(),
      vectors: new SqliteVecIndex(store.database()),
      embedder: {
        async embed(text: string): Promise<Float32Array> {
          embeds += 1;
          return axis(text.length % 8);
        },
      },
      available: async () => false,
      weights: { vector: 1, bm25: 0 },
    });
    const log = new ChatLog(store, null, retriever);
    store.beginConversation("conv-ask");
    const messages = await log.messagesFor(
      "conv-ask",
      "what did I say about the ECE midterm",
    );
    const last = messages.at(-1);
    expect(last).toEqual({
      role: "user",
      content: "what did I say about the ECE midterm",
    });
    expect(JSON.stringify(messages)).toContain("marmalade417");
    expect(String(last?.content)).not.toContain("marmalade417");
    expect(embeds).toBe(0);
    store.close();
  });

  it("reranks the fused list and keeps fused order when rerank throws", async () => {
    const db = openMemoryDatabase(tempPath());
    insertFact(db, "a", "picnic alpha", null, null);
    insertFact(db, "b", "picnic beta", null, null);
    const shared = {
      db,
      vectors: new SqliteVecIndex(db),
      embedder: embedderFor(new Map()),
      available: async () => false,
      weights: { vector: 0, bm25: 1 },
    };
    const plain = new HybridRetriever(shared);
    const fused = (await plain.retrieve("picnic")).map((memory) => memory.id);
    expect(fused).toHaveLength(2);
    const retriever = new HybridRetriever({
      ...shared,
      rerank: async (_query, candidates) =>
        [...candidates].reverse().slice(0, 8),
    });
    const ranked = await retriever.retrieve("picnic");
    expect(ranked.map((memory) => memory.id)).toEqual([...fused].reverse());

    const slow = new HybridRetriever({
      ...shared,
      rerank: async () => {
        throw new Error("timed out");
      },
    });
    const kept = await slow.retrieve("picnic");
    expect(kept.map((memory) => memory.id)).toEqual(fused);
    db.close();
  });
});

function insertFact(
  db: ReturnType<typeof openMemoryDatabase>,
  id: string,
  text: string,
  supersededBy: string | null,
  validUntil: number | null,
): void {
  if (supersededBy !== null) {
    const existing = db
      .prepare("SELECT id FROM facts WHERE id = ?")
      .get(supersededBy);
    if (existing === undefined) {
      db.prepare(
        `INSERT INTO facts (id, text, kind, confidence, created_at)
         VALUES (?, 'tombstone', 'event', 1, 1)`,
      ).run(supersededBy);
    }
  }
  db.prepare(
    `INSERT INTO facts (
      id, text, kind, confidence, superseded_by, valid_until, created_at
    ) VALUES (?, ?, 'event', 1, ?, ?, 1)`,
  ).run(id, text, supersededBy, validUntil);
}
