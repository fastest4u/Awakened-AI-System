import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { HttpEmbedder, extractVectors } from "../src/services/embedding/http-embedder.js";

describe("extractVectors", () => {
  it("parses the OpenAI { data: [{ embedding }] } shape", () => {
    assert.deepEqual(extractVectors({ data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] }), [[1, 2], [3, 4]]);
  });

  it("parses the Ollama batch { embeddings: [[...]] } shape", () => {
    assert.deepEqual(extractVectors({ embeddings: [[1, 2]] }), [[1, 2]]);
  });

  it("parses the single { embedding: [...] } shape", () => {
    assert.deepEqual(extractVectors({ embedding: [5, 6] }), [[5, 6]]);
  });

  it("returns [] for unknown or non-object shapes", () => {
    assert.deepEqual(extractVectors({ foo: 1 }), []);
    assert.deepEqual(extractVectors(null), []);
    assert.deepEqual(extractVectors("nope"), []);
  });
});

type FakeResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
function response(payload: unknown, ok = true, status = 200): FakeResponse {
  return { ok, status, json: async () => payload };
}

describe("HttpEmbedder", () => {
  it("posts { model, input } and returns L2-normalized vectors", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init.body));
      return response({ data: [{ embedding: [3, 4] }] });
    }) as unknown as typeof fetch;
    const embedder = new HttpEmbedder({ endpoint: "http://x/embeddings", model: "m", fetchImpl });
    const [v] = await embedder.embed(["hi"]);
    assert.equal(seenUrl, "http://x/embeddings");
    // No dimensions configured -> no `dimensions` request field, and dims 0 in the id.
    assert.deepEqual(seenBody, { model: "m", input: ["hi"] });
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9, "vector is normalized");
    assert.ok(Math.abs(v[0] - 0.6) < 1e-9);
    assert.equal(embedder.id, "http:m:0");
  });

  it("sends `dimensions` and keys its id on it when explicitly configured", async () => {
    let seenBody: unknown;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seenBody = JSON.parse(String(init.body));
      return response({ data: [{ embedding: [1, 0] }] });
    }) as unknown as typeof fetch;
    const embedder = new HttpEmbedder({ endpoint: "http://x", model: "m", dimensions: 512, fetchImpl });
    await embedder.embed(["hi"]);
    assert.deepEqual(seenBody, { model: "m", input: ["hi"], dimensions: 512 });
    // A dim change must invalidate cached vectors via the embedder signature.
    assert.equal(embedder.id, "http:m:512");
  });

  it("throws a descriptive error when returned vectors differ in length", async () => {
    const fetchImpl = (async () => response({ data: [{ embedding: [1, 2, 3] }, { embedding: [1, 2] }] })) as unknown as typeof fetch;
    const embedder = new HttpEmbedder({ endpoint: "http://x", model: "m", fetchImpl });
    await assert.rejects(() => embedder.embed(["a", "b"]), /differing lengths \(3 vs 2\)/);
  });

  it("sends a bearer token only when an apiKey is set", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return response({ data: [{ embedding: [1] }] });
    }) as unknown as typeof fetch;
    await new HttpEmbedder({ endpoint: "http://x", model: "m", apiKey: "secret", fetchImpl }).embed(["hi"]);
    assert.equal(headers.authorization, "Bearer secret");
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl = (async () => response({}, false, 500)) as unknown as typeof fetch;
    const embedder = new HttpEmbedder({ endpoint: "http://x", model: "m", fetchImpl });
    await assert.rejects(() => embedder.embed(["hi"]), /HTTP 500/);
  });

  it("throws when the vector count does not match the input count", async () => {
    const fetchImpl = (async () => response({ data: [] })) as unknown as typeof fetch;
    const embedder = new HttpEmbedder({ endpoint: "http://x", model: "m", fetchImpl });
    await assert.rejects(() => embedder.embed(["a", "b"]), /vectors for/);
  });

  it("returns [] for empty input without calling fetch", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return response({});
    }) as unknown as typeof fetch;
    const embedder = new HttpEmbedder({ endpoint: "http://x", model: "m", fetchImpl });
    assert.deepEqual(await embedder.embed([]), []);
    assert.equal(called, false);
  });
});
