import type { Confidence } from "../contracts/event.js";
import type {
  BranchScopeId,
  ProjectId,
  WorkspaceId,
} from "../identity/contracts.js";
import type {
  ProjectBinding,
  ProjectionItemStatus,
} from "../projections/contracts.js";
import type { ProjectionManifestV1 } from "../projections/manifest.js";
import type { ProjectionReaderLease } from "../projections/reader-lease.js";

const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;
const HASH = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export const RETRIEVAL_LIMITS = Object.freeze({
  queryBytes: 4_096,
  results: 50,
  tokenBudget: 32_768,
  explainBytes: 65_536,
  candidates: 512,
  deadlineMs: 30_000,
} as const);

export type InternalRetrievalErrorCode =
  | "GLOBAL_SCOPE_DENIED"
  | "PROJECTION_SCOPE_MISMATCH"
  | "RETRIEVAL_PROJECTION_INVALID"
  | "RETRIEVAL_REQUEST_INVALID";

export class InternalRetrievalError extends Error {
  constructor(readonly code: InternalRetrievalErrorCode) {
    super(code);
    this.name = "InternalRetrievalError";
  }
}

export type RetrievalVisibility = "project" | "workspace" | "branch" | "session";
export type RetrievalFreshness = "fresh" | "stale" | "corrupt";
export type RetrievalItemKind =
  | "canonical"
  | "lexical"
  | "artifact"
  | "checkpoint"
  | "follow-up";
export type RetrievalItemStatus = ProjectionItemStatus | "active" | "open" | "blocked";

export interface RetrievalConsistency {
  readonly requiredEventPosition: bigint;
  readonly deadlineMs: number;
}

export interface InternalRetrievalRequest {
  readonly binding: ProjectBinding;
  readonly query: string;
  readonly limit: number;
  readonly tokenBudget: number;
  readonly consistency: RetrievalConsistency;
  readonly candidateLimit?: number;
  readonly explain?: boolean;
  readonly explainByteLimit?: number;
  readonly includeGlobal?: boolean;
  readonly sessionId?: string;
  readonly visibility?: RetrievalVisibility;
  readonly validAt?: string;
  readonly knownAt?: bigint;
}

export interface ValidatedInternalRetrievalRequest extends InternalRetrievalRequest {
  readonly candidateLimit: number;
  readonly explain: boolean;
  readonly explainByteLimit: number;
  readonly includeGlobal: false;
}

export interface RetrievalItem {
  readonly id: string;
  readonly kind: RetrievalItemKind;
  readonly projectId: ProjectId;
  readonly workspaceId: WorkspaceId;
  readonly branchScopeId: BranchScopeId | null;
  readonly branchRef: string | null;
  readonly sessionId: string | null;
  readonly visibility: RetrievalVisibility;
  readonly status: RetrievalItemStatus;
  readonly confidence: Confidence;
  readonly verificationMethod: string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly knownFromEventPosition: bigint;
  readonly sourceEventPosition: bigint;
  readonly summary: string;
  readonly normalizedKey: string;
  readonly anchor: string | null;
  readonly freshness: RetrievalFreshness;
}

export type RetrievalChannel =
  | "exact"
  | "alias"
  | "lexical"
  | "symbol-path"
  | "session-checkpoint"
  | "open-follow-up";

export interface RetrievalCandidate {
  readonly candidateId: string;
  readonly channel: RetrievalChannel;
  readonly rank: number;
  readonly item: RetrievalItem;
}

export interface RetrievalChannelResult {
  readonly channel: RetrievalChannel;
  readonly candidates: readonly RetrievalCandidate[];
}

export interface RetrievalCandidateCollection {
  readonly channels: readonly RetrievalChannelResult[];
  readonly eligibleItemCount: number;
  readonly droppedItemCount: number;
  readonly truncated: boolean;
}

export interface InternalRetrievalResultItem extends RetrievalItem {
  readonly channels: readonly RetrievalChannel[];
  readonly selectionReason: RetrievalChannel;
}

export interface InternalRetrievalResult {
  readonly items: readonly InternalRetrievalResultItem[];
  readonly generation: number;
  readonly terminalEventPosition: bigint;
  readonly candidateCount: number;
  readonly truncated: boolean;
}

export interface ProjectionLeaseProvider {
  pin(
    binding: ProjectBinding,
    consistency: RetrievalConsistency,
  ): Promise<ProjectionReaderLease>;
}

export interface RetrievalCandidateRepository {
  collectEligible(
    lease: ProjectionReaderLease,
    request: InternalRetrievalRequest,
  ): RetrievalCandidateCollection;
}

export interface RetrievalRanker {
  select(
    eligible: RetrievalCandidateCollection,
    request: ValidatedInternalRetrievalRequest,
    manifest: ProjectionManifestV1,
  ): InternalRetrievalResult;
}

function invalid(): never {
  throw new InternalRetrievalError("RETRIEVAL_REQUEST_INVALID");
}

function exactDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
    || requiredKeys.some((key) => !keys.includes(key))
  ) return invalid();
  const output: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return invalid();
    }
    output[key] = descriptor.value;
  }
  return output;
}

function boundedInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    return invalid();
  }
  return Number(value);
}

function canonicalTimestamp(value: unknown): string {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > 24
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) return invalid();
  return value;
}

function binding(value: unknown): ProjectBinding {
  const source = exactDataRecord(
    value,
    ["projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef", "sessionId"],
    ["projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef", "sessionId"],
  );
  for (const key of ["projectId", "vaultId", "storeId", "workspaceId"] as const) {
    if (typeof source[key] !== "string" || !HASH.test(source[key])) return invalid();
  }
  if (source.branchScopeId !== null
    && (typeof source.branchScopeId !== "string" || !UUID.test(source.branchScopeId))) return invalid();
  if (source.branchRef !== null
    && (
      typeof source.branchRef !== "string"
      || source.branchRef.length === 0
      || Buffer.byteLength(source.branchRef, "utf8") > 1_024
      || CONTROL.test(source.branchRef)
    )) return invalid();
  if (source.sessionId !== null) return invalid();
  return Object.freeze({ ...source }) as unknown as ProjectBinding;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") return invalid();
  return value;
}

export function validateInternalRetrievalRequest(
  value: InternalRetrievalRequest,
): ValidatedInternalRetrievalRequest {
  const source = exactDataRecord(
    value,
    [
      "binding", "query", "limit", "tokenBudget", "consistency", "candidateLimit",
      "explain", "explainByteLimit", "includeGlobal", "sessionId", "visibility",
      "validAt", "knownAt",
    ],
    ["binding", "query", "limit", "tokenBudget", "consistency"],
  );
  const privateBinding = binding(source.binding);
  if (typeof source.query !== "string") return invalid();
  if (Buffer.byteLength(source.query, "utf8") > RETRIEVAL_LIMITS.queryBytes) return invalid();
  const query = source.query.normalize("NFKC").trim();
  if (
    query.length === 0
    || CONTROL.test(query)
    || Buffer.byteLength(query, "utf8") > RETRIEVAL_LIMITS.queryBytes
  ) return invalid();
  const limit = boundedInteger(source.limit, RETRIEVAL_LIMITS.results);
  const tokenBudget = boundedInteger(source.tokenBudget, RETRIEVAL_LIMITS.tokenBudget);
  const consistency = exactDataRecord(
    source.consistency,
    ["requiredEventPosition", "deadlineMs"],
    ["requiredEventPosition", "deadlineMs"],
  );
  if (
    typeof consistency.requiredEventPosition !== "bigint"
    || consistency.requiredEventPosition < 0n
    || consistency.requiredEventPosition > SQLITE_INT64_MAX
    || !Number.isSafeInteger(consistency.deadlineMs)
    || Number(consistency.deadlineMs) < 0
    || Number(consistency.deadlineMs) > RETRIEVAL_LIMITS.deadlineMs
  ) return invalid();
  const candidateLimit = source.candidateLimit === undefined
    ? Math.min(RETRIEVAL_LIMITS.candidates, Math.max(64, limit * 8))
    : boundedInteger(source.candidateLimit, RETRIEVAL_LIMITS.candidates);
  const explain = optionalBoolean(source.explain, false);
  const explainByteLimit = source.explainByteLimit === undefined
    ? Math.min(RETRIEVAL_LIMITS.explainBytes, Math.max(1_024, tokenBudget * 4))
    : boundedInteger(source.explainByteLimit, RETRIEVAL_LIMITS.explainBytes);
  const includeGlobal = optionalBoolean(source.includeGlobal, false);
  if (includeGlobal) throw new InternalRetrievalError("GLOBAL_SCOPE_DENIED");
  if (source.sessionId !== undefined
    && (typeof source.sessionId !== "string" || !UUID.test(source.sessionId))) return invalid();
  if (source.visibility !== undefined
    && !(["project", "workspace", "branch", "session"] as const).includes(
      source.visibility as RetrievalVisibility,
    )) return invalid();
  if (source.visibility === "session" && source.sessionId === undefined) return invalid();
  const validAt = source.validAt === undefined ? undefined : canonicalTimestamp(source.validAt);
  if (
    source.knownAt !== undefined
    && (
      typeof source.knownAt !== "bigint"
      || source.knownAt < 0n
      || source.knownAt > SQLITE_INT64_MAX
    )
  ) return invalid();

  return Object.freeze({
    binding: privateBinding,
    query,
    limit,
    tokenBudget,
    consistency: Object.freeze({
      requiredEventPosition: consistency.requiredEventPosition as bigint,
      deadlineMs: Number(consistency.deadlineMs),
    }),
    candidateLimit,
    explain,
    explainByteLimit,
    includeGlobal: false,
    ...(source.sessionId === undefined ? {} : { sessionId: source.sessionId as string }),
    ...(source.visibility === undefined ? {} : { visibility: source.visibility as RetrievalVisibility }),
    ...(validAt === undefined ? {} : { validAt }),
    ...(source.knownAt === undefined ? {} : { knownAt: source.knownAt as bigint }),
  });
}
