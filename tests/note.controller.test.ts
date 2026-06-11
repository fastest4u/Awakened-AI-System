import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NoteController } from "../src/controllers/note.controller.js";
import { IndexRepository } from "../src/repositories/index.repository.js";
import {
  getInputSchema,
  searchInputSchema,
  sessionEndInputSchema,
  writeAdRInputSchema,
  writeMistakeInputSchema,
  writeSessionLogInputSchema,
} from "../src/schemas/memory.js";
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

  it("emits the model-visible text copy as compact JSON of the envelope", async () => {
    const res = await controller.get({ path: "a.md", includeBody: true, includeLinks: true });
    assert.equal(res.content[0].text, JSON.stringify(res.structuredContent));
    assert.ok(!res.content[0].text.includes("\n")); // no pretty-printing
  });

  it("returns an INVALID_INPUT error envelope when none of path/id/title is given", async () => {
    // The requirement lives in the controller, not a schema .refine, so the
    // registered schema stays a plain strict object the MCP SDK can advertise.
    const res = await controller.get({ includeBody: true, includeLinks: true });
    assert.ok("isError" in res && res.isError === true);
    assert.equal(res.structuredContent.ok, false);
    assert.equal(res.structuredContent.error?.code, "INVALID_INPUT");
    assert.equal(res.structuredContent.error?.message, "Provide path, id, or title");
  });
});

describe("NoteController search/list option wire-through", () => {
  // Captures the positional args the controller hands to MemoryQueryService.search.
  const makeStub = () => {
    const calls: unknown[][] = [];
    const stub = { search: async (...args: unknown[]) => { calls.push(args); return []; } };
    return { calls, query: stub as unknown as MemoryQueryService };
  };

  it("maps sortBy and passes scope/includeBody through to search", async () => {
    const { calls, query } = makeStub();
    const controller = new NoteController(query, new ToolResponseService());
    await controller.search({ query: "x", tags: [], limit: 10, offset: 0, sortBy: "recent", scope: "title", includeBody: true, includeSections: false });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][7], { sortBy: "updatedAt", scope: "title", includeBody: true });
  });

  it("passes list sortBy through as a mapped search sort option", async () => {
    const { calls, query } = makeStub();
    const controller = new NoteController(query, new ToolResponseService());
    await controller.list({ limit: 20, offset: 0, sortBy: "name" });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][7], { sortBy: "title" });
  });
});

describe("tool input schema hardening", () => {
  const validSessionEnd = { topic: "wrap up", outcomes: ["done"] };

  it("rejects unknown/typo'd fields instead of silently stripping them", () => {
    assert.equal(sessionEndInputSchema.safeParse(validSessionEnd).success, true);
    // A typo'd "outcomes" used to be dropped silently, saving an empty session log.
    assert.equal(sessionEndInputSchema.safeParse({ topic: "wrap up", outcoms: ["done"] }).success, false);
    assert.equal(searchInputSchema.safeParse({ query: "x", quary: "x" }).success, false);
  });

  it("keeps memory_get a plain strict object the MCP SDK can advertise", () => {
    // A .refine would wrap this in a ZodEffects, advertised as an empty JSON
    // schema; the path/id/title rule is enforced in NoteController.get instead.
    assert.equal(typeof getInputSchema.shape, "object"); // ZodObject, not ZodEffects
    assert.equal(getInputSchema.safeParse({}).success, true);
    assert.equal(getInputSchema.safeParse({ path: "a.md", pth: "a.md" }).success, false);
  });

  it("rejects non-YYYY-MM-DD dates that would corrupt vault paths", () => {
    assert.equal(sessionEndInputSchema.safeParse({ ...validSessionEnd, date: "2026-06-10" }).success, true);
    // "/" silently nests folders; ":" crashes with EINVAL on Windows.
    assert.equal(sessionEndInputSchema.safeParse({ ...validSessionEnd, date: "2026/06/10" }).success, false);
    assert.equal(sessionEndInputSchema.safeParse({ ...validSessionEnd, date: "2026-06-10T12:00" }).success, false);
    assert.equal(writeSessionLogInputSchema.safeParse({ topic: "t", agent: "codex", date: "10-06-2026" }).success, false);

    const validMistake = {
      title: "t",
      area: "memory",
      severity: "low",
      occurredDate: "2026-06-10",
      agent: "codex",
      confidence: "high",
      problem: "p",
      rootCause: "r",
      avoidance: "a",
    };
    assert.equal(writeMistakeInputSchema.safeParse(validMistake).success, true);
    assert.equal(writeMistakeInputSchema.safeParse({ ...validMistake, occurredDate: "2026/06/10" }).success, false);

    const validAdr = {
      title: "t",
      status: "accepted",
      decisionDate: "2026-06-10",
      confidence: "high",
      context: "c",
      decision: "d",
    };
    assert.equal(writeAdRInputSchema.safeParse(validAdr).success, true);
    assert.equal(writeAdRInputSchema.safeParse({ ...validAdr, decisionDate: "10 June 2026" }).success, false);
  });
});
