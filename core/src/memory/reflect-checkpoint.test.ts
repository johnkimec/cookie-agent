import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeEmbedder } from "./embedder.ts";
import { createMemoryRuntime } from "./runtime.ts";
import { readReflectIdleMs } from "./schedule.ts";
import { SqliteMemoryStore } from "./sqlite-store.ts";
import type { TurnRecord } from "./types.ts";
import { InMemoryVectorIndex } from "./vectors.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const FACT = "amber marker from the quiet session";

/**
 * Stand-in for `ChatLog.beginAndReflect`, which exists only on PR #27.
 * A new conversation id ends the previous session. Await the runtime's
 * reflector before the first retrieval of the new turn.
 */
async function checkpointThenRetrieve(
  store: SqliteMemoryStore,
  reflect: (sessionId: string) => Promise<void>,
  nextId: string,
  retrieve: () => Promise<string[]>,
): Promise<string[]> {
  const open = store
    .listSessions()
    .filter((session) => session.endedAt === null)
    .map((session) => session.id);
  store.beginConversation(nextId);
  for (const id of open) {
    if (id === nextId) {
      continue;
    }
    const ended = store.session(id);
    if (ended !== null && ended.endedAt !== null) {
      await reflect(id);
    }
  }
  return retrieve();
}

describe("reflect checkpoint", () => {
  it("COOKIE_REFLECT_IDLE_MS=0 commits facts before the next retrieval", async () => {
    const env = { COOKIE_REFLECT_IDLE_MS: "0" };
    expect(readReflectIdleMs(env)).toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "cookie-reflect-checkpoint-"));
    dirs.push(dir);
    const store = SqliteMemoryStore.open(join(dir, "cookie.db"), {
      now: () => 5_000,
    });
    store.beginConversation("conv-a");
    const turn: TurnRecord = {
      id: "conv-a-1-user",
      sessionId: "conv-a",
      role: "user",
      content: "please keep the amber marker",
      tainted: false,
      model: null,
      egress: false,
      escalatedFrom: null,
      tokensIn: null,
      tokensCached: null,
      tokensOut: null,
      costUsd: null,
      latencyMs: null,
      createdAt: 5_000,
    };
    store.appendTurn(turn);
    let factsDuringModel = -1;
    const runtime = createMemoryRuntime({
      store,
      derived: store,
      embedder: new FakeEmbedder(),
      vectors: new InMemoryVectorIndex(),
      now: () => 5_000,
      idleMs: readReflectIdleMs(env),
      timeZone: "UTC",
      recordTurns: false,
      log: () => undefined,
      complete: async () => {
        factsDuringModel = store.listFacts().length;
        return JSON.stringify({
          journal: "Kept the amber marker.",
          summary: "Amber marker kept.",
          facts: [
            {
              text: FACT,
              kind: "event",
              subject: null,
              confidence: 0.9,
              sensitive: false,
              validUntil: null,
              sourceTurn: turn.id,
              contradicts: null,
            },
          ],
          profile: [],
        });
      },
    });
    let retrieves = 0;
    const found = await checkpointThenRetrieve(
      store,
      (sessionId) => runtime.reflector.reflect(sessionId),
      "conv-b",
      async () => {
        retrieves += 1;
        return store.listFacts().map((fact) => fact.text);
      },
    );
    expect(factsDuringModel).toBe(0);
    expect(retrieves).toBe(1);
    expect(found).toContain(FACT);
    expect(store.session("conv-a")?.endedAt).not.toBeNull();
    expect(store.listFacts().map((fact) => fact.text)).toContain(FACT);
    runtime.scheduler.stop();
    store.close();
  });
});
