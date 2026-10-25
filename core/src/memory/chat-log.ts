import type { ModelMessage } from "ai";
import {
  LOCAL_RECENT_TURN_TOKEN_BUDGET,
  LOCAL_RETRIEVED_TOKEN_BUDGET,
  recentWithinBudget,
  renderRetrieved,
} from "../context.ts";
import type { ChatTurnCommit, ConversationHistory } from "../memory.ts";
import type { ContentIndexer } from "./index-content.ts";
import type { Retrieve } from "./retrieve.ts";
import { abortError } from "./slot.ts";
import type { SqliteMemoryStore } from "./sqlite-store.ts";

/** Recent turns loaded into one prompt, then cut to the local token budget. */
const HISTORY_TURN_LIMIT = 10_000;

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
  private readonly retriever: {
    retrieve: Retrieve;
    setOmitTurnIds?: (ids: ReadonlySet<string>) => void;
  } | null;
  private indexTail: Promise<void> = Promise.resolve();
  private lastUserTurnId: string | null = null;

  constructor(
    store: SqliteMemoryStore,
    indexer: ContentIndexer | null = null,
    retriever: {
      retrieve: Retrieve;
      setOmitTurnIds?: (ids: ReadonlySet<string>) => void;
    } | null = null,
  ) {
    this.store = store;
    this.indexer = indexer;
    this.retriever = retriever;
  }

  /** Resolves when indexing started by `commit` has finished. */
  flushIndex(): Promise<void> {
    return this.indexTail;
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
    const session = this.store.beginConversation(conversationId);
    const messages: ModelMessage[] = [];
    if (session.endedAt !== null) {
      this.lastUserTurnId = null;
      return [{ role: "user", content: userText }];
    }
    const prior = recentWithinBudget(
      this.store.recentTurns(conversationId, HISTORY_TURN_LIMIT),
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
    this.retriever?.setOmitTurnIds?.(omitTurnIds);
    const memories =
      signal?.aborted === true ? [] : await this.safeRetrieve(userText, signal);
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
