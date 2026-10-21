import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { runV2Admin } from "../src/v2/admin.js";
import { inspectV2Build } from "../src/v2/build-identity.js";
import { createV2Foundation } from "../src/v2/composition.js";
import {
  V2_PRODUCTION_CAPABILITIES,
  V2_PRODUCTION_RECOVERY_POLICY,
  loadV2LaunchConfig,
} from "../src/v2/config.js";
import { V2_PUBLIC_TOOL_DEFINITIONS } from "../src/v2/public-tools.js";
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

async function createActiveStoreFixture(prefix = "pm-v2-awaken-") {
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
    evidenceDigest: sha({ purpose: "v2-awakening-test" }),
    createdAt: "2026-10-21T00:00:00.000Z",
  });

  const initializer = new FreshStartInitializer({
    projectionSchemaVersion: 3,
    inspectBuild: () => buildIdentityHash,
    actorFingerprint: sha("v2-awakening-test-operator"),
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
    eventsPath,
    config,
    cleanup(): void {
      rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

test("1. All 33 content tools expose rich inputSchema.properties including optional projectRoot", () => {
  const byName = new Map(V2_PUBLIC_TOOL_DEFINITIONS.map((t) => [t.name, t]));
  assert.equal(byName.size, 34);

  for (const [name, def] of byName.entries()) {
    if (name === "memory_v2Status") {
      assert.equal(def.inputSchema.additionalProperties, false);
      continue;
    }
    const props = def.inputSchema.properties as Record<string, unknown>;
    assert.ok(
      Object.keys(props).length > 0,
      `Expected non-empty inputSchema.properties on ${name}`,
    );
    assert.ok(
      Object.hasOwn(props, "projectRoot"),
      `Expected optional projectRoot property on ${name}`,
    );
  }

  const searchProps = byName.get("memory_search")!.inputSchema.properties as Record<string, unknown>;
  assert.ok(Object.hasOwn(searchProps, "query"));
  assert.ok(Object.hasOwn(searchProps, "limit"));

  const checkpointProps = byName.get("memory_checkpoint")!.inputSchema.properties as Record<string, unknown>;
  assert.ok(Object.hasOwn(checkpointProps, "taskSummary"));
  assert.ok(Object.hasOwn(checkpointProps, "nextActions"));
  assert.ok(Object.hasOwn(checkpointProps, "blockers"));
  assert.ok(Object.hasOwn(checkpointProps, "filesTouched"));
});

test("2. Cross-session visibility, hybrid Soft-OR/Thai search, structured checkpoints, active selfCheck, and autonomous awaken", async () => {
  const fixture = await createActiveStoreFixture();
  try {
    const foundation = await createV2Foundation(fixture.config, { entryUrl: V2_DIST_ENTRY_URL });
    try {
      // Session 1: write ADR, Mistake, Insight, and a structured Checkpoint
      const s1 = (await foundation.content.invoke("memory_sessionStart", {
        agentName: "session-1-agent",
        taskDescription: "Establish core architecture and record lessons",
      })) as { sessionId: string };

      const adr = (await foundation.content.invoke("memory_writeADR", {
        sessionId: s1.sessionId,
        title: "ADR: Multi-Project Isolated V2 Stores",
        summary: "Each project uses its own memory-v2 SQLite event store and Projection Schema 3.",
        content: "# Decision\n\nRoute projectRoot to isolated V2Foundation instances.",
        confidence: "high",
      })) as { recordId: string };

      const mistake = (await foundation.content.invoke("memory_writeMistake", {
        sessionId: s1.sessionId,
        title: "Mistake: Never bypass buildIdentityHash sync after npm run build",
        summary: "Editing src/v2 without syncing fresh_start_releases causes FRESH_START_RELEASE_MISMATCH.",
        content: "# Root Cause\n\nassertPreparedRelease verifies inspectV2Build() against SQLite.",
        confidence: "high",
      })) as { recordId: string };

      const thaiInsight = (await foundation.content.invoke("memory_writeInsight", {
        sessionId: s1.sessionId,
        title: "Insight: ระบบตื่นรู้และค้นหาความจำแม่นยำสูงสุด",
        summary: "รองรับการค้นหาภาษาไทยและ Hybrid Soft-OR ข้าม Session อัตโนมัติ",
        content: "# รายละเอียด\n\nช่วยให้ AI คิดเองได้ว่าจะทำอะไรต่อทันทีที่เริ่มงาน",
        confidence: "high",
      })) as { recordId: string };

      const checkpoint = (await foundation.content.invoke("memory_checkpoint", {
        sessionId: s1.sessionId,
        taskSummary: "Completed Phase 1 retrieval and awakening engine",
        completedItems: ["Implemented rich schemas", "Added hybrid search"],
        inProgressItems: ["Roll out multi-project router"],
        blockers: ["Need to sync buildIdentityHash on SPX store"],
        nextActions: ["Run bootstrap-project on api-gateway", "Verify all unit tests"],
        decisions: ["Use per-project isolated V2 stores with dynamic projectRoot routing"],
        filesTouched: ["src/v2/public-tools.ts", "src/v2/composition.ts"],
      })) as {
        ok: boolean;
        checkpointId: string;
        draft?: {
          completedItems: string[];
          inProgressItems: string[];
          blockers: string[];
          nextActions: string[];
          filesTouched: string[];
        };
      };
      assert.equal(checkpoint.ok, true);
      assert.deepEqual(checkpoint.draft?.nextActions, [
        "Run bootstrap-project on api-gateway",
        "Verify all unit tests",
      ]);

      // Session 2: brand new session with 0 notes written in Session 2!
      const s2 = (await foundation.content.invoke("memory_sessionStart", {
        agentName: "session-2-agent",
        taskDescription: "Resume work in a fresh session",
      })) as { sessionId: string };
      assert.notEqual(s2.sessionId, s1.sessionId);

      // 2a. Cross-session visibility + Hybrid multi-word Soft-OR query (where some words are not in the note)
      const multiWordSearch = (await foundation.content.invoke("memory_search", {
        sessionId: s2.sessionId,
        query: "buildIdentityHash sync after npm run build extraUnmatchedKeyword",
        limit: 10,
      })) as { items: Array<{ id: string }> };
      assert.ok(
        multiWordSearch.items.some((item) => item.id === mistake.recordId),
        "Expected hybrid Soft-OR search in new session s2 to find mistake note from session s1",
      );

      // 2b. Thai natural-language query in new session s2
      const thaiSearch = (await foundation.content.invoke("memory_search", {
        sessionId: s2.sessionId,
        query: "ระบบตื่นรู้ คิดเองได้ว่าจะทำอะไรต่อ",
        limit: 10,
      })) as { items: Array<{ id: string }> };
      assert.ok(
        thaiSearch.items.some((item) => item.id === thaiInsight.recordId),
        "Expected Thai natural-language query in new session s2 to find Thai insight from session s1",
      );

      // 2c. memory_list and memory_recent in new session s2 return notes from session s1
      const listedInS2 = (await foundation.content.invoke("memory_list", {
        sessionId: s2.sessionId,
        limit: 10,
      })) as { items: Array<{ id: string }> };
      assert.ok(listedInS2.items.length >= 3);

      // 2d. Active Pre-Flight Guardrail (memory_selfCheck) surfaces matching mistakes and ADRs
      const selfCheck = (await foundation.content.invoke("memory_selfCheck", {
        sessionId: s2.sessionId,
        taskSummary: "Rebuild dist with npm run build and route multi-project V2 stores",
        filesTouched: ["src/v2/composition.ts"],
      })) as {
        ok: boolean;
        riskLevel: "low" | "medium" | "high";
        pastMistakesToAvoid: Array<{ id: string; title: string; summary: string }>;
        bindingADRs: Array<{ id: string; title: string; summary: string }>;
        preFlightChecklist: string[];
      };
      assert.equal(selfCheck.ok, true);
      assert.ok(
        selfCheck.pastMistakesToAvoid.some((m) => m.id === mistake.recordId),
        "Expected memory_selfCheck to surface the buildIdentityHash mistake",
      );
      assert.ok(
        selfCheck.bindingADRs.some((a) => a.id === adr.recordId),
        "Expected memory_selfCheck to surface the Multi-Project ADR",
      );
      assert.ok(["medium", "high"].includes(selfCheck.riskLevel));
      assert.ok(Array.isArray(selfCheck.preFlightChecklist) && selfCheck.preFlightChecklist.length > 0);

      // 2e. Autonomous Awakening (memory_awaken) synthesizes continuity, workspaceState, governanceAlerts, and autonomousAgenda
      const awakened = (await foundation.content.invoke("memory_awaken", {
        sessionId: s2.sessionId,
        area: "Multi-Project V2",
      })) as {
        ok: boolean;
        sessionId: string;
        continuity: {
          latestCheckpoint: {
            taskSummary: string;
            blockers: string[];
            nextActions: string[];
            inProgressItems: string[];
          } | null;
          recentDecisions: Array<{ id: string }>;
        };
        workspaceState: {
          projectRoot: string;
          isDirty: boolean;
        };
        governanceAlerts: {
          unpromotedCandidateCount: number;
          conflictedCount: number;
          staleCount: number;
        };
        autonomousAgenda: Array<{
          priority: number;
          category: string;
          action: string;
          rationale: string;
          suggestedTool: string;
        }>;
      };
      assert.equal(awakened.ok, true);
      assert.ok(awakened.continuity);
      assert.equal(
        awakened.continuity.latestCheckpoint?.taskSummary,
        "Completed Phase 1 retrieval and awakening engine",
      );
      assert.deepEqual(awakened.continuity.latestCheckpoint?.blockers, [
        "Need to sync buildIdentityHash on SPX store",
      ]);
      assert.deepEqual(awakened.continuity.latestCheckpoint?.nextActions, [
        "Run bootstrap-project on api-gateway",
        "Verify all unit tests",
      ]);
      assert.ok(awakened.workspaceState);
      assert.equal(awakened.workspaceState.projectRoot, fixture.projectRoot);
      assert.ok(awakened.governanceAlerts);
      assert.ok(awakened.governanceAlerts.unpromotedCandidateCount >= 3);
      assert.ok(Array.isArray(awakened.autonomousAgenda) && awakened.autonomousAgenda.length > 0);
      assert.ok(
        awakened.autonomousAgenda.some((item) =>
          item.action.includes("Need to sync buildIdentityHash on SPX store")
          || item.action.includes("Run bootstrap-project on api-gateway"),
        ),
        "Expected autonomousAgenda to include concrete actions from blockers/nextActions",
      );
    } finally {
      await foundation.close();
    }
  } finally {
    fixture.cleanup();
  }
});

test("3. Multi-project support: bootstrap-project CLI, sync-build CLI, and dynamic projectRoot tool routing", async () => {
  const primaryFixture = await createActiveStoreFixture("pm-v2-primary-");
  const futureProjectRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "pm-v2-future-proj-")));
  try {
    // 3a. One-command bootstrap-project initializes and activates a brand-new project directory
    const bootstrapResult = (await runV2Admin([
      "bootstrap-project",
      "--project-root",
      futureProjectRoot,
    ])) as {
      ok: boolean;
      projectRoot: string;
      v2VaultRoot: string;
      releaseId: string;
      mode: string;
      productionReady: boolean;
    };
    assert.equal(bootstrapResult.ok, true);
    assert.equal(bootstrapResult.mode, "active");
    assert.equal(bootstrapResult.productionReady, true);

    // 3b. sync-build updates fresh_start_releases to current buildIdentityHash idempotently
    const syncResult = (await runV2Admin([
      "sync-build",
      "--project-root",
      futureProjectRoot,
    ])) as {
      ok: boolean;
      buildIdentityHash: string;
      mode: string;
      productionReady: boolean;
    };
    assert.equal(syncResult.ok, true);
    assert.equal(syncResult.mode, "active");
    assert.equal(syncResult.productionReady, true);

    // 3c. Dynamic projectRoot routing from primary foundation to futureProjectRoot
    const primaryFoundation = await createV2Foundation(primaryFixture.config, {
      entryUrl: V2_DIST_ENTRY_URL,
    });
    try {
      const futureSession = (await primaryFoundation.content.invoke("memory_sessionStart", {
        projectRoot: futureProjectRoot,
        agentName: "multi-project-router-test",
        taskDescription: "Write note into futureProjectRoot via primary foundation",
      })) as { sessionId: string; projectRoot?: string };
      assert.equal(typeof futureSession.sessionId, "string");

      const futureNote = (await primaryFoundation.content.invoke("memory_writeInsight", {
        projectRoot: futureProjectRoot,
        sessionId: futureSession.sessionId,
        title: "Future Project Specific Architecture Note",
        summary: "Stored exclusively in futureProjectRoot memory-v2 vault.",
        content: "# Isolated Multi-Project Note\n\nVerified routing by projectRoot.",
        confidence: "high",
      })) as { recordId: string };

      // Verify futureProjectRoot has the note
      const futureSearch = (await primaryFoundation.content.invoke("memory_search", {
        projectRoot: futureProjectRoot,
        query: "Future Project Specific Architecture",
      })) as { items: Array<{ id: string }> };
      assert.ok(futureSearch.items.some((i) => i.id === futureNote.recordId));

      // Verify primaryFixture does NOT have futureProjectRoot's note (strict project isolation!)
      const primarySearch = (await primaryFoundation.content.invoke("memory_search", {
        query: "Future Project Specific Architecture",
      })) as { items: Array<{ id: string }> };
      assert.equal(
        primarySearch.items.some((i) => i.id === futureNote.recordId),
        false,
        "Expected primary project store to remain strictly isolated from futureProjectRoot store",
      );
    } finally {
      await primaryFoundation.close();
    }
  } finally {
    primaryFixture.cleanup();
    rmSync(futureProjectRoot, { recursive: true, force: true });
  }
});
