import { FreshStartError } from "../fresh-start/contracts.js";
import { isProjectionProjectStoreIdentity } from "../projections/contracts.js";
import type { RetrievalChannel, RetrievalItem, RetrievalVisibility } from "../retrieval/contracts.js";
import type { NativeContentFilters, NativeContentItem, NativeGetConflict, NativeSearchConflict, NativeSearchItem, NativeSelectionScope } from "./content-contracts.js";
import type { TrustedReadSession } from "./contracts.js";
import { copyBoundedProtocolData } from "./wire-data.js";
const CONTROL = /[\u0000-\u001f\u007f]/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const VISIBILITIES: readonly RetrievalVisibility[] = ["project", "workspace", "branch", "session"];
const KINDS: readonly RetrievalItem["kind"][] = ["canonical", "lexical", "artifact", "checkpoint", "follow-up"];
const STATUSES: readonly RetrievalItem["status"][] = ["candidate", "provisional", "verified", "conflicted", "superseded", "retracted", "expired", "erased-evidence", "active", "open", "blocked"];
const CHANNELS: readonly RetrievalChannel[] = ["exact", "alias", "lexical", "symbol-path", "session-checkpoint", "open-follow-up", "conflict-closure"];
const ITEM_KEYS = ["id", "kind", "projectId", "workspaceId", "branchScopeId", "branchRef", "sessionId", "visibility", "status", "confidence", "verificationMethod", "validFrom", "validTo", "knownFromEventPosition", "sourceEventPosition", "textKind", "text", "conflictGroupId", "supersedingItemId"];
function invalid(): never { throw new FreshStartError("FRESH_START_INPUT_INVALID"); }
/** Only used on descriptor-copied inputs. */
function record(value: unknown, allowed: readonly string[], required = allowed): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== "string" || (!empty && value.length === 0) || Buffer.byteLength(value, "utf8") > maximum || CONTROL.test(value)) invalid();
  return value;
}
function position(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value) || value.length > 19
    || (value.length === 19 && value > "9223372036854775807")) invalid();
  return value;
}
function timestamp(value: unknown): string {
  const result = text(value, 24);
  if (Number.isNaN(Date.parse(result)) || new Date(result).toISOString() !== result) invalid();
  return result;
}
function identity(value: unknown): string { if (!isProjectionProjectStoreIdentity(value)) invalid(); return value as string; }
function hash(value: unknown): string { const result = text(value, 64); if (!HASH.test(result)) invalid(); return result; }
function nullableUuid(value: unknown): string | null { if (value === null) return null; const result = text(value, 36); if (!UUID.test(result)) invalid(); return result; }
function nullableText(value: unknown, maximum = 2048): string | null { return value === null ? null : text(value, maximum); }
function visibility(value: unknown): RetrievalVisibility { if (!VISIBILITIES.includes(value as RetrievalVisibility)) invalid(); return value as RetrievalVisibility; }
function boolean(value: unknown): boolean { if (typeof value !== "boolean") invalid(); return value; }
function count(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(); return value; }
function array(value: unknown, maximum: number): readonly unknown[] { if (!Array.isArray(value) || value.length > maximum) invalid(); return value; }

export function decodeNativeSelectionScope(value: unknown): NativeSelectionScope {
  const source = record(copyBoundedProtocolData(value, 16384), ["projectId", "workspaceId", "branchScopeId", "branchRef", "sessionId", "visibility"]);
  return Object.freeze({ projectId: identity(source.projectId), workspaceId: hash(source.workspaceId),
    branchScopeId: nullableUuid(source.branchScopeId), branchRef: nullableText(source.branchRef, 1024),
    sessionId: nullableUuid(source.sessionId), visibility: visibility(source.visibility) });
}
export function decodeNativeContentItem(value: unknown, search: boolean): NativeContentItem | NativeSearchItem {
  const source = record(copyBoundedProtocolData(value, 16384), search ? [...ITEM_KEYS, "channels", "selectionReason"] : ITEM_KEYS);
  if (!KINDS.includes(source.kind as RetrievalItem["kind"]) || !STATUSES.includes(source.status as RetrievalItem["status"])
    || !["high", "medium", "low", "guess"].includes(source.confidence as string)) invalid();
  const textKind = source.kind === "canonical" ? "canonical-summary" : "projection-text";
  if (source.textKind !== textKind || typeof source.text !== "string") invalid();
  // Projected text is intentional content and may contain newlines or be empty.
  const output: NativeContentItem = Object.freeze({ id: text(source.id, 2048), kind: source.kind as RetrievalItem["kind"],
    projectId: identity(source.projectId), workspaceId: hash(source.workspaceId), branchScopeId: nullableUuid(source.branchScopeId),
    branchRef: nullableText(source.branchRef, 1024), sessionId: nullableUuid(source.sessionId), visibility: visibility(source.visibility),
    status: source.status as RetrievalItem["status"], confidence: source.confidence as RetrievalItem["confidence"], verificationMethod: text(source.verificationMethod, 2048, true),
    validFrom: source.validFrom === null ? null : timestamp(source.validFrom), validTo: source.validTo === null ? null : timestamp(source.validTo),
    knownFromEventPosition: position(source.knownFromEventPosition), sourceEventPosition: position(source.sourceEventPosition), textKind,
    text: source.text, conflictGroupId: nullableText(source.conflictGroupId), supersedingItemId: nullableText(source.supersedingItemId) });
  if (BigInt(output.knownFromEventPosition) > BigInt(output.sourceEventPosition)) invalid();
  if (!search) return output;
  const channels = array(source.channels, 7);
  if (channels.length === 0 || new Set(channels).size !== channels.length || channels.some(channel => !CHANNELS.includes(channel as RetrievalChannel))
    || !channels.includes(source.selectionReason)) invalid();
  return Object.freeze({ ...output, channels: Object.freeze([...channels]) as readonly RetrievalChannel[], selectionReason: source.selectionReason as RetrievalChannel });
}
export function decodeNativeContentConflict(value: unknown, search: boolean): NativeSearchConflict | NativeGetConflict {
  const source = record(copyBoundedProtocolData(value, 16384), search ? ["conflictGroupId", "eligibleMemberCount", "returnedMemberCount", "highImpact", "truncated"] : ["conflictGroupId", "eligibleMemberCount", "returnedMemberCount", "truncated"]);
  const eligibleMemberCount = count(source.eligibleMemberCount), returnedMemberCount = count(source.returnedMemberCount), truncated = boolean(source.truncated);
  if (returnedMemberCount > eligibleMemberCount || truncated !== (returnedMemberCount < eligibleMemberCount)) invalid();
  const common = { conflictGroupId: text(source.conflictGroupId, 2048), eligibleMemberCount, returnedMemberCount, truncated };
  if (search) return Object.freeze({ ...common, highImpact: boolean(source.highImpact) });
  if (returnedMemberCount !== 1 || eligibleMemberCount < 1) invalid();
  return Object.freeze({ ...common, returnedMemberCount: 1 });
}
export function decodeNativeContentFilters(value: unknown, trustedSession: TrustedReadSession | null): NativeContentFilters {
  const source = record(copyBoundedProtocolData(value, 8192), ["visibility", "validAt", "knownAt"], []);
  const filters = {
    ...(Object.hasOwn(source, "visibility") ? { visibility: visibility(source.visibility) } : {}),
    ...(Object.hasOwn(source, "validAt") ? { validAt: timestamp(source.validAt) } : {}),
    ...(Object.hasOwn(source, "knownAt") ? { knownAt: position(source.knownAt) } : {}),
  };
  if (filters.visibility === "session" && trustedSession === null) invalid();
  return Object.freeze(filters);
}
