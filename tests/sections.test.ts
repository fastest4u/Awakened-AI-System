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

  it("does not treat '#' lines inside fenced code blocks as headings", () => {
    const body = "## Real\nprose\n\n```bash\n# install deps\nnpm i\n## also not a heading\n```\n\ntail.\n";
    const sections = splitSections(body);
    assert.deepEqual(sections.map((s) => s.heading), ["Real"]);
  });

  it("handles a heading on line 1 (no intro) and an empty body", () => {
    const fromHeading = splitSections("## First\nbody");
    assert.deepEqual(fromHeading.map((s) => s.heading), ["First"]);
    assert.equal(fromHeading[0].line, 1);

    const empty = splitSections("");
    assert.equal(empty.length, 1);
    assert.equal(empty[0].heading, "");
    assert.equal(empty[0].line, 1);
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

  it("prefers a named section over the intro when scores tie", () => {
    const body = "Intro mentions deploy.\n\n## Rollback\ndeploy steps here.\n";
    const match = bestSection(body, tokenize("deploy"));
    assert.ok(match);
    assert.equal(match!.section, "Rollback");
  });
});
