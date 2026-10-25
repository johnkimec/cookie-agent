/**
 * Fake-model drives for memory.remember, memory.forget, reflect,
 * the profile cap, and rebuild. The real core talks to the llama stub.
 * Retrieval inside the prompt is a later change. These drives assert
 * the rows the core writes and the retrieval filter that already exists.
 */

import { join } from "node:path";
import type { FactKind, ProfileRecord } from "./memory/derived.ts";
import { randomIds } from "./memory/derived.ts";
import { dumpMemory, openReadonlyDatabase } from "./memory/dump.ts";
import { FakeEmbedder } from "./memory/embedder.ts";
import { MEMORY_DB_FILENAME } from "./memory/path.ts";
import { withoutSuperseded } from "./memory/policy.ts";
import {
  capProfile,
  PROFILE_TOKEN_CAP,
  profileTokens,
} from "./memory/profile-cap.ts";
import { LocalReflector, rebuildDerivedMemory } from "./memory/reflect-job.ts";
import { InMemoryRetriever } from "./memory/retrieve.ts";
import { completeViaProvider } from "./memory/runtime.ts";
import { localDay } from "./memory/schedule.ts";
import { SqliteMemoryStore } from "./memory/sqlite-store.ts";
import { InMemoryVectorIndex } from "./memory/vectors.ts";
import { createLlamaServerProvider } from "./model/llama.ts";
import type { CoreSession } from "./verify-drive.ts";
import type {
  LlamaStub,
  LlamaStubOptions,
  StubChatRequest,
  StubScriptTurn,
} from "./verify-llama-stub.ts";

const CHAT_TIMEOUT_MS = 15_000;
const REFLECT_WAIT_MS = 12_000;
const LOCKER = "4417";
const LOCKER_FACT = "The locker code is 4417";
const ECE_FACT = "ECE midterm is Friday";
const AMBER_FACT = "amber marker for the rebuild check";
const JUNK_FACT = "rebuild-should-drop-this";
const REFLECT_MARK = "You extract memory";

export const MEMORY_DRIVE_FEATURES = [
  "memory-remember",
  "memory-forget",
  "memory-reflect",
  "memory-profile-cap",
  "memory-rebuild",
] as const;

export type MemoryDriveFeature = (typeof MEMORY_DRIVE_FEATURES)[number];

export function isMemoryDriveFeature(
  feature: string | undefined,
): feature is MemoryDriveFeature {
  return (
    feature !== undefined &&
    (MEMORY_DRIVE_FEATURES as readonly string[]).includes(feature)
  );
}

/** Short idle for the drives that must see reflect. Remember and rebuild do not. */
export function memoryDriveIdleMs(
  feature: MemoryDriveFeature,
): string | undefined {
  if (
    feature === "memory-forget" ||
    feature === "memory-reflect" ||
    feature === "memory-profile-cap"
  ) {
    return "250";
  }
  return undefined;
}

export function memoryStubOptions(
  feature: MemoryDriveFeature,
): LlamaStubOptions {
  if (feature === "memory-remember") {
    return { script: rememberScript };
  }
  if (feature === "memory-forget") {
    return { script: forgetScript };
  }
  if (feature === "memory-reflect") {
    return { script: reflectScript(reflectHold) };
  }
  if (feature === "memory-profile-cap") {
    return { script: profileScript };
  }
  return { script: rebuildScript };
}

/**
 * The reflect drive holds the first reflect request. The holder lives
 * on the module so the drive can see the same request the stub holds.
 * `memoryStubOptions` is called once per drive, before the core starts.
 */
const reflectHold: { request: StubChatRequest | null } = { request: null };

export interface MemoryDriveContext {
  feature: MemoryDriveFeature;
  session: CoreSession;
  stub: LlamaStub;
  dataDir: string;
  port: string;
  boot: (session: CoreSession) => Promise<void>;
  respawn: () => CoreSession;
  release: (session: CoreSession) => Promise<void>;
}

export async function runMemoryDrive(
  ctx: MemoryDriveContext,
): Promise<{ summary: string; dbText: string; session: CoreSession }> {
  if (ctx.feature === "memory-reflect") {
    reflectHold.request = null;
  }
  await ctx.boot(ctx.session);
  if (ctx.feature === "memory-remember") {
    return finish(ctx, await runRemember(ctx));
  }
  if (ctx.feature === "memory-forget") {
    return finish(ctx, await runForget(ctx));
  }
  if (ctx.feature === "memory-reflect") {
    return finish(ctx, await runReflect(ctx));
  }
  if (ctx.feature === "memory-profile-cap") {
    return finish(ctx, await runProfile(ctx));
  }
  return runRebuild(ctx);
}

function finish(
  ctx: MemoryDriveContext,
  summary: string,
): { summary: string; dbText: string; session: CoreSession } {
  const dbText = derivedDump(dbPath(ctx.dataDir));
  assertEgressZero(dbText);
  return { summary, dbText, session: ctx.session };
}

async function runRemember(ctx: MemoryDriveContext): Promise<string> {
  await chat(
    ctx.session,
    "2",
    "conv-remember",
    "Remember my ECE midterm is Friday",
  );
  await chat(ctx.session, "3", "conv-remember-next", "When is my ECE midterm?");
  await shutdown(ctx.session, "4");
  const dbText = derivedDump(dbPath(ctx.dataDir));
  const fact = jsonLines(dbText, "fact").find((row) => row.text === ECE_FACT);
  if (fact === undefined || typeof fact.source_turn !== "string") {
    throw new Error("pinned remember fact is missing source_turn");
  }
  const profile = jsonLines(dbText, "profile").find(
    (row) => row.key === "ece_midterm",
  );
  if (profile?.pinned !== 1 || profile.value !== ECE_FACT) {
    throw new Error("ECE fact is not pinned on the profile");
  }
  const turn = jsonLines(dbText, "turn").find(
    (row) => row.id === fact.source_turn,
  );
  if (
    turn?.role !== "user" ||
    turn.content !== "Remember my ECE midterm is Friday"
  ) {
    throw new Error("source_turn is not the remember user turn");
  }
  const conversations = new Set(
    ctx.session.transcript
      .map((entry) => conversationOf(entry.message))
      .filter((id) => id !== null),
  );
  if (
    !conversations.has("conv-remember") ||
    !conversations.has("conv-remember-next")
  ) {
    throw new Error("remember drive did not open a second conversation");
  }
  return ["ok", "remember true", "pinned true", "egress 0", ""].join("\n");
}

async function runForget(ctx: MemoryDriveContext): Promise<string> {
  const path = dbPath(ctx.dataDir);
  await chat(
    ctx.session,
    "2",
    "conv-locker",
    "Remember the locker code is 4417",
  );
  await waitUntil("reflect wrote 4417", REFLECT_WAIT_MS, () =>
    derivedCopyHasLocker(derivedDump(path)),
  );
  await chat(ctx.session, "3", "conv-locker", "Forget that code");
  await chat(ctx.session, "4", "conv-locker-ask", "What is the locker code?");
  await shutdown(ctx.session, "5");
  const dbText = derivedDump(path);
  assertLockerGone(dbText);
  const store = SqliteMemoryStore.open(path);
  try {
    if (store.forgottenTurnIds().length === 0) {
      throw new Error("forgotten_turns is empty");
    }
    const retriever = new InMemoryRetriever();
    retriever.add({
      id: "planted",
      text: LOCKER_FACT,
      source: "fact",
    });
    const hits = await withoutSuperseded(retriever.retrieve, store, () =>
      Date.now(),
    )(LOCKER);
    if (hits.length !== 0) {
      throw new Error("retrieval kept a fact hit for the forgotten text");
    }
  } finally {
    store.close();
  }
  return ["ok", "forget true", "retrieval dropped", "egress 0", ""].join("\n");
}

async function runReflect(ctx: MemoryDriveContext): Promise<string> {
  await chat(ctx.session, "2", "conv-reflect-a", "hello reflect");
  await waitUntil(
    "reflect armed",
    REFLECT_WAIT_MS,
    () => reflectHold.request !== null,
  );
  await chat(ctx.session, "3", "conv-reflect-b", "new chat please");
  if (reflectHold.request?.aborted !== true) {
    const rows = ctx.stub.chats.map((chat, index) => {
      const text = JSON.stringify(chat.body);
      return `${index} aborted=${chat.aborted} reflect=${text.includes(REFLECT_MARK)}`;
    });
    throw new Error(
      `chat.send did not abort the idle reflect\n${rows.join("\n")}`,
    );
  }
  const path = dbPath(ctx.dataDir);
  await waitUntil("reflect journal", REFLECT_WAIT_MS, () => {
    const journal = jsonLines(derivedDump(path), "journal");
    const facts = jsonLines(derivedDump(path), "fact");
    return (
      journal.length === 1 &&
      facts.some(
        (row) =>
          typeof row.source_turn === "string" && row.source_turn.length > 0,
      )
    );
  });
  await shutdown(ctx.session, "4");
  const dbText = derivedDump(path);
  const facts = jsonLines(dbText, "fact");
  const journal = jsonLines(dbText, "journal");
  if (journal.length !== 1) {
    throw new Error(`journal rows ${String(journal.length)}`);
  }
  const fact = facts.find((row) => typeof row.source_turn === "string");
  const turn = jsonLines(dbText, "turn").find(
    (row) => row.id === fact?.source_turn,
  );
  if (turn === undefined) {
    throw new Error("reflect fact source_turn is not a stored turn");
  }
  return ["ok", "reflect aborted", "journal 1", "egress 0", ""].join("\n");
}

async function runProfile(ctx: MemoryDriveContext): Promise<string> {
  const path = dbPath(ctx.dataDir);
  await chat(ctx.session, "2", "conv-profile", "hello profile");
  await waitUntil(
    "profile rows",
    REFLECT_WAIT_MS,
    () => profileCount(path) >= 17,
  );
  await shutdown(ctx.session, "3");
  const rows = profileRecords(path);
  const visible = capProfile(rows);
  if (rows.length <= visible.length) {
    throw new Error("profile overflow was deleted");
  }
  if (profileTokens(visible) > PROFILE_TOKEN_CAP) {
    throw new Error(`profile tokens ${String(profileTokens(visible))}`);
  }
  const pinned = visible.find((row) => row.key === "name");
  if (pinned?.pinned !== true || pinned.value !== "John") {
    throw new Error("pinned name did not survive the cap");
  }
  if (!rows.some((row) => row.key === "note_15")) {
    throw new Error("unpinned overflow is missing from the store");
  }
  return ["ok", "profile capped", "pinned kept", "egress 0", ""].join("\n");
}

async function runRebuild(
  ctx: MemoryDriveContext,
): Promise<{ summary: string; dbText: string; session: CoreSession }> {
  await chat(ctx.session, "2", "conv-rebuild", `Remember the ${AMBER_FACT}`);
  await shutdown(ctx.session, "3");
  const path = dbPath(ctx.dataDir);
  const store = SqliteMemoryStore.open(path);
  try {
    const user = store
      .recentTurns("conv-rebuild", 20)
      .find(
        (turn) => turn.role === "user" && turn.content.includes(AMBER_FACT),
      );
    if (user === undefined) {
      throw new Error("rebuild turn is missing");
    }
    store.insertFact({
      id: "junk-rebuild",
      text: JUNK_FACT,
      kind: "event",
      subject: null,
      confidence: 1,
      sensitive: false,
      validUntil: null,
      supersededBy: null,
      sourceTurn: user.id,
      createdAt: Date.now(),
      lastUsedAt: null,
    });
    const vectors = new InMemoryVectorIndex();
    const reflector = new LocalReflector({
      store,
      derived: store,
      embedder: new FakeEmbedder(),
      vectors,
      complete: (args) =>
        completeViaProvider(
          createLlamaServerProvider({ port: Number(ctx.port) }),
          args,
        ),
      now: () => Date.now(),
      timeZone: "UTC",
      localDay,
      factIds: randomIds("fact"),
      journalIds: randomIds("journal"),
    });
    await rebuildDerivedMemory({
      sessionIds: ["conv-rebuild"],
      derived: store,
      vectors,
      reflect: (sessionId) => reflector.reflect(sessionId),
    });
    const facts = store.listFacts();
    if (facts.some((fact) => fact.text.includes(JUNK_FACT))) {
      throw new Error("rebuild kept the junk fact");
    }
    const rebuilt = facts.find((fact) => fact.text === AMBER_FACT);
    if (rebuilt?.sourceTurn !== user.id) {
      throw new Error("rebuilt fact is not sourced from the turn");
    }
  } finally {
    store.close();
  }
  await ctx.release(ctx.session);
  const second = ctx.respawn();
  try {
    await ctx.boot(second);
    await chat(
      second,
      "2",
      "conv-rebuild",
      "What marker did I ask you to keep?",
    );
    const last = ctx.stub.chats.at(-1);
    if (!JSON.stringify(last?.body ?? "").includes(AMBER_FACT)) {
      throw new Error("relaunch prompt did not contain the turn");
    }
    await shutdown(second, "3");
    const dbText = derivedDump(path);
    assertEgressZero(dbText);
    if (!jsonLines(dbText, "fact").some((row) => row.text === AMBER_FACT)) {
      throw new Error("rebuilt fact did not survive relaunch");
    }
    if (dbText.includes(JUNK_FACT)) {
      throw new Error("junk fact survived relaunch");
    }
    second.mergeEarlier(ctx.session);
    return {
      summary: ["ok", "rebuild true", "recall true", "egress 0", ""].join("\n"),
      dbText,
      session: second,
    };
  } catch (error) {
    await ctx.release(second);
    throw error;
  }
}

export function assertForgetStderr(stderr: string): void {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new Error("memory-forget did not log");
  }
  for (const line of lines) {
    if (!/^memory\.forget facts=\S+ turns=\S+$/.test(line)) {
      throw new Error(`stderr: ${line}`);
    }
    if (line.includes(LOCKER)) {
      throw new Error("forget log contains the fact text");
    }
  }
}

function rememberScript(record: StubChatRequest): StubScriptTurn {
  if (hasToolResult(record)) {
    return { kind: "text", text: "I'll remember that." };
  }
  if (lastUser(record).includes("Remember my ECE midterm is Friday")) {
    return {
      kind: "tool",
      name: "memory.remember",
      arguments: {
        text: ECE_FACT,
        kind: "event",
        aboutJohn: true,
        profileKey: "ece_midterm",
      },
    };
  }
  return { kind: "text", text: "Friday." };
}

function forgetScript(record: StubChatRequest): StubScriptTurn {
  if (isReflectRequest(record)) {
    const keep = blob(record).includes(LOCKER);
    return {
      kind: "text",
      text: reflectJson(record, keep ? LOCKER_FACT : null, keep),
    };
  }
  if (hasToolResult(record)) {
    return lastUser(record).includes("Forget that code")
      ? { kind: "text", text: "Done." }
      : { kind: "text", text: "Saved." };
  }
  if (lastUser(record).includes("Remember the locker code is 4417")) {
    return {
      kind: "tool",
      name: "memory.remember",
      arguments: {
        text: LOCKER_FACT,
        kind: "event",
        aboutJohn: true,
        profileKey: "locker",
      },
    };
  }
  if (lastUser(record).includes("Forget that code")) {
    return {
      kind: "tool",
      name: "memory.forget",
      arguments: { text: LOCKER },
    };
  }
  return { kind: "text", text: "I don't have that." };
}

function reflectScript(hold: {
  request: StubChatRequest | null;
}): (record: StubChatRequest) => StubScriptTurn {
  return (record) => {
    if (!isReflectRequest(record)) {
      return { kind: "text", text: "ok" };
    }
    if (hold.request === null) {
      hold.request = record;
      return { kind: "hold" };
    }
    return {
      kind: "text",
      text: reflectJson(record, "Noted the quiet session.", false),
    };
  };
}

function profileScript(record: StubChatRequest): StubScriptTurn {
  if (!isReflectRequest(record)) {
    return { kind: "text", text: "ok" };
  }
  const notes = [];
  for (let index = 0; index < 16; index += 1) {
    notes.push({
      key: `note_${String(index).padStart(2, "0")}`,
      value: "n".repeat(480),
      statedByJohn: false,
      stable: false,
      sessionsObserved: 3,
      shareable: true,
      sensitive: false,
      pinned: false,
    });
  }
  return {
    kind: "text",
    text: JSON.stringify({
      journal: "Profile notes from this session.",
      summary: "Profile notes.",
      facts: [],
      profile: [
        {
          key: "name",
          value: "John",
          statedByJohn: true,
          stable: true,
          sessionsObserved: 1,
          shareable: true,
          sensitive: false,
          pinned: true,
        },
        ...notes,
      ],
    }),
  };
}

function rebuildScript(record: StubChatRequest): StubScriptTurn {
  if (isReflectRequest(record)) {
    return { kind: "text", text: reflectJson(record, AMBER_FACT, false) };
  }
  if (hasToolResult(record)) {
    return { kind: "text", text: "Saved." };
  }
  if (lastUser(record).includes(AMBER_FACT)) {
    return {
      kind: "tool",
      name: "memory.remember",
      arguments: { text: AMBER_FACT, kind: "event" },
    };
  }
  return { kind: "text", text: "The marker is still there." };
}

function reflectJson(
  record: StubChatRequest,
  factText: string | null,
  markerInCopy: boolean,
): string {
  const source = userTurnId(blob(record));
  const facts =
    factText !== null && source !== null
      ? [
          {
            text: factText,
            kind: "event" satisfies FactKind,
            subject: null,
            confidence: 0.9,
            sensitive: false,
            validUntil: null,
            sourceTurn: source,
            contradicts: null,
          },
        ]
      : [];
  const copy = markerInCopy
    ? "John mentioned locker code 4417."
    : factText === null
      ? "Nothing kept."
      : "Kept a note from this session.";
  const summary = markerInCopy
    ? "Locker code 4417."
    : factText === null
      ? "Nothing kept."
      : "Session note.";
  return JSON.stringify({
    journal: copy,
    summary,
    facts,
    profile: [],
  });
}

function userTurnId(text: string): string | null {
  const match = text.match(/id=([A-Za-z0-9-]+-user)/);
  return match?.[1] ?? null;
}

function isReflectRequest(record: StubChatRequest): boolean {
  return blob(record).includes(REFLECT_MARK);
}

function hasToolResult(record: StubChatRequest): boolean {
  return blob(record).includes('"role":"tool"');
}

function blob(record: StubChatRequest): string {
  return JSON.stringify(record.body);
}

function lastUser(record: StubChatRequest): string {
  const messages = record.messages;
  if (!Array.isArray(messages)) {
    return "";
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) {
      continue;
    }
    const row = message as { role?: unknown; content?: unknown };
    if (row.role !== "user" || typeof row.content !== "string") {
      continue;
    }
    return row.content;
  }
  return "";
}

function dbPath(dataDir: string): string {
  return join(dataDir, MEMORY_DB_FILENAME);
}

function derivedDump(path: string): string {
  const facts = readAll(
    path,
    "SELECT id, text, source_turn, superseded_by FROM facts ORDER BY id",
  );
  const profile = readAll(
    path,
    "SELECT key, value, pinned, source_turn FROM profile ORDER BY key",
  );
  const journal = readAll(
    path,
    "SELECT id, entry, session_id FROM journal ORDER BY id",
  );
  const chunks = readAll(
    path,
    "SELECT chunk_id, text, first_turn, last_turn FROM chunks ORDER BY chunk_id",
  );
  const forgotten = readAll(
    path,
    "SELECT turn_id, forgotten_at, fact_ids FROM forgotten_turns ORDER BY turn_id",
  );
  const fts = readAll(path, "SELECT text FROM facts_fts ORDER BY text");
  return [
    dumpMemory(path).trimEnd(),
    ...facts.map((row) => `fact ${JSON.stringify(row)}`),
    ...profile.map((row) => `profile ${JSON.stringify(row)}`),
    ...journal.map((row) => `journal ${JSON.stringify(row)}`),
    ...chunks.map((row) => `chunk ${JSON.stringify(row)}`),
    ...forgotten.map((row) => `forgotten ${JSON.stringify(row)}`),
    ...fts.map((row) => `facts_fts ${JSON.stringify(row)}`),
    "",
  ].join("\n");
}

function readAll(path: string, sql: string): Array<Record<string, unknown>> {
  const db = openReadonlyDatabase(path);
  try {
    return db.prepare(sql).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function jsonLines(
  dump: string,
  prefix: string,
): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const line of dump.split("\n")) {
    if (!line.startsWith(`${prefix} `)) {
      continue;
    }
    rows.push(
      JSON.parse(line.slice(prefix.length + 1)) as Record<string, unknown>,
    );
  }
  return rows;
}

function assertEgressZero(dump: string): void {
  let turns = 0;
  for (const line of dump.split("\n")) {
    if (!line.startsWith("turn ")) {
      continue;
    }
    turns += 1;
    const row = JSON.parse(line.slice("turn ".length)) as { egress?: unknown };
    if (row.egress !== 0) {
      throw new Error("stored turn egress is not 0");
    }
  }
  if (turns === 0) {
    throw new Error("no turns stored");
  }
}

function assertLockerGone(dump: string): void {
  const turnHit = jsonLines(dump, "turn").some(
    (row) => typeof row.content === "string" && row.content.includes(LOCKER),
  );
  if (!turnHit) {
    throw new Error("raw turn lost the locker code");
  }
  for (const prefix of ["fact", "profile", "journal", "chunk", "facts_fts"]) {
    for (const row of jsonLines(dump, prefix)) {
      if (JSON.stringify(row).includes(LOCKER)) {
        throw new Error(`${prefix} still contains ${LOCKER}`);
      }
    }
  }
  for (const row of jsonLines(dump, "session")) {
    if (typeof row.summary === "string" && row.summary.includes(LOCKER)) {
      throw new Error("summary still contains the locker code");
    }
  }
  const forgotten = jsonLines(dump, "forgotten");
  if (forgotten.length === 0) {
    throw new Error("forgotten_turns is missing");
  }
  for (const row of forgotten) {
    if (JSON.stringify(row.fact_ids ?? "").includes(LOCKER)) {
      throw new Error("forgotten_turns stores the fact text");
    }
  }
}

function profileCount(path: string): number {
  return profileRecords(path).length;
}

function profileRecords(path: string): ProfileRecord[] {
  return readAll(
    path,
    "SELECT key, value, pinned, shareable, source_turn, updated_at FROM profile ORDER BY key",
  ).map((row) => ({
    key: String(row.key),
    value: String(row.value),
    pinned: row.pinned === 1,
    shareable: row.shareable !== 0,
    sourceTurn: typeof row.source_turn === "string" ? row.source_turn : null,
    updatedAt: typeof row.updated_at === "number" ? row.updated_at : 0,
  }));
}

function conversationOf(message: unknown): string | null {
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const row = message as { method?: unknown; params?: unknown };
  if (row.method !== "chat.send") {
    return null;
  }
  const params = row.params;
  if (typeof params !== "object" || params === null) {
    return null;
  }
  const id = (params as { conversationId?: unknown }).conversationId;
  return typeof id === "string" ? id : null;
}

async function chat(
  session: CoreSession,
  id: string,
  conversationId: string,
  text: string,
): Promise<string> {
  session.send({
    jsonrpc: "2.0",
    id,
    method: "chat.send",
    params: { conversationId, text },
  });
  const ack = await session.response(id, CHAT_TIMEOUT_MS);
  if (!isRecord(ack.result)) {
    throw new Error(`chat.send ${id} failed`);
  }
  const parts: string[] = [];
  const deadline = Date.now() + CHAT_TIMEOUT_MS;
  for (;;) {
    const message = asRecord(
      await session.next(remaining(deadline, `chat ${id}`)),
      "chat",
    );
    if (message.method === "chat.delta") {
      const params = asRecord(message.params, "delta");
      if (typeof params.text === "string" && params.text.length > 0) {
        parts.push(params.text);
      }
      continue;
    }
    if (message.method === "runtime.status") {
      continue;
    }
    if (message.method !== "chat.done") {
      throw new Error(`unexpected ${String(message.method)}`);
    }
    const params = asRecord(message.params, "done");
    if (params.finishReason !== "stop") {
      throw new Error(
        `finishReason ${String(params.finishReason)} ${parts.join("").slice(0, 120)}`,
      );
    }
    return parts.join("");
  }
}

async function shutdown(session: CoreSession, id: string): Promise<void> {
  session.send({ jsonrpc: "2.0", id, method: "shutdown", params: {} });
  const response = await session.response(id, CHAT_TIMEOUT_MS);
  const result = asRecord(response.result, "shutdown");
  if (result.ok !== true) {
    throw new Error("shutdown was not ok");
  }
  const code = await session.waitForExit();
  if (code !== 0) {
    throw new Error(`core exit ${String(code)}`);
  }
}

async function waitUntil(
  label: string,
  timeoutMs: number,
  ready: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ready()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
  }
  throw new Error(`timed out ${label}`);
}

function remaining(deadline: number, label: string): number {
  const left = deadline - Date.now();
  if (left <= 0) {
    throw new Error(`timed out ${label}`);
  }
  return left;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function derivedCopyHasLocker(dump: string): boolean {
  const summary = jsonLines(dump, "session").some(
    (row) => typeof row.summary === "string" && row.summary.includes(LOCKER),
  );
  const journal = jsonLines(dump, "journal").some((row) =>
    JSON.stringify(row).includes(LOCKER),
  );
  return summary && journal;
}
