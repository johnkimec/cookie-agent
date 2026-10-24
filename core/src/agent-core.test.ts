import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { AgentCore, RUNTIME_FRESH_MS } from "./agent-core.ts";
import { createAiSdkProvider } from "./model/ai-sdk-provider.ts";
import { createLlamaServerProvider } from "./model/llama.ts";
import type { ModelProvider } from "./model/provider.ts";
import { protocolErrors } from "./protocol/errors.ts";
import { DEFAULT_MODEL_ID, type RuntimeState } from "./protocol/types.ts";
import {
  isCookieMessage,
  isRecord,
  messageErrors,
} from "./protocol/validate.ts";
import { startLlamaStub } from "./verify-llama-stub.ts";

const INPUT_TOKENS = 11;
const OUTPUT_TOKENS = 4;

interface Harness {
  messages: unknown[];
  logs: string[];
  exitCode: number | null;
  core: AgentCore;
}

function textChunks(parts: string[], finish: "stop" | "length" = "stop") {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    ...parts.map((delta) => ({ type: "text-delta", id: "t1", delta })),
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: finish, raw: finish },
      usage: {
        inputTokens: {
          total: INPUT_TOKENS,
          noCache: INPUT_TOKENS,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: OUTPUT_TOKENS,
          text: OUTPUT_TOKENS,
          reasoning: 0,
        },
      },
    },
  ];
}

function scriptedProvider(options: {
  parts?: string[];
  finish?: "stop" | "length";
  delayMs?: number | null;
  probe?: () => Promise<RuntimeState>;
  onStream?: (signal: AbortSignal | undefined) => void;
  failStream?: boolean;
}): { provider: ModelProvider; model: MockLanguageModelV4 } {
  const model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      options.onStream?.(abortSignal);
      if (options.failStream === true) {
        let sent = false;
        return {
          stream: new ReadableStream({
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue({ type: "stream-start", warnings: [] });
                controller.enqueue({ type: "text-start", id: "t1" });
                controller.enqueue({
                  type: "text-delta",
                  id: "t1",
                  delta: "partial ",
                });
                controller.enqueue({ type: "text-end", id: "t1" });
                return;
              }
              controller.error(new Error("boom"));
            },
          }),
        } as never;
      }
      return {
        stream: simulateReadableStream({
          chunks: textChunks(
            options.parts ?? ["Hello ", "there."],
            options.finish,
          ),
          chunkDelayInMs: options.delayMs ?? null,
        }),
      } as never;
    },
  });
  const provider = createAiSdkProvider({
    modelId: DEFAULT_MODEL_ID,
    model,
    probe: options.probe ?? (async () => "up"),
  });
  return { provider, model };
}

function harnessFor(
  provider: ModelProvider,
  options: { probeTimeoutMs?: number; now?: () => number } = {},
): Harness {
  const harness: Harness = {
    messages: [],
    logs: [],
    exitCode: null,
    core: undefined as unknown as AgentCore,
  };
  harness.core = new AgentCore({
    provider,
    probeTimeoutMs: options.probeTimeoutMs ?? 200,
    now: options.now,
    emit: (message) => {
      expect(isCookieMessage(message), messageErrors(message)).toBe(true);
      harness.messages.push(message);
    },
    log: (line) => {
      harness.logs.push(line);
    },
    exit: (code) => {
      harness.exitCode = code;
    },
  });
  return harness;
}

function send(harness: Harness, message: unknown): void {
  harness.core.handleLine(JSON.stringify(message));
}

async function waitFor(
  harness: Harness,
  ready: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (ready()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error(`timed out: ${JSON.stringify(harness.messages)}`);
}

function initialize(): unknown {
  return {
    jsonrpc: "2.0",
    id: "1",
    method: "initialize",
    params: {
      protocolVersion: "0.1",
      clientInfo: { name: "cookie-test", version: "0.0.0" },
      capabilities: { chatCancel: true },
    },
  };
}

function chatSend(
  id: string,
  text: string,
  conversationId = "conv-1",
): unknown {
  return {
    jsonrpc: "2.0",
    id,
    method: "chat.send",
    params: { conversationId, text },
  };
}

async function ready(harness: Harness): Promise<void> {
  send(harness, initialize());
  await waitFor(harness, () =>
    harness.messages.some(
      (message) =>
        isRecord(message) &&
        message.method === "runtime.status" &&
        isRecord(message.params),
    ),
  );
}

function deltasOf(messages: unknown[]): string[] {
  return messages
    .filter((message) => isRecord(message) && message.method === "chat.delta")
    .map((message) => {
      const params = (message as { params: { text: string } }).params;
      return params.text;
    });
}

describe("agent core", () => {
  it("streams a reply and validates every emitted message", async () => {
    const { provider, model } = scriptedProvider({
      parts: ["Hello ", "from Cookie."],
    });
    const harness = harnessFor(provider);
    await ready(harness);
    expect(harness.messages[0]).toMatchObject({
      id: "1",
      result: {
        protocolVersion: "0.1",
        serverInfo: { name: "cookie-core", version: "0.0.0" },
        capabilities: {
          chat: { stream: true, cancel: true },
          runtime: { status: true },
        },
      },
    });
    expect(harness.messages[1]).toMatchObject({
      method: "runtime.status",
      params: { state: "up", modelId: DEFAULT_MODEL_ID },
    });

    send(harness, chatSend("2", "hi there"));
    await waitFor(harness, () =>
      harness.messages.some(
        (message) => isRecord(message) && message.method === "chat.done",
      ),
    );

    const ack = harness.messages.find(
      (message) => isRecord(message) && message.id === "2",
    );
    expect(ack).toMatchObject({
      result: { conversationId: "conv-1", messageId: "msg-1" },
    });
    expect(deltasOf(harness.messages)).toEqual(["Hello ", "from Cookie."]);
    const done = harness.messages.find(
      (message) => isRecord(message) && message.method === "chat.done",
    );
    expect(done).toMatchObject({
      method: "chat.done",
      params: {
        conversationId: "conv-1",
        messageId: "msg-1",
        finishReason: "stop",
        usage: { inputTokens: INPUT_TOKENS, outputTokens: OUTPUT_TOKENS },
      },
    });
    expect(harness.messages.every((message) => isCookieMessage(message))).toBe(
      true,
    );
    expect(model.doStreamCalls.length).toBe(1);

    send(harness, chatSend("3", "and before?"));
    await waitFor(
      harness,
      () =>
        harness.messages.filter(
          (message) => isRecord(message) && message.method === "chat.done",
        ).length === 2,
    );
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(secondPrompt).toContain("hi there");
    expect(secondPrompt).toContain("Hello from Cookie.");
    expect(secondPrompt).toContain("and before?");
  });

  it("cancels an in-flight reply by aborting the model", async () => {
    let signal: AbortSignal | undefined;
    const { provider } = scriptedProvider({
      parts: ["one ", "two ", "three ", "four "],
      delayMs: 40,
      onStream: (abortSignal) => {
        signal = abortSignal;
      },
    });
    const harness = harnessFor(provider);
    await ready(harness);
    send(harness, chatSend("2", "keep going"));
    await waitFor(harness, () => deltasOf(harness.messages).length >= 1);
    const beforeCancel = deltasOf(harness.messages).length;
    send(harness, {
      jsonrpc: "2.0",
      id: "3",
      method: "chat.cancel",
      params: { conversationId: "conv-1", messageId: "msg-1" },
    });
    await waitFor(harness, () =>
      harness.messages.some(
        (message) => isRecord(message) && message.id === "3",
      ),
    );
    const doneIndex = harness.messages.findIndex(
      (message) =>
        isRecord(message) &&
        message.method === "chat.done" &&
        isRecord(message.params) &&
        message.params.finishReason === "cancelled",
    );
    const resultIndex = harness.messages.findIndex(
      (message) => isRecord(message) && message.id === "3",
    );
    expect(doneIndex).toBeGreaterThan(-1);
    expect(resultIndex).toBeGreaterThan(doneIndex);
    expect(harness.messages[resultIndex]).toMatchObject({
      result: { cancelled: true },
    });
    const after = harness.messages.slice(doneIndex + 1);
    expect(
      after.some(
        (message) => isRecord(message) && message.method === "chat.delta",
      ),
    ).toBe(false);
    expect(deltasOf(harness.messages).length).toBe(beforeCancel);
    expect(signal?.aborted).toBe(true);
    expect(harness.messages.every((message) => isCookieMessage(message))).toBe(
      true,
    );

    send(harness, {
      jsonrpc: "2.0",
      id: "4",
      method: "chat.cancel",
      params: { conversationId: "conv-1", messageId: "msg-1" },
    });
    await waitFor(harness, () =>
      harness.messages.some(
        (message) => isRecord(message) && message.id === "4",
      ),
    );
    expect(
      harness.messages.find(
        (message) => isRecord(message) && message.id === "4",
      ),
    ).toMatchObject({ result: { cancelled: false } });
  });

  it("reports runtime down and refuses chat.send when the runtime is unreachable", async () => {
    const { provider } = scriptedProvider({
      probe: async () => "down",
    });
    const harness = harnessFor(provider);
    const started = Date.now();
    await ready(harness);
    expect(harness.messages[1]).toMatchObject({
      method: "runtime.status",
      params: { state: "down", modelId: null },
    });
    send(harness, chatSend("2", "anyone there"));
    await waitFor(harness, () =>
      harness.messages.some(
        (message) => isRecord(message) && message.id === "2",
      ),
    );
    expect(Date.now() - started).toBeLessThan(500);
    const error = harness.messages.find(
      (message) => isRecord(message) && message.id === "2",
    );
    expect(error).toMatchObject({
      error: {
        code: protocolErrors.runtimeUnavailable.code,
        message: protocolErrors.runtimeUnavailable.message,
      },
    });
    expect(deltasOf(harness.messages)).toEqual([]);
    expect(
      harness.messages.some(
        (message) => isRecord(message) && message.method === "chat.done",
      ),
    ).toBe(false);
    expect(harness.messages.every((message) => isCookieMessage(message))).toBe(
      true,
    );
  });

  it("maps a length finish and a mid-stream failure", async () => {
    const length = scriptedProvider({
      parts: ["cut "],
      finish: "length",
    });
    const lengthHarness = harnessFor(length.provider);
    await ready(lengthHarness);
    send(lengthHarness, chatSend("2", "go"));
    await waitFor(lengthHarness, () =>
      lengthHarness.messages.some(
        (message) => isRecord(message) && message.method === "chat.done",
      ),
    );
    expect(
      lengthHarness.messages.find(
        (message) => isRecord(message) && message.method === "chat.done",
      ),
    ).toMatchObject({
      params: { finishReason: "length" },
    });

    const failing = scriptedProvider({ failStream: true });
    const harness = harnessFor(failing.provider);
    await ready(harness);
    send(harness, chatSend("2", "go"));
    await waitFor(harness, () =>
      harness.messages.some(
        (message) => isRecord(message) && message.method === "chat.done",
      ),
    );
    expect(deltasOf(harness.messages)).toEqual(["partial "]);
    expect(
      harness.messages.find(
        (message) => isRecord(message) && message.method === "chat.done",
      ),
    ).toMatchObject({
      params: {
        finishReason: "error",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
    expect(harness.exitCode).toBeNull();
    expect(harness.messages.every((message) => isCookieMessage(message))).toBe(
      true,
    );
  });

  it("finishes an empty completion with stop and no deltas", async () => {
    const { provider } = scriptedProvider({ parts: [] });
    const harness = harnessFor(provider);
    await ready(harness);
    send(harness, chatSend("2", "say nothing"));
    await waitFor(harness, () =>
      harness.messages.some(
        (message) => isRecord(message) && message.method === "chat.done",
      ),
    );
    expect(deltasOf(harness.messages)).toEqual([]);
    expect(
      harness.messages.find(
        (message) => isRecord(message) && message.method === "chat.done",
      ),
    ).toMatchObject({
      params: {
        finishReason: "stop",
        usage: { inputTokens: INPUT_TOKENS, outputTokens: OUTPUT_TOKENS },
      },
    });
    expect(harness.messages.every((message) => isCookieMessage(message))).toBe(
      true,
    );
  });

  it("skips the pre-ack probe while up is fresh, including after a shell push", async () => {
    let probes = 0;
    let clock = 1_000;
    const { provider } = scriptedProvider({
      parts: ["ok"],
      probe: async () => {
        probes += 1;
        return "up";
      },
    });
    const harness = harnessFor(provider, { now: () => clock });
    await ready(harness);
    expect(probes).toBe(1);

    send(harness, chatSend("2", "fresh"));
    await waitFor(harness, () =>
      harness.messages.some(
        (message) => isRecord(message) && message.method === "chat.done",
      ),
    );
    expect(probes).toBe(1);

    clock += RUNTIME_FRESH_MS;
    send(harness, {
      jsonrpc: "2.0",
      method: "runtime.status",
      params: { state: "up", modelId: DEFAULT_MODEL_ID },
    });
    send(harness, chatSend("3", "pushed"));
    await waitFor(
      harness,
      () =>
        harness.messages.filter(
          (message) => isRecord(message) && message.method === "chat.done",
        ).length === 2,
    );
    expect(probes).toBe(1);
  });

  it("probes again when up is older than 5 seconds", async () => {
    let probes = 0;
    let clock = 1_000;
    const { provider } = scriptedProvider({
      parts: ["ok"],
      probe: async () => {
        probes += 1;
        return probes === 1 ? "up" : "down";
      },
    });
    const harness = harnessFor(provider, { now: () => clock });
    await ready(harness);
    expect(probes).toBe(1);

    clock += RUNTIME_FRESH_MS;
    send(harness, chatSend("2", "stale"));
    await waitFor(harness, () =>
      harness.messages.some(
        (message) => isRecord(message) && message.id === "2",
      ),
    );
    expect(probes).toBe(2);
    expect(
      harness.messages.find(
        (message) => isRecord(message) && message.id === "2",
      ),
    ).toMatchObject({
      error: {
        code: protocolErrors.runtimeUnavailable.code,
        message: protocolErrors.runtimeUnavailable.message,
      },
    });
    expect(
      harness.messages.filter(
        (message) =>
          isRecord(message) &&
          message.method === "runtime.status" &&
          isRecord(message.params) &&
          message.params.state === "down",
      ).length,
    ).toBe(1);
    expect(
      harness.messages.some(
        (message) => isRecord(message) && message.method === "chat.done",
      ),
    ).toBe(false);
  });

  it("marks the runtime down when a fresh send's connection fails", async () => {
    const stub = await startLlamaStub(0);
    const provider = createLlamaServerProvider({ port: stub.port });
    const harness = harnessFor(provider);
    await ready(harness);
    await stub.close();
    send(harness, chatSend("2", "hello"));
    await waitFor(harness, () =>
      harness.messages.some(
        (message) => isRecord(message) && message.method === "chat.done",
      ),
    );
    const status = harness.messages.find(
      (message) =>
        isRecord(message) &&
        message.method === "runtime.status" &&
        isRecord(message.params) &&
        message.params.state === "down",
    );
    const done = harness.messages.find(
      (message) => isRecord(message) && message.method === "chat.done",
    );
    expect(status).toMatchObject({
      params: { state: "down", modelId: null },
    });
    expect(done).toMatchObject({
      params: {
        finishReason: "error",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
    expect(harness.messages.indexOf(status)).toBeLessThan(
      harness.messages.indexOf(done),
    );
    expect(deltasOf(harness.messages)).toEqual([]);
    expect(harness.exitCode).toBeNull();
  });

  it("lets the shell push loading and down, then chat again when up", async () => {
    const { provider } = scriptedProvider({ parts: ["ok"] });
    const harness = harnessFor(provider);
    await ready(harness);
    send(harness, {
      jsonrpc: "2.0",
      method: "runtime.status",
      params: { state: "loading", modelId: DEFAULT_MODEL_ID },
    });
    send(harness, {
      jsonrpc: "2.0",
      id: "2",
      method: "runtime.status",
      params: {},
    });
    send(harness, chatSend("3", "while loading"));
    await waitFor(harness, () =>
      harness.messages.some(
        (message) => isRecord(message) && message.id === "3",
      ),
    );
    expect(
      harness.messages.find(
        (message) => isRecord(message) && message.id === "2",
      ),
    ).toMatchObject({
      result: { state: "loading", modelId: DEFAULT_MODEL_ID },
    });
    expect(
      harness.messages.find(
        (message) => isRecord(message) && message.id === "3",
      ),
    ).toMatchObject({
      error: { code: protocolErrors.runtimeUnavailable.code },
    });

    send(harness, {
      jsonrpc: "2.0",
      method: "runtime.status",
      params: { state: "down", modelId: null },
    });
    send(harness, chatSend("4", "while down"));
    await waitFor(harness, () =>
      harness.messages.some(
        (message) => isRecord(message) && message.id === "4",
      ),
    );
    expect(
      harness.messages.find(
        (message) => isRecord(message) && message.id === "4",
      ),
    ).toMatchObject({
      error: { code: protocolErrors.runtimeUnavailable.code },
    });

    send(harness, {
      jsonrpc: "2.0",
      method: "runtime.status",
      params: { state: "up", modelId: DEFAULT_MODEL_ID },
    });
    send(harness, chatSend("5", "recovered"));
    await waitFor(harness, () =>
      harness.messages.some(
        (message) => isRecord(message) && message.method === "chat.done",
      ),
    );
    expect(
      harness.messages.find(
        (message) => isRecord(message) && message.method === "chat.done",
      ),
    ).toMatchObject({ params: { finishReason: "stop" } });
  });

  it("refuses a second send while a reply is in flight and shutdown aborts it", async () => {
    let signal: AbortSignal | undefined;
    const { provider } = scriptedProvider({
      parts: ["one ", "two ", "three "],
      delayMs: 50,
      onStream: (abortSignal) => {
        signal = abortSignal;
      },
    });
    const harness = harnessFor(provider);
    await ready(harness);
    send(harness, chatSend("2", "first"));
    await waitFor(harness, () => deltasOf(harness.messages).length >= 1);
    send(harness, chatSend("3", "second"));
    await waitFor(harness, () =>
      harness.messages.some(
        (message) => isRecord(message) && message.id === "3",
      ),
    );
    expect(
      harness.messages.find(
        (message) => isRecord(message) && message.id === "3",
      ),
    ).toMatchObject({
      error: {
        code: protocolErrors.chatInProgress.code,
        message: protocolErrors.chatInProgress.message,
      },
    });
    send(harness, {
      jsonrpc: "2.0",
      id: "4",
      method: "shutdown",
      params: { reason: "test" },
    });
    await waitFor(harness, () => harness.exitCode !== null);
    const doneIndex = harness.messages.findIndex(
      (message) =>
        isRecord(message) &&
        message.method === "chat.done" &&
        isRecord(message.params) &&
        message.params.finishReason === "cancelled",
    );
    const shutdownIndex = harness.messages.findIndex(
      (message) => isRecord(message) && message.id === "4",
    );
    expect(doneIndex).toBeGreaterThan(-1);
    expect(shutdownIndex).toBeGreaterThan(doneIndex);
    expect(harness.messages[shutdownIndex]).toMatchObject({
      result: { ok: true },
    });
    expect(harness.exitCode).toBe(0);
    expect(signal?.aborted).toBe(true);
    expect(harness.messages.every((message) => isCookieMessage(message))).toBe(
      true,
    );
  });

  it("rejects protocol mistakes with schema-valid errors", async () => {
    const { provider } = scriptedProvider({});
    const harness = harnessFor(provider);
    send(harness, chatSend("9", "too soon"));
    harness.core.handleLine("not json");
    send(harness, {
      jsonrpc: "2.0",
      id: "8",
      method: "nope",
      params: {},
    });
    await ready(harness);
    send(harness, {
      jsonrpc: "2.0",
      id: "7",
      method: "chat.send",
      params: { conversationId: "conv-1" },
    });
    await waitFor(harness, () =>
      harness.messages.some(
        (message) => isRecord(message) && message.id === "7",
      ),
    );
    const byId = (id: string): unknown =>
      harness.messages.find(
        (message) => isRecord(message) && message.id === id,
      );
    expect(byId("9")).toMatchObject({
      error: { code: protocolErrors.notInitialized.code },
    });
    expect(
      harness.messages.find(
        (message) =>
          isRecord(message) &&
          isRecord(message.error) &&
          message.error.code === protocolErrors.parseError.code,
      ),
    ).toMatchObject({ id: null });
    expect(byId("7")).toMatchObject({
      error: { code: protocolErrors.invalidParams.code },
    });
    expect(harness.messages.every((message) => isCookieMessage(message))).toBe(
      true,
    );
  });
});
