import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { extractWikilinks } from "../src/utils/links.js";

describe("extractWikilinks", () => {
  it("captures targets, strips #section/|display/.md, dedupes, and skips empties", () => {
    const links = extractWikilinks(
      "a [[One]] b [[Two|display]] c [[Three#sec]] d [[folder/Four]] e [[One]] f [[Five.md]] g [[trailing/]] h [[]]",
    );
    assert.deepEqual(links, ["One", "Two", "Three", "folder/Four", "Five"]);
  });

  it("returns [] for empty / null input", () => {
    assert.deepEqual(extractWikilinks(""), []);
    assert.deepEqual(extractWikilinks(undefined as unknown as string), []);
  });
});
