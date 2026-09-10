import { createHash } from "node:crypto";

import { canonicalJson } from "../serialization/canonical-json.js";
import { isProjectionProjectStoreIdentity } from "./contracts.js";

export const PROJECTION_NAMES = Object.freeze([
  "sessionTree",
  "sessionCheckpoints",
  "canonicalItems",
  "tasksFollowups",
  "artifactsFiles",
  "entityGraph",
  "lexicalChunks",
  "retrievalFeedback",
] as const);

export type ProjectionName = (typeof PROJECTION_NAMES)[number];
export type CanonicalProjectionValue = null | boolean | number | string;
export type CanonicalProjectionRow = Readonly<Record<string, CanonicalProjectionValue>>;

const MAX_ROWS = 100_000;
const MAX_COLUMNS = 64;
const MAX_KEY_BYTES = 128;
const MAX_VALUE_BYTES = 256 * 1_024;
const MAX_CANONICAL_BYTES = 32 * 1024 * 1024;
const SQLITE_INT64_MAX = 9_223_372_036_854_775_807n;

function invalid(): never {
  throw new TypeError("PROJECTION_CHECKSUM_INVALID");
}

function isProjectionName(value: unknown): value is ProjectionName {
  return typeof value === "string" && PROJECTION_NAMES.includes(value as ProjectionName);
}

function validateRows(rows: readonly CanonicalProjectionRow[]): void {
  if (
    !Array.isArray(rows)
    || Object.getPrototypeOf(rows) !== Array.prototype
    || rows.length > MAX_ROWS
    || Reflect.ownKeys(rows).length !== rows.length + 1
  ) invalid();
  let canonicalBytes = 2 + rows.length;
  for (let index = 0; index < rows.length; index += 1) {
    const rowDescriptor = Object.getOwnPropertyDescriptor(rows, String(index));
    if (rowDescriptor === undefined || !rowDescriptor.enumerable || !("value" in rowDescriptor)) {
      invalid();
    }
    const row = rowDescriptor.value as unknown;
    if (typeof row !== "object" || row === null || Array.isArray(row)) invalid();
    const prototype = Object.getPrototypeOf(row) as unknown;
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const keys = Reflect.ownKeys(row);
    if (keys.length > MAX_COLUMNS) invalid();
    canonicalBytes += 2 + keys.length;
    for (const key of keys) {
      if (typeof key !== "string" || Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) invalid();
      canonicalBytes += Buffer.byteLength(JSON.stringify(key), "utf8") + 1;
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) invalid();
      const value = descriptor.value as unknown;
      if (
        value !== null
        && typeof value !== "boolean"
        && typeof value !== "number"
        && typeof value !== "string"
      ) invalid();
      if (typeof value === "number" && !Number.isFinite(value)) invalid();
      if (typeof value === "string" && Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) invalid();
      canonicalBytes += Buffer.byteLength(JSON.stringify(value), "utf8");
      if (canonicalBytes > MAX_CANONICAL_BYTES) invalid();
    }
  }
}

export function sha256Utf8(value: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_CANONICAL_BYTES) invalid();
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function projectionCoreChecksum(
  name: ProjectionName,
  schemaVersion: number,
  projectId: string,
  terminalEventPosition: bigint,
  rows: readonly CanonicalProjectionRow[],
): string {
  if (
    !isProjectionName(name)
    || !Number.isSafeInteger(schemaVersion)
    || schemaVersion < 1
    || schemaVersion > 2_147_483_647
    || !isProjectionProjectStoreIdentity(projectId)
    || typeof terminalEventPosition !== "bigint"
    || terminalEventPosition < 0n
    || terminalEventPosition > SQLITE_INT64_MAX
  ) invalid();
  validateRows(rows);
  return sha256Utf8(
    "project-memory/projection-core/v1\n"
      + canonicalJson([
        name,
        schemaVersion,
        projectId,
        terminalEventPosition.toString(),
        rows,
      ]),
  );
}
