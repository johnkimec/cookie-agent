import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";
import { ChatLog } from "./chat-log.ts";
import { LocalConsolidator } from "./consolidate-job.ts";
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
type H = ReturnType<typeof setup>;
const ids = (h: H) => h.store.forgottenTurnIds();
const close = (h: H) => {
  h.runtime.scheduler.stop();
  h.store.close();
};

const PR = (
  key: string,
  value: string,
  extra: Record<string, unknown> = {},
) => ({
  key,
  value,
  statedByJohn: true,
  stable: true,
  sessionsObserved: 3,
  shareable: true,
  sensitive: false,
  pinned: false,
  ...extra,
});
const factRows = (h: H) =>
  h.db
    .prepare("SELECT id, text, source_turn, superseded_by FROM facts")
    .all() as Array<{
    id: string;
    text: string;
    source_turn: string | null;
    superseded_by: string | null;
  }>;
async function reflectAll(h: H, reply: unknown = reflectNone) {
  h.setReflect(reply);
  const n0 = h.reflectPrompts.length;
  for (const s of h.store.listSessions()) await h.reflector.reflect(s.id);
  return h.reflectPrompts.slice(n0).join("\n");
}
function consolidator(h: H) {
  let clock = 5_000_000;
  return new LocalConsolidator({
    derived: h.store,
    embedder: new FakeEmbedder(),
    vectors: h.vectors,
    sessionIds: () => h.store.listSessions().map((s) => s.id),
    readTurns: (id) => h.store.recentTurns(id, 10_000),
    now: () => (clock += 10),
    timeZone: "UTC",
    localDay,
    ids: randomIds("fact"),
  });
}

const bike = (h: H) => values(h).filter((v) => /bluefox|roadie/i.test(v));
const rowOf = (h: H, key: string) =>
  h.store.listProfile().find((r) => r.key === key);
function racer(h: H, reply: unknown, during: () => Promise<void>) {
  return new (h.reflector.constructor as typeof LocalReflector)({
    store: h.store,
    derived: h.store,
    embedder: new FakeEmbedder(),
    vectors: h.vectors,
    complete: async () => {
      await during();
      return JSON.stringify(reply);
    },
    now: () => 9_000_000,
    timeZone: "UTC",
    localDay,
    factIds: randomIds("fact"),
    journalIds: randomIds("journal"),
  });
}

const factIdOf = async (h: H, text: string, conv: string, user: string) => {
  let id = "";
  await h.turn(conv, user, "Saved.", async () => {
    id = ((await remember(h, text)()) as { factId: string }).factId;
  });
  return id;
};

describe("rv7: fact-id citations", () => {
  it("RV7-1 a fact id that was not shown in the prompt is invalid -> fallback (prompt turns + shown facts' sources)", async () => {
    const h = setup();
    await factIdOf(
      h,
      "John's bike is a Bluefox",
      "a",
      "remember my bike is a Bluefox",
    );
    await h.turn("b", "weather?", "Sunny.");
    h.setReflect({
      ...reflectNone,
      profile: [
        { ...PR("bike", "my blue roadie"), sourceTurns: ["fact-not-shown"] },
      ],
    });
    await h.reflector.reflect("b");
    const row = rowOf(h, "bike");
    expect(row?.sourceTurns).toEqual(
      expect.arrayContaining(["b-1-user", "b-2-assistant", "a-1-user"]),
    );
    expect(row?.sourceTurns?.includes("fact-not-shown")).toBe(false);
    close(h);
  });
  it("RV7-1b a real fact id that exists but was outside the capped prompt (forgotten-sourced fact) is not accepted", async () => {
    const h = setup();
    const fid = await factIdOf(
      h,
      "John's locker code is 4417",
      "a",
      "remember my locker code is 4417",
    );
    await h.turn(
      "c",
      "forget my locker code",
      "Done.",
      forget(h, "locker code"),
    );
    await h.turn("b", "I like oolong", "Nice.");
    h.setReflect({
      ...reflectNone,
      profile: [{ ...PR("tea", "oolong"), sourceTurns: [fid] }],
    });
    await h.reflector.reflect("b");
    const row = rowOf(h, "tea");
    expect(
      (row?.sourceTurns ?? []).some((x) => ids(h).includes(x)),
      "stored a forgotten source",
    ).toBe(false);
    close(h);
  });
  it("RV7-2 forgetting a turn whose fact was cited only by fact id drops the row (cross-session)", async () => {
    const h = setup();
    const fid = await factIdOf(
      h,
      "John's bike is a Bluefox",
      "a",
      "remember my bike is a Bluefox",
    );
    await h.turn("b", "what should I ride today?", "Your bike.");
    h.setReflect({
      ...reflectNone,
      profile: [{ ...PR("bike", "my blue roadie"), sourceTurns: [fid] }],
    });
    await h.reflector.reflect("b");
    const before = rowOf(h, "bike");
    await h.turn("c", "forget my bike", "Done.", forget(h, "bluefox"));
    expect(before?.sourceTurns).toContain("a-1-user");
    expect(bike(h)).toEqual([]);
    close(h);
  });
  it("RV7-3 race: fact-id citation whose (other-session) source turn is forgotten during complete", async () => {
    const h = setup();
    const fid = await factIdOf(
      h,
      "John's bike is a Bluefox",
      "a",
      "remember my bike is a Bluefox",
    );
    await h.turn("b", "what should I ride today?", "Your bike.");
    const reply = {
      ...reflectNone,
      profile: [{ ...PR("bike", "my blue roadie"), sourceTurns: [fid] }],
    };
    await racer(h, reply, async () => {
      h.runtime.host.noteUserTurn?.("c-1-user");
      await forget(h, "bluefox")();
    }).reflect("b");
    expect(ids(h), "precondition").toContain("a-1-user");
    expect(
      bike(h),
      "row citing a fact whose turn was forgotten mid-reflect",
    ).toEqual([]);
    close(h);
  });
  it("RV7-3b race: pinned + missing citation (fallback) with other-session fact forgotten during complete", async () => {
    const h = setup();
    await factIdOf(
      h,
      "John's bike is a Bluefox",
      "a",
      "remember my bike is a Bluefox",
    );
    await h.turn("b", "what should I ride today?", "Your bike.");
    const reply = {
      ...reflectNone,
      profile: [PR("bike", "my blue roadie", { pinned: true })],
    };
    await racer(h, reply, async () => {
      h.runtime.host.noteUserTurn?.("c-1-user");
      await forget(h, "bluefox")();
    }).reflect("b");
    expect(bike(h)).toEqual([]);
    close(h);
  });
  it("RV7-4 (info) consolidation merge: duplicate fact from two turns; forgetting one turn", async () => {
    const h = setup();
    await factIdOf(
      h,
      "John's bike is a Bluefox",
      "a",
      "remember my bike is a Bluefox",
    );
    await factIdOf(
      h,
      "John's bike is a Bluefox",
      "b",
      "my bike is a Bluefox, remember",
    );
    await consolidator(h).consolidate();
    const pre = factRows(h);
    expect(pre.length).toBeGreaterThan(0);
    await h.turn(
      "c",
      "forget the first",
      "Done.",
      forget(h, "remember my bike is a Bluefox"),
    );
    close(h);
  });
});

describe("rv7: hand pins", () => {
  it("RV7-5 a hand pin with no sources survives an unrelated forget even when reflect ran", async () => {
    const h = setup();
    h.store.upsertProfile(P("name", "John Kim", true));
    await factIdOf(
      h,
      "John's bike is a Bluefox",
      "a",
      "remember my bike is a Bluefox, I'm John Kim",
    );
    await reflectAll(h, { ...reflectNone, profile: [] });
    await h.turn("c", "forget my bike", "Done.", forget(h, "bluefox"));
    expect(values(h)).toContain("name=John Kim");
    close(h);
  });
  it("RV7-6 hand pin later re-stated by reflect: does it gain sources / get unpinned / become droppable?", async () => {
    const h = setup();
    h.store.upsertProfile(P("name", "John Kim", true));
    await factIdOf(
      h,
      "John's locker code is 4417",
      "a",
      "I'm John Kim, remember my locker code is 4417",
    );
    h.setReflect({
      ...reflectNone,
      profile: [PR("name", "John Kim", { pinned: true })],
    });
    await h.reflector.reflect("a");
    const afterReflect = rowOf(h, "name");
    await h.turn(
      "c",
      "forget my locker code",
      "Done.",
      forget(h, "locker code"),
    );
    // Accepted under D-30: restating the hand pin records the prompt turns,
    // so forgetting that turn drops the row.
    expect(afterReflect?.value).toBe("John Kim");
    expect((afterReflect?.sourceTurns ?? []).length).toBeGreaterThan(0);
    expect(rowOf(h, "name")).toBeUndefined();
    close(h);
  });
  it("RV7-6b hand pin overwritten by an unpinned reflect row with the same key", async () => {
    const h = setup();
    h.store.upsertProfile(P("name", "John Kim", true));
    await h.turn("a", "call me Johnny", "Sure.");
    h.setReflect({
      ...reflectNone,
      profile: [PR("name", "Johnny", { statedByJohn: false, pinned: false })],
    });
    await h.reflector.reflect("a");
    // Known follow-up, not fixed here: reflect overwrites and unpins the hand pin.
    const row = rowOf(h, "name");
    expect(row?.value).toBe("Johnny");
    expect(row?.pinned).toBe(false);
    close(h);
  });
  it("RV7-7 forgetting fact X keeps a row that cited only fact Y", async () => {
    const h = setup();
    const bikeId = await factIdOf(
      h,
      "John's bike is a Bluefox",
      "a",
      "remember my bike is a Bluefox",
    );
    const teaId = await factIdOf(
      h,
      "John likes oolong tea",
      "b",
      "remember I like oolong tea",
    );
    await h.turn("c", "notes", "Ok.");
    h.setReflect({
      ...reflectNone,
      profile: [{ ...PR("tea", "oolong"), sourceTurns: [teaId] }],
    });
    await h.reflector.reflect("c");
    const before = rowOf(h, "tea");
    expect(before?.sourceTurns).toEqual(["b-1-user"]);
    expect(before?.sourceTurns).not.toContain("a-1-user");
    expect(before?.sourceTurns).not.toContain(bikeId);
    await h.turn("d", "forget my bike", "Done.", forget(h, "bluefox"));
    expect(rowOf(h, "tea")?.value).toBe("oolong");
    close(h);
  });
});

describe("rv7: migration edge ids", () => {
  it("RV7-8 v3 DB: backslash, quote, unicode, empty-string source_turn", () => {
    const path = dbPath();
    const raw = new Database(path);
    raw.pragma("journal_mode = WAL");
    raw.loadExtension(sqliteVec.getLoadablePath());
    const base = new URL("./migrations/", import.meta.url);
    for (const [v, f] of [
      [1, "001_initial.sql"],
      [2, "002_embed_index.sql"],
      [3, "003_meta.sql"],
    ] as const) {
      raw.exec(readFileSync(new URL(f, base), "utf8"));
      raw.pragma(`user_version = ${v}`);
    }
    raw
      .prepare(
        "INSERT INTO sessions (id, surface, started_at) VALUES ('s', 'popup', 1)",
      )
      .run();
    const idsIn = ["back\\bslash", 'q"x', 'both\\"mix', "ünï-✓", "trail\\"];
    raw
      .prepare(
        "INSERT INTO turns (id, session_id, role, content, created_at) VALUES ('', 's', 'user', 'hi', 1)",
      )
      .run();
    for (const id of idsIn)
      raw
        .prepare(
          "INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, 's', 'user', 'hi', 1)",
        )
        .run(id);
    const ins = raw.prepare(
      "INSERT INTO profile (key, value, pinned, shareable, source_turn, updated_at) VALUES (?, 'v', 0, 1, ?, 1)",
    );
    for (const [i, id] of idsIn.entries()) {
      ins.run(`k${i}`, id);
    }
    ins.run("empty", "");
    ins.run("null", null);
    raw.close();
    const store = SqliteMemoryStore.open(path);
    const by = Object.fromEntries(store.listProfile().map((r) => [r.key, r]));
    store.close();
    idsIn.forEach((id, i) => {
      expect(by[`k${i}`]?.sourceTurns, id).toEqual([id]);
      expect(by[`k${i}`]?.sourceTurn, id).toBe(id);
    });
    expect(by.empty?.sourceTurns).toEqual([]);
    expect(by.null?.sourceTurns).toEqual([]);
  });
});
