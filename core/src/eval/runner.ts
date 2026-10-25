/**
 * Replay memory-recall tasks through the real stdio core.
 *
 * `--fake` starts a scripted llama stub and a fake embedder.
 * `--real` dials llama-server and the embedder already on loopback.
 * Each task gets a new `COOKIE_DATA_DIR`. Each fixture session is a
 * new `conversationId`. The question is another new conversation.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loopbackGuardLine } from "../loopback-guard.ts";
import { SqliteMemoryStore } from "../memory/sqlite-store.ts";
import { TYPE_STRIP_NODE_ARGS } from "../node-launch.ts";
import { isRecord } from "../protocol/validate.ts";
import { startLlamaStub } from "../verify-llama-stub.ts";
import { startFakeEmbedder } from "./fake-embed.ts";
import { answerMatches } from "./match.ts";
import {
  FORGET_TASK_ID,
  KNOWN_BLOCKED_REASON,
  loadTasks,
  type RecallTask,
  SCORED_TASK_IDS,
  storedTurnId,
} from "./tasks.ts";

export { storedTurnId };

export const RECALL_BAR = 8;

/**
 * `--fake` passes when an expected id is inside this prefix and no
 * distractor is ranked above it. The cutoff is fixed. It is not an env knob.
 */
export const FAKE_RETRIEVAL_TOP = 8;

/**
 * `--fake` exits 1 below this many passes.
 * The denominator is 9: tasks 03–12, with 04 real-only.
 */
export const FAKE_RETRIEVAL_BAR = 8;

/** Reflect JSON `parseReflectExtraction` accepts with no facts. */
export const EMPTY_REFLECT_REPLY =
  '{"journal":"","summary":"","facts":[],"profile":[]}';

/**
 * `--real` does not dial John's servers. Ports come from flags or env.
 */
export const REAL_PORTS_REQUIRED =
  "--real needs --llama-port and --embed-port, or COOKIE_LLAMA_PORT and COOKIE_EMBED_PORT. It does not default to 8080 or 8081.";

/** #18's reflect system prompt. A fixture reply must not answer it. */
const REFLECT_MARK = "You extract memory for Cookie";

const DEBT_TURN_NEEDLE = "owe Daniel $40";
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
  if (isReflectPrompt(messages)) {
    return EMPTY_REFLECT_REPLY;
  }
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

export function resolveRealPorts(
  options: { llamaPort?: number; embedPort?: number },
  env: NodeJS.ProcessEnv,
): { llamaPort: number; embedPort: number } | { error: string } {
  const llamaPort =
    usablePort(options.llamaPort) ?? portFromEnv(env.COOKIE_LLAMA_PORT);
  const embedPort =
    usablePort(options.embedPort) ?? portFromEnv(env.COOKIE_EMBED_PORT);
  if (llamaPort === null || embedPort === null) {
    return { error: REAL_PORTS_REQUIRED };
  }
  return { llamaPort, embedPort };
}

function usablePort(port: number | undefined): number | null {
  if (port === undefined) {
    return null;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return port;
}

function portFromEnv(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") {
    return null;
  }
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  return usablePort(Number(raw));
}

/**
 * Forward one completion to llama-server. Fixture replies never get here.
 * `temperature` is 0 and streaming is off so the text is one JSON body.
 */
export async function completeAtTemperatureZero(
  port: number,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, temperature: 0, stream: false }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`llama-server status ${response.status}`);
  }
  const parsed = (await response.json()) as {
    choices?: Array<{
      message?: { content?: unknown; tool_calls?: unknown };
    }>;
  };
  const message = parsed.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    return "";
  }
  throw new Error("llama-server reply has no content");
}

/** True when `line` is one full stderr line, not a substring of a longer one. */
export function stderrHasExactLine(stderr: string, line: string): boolean {
  return stderr.split(/\r?\n/).some((row) => row === line);
}

/** Save `/props` and `/v1/models` for one real server. A 404 is still saved. */
export async function writeServerEvidence(
  dir: string,
  label: string,
  port: number,
): Promise<void> {
  await writeEndpoint(dir, label, port, "/props");
  await writeEndpoint(dir, label, port, "/v1/models");
}

async function writeEndpoint(
  dir: string,
  label: string,
  port: number,
  path: string,
): Promise<void> {
  const file = join(dir, `${label}${path.replace(/\//g, "-")}.json`);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      signal: AbortSignal.timeout(2_000),
    });
    const body = await response.text();
    writeFileSync(
      file,
      `${JSON.stringify({ status: response.status, body }, null, 2)}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    writeFileSync(file, `${JSON.stringify({ error: message }, null, 2)}\n`);
  }
}

export function clearEvalDataDirs(dirs: readonly string[]): void {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Delete every dir in `dirs` on SIGINT, SIGTERM, and an uncaught crash,
 * then exit. `exit` is injectable so a test can emit the signal.
 */
export function attachEvalDataCleanup(
  dirs: readonly string[],
  exit: (code: number) => void = (code) => {
    process.exit(code);
  },
): () => void {
  const onStop = (): void => {
    clearEvalDataDirs(dirs);
    exit(1);
  };
  process.on("SIGINT", onStop);
  process.on("SIGTERM", onStop);
  process.on("uncaughtException", onStop);
  return () => {
    process.off("SIGINT", onStop);
    process.off("SIGTERM", onStop);
    process.off("uncaughtException", onStop);
  };
}

/**
 * True when some expected id is in the top {@link FAKE_RETRIEVAL_TOP},
 * every required id is in that top, and no distractor ranks above the
 * best expected id or above any required id.
 */
export function retrievalHit(
  ids: readonly string[],
  expected: readonly string[],
  distractors: readonly string[],
  required: readonly string[] = [],
): boolean {
  const top = ids.slice(0, FAKE_RETRIEVAL_TOP);
  for (const id of required) {
    if (!top.includes(id)) {
      return false;
    }
  }
  let best = -1;
  for (const id of expected) {
    const at = top.indexOf(id);
    if (at >= 0 && (best < 0 || at < best)) {
      best = at;
    }
  }
  if (best < 0) {
    return false;
  }
  for (const id of distractors) {
    const at = top.indexOf(id);
    if (at < 0) {
      continue;
    }
    if (at < best) {
      return false;
    }
    for (const requiredId of required) {
      const requiredAt = top.indexOf(requiredId);
      if (requiredAt >= 0 && at < requiredAt) {
        return false;
      }
    }
  }
  return true;
}

export function evalExitCode(report: EvalReport): number {
  if (report.egressViolation || report.plumbingError) {
    return 1;
  }
  if (report.mode === "fake") {
    return report.passed < FAKE_RETRIEVAL_BAR ? 1 : 0;
  }
  if (report.passed < report.bar) {
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
  const owned: string[] = [];
  const detach = attachEvalDataCleanup(owned);
  if (servers.error !== null) {
    plumbingError = true;
  }
  try {
    if (servers.llamaPort !== null && servers.embedPort !== null) {
      for (const task of tasks) {
        const result = await runTask(task, options, servers, owned);
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
    detach();
    if (!options.keepData) {
      clearEvalDataDirs(owned);
    }
    await servers.close();
  }

  const counted = results.filter((result) => result.countsTowardDenominator);
  const passed = counted.filter((result) => result.pass).length;
  const report: EvalReport = {
    mode: options.mode,
    passed,
    total: counted.length,
    bar: options.mode === "fake" ? FAKE_RETRIEVAL_BAR : RECALL_BAR,
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
    const ports = resolveRealPorts(options, process.env);
    if ("error" in ports) {
      return {
        llamaPort: null,
        embedPort: null,
        script,
        error: ports.error,
        close: async () => undefined,
      };
    }
    const llamaUp = await health(ports.llamaPort);
    const embedUp = await health(ports.embedPort);
    if (!llamaUp || !embedUp) {
      return {
        llamaPort: null,
        embedPort: null,
        script,
        error: realDownMessage(
          ports.llamaPort,
          llamaUp,
          ports.embedPort,
          embedUp,
        ),
        close: async () => undefined,
      };
    }
    await writeServerEvidence(options.evidenceDir, "llama", ports.llamaPort);
    await writeServerEvidence(options.evidenceDir, "embed", ports.embedPort);
    // The core talks to the stub. Fixture assistant lines are the script.
    // Reflect and the final question have no script, so they are forwarded
    // to the real server at temperature 0.
    const llama = await startLlamaStub(0, {
      replyText: (messages, body) =>
        scriptedOrReal(messages, body, script, ports.llamaPort),
    });
    return {
      llamaPort: llama.port,
      embedPort: ports.embedPort,
      script,
      error: null,
      close: async () => {
        await llama.close();
      },
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

function scriptedOrReal(
  messages: unknown,
  body: Record<string, unknown> | undefined,
  script: Script,
  realPort: number,
): string | Promise<string> {
  if (isReflectPrompt(messages)) {
    return EMPTY_REFLECT_REPLY;
  }
  if (script.text !== null) {
    return script.text;
  }
  return completeAtTemperatureZero(realPort, body ?? { messages });
}

function isReflectPrompt(messages: unknown): boolean {
  return JSON.stringify(messages).includes(REFLECT_MARK);
}

async function runTask(
  task: RecallTask,
  options: RunMemoryEvalOptions,
  servers: Servers,
  owned: string[],
): Promise<TaskResult> {
  const llamaPort = servers.llamaPort;
  const embedPort = servers.embedPort;
  if (llamaPort === null || embedPort === null) {
    return failed(task, "model servers did not start", []);
  }
  const dataDir = await mkdtemp(join(tmpdir(), "cookie-recall-"));
  owned.push(dataDir);
  const clockFile = join(dataDir, "clock");
  const traceFile = join(dataDir, "retrieval.jsonl");
  const egressLog = join(dataDir, "egress.log");
  const loopbackNonce = randomBytes(16).toString("hex");
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
      loopbackNonce,
      lexicalOnly: options.mode === "fake",
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
  if (!stderrHasExactLine(stderr, loopbackGuardLine(loopbackNonce))) {
    const missing = "loopback guard was not reported";
    error = error === null ? missing : `${error}; ${missing}`;
  }
  const journalRows = countJournal(dataDir);
  const forgotten = forgottenProbeFor(task.id, dataDir);
  if (!options.keepData) {
    rmSync(dataDir, { recursive: true, force: true });
    const at = owned.indexOf(dataDir);
    if (at >= 0) {
      owned.splice(at, 1);
    }
  }
  const clean = error === null && egress === null;
  const answerPass = clean && answerMatches(task, answer);
  const ranked = retrievalHit(
    ids,
    task.expectedIds ?? [],
    task.distractorIds ?? [],
    task.requiredIds ?? [],
  );
  const realOnly = task.realOnly === true && options.mode === "fake";
  let knownBlocked = false;
  let pass = options.mode === "fake" ? clean && ranked : answerPass;
  if (realOnly) {
    pass = false;
  }
  if (task.id === FORGET_TASK_ID) {
    if (forgotten === null) {
      knownBlocked = true;
      pass = false;
    } else {
      const debtId = storedTurnId(task.sessions, DEBT_TURN_NEEDLE);
      const forgot =
        forgotten !== undefined &&
        debtId !== null &&
        forgotten.includes(debtId);
      pass = pass && forgot;
    }
  }
  return {
    id: task.id,
    pass,
    knownBlocked,
    knownBlockedReason: knownBlocked ? KNOWN_BLOCKED_REASON : null,
    countsTowardDenominator: !realOnly,
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
    // Both modes replay the fixture assistant line through the stub.
    // A reflect prompt gets empty JSON. The final question leaves
    // `script.text` null, so --real forwards it at temperature 0.
    // TODO(#18): script 06's forget as a memory.forget tool call. The
    // assistant line above does not call the tool.
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
  loopbackNonce: string;
  /** `--fake` ignores vectors so the rank is BM25. */
  lexicalOnly?: boolean;
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
  env.COOKIE_LOOPBACK_NONCE = input.loopbackNonce;
  env.COOKIE_REFLECT_IDLE_MS = "0";
  env.COOKIE_INDEX_BEFORE_DONE = "1";
  if (input.lexicalOnly === true) {
    env.COOKIE_RRF_VECTOR = "0";
  }
  return env;
}

function turnTimeout(mode: "fake" | "real"): number {
  return mode === "real" ? 120_000 : 30_000;
}

function failed(task: RecallTask, error: string, ids: string[]): TaskResult {
  return {
    id: task.id,
    pass: false,
    knownBlocked: false,
    knownBlockedReason: null,
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
    `bar ${report.bar}/${report.total}`,
    report.mode === "fake"
      ? "denominator excludes 04-knee-squat-swap (real-only). The gate is the top 8, fixed."
      : "denominator 10 (tasks 03-12)",
    "06-forget-debt-to-daniel counts in the denominator. It is known-blocked when forgottenTurnIds() is missing, and it is not skipped.",
  ];
  if (setupError !== null) {
    lines.push(`error ${setupError}`);
  }
  for (const task of report.tasks) {
    const flag = task.knownBlocked ? " known-blocked" : "";
    const label = task.countsTowardDenominator
      ? `${task.pass ? "PASS" : "FAIL"} ${task.id}${flag}`
      : `REAL-ONLY ${task.id}`;
    lines.push(label);
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

/**
 * Forgotten ids for task 06. A throw fails that task only:
 * null is the known-blocked result, and other tasks do not call the probe.
 */
export function forgottenProbeFor(
  taskId: string,
  dataDir: string,
  probe: (dir: string) => string[] | null = probeForgottenTurnIds,
): string[] | null | undefined {
  if (taskId !== FORGET_TASK_ID) {
    return undefined;
  }
  try {
    return probe(dataDir);
  } catch {
    return null;
  }
}

/**
 * `store.forgottenTurnIds()` with no callback.
 * Null means the method is not on this store (#18 has not landed).
 */
function probeForgottenTurnIds(dataDir: string): string[] | null {
  const path = join(dataDir, "cookie.db");
  let store: SqliteMemoryStore;
  try {
    store = SqliteMemoryStore.open(path);
  } catch {
    return null;
  }
  try {
    const candidate = store as SqliteMemoryStore & {
      forgottenTurnIds?: () => string[];
    };
    if (typeof candidate.forgottenTurnIds !== "function") {
      return null;
    }
    const ids = candidate.forgottenTurnIds();
    if (!Array.isArray(ids)) {
      return null;
    }
    return ids.filter((id): id is string => typeof id === "string");
  } finally {
    store.close();
  }
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
