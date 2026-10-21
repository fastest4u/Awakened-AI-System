import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
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
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const deploymentDir = fileURLToPath(new URL("../dist/", import.meta.url));
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const distV2 = join(deploymentDir, "v2.js");
const distV2Admin = join(deploymentDir, "v2-admin.js");
const distBuildManifest = join(deploymentDir, "v2-build.json");

const SCHEMA_IDENTITY_HASH = "f10eb1976f2fd97d899163d930a91e21f66daaccf448a76334d5c9b13ffd6df1";
const OPERATOR_APPROVAL_SECRET = "v2-release-qualification-operator-secret-2026";
const ARCHIVE_SENTINEL = "V1-ARCHIVE-SENTINEL-DO-NOT-READ-994821";

const V2_SUPPORTED_V1_TOOLS = [
  "memory_search",
  "memory_get",
  "memory_list",
  "memory_recent",
  "memory_contextPack",
  "memory_followUpRadar",
  "memory_writeSessionLog",
  "memory_writeInsight",
  "memory_writeMistake",
  "memory_writeADR",
  "memory_sessionStart",
  "memory_sessionEnd",
  "memory_lifecycleStatus",
  "memory_selfCheck",
  "memory_awaken",
  "memory_verifyVault",
  "memory_verifyNote",
  "memory_verifySourceTruth",
  "memory_findDuplicates",
  "memory_checkStaleness",
];

const V2_SUPERSEDED_V1_TOOLS = {
  memory_bootstrapProject: { supersededBy: "v2-admin.js initialize-fresh" },
  memory_reindex: { supersededBy: "v2-admin.js rebuild-projections" },
  memory_indexNote: { supersededBy: "v2-admin.js rebuild-projections" },
  memory_diagnoseWorkspace: { supersededBy: "v2-admin.js status" },
};

const V2_UNAVAILABLE_V1_TOOLS = [
  "memory_createFromTemplate",
  "memory_findBrokenLinks",
  "memory_validateFrontmatter",
  "memory_fixFrontmatter",
  "memory_migrateFrontmatter",
  "memory_compactVault",
  "memory_export",
  "memory_import",
];

const V2_V1_PARITY_CLASSIFICATION = {
  ...Object.fromEntries(V2_SUPPORTED_V1_TOOLS.map((name) => [name, { status: "V2-supported" }])),
  ...Object.fromEntries(
    Object.entries(V2_SUPERSEDED_V1_TOOLS).map(([name, info]) => [
      name,
      { status: "superseded", supersededBy: info.supersededBy },
    ]),
  ),
  ...Object.fromEntries(V2_UNAVAILABLE_V1_TOOLS.map((name) => [name, { status: "unavailable" }])),
};

const V2_NATIVE_TOOLS = [
  "memory_v2Status",
  "memory_checkpoint",
  "memory_recoverSession",
  "memory_sessionFork",
  "memory_recordChildResult",
  "memory_completeChildSession",
  "memory_amendSessionEnd",
  "memory_cancelSessionEnd",
  "memory_recordEvidenceBatch",
  "memory_promote",
  "memory_supersede",
  "memory_retract",
  "memory_expire",
  "memory_forgetEvidence",
];

const V2_PRODUCTION_CAPABILITIES = {
  profile: "fresh-start",
  version: 1,
  content: "governed-v2",
  tools: [...V2_SUPPORTED_V1_TOOLS, ...V2_NATIVE_TOOLS],
  v1Parity: V2_V1_PARITY_CLASSIFICATION,
};

const V2_PRODUCTION_RECOVERY_POLICY = {
  profile: "fresh-start",
  version: 1,
  productionReady: true,
  promotion: "operator-approved",
};

const ALL_SCENARIO_IDS = [
  "scenario-1-empty-start-write-restart-retrieval",
  "scenario-2-public-workflows-and-governance",
  "scenario-3-v1-archive-isolation-and-path-overlap",
  "scenario-4-binding-capability-and-generation-refusals",
  "scenario-5-crash-recovery-and-idempotent-fencing",
  "scenario-6-verified-backup-isolated-restore-replay-and-rollback",
  "scenario-7-privacy-redaction-encryption-key-rotation-and-erasure-after-restore",
  "scenario-8-bounded-failures-and-operational-limits",
];

function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Object.is(value, -0) ? "0" : JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  throw new TypeError("Unsupported canonicalJson value");
}

function sha256(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function computeReleaseEvidenceReportDigest(reportWithoutDigest) {
  const { reportDigest: _ignored, ...rest } = reportWithoutDigest;
  return sha256({
    domain: "v2-fresh-start-release-evidence-v1",
    ...rest,
  });
}

function createFixture(prefix, buildIdentityHash) {
  const baseTemp = realpathSync.native(tmpdir());
  const rootDir = realpathSync.native(mkdtempSync(join(baseTemp, `v2-rel-gate-${prefix}-`)));
  const projectRoot = join(rootDir, "project");
  const v1ArchiveRoot = join(projectRoot, "archive");
  const v2VaultRoot = join(projectRoot, "memory-v2");
  mkdirSync(v1ArchiveRoot, { recursive: true });
  const sentinelPath = join(v1ArchiveRoot, "sentinel.txt");
  writeFileSync(sentinelPath, ARCHIVE_SENTINEL, "utf8");

  const monitorPath = join(rootDir, "monitor.cjs");
  const accessLogPath = join(rootDir, "archive-access.log");
  writeFileSync(
    monitorPath,
    `const fs=require('node:fs'),p=require('node:path'),u=require('node:url');
const archive=${JSON.stringify(v1ArchiveRoot.toLowerCase())},log=${JSON.stringify(accessLogPath)},append=fs.appendFileSync.bind(fs);
function check(x){if(x instanceof URL)x=u.fileURLToPath(x);if(typeof x!=='string'&&!Buffer.isBuffer(x))return;
const v=p.resolve(String(x)).toLowerCase();if(v===archive||v.startsWith(archive+p.sep)){append(log,'access\\n');throw Error('ARCHIVE_ACCESS_DENIED');}}
for(const n of ['readFileSync','readFile','readdirSync','readdir','opendirSync','opendir','openSync','open','createReadStream','writeFileSync','writeFile','appendFileSync','appendFile','createWriteStream']){const original=fs[n];fs[n]=function(x,...a){check(x);return original.call(this,x,...a)}}
for(const n of ['readFile','readdir','opendir','open','writeFile','appendFile']){const original=fs.promises[n];fs.promises[n]=function(x,...a){check(x);return original.call(this,x,...a)}}
require('node:module').syncBuiltinESMExports();`,
    "utf8",
  );

  const releaseId = randomUUID();
  const capabilityManifestHash = sha256(V2_PRODUCTION_CAPABILITIES);
  const recoveryPolicyHash = sha256(V2_PRODUCTION_RECOVERY_POLICY);

  const unsignedEvidence = {
    schemaVersion: 1,
    status: "ready-for-activation",
    productionReady: true,
    releaseId,
    buildIdentityHash,
    schemaIdentityHash: SCHEMA_IDENTITY_HASH,
    capabilityManifestHash,
    recoveryPolicyHash,
    scenarios: ALL_SCENARIO_IDS.map((id) => ({ id, passed: true })),
    generatedAt: new Date().toISOString(),
  };
  const evidenceDigest = computeReleaseEvidenceReportDigest(unsignedEvidence);
  const evidenceReport = {
    ...unsignedEvidence,
    reportDigest: evidenceDigest,
  };
  const evidencePath = join(rootDir, "release-evidence.json");
  writeFileSync(evidencePath, `${canonicalJson(evidenceReport)}\n`, "utf8");

  const releaseManifestPath = join(rootDir, "release.json");
  const releaseManifest = {
    initializationId: randomUUID(),
    release: {
      profileVersion: 1,
      releaseId,
      buildIdentityHash,
      schemaIdentityHash: SCHEMA_IDENTITY_HASH,
      configurationHash: sha256({
        projectRoot,
        v2VaultRoot,
        v1ArchiveRoot,
        releaseId,
      }),
      capabilityManifestHash,
      recoveryPolicyHash,
      evidenceDigest,
      createdAt: new Date().toISOString(),
    },
  };
  writeFileSync(releaseManifestPath, `${canonicalJson(releaseManifest)}\n`, "utf8");

  const env = {
    ...process.env,
    MEMORY_PROJECT_ROOT: projectRoot,
    MEMORY_V2_VAULT_PATH: v2VaultRoot,
    MEMORY_V1_ARCHIVE_PATH: v1ArchiveRoot,
    MEMORY_V2_RELEASE_ID: releaseId,
    MEMORY_V2_OPERATOR_APPROVAL_KEY: OPERATOR_APPROVAL_SECRET,
  };

  const baseAdminFlags = [
    "--project-root",
    projectRoot,
    "--v2-vault-root",
    v2VaultRoot,
    "--v1-archive-root",
    v1ArchiveRoot,
    "--release-manifest",
    releaseManifestPath,
  ];

  function runAdmin(subcommand, extraFlags = [], options = {}) {
    const useMonitor = options.useMonitor ?? true;
    const nodeArgs = useMonitor
      ? ["--require", monitorPath, distV2Admin, subcommand, ...extraFlags]
      : [distV2Admin, subcommand, ...extraFlags];
    return spawnSync(process.execPath, nodeArgs, {
      cwd: repoRoot,
      env: options.env ?? env,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
  }

  function initializeAndActivate() {
    const initRes = runAdmin("initialize-fresh", baseAdminFlags);
    assert.equal(initRes.status, 0, `initialize-fresh failed: ${initRes.stderr}`);
    const approvalPath = join(rootDir, `approval-${randomUUID()}.json`);
    const signRes = runAdmin("sign-approval", [
      ...baseAdminFlags,
      "--next-mode",
      "active",
      "--output",
      approvalPath,
    ]);
    assert.equal(signRes.status, 0, `sign-approval failed: ${signRes.stderr}`);
    const actRes = runAdmin("activate", [
      ...baseAdminFlags,
      "--operator-approval",
      approvalPath,
      "--release-evidence",
      evidencePath,
    ]);
    assert.equal(actRes.status, 0, `activate failed: ${actRes.stderr}`);
    const status = JSON.parse(actRes.stdout);
    assert.equal(status.mode, "active");
    assert.equal(status.productionReady, true);
    return status;
  }

  async function withMcpSession(fn, options = {}) {
    const useMonitor = options.useMonitor ?? true;
    const nodeArgs = useMonitor ? ["--require", monitorPath, distV2] : [distV2];
    const child = spawn(process.execPath, nodeArgs, {
      cwd: repoRoot,
      env: options.env ?? env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let pending = "";
    let nextId = 0;
    const replies = new Map();
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      pending += chunk;
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const response = JSON.parse(line);
          replies.get(response.id)?.resolve(response);
        } catch (err) {
          for (const waiter of replies.values()) waiter.reject(err);
        }
      }
    });
    child.on("error", (error) => {
      for (const waiter of replies.values()) waiter.reject(error);
    });
    child.on("exit", (code) => {
      for (const waiter of replies.values()) {
        waiter.reject(new Error(`v2.js exited with ${code}: ${stderr}`));
      }
    });

    async function rpc(method, params) {
      const id = ++nextId;
      try {
        return await new Promise((resolveReply, rejectReply) => {
          const timer = setTimeout(
            () => rejectReply(new Error(`MCP timeout on ${method}: ${stderr}`)),
            20_000,
          );
          replies.set(id, {
            resolve(val) {
              clearTimeout(timer);
              resolveReply(val);
            },
            reject(err) {
              clearTimeout(timer);
              rejectReply(err);
            },
          });
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
      } finally {
        replies.delete(id);
      }
    }

    async function callTool(name, args = {}) {
      const response = await rpc("tools/call", { name, arguments: args });
      if (response.error) {
        const err = new Error(response.error.message || "MCP tool error");
        err.code = response.error.data?.code ?? response.error.message;
        err.data = response.error.data;
        throw err;
      }
      return JSON.parse(response.result.content[0].text);
    }

    try {
      await rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "v2-release-verifier", version: "1.0.0" },
      });
      child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      const result = await fn({ rpc, callTool, child });
      assert.ok(!stdout.includes(ARCHIVE_SENTINEL) && !stderr.includes(ARCHIVE_SENTINEL));
      return result;
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.stdin.end();
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
        try {
          await exited;
        } finally {
          clearTimeout(killTimer);
        }
      }
    }
  }

  function cleanup() {
    try {
      chmodSync(sentinelPath, 0o666);
    } catch {
      // Ignore
    }
    rmSync(rootDir, { recursive: true, force: true });
  }

  return {
    rootDir,
    projectRoot,
    v1ArchiveRoot,
    v2VaultRoot,
    sentinelPath,
    monitorPath,
    accessLogPath,
    releaseId,
    evidencePath,
    releaseManifestPath,
    baseAdminFlags,
    env,
    runAdmin,
    initializeAndActivate,
    withMcpSession,
    cleanup,
  };
}

async function runScenario1(buildIdentityHash) {
  const f = createFixture("s1", buildIdentityHash);
  try {
    const activeStatus = f.initializeAndActivate();
    assert.equal(activeStatus.mode, "active");
    assert.equal(activeStatus.productionReady, true);

    let writtenInsightId = "";
    await f.withMcpSession(async ({ rpc, callTool }) => {
      const toolsResp = await rpc("tools/list", {});
      assert.equal(toolsResp.result.tools.length, 34);

      // Deterministic empty reads before first write
      const emptySearch = await callTool("memory_search", { query: "FreshStartArchitecture" });
      assert.deepEqual(emptySearch.items, []);
      const emptyList = await callTool("memory_list", { limit: 10 });
      assert.deepEqual(emptyList.items, []);
      const emptyRecent = await callTool("memory_recent", { limit: 10 });
      assert.deepEqual(emptyRecent.items, []);
      const emptyPack = await callTool("memory_contextPack", { area: "FreshStartArchitecture" });
      assert.equal(emptyPack.ok, true);
      const emptyRadar = await callTool("memory_followUpRadar", { limit: 5 });
      assert.deepEqual(emptyRadar.items, []);

      // First session start and first durable write
      const session = await callTool("memory_sessionStart", {
        agentName: "scenario-1-agent",
        taskDescription: "First durable write and read-after-write verification",
      });
      assert.equal(typeof session.sessionId, "string");

      const created = await callTool("memory_writeInsight", {
        sessionId: session.sessionId,
        title: "FreshStartArchitecture Primary Insight",
        summary: "V2 fresh start writes event-sourced governed notes and publishes Schema 3 projections.",
        content: "# FreshStartArchitecture\n\nDurable body content verified on read-after-write.",
        confidence: "high",
      });
      writtenInsightId = created.recordId;
      assert.equal(typeof writtenInsightId, "string");

      // Immediate read-after-write
      const got = await callTool("memory_get", { id: writtenInsightId });
      assert.equal(got.id, writtenInsightId);
      assert.ok(got.content.body.includes("Durable body content verified on read-after-write."));
    });

    // Restart server (new process) and retrieve from a later session
    await f.withMcpSession(async ({ callTool }) => {
      const session2 = await callTool("memory_sessionStart", {
        agentName: "scenario-1-later-session",
        taskDescription: "Retrieve durable note after server restart",
      });
      assert.equal(typeof session2.sessionId, "string");

      const searchAfterRestart = await callTool("memory_search", {
        query: "FreshStartArchitecture",
      });
      assert.ok(searchAfterRestart.items.some((item) => item.id === writtenInsightId));

      const gotAfterRestart = await callTool("memory_get", { id: writtenInsightId });
      assert.equal(gotAfterRestart.id, writtenInsightId);
      assert.ok(
        gotAfterRestart.content.body.includes("Durable body content verified on read-after-write."),
      );
    });
    assert.equal(existsSync(f.accessLogPath), false);
  } finally {
    f.cleanup();
  }
}

async function runScenario2(buildIdentityHash) {
  const f = createFixture("s2", buildIdentityHash);
  try {
    f.initializeAndActivate();
    await f.withMcpSession(async ({ callTool }) => {
      const started = await callTool("memory_sessionStart", {
        agentName: "scenario-2-agent",
        taskDescription: "Complete session, checkpoint, child saga, and governance workflows",
      });
      const sessionId = started.sessionId;

      // Idempotent write retry returns identical recordId
      const idempotencyKey = `s2-insight-${randomUUID()}`;
      const insight1 = await callTool("memory_writeInsight", {
        sessionId,
        idempotencyKey,
        title: "Idempotent Governed Insight",
        summary: "Testing retry stability.",
        content: "# Idempotent\n\nBody text.",
      });
      const insight2 = await callTool("memory_writeInsight", {
        sessionId,
        idempotencyKey,
        title: "Idempotent Governed Insight",
        summary: "Testing retry stability.",
        content: "# Idempotent\n\nBody text.",
      });
      assert.equal(insight1.recordId, insight2.recordId);

      const mistake = await callTool("memory_writeMistake", {
        sessionId,
        title: "Governed Mistake Note",
        summary: "Mistake summary for retraction test.",
        content: "# Mistake\n\nMistake details.",
      });
      const adr = await callTool("memory_writeADR", {
        sessionId,
        title: "Governed ADR Note",
        summary: "ADR summary.",
        content: "# ADR\n\nDecision details.",
      });
      const sessionLog = await callTool("memory_writeSessionLog", {
        sessionId,
        title: "Governed Session Log",
        summary: "Session log summary.",
        content: "# Session Log\n\nLog details.",
      });

      // Promote, supersede, retract, expire
      const promoted = await callTool("memory_promote", {
        recordId: insight1.recordId,
        verificationMethod: "manual-review",
        reason: "Promote primary insight",
      });
      assert.equal(promoted.status, "active");

      await callTool("memory_promote", {
        recordId: adr.recordId,
        verificationMethod: "manual-review",
        reason: "Promote replacement record",
      });
      const superseded = await callTool("memory_supersede", {
        recordId: insight1.recordId,
        supersedingRecordId: adr.recordId,
        reason: "Superseded by ADR",
      });
      assert.equal(superseded.status, "superseded");

      const retracted = await callTool("memory_retract", {
        recordId: mistake.recordId,
        reason: "Retracted mistake",
      });
      assert.equal(retracted.status, "retracted");

      const expired = await callTool("memory_expire", {
        recordId: sessionLog.recordId,
        validTo: new Date(Date.now() + 60_000).toISOString(),
        reason: "Expired session log",
      });
      assert.equal(expired.status, "expired");

      // Verification tools
      assert.equal((await callTool("memory_verifyVault", {})).ok, true);
      assert.equal((await callTool("memory_verifyNote", { id: adr.recordId })).ok, true);
      assert.equal((await callTool("memory_verifySourceTruth", {})).ok, true);
      assert.equal((await callTool("memory_findDuplicates", {})).ok, true);
      assert.equal((await callTool("memory_checkStaleness", {})).ok, true);

      // Checkpoint + SessionEnd -> Amend -> Cancel + Child fork/report/complete + Final SessionEnd
      const cp = await callTool("memory_checkpoint", {
        sessionId,
        taskSummary: "Checkpoint before session-end workflow",
      });
      assert.equal(typeof cp.checkpointId, "string");

      const endReq = await callTool("memory_sessionEnd", {
        sessionId,
        summary: "Initial session end request",
      });
      await callTool("memory_amendSessionEnd", {
        sessionId,
        workflowId: endReq.workflowId,
        summary: "Amended session end summary",
      });
      const cancelled = await callTool("memory_cancelSessionEnd", {
        sessionId,
        workflowId: endReq.workflowId,
      });
      assert.equal(cancelled.phase, "cancelled");

      const forked = await callTool("memory_sessionFork", {
        parentSessionId: sessionId,
        summary: "Child task",
        scope: "scenario-2-child",
      });
      const childReport = await callTool("memory_recordChildResult", {
        parentSessionId: sessionId,
        childSessionId: forked.childSessionId,
        outcomeSummary: "Child completed work",
        findings: ["Finding 1"],
      });
      const childDone = await callTool("memory_completeChildSession", {
        parentSessionId: sessionId,
        childSessionId: forked.childSessionId,
        reportId: childReport.reportId,
      });
      assert.equal(childDone.state, "completed");

      const finalEnd = await callTool("memory_sessionEnd", {
        sessionId,
        summary: "Final session end after child completion",
      });
      assert.equal(finalEnd.phase, "requested");
    });
  } finally {
    f.cleanup();
  }
}

async function runScenario3(buildIdentityHash) {
  const f = createFixture("s3", buildIdentityHash);
  try {
    f.initializeAndActivate();

    // Runtime V2 operations never access V1 archive
    await f.withMcpSession(async ({ callTool }) => {
      await callTool("memory_sessionStart", { agentName: "s3-agent" });
      await callTool("memory_writeInsight", {
        title: "Archive Isolation Check",
        summary: "Ensure V1 archive sentinel never appears.",
        content: "# Isolation\n\nClean V2 note.",
      });
      const searchRes = await callTool("memory_search", { query: ARCHIVE_SENTINEL });
      assert.deepEqual(searchRes.items, []);
    });
    assert.equal(existsSync(f.accessLogPath), false);

    // Path overlap refusal when vault overlaps archive
    const overlapRes = f.runAdmin("status", [
      "--project-root",
      f.projectRoot,
      "--v2-vault-root",
      join(f.v1ArchiveRoot, "nested-vault"),
      "--v1-archive-root",
      f.v1ArchiveRoot,
      "--release-manifest",
      f.releaseManifestPath,
    ]);
    assert.equal(overlapRes.status, 1);
    assert.match(overlapRes.stderr, /FRESH_START_PATH_OVERLAP/);

    // Explicit operator freeze-v1-archive & verify-v1-archive (run without runtime monitor since these two operator commands intentionally inspect the archive)
    const freezeRes = f.runAdmin(
      "freeze-v1-archive",
      [
        "--project-root",
        f.projectRoot,
        "--v2-vault-root",
        f.v2VaultRoot,
        "--v1-archive-root",
        f.v1ArchiveRoot,
      ],
      { useMonitor: false },
    );
    assert.equal(freezeRes.status, 0, freezeRes.stderr);
    assert.equal(JSON.parse(freezeRes.stdout).ok, true);

    const verifyRes = f.runAdmin(
      "verify-v1-archive",
      [
        "--project-root",
        f.projectRoot,
        "--v2-vault-root",
        f.v2VaultRoot,
        "--v1-archive-root",
        f.v1ArchiveRoot,
      ],
      { useMonitor: false },
    );
    assert.equal(verifyRes.status, 0, verifyRes.stderr);
    const verifyPayload = JSON.parse(verifyRes.stdout);
    assert.equal(verifyPayload.ok, true);
    assert.equal(verifyPayload.writeDenied, true);
  } finally {
    f.cleanup();
  }
}

async function runScenario4(buildIdentityHash) {
  const f = createFixture("s4", buildIdentityHash);
  try {
    f.initializeAndActivate();

    // 1. Wrong releaseId on startup is refused with FRESH_START_RELEASE_MISMATCH
    const wrongReleaseRes = spawnSync(process.execPath, [distV2], {
      cwd: repoRoot,
      env: { ...f.env, MEMORY_V2_RELEASE_ID: randomUUID() },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(wrongReleaseRes.status, 1);
    assert.match(wrongReleaseRes.stderr, /FRESH_START_RELEASE_MISMATCH/);

    // 2. Stale control generation / reused approval envelope is refused
    const staleApprovalPath = join(f.rootDir, "stale-approval.json");
    assert.equal(
      f.runAdmin("sign-approval", [
        ...f.baseAdminFlags,
        "--next-mode",
        "read-only-recovery",
        "--output",
        staleApprovalPath,
      ]).status,
      0,
    );
    assert.equal(
      f.runAdmin("enter-recovery", [
        ...f.baseAdminFlags,
        "--operator-approval",
        staleApprovalPath,
        "--release-evidence",
        f.evidencePath,
      ]).status,
      0,
    );
    // Replaying the same approval on generation 2 fails closed
    const replayRes = f.runAdmin("enter-recovery", [
      ...f.baseAdminFlags,
      "--operator-approval",
      staleApprovalPath,
      "--release-evidence",
      f.evidencePath,
    ]);
    assert.equal(replayRes.status, 1);

    // Exit recovery back to active
    const exitApprovalPath = join(f.rootDir, "exit-approval.json");
    assert.equal(
      f.runAdmin("sign-approval", [
        ...f.baseAdminFlags,
        "--next-mode",
        "active",
        "--output",
        exitApprovalPath,
      ]).status,
      0,
    );
    assert.equal(
      f.runAdmin("exit-recovery", [
        ...f.baseAdminFlags,
        "--operator-approval",
        exitApprovalPath,
        "--release-evidence",
        f.evidencePath,
      ]).status,
      0,
    );

    // 3. Foreign session bindings, superseded tools, and unavailable tools are refused
    await f.withMcpSession(async ({ callTool }) => {
      await assert.rejects(
        () => callTool("memory_checkpoint", { sessionId: randomUUID(), taskSummary: "Foreign" }),
        (err) => err.code === "FRESH_START_INPUT_INVALID",
      );
      for (const unavailable of V2_UNAVAILABLE_V1_TOOLS) {
        await assert.rejects(
          () => callTool(unavailable, {}),
          (err) => err.code === "FRESH_START_CAPABILITY_UNAVAILABLE",
        );
      }
      for (const superseded of Object.keys(V2_SUPERSEDED_V1_TOOLS)) {
        await assert.rejects(
          () => callTool(superseded, {}),
          (err) => err.code === "FRESH_START_OPERATOR_ONLY_TOOL",
        );
      }
    });
  } finally {
    f.cleanup();
  }
}

async function runScenario5(buildIdentityHash) {
  const f = createFixture("s5", buildIdentityHash);
  try {
    f.initializeAndActivate();
    let sessionId = "";
    const writeIdempotencyKey = `crash-retry-${randomUUID()}`;
    let committedRecordId = "";

    await f.withMcpSession(async ({ callTool, child }) => {
      const started = await callTool("memory_sessionStart", {
        agentName: "s5-crash-agent",
        taskDescription: "Crash recovery and idempotent fencing",
      });
      sessionId = started.sessionId;
      const written = await callTool("memory_writeInsight", {
        sessionId,
        idempotencyKey: writeIdempotencyKey,
        title: "Committed Before Crash",
        summary: "Committed insight before abrupt process kill.",
        content: "# Crash Test\n\nCommitted content.",
      });
      committedRecordId = written.recordId;
      // Abruptly terminate the server process to simulate post-commit crash
      child.kill("SIGKILL");
    });

    // Reconnect after abrupt crash, recover session, and retry with same idempotencyKey
    await f.withMcpSession(async ({ callTool }) => {
      const recovered = await callTool("memory_recoverSession", {
        sessionId,
        reasonCode: "process-crash-recovery",
      });
      assert.equal(recovered.sessionId, sessionId);

      const retried = await callTool("memory_writeInsight", {
        sessionId,
        idempotencyKey: writeIdempotencyKey,
        title: "Committed Before Crash",
        summary: "Committed insight before abrupt process kill.",
        content: "# Crash Test\n\nCommitted content.",
      });
      assert.equal(retried.recordId, committedRecordId);
    });

    // Enter read-only-recovery mode and verify write fencing while reads remain available
    const recApproval = join(f.rootDir, "s5-rec-approval.json");
    assert.equal(
      f.runAdmin("sign-approval", [
        ...f.baseAdminFlags,
        "--next-mode",
        "read-only-recovery",
        "--output",
        recApproval,
      ]).status,
      0,
    );
    assert.equal(
      f.runAdmin("enter-recovery", [
        ...f.baseAdminFlags,
        "--operator-approval",
        recApproval,
        "--release-evidence",
        f.evidencePath,
      ]).status,
      0,
    );

    await f.withMcpSession(async ({ callTool }) => {
      await assert.rejects(
        () =>
          callTool("memory_writeInsight", {
            sessionId,
            title: "Should Be Fenced",
            summary: "Denied in recovery",
            content: "# Denied",
          }),
        (err) => err.code === "FRESH_START_ADMISSION_DENIED",
      );
      const got = await callTool("memory_get", { id: committedRecordId });
      assert.equal(got.id, committedRecordId);
    });
  } finally {
    f.cleanup();
  }
}

async function runScenario6(buildIdentityHash) {
  const f = createFixture("s6", buildIdentityHash);
  try {
    f.initializeAndActivate();
    let preBackupId = "";
    let postBackupId = "";

    await f.withMcpSession(async ({ callTool }) => {
      const started = await callTool("memory_sessionStart", {
        agentName: "s6-backup-agent",
      });
      const pre = await callTool("memory_writeInsight", {
        sessionId: started.sessionId,
        title: "Pre-Backup Insight",
        summary: "Created before backup.",
        content: "# Pre-Backup\n\nIncluded in snapshot.",
      });
      preBackupId = pre.recordId;
    });

    const backupRoot = join(f.rootDir, "backup-snapshot");
    const backupRes = f.runAdmin("backup", [
      "--project-root",
      f.projectRoot,
      "--v2-vault-root",
      f.v2VaultRoot,
      "--v1-archive-root",
      f.v1ArchiveRoot,
      "--backup-root",
      backupRoot,
    ]);
    assert.equal(backupRes.status, 0, backupRes.stderr);

    await f.withMcpSession(async ({ callTool }) => {
      const post = await callTool("memory_writeInsight", {
        title: "Post-Backup Insight",
        summary: "Created after backup for replay.",
        content: "# Post-Backup\n\nReplayed during isolated restore.",
      });
      postBackupId = post.recordId;
    });

    // 1. Isolated restore with full post-backup replay
    const restoredProject1 = join(f.rootDir, "restored-full");
    const restoredVault1 = join(restoredProject1, "memory-v2");
    const restoreFullRes = f.runAdmin("restore", [
      "--project-root",
      restoredProject1,
      "--v2-vault-root",
      restoredVault1,
      "--v1-archive-root",
      f.v1ArchiveRoot,
      "--backup-root",
      backupRoot,
      "--post-backup-vault-root",
      f.v2VaultRoot,
    ]);
    assert.equal(restoreFullRes.status, 0, restoreFullRes.stderr);
    const restoreFullReceipt = JSON.parse(restoreFullRes.stdout);
    assert.equal(restoreFullReceipt.status, "active");
    assert.ok(restoreFullReceipt.replayedEventsCount > 0);
    assert.ok(preBackupId && postBackupId);

    // 2. Verify recovery & compatible software rollback check
    const verifyRecRes = f.runAdmin("verify-recovery", [
      "--project-root",
      f.projectRoot,
      "--v2-vault-root",
      f.v2VaultRoot,
      "--v1-archive-root",
      f.v1ArchiveRoot,
    ]);
    assert.equal(verifyRecRes.status, 0, verifyRecRes.stderr);
    assert.equal(JSON.parse(verifyRecRes.stdout).rollback.compatible, true);

    // 3. Incomplete recovery fence keeps restored store in read-only-recovery and reports missingRange
    const restoredProject2 = join(f.rootDir, "restored-incomplete");
    const restoredVault2 = join(restoredProject2, "memory-v2");
    const restoreIncompleteRes = f.runAdmin("restore", [
      "--project-root",
      restoredProject2,
      "--v2-vault-root",
      restoredVault2,
      "--v1-archive-root",
      f.v1ArchiveRoot,
      "--backup-root",
      backupRoot,
      "--recovery-position",
      "999",
      "--recovery-hash",
      "e".repeat(64),
    ]);
    assert.equal(restoreIncompleteRes.status, 0, restoreIncompleteRes.stderr);
    const incompleteReceipt = JSON.parse(restoreIncompleteRes.stdout);
    assert.equal(incompleteReceipt.status, "incomplete-fence");
    assert.ok(incompleteReceipt.missingRange);
  } finally {
    f.cleanup();
  }
}

async function runScenario7(buildIdentityHash) {
  const f = createFixture("s7", buildIdentityHash);
  try {
    f.initializeAndActivate();
    const rawSecret = "fixture_secret_SUPER_CONFIDENTIAL_TOKEN_777";
    let erasedEvidenceId = "";
    let noteId = "";

    await f.withMcpSession(async ({ callTool }) => {
      const started = await callTool("memory_sessionStart", {
        agentName: "s7-privacy-agent",
      });
      const batch = await callTool("memory_recordEvidenceBatch", {
        sessionId: started.sessionId,
        content: `Evidence containing ${rawSecret} that must be redacted before storage.`,
      });
      erasedEvidenceId = batch.evidenceIds[0];

      const note = await callTool("memory_writeInsight", {
        sessionId: started.sessionId,
        title: "Privacy Governed Insight",
        summary: "Cites evidence that will be cryptographically forgotten after backup.",
        content: "# Privacy Insight\n\nBody backed by erasable evidence.",
        provenance: [{ kind: "retained-evidence", identity: erasedEvidenceId }],
      });
      noteId = note.recordId;
    });

    // Verify raw secret never appears in raw SQLite bytes
    const eventsSqliteBytes = readFileSync(
      join(f.v2VaultRoot, ".memory-mcp", "v2", "events.sqlite"),
    );
    assert.equal(eventsSqliteBytes.includes(Buffer.from(rawSecret, "utf8")), false);

    // Take backup BEFORE erasure
    const preErasureBackup = join(f.rootDir, "pre-erasure-backup");
    assert.equal(
      f.runAdmin("backup", [
        "--project-root",
        f.projectRoot,
        "--v2-vault-root",
        f.v2VaultRoot,
        "--v1-archive-root",
        f.v1ArchiveRoot,
        "--backup-root",
        preErasureBackup,
      ]).status,
      0,
    );

    // Now erase the evidence on the live store and verify key rotation
    await f.withMcpSession(async ({ callTool }) => {
      const forgetRes = await callTool("memory_forgetEvidence", {
        evidenceIds: [erasedEvidenceId],
        reason: "User requested erasure under Scenario 7",
      });
      assert.equal(forgetRes.forgotten, true);
      assert.ok(forgetRes.erasedEvidenceIds.includes(erasedEvidenceId));

      const rotateRes = await callTool("memory_forgetEvidence", {
        reason: "Rotate evidence wrap key under Scenario 7",
      });
      assert.equal(rotateRes.forgotten, true);
      assert.ok(rotateRes.activeKeyRef);
    });

    // Restore from the pre-erasure backup + post-backup vault and verify erasure remains effective after restore
    const restoredProject = join(f.rootDir, "restored-after-erasure");
    const restoredVault = join(restoredProject, "memory-v2");
    const restoreRes = f.runAdmin("restore", [
      "--project-root",
      restoredProject,
      "--v2-vault-root",
      restoredVault,
      "--v1-archive-root",
      f.v1ArchiveRoot,
      "--backup-root",
      preErasureBackup,
      "--post-backup-vault-root",
      f.v2VaultRoot,
    ]);
    assert.equal(restoreRes.status, 0, restoreRes.stderr);
    const restoreReceipt = JSON.parse(restoreRes.stdout);
    assert.ok(restoreReceipt.erasedEvidenceIdsApplied.includes(erasedEvidenceId));

    // Verify the note backed by erased evidence is tombstoned in the restored store's Projection Schema 3
    const restoredEnv = {
      ...f.env,
      MEMORY_PROJECT_ROOT: restoredProject,
      MEMORY_V2_VAULT_PATH: restoredVault,
    };
    await f.withMcpSession(
      async ({ callTool }) => {
        const gotErased = await callTool("memory_get", { id: noteId });
        assert.equal(gotErased.ok, false);
        assert.equal(gotErased.found, false);
        const searchErased = await callTool("memory_search", {
          query: "Privacy Governed Insight",
        });
        assert.deepEqual(searchErased.items, []);
      },
      { env: restoredEnv },
    );
  } finally {
    f.cleanup();
  }
}

async function runScenario8(buildIdentityHash) {
  const f = createFixture("s8", buildIdentityHash);
  try {
    f.initializeAndActivate();

    await f.withMcpSession(async ({ callTool }) => {
      await callTool("memory_sessionStart", { agentName: "s8-limits-agent" });
      await callTool("memory_writeInsight", {
        title: "Operational Limits Insight",
        summary: "Testing bounded projection rebuild and operational limits.",
        content: "# Operational Limits\n\nBody.",
      });

      // Malformed / invalid inputs fail closed with bounded error codes
      await assert.rejects(
        () => callTool("memory_v2Status", { unexpectedArg: "rejected" }),
        (err) => err.code === "FRESH_START_INPUT_INVALID",
      );
      await assert.rejects(
        () => callTool("memory_get", { id: "" }),
        (err) => err.code === "FRESH_START_INPUT_INVALID",
      );
      await assert.rejects(
        () => callTool("memory_promote", { recordId: "" }),
        (err) => err.code === "FRESH_START_INPUT_INVALID",
      );
    });

    // Bounded projection rebuild via v2-admin.js rebuild-projections
    const rebuildRes = f.runAdmin("rebuild-projections", [
      "--project-root",
      f.projectRoot,
      "--v2-vault-root",
      f.v2VaultRoot,
      "--v1-archive-root",
      f.v1ArchiveRoot,
    ]);
    assert.equal(rebuildRes.status, 0, rebuildRes.stderr);
    const rebuildJson = JSON.parse(rebuildRes.stdout);
    assert.equal(rebuildJson.ok, true);
    assert.equal(rebuildJson.schemaVersion, 3);

    // Client config generation for all 7 clients
    const configOutDir = join(f.rootDir, "client-configs");
    const genRes = f.runAdmin("generate-client-configs", [
      "--project-root",
      f.projectRoot,
      "--v2-vault-root",
      f.v2VaultRoot,
      "--v1-archive-root",
      f.v1ArchiveRoot,
      "--release-id",
      f.releaseId,
      "--output-dir",
      configOutDir,
    ]);
    assert.equal(genRes.status, 0, genRes.stderr);
    const genJson = JSON.parse(genRes.stdout);
    assert.equal(genJson.ok, true);
    assert.equal(Object.keys(genJson.clients).length, 7);
  } finally {
    f.cleanup();
  }
}

async function main() {
  let outputPath = null;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === "--output" && args[i + 1]) {
      outputPath = isAbsolute(args[i + 1]) ? args[i + 1] : resolve(process.cwd(), args[i + 1]);
    } else {
      throw new Error(`Invalid arguments: ${args.join(" ")}`);
    }
  }

  for (const rel of [
    "v2.js",
    "v2-admin.js",
    "v2-build.json",
    "workers/project-store.worker.js",
    "internal/v2-internal-verified-read.js",
    "internal/v2-internal-verified-read-cleanup.js",
  ]) {
    assert.ok(lstatSync(join(deploymentDir, rel)).isFile(), `Missing compiled artifact: ${rel}`);
  }

  const build = JSON.parse(readFileSync(distBuildManifest, "utf8"));
  const buildIdentityHash = build.buildIdentityHash;

  const runners = [
    ["scenario-1-empty-start-write-restart-retrieval", runScenario1],
    ["scenario-2-public-workflows-and-governance", runScenario2],
    ["scenario-3-v1-archive-isolation-and-path-overlap", runScenario3],
    ["scenario-4-binding-capability-and-generation-refusals", runScenario4],
    ["scenario-5-crash-recovery-and-idempotent-fencing", runScenario5],
    ["scenario-6-verified-backup-isolated-restore-replay-and-rollback", runScenario6],
    ["scenario-7-privacy-redaction-encryption-key-rotation-and-erasure-after-restore", runScenario7],
    ["scenario-8-bounded-failures-and-operational-limits", runScenario8],
  ];

  const scenarios = [];
  for (const [id, fn] of runners) {
    await fn(buildIdentityHash);
    scenarios.push({ id, passed: true });
  }

  const unsignedReport = {
    schemaVersion: 1,
    status: "ready-for-activation",
    productionReady: true,
    buildIdentityHash,
    schemaIdentityHash: SCHEMA_IDENTITY_HASH,
    capabilityManifestHash: sha256(V2_PRODUCTION_CAPABILITIES),
    recoveryPolicyHash: sha256(V2_PRODUCTION_RECOVERY_POLICY),
    scenarios,
    generatedAt: new Date().toISOString(),
  };
  const reportDigest = computeReleaseEvidenceReportDigest(unsignedReport);
  const report = {
    ...unsignedReport,
    reportDigest,
  };

  const serialized = `${canonicalJson(report)}\n`;
  if (outputPath) {
    mkdirSync(resolve(outputPath, ".."), { recursive: true });
    writeFileSync(outputPath, serialized, "utf8");
  }
  process.stdout.write(serialized);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
