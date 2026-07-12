import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";

describe("canonicalJson", () => {
  it("sorts object keys, preserves arrays and strings, and normalizes negative zero", () => {
    assert.equal(
      canonicalJson({ z: -0, a: ["ไทย", 3, true, null], nested: { b: 2, a: 1 } }),
      '{"a":["ไทย",3,true,null],"nested":{"a":1,"b":2},"z":0}',
    );
  });

  it("sorts string keys by JavaScript code-unit order", () => {
    assert.equal(canonicalJson({ "\uE000": 2, "\u{10000}": 1 }), '{"\u{10000}":1,"\uE000":2}');
  });

  it("rejects values outside the JSON domain", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [
      undefined,
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Symbol("x"),
      new Date(),
      cycle,
      () => true,
    ]) {
      assert.throws(() => canonicalJson(value), /CANONICAL_JSON_INVALID/);
    }
  });

  it("rejects symbols, accessors, and class instances instead of silently dropping data", () => {
    class Example { value = 1 }
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 1;
      },
    });
    assert.throws(() => canonicalJson({ [Symbol("x")]: 1 }), /CANONICAL_JSON_INVALID/);
    assert.throws(() => canonicalJson(accessor), /CANONICAL_JSON_INVALID/);
    assert.equal(getterCalls, 0);
    assert.throws(() => canonicalJson(new Example()), /CANONICAL_JSON_INVALID/);
  });
});
