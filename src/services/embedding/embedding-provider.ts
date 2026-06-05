/**
 * Pluggable embedding provider for the optional Tier 3 hybrid (lexical + vector)
 * search. The default build ships no provider (see config/embedding.config.ts);
 * a provider is created only when the operator opts in via env, keeping the
 * server local-first and offline by default.
 */
export interface EmbeddingProvider {
  /**
   * Stable identity for this provider+model+shape, persisted in the index cache
   * as the `embedder` signature. When it changes (provider swapped, model or
   * dimensionality changed) the cached vectors are dropped and re-embedded, so
   * vectors from one embedding space are never compared against another.
   */
  readonly id: string;

  /** Vector dimensionality this provider emits (informational; 0 if unknown until first call). */
  readonly dimensions: number;

  /**
   * Embed a batch of texts into one (ideally L2-normalized) vector each, in the
   * same order. Returns `[]` for empty input. Implementations throw on hard
   * failure (e.g. a network/endpoint error) — callers in the index/query path
   * catch and degrade gracefully to lexical-only ranking, never failing a query.
   */
  embed(texts: string[]): Promise<number[][]>;
}
