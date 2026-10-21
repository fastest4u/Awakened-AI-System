import { types } from "node:util";
import type { FullNoteReadSuccessBaseV1, NativeFullNoteResultV1 } from "./full-note-contracts.js";
import { decodeFullNoteVerifiedReadReceipt, decodeNativeFullNoteResult } from "./full-note-protocol.js";
import { decodeReadReply } from "./protocol.js";
import { copyBoundedFullNoteSuccessData } from "./wire-data.js";

function tooLarge(): never { throw Object.assign(new Error("V2_CONTENT_RESULT_TOO_LARGE"), { code: "V2_CONTENT_RESULT_TOO_LARGE" }); }
/** Reserve actual complete supplied bytes. Prospective closed fields do not attest cleanup or authorize emission. */
export function buildNativeFullNoteResult(candidate: NativeFullNoteResultV1, base: FullNoteReadSuccessBaseV1): NativeFullNoteResultV1 {
  let copied: FullNoteReadSuccessBaseV1 & { content: unknown };
  try {
    // Do not spread untrusted base: that invokes accessors before ownership and can omit hidden fields.
    if (!base || typeof base !== "object" || types.isProxy(base) || Array.isArray(base)) return tooLarge();
    const prototype: unknown = Object.getPrototypeOf(base);
    if (prototype !== Object.prototype && prototype !== null) return tooLarge();
    const keys = Reflect.ownKeys(base), expected = ["version", "ids", "kind", "receipt", "fence", "closed"];
    if (keys.length !== expected.length || keys.some(key => typeof key !== "string" || !expected.includes(key))) return tooLarge();
    const envelope: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(base, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return tooLarge();
      envelope[key] = descriptor.value;
    }
    envelope.content = candidate;
    copied = copyBoundedFullNoteSuccessData(envelope) as FullNoteReadSuccessBaseV1 & { content: unknown };
    const verified = decodeFullNoteVerifiedReadReceipt(copied.receipt);
    const { projectionSchemaVersion: _schema, ...receipt } = verified;
    // Only the explicit body-free base adapter enters the historical validators for IDs/fence/closure.
    decodeReadReply({ version: 3, kind: "success", ids: copied.ids, fence: copied.fence, closed: copied.closed,
      receipt: { ...receipt, operation: "verify-published-view" } });
  } catch { return tooLarge(); }
  return decodeNativeFullNoteResult(copied.content);
}
