import type { ModelMessage } from "ai";

/**
 * In-memory turns for one core process. SQLite replaces this in M1.
 * The system prompt is not stored; the provider adds it on each call.
 */
export class ConversationMemory {
  private readonly turns = new Map<string, ModelMessage[]>();

  messagesFor(conversationId: string, userText: string): ModelMessage[] {
    const prior = this.turns.get(conversationId) ?? [];
    return [...prior, { role: "user", content: userText }];
  }

  commit(
    conversationId: string,
    userText: string,
    assistantText: string,
  ): void {
    const prior = this.turns.get(conversationId) ?? [];
    const next: ModelMessage[] = [
      ...prior,
      { role: "user", content: userText },
    ];
    if (assistantText.length > 0) {
      next.push({ role: "assistant", content: assistantText });
    }
    this.turns.set(conversationId, next);
  }
}
