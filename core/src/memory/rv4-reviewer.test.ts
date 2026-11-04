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
const turnIdsOf = (h: H, conv: string) =>
  h.store.recentTurns(conv, 100).map((t) => t.id);
const embedRowsFor = (h: H, turnIdsList: string[]) =>
  (
    h.db
      .prepare("SELECT id, source, source_id FROM embed_index")
      .all() as Array<{ id: string; source: string; source_id: string }>
  ).filter((r) => r.source === "turn" && turnIdsList.includes(r.source_id));
const vecIds = (h: H, table: string) => {
  try {
    return (
      h.db.prepare(`SELECT id FROM ${table}`).all() as Array<{ id: string }>
    ).map((r) => r.id);
  } catch {
    return [] as string[];
  }
};
async function everySurface(h: H, conv: string, secret: string) {
  await h.indexer.indexPending();
  const hits = JSON.stringify(
    await h.retriever.retrieve(`locker code ${secret}`),
  );
  const hits2 = JSON.stringify(await h.retriever.retrieve(secret));
  const fresh = JSON.stringify(
    await h.log.messagesFor(
      `fresh-${conv}-${Math.random()}`,
      "what is my locker code? and my bike?",
    ),
  );
  const summaries = JSON.stringify(
    h.db.prepare("SELECT id, summary FROM sessions").all(),
  );
  const facts = JSON.stringify(h.db.prepare("SELECT text FROM facts").all());
  const profile = JSON.stringify(h.db.prepare("SELECT * FROM profile").all());
  const chunks = JSON.stringify(h.db.prepare("SELECT * FROM chunks").all());
  const journal = JSON.stringify(h.db.prepare("SELECT * FROM journal").all());
  return {
    retrieve: hits.includes(secret) || hits2.includes(secret),
    contextBuilder: fresh.includes(secret),
    summaries: summaries.includes(secret),
    facts: facts.includes(secret),
    profile: profile.includes(secret),
    chunks: chunks.includes(secret),
    journal: journal.includes(secret),
  };
}
const CLEAN = {
  retrieve: false,
  contextBuilder: false,
  summaries: false,
  facts: false,
  profile: false,
  chunks: false,
  journal: false,
};

describe("round4 reviewer: pinned rows", () => {
  it("R4-1 pinned name/pronouns survive forgetting a fact whose text equals the row value (by factId)", async () => {
    for (const [key, value] of [
      ["name", "John"],
      ["pronouns", "he/him"],
    ] as const) {
      const h = setup();
      h.store.upsertProfile(P("name", "John", true));
      h.store.upsertProfile(P("pronouns", "he/him", true));
      let factId = "";
      await h.turn("a", `remember ${value}`, "Saved.", async () => {
        const out = (await remember(h, value)()) as { factId: string };
        factId = out.factId;
      });
      let r: unknown;
      await h.turn("c", "forget that fact", "Done.", async () => {
        r = await h.tool(MEMORY_FORGET_TOOL, { factId })();
      });
      expect.soft(r, `${key}: forget by id`).toMatchObject({ forgotten: true });
      expect
        .soft(values(h), `${key}: pinned rows after forgetting fact "${value}"`)
        .toEqual(["name=John", "pronouns=he/him"]);
      close(h);
    }
  });

  it("R4-2 pinned name/pronouns survive forgetting unrelated facts by text (incl. text that contains the value)", async () => {
    const cases = [
      "my dog Rex likes John",
      "John's locker is 4417",
      "the he/him sticker on my laptop",
      "Rex the dog",
    ];
    for (const factText of cases) {
      const h = setup();
      h.store.upsertProfile(P("name", "John", true));
      h.store.upsertProfile(P("pronouns", "he/him", true));
      await h.turn(
        "a",
        `remember ${factText}`,
        "Saved.",
        remember(h, factText),
      );
      let r: unknown;
      await h.turn("c", `forget ${factText}`, "Done.", async () => {
        r = await forget(h, factText)();
      });
      expect.soft(r, factText).toMatchObject({ forgotten: true });
      expect
        .soft(values(h), `after forgetting "${factText}"`)
        .toEqual(["name=John", "pronouns=he/him"]);
      close(h);
    }
  });

  it("R4-3 a bare needle equal to a pinned key keeps that row", async () => {
    const h = setup();
    h.store.upsertProfile(P("name", "John", true));
    await h.turn(
      "a",
      "remember my dog's name is Rex",
      "Saved.",
      remember(h, "John's dog's name is Rex"),
    );
    let r: unknown;
    await h.turn("c", "forget the dog's name", "Done.", async () => {
      r = await forget(h, "name")();
    });
    expect(r).toMatchObject({ forgotten: true });
    expect(values(h)).toEqual(["name=John"]);
    expect(h.store.listFacts()).toEqual([]);
    close(h);
  });

  it("drops a pinned name when the needle is my name", async () => {
    const h = setup();
    h.store.upsertProfile(P("name", "John", true));
    h.store.upsertProfile(P("pronouns", "he/him", true));
    await h.turn("a", "remember my name", "Saved.", remember(h, "my name"));
    let r: unknown;
    await h.turn("c", "forget my name", "Done.", async () => {
      r = await forget(h, "my name")();
    });
    expect(r).toMatchObject({ forgotten: true });
    expect(values(h)).toEqual(["pronouns=he/him"]);
    close(h);
  });
});

describe("round4 reviewer: request-turn secrets", () => {
  it("R4-4 a secret only in the request turn drops no rows (fact path)", async () => {
    const h = setup();
    h.store.upsertProfile(P("door_pin", "5521"));
    h.store.upsertProfile(P("door_pin_pinned", "door pin 5521", true));
    await h.turn(
      "a",
      "remember the wifi note is on the fridge",
      "Saved.",
      remember(h, "wifi note is on the fridge"),
    );
    let r: unknown;
    await h.turn(
      "c",
      "forget the wifi note, and btw my door pin is 5521",
      "Done.",
      async () => {
        r = await forget(h, "wifi note")();
      },
    );
    expect.soft(r).toMatchObject({ forgotten: true });
    expect
      .soft(values(h))
      .toEqual(["door_pin=5521", "door_pin_pinned=door pin 5521"]);
    close(h);
  });

  it("R4-5 a secret only in the request turn drops no rows (turn fallback)", async () => {
    const h = setup();
    h.store.upsertProfile(P("door_pin", "5521"));
    h.store.upsertProfile(P("door_pin_pinned", "door pin 5521", true));
    await h.turn("a", "the wifi note is on the fridge", "Ok.");
    let r: unknown;
    await h.turn(
      "c",
      "forget the wifi note, my door pin is 5521",
      "Done.",
      async () => {
        r = await forget(h, "wifi note")();
      },
    );
    expect.soft(r).toMatchObject({ forgotten: true });
    expect
      .soft(ids(h))
      .toEqual(expect.arrayContaining(["a-1-user", "a-2-assistant"]));
    expect
      .soft(values(h))
      .toEqual(["door_pin=5521", "door_pin_pinned=door pin 5521"]);
    close(h);
  });

  it("R4-6 a secret only in the request turn drops no rows (chunk fallback whose span reaches the request)", async () => {
    const h = setup();
    h.store.upsertProfile(P("door_pin", "5521"));
    await h.turn("a", "weather?", "Sunny.");
    let r: unknown;
    await h.turn(
      "a",
      "forget the wifi note, my door pin is 5521",
      "Done.",
      async () => {
        const t = turnIdsOf(h, "a");
        h.store.upsertChunk({
          chunkId: "cx",
          sessionId: "a",
          firstTurn: t[0] ?? null,
          lastTurn: t.at(-1) ?? null,
          text: "weather chat; wifi note; door pin 5521",
        });
        r = await forget(h, "wifi note")();
      },
    );
    expect.soft(r).toMatchObject({ forgotten: true });
    expect.soft(values(h)).toEqual(["door_pin=5521"]);
    close(h);
  });

  it("R4-7 request-only match returns not found and forgets nothing", async () => {
    const h = setup();
    h.store.upsertProfile(P("x", "locker 4417"));
    await h.turn("a", "hello there", "Hi.");
    let r: unknown;
    await h.turn("c", "forget my locker code 4417", "Done.", async () => {
      r = await forget(h, "locker code 4417")();
    });
    expect.soft(r).toMatchObject({ forgotten: false, reason: "not found" });
    expect.soft(ids(h)).toEqual([]);
    expect.soft(values(h)).toEqual(["x=locker 4417"]);
    close(h);
  });
});

describe("round4 reviewer: 5-limit and duplicates", () => {
  it("R4-8 six exact duplicates (case/space variants) count once and are forgotten", async () => {
    const h = setup();
    const texts = [
      "my parking spot is B12",
      "My parking spot is B12",
      "my parking spot is B12 ",
      "MY PARKING SPOT IS B12",
      "my parking spot is B12",
      "my parking spot is B12",
    ];
    for (const t of texts) await h.turn("a", t, "Ok.");
    let r: unknown;
    await h.turn("c", "forget my parking spot", "Done.", async () => {
      r = await forget(h, "parking spot")();
    });
    expect.soft(r).toMatchObject({ forgotten: true });
    expect.soft(ids(h).filter((id) => id.startsWith("a-")).length).toBe(12);
    close(h);
  });

  it("R4-9 six distinct texts: at most 5 candidates and nothing forgotten", async () => {
    const h = setup();
    for (let i = 0; i < 6; i += 1)
      await h.turn("a", `parking spot note ${i}`, "Ok.");
    let r: unknown;
    await h.turn("c", "forget parking spot", "Done.", async () => {
      r = await forget(h, "parking spot")();
    });
    expect.soft(r).toMatchObject({ forgotten: false, reason: "ambiguous" });
    expect
      .soft((r as { candidates: unknown[] }).candidates.length)
      .toBeLessThanOrEqual(5);
    expect.soft(ids(h)).toEqual([]);
    close(h);
  });

  it("R4-10 five distinct texts with many duplicates are not over the cap", async () => {
    const h = setup();
    for (let k = 0; k < 3; k += 1)
      for (let i = 0; i < 5; i += 1)
        await h.turn("a", `parking spot note ${i}`, "Ok.");
    let r: unknown;
    await h.turn("c", "forget parking spot", "Done.", async () => {
      r = await forget(h, "parking spot")();
    });
    expect.soft(r).toMatchObject({ forgotten: false, reason: "ambiguous" });
    expect.soft((r as { candidates: unknown[] }).candidates.length).toBe(5);
    close(h);
  });

  it("R4-11 an assistant reply that echoes the needle does not make a unique turn ambiguous", async () => {
    const h = setup();
    await h.turn(
      "a",
      "my locker code is 4417",
      "Noted, your locker code is 4417.",
    );
    await h.turn("a", "weather?", "Sunny.");
    let r: unknown;
    await h.turn("c", "forget my locker code", "Done.", async () => {
      r = await forget(h, "locker code")();
    });
    expect.soft(r).toMatchObject({ forgotten: true });
    expect
      .soft(ids(h))
      .toEqual(expect.arrayContaining(["a-1-user", "a-2-assistant"]));
    expect.soft(await everySurface(h, "e", SECRET)).toEqual(CLEAN);
    close(h);
  });

  it("R4-12 fact path does not mark unrelated turns that contain the needle", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my locker code is 4417",
      "Saved.",
      remember(h, "John's locker code is 4417"),
    );
    for (let i = 0; i < 8; i += 1)
      await h.turn(
        `other${i}`,
        `code review for barcode decoder ${i}`,
        "Sure.",
      );
    let r: unknown;
    await h.turn("c", "forget my locker code", "Done.", async () => {
      r = await forget(h, "code")();
    });
    const unrelated = ids(h).filter((id) => id.startsWith("other"));
    expect.soft(r).toMatchObject({ forgotten: true });
    expect
      .soft(unrelated, "unrelated turns forgotten by a fact-path forget")
      .toEqual([]);
    close(h);
  });
});

describe("round4 reviewer: retrieval never returns forgotten material", () => {
  it("R4-13 fact path: retrieve, FTS, vectors, embed_index, context builder, after a second forget and after reflect", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my locker code is 4417",
      "Saved, locker code 4417.",
      remember(h, "John's locker code is 4417"),
    );
    await h.turn(
      "a",
      "my bike is a bluefox 7731",
      "Nice.",
      remember(h, "John's bike is a bluefox 7731"),
    );
    await h.turn("a", "weather?", "Sunny.");
    await h.indexer.indexPending();
    const aTurns = turnIdsOf(h, "a");
    expect.soft(embedRowsFor(h, aTurns.slice(0, 2)).length).toBeGreaterThan(0);
    const before = await everySurface(h, "pre", SECRET);
    expect.soft(before.retrieve).toBe(true);
    await h.turn("c", "forget my locker code", "Done.", async () => {
      await forget(h, "locker code")();
    });
    const forgottenA = ids(h).filter((id) => id.startsWith("a-"));
    expect.soft(forgottenA).toEqual(["a-1-user", "a-2-assistant"]);
    expect.soft(embedRowsFor(h, forgottenA)).toEqual([]);
    const chunkIds = (
      h.db.prepare("SELECT chunk_id FROM chunks").all() as Array<{
        chunk_id: string;
      }>
    ).map((c) => c.chunk_id);
    expect
      .soft(
        chunkIds.filter((c) => c.startsWith("a-1-") || c.startsWith("a-2-")),
      )
      .toEqual([]);
    expect
      .soft(
        vecIds(h, "vec_chunks").filter(
          (c) => c.startsWith("a-1-") || c.startsWith("a-2-"),
        ),
      )
      .toEqual([]);
    expect
      .soft(await everySurface(h, "p1", SECRET), "after first forget")
      .toEqual(CLEAN);
    await h.turn("d", "forget my bike", "Done.", async () => {
      await forget(h, "bluefox")();
    });
    expect
      .soft(await everySurface(h, "p2", SECRET), "after second forget (4417)")
      .toEqual(CLEAN);
    expect
      .soft(await everySurface(h, "p2b", "7731"), "after second forget (7731)")
      .toEqual(CLEAN);
    // reflect tries to resurrect a fact and a profile row citing the forgotten turn (summary/journal are benign: the model never sees the secret)
    h.setReflect({
      journal: "weather chat",
      summary: "Weather chat.",
      facts: [
        {
          text: "Locker code 4417",
          kind: "event",
          sourceTurn: "a-1-user",
          contradicts: null,
        },
      ],
      profile: [{ key: "locker", value: "4417" }],
    });
    for (const s of h.store.listSessions()) await h.reflector.reflect(s.id);
    await h.indexer.indexPending();
    const after = await everySurface(h, "p3", SECRET);
    expect
      .soft(h.reflectPrompts.join("\n").includes(SECRET), "reflect prompt")
      .toBe(false);
    expect
      .soft(
        after.retrieve || after.contextBuilder || after.facts || after.chunks,
        "after reflect",
      )
      .toBe(false);
    close(h);
  });

  it("R4-14 turn fallback: a remembered fact whose source turn is forgotten is purged too", async () => {
    const h = setup();
    await h.turn(
      "a",
      "my gym locker is 4417",
      "Saved.",
      remember(h, "Locker combination 4417"),
    );
    await h.turn("a", "weather?", "Sunny.");
    let r: unknown;
    await h.turn("c", "forget my gym locker", "Done.", async () => {
      r = await forget(h, "my gym locker")();
    });
    const surf = await everySurface(h, "f", SECRET);
    expect.soft(r).toMatchObject({ forgotten: true });
    expect
      .soft(ids(h))
      .toEqual(expect.arrayContaining(["a-1-user", "a-2-assistant"]));
    expect.soft(h.store.listFacts()).toEqual([]);
    expect.soft(surf, "derived fact from the forgotten turn").toEqual(CLEAN);
    h.store.insertFact({
      id: "fact-left",
      text: "Locker combination 4417",
      kind: "event",
      subject: null,
      confidence: 1,
      sensitive: false,
      validUntil: null,
      supersededBy: null,
      sourceTurn: "a-1-user",
      createdAt: 1,
      lastUsedAt: null,
    });
    await h.indexer.indexPending();
    const leftover = JSON.stringify(
      await h.retriever.retrieve(`locker code ${SECRET}`),
    );
    expect
      .soft(leftover.includes(SECRET), "fact citing a forgotten turn")
      .toBe(false);
    close(h);
  });
});

describe("round4 reviewer: chunk fallback", () => {
  it("R4-15 no fact or turn matches: chunk marks every covered turn and purges chunk, vector and embed_index", async () => {
    const h = setup();
    await h.turn("a", "my locker is 4417", "Ok.");
    await h.turn("a", "and the gym is on King", "Ok.");
    await h.turn("a", "weather?", "Sunny.");
    await h.turn("b", "unrelated", "Fine.");
    await h.indexer.indexPending();
    const t = turnIdsOf(h, "a");
    h.store.upsertChunk({
      chunkId: "c1",
      sessionId: "a",
      firstTurn: t[0] ?? null,
      lastTurn: t[3] ?? null,
      text: "John's locker combination is 4417 at the King gym.",
    });
    const v = new Float32Array(EMBEDDING_DIMENSIONS);
    v[0] = 1;
    await h.vectors.upsert("vec_chunks", "c1", v);
    h.db
      .prepare(
        "INSERT INTO embed_index (id, vec_table, source, source_id, model, tokens, created_at) VALUES ('c1','vec_chunks','chunk','c1','m',1,1)",
      )
      .run();
    let r: unknown;
    await h.turn("c", "forget that", "Done.", async () => {
      r = await forget(h, "locker combination")();
    });
    expect.soft(r).toMatchObject({ forgotten: true, factIds: [] });
    expect.soft(ids(h)).toEqual(expect.arrayContaining(t.slice(0, 4)));
    expect.soft(ids(h)).not.toContain("a-5-user");
    expect.soft(ids(h).some((id) => id.startsWith("b-"))).toBe(false);
    expect.soft(h.store.listChunks().map((c) => c.chunkId)).not.toContain("c1");
    expect.soft(vecIds(h, "vec_chunks")).not.toContain("c1");
    expect
      .soft(
        (
          h.db
            .prepare("SELECT count(*) n FROM embed_index WHERE id = 'c1'")
            .get() as { n: number }
        ).n,
      )
      .toBe(0);
    expect.soft(embedRowsFor(h, t.slice(0, 4))).toEqual([]);
    expect.soft(await everySurface(h, "cf", SECRET)).toEqual(CLEAN);
    // second forget must not resurrect
    await h.turn("d", "forget weather", "Done.", async () => {
      await forget(h, "weather?")();
    });
    for (const s of h.store.listSessions()) {
      h.setReflect(reflectNone);
      await h.reflector.reflect(s.id);
    }
    expect
      .soft(await everySurface(h, "cf2", SECRET), "after 2nd forget + reflect")
      .toEqual(CLEAN);
    close(h);
  });
});
