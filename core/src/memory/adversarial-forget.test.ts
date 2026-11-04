import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatLog } from "./chat-log.ts";
import { randomIds } from "./derived.ts";
import { FakeEmbedder } from "./embedder.ts";
import { HybridRetriever } from "./hybrid-retrieve.ts";
import { ContentIndexer } from "./index-content.ts";
import { LocalReflector } from "./reflect-job.ts";
import { createMemoryRuntime } from "./runtime.ts";
import { localDay } from "./schedule.ts";
import { SqliteMemoryStore } from "./sqlite-store.ts";
import { SqliteVecIndex } from "./sqlite-vec-index.ts";
import { MEMORY_FORGET_TOOL, MEMORY_REMEMBER_TOOL } from "./tools.ts";
import { EMBEDDING_DIMENSIONS } from "./types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const opts = { toolCallId: "c", messages: [], context: undefined as never };
function dbPath() {
  const d = mkdtempSync(join(tmpdir(), "adv-forget-"));
  dirs.push(d);
  return join(d, "cookie.db");
}
const SECRET = "4417";

function setup() {
  let clock = 1_000;
  const now = () => (clock += 10);
  const store = SqliteMemoryStore.open(dbPath(), { now });
  const db = store.database();
  const vectors = new SqliteVecIndex(db);
  const embedder = new FakeEmbedder();
  const indexer = new ContentIndexer({
    db,
    embedder,
    vectors,
    now,
    available: async () => true,
  });
  const retriever = new HybridRetriever({
    db,
    vectors,
    embedder,
    store,
    available: async () => true,
  });
  const log = new ChatLog(store, indexer, retriever);
  const runtime = createMemoryRuntime({
    store,
    derived: store,
    embedder,
    vectors,
    now,
    recordTurns: false,
    log: () => undefined,
    complete: async () =>
      JSON.stringify({ journal: "", summary: "", facts: [], profile: [] }),
  });
  let reflectReply = "";
  const reflectPrompts: string[] = [];
  const reflector = new LocalReflector({
    store,
    derived: store,
    embedder,
    vectors,
    complete: async (a) => {
      reflectPrompts.push(a.prompt);
      return reflectReply;
    },
    now,
    timeZone: "UTC",
    localDay,
    factIds: randomIds("fact"),
    journalIds: randomIds("journal"),
  });
  const turn = async (
    conv: string,
    user: string,
    reply: string,
    tool?: () => Promise<unknown>,
  ) => {
    const msgs = await log.messagesFor(conv, user);
    runtime.host.noteUserTurn?.(log.currentUserTurnId() ?? "");
    const out = tool ? await tool() : undefined;
    log.commit({
      conversationId: conv,
      userText: user,
      assistantText: reply,
      modelId: null,
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 1,
    });
    await log.flushIndex();
    return { msgs, out };
  };
  const tool = (name: string, input: unknown) => () =>
    runtime.host.tools[name]?.execute?.(
      input as never,
      opts,
    ) as Promise<unknown>;
  return {
    store,
    db,
    vectors,
    indexer,
    retriever,
    log,
    runtime,
    reflector,
    turn,
    tool,
    setReflect: (r: unknown) => {
      reflectReply = JSON.stringify(r);
    },
    reflectPrompts,
  };
}

function derivedDump(db: ReturnType<SqliteMemoryStore["database"]>) {
  const q = (sql: string) => JSON.stringify(db.prepare(sql).all());
  return {
    facts: q("SELECT * FROM facts"),
    facts_fts: q("SELECT rowid, text FROM facts_fts"),
    profile: q("SELECT * FROM profile"),
    journal: q("SELECT * FROM journal"),
    summaries: q("SELECT id, summary FROM sessions"),
    chunks: q("SELECT * FROM chunks"),
  };
}

describe("adversarial forget (reviewer)", () => {
  it("purges every derived copy of 4417 across echo, reflect, forget, rebuild, reflect", async () => {
    const h = setup();
    await h.turn("a", "hi there", "hello John");
    const stated = await h.turn(
      "a",
      "remember my locker code is 4417",
      "Saved: locker #4417.",
      h.tool(MEMORY_REMEMBER_TOOL, {
        text: "John's locker code is 4417",
        kind: "event",
        aboutJohn: true,
      }),
    );
    expect(stated.out).toMatchObject({});
    await h.turn("a", "what is the weather", "It is sunny.");
    const turnIds = h.store.recentTurns("a", 100).map((t) => t.id);
    const statedTurn = turnIds[2] as string;
    // straddling chunk across hello..weather (summary-style span)
    h.store.upsertChunk({
      chunkId: "straddle",
      sessionId: "a",
      firstTurn: turnIds[0] ?? null,
      lastTurn: turnIds[5] ?? null,
      text: "hi there / weather chat",
    });
    const v = new Float32Array(EMBEDDING_DIMENSIONS);
    v[0] = 1;
    await h.vectors.upsert("vec_chunks", "straddle", v);
    // reflect writes a second fact, two profile rows (one paraphrased) and a summary that echoes 4417
    h.setReflect({
      journal: "John stored his gym locker 4417.",
      summary: "John's locker is 4417; weather sunny.",
      facts: [
        {
          text: "Locker code is 4417",
          kind: "event",
          subject: null,
          confidence: 0.9,
          sensitive: true,
          validUntil: null,
          sourceTurn: statedTurn,
          contradicts: null,
        },
      ],
      profile: [
        {
          key: "locker",
          value: "4417",
          statedByJohn: true,
          stable: true,
          sessionsObserved: 1,
          shareable: false,
          sensitive: true,
          pinned: false,
        },
        {
          key: "gym_locker",
          value: "Gym locker #4417",
          statedByJohn: true,
          stable: true,
          sessionsObserved: 1,
          shareable: false,
          sensitive: true,
          pinned: false,
        },
        {
          key: "city",
          value: "Toronto",
          statedByJohn: true,
          stable: true,
          sessionsObserved: 1,
          shareable: true,
          sensitive: false,
          pinned: false,
        },
      ],
    });
    await h.reflector.reflect("a");
    await h.indexer.indexPending();
    const before = derivedDump(h.db);
    expect(before.facts).toContain(SECRET);
    expect(before.profile).toContain("Gym locker #4417");
    expect(h.store.summary("a") ?? "").toContain(SECRET);

    // forget with natural wording: two partial matches, no exact -> ambiguous, nothing deleted
    const amb = await h.tool(MEMORY_FORGET_TOOL, { text: "locker code" })();
    expect(amb).toMatchObject({ forgotten: false, reason: "ambiguous" });
    expect((amb as { candidates: unknown[] }).candidates).toHaveLength(2);
    expect(derivedDump(h.db).facts).toBe(before.facts);

    // the model then forgets by exact text, then the leftover by id, inside a forget-request turn
    const facts = h.store.listFacts().filter((f) => f.text.includes(SECRET));
    const results: unknown[] = [];
    await h.turn(
      "a",
      "forget my locker code",
      "Done, I forgot your locker code.",
      async () => {
        results.push(
          await h.tool(MEMORY_FORGET_TOOL, {
            text: "John's locker code is 4417",
          })(),
        );
        for (const f of h.store
          .listFacts()
          .filter((x) => x.text.includes(SECRET))) {
          results.push(await h.tool(MEMORY_FORGET_TOOL, { factId: f.id })());
        }
      },
    );
    expect(results[0]).toMatchObject({ forgotten: true });
    expect(facts.length).toBe(2);

    // reflect again; model only sees filtered prompt
    h.setReflect({
      journal: "Weather chat.",
      summary: "Weather chat.",
      facts: [],
      profile: [],
    });
    await h.reflector.reflect("a");
    await h.indexer.indexPending();
    await h.turn("a", "thanks", "You're welcome.");

    const after = derivedDump(h.db);
    const leaks = Object.entries(after)
      .filter(([, s]) => s.includes(SECRET))
      .map(([k, s]) => `${k}: ${s}`);
    const forgotten = new Set(h.store.forgottenTurnIds());
    const deletedFactIds = facts.map((f) => f.id);
    const embedRows = h.db
      .prepare("SELECT source, source_id, id FROM embed_index")
      .all() as Array<{ source: string; source_id: string; id: string }>;
    const staleEmbed = embedRows.filter(
      (r) => forgotten.has(r.source_id) || deletedFactIds.includes(r.source_id),
    );
    const vecChunkIds = (
      h.db.prepare("SELECT chunk_id FROM vec_chunks").all() as Array<{
        chunk_id: string;
      }>
    ).map((r) => r.chunk_id);
    const chunkTurn = new Map(
      (
        h.db
          .prepare("SELECT id, source_id FROM embed_index WHERE source='turn'")
          .all() as Array<{ id: string; source_id: string }>
      ).map((r) => [r.id, r.source_id]),
    );
    const vecFactIds = (
      h.db.prepare("SELECT fact_id FROM vec_facts").all() as Array<{
        fact_id: string;
      }>
    ).map((r) => r.fact_id);
    const turnsFts = h.db
      .prepare("SELECT rowid FROM turns_fts WHERE turns_fts MATCH '4417'")
      .all();
    const reflect2 = h.reflectPrompts.at(-1) ?? "";
    const nextConv = JSON.stringify(
      await h.log.messagesFor("b", "what is my locker code?"),
    );
    const sameConv = JSON.stringify(
      await h.log.messagesFor("a", "what is my locker code?"),
    );
    const hits = await h.retriever.retrieve("locker code 4417");

    console.log(
      JSON.stringify(
        {
          results,
          forgotten: [...forgotten],
          leaks,
          staleEmbed,
          vecChunksLeft: vecChunkIds.length,
          vecChunksForForgotten: vecChunkIds.filter(
            (id) => id === "straddle" || forgotten.has(chunkTurn.get(id) ?? ""),
          ),
          vecFactsForDeleted: vecFactIds.filter((id) =>
            deletedFactIds.includes(id),
          ),
          turnsFtsRawRows: turnsFts.length,
          reflect2Has: reflect2.includes(SECRET),
          nextConvHas: nextConv.includes(SECRET),
          sameConvHas: sameConv.includes(SECRET),
          sameConvMsgs: sameConv,
          hitsHas: JSON.stringify(hits).includes(SECRET),
          profile: after.profile,
          summary: h.store.summary("a"),
        },
        null,
        1,
      ),
    );
    expect.soft(leaks).toEqual([]);
    expect.soft(after.chunks).not.toContain("straddle");
    expect
      .soft(vecFactIds.filter((id) => deletedFactIds.includes(id)))
      .toEqual([]);
    expect.soft(reflect2.includes(SECRET)).toBe(false);
    expect.soft(nextConv.includes(SECRET)).toBe(false);
    expect.soft(JSON.stringify(hits).includes(SECRET)).toBe(false);
    expect.soft(sameConv.includes(SECRET)).toBe(false);
    expect.soft(staleEmbed).toEqual([]);
    h.runtime.scheduler.stop();
    h.store.close();
  });

  it("a second forget in the same session does not resurrect the first into the summary", async () => {
    const h = setup();
    await h.turn(
      "s",
      "remember my locker code is 4417",
      "Saved.",
      h.tool(MEMORY_REMEMBER_TOOL, {
        text: "locker code is 4417",
        kind: "event",
        aboutJohn: true,
      }),
    );
    await h.turn(
      "s",
      "remember my bike is a bluefox",
      "Saved.",
      h.tool(MEMORY_REMEMBER_TOOL, {
        text: "bike is a bluefox",
        kind: "preference",
        aboutJohn: true,
      }),
    );
    await h.turn(
      "s",
      "forget the locker code",
      "Done.",
      h.tool(MEMORY_FORGET_TOOL, { text: "locker code is 4417" }),
    );
    const s1 = h.store.summary("s") ?? "";
    await h.turn(
      "s",
      "forget the bike",
      "Done.",
      h.tool(MEMORY_FORGET_TOOL, { text: "bike is a bluefox" }),
    );
    const s2 = h.store.summary("s") ?? "";
    console.log(JSON.stringify({ s1, s2 }));
    expect.soft(s1).not.toContain(SECRET);
    expect.soft(s2).not.toContain(SECRET);
    h.runtime.scheduler.stop();
    h.store.close();
  });
  it("same conversation: the next prompt after forget does not replay the forgotten turns", async () => {
    const h = setup();
    await h.turn(
      "c",
      "remember my locker code is 4417",
      "Saved: locker 4417.",
      h.tool(MEMORY_REMEMBER_TOOL, {
        text: "locker code is 4417",
        kind: "event",
        aboutJohn: true,
      }),
    );
    await h.turn(
      "c",
      "forget my locker code",
      "Done.",
      h.tool(MEMORY_FORGET_TOOL, { text: "locker code is 4417" }),
    );
    const next = JSON.stringify(
      await h.log.messagesFor("c", "what was that code again?"),
    );
    console.log(
      JSON.stringify({ forgotten: h.store.forgottenTurnIds(), next }),
    );
    expect.soft(next).not.toContain(SECRET);
    h.runtime.scheduler.stop();
    h.store.close();
  });

  it("reflect's commit drops a turn forgotten while the model was running", async () => {
    const h = setup();
    await h.turn(
      "r",
      "remember my locker code is 4417",
      "Saved: 4417.",
      h.tool(MEMORY_REMEMBER_TOOL, {
        text: "locker code is 4417",
        kind: "event",
        aboutJohn: true,
      }),
    );
    const stated = h.store
      .recentTurns("r", 20)
      .find((turn) => turn.role === "user" && turn.content.includes(SECRET));
    expect(stated?.id).toBeTruthy();
    const reflector = new LocalReflector({
      store: h.store,
      derived: h.store,
      embedder: new FakeEmbedder(),
      vectors: h.vectors,
      complete: async () => {
        await h.tool(MEMORY_FORGET_TOOL, { text: "locker code is 4417" })();
        return JSON.stringify({
          journal: "John's locker is 4417.",
          summary: "Locker code 4417.",
          facts: [
            {
              text: "Locker code is 4417",
              kind: "event",
              subject: null,
              confidence: 0.9,
              sensitive: true,
              validUntil: null,
              sourceTurn: stated?.id,
              contradicts: null,
            },
          ],
          profile: [
            {
              key: "locker",
              value: "4417",
              statedByJohn: true,
              stable: true,
              sessionsObserved: 1,
              shareable: false,
              sensitive: true,
              pinned: false,
            },
          ],
        });
      },
      now: () => h.store.currentTime(),
      timeZone: "UTC",
      localDay,
      factIds: randomIds("race-fact"),
      journalIds: randomIds("race-journal"),
    });
    await reflector.reflect("r");
    expect(h.store.summary("r") ?? "").not.toContain(SECRET);
    expect(
      h.store
        .listFacts()
        .map((fact) => fact.text)
        .join("\n"),
    ).not.toContain(SECRET);
    expect(JSON.stringify(h.store.listProfile())).not.toContain(SECRET);
    expect(JSON.stringify(h.store.listJournal())).not.toContain(SECRET);
    const vecFacts = h.db
      .prepare("SELECT fact_id FROM vec_facts")
      .all() as Array<{ fact_id: string }>;
    expect(vecFacts).toEqual([]);
    h.runtime.scheduler.stop();
    h.store.close();
  });
});
