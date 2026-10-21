import type { ErasureFenceRecordV1 } from "../keys/operational-key-custody.js";

export type BackupTriggerReason =
  | "hourly-active"
  | "pre-upgrade"
  | "orderly-shutdown"
  | "manual";

export interface V2BackupManifestV1 {
  readonly manifestVersion: 1;
  readonly backupId: string;
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly releaseId: string;
  readonly createdAt: string;
  readonly reason: BackupTriggerReason;
  readonly terminalGlobalPosition: string;
  readonly terminalGlobalHash: string;
  readonly eventStoreSchemaVersion: number;
  readonly projectionSchemaVersion: 3;
  readonly files: Readonly<{
    readonly eventsSqliteSha256: string;
    readonly freshStartReleaseSha256: string;
    readonly projectIdentitySha256: string;
    readonly storeManifestSha256: string;
    readonly erasureFencesSha256: string;
  }>;
  readonly backupManifestDigest: string;
}

export interface BackupHealthStatus {
  readonly healthy: boolean;
  readonly backupOverdue: boolean;
  readonly lastVerifiedBackupId: string | null;
  readonly lastVerifiedBackupAt: string | null;
  readonly lastBackedUpGlobalPosition: string | null;
  readonly currentGlobalPosition: string;
  readonly hasUnbackedEvents: boolean;
}

export interface RestoreVerificationReceipt {
  readonly status: "active" | "incomplete-fence";
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
  readonly restoredGlobalPosition: string;
  readonly restoredGlobalHash: string;
  readonly replayedEventsCount: number;
  readonly erasedEvidenceIdsApplied: readonly string[];
  readonly missingRange?: Readonly<{
    readonly fromExclusivePosition: string;
    readonly toInclusivePosition: string;
    readonly expectedHash: string;
  }>;
  readonly projectionIntegrityVerified: boolean;
  readonly eventIntegrityVerified: boolean;
}

export interface RollbackCompatibilityReceipt {
  readonly compatible: boolean;
  readonly currentEventStoreSchemaVersion: number;
  readonly targetEventStoreSchemaVersion: number;
  readonly currentProjectionSchemaVersion: number;
  readonly targetProjectionSchemaVersion: number;
  readonly currentMigrationFingerprint: string;
  readonly targetMigrationFingerprint: string;
  readonly requiresRestoreFromPreUpgradeBackup: boolean;
}

export type { ErasureFenceRecordV1 };
