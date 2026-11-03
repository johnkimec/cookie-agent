import type { Embedder } from "./embedder.ts";
import { EMBEDDING_DIMENSIONS } from "./types.ts";

/** llama.cpp model name sent on `POST /v1/embeddings`. The file is Q8_0. */
export const EMBED_MODEL_ID = "nomic-embed-text-v1.5";

/** nomic query prefix. Callers add this. `embed` sends the string it is given. */
export const QUERY_PREFIX = "search_query: ";

/** nomic document prefix. Indexing adds this before `embed`. */
export const DOCUMENT_PREFIX = "search_document: ";

export const DEFAULT_EMBED_PORT = 8081;

/** Indexing embed. A batch can be slow. Not the chat-turn budget. */
export const DEFAULT_EMBED_TIMEOUT_MS = 10_000;

/**
 * Query embed on the chat path.
 * `COOKIE_EMBED_QUERY_TIMEOUT_MS` overrides it.
 * `COOKIE_EMBED_TIMEOUT_MS` is a deprecated alias for that query budget
 * only. It does not change indexing. A hung embedder must fall back to
 * BM25 inside this, not the 10 s index budget.
 */
export const DEFAULT_QUERY_EMBED_TIMEOUT_MS = 400;

export const DEFAULT_EMBED_HEALTH_TIMEOUT_MS = 300;

export const DEFAULT_EMBED_BATCH_SIZE = 16;

const LOOPBACK_HOST = "127.0.0.1";

export function prefixQuery(text: string): string {
  return `${QUERY_PREFIX}${text}`;
}

export function prefixDocument(text: string): string {
  return `${DOCUMENT_PREFIX}${text}`;
}

/** Unit-length copy. A zero vector stays zero. */
export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  const out = new Float32Array(vector.length);
  if (norm === 0) {
    return out;
  }
  for (let index = 0; index < vector.length; index += 1) {
    out[index] = (vector[index] ?? 0) / norm;
  }
  return out;
}

export function l2Norm(vector: Float32Array): number {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  return Math.sqrt(sum);
}

/**
 * `COOKIE_EMBED_PORT` when set. Otherwise 8081.
 * The product embedding server is a second llama-server on loopback.
 */
export function readEmbedPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.COOKIE_EMBED_PORT;
  if (raw === undefined || raw === "") {
    return DEFAULT_EMBED_PORT;
  }
  return readPort(raw, "COOKIE_EMBED_PORT");
}

/**
 * Index-embed budget. `COOKIE_EMBED_INDEX_TIMEOUT_MS` overrides it.
 * The deprecated `COOKIE_EMBED_TIMEOUT_MS` alias does not.
 */
export function readIndexEmbedTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return readPositiveInt(
    env.COOKIE_EMBED_INDEX_TIMEOUT_MS,
    DEFAULT_EMBED_TIMEOUT_MS,
    "COOKIE_EMBED_INDEX_TIMEOUT_MS",
  );
}

/**
 * Index-embed budget. Kept so `resolveEmbedder` still has one reader.
 * Same value as {@link readIndexEmbedTimeoutMs}.
 */
export function readEmbedTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return readIndexEmbedTimeoutMs(env);
}

/**
 * Chat-turn embed budget. Unset is 400 ms, not the indexing default.
 * `COOKIE_EMBED_QUERY_TIMEOUT_MS` wins. Otherwise the deprecated
 * `COOKIE_EMBED_TIMEOUT_MS` alias applies.
 */
export function readQueryEmbedTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const query = env.COOKIE_EMBED_QUERY_TIMEOUT_MS;
  if (query !== undefined && query !== "") {
    return readPositiveInt(
      query,
      DEFAULT_QUERY_EMBED_TIMEOUT_MS,
      "COOKIE_EMBED_QUERY_TIMEOUT_MS",
    );
  }
  return readPositiveInt(
    env.COOKIE_EMBED_TIMEOUT_MS,
    DEFAULT_QUERY_EMBED_TIMEOUT_MS,
    "COOKIE_EMBED_TIMEOUT_MS",
  );
}

export interface HttpEmbedderOptions {
  port?: number;
  timeoutMs?: number;
  healthTimeoutMs?: number;
  batchSize?: number;
  model?: string;
  fetch?: typeof fetch;
}

/**
 * OpenAI-compatible embeddings on `127.0.0.1`.
 * `embed` posts the text unchanged, L2-normalizes, and requires 768 dimensions.
 * `embedMany` posts at most `batchSize` strings per request.
 * The host is fixed so this client cannot be pointed off the machine.
 */
export class HttpEmbedder implements Embedder {
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly batchSize: number;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpEmbedderOptions = {}) {
    const port = options.port ?? DEFAULT_EMBED_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("embed port must be an integer 1..65535");
    }
    const batchSize = options.batchSize ?? DEFAULT_EMBED_BATCH_SIZE;
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new Error("embed batch size must be a positive integer");
    }
    this.port = port;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
    this.healthTimeoutMs =
      options.healthTimeoutMs ?? DEFAULT_EMBED_HEALTH_TIMEOUT_MS;
    this.batchSize = batchSize;
    this.model = options.model ?? EMBED_MODEL_ID;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async embed(text: string): Promise<Float32Array> {
    const vectors = await this.embedMany([text]);
    const vector = vectors[0];
    if (vector === undefined) {
      throw new Error("embedder returned no vector");
    }
    return vector;
  }

  async embedMany(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }
    const out: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const slice = texts.slice(start, start + this.batchSize);
      const batch = await this.postEmbeddings(slice);
      out.push(...batch);
    }
    return out;
  }

  /** `GET /health`. Connection failures and non-2xx are `down`. Never throws. */
  async health(): Promise<"up" | "down"> {
    const url = `http://${LOOPBACK_HOST}:${this.port}/health`;
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(this.healthTimeoutMs),
        headers: { accept: "application/json" },
      });
      if (response.status >= 200 && response.status < 300) {
        return "up";
      }
      return "down";
    } catch {
      return "down";
    }
  }

  private async postEmbeddings(
    texts: readonly string[],
  ): Promise<Float32Array[]> {
    const url = `http://${LOOPBACK_HOST}:${this.port}/v1/embeddings`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: this.model, input: [...texts] }),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "embed failed";
      throw new Error(`embedder unreachable: ${detail}`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`embedder status ${response.status}`);
    }
    const body = (await response.json()) as unknown;
    return parseEmbeddings(body, texts.length);
  }
}

function parseEmbeddings(body: unknown, count: number): Float32Array[] {
  if (typeof body !== "object" || body === null || !("data" in body)) {
    throw new Error("embedder response has no data");
  }
  const data = body.data;
  if (!Array.isArray(data)) {
    throw new Error("embedder response data is not a list");
  }
  const placed: Array<Float32Array | undefined> = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) {
      throw new Error("embedder item is not an object");
    }
    const index = "index" in item ? item.index : undefined;
    const embedding = "embedding" in item ? item.embedding : undefined;
    if (typeof index !== "number" || !Number.isInteger(index)) {
      throw new Error("embedder item index is missing");
    }
    if (index < 0 || index >= count) {
      throw new Error(`embedder item index ${index}`);
    }
    placed[index] = normalizeEmbedding(embedding);
  }
  if (placed.length !== count || placed.some((item) => item === undefined)) {
    throw new Error(`embedder returned ${placed.length} of ${count}`);
  }
  return placed as Float32Array[];
}

function normalizeEmbedding(value: unknown): Float32Array {
  if (!Array.isArray(value)) {
    throw new Error("embedder embedding is not a list");
  }
  if (value.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `embedding length ${value.length} is not ${EMBEDDING_DIMENSIONS}`,
    );
  }
  const raw = new Float32Array(EMBEDDING_DIMENSIONS);
  for (let index = 0; index < value.length; index += 1) {
    const component = value[index];
    if (typeof component !== "number" || !Number.isFinite(component)) {
      throw new Error("embedder embedding component is not a finite number");
    }
    raw[index] = component;
  }
  return l2Normalize(raw);
}

function readPort(raw: string, name: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer 1..65535`);
  }
  const port = Number(raw);
  if (port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer 1..65535`);
  }
  return port;
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
