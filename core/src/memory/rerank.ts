import type { ModelProvider } from "../model/provider.ts";
import { estimateTokens } from "./chunk.ts";
import type { Memory } from "./types.ts";

export const RERANK_CANDIDATES = 20;

export const RERANK_KEEP = 8;

/**
 * Characters of each memory shown to the reranker.
 * 100 measured about 1.0 s on the Mac. Full text stays in the chat prompt.
 */
export const RERANK_PREVIEW_CHARS = 100;

/** Short JSON of indices. Eight small integers fit. */
export const RERANK_MAX_TOKENS = 32;

export const DEFAULT_RERANK_TIMEOUT_MS = 1500;

/**
 * Indices, not memory ids. Qwen mangled UUIDs. The schema is
 * `response_format: json_schema` on the llama request.
 */
export const RERANK_RESPONSE_FORMAT = {
  type: "json" as const,
  name: "rerank",
  description: "Candidate indices that help, best first.",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["indices"],
    properties: {
      indices: {
        type: "array",
        items: { type: "integer" },
      },
    },
  },
};

export interface RerankConfig {
  enabled: boolean;
  timeoutMs: number;
}

/**
 * Rerank is off unless `COOKIE_RERANK=1`. On the Mac it timed out 8 of 8
 * runs and the warm first token was 2.16 s. `COOKIE_RERANK_TIMEOUT_MS`
 * defaults to 1500. A timeout keeps fused order.
 */
export function readRerankConfig(
  env: NodeJS.ProcessEnv = process.env,
): RerankConfig {
  const raw = env.COOKIE_RERANK;
  let enabled = false;
  if (raw === undefined || raw === "" || raw === "0") {
    enabled = false;
  } else if (raw === "1") {
    enabled = true;
  } else {
    throw new Error("COOKIE_RERANK must be 0 or 1");
  }
  return {
    enabled,
    timeoutMs: readPositiveInt(
      env.COOKIE_RERANK_TIMEOUT_MS,
      DEFAULT_RERANK_TIMEOUT_MS,
      "COOKIE_RERANK_TIMEOUT_MS",
    ),
  };
}

export function rerankPrompt(
  query: string,
  memories: readonly Memory[],
): string {
  const lines = memories.slice(0, RERANK_CANDIDATES).map((memory, index) => {
    const preview = memory.text
      .replace(/\s+/g, " ")
      .slice(0, RERANK_PREVIEW_CHARS);
    return `${index}. ${preview}`;
  });
  return [
    "Choose the memories that help answer the question.",
    'Reply with JSON only: {"indices":[0,2]} using the numbers shown,',
    "best first, at most 8. Omit numbers that do not help.",
    "",
    `Question: ${query}`,
    "",
    ...lines,
  ].join("\n");
}

/**
 * Integers in range, first occurrence only.
 * Anything else is dropped. An empty list means keep fused order.
 */
export function parseRerankIndices(text: string, count: number): number[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start || count <= 0) {
    return [];
  }
  try {
    const body = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (typeof body !== "object" || body === null || !("indices" in body)) {
      return [];
    }
    const indices = body.indices;
    if (!Array.isArray(indices)) {
      return [];
    }
    const picked: number[] = [];
    const seen = new Set<number>();
    for (const value of indices) {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        continue;
      }
      if (value < 0 || value >= count || seen.has(value)) {
        continue;
      }
      seen.add(value);
      picked.push(value);
      if (picked.length === RERANK_KEEP) {
        break;
      }
    }
    return picked;
  } catch {
    return [];
  }
}

export interface Reranker {
  rerank(
    query: string,
    candidates: readonly Memory[],
    signal?: AbortSignal,
  ): Promise<Memory[]>;
}

export interface ModelRerankerOptions {
  complete: (prompt: string, signal: AbortSignal) => Promise<string>;
  timeoutMs: number;
  enabled: boolean;
}

/**
 * Asks the chat model to order the fused top 20 down to at most 8.
 * A timeout, a disabled flag, or JSON the parser cannot read keeps
 * fused order. Nothing is written to stderr.
 */
export class ModelReranker implements Reranker {
  private readonly complete: (
    prompt: string,
    signal: AbortSignal,
  ) => Promise<string>;
  private readonly timeoutMs: number;
  private readonly enabled: boolean;

  constructor(options: ModelRerankerOptions) {
    this.complete = options.complete;
    this.timeoutMs = options.timeoutMs;
    this.enabled = options.enabled;
  }

  async rerank(
    query: string,
    candidates: readonly Memory[],
    signal?: AbortSignal,
  ): Promise<Memory[]> {
    const top = candidates.slice(0, RERANK_CANDIDATES);
    if (!this.enabled || top.length <= 1 || signal?.aborted === true) {
      return top.slice(0, RERANK_KEEP);
    }
    const prompt = rerankPrompt(query, top);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const limit =
      signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
    try {
      const text = await this.complete(prompt, limit);
      return orderByIndices(top, parseRerankIndices(text, top.length));
    } catch {
      return top.slice(0, RERANK_KEEP);
    }
  }
}

export function rerankPromptTokens(
  query: string,
  memories: readonly Memory[],
): number {
  return estimateTokens(rerankPrompt(query, memories));
}

/**
 * One non-streaming completion through the chat provider.
 * That path already sends `chat_template_kwargs.enable_thinking` false.
 */
export async function completeText(
  provider: ModelProvider,
  prompt: string,
  signal: AbortSignal,
  options: {
    maxOutputTokens?: number;
    responseFormat?: typeof RERANK_RESPONSE_FORMAT;
  } = {},
): Promise<string> {
  const stream = provider.streamChat({
    system: "Reply with JSON only.",
    messages: [{ role: "user", content: prompt }],
    abortSignal: signal,
    maxOutputTokens: options.maxOutputTokens,
    responseFormat: options.responseFormat,
  });
  const done = stream.completion.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  let text = "";
  try {
    for await (const delta of stream.textDeltas) {
      text += delta;
    }
  } catch (error) {
    await done;
    throw error;
  }
  const outcome = await done;
  if (!outcome.ok) {
    throw outcome.error;
  }
  return text;
}

function orderByIndices(
  memories: readonly Memory[],
  indices: readonly number[],
): Memory[] {
  if (indices.length === 0) {
    return memories.slice(0, RERANK_KEEP);
  }
  const picked: Memory[] = [];
  for (const index of indices) {
    const memory = memories[index];
    if (memory === undefined) {
      continue;
    }
    picked.push(memory);
    if (picked.length === RERANK_KEEP) {
      break;
    }
  }
  if (picked.length === 0) {
    return memories.slice(0, RERANK_KEEP);
  }
  return picked;
}

function readPositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
