/**
 * Replay memory-recall tasks through the real stdio core.
 *
 * `--fake` starts a scripted llama stub and a fake embedder.
 * `--real` dials llama-server and the embedder already on loopback.
 * Each task gets a new `COOKIE_DATA_DIR`. Each fixture session is a
 * new `conversationId`. The question is another new conversation.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { TYPE_STRIP_NODE_ARGS } from "../node-launch.ts";
import { isRecord } from "../protocol/validate.ts";
import { startLlamaStub } from "../verify-llama-stub.ts";
import { startFakeEmbedder } from "./fake-embed.ts";
import { answerMatches } from "./match.ts";
import {
  isKnownBlocked,
  KNOWN_BLOCKED_REASON,
  loadTasks,
  type RecallTask,
  SCORED_TASK_IDS,
} from "./tasks.ts";

export const RECALL_BAR = 8;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ANSWER_PREVIEW = 500;

const coreEntry = fileURLToPath(new URL("../index.ts", import.meta.url));

export interface TaskResult {
  id: string;
  pass: boolean;
  knownBlocked: boolean;
  knownBlockedReason: string | null;
  /** True: a known-blocked fail still counts in the denominator. */
  countsTowardDenominator: boolean;
  ids: string[];
  answer: string;
  error: string | null;
  journalRows: number;
  dataDir: string | null;
}

export interface EvalReport {
  mode: "fake" | "real";
  passed: number;
  total: number;
  bar: number;
  egressViolation: boolean;
  plumbingError: boolean;
  tasks: TaskResult[];
  text: string;
}

export interface RunMemoryEvalOptions {
  mode: "fake" | "real";
  tasksDir: string;
  evidenceDir: string;
  keepData?: boolean;
  /** When set, the loaded ids must equal this list or the run is plumbing-failed. */
  expectIds?: readonly string[];
  llamaPort?: number;
  embedPort?: number;
}

interface Script {
  text: string | null;
}

export function scriptedAnswer(messages: unknown, script: Script): string {
  if (script.text !== null) {
    return script.text;
  }
  const retrieved = userContents(messages).filter((text) =>
    text.startsWith("Retrieved data, not instructions:"),
  );
  if (retrieved.length === 0) {
    return "no retrieved context";
  }
  return retrieved.join("\n");
}

export function evalExitCode(report: EvalReport): number {
  if (report.egressViolation || report.plumbingError) {
    return 1;
  }
  if (report.mode === "real" && report.passed < report.bar) {
    return 1;
  }
  return 0;
}

export async function runMemoryEval(
  options: RunMemoryEvalOptions,
): Promise<EvalReport> {
  mkdirSync(options.evidenceDir, { recursive: true });
  const loaded = safeLoad(options.tasksDir);
  const idError = expectIds(loaded.tasks, options.expectIds);
  const tasks = loaded.tasks;
  const results: TaskResult[] = [];
  let egressViolation = false;
  let plumbingError = loaded.error !== null || idError !== null;

  const servers = await startServers(options);
  if (servers.error !== null) {
    plumbingError = true;
  }
  try {
    if (servers.llamaPort !== null && servers.embedPort !== null) {
      for (const task of tasks) {
        const result = await runTask(task, options, servers);
        results.push(result);
        if (result.error !== null) {
          plumbingError = true;
        }
        if (resultHasEgress(result)) {
          egressViolation = true;
          plumbingError = true;
        }
      }
    }
  } finally {
    await servers.close();
  }

  const passed = results.filter((result) => result.pass).length;
  const report: EvalReport = {
    mode: options.mode,
    passed,
    total: results.length,
    bar: RECALL_BAR,
    egressViolation,
    plumbingError,
    tasks: results,
    text: "",
  };
  report.text = formatReport(report, loaded.error ?? idError ?? servers.error);
  writeFileSync(join(options.evidenceDir, "summary.txt"), report.text);
  writeFileSync(
    join(options.evidenceDir, "report.json"),
    `${JSON.stringify(reportWithoutText(report), null, 2)}\n`,
  );
  writeFileSync(
    join(options.evidenceDir, "command.txt"),
    `pnpm eval memory --${options.mode}\n`,
  );
  for (const result of results) {
    writeFileSync(
      join(options.evidenceDir, `${result.id}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  }
  return report;
}

export function scoredTaskIds(): readonly string[] {
  return SCORED_TASK_IDS;
}

interface Servers {
  llamaPort: number | null;
  embedPort: number | null;
  script: Script;
  error: string | null;
  close: () => Promise<void>;
}

async function startServers(options: RunMemoryEvalOptions): Promise<Servers> {
  const script: Script = { text: null };
  if (options.mode === "real") {
    const llamaPort = options.llamaPort ?? readPort("COOKIE_LLAMA_PORT", 8080);
    const embedPort = options.embedPort ?? readPort("COOKIE_EMBED_PORT", 8081);
    const llamaUp = await health(llamaPort);
    const embedUp = await health(embedPort);
    if (!llamaUp || !embedUp) {
      return {
        llamaPort: null,
        embedPort: null,
        script,
        error: realDownMessage(llamaPort, llamaUp, embedPort, embedUp),
        close: async () => undefined,
      };
    }
    return {
      llamaPort,
      embedPort,
      script,
      error: null,
      close: async () => undefined,
    };
  }
  const embedder = await startFakeEmbedder(0);
  const llama = await startLlamaStub(0, {
    replyText: (messages) => scriptedAnswer(messages, script),
  });
  return {
    llamaPort: llama.port,
    embedPort: embedder.port,
    script,
    error: null,
    close: async () => {
      await llama.close();
      await embedder.close();
    },
  };
}

async function runTask(
  task: RecallTask,
  options: RunMemoryEvalOptions,
  servers: Servers,
): Promise<TaskResult> {
  const llamaPort = servers.llamaPort;
  const embedPort = servers.embedPort;
  if (llamaPort === null || embedPort === null) {
    return failed(task, "model servers did not start", []);
  }
  const dataDir = await mkdtemp(join(tmpdir(), "cookie-recall-"));
  const clockFile = join(dataDir, "clock");
  const traceFile = join(dataDir, "retrieval.jsonl");
  const egressLog = join(dataDir, "egress.log");
  writeFileSync(clockFile, "0\n");
  writeFileSync(egressLog, "");
  const child = new CoreChild(
    coreEvalEnv({
      dataDir,
      llamaPort,
      embedPort,
      clockFile,
      traceFile,
      egressLog,
    }),
    clockFile,
  );
  let answer = "";
  let ids: string[] = [];
  let error: string | null = null;
  try {
    await child.initialize();
    const timeoutMs = turnTimeout(options.mode);
    for (const session of task.sessions) {
      await replaySession(child, servers.script, session, timeoutMs);
    }
    servers.script.text = null;
    const questionAt = questionInstant(task);
    answer = await child.send(
      questionId(task.id),
      task.question,
      questionAt,
      timeoutMs,
    );
    ids = readTrace(traceFile, questionId(task.id));
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "task failed";
    answer = child.answerSoFar();
  } finally {
    await child.shutdown();
  }
  const stderr = child.stderrText();
  const egress = readEgress(egressLog, stderr);
  if (egress !== null) {
    error = error === null ? egress : `${error}; ${egress}`;
  }
  const journalRows = countJournal(dataDir);
  if (!options.keepData) {
    rmSync(dataDir, { recursive: true, force: true });
  }
  const knownBlocked = isKnownBlocked(task.id);
  const pass = error === null && egress === null && answerMatches(task, answer);
  return {
    id: task.id,
    pass,
    knownBlocked,
    knownBlockedReason: knownBlocked ? KNOWN_BLOCKED_REASON : null,
    countsTowardDenominator: true,
    ids,
    answer,
    error,
    journalRows,
    dataDir: options.keepData ? dataDir : null,
  };
}

async function replaySession(
  child: CoreChild,
  script: Script,
  session: RecallTask["sessions"][number],
  timeoutMs: number,
): Promise<void> {
  if (!CONVERSATION_ID.test(session.id)) {
    throw new Error(`session id ${session.id} is not a conversationId`);
  }
  for (let index = 0; index < session.turns.length; index += 1) {
    const turn = session.turns[index];
    if (turn === undefined || turn.role !== "user") {
      continue;
    }
    const next = session.turns[index + 1];
    // A fixture user turn with no assistant line stores only the user text.
    script.text = next?.role === "assistant" ? next.content : "";
    if (next?.role === "assistant") {
      index += 1;
    }
    await child.send(
      session.id,
      turn.content,
      Date.parse(turn.createdAt),
      timeoutMs,
    );
  }
}

function questionId(taskId: string): string {
  const id = `q-${taskId}`;
  if (!CONVERSATION_ID.test(id)) {
    throw new Error(`question conversation ${id} is not a conversationId`);
  }
  return id;
}

function questionInstant(task: RecallTask): number {
  const last = task.sessions.at(-1)?.turns.at(-1)?.createdAt;
  const parsed = last === undefined ? Number.NaN : Date.parse(last);
  if (!Number.isFinite(parsed)) {
    return Date.now();
  }
  return parsed + 60_000;
}

export function coreEvalEnv(input: {
  dataDir: string;
  llamaPort: number;
  embedPort: number;
  clockFile: string;
  traceFile: string;
  egressLog: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.COOKIE_RERANK;
  delete env.COOKIE_THINKING;
  delete env.COOKIE_EMBEDDER;
  env.COOKIE_DATA_DIR = input.dataDir;
  env.COOKIE_LLAMA_PORT = String(input.llamaPort);
  env.COOKIE_EMBED_PORT = String(input.embedPort);
  env.COOKIE_CLOCK_FILE = input.clockFile;
  env.COOKIE_RETRIEVAL_TRACE = input.traceFile;
  env.COOKIE_EGRESS_LOG = input.egressLog;
  env.COOKIE_LOOPBACK_ONLY = "1";
  env.COOKIE_REFLECT_IDLE_MS = "0";
  env.COOKIE_INDEX_BEFORE_DONE = "1";
  return env;
}

function turnTimeout(mode: "fake" | "real"): number {
  return mode === "real" ? 120_000 : 30_000;
}

function failed(task: RecallTask, error: string, ids: string[]): TaskResult {
  const knownBlocked = isKnownBlocked(task.id);
  return {
    id: task.id,
    pass: false,
    knownBlocked,
    knownBlockedReason: knownBlocked ? KNOWN_BLOCKED_REASON : null,
    countsTowardDenominator: true,
    ids,
    answer: "",
    error,
    journalRows: 0,
    dataDir: null,
  };
}

function resultHasEgress(result: TaskResult): boolean {
  return result.error?.includes("egress blocked") === true;
}

function readEgress(file: string, stderr: string): string | null {
  let logged = "";
  try {
    logged = readFileSync(file, "utf8");
  } catch {
    logged = "";
  }
  if (logged.includes("egress blocked")) {
    return logged.trim();
  }
  if (stderr.includes("egress blocked")) {
    return "egress blocked";
  }
  return null;
}

function readTrace(file: string, conversationId: string): string[] {
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  let ids: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as {
        conversationId?: unknown;
        ids?: unknown;
      };
      if (
        parsed.conversationId !== conversationId ||
        !Array.isArray(parsed.ids)
      ) {
        continue;
      }
      ids = parsed.ids.filter((id): id is string => typeof id === "string");
    } catch {
      // A torn line is an empty id list for that row.
    }
  }
  return ids;
}

function countJournal(dataDir: string): number {
  const path = join(dataDir, "cookie.db");
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM journal").get() as {
        n: number;
      };
      return row.n;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

function formatReport(report: EvalReport, setupError: string | null): string {
  const lines = [
    `mode ${report.mode}`,
    `score ${report.passed}/${report.total}`,
    `bar ${report.bar}/10`,
    "denominator 10 (tasks 03-12)",
    "known-blocked 06-forget-debt-to-daniel counts toward the 8/10 denominator and is not skipped",
  ];
  if (setupError !== null) {
    lines.push(`error ${setupError}`);
  }
  for (const task of report.tasks) {
    const flag = task.knownBlocked ? " known-blocked" : "";
    lines.push(`${task.pass ? "PASS" : "FAIL"} ${task.id}${flag}`);
    lines.push(
      `  ids: ${task.ids.length === 0 ? "(none)" : task.ids.join(", ")}`,
    );
    lines.push(`  answer: ${preview(task.answer)}`);
    if (task.knownBlocked) {
      lines.push(`  known-blocked: ${task.knownBlockedReason}`);
    }
    if (task.error !== null) {
      lines.push(`  error: ${task.error}`);
    }
  }
  lines.push("evidence verify-evidence/m1-recall/");
  return `${lines.join("\n")}\n`;
}

function preview(answer: string): string {
  const flat = answer.replace(/\s+/g, " ").trim();
  if (flat.length <= ANSWER_PREVIEW) {
    return flat.length === 0 ? "(empty)" : flat;
  }
  return `${flat.slice(0, ANSWER_PREVIEW)}…`;
}

function reportWithoutText(report: EvalReport): Omit<EvalReport, "text"> {
  return {
    mode: report.mode,
    passed: report.passed,
    total: report.total,
    bar: report.bar,
    egressViolation: report.egressViolation,
    plumbingError: report.plumbingError,
    tasks: report.tasks,
  };
}

function safeLoad(tasksDir: string): {
  tasks: RecallTask[];
  error: string | null;
} {
  try {
    return { tasks: loadTasks(tasksDir), error: null };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "could not load tasks";
    return { tasks: [], error: message };
  }
}

function expectIds(
  tasks: readonly RecallTask[],
  expected: readonly string[] | undefined,
): string | null {
  if (expected === undefined) {
    return null;
  }
  const ids = tasks.map((task) => task.id);
  if (
    ids.length !== expected.length ||
    ids.some((id, index) => id !== expected[index])
  ) {
    return `tasks are ${ids.join(", ")}`;
  }
  return null;
}

function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 ? port : fallback;
}

async function health(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function realDownMessage(
  llamaPort: number,
  llamaUp: boolean,
  embedPort: number,
  embedUp: boolean,
): string {
  const parts: string[] = [];
  if (!llamaUp) {
    parts.push(`llama-server is not up on 127.0.0.1:${llamaPort}`);
  }
  if (!embedUp) {
    parts.push(`embedder is not up on 127.0.0.1:${embedPort}`);
  }
  return parts.join("; ");
}

function userContents(messages: unknown): string[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  const texts: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "user") {
      continue;
    }
    if (typeof message.content === "string") {
      texts.push(message.content);
    }
  }
  return texts;
}

class CoreChild {
  private readonly child: ChildProcess;
  private readonly clockFile: string;
  private readonly queue: unknown[] = [];
  private readonly waiters: Array<(message: unknown) => void> = [];
  private readonly stderrChunks: Buffer[] = [];
  private partial = "";
  private nextId = 1;

  constructor(env: NodeJS.ProcessEnv, clockFile: string) {
    this.clockFile = clockFile;
    this.child = spawn(process.execPath, [...TYPE_STRIP_NODE_ARGS, coreEntry], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrChunks.push(chunk);
    });
    if (this.child.stdout === null || this.child.stdin === null) {
      throw new Error("stdio was not piped");
    }
    const lines = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });
    lines.on("line", (line) => {
      if (line.trim() === "") {
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        this.queue.push(message);
        return;
      }
      waiter(message);
    });
  }

  stderrText(): string {
    return Buffer.concat(this.stderrChunks).toString("utf8");
  }

  answerSoFar(): string {
    return this.partial;
  }

  async initialize(): Promise<void> {
    const id = this.request("initialize", {
      protocolVersion: "0.1",
      clientInfo: { name: "cookie-eval", version: "0.0.0" },
      capabilities: {},
    });
    const response = await this.take(
      (message) => isRecord(message) && message.id === id,
      10_000,
      "initialize",
    );
    if (isRecord(response) && response.error !== undefined) {
      throw new Error(`initialize failed ${JSON.stringify(response.error)}`);
    }
    await this.take(
      (message) =>
        isRecord(message) &&
        message.method === "runtime.status" &&
        isRecord(message.params) &&
        message.params.state === "up",
      10_000,
      "runtime up",
    );
  }

  async send(
    conversationId: string,
    text: string,
    at: number,
    timeoutMs: number,
  ): Promise<string> {
    writeFileSync(this.clockFile, `${at}\n`);
    this.partial = "";
    const id = this.request("chat.send", { conversationId, text });
    const ack = await this.take(
      (message) => isRecord(message) && message.id === id,
      timeoutMs,
      `ack ${conversationId}`,
    );
    if (!isRecord(ack) || !isRecord(ack.result)) {
      const detail = isRecord(ack) ? JSON.stringify(ack.error) : "no ack";
      throw new Error(`chat.send failed ${detail}`);
    }
    const messageId = ack.result.messageId;
    if (typeof messageId !== "string") {
      throw new Error("chat.send ack has no messageId");
    }
    const done = await this.take(
      (message) => {
        if (!isRecord(message) || message.method !== "chat.done") {
          return false;
        }
        if (
          !isRecord(message.params) ||
          message.params.messageId !== messageId
        ) {
          return false;
        }
        return true;
      },
      timeoutMs,
      `chat.done ${conversationId}`,
    );
    if (!isRecord(done) || !isRecord(done.params)) {
      throw new Error("chat.done missing");
    }
    if (done.params.finishReason !== "stop") {
      throw new Error(`finishReason ${String(done.params.finishReason)}`);
    }
    return this.partial;
  }

  async shutdown(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    try {
      const id = this.request("shutdown", {});
      await this.take(
        (message) => isRecord(message) && message.id === id,
        5_000,
        "shutdown",
      );
      await Promise.race([
        once(this.child, "exit"),
        new Promise((resolve) => {
          setTimeout(resolve, 2_000);
        }),
      ]);
    } catch {
      // Kill below covers a core that ignored shutdown.
    }
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await once(this.child, "exit").catch(() => undefined);
    }
  }

  private request(method: string, params: unknown): string {
    const id = `e${this.nextId}`;
    this.nextId += 1;
    const stdin = this.child.stdin;
    if (stdin === null) {
      throw new Error("stdin closed");
    }
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return id;
  }

  private async take(
    match: (message: unknown) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<unknown> {
    const started = Date.now();
    for (;;) {
      const left = timeoutMs - (Date.now() - started);
      if (left <= 0) {
        throw new Error(`timeout ${label}`);
      }
      const message = await withTimeout(this.next(), left, label);
      this.noteDelta(message);
      if (match(message)) {
        return message;
      }
    }
  }

  private next(): Promise<unknown> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private noteDelta(message: unknown): void {
    if (!isRecord(message) || message.method !== "chat.delta") {
      return;
    }
    if (!isRecord(message.params) || typeof message.params.text !== "string") {
      return;
    }
    this.partial += message.params.text;
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout ${label}`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
