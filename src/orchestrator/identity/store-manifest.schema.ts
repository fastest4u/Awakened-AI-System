import { z } from "zod";
import type { ProjectId, StoreId, VaultId } from "./contracts.js";

export type StoreIntegrityResult = {
  status: "passed" | "failed";
  checkedAt: string;
  schemaFingerprint: string;
  terminalEventHash: string;
};

export interface StoreManifestV1 {
  schemaVersion: 1;
  storeId: StoreId;
  projectId: ProjectId;
  vaultId: VaultId;
  createdAt: string;
  lastIntegrity: { status: "never" } | StoreIntegrityResult;
}

const rfc3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function isStrictRfc3339(value: string): boolean {
  const match = rfc3339.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return year >= 1
    && month >= 1 && month <= 12
    && day >= 1 && day <= (monthDays[month - 1] ?? 0)
    && hour >= 0 && hour <= 23
    && minute >= 0 && minute <= 59
    && second >= 0 && second <= 59
    && offsetHour >= 0 && offsetHour <= 23
    && offsetMinute >= 0 && offsetMinute <= 59;
}

const rfc3339Schema = z.string().refine(isStrictRfc3339, {
  message: "Invalid RFC3339 timestamp",
});

export const storeIntegrityResultSchema = z.object({
  status: z.enum(["passed", "failed"]),
  checkedAt: rfc3339Schema,
  schemaFingerprint: z.string(),
  terminalEventHash: z.string(),
}).strict();

export const storeManifestSchema = z.object({
  schemaVersion: z.literal(1),
  storeId: z.string().uuid(),
  projectId: z.string().uuid(),
  vaultId: z.string().uuid(),
  createdAt: rfc3339Schema,
  lastIntegrity: z.union([
    z.object({ status: z.literal("never") }).strict(),
    storeIntegrityResultSchema,
  ]),
}).strict();

export function parseStoreManifest(value: unknown): StoreManifestV1 {
  return storeManifestSchema.parse(value) as StoreManifestV1;
}

export function parseStoreIntegrityResult(value: unknown): StoreIntegrityResult {
  return storeIntegrityResultSchema.parse(value) as StoreIntegrityResult;
}
