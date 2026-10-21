import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
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
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { expectedSchemaFingerprint } from "../src/orchestrator/storage/schema-fingerprint.js";
import { inspectV2Build } from "../src/v2/build-identity.js";
import { createV2Foundation } from "../src/v2/composition.js";
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
