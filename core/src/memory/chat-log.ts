import { appendFileSync } from "node:fs";
import type { ModelMessage } from "ai";
import {
  LOCAL_RECENT_TURN_TOKEN_BUDGET,
  LOCAL_RETRIEVED_TOKEN_BUDGET,
  recentWithinBudget,
  renderRetrieved,
} from "../context.ts";
import type { ChatTurnCommit, ConversationHistory } from "../memory.ts";
import type { ContentIndexer } from "./index-content.ts";
import type { Reflector } from "./reflect.ts";
import type { Retrieve } from "./retrieve.ts";
import { abortError } from "./slot.ts";
import type { SqliteMemoryStore } from "./sqlite-store.ts";
import type { Memory } from "./types.ts";

/** A hung reflect must not hold the next chat turn. */
const DEFAULT_REFLECT_TIMEOUT_MS = 30_000;

export interface ChatLogHooks {
  /**
   * Set when `COOKIE_REFLECT_IDLE_MS` is a non-empty string.
   * Unset leaves this null. `"0"` still installs the hook.
   * The instance is `runtime.reflector`, the shared `LocalReflector`.
   */
  reflector?: Reflector | null;
  /** `COOKIE_RETRIEVAL_TRACE`. One JSON line per retrieve. */
  tracePath?: string | null;
  /** How long `reflect` may run before the chat continues. Default 30s. */
  reflectTimeoutMs?: number;
}

/**
 * How many live turns `messagesFor` keeps before the token budget.
 * Forgotten turns are removed first, so they do not use a slot.
 */
export const HISTORY_TURN_CAP = 20;

/** Rows read from SQLite before the forgotten-turn filter and the cap. */
const HISTORY_FETCH_LIMIT = 10_000;

/**
 * Turns in `cookie.db` for the real core.
 * The system prompt is not stored. The provider adds it on each call.
 * `egress` is false: this core only talks to loopback.
 * This is the only writer of turns when the sqlite history is attached.
 * `messagesFor` stores the user row and appends that text once.
 */
export class ChatLog implements ConversationHistory {
  private readonly store: SqliteMemoryStore;
  private readonly indexer: ContentIndexer | null;
  private readonly retriever: { retrieve: Retrieve } | null;
  private readonly reflector: Reflector | null;
  private readonly tracePath: string | null;
  private readonly reflectTimeoutMs: number;
  private readonly reflectPending = new Set<string>();
  private indexTail: Promise<void> = Promise.resolve();
  private lastUserTurnId: string | null = null;

  constructor(
    store: SqliteMemoryStore,
    indexer: ContentIndexer | null = null,
    retriever: { retrieve: Retrieve } | null = null,
    hooks: ChatLogHooks = {},
  ) {
    this.store = store;
    this.indexer = indexer;
    this.retriever = retriever;
    this.reflector = hooks.reflector ?? null;
    this.tracePath = hooks.tracePath ?? null;
    this.reflectTimeoutMs =
      hooks.reflectTimeoutMs ?? DEFAULT_REFLECT_TIMEOUT_MS;
  }

  /**
   * Resolves when indexing started by `commit` has finished.
   * `COOKIE_INDEX_BEFORE_DONE=1` keeps calling until the backlog is empty
   * so one 64-chunk pass cannot leave the question's vectors unwritten.
   */
  async flushIndex(): Promise<void> {
    await this.indexTail;
    const indexer = this.indexer;
    if (indexer === null || process.env.COOKIE_INDEX_BEFORE_DONE !== "1") {
      return;
    }
    for (let pass = 0; pass < 32; pass += 1) {
      const stats = await indexer.indexPending();
      if (
        stats.skipped ||
        (stats.turns === 0 && stats.chunks === 0 && stats.facts === 0)
      ) {
        return;
      }
    }
  }

  /**
   * Prior turns plus this user text, once. The user row is stored
   * before retrieval so a tool can cite it, and that id is omitted
   * from the retrieved block. The prompt does not load the row this
   * call just stored.
   */
  async messagesFor(
    conversationId: string,
    userText: string,
    signal?: AbortSignal,
  ): Promise<ModelMessage[]> {
    if (signal?.aborted) {
      throw abortError();
    }
    const session = await this.beginAndReflect(conversationId);
    const messages: ModelMessage[] = [];
    if (session.endedAt !== null) {
      this.lastUserTurnId = null;
      return [{ role: "user", content: userText }];
    }
    const forgotten = new Set(this.store.forgottenTurnIds());
    const live = this.store
      .recentTurns(conversationId, HISTORY_FETCH_LIMIT)
      .filter((turn) => !forgotten.has(turn.id));
    const prior = recentWithinBudget(
      live.slice(-HISTORY_TURN_CAP),
      LOCAL_RECENT_TURN_TOKEN_BUDGET,
    );
    for (const turn of prior) {
      if (turn.role === "tool") {
        continue;
      }
      messages.push({ role: turn.role, content: turn.content });
    }
    const userTurnId = this.insertTurn(
      conversationId,
      "user",
      userText,
      null,
      null,
      null,
    );
    this.lastUserTurnId = userTurnId;
    const omitTurnIds = new Set(prior.map((turn) => turn.id));
    omitTurnIds.add(userTurnId);
    const memories =
      signal?.aborted === true
        ? []
        : await this.safeRetrieve(userText, signal, omitTurnIds);
    this.traceRetrieval(conversationId, memories);
    const block = renderRetrieved(memories, LOCAL_RETRIEVED_TOKEN_BUDGET, {
      omitTurnIds,
    });
    if (block.length > 0) {
      messages.push({ role: "user", content: block });
    }
    messages.push({ role: "user", content: userText });
    return messages;
  }

  currentUserTurnId(): string | null {
    return this.lastUserTurnId;
  }

  private async safeRetrieve(
    query: string,
    signal?: AbortSignal,
    omitTurnIds?: ReadonlySet<string>,
  ) {
    const retriever = this.retriever;
    if (retriever === null || query.trim() === "" || signal?.aborted === true) {
      return [];
    }
    try {
      return await retriever.retrieve(query, signal, omitTurnIds);
    } catch {
      return [];
    }
  }

  commit(turn: ChatTurnCommit): void {
    const session = this.store.session(turn.conversationId);
    if (session === null || session.endedAt !== null) {
      this.lastUserTurnId = null;
      return;
    }
    const userId = this.lastUserTurnId;
    if (userId === null) {
      this.insertTurn(
        turn.conversationId,
        "user",
        turn.userText,
        null,
        null,
        null,
      );
    }
    this.lastUserTurnId = null;
    if (turn.assistantText.length > 0) {
      const assistantId = this.insertTurn(
        turn.conversationId,
        "assistant",
        turn.assistantText,
        turn.modelId,
        turn.usage.inputTokens,
        turn.usage.outputTokens,
        turn.latencyMs,
      );
      this.markForgottenReply(userId, assistantId);
    }
    this.scheduleIndex();
  }

  /**
   * The forget tool runs before this reply is stored. When the user
   * turn is already forgotten, the reply is too.
   */
  private markForgottenReply(userId: string | null, assistantId: string): void {
    if (userId === null) {
      return;
    }
    if (!this.store.forgottenTurnIds().includes(userId)) {
      return;
    }
    this.store.forgetTurn(
      assistantId,
      new Date(this.store.currentTime()).toISOString(),
      this.store.forgottenFactIds(userId),
    );
  }

  private insertTurn(
    conversationId: string,
    role: "user" | "assistant",
    content: string,
    modelId: string | null,
    tokensIn: number | null,
    tokensOut: number | null,
    latencyMs: number | null = null,
  ): string {
    const count = this.store.turnCount(conversationId);
    const started = Math.max(
      this.store.currentTime(),
      this.store.latestTurnAt(conversationId) + 1,
    );
    const id = `${conversationId}-${count + 1}-${role}`;
    this.store.appendTurn({
      id,
      sessionId: conversationId,
      role,
      content,
      tainted: false,
      model: modelId,
      egress: false,
      escalatedFrom: null,
      tokensIn,
      tokensCached: null,
      tokensOut,
      costUsd: 0,
      latencyMs,
      createdAt: started,
    });
    return id;
  }

  /**
   * A new conversation id ends the previous session. When a reflector
   * is installed, each ended session is reflected once, before this
   * turn's retrieval. The call is the session id only. The chat abort
   * signal is not passed: that signal is what cancels the idle timer.
   * The instance is the shared `LocalReflector` from the runtime.
   */
  private async beginAndReflect(conversationId: string) {
    const reflector = this.reflector;
    const openBefore = reflector === null ? [] : this.store.openSessionIds();
    const session = this.store.beginConversation(conversationId);
    if (reflector === null) {
      return session;
    }
    for (const id of openBefore) {
      if (id === conversationId) {
        continue;
      }
      const ended = this.store.session(id);
      if (ended !== null && ended.endedAt !== null) {
        this.reflectPending.add(id);
      }
    }
    for (const id of [...this.reflectPending]) {
      try {
        await this.reflectWithin(reflector, id);
        this.reflectPending.delete(id);
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : "reflect failed";
        process.stderr.write(`cookie-core: reflect failed: ${detail}\n`);
      }
    }
    return session;
  }

  /**
   * Bound the await. A reflector that ignores the clock still loses
   * the race, the error is logged, and the session stays pending.
   */
  private reflectWithin(reflector: Reflector, id: string): Promise<void> {
    const timeoutMs = this.reflectTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("reflect timed out"));
      }, timeoutMs);
      reflector.reflect(id).then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private traceRetrieval(
    conversationId: string,
    memories: readonly Memory[],
  ): void {
    const path = this.tracePath;
    if (path === null || path === "") {
      return;
    }
    const line = `${JSON.stringify({
      conversationId,
      ids: memories.map((memory) => memory.id),
    })}\n`;
    try {
      appendFileSync(path, line);
    } catch {
      // The trace is how the eval reports ids. A full disk must not
      // fail the reply. The eval then shows an empty id list.
    }
  }

  private scheduleIndex(): void {
    const indexer = this.indexer;
    if (indexer === null) {
      return;
    }
    this.indexTail = this.indexTail
      .then(() => indexer.indexPending())
      .then(() => undefined)
      .catch(() => undefined);
  }

  close(): void {
    this.store.close();
  }
}
