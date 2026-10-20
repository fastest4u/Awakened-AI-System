import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { FreshStartRelease } from "../src/orchestrator/fresh-start/contracts.js";
import { FreshStartInitializer } from "../src/orchestrator/fresh-start/fresh-start-initializer.js";
import { SqliteFreshStartRepository } from "../src/orchestrator/fresh-start/fresh-start.repository.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { expectedSchemaFingerprint } from "../src/orchestrator/storage/schema-fingerprint.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { inspectV2Build } from "../src/v2/build-identity.js";
import {
  V2_CAPABILITIES,
  V2_NATIVE_TOOLS,
  V2_PRODUCTION_CAPABILITIES,
  V2_PRODUCTION_RECOVERY_POLICY,
  V2_RECOVERY_POLICY,
  V2_SUPERSEDED_V1_TOOLS,
  V2_SUPPORTED_V1_TOOLS,
  V2_UNAVAILABLE_V1_TOOLS,
  V2_V1_PARITY_CLASSIFICATION,
  isProductionReleaseManifest,
  loadV2LaunchConfig,
} from "../src/v2/config.js";
import { createV2Foundation } from "../src/v2/composition.js";
import { activateFreshTestStore } from "./support/fresh-start-fixture.js";

const DIST_V2 = resolve("dist/v2.js");

const ALL_32_V1_TOOLS = [
  "memory_search",
  "memory_get",
  "memory_list",
  "memory_recent",
  "memory_writeSessionLog",
  "memory_writeInsight",
  "memory_writeMistake",
  "memory_writeADR",
  "memory_createFromTemplate",
  "memory_verifyVault",
  "memory_verifyNote",
  "memory_verifySourceTruth",
  "memory_findBrokenLinks",
  "memory_findDuplicates",
  "memory_checkStaleness",
  "memory_validateFrontmatter",
  "memory_fixFrontmatter",
  "memory_migrateFrontmatter",
  "memory_bootstrapProject",
  "memory_reindex",
  "memory_indexNote",
  "memory_compactVault",
  "memory_export",
  "memory_import",
  "memory_diagnoseWorkspace",
  "memory_sessionStart",
  "memory_contextPack",
  "memory_awaken",
  "memory_selfCheck",
  "memory_sessionEnd",
  "memory_lifecycleStatus",
  "memory_followUpRadar",
] as const;

function sha(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

const V2_DIST_ENTRY_URL = pathToFileURL(resolve("dist/v2.js")).href;
const V2_BUILD_MANIFEST = JSON.parse(readFileSync(resolve("dist/v2-build.json"), "utf8")) as {
  deploymentId: string;
  buildIdentityHash: string;
};
(globalThis as Record<string, unknown>).__V2_DEPLOYMENT_ID__ = V2_BUILD_MANIFEST.deploymentId;

async function createStoreFixture(options: {
  productionProfile?: boolean;
  promoteMode?: "prepared" | "active";
} = {}) {
  const productionProfile = options.productionProfile ?? true;
  const promoteMode = options.promoteMode ?? "active";
  const projectRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "pm-v2-public-mcp-")));
  const v1ArchiveRoot = join(projectRoot, "archive");
  mkdirSync(v1ArchiveRoot);
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
  const capabilities = productionProfile ? V2_PRODUCTION_CAPABILITIES : V2_CAPABILITIES;
  const recoveryPolicy = productionProfile ? V2_PRODUCTION_RECOVERY_POLICY : V2_RECOVERY_POLICY;
  const release: Omit<FreshStartRelease, "projectId" | "vaultId" | "storeId"> = Object.freeze({
    profileVersion: 1 as const,
    releaseId,
    buildIdentityHash,
    schemaIdentityHash,
    configurationHash: sha(config),
    capabilityManifestHash: sha(capabilities),
    recoveryPolicyHash: sha(recoveryPolicy),
    evidenceDigest: sha({ purpose: "v2-public-mcp-test" }),
    createdAt: "2026-07-01T00:00:00.000Z",
  });

  const initializer = new FreshStartInitializer({
    projectionSchemaVersion: 3,
    inspectBuild: () => buildIdentityHash,
    actorFingerprint: sha("v2-public-mcp-test-operator"),
  });
  const initialized = await initializer.initializeFresh({
    projectRoot,
    v2VaultRoot,
    v1ArchiveRoot,
    initializationId: randomUUID(),
    release,
  });
  const fullRelease: FreshStartRelease = Object.freeze({
    projectId: initialized.projectId,
    vaultId: initialized.vaultId,
    storeId: initialized.storeId,
    ...release,
  });

  const eventsPath = join(v2VaultRoot, ".memory-mcp", "v2", "events.sqlite");
  if (promoteMode === "active") {
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
  }

  return {
    projectRoot,
    v2VaultRoot,
    v1ArchiveRoot,
    eventsPath,
    env,
    config,
    release: fullRelease,
    cleanup(): void {
      rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

async function withMcpClient<T>(
  fixture: { env: NodeJS.ProcessEnv },
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_V2],
    env: fixture.env as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "v2-public-mcp-test", version: "2.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function parseToolJson(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  assert.ok(Array.isArray(content) && content.length > 0 && typeof content[0]?.text === "string");
  return JSON.parse(content[0]!.text!) as Record<string, unknown>;
}

test("32-tool V1 parity classification and V2 production capability manifest are complete and immutable", () => {
  assert.equal(V2_SUPPORTED_V1_TOOLS.length, 20);
  assert.equal(Object.keys(V2_SUPERSEDED_V1_TOOLS).length, 4);
  assert.equal(V2_UNAVAILABLE_V1_TOOLS.length, 8);
  assert.equal(V2_NATIVE_TOOLS.length, 14);

  const classified = Object.keys(V2_V1_PARITY_CLASSIFICATION).sort();
  assert.deepEqual(classified, [...ALL_32_V1_TOOLS].sort());

  for (const tool of V2_SUPPORTED_V1_TOOLS) {
    assert.deepEqual(V2_V1_PARITY_CLASSIFICATION[tool], { status: "V2-supported" });
  }
  for (const [tool, meta] of Object.entries(V2_SUPERSEDED_V1_TOOLS) as Array<[string, { supersededBy: string }]>) {
    assert.deepEqual(V2_V1_PARITY_CLASSIFICATION[tool as keyof typeof V2_V1_PARITY_CLASSIFICATION], {
      status: "superseded",
      supersededBy: meta.supersededBy,
    });
  }
  for (const tool of V2_UNAVAILABLE_V1_TOOLS) {
    assert.deepEqual(V2_V1_PARITY_CLASSIFICATION[tool], { status: "unavailable" });
  }

  // Foundation constants remain unchanged
  assert.deepEqual(V2_CAPABILITIES, {
    profile: "fresh-start",
    version: 1,
    tools: ["memory_v2Status"],
    content: "unavailable",
  });
  assert.deepEqual(V2_RECOVERY_POLICY, {
    profile: "fresh-start",
    version: 1,
    productionReady: false,
    promotion: "closed",
  });

  // Production constants expose all 34 public tools and governed-v2 content
  assert.equal(V2_PRODUCTION_CAPABILITIES.profile, "fresh-start");
  assert.equal(V2_PRODUCTION_CAPABILITIES.version, 1);
  assert.equal(V2_PRODUCTION_CAPABILITIES.content, "governed-v2");
  assert.equal(V2_PRODUCTION_CAPABILITIES.tools.length, 34);
  assert.equal(V2_PRODUCTION_RECOVERY_POLICY.productionReady, true);
});

test("foundation composition gates productionReady and tool surface by release manifest and store mode", async () => {
  const preparedProd = await createStoreFixture({ productionProfile: true, promoteMode: "prepared" });
  try {
    assert.equal(isProductionReleaseManifest(preparedProd.release), true);
    const foundation = await createV2Foundation(preparedProd.config, { entryUrl: V2_DIST_ENTRY_URL });
    try {
      const status = await foundation.status();
      assert.equal(status.mode, "prepared");
      assert.equal(status.productionReady, false);
      const tools = await foundation.content.listTools!();
      assert.deepEqual(tools.map((t: { name: string }) => t.name), ["memory_v2Status"]);
      await assert.rejects(
        () => foundation.content.invoke("memory_search", { query: "test" }),
        { code: "FRESH_START_RELEASE_NOT_READY" },
      );
    } finally {
      await foundation.close();
    }
  } finally {
    preparedProd.cleanup();
  }

  const activeFoundationOnly = await createStoreFixture({ productionProfile: false, promoteMode: "active" });
  try {
    assert.equal(isProductionReleaseManifest(activeFoundationOnly.release), false);
    const foundation = await createV2Foundation(activeFoundationOnly.config, { entryUrl: V2_DIST_ENTRY_URL });
    try {
      const status = await foundation.status();
      assert.equal(status.mode, "active");
      assert.equal(status.productionReady, false);
      const tools = await foundation.content.listTools!();
      assert.deepEqual(tools.map((t: { name: string }) => t.name), ["memory_v2Status"]);
    } finally {
      await foundation.close();
    }
  } finally {
    activeFoundationOnly.cleanup();
  }
});

test("end-to-end public V2 MCP stdio server executes supported V1 tools, V2-native tools, and refuses unavailable/operator tools across restarts", async () => {
  const fixture = await createStoreFixture({ productionProfile: true, promoteMode: "active" });
  try {
    let sessionId = "";
    let insightRecordId = "";
    let mistakeRecordId = "";
    let adrRecordId = "";
    let sessionLogRecordId = "";

    await withMcpClient(fixture, async (client) => {
      const listed = await client.listTools();
      assert.equal(listed.tools.length, 34);
      const toolNames = new Set(listed.tools.map((t) => t.name));
      assert.ok(toolNames.has("memory_v2Status"));
      for (const supported of V2_SUPPORTED_V1_TOOLS) {
        assert.ok(toolNames.has(supported), `Missing V2-supported V1 tool: ${supported}`);
      }
      for (const nativeTool of V2_NATIVE_TOOLS) {
        assert.ok(toolNames.has(nativeTool), `Missing V2-native tool: ${nativeTool}`);
      }

      // 1. memory_v2Status reports productionReady: true
      const v2Status = parseToolJson(await client.callTool({ name: "memory_v2Status", arguments: {} }));
      assert.equal(v2Status.mode, "active");
      assert.equal(v2Status.productionReady, true);

      // 2. Unavailable V1 tools fail closed with FRESH_START_CAPABILITY_UNAVAILABLE
      for (const unavailableTool of V2_UNAVAILABLE_V1_TOOLS) {
        await assert.rejects(
          () => client.callTool({ name: unavailableTool, arguments: {} }),
          (error: unknown) =>
            error instanceof McpError
            && (error.data as { code?: string } | undefined)?.code === "FRESH_START_CAPABILITY_UNAVAILABLE",
          `Expected ${unavailableTool} to fail with FRESH_START_CAPABILITY_UNAVAILABLE`,
        );
      }

      // 3. Superseded operator-only V1 tools fail closed with FRESH_START_OPERATOR_ONLY_TOOL
      for (const [operatorTool, meta] of Object.entries(V2_SUPERSEDED_V1_TOOLS) as Array<[string, { supersededBy: string }]>) {
        await assert.rejects(
          () => client.callTool({ name: operatorTool, arguments: {} }),
          (error: unknown) =>
            error instanceof McpError
            && (error.data as { code?: string; supersededBy?: string } | undefined)?.code === "FRESH_START_OPERATOR_ONLY_TOOL"
            && (error.data as { supersededBy?: string } | undefined)?.supersededBy === meta.supersededBy,
          `Expected ${operatorTool} to fail with FRESH_START_OPERATOR_ONLY_TOOL`,
        );
      }

      // 4. Lifecycle start & status
      const started = parseToolJson(await client.callTool({
        name: "memory_sessionStart",
        arguments: { agentName: "codex-v2-test", taskDescription: "Verify V2 MCP production readiness" },
      }));
      assert.equal(typeof started.sessionId, "string");
      sessionId = String(started.sessionId);

      const lifecycleStatus = parseToolJson(await client.callTool({
        name: "memory_lifecycleStatus",
        arguments: { sessionId },
      }));
      assert.equal(lifecycleStatus.sessionId, sessionId);

      const selfCheck = parseToolJson(await client.callTool({
        name: "memory_selfCheck",
        arguments: { taskSummary: "About to write governed notes" },
      }));
      assert.equal(selfCheck.ok, true);

      // 5. Write V2 governed notes (auto-retaining evidence and publishing Projection Schema 3)
      const insight = parseToolJson(await client.callTool({
        name: "memory_writeInsight",
        arguments: {
          title: "Child-process verified reads isolate projection SQLite",
          summary: "VerifiedReadAdapter runs in an isolated child process with no key custody.",
          content: "# Verified Read Isolation\n\nAll reads execute against immutable Projection Schema 3 generations.",
          confidence: "high",
        },
      }));
      assert.equal(typeof insight.recordId, "string");
      insightRecordId = String(insight.recordId);

      const mistake = parseToolJson(await client.callTool({
        name: "memory_writeMistake",
        arguments: {
          title: "Avoid raw SQLite reads on the MCP surface",
          summary: "Direct SQLite reads bypass VerifiedReadAdapter child isolation.",
          content: "# Mistake\n\nNever bypass child-process verified read.",
          confidence: "high",
        },
      }));
      assert.equal(typeof mistake.recordId, "string");
      mistakeRecordId = String(mistake.recordId);

      const adr = parseToolJson(await client.callTool({
        name: "memory_writeADR",
        arguments: {
          title: "ADR: V2 32-Tool Capability Manifest",
          summary: "Classify all 32 V1 tools and expose 14 V2-native tools.",
          content: "# Context\n\nV2 requires explicit V1 parity classification.\n\n# Decision\n\nExpose 34 public tools.",
          confidence: "high",
        },
      }));
      assert.equal(typeof adr.recordId, "string");
      adrRecordId = String(adr.recordId);

      const sessionLog = parseToolJson(await client.callTool({
        name: "memory_writeSessionLog",
        arguments: {
          title: "Session Log: V2 Public Tool Surface",
          summary: "Completed governed note creation and projection publication.",
          content: "# Session Summary\n\nCreated insight, mistake, and ADR notes.",
          confidence: "high",
        },
      }));
      assert.equal(typeof sessionLog.recordId, "string");
      sessionLogRecordId = String(sessionLog.recordId);

      // 6. Verified read tools via child-process VerifiedReadAdapter
      const fullNote = parseToolJson(await client.callTool({
        name: "memory_get",
        arguments: { id: insightRecordId },
      }));
      assert.equal(fullNote.id, insightRecordId);
      assert.equal(
        (fullNote.content as { body?: string } | undefined)?.body,
        "# Verified Read Isolation\n\nAll reads execute against immutable Projection Schema 3 generations.",
      );

      const searched = parseToolJson(await client.callTool({
        name: "memory_search",
        arguments: { query: "VerifiedReadAdapter" },
      }));
      assert.ok(Array.isArray(searched.items));
      assert.ok((searched.items as Array<{ id?: string }>).some((item) => item.id === insightRecordId));

      const listedRecords = parseToolJson(await client.callTool({
        name: "memory_list",
        arguments: { limit: 10 },
      }));
      assert.ok(Array.isArray(listedRecords.items));
      assert.ok((listedRecords.items as Array<{ id?: string }>).length >= 4);

      const recentRecords = parseToolJson(await client.callTool({
        name: "memory_recent",
        arguments: { limit: 10 },
      }));
      assert.ok(Array.isArray(recentRecords.items));
      assert.ok((recentRecords.items as Array<{ id?: string }>).length >= 4);

      const contextPack = parseToolJson(await client.callTool({
        name: "memory_contextPack",
        arguments: { area: "Projection Schema" },
      }));
      assert.equal(typeof contextPack.generation, "number");

      const radar = parseToolJson(await client.callTool({
        name: "memory_followUpRadar",
        arguments: { limit: 10 },
      }));
      assert.ok(Array.isArray(radar.items));

      const awakened = parseToolJson(await client.callTool({
        name: "memory_awaken",
        arguments: { area: "Projection Schema" },
      }));
      assert.equal(awakened.sessionId, sessionId);
      assert.ok(awakened.contextPack);

      // 7. Verification & governance inspection tools
      const verifyVault = parseToolJson(await client.callTool({
        name: "memory_verifyVault",
        arguments: {},
      }));
      assert.equal(verifyVault.ok, true);

      const verifyNote = parseToolJson(await client.callTool({
        name: "memory_verifyNote",
        arguments: { id: insightRecordId },
      }));
      assert.equal(verifyNote.ok, true);
      assert.equal(verifyNote.recordId, insightRecordId);

      const verifySourceTruth = parseToolJson(await client.callTool({
        name: "memory_verifySourceTruth",
        arguments: {},
      }));
      assert.equal(verifySourceTruth.ok, true);

      const duplicates = parseToolJson(await client.callTool({
        name: "memory_findDuplicates",
        arguments: {},
      }));
      assert.ok(Array.isArray(duplicates.duplicateGroups));

      const staleness = parseToolJson(await client.callTool({
        name: "memory_checkStaleness",
        arguments: {},
      }));
      assert.ok(Array.isArray(staleness.staleItems));

      // 8. V2-native governance lifecycle tools (promote, supersede, retract, expire)
      const promoted = parseToolJson(await client.callTool({
        name: "memory_promote",
        arguments: {
          recordId: insightRecordId,
          verificationMethod: "manual-review",
          reason: "Verified in integration test",
        },
      }));
      assert.equal(promoted.status, "active");

      const replacementInsight = parseToolJson(await client.callTool({
        name: "memory_writeInsight",
        arguments: {
          title: "Updated verified read insight",
          summary: "Superseding verified read insight.",
          content: "# Updated Insight\n\nSupersedes previous insight.",
          confidence: "high",
        },
      }));
      const replacementId = String(replacementInsight.recordId);
      await client.callTool({
        name: "memory_promote",
        arguments: {
          recordId: replacementId,
          verificationMethod: "manual-review",
          reason: "Promote replacement before supersede",
        },
      });

      const superseded = parseToolJson(await client.callTool({
        name: "memory_supersede",
        arguments: {
          recordId: insightRecordId,
          supersedingRecordId: replacementId,
          reason: "Replaced by updated insight",
        },
      }));
      assert.equal(superseded.status, "superseded");

      const retracted = parseToolJson(await client.callTool({
        name: "memory_retract",
        arguments: {
          recordId: mistakeRecordId,
          reason: "Retracting test mistake record",
        },
      }));
      assert.equal(retracted.status, "retracted");

      const expired = parseToolJson(await client.callTool({
        name: "memory_expire",
        arguments: {
          recordId: sessionLogRecordId,
          validTo: new Date(Date.now() + 60_000).toISOString(),
          reason: "Expiring test session log",
        },
      }));
      assert.equal(expired.status, "expired");

      // 9. V2-native evidence & cryptographic forgetting tools
      const evidenceBatch = parseToolJson(await client.callTool({
        name: "memory_recordEvidenceBatch",
        arguments: {
          sessionId,
          content: "Sensitive token fixture_secret_123 in conversation evidence",
        },
      }));
      assert.equal(typeof evidenceBatch.conversationId, "string");

      const forgotten = parseToolJson(await client.callTool({
        name: "memory_forgetEvidence",
        arguments: {
          purpose: "data-key-wrap",
          reason: "Cryptographically erase previous wrap key version",
        },
      }));
      assert.equal(forgotten.forgotten, true);

      // 10. V2-native child session & lifecycle tools
      const checkpointed = parseToolJson(await client.callTool({
        name: "memory_checkpoint",
        arguments: {
          sessionId,
          taskSummary: "Checkpointing before child fork and session-end workflow",
        },
      }));
      assert.equal(typeof checkpointed.checkpointId, "string");

      // Session end -> amend -> cancel while root session is clean, then child workflow + recovery + final sessionEnd
      const sessionEndRequested = parseToolJson(await client.callTool({
        name: "memory_sessionEnd",
        arguments: {
          sessionId,
          summary: "Requesting session end for V2 MCP test",
        },
      }));
      assert.equal(sessionEndRequested.sessionId, sessionId);
      assert.equal(typeof sessionEndRequested.workflowId, "string");

      const sessionEndAmended = parseToolJson(await client.callTool({
        name: "memory_amendSessionEnd",
        arguments: {
          sessionId,
          workflowId: String(sessionEndRequested.workflowId),
          summary: "Amended final checkpoint summary",
        },
      }));
      assert.equal(sessionEndAmended.sessionId, sessionId);

      const sessionEndCancelled = parseToolJson(await client.callTool({
        name: "memory_cancelSessionEnd",
        arguments: {
          sessionId,
          workflowId: String(sessionEndRequested.workflowId),
        },
      }));
      assert.equal(sessionEndCancelled.phase, "cancelled");

      const forked = parseToolJson(await client.callTool({
        name: "memory_sessionFork",
        arguments: {
          parentSessionId: sessionId,
          summary: "Verify subagent child lifecycle",
          scope: "v2-public-mcp-tools",
        },
      }));
      assert.equal(typeof forked.childSessionId, "string");
      const childSessionId = String(forked.childSessionId);

      const childReport = parseToolJson(await client.callTool({
        name: "memory_recordChildResult",
        arguments: {
          parentSessionId: sessionId,
          childSessionId,
          outcomeSummary: "Child verified subagent flow",
          findings: ["Child report recorded and accepted"],
        },
      }));
      assert.equal(typeof childReport.reportId, "string");

      const childCompleted = parseToolJson(await client.callTool({
        name: "memory_completeChildSession",
        arguments: {
          parentSessionId: sessionId,
          childSessionId,
          reportId: String(childReport.reportId),
        },
      }));
      assert.equal(childCompleted.state, "completed");

      const recovered = parseToolJson(await client.callTool({
        name: "memory_recoverSession",
        arguments: {
          sessionId,
          reasonCode: "explicit-user-approval",
        },
      }));
      assert.equal(recovered.sessionId, sessionId);

      const finalSessionEnd = parseToolJson(await client.callTool({
        name: "memory_sessionEnd",
        arguments: {
          sessionId,
          summary: "Final session end after child completion and recovery",
        },
      }));
      assert.equal(finalSessionEnd.sessionId, sessionId);
      assert.equal(finalSessionEnd.phase, "requested");
    });

    // 11. Restart MCP server and verify state persistence & child-process verified reads
    await withMcpClient(fixture, async (client) => {
      const adrNote = parseToolJson(await client.callTool({
        name: "memory_get",
        arguments: { id: adrRecordId },
      }));
      assert.equal(adrNote.id, adrRecordId);
      assert.equal(
        (adrNote.content as { body?: string } | undefined)?.body,
        "# Context\n\nV2 requires explicit V1 parity classification.\n\n# Decision\n\nExpose 34 public tools.",
      );

      const verifyAfterRestart = parseToolJson(await client.callTool({
        name: "memory_verifyVault",
        arguments: {},
      }));
      assert.equal(verifyAfterRestart.ok, true);
    });
  } finally {
    fixture.cleanup();
  }
});

test("read-only-recovery mode, coordinator V3 reconciliation journal, and governed note provenance/body evidence work end-to-end", async () => {
  const fixture = await createStoreFixture({ productionProfile: true, promoteMode: "active" });
  try {
    const foundation = await createV2Foundation(fixture.config, { entryUrl: V2_DIST_ENTRY_URL });
    try {
      const started = (await foundation.content.invoke("memory_sessionStart", {
        agentName: "recovery-test-agent",
      })) as { sessionId: string };
      const sessionId = started.sessionId;

      // 1. Explicit provenance is honored (and invalid explicit provenance fails closed)
      const explicitBatch = (await foundation.content.invoke("memory_recordEvidenceBatch", {
        sessionId,
        content: "Explicit evidence frame backing ADR note",
      })) as { evidenceIds: string[] };
      const explicitEvidenceId = explicitBatch.evidenceIds[0]!;

      const noteWithExplicitProvenance = (await foundation.content.invoke("memory_writeADR", {
        sessionId,
        title: "ADR with Explicit Provenance",
        summary: "Caller-supplied provenance must not be overwritten.",
        content: "# Explicit Provenance\n\nBody text.",
        provenance: [{ kind: "retained-evidence", identity: explicitEvidenceId }],
      })) as { recordId: string; evidenceId: string };
      assert.equal(noteWithExplicitProvenance.evidenceId, explicitEvidenceId);

      // 2. Coordinator V3 publication creates projection-reconciliation-v2.json in projections/
      const projectionDir = join(fixture.v2VaultRoot, ".memory-mcp", "v2", "projections");
      assert.equal(existsSync(join(projectionDir, "projection-reconciliation-v2.json")), true);

      await assert.rejects(
        () =>
          foundation.content.invoke("memory_writeInsight", {
            sessionId,
            title: "Invalid Explicit Provenance",
            summary: "Should fail because retained-evidence identity does not exist.",
            content: "# Invalid\n\nBody.",
            provenance: [{ kind: "retained-evidence", identity: randomUUID() }],
          }),
      );

      // 3. Auto-retained evidence when provenance is omitted includes the note body
      const autoNote = (await foundation.content.invoke("memory_writeInsight", {
        sessionId,
        title: "Auto Evidence Body Coverage",
        summary: "Auto-retained evidence covers body claims.",
        content: "# Body Coverage\n\nDistinctive body marker: body_evidence_marker_98765",
      })) as { recordId: string; evidenceId: string };
      assert.notEqual(autoNote.evidenceId, explicitEvidenceId);

      // 4. Transition store into read-only-recovery mode at the current committed event tail
      const identity = {
        projectId: fixture.release.projectId,
        vaultId: fixture.release.vaultId,
        storeId: fixture.release.storeId,
      };
      const driver = new NodeSqliteDriver({ DatabaseSync });
      const controlConn = driver.open(fixture.eventsPath, { mode: "existing", busyTimeoutMs: 5000 });
      try {
        const repo = new SqliteFreshStartRepository(controlConn);
        repo.transact(identity, (tx) => {
          const current = tx.state()!;
          const fence = tx.captureRecoveryFence(current.generation);
          tx.transition({
            transitionId: randomUUID(),
            expectedMode: "active",
            expectedGeneration: current.generation,
            expectedReleaseId: current.releaseId,
            nextMode: "read-only-recovery",
            nextReleaseId: current.releaseId,
            authorization: {
              kind: "automatic-stop",
              reasonCode: "integrity-failure",
            },
            evidenceDigest: sha("recovery-stop-test"),
            recoveryPosition: fence.eventPosition,
            recoveryHash: fence.eventHash,
            recordedAt: "2026-07-01T00:05:00.000Z",
          });
        });
      } finally {
        controlConn.close();
      }

      const recoveryStatus = await foundation.status();
      assert.equal(recoveryStatus.mode, "read-only-recovery");
      assert.equal(recoveryStatus.productionReady, false);

      // Mutating tools fail closed with FRESH_START_ADMISSION_DENIED in read-only-recovery
      for (const writeTool of [
        "memory_sessionStart",
        "memory_writeInsight",
        "memory_promote",
        "memory_recordEvidenceBatch",
        "memory_checkpoint",
      ]) {
        await assert.rejects(
          () => foundation.content.invoke(writeTool, {}),
          { code: "FRESH_START_ADMISSION_DENIED" },
          `Expected ${writeTool} to be denied in read-only-recovery mode`,
        );
      }

      // All read-only & verification tools succeed in read-only-recovery mode
      const gotNote = (await foundation.content.invoke("memory_get", {
        id: autoNote.recordId,
      })) as { ok: boolean; id: string; content: { body: string } };
      assert.equal(gotNote.ok, true);
      assert.equal(gotNote.id, autoNote.recordId);
      assert.ok(gotNote.content.body.includes("body_evidence_marker_98765"));

      const searched = (await foundation.content.invoke("memory_search", {
        query: "Auto Evidence Body Coverage",
      })) as { ok: boolean; items: Array<{ id: string }> };
      assert.equal(searched.ok, true);
      assert.ok(searched.items.some((item) => item.id === autoNote.recordId));

      const listed = (await foundation.content.invoke("memory_list", { limit: 10 })) as {
        ok: boolean;
        items: Array<{ id: string }>;
      };
      assert.equal(listed.ok, true);
      assert.ok(listed.items.length >= 2);

      const recent = (await foundation.content.invoke("memory_recent", { limit: 10 })) as {
        ok: boolean;
        items: Array<{ id: string }>;
      };
      assert.equal(recent.ok, true);
      assert.ok(recent.items.length >= 2);

      const contextPack = (await foundation.content.invoke("memory_contextPack", {
        area: "Provenance",
      })) as { ok: boolean };
      assert.equal(contextPack.ok, true);

      const radar = (await foundation.content.invoke("memory_followUpRadar", {
        limit: 5,
      })) as { ok: boolean };
      assert.equal(radar.ok, true);

      const awakened = (await foundation.content.invoke("memory_awaken", {
        area: "Provenance",
      })) as { ok: boolean; mode: string };
      assert.equal(awakened.ok, true);
      assert.equal(awakened.mode, "read-only-recovery");

      const lifecycleStatus = (await foundation.content.invoke("memory_lifecycleStatus", {})) as {
        ok: boolean;
        mode: string;
      };
      assert.equal(lifecycleStatus.ok, true);
      assert.equal(lifecycleStatus.mode, "read-only-recovery");

      const selfCheck = (await foundation.content.invoke("memory_selfCheck", {
        taskSummary: "Read-only recovery inspection",
      })) as { ok: boolean; mode: string };
      assert.equal(selfCheck.ok, true);
      assert.equal(selfCheck.mode, "read-only-recovery");

      const verifyVault = (await foundation.content.invoke("memory_verifyVault", {})) as {
        ok: boolean;
      };
      assert.equal(verifyVault.ok, true);

      const verifyNote = (await foundation.content.invoke("memory_verifyNote", {
        id: autoNote.recordId,
      })) as { ok: boolean; verified: boolean };
      assert.equal(verifyNote.ok, true);
      assert.equal(verifyNote.verified, true);

      const verifySourceTruth = (await foundation.content.invoke("memory_verifySourceTruth", {})) as {
        ok: boolean;
      };
      assert.equal(verifySourceTruth.ok, true);

      const duplicates = (await foundation.content.invoke("memory_findDuplicates", {})) as {
        ok: boolean;
      };
      assert.equal(duplicates.ok, true);

      const staleness = (await foundation.content.invoke("memory_checkStaleness", {})) as {
        ok: boolean;
      };
      assert.equal(staleness.ok, true);

      // 5. If recovery_hash mismatches the committed event tail, read tools fail closed with FRESH_START_RECOVERY_REQUIRED
      const mismatchConn = driver.open(fixture.eventsPath, { mode: "existing", busyTimeoutMs: 5000 });
      try {
        const repo = new SqliteFreshStartRepository(mismatchConn);
        repo.transact(identity, (tx) => {
          const current = tx.state()!;
          tx.transition({
            transitionId: randomUUID(),
            expectedMode: "read-only-recovery",
            expectedGeneration: current.generation,
            expectedReleaseId: current.releaseId,
            nextMode: "read-only-recovery",
            nextReleaseId: current.releaseId,
            authorization: {
              kind: "automatic-stop",
              reasonCode: "integrity-failure",
            },
            evidenceDigest: sha("recovery-mismatch-test"),
            recoveryPosition: current.recoveryPosition,
            recoveryHash: "f".repeat(64),
            recordedAt: "2026-07-01T00:06:00.000Z",
          });
        });
      } finally {
        mismatchConn.close();
      }

      await assert.rejects(
        () => foundation.content.invoke("memory_search", { query: "Provenance" }),
        { code: "FRESH_START_RECOVERY_REQUIRED" },
      );

      // 6. Recover store back to active mode at a new generation and verify writes succeed again
      const recoverConn = driver.open(fixture.eventsPath, { mode: "existing", busyTimeoutMs: 5000 });
      try {
        const repo = new SqliteFreshStartRepository(recoverConn);
        repo.transact(identity, (tx) => {
          const current = tx.state()!;
          tx.transition({
            transitionId: randomUUID(),
            expectedMode: "read-only-recovery",
            expectedGeneration: current.generation,
            expectedReleaseId: current.releaseId,
            nextMode: "active",
            nextReleaseId: current.releaseId,
            authorization: {
              kind: "operator",
              approvalId: randomUUID(),
              nonceDigest: sha(randomUUID()),
              actorFingerprint: sha("recovery-operator"),
              requestDigest: sha("recover-to-active"),
            },
            evidenceDigest: sha("recovered-to-active"),
            recoveryPosition: null,
            recoveryHash: null,
            recordedAt: "2026-07-01T00:07:00.000Z",
          });
        });
      } finally {
        recoverConn.close();
      }

      const activeAgainStatus = await foundation.status();
      assert.equal(activeAgainStatus.mode, "active");
      assert.equal(activeAgainStatus.productionReady, true);

      const postRecoveryNote = (await foundation.content.invoke("memory_writeInsight", {
        sessionId,
        title: "Post-Recovery Governed Note",
        summary: "Write succeeds on new active generation after read-only-recovery.",
        content: "# Post-Recovery\n\nSuccessfully written on new generation.",
      })) as { ok: boolean; recordId: string };
      assert.equal(postRecoveryNote.ok, true);
    } finally {
      await foundation.close();
    }
  } finally {
    fixture.cleanup();
  }
});
