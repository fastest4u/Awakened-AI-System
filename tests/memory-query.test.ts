import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { IndexRepository } from "../src/repositories/index.repository.js";
import type { EmbeddingProvider } from "../src/services/embedding/embedding-provider.js";
import { MemoryQueryService } from "../src/services/memory-query.service.js";
import { MemoryUsageService } from "../src/services/memory-usage.service.js";
import { VaultService } from "../src/services/vault.service.js";

const NOTE_A = `---\ntitle: "Backup safety"\ntype: insight\ncreated: "2026-01-01"\nupdated: "2026-01-02"\ntags:\n  - safety\n---\n\nAtomic backup verify and rollback snapshot.\n`;
const NOTE_B = `---\ntitle: "Frontmatter parser"\ntype: insight\ncreated: "2026-01-01"\nupdated: "2026-01-03"\n---\n\nNever-throw yaml parser.\n`;

/** Decode the base64 Float32Array wire form vectors use in index.json v3. */
function decodeB64Vector(value: string): number[] {
  const bytes = Buffer.from(value, "base64");
  return Array.from(new Float32Array(new Uint8Array(bytes).buffer));
}

/** Encode the base64 Float32Array wire form (inverse of decodeB64Vector). */
function encodeB64Vector(values: number[]): string {
  const floats = new Float32Array(values);
  return Buffer.from(floats.buffer, 0, floats.byteLength).toString("base64");
}

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
    assert.equal("sizeBytes" in results[0], false);
    assert.equal("bodyLineOffset" in results[0], false);
  });

  it("searches body text, not just the title", async () => {
    const results = await query.search("rollback", [], undefined, undefined, 10, 0);
    assert.deepEqual(results.map((r) => r.path), ["a.md"]);
  });

  it("indexes body text past the old 4k cap (search text limit raised to 12000)", async () => {
    const filler = "filler ".repeat(800); // ~5600 chars, beyond the old 4000-char cap
    writeFileSync(
      join(root, "long.md"),
      `---\ntitle: "Long"\ntype: note\ncreated: "2026-01-01"\nupdated: "2026-01-02"\n---\n\n${filler}xylophone\n`,
    );
    const results = await query.search("xylophone", [], undefined, undefined, 10, 0);
    assert.deepEqual(results.map((r) => r.path), ["long.md"]);
  });

  it("persists the index cache to .memory-mcp/index.json", async () => {
    await query.search("backup", [], undefined, undefined, 10, 0);
    const cache = join(root, ".memory-mcp", "index.json");
    assert.ok(existsSync(cache));
    const parsed = JSON.parse(readFileSync(cache, "utf8"));
    assert.equal(parsed.version, 3);
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

  it("detects a same-millisecond edit when the file size changes", async () => {
    const fixed = new Date(Date.now() + 5_000);
    utimesSync(join(root, "a.md"), fixed, fixed);
    await query.search("backup", [], undefined, undefined, 10, 0); // index v1

    // Rewrite with different content AND restore the exact same mtime; only the
    // size differs, which mtime-only change detection used to miss.
    writeFileSync(join(root, "a.md"), NOTE_A.replace("rollback snapshot", "zebra snapshot padding"));
    utimesSync(join(root, "a.md"), fixed, fixed);

    const results = await query.search("zebra", [], undefined, undefined, 10, 0);
    assert.deepEqual(results.map((r) => r.path), ["a.md"]);
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

  it("folder filter is case-insensitive and segment-aware", async () => {
    mkdirSync(join(root, "07_Insights"), { recursive: true });
    writeFileSync(
      join(root, "07_Insights", "ins.md"),
      `---\ntitle: "Insight note"\ntype: insight\ncreated: "2026-01-01"\nupdated: "2026-01-02"\n---\n\nbackup lessons learned.\n`,
    );

    const caseInsensitive = await query.search("backup", [], "07_insights", undefined, 10, 0);
    assert.deepEqual(caseInsensitive.map((r) => r.path), ["07_Insights/ins.md"]);

    // A raw substring / partial segment used to match — it must not anymore.
    const partialSegment = await query.search("backup", [], "Insights", undefined, 10, 0);
    assert.equal(partialSegment.length, 0);

    const recent = await query.recent(["07_INSIGHTS"], [], "updated", 10);
    assert.deepEqual(recent.map((r) => r.path), ["07_Insights/ins.md"]);
  });

  it("honors sortBy for ranked search and list-style empty queries", async () => {
    writeFileSync(
      join(root, "c.md"),
      `---\ntitle: "Aardvark backup mention"\ntype: note\ncreated: "2026-02-01"\nupdated: "2026-02-02"\n---\n\nbackup once.\n`,
    );

    const byTitle = await query.search("backup", [], undefined, undefined, 10, 0, false, { sortBy: "title" });
    assert.deepEqual(byTitle.map((r) => r.path), ["c.md", "a.md"]); // "Aardvark…" < "Backup safety"

    const byCreated = await query.search("", [], undefined, undefined, 10, 0, false, { sortBy: "createdAt" });
    assert.equal(byCreated[0].path, "c.md"); // newest created first

    const byPath = await query.search("", [], undefined, undefined, 10, 0, false, { sortBy: "path" });
    assert.deepEqual(byPath.map((r) => r.path), ["a.md", "b.md", "c.md"]);
  });

  it("scope restricts matching to title or tags", async () => {
    // a.md: title "Backup safety", tags ["safety"], body contains "rollback".
    const titleMiss = await query.search("rollback", [], undefined, undefined, 10, 0, false, { scope: "title" });
    assert.equal(titleMiss.length, 0, "body-only term does not match in title scope");

    const titleHit = await query.search("backup", [], undefined, undefined, 10, 0, false, { scope: "title" });
    assert.deepEqual(titleHit.map((r) => r.path), ["a.md"]);

    const tagHit = await query.search("safety", [], undefined, undefined, 10, 0, false, { scope: "tags" });
    assert.deepEqual(tagHit.map((r) => r.path), ["a.md"]);

    const tagMiss = await query.search("backup", [], undefined, undefined, 10, 0, false, { scope: "tags" });
    assert.equal(tagMiss.length, 0, "title/body term does not match in tags scope");
  });

  it("includeBody attaches the full note body to hits", async () => {
    const withBody = await query.search("backup", [], undefined, undefined, 10, 0, false, { includeBody: true });
    assert.ok(withBody[0].body?.includes("Atomic backup verify"));

    const lean = await query.search("backup", [], undefined, undefined, 10, 0);
    assert.equal("body" in lean[0], false);
  });

  it("rankFor returns path -> positive relevance scores for matching notes only", async () => {
    const scores = await query.rankFor(["backup"]);
    assert.ok(scores["a.md"] > 0);
    assert.equal(scores["b.md"], undefined);
    assert.deepEqual(await query.rankFor([]), {});
  });

  it("rankFor dedupes repeated query terms", async () => {
    assert.deepEqual(await query.rankFor(["backup", "backup", "backup"]), await query.rankFor(["backup"]));
  });

  it("rankFor applies the usage boost, capped at 0.75x the BM25 score", async () => {
    const plain = await query.rankFor(["backup"]);
    const usage = new MemoryUsageService(root);
    usage.recordContextPack([{ path: "a.md" }], { query: "backup" });
    const boosted = new MemoryQueryService(new VaultService(root), new IndexRepository(), usage);
    const scores = await boosted.rankFor(["backup"]);
    assert.ok(scores["a.md"] > plain["a.md"], "usage boost increases the score");
    assert.ok(scores["a.md"] <= plain["a.md"] * 1.75 + 1e-9, "boost is capped at 0.75x BM25");
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
    await query.search("backup", [], undefined, undefined, 10, 0); // seed a real cache + stats
    const stat = statSync(join(root, "a.md"));
    // Tamper the cache: a.md matches the file mtime+size (so it is NOT re-read)
    // but is missing tags/aliases — unguarded this crashes documentTerms (`tags.join`).
    mkdirSync(join(root, ".memory-mcp"), { recursive: true });
    writeFileSync(
      join(root, ".memory-mcp", "index.json"),
      JSON.stringify({
        version: 3,
        updatedAt: "2026-01-01T00:00:00.000Z",
        records: { "a.md": { path: "a.md", title: "Backup safety", type: "insight", searchText: "atomic backup", mtimeMs: stat.mtimeMs, sizeBytes: stat.size } },
      }),
    );
    const reopened = new MemoryQueryService(new VaultService(root), new IndexRepository());
    const results = await reopened.search("backup", [], undefined, undefined, 10, 0);
    assert.ok(results.some((r) => r.path === "a.md"));
  });

  it("coerces a corrupt non-string id from the cache instead of crashing memory_get", async () => {
    await query.search("backup", [], undefined, undefined, 10, 0); // seed a real cache
    const cachePath = join(root, ".memory-mcp", "index.json");
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    parsed.records["a.md"].id = 123; // hand-corrupted index.json
    parsed.records["a.md"].bodyLineOffset = -7; // and a negative numeric field
    writeFileSync(cachePath, JSON.stringify(parsed));
    const reopened = new MemoryQueryService(new VaultService(root), new IndexRepository());
    // Resolving b.md by title iterates past a.md and evaluates its id; a
    // non-string id used to throw in resolveReference and the link graph.
    const note = await reopened.get("Frontmatter parser");
    assert.equal(note.path, "b.md");
  });

  it("ignores a stale-schema (old version) persisted cache instead of trusting it", async () => {
    mkdirSync(join(root, ".memory-mcp"), { recursive: true });
    // A Tier-2 (version 2) cache is now stale; it must be ignored and rebuilt by stats.
    writeFileSync(
      join(root, ".memory-mcp", "index.json"),
      JSON.stringify({ version: 2, updatedAt: "2026-01-01T00:00:00.000Z", records: { "ghost.md": { path: "ghost.md" } } }),
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

  it("cleans up the temp file when the index.json rename fails", async () => {
    const dir = join(root, ".memory-mcp");
    // Make the rename target an (unreplaceable) directory so renameSync throws.
    mkdirSync(join(dir, "index.json"), { recursive: true });
    const blocked = new MemoryQueryService(new VaultService(root), new IndexRepository());
    const results = await blocked.search("backup", [], undefined, undefined, 10, 0);
    assert.ok(results.length > 0, "search still works when the cache cannot be written");
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

  it("search with includeSections attaches a file-accurate section anchor", async () => {
    writeFileSync(
      join(root, "doc.md"),
      `---\ntitle: "Doc"\ntype: note\ncreated: "2026-01-01"\nupdated: "2026-01-06"\n---\n\nIntro.\n\n## Setup\ninstall steps.\n\n## Elephant care\nfeed the elephant daily.\n`,
    );
    const withSections = await query.search("elephant", [], undefined, undefined, 10, 0, true);
    const hit = withSections.find((r) => r.path === "doc.md");
    assert.ok(hit, "doc.md should match 'elephant'");
    assert.equal(hit!.match?.section, "Elephant care");
    // "## Elephant care" sits on FILE line 13 (5 frontmatter lines + delimiters
    // precede the body); the anchor used to report the body-relative line.
    assert.equal(hit!.match?.line, 13);

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

/** Deterministically fails any batch containing the poison doc; succeeds otherwise. */
class PoisonEmbedder implements EmbeddingProvider {
  readonly id = "poison:1";
  readonly dimensions = 3;
  attempts: string[][] = [];
  embed(texts: string[]): Promise<number[][]> {
    this.attempts.push(texts);
    if (texts.some((text) => text.includes("poison"))) return Promise.reject(new Error("deterministic per-doc failure"));
    return Promise.resolve(texts.map(() => [1, 0, 0]));
  }
}

/** Emits 3-dim vectors but declares dimensions = 0 (unknown until the first call). */
class DimlessEmbedder implements EmbeddingProvider {
  readonly id = "dimless:1";
  readonly dimensions = 0;
  batchSizes: number[] = [];
  embed(texts: string[]): Promise<number[][]> {
    this.batchSizes.push(texts.length);
    return Promise.resolve(texts.map(() => [1, 0, 0]));
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

  it("persists per-note vectors (base64 Float32) and the embedder signature in the cache", async () => {
    await query.search("backup", [], undefined, undefined, 10, 0);
    const parsed = JSON.parse(readFileSync(join(root, ".memory-mcp", "index.json"), "utf8"));
    assert.equal(parsed.embedder, "stub:test:3");
    assert.equal(typeof parsed.records["a.md"].vector, "string");
    assert.deepEqual(decodeB64Vector(parsed.records["a.md"].vector), [1, 0, 0]);
    assert.deepEqual(decodeB64Vector(parsed.records["b.md"].vector), [0, 1, 0]);
  });

  it("round-trips persisted vectors so an unchanged vault is not re-embedded", async () => {
    await query.search("backup", [], undefined, undefined, 10, 0);
    const second = new StubEmbedder(); // same signature stub:test:3
    const reopened = new MemoryQueryService(new VaultService(root), new IndexRepository(), undefined, second);
    const results = await reopened.search("backup", [], undefined, undefined, 10, 0);
    assert.equal(results[0].path, "a.md");
    assert.deepEqual(second.batchSizes, [1], "only the query embeds — doc vectors came from the cache");
  });

  it("drops just an undecodable persisted vector and re-embeds that one note", async () => {
    await query.search("backup", [], undefined, undefined, 10, 0);
    const cachePath = join(root, ".memory-mcp", "index.json");
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    parsed.records["a.md"].vector = "@@not-base64@@"; // decodes to a non-multiple-of-4 byte length
    writeFileSync(cachePath, JSON.stringify(parsed));
    const second = new StubEmbedder();
    const reopened = new MemoryQueryService(new VaultService(root), new IndexRepository(), undefined, second);
    const results = await reopened.search("backup", [], undefined, undefined, 10, 0);
    assert.equal(results[0].path, "a.md");
    assert.deepEqual(second.batchSizes, [1, 1], "only the corrupted note re-embeds (plus the query)");
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

  it("does not embed for empty-query list-style calls", async () => {
    await query.search("", [], undefined, undefined, 10, 0); // memory_list routes here
    assert.equal(embedder.calls, 0);
  });

  it("caches the query vector across repeated searches (LRU)", async () => {
    await query.search("backup", [], undefined, undefined, 10, 0);
    const afterFirst = embedder.calls;
    await query.search("backup", [], undefined, undefined, 10, 0);
    assert.equal(embedder.calls, afterFirst, "repeating the same query embeds nothing new");
    await query.search("parser", [], undefined, undefined, 10, 0);
    assert.equal(embedder.calls, afterFirst + 1, "a new query embeds exactly one vector");
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

  it("bounds backlog embedding to 4 batches (128 docs) per call", async () => {
    for (let i = 0; i < 130; i += 1) {
      writeFileSync(
        join(root, `bulk-${i}.md`),
        `---\ntitle: "Bulk ${i}"\ntype: note\ncreated: "2026-01-01"\nupdated: "2026-01-02"\n---\n\nbackup bulk note ${i}\n`,
      );
    }
    // 132 docs pending; the first search must stop after 4 full batches.
    await query.search("backup", [], undefined, undefined, 10, 0);
    assert.deepEqual(embedder.batchSizes, [32, 32, 32, 32, 1], "4 doc batches + 1 query embed");
    // The next search drains the remainder (the query vector is LRU-cached).
    await query.search("backup", [], undefined, undefined, 10, 0);
    assert.deepEqual(embedder.batchSizes.slice(5), [4]);
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

  it("a lexical-only process preserves another embedder's vectors and tag", async () => {
    await query.search("backup", [], undefined, undefined, 10, 0); // seed stub:test:3 vectors

    // Force the lexical-only process to rewrite the cache (a new note changed
    // the index); it must NOT wipe the embedding process's vectors or re-tag
    // the cache as "none".
    writeFileSync(join(root, "new.md"), `---\ntitle: "New"\ntype: note\ncreated: "2026-01-04"\nupdated: "2026-01-04"\n---\n\nbrand new note.\n`);
    const lexicalOnly = new MemoryQueryService(new VaultService(root), new IndexRepository());
    await lexicalOnly.search("backup", [], undefined, undefined, 10, 0);

    const parsed = JSON.parse(readFileSync(join(root, ".memory-mcp", "index.json"), "utf8"));
    assert.equal(parsed.embedder, "stub:test:3");
    assert.deepEqual(decodeB64Vector(parsed.records["a.md"].vector), [1, 0, 0]);
  });

  it("lexical persist passes through vectors another process wrote AFTER it loaded", async () => {
    // The long-lived lexical-only service loads (and persists) BEFORE any vectors exist.
    const lexical = new MemoryQueryService(new VaultService(root), new IndexRepository());
    await lexical.search("backup", [], undefined, undefined, 10, 0);

    // A concurrent embedding process now writes vectors + its tag to disk.
    await query.search("backup", [], undefined, undefined, 10, 0);

    // Touch a note so the lexical service rewrites index.json from its
    // (vectorless) in-memory state — this used to clobber the vectors above.
    writeFileSync(join(root, "a.md"), NOTE_A.replace("rollback snapshot.", "rollback snapshot edited."));
    const future = new Date(Date.now() + 10_000);
    utimesSync(join(root, "a.md"), future, future);
    await lexical.search("backup", [], undefined, undefined, 10, 0);

    const parsed = JSON.parse(readFileSync(join(root, ".memory-mcp", "index.json"), "utf8"));
    assert.equal(parsed.embedder, "stub:test:3", "on-disk embedder tag passes through");
    assert.deepEqual(decodeB64Vector(parsed.records["b.md"].vector), [0, 1, 0], "unchanged note keeps its on-disk vector");
    assert.equal(parsed.records["a.md"].vector, undefined, "changed note's stale vector still drops");
  });

  it("sidelines a deterministically-failing batch so later passes drain the rest", async () => {
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    try {
      writeFileSync(join(root, "poison.md"), `---\ntitle: "Poison"\ntype: note\ncreated: "2026-01-01"\nupdated: "2026-01-02"\n---\n\npoison payload.\n`);
      const poison = new PoisonEmbedder();
      const service = new MemoryQueryService(new VaultService(root), new IndexRepository(), undefined, poison);

      // Pass 1: the only batch contains the poison doc -> fails, cooldown starts.
      await service.search("backup", [], undefined, undefined, 10, 0);
      assert.equal(poison.attempts.length, 1, "one failed doc batch; query embed blocked by cooldown");

      // Past the global cooldown but before the failed batch's retry marker
      // expires: a new note drains while the failed records are skipped.
      mock.timers.setTime(Date.now() + 61_000);
      writeFileSync(join(root, "fresh.md"), `---\ntitle: "Fresh backup"\ntype: note\ncreated: "2026-01-03"\nupdated: "2026-01-03"\n---\n\nfresh backup note.\n`);
      await service.search("backup", [], undefined, undefined, 10, 0);
      const passTwo = poison.attempts.slice(1);
      assert.ok(passTwo.length > 0, "embedding resumed after the cooldown");
      assert.ok(passTwo.every((texts) => texts.every((t) => !t.includes("poison"))), "failed records are skipped, not retried first");
      const parsed = JSON.parse(readFileSync(join(root, ".memory-mcp", "index.json"), "utf8"));
      assert.equal(typeof parsed.records["fresh.md"].vector, "string", "backlog drains past the failing batch");

      // Once the per-record backoff expires the failed records retry (transient
      // failures heal; only the deterministic one keeps failing).
      mock.timers.setTime(Date.now() + 65_000);
      await service.search("backup", [], undefined, undefined, 10, 0);
      const passThree = poison.attempts.slice(1 + passTwo.length);
      assert.ok(passThree.some((texts) => texts.some((t) => t.includes("poison"))), "failed records retry after the backoff");
    } finally {
      mock.timers.reset();
    }
  });

  it("re-embeds stored vectors whose length differs from the provider's dimensionality", async () => {
    await query.search("backup", [], undefined, undefined, 10, 0); // seed 3-dim vectors
    const cachePath = join(root, ".memory-mcp", "index.json");
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    // Simulate an endpoint-side dim change under the SAME embedder id: the
    // stored vectors are now 2-dim while the provider emits 3-dim.
    parsed.records["a.md"].vector = encodeB64Vector([1, 0]);
    parsed.records["b.md"].vector = encodeB64Vector([0, 1]);
    writeFileSync(cachePath, JSON.stringify(parsed));

    const second = new StubEmbedder(); // dimensions = 3, same signature
    const reopened = new MemoryQueryService(new VaultService(root), new IndexRepository(), undefined, second);
    await reopened.search("backup", [], undefined, undefined, 10, 0);
    assert.deepEqual(second.batchSizes, [2, 1], "both wrong-length docs re-embed (plus the query)");
    const after = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.deepEqual(decodeB64Vector(after.records["a.md"].vector), [1, 0, 0]);
    assert.deepEqual(decodeB64Vector(after.records["b.md"].vector), [0, 1, 0]);
  });

  it("learns the expected dims from the first embedded vector when the provider declares none", async () => {
    const seed = new DimlessEmbedder();
    const seeded = new MemoryQueryService(new VaultService(root), new IndexRepository(), undefined, seed);
    await seeded.search("backup", [], undefined, undefined, 10, 0); // 3-dim vectors under "dimless:1"

    const cachePath = join(root, ".memory-mcp", "index.json");
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    parsed.records["a.md"].vector = encodeB64Vector([1, 0]); // endpoint-side dim change
    writeFileSync(cachePath, JSON.stringify(parsed));

    const second = new DimlessEmbedder();
    const reopened = new MemoryQueryService(new VaultService(root), new IndexRepository(), undefined, second);
    // First search: expected dims unknown until the query embeds (sets session dims).
    await reopened.search("backup", [], undefined, undefined, 10, 0);
    assert.deepEqual(second.batchSizes, [1], "no doc re-embed before the session learns the dims");
    // Second search: the 2-dim stored vector mismatches the 3-dim session dims.
    await reopened.search("backup", [], undefined, undefined, 10, 0);
    assert.deepEqual(second.batchSizes, [1, 1], "wrong-length doc re-embeds (query vector is LRU-cached)");
    const after = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.deepEqual(decodeB64Vector(after.records["a.md"].vector), [1, 0, 0]);
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
