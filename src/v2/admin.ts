import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  decodeFreshStartRelease,
  FreshStartError,
  type FreshStartMode,
  type FreshStartRelease,
  type FreshStartTransitionRequest,
} from "../orchestrator/fresh-start/contracts.js";
import { FreshStartControlPlane } from "../orchestrator/fresh-start/fresh-start-control-plane.js";
import {
  FreshStartInitializer,
  type FreshStartInitializeInput,
} from "../orchestrator/fresh-start/fresh-start-initializer.js";
import {
  assertFreshStartPaths,
  canonicalFreshStartPath,
  freshStartPathContains,
  type FreshStartPaths,
} from "../orchestrator/fresh-start/fresh-start-paths.js";
import { SqliteFreshStartRepository } from "../orchestrator/fresh-start/fresh-start.repository.js";
import {
  createHmacOperatorApprovalVerifier,
  createReleaseEvidenceReportVerifier,
  createSignedOperatorApprovalEnvelope,
  freshStartRequestDigest,
} from "../orchestrator/fresh-start/operator-approval.js";
import type { BranchScopeId } from "../orchestrator/identity/contracts.js";
import {
  GitWorkspaceResolver,
  SpawnSyncGitCommandRunner,
} from "../orchestrator/identity/git-workspace.resolver.js";
import { ProjectDescriptorRepository } from "../orchestrator/identity/project-descriptor.repository.js";
import { ImmutableProjectionBuilder } from "../orchestrator/projections/builder.js";
import type { ProjectBinding } from "../orchestrator/projections/contracts.js";
import { V2ProjectionBuildCoordinator } from "../orchestrator/projections/coordinator.js";
import { SqliteProjectionEventReader } from "../orchestrator/projections/event-reader.js";
import { ProjectionIntegrityService } from "../orchestrator/projections/integrity.js";
import {
  resolveVaultStoreInfo,
  V2BackupService,
} from "../orchestrator/recovery/backup.service.js";
import type { BackupTriggerReason } from "../orchestrator/recovery/contracts.js";
import {
  V2RestoreService,
  V2RollbackService,
} from "../orchestrator/recovery/restore.service.js";
import { canonicalJson } from "../orchestrator/serialization/canonical-json.js";
import { CURRENT_PROJECT_STORE_SCHEMA_VERSION } from "../orchestrator/storage/migrations/registry.js";
import { NodeSqliteDriver } from "../orchestrator/storage/node-sqlite-driver.js";
import { inspectV2Build } from "./build-identity.js";
import {
  assertPreparedRelease,
  createV2Foundation,
  ensureProjectV2StoreReady,
  type FreshStartStatus,
} from "./composition.js";
import { isProductionReleaseManifest, loadV2LaunchConfig } from "./config.js";
import { startV2WebUiServer } from "./webui.js";

const FOUNDATION_COMMANDS = ["initialize-fresh", "resume-initialization", "status"] as const;
const TRANSITION_COMMANDS = ["activate", "enter-recovery", "exit-recovery", "disable"] as const;
const ALL_COMMANDS = new Set<string>([
  ...FOUNDATION_COMMANDS,
  ...TRANSITION_COMMANDS,
  "sign-approval",
  "backup",
  "restore",
  "verify-recovery",
  "rebuild-projections",
  "freeze-v1-archive",
  "verify-v1-archive",
  "generate-client-configs",
  "bootstrap-project",
  "sync-build",
  "webui",
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH_REGEX = /^[0-9a-f]{64}$/u;
const DUMMY_UUID = "00000000-0000-4000-8000-000000000000";

function parseFlags(
  argv: readonly string[],
): { command: string; values: Record<string, string> } {
  const [command, ...flags] = argv;
  if (!command || !ALL_COMMANDS.has(command)) {
    throw new FreshStartError("FRESH_START_RELEASE_NOT_READY");
  }
  if (flags.length % 2 !== 0) {
    throw new FreshStartError("FRESH_START_CONFIG_INVALID");
  }
  const values: Record<string, string> = {};
  for (let index = 0; index < flags.length; index += 2) {
    const name = flags[index]!;
    const value = flags[index + 1];
    if (!name.startsWith("--") || Object.hasOwn(values, name) || !value) {
      throw new FreshStartError("FRESH_START_CONFIG_INVALID");
    }
    values[name] = value;
  }
  return { command, values };
}

function assertAllowedFlags(
  values: Record<string, string>,
  requiredFlags: readonly string[],
  optionalFlags: readonly string[] = [],
  nonPathFlags: readonly string[] = [],
): void {
  const allowed = new Set<string>([...requiredFlags, ...optionalFlags]);
  const nonPath = new Set<string>(nonPathFlags);
  for (const req of requiredFlags) {
    if (!Object.hasOwn(values, req)) {
      throw new FreshStartError("FRESH_START_CONFIG_INVALID");
    }
  }
  for (const [key, val] of Object.entries(values)) {
    if (!allowed.has(key)) {
      throw new FreshStartError("FRESH_START_CONFIG_INVALID");
    }
    if (!nonPath.has(key) && !isAbsolute(val)) {
      throw new FreshStartError("FRESH_START_CONFIG_INVALID");
    }
  }
}

function readReleaseManifest(path: string): string {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 16384n) {
    throw new Error();
  }
  const handle = openSync(path, "r");
  try {
    const unchanged = () => {
      for (const actual of [fstatSync(handle, { bigint: true }), lstatSync(path, { bigint: true })]) {
        if (!actual.isFile() || actual.isSymbolicLink() || actual.nlink !== 1n) throw new Error();
        for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const) {
          if (actual[key] !== before[key]) throw new Error();
        }
      }
      if (realpathSync.native(path) !== path) throw new Error();
    };
    // Bind both the single-link requirement and identity to the actual reader,
    // before its first content read, even if the checked pathname was replaced.
    unchanged();
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(handle, bytes, used, bytes.length - used, null);
      if (count === 0) break;
      used += count;
    }
    unchanged();
    if (used !== Number(before.size)) throw new Error();
    return bytes.subarray(0, used).toString("utf8");
  } finally {
    closeSync(handle);
  }
}

function loadValidatedManifest(
  rawManifestArg: string,
  v1ArchiveRoot: string,
): { initializationId: string; release: FreshStartInitializeInput["release"] } {
  let manifestPath: string;
  try {
    manifestPath = realpathSync.native(rawManifestArg);
  } catch {
    throw new FreshStartError("FRESH_START_INPUT_INVALID");
  }
  if (freshStartPathContains(v1ArchiveRoot, manifestPath)) {
    throw new FreshStartError("FRESH_START_PATH_OVERLAP");
  }
  try {
    const raw = JSON.parse(readReleaseManifest(manifestPath));
    if (
      !raw
      || typeof raw !== "object"
      || Object.keys(raw).sort().join(",") !== "initializationId,release"
      || typeof raw.initializationId !== "string"
      || !UUID_REGEX.test(raw.initializationId)
      || !raw.release
      || typeof raw.release !== "object"
      || ["projectId", "vaultId", "storeId"].some((key) => Object.hasOwn(raw.release, key))
    ) {
      throw new Error();
    }
    // Reuse the versioned strict decoder; fresh identities are generated by initialization.
    const { projectId: _p, vaultId: _v, storeId: _s, ...release } = decodeFreshStartRelease({
      ...raw.release,
      projectId: DUMMY_UUID,
      vaultId: DUMMY_UUID,
      storeId: DUMMY_UUID,
    });
    return { initializationId: raw.initializationId, release };
  } catch {
    throw new FreshStartError("FRESH_START_INPUT_INVALID");
  }
}

function computeActorFingerprint(): string {
  const actor = userInfo();
  return createHash("sha256")
    .update(JSON.stringify({ host: hostname(), username: actor.username, uid: actor.uid }))
    .digest("hex");
}

function enumerateArchiveFiles(
  archiveRoot: string,
  currentDir: string = archiveRoot,
): Array<{ path: string; bytes: number; sha256: string }> {
  const entries = readdirSync(currentDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const collected: Array<{ path: string; bytes: number; sha256: string }> = [];
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      throw new FreshStartError("FRESH_START_PATH_INVALID");
    }
    if (stat.isDirectory()) {
      collected.push(...enumerateArchiveFiles(archiveRoot, fullPath));
    } else if (stat.isFile()) {
      const content = readFileSync(fullPath);
      const relPosix = relative(archiveRoot, fullPath).split(sep).join("/");
      collected.push({
        path: relPosix,
        bytes: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  }
  return collected;
}

interface V1ArchiveFreezeManifestV1 {
  readonly schemaVersion: 1;
  readonly archiveRoot: string;
  readonly frozenAt: string;
  readonly fileCount: number;
  readonly files: readonly {
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
  readonly manifestSha256: string;
}

function computeArchiveFreezeManifestDigest(
  body: Omit<V1ArchiveFreezeManifestV1, "manifestSha256">,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        domain: "v2-v1-archive-freeze-manifest-v1",
        ...body,
      }),
      "utf8",
    )
    .digest("hex");
}

function freezeV1Archive(paths: FreshStartPaths): Record<string, unknown> {
  const files = enumerateArchiveFiles(paths.v1ArchiveRoot);
  for (const item of files) {
    const fullPath = join(paths.v1ArchiveRoot, ...item.path.split("/"));
    chmodSync(fullPath, 0o444);
  }
  const body: Omit<V1ArchiveFreezeManifestV1, "manifestSha256"> = {
    schemaVersion: 1,
    archiveRoot: paths.v1ArchiveRoot,
    frozenAt: new Date().toISOString(),
    fileCount: files.length,
    files,
  };
  const manifestSha256 = computeArchiveFreezeManifestDigest(body);
  const manifest: V1ArchiveFreezeManifestV1 = {
    ...body,
    manifestSha256,
  };
  const adminDir = join(paths.v2VaultRoot, ".memory-mcp");
  mkdirSync(adminDir, { recursive: true });
  writeFileSync(
    join(adminDir, "v1-archive-manifest.json"),
    `${canonicalJson(manifest)}\n`,
    "utf8",
  );
  return Object.freeze({
    ok: true,
    archiveRoot: paths.v1ArchiveRoot,
    fileCount: files.length,
    manifestSha256,
  });
}

function verifyV1Archive(paths: FreshStartPaths): Record<string, unknown> {
  const manifestPath = join(paths.v2VaultRoot, ".memory-mcp", "v1-archive-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
  }
  let parsed: V1ArchiveFreezeManifestV1;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as V1ArchiveFreezeManifestV1;
  } catch {
    throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || parsed.schemaVersion !== 1
    || parsed.archiveRoot !== paths.v1ArchiveRoot
    || !Array.isArray(parsed.files)
    || typeof parsed.manifestSha256 !== "string"
    || !HASH_REGEX.test(parsed.manifestSha256)
  ) {
    throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
  }
  const { manifestSha256, ...body } = parsed;
  if (computeArchiveFreezeManifestDigest(body) !== manifestSha256) {
    throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
  }

  const currentFiles = enumerateArchiveFiles(paths.v1ArchiveRoot);
  if (currentFiles.length !== parsed.files.length) {
    throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
  }
  for (let i = 0; i < currentFiles.length; i += 1) {
    const actual = currentFiles[i]!;
    const expected = parsed.files[i]!;
    if (
      actual.path !== expected.path
      || actual.bytes !== expected.bytes
      || actual.sha256 !== expected.sha256
    ) {
      throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
    }
    const fullPath = join(paths.v1ArchiveRoot, ...actual.path.split("/"));
    const stat = statSync(fullPath);
    if ((stat.mode & 0o222) !== 0) {
      throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
    }
  }

  let writeDenied = true;
  if (currentFiles.length > 0) {
    const probeTarget = join(paths.v1ArchiveRoot, ...currentFiles[0]!.path.split("/"));
    let writableFd: number | undefined;
    try {
      writableFd = openSync(probeTarget, "r+");
      writeDenied = false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") {
        throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
      }
      writeDenied = true;
    } finally {
      if (writableFd !== undefined) {
        try {
          closeSync(writableFd);
        } catch {
          // Ignore close error
        }
      }
    }
  }
  if (!writeDenied) {
    throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
  }

  return Object.freeze({
    ok: true,
    verifiedFiles: currentFiles.length,
    writeDenied: true,
    manifestSha256,
  });
}

function resolveCompiledV2EntryPath(): string {
  const selfPath = fileURLToPath(import.meta.url);
  const candidateAdjacent = join(dirname(selfPath), "v2.js");
  if (existsSync(candidateAdjacent)) {
    return realpathSync.native(candidateAdjacent);
  }
  const candidateDist = resolve(process.cwd(), "dist", "v2.js");
  if (existsSync(candidateDist)) {
    return realpathSync.native(candidateDist);
  }
  return candidateAdjacent;
}

export async function runV2Admin(argv: readonly string[]): Promise<unknown> {
  const { command, values } = parseFlags(argv);

  // 1. Foundation commands (initialize-fresh, resume-initialization, status)
  if ((FOUNDATION_COMMANDS as readonly string[]).includes(command)) {
    assertAllowedFlags(values, [
      "--project-root",
      "--v2-vault-root",
      "--v1-archive-root",
      "--release-manifest",
    ]);
    const roots = loadV2LaunchConfig({
      MEMORY_PROJECT_ROOT: values["--project-root"],
      MEMORY_V2_VAULT_PATH: values["--v2-vault-root"],
      MEMORY_V1_ARCHIVE_PATH: values["--v1-archive-root"],
      MEMORY_V2_RELEASE_ID: DUMMY_UUID,
    });
    const paths = await assertFreshStartPaths(roots);
    const manifest = loadValidatedManifest(values["--release-manifest"]!, paths.v1ArchiveRoot);
    const explicit = loadV2LaunchConfig({
      MEMORY_PROJECT_ROOT: values["--project-root"],
      MEMORY_V2_VAULT_PATH: values["--v2-vault-root"],
      MEMORY_V1_ARCHIVE_PATH: values["--v1-archive-root"],
      MEMORY_V2_RELEASE_ID: manifest.release.releaseId,
    });
    const config = Object.freeze({ ...paths, releaseId: explicit.releaseId });
    const measured = inspectV2Build();
    assertPreparedRelease(manifest.release, config, measured);
    if (command !== "status") {
      // Paths are local-operator output only, never part of MCP diagnostics.
      process.stderr.write(`Resolved V2 destination: ${JSON.stringify(paths.v2VaultRoot)}\n`);
      const actorFingerprint = computeActorFingerprint();
      const initializer = new FreshStartInitializer({
        projectionSchemaVersion: 3,
        inspectBuild: () => inspectV2Build(),
        actorFingerprint,
      });
      const preparation = { ...paths, ...manifest };
      if (command === "initialize-fresh") await initializer.initializeFresh(preparation);
      else await initializer.resumeInitialization(preparation);
    }
    const foundation = await createV2Foundation(config);
    let status: FreshStartStatus | undefined;
    let primary: unknown;
    try {
      status = await foundation.status();
    } catch (error) {
      primary = error;
    }
    try {
      await foundation.close();
    } catch (error) {
      primary ??= error;
    }
    if (primary) throw primary;
    return status!;
  }

  // 2. State transition commands (activate, enter-recovery, exit-recovery, disable)
  if ((TRANSITION_COMMANDS as readonly string[]).includes(command)) {
    assertAllowedFlags(
      values,
      ["--project-root", "--v2-vault-root", "--v1-archive-root", "--release-manifest"],
      ["--operator-approval", "--release-evidence", "--reason"],
      ["--reason"],
    );
    if (!values["--operator-approval"] || !values["--release-evidence"]) {
      throw new FreshStartError("FRESH_START_RELEASE_NOT_READY");
    }

    const roots = loadV2LaunchConfig({
      MEMORY_PROJECT_ROOT: values["--project-root"],
      MEMORY_V2_VAULT_PATH: values["--v2-vault-root"],
      MEMORY_V1_ARCHIVE_PATH: values["--v1-archive-root"],
      MEMORY_V2_RELEASE_ID: DUMMY_UUID,
    });
    const paths = await assertFreshStartPaths(roots);
    const manifest = loadValidatedManifest(values["--release-manifest"]!, paths.v1ArchiveRoot);
    const explicit = loadV2LaunchConfig({
      MEMORY_PROJECT_ROOT: values["--project-root"],
      MEMORY_V2_VAULT_PATH: values["--v2-vault-root"],
      MEMORY_V1_ARCHIVE_PATH: values["--v1-archive-root"],
      MEMORY_V2_RELEASE_ID: manifest.release.releaseId,
    });
    const config = Object.freeze({ ...paths, releaseId: explicit.releaseId });
    const measured = inspectV2Build();
    assertPreparedRelease(manifest.release, config, measured);

    if (!isProductionReleaseManifest(manifest.release)) {
      throw new FreshStartError("FRESH_START_RELEASE_NOT_READY");
    }

    let approvalPath: string;
    let evidencePath: string;
    try {
      approvalPath = realpathSync.native(values["--operator-approval"]!);
      evidencePath = realpathSync.native(values["--release-evidence"]!);
    } catch {
      throw new FreshStartError("FRESH_START_INPUT_INVALID");
    }
    if (
      freshStartPathContains(paths.v1ArchiveRoot, approvalPath)
      || freshStartPathContains(paths.v1ArchiveRoot, evidencePath)
    ) {
      throw new FreshStartError("FRESH_START_PATH_OVERLAP");
    }

    const approvalBytes = new Uint8Array(readFileSync(approvalPath));
    let evidenceReport: unknown;
    try {
      evidenceReport = JSON.parse(readFileSync(evidencePath, "utf8"));
    } catch {
      throw new FreshStartError("FRESH_START_EVIDENCE_INVALID");
    }

    const info = resolveVaultStoreInfo(paths.v2VaultRoot, paths.projectRoot);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const connection = driver.open(info.eventsPath, {
      mode: "existing",
      busyTimeoutMs: 5_000,
      bindFileIdentity: true,
    });

    try {
      const repository = new SqliteFreshStartRepository(connection);
      const identity = {
        projectId: info.projectId as FreshStartRelease["projectId"],
        vaultId: info.vaultId as FreshStartRelease["vaultId"],
        storeId: info.storeId as FreshStartRelease["storeId"],
      };
      const state = repository.transact(identity, (tx) => tx.state());
      if (!state) {
        throw new FreshStartError("FRESH_START_NOT_INITIALIZED");
      }
      if (command === "exit-recovery" && state.mode !== "read-only-recovery") {
        throw new FreshStartError("FRESH_START_EDGE_FORBIDDEN");
      }
      const nextMode: FreshStartMode =
        command === "activate" || command === "exit-recovery"
          ? "active"
          : command === "enter-recovery"
            ? "read-only-recovery"
            : "disabled";
      const nextRelease: FreshStartRelease = Object.freeze({
        ...identity,
        ...manifest.release,
      });

      const controlPlane = new FreshStartControlPlane(
        repository,
        createHmacOperatorApprovalVerifier(process.env.MEMORY_V2_OPERATOR_APPROVAL_KEY ?? ""),
        createReleaseEvidenceReportVerifier(evidenceReport),
      );
      await controlPlane.transition({
        identity,
        expectedGeneration: state.generation,
        expectedMode: state.mode,
        expectedReleaseId: state.releaseId,
        nextMode,
        nextRelease,
        approvalEnvelope: approvalBytes,
      });
    } finally {
      connection.close();
    }

    const foundation = await createV2Foundation(config);
    try {
      return await foundation.status();
    } finally {
      await foundation.close();
    }
  }

  // 3. sign-approval
  if (command === "sign-approval") {
    assertAllowedFlags(
      values,
      [
        "--project-root",
        "--v2-vault-root",
        "--v1-archive-root",
        "--release-manifest",
        "--next-mode",
        "--output",
      ],
      [
        "--recovery-position",
        "--recovery-hash",
        "--reason",
        "--ttl-ms",
        "--approval-id",
        "--nonce",
      ],
      [
        "--next-mode",
        "--recovery-position",
        "--recovery-hash",
        "--reason",
        "--ttl-ms",
        "--approval-id",
        "--nonce",
      ],
    );
    const measured = inspectV2Build();
    const roots = loadV2LaunchConfig({
      MEMORY_PROJECT_ROOT: values["--project-root"],
      MEMORY_V2_VAULT_PATH: values["--v2-vault-root"],
      MEMORY_V1_ARCHIVE_PATH: values["--v1-archive-root"],
      MEMORY_V2_RELEASE_ID: DUMMY_UUID,
    });
    const paths = await assertFreshStartPaths(roots);
    const manifest = loadValidatedManifest(values["--release-manifest"]!, paths.v1ArchiveRoot);
    const explicit = loadV2LaunchConfig({
      MEMORY_PROJECT_ROOT: values["--project-root"],
      MEMORY_V2_VAULT_PATH: values["--v2-vault-root"],
      MEMORY_V1_ARCHIVE_PATH: values["--v1-archive-root"],
      MEMORY_V2_RELEASE_ID: manifest.release.releaseId,
    });
    const config = Object.freeze({ ...paths, releaseId: explicit.releaseId });
    assertPreparedRelease(manifest.release, config, measured);

    const outputPath = canonicalFreshStartPath(resolve(values["--output"]!));
    if (freshStartPathContains(paths.v1ArchiveRoot, outputPath)) {
      throw new FreshStartError("FRESH_START_PATH_OVERLAP");
    }

    const nextModeRaw = values["--next-mode"]!;
    if (!["prepared", "active", "read-only-recovery", "disabled"].includes(nextModeRaw)) {
      throw new FreshStartError("FRESH_START_INPUT_INVALID");
    }
    const nextMode = nextModeRaw as FreshStartMode;

    const secret = process.env.MEMORY_V2_OPERATOR_APPROVAL_KEY ?? "";
    const info = resolveVaultStoreInfo(paths.v2VaultRoot, paths.projectRoot);
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const connection = driver.open(info.eventsPath, {
      mode: "read-only-existing",
      busyTimeoutMs: 5_000,
    });
    let state;
    try {
      const repository = new SqliteFreshStartRepository(connection);
      const identity = {
        projectId: info.projectId as FreshStartRelease["projectId"],
        vaultId: info.vaultId as FreshStartRelease["vaultId"],
        storeId: info.storeId as FreshStartRelease["storeId"],
      };
      state = repository.transact(identity, (tx) => tx.state());
    } finally {
      connection.close();
    }
    if (!state) {
      throw new FreshStartError("FRESH_START_NOT_INITIALIZED");
    }

    const identity = {
      projectId: state.projectId,
      vaultId: state.vaultId,
      storeId: state.storeId,
    };
    const nextRelease: FreshStartRelease = Object.freeze({
      ...identity,
      ...manifest.release,
    });
    const transitionRequest: FreshStartTransitionRequest = {
      identity,
      expectedGeneration: state.generation,
      expectedMode: state.mode,
      expectedReleaseId: state.releaseId,
      nextMode,
      nextRelease,
      approvalEnvelope: new Uint8Array([0]),
    };
    const requestDigest = freshStartRequestDigest(transitionRequest);
    const approvalId = values["--approval-id"] ?? randomUUID();
    const rawNonce = values["--nonce"] ?? randomUUID();
    const nonceDigest = HASH_REGEX.test(rawNonce)
      ? rawNonce
      : createHash("sha256").update(rawNonce, "utf8").digest("hex");
    const ttlMs = values["--ttl-ms"] ? Number(values["--ttl-ms"]) : 300_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new FreshStartError("FRESH_START_INPUT_INVALID");
    }
    const nowMs = Date.now();
    const issuedAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + ttlMs).toISOString();

    const envelope = createSignedOperatorApprovalEnvelope({
      identity,
      approvalId,
      nonceDigest,
      actorFingerprint: computeActorFingerprint(),
      requestDigest,
      evidenceDigest: nextRelease.evidenceDigest,
      issuedAt,
      expiresAt,
      secret,
    });
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${canonicalJson(envelope)}\n`, "utf8");
    return Object.freeze({
      ok: true,
      approvalId: envelope.approvalId,
      requestDigest: envelope.requestDigest,
      evidenceDigest: envelope.evidenceDigest,
      expiresAt: envelope.expiresAt,
    });
  }

  // 4. backup
  if (command === "backup") {
    const backupDirFlag = values["--backup-root"] ? "--backup-root" : "--output";
    assertAllowedFlags(
      values,
      ["--project-root", "--v2-vault-root", "--v1-archive-root", backupDirFlag],
      ["--reason"],
      ["--reason"],
    );
    inspectV2Build();
    const reasonRaw = values["--reason"] ?? "manual";
    if (!["manual", "pre-upgrade", "hourly-active", "orderly-shutdown"].includes(reasonRaw)) {
      throw new FreshStartError("FRESH_START_INPUT_INVALID");
    }
    return new V2BackupService().createBackup({
      projectRoot: values["--project-root"]!,
      v2VaultRoot: values["--v2-vault-root"]!,
      v1ArchiveRoot: values["--v1-archive-root"]!,
      outputDirectory: values[backupDirFlag]!,
      reason: reasonRaw as BackupTriggerReason,
    });
  }

  // 5. restore
  if (command === "restore") {
    assertAllowedFlags(
      values,
      ["--project-root", "--v2-vault-root", "--v1-archive-root", "--backup-root"],
      ["--post-backup-vault-root", "--recovery-position", "--recovery-hash"],
      ["--recovery-position", "--recovery-hash"],
    );
    inspectV2Build();
    const hasPos = Object.hasOwn(values, "--recovery-position");
    const hasHash = Object.hasOwn(values, "--recovery-hash");
    if (hasPos !== hasHash) {
      throw new FreshStartError("FRESH_START_CONFIG_INVALID");
    }
    return new V2RestoreService().restoreToIsolatedVault({
      backupDirectory: values["--backup-root"]!,
      targetProjectRoot: values["--project-root"]!,
      targetV2VaultRoot: values["--v2-vault-root"]!,
      v1ArchiveRoot: values["--v1-archive-root"]!,
      ...(values["--post-backup-vault-root"]
        ? { postBackupSourceVaultRoot: values["--post-backup-vault-root"] }
        : {}),
      ...(hasPos && hasHash
        ? {
            requiredRecoveryFence: {
              position: values["--recovery-position"]!,
              hash: values["--recovery-hash"]!,
            },
          }
        : {}),
    });
  }

  // 6. verify-recovery
  if (command === "verify-recovery") {
    assertAllowedFlags(
      values,
      ["--project-root", "--v2-vault-root", "--v1-archive-root"],
      [
        "--target-build-hash",
        "--target-event-schema-version",
        "--target-projection-schema-version",
      ],
      [
        "--target-build-hash",
        "--target-event-schema-version",
        "--target-projection-schema-version",
      ],
    );
    inspectV2Build();
    const paths = await assertFreshStartPaths({
      projectRoot: values["--project-root"]!,
      v2VaultRoot: values["--v2-vault-root"]!,
      v1ArchiveRoot: values["--v1-archive-root"]!,
    });
    const backupHealth = await new V2BackupService().inspectHealth({
      v2VaultRoot: paths.v2VaultRoot,
      projectRoot: paths.projectRoot,
    });
    const targetEventStoreSchemaVersion = values["--target-event-schema-version"]
      ? Number(values["--target-event-schema-version"])
      : CURRENT_PROJECT_STORE_SCHEMA_VERSION;
    const targetProjectionSchemaVersion = (
      values["--target-projection-schema-version"]
        ? Number(values["--target-projection-schema-version"])
        : 3
    ) as 2 | 3;
    const rollback = await new V2RollbackService().verifyRollbackCompatibility({
      v2VaultRoot: paths.v2VaultRoot,
      projectRoot: paths.projectRoot,
      targetEventStoreSchemaVersion,
      targetProjectionSchemaVersion,
    });
    return Object.freeze({
      ok: backupHealth.healthy && rollback.compatible,
      backupHealth,
      rollback,
    });
  }

  // 7. rebuild-projections
  if (command === "rebuild-projections") {
    assertAllowedFlags(values, ["--project-root", "--v2-vault-root", "--v1-archive-root"]);
    inspectV2Build();
    const paths = await assertFreshStartPaths({
      projectRoot: values["--project-root"]!,
      v2VaultRoot: values["--v2-vault-root"]!,
      v1ArchiveRoot: values["--v1-archive-root"]!,
    });
    const info = resolveVaultStoreInfo(paths.v2VaultRoot, paths.projectRoot);
    const inspectedDescriptor = new ProjectDescriptorRepository().inspect(paths.v2VaultRoot);
    if (inspectedDescriptor.status !== "valid") {
      throw new FreshStartError("FRESH_START_RECOVERY_REQUIRED");
    }
    const workspace = new GitWorkspaceResolver(new SpawnSyncGitCommandRunner()).inspect(
      paths.projectRoot,
      inspectedDescriptor.descriptor,
    );
    const driver = new NodeSqliteDriver({ DatabaseSync });
    const connection = driver.open(info.eventsPath, {
      mode: "read-only-existing",
      busyTimeoutMs: 5_000,
    });
    let terminalPosition = 0n;
    let branchScopeId: BranchScopeId | null = null;
    try {
      const posRow = connection
        .prepare(
          `SELECT COALESCE(MAX(global_position), 0) AS pos
           FROM events
           WHERE project_id = $projectId`,
        )
        .get({ $projectId: info.projectId }) as { pos?: bigint | number } | undefined;
      terminalPosition = BigInt(posRow?.pos ?? 0);
      const branchRow = connection
        .prepare(
          `SELECT branch_scope_id
           FROM branch_scopes
           WHERE project_id = $projectId AND retired_at IS NULL
           ORDER BY created_at ASC LIMIT 1`,
        )
        .get({ $projectId: info.projectId }) as { branch_scope_id?: string } | undefined;
      branchScopeId = (branchRow?.branch_scope_id ?? null) as BranchScopeId | null;
    } finally {
      connection.close();
    }

    const projectionBinding: ProjectBinding = Object.freeze({
      projectId: info.projectId as ProjectBinding["projectId"],
      vaultId: info.vaultId as ProjectBinding["vaultId"],
      storeId: info.storeId as ProjectBinding["storeId"],
      workspaceId: workspace.workspaceId,
      branchScopeId,
      branchRef: workspace.kind === "git" ? workspace.branchRef : null,
      sessionId: null,
    });
    const projectionDirectory = join(info.storeRoot, "projections");
    mkdirSync(projectionDirectory, { recursive: true });
    const eventReader = new SqliteProjectionEventReader({
      driver,
      eventStorePath: info.eventsPath,
      busyTimeoutMs: 5_000,
    });
    const builder = new ImmutableProjectionBuilder({
      driver,
      projectionDirectory,
      now: () => new Date().toISOString(),
    });
    const coordinator = new V2ProjectionBuildCoordinator({
      eventReader,
      builder,
      projectionDirectory,
      schema3: {
        eventReader,
        builder,
      },
    });
    const published = await coordinator.ensurePublishedV3(
      projectionBinding,
      terminalPosition,
      30_000,
    );
    const integrity = new ProjectionIntegrityService({
      driver,
      projectionDirectory,
      eventStorePath: info.eventsPath,
    }).verify(projectionBinding, published.manifest);
    if (integrity.status !== "passed") {
      throw new FreshStartError("FRESH_START_RECOVERY_CORRUPT");
    }
    return Object.freeze({
      ok: true,
      generation: published.manifest.generation,
      schemaVersion: published.manifest.schemaVersion,
      terminalEventPosition: published.manifest.terminalEventPosition.toString(),
    });
  }

  // 8. freeze-v1-archive & verify-v1-archive
  if (command === "freeze-v1-archive" || command === "verify-v1-archive") {
    assertAllowedFlags(values, ["--project-root", "--v2-vault-root", "--v1-archive-root"]);
    inspectV2Build();
    const roots = loadV2LaunchConfig({
      MEMORY_PROJECT_ROOT: values["--project-root"],
      MEMORY_V2_VAULT_PATH: values["--v2-vault-root"],
      MEMORY_V1_ARCHIVE_PATH: values["--v1-archive-root"],
      MEMORY_V2_RELEASE_ID: DUMMY_UUID,
    });
    const paths = await assertFreshStartPaths(roots);
    return command === "freeze-v1-archive" ? freezeV1Archive(paths) : verifyV1Archive(paths);
  }

  // 9. generate-client-configs
  if (command === "generate-client-configs") {
    const releaseFlag = values["--release-id"] ? "--release-id" : "--release-manifest";
    assertAllowedFlags(
      values,
      ["--project-root", "--v2-vault-root", "--v1-archive-root", releaseFlag],
      ["--output-dir"],
      releaseFlag === "--release-id" ? ["--release-id"] : [],
    );
    inspectV2Build();
    const roots = loadV2LaunchConfig({
      MEMORY_PROJECT_ROOT: values["--project-root"],
      MEMORY_V2_VAULT_PATH: values["--v2-vault-root"],
      MEMORY_V1_ARCHIVE_PATH: values["--v1-archive-root"],
      MEMORY_V2_RELEASE_ID: DUMMY_UUID,
    });
    const paths = await assertFreshStartPaths(roots);
    const releaseId =
      releaseFlag === "--release-id"
        ? values["--release-id"]!
        : loadValidatedManifest(values["--release-manifest"]!, paths.v1ArchiveRoot).release
            .releaseId;
    const explicit = loadV2LaunchConfig({
      MEMORY_PROJECT_ROOT: paths.projectRoot,
      MEMORY_V2_VAULT_PATH: paths.v2VaultRoot,
      MEMORY_V1_ARCHIVE_PATH: paths.v1ArchiveRoot,
      MEMORY_V2_RELEASE_ID: releaseId,
    });
    const env = Object.freeze({
      MEMORY_PROJECT_ROOT: explicit.projectRoot,
      MEMORY_V2_VAULT_PATH: explicit.v2VaultRoot,
      MEMORY_V1_ARCHIVE_PATH: explicit.v1ArchiveRoot,
      MEMORY_V2_RELEASE_ID: explicit.releaseId,
    });
    loadV2LaunchConfig(env);

    const v2EntryPath = resolveCompiledV2EntryPath();
    const clients = Object.freeze({
      codex: Object.freeze({
        configPath: ".codex/config.toml",
        command: "node",
        args: Object.freeze([v2EntryPath]),
        env,
        toml: [
          "[mcp_servers.project-memory]",
          'command = "node"',
          `args = [${JSON.stringify(v2EntryPath)}]`,
          "",
          "[mcp_servers.project-memory.env]",
          `MEMORY_PROJECT_ROOT = ${JSON.stringify(env.MEMORY_PROJECT_ROOT)}`,
          `MEMORY_V2_VAULT_PATH = ${JSON.stringify(env.MEMORY_V2_VAULT_PATH)}`,
          `MEMORY_V1_ARCHIVE_PATH = ${JSON.stringify(env.MEMORY_V1_ARCHIVE_PATH)}`,
          `MEMORY_V2_RELEASE_ID = ${JSON.stringify(env.MEMORY_V2_RELEASE_ID)}`,
          "",
        ].join("\n"),
      }),
      opencode: Object.freeze({
        configPath: "opencode.json",
        command: "node",
        args: Object.freeze([v2EntryPath]),
        env,
        json: Object.freeze({
          $schema: "https://opencode.ai/config.json",
          mcp: {
            "project-memory": {
              type: "local",
              command: ["node", v2EntryPath],
              enabled: true,
              environment: env,
            },
          },
        }),
      }),
      antigravity: Object.freeze({
        configPath: ".antigravity/mcp.json",
        command: "node",
        args: Object.freeze([v2EntryPath]),
        env,
        json: Object.freeze({
          mcpServers: {
            "project-memory": {
              command: "node",
              args: [v2EntryPath],
              env,
            },
          },
        }),
      }),
      cursor: Object.freeze({
        configPath: ".cursor/mcp.json",
        command: "node",
        args: Object.freeze([v2EntryPath]),
        env,
        json: Object.freeze({
          mcpServers: {
            "project-memory": {
              command: "node",
              args: [v2EntryPath],
              env,
            },
          },
        }),
      }),
      zed: Object.freeze({
        configPath: ".zed/settings.json",
        command: "node",
        args: Object.freeze([v2EntryPath]),
        env,
        json: Object.freeze({
          context_servers: {
            "project-memory": {
              command: {
                path: "node",
                args: [v2EntryPath],
                env,
              },
            },
          },
        }),
      }),
      windsurf: Object.freeze({
        configPath: ".windsurf/mcp.json",
        command: "node",
        args: Object.freeze([v2EntryPath]),
        env,
        json: Object.freeze({
          mcpServers: {
            "project-memory": {
              command: "node",
              args: [v2EntryPath],
              env,
            },
          },
        }),
      }),
      claudeCode: Object.freeze({
        configPath: ".mcp.json",
        secondaryConfigPath: ".claude/settings.local.json",
        command: "node",
        args: Object.freeze([v2EntryPath]),
        env,
        json: Object.freeze({
          mcpServers: {
            "project-memory": {
              type: "stdio",
              command: "node",
              args: [v2EntryPath],
              env,
            },
          },
        }),
      }),
    });

    for (const client of Object.values(clients)) {
      loadV2LaunchConfig(client.env);
    }

    const writtenFiles: string[] = [];
    if (values["--output-dir"]) {
      const outputDir = canonicalFreshStartPath(resolve(values["--output-dir"]!));
      if (freshStartPathContains(paths.v1ArchiveRoot, outputDir)) {
        throw new FreshStartError("FRESH_START_PATH_OVERLAP");
      }
      const writeTarget = (relPath: string, content: string) => {
        const target = join(outputDir, ...relPath.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, "utf8");
        writtenFiles.push(relPath);
      };
      writeTarget(clients.codex.configPath, clients.codex.toml);
      writeTarget(clients.opencode.configPath, `${JSON.stringify(clients.opencode.json, null, 2)}\n`);
      writeTarget(
        clients.antigravity.configPath,
        `${JSON.stringify(clients.antigravity.json, null, 2)}\n`,
      );
      writeTarget(clients.cursor.configPath, `${JSON.stringify(clients.cursor.json, null, 2)}\n`);
      writeTarget(clients.zed.configPath, `${JSON.stringify(clients.zed.json, null, 2)}\n`);
      writeTarget(
        clients.windsurf.configPath,
        `${JSON.stringify(clients.windsurf.json, null, 2)}\n`,
      );
      writeTarget(
        clients.claudeCode.configPath,
        `${JSON.stringify(clients.claudeCode.json, null, 2)}\n`,
      );
      writeTarget(
        clients.claudeCode.secondaryConfigPath,
        `${JSON.stringify(clients.claudeCode.json, null, 2)}\n`,
      );
    }

    return Object.freeze({
      ok: true,
      v2EntryPath,
      env,
      clients,
      writtenFiles,
    });
  }

  // 10. bootstrap-project & sync-build (multi-project onboarding and engine upgrade sync)
  if (command === "webui") {
    assertAllowedFlags(
      values,
      [],
      ["--project-root", "--port", "--host"],
      ["--port", "--host"],
    );
    const defaultProjectRoot = values["--project-root"] ?? process.cwd();
    const port = values["--port"] ? Number(values["--port"]) : 4321;
    const host = values["--host"] ?? "127.0.0.1";
    const entryUrl = pathToFileURL(resolveCompiledV2EntryPath()).href;
    const handle = await startV2WebUiServer({
      defaultProjectRoot,
      port,
      host,
      entryUrl,
    });
    process.stderr.write(`Project Memory V2 WebUI listening at ${handle.url}\n`);
    await new Promise<void>(() => {
      // Keep server process alive until terminated
    });
    return { ok: true, url: handle.url };
  }
  if (command === "bootstrap-project" || command === "sync-build") {
    assertAllowedFlags(
      values,
      ["--project-root"],
      ["--v2-vault-root", "--v1-archive-root", "--release-id", "--freeze-v1"],
      ["--release-id", "--freeze-v1"],
    );
    const entryUrl = pathToFileURL(resolveCompiledV2EntryPath()).href;
    const config = await ensureProjectV2StoreReady({
      projectRoot: values["--project-root"]!,
      ...(values["--v2-vault-root"] ? { v2VaultRoot: values["--v2-vault-root"] } : {}),
      ...(values["--v1-archive-root"] ? { v1ArchiveRoot: values["--v1-archive-root"] } : {}),
      ...(values["--release-id"] ? { releaseId: values["--release-id"] } : {}),
      entryUrl,
      syncBuild: true,
      ensureActive: command === "bootstrap-project",
    });
    const paths = await assertFreshStartPaths(config);
    if (command === "bootstrap-project" && values["--freeze-v1"] === "true") {
      freezeV1Archive(paths);
    }
    const foundation = await createV2Foundation(config, { entryUrl });
    try {
      const status = await foundation.status();
      return Object.freeze({
        ok: true,
        projectRoot: paths.projectRoot,
        v2VaultRoot: paths.v2VaultRoot,
        v1ArchiveRoot: paths.v1ArchiveRoot,
        ...status,
      });
    } finally {
      await foundation.close();
    }
  }

  throw new FreshStartError("FRESH_START_RELEASE_NOT_READY");
}
