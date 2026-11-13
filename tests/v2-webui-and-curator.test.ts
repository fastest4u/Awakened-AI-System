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
import { gunzipSync } from "node:zlib";
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
import { V2_PUBLIC_TOOL_DEFINITIONS } from "../src/v2/public-tools.js";
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
    const csrfMatch0 = /<meta\s+name="pm-csrf-token"\s+content="([^"]+)"/u.exec(html);
    assert.ok(csrfMatch0?.[1], "Expected pm-csrf-token meta tag in GET /");
    const csrfToken = csrfMatch0[1]!;

    // 3. Reject invalid/relative project path (Review Focus #4) and unallowed MCP tool name
    const badProjectRes = await fetch(`${baseUrl}/api/overview?project=relative/traversal`);
    assert.equal(badProjectRes.status, 400);
    const badProjectJson = (await badProjectRes.json()) as { ok: boolean; error: string };
    assert.equal(badProjectJson.ok, false);
    assert.equal(badProjectJson.error, "INVALID_PROJECT_ROOT");

    const badToolRes = await fetch(`${baseUrl}/api/mcp/call`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pm-csrf-token": csrfToken },
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
      headers: { "content-type": "application/json", "x-pm-csrf-token": csrfToken },
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
      headers: { "content-type": "application/json", "x-pm-csrf-token": csrfToken },
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
      headers: { "content-type": "application/json", "x-pm-csrf-token": csrfToken },
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

    const missingCsrfOnHeaderlessPost = await fetch(`${baseUrl}/api/governance`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "writeInsight", title: "X", summary: "Y" }),
    });
    assert.equal(
      missingCsrfOnHeaderlessPost.status,
      403,
      "Unconditional CSRF defense must reject POST even when Origin and Sec-Fetch-Site are omitted",
    );

    const defaultPortOriginRes = await fetch(`${baseUrl}/api/governance`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: "http://localhost",
        "x-pm-csrf-token": csrfToken,
      },
      body: JSON.stringify({ action: "writeInsight", title: "X", summary: "Y" }),
    });
    assert.equal(
      defaultPortOriginRes.status,
      403,
      "Origin http://localhost (default port 80) must be rejected against non-80 WebUI Host port",
    );

    // 5. Proper HTTP status codes: 400 malformed JSON, 413 payload > 1MB, 400 malformed URI
    const badJsonRes = await fetch(`${baseUrl}/api/governance`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pm-csrf-token": csrfToken },
      body: "{broken-json",
    });
    assert.equal(badJsonRes.status, 400);

    const hugePayload = JSON.stringify({ pad: "x".repeat(1024 * 1024 + 128) });
    const tooLargeRes = await fetch(`${baseUrl}/api/governance`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pm-csrf-token": csrfToken },
      body: hugePayload,
    });
    assert.equal(tooLargeRes.status, 413);

    // POST /api/projects/register must reject non-existent paths and paths overlapping defaultProjectRoot/memory
    const nonExistentRegisterRes = await fetch(`${baseUrl}/api/projects/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pm-csrf-token": csrfToken },
      body: JSON.stringify({ projectRoot: unregisteredPath }),
    });
    assert.equal(nonExistentRegisterRes.status, 400);

    const overlappingRegisterRes = await fetch(`${baseUrl}/api/projects/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pm-csrf-token": csrfToken },
      body: JSON.stringify({ projectRoot: join(fixture.projectRoot, "memory") }),
    });
    assert.equal(overlappingRegisterRes.status, 400);

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

    // 6b. R2-2: POST /api/mcp/call with nested args.projectRoot / args.workspaceRoot pointing to an existing unregistered directory must return 403 without bootstrapping memory-v2
    const existingUnregisteredDir = mkdtempSync(join(tmpdir(), "pm-v2-existing-unreg-"));
    try {
      const nestedMcpCallRes = await fetch(`${baseUrl}/api/mcp/call`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: baseUrl,
          "x-pm-csrf-token": csrfToken,
        },
        body: JSON.stringify({
          projectRoot: fixture.projectRoot,
          tool: "memory_sessionStart",
          args: {
            projectRoot: existingUnregisteredDir,
            agentName: "nested-bypass-probe",
            includeContext: false,
          },
        }),
      });
      assert.equal(
        nestedMcpCallRes.status,
        403,
        "POST /api/mcp/call must reject nested unregistered args.projectRoot with 403",
      );
      assert.equal(
        existsSync(join(existingUnregisteredDir, "memory-v2")),
        false,
        "POST /api/mcp/call must never auto-bootstrap memory-v2 inside an unregistered nested args.projectRoot",
      );
    } finally {
      rmSync(existingUnregisteredDir, { recursive: true, force: true });
    }

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

    // 9. F6 Regression: Verify vendor.js preserves live Custom Element instances across parent root re-renders
    class FakeNode {
      nodeType = 1;
      tagName: string;
      id = "";
      className = "";
      textContent = "";
      style: Record<string, string> = {};
      dataset: Record<string, string> = {};
      attrs = new Map<string, string>();
      children: FakeNode[] = [];
      parentNode: FakeNode | null = null;
      scrollTop = 0;
      scrollLeft = 0;
      constructor(tag: string) {
        this.tagName = tag.toUpperCase();
      }
      get childNodes() {
        return this.children;
      }
      getAttributeNames() {
        return [...this.attrs.keys()];
      }
      setAttribute(k: string, v: string) {
        this.attrs.set(k, String(v));
        if (k === "id") this.id = String(v);
        if (k.startsWith("data-")) {
          const camel = k
            .slice(5)
            .replace(/-([a-z])/gu, (_, c: string) => c.toUpperCase());
          this.dataset[camel] = String(v);
        }
      }
      getAttribute(k: string) {
        return this.attrs.get(k) ?? null;
      }
      removeAttribute(k: string) {
        this.attrs.delete(k);
      }
      appendChild(child: FakeNode) {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.children.push(child);
        return child;
      }
      removeChild(child: FakeNode) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
        child.parentNode = null;
        return child;
      }
      addEventListener() {}
      querySelectorAll() {
        return [];
      }
      set innerHTML(_v: string) {
        for (const c of this.children) c.parentNode = null;
        this.children = [];
      }
    }
    const fakeDoc = {
      activeElement: null,
      createElement: (tag: string) => new FakeNode(tag),
      createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
      createTextNode: (t: string) => {
        const n = new FakeNode("#text");
        n.nodeType = 3;
        n.textContent = t;
        return n;
      },
      querySelector: () => null,
      getElementById: () => null,
    };
    const vendorSandbox: Record<string, unknown> = {
      window: { document: fakeDoc },
      document: fakeDoc,
      Node: { ELEMENT_NODE: 1 },
      SVGElement: class {},
      HTMLInputElement: class {},
      HTMLTextAreaElement: class {},
      HTMLElement: FakeNode,
      Promise,
      Map,
      Set,
      Object,
      Array,
      String,
      Number,
      Boolean,
      Error,
      queueMicrotask,
      setTimeout,
      clearTimeout,
    };
    vendorSandbox.window = vendorSandbox;
    runInNewContext(bundles["/mvc/vendor.js"]!, vendorSandbox);
    const VendorReact = vendorSandbox.React as {
      createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => unknown;
      useState: <T>(init: T) => [T, (next: T) => void];
    };
    const VendorReactDOM = vendorSandbox.ReactDOM as {
      createRoot: (container: FakeNode) => { render: (vnode: unknown) => void };
    };
    const hostContainer = new FakeNode("div");
    const childContainer = new FakeNode("div");
    let triggerParentRerender: ((v: number) => void) | null = null;
    let setChildDraft: ((v: string) => void) | null = null;
    let latestChildDraft = "";

    function ChildPanel() {
      const [draft, setDraft] = VendorReact.useState("initial");
      setChildDraft = setDraft;
      latestChildDraft = draft;
      return VendorReact.createElement("div", null, draft);
    }
    const childRoot = VendorReactDOM.createRoot(childContainer);
    childRoot.render(VendorReact.createElement(ChildPanel, null));

    let createdCustomElements = 0;
    const origCreateElement = fakeDoc.createElement;
    fakeDoc.createElement = (tag: string) => {
      if (tag.toLowerCase() === "pm-kanban-view") {
        createdCustomElements += 1;
        const ce = new FakeNode(tag);
        ce.appendChild(childContainer);
        return ce;
      }
      return origCreateElement(tag);
    };

    function ParentShell() {
      const [toastTick, setToastTick] = VendorReact.useState(0);
      triggerParentRerender = setToastTick;
      return VendorReact.createElement(
        "div",
        { className: `tick-${toastTick}` },
        VendorReact.createElement("pm-kanban-view", { "data-scope": "p1" }),
      );
    }
    const parentRoot = VendorReactDOM.createRoot(hostContainer);
    parentRoot.render(VendorReact.createElement(ParentShell, null));
    assert.equal(createdCustomElements, 1);

    // Mutate child state, then trigger parent re-render (like a toast or theme toggle)
    setChildDraft!("typed-user-input");
    await Promise.resolve();
    assert.equal(latestChildDraft, "typed-user-input");
    triggerParentRerender!(1);
    await Promise.resolve();
    triggerParentRerender!(2);
    await Promise.resolve();
    assert.equal(
      createdCustomElements,
      1,
      "Parent root re-render must reuse live <pm-kanban-view> custom element instead of recreating it",
    );
    assert.equal(
      latestChildDraft,
      "typed-user-input",
      "Child custom element hook state must survive parent root re-renders",
    );
  } finally {
    await serverHandle.close();
    rmSync(unregisteredPath, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("Task 4: WebUI Readability — Modal Markdown Unwrapping, Orbital/Flow Decluttering, Kanban Badge Caps & Session Cards", async (t) => {
  const fixture = await createActiveStoreFixture("pm-v2-webui-readability-");
  const serverHandle = await startV2WebUiServer({
    defaultProjectRoot: fixture.projectRoot,
    port: 0,
    host: "127.0.0.1",
    foundations: new Map([[fixture.projectRoot, fixture.foundation]]),
  });

  try {
    const baseUrl = serverHandle.url;
    const htmlRes = await fetch(`${baseUrl}/`);
    const html = await htmlRes.text();
    const csrfToken = /<meta\s+name="pm-csrf-token"\s+content="([^"]+)"/u.exec(html)![1]!;

    await t.test("4.1 GET /api/notes/:id unwraps content.body and derives human title", async () => {
      const createRes = await fetch(`${baseUrl}/api/governance`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-pm-csrf-token": csrfToken },
        body: JSON.stringify({
          projectRoot: fixture.projectRoot,
          action: "writeADR",
          title: "Readable Modal Architecture",
          summary: "Unwrap content.body in src/v2/webui/models.ts (`MemoryNoteModel`).",
          content: "# Readable Modal Architecture\n\n- Bullet alpha\n- Bullet beta",
        }),
      });
      assert.equal(createRes.status, 200);
      const created = (await createRes.json()) as { result: { recordId: string } };
      const noteId = created.result.recordId;

      const noteDetailRes = await fetch(
        `${baseUrl}/api/notes/${encodeURIComponent(noteId)}?project=${encodeURIComponent(fixture.projectRoot)}`,
      );
      assert.equal(noteDetailRes.status, 200);
      const noteDetailJson = (await noteDetailRes.json()) as {
        ok: boolean;
        note: {
          recordId: string;
          title?: string;
          summary?: string;
          body?: string;
          content?: unknown;
        };
      };
      assert.equal(noteDetailJson.ok, true);
      assert.equal(
        noteDetailJson.note.title,
        "Readable Modal Architecture",
        "GET /api/notes/:id must derive human-readable title instead of leaving it undefined",
      );
      assert.equal(
        typeof noteDetailJson.note.body,
        "string",
        "GET /api/notes/:id must expose normalized string body from content.body",
      );
      assert.ok(noteDetailJson.note.body!.includes("Bullet alpha"));
      assert.ok(!noteDetailJson.note.body!.includes("[object Object]"));

      const missingRes = await fetch(
        `${baseUrl}/api/notes/non-existent-note-id-9999?project=${encodeURIComponent(fixture.projectRoot)}`,
      );
      assert.equal(
        missingRes.status,
        404,
        "GET /api/notes/:id must return HTTP 404 instead of fabricating a fake provisional note with raw UUID title",
      );
      const missingJson = (await missingRes.json()) as { ok: boolean; error: string };
      assert.equal(missingJson.ok, false);
      assert.equal(missingJson.error, "NOTE_NOT_FOUND");
    });

    // Build an interactive DOM harness running the real WebUI bundles
    const bundlePaths = [
      "/mvc/vendor.js",
      "/mvc/models.js",
      "/mvc/controllers.js",
      "/mvc/shadcn-ui.js",
      "/mvc/views.js",
    ] as const;
    const bundles: Record<string, string> = {};
    for (const p of bundlePaths) {
      bundles[p] = await (await fetch(`${baseUrl}${p}`)).text();
    }

    class DomElement {
      nodeType = 1;
      tagName: string;
      id = "";
      className = "";
      textContent = "";
      value = "";
      style: Record<string, string> = {};
      dataset: Record<string, string> = {};
      attrs = new Map<string, string>();
      children: DomElement[] = [];
      parentNode: DomElement | null = null;
      listeners = new Map<string, Array<(ev: Record<string, unknown>) => void>>();
      scrollTop = 0;
      scrollLeft = 0;
      constructor(tag: string) {
        this.tagName = tag.toUpperCase();
      }
      get childNodes() {
        return this.children;
      }
      getAttributeNames() {
        return [...this.attrs.keys()];
      }
      setAttribute(k: string, v: string) {
        this.attrs.set(k, String(v));
        if (k === "id") this.id = String(v);
        if (k === "class") this.className = String(v);
        if (k.startsWith("data-")) {
          const camel = k
            .slice(5)
            .replace(/-([a-z])/gu, (_, c: string) => c.toUpperCase());
          this.dataset[camel] = String(v);
        }
      }
      getAttribute(k: string) {
        return this.attrs.get(k) ?? null;
      }
      removeAttribute(k: string) {
        this.attrs.delete(k);
      }
      appendChild(child: DomElement) {
        if (child.nodeType === 11) {
          for (const fc of [...child.children]) {
            this.appendChild(fc);
          }
          return child;
        }
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.children.push(child);
        return child;
      }
      removeChild(child: DomElement) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
        child.parentNode = null;
        return child;
      }
      addEventListener(event: string, fn: (ev: Record<string, unknown>) => void) {
        const list = this.listeners.get(event) ?? [];
        list.push(fn);
        this.listeners.set(event, list);
      }
      dispatch(event: string, extra: Record<string, unknown> = {}) {
        const list = this.listeners.get(event) ?? [];
        for (const fn of list) {
          fn({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...extra });
        }
      }
      querySelectorAll() {
        return [];
      }
      set innerHTML(_v: string) {
        for (const c of this.children) c.parentNode = null;
        this.children = [];
      }
    }

    function collectText(node: DomElement): string {
      if (node.nodeType === 3) return node.textContent;
      return node.children.map(collectText).join(" ");
    }

    function findAll(root: DomElement, pred: (el: DomElement) => boolean): DomElement[] {
      const out: DomElement[] = [];
      const walk = (n: DomElement) => {
        if (n.nodeType === 1 && pred(n)) out.push(n);
        for (const c of n.children) walk(c);
      };
      walk(root);
      return out;
    }

    // Build dense 120-node graph dataset (20 sessions, 25 notes, 35 files, 40 symbols)
    const denseNodes: Array<Record<string, unknown>> = [];
    const denseEdges: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 20; i++) {
      denseNodes.push({
        id: `session:sess-${i}`,
        kind: "session",
        sessionId: `sess-${i}`,
        label: `Session #${i}`,
        currentTask: `Implement feature module ${i}`,
        status: i === 0 ? "active" : "ended",
      });
    }
    for (let i = 0; i < 25; i++) {
      denseNodes.push({
        id: `note:note-${i}`,
        kind: "note",
        subkind: i === 0 ? "adr" : "insight",
        recordId: `note-${i}`,
        sessionId: `sess-${i % 20}`,
        label: `Architecture Note ${i}`,
        summary: `Summary for note ${i}`,
        status: "verified",
      });
      denseEdges.push({
        source: `session:sess-${i % 20}`,
        target: `note:note-${i}`,
        relation: "created-in-session",
      });
    }
    for (let i = 0; i < 35; i++) {
      const fp = i === 0 ? "src/v2/webui/views-and-web-components.ts" : `src/module-${i}/handler-${i}.ts`;
      denseNodes.push({
        id: `file:${fp}`,
        kind: "file",
        label: fp,
      });
      denseEdges.push({
        source: `note:note-${i % 25}`,
        target: `file:${fp}`,
        relation: "touches-file",
      });
    }
    for (let i = 0; i < 40; i++) {
      denseNodes.push({
        id: `symbol:sym_${i}`,
        kind: "symbol",
        label: `sym_${i}`,
      });
      denseEdges.push({
        source: `note:note-${i % 25}`,
        target: `symbol:sym_${i}`,
        relation: "mentions-symbol",
      });
    }

    const manySymbolsNote = {
      id: "note-many",
      recordId: "note-many",
      kind: "insight",
      recordKind: "insight",
      title: "High-Density Symbol Extraction Note",
      summary: "Touches 6 files and 20 symbols.",
      status: "verified",
      filePaths: Array.from({ length: 6 }, (_, i) => `src/f${i}.ts`),
      symbols: Array.from({ length: 20 }, (_, i) => `symbolItem_${i}`),
    };

    const domDoc = {
      activeElement: null,
      createElement: (tag: string) => new DomElement(tag),
      createElementNS: (_ns: string, tag: string) => new DomElement(tag),
      createDocumentFragment: () => {
        const frag = new DomElement("#fragment");
        frag.nodeType = 11;
        return frag;
      },
      createTextNode: (t: string) => {
        const n = new DomElement("#text");
        n.nodeType = 3;
        n.textContent = t;
        return n;
      },
      querySelector: (sel: string) => {
        if (sel === 'meta[name="pm-csrf-token"]') {
          return { getAttribute: () => csrfToken };
        }
        return null;
      },
      getElementById: () => null,
    };

    let missing404FetchCount = 0;
    const sandboxFetch = async (urlStr: string) => {
      const u = String(urlStr);
      if (u.startsWith("/api/graph")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            nodes: denseNodes,
            edges: denseEdges,
            stats: {
              sessionNodes: 20,
              noteNodes: 25,
              fileNodes: 35,
              symbolNodes: 40,
              edgeCount: denseEdges.length,
            },
            causalTriads: [],
          }),
        };
      }
      if (u.startsWith("/api/notes/")) {
        if (u.includes("missing-404-note")) {
          missing404FetchCount += 1;
          if (missing404FetchCount > 3) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ ok: true, note: { recordId: "storm-breaker" } }),
            };
          }
          return {
            ok: false,
            status: 404,
            json: async () => ({
              ok: false,
              error: "NOTE_NOT_FOUND",
              message: "ไม่พบข้อมูลความจำที่ระบุ",
            }),
          };
        }
        if (u.includes("note-many")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              ok: true,
              note: {
                ...manySymbolsNote,
                body: "# High-Density Symbol Extraction Note\n\n- Detailed list",
              },
            }),
          };
        }
        // Deliberately return raw nested content object WITHOUT .body to verify view-level fallback too!
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            note: {
              recordId: "raw-nested-note",
              recordKind: "insight",
              status: "verified",
              text: "Insight: Nested Markdown Content Object",
              content: {
                format: "markdown",
                body: "# Clean Heading\n\n- Nested bullet item",
                contentHash: "abc",
              },
            },
          }),
        };
      }
      if (u.startsWith("/api/notes")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, items: [manySymbolsNote] }),
        };
      }
      if (u.startsWith("/api/projects")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            defaultProjectRoot: fixture.projectRoot,
            projects: [{ projectRoot: fixture.projectRoot, name: "test-proj", mode: "active" }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const sandbox: Record<string, unknown> = {
      document: domDoc,
      location: { hash: "#overview?note=raw-nested-note" },
      history: { replaceState() {} },
      addEventListener() {},
      removeEventListener() {},
      fetch: sandboxFetch,
      URLSearchParams,
      Node: { ELEMENT_NODE: 1 },
      SVGElement: class {},
      HTMLInputElement: class {},
      HTMLTextAreaElement: class {},
      HTMLElement: DomElement,
      Promise,
      Map,
      Set,
      Object,
      Array,
      String,
      Number,
      Boolean,
      Math,
      Date,
      JSON,
      RegExp,
      Error,
      encodeURIComponent,
      decodeURIComponent,
      queueMicrotask,
      setTimeout,
      clearTimeout,
    };
    sandbox.window = sandbox;
    for (const p of bundlePaths) {
      runInNewContext(bundles[p]!, sandbox, { filename: p });
    }

    const React = sandbox.React as {
      createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
    };
    const ReactDOM = sandbox.ReactDOM as {
      createRoot: (container: DomElement) => { render: (vnode: unknown) => void };
    };
    const TanStackQuery = sandbox.TanStackQuery as {
      QueryClient: new () => unknown;
      QueryClientProvider: unknown;
    };
    const Views = sandbox.PM_MVC_VIEWS as Record<string, unknown>;

    const flushAsync = async () => {
      for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 5));
    };

    await t.test("4.2 MissionControlShellView modal unwraps nested note.content.body without [object Object]", async () => {
      const shellContainer = new DomElement("div");
      const shellClient = new TanStackQuery.QueryClient();
      ReactDOM.createRoot(shellContainer).render(
        React.createElement(
          TanStackQuery.QueryClientProvider,
          { client: shellClient },
          React.createElement(Views.MissionControlShellView, { defaultProjectRoot: fixture.projectRoot }),
        ),
      );
      await flushAsync();
      const shellText = collectText(shellContainer);
      assert.ok(
        shellText.includes("Clean Heading"),
        "Modal <h2> must derive clean H1 title instead of falling back to raw recordId",
      );
      assert.ok(
        shellText.includes("Nested bullet item"),
        "Modal must render Markdown body from nested content.body object",
      );
      assert.ok(
        !shellText.includes("[object Object]"),
        "Modal must NEVER render '[object Object]' when note.content is an object",
      );

      // Verify missing note 404 shows clean error alert instead of infinite loading spinner
      (sandbox.location as { hash: string }).hash = "#overview?note=missing-404-note";
      const missingContainer = new DomElement("div");
      const missingClient = new TanStackQuery.QueryClient();
      ReactDOM.createRoot(missingContainer).render(
        React.createElement(
          TanStackQuery.QueryClientProvider,
          { client: missingClient },
          React.createElement(Views.MissionControlShellView, { defaultProjectRoot: fixture.projectRoot }),
        ),
      );
      await flushAsync();
      assert.equal(
        missing404FetchCount,
        1,
        "useQuery in vendor.js must NOT spin in an infinite microtask refetch loop when an endpoint returns 404",
      );
      const missingModalText = collectText(missingContainer);
      assert.ok(
        missingModalText.includes("ไม่พบข้อมูลความจำ"),
        "Modal must display a clear Thai error state when GET /api/notes/:id returns 404",
      );
      assert.ok(
        !missingModalText.includes("กำลังโหลดข้อมูลความจำ..."),
        "Modal must NOT get stuck on loading text when noteDetailQuery fails",
      );
      (sandbox.location as { hash: string }).hash = "#overview";
    });

    const graphContainer = new DomElement("div");
    const graphClient = new TanStackQuery.QueryClient();
    ReactDOM.createRoot(graphContainer).render(
      React.createElement(
        TanStackQuery.QueryClientProvider,
        { client: graphClient },
        React.createElement(Views.KnowledgeGraphView, { projectRoot: fixture.projectRoot }),
      ),
    );
    await flushAsync();

    await t.test("4.3 Flow mode separates zoom toolbar from Column 4 and renders clean file basenames + <title> tooltips", async () => {
      const hudNodes = findAll(graphContainer, (el) => el.id === "graph-zoom-hud");
      assert.equal(hudNodes.length, 1, "Graph zoom controls toolbar must exist");
      assert.notEqual(
        hudNodes[0]!.style.position,
        "absolute",
        "Graph zoom toolbar must not float with position:absolute over Column 4",
      );

      const flowSvg = findAll(graphContainer, (el) => el.id === "knowledge-graph-canvas")[0]!;
      const flowTitles = findAll(flowSvg, (el) => el.tagName === "TITLE").map(collectText);
      assert.ok(
        flowTitles.some((t) => t.includes("src/v2/webui/views-and-web-components.ts")),
        "Flow mode nodes must include <title> tooltips with full file path for hover inspection",
      );
      const flowTexts = findAll(flowSvg, (el) => el.tagName === "TEXT").map(collectText);
      assert.ok(
        flowTexts.some((t) => t.trim() === "views-and-web-components.ts"),
        "Flow mode file pill must display clean basename without verbose parent folder suffix truncating it",
      );
    });

    await t.test("4.4 Orbital mode caps dense rings, suppresses 175% background label explosion, and shows hover labels on demand", async () => {
      const orbitalBtn = findAll(
        graphContainer,
        (el) => el.tagName === "BUTTON" && collectText(el).includes("มุมมองเครือข่ายวงโคจร"),
      )[0]!;
      orbitalBtn.dispatch("click");
      await flushAsync();

      const focusBtn = findAll(
        graphContainer,
        (el) => el.tagName === "BUTTON" && collectText(el).includes("ซูมดูจุดที่เลือก"),
      )[0]!;
      focusBtn.dispatch("click");
      await flushAsync();

      const getOrbitalSvg = () => findAll(graphContainer, (el) => el.id === "knowledge-graph-canvas")[0]!;
      const orbitalSvg = getOrbitalSvg();
      const orbitalNodeGroups = findAll(
        orbitalSvg,
        (el) => el.tagName === "G" && Boolean(el.getAttribute("data-node-id")),
      );
      assert.ok(
        orbitalNodeGroups.length > 0 && orbitalNodeGroups.length <= 56,
        `Orbital mode must cap visible ring nodes to <= 56 for readability (got ${orbitalNodeGroups.length} from 120 raw nodes)`,
      );

      const orbitalLabelsAt175 = findAll(orbitalSvg, (el) => el.tagName === "TEXT");
      assert.ok(
        orbitalLabelsAt175.length <= 12,
        `Orbital mode at 175% zoom must NOT explode background labels (expected <= 12 spotlight labels, got ${orbitalLabelsAt175.length})`,
      );

      const unhighlightedNode = orbitalNodeGroups.find(
        (el) => el.getAttribute("data-highlighted") === "false",
      );
      assert.ok(unhighlightedNode, "Expected at least one dimmed background node in Orbital mode");
      const targetHoverId = unhighlightedNode!.getAttribute("data-node-id")!;
      const countBeforeHover = findAll(getOrbitalSvg(), (el) => el.tagName === "TEXT").length;
      unhighlightedNode!.dispatch("mouseenter");
      await flushAsync();
      const countDuringHover = findAll(getOrbitalSvg(), (el) => el.tagName === "TEXT").length;
      assert.equal(
        countDuringHover,
        countBeforeHover + 1,
        "Hovering a background node in Orbital mode must reveal its label cleanly",
      );
      const liveHoveredNode = findAll(
        getOrbitalSvg(),
        (el) => el.tagName === "G" && el.getAttribute("data-node-id") === targetHoverId,
      )[0]!;
      const hoveredTextEl = findAll(liveHoveredNode, (el) => el.tagName === "TEXT")[0]!;
      assert.notEqual(
        hoveredTextEl.getAttribute("fill"),
        "#ffffff",
        "Hovered Orbital label must use theme-safe foreground color instead of hardcoded #ffffff (which turns invisible in Light Mode)",
      );
      liveHoveredNode.dispatch("mouseleave");
      await flushAsync();
      assert.equal(
        findAll(getOrbitalSvg(), (el) => el.tagName === "TEXT").length,
        countBeforeHover,
        "Leaving hover on a background node must hide its temporary label",
      );

      // Verify 1px pointer jitter during click does NOT pan the viewBox
      const viewBoxBeforeJitter = getOrbitalSvg().getAttribute("viewBox");
      getOrbitalSvg().dispatch("mousedown", { button: 0, clientX: 200, clientY: 200 });
      getOrbitalSvg().dispatch("mousemove", { clientX: 201, clientY: 201 });
      getOrbitalSvg().dispatch("mouseup", {});
      await flushAsync();
      assert.equal(
        getOrbitalSvg().getAttribute("viewBox"),
        viewBoxBeforeJitter,
        "Sub-4px pointer jitter during click must NOT pan the SVG viewBox or replace DOM mid-click",
      );

      // Verify top-of-ring outer file node pin does not clip above y=0
      const topOuterFile = findAll(
        getOrbitalSvg(),
        (el) => el.tagName === "G" && el.getAttribute("data-node-id") === "file:src/v2/webui/views-and-web-components.ts",
      )[0]!;
      topOuterFile.dispatch("click");
      await flushAsync();
      const pinRects = findAll(
        getOrbitalSvg(),
        (el) => el.tagName === "RECT" && el.getAttribute("stroke") === "#f43f5e",
      );
      assert.ok(pinRects.length >= 1, "Selected top-of-ring file node must render selection pin");
      assert.ok(
        Number(pinRects[0]!.getAttribute("y")) >= 0,
        `Selected top-of-ring pin must stay inside SVG viewBox y >= 0 (got y=${pinRects[0]!.getAttribute("y")})`,
      );
    });

    await t.test("4.5 KanbanBoardView caps filePaths (<= 3) and symbols (<= 4) per card with +N overflow badge that reveals full list in modal, and graph double-click works across DOM re-renders", async () => {
      const Controllers = sandbox.PM_MVC_CONTROLLERS as {
        MissionControlController: { Context: { Provider: unknown } };
      };
      const inspectedIds: string[] = [];
      const mockMc = {
        inspectNote: (id: string) => inspectedIds.push(id),
        openInGraph: () => {},
        openInKanban: () => {},
      };

      const kanbanContainer = new DomElement("div");
      const kanbanClient = new TanStackQuery.QueryClient();
      ReactDOM.createRoot(kanbanContainer).render(
        React.createElement(
          TanStackQuery.QueryClientProvider,
          { client: kanbanClient },
          React.createElement(
            Controllers.MissionControlController.Context.Provider,
            { value: mockMc },
            React.createElement(Views.KanbanBoardView, { projectRoot: fixture.projectRoot }),
          ),
        ),
      );
      await flushAsync();
      const kanbanText = collectText(kanbanContainer);
      assert.ok(kanbanText.includes("symbolItem_0"), "Kanban card should show first 4 symbols");
      assert.ok(
        !kanbanText.includes("symbolItem_19"),
        "Kanban card must NOT render 20 unbounded symbol badges",
      );
      assert.ok(
        kanbanText.includes("+19"),
        "Kanban card must summarize hidden files+symbols (3 hidden files + 16 hidden symbols = +19)",
      );

      const moreBadge = findAll(
        kanbanContainer,
        (el) => el.tagName === "SPAN" && collectText(el).trim() === "+19 รายการ",
      )[0]!;
      moreBadge.dispatch("click");
      assert.deepEqual(
        inspectedIds,
        ["note-many"],
        "Clicking +19 รายการ badge on Kanban card must invoke mc.inspectNote('note-many')",
      );

      // Verify Note Detail Modal renders all 20 symbols including symbolItem_19 when inspecting note-many
      (sandbox.location as { hash: string }).hash = "#overview?note=note-many";
      const modalManyContainer = new DomElement("div");
      const modalManyClient = new TanStackQuery.QueryClient();
      ReactDOM.createRoot(modalManyContainer).render(
        React.createElement(
          TanStackQuery.QueryClientProvider,
          { client: modalManyClient },
          React.createElement(Views.MissionControlShellView, { defaultProjectRoot: fixture.projectRoot }),
        ),
      );
      await flushAsync();
      assert.ok(
        collectText(modalManyContainer).includes("symbolItem_19"),
        "Note Detail Modal must display all related symbols including symbolItem_19 when opened from +19 รายการ",
      );

      // Verify rapid double-click (two clicks across full DOM replacement) on a graph note node invokes inspectNote
      const dblGraphContainer = new DomElement("div");
      const dblGraphClient = new TanStackQuery.QueryClient();
      ReactDOM.createRoot(dblGraphContainer).render(
        React.createElement(
          TanStackQuery.QueryClientProvider,
          { client: dblGraphClient },
          React.createElement(
            Controllers.MissionControlController.Context.Provider,
            { value: mockMc },
            React.createElement(Views.KnowledgeGraphView, { projectRoot: fixture.projectRoot }),
          ),
        ),
      );
      await flushAsync();
      const firstClickNode = findAll(
        dblGraphContainer,
        (el) => el.tagName === "G" && el.getAttribute("data-node-id") === "note:note-1",
      )[0]!;
      firstClickNode.dispatch("click");
      await flushAsync();
      // After flushAsync(), vendor.js replaced the DOM — click #2 hits the brand-new <g> instance!
      const secondClickNode = findAll(
        dblGraphContainer,
        (el) => el.tagName === "G" && el.getAttribute("data-node-id") === "note:note-1",
      )[0]!;
      secondClickNode.dispatch("click");
      await flushAsync();
      assert.ok(
        inspectedIds.includes("note-1"),
        "Two rapid clicks on the same note node across vendor.js DOM re-renders must invoke mc.inspectNote",
      );
    });

    await t.test("4.6 SessionActivityMap distinguishes ended sessions and omits empty-memory boilerplate on ended 0-note cards", async () => {
      const sessionMapContainer = new DomElement("div");
      ReactDOM.createRoot(sessionMapContainer).render(
        React.createElement(Views.SessionActivityMap, {
          sessionsJson: JSON.stringify([
            {
              sessionId: "ended-zero-12345678",
              kind: "root",
              semanticState: "ended",
              currentTask: "Synced latest V2 deploymentId across vaults",
              noteCount: 0,
              noteTitles: [],
              noteIds: [],
              filesTouched: [],
            },
          ]),
        }),
      );
      await flushAsync();
      const sessionCardText = collectText(sessionMapContainer);
      assert.ok(
        !sessionCardText.includes("AI กำลังทำ:"),
        "Ended session card must not say 'AI กำลังทำ:'",
      );
      assert.ok(
        !sessionCardText.includes("ยังไม่มีความจำใหม่ในเซสชันนี้"),
        "Ended 0-note session card must omit repetitive empty-memory boilerplate",
      );
    });
  } finally {
    await serverHandle.close();
    await fixture.cleanup();
  }
});

test("Task 5: WebUI Usability & System Efficiency Upgrades (E1-E4 & U1-U5)", async (t) => {
  const fixture = await createActiveStoreFixture("pm-v2-webui-efficiency-");
  const serverHandle = await startV2WebUiServer({
    defaultProjectRoot: fixture.projectRoot,
    foundations: new Map([[fixture.projectRoot, fixture.foundation]]),
    port: 0,
  });

  try {
    const baseUrl = serverHandle.url;
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    const csrfMatch = html.match(/<meta\s+name="pm-csrf-token"\s+content="([^"]+)"/iu);
    assert.ok(csrfMatch?.[1], "Expected non-empty pm-csrf-token meta tag");
    const csrfToken = csrfMatch![1];

    await t.test("5.2 Backend Efficiency, ETag/Gzip Static Bundles, Zero-Work Curator & Authentic Analytics (E3 + E4 + U1 + U2)", async () => {
      // Empty vault overview: activitySeries must reflect real 0-note state, NOT synthetic 1..6 staircase
      const emptyOverviewRes = await fetch(
        `${baseUrl}/api/overview?project=${encodeURIComponent(fixture.projectRoot)}`,
      );
      assert.equal(emptyOverviewRes.status, 200);
      const emptyOverview = (await emptyOverviewRes.json()) as {
        ok: boolean;
        analytics: {
          activitySeries: Array<{ label: string; notes: number; verified: number; sessions: number }>;
        };
      };
      assert.equal(emptyOverview.ok, true);
      assert.ok(emptyOverview.analytics.activitySeries.length >= 1);
      assert.ok(
        emptyOverview.analytics.activitySeries.every((pt) => pt.notes === 0 && pt.verified === 0),
        `Empty vault activitySeries must report 0 notes instead of synthetic staircase: ${JSON.stringify(emptyOverview.analytics.activitySeries)}`,
      );

      // Zero-work autoCurate on clean vault must NOT spawn empty governed sessions
      const curator = new V2MemoryCuratorAgent(fixture.foundation);
      const lifecycleBefore = (await fixture.foundation.content.invoke(
        "memory_lifecycleStatus",
        {},
      )) as { sessions?: unknown[] };
      const sessionCountBefore = lifecycleBefore.sessions?.length ?? 0;

      const noopReceipt = await curator.autoCurate();
      assert.equal(noopReceipt.ok, true);
      assert.equal(noopReceipt.promoted.length, 0);
      assert.equal(noopReceipt.superseded.length, 0);
      assert.equal(noopReceipt.expired.length, 0);

      const lifecycleAfter = (await fixture.foundation.content.invoke(
        "memory_lifecycleStatus",
        {},
      )) as { sessions?: unknown[] };
      assert.equal(
        lifecycleAfter.sessions?.length ?? 0,
        sessionCountBefore,
        "autoCurate() on a clean vault with 0 actionable items must NOT spawn a governed session",
      );

      // Interrogative Thai question containing 'อนุมัติ' must route to read-only 'audit', NOT 'auto_curate'
      const questionReply = await curator.chat({ message: "มีรายการรออนุมัติกี่อัน?" });
      assert.equal(
        questionReply.intent,
        "audit",
        "Question containing 'อนุมัติ' + 'กี่' + '?' must route to read-only audit intent",
      );

      // Natural Thai ADR command without colon ('บันทึก ADR เรื่อง ...') must create ADR
      const naturalAdrReply = await curator.chat({
        message: "บันทึก ADR เรื่อง ใช้ In-Place DOM Reconciliation ใน vendor.js",
      });
      assert.equal(
        naturalAdrReply.intent,
        "write_adr",
        "Natural Thai 'บันทึก ADR เรื่อง ...' without colon must match write_adr intent",
      );
      // Cleanup session opened by naturalAdrReply if any
      const openSessions = (await fixture.foundation.content.invoke("memory_lifecycleStatus", {})) as {
        sessions?: Array<{ sessionId: string; semanticState: string }>;
      };
      for (const s of openSessions.sessions ?? []) {
        if (s.semanticState === "active") {
          await fixture.foundation.content.invoke("memory_sessionEnd", {
            sessionId: s.sessionId,
            summary: "End test ADR session",
            finalize: true,
          });
        }
      }

      // Static /mvc/views.js ETag + Gzip + 304 Not Modified + defer scripts
      assert.match(
        html,
        /<script\s+defer\s+src="\/mvc\/vendor\.js/u,
        "index.html must include defer attribute on /mvc/*.js script tags",
      );
      const rawHttpGet = (path: string, headers: Record<string, string>) =>
        new Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>(
          (resolveReq, rejectReq) => {
            const u = new URL(path, baseUrl);
            const req = httpRequest(
              {
                hostname: u.hostname,
                port: u.port,
                path: u.pathname + u.search,
                method: "GET",
                headers: { Host: u.host, ...headers },
              },
              (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
                res.on("end", () =>
                  resolveReq({
                    statusCode: res.statusCode ?? 0,
                    headers: res.headers,
                    body: Buffer.concat(chunks),
                  }),
                );
              },
            );
            req.on("error", rejectReq);
            req.end();
          },
        );

      const gzipRes = await rawHttpGet("/mvc/views.js", { "Accept-Encoding": "gzip" });
      assert.equal(gzipRes.statusCode, 200);
      assert.equal(gzipRes.headers["content-encoding"], "gzip", "/mvc/views.js must compress with gzip");
      const etag = String(gzipRes.headers.etag ?? "");
      assert.ok(etag.length > 4, "/mvc/views.js must emit an ETag header");
      const unzipped = gunzipSync(gzipRes.body).toString("utf8");
      assert.ok(unzipped.includes("MissionControlShellView"), "Gunzipped views.js must match source");

      const notModRes = await rawHttpGet("/mvc/views.js", { "If-None-Match": etag });
      assert.equal(notModRes.statusCode, 304, "Matching If-None-Match must return 304 Not Modified");
    });

    // Fetch bundles for VM frontend tests (5.1 & 5.3)
    const bundlePaths = [
      "/mvc/vendor.js",
      "/mvc/models.js",
      "/mvc/controllers.js",
      "/mvc/shadcn-ui.js",
      "/mvc/views.js",
    ] as const;
    const bundles: Record<string, string> = {};
    for (const p of bundlePaths) {
      bundles[p] = await (await fetch(`${baseUrl}${p}`)).text();
    }

    class DomNode {
      nodeType = 1;
      tagName: string;
      id = "";
      className = "";
      textContent = "";
      value = "";
      checked = false;
      disabled = false;
      style: Record<string, string> = {};
      dataset: Record<string, string> = {};
      attrs = new Map<string, string>();
      children: DomNode[] = [];
      parentNode: DomNode | null = null;
      listeners = new Map<string, Array<(ev: Record<string, unknown>) => void>>();
      scrollTop = 0;
      scrollLeft = 0;
      constructor(tag: string) {
        this.tagName = tag.toUpperCase();
      }
      get childNodes() {
        return this.children;
      }
      getAttributeNames() {
        return [...this.attrs.keys()];
      }
      setAttribute(k: string, v: string) {
        this.attrs.set(k, String(v));
        if (k === "id") this.id = String(v);
        if (k === "class") this.className = String(v);
        if (k === "disabled") this.disabled = true;
        if (k.startsWith("data-")) {
          const camel = k.slice(5).replace(/-([a-z])/gu, (_, c: string) => c.toUpperCase());
          this.dataset[camel] = String(v);
        }
      }
      getAttribute(k: string) {
        return this.attrs.get(k) ?? null;
      }
      removeAttribute(k: string) {
        this.attrs.delete(k);
        if (k === "disabled") this.disabled = false;
      }
      appendChild(child: DomNode) {
        if (child.nodeType === 11) {
          for (const fc of [...child.children]) this.appendChild(fc);
          return child;
        }
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.children.push(child);
        return child;
      }
      insertBefore(child: DomNode, refNode: DomNode | null) {
        if (!refNode) return this.appendChild(child);
        if (child.nodeType === 11) {
          for (const fc of [...child.children]) this.insertBefore(fc, refNode);
          return child;
        }
        if (child === refNode) return child;
        if (child.parentNode) child.parentNode.removeChild(child);
        const refIdx = this.children.indexOf(refNode);
        child.parentNode = this;
        if (refIdx >= 0) {
          this.children.splice(refIdx, 0, child);
        } else {
          this.children.push(child);
        }
        return child;
      }
      removeChild(child: DomNode) {
        const idx = this.children.indexOf(child);
        if (idx >= 0) this.children.splice(idx, 1);
        child.parentNode = null;
        return child;
      }
      addEventListener(event: string, fn: (ev: Record<string, unknown>) => void) {
        const list = this.listeners.get(event) ?? [];
        list.push(fn);
        this.listeners.set(event, list);
      }
      removeEventListener(event: string, fn: (ev: Record<string, unknown>) => void) {
        const list = this.listeners.get(event) ?? [];
        this.listeners.set(
          event,
          list.filter((f) => f !== fn),
        );
      }
      dispatch(event: string, extra: Record<string, unknown> = {}) {
        const list = this.listeners.get(event) ?? [];
        for (const fn of [...list]) {
          fn({
            target: this,
            currentTarget: this,
            preventDefault() {},
            stopPropagation() {},
            ...extra,
          });
        }
      }
      focus() {
        domDoc.activeElement = this;
      }
      querySelectorAll() {
        return [];
      }
      set innerHTML(_v: string) {
        for (const c of this.children) c.parentNode = null;
        this.children = [];
      }
    }

    const collectText = (node: DomNode): string =>
      node.nodeType === 3 ? node.textContent : node.children.map(collectText).join(" ");
    const findAll = (root: DomNode, pred: (el: DomNode) => boolean): DomNode[] => {
      const out: DomNode[] = [];
      const walk = (n: DomNode) => {
        if (n.nodeType === 1 && pred(n)) out.push(n);
        for (const c of n.children) walk(c);
      };
      walk(root);
      return out;
    };

    const docListeners = new Map<string, Array<(ev: Record<string, unknown>) => void>>();
    const winListeners = new Map<string, Array<(ev: Record<string, unknown>) => void>>();
    const domDoc = {
      activeElement: null as DomNode | null,
      documentElement: new DomNode("html"),
      body: new DomNode("body"),
      createElement: (tag: string) => new DomNode(tag),
      createElementNS: (_ns: string, tag: string) => new DomNode(tag),
      createDocumentFragment: () => {
        const frag = new DomNode("#fragment");
        frag.nodeType = 11;
        return frag;
      },
      createTextNode: (txt: string) => {
        const n = new DomNode("#text");
        n.nodeType = 3;
        n.textContent = txt;
        return n;
      },
      querySelector: (sel: string) =>
        sel === 'meta[name="pm-csrf-token"]' ? { getAttribute: () => csrfToken } : null,
      getElementById: () => null,
      addEventListener: (ev: string, fn: (e: Record<string, unknown>) => void) => {
        const l = docListeners.get(ev) ?? [];
        l.push(fn);
        docListeners.set(ev, l);
      },
      removeEventListener: (ev: string, fn: (e: Record<string, unknown>) => void) => {
        docListeners.set(
          ev,
          (docListeners.get(ev) ?? []).filter((f) => f !== fn),
        );
      },
      dispatchKey(key: string, extra: Record<string, unknown> = {}) {
        const payload = { key, preventDefault() {}, stopPropagation() {}, ...extra };
        for (const fn of [...(docListeners.get("keydown") ?? [])]) fn(payload);
        for (const fn of [...(winListeners.get("keydown") ?? [])]) fn(payload);
      },
    };

    const notesSearchCalls: string[] = [];
    const govCalls: Array<Record<string, unknown>> = [];
    const mcpCalls: Array<Record<string, unknown>> = [];
    const curatorChatCalls: Array<Record<string, unknown>> = [];
    let copiedText = "";

    const sampleCard = {
      id: "note-confirm-1",
      recordId: "note-confirm-1",
      kind: "adr",
      recordKind: "adr",
      title: "Sample ADR Card",
      summary: "Details about sample ADR",
      body: "# Sample ADR Card\n\nBody text",
      status: "verified",
      filePaths: ["src/v2/webui.ts"],
      symbols: ["startV2WebUiServer"],
    };

    const sandboxFetch = async (urlStr: string, opts?: Record<string, unknown>) => {
      const u = String(urlStr);
      if (u.startsWith("/api/notes/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, note: sampleCard }),
        };
      }
      if (u.startsWith("/api/notes")) {
        notesSearchCalls.push(u);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, items: [sampleCard] }),
        };
      }
      if (u.startsWith("/api/governance")) {
        const parsed = JSON.parse(String(opts?.body ?? "{}")) as Record<string, unknown>;
        govCalls.push(parsed);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, action: parsed.action, result: { ok: true } }),
        };
      }
      if (u.startsWith("/api/mcp/call")) {
        const parsed = JSON.parse(String(opts?.body ?? "{}")) as Record<string, unknown>;
        mcpCalls.push(parsed);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, tool: parsed.tool, result: { mode: "active" } }),
        };
      }
      if (u.startsWith("/api/curator/chat")) {
        const parsed = JSON.parse(String(opts?.body ?? "{}")) as Record<string, unknown>;
        curatorChatCalls.push(parsed);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            intent: "audit",
            reply: "OK",
            executedTools: ["memory_list"],
          }),
        };
      }
      if (u.startsWith("/api/curator/audit")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            healthScore: 95,
            counts: { totalNotes: 1, verifiedNotes: 1, unpromotedCandidates: 0, duplicateGroups: 0, staleNotes: 0 },
            recommendations: [],
            duplicateGroups: [
              { title: "Dup Group", keeperRecordId: "note-confirm-1", duplicateRecordIds: ["dup-rec-2"] },
            ],
          }),
        };
      }
      if (u.startsWith("/api/projects")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            defaultProjectRoot: fixture.projectRoot,
            projects: [{ projectRoot: fixture.projectRoot, name: "proj", mode: "active" }],
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };

    const pushStateHistory: string[] = [];
    const localStorageMap = new Map<string, string>();
    const sandbox: Record<string, unknown> = {
      document: domDoc,
      location: { hash: "#overview" },
      history: {
        replaceState: (_s: unknown, _t: string, url: string) => {
          (sandbox.location as { hash: string }).hash = url;
        },
        pushState: (_s: unknown, _t: string, url: string) => {
          pushStateHistory.push(url);
          (sandbox.location as { hash: string }).hash = url;
        },
      },
      localStorage: {
        getItem: (k: string) => localStorageMap.get(k) ?? null,
        setItem: (k: string, v: string) => localStorageMap.set(k, String(v)),
      },
      navigator: {
        clipboard: {
          writeText: async (txt: string) => {
            copiedText = String(txt);
          },
        },
      },
      AbortController,
      addEventListener: (ev: string, fn: (e: Record<string, unknown>) => void) => {
        const l = winListeners.get(ev) ?? [];
        l.push(fn);
        winListeners.set(ev, l);
      },
      removeEventListener: (ev: string, fn: (e: Record<string, unknown>) => void) => {
        winListeners.set(
          ev,
          (winListeners.get(ev) ?? []).filter((f) => f !== fn),
        );
      },
      fetch: sandboxFetch,
      URLSearchParams,
      Node: { ELEMENT_NODE: 1 },
      SVGElement: class {},
      HTMLInputElement: class {},
      HTMLTextAreaElement: class {},
      HTMLElement: DomNode,
      Promise,
      Map,
      Set,
      Object,
      Array,
      String,
      Number,
      Boolean,
      Math,
      Date,
      JSON,
      RegExp,
      Error,
      encodeURIComponent,
      decodeURIComponent,
      queueMicrotask,
      setTimeout,
      clearTimeout,
    };
    sandbox.window = sandbox;
    for (const p of bundlePaths) {
      runInNewContext(bundles[p]!, sandbox, { filename: p });
    }

    const React = sandbox.React as {
      createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
      useState: <T>(init: T) => [T, (next: T | ((prev: T) => T)) => void];
      useEffect: (fn: () => void | (() => void), deps?: unknown[]) => void;
    };
    const ReactDOM = sandbox.ReactDOM as {
      createRoot: (container: DomNode) => { render: (vnode: unknown) => void };
    };
    const TanStackQuery = sandbox.TanStackQuery as {
      QueryClient: new () => {
        getEntry: (k: unknown) => { updatedAt: number; data: unknown };
        fetchQuery: (opts: { queryKey: unknown[]; queryFn: (ctx?: { signal?: AbortSignal }) => Promise<unknown> }) => Promise<unknown>;
        invalidateQueries: (opts?: { queryKey?: unknown[] }) => void;
      };
      QueryClientProvider: unknown;
      useQuery: (opts: { queryKey: unknown[]; queryFn: (ctx: { signal?: AbortSignal }) => Promise<unknown> }) => { data: unknown };
    };
    const Views = sandbox.PM_MVC_VIEWS as Record<string, unknown>;
    const Controllers = sandbox.PM_MVC_CONTROLLERS as {
      MissionControlController: { Context: { Provider: unknown } };
    };

    const flushAsync = async () => {
      for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 5));
    };

    await t.test("5.1 Frontend Runtime (E1 + E2): In-Place DOM Reconciliation, Thai IME Guard, Scoped QueryClient & Search Debounce", async () => {
      // 1. In-place DOM reconciliation + Thai IME guard + un-ID'd scrollTop preservation
      let setCountExternal!: (n: number) => void;
      const imeCommitted: string[] = [];
      function ReconcileProbe() {
        const [count, setCount] = React.useState(0);
        const [val, setVal] = React.useState("");
        setCountExternal = setCount;
        return React.createElement(
          "div",
          { className: "probe-wrap" },
          React.createElement("span", {}, `count:${count}`),
          React.createElement("input", {
            className: "thai-input",
            value: val,
            onChange: (e: { target: { value: string } }) => {
              imeCommitted.push(e.target.value);
              setVal(e.target.value);
            },
          }),
          React.createElement(
            "div",
            { className: "unid-scroll", style: { overflowY: "auto" } },
            React.createElement("p", {}, `item-${count}`),
          ),
          React.createElement(
            "svg",
            { className: "probe-svg" },
            React.createElement("circle", { cx: String(10 + count), cy: "20", r: "5" }),
          ),
        );
      }

      const probeRoot = new DomNode("div");
      ReactDOM.createRoot(probeRoot).render(React.createElement(ReconcileProbe));
      await flushAsync();

      const inputBefore = findAll(probeRoot, (el) => el.tagName === "INPUT")[0]!;
      const scrollBoxBefore = findAll(probeRoot, (el) => el.className === "unid-scroll")[0]!;
      const svgBefore = findAll(probeRoot, (el) => el.tagName === "SVG")[0]!;
      scrollBoxBefore.scrollTop = 188;

      setCountExternal(1);
      await flushAsync();

      const inputAfter = findAll(probeRoot, (el) => el.tagName === "INPUT")[0]!;
      const scrollBoxAfter = findAll(probeRoot, (el) => el.className === "unid-scroll")[0]!;
      const svgAfter = findAll(probeRoot, (el) => el.tagName === "SVG")[0]!;

      assert.equal(
        inputBefore,
        inputAfter,
        "E1: In-place DOM reconciliation must preserve <input> node identity across re-renders",
      );
      assert.equal(
        svgBefore,
        svgAfter,
        "E1: In-place DOM reconciliation must preserve <svg> root identity across pan/hover re-renders",
      );
      assert.equal(
        scrollBoxAfter.scrollTop,
        188,
        "E1: Un-ID'd scroll containers must retain scrollTop because the DOM element is updated in place",
      );

      // Thai IME compositionstart -> input -> compositionend guard
      inputAfter.dispatch("compositionstart");
      inputAfter.value = "ก";
      inputAfter.dispatch("input");
      await flushAsync();
      assert.equal(
        imeCommitted.length,
        0,
        "E1: Thai IME composition must NOT trigger React state re-render mid-composition",
      );
      inputAfter.value = "การ";
      inputAfter.dispatch("compositionend");
      await flushAsync();
      assert.deepEqual(
        imeCommitted,
        ["การ"],
        "E1: compositionend must flush final composed Thai text cleanly",
      );

      // 2. Scoped QueryClient notifications + staleTime
      const scopedClient = new TanStackQuery.QueryClient();
      let k1Renders = 0;
      let k2Renders = 0;
      let k1Fetches = 0;
      function CompK1() {
        k1Renders += 1;
        TanStackQuery.useQuery({
          queryKey: ["k1"],
          queryFn: async () => {
            k1Fetches += 1;
            return "v1";
          },
        });
        return React.createElement("div", {}, "k1");
      }
      function CompK2() {
        k2Renders += 1;
        TanStackQuery.useQuery({
          queryKey: ["k2"],
          queryFn: async () => "v2",
        });
        return React.createElement("div", {}, "k2");
      }
      const qContainer = new DomNode("div");
      ReactDOM.createRoot(qContainer).render(
        React.createElement(
          TanStackQuery.QueryClientProvider,
          { client: scopedClient },
          React.createElement(CompK1),
          React.createElement(CompK2),
        ),
      );
      await flushAsync();
      const k2AfterMount = k2Renders;
      await scopedClient.fetchQuery({
        queryKey: ["k1"],
        queryFn: async () => "v1-updated",
      });
      await flushAsync();
      assert.equal(
        k2Renders,
        k2AfterMount,
        "E2: Updating query ['k1'] must NOT force unrelated useQuery(['k2']) components to re-render",
      );

      const fetchesBeforeRemount = k1Fetches;
      const qContainer2 = new DomNode("div");
      ReactDOM.createRoot(qContainer2).render(
        React.createElement(
          TanStackQuery.QueryClientProvider,
          { client: scopedClient },
          React.createElement(CompK1),
        ),
      );
      await flushAsync();
      assert.equal(
        k1Fetches,
        fetchesBeforeRemount,
        "E2: Fresh cached query within staleTime must NOT re-fetch on mount",
      );

      // 3. Kanban search input 250ms debounce
      notesSearchCalls.length = 0;
      const kanbanContainer = new DomNode("div");
      const kanbanClient = new TanStackQuery.QueryClient();
      ReactDOM.createRoot(kanbanContainer).render(
        React.createElement(
          TanStackQuery.QueryClientProvider,
          { client: kanbanClient },
          React.createElement(
            Controllers.MissionControlController.Context.Provider,
            { value: { inspectNote() {}, openInGraph() {}, openInKanban() {} } },
            React.createElement(Views.KanbanBoardView, { projectRoot: fixture.projectRoot }),
          ),
        ),
      );
      await flushAsync();
      const baselineCalls = notesSearchCalls.length;
      const searchInput = findAll(kanbanContainer, (el) => el.id === "kanban-search-input")[0]!;
      for (const partial of ["r", "re", "red", "redis"]) {
        searchInput.value = partial;
        searchInput.dispatch("input");
      }
      await flushAsync();
      assert.equal(
        notesSearchCalls.length,
        baselineCalls,
        "E2: Rapid keystrokes in #kanban-search-input must debounce and NOT fire immediate HTTP requests per character",
      );
      await new Promise((r) => setTimeout(r, 290));
      await flushAsync();
      assert.equal(
        notesSearchCalls.length,
        baselineCalls + 1,
        "E2: Debounced search must fire exactly 1 HTTP request after 250ms quiet window",
      );
      assert.ok(
        notesSearchCalls[notesSearchCalls.length - 1]!.includes("query=redis"),
        "E2: Debounced search request must carry final query=redis",
      );
    });

    await t.test("5.3 Usability, Safety Confirmations, Keyboard Shortcuts, MCP Schema Templates & Light Mode CSS (U1 + U3 + U4 + U5)", async () => {
      // 1. Valid CSS Color 4 syntax (no broken hsla(var(--...)))
      assert.ok(
        !html.includes("hsla(var(--"),
        "U5: Theme CSS must NOT contain invalid 'hsla(var(--...), a)' rules that break Light Mode",
      );
      assert.ok(
        html.includes("hsl(var(--card) /"),
        "U5: Theme CSS must use valid CSS Color 4 'hsl(var(--card) / a)' syntax",
      );

      // 2. HealthGaugeChart accurate proportional progress bars
      const gaugeContainer = new DomNode("div");
      ReactDOM.createRoot(gaugeContainer).render(
        React.createElement(Views.HealthGaugeChart, {
          score: 90,
          verified: 2,
          candidates: 2,
          conflicts: 0,
        }),
      );
      await flushAsync();
      const progressFills = findAll(gaugeContainer, (el) => el.className.includes("sh-progress-fill"));
      assert.equal(
        progressFills[0]!.style.width,
        "50%",
        `U2: HealthGaugeChart verified=2, candidates=2 must render 50% bar width (got ${progressFills[0]!.style.width})`,
      );

      // 3. Destructive Governance Confirmation Dialog before retract/expire
      govCalls.length = 0;
      const kbContainer = new DomNode("div");
      const kbClient = new TanStackQuery.QueryClient();
      ReactDOM.createRoot(kbContainer).render(
        React.createElement(
          TanStackQuery.QueryClientProvider,
          { client: kbClient },
          React.createElement(
            Controllers.MissionControlController.Context.Provider,
            { value: { inspectNote() {}, openInGraph() {}, openInKanban() {} } },
            React.createElement(Views.KanbanBoardView, { projectRoot: fixture.projectRoot }),
          ),
        ),
      );
      await flushAsync();
      const retractBtn = findAll(
        kbContainer,
        (el) => el.tagName === "BUTTON" && collectText(el).includes("ถอนคืน"),
      )[0]!;
      retractBtn.dispatch("click");
      await flushAsync();
      assert.equal(
        govCalls.length,
        0,
        "U1: Clicking 'ถอนคืน' (retract) must open a confirmation dialog instead of firing POST /api/governance immediately",
      );
      const dialogs = findAll(kbContainer, (el) => el.getAttribute("role") === "dialog");
      assert.equal(dialogs.length, 1, "U1/U4: Confirmation Dialog must render with role='dialog'");

      const confirmBtn = findAll(
        dialogs[0]!,
        (el) => el.tagName === "BUTTON" && collectText(el).includes("ยืนยัน"),
      )[0]!;
      confirmBtn.dispatch("click");
      await flushAsync();
      assert.equal(govCalls.length, 1, "U1: Confirming dialog must execute governance retract mutation");
      assert.equal(govCalls[0]!.action, "retract");

      // 4. Note Detail Modal Escape-to-close + Copy ID button + pushState on tab switch
      (sandbox.location as { hash: string }).hash = "#overview?note=note-confirm-1";
      pushStateHistory.length = 0;
      const shellContainer = new DomNode("div");
      const shellClient = new TanStackQuery.QueryClient();
      ReactDOM.createRoot(shellContainer).render(
        React.createElement(
          TanStackQuery.QueryClientProvider,
          { client: shellClient },
          React.createElement(Views.MissionControlShellView, { defaultProjectRoot: fixture.projectRoot }),
        ),
      );
      await flushAsync();
      assert.equal(
        findAll(shellContainer, (el) => el.getAttribute("role") === "dialog").length,
        1,
        "Note Detail Modal should be open initially",
      );
      const copyIdBtn = findAll(
        shellContainer,
        (el) => el.tagName === "BUTTON" && collectText(el).includes("คัดลอก ID"),
      )[0];
      assert.ok(copyIdBtn, "U4: Note Detail Modal must include a 1-click 'คัดลอก ID' button");
      copyIdBtn!.dispatch("click");
      await flushAsync();
      assert.equal(copiedText, "note-confirm-1", "U4: Clicking 'คัดลอก ID' must copy recordId to clipboard");

      domDoc.dispatchKey("Escape");
      await flushAsync();
      assert.equal(
        findAll(shellContainer, (el) => el.getAttribute("role") === "dialog").length,
        0,
        "U4: Pressing Escape must close the open Dialog modal",
      );

      // Primary tab switch pushes browser history entry
      const graphNavBtn = findAll(
        shellContainer,
        (el) => el.tagName === "BUTTON" && collectText(el).includes("กราฟเชื่อมโยง"),
      )[0]!;
      graphNavBtn.dispatch("click");
      await flushAsync();
      assert.ok(
        pushStateHistory.some((hUrl) => hUrl.startsWith("#graph")),
        "U4: Switching primary tabs must push a browser history entry via history.pushState",
      );

      // 5. MCP Developer Console auto-populates JSON schema template + preserves cache on readOnlyHint tools
      const mcpContainer = new DomNode("div");
      const mcpClient = new TanStackQuery.QueryClient();
      await mcpClient.fetchQuery({ queryKey: ["pm-v2", "overview", fixture.projectRoot], queryFn: async () => ({ ok: true }) });
      const cachedOverviewBefore = mcpClient.getEntry(["pm-v2", "overview", fixture.projectRoot]).updatedAt;
      assert.ok(cachedOverviewBefore > 0);

      ReactDOM.createRoot(mcpContainer).render(
        React.createElement(
          TanStackQuery.QueryClientProvider,
          { client: mcpClient },
          React.createElement(Views.McpConsoleView, { projectRoot: fixture.projectRoot }),
        ),
      );
      await flushAsync();

      // Run default read-only tool memory_v2Status -> must NOT wipe cachedOverviewBefore!
      const execBtn = findAll(
        mcpContainer,
        (el) => el.tagName === "BUTTON" && collectText(el).includes("รันคำสั่ง"),
      )[0]!;
      execBtn.dispatch("click");
      await flushAsync();
      assert.equal(
        mcpClient.getEntry(["pm-v2", "overview", fixture.projectRoot]).updatedAt,
        cachedOverviewBefore,
        "E2/U3: Running readOnlyHint tool (memory_v2Status) in MCP Console must NOT wipe QueryClient cache",
      );

      // Select memory_search -> #mcp-tool-args must auto-populate starter template with "query"
      const toolSelect = findAll(mcpContainer, (el) => el.id === "mcp-tool-select")[0]!;
      toolSelect.value = "memory_search";
      toolSelect.dispatch("change");
      await flushAsync();
      const argsBox = findAll(mcpContainer, (el) => el.id === "mcp-tool-args")[0]!;
      assert.ok(
        argsBox.value.includes('"query"'),
        `U3: Selecting memory_search must auto-populate JSON template with "query" (got ${argsBox.value})`,
      );
      assert.ok(
        collectText(mcpContainer).includes("Read-Only"),
        "U3: MCP Console must display Read-Only safety badge for readOnlyHint tools",
      );

      // 6. CuratorStudioView multiline <textarea> + prefill chips
      const curContainer = new DomNode("div");
      const curClient = new TanStackQuery.QueryClient();
      ReactDOM.createRoot(curContainer).render(
        React.createElement(
          TanStackQuery.QueryClientProvider,
          { client: curClient },
          React.createElement(Views.CuratorStudioView, { projectRoot: fixture.projectRoot }),
        ),
      );
      await flushAsync();
      const curInput = findAll(curContainer, (el) => el.id === "curator-chat-input")[0]!;
      assert.equal(
        curInput.tagName,
        "TEXTAREA",
        "U5: Curator chat input must be a multiline <textarea>",
      );
      const adrChip = findAll(
        curContainer,
        (el) => el.tagName === "BUTTON" && collectText(el).includes("+ ADR"),
      )[0];
      assert.ok(adrChip, "U5: Curator Studio must include '+ ADR' quick-prefill chip");
      adrChip!.dispatch("click");
      await flushAsync();
      assert.ok(
        curInput.value.toLowerCase().includes("adr"),
        "U5: Clicking '+ ADR' chip must prefill Curator chat textarea",
      );
    });

    await t.test("5.4 Code Review Regressions (C1, C2, I1-I6, M1-M4)", async () => {
      // C1 & I2: Concurrent read + write must not poison #cachedProjectionManifest or generation-keyed WebUI read cache
      const [concurrentOverviewRes, createdAdr] = await Promise.all([
        fetch(`${baseUrl}/api/overview?project=${encodeURIComponent(fixture.projectRoot)}`),
        fixture.foundation.content.invoke("memory_writeADR", {
          title: "C1 Concurrent Projection Safety ADR",
          summary: "Verify concurrent read+write never poisons projection cache",
          content: "# C1 Concurrent Projection Safety ADR\n\nBody text",
        }) as Promise<{ recordId: string }>,
      ]);
      assert.equal(concurrentOverviewRes.status, 200);
      assert.ok(createdAdr.recordId, "Expected recordId from memory_writeADR");

      const noteDetailAfterWrite = await fetch(
        `${baseUrl}/api/notes/${encodeURIComponent(createdAdr.recordId)}?project=${encodeURIComponent(fixture.projectRoot)}`,
      );
      assert.equal(
        noteDetailAfterWrite.status,
        200,
        "C1: Verified note detail read immediately after concurrent read+write must find the new ADR",
      );
      const freshOverviewRes = await fetch(
        `${baseUrl}/api/overview?project=${encodeURIComponent(fixture.projectRoot)}`,
      );
      const freshOverviewJson = (await freshOverviewRes.json()) as {
        audit: { counts: { totalNotes: number } };
      };
      assert.ok(
        freshOverviewJson.audit.counts.totalNotes >= 2,
        `I2: Post-write /api/overview must immediately reflect updated globalPosition instead of stale cache (got ${freshOverviewJson.audit.counts.totalNotes})`,
      );
      // Cleanup any auto-session opened by memory_writeADR
      const postWriteLifecycle = (await fixture.foundation.content.invoke("memory_lifecycleStatus", {})) as {
        sessions?: Array<{ sessionId: string; semanticState: string }>;
      };
      for (const s of postWriteLifecycle.sessions ?? []) {
        if (s.semanticState === "active") {
          await fixture.foundation.content.invoke("memory_sessionEnd", {
            sessionId: s.sessionId,
            summary: "Close C1 test session",
            finalize: true,
          });
        }
      }

      // C2 & I5: Conditional null sibling preserves child hook state + DOM identity (suffix patch) + unmounted child runs useEffect cleanup
      let toggleBanner!: (v: boolean) => void;
      let toggleEffectChild!: (v: boolean) => void;
      let bumpCounter!: () => void;
      let effectCleanups = 0;
      function StatefulCounter() {
        const [val, setVal] = React.useState(1);
        bumpCounter = () => setVal((n) => n + 6);
        return React.createElement("div", { className: "stable-counter" }, `counter:${val}`);
      }
      function EffectChild() {
        React.useEffect(() => {
          return () => {
            effectCleanups += 1;
          };
        }, []);
        return React.createElement("span", { className: "effect-child" }, "mounted");
      }
      function SiblingHarness() {
        const [banner, setBanner] = React.useState(false);
        const [mountEffect, setMountEffect] = React.useState(true);
        toggleBanner = setBanner;
        toggleEffectChild = setMountEffect;
        return React.createElement(
          "div",
          { className: "sibling-harness" },
          banner ? React.createElement("div", { className: "cond-banner" }, "Alert") : null,
          React.createElement(StatefulCounter),
          mountEffect ? React.createElement(EffectChild) : null,
        );
      }
      const sibRoot = new DomNode("div");
      ReactDOM.createRoot(sibRoot).render(React.createElement(SiblingHarness));
      await flushAsync();
      bumpCounter();
      await flushAsync();
      const counterDomBefore = findAll(sibRoot, (el) => el.className === "stable-counter")[0]!;
      assert.ok(collectText(counterDomBefore).includes("counter:7"));

      toggleBanner(true);
      await flushAsync();
      const counterDomAfter = findAll(sibRoot, (el) => el.className === "stable-counter")[0]!;
      assert.ok(
        collectText(counterDomAfter).includes("counter:7"),
        `C2: Toggling conditional sibling before StatefulCounter must preserve hook state (got ${collectText(counterDomAfter)})`,
      );
      assert.equal(
        counterDomBefore,
        counterDomAfter,
        "C2: Suffix reconciliation in patchChildren must preserve trailing DOM element identity without detaching",
      );

      toggleEffectChild(false);
      await flushAsync();
      assert.equal(
        effectCleanups,
        1,
        "I5: Conditionally unmounting a child component must invoke its useEffect cleanup immediately",
      );

      // C2: Toast show/hide in MissionControlShellView must NOT detach <main class="pm-content">
      (sandbox.location as { hash: string }).hash = "#overview?note=note-confirm-1";
      const toastShellContainer = new DomNode("div");
      const toastShellClient = new TanStackQuery.QueryClient();
      ReactDOM.createRoot(toastShellContainer).render(
        React.createElement(
          TanStackQuery.QueryClientProvider,
          { client: toastShellClient },
          React.createElement(Views.MissionControlShellView, { defaultProjectRoot: fixture.projectRoot }),
        ),
      );
      await flushAsync();
      const mainEl = findAll(toastShellContainer, (el) => el.tagName === "MAIN")[0]!;
      let mainRemovedCount = 0;
      const origParent = mainEl.parentNode!;
      const origRemove = origParent.removeChild.bind(origParent);
      origParent.removeChild = (c: DomNode) => {
        if (c === mainEl) mainRemovedCount += 1;
        return origRemove(c);
      };
      const modalCopyBtn = findAll(
        toastShellContainer,
        (el) => el.tagName === "BUTTON" && collectText(el).includes("คัดลอก ID"),
      )[0]!;
      modalCopyBtn.dispatch("click");
      await flushAsync();
      assert.equal(
        mainRemovedCount,
        0,
        "C2: Showing floating toast notification must NOT removeChild(<main>) or detach active content",
      );

      // M3: Pressing '/' outside inputs closes modal & jumps to #kanban
      domDoc.activeElement = null;
      domDoc.dispatchKey("/");
      await flushAsync();
      assert.ok(
        String((sandbox.location as { hash: string }).hash).startsWith("#kanban"),
        "M3: Pressing '/' when no input is focused must jump to #kanban search",
      );

      // I1: QueryClient aborts superseded AbortSignal when observer unmounts + refetches mid-flight invalidated query
      const raceClient = new TanStackQuery.QueryClient();
      let firstSignal: AbortSignal | undefined;
      let setSearchKey!: (k: string) => void;
      function AbortProbe() {
        const [k, setK] = React.useState("r");
        setSearchKey = setK;
        TanStackQuery.useQuery({
          queryKey: ["abort-probe", k],
          queryFn: ({ signal }) =>
            new Promise((resolveQ) => {
              if (k === "r") firstSignal = signal;
              else resolveQ("done-re");
            }),
        });
        return React.createElement("div", {}, k);
      }
      const abortRoot = new DomNode("div");
      ReactDOM.createRoot(abortRoot).render(
        React.createElement(TanStackQuery.QueryClientProvider, { client: raceClient }, React.createElement(AbortProbe)),
      );
      await flushAsync();
      assert.ok(firstSignal && !firstSignal.aborted, "Expected initial query signal in flight");
      setSearchKey("re");
      await flushAsync();
      assert.equal(
        firstSignal!.aborted,
        true,
        "I1: Switching queryKey from ['abort-probe','r'] to ['abort-probe','re'] must abort the zero-observer in-flight signal",
      );

      let midFlightCalls = 0;
      let resolveFirstFetch!: (v: string) => void;
      function MidFlightProbe() {
        const q = TanStackQuery.useQuery({
          queryKey: ["midflight-inv"],
          queryFn: () => {
            midFlightCalls += 1;
            if (midFlightCalls === 1) {
              return new Promise<string>((r) => {
                resolveFirstFetch = r;
              });
            }
            return Promise.resolve("fresh-v2");
          },
        });
        return React.createElement("div", {}, String(q.data ?? "pending"));
      }
      const midRoot = new DomNode("div");
      ReactDOM.createRoot(midRoot).render(
        React.createElement(
          TanStackQuery.QueryClientProvider,
          { client: raceClient },
          React.createElement(MidFlightProbe),
        ),
      );
      await flushAsync();
      assert.equal(midFlightCalls, 1);
      // Invalidate while fetch #1 is still in flight!
      raceClient.invalidateQueries({ queryKey: ["midflight-inv"] });
      if (resolveFirstFetch) resolveFirstFetch("stale-v1");
      await flushAsync();
      assert.ok(
        midFlightCalls >= 2 && collectText(midRoot).includes("fresh-v2"),
        `I1: invalidateQueries during an in-flight fetch must trigger a fresh refetch (calls=${midFlightCalls}, text=${collectText(midRoot)})`,
      );

      // I3: V2_PUBLIC_TOOL_DEFINITIONS required metadata + alias-free starter template + clickable parameter pills
      const supersedeDef = V2_PUBLIC_TOOL_DEFINITIONS.find((d) => d.name === "memory_supersede");
      const supersedeSchema = supersedeDef?.inputSchema as unknown as { required?: string[] } | undefined;
      assert.ok(
        Array.isArray(supersedeSchema?.required) &&
          supersedeSchema.required.includes("supersedingRecordId"),
        "I3: memory_supersede inputSchema must declare required: ['supersedingRecordId']",
      );
      const mcpRegContainer = new DomNode("div");
      const mcpRegClient = new TanStackQuery.QueryClient();
      ReactDOM.createRoot(mcpRegContainer).render(
        React.createElement(
          TanStackQuery.QueryClientProvider,
          { client: mcpRegClient },
          React.createElement(Views.McpConsoleView, { projectRoot: fixture.projectRoot }),
        ),
      );
      await flushAsync();
      const mcpSel = findAll(mcpRegContainer, (el) => el.id === "mcp-tool-select")[0]!;
      mcpSel.value = "memory_supersede";
      mcpSel.dispatch("change");
      await flushAsync();
      const mcpArgs = findAll(mcpRegContainer, (el) => el.id === "mcp-tool-args")[0]!;
      const parsedStarter = JSON.parse(mcpArgs.value) as Record<string, unknown>;
      assert.ok(
        "recordId" in parsedStarter && "supersedingRecordId" in parsedStarter && !("id" in parsedStarter),
        `I3: memory_supersede starter JSON must include recordId + supersedingRecordId and omit alias 'id' (got ${mcpArgs.value})`,
      );
      // Clear args to {}, then click the 'reason' parameter pill button -> inserts "reason"
      mcpArgs.value = "{}";
      mcpArgs.dispatch("input");
      await flushAsync();
      const reasonPillBtn = findAll(
        mcpRegContainer,
        (el) => el.tagName === "BUTTON" && collectText(el).trim().startsWith("reason"),
      )[0];
      assert.ok(reasonPillBtn, "I3: Parameter pills in McpConsoleView must be clickable <button> elements");
      reasonPillBtn!.dispatch("click");
      await flushAsync();
      assert.ok(
        mcpArgs.value.includes('"reason"'),
        `I3: Clicking 'reason' parameter pill must insert "reason" key into #mcp-tool-args (got ${mcpArgs.value})`,
      );

      // I4: Thai IME keydown Enter guard in Curator chat textarea
      curatorChatCalls.length = 0;
      const imeCurContainer = new DomNode("div");
      const imeCurClient = new TanStackQuery.QueryClient();
      ReactDOM.createRoot(imeCurContainer).render(
        React.createElement(
          TanStackQuery.QueryClientProvider,
          { client: imeCurClient },
          React.createElement(Views.CuratorStudioView, { projectRoot: fixture.projectRoot }),
        ),
      );
      await flushAsync();
      const imeTextarea = findAll(imeCurContainer, (el) => el.id === "curator-chat-input")[0]!;
      imeTextarea.value = "ตรวจสุขภาพ";
      imeTextarea.dispatch("input");
      await flushAsync();
      imeTextarea.dispatch("compositionstart");
      imeTextarea.dispatch("keydown", { key: "Enter", shiftKey: false, isComposing: true });
      await flushAsync();
      assert.equal(
        curatorChatCalls.length,
        0,
        "I4: Pressing Enter during active Thai IME composition must NOT submit Curator chat",
      );
      imeTextarea.dispatch("compositionend");
      await flushAsync();
      imeTextarea.dispatch("keydown", { key: "Enter", shiftKey: false, isComposing: false });
      await flushAsync();
      assert.equal(
        curatorChatCalls.length,
        1,
        "I4: Pressing Enter after compositionend must submit Curator chat normally",
      );

      // I6: Curator explicit write prefix beats interrogative body, 'เท่าไหร่' is interrogative, and clean autoCurate omits sessionStart/End in executedTools
      const curator = new V2MemoryCuratorAgent(fixture.foundation);
      const adrWithQuestion = await curator.chat({
        message: "บันทึก ADR: ควรใช้ Redis ไหม? สรุปใช้ SQLite",
        autoExecute: false,
      });
      assert.equal(
        adrWithQuestion.intent,
        "write_adr",
        "I6: Explicit 'บันทึก ADR: ...' command containing '?' or 'ไหม' in body must still match write_adr",
      );
      const howManyApproved = await curator.chat({ message: "อนุมัติไปเท่าไหร่" });
      assert.equal(
        howManyApproved.intent,
        "audit",
        "I6: Thai question 'อนุมัติไปเท่าไหร่' must route to read-only audit, never auto_curate",
      );

      const cleanFixture = await createActiveStoreFixture("pm-v2-clean-curator-");
      try {
        const cleanCurator = new V2MemoryCuratorAgent(cleanFixture.foundation);
        const cleanChat = await cleanCurator.chat({ message: "จัดระเบียบความจำ" });
        assert.equal(cleanChat.intent, "auto_curate");
        assert.ok(
          !cleanChat.executedTools.includes("memory_sessionStart") &&
            !cleanChat.executedTools.includes("memory_sessionEnd"),
          `I6: Clean-vault noop auto_curate must NOT claim memory_sessionStart/End in executedTools: ${JSON.stringify(cleanChat.executedTools)}`,
        );
      } finally {
        await cleanFixture.cleanup();
      }
    });
  } finally {
    await serverHandle.close();
    await fixture.cleanup();
  }
});


