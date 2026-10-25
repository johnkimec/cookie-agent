import type { ModelMessage, ToolSet } from "ai";
import type { RuntimeState } from "../protocol/types.ts";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Finish reasons the core can report from a model call. `cancelled` is the core's. */
export type ModelFinishReason = "stop" | "length" | "error";

export interface ModelCompletion {
  finishReason: ModelFinishReason;
  usage: ModelUsage;
}

/**
 * One streaming chat call. `textDeltas` yields the next chunk, not the
 * whole reply. `completion` resolves after the stream has been read.
 * Aborting `abortSignal` rejects `completion` and stops the model request.
 */
export interface ModelStream {
  textDeltas: AsyncIterable<string>;
  completion: Promise<ModelCompletion>;
}

/**
 * The only model seam. M0 constructs the local llama-server provider.
 * A hosted provider later is a different factory behind this interface.
 */
export interface ModelProvider {
  readonly modelId: string;
  probe(signal: AbortSignal): Promise<RuntimeState>;
  streamChat(args: {
    system: string;
    messages: ModelMessage[];
    abortSignal: AbortSignal;
    /** When set, the model may call these tools before the reply text. */
    tools?: ToolSet;
  }): ModelStream;
}
