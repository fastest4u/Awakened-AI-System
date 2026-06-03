import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { VaultRepository } from "../src/repositories/vault.repository.js";
import { VaultService } from "../src/services/vault.service.js";

describe("VaultRepository", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vault-repo-"));
    mkdirSync(join(root, ".memory-mcp", "backups", "latest"), { recursive: true });
    writeFileSync(join(root, "note.md"), `---\ntitle: Note\ntype: note\n---\n\n# Note\n`);
    writeFileSync(join(root, ".memory-mcp", "backups", "latest", "note.md"), `---\ntitle: Backup\ntype: note\n---\n\n# Backup\n`);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("does not treat .memory-mcp backup markdown files as live notes", async () => {
    const vault = new VaultService(root);
    const repo = new VaultRepository(vault);

    const notes = await repo.readAllNotes();

    assert.equal(notes.length, 1);
    assert.equal(vault.relativePath(notes[0].fullPath), "note.md");
  });
});
