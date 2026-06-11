/**
 * Embedding configuration for the optional Tier 3 hybrid search.
 *
 * Everything is env-driven and OFF by default: with no env set the provider is
 * `none`, no vectors are computed, and search behaves exactly as the lexical
 * Tier 1/2 index. Operators opt in explicitly:
 *
 *   MEMORY_EMBEDDINGS           none | hash | http   (default none; "off"/"0"/"false" -> none)
 *   MEMORY_EMBEDDINGS_DIM       hash vector size      (default 256, clamped 32..4096)
 *   MEMORY_EMBEDDINGS_ENDPOINT  http embeddings URL   (required for http)
 *   MEMORY_EMBEDDINGS_MODEL     http model name       (required for http)
 *   MEMORY_EMBEDDINGS_API_KEY   http bearer token     (optional)
 *   MEMORY_EMBEDDINGS_DIM       (also used as http dimensions hint)
 *   MEMORY_EMBEDDINGS_TIMEOUT_MS  http request timeout (default 15000)
 */
import { HashEmbedder } from "../services/embedding/hash-embedder.js";
import { HttpEmbedder } from "../services/embedding/http-embedder.js";
import type { EmbeddingProvider } from "../services/embedding/embedding-provider.js";

export type EmbeddingProviderKind = "none" | "hash" | "http";

export interface EmbeddingConfig {
  provider: EmbeddingProviderKind;
  dimensions: number;
  /** True when MEMORY_EMBEDDINGS_DIM was set explicitly. The http provider only
   *  sends a `dimensions` request field (and keys its cache id on it) when the
   *  operator actually chose one — `dimensions` alone always carries the
   *  default, so it cannot distinguish "configured 256" from "unset". */
  dimensionsExplicit: boolean;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  timeoutMs: number;
}

const DEFAULT_DIM = 256;
const DEFAULT_TIMEOUT_MS = 15_000;

function parseProvider(raw: string | undefined): EmbeddingProviderKind {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "hash") return "hash";
  if (value === "http" || value === "openai" || value === "ollama") return "http";
  // Everything else — "", "none", "off", "0", "false", or an unknown token —
  // disables embeddings. Unknown values fail safe to off rather than throwing.
  return "none";
}

function parseInt32(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const trimmed = (value: string | undefined) => {
    const v = value?.trim();
    return v && v.length > 0 ? v : undefined;
  };
  const rawDim = trimmed(env.MEMORY_EMBEDDINGS_DIM);
  return {
    provider: parseProvider(env.MEMORY_EMBEDDINGS),
    dimensions: parseInt32(env.MEMORY_EMBEDDINGS_DIM, DEFAULT_DIM),
    dimensionsExplicit: rawDim !== undefined && Number.isFinite(Number.parseInt(rawDim, 10)),
    endpoint: trimmed(env.MEMORY_EMBEDDINGS_ENDPOINT),
    model: trimmed(env.MEMORY_EMBEDDINGS_MODEL),
    apiKey: trimmed(env.MEMORY_EMBEDDINGS_API_KEY),
    timeoutMs: parseInt32(env.MEMORY_EMBEDDINGS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

/**
 * Build the provider for a config, or `undefined` when embeddings are off.
 * Throws on a misconfigured `http` provider (missing endpoint/model) so the
 * operator gets a clear error rather than silent lexical-only fallback; the
 * composition root catches it, logs, and continues without embeddings.
 */
export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider | undefined {
  switch (config.provider) {
    case "hash":
      return new HashEmbedder(config.dimensions);
    case "http":
      if (!config.endpoint || !config.model) {
        throw new Error(
          "MEMORY_EMBEDDINGS=http requires MEMORY_EMBEDDINGS_ENDPOINT and MEMORY_EMBEDDINGS_MODEL",
        );
      }
      return new HttpEmbedder({
        endpoint: config.endpoint,
        model: config.model,
        apiKey: config.apiKey,
        // Only an explicitly configured dim is forwarded; the fallback default
        // (256) is a hash-embedder concern, not a request to reshape the model.
        dimensions: config.dimensionsExplicit ? config.dimensions : undefined,
        timeoutMs: config.timeoutMs,
      });
    case "none":
    default:
      return undefined;
  }
}
