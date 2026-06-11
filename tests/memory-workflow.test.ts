import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { IndexRepository } from "../src/repositories/index.repository.js";
import { NoteRepository } from "../src/repositories/note.repository.js";
import { AuditService } from "../src/services/audit.service.js";
import { MemoryCompactionService } from "../src/services/memory-compaction.service.js";
import { MemoryFollowUpService } from "../src/services/memory-follow-up.service.js";
import { MemoryLifecycleService } from "../src/services/memory-lifecycle.service.js";
import { MemoryQueryService } from "../src/services/memory-query.service.js";
import { MemoryTemplateService } from "../src/services/memory-template.service.js";
import { MemoryUsageService } from "../src/services/memory-usage.service.js";
import { MemoryWorkflowService } from "../src/services/memory-workflow.service.js";
import { NoteService } from "../src/services/note.service.js";
import { VaultHealthService } from "../src/services/vault-health.service.js";
import { VaultService } from "../src/services/vault.service.js";

const RULES_NOTE = `---
title: "Project Working Agreements"
type: rules
created: "2026-01-01"
updated: "2026-01-05"
tags:
  - conventions
---

Always keep changes small and verified.
`;

const ELEPHANT_INSIGHT = `---
title: "Elephant handling"
type: insight
created: "2026-02-01"
updated: "2026-02-02"
tags:
  - safety
---

Keep the elephant calm during transport and feeding.
`;

const MISTAKE_ELEPHANT = `---
title: "Elephant stampede"
type: mistake
created: "2026-03-01"
updated: "2026-03-02"
tags:
  - incident
---

Elephant stampede caused data loss during transport.
`;

const MISTAKE_PARSER = `---
title: "Parser crash"
type: mistake
created: "2026-03-03"
updated: "2026-03-04"
tags:
  - parser
---

Parser crashed on malformed YAML frontmatter.
`;

function buildWorkflows(root: string) {
  const vault = new VaultService(root);
  const usage = new MemoryUsageService(root);
  const query = new MemoryQueryService(vault, new IndexRepository(), usage);
  const notes = new NoteService(new NoteRepository(vault));
  return new MemoryWorkflowService(
    vault,
    query,
    new VaultHealthService(vault),
    notes,
    new MemoryTemplateService(),
    new AuditService(root),
    usage,
    new MemoryCompactionService(query, notes),
    new MemoryLifecycleService(root),
    new MemoryFollowUpService(vault),
  );
}

describe("MemoryWorkflowService context pack and lifecycle workflows", () => {
  let root: string;
  let workflows: MemoryWorkflowService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mem-workflow-"));
    mkdirSync(join(root, "01_Project_Rules"), { recursive: true });
    mkdirSync(join(root, "07_Insights"), { recursive: true });
    mkdirSync(join(root, "08_Mistakes"), { recursive: true });
    writeFileSync(join(root, "01_Project_Rules", "Project-Working-Agreements.md"), RULES_NOTE, "utf8");
    writeFileSync(join(root, "07_Insights", "Elephant-Handling.md"), ELEPHANT_INSIGHT, "utf8");
    writeFileSync(join(root, "08_Mistakes", "Mistake-001-elephant-stampede.md"), MISTAKE_ELEPHANT, "utf8");
    writeFileSync(join(root, "08_Mistakes", "Mistake-002-parser-crash.md"), MISTAKE_PARSER, "utf8");
    workflows = buildWorkflows(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("relevance gate excludes an irrelevant high-type-weight note when terms exist", async () => {
    const pack = await workflows.contextPack({ query: "elephant", maxItems: 10, maxChars: 8000 });
    const paths = pack.selected.map((item) => item.path);
    assert.ok(paths.includes("07_Insights/Elephant-Handling.md"), "the matching note must be selected");
    assert.equal(
      paths.includes("01_Project_Rules/Project-Working-Agreements.md"),
      false,
      "type weight alone must not admit a record when scoring terms exist",
    );
  });

  it("keeps type-weight ordering as the fallback when no scoring terms exist", async () => {
    const pack = await workflows.contextPack({ maxItems: 10, maxChars: 8000 });
    const paths = pack.selected.map((item) => item.path);
    assert.ok(paths.includes("01_Project_Rules/Project-Working-Agreements.md"));
    assert.ok(paths.includes("07_Insights/Elephant-Handling.md"));
  });

  it("does not embed usage telemetry in selected items", async () => {
    const pack = await workflows.contextPack({ query: "elephant", maxItems: 10, maxChars: 8000 });
    assert.ok(pack.selected.length > 0);
    for (const item of pack.selected) {
      assert.equal("usage" in item, false, "per-item usage records must not reach the wire");
    }
  });

  it("sessionStart serializes followUps/lifecycle/recommendedReads exactly once", async () => {
    const result = await workflows.sessionStart({ taskArea: "elephant", recentLimit: 5, maxItems: 8, maxChars: 6000 });
    assert.ok(result.followUps, "followUps stays at top level");
    assert.ok(result.lifecycle.session, "lifecycle stays at top level");
    assert.ok(Array.isArray(result.recommendedReads), "recommendedReads stays at top level");
    assert.equal("followUps" in result.contextPack, false, "embedded pack must not duplicate followUps");
    assert.equal("lifecycle" in result.contextPack, false, "embedded pack must not duplicate lifecycle");
    assert.equal("recommendedReads" in result.contextPack.mode, false, "embedded pack must not duplicate recommendedReads");
    assert.ok(Array.isArray(result.contextPack.selected));
  });

  it("selfCheck returns ranked compact mistake projections, never raw index records", async () => {
    const result = await workflows.selfCheck({ task: "calm the elephant stampede", area: "elephant", riskLevel: "high" });
    assert.ok(result.pastMistakesToAvoid.length > 0);
    assert.equal(result.pastMistakesToAvoid[0].path, "08_Mistakes/Mistake-001-elephant-stampede.md", "ranked match comes first");
    for (const item of result.pastMistakesToAvoid) {
      assert.equal(item.type, "mistake");
      assert.equal("searchText" in item, false);
      assert.equal("mtimeMs" in item, false);
      assert.equal("sizeBytes" in item, false);
      assert.equal("vector" in item, false);
      assert.equal("usage" in item, false);
    }
  });

  it("selfCheck caps results at 5 without an area and 10 with one", async () => {
    for (let index = 3; index <= 8; index += 1) {
      writeFileSync(
        join(root, "08_Mistakes", `Mistake-00${index}-extra.md`),
        `---\ntitle: "Extra mistake ${index}"\ntype: mistake\ncreated: "2026-03-0${index}"\nupdated: "2026-03-0${index}"\n---\n\nFiller incident number ${index}.\n`,
        "utf8",
      );
    }
    const noArea = await workflows.selfCheck({ task: "general cleanup", riskLevel: "low" });
    assert.equal(noArea.pastMistakesToAvoid.length, 5);
    const withArea = await workflows.selfCheck({ task: "general cleanup", area: "vault", riskLevel: "low" });
    assert.ok(withArea.pastMistakesToAvoid.length > 5);
    assert.ok(withArea.pastMistakesToAvoid.length <= 10);
  });

  it("awaken does not end, rotate, or create lifecycle sessions", async () => {
    const started = await workflows.sessionStart({ taskArea: "elephant", recentLimit: 5, maxItems: 8, maxChars: 6000 });
    const sessionId = started.lifecycle.session.id;
    const before = workflows.lifecycleStatus({ includeHistory: true });

    const result = await workflows.awaken({ focus: "elephant" });

    const after = workflows.lifecycleStatus({ includeHistory: true });
    assert.equal(after.activeSession?.id, sessionId, "the in-flight session must survive awaken");
    assert.equal(after.recentSessions.length, before.recentSessions.length, "awaken must not archive sessions");
    assert.ok(Array.isArray(result.nextActions));
    assert.ok(Array.isArray(result.context.contextPack.selected));
  });

  it("awaken without an active session does not create one", async () => {
    await workflows.awaken({ focus: "elephant" });
    const status = workflows.lifecycleStatus({});
    assert.equal(status.activeSession, null);
  });

  it("infers mode from whole tokens, not substrings", async () => {
    // 'pr' inside 'project' / 'prod' inside 'product' must no longer match.
    const docs = await workflows.contextPack({ query: "project documentation", maxItems: 4, maxChars: 2000 });
    assert.equal(docs.mode.resolved, "docs");
    const auto = await workflows.contextPack({ query: "product analytics", maxItems: 4, maxChars: 2000 });
    assert.equal(auto.mode.resolved, "auto");
    // A genuine standalone token still matches.
    const review = await workflows.contextPack({ query: "pr feedback", maxItems: 4, maxChars: 2000 });
    assert.equal(review.mode.resolved, "review");
  });

  it("infers mode from Thai keywords", async () => {
    const debugging = await workflows.contextPack({ query: "ช่วยดีบักระบบล็อกอิน", maxItems: 4, maxChars: 2000 });
    assert.equal(debugging.mode.resolved, "debugging");
    const planning = await workflows.contextPack({ query: "วางแผนสถาปัตยกรรมระบบ", maxItems: 4, maxChars: 2000 });
    assert.equal(planning.mode.resolved, "planning");
    const coding = await workflows.contextPack({ query: "พัฒนาระบบสมาชิก", maxItems: 4, maxChars: 2000 });
    assert.equal(coding.mode.resolved, "coding");
  });

  it("sessionEnd auto-compact waits for a session backlog instead of churning the digest", async () => {
    const result = await workflows.sessionEnd({ topic: "Small docs fix", agent: "tester", outcomes: ["done"], verification: "manual check" });
    assert.equal(result.saved, true);
    assert.equal(result.autoCompact.compacted, false, "one session log must not trigger compaction");
    assert.equal(existsSync(join(root, "07_Insights", "Auto-Memory-Digest.md")), false);
    // Lean compactor shape: paths only, no full candidate records.
    assert.ok("candidateCount" in result.autoCompact);
    assert.ok("candidatePaths" in result.autoCompact);
    assert.equal("candidateSessions" in result.autoCompact, false);
  });
});
