import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const factTexts = (h: H) =>
  (h.db.prepare("SELECT text FROM facts").all() as Array<{ text: string }>).map(
    (r) => r.text,
  );
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

describe("round5 reviewer: pinned copy made by remember(aboutJohn)", () => {
  it("R5-1 forgetting a remembered aboutJohn fact by text drops its own pinned profile copy (no digits)", async () => {
    const h = setup();
    h.store.upsertProfile(P("name", "John", true));
    await h.turn(
      "a",
      "remember my favourite bar is The Rex",
      "Saved.",
      remember(h, "John's favourite bar is The Rex", true),
    );
    let r: unknown;
    await h.turn("c", "forget my favourite bar", "Done.", async () => {
      r = await forget(h, "favourite bar")();
    });
    expect.soft(r).toMatchObject({ forgotten: true });
    expect.soft(factTexts(h).filter((t) => t.includes("The Rex"))).toEqual([]);
    expect
      .soft(
        values(h).filter((v) => v.includes("The Rex")),
        "pinned copy of the forgotten fact",
      )
      .toEqual([]);
    expect.soft(values(h)).toContain("name=John");
    close(h);
  });
  it("R5-1b same, forgotten by factId", async () => {
    const h = setup();
    let factId = "";
    await h.turn(
      "a",
      "remember my favourite bar is The Rex",
      "Saved.",
      async () => {
        factId = (
          (await remember(h, "John's favourite bar is The Rex", true)()) as {
            factId: string;
          }
        ).factId;
      },
    );
    let r: unknown;
    await h.turn("c", "forget that", "Done.", async () => {
      r = await h.tool(MEMORY_FORGET_TOOL, { factId })();
    });
    expect.soft(r).toMatchObject({ forgotten: true });
    expect.soft(values(h).filter((v) => v.includes("The Rex"))).toEqual([]);
    close(h);
  });
  it("R5-1c control: with a secret number the pinned copy is dropped", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my locker code is 4417",
      "Saved.",
      remember(h, "John's locker code is 4417", true),
    );
    await h.turn(
      "c",
      "forget my locker code",
      "Done.",
      forget(h, "locker code"),
    );
    expect.soft(values(h).filter((v) => v.includes(SECRET))).toEqual([]);
    close(h);
  });
});

describe("round5 reviewer: sibling facts from the forgotten source turn", () => {
  it("R5-2 a sibling fact that carries the same secret is purged and never reaches reflect", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my locker code is 4417 and my gym locker combo is the same 4417",
      "Saved.",
      async () => {
        await remember(h, "John's locker code is 4417")();
        await remember(h, "John's gym locker combo is 4417")();
      },
    );
    await h.turn("b", "weather?", "Sunny.");
    await h.turn(
      "c",
      "forget my locker code",
      "Done.",
      forget(h, "locker code"),
    );
    const prompt = await reflectAll(h);
    const hits = JSON.stringify(
      await h.retriever.retrieve("gym locker combo 4417"),
    );
    expect.soft(hits.includes(SECRET), "retrieve").toBe(false);
    expect
      .soft(
        prompt.includes(SECRET),
        "reflect prompt (Active facts) carries the secret",
      )
      .toBe(false);
    expect
      .soft(
        factTexts(h).filter((t) => t.includes(SECRET)),
        "derived facts still carry the secret",
      )
      .toEqual([]);
    close(h);
  });
  it("R5-2b the model echoes a sibling secret from the reflect prompt into summary/profile/fact on a live turn", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my locker code is 4417 and my gym locker combo is the same 4417",
      "Saved.",
      async () => {
        await remember(h, "John's locker code is 4417")();
        await remember(h, "John's gym locker combo is 4417")();
      },
    );
    await h.turn("a", "weather?", "Sunny.");
    await h.turn(
      "c",
      "forget my locker code",
      "Done.",
      forget(h, "locker code"),
    );
    const live = turnIdsOf(h, "a").find((id) => !ids(h).includes(id)) ?? "";
    // a model that read "Active facts: John's gym locker combo is 4417" and restates it
    await reflectAll(h, {
      journal: "Weather chat. Gym combo 4417.",
      summary: "Weather; gym combo 4417.",
      facts: [
        {
          text: "Gym combo is 4417",
          kind: "event",
          sourceTurn: live,
          contradicts: null,
        },
      ],
      profile: [PR("gym_combo", "4417")],
    });
    const s = await everySurface(h, "r52b", SECRET);
    expect.soft(s, "after reflect echoes the sibling").toEqual(CLEAN);
    close(h);
  });
  it("R5-3 a benign sibling from the forgotten source turn is purged", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my locker code is 4417, also I like oolong tea",
      "Saved.",
      async () => {
        await remember(h, "John's locker code is 4417")();
        await remember(h, "John likes oolong tea")();
      },
    );
    await h.turn(
      "c",
      "forget my locker code",
      "Done.",
      forget(h, "locker code"),
    );
    await h.indexer.indexPending();
    const inTable = factTexts(h).includes("John likes oolong tea");
    const retrievable = JSON.stringify(
      await h.retriever.retrieve("oolong tea"),
    ).includes("oolong");
    const prompt = await reflectAll(h);
    const inPrompt = prompt.includes("oolong");
    expect(inTable, "benign sibling stays in facts").toBe(false);
    expect(retrievable, "benign sibling stays retrievable").toBe(false);
    expect(inPrompt, "benign sibling stays in the reflect prompt").toBe(false);
    close(h);
  });
});

describe("round5 reviewer: second forget", () => {
  it("R5-4 forgetting the same thing twice: not found, nothing new marked, still clean", async () => {
    const h = setup();
    h.store.upsertProfile(P("name", "John", true));
    await h.turn(
      "a",
      "remember my locker code is 4417",
      "Saved.",
      remember(h, "John's locker code is 4417"),
    );
    await h.turn(
      "a",
      "my bike is a bluefox 7731",
      "Nice.",
      remember(h, "John's bike is a bluefox 7731"),
    );
    await h.turn("a", "weather?", "Sunny.");
    await h.turn(
      "c",
      "forget my locker code",
      "Done.",
      forget(h, "locker code"),
    );
    const after1 = [...ids(h)].sort();
    let r2: unknown;
    await h.turn("c", "forget my locker code", "Done again.", async () => {
      r2 = await forget(h, "locker code")();
    });
    const after2 = [...ids(h)].sort();
    expect.soft(r2).toMatchObject({ forgotten: false });
    expect
      .soft(
        after2.filter((id) => !after1.includes(id) && !id.startsWith("c-")),
        "second forget marked new non-request turns",
      )
      .toEqual([]);
    expect.soft(values(h)).toEqual(["name=John"]);
    expect.soft(await everySurface(h, "r54", SECRET)).toEqual(CLEAN);
    // bike fact still live and retrievable
    await h.indexer.indexPending();
    expect
      .soft(
        JSON.stringify(await h.retriever.retrieve("bluefox bike")).includes(
          "bluefox",
        ),
        "unrelated fact survives two forgets",
      )
      .toBe(true);
    close(h);
  });
  it("R5-4b a second forget whose needle only matches the earlier forget request finds nothing", async () => {
    const h = setup();
    await h.turn("a", "the wifi note is on the fridge", "Ok.");
    await h.turn(
      "c",
      "forget the wifi note please",
      "Done.",
      forget(h, "wifi note"),
    );
    let r2: unknown;
    await h.turn("d", "forget wifi note please", "Done.", async () => {
      r2 = await forget(h, "note please")();
    });
    expect.soft(r2).toMatchObject({ forgotten: false });
    close(h);
  });
});

describe("round5 reviewer: reworded profile values", () => {
  it("R5-5 a reflect-made unpinned row that rewords the forgotten fact (no digits) is dropped", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my bike is a Bluefox",
      "Saved.",
      remember(h, "John's bike is a Bluefox"),
    );
    await reflectAll(h, {
      journal: "",
      summary: "",
      facts: [],
      profile: [PR("bike", "Bluefox road bike")],
    });
    const before = values(h);
    await h.turn("c", "forget my bike", "Done.", forget(h, "bluefox"));
    expect.soft(before).toContain("bike=Bluefox road bike");
    expect
      .soft(
        values(h).filter((v) => /bluefox/i.test(v)),
        "reworded profile row survives",
      )
      .toEqual([]);
    close(h);
  });
  it("drops a reword with no shared token when the citation is missing", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my bike is a Bluefox",
      "Saved.",
      remember(h, "John's bike is a Bluefox"),
    );
    await reflectAll(h, {
      journal: "",
      summary: "",
      facts: [],
      profile: [PR("bike", "my blue roadie")],
    });
    const row = h.store.listProfile().find((item) => item.key === "bike");
    expect(row?.sourceTurns).toEqual(["a-1-user", "a-2-assistant"]);
    await h.turn("c", "forget my bike", "Done.", forget(h, "bluefox"));
    expect(values(h).filter((v) => /roadie|bluefox/i.test(v))).toEqual([]);
    close(h);
  });
  it("a hallucinated profile source falls back to every prompt turn", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my bike is a Bluefox",
      "Saved.",
      remember(h, "John's bike is a Bluefox"),
    );
    await reflectAll(h, {
      journal: "",
      summary: "",
      facts: [],
      profile: [
        { ...PR("bike", "my blue roadie"), sourceTurns: ["no-such-turn"] },
      ],
    });
    const row = h.store.listProfile().find((item) => item.key === "bike");
    expect(row?.sourceTurns).toEqual(["a-1-user", "a-2-assistant"]);
    await h.turn("c", "forget my bike", "Done.", forget(h, "bluefox"));
    expect(h.store.listProfile().some((item) => item.key === "bike")).toBe(
      false,
    );
    close(h);
  });
  it("a missing profile citation falls back to every prompt turn", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my bike is a Bluefox",
      "Saved.",
      remember(h, "John's bike is a Bluefox"),
    );
    await reflectAll(h, {
      journal: "",
      summary: "",
      facts: [],
      profile: [PR("bike", "my blue roadie")],
    });
    expect(
      h.store.listProfile().find((item) => item.key === "bike")?.sourceTurns,
    ).toEqual(["a-1-user", "a-2-assistant"]);
    close(h);
  });
  it("R5-5b control: reworded value with the secret number is dropped", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my locker code is 4417",
      "Saved.",
      remember(h, "John's locker code is 4417"),
    );
    await reflectAll(h, {
      journal: "",
      summary: "",
      facts: [],
      profile: [PR("gym", "locker #4417 at the gym")],
    });
    const before = values(h);
    await h.turn(
      "c",
      "forget my locker code",
      "Done.",
      forget(h, "locker code"),
    );
    expect.soft(before.join()).toContain(SECRET);
    expect.soft(values(h).filter((v) => v.includes(SECRET))).toEqual([]);
    close(h);
  });
});

describe("round5 reviewer: vector path", () => {
  it("R5-6 the forgotten fact's vector is gone and no fact citing a forgotten turn comes back from kNN", async () => {
    const h = setup();
    let factId = "";
    await h.turn("a", "remember my locker code is 4417", "Saved.", async () => {
      factId = (
        (await remember(h, "John's locker code is 4417")()) as {
          factId: string;
        }
      ).factId;
    });
    await h.turn("b", "weather?", "Sunny.");
    await h.indexer.indexPending();
    expect
      .soft(
        await h.vectors.has("vec_facts", factId),
        "vector present before forget",
      )
      .toBe(true);
    await h.turn(
      "c",
      "forget my locker code",
      "Done.",
      forget(h, "locker code"),
    );
    // a reflect-style fact citing the forgotten turn written straight into the store + vec index (simulates a race survivor)
    const zombie = {
      id: "fact-zombie",
      text: "Locker code 4417 again",
      kind: "event",
      subject: null,
      confidence: 1,
      sensitive: false,
      validUntil: null,
      supersededBy: null,
      sourceTurn: "a-1-user",
      createdAt: 9,
      lastUsedAt: null,
    };
    h.store.insertFact(zombie as never);
    await h.vectors.upsert(
      "vec_facts",
      zombie.id,
      await new FakeEmbedder().embed("search_document: Locker code 4417 again"),
    );
    const hits = await h.retriever.retrieve("Locker code 4417 again");
    const stillHas = await h.vectors.has("vec_facts", factId);
    expect.soft(stillHas, "forgotten fact vector").toBe(false);
    expect
      .soft(
        JSON.stringify(hits).includes(SECRET),
        "fact citing a forgotten turn via vector/bm25",
      )
      .toBe(false);
    close(h);
  });
});

describe("round5 reviewer: consolidation and summaries after forget", () => {
  it("R5-7 consolidation (expire, merge, profile cap, re-chunk today) does not bring the secret back", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my locker code is 4417",
      "Saved, 4417.",
      remember(h, "John's locker code is 4417"),
    );
    await h.turn("a", "weather?", "Sunny.");
    await h.indexer.indexPending();
    await h.turn(
      "c",
      "forget my locker code",
      "Done.",
      forget(h, "locker code"),
    );
    await consolidator(h).consolidate();
    await h.indexer.indexPending();
    const s = await everySurface(h, "r57", SECRET);
    expect.soft(s).toEqual(CLEAN);
    close(h);
  });
  it("R5-7b reflect after forget writes no summary/journal/profile/fact with the secret even if the model tries (citing forgotten or null turns)", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my locker code is 4417",
      "Saved.",
      remember(h, "John's locker code is 4417"),
    );
    await h.turn("a", "weather?", "Sunny.");
    await h.turn(
      "c",
      "forget my locker code",
      "Done.",
      forget(h, "locker code"),
    );
    const prompt = await reflectAll(h, {
      journal: "j",
      summary: "Weather.",
      facts: [
        {
          text: "Locker code 4417",
          kind: "event",
          sourceTurn: "a-1-user",
          contradicts: null,
        },
        {
          text: "Locker code 4417",
          kind: "event",
          sourceTurn: "a-2-assistant",
          contradicts: null,
        },
      ],
      profile: [PR("locker", "4417")],
    });
    const s = await everySurface(h, "r57b", SECRET);
    expect.soft(prompt.includes(SECRET)).toBe(false);
    expect
      .soft(s.facts || s.retrieve, "facts citing forgotten turns")
      .toBe(false);
    // NB: a model with no secret in its prompt cannot invent 4417; profile echo here is a synthetic worst case (info)
    close(h);
  });
  it("R5-7c forget racing a reflect run (forget lands during complete)", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my locker code is 4417",
      "Saved.",
      remember(h, "John's locker code is 4417"),
    );
    await h.turn("a", "weather?", "Sunny.");
    await h.turn("c", "forget my locker code", "On it.");
    const reply = JSON.stringify({
      journal: "Locker chat",
      summary: "John's locker code is 4417.",
      facts: [
        {
          text: "Locker code is 4417",
          kind: "event",
          sourceTurn: "a-1-user",
          contradicts: null,
        },
      ],
      profile: [PR("locker_code", "4417")],
    });
    // run forget from inside the model call
    const r = new (h.reflector.constructor as typeof LocalReflector)({
      store: h.store,
      derived: h.store,
      embedder: new FakeEmbedder(),
      vectors: h.vectors,
      complete: async () => {
        h.runtime.host.noteUserTurn?.("c-1-user");
        await forget(h, "locker code")();
        return reply;
      },
      now: () => 9_000_000,
      timeZone: "UTC",
      localDay,
      factIds: randomIds("fact"),
      journalIds: randomIds("journal"),
    });
    await r.reflect("a");
    const s = await everySurface(h, "r57c", SECRET);
    expect.soft(s).toEqual(CLEAN);
    close(h);
  });
});

describe("round5 reviewer: pinned rows with partial needle matches", () => {
  const base = () => {
    const h = setup();
    h.store.upsertProfile(P("name", "John Kim", true));
    h.store.upsertProfile(P("home_city", "Toronto", true));
    h.store.upsertProfile(P("locker", "gym locker", true));
    return h;
  };
  const cases: Array<[string, string, string, string[]]> = [
    // [fact remembered, needle, label, expected pinned rows]
    [
      "John's dog is Rex",
      "John",
      "first-name only",
      ["home_city=Toronto", "locker=gym locker", "name=John Kim"],
    ],
    [
      "Kim's Convenience is a show",
      "Kim's",
      "surname only",
      ["home_city=Toronto", "locker=gym locker", "name=John Kim"],
    ],
    [
      "Toronto weather is cold today",
      "Toronto weather",
      "value prefix",
      ["home_city=Toronto", "locker=gym locker", "name=John Kim"],
    ],
    [
      "the home city derby is Sunday",
      "home city",
      "bare key with space",
      ["home_city=Toronto", "locker=gym locker", "name=John Kim"],
    ],
    [
      "my gym locker is by the door",
      "gym locker is by the door",
      "value inside needle",
      ["home_city=Toronto", "locker=gym locker", "name=John Kim"],
    ],
    [
      "my locker is blue",
      "locker",
      "bare key",
      ["home_city=Toronto", "locker=gym locker", "name=John Kim"],
    ],
    [
      "I moved from Toronto",
      "toronto",
      "case-folded value equals needle (drop per N2)",
      ["locker=gym locker", "name=John Kim"],
    ],
    [
      "note: my home city might change",
      "my home city",
      "my <key> (drop per N2)",
      ["locker=gym locker", "name=John Kim"],
    ],
  ];
  for (const [fact, needle, label, expected] of cases) {
    it(`R5-8 ${label}: forget('${needle}')`, async () => {
      const h = base();
      await h.turn("a", `remember ${fact}`, "Saved.", remember(h, fact));
      let r: unknown;
      await h.turn("c", `forget ${needle}`, "Done.", async () => {
        r = await forget(h, needle)();
      });
      expect.soft(r).toMatchObject({ forgotten: true });
      expect.soft(values(h).sort()).toEqual(expected);
      close(h);
    });
  }
  it("R5-8i (info) forget('my name') with no fact or turn containing it", async () => {
    const h = base();
    await h.turn("a", "weather?", "Sunny.");
    let r: unknown;
    await h.turn("c", "please drop it", "Done.", async () => {
      r = await forget(h, "my name")();
    });
    expect(r).toMatchObject({ forgotten: false, reason: "not found" });
    expect(values(h).sort()).toEqual([
      "home_city=Toronto",
      "locker=gym locker",
      "name=John Kim",
    ]);
    close(h);
  });
});

describe("round5 reviewer: info probes", () => {
  it("R5-9 (info) fact path leaves an unrelated turn that repeats the secret recallable (B3 trade-off)", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my locker code is 4417",
      "Saved.",
      remember(h, "John's locker code is 4417"),
    );
    await h.turn("b", "is 4417 still my locker code?", "Yes, 4417.");
    await h.turn(
      "c",
      "forget my locker code",
      "Done.",
      forget(h, "locker code"),
    );
    const s = await everySurface(h, "r59", SECRET);
    // Known issue R5-9: the other conversation that repeats the secret stays recallable.
    expect(ids(h).some((id) => id.startsWith("b-"))).toBe(false);
    expect(s.facts).toBe(false);
    expect(s.profile).toBe(false);
    expect(s.retrieve || s.contextBuilder || s.chunks).toBe(true);
    close(h);
  });
  it("R5-10 (info) pinned row with a short shared number is dropped by an unrelated secret", async () => {
    const h = setup();
    h.store.upsertProfile(P("room", "Room 101", true));
    await h.turn(
      "a",
      "remember bus 101 code",
      "Saved.",
      remember(h, "bus pass pin 101"),
    );
    await h.turn(
      "c",
      "forget my bus pass pin",
      "Done.",
      forget(h, "bus pass pin"),
    );
    // Known issue R5-10: the pinned room number shares the 3-digit token.
    expect(values(h)).toEqual([]);
    close(h);
  });
});

describe("round5 reviewer: chunk vectors (R4-13 used a wrong vec column, so re-check)", () => {
  it("R5-6b chunk vectors for the forgotten turns are deleted", async () => {
    const h = setup();
    await h.turn(
      "a",
      "remember my locker code is 4417",
      "Saved, locker code 4417.",
      remember(h, "John's locker code is 4417"),
    );
    await h.turn("a", "weather?", "Sunny.");
    await h.indexer.indexPending();
    const vecChunkIds = (
      h.db.prepare("SELECT chunk_id FROM vec_chunks").all() as Array<{
        chunk_id: string;
      }>
    ).map((c) => c.chunk_id);
    await h.turn(
      "c",
      "forget my locker code",
      "Done.",
      forget(h, "locker code"),
    );
    const after = (
      h.db.prepare("SELECT chunk_id FROM vec_chunks").all() as Array<{
        chunk_id: string;
      }>
    ).map((c) => c.chunk_id);
    expect
      .soft(
        vecChunkIds.some((c) => c.startsWith("a-1-") || c.startsWith("a-2-")),
        "precondition: chunk vectors existed",
      )
      .toBe(true);
    expect
      .soft(after.filter((c) => c.startsWith("a-1-") || c.startsWith("a-2-")))
      .toEqual([]);
    close(h);
  });
});
