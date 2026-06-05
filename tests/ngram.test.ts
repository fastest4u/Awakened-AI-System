import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { charNgrams, searchTokens } from "../src/utils/ngram.js";

describe("charNgrams", () => {
  it("produces sliding 2- and 3-grams by default", () => {
    assert.deepEqual(charNgrams("abcd"), ["ab", "bc", "cd", "abc", "bcd"]);
  });

  it("is code-point safe (counts characters, not UTF-16 units)", () => {
    // An astral char is 2 UTF-16 units; the n-gram must treat it as one char.
    assert.deepEqual(charNgrams("\u{1F600}\u{1F600}", 2, 2), ["\u{1F600}\u{1F600}"]);
  });

  it("skips an n longer than the run", () => {
    assert.deepEqual(charNgrams("ab", 2, 3), ["ab"]);
  });

  it("supports a custom range", () => {
    assert.deepEqual(charNgrams("abcde", 3, 4), ["abc", "bcd", "cde", "abcd", "bcde"]);
  });

  it("returns [] for an empty/nullish run", () => {
    assert.deepEqual(charNgrams(""), []);
    assert.deepEqual(charNgrams(undefined as unknown as string), []);
  });
});

describe("searchTokens", () => {
  it("is identical to word tokens for Latin/code (no n-grams added)", () => {
    assert.deepEqual(searchTokens("Hello, World! session-log"), ["hello", "world", "session-log"]);
    assert.deepEqual(searchTokens("just english 123"), ["just", "english", "123"]);
  });

  it("keeps the whole Thai word token and adds character n-grams", () => {
    const tokens = searchTokens("ความจำ"); // "ความจำ"
    assert.ok(tokens.includes("ความจำ"), "retains the full word token");
    assert.ok(tokens.length > 1, "appends n-grams beyond the single word token");
  });

  it("lets a Thai substring query overlap a longer Thai word via shared n-grams", () => {
    const docTokens = new Set(searchTokens("หน่วยความจำ")); // "หน่วยความจำ"
    const queryTokens = searchTokens("ความจำ"); // "ความจำ"
    assert.ok(queryTokens.some((token) => docTokens.has(token)), "query and doc share at least one n-gram");
  });

  it("handles a CJK run", () => {
    const tokens = searchTokens("メモリ"); // katakana "メモリ"
    assert.ok(tokens.length >= 1);
  });

  it("handles non-strings safely", () => {
    assert.deepEqual(searchTokens(undefined), []);
  });
});
