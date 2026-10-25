import {
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  stepCountIs,
  streamText,
} from "ai";
import { LOCAL_TOOL_STEP_LIMIT } from "../memory/tools.ts";
import type { RuntimeState } from "../protocol/types.ts";
import type {
  ModelCompletion,
  ModelFinishReason,
  ModelProvider,
  ModelStream,
  ModelUsage,
} from "./provider.ts";

export interface AiSdkProviderOptions {
  modelId: string;
  model: LanguageModel;
  probe: (signal: AbortSignal) => Promise<RuntimeState>;
  /** When false (the default), the model call sets reasoning to `none`. */
  thinking?: boolean;
}

/**
 * Adapts any AI SDK language model to {@link ModelProvider}.
 * Tests pass `MockLanguageModelV4`. The local runtime passes llama-server.
 */
export function createAiSdkProvider(
  options: AiSdkProviderOptions,
): ModelProvider {
  return {
    modelId: options.modelId,
    probe: options.probe,
    streamChat(args): ModelStream {
      let providerError: unknown;
      const result = streamText({
        model: options.model,
        system: args.system,
        messages: args.messages,
        abortSignal: args.abortSignal,
        maxRetries: 0,
        reasoning: options.thinking === true ? "provider-default" : "none",
        ...(args.tools === undefined
          ? {}
          : {
              tools: args.tools,
              stopWhen: stepCountIs(LOCAL_TOOL_STEP_LIMIT),
            }),
        onError: ({ error }) => {
          providerError = error;
        },
      });
      const completion = Promise.all([result.finishReason, result.usage])
        .then(([finishReason, usage]) =>
          toCompletion(finishReason, usage, args.abortSignal),
        )
        .catch((error: unknown) => {
          const cause = providerError ?? error;
          if (
            args.abortSignal.aborted ||
            isAbortError(cause) ||
            isAbortError(error)
          ) {
            throw toAbortError();
          }
          throw cause;
        });
      return {
        textDeltas: result.textStream,
        completion,
      };
    },
  };
}

function toCompletion(
  finishReason: FinishReason,
  usage: LanguageModelUsage,
  abortSignal: AbortSignal,
): ModelCompletion {
  if (abortSignal.aborted) {
    throw toAbortError();
  }
  return {
    finishReason: mapFinishReason(finishReason),
    usage: toUsage(usage),
  };
}

function mapFinishReason(finishReason: FinishReason): ModelFinishReason {
  if (finishReason === "stop") {
    return "stop";
  }
  if (finishReason === "length") {
    return "length";
  }
  return "error";
}

function toUsage(usage: LanguageModelUsage): ModelUsage {
  return {
    inputTokens: tokenCount(usage.inputTokens),
    outputTokens: tokenCount(usage.outputTokens),
  };
}

function tokenCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.trunc(value);
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError")
  );
}

function toAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
