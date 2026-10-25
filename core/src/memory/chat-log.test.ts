import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCore } from "../agent-core.ts";
import type { ModelProvider, ModelStream } from "../model/provider.ts";
import {
  isCookieMessage,
  isRecord,
  messageErrors,
} from "../protocol/validate.ts";
import { ChatLog } from "./chat-log.ts";
import { SqliteMemoryStore } from "./sqlite-store.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cookie-chat-log-"));
  dirs.push(dir);
  return join(dir, "cookie.db");
}

function provider(seen: ModelMessage[][]): ModelProvider {
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

function coreFor(
  history: ChatLog,
  seen: ModelMessage[][],
  now: () => number,
): { core: AgentCore; messages: unknown[] } {
  const messages: unknown[] = [];
  const core = new AgentCore({
    provider: provider(seen),
    now,
    history,
    emit: (message) => {
      expect(isCookieMessage(message), messageErrors(message)).toBe(true);
      messages.push(message);
    },
    log: () => undefined,
    exit: () => undefined,
  });
  return { core, messages };
}

function send(core: AgentCore, message: unknown): void {
  core.handleLine(JSON.stringify(message));
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

async function ready(core: AgentCore, messages: unknown[]): Promise<void> {
  send(core, initialize());
  await waitFor(() =>
    messages.some(
      (message) =>
        isRecord(message) &&
        message.method === "runtime.status" &&
        isRecord(message.params) &&
        message.params.state === "up",
    ),
  );
}

async function untilDone(messages: unknown[], id: string): Promise<void> {
  await waitFor(() =>
    messages.some(
      (message) =>
        isRecord(message) &&
        message.method === "chat.done" &&
        isRecord(message.params) &&
        message.params.messageId === id,
    ),
  );
}

describe("chat log wired into the core", () => {
  it("sends the previous turn on the next chat and keeps it after reopen", async () => {
    const path = tempDbPath();
    const seen: ModelMessage[][] = [];
    let clock = 5_000;
    const firstStore = SqliteMemoryStore.open(path, { now: () => clock });
    const first = coreFor(new ChatLog(firstStore), seen, () => clock);
    await ready(first.core, first.messages);
    send(first.core, chat("2", "conv-1", "alpha code"));
    await untilDone(first.messages, "msg-1");
    send(first.core, chat("3", "conv-1", "what did I say"));
    await untilDone(first.messages, "msg-2");

    const secondPrompt = seen[1] ?? [];
    expect(secondPrompt.map((message) => message.content)).toEqual([
      "alpha code",
      "ok",
      "what did I say",
    ]);
    expect(
      firstStore.recentTurns("conv-1", 10).every((row) => !row.egress),
    ).toBe(true);

    send(first.core, {
      jsonrpc: "2.0",
      id: "4",
      method: "shutdown",
      params: {},
    });
    await waitFor(() =>
      first.messages.some((message) => isRecord(message) && message.id === "4"),
    );

    const seenAgain: ModelMessage[][] = [];
    clock = 6_000;
    const secondStore = SqliteMemoryStore.open(path, { now: () => clock });
    const second = coreFor(new ChatLog(secondStore), seenAgain, () => clock);
    await ready(second.core, second.messages);
    send(second.core, chat("2", "conv-1", "again"));
    await untilDone(second.messages, "msg-1");
    expect(seenAgain[0]?.map((message) => message.content)).toEqual([
      "alpha code",
      "ok",
      "what did I say",
      "ok",
      "again",
    ]);
    secondStore.close();
  });

  it("ends the session on a new conversation id", async () => {
    const path = tempDbPath();
    const seen: ModelMessage[][] = [];
    const store = SqliteMemoryStore.open(path, { now: () => 1_000 });
    const harness = coreFor(new ChatLog(store), seen, () => 1_000);
    await ready(harness.core, harness.messages);
    send(harness.core, chat("2", "conv-a", "keep this"));
    await untilDone(harness.messages, "msg-1");
    send(harness.core, chat("3", "conv-b", "new chat"));
    await untilDone(harness.messages, "msg-2");

    expect(store.session("conv-a")?.endedAt).toBe(1_000);
    expect(store.session("conv-b")?.endedAt).toBeNull();
    expect(seen[1]?.map((message) => message.content)).toEqual(["new chat"]);
    expect(store.recentTurns("conv-a", 10).map((row) => row.content)).toContain(
      "keep this",
    );
    store.close();
  });
});
