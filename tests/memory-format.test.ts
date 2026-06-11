import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { basenameWithoutExtension, slugify } from "../src/utils/memory-format.js";

describe("slugify", () => {
  it("lowercases and collapses whitespace/punctuation runs to single hyphens", () => {
    assert.equal(slugify("Hello, World!"), "hello-world");
    assert.equal(slugify("A  --  B__C"), "a-b-c");
  });

  it("trims leading/trailing hyphens", () => {
    assert.equal(slugify("--abc--"), "abc");
    assert.equal(slugify("  (abc)  "), "abc");
  });

  it("preserves Thai text instead of collapsing it to 'untitled'", () => {
    assert.equal(slugify("ความจำ ระบบ"), "ความจำ-ระบบ");
    // Combining vowel/tone marks (\p{M}) must survive, not just base letters.
    assert.equal(slugify("หน่วยความจำถาวร"), "หน่วยความจำถาวร");
  });

  it("keeps mixed Thai/Latin/digit titles intact", () => {
    assert.equal(slugify("SPX แผน Q3 2026"), "spx-แผน-q3-2026");
  });

  it("returns 'untitled' only for genuinely empty input", () => {
    assert.equal(slugify(""), "untitled");
    assert.equal(slugify("   "), "untitled");
    assert.equal(slugify("!!! ??? ..."), "untitled");
    assert.equal(slugify(undefined as unknown as string), "untitled");
    assert.notEqual(slugify("ความจำ"), "untitled");
  });

  it("caps at 80 UTF-16 units without trailing hyphens", () => {
    const slug = slugify("a".repeat(50) + " " + "b".repeat(50));
    assert.ok(slug.length <= 80);
    assert.doesNotMatch(slug, /-$/);
    assert.equal(slug, "a".repeat(50) + "-" + "b".repeat(29));
  });

  it("never splits a surrogate pair at the 80-unit cap", () => {
    // 79 BMP letters + an astral letter (2 UTF-16 units) straddling the cap:
    // the lone high surrogate must be dropped, not kept as invalid UTF-16.
    const astral = "\u{20000}"; // CJK Ext-B ideograph, \p{L}, 2 units
    const slug = slugify("a".repeat(79) + astral + astral);
    assert.equal(slug, "a".repeat(79));
    assert.doesNotMatch(slug, /[\uD800-\uDBFF]$/, "must not end on a lone high surrogate");
  });
});

describe("basenameWithoutExtension", () => {
  it("strips folders and the .md extension across path styles", () => {
    assert.equal(basenameWithoutExtension("04_ADRs/adr-001.md"), "adr-001");
    assert.equal(basenameWithoutExtension("04_ADRs\\adr-001.MD"), "adr-001");
    assert.equal(basenameWithoutExtension("plain"), "plain");
  });
});
