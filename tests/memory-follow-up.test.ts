import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryFollowUpService } from "../src/services/memory-follow-up.service.js";
import { VaultService } from "../src/services/vault.service.js";

// High base score: Open-Followups path, follow-up section, follow-up heading.
const OPEN_FOLLOWUPS_NOTE = `---
title: "Open Followups"
type: index
created: "2026-06-01"
updated: "2026-06-10"
---

## Follow-ups
- Polish dashboard layout colors
`;

// Low base score: plain checkbox in a session log under a non-follow-up heading.
const DB_SESSION_NOTE = `---
title: "2026-06-01 - Database work"
type: session-log
created: "2026-06-01"
updated: "2026-06-01"
---

## What Was Done
- routine maintenance

- [ ] Migrate customer database
`;

const DB_SESSION_NOTE_UPDATED = `---
title: "2026-06-01 - Database work"
type: session-log
created: "2026-06-01"
updated: "2026-06-02"
---

## What Was Done
- routine maintenance

- [ ] Migrate customer database
- [ ] Rotate the api keys
`;

describe("MemoryFollowUpService radar", () => {
  let root: string;
  let vault: VaultService;
  let service: MemoryFollowUpService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mem-followup-"));
    mkdirSync(join(root, "00_Index"), { recursive: true });
    mkdirSync(join(root, "05_Agent_Session_Logs"), { recursive: true });
    writeFileSync(join(root, "00_Index", "Open-Followups.md"), OPEN_FOLLOWUPS_NOTE, "utf8");
    writeFileSync(join(root, "05_Agent_Session_Logs", "2026-06-01-dbwork.md"), DB_SESSION_NOTE, "utf8");
    vault = new VaultService(root);
    service = new MemoryFollowUpService(vault);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("ranks any termed match strictly above items matching no term", async () => {
    const result = await service.radar({ query: "database", limit: 10 });
    assert.equal(result.followUps.length, 2);
    // Without the term partition the Open-Followups item wins on base score.
    assert.equal(result.followUps[0].path, "05_Agent_Session_Logs/2026-06-01-dbwork.md");
    assert.ok(result.followUps[0].matchedTerms.length > 0);
    assert.equal(result.followUps[1].path, "00_Index/Open-Followups.md");
    assert.equal(result.followUps[1].matchedTerms.length, 0);
  });

  it("returns the none-matched guidance when no item matches the query terms", async () => {
    const result = await service.radar({ query: "kubernetes helm chart", limit: 10 });
    assert.equal(result.returned, 0);
    assert.deepEqual(result.followUps, []);
    assert.equal(result.totalOpen, 2);
    assert.ok(result.recommendedActions[0].includes("none matched"));
  });

  it("returns all open items ordered by base score when there is no query", async () => {
    const result = await service.radar({ limit: 10 });
    assert.equal(result.returned, 2);
    assert.equal(result.followUps[0].path, "00_Index/Open-Followups.md");
  });

  it("caches per-file extraction and only re-parses changed files", async () => {
    let loads = 0;
    const originalLoad = vault.load.bind(vault);
    vault.load = (relativePath: string) => {
      loads += 1;
      return originalLoad(relativePath);
    };

    await service.radar({ limit: 10 });
    const firstPass = loads;
    assert.equal(firstPass, 2, "first radar parses every file");

    await service.radar({ limit: 10 });
    assert.equal(loads, firstPass, "unchanged files must not be re-parsed");

    // Rewrite one file with a future mtime; only that file is re-parsed.
    const dbPath = join(root, "05_Agent_Session_Logs", "2026-06-01-dbwork.md");
    writeFileSync(dbPath, DB_SESSION_NOTE_UPDATED, "utf8");
    const future = new Date(Date.now() + 10_000);
    utimesSync(dbPath, future, future);

    const result = await service.radar({ limit: 10 });
    assert.equal(loads, firstPass + 1, "only the changed file is re-parsed");
    assert.ok(result.followUps.some((item) => item.text.includes("Rotate the api keys")));
  });

  it("drops cached extractions for deleted files", async () => {
    await service.radar({ limit: 10 });
    rmSync(join(root, "05_Agent_Session_Logs", "2026-06-01-dbwork.md"));
    const result = await service.radar({ limit: 10 });
    assert.equal(result.totalOpen, 1);
    assert.equal(result.followUps.some((item) => item.path.includes("dbwork")), false);
  });

  it("infers mode from whole tokens and Thai keywords, not substrings", async () => {
    // 'pr' inside 'project' / 'prod' inside 'product' must no longer match.
    const docs = await service.radar({ query: "project documentation", limit: 5 });
    assert.equal(docs.mode.resolved, "docs");
    const auto = await service.radar({ query: "product analytics", limit: 5 });
    assert.equal(auto.mode.resolved, "auto");
    const debugging = await service.radar({ query: "ดีบักระบบล็อกอิน", limit: 5 });
    assert.equal(debugging.mode.resolved, "debugging");
  });
});
