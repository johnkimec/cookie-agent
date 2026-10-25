import type { ModelMessage } from "ai";
import type { ModelUsage } from "./model/provider.ts";

/**
 * One committed exchange. `egress` stays false on the SQLite path:
 * this core only talks to loopback.
 */
export interface ChatTurnCommit {
  conversationId: string;
  userText: string;
  assistantText: string;
  modelId: string | null;
  usage: ModelUsage;
  latencyMs: number | null;
}

/**
 * What the core asks for history. The real process uses `ChatLog`.
 * This in-memory class is the default for tests that do not open a database.
 * The system prompt is not stored; the provider adds it on each call.
 */
export interface ConversationHistory {
  messagesFor(conversationId: string, userText: string): ModelMessage[];
  commit(turn: ChatTurnCommit): void;
  close(): void;
}

export class ConversationMemory implements ConversationHistory {
  private readonly turns = new Map<string, ModelMessage[]>();

  messagesFor(conversationId: string, userText: string): ModelMessage[] {
    const prior = this.turns.get(conversationId) ?? [];
    return [...prior, { role: "user", content: userText }];
  }

  commit(turn: ChatTurnCommit): void {
    const prior = this.turns.get(turn.conversationId) ?? [];
    const next: ModelMessage[] = [
      ...prior,
      { role: "user", content: turn.userText },
    ];
    if (turn.assistantText.length > 0) {
      next.push({ role: "assistant", content: turn.assistantText });
    }
    this.turns.set(turn.conversationId, next);
  }

  close(): void {}
}
