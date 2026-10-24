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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fakeCorePath = join(repoRoot, "core/src/fake-core.ts");
const schemaPath = join(repoRoot, "protocol/schema/cookie-rpc.schema.json");
const llamaPort = "18080";
const readTimeoutMs = 5000;

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

  static spawn(dataDir: string, deltaMs: string): CoreSession {
    mkdirSync(dataDir, { recursive: true });
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", fakeCorePath],
      {
        cwd: repoRoot,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          COOKIE_DATA_DIR: dataDir,
          COOKIE_LLAMA_PORT: llamaPort,
          COOKIE_FAKE_DELTA_MS: deltaMs,
        },
      },
    );
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

  async next(): Promise<unknown> {
    const message = await this.queue.next(readTimeoutMs);
    this.record("server", message);
    if (!isCookieMessage(message)) {
      throw new Error(
        `schema rejected server message ${JSON.stringify(message)} ${messageErrors(message)}`,
      );
    }
    return message;
  }

  async response(id: string): Promise<Record<string, unknown>> {
    for (;;) {
      const message = await this.next();
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

function cmdlineIsFakeCore(pid: number): boolean {
  if (pid <= 1 || pid === process.pid) {
    return false;
  }
  try {
    const text = readFileSync(`/proc/${pid}/cmdline`).toString("utf8");
    return text.includes("fake-core.ts");
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

async function killFakeCore(pid: number): Promise<void> {
  if (!cmdlineIsFakeCore(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const started = Date.now();
  while (Date.now() - started < 500) {
    if (!cmdlineIsFakeCore(pid)) {
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
      await killFakeCore(pid);
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

async function assertNoSockets(pid: number): Promise<void> {
  if (process.platform !== "linux") {
    return;
  }
  const fdDir = `/proc/${pid}/fd`;
  const entries = await readdir(fdDir);
  for (const entry of entries) {
    // Node wires stdio as socket pairs. Those are fds 0, 1, and 2.
    if (entry === "0" || entry === "1" || entry === "2") {
      continue;
    }
    let target = "";
    try {
      target = readlinkSync(join(fdDir, entry));
    } catch {
      try {
        target = await readlink(join(fdDir, entry));
      } catch {
        continue;
      }
    }
    if (target.startsWith("socket:")) {
      throw new Error(`fake core pid ${pid} opened ${target}`);
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

async function initialize(session: CoreSession, id: string): Promise<void> {
  session.send(initializeMessage(id));
  const response = await session.response(id);
  const result = asRecord(response.result, "initialize result");
  if (result.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`protocolVersion ${String(result.protocolVersion)}`);
  }
  const serverInfo = asRecord(result.serverInfo, "serverInfo");
  if (serverInfo.name !== FAKE_SERVER_NAME) {
    throw new Error(`server ${String(serverInfo.name)}`);
  }
  const status = session.side.shift() ?? (await session.next());
  const note = asRecord(status, "runtime.status");
  if (note.method !== "runtime.status") {
    throw new Error("missing runtime.status after initialize");
  }
  const params = asRecord(note.params, "runtime.status params");
  if (params.state !== "up" || params.modelId !== FAKE_MODEL_ID) {
    throw new Error(
      `runtime ${String(params.state)} ${String(params.modelId)}`,
    );
  }
  await assertNoSockets(session.pid);
}

async function runChat(session: CoreSession): Promise<string> {
  await initialize(session, "1");
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
  if (deltas.length !== FAKE_REPLY_CHUNKS.length) {
    throw new Error(
      `expected ${FAKE_REPLY_CHUNKS.length} deltas, got ${deltas.length}`,
    );
  }
  if (deltas.join("") !== fakeReplyText()) {
    throw new Error("deltas did not form the canned reply");
  }
  const doneParams = asRecord(done.params, "chat.done");
  if (doneParams.finishReason !== "stop") {
    throw new Error(`finishReason ${String(doneParams.finishReason)}`);
  }
  const usage = asRecord(doneParams.usage, "usage");
  if (usage.inputTokens !== countWords(firstText)) {
    throw new Error(`inputTokens ${String(usage.inputTokens)}`);
  }
  if (usage.outputTokens !== countWords(fakeReplyText())) {
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
    throw new Error(`fake core exit ${String(code)}`);
  }
  return ["ok", "deltas 3", "finishReason stop", "cancelled true", ""].join(
    "\n",
  );
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

async function runModelStatus(session: CoreSession): Promise<string> {
  await initialize(session, "1");
  const initial = await queryStatus(session, "2");
  if (initial.state !== "up" || initial.modelId !== FAKE_MODEL_ID) {
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
  await pushStatus(session, "up", FAKE_MODEL_ID);
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
    throw new Error(`fake core exit ${String(code)}`);
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

async function doctor(): Promise<number> {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 22) {
    process.stdout.write(`not-ok\nnode ${process.version}\n`);
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
  const session = CoreSession.spawn(dataDir, "0");
  try {
    await initialize(session, "1");
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
        `server ${FAKE_SERVER_NAME}`,
        `runtime up ${FAKE_MODEL_ID}`,
        `llamaPort ${llamaPort}`,
        "sockets none",
        "",
      ].join("\n"),
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "doctor failed";
    process.stdout.write(`not-ok\n${message}\n`);
    return 1;
  } finally {
    await session.dispose();
    forgetPid(session.pid);
  }
}

function commandLines(args: string, dataDir: string, deltaMs: string): string {
  return [
    `.cursor/skills/verify-cookie/bin/drive-core ${args}`,
    `COOKIE_DATA_DIR=${dataDir}`,
    `COOKIE_LLAMA_PORT=${llamaPort}`,
    `COOKIE_FAKE_DELTA_MS=${deltaMs}`,
    "",
  ].join("\n");
}

async function writeEvidence(
  evidenceDir: string,
  args: string,
  dataDir: string,
  deltaMs: string,
  session: CoreSession,
  summary: string,
): Promise<void> {
  await mkdir(evidenceDir, { recursive: true });
  const lines = session.transcript
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  await writeFile(
    join(evidenceDir, "command.txt"),
    commandLines(args, dataDir, deltaMs),
  );
  await writeFile(
    join(evidenceDir, "transcript.jsonl"),
    lines === "" ? "" : `${lines}\n`,
  );
  await writeFile(join(evidenceDir, "stderr.txt"), session.stderrText());
  await writeFile(join(evidenceDir, "summary.txt"), summary);
}

async function driveFeature(
  feature: "chat-streaming" | "model-status",
  evidenceArg: string,
): Promise<number> {
  const evidenceDir = resolve(repoRoot, evidenceArg);
  const deltaMs = feature === "chat-streaming" ? "800" : "0";
  const runDir = join(runtimeRoot(), `${feature}-${process.pid}-${Date.now()}`);
  const dataDir = join(runDir, "data");
  rememberScratch(runDir);
  const session = CoreSession.spawn(dataDir, deltaMs);
  const args = `drive ${feature} --evidence ${evidenceArg}`;
  let summary = "not-ok\n";
  let code = 1;
  try {
    summary =
      feature === "chat-streaming"
        ? await runChat(session)
        : await runModelStatus(session);
    const stderr = session.stderrText().trim();
    if (stderr !== "") {
      throw new Error(`stderr: ${stderr}`);
    }
    code = 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "drive failed";
    summary = `not-ok\n${message}\n`;
    code = 1;
  } finally {
    await session.dispose();
    forgetPid(session.pid);
    await writeEvidence(evidenceDir, args, dataDir, deltaMs, session, summary);
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
      "  drive-core doctor",
      "  drive-core drive chat-streaming --evidence <dir>",
      "  drive-core drive model-status --evidence <dir>",
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

async function main(argv: string[]): Promise<number> {
  const [command, feature, ...rest] = argv;
  if (command === "doctor") {
    return doctor();
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
  if (feature !== "chat-streaming" && feature !== "model-status") {
    return usage();
  }
  const evidence = evidenceArg(rest);
  if (evidence === null) {
    return usage();
  }
  return driveFeature(feature, evidence);
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
