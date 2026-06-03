import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
    assert.equal(parsed.version, 1);
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
});
