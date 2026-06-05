import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { IndexRepository } from "../src/repositories/index.repository.js";
import type { EmbeddingProvider } from "../src/services/embedding/embedding-provider.js";
import { MemoryQueryService } from "../src/services/memory-query.service.js";
import { VaultService } from "../src/services/vault.service.js";

const NOTE_A = `---\ntitle: "Backup safety"\ntype: insight\ncreated: "2026-01-01"\nupdated: "2026-01-02"\ntags:\n  - safety\n---\n\nAtomic backup verify and rollback snapshot.\n`;
const NOTE_B = `---\ntitle: "Frontmatter parser"\ntype: insight\ncreated: "2026-01-01"\nupdated: "2026-01-03"\n---\n\nNever-throw yaml parser.\n`;

describe("MemoryQueryService incremental + ranked index", () => {
  let root: string;
  let query: MemoryQueryService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mem-query-"));
    writeFileSync(join(root, "a.md"), NOTE_A);
    writeFileSync(join(root, "b.md"), NOTE_B);
    query = new MemoryQueryService(new VaultService(root), new IndexRepository());
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("ranks the matching note first and returns lean public records", async () => {
    const results = await query.search("backup", [], undefined, undefined, 10, 0);
    assert.equal(results[0].path, "a.md");
    assert.ok(!results.some((r) => r.path === "b.md"));
    // Internal index fields must not leak into results.
    assert.equal("searchText" in results[0], false);
    assert.equal("mtimeMs" in results[0], false);
  });

  it("searches body text, not just the title", async () => {
    const results = await query.search("rollback", [], undefined, undefined, 10, 0);
    assert.deepEqual(results.map((r) => r.path), ["a.md"]);
  });

  it("persists the index cache to .memory-mcp/index.json", async () => {
    await query.search("backup", [], undefined, undefined, 10, 0);
    const cache = join(root, ".memory-mcp", "index.json");
    assert.ok(existsSync(cache));
    const parsed = JSON.parse(readFileSync(cache, "utf8"));
    assert.equal(parsed.version, 2);
    assert.ok(parsed.records["a.md"]);
  });

  it("incrementally picks up a modified note (new mtime) and drops a deleted one", async () => {
    await query.search("backup", [], undefined, undefined, 10, 0);

    // Modify a.md and force a newer mtime so the incremental scan re-parses it.
    writeFileSync(join(root, "a.md"), `---\ntitle: "Backup safety"\ntype: insight\ncreated: "2026-01-01"\nupdated: "2026-01-02"\n---\n\nNow mentions elephant.\n`);
    const future = new Date(Date.now() + 10_000);
    utimesSync(join(root, "a.md"), future, future);

    const elephant = await query.search("elephant", [], undefined, undefined, 10, 0);
    assert.deepEqual(elephant.map((r) => r.path), ["a.md"]);

    // Delete b.md -> it should disappear from the index.
    rmSync(join(root, "b.md"));
    const parser = await query.search("parser", [], undefined, undefined, 10, 0);
    assert.equal(parser.length, 0);
  });

  it("force reindex rebuilds from scratch", async () => {
    const records = await query.snapshotIndex({ force: true });
    assert.equal(records.length, 2);
  });

  it("empty query returns notes newest-first", async () => {
    const results = await query.search("", [], undefined, undefined, 10, 0);
    // b.md updated 2026-01-03 is newer than a.md 2026-01-02.
    assert.equal(results[0].path, "b.md");
  });

  it("falls back to newest-first for a non-empty query that tokenizes to nothing", async () => {
    // Punctuation/single-char queries drop to zero terms; they must not silently
    // return an empty result (the substring-search behaviour they replaced did not).
    const results = await query.search("?", [], undefined, undefined, 10, 0);
    assert.equal(results.length, 2);
    assert.equal(results[0].path, "b.md");
  });

  it("skips a note that fails to read instead of breaking the whole index", async () => {
    class FlakyVault extends VaultService {
      load(relative: string) {
        if (relative === "a.md") throw new Error("EBUSY: simulated lock");
        return super.load(relative);
      }
    }
    const flaky = new MemoryQueryService(new FlakyVault(root), new IndexRepository());
    const results = await flaky.search("parser", [], undefined, undefined, 10, 0);
    // a.md throws on read and is skipped; b.md still indexes and ranks.
    assert.deepEqual(results.map((r) => r.path), ["b.md"]);
  });

  it("survives a shape-wrong persisted record (no tags) without throwing in BM25", async () => {
    await query.search("backup", [], undefined, undefined, 10, 0); // seed a real cache + mtimes
    const mtimeMs = statSync(join(root, "a.md")).mtimeMs;
    // Tamper the cache: a.md matches the file mtime (so it is NOT re-read) but is
    // missing tags/aliases — unguarded this crashes documentTerms (`tags.join`).
    mkdirSync(join(root, ".memory-mcp"), { recursive: true });
    writeFileSync(
      join(root, ".memory-mcp", "index.json"),
      JSON.stringify({
        version: 2,
        updatedAt: "2026-01-01T00:00:00.000Z",
        records: { "a.md": { path: "a.md", title: "Backup safety", type: "insight", searchText: "atomic backup", mtimeMs } },
      }),
    );
    const reopened = new MemoryQueryService(new VaultService(root), new IndexRepository());
    const results = await reopened.search("backup", [], undefined, undefined, 10, 0);
    assert.ok(results.some((r) => r.path === "a.md"));
  });

  it("ignores a stale-schema (old version) persisted cache instead of trusting it", async () => {
    mkdirSync(join(root, ".memory-mcp"), { recursive: true });
    // A Tier-1 (version 1) cache is now stale; it must be ignored and rebuilt by mtime.
    writeFileSync(
      join(root, ".memory-mcp", "index.json"),
      JSON.stringify({ version: 1, updatedAt: "2026-01-01T00:00:00.000Z", records: { "ghost.md": { path: "ghost.md" } } }),
    );
    const reopened = new MemoryQueryService(new VaultService(root), new IndexRepository());
    const records = await reopened.snapshotIndex();
    assert.ok(!records.some((r) => r.path === "ghost.md"));
    assert.equal(records.length, 2);
  });

  it("writes the index cache atomically (no leftover temp file)", async () => {
    await query.search("backup", [], undefined, undefined, 10, 0);
    const dir = join(root, ".memory-mcp");
    assert.ok(existsSync(join(dir, "index.json")));
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
  });

  it("get() returns real backlinks resolved from the wikilink graph", async () => {
    writeFileSync(
      join(root, "c.md"),
      `---\ntitle: "Linker"\ntype: note\ncreated: "2026-01-01"\nupdated: "2026-01-05"\n---\n\nSee [[Backup safety]] for details.\n`,
    );
    const note = await query.get("a.md");
    // c.md links to a.md via its title "Backup safety"; a.md links to nothing.
    assert.deepEqual(note.incomingLinks, ["c.md"]);
    assert.deepEqual(note.outgoingLinks, []);
  });

  it("search with includeSections attaches the best-matching section anchor", async () => {
    writeFileSync(
      join(root, "doc.md"),
      `---\ntitle: "Doc"\ntype: note\ncreated: "2026-01-01"\nupdated: "2026-01-06"\n---\n\nIntro.\n\n## Setup\ninstall steps.\n\n## Elephant care\nfeed the elephant daily.\n`,
    );
    const withSections = await query.search("elephant", [], undefined, undefined, 10, 0, true);
    const hit = withSections.find((r) => r.path === "doc.md");
    assert.ok(hit, "doc.md should match 'elephant'");
    assert.equal(hit!.match?.section, "Elephant care");
    assert.ok((hit!.match?.line ?? 0) > 0);

    // Default (no includeSections) leaves results lean — no match field.
    const lean = await query.search("elephant", [], undefined, undefined, 10, 0);
    assert.equal("match" in (lean.find((r) => r.path === "doc.md") ?? {}), false);
  });

  it("includeSections omits the match field for a hit with no overlapping section", async () => {
    // a.md ranks for "safety" via its title/tag, but no body section contains the term.
    const results = await query.search("safety", [], undefined, undefined, 10, 0, true);
    const aHit = results.find((r) => r.path === "a.md");
    assert.ok(aHit, "a.md should match 'safety' via title/tag");
    assert.equal("match" in aHit!, false);
  });

  it("includeSections survives a note that becomes unreadable during the lazy section load", async () => {
    // Indexes a.md on the first load, then throws on the SECOND (the lazy section
    // read in sectionMatchFor) — exercising its swallow-and-continue branch.
    class LazyFlakyVault extends VaultService {
      private loads = new Map<string, number>();
      load(relative: string) {
        const n = (this.loads.get(relative) ?? 0) + 1;
        this.loads.set(relative, n);
        if (relative === "a.md" && n > 1) throw new Error("EBUSY: simulated lock");
        return super.load(relative);
      }
    }
    const flaky = new MemoryQueryService(new LazyFlakyVault(root), new IndexRepository());
    const results = await flaky.search("backup", [], undefined, undefined, 10, 0, true);
    const aHit = results.find((r) => r.path === "a.md");
    assert.ok(aHit, "a.md is still returned despite the lazy-load failure");
    assert.equal("match" in aHit!, false);
  });
});

/** Deterministic stub: steer doc/query vectors by keyword so similarity is testable offline. */
class StubEmbedder implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions = 3;
  calls = 0;
  batchSizes: number[] = [];
  constructor(id = "stub:test:3") {
    this.id = id;
  }
  embed(texts: string[]): Promise<number[][]> {
    this.calls += texts.length;
    this.batchSizes.push(texts.length);
    return Promise.resolve(texts.map((text) => {
      const s = text.toLowerCase();
      if (s.includes("backup") || s.includes("rollback")) return [1, 0, 0];
      if (s.includes("parser") || s.includes("yaml")) return [0, 1, 0];
      return [0, 0, 1];
    }));
  }
}

class BadShapeEmbedder implements EmbeddingProvider {
  readonly id = "bad-shape:1";
  readonly dimensions = 3;
  calls = 0;
  embed(): Promise<number[][]> {
    this.calls += 1;
    return Promise.resolve([]);
  }
}

class BrokenEmbedder implements EmbeddingProvider {
  readonly id = "broken:1";
  readonly dimensions = 0;
  embed(): Promise<number[][]> {
    return Promise.reject(new Error("endpoint down"));
  }
}

describe("MemoryQueryService hybrid search (embedder enabled)", () => {
  let root: string;
  let embedder: StubEmbedder;
  let query: MemoryQueryService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mem-hybrid-"));
    writeFileSync(join(root, "a.md"), NOTE_A); // backup/rollback -> [1,0,0]
    writeFileSync(join(root, "b.md"), NOTE_B); // parser/yaml     -> [0,1,0]
    embedder = new StubEmbedder();
    query = new MemoryQueryService(new VaultService(root), new IndexRepository(), undefined, embedder);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("persists per-note vectors and the embedder signature in the cache", async () => {
    await query.search("backup", [], undefined, undefined, 10, 0);
    const parsed = JSON.parse(readFileSync(join(root, ".memory-mcp", "index.json"), "utf8"));
    assert.equal(parsed.embedder, "stub:test:3");
    assert.deepEqual(parsed.records["a.md"].vector, [1, 0, 0]);
    assert.deepEqual(parsed.records["b.md"].vector, [0, 1, 0]);
  });

  it("never leaks the vector into public results", async () => {
    const results = await query.search("backup", [], undefined, undefined, 10, 0);
    assert.ok(results.length > 0);
    assert.equal("vector" in results[0], false);
  });

  it("does not embed on get()/recent() lookups (only search embeds)", async () => {
    await query.get("a.md");
    await query.recent([], [], "updated", 10);
    assert.equal(embedder.calls, 0);
  });

  it("re-embeds under a new signature when the embedder changes", async () => {
    await query.search("backup", [], undefined, undefined, 10, 0); // seed stub:test:3
    const other = new StubEmbedder("stub:other:3");
    const reopened = new MemoryQueryService(new VaultService(root), new IndexRepository(), undefined, other);
    await reopened.search("backup", [], undefined, undefined, 10, 0);
    assert.ok(other.calls > 0, "cached vectors dropped and re-embedded under the new signature");
    const parsed = JSON.parse(readFileSync(join(root, ".memory-mcp", "index.json"), "utf8"));
    assert.equal(parsed.embedder, "stub:other:3");
  });

  it("degrades to lexical-only when the provider throws", async () => {
    const broken = new MemoryQueryService(new VaultService(root), new IndexRepository(), undefined, new BrokenEmbedder());
    const results = await broken.search("backup", [], undefined, undefined, 10, 0);
    assert.equal(results[0].path, "a.md"); // lexical ranking still works
  });

  it("batches document embedding requests before embedding the query", async () => {
    for (let i = 0; i < 35; i += 1) {
      writeFileSync(
        join(root, `extra-${i}.md`),
        `---\ntitle: "Backup extra ${i}"\ntype: note\ncreated: "2026-01-01"\nupdated: "2026-01-02"\n---\n\nbackup rollback ${i}\n`,
      );
    }
    await query.search("backup", [], undefined, undefined, 10, 0);
    assert.ok(embedder.batchSizes.length >= 3, "document embeddings are split before the query embedding call");
    assert.ok(embedder.batchSizes.slice(0, -1).every((size) => size <= 32), "document embedding batches stay bounded");
    assert.equal(embedder.batchSizes.at(-1), 1, "query vector is embedded separately");
  });

  it("cooldowns after a malformed provider response instead of retrying immediately", async () => {
    const bad = new BadShapeEmbedder();
    const withBadProvider = new MemoryQueryService(new VaultService(root), new IndexRepository(), undefined, bad);
    assert.equal((await withBadProvider.search("backup", [], undefined, undefined, 10, 0))[0].path, "a.md");
    assert.equal(bad.calls, 1, "malformed document embedding response starts cooldown before query embedding");
    assert.equal((await withBadProvider.search("backup", [], undefined, undefined, 10, 0))[0].path, "a.md");
    assert.equal(bad.calls, 1, "second search stays lexical-only during cooldown");
  });

  it("applies folder filters before the capped vector arm", async () => {
    for (let i = 0; i < 30; i += 1) {
      writeFileSync(
        join(root, `aaa-outside-${i}.md`),
        `---\ntitle: "Outside ${i}"\ntype: note\ncreated: "2026-01-01"\nupdated: "2026-01-02"\n---\n\nrollback-only outside note ${i}\n`,
      );
    }
    mkdirSync(join(root, "target"), { recursive: true });
    writeFileSync(
      join(root, "target", "hit.md"),
      `---\ntitle: "Target"\ntype: note\ncreated: "2026-01-01"\nupdated: "2026-01-02"\n---\n\nrollback-only target note\n`,
    );

    const results = await query.search("backup", [], "target", undefined, 10, 0);
    assert.deepEqual(results.map((r) => r.path), ["target/hit.md"]);
  });

  it("persists vector removal when reopening a cache with embeddings disabled", async () => {
    await query.search("backup", [], undefined, undefined, 10, 0);

    const lexicalOnly = new MemoryQueryService(new VaultService(root), new IndexRepository());
    await lexicalOnly.search("backup", [], undefined, undefined, 10, 0);

    const parsed = JSON.parse(readFileSync(join(root, ".memory-mcp", "index.json"), "utf8"));
    assert.equal(parsed.embedder, "none");
    assert.equal(parsed.records["a.md"].vector, undefined);
  });
});

describe("MemoryQueryService Thai recall via n-grams (no embedder)", () => {
  it("matches a Thai substring query against a longer Thai word", async () => {
    const root = mkdtempSync(join(tmpdir(), "mem-thai-"));
    try {
      writeFileSync(
        join(root, "th.md"),
        `---\ntitle: "หน่วยความจำ"\ntype: note\ncreated: "2026-01-01"\nupdated: "2026-01-02"\n---\n\nระบบหน่วยความจำของโครงการ\n`,
      );
      writeFileSync(
        join(root, "other.md"),
        `---\ntitle: "Frontmatter parser"\ntype: note\ncreated: "2026-01-01"\nupdated: "2026-01-03"\n---\n\nNever-throw yaml parser.\n`,
      );
      const query = new MemoryQueryService(new VaultService(root), new IndexRepository());
      // The old whitespace tokenizer collapsed Thai into one token, so "ความจำ"
      // (a substring of "หน่วยความจำ") never matched. N-grams fix that.
      const results = await query.search("ความจำ", [], undefined, undefined, 10, 0);
      assert.ok(results.some((r) => r.path === "th.md"), "Thai substring query matches the longer Thai word");
      assert.ok(!results.some((r) => r.path === "other.md"), "unrelated English note does not match");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
