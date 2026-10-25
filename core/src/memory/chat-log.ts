import type { ModelMessage } from "ai";
import type { ChatTurnCommit, ConversationHistory } from "../memory.ts";
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

  constructor(store: SqliteMemoryStore) {
    this.store = store;
  }

  messagesFor(conversationId: string, userText: string): ModelMessage[] {
    const session = this.store.beginConversation(conversationId);
    const messages: ModelMessage[] = [];
    if (session.endedAt === null) {
      const prior = this.store.recentTurns(conversationId, HISTORY_TURN_LIMIT);
      for (const turn of prior) {
        if (turn.role === "tool") {
          continue;
        }
        messages.push({ role: turn.role, content: turn.content });
      }
    }
    messages.push({ role: "user", content: userText });
    return messages;
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
    if (turn.assistantText.length === 0) {
      return;
    }
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

  noteWindow(conversationId: string, state: "open" | "closed"): void {
    this.store.noteWindow(conversationId, state);
  }

  close(): void {
    this.store.close();
  }
}
