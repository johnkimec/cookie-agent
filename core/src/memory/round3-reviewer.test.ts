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
import {
  FORGET_NAME_THE_THING,
  FORGET_TURN_CAP,
  MEMORY_FORGET_TOOL,
  MEMORY_REMEMBER_TOOL,
} from "./tools.ts";
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

const forget = (h: ReturnType<typeof setup>, text: string) =>
  h.tool(MEMORY_FORGET_TOOL, { text });
const remember = (
  h: ReturnType<typeof setup>,
  text: string,
  aboutJohn = false,
) => h.tool(MEMORY_REMEMBER_TOOL, { text, kind: "event", aboutJohn });
const leakCheck = async (h: ReturnType<typeof setup>, conv: string) => {
  await h.indexer.indexPending();
  const hits = JSON.stringify(
    await h.retriever.retrieve("what is my locker code 4417"),
  );
  const next = JSON.stringify(
    await h.log.messagesFor(`fresh-${conv}`, "what is my locker code?"),
  );
  h.setReflect(reflectNone);
  const n0 = h.reflectPrompts.length;
  for (const s of h.store.listSessions()) await h.reflector.reflect(s.id);
  const prompts = h.reflectPrompts.slice(n0).join("\n");
  const dump = JSON.stringify(derivedDump(h.db));
  return {
    hitsHas: hits.includes(SECRET),
    nextHas: next.includes(SECRET),
    reflectHas: prompts.includes(SECRET),
    derivedHas: dump.includes(SECRET),
  };
};
const out: Record<string, unknown> = {};

describe("round3 adversarial (reviewer)", () => {
  it("7+ letter key words vs unrelated profile rows", async () => {
    const cases: Array<[string, string, string[]]> = [
      [
        "birthday",
        "John's birthday is in September",
        [
          "anniversary=married in September 2019",
          "school=semester starts September",
          "bday_party=birthday dinner at Gusto",
        ],
      ],
      [
        "appointment",
        "dentist appointment tomorrow at 3pm",
        [
          "physio=physio appointment every Tuesday",
          "standup=standup tomorrow is cancelled",
        ],
      ],
      [
        "remember",
        "remember that my locker code is 4417",
        ["note=remember to water the plants"],
      ],
      [
        "everything",
        "everything about my ex Sarah",
        ["motto=everything in moderation"],
      ],
    ];
    for (const [label, factText, rows] of cases) {
      const h = setup();
      for (const r of rows) {
        const [k, v] = r.split("=");
        if (k === undefined || v === undefined) {
          throw new Error(r);
        }
        h.store.upsertProfile(P(k, v));
      }
      h.store.upsertProfile(P("name", "John", true));
      h.store.upsertProfile(P("pronouns", "he/him", true));
      await h.turn(
        "a",
        `remember ${factText}`,
        "Saved.",
        remember(h, factText),
      );
      const r = await forget(h, factText)();
      const after = values(h);
      out[label] = { r, before: rows, after };
      expect(r).toMatchObject({ forgotten: true });
      expect([...after].sort()).toEqual(
        [...rows, "name=John", "pronouns=he/him"].sort(),
      );
      expect(after.join("\n")).not.toContain(SECRET);
      h.runtime.scheduler.stop();
      h.store.close();
    }
  });

  it("pinned rows: key-word collision and value-contained-in-fact", async () => {
    const cases: Array<[string, string, string]> = [
      ["name-key", "John's dog's name is Rex", "name=John"],
      ["city-key", "the city where my locker 4417 is", "city=Toronto"],
      ["city-value", "John's gym in Toronto has locker 4417", "city=Toronto"],
      ["pronouns-value", "John (he/him) has locker 4417", "pronouns=he/him"],
      [
        "employer-value",
        "Cookie Labs locker code is 4417",
        "employer=Cookie Labs",
      ],
    ];
    for (const [label, factText, row] of cases) {
      const h = setup();
      const [k, v] = row.split("=");
      if (k === undefined || v === undefined) {
        throw new Error(row);
      }
      h.store.upsertProfile(P(k, v, true));
      await h.turn(
        "a",
        `remember ${factText}`,
        "Saved.",
        remember(h, factText),
      );
      const r = await forget(h, factText)();
      const after = values(h);
      out[`pinned:${label}`] = { r, after };
      expect(r).toMatchObject({ forgotten: true });
      expect(after).toEqual([row]);
      h.runtime.scheduler.stop();
      h.store.close();
    }
  });

  it("forget my gym locker (no digits) vs 'Gym locker #4417' rows", async () => {
    const res: Record<string, unknown> = {};
    // (a) fact + unpinned reflect row
    {
      const h = setup();
      await h.turn(
        "a",
        "my gym locker is 4417",
        "Saved.",
        remember(h, "John's gym locker is 4417"),
      );
      h.store.upsertProfile(P("gym_locker", "Gym locker #4417"));
      const r = await forget(h, "gym locker")();
      const after = values(h);
      res.factPlusRow = { r, after };
      expect(r).toMatchObject({ forgotten: true });
      expect(after).toEqual([]);
      h.runtime.scheduler.stop();
      h.store.close();
    }
    // (b) no fact, only a turn and an unpinned row
    {
      const h = setup();
      await h.turn("a", "my gym locker is #4417", "Ok.");
      h.store.upsertProfile(P("gym_locker", "Gym locker #4417"));
      let r: unknown;
      await h.turn("c", "forget my gym locker", "Done.", async () => {
        r = await forget(h, "my gym locker")();
      });
      const after = values(h);
      const forgotten = h.store.forgottenTurnIds();
      const leak = await leakCheck(h, "b");
      res.turnPlusRow = { r, after, forgotten, leak };
      expect(r).toMatchObject({ forgotten: true, factIds: [] });
      expect(after).toEqual([]);
      expect(forgotten.length).toBeGreaterThan(0);
      expect(leak).toEqual({
        hitsHas: false,
        nextHas: false,
        reflectHas: false,
        derivedHas: false,
      });
      h.runtime.scheduler.stop();
      h.store.close();
    }
    // (c) pinned row, key differs
    {
      const h = setup();
      await h.turn("a", "my gym locker is #4417", "Ok.");
      h.store.upsertProfile(P("locker_info", "Gym locker #4417", true));
      let r: unknown;
      await h.turn("c", "forget my gym locker", "Done.", async () => {
        r = await forget(h, "my gym locker")();
      });
      const after = values(h);
      const leak = await leakCheck(h, "c");
      res.pinnedRow = { r, after, leak };
      expect(r).toMatchObject({ forgotten: true, factIds: [] });
      expect(after).toEqual([]);
      expect(leak).toEqual({
        hitsHas: false,
        nextHas: false,
        reflectHas: false,
        derivedHas: false,
      });
      h.runtime.scheduler.stop();
      h.store.close();
    }
    out.gymLocker = res;
  });

  it("turn-only secret: forget my locker code", async () => {
    const h = setup();
    await h.turn("a", "fyi my locker code is 4417", "Got it, 4417.");
    await h.turn("a", "what's the weather", "Sunny.");
    let r: unknown;
    await h.turn("c", "forget my locker code", "Done.", async () => {
      r = await forget(h, "my locker code")();
    });
    const sameA = JSON.stringify(
      await h.log.messagesFor("a", "what is my locker code?"),
    );
    const leak = await leakCheck(h, "x");
    const forgotten = h.store.forgottenTurnIds();
    out.turnOnly = { r, forgotten, sameAHas: sameA.includes(SECRET), leak };
    const locker = h.store
      .recentTurns("a", 20)
      .find((turn) => turn.content.includes(SECRET));
    const weather = h.store
      .recentTurns("a", 20)
      .find((turn) => turn.content === "what's the weather");
    expect(r).toMatchObject({ forgotten: true, factIds: [] });
    expect(forgotten).toContain(locker?.id);
    expect(forgotten).not.toContain(weather?.id);
    expect(leak).toEqual({
      hitsHas: false,
      nextHas: false,
      reflectHas: false,
      derivedHas: false,
    });
    expect(sameA).not.toContain(SECRET);
    h.runtime.scheduler.stop();
    h.store.close();
  });

  it("turn-only secret: reworded so only the request turn matches", async () => {
    const h = setup();
    await h.turn("a", "the code for my locker is 4417", "Got it.");
    let r: unknown;
    await h.turn("c", "forget my locker code", "Done.", async () => {
      r = await forget(h, "locker code")();
    });
    const leak = await leakCheck(h, "y");
    out.requestOnly = { r, forgotten: h.store.forgottenTurnIds(), leak };
    expect(r).toMatchObject({
      forgotten: false,
      reason: "not found",
      detail: FORGET_NAME_THE_THING,
    });
    expect(h.store.forgottenTurnIds()).toEqual([]);
    expect(leak.hitsHas).toBe(true);
    h.runtime.scheduler.stop();
    h.store.close();
  });

  it("ambiguity and vague forgets", async () => {
    const h = setup();
    await h.turn("a", "my locker code is 4417", "Ok.");
    await h.turn("a", "the locker room smells", "Sorry.");
    for (let i = 0; i < 12; i += 1)
      await h.turn("a", `that was fun ${i}`, "Yes.");
    await h.turn("a", "thanks", "You're welcome.");
    await h.turn("b", "thanks", "Any time.");
    await h.turn("b", "Thanks", "Sure.");
    const res: Record<string, unknown> = {};
    const before = h.store.forgottenTurnIds().length;
    const locker = h.store
      .recentTurns("a", 50)
      .find((turn) => turn.content.includes(SECRET));
    for (const t of [
      "locker",
      "forget that",
      "that",
      "everything about me",
      "thanks",
      "about me",
    ]) {
      let r: unknown;
      await h.turn("req", `forget ${t}`, "Ok.", async () => {
        r = await forget(h, t)();
      });
      const rr = r as { candidates?: unknown[]; detail?: string } & Record<
        string,
        unknown
      >;
      res[t] = {
        forgotten: rr.forgotten,
        reason: rr.reason,
        detail: rr.detail,
        nCandidates: rr.candidates?.length,
        nForgottenTotal: h.store.forgottenTurnIds().length,
      };
    }
    out.vague = { before, res, chunks: h.store.listChunks().length };
    expect(res.locker).toMatchObject({
      forgotten: false,
      reason: "ambiguous",
      nCandidates: 2,
      nForgottenTotal: 0,
    });
    expect(res["forget that"]).toMatchObject({
      forgotten: false,
      reason: "not found",
      detail: FORGET_NAME_THE_THING,
      nForgottenTotal: 0,
    });
    expect(res.that).toMatchObject({
      forgotten: false,
      reason: "ambiguous",
      nForgottenTotal: 0,
    });
    expect(
      (res.that as { nCandidates: number }).nCandidates,
    ).toBeLessThanOrEqual(FORGET_TURN_CAP);
    expect((res.that as { nCandidates: number }).nCandidates).toBeGreaterThan(
      0,
    );
    expect(res["everything about me"]).toMatchObject({
      forgotten: false,
      reason: "not found",
      detail: FORGET_NAME_THE_THING,
      nForgottenTotal: 0,
    });
    expect(res.thanks).toMatchObject({ forgotten: true });
    expect(
      (res.thanks as { nForgottenTotal: number }).nForgottenTotal,
    ).toBeGreaterThan(0);
    expect(h.store.forgottenTurnIds()).not.toContain(locker?.id);
    h.runtime.scheduler.stop();
    h.store.close();
  });

  it("chunk-only secret: turns re-indexed afterwards?", async () => {
    const h = setup();
    await h.turn("a", "my locker is 4417", "Ok.");
    await h.turn("a", "weather?", "Sunny.");
    const ids = h.store.recentTurns("a", 20).map((t) => t.id);
    h.store.upsertChunk({
      chunkId: "c1",
      sessionId: "a",
      firstTurn: ids[0] ?? null,
      lastTurn: ids.at(-1) ?? null,
      text: "John's locker combination is 4417.",
    });
    const v = new Float32Array(EMBEDDING_DIMENSIONS);
    v[0] = 1;
    await h.vectors.upsert("vec_chunks", "c1", v);
    let r: unknown;
    await h.turn("c", "forget it", "Done.", async () => {
      r = await forget(h, "locker combination")();
    });
    const leak = await leakCheck(h, "z");
    const forgotten = h.store.forgottenTurnIds();
    out.chunkOnly = {
      r,
      forgotten,
      chunks: h.store.listChunks().map((c) => c.text),
      leak,
    };
    expect(r).toMatchObject({ forgotten: true, factIds: [] });
    expect(forgotten).toEqual(expect.arrayContaining(ids));
    expect(
      h.store.listChunks().some((chunk) => chunk.text.includes(SECRET)),
    ).toBe(false);
    expect(leak).toEqual({
      hitsHas: false,
      nextHas: false,
      reflectHas: false,
      derivedHas: false,
    });
    h.runtime.scheduler.stop();
    h.store.close();
  });
});
