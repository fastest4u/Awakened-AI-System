import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProjectDescriptorRepository } from "../identity/project-descriptor.repository.js";
import { ProjectStoreRouter } from "../identity/project-store.router.js";
import { GitWorkspaceResolver, SpawnSyncGitCommandRunner } from "../identity/git-workspace.resolver.js";
import { StoreManifestRepository } from "../identity/store-manifest.repository.js";
import { fsyncDirectory, createDirectoryDurably } from "../identity/directory-durability.js";
import type { ProjectDescriptorV1, ProjectStoreRoute } from "../identity/contracts.js";
import { ImmutableProjectionBuilder } from "../projections/builder.js";
import { openCommittedProjectionEventSnapshot, SqliteProjectionEventReader, type ProjectionEventSnapshotV3 } from "../projections/event-reader.js";
import { readVerifiedCanonicalProjectionSnapshot } from "../projections/integrity.js";
import { parseRichProjectionManifest, type ProjectionManifestV2, type ProjectionManifestV3 } from "../projections/manifest.js";
import type { ProjectBinding } from "../projections/contracts.js";
import { assertMinimumNodeVersion } from "../runtime/runtime-capabilities.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { DefaultProjectStoreBootstrapService, type ProjectStoreBootstrapFaultBoundary } from "../storage/project-store-bootstrap.service.js";
import { NodeSqliteDriver } from "../storage/node-sqlite-driver.js";
import { expectedSchemaFingerprint, schemaFingerprint } from "../storage/schema-fingerprint.js";
import { PROJECT_STORE_MIGRATIONS } from "../storage/migrations/registry.js";
import { inspectStoreSchema, requireCurrentStoreSchema } from "../storage/schema-compatibility.js";
import { GENESIS_GLOBAL_HASH } from "../storage/event-chain-constants.js";
import { decodeFreshStartGenesis, decodeFreshStartIdentity, decodeFreshStartRelease, FreshStartError, type FreshStartGenesis, type FreshStartIdentity, type FreshStartRelease } from "./contracts.js";
import { SqliteFreshStartRepository } from "./fresh-start.repository.js";
import { assertFreshStartDisjoint, assertFreshStartOwnedDirectory, assertFreshStartPaths, canonicalFreshStartPath, type FreshStartPaths } from "./fresh-start-paths.js";

export type FreshStartInitializeInput = FreshStartPaths & Readonly<{
  initializationId: string; release: Omit<FreshStartRelease, keyof FreshStartIdentity>;
}>;
export type FreshStartInitializationBoundary = ProjectStoreBootstrapFaultBoundary
  | "after-journal-reserved" | "after-descriptor-published" | "after-store-published"
  | "after-projection-verified" | "after-receipt-installed" | "after-receipt-published";
/** Trusted local composition only. Never decode these dependencies from MCP input or environment. */
export interface FreshStartInitializerDependencies {
  projectionSchemaVersion?: 2 | 3;
  inspectBuild?: () => string | Promise<string>;
  actorFingerprint?: string;
  faultInjector?: { hit(boundary: FreshStartInitializationBoundary): void | Promise<void> };
}
type Journal = {
  phase: "reserved" | "store-published" | "receipt-published";
  paths: FreshStartPaths; initializationId: string; identity: FreshStartIdentity;
  release: FreshStartRelease; actorFingerprint: string; storeRoot: string;
  foundationChecksDigest: string | null;
  receipt: FreshStartGenesis | null;
} & ({ version: 1; projection: ProjectionManifestV2 | null }
  | { version: 2; projectionSchemaVersion: 3; projection: ProjectionManifestV3 | null });
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const driver = new NodeSqliteDriver({ DatabaseSync });
const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
const fail = (code: ConstructorParameters<typeof FreshStartError>[0]): never => { throw new FreshStartError(code); };
const admin = (paths: FreshStartPaths): string => join(paths.v2VaultRoot, ".memory-mcp");
const journalPath = (paths: FreshStartPaths): string => join(admin(paths), "fresh-start-init.json");
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("FRESH_START_INPUT_INVALID");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail("FRESH_START_INPUT_INVALID");
  if (Reflect.ownKeys(value).length !== keys.length) return fail("FRESH_START_INPUT_INVALID");
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !property.enumerable || !("value" in property)) return fail("FRESH_START_INPUT_INVALID");
    output[key] = property.value;
  }
  return output;
}
function regular(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("FRESH_START_RECOVERY_REQUIRED");
}
function publishJson(path: string, value: unknown, exclusive = false): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = openSync(temporary, "wx", 0o600);
  try { writeFileSync(handle, `${JSON.stringify(value)}\n`); fsyncSync(handle); }
  finally { closeSync(handle); }
  try {
    if (exclusive) { linkSync(temporary, path); unlinkSync(temporary); }
    else { regular(path); renameSync(temporary, path); }
    fsyncDirectory(dirname(path));
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function routeFor(paths: FreshStartPaths, identity: FreshStartIdentity, createdAt: string) {
  const descriptor: ProjectDescriptorV1 = { schemaVersion: 1, projectId: identity.projectId, vaultId: identity.vaultId, createdAt };
  const workspace = new GitWorkspaceResolver(new SpawnSyncGitCommandRunner()).inspect(paths.projectRoot, descriptor);
  const route = new ProjectStoreRouter().route(descriptor, paths.v2VaultRoot, workspace);
  assertFreshStartOwnedDirectory(route.storeRoot, paths.v1ArchiveRoot);
  assertFreshStartDisjoint(canonicalFreshStartPath(route.storeRoot), paths.v1ArchiveRoot);
  const binding: ProjectBinding = { ...identity, workspaceId: workspace.workspaceId, branchScopeId: null, branchRef: null, sessionId: null };
  return { route, binding };
}
function decodeJournal(value: unknown): Journal {
  try {
    if (typeof value !== "object" || value === null) fail("FRESH_START_JOURNAL_MISMATCH");
    const version = Object.getOwnPropertyDescriptor(value, "version");
    if (!version || !version.enumerable || !("value" in version) || (version.value !== 1 && version.value !== 2)) return fail("FRESH_START_JOURNAL_MISMATCH");
    const j = exact(value, ["version", "phase", "paths", "initializationId", "identity", "release", "actorFingerprint", "storeRoot", "projection", "foundationChecksDigest", "receipt",
      ...(version.value === 2 ? ["projectionSchemaVersion"] : [])]);
    if (j.version !== version.value || (j.version === 2 && j.projectionSchemaVersion !== 3)) fail("FRESH_START_JOURNAL_MISMATCH");
    const target = j.version === 1 ? 2 : 3;
    const paths = exact(j.paths, ["projectRoot", "v2VaultRoot", "v1ArchiveRoot"]) as FreshStartPaths;
    if (Object.values(paths).some(value => typeof value !== "string")
      || !["reserved", "store-published", "receipt-published"].includes(String(j.phase))
      || typeof j.initializationId !== "string" || !UUID.test(j.initializationId)
      || typeof j.actorFingerprint !== "string" || !HASH.test(j.actorFingerprint)
      || typeof j.storeRoot !== "string" || (j.foundationChecksDigest !== null && (typeof j.foundationChecksDigest !== "string" || !HASH.test(j.foundationChecksDigest)))) fail("FRESH_START_JOURNAL_MISMATCH");
    const identity = decodeFreshStartIdentity(j.identity);
    const release = decodeFreshStartRelease(j.release);
    if (identity.projectId !== release.projectId || identity.vaultId !== release.vaultId || identity.storeId !== release.storeId) fail("FRESH_START_JOURNAL_MISMATCH");
    const receipt = j.receipt === null ? null : decodeFreshStartGenesis(j.receipt);
    const projection = j.projection === null ? null : parseRichProjectionManifest(j.projection, {
      ...identity, workspaceId: Object.getOwnPropertyDescriptor(j.projection, "workspaceId")?.value,
      branchScopeId: null, branchRef: null, sessionId: null,
    });
    if (receipt && (("genesisVersion" in receipt ? 3 : 2) !== target)) fail("FRESH_START_JOURNAL_MISMATCH");
    if (projection && (projection.schemaVersion !== target || projection.terminalEventPosition !== "0"
      || projection.terminalEventHash !== GENESIS_GLOBAL_HASH)) fail("FRESH_START_JOURNAL_MISMATCH");
    if (receipt && projection && digest(receipt.projectionChecksums) !== digest(projection.coreChecksums)) fail("FRESH_START_JOURNAL_MISMATCH");
    if (receipt && (receipt.initializationId !== j.initializationId || receipt.releaseId !== release.releaseId || receipt.projectId !== identity.projectId || receipt.vaultId !== identity.vaultId || receipt.storeId !== identity.storeId || receipt.actorFingerprint !== j.actorFingerprint)) fail("FRESH_START_JOURNAL_MISMATCH");
    if (j.phase === "receipt-published" && (!receipt || !projection || !j.foundationChecksDigest)) fail("FRESH_START_JOURNAL_MISMATCH");
    return { ...j, paths, identity, release, receipt, projection } as Journal;
  } catch { return fail("FRESH_START_JOURNAL_MISMATCH"); }
}

export class FreshStartInitializer {
  constructor(private readonly dependencies: FreshStartInitializerDependencies = {}) {}

  async initializeFresh(input: FreshStartInitializeInput): Promise<FreshStartGenesis> {
    exact(input, ["projectRoot", "v2VaultRoot", "v1ArchiveRoot", "initializationId", "release"]);
    const paths = await assertFreshStartPaths(input);
    const identity = decodeFreshStartIdentity({ projectId: randomUUID(), vaultId: randomUUID(), storeId: randomUUID() });
    const release = this.decodeInput(input, identity);
    await this.preflight(release);
    if (digest(await assertFreshStartPaths(paths)) !== digest(paths)) fail("FRESH_START_PATH_CHANGED");
    assertFreshStartOwnedDirectory(admin(paths), paths.v1ArchiveRoot);
    if (existsSync(journalPath(paths))) fail("FRESH_START_ALREADY_INITIALIZED");
    if (existsSync(paths.v2VaultRoot) && readdirSync(paths.v2VaultRoot).length !== 0) fail("FRESH_START_DESTINATION_NOT_EMPTY");
    createDirectoryDurably(paths.v2VaultRoot, paths.projectRoot, fsyncDirectory);
    const { route } = routeFor(paths, identity, release.createdAt);
    if (existsSync(route.storeRoot)) fail("FRESH_START_DESTINATION_NOT_EMPTY");
    // mkdir is also exclusive: a concurrent contender cannot admit an existing administrative directory.
    try { mkdirSync(admin(paths)); fsyncDirectory(paths.v2VaultRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("FRESH_START_ALREADY_INITIALIZED"); throw error; }
    const journal: Journal = { ...(this.dependencies.projectionSchemaVersion === 3 ? {version:2 as const, projectionSchemaVersion:3 as const} : {version:1 as const}), phase: "reserved", paths, initializationId: input.initializationId,
      identity, release, actorFingerprint: this.dependencies.actorFingerprint!, storeRoot: route.storeRoot,
      projection: null, foundationChecksDigest: null, receipt: null };
    publishJson(journalPath(paths), journal, true);
    return this.operate(journal, true);
  }

  async resumeInitialization(input: FreshStartInitializeInput): Promise<FreshStartGenesis> {
    exact(input, ["projectRoot", "v2VaultRoot", "v1ArchiveRoot", "initializationId", "release"]);
    const paths = await assertFreshStartPaths(input);
    const journal = this.readJournal(paths);
    if (this.dependencies.projectionSchemaVersion !== undefined
      && this.dependencies.projectionSchemaVersion !== (journal.version === 2 ? 3 : 2)) fail("FRESH_START_JOURNAL_MISMATCH");
    const release = this.decodeInput(input, journal.identity);
    if (journal.initializationId !== input.initializationId || digest(journal.release) !== digest(release)
      || journal.actorFingerprint !== this.dependencies.actorFingerprint) fail("FRESH_START_JOURNAL_MISMATCH");
    await this.preflight(release);
    return this.operate(journal, false);
  }

  async openExisting(pathsInput: FreshStartPaths): Promise<FreshStartGenesis> {
    const paths = await assertFreshStartPaths(pathsInput);
    const journal = this.readJournal(paths);
    if (journal.phase !== "receipt-published") fail("FRESH_START_RECOVERY_REQUIRED");
    const { route } = await this.recheck(paths, journal);
    this.requirePublished(route, journal);
    const connection = driver.open(route.eventsPath, { mode: "existing", busyTimeoutMs: 5_000, bindFileIdentity: true });
    try {
      requireCurrentStoreSchema(inspectStoreSchema(connection, PROJECT_STORE_MIGRATIONS));
      return new SqliteFreshStartRepository(connection).transact(journal.identity, tx => {
        const receipt = tx.installation();
        if (!receipt || digest(receipt) !== digest(journal.receipt) || !tx.state()) return fail("FRESH_START_RECOVERY_REQUIRED");
        return receipt;
      });
    } finally { connection.close(); }
  }

  private decodeInput(input: FreshStartInitializeInput, identity: FreshStartIdentity): FreshStartRelease {
    exact(input, ["projectRoot", "v2VaultRoot", "v1ArchiveRoot", "initializationId", "release"]);
    if (typeof input.initializationId !== "string" || !UUID.test(input.initializationId)) fail("FRESH_START_INPUT_INVALID");
    exact(input.release, ["profileVersion", "releaseId", "buildIdentityHash", "schemaIdentityHash", "configurationHash", "capabilityManifestHash", "recoveryPolicyHash", "evidenceDigest", "createdAt"]);
    return decodeFreshStartRelease({ ...input.release, ...identity });
  }

  private async preflight(release: FreshStartRelease): Promise<void> {
    assertMinimumNodeVersion();
    if (this.dependencies.projectionSchemaVersion !== undefined && this.dependencies.projectionSchemaVersion !== 2 && this.dependencies.projectionSchemaVersion !== 3) fail("FRESH_START_INPUT_INVALID");
    const inspectBuild = this.dependencies.inspectBuild;
    if (typeof inspectBuild !== "function" || typeof this.dependencies.actorFingerprint !== "string" || !HASH.test(this.dependencies.actorFingerprint)) return fail("FRESH_START_PREPARATION_REQUIRED");
    const measuredBuild = await inspectBuild();
    if (measuredBuild !== release.buildIdentityHash || expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS) !== release.schemaIdentityHash) fail("FRESH_START_RELEASE_MISMATCH");
  }

  private readJournal(paths: FreshStartPaths): Journal {
    try {
      assertFreshStartOwnedDirectory(admin(paths), paths.v1ArchiveRoot);
      regular(journalPath(paths));
      const journal = decodeJournal(JSON.parse(readFileSync(journalPath(paths), "utf8")));
      if (digest(paths) !== digest(journal.paths)) fail("FRESH_START_JOURNAL_MISMATCH");
      return journal;
    } catch (error) {
      if (error instanceof FreshStartError) throw error;
      return fail("FRESH_START_RECOVERY_REQUIRED");
    }
  }

  private async recheck(paths: FreshStartPaths, journal: Journal): Promise<{ route: ProjectStoreRoute; binding: ProjectBinding }> {
    if (digest(await assertFreshStartPaths(paths)) !== digest(paths)) fail("FRESH_START_PATH_CHANGED");
    assertFreshStartOwnedDirectory(admin(paths), paths.v1ArchiveRoot);
    const result = routeFor(paths, journal.identity, journal.release.createdAt);
    if (result.route.storeRoot !== journal.storeRoot) fail("FRESH_START_PATH_CHANGED");
    return result;
  }

  private requirePublished(route: ProjectStoreRoute, journal: Journal): void {
    try {
      regular(route.eventsPath);
      const descriptor = new ProjectDescriptorRepository().inspect(journal.paths.v2VaultRoot);
      if (descriptor.status !== "valid" || descriptor.descriptor.projectId !== journal.identity.projectId || descriptor.descriptor.vaultId !== journal.identity.vaultId) fail("FRESH_START_IDENTITY_MISMATCH");
      if (new StoreManifestRepository().inspect(route, journal.identity).status !== "valid") fail("FRESH_START_RECOVERY_REQUIRED");
    } catch (error) {
      if (error instanceof FreshStartError) throw error;
      fail("FRESH_START_RECOVERY_REQUIRED");
    }
  }

  private async operate(journal: Journal, fresh: boolean): Promise<FreshStartGenesis> {
    const lockPath = join(admin(journal.paths), "fresh-start-operation.lock");
    let lock: number;
    try { lock = openSync(lockPath, "wx", 0o600); }
    catch { return fail("FRESH_START_INITIALIZATION_BUSY"); }
    try {
      if (fresh) await this.dependencies.faultInjector?.hit("after-journal-reserved");
      let { route, binding } = await this.recheck(journal.paths, journal);
      if (journal.phase === "receipt-published") return await this.openExisting(journal.paths);
      const target = journal.version === 2 ? 3 : 2;
      // Only exact owned files may be present; no generic nonempty-directory exception.
      const administrativeNames = ["fresh-start-init.json", "fresh-start-operation.lock", "project-identity.json",
        ...(route.kind === "vault-local" ? ["v2"] : [])];
      if (readdirSync(journal.paths.v2VaultRoot).some(name => name !== ".memory-mcp")
        || readdirSync(admin(journal.paths)).some(name => !administrativeNames.includes(name))) fail("FRESH_START_DESTINATION_NOT_EMPTY");
      if (existsSync(route.storeRoot) && readdirSync(route.storeRoot).some(name => ![
        "events.sqlite", "events.sqlite-wal", "events.sqlite-shm", "store-manifest.json", "fresh-start-projection",
      ].includes(name))) fail("FRESH_START_DESTINATION_NOT_EMPTY");
      const ownedProjection = join(route.storeRoot, "fresh-start-projection");
      assertFreshStartOwnedDirectory(ownedProjection, journal.paths.v1ArchiveRoot);
      if (existsSync(ownedProjection) && readdirSync(ownedProjection).some(name => name !== `projections-${target}-1.sqlite`)) fail("FRESH_START_DESTINATION_NOT_EMPTY");
      if (journal.phase !== "reserved" && !existsSync(route.eventsPath)) fail("FRESH_START_RECOVERY_REQUIRED");
      const descriptors = new ProjectDescriptorRepository({ now: () => journal.release.createdAt,
        randomId: (() => { let index = 0; return () => index++ === 0 ? journal.identity.projectId : journal.identity.vaultId; })() });
      let descriptor = descriptors.inspect(journal.paths.v2VaultRoot);
      if (descriptor.status === "missing") {
        if (journal.phase !== "reserved") fail("FRESH_START_RECOVERY_REQUIRED");
        descriptors.createExplicit(journal.paths.projectRoot, journal.paths.v2VaultRoot);
        descriptor = descriptors.inspect(journal.paths.v2VaultRoot);
      }
      if (descriptor.status !== "valid" || descriptor.descriptor.projectId !== journal.identity.projectId || descriptor.descriptor.vaultId !== journal.identity.vaultId) fail("FRESH_START_IDENTITY_MISMATCH");
      await this.dependencies.faultInjector?.hit("after-descriptor-published");
      ({ route, binding } = await this.recheck(journal.paths, journal));
      if (existsSync(route.eventsPath)) {
        regular(route.eventsPath);
        const partial = driver.open(route.eventsPath, { mode: "read-only-existing", busyTimeoutMs: 5_000, bindFileIdentity: true });
        try {
          const meta = partial.prepare("SELECT project_id, vault_id, store_id FROM project_meta WHERE singleton = 1").get();
          if (!meta || meta.project_id !== journal.identity.projectId || meta.vault_id !== journal.identity.vaultId || meta.store_id !== journal.identity.storeId) fail("FRESH_START_IDENTITY_MISMATCH");
        } finally { partial.close(); }
      }
      const bootstrap = new DefaultProjectStoreBootstrapService({ descriptorRepository: descriptors,
        reserveStoreId: () => journal.identity.storeId,
        beforeStorePublish: async () => { await this.recheck(journal.paths, journal); },
        faultInjector: { hit: boundary => {
          if (boundary === "after-database-publish-before-manifest") {
            journal.phase = "store-published";
            publishJson(journalPath(journal.paths), journal);
          }
          // Bootstrap's historical fault interface is synchronous. Async outer faults are awaited below.
          const result = this.dependencies.faultInjector?.hit(boundary);
          if (result && typeof result.then === "function") fail("FRESH_START_INPUT_INVALID");
        } },
      });
      if (journal.phase === "reserved" || !existsSync(route.storeManifestPath)) {
        if (!existsSync(route.eventsPath) && existsSync(route.storeManifestPath)) fail("FRESH_START_RECOVERY_REQUIRED");
        const result = await bootstrap.initialize({ projectRoot: journal.paths.projectRoot, vaultRoot: journal.paths.v2VaultRoot,
          ...(existsSync(route.eventsPath) ? {} : { replicaDecision: "initialize-local" as const }) });
        if (result.manifest.storeId !== journal.identity.storeId) fail("FRESH_START_IDENTITY_MISMATCH");
        journal.phase = "store-published"; publishJson(journalPath(journal.paths), journal);
      }
      this.requirePublished(route, journal);
      await this.dependencies.faultInjector?.hit("after-store-published");
      ({ route, binding } = await this.recheck(journal.paths, journal));
      const connection = driver.open(route.eventsPath, { mode: "existing", busyTimeoutMs: 5_000, bindFileIdentity: true });
      try {
        const actualSchema = schemaFingerprint(connection);
        requireCurrentStoreSchema(inspectStoreSchema(connection, PROJECT_STORE_MIGRATIONS));
        if (actualSchema !== journal.release.schemaIdentityHash) fail("FRESH_START_RELEASE_MISMATCH");
        const snapshot = target === 3
          ? await new SqliteProjectionEventReader({ driver, eventStorePath: route.eventsPath }).openCommittedSnapshotV3(binding)
          : openCommittedProjectionEventSnapshot(binding, { driver, eventStorePath: route.eventsPath });
        try {
          if (snapshot.eventCount !== 0 || snapshot.terminalEventPosition !== 0n || snapshot.terminalEventHash !== GENESIS_GLOBAL_HASH) fail("FRESH_START_DESTINATION_NOT_EMPTY");
          const projectionDirectory = join(route.storeRoot, "fresh-start-projection");
          assertFreshStartOwnedDirectory(projectionDirectory, journal.paths.v1ArchiveRoot);
          if (!journal.projection) {
            const builder = new ImmutableProjectionBuilder({ driver, projectionDirectory });
            const staged = target === 3 ? await builder.buildV3(snapshot as ProjectionEventSnapshotV3, 1) : await builder.buildV2(snapshot, 1);
            await this.recheck(journal.paths, journal);
            linkSync(staged.temporaryDatabasePath, join(projectionDirectory, staged.manifest.databaseFile));
            unlinkSync(staged.temporaryDatabasePath); fsyncDirectory(projectionDirectory);
            journal.projection = staged.manifest;
          }
          const verificationSource = target === 3
            ? await new SqliteProjectionEventReader({driver,eventStorePath:route.eventsPath}).openCommittedSnapshotV3(binding)
            : openCommittedProjectionEventSnapshot(binding, { driver, eventStorePath: route.eventsPath });
          const verified = (() => {
            try { return readVerifiedCanonicalProjectionSnapshot(binding, journal.projection, { driver,
              eventStorePath: route.eventsPath, projectionDirectory, sourceSnapshot: verificationSource }); }
            finally { verificationSource.close(); }
          })();
          if (verified.schemaVersion !== target || Object.values(verified.rows).some(rows => rows.length !== 0)) fail("FRESH_START_RECOVERY_REQUIRED");
          journal.foundationChecksDigest = digest({ kind: "fresh-start-foundation-preflight-v1", paths: journal.paths,
            runtime: process.version, buildIdentityHash: journal.release.buildIdentityHash, schemaIdentityHash: actualSchema,
            semanticPosition: "0", terminalHash: snapshot.terminalEventHash, projection: journal.projection });
          journal.receipt = decodeFreshStartGenesis({ ...(target === 3 ? {genesisVersion:2,projectionSchemaVersion:3} : {}), ...journal.identity, initializationId: journal.initializationId,
            releaseId: journal.release.releaseId, semanticPosition: "0", terminalHash: snapshot.terminalEventHash,
            projectionChecksums: verified.coreChecksums, actorFingerprint: journal.actorFingerprint,
            preparationIntentDigest: digest({ action: "prepare-fresh-start-v1", initializationId: journal.initializationId,
              actorFingerprint: journal.actorFingerprint, release: journal.release, foundationChecksDigest: journal.foundationChecksDigest }),
            createdAt: journal.release.createdAt });
          publishJson(journalPath(journal.paths), journal);
          await this.dependencies.faultInjector?.hit("after-projection-verified");
        } finally { snapshot.close(); }
        await this.preflight(journal.release);
        await this.recheck(journal.paths, journal);
        new SqliteFreshStartRepository(connection).transact(journal.identity, tx => {
          const installed = tx.installation();
          if (installed) { if (digest(installed) !== digest(journal.receipt)) fail("FRESH_START_IDENTITY_MISMATCH"); }
          else tx.install(journal.receipt!, journal.release);
        });
        await this.dependencies.faultInjector?.hit("after-receipt-installed");
      } finally { connection.close(); }
      await this.recheck(journal.paths, journal);
      journal.phase = "receipt-published"; publishJson(journalPath(journal.paths), journal);
      await this.dependencies.faultInjector?.hit("after-receipt-published");
      return journal.receipt!;
    } finally { closeSync(lock); unlinkSync(lockPath); fsyncDirectory(admin(journal.paths)); }
  }
}
