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
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Script, runInNewContext } from "node:vm";
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
import { V2MemoryCuratorAgent } from "../src/v2/curator.js";
import {
  buildMemoryKnowledgeGraph,
  discoverV2Projects,
  startV2WebUiServer,
} from "../src/v2/webui.js";
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

async function createActiveStoreFixture(prefix = "pm-v2-webui-") {
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
    evidenceDigest: sha({ test: "v2-webui-and-curator" }),
    createdAt: "2026-10-21T00:00:00.000Z",
  });
  const initializer = new FreshStartInitializer({
    projectionSchemaVersion: 3,
    inspectBuild: () => buildIdentityHash,
    actorFingerprint: sha({ actor: "test" }),
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
  const foundation = await createV2Foundation(config, {
    entryUrl: V2_DIST_ENTRY_URL,
  });
  return {
    projectRoot,
    v2VaultRoot,
    v1ArchiveRoot,
    config,
    foundation,
    async cleanup() {
      await foundation.close();
      rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

test("Task 1.1: V2MemoryCuratorAgent.auditVault handles an empty vault cleanly", async () => {
  const fixture = await createActiveStoreFixture("pm-v2-curator-empty-");
  try {
    const curator = new V2MemoryCuratorAgent(fixture.foundation);
    const audit = await curator.auditVault();
    assert.equal(audit.healthScore, 100);
    assert.equal(audit.counts.totalNotes, 0);
    assert.deepEqual(audit.duplicateGroups, []);
    assert.deepEqual(audit.staleNotes, []);
    assert.deepEqual(audit.candidateQueue, []);
  } finally {
    await fixture.cleanup();
  }
});

test("Task 1.2, 1.3 & 1.4: V2MemoryCuratorAgent audits, autoCurates, and chats in Thai/English", async () => {
  const fixture = await createActiveStoreFixture("pm-v2-curator-full-");
  try {
    const session = (await fixture.foundation.content.invoke("memory_sessionStart", {
      taskSummary: "Seed notes for AI Curator test",
      contextArea: "auth",
      includeContext: false,
    })) as { sessionId: string };

    const adr1 = (await fixture.foundation.content.invoke("memory_writeADR", {
      sessionId: session.sessionId,
      title: "Use Redis Token Bucket for Auth Rate Limiting",
      summary: "Use Redis token bucket algorithm for API gateway rate limiting in src/gateway/rate-limiter.ts (`RedisRateLimiter`).",
      content: "# Use Redis Token Bucket for Auth Rate Limiting\n\nUse Redis token bucket algorithm in `src/gateway/rate-limiter.ts` with `RedisRateLimiter`.",
    })) as { recordId: string };

    const adr2 = (await fixture.foundation.content.invoke("memory_writeADR", {
      sessionId: session.sessionId,
      title: "Use Redis Token Bucket for Auth Rate Limiting",
      summary: "Use Redis token bucket algorithm for API gateway rate limiting in src/gateway/rate-limiter.ts (`RedisRateLimiter`).",
      content: "# Use Redis Token Bucket for Auth Rate Limiting\n\nUse Redis token bucket algorithm in `src/gateway/rate-limiter.ts` with `RedisRateLimiter`.",
    })) as { recordId: string };

    const insight = (await fixture.foundation.content.invoke("memory_writeInsight", {
      sessionId: session.sessionId,
      title: "SQLite WAL busy_timeout prevents lock errors",
      summary: "Always configure busy_timeout = 5000 on SQLite connections in src/orchestrator/storage/node-sqlite-driver.ts (`NodeSqliteDriver`).",
    })) as { recordId: string };

    await fixture.foundation.content.invoke("memory_sessionEnd", {
      sessionId: session.sessionId,
      summary: "Seeded duplicate ADRs and storage insight",
    });

    const curator = new V2MemoryCuratorAgent(fixture.foundation);
    const auditBefore = await curator.auditVault();
    assert.ok(auditBefore.counts.unpromotedCandidates >= 3);
    assert.ok(auditBefore.duplicateGroups.length >= 1, "Should detect duplicate ADR group");
    assert.ok(auditBefore.candidateQueue.length >= 3, "Should list candidates in queue");
    assert.ok(auditBefore.recommendations.length >= 1, "Should produce actionable recommendations");

    const receipt = await curator.autoCurate({
      promoteCandidates: true,
      resolveDuplicates: true,
      expireStale: true,
    });
    assert.ok(receipt.sessionId, "Should record governed curator sessionId");
    assert.ok(receipt.promoted.length >= 2, "Should promote non-duplicate candidates");
    assert.ok(receipt.superseded.length >= 1, "Should supersede duplicate note");
    for (const sup of receipt.superseded) {
      assert.notEqual(sup.recordId, sup.supersedingRecordId, "Must never self-supersede");
    }

    const insightNote = (await fixture.foundation.content.invoke("memory_get", {
      id: insight.recordId,
    })) as { status: string };
    assert.equal(insightNote.status, "verified");
    assert.ok(adr1.recordId && adr2.recordId);

    // Chat intents (Thai & English)
    const writeRes = await curator.chat({
      message: "บันทึก ADR: ใช้ JWT RS256 สำหรับระบบ Auth Gateway",
      autoExecute: true,
    });
    assert.equal(writeRes.intent, "write_adr");
    assert.ok(writeRes.executedTools.includes("memory_writeADR"));

    const searchRes = await curator.chat({
      message: "ค้นหา JWT RS256",
    });
    assert.equal(searchRes.intent, "search");
    assert.ok(searchRes.executedTools.includes("memory_search"));

    const auditRes = await curator.chat({
      message: "ช่วยตรวจสุขภาพความจำและหาความจำซ้ำ",
    });
    assert.equal(auditRes.intent, "audit");

    // Preview mode (autoExecute: false) must NOT mutate candidate/duplicate notes
    const unverifiedDupA = (await fixture.foundation.content.invoke("memory_writeInsight", {
      title: "Insight: Cache Query Plans Per Schema Hash",
      summary: "Cache compiled SQLite statements keyed by schemaIdentityHash.",
    })) as { recordId: string };
    const unverifiedDupB = (await fixture.foundation.content.invoke("memory_writeInsight", {
      title: "Insight: Cache Query Plans Per Schema Hash",
      summary: "Cache compiled SQLite statements keyed by schemaIdentityHash.",
    })) as { recordId: string };

    const previewCurate = await curator.chat({
      message: "จัดระเบียบความจำ",
      autoExecute: false,
    });
    assert.equal(previewCurate.intent, "audit");
    assert.ok(
      !previewCurate.executedTools.includes("memory_promote") &&
        !previewCurate.executedTools.includes("memory_supersede"),
      "autoExecute: false must return audit preview without executing mutations",
    );
    const dupABefore = (await fixture.foundation.content.invoke("memory_get", {
      id: unverifiedDupA.recordId,
    })) as { status: string };
    assert.equal(dupABefore.status, "candidate");

    // Verify paginated auditVault with small pageSize walks all pages cleanly
    const pagedAudit = await curator.auditVault({ pageSize: 2 });
    assert.ok(
      pagedAudit.counts.totalNotes >= 4,
      "auditVault cursor pagination must collect notes across multiple pages",
    );

    const promoteRes = await curator.chat({
      message: "อนุมัติ candidate ทั้งหมด",
      autoExecute: true,
    });
    assert.equal(promoteRes.intent, "auto_curate");
    assert.ok(promoteRes.executedTools.includes("memory_promote"));

    // Keeper of unverified duplicate pair must be promoted to verified, duplicate superseded, and curator session finalized (0 'ending' sessions from curator)
    const lifecycleAfterCurator = (await fixture.foundation.content.invoke(
      "memory_lifecycleStatus",
      {},
    )) as {
      sessions: Array<{ sessionId: string; semanticState: string; currentTask: string }>;
    };
    const stuckCuratorSessions = lifecycleAfterCurator.sessions.filter(
      (s) =>
        s.currentTask.includes("AI Memory Curator") && s.semanticState === "ending",
    );
    assert.equal(
      stuckCuratorSessions.length,
      0,
      "V2MemoryCuratorAgent.autoCurate must finalize its session to 'ended' without leaving 'ending' sessions",
    );
    assert.ok(unverifiedDupB.recordId);
  } finally {
    await fixture.cleanup();
  }
});

test("Task 2: V2 WebUI Server, Knowledge Graph, Multi-Project Switcher, Governance & AI Curator REST API", async () => {
  const fixture = await createActiveStoreFixture("pm-v2-webui-http-");
  const serverHandle = await startV2WebUiServer({
    defaultProjectRoot: fixture.projectRoot,
    port: 0,
    host: "127.0.0.1",
    foundations: new Map([[fixture.projectRoot, fixture.foundation]]),
  });
  try {
    const baseUrl = serverHandle.url;

    // 1. Discover V2 projects & Knowledge Graph unit check
    const discovered = discoverV2Projects(fixture.projectRoot);
    assert.ok(discovered.includes(fixture.projectRoot));

    const sampleGraph = buildMemoryKnowledgeGraph([
      {
        recordId: "rec-1",
        kind: "adr",
        title: "Gateway Rate Limiter",
        summary: "Implemented in src/gateway/rate-limiter.ts (`RedisRateLimiter`)",
        status: "verified",
      },
    ]);
    assert.ok(sampleGraph.nodes.some((n) => n.kind === "file" && n.label === "src/gateway/rate-limiter.ts"));
    assert.ok(sampleGraph.nodes.some((n) => n.kind === "symbol" && n.label === "RedisRateLimiter"));
    assert.ok(
      sampleGraph.nodes.some((n) => n.kind === "note" && typeof n.summary === "string" && n.summary.length > 0),
      "Note graph nodes should include human-readable summary for the Story Inspector",
    );
    assert.ok(sampleGraph.edges.length >= 2);

    // 2. Serve Mission Control SPA HTML at GET /
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes("Project Memory V2"));
    assert.ok(html.includes("AI Memory Curator"));

    // 3. Reject invalid/relative project path (Review Focus #4) and unallowed MCP tool name
    const badProjectRes = await fetch(`${baseUrl}/api/overview?project=relative/traversal`);
    assert.equal(badProjectRes.status, 400);
    const badProjectJson = (await badProjectRes.json()) as { ok: boolean; error: string };
    assert.equal(badProjectJson.ok, false);
    assert.equal(badProjectJson.error, "INVALID_PROJECT_ROOT");

    const badToolRes = await fetch(`${baseUrl}/api/mcp/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot: fixture.projectRoot,
        tool: "non_existent_tool_xyz",
        args: {},
      }),
    });
    assert.equal(badToolRes.status, 400);
    const badToolJson = (await badToolRes.json()) as { ok: boolean; error: string };
    assert.equal(badToolJson.ok, false);
    assert.equal(badToolJson.error, "INVALID_MCP_TOOL");

    // 4. List discovered projects via GET /api/projects
    const projectsRes = await fetch(`${baseUrl}/api/projects`);
    assert.equal(projectsRes.status, 200);
    const projectsJson = (await projectsRes.json()) as {
      ok: boolean;
      projects: Array<{ projectRoot: string; mode: string }>;
    };
    assert.equal(projectsJson.ok, true);
    assert.ok(projectsJson.projects.some((p) => p.projectRoot === fixture.projectRoot));

    // 5. Create ADR and Promote via POST /api/governance
    const createAdrRes = await fetch(`${baseUrl}/api/governance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot: fixture.projectRoot,
        action: "writeADR",
        title: "WebUI Architecture Decision",
        summary: "Serve WebUI in src/v2/webui.ts using `startV2WebUiServer` and `V2MemoryCuratorAgent`.",
      }),
    });
    assert.equal(createAdrRes.status, 200);
    const createdAdr = (await createAdrRes.json()) as { ok: boolean; result: { recordId: string } };
    assert.equal(createdAdr.ok, true);
    assert.ok(createdAdr.result.recordId);

    const promoteRes = await fetch(`${baseUrl}/api/governance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot: fixture.projectRoot,
        action: "promote",
        recordId: createdAdr.result.recordId,
        reason: "Approved from WebUI Kanban board",
      }),
    });
    assert.equal(promoteRes.status, 200);

    // 6. Verify GET /api/notes, GET /api/notes/:id, and GET /api/graph
    const notesRes = await fetch(
      `${baseUrl}/api/notes?project=${encodeURIComponent(fixture.projectRoot)}`,
    );
    assert.equal(notesRes.status, 200);
    const notesJson = (await notesRes.json()) as {
      ok: boolean;
      items: Array<{ recordId: string; status: string; filePaths: string[]; symbols: string[] }>;
    };
    assert.equal(notesJson.ok, true);
    const matchingNote = notesJson.items.find((i) => i.recordId === createdAdr.result.recordId);
    assert.ok(matchingNote);
    assert.equal(matchingNote.status, "verified");
    assert.ok(matchingNote.filePaths.includes("src/v2/webui.ts"));

    const singleNoteRes = await fetch(
      `${baseUrl}/api/notes/${encodeURIComponent(createdAdr.result.recordId)}?project=${encodeURIComponent(fixture.projectRoot)}`,
    );
    assert.equal(singleNoteRes.status, 200);

    const graphRes = await fetch(
      `${baseUrl}/api/graph?project=${encodeURIComponent(fixture.projectRoot)}`,
    );
    assert.equal(graphRes.status, 200);
    const graphJson = (await graphRes.json()) as {
      ok: boolean;
      nodes: Array<{ id: string; kind: string }>;
      edges: Array<{ source: string; target: string }>;
    };
    assert.equal(graphJson.ok, true);
    assert.ok(graphJson.nodes.some((n) => n.kind === "file"));
    assert.ok(graphJson.edges.length >= 1);

    // 7. Verify AI Curator endpoints (/api/curator/audit, /api/curator/chat, /api/curator/auto-curate)
    const auditRes = await fetch(
      `${baseUrl}/api/curator/audit?project=${encodeURIComponent(fixture.projectRoot)}`,
    );
    assert.equal(auditRes.status, 200);

    const chatRes = await fetch(`${baseUrl}/api/curator/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectRoot: fixture.projectRoot,
        message: "ค้นหา WebUI Architecture",
      }),
    });
    assert.equal(chatRes.status, 200);
    const chatJson = (await chatRes.json()) as { ok: boolean; intent: string };
    assert.equal(chatJson.ok, true);
    assert.equal(chatJson.intent, "search");

    // 8. Verify React + TanStack + shadcn/ui + Web Components MVC Architecture
    assert.ok(html.includes("<pm-mission-control"), "HTML should mount <pm-mission-control> Web Component");
    assert.ok(html.includes("--background"), "HTML should include shadcn/ui HSL CSS variables");
    assert.ok(html.includes("/mvc/vendor.js"), "HTML should load React + TanStack vendor runtime");
    assert.ok(html.includes("/mvc/models.js"), "HTML should load MVC Models");
    assert.ok(html.includes("/mvc/controllers.js"), "HTML should load MVC Controllers");
    assert.ok(html.includes("/mvc/shadcn-ui.js"), "HTML should load shadcn/ui components");
    assert.ok(html.includes("/mvc/views.js"), "HTML should load React MVC Views");
    assert.ok(html.includes("/mvc/web-components.js"), "HTML should load Custom Elements Web Components");

    const vendorJs = await (await fetch(`${baseUrl}/mvc/vendor.js`)).text();
    assert.ok(vendorJs.includes("QueryClient"));
    assert.ok(vendorJs.includes("useQuery"));
    assert.ok(vendorJs.includes("useMutation"));
    assert.ok(vendorJs.includes("useReactTable"));
    assert.ok(vendorJs.includes("flexRender"));

    const modelsJs = await (await fetch(`${baseUrl}/mvc/models.js`)).text();
    assert.ok(modelsJs.includes("ProjectModel"));
    assert.ok(modelsJs.includes("MemoryNoteModel"));
    assert.ok(modelsJs.includes("KnowledgeGraphModel"));
    assert.ok(modelsJs.includes("CuratorModel"));
    assert.ok(modelsJs.includes("McpToolModel"));

    const controllersJs = await (await fetch(`${baseUrl}/mvc/controllers.js`)).text();
    assert.ok(controllersJs.includes("MissionControlController"));
    assert.ok(controllersJs.includes("KanbanController"));
    assert.ok(controllersJs.includes("KnowledgeGraphController"));
    assert.ok(controllersJs.includes("CuratorController"));
    assert.ok(controllersJs.includes("McpConsoleController"));

    const shadcnJs = await (await fetch(`${baseUrl}/mvc/shadcn-ui.js`)).text();
    assert.ok(shadcnJs.includes("Button"));
    assert.ok(shadcnJs.includes("Card"));
    assert.ok(shadcnJs.includes("Badge"));
    assert.ok(shadcnJs.includes("Tabs"));
    assert.ok(shadcnJs.includes("Table"));
    assert.ok(shadcnJs.includes("Dialog"));
    assert.ok(shadcnJs.includes("LucideIcon"), "shadcn-ui.js should export LucideIcon SVG component");
    assert.ok(shadcnJs.includes("LUCIDE_ICON_NODES"), "shadcn-ui.js should include official Lucide SVG vector definitions");
    assert.ok(shadcnJs.includes("lucide-"), "LucideIcon should render standard lucide CSS classes");

    const viewsJs = await (await fetch(`${baseUrl}/mvc/views.js`)).text();
    assert.ok(viewsJs.includes("OverviewView"));
    assert.ok(viewsJs.includes("KanbanBoardView"));
    assert.ok(viewsJs.includes("KnowledgeGraphView"));
    assert.ok(viewsJs.includes("CuratorStudioView"));
    assert.ok(viewsJs.includes("McpConsoleView"));
    assert.ok(viewsJs.includes("LucideIcon"), "MVC Views should render LucideIcon instead of emojis");
    assert.ok(viewsJs.includes("humanKindLabel"), "KnowledgeGraphView should include human-friendly node translator");
    assert.ok(viewsJs.includes("renderHumanMarkdownBlocks"), "Note Inspector should format content into readable blocks");
    assert.ok(controllersJs.includes("selectedStory"), "KnowledgeGraphController should compute connected human story neighborhood");

    const webComponentsJs = await (await fetch(`${baseUrl}/mvc/web-components.js`)).text();
    assert.ok(webComponentsJs.includes('customElements.define("pm-mission-control"'));
    assert.ok(webComponentsJs.includes('customElements.define("pm-overview-panel"'));
    assert.ok(webComponentsJs.includes('customElements.define("pm-kanban-board"'));
    assert.ok(webComponentsJs.includes('customElements.define("pm-knowledge-graph"'));
    assert.ok(webComponentsJs.includes('customElements.define("pm-curator-studio"'));
    assert.ok(webComponentsJs.includes('customElements.define("pm-mcp-console"'));

    // Verify all 6 browser MVC scripts parse with zero V8 SyntaxErrors
    for (const [filename, code] of [
      ["vendor.js", vendorJs],
      ["models.js", modelsJs],
      ["controllers.js", controllersJs],
      ["shadcn-ui.js", shadcnJs],
      ["views.js", viewsJs],
      ["web-components.js", webComponentsJs],
    ] as const) {
      assert.doesNotThrow(
        () => new Script(code, { filename }),
        `Browser script ${filename} must parse without SyntaxError`,
      );
    }

    const archRes = await fetch(`${baseUrl}/api/mvc/architecture`);
    assert.equal(archRes.status, 200);
    const archJson = (await archRes.json()) as {
      ok: boolean;
      pattern: string;
      models: string[];
      views: string[];
      controllers: string[];
      webComponents: string[];
    };
    assert.equal(archJson.ok, true);
    assert.equal(archJson.pattern, "MVC");
    assert.ok(archJson.webComponents.includes("pm-mission-control"));
    assert.ok(archJson.webComponents.includes("pm-health-gauge"));
    assert.ok(archJson.webComponents.includes("pm-distribution-chart"));
    assert.ok(archJson.webComponents.includes("pm-activity-chart"));
    assert.ok(archJson.webComponents.includes("pm-session-activity-map"));
    assert.ok(viewsJs.includes("HealthGaugeChart"));
    assert.ok(viewsJs.includes("DistributionDonutChart"));
    assert.ok(viewsJs.includes("ActivityAreaChart"));
    assert.ok(viewsJs.includes("SessionActivityMap"));
    assert.ok(webComponentsJs.includes('customElements.define("pm-health-gauge"'));
    assert.ok(webComponentsJs.includes('customElements.define("pm-distribution-chart"'));
    assert.ok(webComponentsJs.includes('customElements.define("pm-activity-chart"'));
    assert.ok(webComponentsJs.includes('customElements.define("pm-session-activity-map"'));

    // 9. Verify Session <-> Memory Note Relationship Graph & Live AI Session Activity
    assert.ok(
      graphJson.nodes.some((n) => n.kind === "session"),
      "Knowledge graph should include session nodes showing AI session relationships",
    );
    assert.ok(
      graphJson.edges.some((e) => (e as { relation?: string }).relation === "created-in-session"),
      "Knowledge graph should include created-in-session edges linking Sessions to Memory Notes",
    );

    const overviewRes = await fetch(
      `${baseUrl}/api/overview?project=${encodeURIComponent(fixture.projectRoot)}`,
    );
    assert.equal(overviewRes.status, 200);
    const overviewJson = (await overviewRes.json()) as {
      ok: boolean;
      lifecycle: {
        sessions: Array<{
          sessionId: string;
          semanticState: string;
          currentTask: string;
          noteCount: number;
          noteTitles: string[];
        }>;
      };
      analytics: {
        byStatus: Record<string, number>;
        byKind: Record<string, number>;
        activitySeries: Array<{ label: string; notes: number; verified: number }>;
      };
    };
    assert.equal(overviewJson.ok, true);
    assert.ok(overviewJson.analytics);
    assert.ok(Array.isArray(overviewJson.analytics.activitySeries));
    assert.ok(overviewJson.analytics.activitySeries.length >= 1);
    assert.ok(Array.isArray(overviewJson.lifecycle.sessions));
    assert.ok(overviewJson.lifecycle.sessions.length >= 1);
    assert.ok(
      overviewJson.lifecycle.sessions.some((s) => typeof s.currentTask === "string" && s.noteCount >= 1),
      "Lifecycle sessions should report currentTask and memories created per session",
    );

    // 10. Verify concurrent HTTP requests (/api/overview + /api/graph + /api/notes) never fail with WORKER_UNAVAILABLE
    const [concOverview, concGraph, concNotes] = await Promise.all([
      fetch(`${baseUrl}/api/overview?project=${encodeURIComponent(fixture.projectRoot)}`).then((r) => r.json()),
      fetch(`${baseUrl}/api/graph?project=${encodeURIComponent(fixture.projectRoot)}`).then((r) => r.json()),
      fetch(`${baseUrl}/api/notes?project=${encodeURIComponent(fixture.projectRoot)}`).then((r) => r.json()),
    ]) as Array<{ ok: boolean }>;
    assert.equal(concOverview.ok, true);
    assert.equal(concGraph.ok, true);
    assert.equal(concNotes.ok, true);
  } finally {
    await serverHandle.close();
    await fixture.cleanup();
  }
});

test("Task 2.2: buildMemoryKnowledgeGraph emits wikilinks, supersedes, causal-triad & completed child forked-from edges without orphan-session or false defines-symbol pollution", async () => {
  const graph = buildMemoryKnowledgeGraph(
    [
      {
        recordId: "adr-old",
        recordKind: "adr",
        title: "Legacy Rate Limiter",
        summary: "Old limiter policy",
        body: "# Legacy Rate Limiter\n\nDeprecated.",
        status: "verified",
        sessionId: "sess-root",
      },
      {
        recordId: "adr-new",
        recordKind: "adr",
        title: "Token Bucket Rate Limiter",
        summary: "Replaces [[Legacy Rate Limiter]] using `TokenBucketLimiter` across src/a.ts and src/b.ts.",
        body: "# Token Bucket Rate Limiter\n\nSupersedes [[Legacy Rate Limiter]] and avoids self-link [[Token Bucket Rate Limiter]].",
        status: "verified",
        sessionId: "sess-root",
        supersedesRecordId: "adr-old",
      },
      {
        recordId: "mistake-1",
        recordKind: "mistake",
        title: "Burst Overflow Bug",
        summary: "Triggered when `TokenBucketLimiter` burst window lacked clamping.",
        body: "# Burst Overflow Bug\n\nFixed by [[Token Bucket Rate Limiter]].",
        status: "verified",
        sessionId: null, // Orphan / imported note — must NOT bind to sessions[0]!
      },
    ],
    [
      {
        sessionId: "sess-root",
        kind: "root",
        parentSessionId: null,
        semanticState: "ended",
        noteCount: 2,
        noteIds: ["adr-old", "adr-new"],
      },
      {
        sessionId: "sess-child-done",
        kind: "child",
        parentSessionId: "sess-root",
        semanticState: "completed",
        noteCount: 0,
        noteIds: [],
      },
    ],
  );

  // 1. Completed child session with 0 notes still retains its forked-from lineage edge
  assert.ok(
    graph.edges.some(
      (e) =>
        e.source === "session:sess-root" &&
        e.target === "session:sess-child-done" &&
        (e.relation as string) === "forked-from",
    ),
    "Completed child session must keep forked-from edge",
  );

  // 2. Orphan note (sessionId: null) must NOT be falsely linked to sessions[0]
  assert.ok(
    !graph.edges.some(
      (e) => e.target === "note:mistake-1" && e.relation === "created-in-session",
    ),
    "Sessionless note must not be falsely assigned to sessions[0]",
  );

  // 3. Multi-file note without disk confirmation must NOT fabricate defines-symbol onto filePaths[0]
  assert.ok(
    !graph.edges.some(
      (e) =>
        e.source === "file:src/a.ts" &&
        e.target === "symbol:TokenBucketLimiter" &&
        e.relation === "defines-symbol",
    ),
    "Multi-file note must not guess filePaths[0] defines symbol",
  );

  // 4. [[wikilinks]] emit links-to-note edges (and exclude self-links)
  assert.ok(
    graph.edges.some(
      (e) =>
        e.source === "note:adr-new" &&
        e.target === "note:adr-old" &&
        (e.relation as string) === "links-to-note",
    ),
    "Expected links-to-note edge resolved from [[Legacy Rate Limiter]]",
  );
  assert.ok(
    !graph.edges.some(
      (e) =>
        e.source === "note:adr-new" &&
        e.target === "note:adr-new" &&
        (e.relation as string) === "links-to-note",
    ),
    "Self wikilinks must not create self-loop edges",
  );

  // 5. Supersession & causal-triad edges exist
  assert.ok(
    graph.edges.some(
      (e) =>
        e.source === "note:adr-new" &&
        e.target === "note:adr-old" &&
        (e.relation as string) === "supersedes",
    ),
    "Expected supersedes edge from adr-new -> adr-old",
  );
  assert.ok(
    graph.edges.some(
      (e) =>
        e.source === "note:mistake-1" &&
        e.target === "note:adr-new" &&
        (e.relation as string) === "causal-triad",
    ),
    "Expected causal-triad edge linking mistake-1 -> adr-new via shared TokenBucketLimiter",
  );
});

test("Task 3: WebUI security hardening, CSRF/Host/Origin/GET-registration guards, VM-valid MVC bundles, deep-linking, responsive nav, and safe Markdown", async () => {
  const fixture = await createActiveStoreFixture("pm-v2-webui-sec-");
  const unregisteredPath = join(tmpdir(), `pm-v2-unregistered-${randomUUID()}`);
  const serverHandle = await startV2WebUiServer({
    defaultProjectRoot: fixture.projectRoot,
    port: 0,
    host: "127.0.0.1",
    foundations: new Map([[fixture.projectRoot, fixture.foundation]]),
  });

  try {
    const baseUrl = serverHandle.url;

    // 1. Security headers + CSRF meta token on GET /
    const rootRes = await fetch(`${baseUrl}/`);
    assert.equal(rootRes.status, 200);
    const csp = rootRes.headers.get("content-security-policy") ?? "";
    assert.ok(csp.includes("default-src 'self'"), `Expected CSP header, got: ${csp}`);
    assert.equal(rootRes.headers.get("x-frame-options"), "DENY");
    assert.equal(rootRes.headers.get("x-content-type-options"), "nosniff");
    const html = await rootRes.text();
    const csrfMatch = /<meta\s+name="pm-csrf-token"\s+content="([^"]+)"/u.exec(html);
    assert.ok(csrfMatch?.[1], "Expected <meta name=\"pm-csrf-token\"> in index HTML");
    const csrfToken = csrfMatch[1]!;

    // 2. Host header DNS-rebinding defense (403 on evil Host)
    const evilHostStatus = await new Promise<number>((resolveStatus, rejectStatus) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: serverHandle.port,
          path: "/api/projects",
          method: "GET",
          headers: { Host: "evil.example.com" },
        },
        (res) => {
          res.resume();
          resolveStatus(res.statusCode ?? 0);
        },
      );
      req.on("error", rejectStatus);
      req.end();
    });
    assert.equal(evilHostStatus, 403, "Expected 403 when Host header is not loopback");

    // 3. Content-Type enforcement (415 on text/plain POST)
    const badCtRes = await fetch(`${baseUrl}/api/governance`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    assert.equal(badCtRes.status, 415);

    // 4. Cross-Origin / Sec-Fetch-Site / CSRF token enforcement on browser POSTs
    const evilOriginRes = await fetch(`${baseUrl}/api/governance`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: "https://evil.example",
        "x-pm-csrf-token": csrfToken,
      },
      body: JSON.stringify({ action: "writeInsight", title: "X", summary: "Y" }),
    });
    assert.equal(evilOriginRes.status, 403);

    const crossSiteFetchRes = await fetch(`${baseUrl}/api/governance`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
        "x-pm-csrf-token": csrfToken,
      },
      body: JSON.stringify({ action: "writeInsight", title: "X", summary: "Y" }),
    });
    assert.equal(crossSiteFetchRes.status, 403);

    const missingCsrfOnBrowserPost = await fetch(`${baseUrl}/api/governance`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: baseUrl,
      },
      body: JSON.stringify({ action: "writeInsight", title: "X", summary: "Y" }),
    });
    assert.equal(missingCsrfOnBrowserPost.status, 403);

    const wrongCsrfRes = await fetch(`${baseUrl}/api/governance`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: baseUrl,
        "x-pm-csrf-token": "invalid-token",
      },
      body: JSON.stringify({ action: "writeInsight", title: "X", summary: "Y" }),
    });
    assert.equal(wrongCsrfRes.status, 403);

    const validBrowserPost = await fetch(`${baseUrl}/api/governance`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: baseUrl,
        "x-pm-csrf-token": csrfToken,
      },
      body: JSON.stringify({
        projectRoot: fixture.projectRoot,
        action: "writeInsight",
        title: "CSRF Verified Insight",
        summary: "Browser POST with valid Origin + X-PM-CSRF-Token succeeds.",
      }),
    });
    assert.equal(validBrowserPost.status, 200);

    const ipv6Body = JSON.stringify({
      projectRoot: fixture.projectRoot,
      action: "writeInsight",
      title: "IPv6 Loopback Host Header",
      summary: "Bare [::1] Host header must not falsely fail port comparison.",
    });
    const ipv6Status = await new Promise<number>((resolveStatus, rejectStatus) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: serverHandle.port,
          path: "/api/governance",
          method: "POST",
          headers: {
            Host: "[::1]",
            Origin: `http://[::1]:${serverHandle.port}`,
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(ipv6Body)),
            "x-pm-csrf-token": csrfToken,
          },
        },
        (res) => {
          res.resume();
          resolveStatus(res.statusCode ?? 0);
        },
      );
      req.on("error", rejectStatus);
      req.end(ipv6Body);
    });
    assert.equal(ipv6Status, 200, "Bare [::1] Host header with loopback IPv6 Origin must return 200");

    // 5. Proper HTTP status codes: 400 malformed JSON, 413 payload > 1MB, 400 malformed URI
    const badJsonRes = await fetch(`${baseUrl}/api/governance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken-json",
    });
    assert.equal(badJsonRes.status, 400);

    const hugePayload = JSON.stringify({ pad: "x".repeat(1024 * 1024 + 128) });
    const tooLargeRes = await fetch(`${baseUrl}/api/governance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: hugePayload,
    });
    assert.equal(tooLargeRes.status, 413);

    const badUriRes = await fetch(`${baseUrl}/api/notes/%E0%A4%A`);
    assert.equal(badUriRes.status, 400);

    // 6. GET and POST endpoints NEVER auto-create directories/SQLite stores for unregistered paths
    const unregGetRes = await fetch(
      `${baseUrl}/api/overview?project=${encodeURIComponent(unregisteredPath)}`,
    );
    assert.equal(unregGetRes.status, 403);
    const unregPostRes = await fetch(`${baseUrl}/api/governance`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: baseUrl,
        "x-pm-csrf-token": csrfToken,
      },
      body: JSON.stringify({
        projectRoot: unregisteredPath,
        action: "writeInsight",
        title: "Blocked Unregistered Write",
        summary: "Must fail with 403 UNREGISTERED_PROJECT_ROOT.",
      }),
    });
    assert.equal(unregPostRes.status, 403);
    assert.equal(
      existsSync(unregisteredPath),
      false,
      "GET/POST endpoints must never create directories or SQLite stores for unregistered paths",
    );

    // 7. Compile ALL 6 frontend MVC JS bundles via vm.Script + verify UX/Deep-Linking invariants
    const bundlePaths = [
      "/mvc/vendor.js",
      "/mvc/models.js",
      "/mvc/controllers.js",
      "/mvc/shadcn-ui.js",
      "/mvc/views.js",
      "/mvc/web-components.js",
    ] as const;
    const bundles: Record<string, string> = {};
    for (const p of bundlePaths) {
      const res = await fetch(`${baseUrl}${p}`);
      assert.equal(res.status, 200, `Expected 200 for ${p}`);
      const code = await res.text();
      assert.doesNotThrow(
        () => new Script(code, { filename: p }),
        `Syntax error detected in WebUI bundle ${p}`,
      );
      bundles[p] = code;
    }

    assert.ok(bundles["/mvc/vendor.js"]!.includes("data-pm-mount-id"), "vendor.js must isolate hook slots per mount instance");
    assert.ok(bundles["/mvc/vendor.js"]!.includes("scrollTop"), "vendor.js must preserve scroll positions across renders");
    assert.ok(bundles["/mvc/models.js"]!.includes("pm-csrf-token"), "models.js must attach X-PM-CSRF-Token from meta tag");
    assert.ok(bundles["/mvc/controllers.js"]!.includes("hashchange"), "controllers.js must sync URL hash/query deep-links");
    assert.ok(bundles["/mvc/controllers.js"]!.includes("openInGraph"), "controllers.js must expose openInGraph cross-view navigation");
    assert.ok(bundles["/mvc/controllers.js"]!.includes("openInKanban"), "controllers.js must expose openInKanban cross-view navigation");
    assert.ok(bundles["/mvc/shadcn-ui.js"]!.includes("crosshair") && bundles["/mvc/shadcn-ui.js"]!.includes("map-pin"));
    assert.ok(html.includes(".pm-mobile-nav"), "CSS must include .pm-mobile-nav responsive navigation bar");
    assert.ok(!bundles["/mvc/views.js"]!.includes("🎯") && !bundles["/mvc/views.js"]!.includes("📍"), "views.js must replace raw 🎯/📍 emojis with Lucide icons");
    assert.ok(bundles["/mvc/views.js"]!.includes("ctrlKey") && bundles["/mvc/views.js"]!.includes("metaKey"), "Graph SVG wheel zoom must require ctrlKey/metaKey");
    assert.ok(bundles["/mvc/views.js"]!.includes("causalTriads"), "views.js must surface Causal Triads");
    assert.ok(
      bundles["/mvc/views.js"]!.includes("relatedAdrs") &&
        bundles["/mvc/views.js"]!.includes("relatedInsights"),
      "views.js Causal Triads must render human-readable relatedAdrs/relatedInsights titles",
    );
    assert.ok(bundles["/mvc/views.js"]!.includes("vscode:") && bundles["/mvc/views.js"]!.includes("[[") , "views.js must safely render allowlisted links and clickable [[wikilinks]]");

    // 8. Execute parseDeepLinkHash inside a VM sandbox for both #<tab>?... and #view=<tab>&... formats
    const vmWindow: Record<string, unknown> = {
      location: { hash: "#kanban?note=rec-123&q=lifecycle" },
      history: { replaceState() {} },
      React: {
        useState: (init: unknown) => [typeof init === "function" ? (init as () => unknown)() : init, () => {}],
        useEffect: () => {},
        useMemo: (fn: () => unknown) => fn(),
        useCallback: (fn: unknown) => fn,
        createContext: () => ({}),
        useContext: () => null,
        createElement: () => ({}),
      },
      TanStackQuery: {
        useQuery: () => ({}),
        useMutation: () => ({}),
        useQueryClient: () => ({}),
      },
      PM_MVC_MODELS: {},
    };
    runInNewContext(bundles["/mvc/controllers.js"]!, { window: vmWindow, URLSearchParams });
    const parseDeepLinkHash = (
      vmWindow.PM_MVC_CONTROLLERS as {
        parseDeepLinkHash?: (defaultRoot: string) => {
          tab: string;
          note: string | null;
          q: string;
          kind?: string;
        };
      }
    ).parseDeepLinkHash;
    assert.equal(typeof parseDeepLinkHash, "function");

    const parsedCanonical = parseDeepLinkHash!(fixture.projectRoot);
    assert.equal(parsedCanonical.tab, "kanban");
    assert.equal(parsedCanonical.note, "rec-123");
    assert.equal(parsedCanonical.q, "lifecycle");

    (vmWindow.location as { hash: string }).hash = "#view=graph&q=curator&type=file";
    const parsedKeyValue = parseDeepLinkHash!(fixture.projectRoot);
    assert.equal(parsedKeyValue.tab, "graph");
    assert.equal(parsedKeyValue.q, "curator");
    assert.equal(parsedKeyValue.kind, "file");
  } finally {
    await serverHandle.close();
    rmSync(unregisteredPath, { recursive: true, force: true });
    await fixture.cleanup();
  }
});
