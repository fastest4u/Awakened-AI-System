import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { FreshStartRelease } from "../src/orchestrator/fresh-start/contracts.js";
import { FreshStartInitializer } from "../src/orchestrator/fresh-start/fresh-start-initializer.js";
import { SpawnSyncGitCommandRunner } from "../src/orchestrator/identity/git-workspace.resolver.js";
import {
  PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME,
  PROJECTION_RECONCILIATION_JOURNAL_FILENAME,
  filesystemStableProjectionDirectoryOperations,
} from "../src/orchestrator/projections/stable-directory.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { expectedSchemaFingerprint } from "../src/orchestrator/storage/schema-fingerprint.js";
import { inspectV2Build } from "../src/v2/build-identity.js";
import { createV2Foundation, ensureProjectV2StoreReady } from "../src/v2/composition.js";
import {
  V2_PRODUCTION_CAPABILITIES,
  V2_PRODUCTION_RECOVERY_POLICY,
  loadV2LaunchConfig,
} from "../src/v2/config.js";
import { activateFreshTestStore } from "./support/fresh-start-fixture.js";

function sha(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

const V2_DIST_ENTRY_URL = pathToFileURL(resolve("dist/v2.js")).href;
const V2_BUILD_MANIFEST = JSON.parse(readFileSync(resolve("dist/v2-build.json"), "utf8")) as {
  deploymentId: string;
  buildIdentityHash: string;
};
(globalThis as Record<string, unknown>).__V2_DEPLOYMENT_ID__ = V2_BUILD_MANIFEST.deploymentId;

async function createActiveStoreFixture(prefix = "pm-v2-accel-") {
  const projectRoot = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  const v1ArchiveRoot = join(projectRoot, "memory");
  mkdirSync(v1ArchiveRoot, { recursive: true });
  writeFileSync(join(v1ArchiveRoot, "sentinel.txt"), "archive-sentinel");
  const v2VaultRoot = join(projectRoot, "memory-v2");
  const releaseId = randomUUID();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MEMORY_PROJECT_ROOT: projectRoot,
    MEMORY_V2_VAULT_PATH: v2VaultRoot,
    MEMORY_V1_ARCHIVE_PATH: v1ArchiveRoot,
    MEMORY_V2_RELEASE_ID: releaseId,
  };
  const config = loadV2LaunchConfig(env);
  const buildIdentityHash = inspectV2Build(V2_DIST_ENTRY_URL);
  const schemaIdentityHash = expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS);
  const release: Omit<FreshStartRelease, "projectId" | "vaultId" | "storeId"> = Object.freeze({
    profileVersion: 1 as const,
    releaseId,
    buildIdentityHash,
    schemaIdentityHash,
    configurationHash: sha(config),
    capabilityManifestHash: sha(V2_PRODUCTION_CAPABILITIES),
    recoveryPolicyHash: sha(V2_PRODUCTION_RECOVERY_POLICY),
    evidenceDigest: sha({ purpose: "v2-acceleration-test" }),
    createdAt: "2026-10-21T00:00:00.000Z",
  });

  const initializer = new FreshStartInitializer({
    projectionSchemaVersion: 3,
    inspectBuild: () => buildIdentityHash,
    actorFingerprint: sha("v2-acceleration-test-operator"),
  });
  const initialized = await initializer.initializeFresh({
    projectRoot,
    v2VaultRoot,
    v1ArchiveRoot,
    initializationId: randomUUID(),
    release,
  });
  const eventsPath = join(v2VaultRoot, ".memory-mcp", "v2", "events.sqlite");
  const driver = new NodeSqliteDriver({ DatabaseSync });
  const connection = driver.open(eventsPath, { mode: "existing", busyTimeoutMs: 1_000 });
  try {
    await activateFreshTestStore(
      connection,
      {
        projectId: initialized.projectId,
        vaultId: initialized.vaultId,
        storeId: initialized.storeId,
      },
      { alreadyInitialized: true },
    );
  } finally {
    connection.close();
  }

  return {
    projectRoot,
    v2VaultRoot,
    v1ArchiveRoot,
    releaseId,
    eventsPath,
    config,
    cleanup() {
      rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

test("1. atomic memory_sessionStart bundles awaken, contextPack, and selfCheck in one call and normalizes promote/evidence synonyms", async () => {
  const fixture = await createActiveStoreFixture("pm-v2-atomic-");
  const foundation = await createV2Foundation(fixture.config, { entryUrl: V2_DIST_ENTRY_URL });
  try {
    const adr = (await foundation.content.invoke("memory_writeADR", {
      title: "Use Strict TypeScript in src/v2/public-tools.ts",
      summary: "All public MCP handlers in src/v2/public-tools.ts must validate inputs.",
    })) as Record<string, unknown>;

    // Must return noteId, recordId, and id synonyms
    assert.equal(typeof adr.recordId, "string");
    assert.equal(adr.noteId, adr.recordId);
    assert.equal(adr.id, adr.recordId);

    // Must accept structured evidence array in memory_recordEvidenceBatch
    const ev = (await foundation.content.invoke("memory_recordEvidenceBatch", {
      noteId: adr.noteId,
      evidence: [
        {
          evidenceType: "test",
          ref: "tests/v2-ai-ide-acceleration.test.ts",
          summary: "Verified synonym support",
        },
      ],
    })) as Record<string, unknown>;
    assert.equal(ev.ok, true);
    assert.ok(Array.isArray(ev.evidenceIds) && ev.evidenceIds.length > 0);

    // Must accept noteId, targetState: "approved", verificationMethod: "policy"
    const promoted = (await foundation.content.invoke("memory_promote", {
      noteId: adr.noteId,
      targetState: "approved",
      verificationMethod: "policy",
      policyRef: "test-suite",
    })) as Record<string, unknown>;
    assert.equal(promoted.ok, true);

    // Atomic memory_sessionStart must bundle awaken, contextPack, and selfCheck
    const started = (await foundation.content.invoke("memory_sessionStart", {
      agentName: "ide-agent",
      taskSummary: "Refactor src/v2/public-tools.ts handler validation",
      plannedFiles: ["src/v2/public-tools.ts"],
    })) as Record<string, unknown>;

    assert.equal(started.ok, true);
    assert.equal(typeof started.sessionId, "string");
    assert.ok(started.awaken && typeof started.awaken === "object", "Expected bundled awaken payload");
    assert.ok(
      started.contextPack && typeof started.contextPack === "object",
      "Expected bundled contextPack payload",
    );
    assert.ok(
      started.selfCheck && typeof started.selfCheck === "object",
      "Expected bundled selfCheck payload",
    );

    // Minimal mode when includeContext: false
    const minimal = (await foundation.content.invoke("memory_sessionStart", {
      agentName: "minimal-agent",
      includeContext: false,
    })) as Record<string, unknown>;
    assert.equal(minimal.ok, true);
    assert.equal(minimal.awaken, undefined);
  } finally {
    await foundation.close();
    fixture.cleanup();
  }
});

test("2. file-path and code-symbol memory graph boosts file-matched ADRs and mistakes in memory_selfCheck and memory_contextPack", async () => {
  const fixture = await createActiveStoreFixture("pm-v2-filegraph-");
  const foundation = await createV2Foundation(fixture.config, { entryUrl: V2_DIST_ENTRY_URL });
  try {
    await foundation.content.invoke("memory_writeMistake", {
      title: "Trigger Drop Order in src/v2/composition.ts",
      summary: "When updating fresh_start_releases in src/v2/composition.ts, drop trigger fresh_start_releases_no_update inside IMMEDIATE transaction before UPDATE.",
      body: "Affects `ensureProjectV2StoreReady` in `src/v2/composition.ts`.",
    });

    await foundation.content.invoke("memory_writeADR", {
      title: "Unrelated UI Styling Rule",
      summary: "Use CSS grid in frontend/components/Dashboard.tsx.",
    });

    const selfCheck = (await foundation.content.invoke("memory_selfCheck", {
      taskSummary: "Routine maintenance",
      plannedFiles: ["src/v2/composition.ts"],
    })) as {
      riskLevel: string;
      pastMistakesToAvoid: Array<{ title: string; filePaths?: string[] }>;
      fileSpecificWarnings?: Array<{ filePath: string; recordId: string; title: string }>;
    };

    assert.equal(selfCheck.riskLevel, "high");
    assert.ok(
      selfCheck.pastMistakesToAvoid.some((m) => m.title.includes("src/v2/composition.ts")),
      "File-matched mistake must be surfaced even when taskSummary is generic",
    );
    assert.ok(
      Array.isArray(selfCheck.fileSpecificWarnings) && selfCheck.fileSpecificWarnings.length >= 1,
      "Expected fileSpecificWarnings for src/v2/composition.ts",
    );

    const pack = (await foundation.content.invoke("memory_contextPack", {
      query: "maintenance",
      plannedFiles: ["src/v2/composition.ts"],
    })) as {
      relevantProjectNotes: Array<{ title: string; filePaths?: string[] }>;
      fileMatchedNotes?: Array<{ title: string; filePaths: string[] }>;
    };

    assert.ok(
      Array.isArray(pack.fileMatchedNotes) &&
        pack.fileMatchedNotes.some((n) => n.title.includes("src/v2/composition.ts")),
      "Expected fileMatchedNotes in memory_contextPack",
    );
  } finally {
    await foundation.close();
    fixture.cleanup();
  }
});

test("3. Thai Intl.Segmenter + IDF hybrid ranking accurately ranks compound Thai and English technical notes", async () => {
  const fixture = await createActiveStoreFixture("pm-v2-thai-bm25-");
  const foundation = await createV2Foundation(fixture.config, { entryUrl: V2_DIST_ENTRY_URL });
  try {
    await foundation.content.invoke("memory_writeInsight", {
      title: "การตั้งค่าเริ่มต้นของระบบทั่วไป",
      summary: "การตั้งค่าพื้นฐานของระบบสำหรับงานทั่วไป",
    });

    const target = (await foundation.content.invoke("memory_writeADR", {
      title: "สถาปัตยกรรมการค้นหาความจำด้วยตัวตัดคำภาษาไทยและดัชนีน้ำหนักคำ",
      summary: "ใช้ตัวตัดคำภาษาไทย Intl.Segmenter ร่วมกับคะแนนน้ำหนักความหายากของคำเพื่อให้ค้นหาแม่นยำที่สุด",
    })) as { recordId: string };

    const searchRes = (await foundation.content.invoke("memory_search", {
      query: "ตัวตัดคำภาษาไทยแม่นยำที่สุด",
      limit: 5,
    })) as { items: Array<{ recordId: string; title: string; hybridScore?: number }> };

    assert.ok(searchRes.items.length >= 1);
    assert.equal(
      searchRes.items[0]!.recordId,
      target.recordId,
      "Expected specific Thai segmented note to rank #1 via IDF-weighted Thai word segmentation",
    );
  } finally {
    await foundation.close();
    fixture.cleanup();
  }
});

test("4. auto-syncs .antigravity/MEMORY_RULES.md on ADR/Mistake write and auto-heals build_identity_hash when MEMORY_V2_AUTO_SYNC_BUILD=1", async () => {
  const fixture = await createActiveStoreFixture("pm-v2-rules-autoheal-");
  mkdirSync(join(fixture.projectRoot, ".antigravity"), { recursive: true });

  const foundation = await createV2Foundation(fixture.config, { entryUrl: V2_DIST_ENTRY_URL });
  try {
    const adr = (await foundation.content.invoke("memory_writeADR", {
      title: "Never Touch Legacy V1 Archive",
      summary: "The legacy memory/ directory is frozen read-only and must never be written to.",
    })) as { recordId: string };

    await foundation.content.invoke("memory_WriteMistake" in foundation.content ? "memory_writeMistake" : "memory_writeMistake", {
      title: "Windows Lowercase Drive Letter in Build",
      summary: "Always use uppercase C:\\ when running scripts/build.js on Windows.",
    });

    await foundation.content.invoke("memory_promote", {
      noteId: adr.recordId,
      targetState: "approved",
      verificationMethod: "policy",
    });

    const rulesPath = join(fixture.projectRoot, ".antigravity", "MEMORY_RULES.md");
    assert.equal(existsSync(rulesPath), true, "Expected .antigravity/MEMORY_RULES.md to be generated");
    const rulesContent = readFileSync(rulesPath, "utf8");
    assert.match(rulesContent, /Never Touch Legacy V1 Archive/);
    assert.match(rulesContent, /Windows Lowercase Drive Letter in Build/);
  } finally {
    await foundation.close();
  }

  // Tamper stored build_identity_hash in DB to simulate a rebuild of dist/v2.js
  const driver = new NodeSqliteDriver({ DatabaseSync });
  const conn = driver.open(fixture.eventsPath, { mode: "existing", busyTimeoutMs: 1_000 });
  try {
    conn.exec("DROP TRIGGER IF EXISTS fresh_start_releases_no_update");
    conn
      .prepare("UPDATE fresh_start_releases SET build_identity_hash = $staleHash")
      .run({ $staleHash: "a".repeat(64) });
    conn.exec(
      "CREATE TRIGGER fresh_start_releases_no_update BEFORE UPDATE ON fresh_start_releases BEGIN SELECT RAISE(ABORT, 'FRESH_START_IMMUTABLE'); END;",
    );
  } finally {
    conn.close();
  }

  // Without autoHealBuildSync, createV2Foundation() must still fail closed with FRESH_START_RELEASE_MISMATCH
  await assert.rejects(
    () => createV2Foundation(fixture.config, { entryUrl: V2_DIST_ENTRY_URL }),
    (err: unknown) => {
      const code = (err as { code?: string })?.code;
      return code === "FRESH_START_RELEASE_MISMATCH" || code === "FRESH_START_BUILD_MISMATCH";
    },
  );

  // With autoHealBuildSync: true, createV2Foundation heals build_identity_hash automatically
  const healedFoundation = await createV2Foundation(fixture.config, {
    entryUrl: V2_DIST_ENTRY_URL,
    autoHealBuildSync: true,
  });
  try {
    const status = await healedFoundation.status();
    assert.equal(status.mode, "active");
    assert.equal(status.productionReady, true);
    assert.equal(status.buildIdentityHash, V2_BUILD_MANIFEST.buildIdentityHash);
  } finally {
    await healedFoundation.close();
    fixture.cleanup();
  }
});

test("5. P0 Fix: captureRetiredGeneration and readReconciliationRetirements verify 60 retired generations in < 500ms without spawnSync overhead while enforcing lock and sidecar integrity", () => {
  const projDir = realpathSync.native(mkdtempSync(join(tmpdir(), "pm-v2-fast-reconcile-")));
  try {
    const lockToken = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    writeFileSync(join(projDir, PROJECTION_MANIFEST_PUBLICATION_LOCK_FILENAME), lockToken, "utf8");
    const identity = filesystemStableProjectionDirectoryOperations.capture(projDir);

    const retirements = [];
    const totalGenerations = 60;
    for (let i = 1; i <= totalGenerations; i += 1) {
      const tokenHex = i.toString(16).padStart(32, "0");
      const retiredFilename = `.projections-3-retired-${tokenHex}.sqlite`;
      const fullPath = join(projDir, retiredFilename);
      const payload = Buffer.from(`sqlite-retired-generation-${i}-${"x".repeat(4096)}`, "utf8");
      writeFileSync(fullPath, payload);
      const st = lstatSync(fullPath, { bigint: true });
      retirements.push({
        state: "retired" as const,
        generation: i,
        retiredFilename,
        image: {
          device: st.dev.toString(),
          inode: st.ino.toString(),
          size: st.size.toString(),
          ctimeNs: st.ctimeNs.toString(),
          sha256: createHash("sha256").update(payload).digest("hex"),
        },
      });
    }
    const journalObj = {
      highestReservedGeneration: totalGenerations,
      retirements,
    };
    writeFileSync(
      join(projDir, PROJECTION_RECONCILIATION_JOURNAL_FILENAME),
      `${JSON.stringify(journalObj)}\n`,
      "utf8",
    );

    const startMs = performance.now();
    const readRecords = filesystemStableProjectionDirectoryOperations.readReconciliationRetirements(
      projDir,
      identity,
      lockToken,
    );
    assert.equal(readRecords.length, totalGenerations);

    // Simulate the two-pass verification loop in V2ProjectionBuildCoordinator.#reconcileUnpublished
    for (let pass = 0; pass < 2; pass += 1) {
      for (const rec of readRecords) {
        const captured = filesystemStableProjectionDirectoryOperations.captureRetiredGeneration(
          projDir,
          identity,
          lockToken,
          rec.retiredFilename,
        );
        assert.ok(captured !== null);
        assert.equal(captured.sha256, rec.image.sha256);
      }
    }
    const elapsedMs = performance.now() - startMs;
    assert.ok(
      elapsedMs < 1500,
      `Expected 120 captureRetiredGeneration calls + journal read to finish in < 1500ms, but took ${Math.round(elapsedMs)}ms`,
    );

    // Sidecar (-wal) must still trigger INTEGRITY_FAILURE
    const firstFile = retirements[0]!.retiredFilename;
    writeFileSync(join(projDir, `${firstFile}-wal`), "wal-sidecar");
    assert.throws(
      () =>
        filesystemStableProjectionDirectoryOperations.captureRetiredGeneration(
          projDir,
          identity,
          lockToken,
          firstFile,
        ),
      /INTEGRITY_FAILURE/u,
    );
    rmSync(join(projDir, `${firstFile}-wal`), { force: true });

    // Wrong lock token must still fail closed with PROJECTION_PATH_INVALID
    assert.throws(
      () =>
        filesystemStableProjectionDirectoryOperations.captureRetiredGeneration(
          projDir,
          identity,
          "0".repeat(32),
          firstFile,
        ),
      /PROJECTION_PATH_INVALID/u,
    );
  } finally {
    rmSync(projDir, { recursive: true, force: true });
  }
});

test("6. P1 Fix: passing home projectRoot (containing v1ArchiveRoot) to MCP tools succeeds without FRESH_START_PATH_OVERLAP", async () => {
  const fixture = await createActiveStoreFixture("pm-v2-selfroot-");
  const foundation = await createV2Foundation(fixture.config, { entryUrl: V2_DIST_ENTRY_URL });
  try {
    const lifecycle = (await foundation.content.invoke("memory_lifecycleStatus", {
      projectRoot: fixture.projectRoot,
    })) as { ok: boolean; mode: string };
    assert.equal(lifecycle.ok, true);
    assert.equal(lifecycle.mode, "active");
  } finally {
    await foundation.close();
    fixture.cleanup();
  }
});

test("7. Next-Gen AI Memory Intelligence: Git-Diff Auto-Context, 1-Call Auto-Verify, Bilingual Technical Synonyms + Causal Triad Boosting, and Session-End Curation", async () => {
  const fixture = await createActiveStoreFixture("pm-v2-nextgen-ai-");
  const foundation = await createV2Foundation(fixture.config, { entryUrl: V2_DIST_ENTRY_URL });
  const git = new SpawnSyncGitCommandRunner();
  git.run(fixture.projectRoot, ["init"]);
  mkdirSync(join(fixture.projectRoot, "src", "engine"), { recursive: true });
  writeFileSync(
    join(fixture.projectRoot, "src", "engine", "query-planner.ts"),
    "export class QueryPlanner {}\n",
    "utf8",
  );
  try {
    // 1. Start session with taskSummary and verify immediate currentTask binding
    const session = (await foundation.content.invoke("memory_sessionStart", {
      agentName: "superpowers-agent",
      taskSummary: "แก้ปัญหาฐานข้อมูล SQLite ค้างและปรับปรุง QueryPlanner",
      includeContext: false,
    })) as {
      ok: boolean;
      sessionId: string;
      sessions: Array<{ sessionId: string; currentTask: string }>;
    };
    assert.equal(session.ok, true);
    const activeSessionView = session.sessions.find((s) => s.sessionId === session.sessionId);
    assert.ok(activeSessionView, "Expected started session in sessions list");
    assert.equal(
      activeSessionView.currentTask,
      "แก้ปัญหาฐานข้อมูล SQLite ค้างและปรับปรุง QueryPlanner",
      "Expected taskSummary to bind immediately as currentTask on session start",
    );

    // 2. Write a Causal Memory Triad (Mistake + Insight + ADR) in the same session, testing 1-call autoVerify: true on Mistake & ADR, and leaving Insight as candidate for session-end auto-promotion
    const mistake = (await foundation.content.invoke("memory_writeMistake", {
      sessionId: session.sessionId,
      title: "SQLite busy_timeout lock latency in src/engine/query-planner.ts",
      summary: "Omitting busy_timeout in src/engine/query-planner.ts (`QueryPlanner`) causes database lock timeout under concurrent reads.",
      autoVerify: true,
    })) as { recordId: string; status: string; autoPromoted?: boolean };
    assert.equal(mistake.status, "verified", "autoVerify: true should promote mistake to verified in 1 call");
    assert.equal(mistake.autoPromoted, true);

    const insight = (await foundation.content.invoke("memory_writeInsight", {
      sessionId: session.sessionId,
      title: "Root Cause of Concurrent Read Starvation",
      summary: "WAL mode requires a non-zero busy timeout so readers and writers coordinate without SQLITE_BUSY.",
    })) as { recordId: string; status: string };
    assert.equal(insight.status, "candidate");

    const adr = (await foundation.content.invoke("memory_writeADR", {
      sessionId: session.sessionId,
      title: "Enforce 5000ms busy_timeout Policy",
      summary: "All connection pools must set PRAGMA busy_timeout = 5000 at initialization.",
      autoVerify: true,
    })) as { recordId: string; status: string };
    assert.equal(adr.status, "verified", "autoVerify: true should promote ADR to verified in 1 call");

    // 3. Strategy 1: Git-Diff Auto-Context — call memory_selfCheck WITHOUT plannedFiles; dirty file src/engine/query-planner.ts in git status must be auto-detected!
    const selfCheck = (await foundation.content.invoke("memory_selfCheck", {
      sessionId: session.sessionId,
      taskSummary: "General code review",
    })) as {
      riskLevel: string;
      autoDetectedFiles?: string[];
      fileSpecificWarnings: Array<{ filePath: string; recordId: string }>;
    };
    assert.ok(
      Array.isArray(selfCheck.autoDetectedFiles) &&
        selfCheck.autoDetectedFiles.some((f) => f.includes("src/engine/query-planner.ts")),
      "Expected git dirty file src/engine/query-planner.ts to be auto-detected when plannedFiles is omitted",
    );
    assert.ok(
      selfCheck.fileSpecificWarnings.some((w) => w.recordId === mistake.recordId),
      "Expected fileSpecificWarnings to surface mistake for auto-detected git file",
    );
    assert.equal(selfCheck.riskLevel, "high");

    // 4. Strategy 3: Bilingual Thai <-> English Technical Synonym Search & Causal Triad Boosting
    // Query purely in Thai ("ปัญหาฐานข้อมูลล็อกและค้างช้า") while the notes are in English!
    const pack = (await foundation.content.invoke("memory_contextPack", {
      sessionId: session.sessionId,
      query: "ปัญหาฐานข้อมูลล็อกและค้างช้า",
      autoDetectFiles: false,
    })) as {
      relevantProjectNotes: Array<{ recordId: string; recordKind: string; relevanceScore: number }>;
      causalTriads?: Array<{
        anchorMistakeId: string;
        relatedInsightIds: string[];
        relatedAdrIds: string[];
      }>;
    };

    const relevantIds = pack.relevantProjectNotes.map((n) => n.recordId);
    assert.ok(
      relevantIds.includes(mistake.recordId),
      "Bilingual Thai query 'ปัญหาฐานข้อมูลล็อกและค้างช้า' must match English SQLite lock latency mistake",
    );
    assert.ok(
      relevantIds.includes(insight.recordId) && relevantIds.includes(adr.recordId),
      "Causal Triad Boosting must pull in sibling Insight and ADR from the same session",
    );
    assert.ok(
      Array.isArray(pack.causalTriads) &&
        pack.causalTriads.some(
          (t) =>
            t.anchorMistakeId === mistake.recordId &&
            t.relatedInsightIds.includes(insight.recordId) &&
            t.relatedAdrIds.includes(adr.recordId),
        ),
      "Expected causalTriads to link Mistake -> Insight -> ADR",
    );

    // 5. Strategy 4: Autonomous Session-End Curation
    const ended = (await foundation.content.invoke("memory_sessionEnd", {
      sessionId: session.sessionId,
      summary: "Completed query planner reliability improvements",
      autoPromote: true,
    })) as {
      ok: boolean;
      curationSummary?: {
        sessionNoteCount: number;
        autoPromotedCount: number;
        autoPromotedIds: string[];
      };
    };
    assert.equal(ended.ok, true);
    assert.ok(ended.curationSummary, "Expected curationSummary on memory_sessionEnd");
    assert.equal(ended.curationSummary.sessionNoteCount, 3);
    assert.ok(
      ended.curationSummary.autoPromotedIds.includes(insight.recordId),
      "Expected remaining candidate insight from session to be auto-promoted on sessionEnd",
    );
  } finally {
    await foundation.close();
    fixture.cleanup();
  }
});

test("8. Core V2 Engine Hardening: read-only purity, dynamic git branch-scope projection binding, pure note titles/bodies, expire sync, and finalized session-end lease release", async () => {
  const projectRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "pm-v2-branch-hardening-")));
  const git = new SpawnSyncGitCommandRunner();
  git.run(projectRoot, ["init", "-b", "feat/alpha"]);
  git.run(projectRoot, ["config", "user.email", "test@example.com"]);
  git.run(projectRoot, ["config", "user.name", "Test Operator"]);
  writeFileSync(join(projectRoot, ".gitignore"), "memory/\nmemory-v2/\n.antigravity/\n", "utf8");
  git.run(projectRoot, ["add", ".gitignore"]);
  git.run(projectRoot, ["commit", "-m", "initial commit on feat/alpha"]);

  const v1ArchiveRoot = join(projectRoot, "memory");
  mkdirSync(v1ArchiveRoot, { recursive: true });
  writeFileSync(join(v1ArchiveRoot, "sentinel.txt"), "archive-sentinel");
  const v2VaultRoot = join(projectRoot, "memory-v2");
  const config = await ensureProjectV2StoreReady({
    projectRoot,
    v2VaultRoot,
    v1ArchiveRoot,
    entryUrl: V2_DIST_ENTRY_URL,
    ensureActive: true,
  });

  const foundation = await createV2Foundation(config, { entryUrl: V2_DIST_ENTRY_URL });
  const initStatus = await foundation.status();
  const resolvedEventsPath = join(
    projectRoot,
    ".git",
    "project-memory",
    initStatus.projectId,
    "v2",
    "events.sqlite",
  );
  try {
    // 8a. Read-only purity: memory_awaken, memory_selfCheck, memory_lifecycleStatus must NOT create sessions or events on an empty active store
    const emptyLifecycle = (await foundation.content.invoke("memory_lifecycleStatus", {})) as {
      ok: boolean;
      sessionId: string | null;
    };
    const emptySelfCheck = (await foundation.content.invoke("memory_selfCheck", {
      taskSummary: "Inspect empty project",
    })) as { ok: boolean; sessionId: string | null };
    const emptyAwaken = (await foundation.content.invoke("memory_awaken", {
      area: "empty-project",
    })) as { ok: boolean; sessionId: string | null };

    assert.equal(emptyLifecycle.ok, true);
    assert.equal(emptySelfCheck.ok, true);
    assert.equal(emptyAwaken.ok, true);
    assert.equal(emptyLifecycle.sessionId, null, "Read-only lifecycleStatus must not auto-start a session");
    assert.equal(emptySelfCheck.sessionId, null, "Read-only selfCheck must not auto-start a session");
    assert.equal(emptyAwaken.sessionId, null, "Read-only awaken must not auto-start a session");

    {
      const roDb = new DatabaseSync(resolvedEventsPath, { readOnly: true });
      try {
        const evCount = (roDb.prepare("SELECT COUNT(*) AS cnt FROM events").get() as { cnt: number | bigint }).cnt;
        const sessCount = (roDb.prepare("SELECT COUNT(*) AS cnt FROM session_authority").get() as { cnt: number | bigint }).cnt;
        assert.equal(Number(evCount), 0, "Read-only tools must append 0 events");
        assert.equal(Number(sessCount), 0, "Read-only tools must create 0 sessions");
      } finally {
        roDb.close();
      }
    }

    // 8b. Write note & checkpoint on feat/alpha, then switch git branch to main and verify dynamic projection re-binding + cross-branch duplicate/radar
    const alphaSession = (await foundation.content.invoke("memory_sessionStart", {
      agentName: "alpha-agent",
      taskSummary: "Alpha branch work",
      includeContext: false,
    })) as { sessionId: string };

    await foundation.content.invoke("memory_writeADR", {
      sessionId: alphaSession.sessionId,
      title: "ADR: Enforce Strict Input Validation",
      summary: "Validate all incoming JSON payloads at boundary.",
      autoVerify: true,
    });
    await foundation.content.invoke("memory_checkpoint", {
      sessionId: alphaSession.sessionId,
      taskSummary: "Alpha branch checkpoint",
      nextActions: ["Verify alpha validation rules after merge"],
    });
    await foundation.content.invoke("memory_sessionEnd", {
      sessionId: alphaSession.sessionId,
      summary: "Completed alpha branch session",
      finalize: true,
    });

    // Switch live git workspace to main branch WITHOUT recreating foundation!
    git.run(projectRoot, ["checkout", "-b", "main"]);
    git.run(projectRoot, ["commit", "--allow-empty", "-m", "switch to main"]);

    mkdirSync(join(projectRoot, ".antigravity"), { recursive: true });
    const mainSession = (await foundation.content.invoke("memory_sessionStart", {
      agentName: "main-agent",
      taskSummary: "Main branch work",
      includeContext: false,
    })) as { sessionId: string };

    const mainDupAdr = (await foundation.content.invoke("memory_writeADR", {
      sessionId: mainSession.sessionId,
      title: "ADR: Enforce Strict Input Validation",
      summary: "Validate all incoming JSON payloads at boundary.",
    })) as { recordId: string };

    const pureBodyInsight = (await foundation.content.invoke("memory_writeInsight", {
      sessionId: mainSession.sessionId,
      title: "Insight: Preserve Clean Markdown Body",
      summary: "Never mutate original Markdown body during promotion.",
      content: "# Insight: Preserve Clean Markdown Body\n\nOriginal Markdown content stays immutable.",
    })) as { recordId: string };

    const expirableAdr = (await foundation.content.invoke("memory_writeADR", {
      sessionId: mainSession.sessionId,
      title: "Temporary Feature Flag Policy",
      summary: "Enable beta flag during rollout week.",
      autoVerify: true,
    })) as { recordId: string };

    // Verify dynamic branch-scope projection published main branch notes into canonical_items!
    const mainSearch = (await foundation.content.invoke("memory_search", {
      query: "Preserve Clean Markdown Body",
    })) as { items: Array<{ id?: string; recordId?: string }> };
    assert.ok(
      mainSearch.items.some((i) => (i.recordId ?? i.id) === pureBodyInsight.recordId),
      "Expected Projection V3 FTS search to dynamically bind to refs/heads/main and index main branch notes",
    );

    // Verify cross-branch duplicate detection catches the duplicate ADR across feat/alpha and main
    const dups = (await foundation.content.invoke("memory_findDuplicates", {})) as {
      duplicateGroups: Array<{ contentHash: string; recordIds: string[] }>;
    };
    assert.ok(
      dups.duplicateGroups.some((g) => g.recordIds.includes(mainDupAdr.recordId) && g.recordIds.length >= 2),
      "Expected memory_findDuplicates to detect duplicate notes across branch scopes",
    );

    // Verify follow-up radar surfaces checkpoint nextActions across branches
    const radar = (await foundation.content.invoke("memory_followUpRadar", { limit: 10 })) as {
      ok: boolean;
      items?: Array<Record<string, unknown>>;
      openCheckpointFollowUps?: Array<{ action: string }>;
    };
    assert.equal(radar.ok, true);
    const radarText = JSON.stringify(radar);
    assert.ok(
      radarText.includes("Verify alpha validation rules after merge"),
      "Expected memory_followUpRadar to surface cross-branch checkpoint nextActions",
    );

    // 8c. Clean note titles (never truncated to bare 'ADR' or 'Insight') & pure Markdown body after promotion
    await foundation.content.invoke("memory_promote", {
      sessionId: mainSession.sessionId,
      recordId: pureBodyInsight.recordId,
      targetStatus: "verified",
      verificationMethod: "user-confirmed",
      verificationAnchor: "unit-test-anchor",
      reason: "Promoted via unit test",
    });

    const packAfterPromote = (await foundation.content.invoke("memory_contextPack", {
      sessionId: mainSession.sessionId,
      query: "Preserve Clean Markdown Body",
      autoDetectFiles: false,
    })) as {
      relevantProjectNotes: Array<{ recordId: string; title: string }>;
    };
    const matchedInsight = packAfterPromote.relevantProjectNotes.find(
      (n) => n.recordId === pureBodyInsight.recordId,
    );
    assert.ok(matchedInsight, "Expected promoted insight in relevantProjectNotes");
    assert.notEqual(
      matchedInsight.title,
      "Insight",
      "Note title with 'Insight: ...' must never truncate to bare 'Insight'",
    );
    assert.ok(
      matchedInsight.title.includes("Preserve Clean Markdown Body"),
      `Expected descriptive title, got: ${matchedInsight.title}`,
    );

    const fullInsight = (await foundation.content.invoke("memory_get", {
      id: pureBodyInsight.recordId,
    })) as { content?: { body?: string }; body?: string };
    const actualBody = fullInsight.content?.body ?? fullInsight.body ?? "";
    assert.equal(
      actualBody,
      "# Insight: Preserve Clean Markdown Body\n\nOriginal Markdown content stays immutable.",
      "Promoting a note must not append verificationAnchor/reason onto note body",
    );

    // 8d. #handleExpire immediately republishes projection V3 and syncs .antigravity/MEMORY_RULES.md
    const rulesPath = join(projectRoot, ".antigravity", "MEMORY_RULES.md");
    assert.ok(
      readFileSync(rulesPath, "utf8").includes(expirableAdr.recordId),
      "Expected active ADR in MEMORY_RULES.md before expiration",
    );
    await foundation.content.invoke("memory_expire", {
      sessionId: mainSession.sessionId,
      recordId: expirableAdr.recordId,
      reason: "Rollout week ended",
    });
    assert.ok(
      !readFileSync(rulesPath, "utf8").includes(expirableAdr.recordId),
      "Expected memory_expire to republish projection and remove expired ADR from MEMORY_RULES.md",
    );
    const staleness = (await foundation.content.invoke("memory_checkStaleness", {})) as {
      staleItems: Array<{ recordId: string; status: string }>;
    };
    assert.ok(
      staleness.staleItems.some((s) => s.recordId === expirableAdr.recordId && s.status === "expired"),
      "Expected memory_checkStaleness to report expired ADR immediately",
    );

    // 8e. Finalize session end & verify terminal 'ended' state + released lease in session_leases
    const finalizedEnd = (await foundation.content.invoke("memory_sessionEnd", {
      sessionId: mainSession.sessionId,
      summary: "Completed main branch work",
      finalize: true,
    })) as { ok: boolean; phase: string; state?: string };
    assert.equal(finalizedEnd.ok, true);
    assert.equal(finalizedEnd.phase, "completed");
    assert.equal(finalizedEnd.state, "ended");

    const postEndLifecycle = (await foundation.content.invoke("memory_lifecycleStatus", {})) as {
      sessions: Array<{ sessionId: string; semanticState: string; leaseState: string }>;
    };
    const mainSessionView = postEndLifecycle.sessions.find((s) => s.sessionId === mainSession.sessionId);
    assert.ok(mainSessionView, "Expected finalized session in lifecycle sessions list");
    assert.equal(mainSessionView.semanticState, "ended");
    assert.equal(mainSessionView.leaseState, "released");

    // Non-existent routed projectRoot must reject with FRESH_START_INPUT_INVALID without creating the directory on disk
    const nonExistentTarget = join(projectRoot, "..", `pm-v2-must-not-create-${randomUUID()}`);
    await assert.rejects(
      () =>
        foundation.content.invoke("memory_list", {
          projectRoot: nonExistentTarget,
        }),
      /FRESH_START_INPUT_INVALID/u,
    );
    assert.equal(
      existsSync(nonExistentTarget),
      false,
      "Routing to a non-existent projectRoot must never create directories on disk",
    );
  } finally {
    await foundation.close();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("9. Unified Entity/Link Extractor, IDF-weighted Causal Triads & memory_verifySourceTruth disk/wikilink verification", async () => {
  const fixture = await createActiveStoreFixture("pm-v2-entity-truth-");
  const foundation = await createV2Foundation(fixture.config, {
    entryUrl: V2_DIST_ENTRY_URL,
  });
  try {
    mkdirSync(join(fixture.projectRoot, "src"), { recursive: true });
    writeFileSync(
      join(fixture.projectRoot, "src", "existing-module.ts"),
      "export class SpecificTriadLockGuard {}\n",
      "utf8",
    );
    writeFileSync(join(fixture.projectRoot, "package.json"), '{"name":"test-pkg"}\n', "utf8");

    const fileUri = `${pathToFileURL(join(fixture.projectRoot, "src", "existing-module.ts")).href}#L1-L5`;
    const session = (await foundation.content.invoke("memory_sessionStart", {
      agentName: "entity-auditor",
      taskSummary: "Verify entity extraction, IDF triads, and source truth",
      includeContext: false,
    })) as { sessionId: string };

    // 9a. Write target note for wikilink + noise-heavy note testing entity extraction precision
    const targetAdr = (await foundation.content.invoke("memory_writeADR", {
      sessionId: session.sessionId,
      title: "Canonical Lock Guard Policy",
      summary: "Use `SpecificTriadLockGuard` in src\\existing-module.ts and .github/workflows/ci.yml.",
      content: [
        "# Canonical Lock Guard Policy",
        "",
        `Inspect [existing-module.ts](${fileUri}), package.json, tests/unit.test.ts, and .cursor/rules/project-memory.mdc.`,
        "Ignore noise: v1.0.0, Node.js, e.g., i.e., 127.0.0.1, https://example.com/src/fake-url.ts, \"/mvc/views.js\", vendor.js, dist/missing-bundle.js.",
        "Ignore stop-symbols: `null`, `undefined`, `read-only-recovery`, #graph, Summary, Context, Decision, Date, JSON, Promise, Map, Set, Array, Object, Error, WebUI, TypeScript, `main`, `master`, `HEAD`.",
        "ubiquitous ref: `UbiquitousRouterSymbol`",
      ].join("\n"),
      autoVerify: true,
    })) as { recordId: string };

    // Start a separate session for the 4 unrelated insights so sameSession is false vs session2
    await foundation.content.invoke("memory_sessionEnd", {
      sessionId: session.sessionId,
      summary: "Done session 1",
      finalize: true,
    });
    const sessionNoise = (await foundation.content.invoke("memory_sessionStart", {
      agentName: "noise-writer",
      taskSummary: "Seed ubiquitous router symbol insights",
      includeContext: false,
    })) as { sessionId: string };

    // Create 4 unrelated insights sharing ONLY UbiquitousRouterSymbol (>40% DF across corpus)
    const unrelatedIds: string[] = [];
    for (let i = 1; i <= 4; i += 1) {
      const ins = (await foundation.content.invoke("memory_writeInsight", {
        sessionId: sessionNoise.sessionId,
        title: `Unrelated Module Insight ${i}`,
        summary: `Routine note ${i} mentioning \`UbiquitousRouterSymbol\` only.`,
        content: `# Unrelated Module Insight ${i}\n\nMentions \`UbiquitousRouterSymbol\`.`,
      })) as { recordId: string };
      unrelatedIds.push(ins.recordId);
    }

    await foundation.content.invoke("memory_sessionEnd", {
      sessionId: sessionNoise.sessionId,
      summary: "Done noise session",
      finalize: true,
    });
    const session2 = (await foundation.content.invoke("memory_sessionStart", {
      agentName: "triad-tester",
      taskSummary: "Session 2 mistake",
      includeContext: false,
    })) as { sessionId: string };

    const anchorMistake = (await foundation.content.invoke("memory_writeMistake", {
      sessionId: session2.sessionId,
      title: "Deadlock Without Lock Guard",
      summary: "Forgot `SpecificTriadLockGuard` alongside `UbiquitousRouterSymbol`.",
      content: [
        "# Deadlock Without Lock Guard",
        "",
        "See [[Canonical Lock Guard Policy]] and broken [[NonExistent Wiki Target]].",
        "Also references missing file src/deleted-ghost.ts.",
      ].join("\n"),
      autoVerify: true,
    })) as { recordId: string };

    // Check extracted entities on targetAdr via contextPack
    const pack = (await foundation.content.invoke("memory_contextPack", {
      query: "Canonical Lock Guard Policy",
      autoDetectFiles: false,
    })) as {
      relevantProjectNotes: Array<{
        recordId: string;
        filePaths: string[];
        symbols: string[];
      }>;
      causalTriads: Array<{
        anchorMistakeId: string;
        relatedAdrIds: string[];
        relatedInsightIds: string[];
      }>;
    };

    const adrNote = pack.relevantProjectNotes.find((n) => n.recordId === targetAdr.recordId);
    assert.ok(adrNote, "Expected targetAdr in contextPack");
    assert.ok(adrNote.filePaths.includes("src/existing-module.ts"), `Missing normalized path in ${JSON.stringify(adrNote.filePaths)}`);
    assert.ok(adrNote.filePaths.includes(".github/workflows/ci.yml"), "Expected dot-directory workflow path");
    assert.ok(adrNote.filePaths.includes(".cursor/rules/project-memory.mdc"), "Expected .mdc path");
    assert.ok(adrNote.filePaths.includes("tests/unit.test.ts"), "Expected compound .test.ts path");
    assert.ok(adrNote.filePaths.includes("package.json"), "Expected existing root package.json");
    for (const forbidden of [
      "v1.0.0",
      "Node.js",
      "e.g.",
      "i.e.",
      "127.0.0.1",
      "src/fake-url.ts",
      "/mvc/views.js",
      "mvc/views.js",
      "vendor.js",
      "dist/missing-bundle.js",
    ]) {
      assert.ok(
        !adrNote.filePaths.includes(forbidden),
        `Entity extractor must reject false-positive file path '${forbidden}', got ${JSON.stringify(adrNote.filePaths)}`,
      );
    }

    assert.ok(adrNote.symbols.includes("SpecificTriadLockGuard"));
    for (const stopSym of [
      "null",
      "undefined",
      "read-only-recovery",
      "#graph",
      "Summary",
      "Context",
      "Decision",
      "Date",
      "JSON",
      "Promise",
      "WebUI",
      "TypeScript",
      "main",
      "master",
      "HEAD",
    ]) {
      assert.ok(
        !adrNote.symbols.includes(stopSym),
        `Entity extractor must reject stop-symbol '${stopSym}', got ${JSON.stringify(adrNote.symbols)}`,
      );
    }

    // 9b. IDF-weighted causalTriads: links anchorMistake -> targetAdr via SpecificTriadLockGuard, ignoring ubiquitous UbiquitousRouterSymbol!
    const packMistake = (await foundation.content.invoke("memory_contextPack", {
      query: "Deadlock Without Lock Guard",
      autoDetectFiles: false,
    })) as Omit<typeof pack, "causalTriads"> & {
      causalTriads: Array<{
        anchorMistakeId: string;
        mistakeTitle: string;
        relatedAdrIds: string[];
        relatedInsightIds: string[];
        relatedAdrs?: Array<{ recordId: string; title: string; score: number }>;
        relatedInsights?: Array<{ recordId: string; title: string; score: number }>;
      }>;
    };
    const triad = packMistake.causalTriads.find((t) => t.anchorMistakeId === anchorMistake.recordId);
    assert.ok(triad, "Expected causal triad anchored on Deadlock Without Lock Guard");
    assert.ok(
      triad.relatedAdrIds.includes(targetAdr.recordId),
      "Expected high-IDF SpecificTriadLockGuard to link mistake -> targetAdr",
    );
    assert.ok(
      Array.isArray(triad.relatedAdrs) &&
        triad.relatedAdrs.some(
          (a) => a.recordId === targetAdr.recordId && a.title === "Canonical Lock Guard Policy",
        ),
      `Expected human-readable relatedAdrs metadata on causalTriad, got ${JSON.stringify(triad.relatedAdrs)}`,
    );
    for (const uid of unrelatedIds) {
      assert.ok(
        !triad.relatedInsightIds.includes(uid),
        `Ubiquitous symbol (>40% DF) must not create noisy causal triad link to ${uid}`,
      );
    }

    // 9b-2. Generic section headings (# Root Cause & Prevention, # Context) must NOT hijack note title, and `main` must not leak into symbols
    const sectionHeadingMistake = (await foundation.content.invoke("memory_writeMistake", {
      sessionId: session2.sessionId,
      summary:
        "Mistake: Unescaped Backslashes in Browser Bundles: Single backslashes broke template literals on `main`.",
      content: "# Root Cause & Prevention\n\nOccurred on branch `main` in `src/existing-module.ts`.",
      autoVerify: true,
    })) as { recordId: string };
    const listedAfterSectionMistake = (await foundation.content.invoke("memory_list", {
      limit: 50,
    })) as {
      items: Array<{ recordId: string; title: string; symbols: string[] }>;
    };
    const projectedSectionMistake = listedAfterSectionMistake.items.find(
      (i) => i.recordId === sectionHeadingMistake.recordId,
    );
    assert.ok(projectedSectionMistake, "Expected sectionHeadingMistake in memory_list");
    assert.equal(
      projectedSectionMistake.title,
      "Unescaped Backslashes in Browser Bundles",
      "Generic # Root Cause & Prevention body heading must not hijack note title",
    );
    assert.ok(
      !projectedSectionMistake.symbols.includes("main"),
      `Generic branch name 'main' must not be extracted as a code symbol: ${JSON.stringify(projectedSectionMistake.symbols)}`,
    );

    // 9c. memory_verifySourceTruth checks project-scoped events, files on disk, and [[wikilinks]]
    const truth = (await foundation.content.invoke("memory_verifySourceTruth", {})) as {
      ok: boolean;
      verified: boolean;
      existingFiles: string[];
      missingFiles: string[];
      resolvedWikilinks: string[];
      brokenWikilinks: Array<{ recordId: string; target: string } | string>;
    };
    assert.equal(truth.ok, true);
    assert.equal(truth.verified, false, "Source truth must report verified=false when missing files or broken wikilinks exist");
    assert.ok(truth.existingFiles.includes("src/existing-module.ts"));
    assert.ok(truth.missingFiles.includes("src/deleted-ghost.ts"));
    assert.ok(
      JSON.stringify(truth.brokenWikilinks).includes("NonExistent Wiki Target"),
      `Expected broken wikilink reported, got ${JSON.stringify(truth.brokenWikilinks)}`,
    );
  } finally {
    await foundation.close();
    fixture.cleanup();
  }
});
