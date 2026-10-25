import type { ToolSet } from "ai";
import type { FinishReason } from "../protocol/types.ts";
import type { ModelSlot } from "./slot.ts";

export interface MemoryChatStart {
  conversationId: string;
  messageId: string;
  userText: string;
}

export interface MemoryChatSettled {
  conversationId: string;
  messageId: string;
  userText: string;
  assistantText: string;
  cancelled: boolean;
  finishReason: FinishReason;
}

/**
 * Optional hook on the chat core. Absent in M0. When present, chat
 * takes the llama slot and may call `memory.*` tools.
 */
export interface MemoryHost {
  readonly systemPrompt: string;
  readonly tools: ToolSet;
  readonly slot: ModelSlot;
  onChatStarted(event: MemoryChatStart): void;
  onChatSettled(event: MemoryChatSettled): void;
  onStop(): void;
}
