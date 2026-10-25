/**
 * Protocol 0.1 core. One in-flight chat, in-memory history, local model.
 *
 * The fake core in fake-core.ts stays. Task B's shell speaks to that
 * process. This process is the one that dials llama-server.
 */

import {
  CORE_SERVER_NAME,
  CORE_SERVER_VERSION,
  SYSTEM_PROMPT,
} from "./identity.ts";
import { type ConversationHistory, ConversationMemory } from "./memory.ts";
import { isAbortError } from "./model/ai-sdk-provider.ts";
import type {
  ModelCompletion,
  ModelProvider,
  ModelStream,
  ModelUsage,
} from "./model/provider.ts";
import { REQUEST_ID_PATTERN, rpcError } from "./protocol/errors.ts";
import {
  type ChatCancelParams,
  type ChatSendParams,
  type FinishReason,
  type InitializeParams,
  PROTOCOL_VERSION,
  type RuntimeState,
  type RuntimeStatus,
  type SessionWindowParams,
} from "./protocol/types.ts";
import {
  isCookieMessage,
  isRecord,
  messageErrors,
  paramsAreValid,
  paramsErrors,
} from "./protocol/validate.ts";

const MAX_LINE_BYTES = 1_048_576;
const ZERO_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * A status of `up` set more recently than this (a shell push or this
 * core's own probe) is fresh enough to ack `chat.send` without probing.
 * A shell push is also left alone by the runtime watch for this long.
 */
export const RUNTIME_FRESH_MS = 5_000;

/** How often the stdio core re-probes llama-server while it is ready. */
export const RUNTIME_WATCH_MS = 500;

interface Flight {
  conversationId: string;
  messageId: string;
  userText: string;
  sent: string[];
  startedAt: number;
  cancelled: boolean;
  abort: AbortController;
}

export interface AgentCoreOptions {
  provider: ModelProvider;
  /** Milliseconds a runtime probe may take before the core calls it down. */
  probeTimeoutMs?: number;
  /** Clock for the fresh-status window. Tests pass a fake. */
  now?: () => number;
  /**
   * Re-probe while ready and announce `runtime.status` when it changes.
   * Unset or `0` leaves the watch off. The stdio entry uses
   * {@link RUNTIME_WATCH_MS}.
   */
  watchIntervalMs?: number;
  emit?: (message: unknown) => void;
  log?: (line: string) => void;
  exit?: (code: number) => void;
  /**
   * Turn history. The stdio entry passes a SQLite `ChatLog`.
   * Tests that omit it keep an in-memory stand-in.
   */
  history?: ConversationHistory;
  serverName?: string;
  serverVersion?: string;
}

type ParamSchema =
  | "initializeParams"
  | "shutdownParams"
  | "chatSendParams"
  | "chatCancelParams"
  | "emptyParams";

export class AgentCore {
  readonly probeTimeoutMs: number;
  private readonly now: () => number;
  private readonly provider: ModelProvider;
  private readonly history: ConversationHistory;
  private readonly emitMessage: (message: unknown) => void;
  private readonly logLine: (line: string) => void;
  private readonly requestExit: (code: number) => void;
  private readonly serverName: string;
  private readonly serverVersion: string;
  private readonly ownsStdio: boolean;
  private readonly stopped = new AbortController();
  private phase: "new" | "ready" | "stopping" = "new";
  private runtime: RuntimeStatus;
  /** `now()` when `runtime` was last set by a probe or a shell push. */
  private runtimeSetAt = Number.NEGATIVE_INFINITY;
  /** A shell push is not overridden by the watch until it is stale. */
  private runtimeSource: "probe" | "shell" = "probe";
  private runtimeGeneration = 0;
  private watchTimer: ReturnType<typeof setInterval> | undefined;
  private inflight: Flight | null = null;
  private accepting = false;
  private nextMessage = 1;
  private exiting = false;

  constructor(options: AgentCoreOptions) {
    this.provider = options.provider;
    this.history = options.history ?? new ConversationMemory();
    this.probeTimeoutMs = options.probeTimeoutMs ?? 1000;
    this.now = options.now ?? (() => Date.now());
    this.serverName = options.serverName ?? CORE_SERVER_NAME;
    this.serverVersion = options.serverVersion ?? CORE_SERVER_VERSION;
    this.ownsStdio = options.emit === undefined;
    this.runtime = { state: "loading", modelId: options.provider.modelId };
    this.emitMessage =
      options.emit ??
      ((message) => {
        process.stdout.write(`${JSON.stringify(message)}\n`);
      });
    this.logLine =
      options.log ??
      ((line) => {
        process.stderr.write(`cookie-core: ${line}\n`);
      });
    this.requestExit =
      options.exit ??
      ((code) => {
        process.exit(code);
      });
    const watchMs = options.watchIntervalMs ?? 0;
    if (watchMs > 0) {
      this.watchTimer = setInterval(() => {
        this.onWatch();
      }, watchMs);
      this.watchTimer.unref();
    }
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
      this.logLine(detail);
      this.emit(rpcError(null, "internalError"));
    }
  }

  onStdinClose(): void {
    this.phase = "stopping";
    this.stopWatch();
    this.stopped.abort();
    const flight = this.inflight;
    this.inflight = null;
    if (flight !== null) {
      flight.cancelled = true;
      flight.abort.abort();
    }
    this.flushAndExit(0);
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
        void this.onChatSend(id, params);
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
      this.logLine(`ignored ${method} before initialize`);
      return;
    }
    if (method === "session.window") {
      this.onSessionWindow(params);
      return;
    }
    if (method !== "runtime.status") {
      this.logLine(`ignored notification ${method}`);
      return;
    }
    if (!paramsAreValid("runtimeStatusParams", params)) {
      this.logLine(
        `ignored runtime.status ${paramsErrors("runtimeStatusParams", params)}`,
      );
      return;
    }
    const status = params as RuntimeStatus;
    this.runtimeGeneration += 1;
    this.runtime = {
      state: status.state,
      modelId: status.modelId ?? null,
    };
    this.runtimeSetAt = this.now();
    this.runtimeSource = "shell";
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
        serverInfo: { name: this.serverName, version: this.serverVersion },
        capabilities: {
          chat: { stream: true, cancel: true },
          runtime: { status: true },
        },
      },
    });
    const generation = this.runtimeGeneration;
    void this.publishProbe(generation, true);
  }

  private onShutdown(id: string, params: unknown): void {
    if (!paramsAreValid("shutdownParams", params)) {
      this.rejectParams(id, "shutdownParams", params);
      return;
    }
    this.phase = "stopping";
    this.stopWatch();
    this.stopped.abort();
    this.cancelFlight(this.inflight);
    this.emit({ jsonrpc: "2.0", id, result: { ok: true } });
    this.flushAndExit(0);
  }

  private async onChatSend(id: string, params: unknown): Promise<void> {
    if (this.phase === "stopping") {
      this.emit(rpcError(id, "shuttingDown", { method: "chat.send" }));
      return;
    }
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
    if (this.inflight !== null || this.accepting) {
      this.emit(rpcError(id, "chatInProgress", { method: "chat.send" }));
      return;
    }
    if (this.runtimeIsFresh()) {
      this.startFlight(id, body);
      return;
    }
    this.accepting = true;
    const generation = this.runtimeGeneration;
    let probed: RuntimeState;
    try {
      probed = await this.readProbe();
    } finally {
      this.accepting = false;
    }
    if (this.phaseIs("stopping")) {
      return;
    }
    if (generation !== this.runtimeGeneration) {
      if (this.runtime.state !== "up") {
        this.emit(
          rpcError(id, "runtimeUnavailable", {
            reason: `runtime is ${this.runtime.state}`,
          }),
        );
        return;
      }
    } else if (probed !== "up") {
      this.applyProbe(probed);
      this.emit({
        jsonrpc: "2.0",
        method: "runtime.status",
        params: this.runtimePayload(),
      });
      this.emit(
        rpcError(id, "runtimeUnavailable", {
          reason: `runtime is ${probed}`,
        }),
      );
      return;
    } else {
      this.applyProbe(probed);
    }
    if (this.inflight !== null) {
      this.emit(rpcError(id, "chatInProgress", { method: "chat.send" }));
      return;
    }
    this.startFlight(id, body);
  }

  private startFlight(id: string, body: ChatSendParams): void {
    const messageId = `msg-${this.nextMessage}`;
    this.nextMessage += 1;
    const flight: Flight = {
      conversationId: body.conversationId,
      messageId,
      userText: body.text,
      sent: [],
      startedAt: this.now(),
      cancelled: false,
      abort: new AbortController(),
    };
    const onStop = (): void => {
      flight.abort.abort();
    };
    if (this.stopped.signal.aborted) {
      onStop();
    } else {
      this.stopped.signal.addEventListener("abort", onStop, { once: true });
    }
    this.inflight = flight;
    this.emit({
      jsonrpc: "2.0",
      id,
      result: { conversationId: body.conversationId, messageId },
    });
    void this.runStream(flight);
  }

  private onChatCancel(id: string, params: unknown): void {
    if (!paramsAreValid("chatCancelParams", params)) {
      this.rejectParams(id, "chatCancelParams", params);
      return;
    }
    const body = params as ChatCancelParams;
    const flight = this.inflight;
    const matches =
      flight !== null &&
      flight.conversationId === body.conversationId &&
      flight.messageId === body.messageId;
    if (!matches || flight === null) {
      this.emit({ jsonrpc: "2.0", id, result: { cancelled: false } });
      return;
    }
    this.cancelFlight(flight);
    this.emit({ jsonrpc: "2.0", id, result: { cancelled: true } });
  }

  private onRuntimeQuery(id: string, params: unknown): void {
    if (!paramsAreValid("emptyParams", params)) {
      this.rejectParams(id, "emptyParams", params);
      return;
    }
    this.emit({ jsonrpc: "2.0", id, result: this.runtimePayload() });
  }

  private onWatch(): void {
    if (this.phase !== "ready") {
      return;
    }
    if (
      this.runtimeSource === "shell" &&
      this.now() - this.runtimeSetAt < RUNTIME_FRESH_MS
    ) {
      return;
    }
    const generation = this.runtimeGeneration;
    void this.publishProbe(generation, false);
  }

  private stopWatch(): void {
    if (this.watchTimer === undefined) {
      return;
    }
    clearInterval(this.watchTimer);
    this.watchTimer = undefined;
  }

  private async publishProbe(
    generation: number,
    force: boolean,
  ): Promise<void> {
    const state = await this.readProbe();
    if (this.phase !== "ready") {
      return;
    }
    if (generation !== this.runtimeGeneration) {
      return;
    }
    const previous = this.runtimePayload();
    this.applyProbe(state);
    const next = this.runtimePayload();
    if (
      !force &&
      previous.state === next.state &&
      previous.modelId === next.modelId
    ) {
      return;
    }
    this.emit({
      jsonrpc: "2.0",
      method: "runtime.status",
      params: this.runtimePayload(),
    });
  }

  private async readProbe(): Promise<RuntimeState> {
    const signal = AbortSignal.any([
      this.stopped.signal,
      AbortSignal.timeout(this.probeTimeoutMs),
    ]);
    try {
      return await this.provider.probe(signal);
    } catch (error) {
      if (!isExpectedProbeFailure(error)) {
        const detail = error instanceof Error ? error.message : "probe failed";
        this.logLine(`probe failed: ${detail}`);
      }
      return "down";
    }
  }

  private runtimeIsFresh(): boolean {
    return (
      this.runtime.state === "up" &&
      this.now() - this.runtimeSetAt < RUNTIME_FRESH_MS
    );
  }

  private applyProbe(state: RuntimeState): void {
    if (state === "down") {
      this.runtime = { state: "down", modelId: null };
    } else {
      this.runtime = { state, modelId: this.provider.modelId };
    }
    this.runtimeSetAt = this.now();
    this.runtimeSource = "probe";
  }

  private markDown(): void {
    if (
      this.runtime.state === "down" &&
      (this.runtime.modelId ?? null) === null
    ) {
      return;
    }
    this.runtimeGeneration += 1;
    this.applyProbe("down");
    this.emit({
      jsonrpc: "2.0",
      method: "runtime.status",
      params: this.runtimePayload(),
    });
  }

  private async runStream(flight: Flight): Promise<void> {
    let stream: ModelStream;
    try {
      stream = this.provider.streamChat({
        system: SYSTEM_PROMPT,
        messages: this.history.messagesFor(
          flight.conversationId,
          flight.userText,
        ),
        abortSignal: flight.abort.signal,
      });
    } catch (error) {
      this.failStream(flight, error);
      return;
    }
    // Always attach a handler. Cancel abandons the iterator, and an
    // unhandled rejection from the aborted completion would exit the process.
    const completion = stream.completion.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      for await (const text of stream.textDeltas) {
        if (flight.cancelled || this.inflight !== flight) {
          return;
        }
        if (text.length === 0) {
          continue;
        }
        flight.sent.push(text);
        this.emit({
          jsonrpc: "2.0",
          method: "chat.delta",
          params: {
            conversationId: flight.conversationId,
            messageId: flight.messageId,
            index: flight.sent.length - 1,
            text,
          },
        });
      }
      if (flight.cancelled || this.inflight !== flight) {
        return;
      }
      const outcome = await completion;
      if (flight.cancelled || this.inflight !== flight) {
        return;
      }
      if (!outcome.ok) {
        this.failStream(flight, outcome.error);
        return;
      }
      this.completeStream(flight, outcome.value);
    } catch (error) {
      const outcome = await completion;
      this.failStream(flight, outcome.ok ? error : outcome.error);
    }
  }

  private completeStream(flight: Flight, completion: ModelCompletion): void {
    // A successful completion with no chunks is still `stop`. `error` stays
    // `error` even when the model produced no text.
    const finishReason =
      flight.sent.length === 0 && completion.finishReason !== "error"
        ? "stop"
        : completion.finishReason;
    this.finishFlight(flight, finishReason, completion.usage);
  }

  private failStream(flight: Flight, error: unknown): void {
    if (
      flight.cancelled ||
      this.inflight !== flight ||
      isAbortError(error) ||
      this.phase === "stopping"
    ) {
      return;
    }
    const detail = error instanceof Error ? error.message : "stream failed";
    this.logLine(detail);
    if (this.inflight !== flight) {
      return;
    }
    if (isUnreachable(error)) {
      this.markDown();
    }
    this.finishFlight(flight, "error", ZERO_USAGE);
  }

  private finishFlight(
    flight: Flight,
    finishReason: FinishReason,
    usage: ModelUsage,
  ): void {
    if (this.inflight !== flight) {
      return;
    }
    this.inflight = null;
    this.commitFlight(flight, usage);
    this.emit(this.doneMessage(flight, finishReason, usage));
  }

  private cancelFlight(flight: Flight | null): void {
    if (flight === null || this.inflight !== flight) {
      return;
    }
    flight.cancelled = true;
    this.inflight = null;
    flight.abort.abort();
    this.commitFlight(flight, ZERO_USAGE);
    // The aborted request does not return a usage payload. See lessons.
    this.emit(this.doneMessage(flight, "cancelled", ZERO_USAGE));
  }

  private doneMessage(
    flight: Flight,
    finishReason: FinishReason,
    usage: ModelUsage,
  ): {
    jsonrpc: "2.0";
    method: "chat.done";
    params: {
      conversationId: string;
      messageId: string;
      finishReason: FinishReason;
      usage: ModelUsage;
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
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        },
      },
    };
  }

  private runtimePayload(): { state: RuntimeState; modelId: string | null } {
    return {
      state: this.runtime.state,
      modelId: this.runtime.modelId ?? null,
    };
  }

  private rejectParams(id: string, def: ParamSchema, params: unknown): void {
    this.logLine(`${def} ${paramsErrors(def, params)}`);
    this.emit(
      rpcError(id, "invalidParams", { reason: "params failed schema" }),
    );
  }

  private emit(message: unknown): void {
    if (!isCookieMessage(message)) {
      this.logLine(
        `refused invalid outbound message ${JSON.stringify(message)} ${messageErrors(message)}`,
      );
      this.finish(1);
      return;
    }
    this.emitMessage(message);
  }

  private onSessionWindow(params: unknown): void {
    if (!paramsAreValid("sessionWindowParams", params)) {
      this.logLine(
        `ignored session.window ${paramsErrors("sessionWindowParams", params)}`,
      );
      return;
    }
    const body = params as SessionWindowParams;
    this.history.noteWindow(body.conversationId, body.state);
  }

  private commitFlight(flight: Flight, usage: ModelUsage): void {
    try {
      this.history.commit({
        conversationId: flight.conversationId,
        userText: flight.userText,
        assistantText: flight.sent.join(""),
        modelId: this.provider.modelId,
        usage,
        latencyMs: Math.max(0, this.now() - flight.startedAt),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "memory failed";
      this.logLine(`memory: ${detail}`);
    }
  }

  private flushAndExit(code: number): void {
    this.history.close();
    if (!this.ownsStdio) {
      this.finish(code);
      return;
    }
    process.stdout.write("", () => {
      this.finish(code);
    });
  }

  private finish(code: number): void {
    if (this.exiting) {
      return;
    }
    this.exiting = true;
    this.requestExit(code);
  }

  private phaseIs(phase: "new" | "ready" | "stopping"): boolean {
    return this.phase === phase;
  }

  private errorId(value: unknown): string | null {
    if (!isRecord(value)) {
      return null;
    }
    return typeof value.id === "string" ? value.id : null;
  }
}

function isExpectedProbeFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "object" && "name" in current) {
      const name = current.name;
      if (name === "AbortError" || name === "TimeoutError") {
        return true;
      }
    }
    if (typeof current === "object" && "cause" in current) {
      current = current.cause;
      continue;
    }
    break;
  }
  return false;
}

function isUnreachable(error: unknown): boolean {
  const codes = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "ECONNABORTED",
    "EPIPE",
    "ENOTFOUND",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
  ]);
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (typeof current !== "object") {
      continue;
    }
    if ("code" in current) {
      const code = current.code;
      if (typeof code === "string" && codes.has(code)) {
        return true;
      }
    }
    if ("cause" in current) {
      stack.push(current.cause);
    }
    if ("errors" in current && Array.isArray(current.errors)) {
      stack.push(...current.errors);
    }
  }
  return false;
}
