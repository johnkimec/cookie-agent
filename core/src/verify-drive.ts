/**
 * Driver for .cursor/skills/verify-cookie/bin/drive-core.
 *
 * Spawns the fake core, speaks protocol 0.1, and writes a transcript.
 * Scratch lives under /tmp/cookie-verify (or COOKIE_VERIFY_RUNTIME).
 * Evidence directories are never deleted by cleanup.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readdir, readlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CORE_SERVER_NAME } from "./identity.ts";
import {
  nodeSupportsTypeStripping,
  TYPE_STRIP_NODE_ARGS,
} from "./node-launch.ts";
import { protocolErrors } from "./protocol/errors.ts";
import {
  countWords,
  FAKE_MODEL_ID,
  FAKE_REPLY_CHUNKS,
  FAKE_SERVER_NAME,
  fakeReplyText,
} from "./protocol/text.ts";
import { DEFAULT_MODEL_ID, PROTOCOL_VERSION } from "./protocol/types.ts";
import {
  isCookieMessage,
  isRecord,
  messageErrors,
} from "./protocol/validate.ts";
import {
  type LlamaStub,
  STUB_INPUT_TOKENS,
  STUB_OUTPUT_TOKENS,
  STUB_REPLY_CHUNKS,
  startLlamaStub,
} from "./verify-llama-stub.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fakeCorePath = join(repoRoot, "core/src/fake-core.ts");
const realCorePath = join(repoRoot, "core/src/index.ts");

type CoreKind = "fake" | "real";
type LlamaMode = "stub" | "external";
type DriveFeature =
  | "chat-streaming"
  | "model-status"
  | "chat-history"
  | "runtime-restart";
const schemaPath = join(repoRoot, "protocol/schema/cookie-rpc.schema.json");
const llamaPort = "18080";
const readTimeoutMs = 5000;
/** Cold Qwen loads are tens of seconds. External mode waits at least this long. */
const EXTERNAL_UP_TIMEOUT_MS = 120_000;
/** One chat line on a real model. The clock resets on each JSON-RPC line. */
const EXTERNAL_CHAT_TIMEOUT_MS = 180_000;

/**
 * The second prompt must not contain this word. A server that only echoes
 * the latest user text then fails the history check.
 */
export const HISTORY_CODE_WORD = "marmalade417";
const HISTORY_FIRST_PROMPT = `Remember this code word: ${HISTORY_CODE_WORD}. Reply with exactly: remembered`;
const HISTORY_SECOND_PROMPT =
  "What code word did I ask you to remember? Reply with only that code word.";
const HISTORY_CONVERSATION = "conv-history";

interface TranscriptEntry {
  seq: number;
  direction: "client" | "server";
  message: unknown;
}

interface Waiter {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class LineQueue {
  private readonly lines: unknown[] = [];
  private readonly waiters: Waiter[] = [];
  private closed: Error | null = null;

  push(message: unknown): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.lines.push(message);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  fail(error: Error): void {
    this.closed = error;
    const pending = this.waiters.splice(0);
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  next(timeoutMs: number): Promise<unknown> {
    const queued = this.lines.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (this.closed !== null) {
      return Promise.reject(this.closed);
    }
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex(
          (waiter) => waiter.timer === timer,
        );
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(new Error("timed out waiting for a JSON-RPC line"));
      }, timeoutMs);
      this.waiters.push({ resolve: resolvePromise, reject, timer });
    });
  }
}

class CoreSession {
  readonly transcript: TranscriptEntry[] = [];
  readonly side: unknown[] = [];
  readonly stderr: Buffer[] = [];
  readonly pid: number;
  private readonly child: ChildProcess;
  private readonly stdin: NonNullable<ChildProcess["stdin"]>;
  private readonly queue = new LineQueue();

  private constructor(child: ChildProcess) {
    if (
      child.pid === undefined ||
      child.stdin === null ||
      child.stdout === null ||
      child.stderr === null
    ) {
      throw new Error("fake core did not start");
    }
    this.child = child;
    this.stdin = child.stdin;
    this.pid = child.pid;
    const stdout = child.stdout;
    const stderr = child.stderr;
    const lines = createInterface({ input: stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (line.trim() === "") {
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch (error) {
        const detail = error instanceof Error ? error.message : "invalid json";
        this.queue.fail(new Error(`fake core stdout was not JSON: ${detail}`));
        return;
      }
      this.queue.push(message);
    });
    stdout.on("end", () => {
      this.queue.fail(new Error("fake core stdout closed"));
    });
    stderr.on("data", (chunk: Buffer) => {
      this.stderr.push(chunk);
    });
  }

  static spawn(
    dataDir: string,
    deltaMs: string,
    kind: CoreKind,
    llama: LlamaMode,
  ): CoreSession {
    mkdirSync(dataDir, { recursive: true });
    const entry = kind === "real" ? realCorePath : fakeCorePath;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      COOKIE_DATA_DIR: dataDir,
      COOKIE_FAKE_DELTA_MS: deltaMs,
    };
    if (llama === "stub") {
      env.COOKIE_LLAMA_PORT = llamaPort;
    }
    const child = spawn(process.execPath, [...TYPE_STRIP_NODE_ARGS, entry], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    const session = new CoreSession(child);
    writePidFile(session.pid, dataDir);
    return session;
  }

  send(message: unknown): void {
    if (!isCookieMessage(message)) {
      throw new Error(
        `schema rejected client message ${JSON.stringify(message)} ${messageErrors(message)}`,
      );
    }
    this.record("client", message);
    this.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async next(timeoutMs = readTimeoutMs): Promise<unknown> {
    const message = await this.queue.next(timeoutMs);
    this.record("server", message);
    if (!isCookieMessage(message)) {
      throw new Error(
        `schema rejected server message ${JSON.stringify(message)} ${messageErrors(message)}`,
      );
    }
    return message;
  }

  async response(
    id: string,
    timeoutMs = readTimeoutMs,
  ): Promise<Record<string, unknown>> {
    for (;;) {
      const message = await this.next(timeoutMs);
      if (!isRecord(message)) {
        throw new Error(`expected an object for id ${id}`);
      }
      if (message.id === id && ("result" in message || "error" in message)) {
        return message;
      }
      this.side.push(message);
    }
  }

  stderrText(): string {
    return Buffer.concat(this.stderr).toString("utf8");
  }

  async dispose(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await once(this.child, "exit").catch(() => undefined);
    }
  }

  async waitForExit(): Promise<number | null> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return this.child.exitCode;
    }
    const [code] = (await once(this.child, "exit")) as [number | null];
    return code;
  }

  private record(direction: "client" | "server", message: unknown): void {
    this.transcript.push({ seq: this.transcript.length, direction, message });
  }
}

function runtimeRoot(): string {
  return process.env.COOKIE_VERIFY_RUNTIME ?? "/tmp/cookie-verify";
}

function scratchListPath(): string {
  return join(runtimeRoot(), "scratch-dirs.txt");
}

function rememberScratch(dir: string): void {
  mkdirSync(runtimeRoot(), { recursive: true });
  appendFileSync(scratchListPath(), `${resolve(dir)}\n`);
}

function writePidFile(pid: number, dataDir: string): void {
  const dir = join(runtimeRoot(), "pids");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${pid}.json`),
    `${JSON.stringify({ pid, dataDir: resolve(dataDir) })}\n`,
  );
}

function forgetPid(pid: number): void {
  try {
    unlinkSync(join(runtimeRoot(), "pids", `${pid}.json`));
  } catch {
    // already removed
  }
}

function deletableScratch(dir: string): string | null {
  const root = resolve(runtimeRoot());
  let target = resolve(dir);
  try {
    target = realpathSync(target);
  } catch {
    // The directory may already be gone. Judge the lexical path.
  }
  if (target === root || !target.startsWith(`${root}${sep}`)) {
    return null;
  }
  return target;
}

function cmdlineIsManagedCore(pid: number): boolean {
  if (pid <= 1 || pid === process.pid) {
    return false;
  }
  try {
    const text = readFileSync(`/proc/${pid}/cmdline`).toString("utf8");
    return text.includes("fake-core.ts") || text.includes("core/src/index.ts");
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function killManagedCore(pid: number): Promise<void> {
  if (!cmdlineIsManagedCore(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const started = Date.now();
  while (Date.now() - started < 500) {
    if (!cmdlineIsManagedCore(pid)) {
      return;
    }
    await sleep(20);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

function rmIfScratch(dir: string): void {
  if (dir === "") {
    return;
  }
  const target = deletableScratch(dir);
  if (target === null) {
    return;
  }
  rmSync(target, { recursive: true, force: true });
}

function finishCleanupList(): void {
  let text = "";
  try {
    text = readFileSync(scratchListPath(), "utf8");
  } catch {
    text = "";
  }
  for (const line of text.split("\n")) {
    rmIfScratch(line.trim());
  }
  try {
    writeFileSync(scratchListPath(), "");
  } catch {
    // no scratch list yet
  }
}

async function cleanupAsync(): Promise<number> {
  const pidDir = join(runtimeRoot(), "pids");
  let pidFiles: string[] = [];
  try {
    pidFiles = readdirSync(pidDir);
  } catch {
    pidFiles = [];
  }
  for (const file of pidFiles) {
    const path = join(pidDir, file);
    let pid: number | null = null;
    let dataDir = "";
    try {
      const record = JSON.parse(readFileSync(path, "utf8")) as {
        pid?: unknown;
        dataDir?: unknown;
      };
      if (typeof record.pid === "number") {
        pid = record.pid;
      }
      if (typeof record.dataDir === "string") {
        dataDir = record.dataDir;
      }
    } catch {
      pid = null;
    }
    if (pid !== null) {
      await killManagedCore(pid);
    }
    rmIfScratch(dataDir);
    try {
      unlinkSync(path);
    } catch {
      // already removed
    }
  }
  finishCleanupList();
  process.stdout.write("ok\n");
  return 0;
}

/**
 * Decode an address from /proc/net/tcp. IPv4 is little-endian.
 * `0100007F:46A0` is 127.0.0.1:18080.
 */
export function decodeProcAddress(hex: string): string {
  const [ipHex, portHex] = hex.split(":");
  if (ipHex === undefined || portHex === undefined) {
    return hex;
  }
  const port = Number.parseInt(portHex, 16);
  if (!Number.isFinite(port)) {
    return hex;
  }
  if (ipHex.length === 8) {
    const value = Number.parseInt(ipHex, 16);
    const b1 = value & 0xff;
    const b2 = (value >>> 8) & 0xff;
    const b3 = (value >>> 16) & 0xff;
    const b4 = (value >>> 24) & 0xff;
    return `${b1}.${b2}.${b3}.${b4}:${port}`;
  }
  return `${ipHex}:${port}`;
}

async function socketPeers(pid: number): Promise<string[]> {
  const byInode = new Map<string, string>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      const remote = fields[2];
      const inode = fields[9];
      if (remote === undefined || inode === undefined || inode === "0") {
        continue;
      }
      byInode.set(inode, decodeProcAddress(remote));
    }
  }
  const peers: string[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(`/proc/${pid}/fd`);
  } catch {
    return peers;
  }
  for (const entry of entries) {
    // Node wires stdio as socket pairs. Those are fds 0, 1, and 2.
    if (entry === "0" || entry === "1" || entry === "2") {
      continue;
    }
    let target = "";
    try {
      target = readlinkSync(join(`/proc/${pid}/fd`, entry));
    } catch {
      try {
        target = await readlink(join(`/proc/${pid}/fd`, entry));
      } catch {
        continue;
      }
    }
    if (!target.startsWith("socket:")) {
      continue;
    }
    const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
    if (inode === undefined) {
      peers.push(target);
      continue;
    }
    peers.push(byInode.get(inode) ?? target);
  }
  return peers;
}

function effectiveLlamaPort(llama: LlamaMode): string {
  if (llama === "stub") {
    return llamaPort;
  }
  const raw = process.env.COOKIE_LLAMA_PORT;
  if (raw === undefined || raw === "") {
    return "8080";
  }
  return raw;
}

async function assertSockets(
  pid: number,
  kind: CoreKind,
  port: string,
): Promise<void> {
  if (process.platform !== "linux") {
    return;
  }
  const peers = await socketPeers(pid);
  if (kind === "fake") {
    if (peers.length > 0) {
      throw new Error(`fake core pid ${pid} opened ${peers.join(" ")}`);
    }
    return;
  }
  const allowed = new Set([`127.0.0.1:${port}`, `::1:${port}`]);
  for (const peer of peers) {
    if (!allowed.has(peer)) {
      throw new Error(`core pid ${pid} opened ${peer}`);
    }
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value;
}

function initializeMessage(id: string): unknown {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "verify-cookie", version: "0.0.0" },
      capabilities: { chatCancel: true },
    },
  };
}

function expectedServer(kind: CoreKind): string {
  return kind === "real" ? CORE_SERVER_NAME : FAKE_SERVER_NAME;
}

function expectedModel(kind: CoreKind): string {
  return kind === "real" ? DEFAULT_MODEL_ID : FAKE_MODEL_ID;
}

async function initialize(
  session: CoreSession,
  id: string,
  kind: CoreKind,
  port: string,
): Promise<void> {
  session.send(initializeMessage(id));
  const response = await session.response(id);
  const result = asRecord(response.result, "initialize result");
  if (result.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`protocolVersion ${String(result.protocolVersion)}`);
  }
  const serverInfo = asRecord(result.serverInfo, "serverInfo");
  if (serverInfo.name !== expectedServer(kind)) {
    throw new Error(`server ${String(serverInfo.name)}`);
  }
  const status = session.side.shift() ?? (await session.next());
  const note = asRecord(status, "runtime.status");
  if (note.method !== "runtime.status") {
    throw new Error("missing runtime.status after initialize");
  }
  const params = asRecord(note.params, "runtime.status params");
  if (params.state !== "up" || params.modelId !== expectedModel(kind)) {
    throw new Error(
      `runtime ${String(params.state)} ${String(params.modelId)}`,
    );
  }
  await assertSockets(session.pid, kind, port);
}

async function runChat(
  session: CoreSession,
  kind: CoreKind,
  stub: LlamaStub | null,
): Promise<string> {
  await initialize(session, "1", kind, llamaPort);
  const firstText = "hello from verify-cookie";
  session.send({
    jsonrpc: "2.0",
    id: "2",
    method: "chat.send",
    params: { conversationId: "conv-verify", text: firstText },
  });
  const ack = await session.response("2");
  const ackResult = asRecord(ack.result, "chat.send result");
  const firstId = ackResult.messageId;
  if (typeof firstId !== "string") {
    throw new Error("chat.send ack has no messageId");
  }
  const deltas: string[] = [];
  let done: Record<string, unknown> | null = null;
  while (done === null) {
    const message = asRecord(await session.next(), "stream message");
    if (message.method === "chat.delta") {
      const params = asRecord(message.params, "chat.delta");
      if (params.index !== deltas.length) {
        throw new Error(`delta index ${String(params.index)}`);
      }
      if (typeof params.text !== "string") {
        throw new Error("delta text missing");
      }
      deltas.push(params.text);
      continue;
    }
    if (message.method === "chat.done") {
      done = message;
      break;
    }
    throw new Error(`unexpected ${String(message.method)}`);
  }
  const replyChunks = kind === "real" ? STUB_REPLY_CHUNKS : FAKE_REPLY_CHUNKS;
  const replyText =
    kind === "real" ? STUB_REPLY_CHUNKS.join("") : fakeReplyText();
  if (deltas.length !== replyChunks.length) {
    throw new Error(
      `expected ${replyChunks.length} deltas, got ${deltas.length}`,
    );
  }
  if (deltas.join("") !== replyText) {
    throw new Error("deltas did not form the canned reply");
  }
  const doneParams = asRecord(done.params, "chat.done");
  if (doneParams.finishReason !== "stop") {
    throw new Error(`finishReason ${String(doneParams.finishReason)}`);
  }
  const usage = asRecord(doneParams.usage, "usage");
  const expectedIn =
    kind === "real" ? STUB_INPUT_TOKENS : countWords(firstText);
  const expectedOut =
    kind === "real" ? STUB_OUTPUT_TOKENS : countWords(replyText);
  if (usage.inputTokens !== expectedIn) {
    throw new Error(`inputTokens ${String(usage.inputTokens)}`);
  }
  if (usage.outputTokens !== expectedOut) {
    throw new Error(`outputTokens ${String(usage.outputTokens)}`);
  }

  const secondText = "cancel this reply";
  session.send({
    jsonrpc: "2.0",
    id: "3",
    method: "chat.send",
    params: { conversationId: "conv-verify", text: secondText },
  });
  const secondAck = await session.response("3");
  const secondResult = asRecord(secondAck.result, "second chat.send result");
  const secondId = secondResult.messageId;
  if (typeof secondId !== "string") {
    throw new Error("second ack has no messageId");
  }
  const firstDelta = asRecord(await session.next(), "first cancel delta");
  if (firstDelta.method !== "chat.delta") {
    throw new Error("cancel path did not start with chat.delta");
  }
  session.send({
    jsonrpc: "2.0",
    id: "4",
    method: "chat.cancel",
    params: { conversationId: "conv-verify", messageId: secondId },
  });
  const cancelledDone = asRecord(await session.next(), "cancelled chat.done");
  if (cancelledDone.method !== "chat.done") {
    throw new Error(`expected chat.done, got ${String(cancelledDone.method)}`);
  }
  const cancelledParams = asRecord(cancelledDone.params, "cancelled params");
  if (cancelledParams.finishReason !== "cancelled") {
    throw new Error(
      `cancel finishReason ${String(cancelledParams.finishReason)}`,
    );
  }
  const cancelResponse = await session.response("4");
  const cancelResult = asRecord(cancelResponse.result, "chat.cancel result");
  if (cancelResult.cancelled !== true) {
    throw new Error("chat.cancel did not report cancelled");
  }
  if (kind === "real") {
    if (stub === null) {
      throw new Error("real core drive has no llama stub");
    }
    await waitForModelAbort(stub);
    const encoded = JSON.stringify(stub.chats.map((chat) => chat.messages));
    if (!encoded.includes(firstText) || !encoded.includes("local stub")) {
      throw new Error("real core did not send conversation history");
    }
  }

  session.send({
    jsonrpc: "2.0",
    id: "5",
    method: "shutdown",
    params: {},
  });
  const shutdown = await session.response("5");
  const shutdownResult = asRecord(shutdown.result, "shutdown result");
  if (shutdownResult.ok !== true) {
    throw new Error("shutdown was not ok");
  }
  const code = await session.waitForExit();
  if (code !== 0) {
    throw new Error(`core exit ${String(code)}`);
  }
  const lines = ["ok", "deltas 3", "finishReason stop", "cancelled true"];
  if (kind === "real") {
    lines.push("modelAborted true");
  }
  lines.push("");
  return lines.join("\n");
}

async function waitForModelAbort(stub: LlamaStub): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 2000) {
    if (stub.chats.some((chat) => chat.aborted)) {
      return;
    }
    await sleep(20);
  }
  throw new Error("model request was not aborted");
}

async function expectRuntimeError(
  session: CoreSession,
  id: string,
  text: string,
): Promise<void> {
  session.send({
    jsonrpc: "2.0",
    id,
    method: "chat.send",
    params: { conversationId: "conv-status", text },
  });
  const response = await session.response(id);
  const error = asRecord(response.error, "chat.send error");
  if (error.code !== protocolErrors.runtimeUnavailable.code) {
    throw new Error(`expected runtime unavailable, got ${String(error.code)}`);
  }
  if (error.message !== protocolErrors.runtimeUnavailable.message) {
    throw new Error(`unexpected error message ${String(error.message)}`);
  }
}

async function pushStatus(
  session: CoreSession,
  state: "up" | "down" | "loading",
  modelId: string | null,
): Promise<void> {
  const params =
    modelId === null ? { state, modelId: null } : { state, modelId };
  session.send({ jsonrpc: "2.0", method: "runtime.status", params });
}

async function queryStatus(
  session: CoreSession,
  id: string,
): Promise<Record<string, unknown>> {
  session.send({
    jsonrpc: "2.0",
    id,
    method: "runtime.status",
    params: {},
  });
  const response = await session.response(id);
  return asRecord(response.result, "runtime.status result");
}

async function runModelStatus(
  session: CoreSession,
  kind: CoreKind,
): Promise<string> {
  await initialize(session, "1", kind, llamaPort);
  const modelId = expectedModel(kind);
  const initial = await queryStatus(session, "2");
  if (initial.state !== "up" || initial.modelId !== modelId) {
    throw new Error("query did not echo the initial runtime");
  }
  await pushStatus(session, "loading", DEFAULT_MODEL_ID);
  const loading = await queryStatus(session, "3");
  if (loading.state !== "loading" || loading.modelId !== DEFAULT_MODEL_ID) {
    throw new Error("runtime did not enter loading");
  }
  await expectRuntimeError(session, "4", "while loading");
  await pushStatus(session, "down", null);
  const down = await queryStatus(session, "5");
  if (down.state !== "down" || down.modelId !== null) {
    throw new Error("runtime did not enter down");
  }
  await expectRuntimeError(session, "6", "while down");
  await pushStatus(session, "up", modelId);
  session.send({
    jsonrpc: "2.0",
    id: "7",
    method: "chat.send",
    params: { conversationId: "conv-status", text: "status check" },
  });
  const ack = await session.response("7");
  if (!isRecord(ack.result)) {
    throw new Error("recovery chat.send failed");
  }
  let finish = "";
  for (;;) {
    const message = asRecord(await session.next(), "recovery stream");
    if (message.method === "chat.done") {
      finish = String(asRecord(message.params, "done").finishReason);
      break;
    }
    if (message.method !== "chat.delta") {
      throw new Error(`recovery saw ${String(message.method)}`);
    }
  }
  if (finish !== "stop") {
    throw new Error(`recovery finishReason ${finish}`);
  }
  session.send({ jsonrpc: "2.0", id: "8", method: "shutdown", params: {} });
  await session.response("8");
  const code = await session.waitForExit();
  if (code !== 0) {
    throw new Error(`core exit ${String(code)}`);
  }
  const macLine =
    process.platform === "linux"
      ? "verified-unreachable on Linux: requires macOS"
      : "verified-unreachable: requires the Mac app from task B";
  return [
    "ok",
    "loading refused",
    "down refused",
    "recovered stop",
    macLine,
    "",
  ].join("\n");
}

interface ChatTiming {
  index: number;
  ttftMs: number;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  text: string;
}

function formatTiming(row: ChatTiming): string {
  return `chat ${row.index} ttftMs ${row.ttftMs} totalMs ${row.totalMs} inputTokens ${row.inputTokens} outputTokens ${row.outputTokens}`;
}

function remainingMs(deadline: number, label: string): number {
  const left = deadline - Date.now();
  if (left <= 0) {
    throw new Error(`timed out ${label}`);
  }
  return left;
}

async function waitForRuntimeUp(
  session: CoreSession,
  kind: CoreKind,
  timeoutMs: number,
  port: string,
): Promise<void> {
  session.send(initializeMessage("1"));
  const response = await session.response("1", timeoutMs);
  const result = asRecord(response.result, "initialize result");
  if (result.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`protocolVersion ${String(result.protocolVersion)}`);
  }
  const serverInfo = asRecord(result.serverInfo, "serverInfo");
  if (serverInfo.name !== expectedServer(kind)) {
    throw new Error(`server ${String(serverInfo.name)}`);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = asRecord(
      await session.next(
        remainingMs(deadline, "waiting for runtime.status up"),
      ),
      "runtime wait",
    );
    if (message.method !== "runtime.status") {
      throw new Error(
        `unexpected ${String(message.method)} while waiting for up`,
      );
    }
    const params = asRecord(message.params, "runtime.status params");
    if (params.state === "up" && params.modelId === expectedModel(kind)) {
      await assertSockets(session.pid, kind, port);
      return;
    }
  }
  throw new Error("timed out waiting for runtime.status up");
}

async function timedChat(
  session: CoreSession,
  id: string,
  text: string,
  index: number,
  timeoutMs: number,
): Promise<ChatTiming> {
  const started = Date.now();
  session.send({
    jsonrpc: "2.0",
    id,
    method: "chat.send",
    params: { conversationId: HISTORY_CONVERSATION, text },
  });
  const ack = await session.response(id, timeoutMs);
  if (!isRecord(ack.result)) {
    throw new Error(`chat.send ${id} failed`);
  }
  let ttftMs: number | null = null;
  const parts: string[] = [];
  const deadline = started + timeoutMs;
  for (;;) {
    const message = asRecord(
      await session.next(remainingMs(deadline, `chat ${index}`)),
      "chat",
    );
    if (message.method === "chat.delta") {
      const params = asRecord(message.params, "delta");
      if (typeof params.text !== "string" || params.text.length === 0) {
        throw new Error("empty delta");
      }
      if (ttftMs === null) {
        ttftMs = Date.now() - started;
      }
      parts.push(params.text);
      continue;
    }
    if (message.method === "runtime.status") {
      const params = asRecord(message.params, "status during chat");
      if (params.state !== "up") {
        throw new Error(
          `runtime dropped to ${String(params.state)} during chat ${index}`,
        );
      }
      continue;
    }
    if (message.method !== "chat.done") {
      throw new Error(`unexpected ${String(message.method)}`);
    }
    const params = asRecord(message.params, "done");
    if (params.finishReason !== "stop") {
      throw new Error(
        `chat ${index} finishReason ${String(params.finishReason)}`,
      );
    }
    const usage = asRecord(params.usage, "usage");
    if (ttftMs === null) {
      throw new Error(`chat ${index} produced no token`);
    }
    if (
      typeof usage.inputTokens !== "number" ||
      typeof usage.outputTokens !== "number"
    ) {
      throw new Error(`chat ${index} usage missing`);
    }
    return {
      index,
      ttftMs,
      totalMs: Date.now() - started,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      text: parts.join(""),
    };
  }
}

async function runChatHistory(
  session: CoreSession,
  port: string,
): Promise<{ summary: string; timings: string }> {
  if (!HISTORY_FIRST_PROMPT.includes(HISTORY_CODE_WORD)) {
    throw new Error("first prompt is missing the code word");
  }
  if (
    HISTORY_SECOND_PROMPT.toLowerCase().includes(
      HISTORY_CODE_WORD.toLowerCase(),
    )
  ) {
    throw new Error("second prompt contains the code word");
  }
  await waitForRuntimeUp(session, "real", EXTERNAL_UP_TIMEOUT_MS, port);
  const first = await timedChat(
    session,
    "2",
    HISTORY_FIRST_PROMPT,
    1,
    EXTERNAL_CHAT_TIMEOUT_MS,
  );
  const second = await timedChat(
    session,
    "3",
    HISTORY_SECOND_PROMPT,
    2,
    EXTERNAL_CHAT_TIMEOUT_MS,
  );
  if (!second.text.toLowerCase().includes(HISTORY_CODE_WORD.toLowerCase())) {
    const sample = second.text.slice(0, 200);
    throw new Error(
      `second reply did not contain ${HISTORY_CODE_WORD}: ${sample}`,
    );
  }
  session.send({ jsonrpc: "2.0", id: "4", method: "shutdown", params: {} });
  const shutdown = await session.response("4", readTimeoutMs);
  const shutdownResult = asRecord(shutdown.result, "shutdown result");
  if (shutdownResult.ok !== true) {
    throw new Error("shutdown was not ok");
  }
  const code = await session.waitForExit();
  if (code !== 0) {
    throw new Error(`core exit ${String(code)}`);
  }
  const lines = [formatTiming(first), formatTiming(second)];
  const timings = [
    `conversation ${HISTORY_CONVERSATION}`,
    `codeWord ${HISTORY_CODE_WORD}`,
    ...lines,
    "",
  ].join("\n");
  return {
    summary: ["ok", "history true", ...lines, ""].join("\n"),
    timings,
  };
}

async function runRuntimeRestart(
  session: CoreSession,
  stub: LlamaStub,
): Promise<string> {
  await initialize(session, "1", "real", llamaPort);
  const states = ["up"];
  const note = (message: Record<string, unknown>): void => {
    if (message.method !== "runtime.status") {
      return;
    }
    const params = asRecord(message.params, "runtime.status");
    const state = String(params.state);
    if (states[states.length - 1] === state) {
      throw new Error(`duplicate runtime.status ${state}`);
    }
    states.push(state);
  };
  const deadline = Date.now() + 15_000;
  stub.holdAfterFirstChunk(true);
  session.send({
    jsonrpc: "2.0",
    id: "2",
    method: "chat.send",
    params: { conversationId: "conv-restart", text: "hold this reply" },
  });
  const ack = await session.response("2", 5000);
  const messageId = asRecord(ack.result, "chat.send result").messageId;
  if (typeof messageId !== "string") {
    throw new Error("restart chat has no messageId");
  }
  let sawDelta = false;
  while (!sawDelta) {
    const message = asRecord(
      await session.next(remainingMs(deadline, "waiting for a delta")),
      "restart delta",
    );
    note(message);
    if (message.method === "chat.delta") {
      sawDelta = true;
    }
  }
  await stub.kill();
  let sawError = false;
  while (!sawError || states[states.length - 1] !== "down") {
    const message = asRecord(
      await session.next(remainingMs(deadline, "waiting for down")),
      "restart death",
    );
    note(message);
    if (message.method !== "chat.done") {
      continue;
    }
    const params = asRecord(message.params, "inflight done");
    if (params.messageId !== messageId) {
      throw new Error("inflight chat.done messageId");
    }
    if (params.finishReason !== "error") {
      throw new Error(`inflight finishReason ${String(params.finishReason)}`);
    }
    const usage = asRecord(params.usage, "inflight usage");
    if (usage.inputTokens !== 0 || usage.outputTokens !== 0) {
      throw new Error("inflight error usage was not zero");
    }
    sawError = true;
  }
  stub.setHealth("loading");
  await stub.resume();
  while (states[states.length - 1] !== "loading") {
    const message = asRecord(
      await session.next(remainingMs(deadline, "waiting for loading")),
      "restart loading",
    );
    note(message);
  }
  stub.setHealth("up");
  while (states[states.length - 1] !== "up") {
    const message = asRecord(
      await session.next(remainingMs(deadline, "waiting for up")),
      "restart up",
    );
    note(message);
  }
  if (states.join(" ") !== "up down loading up") {
    throw new Error(`status ${states.join(" ")}`);
  }
  stub.holdAfterFirstChunk(false);
  session.send({
    jsonrpc: "2.0",
    id: "3",
    method: "chat.send",
    params: { conversationId: "conv-restart", text: "after restart" },
  });
  const recovered = await session.response("3", 5000);
  if (!isRecord(recovered.result)) {
    throw new Error("recovery chat.send failed");
  }
  let recoveredFinish = "";
  while (recoveredFinish === "") {
    const message = asRecord(
      await session.next(remainingMs(deadline, "recovery")),
      "recovery",
    );
    note(message);
    if (message.method === "chat.done") {
      recoveredFinish = String(
        asRecord(message.params, "recovered").finishReason,
      );
    }
  }
  if (recoveredFinish !== "stop") {
    throw new Error(`recovery finishReason ${recoveredFinish}`);
  }
  if (states.join(" ") !== "up down loading up") {
    throw new Error(`status after recovery ${states.join(" ")}`);
  }
  session.send({ jsonrpc: "2.0", id: "4", method: "shutdown", params: {} });
  await session.response("4");
  const code = await session.waitForExit();
  if (code !== 0) {
    throw new Error(`core exit ${String(code)}`);
  }
  return [
    "ok",
    "status up down loading up",
    "inflight error",
    "recovered stop",
    "",
  ].join("\n");
}

async function doctor(kind: CoreKind, llama: LlamaMode): Promise<number> {
  if (!nodeSupportsTypeStripping(process.version)) {
    process.stdout.write(`not-ok\nnode ${process.version} requires >=22.6\n`);
    return 1;
  }
  try {
    readFileSync(schemaPath);
  } catch {
    process.stdout.write("not-ok\nmissing protocol schema\n");
    return 1;
  }
  const runDir = join(runtimeRoot(), `doctor-${process.pid}-${Date.now()}`);
  const dataDir = join(runDir, "data");
  rememberScratch(runDir);
  const port = effectiveLlamaPort(llama);
  let stub: LlamaStub | null = null;
  let session: CoreSession | null = null;
  try {
    if (kind === "real" && llama === "stub") {
      stub = await startLlamaStub(Number(llamaPort));
    }
    session = CoreSession.spawn(dataDir, "0", kind, llama);
    await initialize(session, "1", kind, port);
    if (
      llama === "stub" &&
      kind === "real" &&
      (stub === null || stub.healthHits < 1)
    ) {
      throw new Error("core did not probe /health");
    }
    // Any non-empty stderr fails. The type-stripping ExperimentalWarning
    // is kept off this stream by TYPE_STRIP_NODE_ARGS, not by ignoring it.
    const stderr = session.stderrText().trim();
    if (stderr !== "") {
      throw new Error(`stderr: ${stderr}`);
    }
    session.send({ jsonrpc: "2.0", id: "2", method: "shutdown", params: {} });
    await session.response("2");
    const code = await session.waitForExit();
    if (code !== 0) {
      throw new Error(`exit ${String(code)}`);
    }
    process.stdout.write(
      [
        "ok",
        `node ${process.version}`,
        `protocolVersion ${PROTOCOL_VERSION}`,
        `server ${expectedServer(kind)}`,
        `runtime up ${expectedModel(kind)}`,
        `llamaPort ${port}`,
        kind === "real" ? "sockets loopback" : "sockets none",
        "",
      ].join("\n"),
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "doctor failed";
    process.stdout.write(`not-ok\n${message}\n`);
    return 1;
  } finally {
    if (session !== null) {
      await session.dispose();
      forgetPid(session.pid);
    }
    await stub?.close();
  }
}

function commandLines(
  args: string,
  dataDir: string,
  deltaMs: string,
  port: string,
): string {
  return [
    `.cursor/skills/verify-cookie/bin/drive-core ${args}`,
    `COOKIE_DATA_DIR=${dataDir}`,
    `COOKIE_LLAMA_PORT=${port}`,
    `COOKIE_FAKE_DELTA_MS=${deltaMs}`,
    "",
  ].join("\n");
}

async function writeEvidence(
  evidenceDir: string,
  args: string,
  dataDir: string,
  deltaMs: string,
  port: string,
  session: CoreSession,
  summary: string,
  timings?: string,
): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  const lines = session.transcript
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  await writeFile(
    join(evidenceDir, "command.txt"),
    commandLines(args, dataDir, deltaMs, port),
  );
  await writeFile(
    join(evidenceDir, "transcript.jsonl"),
    lines === "" ? "" : `${lines}\n`,
  );
  await writeFile(join(evidenceDir, "stderr.txt"), session.stderrText());
  await writeFile(join(evidenceDir, "summary.txt"), summary);
  if (timings !== undefined) {
    await writeFile(join(evidenceDir, "timings.txt"), timings);
  }
}

function driveArgs(
  feature: DriveFeature,
  evidence: string,
  kind: CoreKind,
  llama: LlamaMode,
): string {
  const parts = [`drive ${feature} --evidence ${evidence}`];
  if (kind === "real") {
    parts.push("--core real");
  }
  if (llama === "external") {
    parts.push("--llama external");
  }
  return parts.join(" ");
}

async function driveFeature(
  feature: DriveFeature,
  evidence: string,
  kind: CoreKind,
  llama: LlamaMode,
): Promise<number> {
  const evidenceDir = resolve(repoRoot, evidence);
  const deltaMs = feature === "chat-streaming" ? "800" : "0";
  const runDir = join(runtimeRoot(), `${feature}-${process.pid}-${Date.now()}`);
  const dataDir = join(runDir, "data");
  rememberScratch(runDir);
  const port = effectiveLlamaPort(llama);
  const args = driveArgs(feature, evidence, kind, llama);
  let stub: LlamaStub | null = null;
  let session: CoreSession | null = null;
  let summary = "not-ok\n";
  let timings: string | undefined;
  let code = 1;
  try {
    if (kind === "real" && llama === "stub") {
      stub = await startLlamaStub(Number(llamaPort));
    }
    session = CoreSession.spawn(dataDir, deltaMs, kind, llama);
    if (feature === "chat-history") {
      const produced = await runChatHistory(session, port);
      summary = produced.summary;
      timings = produced.timings;
    } else if (feature === "runtime-restart") {
      if (stub === null) {
        throw new Error("runtime-restart has no llama stub");
      }
      summary = await runRuntimeRestart(session, stub);
    } else if (feature === "chat-streaming") {
      summary = await runChat(session, kind, stub);
    } else {
      summary = await runModelStatus(session, kind);
    }
    // Any non-empty stderr fails, except the restart drive's stream error.
    // The type-stripping ExperimentalWarning is not that error. Spawn flags
    // remove it; this check does not.
    const stderr = session.stderrText().trim();
    if (stderr !== "" && feature !== "runtime-restart") {
      throw new Error(`stderr: ${stderr}`);
    }
    code = 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "drive failed";
    summary = `not-ok\n${message}\n`;
    timings = undefined;
    code = 1;
  } finally {
    if (session !== null) {
      await session.dispose();
      forgetPid(session.pid);
      await writeEvidence(
        evidenceDir,
        args,
        dataDir,
        deltaMs,
        port,
        session,
        summary,
        timings,
      );
    }
    await stub?.close();
  }
  process.stdout.write(summary);
  return code;
}

function unreachable(): number {
  if (process.platform !== "darwin") {
    process.stdout.write("verified-unreachable on Linux: requires macOS\n");
  } else {
    process.stdout.write(
      "verified-unreachable: requires the Mac app from task B\n",
    );
  }
  return 2;
}

function usage(): number {
  process.stderr.write(
    [
      "usage:",
      "  drive-core doctor [--core fake|real] [--llama stub|external]",
      "  drive-core drive chat-streaming --evidence <dir> [--core fake|real]",
      "  drive-core drive model-status --evidence <dir> [--core fake|real]",
      "  drive-core drive chat-history --evidence <dir> --core real --llama external",
      "  drive-core drive runtime-restart --evidence <dir> --core real",
      "  drive-core drive menu-bar-icon",
      "  drive-core drive hotkey-popup",
      "  drive-core cleanup",
      "",
    ].join("\n"),
  );
  return 2;
}

function evidenceArg(rest: string[]): string | null {
  const index = rest.indexOf("--evidence");
  if (index < 0) {
    return null;
  }
  const value = rest[index + 1];
  if (value === undefined || value.startsWith("--")) {
    return null;
  }
  return value;
}

function coreKind(args: string[]): CoreKind | null {
  const index = args.indexOf("--core");
  if (index < 0) {
    return "fake";
  }
  const value = args[index + 1];
  if (value === "fake" || value === "real") {
    return value;
  }
  return null;
}

function llamaMode(args: string[]): LlamaMode | null {
  const index = args.indexOf("--llama");
  if (index < 0) {
    return "stub";
  }
  const value = args[index + 1];
  if (value === "stub" || value === "external") {
    return value;
  }
  return null;
}

async function main(argv: string[]): Promise<number> {
  const [command, feature, ...rest] = argv;
  if (command === "doctor") {
    const kind = coreKind(argv.slice(1));
    const llama = llamaMode(argv.slice(1));
    if (
      kind === null ||
      llama === null ||
      (llama === "external" && kind !== "real")
    ) {
      return usage();
    }
    return doctor(kind, llama);
  }
  if (command === "cleanup") {
    return cleanupAsync();
  }
  if (command !== "drive") {
    return usage();
  }
  if (feature === "menu-bar-icon" || feature === "hotkey-popup") {
    return unreachable();
  }
  if (
    feature !== "chat-streaming" &&
    feature !== "model-status" &&
    feature !== "chat-history" &&
    feature !== "runtime-restart"
  ) {
    return usage();
  }
  const evidence = evidenceArg(rest);
  if (evidence === null) {
    return usage();
  }
  const kind = coreKind(rest);
  const llama = llamaMode(rest);
  if (
    kind === null ||
    llama === null ||
    (llama === "external" && kind !== "real")
  ) {
    return usage();
  }
  if (feature === "chat-history" && llama !== "external") {
    process.stderr.write(
      "chat-history requires --core real --llama external\n",
    );
    return usage();
  }
  if (feature === "runtime-restart" && (kind !== "real" || llama !== "stub")) {
    process.stderr.write(
      "runtime-restart requires --core real and the built-in stub\n",
    );
    return usage();
  }
  return driveFeature(feature, evidence, kind, llama);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isDirectRun()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : "verify-drive failed";
      process.stderr.write(`${message}\n`);
      process.exit(1);
    });
}
