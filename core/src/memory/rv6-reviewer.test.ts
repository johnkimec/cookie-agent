import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { afterEach, describe, expect, it } from "vitest";
import { ChatLog } from "./chat-log.ts";
import { randomIds } from "./derived.ts";
import { FakeEmbedder } from "./embedder.ts";
import { HybridRetriever } from "./hybrid-retrieve.ts";
import { ContentIndexer } from "./index-content.ts";
import { openMemoryDatabase } from "./migrate.ts";
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
async function reflectAll(h: H, reply: unknown = reflectNone) {
  h.setReflect(reply);
  const n0 = h.reflectPrompts.length;
  for (const s of h.store.listSessions()) await h.reflector.reflect(s.id);
  return h.reflectPrompts.slice(n0).join("\n");
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

describe("rv6: cross-session provenance", () => {
  it("RV6-1 reflect on session b rewords an Active fact from session a (missing citation); forget drops it", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my bike is a Bluefox",
      "Saved.",
      remember(h, "John's bike is a Bluefox"),
    );
    await h.turn("b", "weather?", "Sunny.");
    h.setReflect({ ...reflectNone, profile: [PR("bike", "my blue roadie")] });
    const n0 = h.reflectPrompts.length;
    await h.reflector.reflect("b");
    const prompt = h.reflectPrompts.slice(n0).join("\n");
    await h.turn("c", "forget my bike", "Done.", forget(h, "bluefox"));
    expect(
      /Bluefox/.test(prompt),
      "precondition: model saw the fact in Active facts",
    ).toBe(true);
    expect(bike(h), "reword derived from a forgotten fact survives").toEqual(
      [],
    );
    close(h);
  });
  it("RV6-1b a valid citation of a session-b turn does not also attach the other fact", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my bike is a Bluefox",
      "Saved.",
      remember(h, "John's bike is a Bluefox"),
    );
    await h.turn("b", "what should I ride today?", "Your bike.");
    h.setReflect({
      ...reflectNone,
      profile: [{ ...PR("bike", "my blue roadie"), sourceTurns: ["b-1-user"] }],
    });
    await h.reflector.reflect("b");
    expect(rowOf(h, "bike")?.sourceTurns).toEqual(["b-1-user"]);
    await h.turn("c", "forget my bike", "Done.", forget(h, "bluefox"));
    expect(bike(h)).toEqual(["bike=my blue roadie"]);
    close(h);
  });
});

describe("rv6: pinned reflect rows with a forgotten source", () => {
  it("RV6-2 a pinned (statedByJohn) reflect row citing the forgotten turn is dropped", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my bike is a Bluefox",
      "Saved.",
      remember(h, "John's bike is a Bluefox"),
    );
    await reflectAll(h, {
      ...reflectNone,
      profile: [
        {
          ...PR("bike", "my blue roadie", { pinned: true }),
          sourceTurns: ["a-1-user"],
        },
      ],
    });
    const before = rowOf(h, "bike");
    await h.turn("c", "forget my bike", "Done.", forget(h, "bluefox"));
    expect(before?.pinned, "precondition: pinned").toBe(true);
    expect(bike(h), "pinned row sourced only from a forgotten turn").toEqual(
      [],
    );
    close(h);
  });
  it("RV6-3 race: pinned multi-source row, forget lands during complete", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my bike is a Bluefox",
      "Saved.",
      remember(h, "John's bike is a Bluefox"),
    );
    await h.turn("a", "I ride it to class", "Nice.");
    const reply = {
      ...reflectNone,
      profile: [
        {
          ...PR("bike", "my blue roadie", { pinned: true }),
          sourceTurns: ["a-3-user", "a-1-user"],
        },
      ],
    };
    await racer(h, reply, async () => {
      h.runtime.host.noteUserTurn?.("c-1-user");
      await forget(h, "bluefox")();
    }).reflect("a");
    expect(ids(h), "precondition: a-1-user forgotten").toContain("a-1-user");
    expect(bike(h), "pinned row citing a turn forgotten mid-reflect").toEqual(
      [],
    );
    close(h);
  });
  it("RV6-3b race: unpinned multi-source row (forgotten id listed second)", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my bike is a Bluefox",
      "Saved.",
      remember(h, "John's bike is a Bluefox"),
    );
    await h.turn("a", "I ride it to class", "Nice.");
    const reply = {
      ...reflectNone,
      profile: [
        {
          ...PR("bike", "my blue roadie"),
          sourceTurns: ["a-3-user", "a-1-user"],
        },
      ],
    };
    await racer(h, reply, async () => {
      h.runtime.host.noteUserTurn?.("c-1-user");
      await forget(h, "bluefox")();
    }).reflect("a");
    expect(bike(h)).toEqual([]);
    close(h);
  });
});

describe("rv6: citation validation", () => {
  const setupA = async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my bike is a Bluefox",
      "Saved.",
      remember(h, "John's bike is a Bluefox"),
    );
    await h.turn("a", "I ride it to class", "Nice.");
    return h;
  };
  it("RV6-4 forget of the second-listed source drops the row", async () => {
    const h = await setupA();
    await reflectAll(h, {
      ...reflectNone,
      profile: [
        {
          ...PR("bike", "my blue roadie"),
          sourceTurns: ["a-3-user", "a-1-user"],
        },
      ],
    });
    const before = rowOf(h, "bike");
    await h.turn("c", "forget my bike", "Done.", forget(h, "bluefox"));
    expect(before?.sourceTurns).toEqual(["a-3-user", "a-1-user"]);
    expect(before?.sourceTurn).toBe("a-3-user");
    expect(bike(h)).toEqual([]);
    close(h);
  });
  it("RV6-5 mixed valid + invalid ids keeps only the valid ones; duplicates collapse", async () => {
    const h = await setupA();
    await reflectAll(h, {
      ...reflectNone,
      profile: [
        {
          ...PR("bike", "my blue roadie"),
          sourceTurns: ["bogus", "a-1-user", " a-1-user ", "a-1-user", "", 7],
        },
        { ...PR("ride", "to class"), sourceTurns: ["a-3-user", "a-3-user"] },
      ],
    });
    expect(rowOf(h, "bike")?.sourceTurns).toEqual(["a-1-user"]);
    expect(rowOf(h, "ride")?.sourceTurns).toEqual(["a-3-user"]);
    const raw = h.db
      .prepare("SELECT source_turns FROM profile WHERE key='ride'")
      .get() as { source_turns: string };
    expect(raw.source_turns).toBe('["a-3-user"]');
    close(h);
  });
  it("RV6-6 citing an already-forgotten turn is invalid and falls back to all prompt turns (none forgotten)", async () => {
    const h = setup();
    await h.turn("a", "my locker code is 4417", "Ok.");
    await h.turn("a", "I like oolong tea", "Nice.");
    await h.turn("c", "forget my locker code", "Done.", forget(h, "4417"));
    const f = ids(h);
    await reflectAll(h, {
      ...reflectNone,
      profile: [
        {
          ...PR("tea", "oolong"),
          sourceTurns: [f.find((x) => x.startsWith("a-")) ?? "a-1-user"],
        },
      ],
    });
    const row = rowOf(h, "tea");
    expect(
      row?.sourceTurns?.some((x) => f.includes(x)),
      "stored a forgotten id",
    ).toBe(false);
    expect((row?.sourceTurns ?? []).length).toBeGreaterThan(0);
    close(h);
  });
});

describe("rv6: migration 003 -> 004 on an existing DB", () => {
  it("RV6-7 backfills source_turns from source_turn and leaves null as []", () => {
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
    for (const id of ["s-1-user", 'q"x', "back\\bslash"])
      raw
        .prepare(
          "INSERT INTO turns (id, session_id, role, content, created_at) VALUES (?, 's', 'user', 'hi', 1)",
        )
        .run(id);
    const ins = raw.prepare(
      "INSERT INTO profile (key, value, pinned, shareable, source_turn, updated_at) VALUES (?, ?, 0, 1, ?, 1)",
    );
    ins.run("plain", "v", "s-1-user");
    ins.run("quote", "v", 'q"x');
    ins.run("bslash", "v", "back\\bslash");
    ins.run("none", "v", null);
    raw.close();
    const db = openMemoryDatabase(path);
    const ver = db.pragma("user_version", { simple: true });
    db.close();
    const store = SqliteMemoryStore.open(path);
    const listed = store
      .listProfile()
      .map((r) => ({ k: r.key, st: r.sourceTurn, sts: r.sourceTurns }));
    store.close();
    expect(ver).toBe(4);
    const by = Object.fromEntries(listed.map((r) => [r.k, r]));
    expect(by.plain?.sts).toEqual(["s-1-user"]);
    expect(by.quote?.sts).toEqual(['q"x']);
    expect(by.none?.sts).toEqual([]);
    expect(by.bslash?.sts, "(edge) backslash id round-trips").toEqual([
      "back\\bslash",
    ]);
  });
});

describe("rv6: indexes after purge", () => {
  it("RV6-8 forgotten fact + benign sibling are gone from facts_fts, vec_facts and embed_index", async () => {
    const h = setup();
    const fids: string[] = [];
    await h.turn(
      "a",
      "remember my locker code is 4417, also I like oolong tea",
      "Saved.",
      async () => {
        fids.push(
          (
            (await remember(h, "John's locker code is 4417")()) as {
              factId: string;
            }
          ).factId,
        );
        fids.push(
          ((await remember(h, "John likes oolong tea")()) as { factId: string })
            .factId,
        );
      },
    );
    await h.turn("b", "weather?", "Sunny.");
    await h.indexer.indexPending();
    const pre = await Promise.all(
      fids.map((f) => h.vectors.has("vec_facts", f)),
    );
    await h.turn(
      "c",
      "forget my locker code",
      "Done.",
      forget(h, "locker code"),
    );
    await h.indexer.indexPending();
    const fts = h.db
      .prepare("SELECT rowid, text FROM facts_fts WHERE facts_fts MATCH ?")
      .all('"4417" OR "oolong"');
    const vec = await Promise.all(
      fids.map((f) => h.vectors.has("vec_facts", f)),
    );
    const emb = (
      h.db
        .prepare("SELECT * FROM embed_index WHERE source='fact'")
        .all() as Array<{ source_id: string }>
    ).filter((r) => fids.includes(r.source_id));
    const turnVec = (
      h.db.prepare("SELECT chunk_id FROM vec_chunks").all() as Array<{
        chunk_id: string;
      }>
    ).filter((c) => c.chunk_id.startsWith("a-"));
    expect(pre, "precondition: vectors existed").toEqual([true, true]);
    expect(fts).toEqual([]);
    expect(vec).toEqual([false, false]);
    expect(emb).toEqual([]);
    expect(turnVec).toEqual([]);
    close(h);
  });
});
