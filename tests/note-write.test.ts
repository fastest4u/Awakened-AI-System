import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NoteRepository } from "../src/repositories/note.repository.js";
import { MemoryTemplateService } from "../src/services/memory-template.service.js";
import { VaultService } from "../src/services/vault.service.js";
import { todayIso } from "../src/utils/memory-format.js";

/** Run fn with console.error captured (the services warn on stderr, not via return values). */
function captureStderr<T>(fn: () => T): { value: T; errors: string[] } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    return { value: fn(), errors };
  } finally {
    console.error = original;
  }
}

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

  it("prunes the oldest backup dirs so at most 20 remain", () => {
    const backupsRoot = join(root, ".memory-mcp", "backups");
    // Simulate 25 historic backups (ISO-like stamps sort chronologically).
    for (let index = 0; index < 25; index += 1) {
      mkdirSync(join(backupsRoot, `note-overwrite-2020-01-01T00-00-${String(index).padStart(2, "0")}-000Z`), { recursive: true });
    }

    repo.write("a.md", "ONE\n");
    repo.write("a.md", "TWO\n"); // triggers a new backup + rotation

    const dirs = readdirSync(backupsRoot).filter((name) => name.startsWith("note-overwrite-")).sort();
    assert.equal(dirs.length, 20);
    // The oldest historic dirs were pruned...
    assert.equal(dirs.includes("note-overwrite-2020-01-01T00-00-00-000Z"), false);
    // ...while the just-created backup (newest stamp) survived with its content.
    const newest = dirs[dirs.length - 1];
    assert.equal(readFileSync(join(backupsRoot, newest, "a.md"), "utf8"), "ONE\n");
  });
});

describe("MemoryTemplateService hardening", () => {
  const templates = new MemoryTemplateService();

  it("escapes pipes and newlines in confidence-log table cells", () => {
    const content = templates.sessionLog({
      topic: "table safety",
      agent: "tester",
      confidenceLog: [{
        claim: "uses | pipe",
        statedConfidence: "high",
        actualResult: "ok\nnext line",
        lesson: "multi|line",
      }],
    });

    const row = content.split("\n").find((line) => line.includes("uses \\| pipe"));
    assert.ok(row, "escaped claim cell must be present");
    assert.ok(row!.includes("ok next line"), "newlines must collapse so the row stays a single table line");
    assert.ok(row!.includes("multi\\|line"));
    // Splitting on unescaped pipes still yields exactly 4 data cells.
    const cells = row!.split(/(?<!\\)\|/).slice(1, -1);
    assert.equal(cells.length, 4);
  });

  it("rejects path-corrupting dates in sessionLogPath and falls back to today with a warning", () => {
    const today = todayIso();
    const { value: nested, errors: nestedErrors } = captureStderr(() =>
      templates.sessionLogPath({ date: "2026/06/10", topic: "speed", agent: "a" }));
    assert.equal(nested, `05_Agent_Session_Logs/${today}-speed.md`);
    assert.equal(nestedErrors.length, 1);

    const { value: colon } = captureStderr(() =>
      templates.sessionLogPath({ date: "12:30", topic: "speed", agent: "a" }));
    assert.equal(colon, `05_Agent_Session_Logs/${today}-speed.md`);
  });

  it("keeps a valid YYYY-MM-DD date untouched", () => {
    assert.equal(
      templates.sessionLogPath({ date: "2026-01-02", topic: "speed", agent: "a" }),
      "05_Agent_Session_Logs/2026-01-02-speed.md",
    );
  });

  it("falls back to today for a malformed occurredDate / decisionDate", () => {
    const { value: mistake } = captureStderr(() => templates.mistake({
      title: "x",
      area: "memory",
      severity: "medium",
      occurredDate: "2026/06/10",
      agent: "a",
      confidence: "high",
      problem: "p",
      rootCause: "r",
      avoidance: "v",
      references: [],
    }));
    assert.equal(mistake.includes("2026/06/10"), false);
    assert.ok(mistake.includes(`occurred-date: "${todayIso()}"`));

    const { value: adr } = captureStderr(() => templates.adr({
      title: "x",
      status: "accepted",
      decisionDate: "10-06-2026T12:00",
      confidence: "high",
      context: "c",
      decision: "d",
      consequences: [],
      supersedes: [],
      tags: [],
    }));
    assert.equal(adr.includes("10-06-2026T12:00"), false);
    assert.ok(adr.includes(`decision-date: "${todayIso()}"`));
  });
});
