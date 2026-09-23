import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { types } from "node:util";
import type { ProjectBinding } from "../projections/contracts.js";
import { isProjectionProjectStoreIdentity, isProjectionWorkspaceIdentity } from "../projections/contracts.js";
import { parseSealedRetrievalEvaluationBundle, type RetrievalEvaluationBundleV2, type SealedRetrievalEvaluationCorpusV2 } from "../retrieval/evaluation.js";
import { authenticateSealedRetrievalSource } from "../parity/v2-snapshot-parity.js";
import { decodeExpectedDifferenceRuleV1, type ExpectedDifferenceRuleV1 } from "../parity/v2-expected-difference.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import type { SqliteDriver } from "../storage/sqlite-driver.js";
import { verifyV1SourceCopy, type VerifiedV1SourceCopy } from "./v1-source-copy.js";
import { decodeShadowMigrationConfigurationV1, decodeShadowMigrationPolicyV1, shadowMigrationPolicyChecksum,
  ShadowMigrationError, type ShadowMigrationConfigurationV1, type ShadowMigrationPolicyV1 } from "./v2-shadow-migration.contracts.js";
import { createShadowMigrationInvocationDeadline, type ShadowMigrationInvocationDeadline } from "./v2-shadow-migration-runtime.js";

/** Private read-only preparation only; no build/source approval or rollout authority. */
export interface V2ShadowMigrationRehearsalPreflightInput {
  readonly sourceRoot: string; readonly sourceManifestPath: string;
  readonly liveEventStorePath: string; readonly liveLegacyArtifactRoot: string;
  readonly expectedBinding: ProjectBinding; readonly configuration: ShadowMigrationConfigurationV1;
  readonly policy: ShadowMigrationPolicyV1; readonly expectedDifferenceRules: readonly ExpectedDifferenceRuleV1[];
  readonly sealedRetrieval: Readonly<{ bundleRoot: string; expectedBundle: RetrievalEvaluationBundleV2 }>;
}
export interface V2ShadowMigrationRehearsalPreflight {
  readonly input: V2ShadowMigrationRehearsalPreflightInput;
  readonly corpus: SealedRetrievalEvaluationCorpusV2; readonly source: VerifiedV1SourceCopy;
  assertUnchanged(): void;
  close(): void;
}
const INPUT_KEYS = ["sourceRoot", "sourceManifestPath", "liveEventStorePath", "liveLegacyArtifactRoot", "expectedBinding",
  "configuration", "policy", "expectedDifferenceRules", "sealedRetrieval"] as const;
const ARTIFACTS = ["manifest.json", "source-events.json", "judgments.json", "v1-shadow-baseline.json"] as const;
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function invalid(): never { throw new ShadowMigrationError("MIGRATION_SOURCE_INVALID"); }
function limit(): never { throw new ShadowMigrationError("MIGRATION_LIMIT_EXCEEDED"); }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) invalid();
}
// Capture own data before filesystem access; caller accessors/proxies never execute.
function capture(value: unknown, depth = 0, budget = { nodes: 0, bytes: 0 }, seen = new Set<object>()): any {
  if (depth > 32 || ++budget.nodes > 65536) limit();
  if (typeof value === "string") { budget.bytes += Buffer.byteLength(value); if (budget.bytes > 1048576) limit(); return value; }
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value !== "object" || types.isProxy(value) || seen.has(value)) invalid();
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) invalid();
  const output: Record<string, unknown> | unknown[] = array ? [] : {};
  seen.add(value);
  let count = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor || !descriptor.enumerable || !("value" in descriptor)
      || (array && key !== String(count++))) invalid();
    budget.bytes += Buffer.byteLength(key); if (budget.bytes > 1048576) limit();
    Object.defineProperty(output, key, { value: capture(descriptor.value, depth + 1, budget, seen), enumerable: true });
  }
  if (array && count !== (value as unknown[]).length) invalid();
  seen.delete(value); return Object.freeze(output);
}
export function decodeV2ShadowMigrationRehearsalPreflightInput(input: unknown): V2ShadowMigrationRehearsalPreflightInput {
  const value = capture(input); exact(value, INPUT_KEYS);
  const policy = decodeShadowMigrationPolicyV1(value.policy), configuration = decodeShadowMigrationConfigurationV1(value.configuration);
  if (configuration.policyChecksum !== shadowMigrationPolicyChecksum(policy)
    || configuration.expectedDifferencePolicyVersion !== policy.expectedDifferencePolicyVersion) invalid();
  const binding = value.expectedBinding; exact(binding, ["projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef", "sessionId"]);
  if (![binding.projectId, binding.vaultId, binding.storeId].every(isProjectionProjectStoreIdentity)
    || !isProjectionWorkspaceIdentity(binding.workspaceId) || binding.sessionId !== null
    || !(binding.branchScopeId === null || (typeof binding.branchScopeId === "string" && UUID.test(binding.branchScopeId)))
    || !(binding.branchRef === null || (typeof binding.branchRef === "string" && binding.branchRef.length > 0 && !binding.branchRef.includes("\0")))) invalid();
  exact(value.sealedRetrieval, ["bundleRoot", "expectedBundle"]);
  for (const path of [value.sourceRoot, value.sourceManifestPath, value.liveEventStorePath, value.liveLegacyArtifactRoot, value.sealedRetrieval.bundleRoot])
    if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path || path.includes("\0")) invalid();
  const bundle = value.sealedRetrieval.expectedBundle;
  exact(bundle, ["schemaVersion", "corpusVersion", "files"]); exact(bundle.files, ARTIFACTS.slice(1));
  if (bundle.schemaVersion !== 2 || bundle.corpusVersion !== "retrieval-evaluation-v2"
    || Object.values(bundle.files).some(hash => typeof hash !== "string" || !HASH.test(hash))) invalid();
  if (!Array.isArray(value.expectedDifferenceRules) || value.expectedDifferenceRules.length > 4096) invalid();
  const ids = new Set<string>();
  const rules = value.expectedDifferenceRules.map((rule: unknown) => {
    const decoded = decodeExpectedDifferenceRuleV1(rule);
    if (ids.has(decoded.ruleId) || decoded.policyVersion !== policy.expectedDifferencePolicyVersion) invalid();
    ids.add(decoded.ruleId); return decoded;
  });
  return Object.freeze({ ...value, policy, configuration, expectedDifferenceRules: Object.freeze(rules) }) as V2ShadowMigrationRehearsalPreflightInput;
}
interface PathPin { readonly path: string; readonly stat: BigIntStats; }
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return sameIdentity(a, b) && b.isFile() && b.nlink === 1n && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function pathPin(value: unknown, directory: boolean): PathPin {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || value.includes("\0") || realpathSync.native(value) !== value) invalid();
  let cursor = value;
  while (true) {
    const stat = lstatSync(cursor, { bigint: true });
    if (stat.isSymbolicLink() || (cursor !== value && !stat.isDirectory())) invalid();
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  const stat = lstatSync(value, { bigint: true });
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) invalid();
  return { path: value, stat };
}
function overlaps(a: string, b: string): boolean {
  const child = relative(a, b); return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}
interface ArtifactPin extends PathPin { readonly sha256: string; }
function readArtifact(pin: PathPin, maxBytes: number, deadline: ShadowMigrationInvocationDeadline): { bytes: Buffer; pin: ArtifactPin } {
  deadline.remainingMs();
  if (pin.stat.size > BigInt(maxBytes) || pin.stat.size > BigInt(Number.MAX_SAFE_INTEGER)) limit();
  let fd: number | undefined, failed = false;
  try {
    fd = openSync(pin.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!sameFile(pin.stat, fstatSync(fd, { bigint: true }))) invalid();
    const bytes = Buffer.alloc(Number(pin.stat.size)); let offset = 0;
    while (offset < bytes.length) {
      deadline.remainingMs();
      const count = readSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (count === 0) invalid(); offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 || !sameFile(pin.stat, fstatSync(fd, { bigint: true }))
      || !sameFile(pin.stat, pathPin(pin.path, false).stat)) invalid();
    deadline.remainingMs(); return { bytes, pin: { ...pin, sha256: createHash("sha256").update(bytes).digest("hex") } };
  } catch (error) { failed = true; throw error; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch (error) { if (!failed) throw error; } } }
}

/** No target, package, revision, reservation or evidence writes. The accepted source
 * verifier owns its existing temporary working image. Call close on every handoff exit.
 * Persistent identity/byte changes are detected; this is not hostile pathname atomicity.
 */
export async function preflightV2ShadowMigrationRehearsal(supplied: unknown, options: Readonly<{ driver: SqliteDriver }>): Promise<V2ShadowMigrationRehearsalPreflight> {
  let source: VerifiedV1SourceCopy | undefined;
  let deadline: ReturnType<typeof createShadowMigrationInvocationDeadline> | undefined;
  try {
    const input = decodeV2ShadowMigrationRehearsalPreflightInput(supplied);
    deadline = createShadowMigrationInvocationDeadline(input.policy.deadlineMs);
    const roots = [pathPin(input.sourceRoot, true), pathPin(input.liveLegacyArtifactRoot, true), pathPin(input.sealedRetrieval.bundleRoot, true)];
    const manifest = pathPin(input.sourceManifestPath, false), live = pathPin(input.liveEventStorePath, false);
    if (!overlaps(input.sourceRoot, manifest.path) || overlaps(input.sourceRoot, live.path)
      || overlaps(input.sealedRetrieval.bundleRoot, live.path)) invalid();
    for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
      if (sameIdentity(roots[i]!.stat, roots[j]!.stat) || overlaps(roots[i]!.path, roots[j]!.path) || overlaps(roots[j]!.path, roots[i]!.path)) invalid();
    }
    const files = ARTIFACTS.map(name => pathPin(join(input.sealedRetrieval.bundleRoot, name), false));
    let total = 0n;
    for (const file of files) { total += file.stat.size; if (total > BigInt(input.policy.maxAggregateBytes)) limit(); }
    // Do not retain the raw file buffers in the returned handoff closures.
    const { corpus, pins } = (() => {
      const reads = files.map(file => readArtifact(file, input.policy.maxAggregateBytes, deadline!));
      const json = reads.map(read => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)) as unknown);
      return { corpus: parseSealedRetrievalEvaluationBundle(json[0], json[1], json[2], json[3]), pins: reads.map(read => read.pin) };
    })();
    if (canonicalJson(corpus.bundle) !== canonicalJson(input.sealedRetrieval.expectedBundle)) invalid();
    source = await verifyV1SourceCopy({ driver: options.driver, sourceRoot: input.sourceRoot, manifestPath: input.sourceManifestPath,
      liveEventStorePath: input.liveEventStorePath, liveLegacyArtifactRoot: input.liveLegacyArtifactRoot,
      expectedBinding: input.expectedBinding, policy: input.policy, invocationDeadline: deadline });
    const authenticated = authenticateSealedRetrievalSource(corpus, source, deadline);
    const ownedSource = source, ownedDeadline = deadline; let closed = false;
    const assertUnchanged = (): void => {
      try {
        if (closed) invalid(); ownedDeadline.remainingMs();
        for (const root of roots) if (!sameIdentity(root.stat, pathPin(root.path, true).stat)) invalid();
        if (!sameIdentity(live.stat, pathPin(live.path, false).stat)) invalid();
        for (const pin of pins) {
          const current = pathPin(pin.path, false);
          if (!sameFile(pin.stat, current.stat) || readArtifact(current, input.policy.maxAggregateBytes, ownedDeadline).pin.sha256 !== pin.sha256) invalid();
        }
        ownedSource.assertUnchanged(); ownedDeadline.remainingMs();
      } catch (error) {
        if (error instanceof ShadowMigrationError) throw error;
        invalid();
      }
    };
    const close = (): void => { if (closed) return; closed = true; try { ownedSource.close(); } finally { ownedDeadline.dispose(); } };
    assertUnchanged();
    return Object.freeze({ input, corpus: authenticated, source: ownedSource, assertUnchanged, close });
  } catch (error) {
    try { source?.close(); } catch { /* Preserve the primary failure. */ }
    deadline?.dispose();
    if (error instanceof ShadowMigrationError) throw error;
    invalid();
  }
}
