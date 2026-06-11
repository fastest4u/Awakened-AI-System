import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { cosine, l2normalize, reciprocalRankFusion } from "../src/utils/vector.js";

describe("l2normalize", () => {
  it("scales to unit length", () => {
    const v = l2normalize([3, 4]);
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9);
    assert.ok(Math.abs(v[0] - 0.6) < 1e-9);
    assert.ok(Math.abs(v[1] - 0.8) < 1e-9);
  });

  it("returns a zero vector unchanged (no divide-by-zero)", () => {
    assert.deepEqual(l2normalize([0, 0, 0]), [0, 0, 0]);
  });
});

describe("cosine", () => {
  it("is 1 for identical direction and 0 for orthogonal", () => {
    assert.ok(Math.abs(cosine([1, 0], [2, 0]) - 1) < 1e-9);
    assert.equal(cosine([1, 0], [0, 1]), 0);
  });

  it("is 0 when either vector is zero or empty", () => {
    assert.equal(cosine([0, 0], [1, 1]), 0);
    assert.equal(cosine([], [1, 1]), 0);
  });

  it("returns 0 on a length mismatch instead of silently truncating", () => {
    // Mismatched dimensions mean different embedding spaces; any non-zero
    // score from a truncated dot product would be meaningless.
    assert.equal(cosine([3, 4], [3, 4, 0]), 0);
    assert.equal(cosine([1, 0, 5], [1, 0]), 0);
    assert.equal(cosine([1], []), 0);
  });
});

describe("reciprocalRankFusion", () => {
  it("uses 1/(k+rank) with k=60 by default", () => {
    const fused = reciprocalRankFusion([["x"]]);
    assert.ok(Math.abs((fused.get("x") ?? 0) - 1 / 61) < 1e-12);
  });

  it("a smaller k sharpens rank-1 dominance", () => {
    const fused = reciprocalRankFusion([["x"]], 1);
    assert.ok(Math.abs((fused.get("x") ?? 0) - 1 / 2) < 1e-12);
  });

  it("sums a key's contributions across the lists it appears in", () => {
    // 'a': rank1 in list1 + rank2 in list2; 'b': rank2 in list1 + rank1 in list2.
    const fused = reciprocalRankFusion([["a", "b"], ["b", "a"]]);
    const a = fused.get("a") ?? 0;
    const b = fused.get("b") ?? 0;
    assert.ok(Math.abs(a - b) < 1e-12, "symmetric ranks tie");
    assert.ok(Math.abs(a - (1 / 61 + 1 / 62)) < 1e-12);
    assert.equal(fused.size, 2);
  });

  it("ranks an item appearing in two lists above one appearing in a single list", () => {
    const fused = reciprocalRankFusion([["both", "solo"], ["both"]]);
    assert.ok((fused.get("both") ?? 0) > (fused.get("solo") ?? 0));
  });
});
