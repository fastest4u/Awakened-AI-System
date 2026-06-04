import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { IndexRepository } from "../src/repositories/index.repository.js";
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
});
