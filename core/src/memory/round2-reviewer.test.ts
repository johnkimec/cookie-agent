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

function setup(path = dbPath()) {
  let clock = 1_000;
  const now = () => (clock += 10);
  const store = SqliteMemoryStore.open(path, { now });
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

const P = (
  key: string,
  value: string,
  pinned = false,
  sourceTurn: string | null = null,
) => ({
  key,
  value,
  pinned,
  shareable: true,
  sourceTurn,
  updatedAt: 1,
});
const values = (h: ReturnType<typeof setup>) =>
  h.store.listProfile().map((r) => `${r.key}=${r.value}`);
const reflectNone = { journal: "", summary: "", facts: [], profile: [] };

describe("round2 adversarial (reviewer)", () => {
  it("over-deletion: unrelated profile rows sharing common tokens", async () => {
    const h = setup();
    for (const r of [
      P("name", "John", true),
      P("full_name", "John Kim", true),
      P("pronouns", "he/him", true),
      P("city", "Toronto", true),
      P("gym", "goes to the gym on Mondays"),
      P("married", "married in 2026"),
      P("employer", "Cookie Labs since 2019"),
      P("kids", "2 kids"),
      P("locker_room", "prefers the locker room near the code desk"),
    ])
      h.store.upsertProfile(r);
    await h.turn(
      "a",
      "remember my locker code is 4417",
      "Saved.",
      h.tool(MEMORY_REMEMBER_TOOL, {
        text: "John's locker code is 4417",
        kind: "event",
        aboutJohn: true,
      }),
    );
    const before = values(h);
    const res = await h.tool(MEMORY_FORGET_TOOL, {
      text: "John's locker code is 4417",
    })();
    const after1 = values(h);
    // second forget: a dated fact
    await h.turn(
      "a",
      "remember my gym dentist appointment is 2026-11-03 2 pm",
      "Saved.",
      h.tool(MEMORY_REMEMBER_TOOL, {
        text: "Dentist appointment at the gym on 2026-11-03 at 2 pm",
        kind: "event",
        aboutJohn: false,
      }),
    );
    const res2 = await h.tool(MEMORY_FORGET_TOOL, {
      text: "Dentist appointment at the gym on 2026-11-03 at 2 pm",
    })();
    const after2 = values(h);
    const kept = [
      "name=John",
      "full_name=John Kim",
      "pronouns=he/him",
      "city=Toronto",
      "gym=goes to the gym on Mondays",
      "married=married in 2026",
      "employer=Cookie Labs since 2019",
      "kids=2 kids",
      "locker_room=prefers the locker room near the code desk",
    ];
    expect(res).toMatchObject({ forgotten: true });
    expect(res2).toMatchObject({ forgotten: true });
    expect(before).toEqual(expect.arrayContaining(kept));
    expect([...after1].sort()).toEqual([...kept].sort());
    expect([...after2].sort()).toEqual([...kept].sort());
    expect(after1.join("\n")).not.toContain(SECRET);
    expect(after2.join("\n")).not.toContain(SECRET);
    h.runtime.scheduler.stop();
    h.store.close();
  });

  it("over-deletion via reflect sourceForProfile: name stated on the secret turn", async () => {
    const h = setup();
    const t = await h.turn(
      "a",
      "I'm John, he/him, and my locker code is 4417",
      "Nice to meet you John.",
    );
    const turnId =
      h.store.recentTurns("a", 20).find((x) => x.role === "user")?.id ?? null;
    h.setReflect({
      journal: "Intro.",
      summary: "John introduced himself.",
      facts: [
        {
          text: "Locker code is 4417",
          kind: "event",
          subject: null,
          confidence: 0.9,
          sensitive: true,
          validUntil: null,
          sourceTurn: turnId,
          contradicts: null,
        },
      ],
      profile: [
        {
          key: "name",
          value: "John",
          statedByJohn: true,
          stable: true,
          sessionsObserved: 3,
          shareable: true,
          sensitive: false,
          pinned: true,
        },
        {
          key: "pronouns",
          value: "he/him",
          statedByJohn: true,
          stable: true,
          sessionsObserved: 3,
          shareable: true,
          sensitive: false,
          pinned: true,
        },
      ],
    });
    await h.reflector.reflect("a");
    const before = h.store.listProfile();
    await h.turn(
      "b",
      "forget my locker code",
      "Done.",
      h.tool(MEMORY_FORGET_TOOL, { text: "Locker code is 4417" }),
    );
    const after = h.store.listProfile();
    expect(t.msgs).toBeDefined();
    expect(before.map((row) => row.sourceTurn)).toEqual([null, null]);
    expect(before.map((row) => `${row.key}=${row.value}`).sort()).toEqual([
      "name=John",
      "pronouns=he/him",
    ]);
    expect(after.map((row) => `${row.key}=${row.value}`).sort()).toEqual([
      "name=John",
      "pronouns=he/him",
    ]);
    h.runtime.scheduler.stop();
    h.store.close();
  });

  it("secret written as words or split", async () => {
    const out: Record<string, unknown> = {};
    for (const [label, factText, profileValue] of [
      [
        "words/words",
        "locker code is four four one seven",
        "four four one seven",
      ],
      ["digits-fact/split-profile", "locker code is 4417", "Gym locker 44-17"],
      ["split-fact/digits-profile", "locker code is 44-17", "Gym locker 4417"],
      [
        "words-fact/digits-profile",
        "locker code is four four one seven",
        "4417",
      ],
      [
        "digits-fact/words-profile",
        "locker code is 4417",
        "four four one seven",
      ],
    ] as const) {
      const h = setup();
      h.store.upsertProfile(P("lock", profileValue));
      await h.turn(
        "a",
        `remember ${factText}`,
        "Saved.",
        h.tool(MEMORY_REMEMBER_TOOL, {
          text: factText,
          kind: "event",
          aboutJohn: false,
        }),
      );
      const r = await h.tool(MEMORY_FORGET_TOOL, { text: factText })();
      const profile = values(h);
      out[label] = {
        r,
        profile,
        facts: h.store.listFacts().map((f) => f.text),
      };
      expect(r).toMatchObject({ forgotten: true });
      expect(profile).toEqual([`lock=${profileValue}`]);
      expect(h.store.listFacts().map((fact) => fact.text)).not.toContain(
        factText,
      );
      h.runtime.scheduler.stop();
      h.store.close();
    }
    console.log("WORDS", JSON.stringify(out, null, 1));
  });

  it("forget in A, ask in B same day", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my locker code is 4417",
      "Saved: locker 4417.",
      h.tool(MEMORY_REMEMBER_TOOL, {
        text: "locker code is 4417",
        kind: "event",
        aboutJohn: true,
      }),
    );
    h.setReflect({
      journal: "John's locker is 4417.",
      summary: "Locker 4417 saved.",
      facts: [],
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
    await h.reflector.reflect("a");
    await h.turn(
      "a",
      "forget my locker code",
      "Done.",
      h.tool(MEMORY_FORGET_TOOL, { text: "locker code is 4417" }),
    );
    const b = JSON.stringify(
      await h.log.messagesFor("b", "what is my locker code?"),
    );
    const hits = JSON.stringify(
      await h.retriever.retrieve("what is my locker code 4417"),
    );
    h.setReflect(reflectNone);
    const n0 = h.reflectPrompts.length;
    await h.reflector.reflect("a");
    await h.reflector.reflect("b");
    const prompt = h.reflectPrompts.slice(n0).join("\n");
    console.log("NEWPROMPTS", h.reflectPrompts.length - n0, prompt);
    const dump = JSON.stringify(derivedDump(h.db));
    console.log(
      "CROSSCONV",
      JSON.stringify({
        bHas: b.includes(SECRET),
        hitsHas: hits.includes(SECRET),
        promptHas: prompt.includes(SECRET),
        dumpHas: dump.includes(SECRET),
        dump,
      }),
    );
    expect.soft(b).not.toContain(SECRET);
    expect.soft(hits).not.toContain(SECRET);
    expect.soft(prompt).not.toContain(SECRET);
    expect.soft(dump).not.toContain(SECRET);
    h.runtime.scheduler.stop();
    h.store.close();
  });

  it("forget, restart core, ask", async () => {
    const path = dbPath();
    const h = setup(path);
    await h.turn(
      "a",
      "remember my locker code is 4417",
      "Saved: locker 4417.",
      h.tool(MEMORY_REMEMBER_TOOL, {
        text: "locker code is 4417",
        kind: "event",
        aboutJohn: true,
      }),
    );
    await h.turn(
      "a",
      "forget my locker code",
      "Done.",
      h.tool(MEMORY_FORGET_TOOL, { text: "locker code is 4417" }),
    );
    h.runtime.scheduler.stop();
    h.store.close();
    const g = setup(path);
    await g.log.flushIndex();
    await g.indexer.indexPending();
    const same = JSON.stringify(
      await g.log.messagesFor("a", "what is my locker code?"),
    );
    const other = JSON.stringify(
      await g.log.messagesFor("z", "what is my locker code?"),
    );
    const hits = JSON.stringify(await g.retriever.retrieve("locker code 4417"));
    g.setReflect(reflectNone);
    await g.reflector.reflect("a");
    await g.reflector.reflect("z");
    const prompt = g.reflectPrompts.join("\n");
    console.log("RPROMPTS", g.reflectPrompts.length, prompt);
    const embed = JSON.stringify(
      g.db.prepare("SELECT * FROM embed_index").all(),
    );
    const dump = JSON.stringify(derivedDump(g.db));
    console.log(
      "RESTART",
      JSON.stringify({
        sameHas: same.includes(SECRET),
        otherHas: other.includes(SECRET),
        hitsHas: hits.includes(SECRET),
        promptHas: prompt.includes(SECRET),
        dumpHas: dump.includes(SECRET),
        forgotten: g.store.forgottenTurnIds(),
        embed,
      }),
    );
    expect.soft(same).not.toContain(SECRET);
    expect.soft(other).not.toContain(SECRET);
    expect.soft(hits).not.toContain(SECRET);
    expect.soft(prompt).not.toContain(SECRET);
    expect.soft(dump).not.toContain(SECRET);
    g.runtime.scheduler.stop();
    g.store.close();
  });

  it("forget whose secret is only in a chunk", async () => {
    const h = setup();
    await h.turn("a", "my locker code is 4417 by the way", "Got it, 4417.");
    await h.turn("a", "what's the weather", "Sunny.");
    const ids = h.store.recentTurns("a", 20).map((t) => t.id);
    h.store.upsertChunk({
      chunkId: "c1",
      sessionId: "a",
      firstTurn: ids[0] ?? null,
      lastTurn: ids.at(-1) ?? null,
      text: "John said his locker code is 4417. Weather sunny.",
    });
    const v = new Float32Array(EMBEDDING_DIMENSIONS);
    v[0] = 1;
    await h.vectors.upsert("vec_chunks", "c1", v);
    const r1 = await h.tool(MEMORY_FORGET_TOOL, {
      text: "locker code is 4417",
    })();
    const r2 = await h.tool(MEMORY_FORGET_TOOL, { text: "my locker code" })();
    const hits = JSON.stringify(await h.retriever.retrieve("locker code 4417"));
    const next = JSON.stringify(
      await h.log.messagesFor("b", "what is my locker code?"),
    );
    const same = JSON.stringify(
      await h.log.messagesFor("a", "what is my locker code?"),
    );
    expect(r1).toMatchObject({ forgotten: true });
    expect(r2).toMatchObject({ forgotten: false, reason: "not found" });
    expect(
      h.store.listChunks().some((chunk) => chunk.text.includes(SECRET)),
    ).toBe(false);
    expect(hits).not.toContain(SECRET);
    expect(next).not.toContain(SECRET);
    expect(same).not.toContain(SECRET);
    h.runtime.scheduler.stop();
    h.store.close();
  });
});
