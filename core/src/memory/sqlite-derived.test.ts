import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCore } from "../agent-core.ts";
import type { ModelProvider, ModelStream } from "../model/provider.ts";
import { isRecord } from "../protocol/validate.ts";
import { ChatLog } from "./chat-log.ts";
import { sequentialIds } from "./derived.ts";
import { FakeEmbedder } from "./embedder.ts";
import { activeFacts } from "./policy.ts";
import { createMemoryRuntime } from "./runtime.ts";
import { SqliteMemoryStore } from "./sqlite-store.ts";
import {
  createMemoryTools,
  MEMORY_FORGET_TOOL,
  MEMORY_REMEMBER_TOOL,
  type MemoryToolState,
} from "./tools.ts";
import type { TurnRecord } from "./types.ts";
import { InMemoryVectorIndex } from "./vectors.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cookie-sqlite-derived-"));
  dirs.push(dir);
  return join(dir, "cookie.db");
}

function turn(id: string, sessionId: string, content: string): TurnRecord {
  return {
    id,
    sessionId,
    role: "user",
    content,
    tainted: false,
    model: null,
    egress: false,
    escalatedFrom: null,
    tokensIn: null,
    tokensCached: null,
    tokensOut: null,
    costUsd: null,
    latencyMs: null,
    createdAt: 10,
  };
}

const toolOptions = {
  toolCallId: "call-1",
  messages: [],
  context: undefined as never,
};

describe("sqlite derived memory", () => {
  it("persists a summary and lists sessions that still need reflect", () => {
    const path = tempDbPath();
    const store = SqliteMemoryStore.open(path, { now: () => 10 });
    store.appendSession({
      id: "ses-1",
      surface: "popup",
      startedAt: 1,
      endedAt: null,
      summary: null,
    });
    store.appendTurn(turn("t1", "ses-1", "ECE midterm is Friday"));
    expect(
      store.listSessions({ needsReflect: true }).map((row) => row.id),
    ).toEqual(["ses-1"]);
    store.setSummary("ses-1", "ECE midterm Friday");
    store.setMeta("consolidation.localDay", "2026-10-25");
    store.insertJournal({
      id: "j1",
      day: "2026-10-25",
      entry: "John mentioned the midterm.",
      sessionId: "ses-1",
      createdAt: 11,
    });
    store.close();

    const again = SqliteMemoryStore.open(path, { now: () => 20 });
    expect(again.summary("ses-1")).toBe("ECE midterm Friday");
    expect(again.session("ses-1")?.summary).toBe("ECE midterm Friday");
    expect(again.session("ses-1")?.endedAt).toBeNull();
    expect(again.listSessions({ needsReflect: true })).toEqual([]);
    expect(again.getMeta("consolidation.localDay")).toBe("2026-10-25");
    expect(again.listJournal("ses-1")).toHaveLength(1);
    again.clearDerived();
    expect(again.listFacts()).toEqual([]);
    expect(again.summary("ses-1")).toBeNull();
    expect(again.listJournal("ses-1")).toEqual([]);
    expect(again.getMeta("consolidation.localDay")).toBe("2026-10-25");
    expect(again.recentTurns("ses-1", 10).map((row) => row.id)).toEqual(["t1"]);
    again.close();
  });

  it("forgets the pinned profile row and the linked fact", async () => {
    const store = SqliteMemoryStore.open(tempDbPath(), { now: () => 10 });
    store.appendSession({
      id: "ses-1",
      surface: "popup",
      startedAt: 1,
      endedAt: null,
      summary: null,
    });
    store.appendTurn(turn("t1", "ses-1", "Remember my ECE midterm is Friday"));
    const state: MemoryToolState = { sourceTurnId: "t1" };
    const tools = createMemoryTools({
      derived: store,
      embedder: new FakeEmbedder(),
      vectors: new InMemoryVectorIndex(),
      state,
      now: () => 10,
      ids: sequentialIds("fact"),
    });
    const stored = await tools[MEMORY_REMEMBER_TOOL]?.execute?.(
      {
        text: "ECE midterm is Friday",
        kind: "event",
        aboutJohn: true,
        profileKey: "ece_midterm",
      },
      toolOptions,
    );
    expect(stored).toMatchObject({
      remembered: true,
      pinned: true,
      sourceTurn: "t1",
    });
    expect(store.listProfile()).toEqual([
      expect.objectContaining({
        key: "ece_midterm",
        pinned: true,
        sourceTurn: "t1",
      }),
    ]);
    const dropped = await tools[MEMORY_FORGET_TOOL]?.execute?.(
      { text: "midterm" },
      toolOptions,
    );
    expect(dropped).toMatchObject({ forgotten: true, factIds: ["fact-1"] });
    expect(store.listProfile()).toEqual([]);
    expect(activeFacts(store, 10)).toEqual([]);
    expect(store.factById("fact-1")?.supersededBy).toMatch(/^fact-/);
    expect(store.factById("fact-1")?.sourceTurn).toBe("t1");
    store.close();
  });

  it("does not end a session when the reflect idle elapses", async () => {
    const path = tempDbPath();
    let clock = 5_000;
    const now = (): number => clock;
    const timers = manualTimers(() => clock);
    const store = SqliteMemoryStore.open(path, { now });
    const seen: ModelMessage[][] = [];
    const provider = textProvider(seen);
    const runtime = createMemoryRuntime({
      provider,
      store,
      derived: store,
      now,
      idleMs: 1_000,
      timeZone: "UTC",
      timers,
      complete: async () =>
        JSON.stringify({
          journal: "John said hello.",
          summary: "Hello",
          facts: [],
          profile: [],
        }),
    });
    const messages: unknown[] = [];
    const core = new AgentCore({
      provider,
      now,
      history: new ChatLog(store),
      memoryHost: runtime.host,
      emit: (message) => {
        messages.push(message);
      },
      log: () => undefined,
      exit: () => undefined,
    });
    runtime.start();
    await runtime.scheduler.drained();
    core.handleLine(JSON.stringify(initialize()));
    await waitFor(() =>
      messages.some(
        (message) => isRecord(message) && message.method === "runtime.status",
      ),
    );
    core.handleLine(JSON.stringify(chat("2", "conv-a", "hello")));
    await waitFor(() => doneFor(messages, "msg-1"));
    expect(store.recentTurns("conv-a", 10)).toHaveLength(2);
    expect(store.session("conv-a")?.endedAt).toBeNull();
    clock += 1_000;
    timers.flush(clock);
    await runtime.scheduler.drained();
    expect(store.session("conv-a")?.endedAt).toBeNull();
    expect(store.summary("conv-a")).toBe("Hello");
    clock += 10 * 60 * 1000;
    timers.flush(clock);
    await runtime.scheduler.drained();
    expect(store.session("conv-a")?.endedAt).toBeNull();

    core.handleLine(JSON.stringify(chat("3", "conv-b", "new chat")));
    await waitFor(() => doneFor(messages, "msg-2"));
    expect(store.session("conv-a")?.endedAt).not.toBeNull();
    expect(store.session("conv-b")?.endedAt).toBeNull();
    runtime.scheduler.stop();
    store.close();
  });
});

function textProvider(seen: ModelMessage[][]): ModelProvider {
  return {
    modelId: "Qwen3.6-35B-A3B",
    probe: async () => "up",
    streamChat(args): ModelStream {
      seen.push(args.messages);
      return {
        textDeltas: (async function* () {
          yield "ok";
        })(),
        completion: Promise.resolve({
          finishReason: "stop",
          usage: { inputTokens: 3, outputTokens: 1 },
        }),
      };
    },
  };
}

function initialize(): unknown {
  return {
    jsonrpc: "2.0",
    id: "1",
    method: "initialize",
    params: {
      protocolVersion: "0.1",
      clientInfo: { name: "cookie-test", version: "0.0.0" },
      capabilities: {},
    },
  };
}

function chat(id: string, conversationId: string, text: string): unknown {
  return {
    jsonrpc: "2.0",
    id,
    method: "chat.send",
    params: { conversationId, text },
  };
}

function doneFor(messages: unknown[], messageId: string): boolean {
  return messages.some(
    (message) =>
      isRecord(message) &&
      message.method === "chat.done" &&
      isRecord(message.params) &&
      message.params.messageId === messageId,
  );
}

async function waitFor(ready: () => boolean): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 2000) {
    if (ready()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error("timed out");
}

function manualTimers(now: () => number): {
  set: (
    delayMs: number,
    fn: () => void,
  ) => {
    clear: () => void;
  };
  flush: (at: number) => void;
} {
  const items: Array<{ at: number; fn: () => void; cleared: boolean }> = [];
  return {
    set(delayMs: number, fn: () => void) {
      const item = { at: now() + delayMs, fn, cleared: false };
      items.push(item);
      return {
        clear() {
          item.cleared = true;
        },
      };
    },
    flush(at: number) {
      const due = items.filter((item) => !item.cleared && item.at <= at);
      for (const item of due) {
        item.cleared = true;
        item.fn();
      }
    },
  };
}
