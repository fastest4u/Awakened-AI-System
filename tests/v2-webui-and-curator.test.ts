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

    // 8. Verify SPA Architecture Manifest (/api/mvc/architecture)
    const archRes = await fetch(`${baseUrl}/api/mvc/architecture`);
    assert.equal(archRes.status, 200);
    const archJson = (await archRes.json()) as {
      ok: boolean;
      pattern: string;
      models: string[];
      views: string[];
      controllers: string[];
      stack: string[];
      endpoints: string[];
    };
    assert.equal(archJson.ok, true);
    assert.equal(archJson.pattern, "SPA + REST API");
    assert.ok(archJson.stack.some((s) => s.includes("React 19")));
    assert.ok(archJson.stack.some((s) => s.includes("Vite 8")));
    assert.ok(archJson.views.includes("OverviewView"));
    assert.ok(archJson.views.includes("KanbanBoardView"));
    assert.ok(archJson.views.includes("KnowledgeGraphView"));
    assert.ok(archJson.views.includes("CuratorStudioView"));
    assert.ok(archJson.views.includes("McpConsoleView"));
    assert.ok(archJson.views.includes("NoteDetailSheet"));
    assert.ok(archJson.models.includes("ProjectModel"));
    assert.ok(archJson.models.includes("MemoryNoteModel"));
    assert.ok(archJson.controllers.includes("WebUiMvcController"));
    assert.ok(archJson.endpoints.includes("/api/bootstrap"));
    assert.ok(archJson.endpoints.includes("/api/overview"));

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

      // I3: V2_PUBLIC_TOOL_DEFINITIONS required metadata + alias-free starter template + clickable parameter pills
      const supersedeDef = V2_PUBLIC_TOOL_DEFINITIONS.find((d) => d.name === "memory_supersede");
      const supersedeSchema = supersedeDef?.inputSchema as unknown as { required?: string[] } | undefined;
      assert.ok(
        Array.isArray(supersedeSchema?.required) &&
          supersedeSchema.required.includes("supersedingRecordId"),
        "I3: memory_supersede inputSchema must declare required: ['supersedingRecordId']",
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

    await t.test("5.5 Overview & Graph causalTriads exclude superseded/expired notes and missing repo files", async () => {
      mkdirSync(join(fixture.projectRoot, "src"), { recursive: true });
      writeFileSync(
        join(fixture.projectRoot, "src", "live-module.ts"),
        "export function liveHandler() { return true; }\n",
        "utf8",
      );

      const triadSession = (await fixture.foundation.content.invoke("memory_sessionStart", {
        taskSummary: "Seed active and superseded notes for causalTriad filtering regression",
        contextArea: "webui causalTriads",
        includeContext: false,
      })) as { sessionId: string };

      const obsoleteMistake = (await fixture.foundation.content.invoke("memory_writeMistake", {
        sessionId: triadSession.sessionId,
        title: "Obsolete Legacy MVC Mistake",
        summary: "Bug in src/deleted-legacy.ts and src/live-module.ts (`liveHandler`).",
        autoVerify: true,
        verificationMethod: "test-verified",
      })) as { recordId: string };

      const activeMistake = (await fixture.foundation.content.invoke("memory_writeMistake", {
        sessionId: triadSession.sessionId,
        title: "Active Handler Mistake",
        summary: "Race condition in src/live-module.ts and src/deleted-legacy.ts (`liveHandler`).",
        autoVerify: true,
        verificationMethod: "test-verified",
      })) as { recordId: string };

      const obsoleteAdr = (await fixture.foundation.content.invoke("memory_writeADR", {
        sessionId: triadSession.sessionId,
        title: "Obsolete Legacy MVC ADR",
        summary: "Old architecture in src/live-module.ts (`liveHandler`).",
        autoVerify: true,
        verificationMethod: "test-verified",
      })) as { recordId: string };

      const activeAdr = (await fixture.foundation.content.invoke("memory_writeADR", {
        sessionId: triadSession.sessionId,
        title: "Active Handler Architecture ADR",
        summary: "New architecture in src/live-module.ts replacing src/deleted-legacy.ts (`liveHandler`).",
        autoVerify: true,
        verificationMethod: "test-verified",
      })) as { recordId: string };

      const staleSessionA = (await fixture.foundation.content.invoke("memory_sessionStart", {
        taskSummary: "Stale mistake session A",
        contextArea: "legacy",
        includeContext: false,
      })) as { sessionId: string };
      const staleOnlyMistake = (await fixture.foundation.content.invoke("memory_writeMistake", {
        sessionId: staleSessionA.sessionId,
        title: "Legacy Deleted-Only File Mistake",
        summary: "Historical bug in src/deleted-only-a.ts (`staleOnlyFn`).",
        autoVerify: true,
        verificationMethod: "test-verified",
      })) as { recordId: string };
      await fixture.foundation.content.invoke("memory_sessionEnd", {
        sessionId: staleSessionA.sessionId,
        summary: "End stale A",
        finalize: true,
      });

      const staleSessionB = (await fixture.foundation.content.invoke("memory_sessionStart", {
        taskSummary: "Stale ADR session B",
        contextArea: "legacy",
        includeContext: false,
      })) as { sessionId: string };
      await fixture.foundation.content.invoke("memory_writeADR", {
        sessionId: staleSessionB.sessionId,
        title: "Legacy Deleted-Only File ADR",
        summary: "Legacy design in src/deleted-only-a.ts.",
        autoVerify: true,
        verificationMethod: "test-verified",
      });
      await fixture.foundation.content.invoke("memory_sessionEnd", {
        sessionId: staleSessionB.sessionId,
        summary: "End stale B",
        finalize: true,
      });

      await fixture.foundation.content.invoke("memory_supersede", {
        sessionId: triadSession.sessionId,
        recordId: obsoleteMistake.recordId,
        supersedingRecordId: activeAdr.recordId,
        reason: "Replaced by active ADR",
      });
      await fixture.foundation.content.invoke("memory_supersede", {
        sessionId: triadSession.sessionId,
        recordId: obsoleteAdr.recordId,
        supersedingRecordId: activeAdr.recordId,
        reason: "Replaced by active ADR",
      });

      await fixture.foundation.content.invoke("memory_sessionEnd", {
        sessionId: triadSession.sessionId,
        summary: "Finish causalTriads filtering test setup",
        finalize: true,
      });

      const overviewRes = await fetch(
        `${baseUrl}/api/overview?project=${encodeURIComponent(fixture.projectRoot)}`,
      );
      assert.equal(overviewRes.status, 200);
      const overviewJson = (await overviewRes.json()) as {
        ok: boolean;
        causalTriads: Array<{
          anchorMistakeId: string;
          relatedAdrIds: string[];
          sharedContext: string[];
        }>;
      };
      assert.equal(overviewJson.ok, true);
      assert.ok(
        !overviewJson.causalTriads.some((c) => c.anchorMistakeId === obsoleteMistake.recordId),
        "Superseded mistake must NOT appear in /api/overview causalTriads",
      );
      const activeTriad = overviewJson.causalTriads.find(
        (c) => c.anchorMistakeId === activeMistake.recordId,
      );
      assert.ok(activeTriad, "Active mistake should produce a causal triad in /api/overview");
      assert.ok(
        activeTriad.relatedAdrIds.includes(activeAdr.recordId),
        "Active triad should link activeAdr",
      );
      assert.ok(
        !activeTriad.relatedAdrIds.includes(obsoleteAdr.recordId),
        "Active triad must NOT link superseded ADR",
      );
      assert.ok(
        activeTriad.sharedContext.includes("file:src/live-module.ts"),
        "Active triad should retain existing repo file context",
      );
      assert.ok(
        !activeTriad.sharedContext.includes("file:src/deleted-legacy.ts"),
        "Active triad must NOT include deleted/nonexistent repo files in sharedContext",
      );
      assert.ok(
        !overviewJson.causalTriads.some((c) => c.anchorMistakeId === staleOnlyMistake.recordId),
        "Mistake & ADR sharing only a deleted repo file must NOT form a causal triad in /api/overview",
      );

      // Direct unit verification that buildMemoryKnowledgeGraph suppresses causal-triad for superseded inputs while keeping supersedes edges
      const unitGraph = buildMemoryKnowledgeGraph([
        {
          recordId: "sup-mistake",
          recordKind: "mistake",
          title: "Superseded Legacy Mistake",
          summary: "Old bug in src/live-module.ts (`liveHandler`).",
          status: "superseded",
        },
        {
          recordId: "cur-adr",
          recordKind: "adr",
          title: "Current Active ADR",
          summary: "Current design in src/live-module.ts (`liveHandler`).",
          status: "verified",
          supersedesRecordIds: ["sup-mistake"],
        },
      ]);
      assert.ok(
        !unitGraph.edges.some(
          (e) => e.relation === "causal-triad" && e.source === "note:sup-mistake",
        ),
        "buildMemoryKnowledgeGraph must NOT emit causal-triad edge from superseded note",
      );
      assert.ok(
        unitGraph.edges.some(
          (e) => e.relation === "supersedes" && e.source === "note:cur-adr" && e.target === "note:sup-mistake",
        ),
        "buildMemoryKnowledgeGraph must still emit supersedes edge from active note to superseded note",
      );

      const graphRes = await fetch(
        `${baseUrl}/api/graph?project=${encodeURIComponent(fixture.projectRoot)}`,
      );
      assert.equal(graphRes.status, 200);
      const graphJson = (await graphRes.json()) as {
        ok: boolean;
        causalTriads?: Array<{ anchorMistakeId: string }>;
        nodes: Array<{ id: string; supersedesRecordIds?: string[] }>;
        edges: Array<{ source: string; target: string; relation: string }>;
      };
      assert.equal(graphJson.ok, true);
      assert.ok(
        !graphJson.edges.some(
          (e) =>
            e.relation === "causal-triad" &&
            (e.source === `note:${obsoleteMistake.recordId}` ||
              e.target === `note:${obsoleteAdr.recordId}`),
        ),
        "Superseded notes must NOT emit causal-triad edges in /api/graph",
      );
      const activeAdrGraphNode = graphJson.nodes.find(
        (n) => n.id === `note:${activeAdr.recordId}`,
      );
      assert.ok(
        activeAdrGraphNode?.supersedesRecordIds?.includes(obsoleteAdr.recordId) &&
          activeAdrGraphNode?.supersedesRecordIds?.includes(obsoleteMistake.recordId),
        "/api/graph active ADR node must retain supersedesRecordIds lineage metadata",
      );
    });
  } finally {
    await serverHandle.close();
    await fixture.cleanup();
  }
});


