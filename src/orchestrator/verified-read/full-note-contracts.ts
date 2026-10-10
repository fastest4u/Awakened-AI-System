import type { GovernedNoteKind } from "../governed-notes/contracts.js";
import type { ContentReadBase, NativeContentFilters, NativeContentItem, NativeGetConflict, NativeSelectionScope } from "./content-contracts.js";
import type { ReadSuccessBase, VerifiedReadReceipt } from "./contracts.js";

export type GetFullNoteRequest = ContentReadBase & Readonly<{
  operation: "get-full-note"; parameters: NativeContentFilters & Readonly<{ id: string }>;
}>;
export type NativeFullNoteItem = NativeContentItem & (
  | Readonly<{ recordKind: GovernedNoteKind; bodyAvailability: "present";
      content: Readonly<{ format: "markdown"; body: string; contentHash: string }> }>
  | Readonly<{ recordKind: GovernedNoteKind | null; bodyAvailability: "absent"; content: null }>
);
export type NativeFullNoteResultV1 = Readonly<{
  operation: "get-full-note"; noteBoundsVersion: "v2-full-note-bounds-1";
  selectionScope: NativeSelectionScope; item: NativeFullNoteItem | null; conflict: NativeGetConflict | null;
}>;
export type FullNoteVerifiedReadReceiptV1 = Omit<VerifiedReadReceipt, "operation"> & {
  operation: "get-full-note"; projectionSchemaVersion: 3;
};
export type FullNoteReadSuccessBaseV1 = Omit<ReadSuccessBase, "version" | "receipt"> & {
  version: 4; receipt: FullNoteVerifiedReadReceiptV1;
};
