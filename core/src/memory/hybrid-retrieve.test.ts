import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatLog } from "./chat-log.ts";
import {
  HttpEmbedder,
  prefixQuery,
  readQueryEmbedTimeoutMs,
} from "./http-embedder.ts";
import {
  DEFAULT_RRF_WEIGHTS,
  ftsOrQuery,
  HybridRetriever,
  KNN_MAX_K,
  readRrfWeights,
} from "./hybrid-retrieve.ts";
import { openMemoryDatabase } from "./migrate.ts";
import { fuseRrf } from "./rrf.ts";
import { SqliteMemoryStore } from "./sqlite-store.ts";
import { SqliteVecIndex } from "./sqlite-vec-index.ts";
import { EMBEDDING_DIMENSIONS } from "./types.ts";
import type { VectorIndex } from "./vectors.ts";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  await Promise.all(
    hangers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
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
  it("defaults to vector 1 and bm25 1, and reads the knobs", () => {
    expect(DEFAULT_RRF_WEIGHTS).toEqual({ vector: 1, bm25: 1 });
    expect(readRrfWeights({})).toEqual({ vector: 1, bm25: 1 });
    expect(readRrfWeights({ COOKIE_RRF_BM25: "0" })).toEqual({
      vector: 1,
      bm25: 0,
    });
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

  it("keeps a forgotten turn out of the assembled context", async () => {
    const store = SqliteMemoryStore.open(tempPath());
    const db = store.database();
    store.appendSession({
      id: "ses",
      surface: "popup",
      startedAt: 1,
      endedAt: null,
      summary: null,
    });
    store.appendTurn(turn("t-live", "ses", "picnic LIVECODE", 2));
    store.appendTurn(turn("t-mid", "ses", "picnic picnic picnic GONECODE", 3));
    store.appendTurn(turn("t-end", "ses", "closing remark", 4));
    db.prepare("UPDATE sessions SET summary = ? WHERE id = ?").run(
      "summary picnic GONECODE",
      "ses",
    );
    db.prepare(
      `INSERT INTO journal (id, day, entry, session_id, created_at)
       VALUES ('j1', '2026-10-25', 'journal picnic GONECODE', 'ses', 5)`,
    ).run();
    insertChunk(
      db,
      "embed-only",
      "ses",
      "t-live",
      "t-live",
      "embed picnic GONECODE",
    );
    insertChunk(
      db,
      "span-1",
      "ses",
      "t-live",
      "t-end",
      "window picnic GONECODE",
    );
    insertChunk(
      db,
      "summary-ses",
      "ses",
      null,
      null,
      "summary picnic GONECODE",
    );
    insertChunk(
      db,
      "journal-ses",
      "ses",
      "t-live",
      "t-live",
      "journal picnic GONECODE",
    );
    insertChunk(
      db,
      "t-mid#0",
      "ses",
      "t-mid",
      "t-mid",
      "chunk picnic GONECODE",
    );
    insertChunk(
      db,
      "t-live#0",
      "ses",
      "t-live",
      "t-live",
      "chunk picnic LIVECODE",
    );
    db.prepare(
      `INSERT INTO embed_index (
        id, vec_table, source, source_id, model, tokens, created_at
      ) VALUES ('embed-only', 'vec_chunks', 'turn', 't-mid', 'nomic', 1, 1)`,
    ).run();
    const index = new SqliteVecIndex(db);
    await index.upsert("vec_chunks", "embed-only", axis(0));
    await index.upsert("vec_chunks", "span-1", axis(0));
    await index.upsert("vec_chunks", "summary-ses", axis(0));
    await index.upsert("vec_chunks", "journal-ses", axis(0));
    await index.upsert("vec_chunks", "t-mid#0", axis(0));
    await index.upsert("vec_chunks", "t-live#0", axis(1));
    const slots = new Map<string, number>([["picnic", 0]]);
    const forgotten = {
      forgottenTurnIds(): string[] {
        return ["t-mid"];
      },
    };

    const vectorBlob = await ask(store, {
      db,
      vectors: index,
      embedder: embedderFor(slots),
      store: forgotten,
      pool: 1,
    });
    expect(vectorBlob).toContain("LIVECODE");
    expect(vectorBlob).not.toContain("GONECODE");

    const lexicalBlob = await ask(store, {
      db,
      vectors: index,
      embedder: embedderFor(slots),
      store: forgotten,
      available: async () => false,
      pool: 1,
    });
    expect(lexicalBlob).toContain("LIVECODE");
    expect(lexicalBlob).not.toContain("GONECODE");

    const openBlob = await ask(store, {
      db,
      vectors: index,
      embedder: embedderFor(slots),
      store,
      available: async () => false,
      pool: 1,
    });
    expect(openBlob).toContain("GONECODE");
    store.close();
  });

  it("fuses a turn that both legs hit above single-leg hits", async () => {
    const store = SqliteMemoryStore.open(tempPath());
    const db = store.database();
    store.appendSession({
      id: "ses",
      surface: "popup",
      startedAt: 1,
      endedAt: null,
      summary: null,
    });
    store.appendTurn(turn("lexical", "ses", "picnic picnic picnic", 2));
    store.appendTurn(turn("both", "ses", "picnic apple", 3));
    store.appendTurn(turn("vector", "ses", "zebra marker", 4));
    insertChunk(db, "both#0", "ses", "both", "both", "picnic apple chunk");
    insertChunk(db, "vector#0", "ses", "vector", "vector", "zebra chunk");
    const index = new SqliteVecIndex(db);
    await index.upsert("vec_chunks", "both#0", axis(0));
    await index.upsert("vec_chunks", "vector#0", axis(1));
    const retriever = new HybridRetriever({
      db,
      vectors: index,
      embedder: embedderFor(new Map([["picnic", 0]])),
    });
    const memories = await retriever.retrieve("picnic");
    expect(memories.map((memory) => memory.id).slice(0, 3)).toEqual([
      "both",
      "lexical",
      "vector",
    ]);
    store.close();
  });

  it("returns a live fact past 2600 nearer dead facts without passing k 4096", async () => {
    const db = openMemoryDatabase(tempPath());
    insertFact(db, "tomb", "tombstone", null, null);
    const fact = db.prepare(
      `INSERT INTO facts (
        id, text, kind, confidence, superseded_by, created_at
      ) VALUES (?, 'dead picnic', 'event', 1, 'tomb', 1)`,
    );
    const vec = db.prepare(
      "INSERT INTO vec_facts (fact_id, embedding) VALUES (?, ?)",
    );
    const near = axis(0);
    const write = db.transaction(() => {
      for (let index = 0; index < 2600; index += 1) {
        const id = `dead-${index}`;
        fact.run(id);
        vec.run(id, near);
      }
    });
    write();
    insertFact(db, "live", "far marker LIVEFACT", null, null);
    const index = new SqliteVecIndex(db);
    await index.upsert("vec_facts", "live", axis(1));
    const asked: number[] = [];
    const vectors: VectorIndex = {
      async upsert(table, id, embedding) {
        await index.upsert(table, id, embedding);
      },
      async delete(ids) {
        await index.delete(ids);
      },
      async knn(table, query, k) {
        asked.push(k);
        if (k > KNN_MAX_K) {
          throw new Error(`k ${k} is above ${KNN_MAX_K}`);
        }
        return index.knn(table, query, k);
      },
    };
    const retriever = new HybridRetriever({
      db,
      vectors,
      embedder: embedderFor(new Map([["picnic", 0]])),
      pool: 1,
      weights: { vector: 1, bm25: 0 },
    });
    const memories = await retriever.retrieve("picnic");
    expect(memories.map((memory) => memory.id)).toEqual(["live"]);
    expect(Math.max(...asked)).toBeLessThanOrEqual(KNN_MAX_K);
    expect(asked.some((k) => k > 2048)).toBe(true);
    db.close();
  }, 30_000);

  it("keeps chunk hits when the facts kNN throws", async () => {
    const db = openMemoryDatabase(tempPath());
    insertChunk(db, "solo#0", "ses", "solo", "solo", "chunk ONLYCHUNK");
    const vectors: VectorIndex = {
      async upsert() {
        return undefined;
      },
      async delete() {
        return undefined;
      },
      async knn(table, _query, k) {
        if (k > KNN_MAX_K) {
          throw new Error(`k ${k}`);
        }
        if (table === "vec_facts") {
          throw new Error("facts knn failed");
        }
        return [{ id: "solo#0", distance: 0 }];
      },
    };
    const retriever = new HybridRetriever({
      db,
      vectors,
      embedder: embedderFor(new Map([["picnic", 0]])),
      pool: 1,
      weights: { vector: 1, bm25: 0 },
    });
    const memories = await retriever.retrieve("picnic");
    expect(memories.map((memory) => memory.id)).toEqual(["solo"]);
    expect(memories[0]?.text).toContain("ONLYCHUNK");
    db.close();
  });

  it("falls back to BM25 when the embedder hangs past the query timeout", async () => {
    const store = SqliteMemoryStore.open(tempPath());
    store.appendSession({
      id: "ses",
      surface: "popup",
      startedAt: 1,
      endedAt: null,
      summary: null,
    });
    store.appendTurn(
      turn("t1", "ses", "The ECE midterm is Friday. Remember marmalade417.", 2),
    );
    const hung = await hangServer();
    try {
      const retriever = new HybridRetriever({
        db: store.database(),
        vectors: new SqliteVecIndex(store.database()),
        embedder: new HttpEmbedder({
          port: hung.port,
          timeoutMs: readQueryEmbedTimeoutMs({}),
        }),
        available: async () => true,
        weights: { vector: 1, bm25: 0 },
      });
      const log = new ChatLog(store, null, retriever);
      const started = Date.now();
      const messages = await log.messagesFor(
        "conv-ask",
        "what did I say about the ECE midterm",
      );
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(2_000);
      expect(elapsed).toBeGreaterThan(200);
      expect(JSON.stringify(messages)).toContain("marmalade417");
      expect(readQueryEmbedTimeoutMs({})).toBe(400);
    } finally {
      await hung.close();
      store.close();
    }
  });

  it("stops retrieval when the chat signal aborts", async () => {
    const store = SqliteMemoryStore.open(tempPath());
    store.appendSession({
      id: "ses",
      surface: "popup",
      startedAt: 1,
      endedAt: null,
      summary: null,
    });
    store.appendTurn(turn("t1", "ses", "picnic LIVECODE", 2));
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const retriever = new HybridRetriever({
      db: store.database(),
      vectors: new SqliteVecIndex(store.database()),
      embedder: {
        async embed() {
          markStarted();
          return new Promise<Float32Array>(() => undefined);
        },
      },
      available: async () => true,
    });
    const log = new ChatLog(store, null, retriever);
    const controller = new AbortController();
    const pending = log.messagesFor("conv-ask", "picnic", controller.signal);
    await started;
    const mark = Date.now();
    controller.abort();
    const messages = await pending;
    expect(Date.now() - mark).toBeLessThan(500);
    expect(JSON.stringify(messages)).toContain("picnic");
    store.close();
  });
});

const hangers: Server[] = [];

function hangServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((_request, response) => {
      response.writeHead(200);
    });
    hangers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("hang server has no port"));
        return;
      }
      const info = address as AddressInfo;
      resolve({
        port: info.port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function turn(
  id: string,
  sessionId: string,
  content: string,
  createdAt: number,
) {
  return {
    id,
    sessionId,
    role: "user" as const,
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

function insertChunk(
  db: ReturnType<typeof openMemoryDatabase>,
  id: string,
  sessionId: string,
  firstTurn: string | null,
  lastTurn: string | null,
  text: string,
): void {
  db.prepare(
    `INSERT INTO chunks (chunk_id, session_id, first_turn, last_turn, text)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, sessionId, firstTurn, lastTurn, text);
}

async function ask(
  store: SqliteMemoryStore,
  options: ConstructorParameters<typeof HybridRetriever>[0],
): Promise<string> {
  const log = new ChatLog(store, null, new HybridRetriever(options));
  const messages = await log.messagesFor("conv-ask", "picnic");
  return JSON.stringify(messages);
}

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
