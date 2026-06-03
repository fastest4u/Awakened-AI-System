import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NoteRepository } from "../src/repositories/note.repository.js";
import { VaultService } from "../src/services/vault.service.js";

describe("NoteRepository overwrite safety", () => {
  let root: string;
  let repo: NoteRepository;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "note-write-"));
    repo = new NoteRepository(new VaultService(root));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("backs up the original before overwriting an existing note with different content", () => {
    repo.write("07_Insights/x.md", "ORIGINAL\n");
    repo.write("07_Insights/x.md", "REPLACED\n");

    // Live note has the new content.
    assert.equal(readFileSync(join(root, "07_Insights", "x.md"), "utf8"), "REPLACED\n");

    // A timestamped backup of the original exists under .memory-mcp/backups.
    const backupsRoot = join(root, ".memory-mcp", "backups");
    assert.ok(existsSync(backupsRoot), "a backups directory must be created");
    const dirs = readdirSync(backupsRoot).filter((d) => d.startsWith("note-overwrite-"));
    assert.equal(dirs.length, 1);
    assert.equal(readFileSync(join(backupsRoot, dirs[0], "07_Insights", "x.md"), "utf8"), "ORIGINAL\n");
  });

  it("does not create a backup when the content is unchanged", () => {
    repo.write("note.md", "SAME\n");
    repo.write("note.md", "SAME\n");
    const backupsRoot = join(root, ".memory-mcp", "backups");
    assert.equal(existsSync(backupsRoot), false);
  });

  it("does not back up a brand-new note (nothing to lose)", () => {
    repo.write("fresh.md", "NEW\n");
    assert.equal(existsSync(join(root, ".memory-mcp", "backups")), false);
  });
});
