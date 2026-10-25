import type { ModelMessage } from "ai";
import type { ModelProvider } from "../model/provider.ts";
import type { StoreMaintenance } from "./consolidate-job.ts";
import { LocalConsolidator } from "./consolidate-job.ts";
import type { DerivedMemoryStore } from "./derived.ts";
import { InMemoryDerivedMemory, randomIds } from "./derived.ts";
import type { Embedder } from "./embedder.ts";
import { FakeEmbedder } from "./embedder.ts";
import type { MemoryHost } from "./host.ts";
import type { TextComplete } from "./reflect-job.ts";
import { LocalReflector } from "./reflect-job.ts";
import type { AcPower } from "./schedule.ts";
import {
  IdleScheduler,
  localDay,
  readReflectIdleMs,
  readTimeZone,
} from "./schedule.ts";
import type { TimerQueue } from "./slot.ts";
import { abortError, isAbortError, ModelSlot, systemTimers } from "./slot.ts";
import type { MemoryStore } from "./store.ts";
import { InMemoryMemoryStore } from "./store.ts";
import {
  createMemoryTools,
  MEMORY_SYSTEM_PROMPT,
  type MemoryToolState,
} from "./tools.ts";
import type { TurnRecord } from "./types.ts";
import type { VectorIndex } from "./vectors.ts";
import { InMemoryVectorIndex } from "./vectors.ts";

export interface MemoryRuntime {
  host: MemoryHost;
  scheduler: IdleScheduler;
  store: MemoryStore;
  derived: DerivedMemoryStore;
  slot: ModelSlot;
  start: () => void;
}

export interface MemoryRuntimeOptions {
  /**
   * Chat model. Reflect calls it through `complete` when that is set,
   * and through this provider otherwise. Step 2D replaces the embedder.
   */
  provider?: ModelProvider;
  complete?: TextComplete;
  store?: MemoryStore;
  derived?: DerivedMemoryStore;
  embedder?: Embedder;
  vectors?: VectorIndex;
  now?: () => number;
  idleMs?: number;
  timeZone?: string;
  timers?: TimerQueue;
  power?: AcPower;
  maintenance?: StoreMaintenance;
  modelId?: string;
  /**
   * When a ChatLog is also writing turns, set this false. Two writers
   * duplicate the user text in the prompt and mint different ids.
   */
  recordTurns?: boolean;
  /** Ids only. Forget must not log fact text. */
  log?: (message: string) => void;
}

/**
 * Wires remember, forget, reflect, and consolidation for one core.
 * The store and the embedder are injected so step 1A and step 2D can
 * replace the in-memory fakes without changing this job.
 */
export function createMemoryRuntime(
  options: MemoryRuntimeOptions = {},
): MemoryRuntime {
  const now = options.now ?? (() => Date.now());
  const timeZone = options.timeZone ?? readTimeZone();
  const store = options.store ?? new InMemoryMemoryStore();
  const derived = options.derived ?? new InMemoryDerivedMemory();
  const embedder = options.embedder ?? new FakeEmbedder();
  const vectors = options.vectors ?? new InMemoryVectorIndex();
  const slot = new ModelSlot();
  const sessions = new Set<string>();
  const writtenUserTurns = new Map<string, string>();
  const state: MemoryToolState = { sourceTurnId: null };
  const recordTurns = options.recordTurns !== false;
  const log =
    options.log ??
    ((message: string) => {
      process.stderr.write(`${message}\n`);
    });
  const factIds = randomIds("fact");
  const journalIds = randomIds("journal");
  const provider = options.provider;
  const complete =
    options.complete ??
    (provider === undefined
      ? async () => {
          throw new Error("reflect has no model");
        }
      : (args: Parameters<TextComplete>[0]) =>
          completeViaProvider(provider, args));
  const reflector = new LocalReflector({
    store,
    derived,
    embedder,
    vectors,
    complete,
    now,
    timeZone,
    localDay,
    factIds,
    journalIds,
    log,
  });
  const consolidator = new LocalConsolidator({
    derived,
    embedder,
    vectors,
    sessionIds: () => store.listSessions().map((session) => session.id),
    readTurns: (sessionId) => store.recentTurns(sessionId, 10_000),
    now,
    timeZone,
    localDay,
    ids: factIds,
    maintenance: options.maintenance,
    log,
  });
  const scheduler = new IdleScheduler({
    slot,
    derived,
    now,
    idleMs: options.idleMs ?? readReflectIdleMs(),
    timeZone,
    localDay,
    timers: options.timers ?? systemTimers(),
    power: options.power,
    sessionsToReflect: () =>
      store.listSessions({ needsReflect: true }).map((session) => {
        const latest = store.recentTurns(session.id, 1).at(-1);
        return {
          sessionId: session.id,
          lastTurnAt: latest?.createdAt ?? null,
        };
      }),
    reflect: async (sessionId, signal) => {
      await reflector.reflect(sessionId, { signal });
    },
    consolidate: async (signal) => {
      consolidator.bindSignal(signal);
      await consolidator.consolidate();
    },
  });
  const modelId = options.modelId ?? options.provider?.modelId ?? null;
  const host: MemoryHost = {
    systemPrompt: MEMORY_SYSTEM_PROMPT,
    tools: createMemoryTools({
      derived,
      store,
      embedder,
      vectors,
      state,
      now,
      ids: factIds,
      log,
    }),
    slot,
    onChatStarted(event) {
      scheduler.onChatStarted(event.conversationId);
      if (!recordTurns) {
        return;
      }
      const storedId = rememberTurn(store, sessions, {
        id: userTurnId(event.messageId),
        sessionId: event.conversationId,
        role: "user",
        content: event.userText,
        createdAt: now(),
        modelId,
      });
      writtenUserTurns.set(event.messageId, storedId);
      state.sourceTurnId = storedId;
    },
    noteUserTurn(turnId) {
      state.sourceTurnId = turnId;
    },
    storedUserTurnId(messageId) {
      return writtenUserTurns.get(messageId);
    },
    onChatSettled(event) {
      state.sourceTurnId = null;
      if (
        recordTurns &&
        event.assistantText.length > 0 &&
        !latestTurnIs(
          store,
          event.conversationId,
          "assistant",
          event.assistantText,
        )
      ) {
        rememberTurn(store, sessions, {
          id: assistantTurnId(event.messageId),
          sessionId: event.conversationId,
          role: "assistant",
          content: event.assistantText,
          createdAt: now(),
          modelId,
        });
      }
      scheduler.onChatSettled(event.conversationId);
    },
    onStop() {
      scheduler.stop();
    },
  };
  return {
    host,
    scheduler,
    store,
    derived,
    slot,
    start() {
      scheduler.start();
    },
  };
}

export async function completeViaProvider(
  provider: ModelProvider,
  args: Parameters<TextComplete>[0],
): Promise<string> {
  const messages: ModelMessage[] = [{ role: "user", content: args.prompt }];
  const stream = provider.streamChat({
    system: args.system,
    messages,
    abortSignal: args.signal,
  });
  let text = "";
  try {
    for await (const delta of stream.textDeltas) {
      if (args.signal.aborted) {
        throw abortError();
      }
      text += delta;
    }
    await stream.completion;
  } catch (error) {
    if (args.signal.aborted || isAbortError(error)) {
      throw abortError();
    }
    throw error;
  }
  if (args.signal.aborted) {
    throw abortError();
  }
  return text;
}

export function userTurnId(messageId: string): string {
  return `turn-${messageId}-user`;
}

export function assistantTurnId(messageId: string): string {
  return `turn-${messageId}-assistant`;
}

function rememberTurn(
  store: MemoryStore,
  sessions: Set<string>,
  turn: {
    id: string;
    sessionId: string;
    role: "user" | "assistant";
    content: string;
    createdAt: number;
    modelId: string | null;
  },
): string {
  if (!sessions.has(turn.sessionId)) {
    try {
      store.appendSession({
        id: turn.sessionId,
        surface: "popup",
        startedAt: turn.createdAt,
        endedAt: null,
        summary: null,
      });
    } catch (error) {
      if (!alreadyExists(error)) {
        throw error;
      }
    }
    sessions.add(turn.sessionId);
  }
  const record: TurnRecord = {
    id: turn.id,
    sessionId: turn.sessionId,
    role: turn.role,
    content: turn.content,
    tainted: false,
    model: turn.modelId,
    egress: false,
    escalatedFrom: null,
    tokensIn: null,
    tokensCached: null,
    tokensOut: null,
    costUsd: 0,
    latencyMs: null,
    createdAt: turn.createdAt,
  };
  try {
    store.appendTurn(record);
    return record.id;
  } catch (error) {
    if (!alreadyExists(error)) {
      throw error;
    }
  }
  const uniqueId = `${record.id}#${store.recentTurns(record.sessionId, 10_000).length + 1}`;
  try {
    store.appendTurn({ ...record, id: uniqueId });
    return uniqueId;
  } catch (error) {
    if (!alreadyExists(error)) {
      throw error;
    }
  }
  return record.id;
}

function alreadyExists(error: unknown): boolean {
  return error instanceof Error && /already exists/.test(error.message);
}

function latestTurnIs(
  store: MemoryStore,
  sessionId: string,
  role: "user" | "assistant",
  content: string,
): boolean {
  const latest = store.recentTurns(sessionId, 1).at(-1);
  return latest?.role === role && latest.content === content;
}
