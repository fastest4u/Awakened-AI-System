import { FreshStartError } from "../fresh-start/contracts.js";
import { types } from "node:util";
import { assertMarkdownNoteBodyV1, governedNoteBodyHash } from "../governed-notes/body-content.js";

function invalid(): never { throw new FreshStartError("FRESH_START_INPUT_INVALID"); }
function wellFormed(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) return false;
  }
  return true;
}
/** Copies only own data descriptors. Charging includes escaped keys/strings and JSON punctuation. */
export function copyBoundedProtocolData(value: unknown, maximumBytes: 8192 | 16384): unknown {
  let bytes = 0, containers = 0;
  const charge = (amount: number) => { bytes += amount; if (bytes > maximumBytes) invalid(); };
  const copy = (input: unknown, depth: number): unknown => {
    if (input === null) { charge(4); return null; }
    if (typeof input === "string") {
      if (!wellFormed(input) || input.length > 2048 || Buffer.byteLength(input, "utf8") > 2048) invalid();
      charge(Buffer.byteLength(JSON.stringify(input), "utf8")); return input;
    }
    if (typeof input === "boolean") { charge(input ? 4 : 5); return input; }
    if (typeof input === "number") { if (!Number.isFinite(input)) invalid(); charge(JSON.stringify(input).length); return input; }
    if (typeof input !== "object" || depth > 8 || ++containers > 128) invalid();
    const prototype: unknown = Object.getPrototypeOf(input);
    const array = Array.isArray(input);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid();
    const keys = Reflect.ownKeys(input);
    if (array) {
      const length = Object.getOwnPropertyDescriptor(input, "length");
      if (!length || !("value" in length) || !Number.isInteger(length.value) || length.value < 0 || length.value > 64
        || keys.length !== length.value + 1) invalid();
      const descriptors: PropertyDescriptor[] = [];
      for (let index = 0; index < length.value; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
        descriptors.push(descriptor);
      }
      if (keys.some(key => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key)))) invalid();
      charge(2 + Math.max(0, descriptors.length - 1));
      const output: unknown[] = [];
      for (const descriptor of descriptors) output.push(copy(descriptor.value, depth + 1));
      return Object.freeze(output);
    }
    if (keys.length > 32) invalid();
    charge(2 + Math.max(0, keys.length - 1));
    const descriptors: [string, PropertyDescriptor][] = [];
    for (const key of keys) {
      if (typeof key !== "string" || key.length > 128) invalid();
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
      if (!wellFormed(key)) invalid();
      charge(Buffer.byteLength(JSON.stringify(key), "utf8") + 1); descriptors.push([key, descriptor]);
    }
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of descriptors) output[key] = copy(descriptor.value, depth + 1);
    return Object.freeze(output);
  };
  try { return copy(value, 0); } catch { return invalid(); }
}
/** Measurement is for already copied data only; it is not validation or authority. */
export function encodedProtocolBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }

const FULL_ITEM_KEYS = ["id", "kind", "projectId", "workspaceId", "branchScopeId", "branchRef", "sessionId", "visibility", "status", "confidence",
  "verificationMethod", "validFrom", "validTo", "knownFromEventPosition", "sourceEventPosition", "textKind", "text", "conflictGroupId", "supersedingItemId",
  "recordKind", "bodyAvailability", "content"];
const FULL_RESULT_KEYS = ["operation", "noteBoundsVersion", "selectionScope", "item", "conflict"];
const FULL_RECEIPT_KEYS = ["operation", "consistency", "scope", "releaseId", "controlGeneration", "requiredEventPosition", "projectionGeneration",
  "projectionEventPosition", "projectionEventHash", "imageSha256", "verification", "projectionSchemaVersion"];
const SELECTION_KEYS = ["projectId", "workspaceId", "branchScopeId", "branchRef", "sessionId", "visibility"];
const FULL_KINDS = ["session-log", "insight", "mistake", "adr"];
function fullRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  // Proxy detection must precede *every* reflective operation, including prototype/descriptor reads.
  if (!input || typeof input !== "object" || types.isProxy(input) || Array.isArray(input)) invalid();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const actual = Reflect.ownKeys(input);
  if (actual.length > 32 || actual.length !== keys.length || actual.some(key => typeof key !== "string" || !keys.includes(key))) invalid();
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
    output[key] = descriptor.value;
  }
  return output;
}
function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}
/** Exact structural admission and descriptor ownership precede the sole body allowance.
 * Both encoded budgets are charged independently; no fields are stripped to fit. */
function copyFullNote(value: unknown, success: boolean): unknown {
  let bytes = 0, metadata = 0, containers = 0;
  const prefix = success ? ["content"] : [];
  const bodyPath = [...prefix, "item", "content", "body"];
  const schemas: readonly (readonly [readonly string[], readonly string[]])[] = [
    [prefix, FULL_RESULT_KEYS], [[...prefix, "selectionScope"], SELECTION_KEYS], [[...prefix, "item"], FULL_ITEM_KEYS],
    [[...prefix, "item", "content"], ["format", "body", "contentHash"]],
    [[...prefix, "conflict"], ["conflictGroupId", "eligibleMemberCount", "returnedMemberCount", "truncated"]],
    ...(success ? [
      [[], ["version", "ids", "kind", "receipt", "fence", "closed", "content"]],
      [["ids"], ["requestId", "attemptId", "laneEpoch"]], [["receipt"], FULL_RECEIPT_KEYS],
      [["receipt", "scope"], ["projectId", "vaultId", "storeId", "workspaceId", "branchScopeId", "branchRef", "sessionId"]],
      [["fence"], ["controlGeneration", "releaseId", "capturedPosition", "capturedHash", "requiredPosition"]],
      [["closed"], ["image", "reader", "lock"]],
    ] as const : []),
  ];
  const charge = (amount: number, body = false) => {
    bytes += amount; metadata += body ? 2 : amount;
    if (bytes > 262144 || metadata > 65536) invalid();
  };
  const copy = (input: unknown, path: readonly string[]): unknown => {
    const schema = schemas.find(([at]) => samePath(at, path));
    const nullable = samePath(path, [...prefix, "item"]) || samePath(path, [...prefix, "conflict"]) || samePath(path, [...prefix, "item", "content"]);
    if (input === null && (!schema || nullable)) { charge(4); return null; }
    if (schema) {
      if (path.length > 8 || ++containers > 128) invalid();
      const source = fullRecord(input, schema[1]);
      if (samePath(path, prefix) && (source.operation !== "get-full-note" || source.noteBoundsVersion !== "v2-full-note-bounds-1")) invalid();
      if (success && path.length === 0) {
        if (source.version !== 4 || source.kind !== "success") invalid();
        const receipt = fullRecord(source.receipt, FULL_RECEIPT_KEYS);
        if (receipt.operation !== "get-full-note" || receipt.projectionSchemaVersion !== 3) invalid();
      }
      if (samePath(path, [...prefix, "item"])) {
        if (source.kind !== "canonical" || source.textKind !== "canonical-summary") invalid();
        if (source.bodyAvailability === "present") {
          if (!FULL_KINDS.includes(source.recordKind as string)) invalid();
          const content = fullRecord(source.content, ["format", "body", "contentHash"]);
          if (content.format !== "markdown") invalid();
        } else if (source.bodyAvailability !== "absent" || source.content !== null
          || (source.recordKind !== null && !FULL_KINDS.includes(source.recordKind as string))) invalid();
      }
      charge(2 + Math.max(0, schema[1].length - 1));
      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const key of schema[1]) { charge(Buffer.byteLength(JSON.stringify(key), "utf8") + 1); output[key] = copy(source[key], [...path, key]); }
      if (samePath(path, [...prefix, "item", "content"])) {
        if (output.format !== "markdown" || typeof output.contentHash !== "string"
          || governedNoteBodyHash({ format: "markdown", body: output.body as string }) !== output.contentHash) invalid();
      }
      return Object.freeze(output);
    }
    if (typeof input === "string") {
      const body = samePath(path, bodyPath);
      if (body) assertMarkdownNoteBodyV1(input);
      else if (!wellFormed(input) || input.length > 2048 || Buffer.byteLength(input, "utf8") > 2048) invalid();
      const size = Buffer.byteLength(JSON.stringify(input), "utf8");
      if (body && size > 131074) invalid();
      charge(size, body); return input;
    }
    if (typeof input === "boolean") { charge(input ? 4 : 5); return input; }
    if (typeof input === "number" && Number.isFinite(input)) { charge(JSON.stringify(input).length); return input; }
    // No admitted full-note field contains arrays or arbitrary metadata containers.
    return invalid();
  };
  try { return copy(value, []); } catch { return invalid(); }
}
export function copyBoundedFullNoteSuccessData(value: unknown): unknown { return copyFullNote(value, true); }
export function copyBoundedFullNoteResultData(value: unknown): unknown { return copyFullNote(value, false); }
