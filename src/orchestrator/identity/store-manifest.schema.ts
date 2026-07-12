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

export const storeIntegrityResultSchema = z.object({
  status: z.enum(["passed", "failed"]),
  checkedAt: z.string().datetime({ offset: true }),
  schemaFingerprint: z.string(),
  terminalEventHash: z.string(),
}).strict();

export const storeManifestSchema = z.object({
  schemaVersion: z.literal(1),
  storeId: z.string().uuid(),
  projectId: z.string().uuid(),
  vaultId: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }),
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
