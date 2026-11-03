import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatLog } from "./chat-log.ts";
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
    let found: string[] = [];
    const log = new ChatLog(
      store,
      null,
      {
        retrieve: async () => {
          retrieves += 1;
          found = store.listFacts().map((fact) => fact.text);
          return [];
        },
      },
      { reflector: runtime.reflector },
    );
    await log.messagesFor("conv-b", "what about the amber marker");
    expect(factsDuringModel).toBe(0);
    expect(retrieves).toBe(1);
    expect(found).toContain(FACT);
    expect(store.session("conv-a")?.endedAt).not.toBeNull();
    expect(store.listFacts().map((fact) => fact.text)).toContain(FACT);
    runtime.scheduler.stop();
    store.close();
  });
});
