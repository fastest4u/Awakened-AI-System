import type { RetrievalChannel, RetrievalItem, RetrievalVisibility } from "../retrieval/contracts.js";
import type { MetadataVerifiedReadRequest, VerifiedReadReceipt } from "./contracts.js";

export const NATIVE_CONTENT_BOUNDS_VERSION = "v2-native-content-bounds-1";
export const NATIVE_CONTENT_RANKING_VERSION = "retrieval-ranking-v2-shadow-fixed-units";
export type NativeContentFilters = Readonly<{ visibility?: RetrievalVisibility; validAt?: string; knownAt?: string }>;
type ContentReadBase = Readonly<{ consistency: MetadataVerifiedReadRequest["consistency"]; minimumEventPosition: string; budgetMs: number }>;
export type SearchProjectedContentRequest = ContentReadBase & Readonly<{
  operation: "search-projected-content"; parameters: NativeContentFilters & Readonly<{ query: string; limit?: number }>;
}>;
export type GetCanonicalRecordRequest = ContentReadBase & Readonly<{
  operation: "get-canonical-record"; parameters: NativeContentFilters & Readonly<{ id: string }>;
}>;
export type VerifiedContentReadRequest = SearchProjectedContentRequest | GetCanonicalRecordRequest;
export type NativeSelectionScope = Readonly<{
  projectId: string; workspaceId: string; branchScopeId: string | null; branchRef: string | null;
  sessionId: string | null; visibility: RetrievalVisibility;
}>;
export type NativeContentItem = Readonly<{
  id: string; kind: RetrievalItem["kind"]; projectId: string; workspaceId: string;
  branchScopeId: string | null; branchRef: string | null; sessionId: string | null;
  visibility: RetrievalVisibility; status: RetrievalItem["status"]; confidence: RetrievalItem["confidence"];
  verificationMethod: string; validFrom: string | null; validTo: string | null;
  knownFromEventPosition: string; sourceEventPosition: string;
  textKind: "canonical-summary" | "projection-text"; text: string;
  conflictGroupId: string | null; supersedingItemId: string | null;
}>;
export type NativeSearchItem = NativeContentItem & Readonly<{ channels: readonly RetrievalChannel[]; selectionReason: RetrievalChannel }>;
export type NativeSearchConflict = Readonly<{
  conflictGroupId: string; eligibleMemberCount: number; returnedMemberCount: number; highImpact: boolean; truncated: boolean;
}>;
export type NativeGetConflict = Readonly<{
  conflictGroupId: string; eligibleMemberCount: number; returnedMemberCount: 1; truncated: boolean;
}>;
export type NativeSearchResult = Readonly<{
  operation: "search-projected-content"; selectionScope: NativeSelectionScope;
  rankingPolicyVersion: typeof NATIVE_CONTENT_RANKING_VERSION; contentBoundsVersion: typeof NATIVE_CONTENT_BOUNDS_VERSION;
  items: readonly NativeSearchItem[]; conflicts: readonly NativeSearchConflict[];
  candidateBounded: boolean; selectionTruncated: boolean; byteBounded: boolean;
}>;
export type NativeGetResult = Readonly<{
  operation: "get-canonical-record"; selectionScope: NativeSelectionScope; item: NativeContentItem | null; conflict: NativeGetConflict | null;
}>;
export type NativeContentResult = NativeSearchResult | NativeGetResult;
export type VerifiedContentReadResult = Readonly<{ receipt: VerifiedReadReceipt; content: NativeContentResult }>;
