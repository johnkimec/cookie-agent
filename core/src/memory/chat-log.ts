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
import type { SqliteMemoryStore } from "./sqlite-store.ts";
import type { Memory, TurnRecord } from "./types.ts";

export interface ChatLogHooks {
  /** Set when `COOKIE_REFLECT_IDLE_MS` is set. Otherwise null. */
  reflector?: Reflector | null;
  /** `COOKIE_RETRIEVAL_TRACE`. One JSON line per retrieve. */
  tracePath?: string | null;
}

/** Recent turns loaded into one prompt, then cut to the local token budget. */
const HISTORY_TURN_LIMIT = 10_000;

/**
 * Turns in `cookie.db` for the real core.
 * The system prompt is not stored. The provider adds it on each call.
 * `egress` is false: this core only talks to loopback.
 */
export class ChatLog implements ConversationHistory {
  private readonly store: SqliteMemoryStore;
  private readonly indexer: ContentIndexer | null;
  private readonly retriever: { retrieve: Retrieve } | null;
  private readonly reflector: Reflector | null;
  private readonly tracePath: string | null;
  private indexTail: Promise<void> = Promise.resolve();

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

  async messagesFor(
    conversationId: string,
    userText: string,
    signal?: AbortSignal,
  ): Promise<ModelMessage[]> {
    const session = await this.beginAndReflect(conversationId);
    const messages: ModelMessage[] = [];
    let prior: TurnRecord[] = [];
    if (session.endedAt === null) {
      prior = recentWithinBudget(
        this.store.recentTurns(conversationId, HISTORY_TURN_LIMIT),
        LOCAL_RECENT_TURN_TOKEN_BUDGET,
      );
      for (const turn of prior) {
        if (turn.role === "tool") {
          continue;
        }
        messages.push({ role: turn.role, content: turn.content });
      }
    }
    const memories =
      signal?.aborted === true ? [] : await this.safeRetrieve(userText, signal);
    this.traceRetrieval(conversationId, memories);
    const block = renderRetrieved(memories, LOCAL_RETRIEVED_TOKEN_BUDGET, {
      omitTurnIds: new Set(prior.map((turn) => turn.id)),
    });
    if (block.length > 0) {
      messages.push({ role: "user", content: block });
    }
    messages.push({ role: "user", content: userText });
    return messages;
  }

  private async safeRetrieve(query: string, signal?: AbortSignal) {
    const retriever = this.retriever;
    if (retriever === null || query.trim() === "" || signal?.aborted === true) {
      return [];
    }
    try {
      return await retriever.retrieve(query, signal);
    } catch {
      return [];
    }
  }

  commit(turn: ChatTurnCommit): void {
    const session = this.store.session(turn.conversationId);
    if (session === null || session.endedAt !== null) {
      return;
    }
    const count = this.store.turnCount(turn.conversationId);
    const started = Math.max(
      this.store.currentTime(),
      this.store.latestTurnAt(turn.conversationId) + 1,
    );
    this.store.appendTurn({
      id: `${turn.conversationId}-${count + 1}-user`,
      sessionId: turn.conversationId,
      role: "user",
      content: turn.userText,
      tainted: false,
      model: null,
      egress: false,
      escalatedFrom: null,
      tokensIn: null,
      tokensCached: null,
      tokensOut: null,
      costUsd: null,
      latencyMs: null,
      createdAt: started,
    });
    if (turn.assistantText.length > 0) {
      this.store.appendTurn({
        id: `${turn.conversationId}-${count + 2}-assistant`,
        sessionId: turn.conversationId,
        role: "assistant",
        content: turn.assistantText,
        tainted: false,
        model: turn.modelId,
        egress: false,
        escalatedFrom: null,
        tokensIn: turn.usage.inputTokens,
        tokensCached: null,
        tokensOut: turn.usage.outputTokens,
        costUsd: 0,
        latencyMs: turn.latencyMs,
        createdAt: started + 1,
      });
    }
    this.scheduleIndex();
  }

  /**
   * A new conversation id ends the previous session. When a reflector
   * is installed, that ended session is reflected before this turn's
   * retrieval. The idle timer itself is not in the core. The eval sets
   * `COOKIE_REFLECT_IDLE_MS` and treats the next conversation as the
   * idle boundary.
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
        await reflector.reflect(id);
      }
    }
    return session;
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
