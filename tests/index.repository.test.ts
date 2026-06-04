import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { IndexRepository, toPublicRecord, type StoredRecord } from "../src/repositories/index.repository.js";
import { tokenize } from "../src/utils/bm25.js";

function rec(over: Partial<StoredRecord> & { path: string }): StoredRecord {
  return {
    path: over.path,
    title: over.title ?? "",
    type: over.type ?? "note",
    tags: over.tags ?? [],
    aliases: over.aliases ?? [],
    updatedAt: over.updatedAt ?? "2026-01-01",
    createdAt: over.createdAt ?? "2026-01-01",
    excerpt: over.excerpt ?? "",
    mtimeMs: over.mtimeMs ?? 0,
    searchText: over.searchText ?? "",
    outgoingLinks: over.outgoingLinks ?? [],
    id: over.id,
  };
}

describe("IndexRepository ranked search", () => {
  it("returns only documents that match a query term, best-first", () => {
    const index = new IndexRepository();
    index.upsert(rec({ path: "a.md", title: "Backup safety", searchText: "atomic backup verify rollback" }));
    index.upsert(rec({ path: "b.md", title: "Frontmatter parser", searchText: "yaml parse never throw" }));

    const hits = index.rank(tokenize("backup"));
    assert.deepEqual(hits.map((r) => r.path), ["a.md"]);
  });

  it("applies the usage boost to break ties / re-order matches", () => {
    const index = new IndexRepository();
    index.upsert(rec({ path: "a.md", title: "shared topic", searchText: "shared" }));
    index.upsert(rec({ path: "b.md", title: "shared topic", searchText: "shared" }));

    const withBoost = index.rank(tokenize("shared"), (path) => (path === "b.md" ? 100 : 0));
    assert.equal(withBoost[0].path, "b.md");
  });

  it("rebuilds the BM25 model after the record set changes", () => {
    const index = new IndexRepository();
    index.upsert(rec({ path: "a.md", title: "alpha", searchText: "alpha" }));
    assert.equal(index.rank(tokenize("beta")).length, 0);
    index.upsert(rec({ path: "b.md", title: "beta", searchText: "beta" }));
    assert.deepEqual(index.rank(tokenize("beta")).map((r) => r.path), ["b.md"]);
    index.delete("b.md");
    assert.equal(index.rank(tokenize("beta")).length, 0);
  });

  it("toPublicRecord strips internal mtimeMs/searchText/outgoingLinks", () => {
    const pub = toPublicRecord(rec({ path: "a.md", title: "x", searchText: "secret-body", mtimeMs: 999, outgoingLinks: ["b"] }));
    assert.equal("searchText" in pub, false);
    assert.equal("mtimeMs" in pub, false);
    assert.equal("outgoingLinks" in pub, false);
    assert.equal(pub.path, "a.md");
  });
});

describe("IndexRepository backlink graph", () => {
  it("resolves outgoing wikilinks to incoming backlinks by basename/title/alias", () => {
    const index = new IndexRepository();
    index.upsert(rec({ path: "04_Architecture_Decisions/adr-x.md", title: "ADR X", outgoingLinks: ["target-note", "By Title"] }));
    index.upsert(rec({ path: "07_Insights/another.md", title: "Another", outgoingLinks: ["target-note"] }));
    index.upsert(rec({ path: "notes/target-note.md", title: "Target", aliases: ["By Title"] }));

    // adr-x links via basename + alias (deduped to one edge); another links via basename.
    assert.deepEqual(index.incomingLinks("notes/target-note.md"), [
      "04_Architecture_Decisions/adr-x.md",
      "07_Insights/another.md",
    ]);
  });

  it("ignores self-links and unresolved targets, and updates when a source is deleted", () => {
    const index = new IndexRepository();
    index.upsert(rec({ path: "a.md", title: "A", outgoingLinks: ["a", "ghost", "b"] }));
    index.upsert(rec({ path: "b.md", title: "B" }));
    assert.deepEqual(index.incomingLinks("b.md"), ["a.md"]); // a -> b
    assert.deepEqual(index.incomingLinks("a.md"), []);        // self-link "a" + unresolved "ghost"
    index.delete("a.md");
    assert.deepEqual(index.incomingLinks("b.md"), []);        // backlink gone after source removed
  });

  it("resolves backlinks by frontmatter id", () => {
    const index = new IndexRepository();
    index.upsert(rec({ path: "src.md", title: "Src", outgoingLinks: ["adr-007"] }));
    index.upsert(rec({ path: "notes/by-id.md", title: "ById", id: "adr-007" }));
    assert.deepEqual(index.incomingLinks("notes/by-id.md"), ["src.md"]);
  });

  it("lets a note's own path/basename win over another note's title (precedence tiers)", () => {
    const index = new IndexRepository();
    // glossary.md is merely TITLED "Setup"; guide/setup.md IS the note named setup.
    index.upsert(rec({ path: "glossary.md", title: "Setup" }));
    index.upsert(rec({ path: "guide/setup.md", title: "Guide" }));
    index.upsert(rec({ path: "ref.md", title: "Ref", outgoingLinks: ["setup"] }));
    // [[setup]] must land on the basename match, not the earlier-sorted title match.
    assert.deepEqual(index.incomingLinks("guide/setup.md"), ["ref.md"]);
    assert.deepEqual(index.incomingLinks("glossary.md"), []);
  });

  it("resolves an ambiguous basename to the sorted-first path (deterministic)", () => {
    const index = new IndexRepository();
    index.upsert(rec({ path: "z/dup.md", title: "Z" }));
    index.upsert(rec({ path: "a/dup.md", title: "A" }));
    index.upsert(rec({ path: "src.md", outgoingLinks: ["dup"] }));
    assert.deepEqual(index.incomingLinks("a/dup.md"), ["src.md"]);
    assert.deepEqual(index.incomingLinks("z/dup.md"), []);
  });

  it("rebuilds backlinks when a source note's outgoing links change (re-upsert)", () => {
    const index = new IndexRepository();
    index.upsert(rec({ path: "a.md", title: "A", outgoingLinks: ["b"] }));
    index.upsert(rec({ path: "b.md", title: "B" }));
    assert.deepEqual(index.incomingLinks("b.md"), ["a.md"]); // populate the cache
    index.upsert(rec({ path: "a.md", title: "A", outgoingLinks: [] })); // edit: drop the link
    assert.deepEqual(index.incomingLinks("b.md"), []);
  });
});
