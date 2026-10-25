/**
 * Stdio stand-in for the Cookie agent core.
 *
 * Speaks protocol 0.1 with a canned streamed reply and no model. Task B
 * builds the Swift shell against this process. Task A replaces it.
 * Run: pnpm --filter @cookie-agent/core fake-core
 *
 * The process opens no sockets. It does not dial llama-server.
 */

import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { REQUEST_ID_PATTERN, rpcError } from "./protocol/errors.ts";
import {
  countWords,
  FAKE_MODEL_ID,
  FAKE_REPLY_CHUNKS,
  FAKE_SERVER_NAME,
  FAKE_SERVER_VERSION,
} from "./protocol/text.ts";
import {
  type ChatCancelParams,
  type ChatSendParams,
  type InitializeParams,
  PROTOCOL_VERSION,
  type RuntimeState,
  type RuntimeStatus,
} from "./protocol/types.ts";
import {
  isCookieMessage,
  isRecord,
  paramsAreValid,
  paramsErrors,
} from "./protocol/validate.ts";

const MAX_LINE_BYTES = 1_048_576;

interface Inflight {
  conversationId: string;
  messageId: string;
  inputTokens: number;
  outputTokens: number;
}

class FakeCore {
  readonly deltaMs: number;
  private phase: "new" | "ready" | "stopping" = "new";
  private runtime: RuntimeStatus = { state: "up", modelId: FAKE_MODEL_ID };
  private inflight: Inflight | null = null;
  private nextMessage = 1;
  private wake: (() => void) | null = null;
  private exiting = false;

  constructor(deltaMs: number) {
    this.deltaMs = deltaMs;
  }

  handleLine(line: string): void {
    if (line.trim() === "") {
      return;
    }
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      this.emit(rpcError(null, "invalidRequest", { reason: "line too long" }));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.emit(rpcError(null, "parseError"));
      return;
    }
    try {
      this.handleValue(parsed);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown";
      process.stderr.write(`fake-core: ${detail}\n`);
      this.emit(rpcError(null, "internalError"));
    }
  }

  onStdinClose(): void {
    setImmediate(() => {
      this.flushAndExit(0);
    });
  }

  private handleValue(value: unknown): void {
    if (!isRecord(value) || value.jsonrpc !== "2.0") {
      this.emit(rpcError(this.errorId(value), "invalidRequest"));
      return;
    }
    if (typeof value.method !== "string") {
      this.emit(rpcError(this.errorId(value), "invalidRequest"));
      return;
    }
    if (Object.hasOwn(value, "id")) {
      if (typeof value.id !== "string" || !REQUEST_ID_PATTERN.test(value.id)) {
        this.emit(
          rpcError(null, "invalidRequest", { reason: "id must be a string" }),
        );
        return;
      }
      this.handleRequest(value.id, value.method, value.params);
      return;
    }
    this.handleNotification(value.method, value.params);
  }

  private handleRequest(id: string, method: string, params: unknown): void {
    if (this.phase === "stopping") {
      this.emit(rpcError(id, "shuttingDown", { method }));
      return;
    }
    if (
      this.phase === "new" &&
      method !== "initialize" &&
      method !== "shutdown"
    ) {
      this.emit(rpcError(id, "notInitialized", { method }));
      return;
    }
    switch (method) {
      case "initialize":
        this.onInitialize(id, params);
        return;
      case "shutdown":
        this.onShutdown(id, params);
        return;
      case "chat.send":
        this.onChatSend(id, params);
        return;
      case "chat.cancel":
        this.onChatCancel(id, params);
        return;
      case "runtime.status":
        this.onRuntimeQuery(id, params);
        return;
      default:
        this.emit(rpcError(id, "methodNotFound", { method }));
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (this.phase !== "ready") {
      process.stderr.write(`fake-core: ignored ${method} before initialize\n`);
      return;
    }
    if (method !== "runtime.status") {
      process.stderr.write(`fake-core: ignored notification ${method}\n`);
      return;
    }
    if (!paramsAreValid("runtimeStatusParams", params)) {
      process.stderr.write(
        `fake-core: ignored runtime.status ${paramsErrors("runtimeStatusParams", params)}\n`,
      );
      return;
    }
    const status = params as RuntimeStatus;
    this.runtime = { state: status.state, modelId: status.modelId ?? null };
  }

  private onInitialize(id: string, params: unknown): void {
    if (this.phase !== "new") {
      this.emit(
        rpcError(id, "invalidRequest", { reason: "already initialized" }),
      );
      return;
    }
    if (!paramsAreValid("initializeParams", params)) {
      this.rejectParams(id, "initializeParams", params);
      return;
    }
    const body = params as InitializeParams;
    if (body.protocolVersion !== PROTOCOL_VERSION) {
      this.emit(
        rpcError(id, "protocolMismatch", {
          reason: "unsupported protocolVersion",
        }),
      );
      return;
    }
    this.phase = "ready";
    this.emit({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: FAKE_SERVER_NAME, version: FAKE_SERVER_VERSION },
        capabilities: {
          chat: { stream: true, cancel: true },
          runtime: { status: true },
        },
      },
    });
    this.emit({
      jsonrpc: "2.0",
      method: "runtime.status",
      params: this.runtimePayload(),
    });
  }

  private onShutdown(id: string, params: unknown): void {
    if (!paramsAreValid("shutdownParams", params)) {
      this.rejectParams(id, "shutdownParams", params);
      return;
    }
    this.phase = "stopping";
    this.abortInflight();
    this.emit({ jsonrpc: "2.0", id, result: { ok: true } });
    this.flushAndExit(0);
  }

  private onChatSend(id: string, params: unknown): void {
    if (!paramsAreValid("chatSendParams", params)) {
      this.rejectParams(id, "chatSendParams", params);
      return;
    }
    const body = params as ChatSendParams;
    if (this.runtime.state !== "up") {
      this.emit(
        rpcError(id, "runtimeUnavailable", {
          reason: `runtime is ${this.runtime.state}`,
        }),
      );
      return;
    }
    if (this.inflight !== null) {
      this.emit(rpcError(id, "chatInProgress", { method: "chat.send" }));
      return;
    }
    const messageId = `msg-${this.nextMessage}`;
    this.nextMessage += 1;
    const flight: Inflight = {
      conversationId: body.conversationId,
      messageId,
      inputTokens: countWords(body.text),
      outputTokens: 0,
    };
    this.inflight = flight;
    this.emit({
      jsonrpc: "2.0",
      id,
      result: { conversationId: body.conversationId, messageId },
    });
    void this.runStream(flight).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : "stream failed";
      process.stderr.write(`fake-core: ${detail}\n`);
      this.finish(1);
    });
  }

  private onChatCancel(id: string, params: unknown): void {
    if (!paramsAreValid("chatCancelParams", params)) {
      this.rejectParams(id, "chatCancelParams", params);
      return;
    }
    const body = params as ChatCancelParams;
    const cancelled = this.cancelInflight(body.conversationId, body.messageId);
    this.emit({ jsonrpc: "2.0", id, result: { cancelled } });
  }

  private onRuntimeQuery(id: string, params: unknown): void {
    if (!paramsAreValid("emptyParams", params)) {
      this.rejectParams(id, "emptyParams", params);
      return;
    }
    this.emit({ jsonrpc: "2.0", id, result: this.runtimePayload() });
  }

  private async runStream(flight: Inflight): Promise<void> {
    for (let index = 0; index < FAKE_REPLY_CHUNKS.length; index += 1) {
      if (this.inflight !== flight) {
        return;
      }
      const text = FAKE_REPLY_CHUNKS[index];
      if (text === undefined) {
        return;
      }
      flight.outputTokens += countWords(text);
      this.emit({
        jsonrpc: "2.0",
        method: "chat.delta",
        params: {
          conversationId: flight.conversationId,
          messageId: flight.messageId,
          index,
          text,
        },
      });
      if (index < FAKE_REPLY_CHUNKS.length - 1) {
        await this.pause();
      }
    }
    if (this.inflight !== flight) {
      return;
    }
    this.emit(this.doneMessage(flight, "stop"));
    if (this.inflight === flight) {
      this.inflight = null;
    }
  }

  private cancelInflight(conversationId: string, messageId: string): boolean {
    const flight = this.inflight;
    if (
      flight === null ||
      flight.conversationId !== conversationId ||
      flight.messageId !== messageId
    ) {
      return false;
    }
    this.inflight = null;
    this.emit(this.doneMessage(flight, "cancelled"));
    this.wake?.();
    return true;
  }

  private abortInflight(): void {
    const flight = this.inflight;
    if (flight === null) {
      return;
    }
    this.inflight = null;
    this.emit(this.doneMessage(flight, "cancelled"));
    this.wake?.();
  }

  private doneMessage(
    flight: Inflight,
    finishReason: "stop" | "cancelled",
  ): {
    jsonrpc: "2.0";
    method: "chat.done";
    params: {
      conversationId: string;
      messageId: string;
      finishReason: "stop" | "cancelled";
      usage: { inputTokens: number; outputTokens: number };
    };
  } {
    return {
      jsonrpc: "2.0",
      method: "chat.done",
      params: {
        conversationId: flight.conversationId,
        messageId: flight.messageId,
        finishReason,
        usage: {
          inputTokens: flight.inputTokens,
          outputTokens: flight.outputTokens,
        },
      },
    };
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, this.deltaMs);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  private runtimePayload(): { state: RuntimeState; modelId: string | null } {
    return {
      state: this.runtime.state,
      modelId: this.runtime.modelId ?? null,
    };
  }

  private rejectParams(
    id: string,
    def:
      | "initializeParams"
      | "shutdownParams"
      | "chatSendParams"
      | "chatCancelParams"
      | "emptyParams",
    params: unknown,
  ): void {
    process.stderr.write(`fake-core: ${def} ${paramsErrors(def, params)}\n`);
    this.emit(
      rpcError(id, "invalidParams", { reason: "params failed schema" }),
    );
  }

  private emit(message: unknown): void {
    if (!isCookieMessage(message)) {
      process.stderr.write(
        `fake-core: refused invalid outbound message ${JSON.stringify(message)}\n`,
      );
      this.finish(1);
      return;
    }
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  private flushAndExit(code: number): void {
    process.stdout.write("", () => {
      this.finish(code);
    });
  }

  private finish(code: number): void {
    if (this.exiting) {
      return;
    }
    this.exiting = true;
    process.exit(code);
  }

  private errorId(value: unknown): string | null {
    if (!isRecord(value)) {
      return null;
    }
    return typeof value.id === "string" ? value.id : null;
  }
}

function readDeltaMs(): number {
  const raw = process.env.COOKIE_FAKE_DELTA_MS;
  if (raw === undefined || raw === "") {
    return 0;
  }
  if (!/^\d+$/.test(raw)) {
    process.stderr.write(
      "fake-core: COOKIE_FAKE_DELTA_MS must be an integer 0..10000\n",
    );
    process.exit(1);
  }
  const parsed = Number(raw);
  if (parsed > 10_000) {
    process.stderr.write(
      "fake-core: COOKIE_FAKE_DELTA_MS must be an integer 0..10000\n",
    );
    process.exit(1);
  }
  return parsed;
}

function warnIfProductPort(): void {
  if (process.env.COOKIE_LLAMA_PORT === "8080") {
    process.stderr.write(
      "fake-core: COOKIE_LLAMA_PORT=8080 is John's llama-server port; this process does not connect\n",
    );
  }
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || entry === "") {
    return false;
  }
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

function main(): void {
  warnIfProductPort();
  const core = new FakeCore(readDeltaMs());
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  process.stdout.on("error", () => {
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    process.exit(0);
  });
  lines.on("line", (line) => {
    core.handleLine(line);
  });
  lines.on("close", () => {
    core.onStdinClose();
  });
}

if (isDirectRun()) {
  main();
}
