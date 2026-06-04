import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { tokenize } from "../src/utils/bm25.js";
import { bestSection, splitSections } from "../src/utils/sections.js";

const BODY = "Intro line.\n\n## Setup\ninstall here.\n\n## Care\nfeed daily.\n";

describe("splitSections", () => {
  it("splits on ATX headings and tracks 1-based start lines (text before the first heading is an intro)", () => {
    const sections = splitSections(BODY);
    assert.deepEqual(sections.map((s) => s.heading), ["", "Setup", "Care"]);
    assert.deepEqual(sections.map((s) => s.line), [1, 3, 6]);
    assert.equal(sections[0].level, 0);
    assert.equal(sections[1].level, 2);
  });
});

describe("bestSection", () => {
  it("picks the section whose heading/text best matches the query (heading weighted)", () => {
    const match = bestSection(BODY, tokenize("care feed"));
    assert.ok(match);
    assert.equal(match!.section, "Care");
    assert.equal(match!.line, 6);
    assert.equal(match!.snippet, "feed daily.");
  });

  it("returns null when there is no term overlap or no query terms", () => {
    assert.equal(bestSection(BODY, tokenize("nonexistent")), null);
    assert.equal(bestSection(BODY, []), null);
  });
});
