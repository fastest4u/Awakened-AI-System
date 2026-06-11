/**
 * Optional HTTP embedding provider (opt-in, OFF by default). Targets the common
 * OpenAI-compatible `/v1/embeddings` shape (`{ model, input: string[] }` ->
 * `{ data: [{ embedding }] }`) and also accepts Ollama's `{ embeddings }` /
 * `{ embedding }` shapes, so a local model server (Ollama, llama.cpp, LM Studio)
 * or a hosted endpoint both work. This is the path to true cross-lingual
 * (Thai<->English) semantic recall; it requires network/an external service, so
 * it is never enabled unless the operator configures it explicitly.
 */
import { l2normalize } from "../../utils/vector.js";
import type { EmbeddingProvider } from "./embedding-provider.js";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpEmbedderOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
  /** Set only when the operator explicitly configured a dimensionality; it is
   *  then sent as `dimensions` in the request body (OpenAI shape) and baked
   *  into the embedder id so changing it invalidates cached vectors. */
  dimensions?: number;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch (Node >= 18). */
  fetchImpl?: FetchLike;
}

/** Pull vectors out of the known response shapes, defensively. Throws only for
 *  an index-tagged OpenAI response whose indices are inconsistent (duplicate,
 *  out-of-range, or present on some entries but not others) — callers treat a
 *  throw like any other provider failure (catch + cooldown). */
export function extractVectors(json: unknown): number[][] {
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  // OpenAI: { data: [{ embedding: number[], index?: number }, ...] }
  if (Array.isArray(obj.data)) {
    const entries = obj.data;
    const toVector = (entry: unknown) => {
      const embedding = (entry as { embedding?: unknown } | null)?.embedding;
      return Array.isArray(embedding) ? embedding.map(Number) : [];
    };
    const indexOf = (entry: unknown) => (entry as { index?: unknown } | null)?.index;
    // No index fields -> positional order (Ollama-style lookalikes and older shapes).
    if (!entries.some((entry) => typeof indexOf(entry) === "number")) return entries.map(toVector);
    // OpenAI tags each entry with its input position and does not guarantee
    // array order; place each vector at its declared index. Inconsistent
    // indices (duplicate, out-of-range, missing on some entries) are malformed.
    const out = new Array<number[]>(entries.length);
    for (const entry of entries) {
      const index = indexOf(entry);
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= entries.length) {
        throw new Error(`embedding response entry has an invalid index (${String(index)})`);
      }
      if (out[index] !== undefined) {
        throw new Error(`embedding response repeats index ${index}`);
      }
      out[index] = toVector(entry);
    }
    return out;
  }
  // Ollama /api/embed (batch): { embeddings: number[][] }
  if (Array.isArray(obj.embeddings)) {
    return obj.embeddings.map((vec) => (Array.isArray(vec) ? vec.map(Number) : []));
  }
  // Ollama /api/embeddings (single): { embedding: number[] }
  if (Array.isArray(obj.embedding)) {
    return [obj.embedding.map(Number)];
  }
  return [];
}

export class HttpEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: HttpEmbedderOptions) {
    this.endpoint = options.endpoint;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.dimensions = options.dimensions ?? 0;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    const provided = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!provided) throw new Error("HttpEmbedder requires a fetch implementation (global fetch unavailable)");
    this.fetchImpl = provided;
    // Identity keys on the model AND its dimensionality (the vector space), not
    // the endpoint, so moving the same model between hosts does not needlessly
    // invalidate the cache — but a dim change does (0 = endpoint default).
    this.id = `http:${this.model}:${this.dimensions}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      // `dimensions` is sent only when explicitly configured; endpoints that do
      // not support it would otherwise reject the request.
      body: JSON.stringify({ model: this.model, input: texts, ...(this.dimensions > 0 ? { dimensions: this.dimensions } : {}) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`embedding endpoint ${this.endpoint} returned HTTP ${response.status}`);
    }
    const vectors = extractVectors(await response.json());
    if (vectors.length !== texts.length) {
      throw new Error(`embedding endpoint returned ${vectors.length} vectors for ${texts.length} inputs`);
    }
    // Mixed dimensionality means at least one vector is malformed/truncated —
    // cosine over mismatched lengths would silently compare garbage.
    const dims = vectors[0]?.length ?? 0;
    const mismatch = vectors.find((vec) => vec.length !== dims);
    if (mismatch) {
      throw new Error(`embedding endpoint returned vectors of differing lengths (${dims} vs ${mismatch.length}); expected a uniform dimensionality`);
    }
    return vectors.map((vec) => l2normalize(vec));
  }
}
