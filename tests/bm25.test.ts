import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { Bm25Index, tokenize, weighted } from "../src/utils/bm25.js";

describe("tokenize", () => {
  it("lowercases, splits on punctuation, and drops single chars", () => {
    assert.deepEqual(tokenize("Hello, World! a I"), ["hello", "world"]);
  });

  it("keeps hyphen/underscore inside a token (kebab tags stay whole)", () => {
    assert.deepEqual(tokenize("session-log schema_version"), ["session-log", "schema_version"]);
  });

  it("preserves Thai tokens", () => {
    assert.deepEqual(tokenize("บันทึก ความจำ"), ["บันทึก", "ความจำ"]);
  });

  it("handles non-strings safely", () => {
    assert.deepEqual(tokenize(undefined), []);
    assert.deepEqual(tokenize(123), ["123"]);
  });
});

describe("weighted", () => {
  it("repeats the term list", () => {
    assert.deepEqual(weighted(["a", "b"], 3), ["a", "b", "a", "b", "a", "b"]);
  });
  it("is a no-op for times <= 1", () => {
    assert.deepEqual(weighted(["a"], 1), ["a"]);
  });
});

describe("Bm25Index", () => {
  const index = new Bm25Index([
    { doc: "A", terms: tokenize("backup atomic backup verify") },
    { doc: "B", terms: tokenize("frontmatter yaml parser") },
    { doc: "C", terms: tokenize("backup rollback snapshot") },
  ]);

  it("scores only documents containing a query term", () => {
    const scores = new Map(index.score(tokenize("backup")).map((r) => [r.doc, r.score]));
    assert.ok((scores.get("A") ?? 0) > 0);
    assert.ok((scores.get("C") ?? 0) > 0);
    assert.equal(scores.get("B"), 0);
  });

  it("ranks higher term-frequency first (A has 'backup' twice, C once)", () => {
    const ranked = index.score(tokenize("backup")).sort((a, b) => b.score - a.score);
    assert.equal(ranked[0].doc, "A");
  });

  it("returns all-zero scores for an out-of-vocabulary query", () => {
    assert.ok(index.score(tokenize("zzz nonexistent")).every((r) => r.score === 0));
  });
});
