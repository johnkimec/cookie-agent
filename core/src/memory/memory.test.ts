import { describe, expect, it } from "vitest";
import { InMemoryConsolidator } from "./consolidate.ts";
import { FakeEmbedder } from "./embedder.ts";
import { InMemoryReflector } from "./reflect.ts";
import { InMemoryRetriever } from "./retrieve.ts";
import { InMemoryMemoryStore } from "./store.ts";
import {
  EMBEDDING_DIMENSIONS,
  type SessionRecord,
  type TurnRecord,
} from "./types.ts";
import { InMemoryVectorIndex } from "./vectors.ts";

function session(id: string): SessionRecord {
  return {
    id,
    surface: "popup",
    startedAt: 1,
    endedAt: null,
    summary: null,
  };
}

function turn(id: string, sessionId: string, createdAt: number): TurnRecord {
  return {
    id,
    sessionId,
    role: "user",
    content: id,
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

describe("memory contracts", () => {
  it("appends sessions and returns the last turns oldest first", () => {
    const store = new InMemoryMemoryStore();
    store.appendSession(session("ses-1"));
    store.appendTurn(turn("t2", "ses-1", 20));
    store.appendTurn(turn("t1", "ses-1", 10));
    store.appendTurn(turn("t3", "ses-1", 30));
    store.appendSession(session("ses-2"));
    store.appendTurn(turn("other", "ses-2", 15));

    expect(store.recentTurns("ses-1", 2).map((row) => row.id)).toEqual([
      "t2",
      "t3",
    ]);
    expect(store.recentTurns("ses-1", 0)).toEqual([]);
    expect(() => store.appendSession(session("ses-1"))).toThrow(
      /session already exists/,
    );
    expect(() => store.appendTurn(turn("t1", "ses-1", 10))).toThrow(
      /turn already exists/,
    );
    expect(() => store.appendTurn(turn("missing", "ses-missing", 1))).toThrow(
      /unknown session/,
    );
    expect(store.listSessions().map((row) => row.id)).toEqual([
      "ses-1",
      "ses-2",
    ]);
    expect(
      store.listSessions({ needsReflect: true }).map((row) => row.id),
    ).toEqual(["ses-1", "ses-2"]);
    store.appendSession({ ...session("ses-3"), summary: "done" });
    expect(
      store.listSessions({ needsReflect: false }).map((row) => row.id),
    ).toEqual(["ses-3"]);
  });

  it("embeds offline to a stable 768-d vector", async () => {
    const embedder = new FakeEmbedder();
    const first = await embedder.embed("ECE midterm is Friday");
    const second = await embedder.embed("ECE midterm is Friday");
    const other = await embedder.embed("packing list");
    expect(first).toBeInstanceOf(Float32Array);
    expect(first.length).toBe(EMBEDDING_DIMENSIONS);
    expect(Array.from(first)).toEqual(Array.from(second));
    expect(Array.from(first)).not.toEqual(Array.from(other));
  });

  it("ranks an identical vector ahead of an orthogonal one", async () => {
    const index = new InMemoryVectorIndex();
    const near = new Float32Array(EMBEDDING_DIMENSIONS);
    near[0] = 1;
    const far = new Float32Array(EMBEDDING_DIMENSIONS);
    far[1] = 1;
    await index.upsert("vec_facts", "near", near);
    await index.upsert("vec_facts", "far", far);
    await index.upsert("vec_chunks", "chunk", near);

    const hits = await index.knn("vec_facts", near, 2);
    expect(hits.map((hit) => hit.id)).toEqual(["near", "far"]);
    expect(hits[0]?.distance).toBeLessThan(1e-9);
    expect(hits[1]?.distance).toBeGreaterThan(0.5);
    expect(await index.knn("vec_chunks", near, 1)).toEqual([
      { id: "chunk", distance: expect.any(Number) },
    ]);
    expect(await index.knn("vec_facts", near, 0)).toEqual([]);
    await index.delete(["near"]);
    expect(
      (await index.knn("vec_facts", near, 2)).map((hit) => hit.id),
    ).toEqual(["far"]);
    await index.delete([]);
    await index.delete(["missing"]);
    expect(await index.knn("vec_chunks", near, 1)).toEqual([
      { id: "chunk", distance: expect.any(Number) },
    ]);
    await index.delete(["chunk"]);
    expect(await index.knn("vec_chunks", near, 1)).toEqual([]);
    const wrong = new Float32Array(3);
    await expect(index.upsert("vec_facts", "bad", wrong)).rejects.toThrow(
      /768/,
    );
  });

  it("retrieves, reflects, and consolidates through the fakes", async () => {
    const retriever = new InMemoryRetriever();
    retriever.add({
      id: "fact-1",
      text: "ECE midterm is Friday",
      source: "fact",
    });
    retriever.add({
      id: "turn-1",
      text: "packing list for the trip",
      source: "turn",
    });
    await expect(retriever.retrieve("midterm")).resolves.toEqual([
      { id: "fact-1", text: "ECE midterm is Friday", source: "fact" },
    ]);

    const reflector = new InMemoryReflector();
    await reflector.reflect("ses-1");
    expect(reflector.calls).toEqual(["ses-1"]);

    const consolidator = new InMemoryConsolidator();
    await consolidator.consolidate();
    await consolidator.consolidate();
    expect(consolidator.runs).toBe(2);
  });
});
