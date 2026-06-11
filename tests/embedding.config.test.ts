import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createEmbeddingProvider, loadEmbeddingConfig } from "../src/config/embedding.config.js";
import { HashEmbedder } from "../src/services/embedding/hash-embedder.js";
import { HttpEmbedder } from "../src/services/embedding/http-embedder.js";

describe("loadEmbeddingConfig", () => {
  it("defaults to provider 'none' with no env", () => {
    assert.equal(loadEmbeddingConfig({}).provider, "none");
  });

  it("maps off-ish/unknown values to none and known values through", () => {
    assert.equal(loadEmbeddingConfig({ MEMORY_EMBEDDINGS: "off" }).provider, "none");
    assert.equal(loadEmbeddingConfig({ MEMORY_EMBEDDINGS: "false" }).provider, "none");
    assert.equal(loadEmbeddingConfig({ MEMORY_EMBEDDINGS: "garbage" }).provider, "none");
    assert.equal(loadEmbeddingConfig({ MEMORY_EMBEDDINGS: "HASH" }).provider, "hash");
    assert.equal(loadEmbeddingConfig({ MEMORY_EMBEDDINGS: "http" }).provider, "http");
    assert.equal(loadEmbeddingConfig({ MEMORY_EMBEDDINGS: "openai" }).provider, "http");
    assert.equal(loadEmbeddingConfig({ MEMORY_EMBEDDINGS: "ollama" }).provider, "http");
  });

  it("parses dim/endpoint/model/timeout with sane fallbacks", () => {
    const config = loadEmbeddingConfig({
      MEMORY_EMBEDDINGS: "http",
      MEMORY_EMBEDDINGS_DIM: "1024",
      MEMORY_EMBEDDINGS_ENDPOINT: "http://x/embeddings",
      MEMORY_EMBEDDINGS_MODEL: "m",
      MEMORY_EMBEDDINGS_TIMEOUT_MS: "5000",
    });
    assert.equal(config.dimensions, 1024);
    assert.equal(config.endpoint, "http://x/embeddings");
    assert.equal(config.model, "m");
    assert.equal(config.timeoutMs, 5000);

    const defaults = loadEmbeddingConfig({ MEMORY_EMBEDDINGS: "hash" });
    assert.equal(defaults.dimensions, 256);
    assert.equal(defaults.timeoutMs, 15_000);
    assert.equal(defaults.endpoint, undefined);
  });

  it("tracks whether MEMORY_EMBEDDINGS_DIM was explicitly configured", () => {
    assert.equal(loadEmbeddingConfig({}).dimensionsExplicit, false);
    assert.equal(loadEmbeddingConfig({ MEMORY_EMBEDDINGS_DIM: "  " }).dimensionsExplicit, false);
    assert.equal(loadEmbeddingConfig({ MEMORY_EMBEDDINGS_DIM: "garbage" }).dimensionsExplicit, false);
    assert.equal(loadEmbeddingConfig({ MEMORY_EMBEDDINGS_DIM: "1024" }).dimensionsExplicit, true);
  });
});

describe("createEmbeddingProvider", () => {
  it("returns undefined for none", () => {
    assert.equal(createEmbeddingProvider(loadEmbeddingConfig({})), undefined);
  });

  it("creates a HashEmbedder for hash with the configured dim", () => {
    const provider = createEmbeddingProvider(loadEmbeddingConfig({ MEMORY_EMBEDDINGS: "hash", MEMORY_EMBEDDINGS_DIM: "128" }));
    assert.ok(provider instanceof HashEmbedder);
    assert.equal(provider?.dimensions, 128);
  });

  it("creates an HttpEmbedder when endpoint+model are present", () => {
    const provider = createEmbeddingProvider(loadEmbeddingConfig({
      MEMORY_EMBEDDINGS: "http",
      MEMORY_EMBEDDINGS_ENDPOINT: "http://x",
      MEMORY_EMBEDDINGS_MODEL: "m",
    }));
    assert.ok(provider instanceof HttpEmbedder);
    // The fallback default dim (a hash-embedder concern) must NOT be forwarded
    // to the http provider — only an explicitly configured value is.
    assert.equal(provider?.id, "http:m:0");
  });

  it("forwards an explicitly configured dim to the http provider", () => {
    const provider = createEmbeddingProvider(loadEmbeddingConfig({
      MEMORY_EMBEDDINGS: "http",
      MEMORY_EMBEDDINGS_ENDPOINT: "http://x",
      MEMORY_EMBEDDINGS_MODEL: "m",
      MEMORY_EMBEDDINGS_DIM: "1024",
    }));
    assert.ok(provider instanceof HttpEmbedder);
    assert.equal(provider?.dimensions, 1024);
    assert.equal(provider?.id, "http:m:1024");
  });

  it("throws a clear error for http without endpoint/model", () => {
    assert.throws(
      () => createEmbeddingProvider(loadEmbeddingConfig({ MEMORY_EMBEDDINGS: "http" })),
      /requires MEMORY_EMBEDDINGS_ENDPOINT and MEMORY_EMBEDDINGS_MODEL/,
    );
  });
});
