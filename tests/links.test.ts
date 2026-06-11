import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildWikilinkResolver, extractWikilinks } from "../src/utils/links.js";

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

describe("buildWikilinkResolver", () => {
  it("resolves by path, basename, title, id, and alias (case-insensitive, .md stripped)", () => {
    const resolve = buildWikilinkResolver([
      { path: "04_ADRs/adr-001-pick-db.md", title: "ADR-001 - Pick a Database", id: "adr-001" },
      { path: "07_Insights/cache.md", aliases: ["Caching Lessons"] },
    ]);
    assert.equal(resolve("04_ADRs/adr-001-pick-db"), "04_ADRs/adr-001-pick-db.md");
    assert.equal(resolve("04_ADRs/adr-001-pick-db.md"), "04_ADRs/adr-001-pick-db.md");
    assert.equal(resolve("adr-001-pick-db"), "04_ADRs/adr-001-pick-db.md");
    assert.equal(resolve("ADR-001 - Pick a Database"), "04_ADRs/adr-001-pick-db.md");
    assert.equal(resolve("adr-001 - pick a database"), "04_ADRs/adr-001-pick-db.md");
    assert.equal(resolve("ADR-001"), "04_ADRs/adr-001-pick-db.md");
    assert.equal(resolve("caching lessons"), "07_Insights/cache.md");
    assert.equal(resolve("Missing Note"), undefined);
  });

  it("gives path/basename precedence over another note's title", () => {
    const resolve = buildWikilinkResolver([
      { path: "b/other.md", title: "Setup" },
      { path: "a/setup.md", title: "Install Guide" },
    ]);
    // "setup" is a's basename (tier 1), which beats b's title (tier 2).
    assert.equal(resolve("Setup"), "a/setup.md");
    // a's own title still resolves to a via the unclaimed title key.
    assert.equal(resolve("Install Guide"), "a/setup.md");
  });

  it("gives title/id precedence over another note's alias", () => {
    const resolve = buildWikilinkResolver([
      { path: "a/one.md", aliases: ["Guide"] },
      { path: "b/two.md", title: "Guide" },
    ]);
    assert.equal(resolve("guide"), "b/two.md");
  });

  it("breaks a within-tier collision to the lexicographically-first path", () => {
    const resolve = buildWikilinkResolver([
      { path: "z/note.md" },
      { path: "a/note.md" },
    ]);
    assert.equal(resolve("note"), "a/note.md");
  });

  it("trims and handles nullish targets safely", () => {
    const resolve = buildWikilinkResolver([{ path: "a/setup.md" }]);
    assert.equal(resolve("  setup  "), "a/setup.md");
    assert.equal(resolve(undefined as unknown as string), undefined);
  });
});
