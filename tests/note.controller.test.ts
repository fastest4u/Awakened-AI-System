import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NoteController } from "../src/controllers/note.controller.js";
import { IndexRepository } from "../src/repositories/index.repository.js";
import { MemoryQueryService } from "../src/services/memory-query.service.js";
import { ToolResponseService } from "../src/services/tool-response.service.js";
import { VaultService } from "../src/services/vault.service.js";

const NOTE_A = `---\ntitle: "Backup safety"\ntype: insight\ncreated: "2026-01-01"\nupdated: "2026-01-02"\n---\n\nAtomic backup body.\n`;
const NOTE_C = `---\ntitle: "Linker"\ntype: note\ncreated: "2026-01-01"\nupdated: "2026-01-05"\n---\n\nSee [[Backup safety]] for details.\n`;

describe("NoteController memory_get link/body gating", () => {
  let root: string;
  let controller: NoteController;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "note-ctrl-"));
    writeFileSync(join(root, "a.md"), NOTE_A);
    writeFileSync(join(root, "c.md"), NOTE_C);
    const query = new MemoryQueryService(new VaultService(root), new IndexRepository());
    controller = new NoteController(query, new ToolResponseService());
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns real backlinks and body when includeLinks/includeBody are true", async () => {
    const res = await controller.get({ path: "a.md", includeBody: true, includeLinks: true });
    const note = res.structuredContent.data!.note;
    assert.deepEqual(note.incomingLinks, ["c.md"]); // c.md -> a.md via the title wikilink
    assert.deepEqual(note.outgoingLinks, []);
    assert.ok(note.body && note.body.includes("Atomic backup"));
  });

  it("suppresses links and body to [] / undefined when the flags are false", async () => {
    const res = await controller.get({ path: "a.md", includeBody: false, includeLinks: false });
    const note = res.structuredContent.data!.note;
    assert.deepEqual(note.incomingLinks, []);
    assert.deepEqual(note.outgoingLinks, []);
    assert.equal(note.body, undefined);
  });
});
