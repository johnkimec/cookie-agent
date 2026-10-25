import type { ModelMessage } from "ai";
import type { ChatTurnCommit, ConversationHistory } from "../memory.ts";
import type { ContentIndexer } from "./index-content.ts";
import { abortError } from "./slot.ts";
import type { SqliteMemoryStore } from "./sqlite-store.ts";

/** Recent turns loaded into one prompt. Context budgets land in Step 2. */
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
  private indexTail: Promise<void> = Promise.resolve();
  private lastUserTurnId: string | null = null;

  constructor(store: SqliteMemoryStore, indexer: ContentIndexer | null = null) {
    this.store = store;
    this.indexer = indexer;
  }

  /** Resolves when indexing started by `commit` has finished. */
  flushIndex(): Promise<void> {
    return this.indexTail;
  }

  /**
   * Prior turns plus this user text, once. The user row is stored here
   * so a tool can cite it before the assistant reply exists. The memory
   * host must not insert the same turn. The prompt does not load the
   * row this call just stored.
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
    const prior = this.store.recentTurns(conversationId, HISTORY_TURN_LIMIT);
    for (const turn of prior) {
      if (turn.role === "tool") {
        continue;
      }
      messages.push({ role: turn.role, content: turn.content });
    }
    this.lastUserTurnId = this.insertTurn(
      conversationId,
      "user",
      userText,
      null,
      null,
      null,
    );
    messages.push({ role: "user", content: userText });
    return messages;
  }

  currentUserTurnId(): string | null {
    return this.lastUserTurnId;
  }

  commit(turn: ChatTurnCommit): void {
    const session = this.store.session(turn.conversationId);
    if (session === null || session.endedAt !== null) {
      this.lastUserTurnId = null;
      return;
    }
    if (this.lastUserTurnId === null) {
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
      this.insertTurn(
        turn.conversationId,
        "assistant",
        turn.assistantText,
        turn.modelId,
        turn.usage.inputTokens,
        turn.usage.outputTokens,
        turn.latencyMs,
      );
    }
    this.scheduleIndex();
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
