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

  it("toPublicRecord strips internal mtimeMs/searchText", () => {
    const pub = toPublicRecord(rec({ path: "a.md", title: "x", searchText: "secret-body", mtimeMs: 999 }));
    assert.equal("searchText" in pub, false);
    assert.equal("mtimeMs" in pub, false);
    assert.equal(pub.path, "a.md");
  });
});
