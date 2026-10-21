// Historical parity differences compare schema1 against frozen schema2, never schema3.
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { ShadowMigrationError } from "../migration/v2-shadow-migration.contracts.js";
import { PROJECTION_NAMES, type ProjectionName } from "../projections/checksum.js";
import { canonicalJson } from "../serialization/canonical-json.js";

export interface ExpectedDifferenceRuleV1 {
  readonly schemaVersion: 1;
  readonly ruleId: string;
  readonly policyVersion: number;
  readonly category: "semantic-value" | "representation";
  readonly projection: ProjectionName;
  readonly rowIdentityHash: string;
  readonly fieldPath: string;
  readonly predicate: Readonly<{ operator: "exact-value-hashes"; v1ValueHash: string; v2ValueHash: string }>;
  readonly rationaleDigest: string;
  readonly approverFingerprint: string;
  readonly approvalReferenceDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly rolloutRevisionId: string;
  readonly migrationIdentity: string;
  readonly ruleChecksum: string;
}

const KEYS = ["schemaVersion", "ruleId", "policyVersion", "category", "projection", "rowIdentityHash", "fieldPath",
  "predicate", "rationaleDigest", "approverFingerprint", "approvalReferenceDigest", "issuedAt", "expiresAt",
  "rolloutRevisionId", "migrationIdentity"] as const;
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// Only explicitly modeled descriptive values can be governed. Authority, scope,
// source provenance, temporal eligibility and identities have no selector here.
const VALUE_FIELDS: Readonly<Record<ProjectionName, readonly string[]>> = Object.freeze({
  sessionTree: ["task_summary"], sessionCheckpoints: [], canonicalItems: ["summary"],
  tasksFollowups: ["summary"], artifactsFiles: ["summary", "symbol", "commit_hash", "heading"],
  entityGraph: [], lexicalChunks: ["text"], retrievalFeedback: [],
});
function invalid(): never { throw new ShadowMigrationError("PARITY_RULE_INVALID"); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || utilTypes.isProxy(value) || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some(key => typeof key !== "string" || !keys.includes(key))) invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function hash(value: unknown): string { if (typeof value !== "string" || !HASH.test(value)) invalid(); return value; }
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
function decodeBody(input: unknown): Omit<ExpectedDifferenceRuleV1, "ruleChecksum"> {
  const value = exact(input, KEYS);
  const predicate = exact(value.predicate, ["operator", "v1ValueHash", "v2ValueHash"]);
  if (value.schemaVersion !== 1 || typeof value.ruleId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(value.ruleId)
    || !Number.isSafeInteger(value.policyVersion) || Number(value.policyVersion) < 1
    || (value.category !== "semantic-value" && value.category !== "representation")
    || typeof value.projection !== "string" || !PROJECTION_NAMES.includes(value.projection as ProjectionName)
    || typeof value.fieldPath !== "string" || !VALUE_FIELDS[value.projection as ProjectionName].includes(value.fieldPath)
    || typeof value.rolloutRevisionId !== "string" || !UUID.test(value.rolloutRevisionId)
    || predicate.operator !== "exact-value-hashes") invalid();
  const issuedAt = timestamp(value.issuedAt), expiresAt = timestamp(value.expiresAt);
  if (expiresAt <= issuedAt) invalid();
  return Object.freeze({ schemaVersion: 1, ruleId: value.ruleId, policyVersion: Number(value.policyVersion),
    category: value.category, projection: value.projection as ProjectionName,
    rowIdentityHash: hash(value.rowIdentityHash), fieldPath: value.fieldPath,
    predicate: Object.freeze({ operator: "exact-value-hashes", v1ValueHash: hash(predicate.v1ValueHash), v2ValueHash: hash(predicate.v2ValueHash) }),
    rationaleDigest: hash(value.rationaleDigest), approverFingerprint: hash(value.approverFingerprint),
    approvalReferenceDigest: hash(value.approvalReferenceDigest), issuedAt, expiresAt,
    rolloutRevisionId: value.rolloutRevisionId, migrationIdentity: hash(value.migrationIdentity) });
}
export function expectedDifferenceRuleChecksum(rule: Omit<ExpectedDifferenceRuleV1, "ruleChecksum">): string {
  return createHash("sha256").update("project-memory/v2-expected-difference-rule/v1\n" + canonicalJson(decodeBody(rule)), "utf8").digest("hex");
}
export function decodeExpectedDifferenceRuleV1(input: unknown): ExpectedDifferenceRuleV1 {
  const value = exact(input, [...KEYS, "ruleChecksum"]);
  const { ruleChecksum, ...fields } = value;
  const body = decodeBody(fields);
  if (expectedDifferenceRuleChecksum(body) !== hash(ruleChecksum)) invalid();
  return Object.freeze({ ...body, ruleChecksum: ruleChecksum as string });
}
