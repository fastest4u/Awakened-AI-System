import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { IndexRepository } from "../src/repositories/index.repository.js";
import { NoteRepository } from "../src/repositories/note.repository.js";
import { MemoryCompactionService } from "../src/services/memory-compaction.service.js";
import { MemoryQueryService } from "../src/services/memory-query.service.js";
import { NoteService } from "../src/services/note.service.js";
import { VaultService } from "../src/services/vault.service.js";
import { todayIso } from "../src/utils/memory-format.js";

const SESSION_A = `---
title: "2026-01-01 - Database work"
type: session-log
created: "2026-01-01"
updated: "2026-01-02"
---

## TL;DR
- ปรับปรุงฐานข้อมูลผู้ใช้
- Fixed login redirect

## Open Follow-ups
- [ ] Migrate password hashing

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| login fix works | high | verified | always run the smoke test |
`;

const SESSION_B = `---
title: "2026-01-02 - Password admin"
type: session-log
created: "2026-01-02"
updated: "2026-01-03"
---

## TL;DR
- แก้ไขรหัสผ่านผู้ดูแล

## Open Follow-ups
- [ ] Migrate password hashing
- [ ] Document the rollout steps
`;

const OPTIONS = {
  fromFolder: "05_Agent_Session_Logs",
  targetFolder: "07_Insights",
  maxSessions: 30,
  minSessions: 1,
};

describe("MemoryCompactionService digest generation", () => {
  let root: string;
  let compactor: MemoryCompactionService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mem-compact-"));
    mkdirSync(join(root, "05_Agent_Session_Logs"), { recursive: true });
    mkdirSync(join(root, "07_Insights"), { recursive: true });
    writeFileSync(join(root, "05_Agent_Session_Logs", "2026-01-01-a.md"), SESSION_A, "utf8");
    writeFileSync(join(root, "05_Agent_Session_Logs", "2026-01-02-b.md"), SESSION_B, "utf8");

    const vault = new VaultService(root);
    const query = new MemoryQueryService(vault, new IndexRepository());
    compactor = new MemoryCompactionService(query, new NoteService(new NoteRepository(vault)));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns candidate paths only (no full records with excerpts)", async () => {
    const result = await compactor.compact({ ...OPTIONS, dryRun: true });
    assert.equal(result.candidateCount, 2);
    assert.deepEqual(
      [...result.candidatePaths].sort(),
      ["05_Agent_Session_Logs/2026-01-01-a.md", "05_Agent_Session_Logs/2026-01-02-b.md"],
    );
    assert.equal("candidateSessions" in result, false);
    assert.equal(result.sessionsRead, 2);
  });

  it("re-emits open follow-ups as plain attributed lines, not live checkboxes", async () => {
    const result = await compactor.compact({ ...OPTIONS, dryRun: true });
    assert.ok(result.preview);
    const preview = result.preview!;

    assert.equal(preview.includes("- [ ]"), false, "the digest must not contain live unchecked checkboxes");
    assert.ok(preview.includes("- (open) Migrate password hashing — [["), "follow-ups are plain lines with a source link");
    assert.ok(preview.includes("- (open) Document the rollout steps — [["));
    // Duplicated follow-up text across sessions is emitted once.
    assert.equal(preview.split("- (open) Migrate password hashing").length - 1, 1);
    // The section heading must not match the follow-up radar's heading patterns
    // (follow-up / next action / open item / todo / task), or plain bullets
    // under it would still be harvested as live follow-ups.
    const headings = preview.split("\n").filter((line) => line.startsWith("## "));
    const followUpHeading = headings.find((line) => line.includes("Unresolved From Source Sessions"));
    assert.ok(followUpHeading);
    assert.equal(/follow[- ]?ups?|next actions?|open items?|todo|tasks?/i.test(followUpHeading!), false);
  });

  it("keeps distinct Thai lessons separate (unicode-aware dedupe keys)", async () => {
    const result = await compactor.compact({ ...OPTIONS, dryRun: true });
    const preview = result.preview!;
    // ASCII-only slugify collapsed every Thai item into one "untitled" bucket.
    assert.ok(preview.includes("ปรับปรุงฐานข้อมูลผู้ใช้"));
    assert.ok(preview.includes("แก้ไขรหัสผ่านผู้ดูแล"));
  });

  it("preserves the existing digest's created date across rewrites", async () => {
    const digestPath = join(root, "07_Insights", "Auto-Memory-Digest.md");
    writeFileSync(digestPath, `---
title: "Auto Memory Digest"
type: insight
created: "2020-05-05"
updated: "2020-05-05"
---

old digest content
`, "utf8");

    const result = await compactor.compact({ ...OPTIONS, dryRun: false });
    assert.equal(result.compacted, true);
    assert.equal(result.path, "07_Insights/Auto-Memory-Digest.md");

    const rewritten = readFileSync(digestPath, "utf8");
    assert.ok(rewritten.includes('created: "2020-05-05"'), "created must survive the rewrite");
    assert.ok(rewritten.includes(`updated: "${todayIso()}"`));
  });

  it("uses today's created date for a brand-new digest", async () => {
    const result = await compactor.compact({ ...OPTIONS, dryRun: false });
    assert.equal(result.compacted, true);
    const rewritten = readFileSync(join(root, "07_Insights", "Auto-Memory-Digest.md"), "utf8");
    assert.ok(rewritten.includes(`created: "${todayIso()}"`));
  });
});
