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
import type { SqliteMemoryStore } from "./sqlite-store.ts";
import type { TurnRecord } from "./types.ts";

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
  private indexTail: Promise<void> = Promise.resolve();

  constructor(
    store: SqliteMemoryStore,
    indexer: ContentIndexer | null = null,
    retriever: { retrieve: Retrieve } | null = null,
  ) {
    this.store = store;
    this.indexer = indexer;
    this.retriever = retriever;
  }

  /** Resolves when indexing started by `commit` has finished. */
  flushIndex(): Promise<void> {
    return this.indexTail;
  }

  async messagesFor(
    conversationId: string,
    userText: string,
    signal?: AbortSignal,
  ): Promise<ModelMessage[]> {
    const session = this.store.beginConversation(conversationId);
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
    const omitTurnIds = new Set(prior.map((turn) => turn.id));
    const memories =
      signal?.aborted === true
        ? []
        : await this.safeRetrieve(userText, signal, omitTurnIds);
    const block = renderRetrieved(memories, LOCAL_RETRIEVED_TOKEN_BUDGET, {
      omitTurnIds,
    });
    if (block.length > 0) {
      messages.push({ role: "user", content: block });
    }
    messages.push({ role: "user", content: userText });
    return messages;
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
