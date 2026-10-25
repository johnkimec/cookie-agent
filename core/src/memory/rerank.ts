import type { ModelProvider } from "../model/provider.ts";
import { estimateTokens } from "./chunk.ts";
import type { Memory } from "./types.ts";

export const RERANK_CANDIDATES = 20;

export const RERANK_KEEP = 8;

/** Characters of each memory shown to the reranker. Full text stays in the prompt. */
export const RERANK_PREVIEW_CHARS = 200;

export const DEFAULT_RERANK_TIMEOUT_MS = 1500;

export interface RerankConfig {
  enabled: boolean;
  timeoutMs: number;
}

/**
 * `COOKIE_RERANK=0` skips the model. Unset and `1` run it.
 * `COOKIE_RERANK_TIMEOUT_MS` defaults to 1500. A timeout keeps fused order.
 */
export function readRerankConfig(
  env: NodeJS.ProcessEnv = process.env,
): RerankConfig {
  const raw = env.COOKIE_RERANK;
  let enabled = true;
  if (raw === undefined || raw === "" || raw === "1") {
    enabled = true;
  } else if (raw === "0") {
    enabled = false;
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
    return `${index + 1}. id=${memory.id} ${preview}`;
  });
  return [
    "Choose the memories that help answer the question.",
    'Reply with JSON only: {"ids":["..."]} with at most 8 ids, best first.',
    "Omit ids that do not help.",
    "",
    `Question: ${query}`,
    "",
    ...lines,
  ].join("\n");
}

export function parseRerankIds(text: string): string[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return [];
  }
  try {
    const body = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (typeof body !== "object" || body === null || !("ids" in body)) {
      return [];
    }
    const ids = body.ids;
    if (!Array.isArray(ids)) {
      return [];
    }
    return ids.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
  } catch {
    return [];
  }
}

export interface Reranker {
  rerank(query: string, candidates: readonly Memory[]): Promise<Memory[]>;
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
  ): Promise<Memory[]> {
    const top = candidates.slice(0, RERANK_CANDIDATES);
    if (!this.enabled || top.length <= 1) {
      return top.slice(0, RERANK_KEEP);
    }
    const prompt = rerankPrompt(query, top);
    try {
      const text = await this.complete(
        prompt,
        AbortSignal.timeout(this.timeoutMs),
      );
      return orderByIds(top, parseRerankIds(text));
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
): Promise<string> {
  const stream = provider.streamChat({
    system: "Reply with JSON only.",
    messages: [{ role: "user", content: prompt }],
    abortSignal: signal,
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

function orderByIds(
  memories: readonly Memory[],
  ids: readonly string[],
): Memory[] {
  if (ids.length === 0) {
    return memories.slice(0, RERANK_KEEP);
  }
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  const picked: Memory[] = [];
  for (const id of ids) {
    const memory = byId.get(id);
    if (memory === undefined || picked.some((row) => row.id === id)) {
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
