import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  readlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { ProjectContext } from "../identity/contracts.js";
import {
  assertContainedPath,
  canonicalExistingDirectory,
  canonicalExistingPath,
  resolveContainedProjectPath,
  sameCanonicalPath,
} from "../identity/canonical-path.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type { SqliteConnection, SqliteValue } from "../storage/sqlite-driver.js";
import type { SourceStateFingerprintV1 } from "./contracts/checkpoint.js";
import { LifecycleError } from "./errors.js";
import { COMPATIBILITY_SESSION_LOG_ARTIFACT_KIND } from "./materialization-queue.port.js";

const GIT_EXECUTABLE = "git";
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_INVENTORY_ENTRIES = 100_000;
const MAX_INVENTORY_BYTES = 64 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/u;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SESSION_LOG_NAME = /^(\d{4}-\d{2}-\d{2})-session-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.md$/u;
const COMMITTED_TEMP_NAME = /^\.(\d{4}-\d{2}-\d{2}-session-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.md)\.pm-materialize-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-([1-9][0-9]*)-([1-9][0-9]*)\.tmp$/u;
const SQLITE_MAX_INTEGER = 9_223_372_036_854_775_807n;

const GIT_ARGUMENTS = Object.freeze({
  branch: Object.freeze(["symbolic-ref", "--quiet", "HEAD"]),
  head: Object.freeze(["rev-parse", "--verify", "HEAD"]),
  status: Object.freeze(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  inventory: Object.freeze(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
});

export interface SourceStateScopeV1 {
  readonly scopeVersion: 1;
  readonly descriptorPath: string;
  readonly storeRoot: string;
  readonly privateStateRoot: string;
  readonly exactMaterializationTargets: readonly string[];
  readonly exactCommittedTempPaths: readonly string[];
}

export interface SourceStateProvider {
  capture(context: ProjectContext, scope: SourceStateScopeV1): Promise<SourceStateFingerprintV1>;
  captureForCheckpoint(context: ProjectContext, scope: SourceStateScopeV1): SourceStateFingerprintV1;
  captureForFinalization(context: ProjectContext, scope: SourceStateScopeV1): SourceStateFingerprintV1;
}

export interface SourceStateCommandInvocation {
  readonly executable: "git";
  readonly args: readonly string[];
  readonly cwd: string;
  readonly shell: false;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface SourceStateCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut?: boolean;
}

export interface SourceStateCommandRunner {
  runSync(invocation: SourceStateCommandInvocation): SourceStateCommandResult;
  run(invocation: SourceStateCommandInvocation): Promise<SourceStateCommandResult>;
}

export interface FilesystemSourceStateProviderOptions {
  readonly runner?: SourceStateCommandRunner;
  readonly trustedPrivateStateRoot?: string;
  readonly faultInjector?: (
    point: "after-lstat-before-open",
    absolutePath: string,
  ) => void;
}

export interface SqliteSourceStateScopeResolverOptions {
  readonly privateStateRoot: string;
}

export interface SourceStateScopeResolver {
  resolve(connection: SqliteConnection, context: ProjectContext): SourceStateScopeV1;
}

interface ValidatedCapture {
  readonly context: ProjectContext;
  readonly projectRoot: string;
  readonly scope: ValidatedScope;
}

interface ValidatedScope {
  readonly descriptorPath: string;
  readonly storeRoot: string;
  readonly privateStateRoot: string;
  readonly exactMaterializationTargets: ReadonlySet<string>;
  readonly exactCommittedTempPaths: ReadonlySet<string>;
}

interface InventoryRecord {
  readonly path: string;
  readonly kind: "file" | "symlink" | "missing";
  readonly size: number;
  readonly fingerprint: string;
}

function invalid(): never {
  throw new LifecycleError("LIFECYCLE_INPUT_INVALID");
}

function captureFailure(): never {
  throw new LifecycleError("INTEGRITY_FAILURE");
}

function exactRecord(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) invalid();
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid();
    output[key] = descriptor.value;
  }
  return Object.freeze(output);
}

function strictStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) invalid();
  const output: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
      || typeof descriptor.value !== "string" || descriptor.value.length === 0) invalid();
    output.push(descriptor.value);
  }
  return Object.freeze(output);
}

function comparisonPath(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function canonicalOrLexical(path: string): string {
  try {
    return comparisonPath(canonicalExistingPath(path));
  } catch {
    return comparisonPath(path);
  }
}

function within(root: string, target: string): boolean {
  const difference = relative(root, target);
  return difference === "" || (
    difference !== ".."
    && !difference.startsWith(`..${sep}`)
    && !isAbsolute(difference)
  );
}

function validCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function positiveSqliteInteger(value: string): boolean {
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= SQLITE_MAX_INTEGER;
  } catch {
    return false;
  }
}

function containedAbsolutePath(root: string, path: string): string {
  try {
    const child = relative(root, path);
    if (child.length === 0 || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) invalid();
    return resolveContainedProjectPath(root, child);
  } catch {
    invalid();
  }
}

function sqliteText(value: SqliteValue | undefined): string {
  if (typeof value !== "string" || value.length === 0) captureFailure();
  return value;
}

function sqlitePositiveIntegerText(value: SqliteValue | undefined): string {
  if (typeof value === "bigint") {
    if (value <= 0n || value > SQLITE_MAX_INTEGER) captureFailure();
    return value.toString();
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  captureFailure();
}

function canonicalEventDate(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) captureFailure();
  return value.slice(0, 10);
}

function validateContext(context: ProjectContext): string {
  if (typeof context !== "object" || context === null || context.binding === undefined
    || context.workspace !== context.binding.workspace
    || typeof context.binding.projectRoot !== "string"
    || typeof context.binding.descriptorPath !== "string"
    || typeof context.binding.storeRoute?.storeRoot !== "string"
    || typeof context.workspace.workspaceId !== "string"
    || !HASH.test(context.workspace.workspaceId)) invalid();
  const projectRoot = canonicalExistingDirectory(context.binding.projectRoot);
  const workspaceRoot = context.workspace.kind === "git"
    ? canonicalExistingDirectory(context.workspace.worktreeRoot)
    : canonicalExistingDirectory(context.workspace.workspaceRoot);
  if (!sameCanonicalPath(projectRoot, workspaceRoot)
    || context.binding.workspaceId !== context.workspace.workspaceId) invalid();
  return projectRoot;
}

function validateScope(
  context: ProjectContext,
  scopeInput: SourceStateScopeV1,
  trustedPrivateStateRoot: string | undefined,
): ValidatedScope {
  const scope = exactRecord(scopeInput, [
    "scopeVersion",
    "descriptorPath",
    "storeRoot",
    "privateStateRoot",
    "exactMaterializationTargets",
    "exactCommittedTempPaths",
  ]);
  if (scope.scopeVersion !== 1
    || typeof scope.descriptorPath !== "string"
    || typeof scope.storeRoot !== "string"
    || typeof scope.privateStateRoot !== "string"
    || !isAbsolute(scope.descriptorPath)
    || !isAbsolute(scope.storeRoot)
    || !isAbsolute(scope.privateStateRoot)) invalid();
  const descriptorPath = canonicalExistingPath(scope.descriptorPath);
  const storeRoot = canonicalExistingDirectory(scope.storeRoot);
  const privateStateRoot = canonicalExistingDirectory(scope.privateStateRoot);
  if (!sameCanonicalPath(descriptorPath, canonicalExistingPath(context.binding.descriptorPath))
    || !sameCanonicalPath(storeRoot, canonicalExistingDirectory(context.binding.storeRoute.storeRoot))
    || (trustedPrivateStateRoot !== undefined
      && !sameCanonicalPath(privateStateRoot, canonicalExistingDirectory(trustedPrivateStateRoot)))) invalid();

  const targets = strictStrings(scope.exactMaterializationTargets);
  const temps = strictStrings(scope.exactCommittedTempPaths);
  if (new Set(targets.map(comparisonPath)).size !== targets.length
    || new Set(temps.map(comparisonPath)).size !== temps.length
    || [...targets, ...temps].some((path) => !isAbsolute(path))) invalid();
  const vaultRoot = canonicalExistingDirectory(context.binding.vaultRoot);
  const logRoot = canonicalOrLexical(resolve(vaultRoot, "05_Agent_Session_Logs"));
  const validatedTargets = targets.map((path) => {
    if (path.length > 4_096) invalid();
    const contained = containedAbsolutePath(vaultRoot, path);
    const name = basename(contained);
    const match = SESSION_LOG_NAME.exec(name);
    if (match === null || match[1] === undefined || !validCalendarDate(match[1])
      || !sameCanonicalPath(dirname(contained), logRoot)) invalid();
    return canonicalOrLexical(contained);
  });
  const targetSet = new Set(validatedTargets);
  const validatedTemps = temps.map((path) => {
    if (path.length > 4_096) invalid();
    const contained = containedAbsolutePath(vaultRoot, path);
    const match = COMMITTED_TEMP_NAME.exec(basename(contained));
    if (match === null || match[1] === undefined || match[2] === undefined
      || match[3] === undefined || match[4] === undefined || match[5] === undefined
      || match[2] !== match[3]
      || !positiveSqliteInteger(match[4]) || !positiveSqliteInteger(match[5])
      || !sameCanonicalPath(dirname(contained), logRoot)
      || !targetSet.has(canonicalOrLexical(resolve(dirname(contained), match[1])))) invalid();
    return canonicalOrLexical(contained);
  });
  return Object.freeze({
    descriptorPath: canonicalOrLexical(descriptorPath),
    storeRoot: canonicalOrLexical(storeRoot),
    privateStateRoot: canonicalOrLexical(privateStateRoot),
    exactMaterializationTargets: targetSet,
    exactCommittedTempPaths: new Set(validatedTemps),
  });
}

function validateCapture(
  context: ProjectContext,
  scope: SourceStateScopeV1,
  trustedPrivateStateRoot: string | undefined,
): ValidatedCapture {
  const projectRoot = validateContext(context);
  return Object.freeze({
    context,
    projectRoot,
    scope: validateScope(context, scope, trustedPrivateStateRoot),
  });
}

function isExcluded(scope: ValidatedScope, absolutePath: string): boolean {
  const candidate = canonicalOrLexical(absolutePath);
  return candidate === scope.descriptorPath
    || within(scope.storeRoot, candidate)
    || within(scope.privateStateRoot, candidate)
    || scope.exactMaterializationTargets.has(candidate)
    || scope.exactCommittedTempPaths.has(candidate);
}

function relativeProjectPath(projectRoot: string, absolutePath: string): string {
  const value = relative(projectRoot, absolutePath).split(sep).join("/");
  if (value.length === 0 || value === ".." || value.startsWith("../") || isAbsolute(value)) invalid();
  return value;
}

function regularFileRecord(
  projectRoot: string,
  projectPath: string,
  absolutePath: string,
  maximumBytes: number,
  observedStat: NonNullable<ReturnType<typeof lstatSync>>,
  faultInjector: FilesystemSourceStateProviderOptions["faultInjector"],
): InventoryRecord {
  const observedSize = observedStat.size;
  if (!Number.isSafeInteger(observedSize) || observedSize < 0 || observedSize > maximumBytes) captureFailure();
  faultInjector?.("after-lstat-before-open", absolutePath);
  let descriptor: number;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    descriptor = openSync(absolutePath, constants.O_RDONLY | noFollow);
  } catch {
    captureFailure();
  }
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const fingerprint = createHash("sha256").update("project-memory/source-file/v1\n");
  let size = 0;
  try {
    const openedStat = fstatSync(descriptor);
    if (!openedStat.isFile()
      || openedStat.dev !== observedStat.dev
      || openedStat.ino !== observedStat.ino
      || openedStat.size !== observedSize) captureFailure();
    try {
      resolveContainedProjectPath(projectRoot, projectPath);
    } catch {
      captureFailure();
    }
    const currentPathStat = lstatSync(absolutePath);
    if (!currentPathStat.isFile()
      || currentPathStat.dev !== openedStat.dev
      || currentPathStat.ino !== openedStat.ino) captureFailure();
    while (true) {
      const remaining = maximumBytes - size;
      const requested = Math.min(chunk.byteLength, remaining + 1);
      const read = readSync(descriptor, chunk, 0, requested, null);
      if (read === 0) break;
      size += read;
      if (size > maximumBytes) captureFailure();
      fingerprint.update(chunk.subarray(0, read));
    }
    const completedStat = fstatSync(descriptor);
    if (!completedStat.isFile()
      || completedStat.dev !== openedStat.dev
      || completedStat.ino !== openedStat.ino
      || completedStat.size !== openedStat.size
      || size !== completedStat.size) captureFailure();
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    captureFailure();
  } finally {
    chunk.fill(0);
    try {
      closeSync(descriptor);
    } catch {
      captureFailure();
    }
  }
  return Object.freeze({ path: projectPath, kind: "file", size, fingerprint: fingerprint.digest("hex") });
}

function fileRecord(
  projectRoot: string,
  absolutePath: string,
  maximumBytes: number,
  faultInjector: FilesystemSourceStateProviderOptions["faultInjector"],
): InventoryRecord {
  const projectPath = relativeProjectPath(projectRoot, absolutePath);
  try {
    resolveContainedProjectPath(projectRoot, projectPath);
  } catch {
    captureFailure();
  }
  let stat;
  try {
    stat = lstatSync(absolutePath);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
    if (code === "ENOENT") {
      return Object.freeze({ path: projectPath, kind: "missing", size: 0, fingerprint: "0".repeat(64) });
    }
    captureFailure();
  }
  if (stat.isSymbolicLink()) {
    const link = readlinkSync(absolutePath, "utf8");
    const size = Buffer.byteLength(link, "utf8");
    if (size > maximumBytes) captureFailure();
    return Object.freeze({
      path: projectPath,
      kind: "symlink",
      size,
      fingerprint: createHash("sha256").update("project-memory/source-symlink/v1\n").update(link).digest("hex"),
    });
  }
  if (!stat.isFile()) captureFailure();
  return regularFileRecord(projectRoot, projectPath, absolutePath, maximumBytes, stat, faultInjector);
}

function nonGitInventory(
  capture: ValidatedCapture,
  faultInjector: FilesystemSourceStateProviderOptions["faultInjector"],
): readonly InventoryRecord[] {
  const pendingDirectories = [capture.projectRoot];
  const files: string[] = [];
  let observedNodes = 0;
  while (pendingDirectories.length !== 0) {
    const directory = pendingDirectories.pop()!;
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    const childDirectories: string[] = [];
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (isExcluded(capture.scope, path)) continue;
      observedNodes += 1;
      if (observedNodes > MAX_INVENTORY_ENTRIES) captureFailure();
      if (entry.isDirectory()) childDirectories.push(path);
      else files.push(path);
    }
    for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
      pendingDirectories.push(childDirectories[index]!);
    }
  }
  files.sort();
  const records: InventoryRecord[] = [];
  let totalBytes = 0;
  for (const path of files) {
    const record = fileRecord(capture.projectRoot, path, MAX_INVENTORY_BYTES - totalBytes, faultInjector);
    records.push(record);
    totalBytes += record.size;
  }
  return Object.freeze(records);
}

function invocation(cwd: string, args: readonly string[]): SourceStateCommandInvocation {
  return Object.freeze({
    executable: GIT_EXECUTABLE,
    args,
    cwd,
    shell: false,
    timeoutMs: GIT_TIMEOUT_MS,
    maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
  });
}

function validateCommandResult(
  result: SourceStateCommandResult,
  allowedStatuses: readonly number[],
): SourceStateCommandResult {
  if (typeof result !== "object" || result === null
    || !allowedStatuses.includes(result.status ?? -1)
    || result.timedOut === true
    || typeof result.stdout !== "string"
    || typeof result.stderr !== "string"
    || Buffer.byteLength(result.stdout, "utf8") > GIT_MAX_OUTPUT_BYTES
    || Buffer.byteLength(result.stderr, "utf8") > GIT_MAX_OUTPUT_BYTES) captureFailure();
  return result;
}

function nulRecords(value: string): readonly string[] {
  if (value.length === 0) return Object.freeze([]);
  const records = value.split("\0");
  if (records.at(-1) === "") records.pop();
  if (records.some((record) => record.length === 0 || record.includes("\r") || record.includes("\n"))) captureFailure();
  return Object.freeze(records);
}

function filteredStatus(value: string, capture: ValidatedCapture): readonly string[] {
  const source = [...nulRecords(value)];
  const records: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const record = source[index];
    if (record === undefined || record.length < 4 || record[2] !== " ") captureFailure();
    const status = record.slice(0, 2);
    const path = record.slice(3);
    const paths = [path];
    if (status.includes("R") || status.includes("C")) {
      const prior = source[++index];
      if (prior === undefined) captureFailure();
      paths.push(prior);
    }
    if (paths.every((candidate) => isExcluded(capture.scope, resolve(capture.projectRoot, candidate)))) continue;
    records.push(canonicalJson({ status, paths }));
  }
  return Object.freeze(records.sort());
}

function gitInventory(
  value: string,
  capture: ValidatedCapture,
  faultInjector: FilesystemSourceStateProviderOptions["faultInjector"],
): readonly InventoryRecord[] {
  const paths = [...new Set(nulRecords(value))]
    .sort()
    .filter((path) => !isExcluded(capture.scope, resolve(capture.projectRoot, path)));
  if (paths.length > MAX_INVENTORY_ENTRIES) captureFailure();
  const records: InventoryRecord[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    const record = fileRecord(
      capture.projectRoot,
      resolve(capture.projectRoot, path),
      MAX_INVENTORY_BYTES - totalBytes,
      faultInjector,
    );
    records.push(record);
    totalBytes += record.size;
  }
  return Object.freeze(records);
}

function fingerprint(input: {
  readonly workspaceId: string;
  readonly branchRef: string | null;
  readonly headCommit: string | null;
  readonly status: readonly string[];
  readonly inventory: readonly InventoryRecord[];
}): SourceStateFingerprintV1 {
  const dirtyWorktreeFingerprint = createHash("sha256")
    .update("project-memory/source-state/v1\n", "utf8")
    .update(canonicalJson({
      sourceStateScopeVersion: 1,
      workspaceId: input.workspaceId,
      branchRef: input.branchRef,
      headCommit: input.headCommit,
      status: input.status,
      inventory: input.inventory,
    }), "utf8")
    .digest("hex");
  return Object.freeze({
    sourceStateScopeVersion: 1,
    workspaceId: input.workspaceId as SourceStateFingerprintV1["workspaceId"],
    branchRef: input.branchRef,
    headCommit: input.headCommit,
    dirtyWorktreeFingerprint,
  });
}

class NodeSourceStateCommandRunner implements SourceStateCommandRunner {
  runSync(request: SourceStateCommandInvocation): SourceStateCommandResult {
    const result = spawnSync(request.executable, [...request.args], {
      cwd: request.cwd,
      shell: request.shell,
      timeout: request.timeoutMs,
      maxBuffer: request.maxOutputBytes,
      encoding: "utf8",
      windowsHide: true,
    });
    return Object.freeze({
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut: result.error !== undefined && "code" in result.error && result.error.code === "ETIMEDOUT",
    });
  }

  run(request: SourceStateCommandInvocation): Promise<SourceStateCommandResult> {
    return new Promise((resolveResult) => {
      execFile(request.executable, [...request.args], {
        cwd: request.cwd,
        shell: request.shell,
        timeout: request.timeoutMs,
        maxBuffer: request.maxOutputBytes,
        encoding: "utf8",
        windowsHide: true,
      }, (error, stdout, stderr) => {
        const status = error === null ? 0
          : typeof error.code === "number" ? error.code
            : null;
        resolveResult(Object.freeze({
          status,
          stdout,
          stderr,
          timedOut: error !== null && error.killed === true,
        }));
      });
    });
  }
}

export class SqliteSourceStateScopeResolver implements SourceStateScopeResolver {
  readonly #privateStateRoot: string;

  constructor(options: SqliteSourceStateScopeResolverOptions) {
    const decoded = exactRecord(options, ["privateStateRoot"]);
    if (typeof decoded.privateStateRoot !== "string" || !isAbsolute(decoded.privateStateRoot)) invalid();
    try {
      this.#privateStateRoot = canonicalExistingDirectory(decoded.privateStateRoot);
    } catch {
      invalid();
    }
  }

  resolve(connection: SqliteConnection, context: ProjectContext): SourceStateScopeV1 {
    if (typeof connection !== "object" || connection === null || typeof connection.prepare !== "function") invalid();
    validateContext(context);
    let vaultRoot: string;
    let descriptorPath: string;
    let storeRoot: string;
    try {
      vaultRoot = canonicalExistingDirectory(context.binding.vaultRoot);
      descriptorPath = canonicalExistingPath(context.binding.descriptorPath);
      storeRoot = canonicalExistingDirectory(context.binding.storeRoute.storeRoot);
    } catch {
      captureFailure();
    }
    const startRows = connection.prepare(`
      SELECT session_id, occurred_at
      FROM events
      WHERE project_id = $projectId
        AND event_type = 'SessionStarted'
        AND parent_session_id IS NULL
      ORDER BY global_position ASC
    `).all({ $projectId: context.binding.projectId });
    const starts = new Map<string, { readonly artifactPath: string; readonly target: string }>();
    for (const row of startRows) {
      const sessionId = sqliteText(row.session_id);
      const occurredAt = sqliteText(row.occurred_at);
      if (!SESSION_ID.test(sessionId) || starts.has(sessionId)) captureFailure();
      const date = canonicalEventDate(occurredAt);
      const artifactPath = `05_Agent_Session_Logs/${date}-session-${sessionId}.md`;
      let target: string;
      try {
        target = resolveContainedProjectPath(vaultRoot, artifactPath);
      } catch {
        captureFailure();
      }
      starts.set(sessionId, Object.freeze({ artifactPath, target }));
    }

    const outboxRows = connection.prepare(`
      SELECT session_id, artifact_path, materialization_revision,
             status, claim_owner, claim_token
      FROM outbox
      WHERE project_id = $projectId
        AND artifact_kind = '${COMPATIBILITY_SESSION_LOG_ARTIFACT_KIND}'
        AND session_id IS NOT NULL
      ORDER BY event_position ASC, target_key ASC
    `).all({ $projectId: context.binding.projectId });
    const temps = new Map<string, string>();
    for (const row of outboxRows) {
      const sessionId = sqliteText(row.session_id);
      const artifactPath = sqliteText(row.artifact_path);
      const revision = sqlitePositiveIntegerText(row.materialization_revision);
      const status = sqliteText(row.status);
      const start = starts.get(sessionId);
      if (start === undefined || artifactPath !== start.artifactPath) captureFailure();
      if (status === "pending" || status === "failed") {
        if (row.claim_owner !== null || row.claim_token !== null) captureFailure();
        continue;
      }
      if (status !== "claimed" && status !== "completed") captureFailure();
      sqliteText(row.claim_owner);
      const claimToken = sqlitePositiveIntegerText(row.claim_token);
      const targetName = basename(start.target);
      const temp = join(dirname(start.target), `.${targetName}.pm-materialize-${sessionId}-${revision}-${claimToken}.tmp`);
      const comparisonKey = comparisonPath(temp);
      if (temps.has(comparisonKey)) captureFailure();
      temps.set(comparisonKey, temp);
    }
    return Object.freeze({
      scopeVersion: 1,
      descriptorPath,
      storeRoot,
      privateStateRoot: this.#privateStateRoot,
      exactMaterializationTargets: Object.freeze([...starts.values()]
        .map((item) => item.target)
        .sort()),
      exactCommittedTempPaths: Object.freeze([...temps.values()].sort()),
    });
  }
}

export class FilesystemSourceStateProvider implements SourceStateProvider {
  readonly #runner: SourceStateCommandRunner;
  readonly #trustedPrivateStateRoot: string | undefined;
  readonly #faultInjector: FilesystemSourceStateProviderOptions["faultInjector"];

  constructor(options: FilesystemSourceStateProviderOptions = {}) {
    if (typeof options !== "object" || options === null || Array.isArray(options)) invalid();
    const prototype = Object.getPrototypeOf(options) as unknown;
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(options);
    const optionKeys = Reflect.ownKeys(descriptors);
    if (optionKeys.some((key) => typeof key !== "string"
      || (key !== "runner" && key !== "trustedPrivateStateRoot" && key !== "faultInjector"))) invalid();
    for (const descriptor of Object.values(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor)) invalid();
    }
    if (options.runner !== undefined
      && (typeof options.runner !== "object" || options.runner === null
        || typeof options.runner.run !== "function" || typeof options.runner.runSync !== "function")) invalid();
    if (options.trustedPrivateStateRoot !== undefined
      && (typeof options.trustedPrivateStateRoot !== "string"
        || !isAbsolute(options.trustedPrivateStateRoot))) invalid();
    if (options.faultInjector !== undefined && typeof options.faultInjector !== "function") invalid();
    this.#runner = options.runner ?? new NodeSourceStateCommandRunner();
    this.#trustedPrivateStateRoot = options.trustedPrivateStateRoot;
    this.#faultInjector = options.faultInjector;
  }

  captureForCheckpoint(context: ProjectContext, scope: SourceStateScopeV1): SourceStateFingerprintV1 {
    return this.#captureSync(validateCapture(context, scope, this.#trustedPrivateStateRoot));
  }

  captureForFinalization(context: ProjectContext, scope: SourceStateScopeV1): SourceStateFingerprintV1 {
    return this.#captureSync(validateCapture(context, scope, this.#trustedPrivateStateRoot));
  }

  async capture(context: ProjectContext, scope: SourceStateScopeV1): Promise<SourceStateFingerprintV1> {
    const validated = validateCapture(context, scope, this.#trustedPrivateStateRoot);
    if (validated.context.workspace.kind === "non-git") {
      return fingerprint({
        workspaceId: validated.context.workspace.workspaceId,
        branchRef: null,
        headCommit: null,
        status: Object.freeze([]),
        inventory: nonGitInventory(validated, this.#faultInjector),
      });
    }
    const [branch, head, status, inventory] = await Promise.all([
      this.#runner.run(invocation(validated.projectRoot, GIT_ARGUMENTS.branch)),
      this.#runner.run(invocation(validated.projectRoot, GIT_ARGUMENTS.head)),
      this.#runner.run(invocation(validated.projectRoot, GIT_ARGUMENTS.status)),
      this.#runner.run(invocation(validated.projectRoot, GIT_ARGUMENTS.inventory)),
    ]);
    return this.#gitFingerprint(validated, branch, head, status, inventory);
  }

  #captureSync(validated: ValidatedCapture): SourceStateFingerprintV1 {
    if (validated.context.workspace.kind === "non-git") {
      return fingerprint({
        workspaceId: validated.context.workspace.workspaceId,
        branchRef: null,
        headCommit: null,
        status: Object.freeze([]),
        inventory: nonGitInventory(validated, this.#faultInjector),
      });
    }
    return this.#gitFingerprint(
      validated,
      this.#runner.runSync(invocation(validated.projectRoot, GIT_ARGUMENTS.branch)),
      this.#runner.runSync(invocation(validated.projectRoot, GIT_ARGUMENTS.head)),
      this.#runner.runSync(invocation(validated.projectRoot, GIT_ARGUMENTS.status)),
      this.#runner.runSync(invocation(validated.projectRoot, GIT_ARGUMENTS.inventory)),
    );
  }

  #gitFingerprint(
    validated: ValidatedCapture,
    branchInput: SourceStateCommandResult,
    headInput: SourceStateCommandResult,
    statusInput: SourceStateCommandResult,
    inventoryInput: SourceStateCommandResult,
  ): SourceStateFingerprintV1 {
    const branch = validateCommandResult(branchInput, [0, 1]);
    const head = validateCommandResult(headInput, [0]);
    const status = validateCommandResult(statusInput, [0]);
    const inventory = validateCommandResult(inventoryInput, [0]);
    const branchRef = branch.status === 1 ? null : branch.stdout.trim();
    const headCommit = head.stdout.trim();
    if ((branchRef !== null && (branchRef.length === 0 || branchRef.includes("\0")))
      || !GIT_OBJECT_ID.test(headCommit)) captureFailure();
    return fingerprint({
      workspaceId: validated.context.workspace.workspaceId,
      branchRef,
      headCommit,
      status: filteredStatus(status.stdout, validated),
      inventory: gitInventory(inventory.stdout, validated, this.#faultInjector),
    });
  }
}

export class DeterministicSourceStateProvider implements SourceStateProvider {
  readonly #value: SourceStateFingerprintV1;

  constructor(value: SourceStateFingerprintV1) {
    this.#value = Object.freeze({ ...value });
  }

  capture(): Promise<SourceStateFingerprintV1> { return Promise.resolve(this.#value); }
  captureForCheckpoint(): SourceStateFingerprintV1 { return this.#value; }
  captureForFinalization(): SourceStateFingerprintV1 { return this.#value; }
}
