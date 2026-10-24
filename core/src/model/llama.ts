import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { RuntimeState } from "../protocol/types.ts";
import { DEFAULT_MODEL_ID } from "../protocol/types.ts";
import { isRecord } from "../protocol/validate.ts";
import { createAiSdkProvider } from "./ai-sdk-provider.ts";
import type { ModelProvider } from "./provider.ts";

export interface LlamaServerOptions {
  port: number;
  modelId?: string;
  fetch?: typeof fetch;
}

const PRODUCT_HOST = "127.0.0.1";

/**
 * Local llama-server (OpenAI-compatible) on loopback.
 * `COOKIE_LLAMA_PORT` selects the port. The product default is 8080.
 * M0 does not construct a hosted provider.
 */
export function createLlamaServerProvider(
  options: LlamaServerOptions,
): ModelProvider {
  const modelId = options.modelId ?? DEFAULT_MODEL_ID;
  const port = options.port;
  const doFetch = options.fetch ?? globalThis.fetch;
  const openai = createOpenAICompatible({
    name: "llama-server",
    baseURL: `http://${PRODUCT_HOST}:${port}/v1`,
    includeUsage: true,
    fetch: doFetch,
    transformRequestBody: (body) => withThinkingDisabled(body),
  });
  return createAiSdkProvider({
    modelId,
    model: openai.chatModel(modelId),
    probe: (signal) => probeLlamaServer(port, signal, doFetch),
  });
}

export function readLlamaPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.COOKIE_LLAMA_PORT;
  if (raw === undefined || raw === "") {
    return 8080;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error("COOKIE_LLAMA_PORT must be an integer 1..65535");
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new Error("COOKIE_LLAMA_PORT must be an integer 1..65535");
  }
  return port;
}

/**
 * Qwen3 thinking is on unless the template is told otherwise.
 * Local chat, routing, and gating keep it off. Day planning is later.
 */
function withThinkingDisabled(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const existing = body.chat_template_kwargs;
  const prior =
    typeof existing === "object" &&
    existing !== null &&
    !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  return {
    ...body,
    chat_template_kwargs: {
      ...prior,
      enable_thinking: false,
    },
  };
}

async function probeLlamaServer(
  port: number,
  signal: AbortSignal,
  doFetch: typeof fetch,
): Promise<RuntimeState> {
  const health = await readHealth(port, signal, doFetch);
  if (health !== "unknown") {
    return health;
  }
  return readModels(port, signal, doFetch);
}

async function readHealth(
  port: number,
  signal: AbortSignal,
  doFetch: typeof fetch,
): Promise<RuntimeState | "unknown"> {
  let response: Response;
  try {
    response = await doFetch(`http://${PRODUCT_HOST}:${port}/health`, {
      signal,
      redirect: "manual",
      headers: { accept: "application/json" },
    });
  } catch {
    return "down";
  }
  if (response.status === 404) {
    return "unknown";
  }
  if (response.status === 503) {
    return "loading";
  }
  if (response.status < 200 || response.status >= 300) {
    return "down";
  }
  const text = await response.text();
  if (text.trim() === "") {
    return "up";
  }
  try {
    const body = JSON.parse(text) as unknown;
    if (!isRecord(body) || typeof body.status !== "string") {
      return "up";
    }
    if (body.status === "loading") {
      return "loading";
    }
    if (body.status === "error" || body.status === "failed") {
      return "down";
    }
  } catch {
    return "up";
  }
  return "up";
}

async function readModels(
  port: number,
  signal: AbortSignal,
  doFetch: typeof fetch,
): Promise<RuntimeState> {
  try {
    const response = await doFetch(`http://${PRODUCT_HOST}:${port}/v1/models`, {
      signal,
      redirect: "manual",
      headers: { accept: "application/json" },
    });
    if (response.ok) {
      return "up";
    }
  } catch {
    return "down";
  }
  return "down";
}
