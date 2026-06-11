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
    sizeBytes: over.sizeBytes ?? 0,
    searchText: over.searchText ?? "",
    bodyLineOffset: over.bodyLineOffset ?? 0,
    outgoingLinks: over.outgoingLinks ?? [],
    id: over.id,
    vector: over.vector,
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

  it("toPublicRecord strips internal mtimeMs/sizeBytes/searchText/bodyLineOffset/outgoingLinks/vector", () => {
    const pub = toPublicRecord(rec({ path: "a.md", title: "x", searchText: "secret-body", mtimeMs: 999, sizeBytes: 1234, bodyLineOffset: 6, outgoingLinks: ["b"], vector: [0.1, 0.2] }));
    assert.equal("searchText" in pub, false);
    assert.equal("mtimeMs" in pub, false);
    assert.equal("sizeBytes" in pub, false);
    assert.equal("bodyLineOffset" in pub, false);
    assert.equal("outgoingLinks" in pub, false);
    assert.equal("vector" in pub, false);
    assert.equal(pub.path, "a.md");
  });

  it("caps the usage boost at 0.75x the doc's own BM25 score", () => {
    const index = new IndexRepository();
    index.upsert(rec({ path: "exact.md", title: "deploy runbook", searchText: "deploy runbook steps" }));
    index.upsert(rec({ path: "partial.md", title: "deploy notes", searchText: "deploy" }));

    // partial.md matches only one of two query terms; a huge usage boost
    // (formerly up to +18, uncapped) must not let it beat the exact match.
    const hits = index.rank(tokenize("deploy runbook"), (path) => (path === "partial.md" ? 100 : 0));
    assert.equal(hits[0].path, "exact.md");

    const scored = index.rankScored(tokenize("deploy runbook"), (path) => (path === "partial.md" ? 100 : 0));
    const partial = scored.find((entry) => entry.doc.path === "partial.md");
    const partialPlain = index.rankScored(tokenize("deploy runbook")).find((entry) => entry.doc.path === "partial.md");
    assert.ok(partial && partialPlain);
    assert.ok(partial!.score <= partialPlain!.score * 1.75 + 1e-9, "boost is capped at 0.75x BM25");
    assert.ok(partial!.score > partialPlain!.score, "capped boost still increases the score");
  });

  it("never applies a boost to a doc whose BM25 score is 0", () => {
    const index = new IndexRepository();
    index.upsert(rec({ path: "match.md", title: "deploy", searchText: "deploy" }));
    index.upsert(rec({ path: "popular.md", title: "unrelated", searchText: "nothing here" }));
    const hits = index.rank(tokenize("deploy"), (path) => (path === "popular.md" ? 1000 : 0));
    assert.deepEqual(hits.map((r) => r.path), ["match.md"]);
  });

  it("rankScored returns only matched docs with positive scores, best-first", () => {
    const index = new IndexRepository();
    index.upsert(rec({ path: "a.md", title: "backup backup", searchText: "atomic backup verify backup" }));
    index.upsert(rec({ path: "b.md", title: "mentions backup once", searchText: "unrelated body" }));
    index.upsert(rec({ path: "c.md", title: "nothing", searchText: "nothing" }));
    const scored = index.rankScored(tokenize("backup"));
    assert.deepEqual(scored.map((entry) => entry.doc.path), ["a.md", "b.md"]);
    assert.ok(scored.every((entry) => entry.score > 0));
    assert.ok(scored[0].score >= scored[1].score);
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

describe("IndexRepository hybrid (RRF) search", () => {
  it("falls back to plain rank() when no query vector is given", () => {
    const index = new IndexRepository();
    index.upsert(rec({ path: "a.md", title: "Backup", searchText: "atomic backup verify", vector: [1, 0, 0] }));
    index.upsert(rec({ path: "b.md", title: "Parser", searchText: "yaml parse", vector: [0, 1, 0] }));
    assert.deepEqual(index.rankHybrid(tokenize("backup"), undefined).map((r) => r.path), ["a.md"]);
  });

  it("falls back to plain rank() when no document carries a vector", () => {
    const index = new IndexRepository();
    index.upsert(rec({ path: "a.md", title: "Backup", searchText: "atomic backup" }));
    index.upsert(rec({ path: "b.md", title: "Parser", searchText: "yaml parse" }));
    assert.deepEqual(index.rankHybrid(tokenize("backup"), [1, 0, 0]).map((r) => r.path), ["a.md"]);
  });

  it("surfaces a semantically-near note that shares no query term", () => {
    const index = new IndexRepository();
    index.upsert(rec({ path: "a.md", title: "Backup", searchText: "atomic backup", vector: [1, 0, 0] }));
    index.upsert(rec({ path: "b.md", title: "Recovery", searchText: "restore process", vector: [0, 1, 0] }));
    // Query vector aligns with b.md; query term 'backup' only matches a.md.
    const hits = index.rankHybrid(tokenize("backup"), [0, 1, 0]).map((r) => r.path);
    assert.ok(hits.includes("a.md"), "lexical match present");
    assert.ok(hits.includes("b.md"), "semantic-only match surfaced");
  });

  it("ranks a doc matched by both arms above docs matched by one", () => {
    const index = new IndexRepository();
    index.upsert(rec({ path: "both.md", title: "Backup", searchText: "atomic backup", vector: [1, 0, 0] }));
    index.upsert(rec({ path: "lexonly.md", title: "Backup", searchText: "atomic backup process", vector: [0, 1, 0] }));
    index.upsert(rec({ path: "veconly.md", title: "Other", searchText: "unrelated content", vector: [1, 0, 0] }));
    const hits = index.rankHybrid(tokenize("backup"), [1, 0, 0]).map((r) => r.path);
    assert.equal(hits[0], "both.md");
  });

  it("usage arm only re-orders candidates — never injects an unrelated note", () => {
    const index = new IndexRepository();
    index.upsert(rec({ path: "match.md", title: "Backup", searchText: "atomic backup", vector: [1, 0, 0] }));
    index.upsert(rec({ path: "popular.md", title: "Unrelated", searchText: "nothing here", vector: [0, 1, 0] }));
    // popular.md matches neither the term 'backup' nor the (orthogonal) query vector,
    // so a huge usage boost must not pull it into the results.
    const hits = index.rankHybrid(tokenize("backup"), [1, 0, 0], (path) => (path === "popular.md" ? 1000 : 0)).map((r) => r.path);
    assert.deepEqual(hits, ["match.md"]);
  });

  it("vector arm skips weakly-similar candidates (cosine < 0.15)", () => {
    const index = new IndexRepository();
    // cosine vs query [1,0,0]: strong.md ~0.30, weak.md ~0.10 — only strong passes the floor.
    index.upsert(rec({ path: "strong.md", title: "Other", searchText: "unrelated body", vector: [0.3, 0.9539392, 0] }));
    index.upsert(rec({ path: "weak.md", title: "Another", searchText: "also unrelated", vector: [0.1, 0.99498744, 0] }));
    index.upsert(rec({ path: "lex.md", title: "Backup", searchText: "atomic backup" }));
    const hits = index.rankHybrid(tokenize("backup"), [1, 0, 0]).map((r) => r.path);
    assert.ok(hits.includes("lex.md"), "lexical match kept");
    assert.ok(hits.includes("strong.md"), "candidate above the similarity floor surfaced");
    assert.ok(!hits.includes("weak.md"), "near-orthogonal candidate is not injected");
  });
});
