/** Shared memory contracts. Step 0 defines these. Later steps implement them. */

export const EMBEDDING_DIMENSIONS = 768;

export type SessionSurface = "popup" | "menubar" | "checkin" | "widget";

export type TurnRole = "user" | "assistant" | "tool";

export type SessionRecord = {
  id: string;
  surface: SessionSurface;
  startedAt: number;
  endedAt: number | null;
  summary: string | null;
};

export type TurnRecord = {
  id: string;
  sessionId: string;
  role: TurnRole;
  content: string;
  tainted: boolean;
  model: string | null;
  egress: boolean;
  escalatedFrom: string | null;
  tokensIn: number | null;
  tokensCached: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  createdAt: number;
};

export type MemorySource = "fact" | "turn" | "chunk";

export type Memory = {
  id: string;
  text: string;
  source: MemorySource;
  /** Unix milliseconds. The retrieved block shows this as a local date. */
  createdAt?: number;
  /**
   * Chunk text, or the BM25 token, that this hit matched.
   * A long `text` is previewed around this instead of from the start.
   */
  matchText?: string;
};

export type VectorTable = "vec_facts" | "vec_chunks";

export type VectorHit = {
  id: string;
  distance: number;
};
