import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { HashEmbedder } from "../src/services/embedding/hash-embedder.js";
import { cosine } from "../src/utils/vector.js";

describe("HashEmbedder", () => {
  it("is deterministic and emits unit-length vectors of the configured dim", async () => {
    const embedder = new HashEmbedder(64);
    const [a] = await embedder.embed(["atomic backup verify"]);
    const [b] = await embedder.embed(["atomic backup verify"]);
    assert.equal(a.length, 64);
    assert.deepEqual(a, b);
    assert.ok(Math.abs(Math.hypot(...a) - 1) < 1e-9);
  });

  it("scores related text more similar than unrelated text", async () => {
    const embedder = new HashEmbedder(512);
    const [query, near, far] = await embedder.embed([
      "backup rollback snapshot safety",
      "atomic backup and rollback verification",
      "frontmatter yaml parser tokens",
    ]);
    assert.ok(cosine(query, near) > cosine(query, far));
  });

  it("clamps the dimension and exposes a stable id", () => {
    assert.equal(new HashEmbedder(8).dimensions, 32); // floored to the min
    assert.equal(new HashEmbedder(99_999).dimensions, 4096); // capped to the max
    assert.equal(new HashEmbedder(256).id, "hash:v1:256");
    assert.equal(new HashEmbedder(256).dimensions, 256);
  });

  it("returns [] for empty input", async () => {
    assert.deepEqual(await new HashEmbedder().embed([]), []);
  });

  it("produces a finite (zero) vector for feature-less text", async () => {
    const [v] = await new HashEmbedder(64).embed([""]);
    assert.equal(v.length, 64);
    assert.ok(v.every((x) => Number.isFinite(x)));
    assert.ok(v.every((x) => x === 0));
  });
});
