import { describe, expect, it } from "vitest";
import { estimateTokens } from "./chunk.ts";
import {
  DEFAULT_RERANK_TIMEOUT_MS,
  ModelReranker,
  parseRerankIndices,
  RERANK_MAX_TOKENS,
  RERANK_PREVIEW_CHARS,
  RERANK_RESPONSE_FORMAT,
  readRerankConfig,
  rerankPrompt,
  rerankPromptTokens,
} from "./rerank.ts";
import type { Memory } from "./types.ts";

function memory(id: string, text: string): Memory {
  return { id, text, source: "chunk" };
}

describe("rerank config", () => {
  it("stays off unless COOKIE_RERANK is 1, and times out at 1500 ms", () => {
    expect(readRerankConfig({})).toEqual({
      enabled: false,
      timeoutMs: DEFAULT_RERANK_TIMEOUT_MS,
    });
    expect(readRerankConfig({ COOKIE_RERANK: "1" }).enabled).toBe(true);
    expect(readRerankConfig({ COOKIE_RERANK: "0" }).enabled).toBe(false);
    expect(
      readRerankConfig({ COOKIE_RERANK_TIMEOUT_MS: "400" }).timeoutMs,
    ).toBe(400);
    expect(() => readRerankConfig({ COOKIE_RERANK: "yes" })).toThrow(
      /COOKIE_RERANK/,
    );
  });

  it("reads indices and drops invalid or duplicate ones", () => {
    expect(parseRerankIndices('sure {"indices":[1,1,9,-1,0,"x"]}', 2)).toEqual([
      1, 0,
    ]);
    expect(parseRerankIndices("remembered", 2)).toEqual([]);
    expect(parseRerankIndices('{"ids":["b"]}', 2)).toEqual([]);
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

  it("orders by indices and ignores ids in the prompt", async () => {
    const candidates = [memory("a", "alpha"), memory("b", "beta")];
    const reranker = new ModelReranker({
      enabled: true,
      timeoutMs: 1000,
      complete: async (prompt) => {
        expect(prompt).not.toContain("id=");
        expect(prompt).toContain("0. alpha");
        return '{"indices":[1,1,4]}';
      },
    });
    const ranked = await reranker.rerank("picnic", candidates);
    expect(ranked.map((row) => row.id)).toEqual(["b"]);
    expect(RERANK_PREVIEW_CHARS).toBe(100);
    expect(RERANK_MAX_TOKENS).toBe(32);
    expect(RERANK_RESPONSE_FORMAT.schema).toMatchObject({
      required: ["indices"],
    });
    expect(rerankPrompt("picnic", candidates)).toContain("indices");
  });

  it("counts a 100-character preview far under a full 512-token chunk", () => {
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
