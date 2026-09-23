import * as fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { types } from "node:util";
import { canonicalJson } from "../serialization/canonical-json.js";
import { readV2ShadowMigrationPreflightEvidence, type V2ShadowMigrationPreflightEvidence } from "./v2-shadow-migration-runner.js";

export interface DeterministicRunEvidenceV1 {
  readonly runOrdinal: 1 | 2 | 3 | 4;
  readonly deduplicated: boolean;
  readonly determinismVector: Readonly<{
    migrationIdentity: string; packageChecksum: string; importedEventsChecksum: string; transitionChainChecksum: string;
    v2ProjectionManifestChecksum: string; parityReportChecksum: string; compatibilityArtifactSetChecksum: string;
    sourceRecordCount: number; importedEventCount: number; compatibilityAcknowledgementCount: number;
  }>;
}
export interface V2ShadowMigrationEvidenceV1 {
  readonly schemaVersion: 1; readonly commit: string; readonly nodeVersion: string; readonly sqliteVersion: string;
  readonly operatingSystem: string; readonly projectStoreSchemaVersion: number; readonly buildIdentityHash: string;
  readonly rolloutRevisionId: string; readonly migrationIdentity: string; readonly configurationChecksum: string;
  readonly policyChecksum: string; readonly sourceManifestChecksum: string; readonly sourceBeforeChecksum: string;
  readonly sourceAfterChecksum: string; readonly counts: Readonly<Record<string, number>>;
  readonly deterministicRuns: readonly DeterministicRunEvidenceV1[]; readonly noOpRun: DeterministicRunEvidenceV1;
  readonly parity: Readonly<{ equal: number; expected: number; blocking: number; ruleIds: readonly string[] }>;
  readonly compatibility: Readonly<{ acknowledged: number; terminalPosition: string | null; artifactSetChecksum: string }>;
  readonly performance: Readonly<{ elapsedMs: number; throughputPerSecond: number; peakRssBytes: number;
    maxBatchEvents: number; maxBatchBytes: number; retries: number; projectionLag: number; materializationLag: number }>;
  readonly tests: readonly Readonly<{ name: string; passed: number; failed: number; skipped: number }>[];
  readonly reviews: readonly Readonly<{ kind: "specification" | "implementation-quality" | "security";
    disposition: "approved" | "changes-required"; evidenceDigest: string }>[];
  readonly gates: readonly Readonly<{ name: string; status: "passed" | "failed"; evidenceDigest: string }>[];
  readonly createdAt: string; readonly evidenceChecksum: string;
}
export type V2ShadowMigrationPreflightFailureEvidenceV1 = V2ShadowMigrationPreflightEvidence & { readonly evidenceChecksum: string };
const DOMAIN = "project-memory/v2-shadow-migration-evidence/v1";
const FAILURE_DOMAIN = "project-memory/v2-shadow-migration-preflight-failure-evidence/v1";
const CONTROL = ".v2-shadow-migration-evidence.reservation";
const FAILURE = "preflight-failure-evidence.json";
const CHILD = "--v2-shadow-migration-evidence-child";
const MAX_BYTES = 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{32}$/;
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export class V2ShadowMigrationEvidenceError extends Error {
  constructor(readonly code: "EVIDENCE_INVALID" | "EVIDENCE_OUTPUT_REFUSED" | "EVIDENCE_OUTCOME_UNKNOWN") {
    super(code); this.name = "V2ShadowMigrationEvidenceError";
  }
}
function invalid(): never { throw new V2ShadowMigrationEvidenceError("EVIDENCE_INVALID"); }
function refused(): never { throw new V2ShadowMigrationEvidenceError("EVIDENCE_OUTPUT_REFUSED"); }
function unknown(): never { throw new V2ShadowMigrationEvidenceError("EVIDENCE_OUTCOME_UNKNOWN"); }
function safeString(value: string): void {
  if (value.length > 256 || /[\\/\x00-\x1f]|[a-z]:|-----BEGIN|\b(?:sk|AKIA)[-_]?[a-z0-9]{16}|plaintext|sentinel|password|secret|payload|rationale|approver/i.test(value)) invalid();
}
/** Copy own data only; never invoke caller getters, proxies or serialization hooks. */
function capture(value: unknown, depth = 0, budget = { nodes: 0 }, ancestors = new Set<object>()): any {
  if (++budget.nodes > 10000 || depth > 12) invalid();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) invalid(); return value; }
  if (typeof value === "string") { safeString(value); return value; }
  if (!value || typeof value !== "object" || types.isProxy(value) || ancestors.has(value)) invalid();
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) invalid();
  const result: any = array ? [] : Object.create(null); ancestors.add(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 4097 || (array && keys.length !== value.length + 1)) invalid();
  for (const key of keys) {
    if (array && key === "length") continue;
    if (typeof key !== "string") invalid(); safeString(key);
    if (array && !/^(0|[1-9][0-9]*)$/.test(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    Object.defineProperty(result, key, { enumerable: true, value: capture(descriptor.value, depth + 1, budget, ancestors) });
  }
  ancestors.delete(value); return Object.freeze(result);
}
function exact(value: any, keys: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) invalid();
}
function string(value: unknown, pattern: RegExp): void { if (typeof value !== "string" || !pattern.test(value)) invalid(); }
function integer(value: unknown, min = 0): void { if (!Number.isSafeInteger(value) || Number(value) < min) invalid(); }
function measurement(value: unknown): void { if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) invalid(); }
function utc(value: unknown): void {
  string(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  if (!Number.isFinite(Date.parse(value as string)) || new Date(value as string).toISOString() !== value) invalid();
}
function list(value: unknown, max = 4096): asserts value is any[] { if (!Array.isArray(value) || value.length > max) invalid(); }
const LABEL = /^[a-zA-Z][a-zA-Z0-9_. -]{0,127}$/;
const VECTOR_HASHES = ["migrationIdentity", "packageChecksum", "importedEventsChecksum", "transitionChainChecksum", "v2ProjectionManifestChecksum", "parityReportChecksum", "compatibilityArtifactSetChecksum"];
const VECTOR_COUNTS = ["sourceRecordCount", "importedEventCount", "compatibilityAcknowledgementCount"];
function run(value: any, ordinal: number): void {
  exact(value, ["runOrdinal", "deduplicated", "determinismVector"]);
  if (value.runOrdinal !== ordinal || typeof value.deduplicated !== "boolean") invalid();
  exact(value.determinismVector, [...VECTOR_HASHES, ...VECTOR_COUNTS]);
  for (const key of VECTOR_HASHES) string(value.determinismVector[key], HASH);
  for (const key of VECTOR_COUNTS) integer(value.determinismVector[key]);
}
const BODY_KEYS = ["schemaVersion", "commit", "nodeVersion", "sqliteVersion", "operatingSystem", "projectStoreSchemaVersion", "buildIdentityHash", "rolloutRevisionId", "migrationIdentity", "configurationChecksum", "policyChecksum", "sourceManifestChecksum", "sourceBeforeChecksum", "sourceAfterChecksum", "counts", "deterministicRuns", "noOpRun", "parity", "compatibility", "performance", "tests", "reviews", "gates", "createdAt"];
function successBody(input: unknown): Omit<V2ShadowMigrationEvidenceV1, "evidenceChecksum"> {
  const v = capture(input); exact(v, BODY_KEYS);
  if (v.schemaVersion !== 1) invalid(); string(v.commit, /^[0-9a-f]{40}$/); string(v.nodeVersion, /^v\d+\.\d+\.\d+$/);
  string(v.sqliteVersion, /^\d+\.\d+\.\d+$/); string(v.operatingSystem, /^(win32|linux|darwin|freebsd|openbsd|aix|sunos)$/);
  integer(v.projectStoreSchemaVersion, 1); string(v.rolloutRevisionId, UUID); utc(v.createdAt);
  for (const key of ["buildIdentityHash", "migrationIdentity", "configurationChecksum", "policyChecksum", "sourceManifestChecksum", "sourceBeforeChecksum", "sourceAfterChecksum"]) string(v[key], HASH);
  if (!v.counts || typeof v.counts !== "object" || Array.isArray(v.counts)) invalid();
  for (const [key, value] of Object.entries(v.counts)) { string(key, /^[a-zA-Z][a-zA-Z0-9]{0,63}$/); integer(value); }
  list(v.deterministicRuns, 3); if (v.deterministicRuns.length !== 3) invalid();
  v.deterministicRuns.forEach((entry: unknown, index: number) => run(entry, index + 1)); run(v.noOpRun, 4);
  exact(v.parity, ["equal", "expected", "blocking", "ruleIds"]);
  for (const key of ["equal", "expected", "blocking"]) integer(v.parity[key]);
  list(v.parity.ruleIds); for (const id of v.parity.ruleIds) string(id, LABEL);
  if (new Set(v.parity.ruleIds).size !== v.parity.ruleIds.length) invalid();
  exact(v.compatibility, ["acknowledged", "terminalPosition", "artifactSetChecksum"]); integer(v.compatibility.acknowledged);
  if (v.compatibility.terminalPosition !== null) { string(v.compatibility.terminalPosition, /^(0|[1-9][0-9]{0,18})$/); if (BigInt(v.compatibility.terminalPosition) > 9223372036854775807n) invalid(); }
  string(v.compatibility.artifactSetChecksum, HASH);
  exact(v.performance, ["elapsedMs", "throughputPerSecond", "peakRssBytes", "maxBatchEvents", "maxBatchBytes", "retries", "projectionLag", "materializationLag"]);
  for (const key of ["elapsedMs", "throughputPerSecond"]) measurement(v.performance[key]);
  for (const key of ["peakRssBytes", "maxBatchEvents", "maxBatchBytes", "retries", "projectionLag", "materializationLag"]) integer(v.performance[key]);
  list(v.tests); list(v.reviews, 3); list(v.gates);
  const testNames = new Set<string>(), kinds = new Set<string>(), gateNames = new Set<string>();
  for (const test of v.tests) { exact(test, ["name", "passed", "failed", "skipped"]); string(test.name, LABEL); if (testNames.has(test.name)) invalid(); testNames.add(test.name); for (const key of ["passed", "failed", "skipped"]) integer(test[key]); }
  for (const review of v.reviews) {
    exact(review, ["kind", "disposition", "evidenceDigest"]);
    if (!["specification", "implementation-quality", "security"].includes(review.kind) || !["approved", "changes-required"].includes(review.disposition) || kinds.has(review.kind)) invalid();
    kinds.add(review.kind); string(review.evidenceDigest, HASH);
  }
  const gates = v.gates.map((gate: any) => {
    exact(gate, ["name", "status", "evidenceDigest"]); string(gate.name, LABEL); string(gate.evidenceDigest, HASH);
    if (!["passed", "failed"].includes(gate.status) || gateNames.has(gate.name)) invalid(); gateNames.add(gate.name); return gate;
  });
  for (const review of v.reviews) if (review.disposition === "changes-required") {
    const name = `review-${review.kind}`, index = gates.findIndex((gate: any) => gate.name === name);
    const gate = { name, status: "failed", evidenceDigest: review.evidenceDigest };
    if (index < 0) gates.push(gate); else gates[index] = gate;
  }
  return capture({ ...v, gates });
}
function sealed<T extends object>(body: T, domain: string): T & { readonly evidenceChecksum: string } {
  const result = capture({ ...body, evidenceChecksum: digest(domain + "\n" + canonicalJson(body)) });
  if (Buffer.byteLength(canonicalJson(result) + "\n") > MAX_BYTES) invalid(); return result;
}
/** Serialization integrity only. Task12C must supply genuine observations and functional gates. */
export function buildV2ShadowMigrationEvidence(input: unknown): V2ShadowMigrationEvidenceV1 { return sealed(successBody(input), DOMAIN); }
/** This is only the review prerequisite, never the final Slice2 acceptance predicate. */
export function hasRequiredApprovedV2ShadowMigrationReviews(evidence: V2ShadowMigrationEvidenceV1): boolean {
  documentBytes(evidence, false);
  const { evidenceChecksum: _, ...body } = capture(evidence); const validated = successBody(body);
  return validated.reviews.length === 3 && validated.reviews.every(review => review.disposition === "approved");
}
const SAFE_CODES = ["MIGRATION_POLICY_INVALID", "MIGRATION_SOURCE_INVALID", "MIGRATION_SOURCE_MUTATED", "MIGRATION_LIMIT_EXCEEDED", "MIGRATION_IDENTITY_CONFLICT", "MIGRATION_LEDGER_INTEGRITY_FAILURE", "MIGRATION_OUTCOME_UNKNOWN", "MIGRATION_RETRY_EXHAUSTED", "PROJECTION_INTEGRITY_FAILURE", "PARITY_RULE_INVALID", "PARITY_BLOCKING_DIVERGENCE", "COMPATIBILITY_INTEGRITY_FAILURE"];
function failureBody(input: unknown): V2ShadowMigrationPreflightEvidence {
  const v = capture(input); exact(v, ["schemaVersion", "rolloutRevisionId", "sourceManifestChecksum", "migrationIdentity", "attempts"]);
  if (v.schemaVersion !== 1) invalid(); string(v.rolloutRevisionId, UUID);
  for (const key of ["sourceManifestChecksum", "migrationIdentity"]) if (v[key] !== null) string(v[key], HASH);
  list(v.attempts);
  for (const attempt of v.attempts) {
    exact(attempt, ["attemptId", "operation", "operationAttemptIndex", "outcomeCategory", "safeErrorCode", "evidenceDigest", "recordedAt"]);
    string(attempt.attemptId, UUID); integer(attempt.operationAttemptIndex); string(attempt.evidenceDigest, HASH); utc(attempt.recordedAt);
    if (!["source-verify", "package-seal", "baseline-prepare"].includes(attempt.operation)
      || !["retryable-failure", "unknown-outcome", "retry-exhausted", "terminal-failure"].includes(attempt.outcomeCategory)
      || !SAFE_CODES.includes(attempt.safeErrorCode)) invalid();
  }
  return v;
}
export function buildV2ShadowMigrationPreflightFailureEvidence(failure: unknown): V2ShadowMigrationPreflightFailureEvidenceV1 {
  const carrier = readV2ShadowMigrationPreflightEvidence(failure); if (!carrier) invalid(); return sealed(failureBody(carrier), FAILURE_DOMAIN);
}
function documentBytes(input: unknown, failure: boolean): { bytes: Buffer; evidenceChecksum: string } {
  const v = capture(input), { evidenceChecksum, ...body } = v; string(evidenceChecksum, HASH);
  const expected = failure ? sealed(failureBody(body), FAILURE_DOMAIN) : buildV2ShadowMigrationEvidence(body);
  if (canonicalJson(v) !== canonicalJson(expected)) invalid();
  return { bytes: Buffer.from(canonicalJson(expected) + "\n"), evidenceChecksum };
}

interface Identity { readonly device: string; readonly inode: string; }
const identity = (stat: fs.BigIntStats): Identity => ({ device: String(stat.dev), inode: String(stat.ino) });
const same = (a: Identity, b: Identity) => a.device === b.device && a.inode === b.inode;
function leaf(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 200 || /[\\/:\x00-\x1f<>"|?*]/.test(value) || value === "." || value === ".." || /[. ]$/.test(value)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) refused();
}
function absent(path: string): void {
  try { fs.lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; } refused();
}
function canonicalDirectory(path: string): Identity {
  if (typeof path !== "string" || path.length > 32768 || !isAbsolute(path) || normalize(path) !== path || fs.realpathSync.native(path) !== path) refused();
  let current = parse(path).root;
  for (const component of path.slice(current.length).split(sep).filter(Boolean)) {
    leaf(component); current = join(current, component); const stat = fs.lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(current) !== current) refused();
  }
  const stat = fs.lstatSync(path, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink()) refused(); return identity(stat);
}
function overlaps(a: string, b: string): boolean { const value = relative(a, b); return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`)); }
export interface V2ShadowMigrationEvidenceReservation { readonly __opaqueEvidenceReservation?: never; }
interface PublicationReceipt { readonly evidenceChecksum: string; readonly outputPathHash: string; readonly identity: Identity; }
interface Session { publish(document: unknown, failure: boolean): Promise<PublicationReceipt>; stop(): Promise<void>; }
// No constructor or registration export: only the actual child reservation response mints a handle.
const sessions = new WeakMap<object, Session>();
function operationalFields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) refused();
  const prototype = Object.getPrototypeOf(value); if (prototype !== Object.prototype && prototype !== null) refused();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) refused();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) refused(); result[key] = descriptor.value;
  }
  return result;
}
function rootPaths(value: unknown): string[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 64 || Reflect.ownKeys(value).length !== value.length + 1) refused();
  const result: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") refused(); result.push(descriptor.value);
  }
  return result;
}
export async function reserveV2ShadowMigrationEvidence(input: Readonly<{ outputPath: string; protectedRoots: readonly string[]; timeoutMs: number }>): Promise<V2ShadowMigrationEvidenceReservation> {
  try {
    const fields = operationalFields(input, ["outputPath", "protectedRoots", "timeoutMs"]);
    if (Object.keys(fields).length !== 3) refused();
    const { outputPath, timeoutMs } = fields, protectedRoots = rootPaths(fields.protectedRoots);
    if (typeof outputPath !== "string" || !isAbsolute(outputPath) || normalize(outputPath) !== outputPath || typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 3600000) refused();
    const parent = dirname(outputPath), name = basename(outputPath); leaf(name);
    if ([FAILURE, CONTROL].includes(name.toLowerCase()) || name.toLowerCase().startsWith(".v2-evidence-")) refused();
    const parentIdentity = canonicalDirectory(parent);
    for (const root of protectedRoots) {
      if (typeof root !== "string" || !isAbsolute(root) || normalize(root) !== root || fs.realpathSync.native(root) !== root) refused();
      const stat = fs.lstatSync(root, { bigint: true }); if (stat.isSymbolicLink() || overlaps(root, parent) || overlaps(parent, root) || same(identity(stat), parentIdentity)) refused();
      canonicalDirectory(stat.isDirectory() ? root : dirname(root));
    }
    for (const entry of [name, FAILURE, CONTROL]) absent(join(parent, entry));
    const session = await startChild(parent, parentIdentity, name, timeoutMs);
    const capability = Object.freeze(Object.create(null)); sessions.set(capability, session); return capability;
  } catch (error) { if (error instanceof V2ShadowMigrationEvidenceError) throw error; refused(); }
}
export async function writeV2ShadowMigrationEvidence(input: Readonly<{ reservation: V2ShadowMigrationEvidenceReservation; evidence?: V2ShadowMigrationEvidenceV1; failure?: unknown }>): Promise<PublicationReceipt> {
  const fields = operationalFields(input, ["reservation", "evidence", "failure"]), reservation = fields.reservation;
  if (!reservation || typeof reservation !== "object") refused();
  const session = sessions.get(reservation);
  if (!session) refused(); sessions.delete(reservation);
  try {
    const failure = Object.hasOwn(fields, "failure");
    if (failure === Object.hasOwn(fields, "evidence") || Object.keys(fields).length !== 2) invalid();
    const document = failure ? buildV2ShadowMigrationPreflightFailureEvidence(fields.failure) : fields.evidence;
    documentBytes(document, failure); return await session.publish(document, failure);
  } finally { await session.stop(); }
}

async function startChild(parent: string, parentIdentity: Identity, name: string, timeoutMs: number): Promise<Session> {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "SYSTEMROOT"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), CHILD], { cwd: parent, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let pending: { resolve(value: any): void; reject(error: unknown): void } | undefined;
  let buffer = "", received = 0, stderrBytes = 0, dead = false, bad = false, exitCode: number | null = null;
  let reaped!: () => void; const closed = new Promise<void>(resolveClose => { reaped = resolveClose; });
  const fail = () => { bad = true; pending?.reject(new V2ShadowMigrationEvidenceError("EVIDENCE_OUTCOME_UNKNOWN")); pending = undefined; child.kill(); };
  const timer = setTimeout(fail, timeoutMs);
  child.on("error", fail); child.stdin.on("error", fail);
  child.on("close", code => { dead = true; exitCode = code; clearTimeout(timer); pending?.reject(new V2ShadowMigrationEvidenceError("EVIDENCE_OUTCOME_UNKNOWN")); pending = undefined; reaped(); });
  child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 8192) fail(); });
  child.stdout.on("data", (chunk: Buffer) => {
    received += chunk.length; if (received > 16384) { fail(); return; }
    buffer += chunk.toString("utf8"); const index = buffer.indexOf("\n"); if (index < 0) return;
    if (!pending || index !== buffer.length - 1) { fail(); return; }
    try {
      const result: unknown = JSON.parse(buffer.slice(0, index));
      if (!result || typeof result !== "object" || Array.isArray(result)) { fail(); return; }
      buffer = ""; const waiter = pending; pending = undefined; waiter.resolve(result);
    } catch { fail(); }
  });
  const request = (value: unknown) => new Promise<any>((resolveRequest, reject) => {
    if (bad || dead || pending) { reject(new V2ShadowMigrationEvidenceError("EVIDENCE_OUTCOME_UNKNOWN")); return; }
    pending = { resolve: resolveRequest, reject }; const text = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(text) > MAX_BYTES + 8192) { fail(); return; } child.stdin.write(text);
  });
  const reap = () => Promise.race([closed, new Promise<never>((_, reject) => { const timeout = setTimeout(() => { child.kill(); reject(new V2ShadowMigrationEvidenceError("EVIDENCE_OUTCOME_UNKNOWN")); }, 5000); closed.then(() => clearTimeout(timeout)); })]);
  const stop = async () => { clearTimeout(timer); if (!dead) child.kill(); await reap(); };
  try {
    const ready = await request({ operation: "reserve", parent, parentIdentity, name, timeoutMs });
    if (ready.status === "refused" && ready.code === "EVIDENCE_OUTPUT_REFUSED" && Object.keys(ready).length === 2) refused();
    if (ready.status !== "reserved" || typeof ready.token !== "string" || !TOKEN.test(ready.token) || Object.keys(ready).length !== 2) unknown();
    const token = ready.token;
    return { stop, async publish(document, failure) {
      const result = await request({ operation: "publish", token, failure, document }); child.stdin.end();
      await reap();
      if (bad || exitCode !== 0 || buffer !== "" || result.status !== "published" || Object.keys(result).length !== 4
        || result.evidenceChecksum !== (document as { evidenceChecksum: string }).evidenceChecksum
        || result.outputPathHash !== digest(join(parent, failure ? FAILURE : name)) || !result.identity
        || typeof result.identity !== "object" || Array.isArray(result.identity) || Object.keys(result.identity).length !== 2
        || typeof result.identity.device !== "string" || typeof result.identity.inode !== "string"
        || !/^\d{1,30}$/.test(result.identity.device) || !/^\d{1,30}$/.test(result.identity.inode)) unknown();
      return Object.freeze({ evidenceChecksum: result.evidenceChecksum, outputPathHash: result.outputPathHash, identity: Object.freeze(result.identity) });
    } };
  } catch (error) { await stop(); if (error instanceof V2ShadowMigrationEvidenceError) throw error; unknown(); }
}

interface Authority { readonly token: string; readonly parentIdentity: Identity; readonly permittedLeaves: readonly string[]; }
/** Private child only. The cwd is pinned by spawn; all mutations use validated single relative leaves.
 * Operator-controlled namespace required. This is absent-only install, not arbitrary-hostile leaf CAS. */
async function childMain(): Promise<void> {
  let parentFd: number | undefined, authority: Authority | undefined, controlIdentity: Identity | undefined;
  let parentPath = "", complete = false, mutation = false, timer: NodeJS.Timeout | undefined;
  const handles = new Set<number>();
  const close = (fd: number) => { fs.closeSync(fd); handles.delete(fd); };
  const open = (name: string, flags: string) => { const fd = fs.openSync(name, flags, 0o600); handles.add(fd); return fd; };
  const parent = () => {
    if (!authority || !same(canonicalDirectory(parentPath), authority.parentIdentity) || fs.realpathSync.native(".") !== parentPath) refused();
    const stat = fs.lstatSync(".", { bigint: true }); if (!stat.isDirectory() || !same(identity(stat), authority.parentIdentity)) refused();
    if (parentFd !== undefined) { const pinned = fs.fstatSync(parentFd, { bigint: true }); if (!pinned.isDirectory() || !same(identity(pinned), authority.parentIdentity)) refused(); }
  };
  const flush = () => { parent(); fs.fsyncSync(parentFd!); parent(); };
  const regular = (name: string, expected: Identity, links: bigint, size: number, fd?: number) => {
    parent(); leaf(name); const stat = fs.lstatSync(name, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || !same(identity(stat), expected) || stat.nlink !== links || stat.size !== BigInt(size)
      || fs.realpathSync.native(name) !== join(parentPath, name)) refused();
    if (fd !== undefined) { const pinned = fs.fstatSync(fd, { bigint: true }); if (!pinned.isFile() || !same(identity(pinned), expected) || pinned.nlink !== links || pinned.size !== BigInt(size)) refused(); }
  };
  const read = (fd: number, size: number) => {
    if (size < 0 || size > MAX_BYTES) refused(); const bytes = Buffer.alloc(size + 1);
    let offset = 0; while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (count === 0) break; offset += count; }
    if (offset !== size) refused(); return bytes.subarray(0, size);
  };
  const control = () => {
    if (!authority || !controlIdentity) refused(); const size = Buffer.byteLength(authority.token + "\n");
    regular(CONTROL, controlIdentity, 1n, size); const fd = open(CONTROL, "r");
    try { regular(CONTROL, controlIdentity, 1n, size, fd); if (read(fd, size).toString("utf8") !== authority.token + "\n") refused(); regular(CONTROL, controlIdentity, 1n, size, fd); }
    finally { close(fd); }
  };
  const seal = (name: string, bytes: Buffer) => {
    parent(); absent(name); mutation = true; const fd = open(name, "wx"), stat = fs.fstatSync(fd, { bigint: true }), id = identity(stat);
    if (!stat.isFile() || stat.nlink !== 1n) refused();
    let offset = 0;
    while (offset < bytes.length) { parent(); const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset); if (count <= 0) refused(); offset += count; }
    regular(name, id, 1n, bytes.length, fd); fs.fsyncSync(fd); regular(name, id, 1n, bytes.length, fd); close(fd);
    const sealedFd = open(name, "r"); regular(name, id, 1n, bytes.length, sealedFd);
    if (!read(sealedFd, bytes.length).equals(bytes)) refused(); regular(name, id, 1n, bytes.length, sealedFd); return { id, fd: sealedFd };
  };
  const send = (value: unknown) => new Promise<void>((resolveSend, reject) => process.stdout.write(JSON.stringify(value) + "\n", error => error ? reject(error) : resolveSend()));
  try {
    let buffered = Buffer.alloc(0), requests = 0;
    for await (const chunk of process.stdin) {
      if (complete || buffered.length + (chunk as Buffer).length > MAX_BYTES + 8192) refused();
      buffered = Buffer.concat([buffered, chunk as Buffer]); const index = buffered.indexOf(10);
      if (index < 0) continue; if (index !== buffered.length - 1 || ++requests > 2) refused();
      const request = JSON.parse(buffered.subarray(0, index).toString("utf8")); buffered = Buffer.alloc(0);
      if (requests === 1) {
        exact(request, ["operation", "parent", "parentIdentity", "name", "timeoutMs"]);
        if (request.operation !== "reserve" || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 50 || request.timeoutMs > 3600000) refused();
        leaf(request.name); if ([CONTROL, FAILURE].includes(request.name.toLowerCase()) || request.name.toLowerCase().startsWith(".v2-evidence-")) refused();
        exact(request.parentIdentity, ["device", "inode"]); parentPath = request.parent;
        authority = Object.freeze({ token: randomBytes(16).toString("hex"), parentIdentity: Object.freeze(request.parentIdentity), permittedLeaves: Object.freeze([request.name, FAILURE]) });
        parent(); for (const name of [...authority.permittedLeaves, CONTROL]) absent(name);
        parentFd = open(".", process.platform === "win32" ? "r+" : "r"); parent();
        const reserved = seal(CONTROL, Buffer.from(authority.token + "\n")); controlIdentity = reserved.id; close(reserved.fd); control(); flush();
        for (const name of authority.permittedLeaves) absent(name);
        timer = setTimeout(() => { process.stdin.destroy(); process.exitCode = 1; }, request.timeoutMs);
        await send({ status: "reserved", token: authority.token });
      } else {
        exact(request, ["operation", "token", "failure", "document"]);
        if (!authority || request.operation !== "publish" || request.token !== authority.token || typeof request.failure !== "boolean") refused();
        control(); for (const name of authority.permittedLeaves) absent(name);
        const name = authority.permittedLeaves[request.failure ? 1 : 0]!, temporary = `.v2-evidence-${authority.token}.tmp`;
        const { bytes, evidenceChecksum } = documentBytes(request.document, request.failure);
        const sealedFile = seal(temporary, bytes);
        // The reopened bytes themselves must pass canonical schema/redaction/checksum validation.
        const actual = read(sealedFile.fd, bytes.length); const validated = documentBytes(JSON.parse(actual.toString("utf8")), request.failure);
        if (!validated.bytes.equals(actual)) refused();
        control(); regular(temporary, sealedFile.id, 1n, bytes.length, sealedFile.fd); absent(name);
        fs.linkSync(temporary, name); regular(temporary, sealedFile.id, 2n, bytes.length, sealedFile.fd); regular(name, sealedFile.id, 2n, bytes.length); flush();
        const finalFd = open(name, "r"); regular(name, sealedFile.id, 2n, bytes.length, finalFd);
        if (!read(finalFd, bytes.length).equals(bytes)) refused(); control();
        regular(temporary, sealedFile.id, 2n, bytes.length, sealedFile.fd); regular(name, sealedFile.id, 2n, bytes.length, finalFd);
        fs.unlinkSync(temporary); flush(); regular(name, sealedFile.id, 1n, bytes.length, finalFd);
        if (!read(finalFd, bytes.length).equals(bytes)) refused(); close(sealedFile.fd); close(finalFd);
        if (!request.failure) { control(); flush(); control(); fs.unlinkSync(CONTROL); flush(); }
        const verified = open(name, "r"); regular(name, sealedFile.id, 1n, bytes.length, verified);
        if (!read(verified, bytes.length).equals(bytes)) refused(); close(verified); parent(); close(parentFd!); parentFd = undefined;
        complete = true; clearTimeout(timer);
        await send({ status: "published", identity: sealedFile.id, evidenceChecksum, outputPathHash: digest(join(parentPath, name)) });
        break;
      }
    }
    if (!complete) unknown();
  } catch { process.exitCode = 1; try { await send({ status: "refused", code: mutation ? "EVIDENCE_OUTCOME_UNKNOWN" : "EVIDENCE_OUTPUT_REFUSED" }); } catch { /* No response is an unknown outcome. */ } }
  finally {
    clearTimeout(timer); for (const fd of handles) try { fs.closeSync(fd); } catch { process.exitCode = 1; }
    process.stdin.destroy();
  }
}
// Inert on ordinary import. Task12C bundles this exact hidden entry in its internal artifact.
if (process.argv[2] === CHILD && process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) void childMain();
