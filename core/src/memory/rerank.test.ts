import { describe, expect, it } from "vitest";
import { estimateTokens } from "./chunk.ts";
import {
  DEFAULT_RERANK_TIMEOUT_MS,
  ModelReranker,
  parseRerankIds,
  RERANK_PREVIEW_CHARS,
  readRerankConfig,
  rerankPromptTokens,
} from "./rerank.ts";
import type { Memory } from "./types.ts";

function memory(id: string, text: string): Memory {
  return { id, text, source: "chunk" };
}

describe("rerank config", () => {
  it("runs unless COOKIE_RERANK is 0, and times out at 1500 ms", () => {
    expect(readRerankConfig({})).toEqual({
      enabled: true,
      timeoutMs: DEFAULT_RERANK_TIMEOUT_MS,
    });
    expect(readRerankConfig({ COOKIE_RERANK: "0" }).enabled).toBe(false);
    expect(
      readRerankConfig({ COOKIE_RERANK_TIMEOUT_MS: "400" }).timeoutMs,
    ).toBe(400);
    expect(() => readRerankConfig({ COOKIE_RERANK: "yes" })).toThrow(
      /COOKIE_RERANK/,
    );
  });

  it("reads ids from a JSON object and ignores prose", () => {
    expect(parseRerankIds('sure {"ids":["b","a"]}')).toEqual(["b", "a"]);
    expect(parseRerankIds("remembered")).toEqual([]);
  });

  it("keeps fused order when the completion aborts", async () => {
    const candidates = [memory("a", "alpha"), memory("b", "beta")];
    const reranker = new ModelReranker({
      enabled: true,
      timeoutMs: 30,
      complete: (_prompt, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(signal.reason);
          });
        }),
    });
    const ranked = await reranker.rerank("picnic", candidates);
    expect(ranked.map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("orders by the ids the model returns", async () => {
    const candidates = [memory("a", "alpha"), memory("b", "beta")];
    const reranker = new ModelReranker({
      enabled: true,
      timeoutMs: 1000,
      complete: async () => '{"ids":["b"]}',
    });
    const ranked = await reranker.rerank("picnic", candidates);
    expect(ranked.map((row) => row.id)).toEqual(["b"]);
  });

  it("counts a 200-character preview far under a full 512-token chunk", () => {
    const query = "What did I say about the ECE midterm?";
    const preview = Array.from({ length: 20 }, (_, index) =>
      memory(`c${index}`, "m".repeat(RERANK_PREVIEW_CHARS)),
    );
    const full = preview.map((row) => memory(row.id, "m".repeat(512 * 4)));
    const previewTokens = rerankPromptTokens(query, preview);
    const fullTokens = estimateTokens(full.map((row) => row.text).join("\n"));
    expect(previewTokens).toBeLessThan(2000);
    expect(fullTokens).toBeGreaterThan(10_000);
    expect(rerankPromptTokens(query, full)).toBeLessThan(2000);
  });
});
