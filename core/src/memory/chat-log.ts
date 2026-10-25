import type { ModelMessage } from "ai";
import type { ChatTurnCommit, ConversationHistory } from "../memory.ts";
import { abortError } from "./slot.ts";
import type { SqliteMemoryStore } from "./sqlite-store.ts";

/** Recent turns loaded into one prompt. Context budgets land in Step 2. */
const HISTORY_TURN_LIMIT = 10_000;

/**
 * Turns in `cookie.db` for the real core.
 * The system prompt is not stored. The provider adds it on each call.
 * `egress` is false: this core only talks to loopback.
 */
export class ChatLog implements ConversationHistory {
  private readonly store: SqliteMemoryStore;
  private lastUserTurnId: string | null = null;

  constructor(store: SqliteMemoryStore) {
    this.store = store;
  }

  /**
   * Prior turns plus this user text, once. The user row is stored here
   * so a tool can cite it before the assistant reply exists. The memory
   * host must not insert the same turn.
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
    if (turn.assistantText.length === 0) {
      return;
    }
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

  close(): void {
    this.store.close();
  }
}
