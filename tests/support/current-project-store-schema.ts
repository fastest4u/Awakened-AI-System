import type { ProjectContext } from "../../src/orchestrator/identity/contracts.js";
import { MigrationRunner } from "../../src/orchestrator/storage/migration-runner.js";
import { PROJECT_STORE_MIGRATIONS } from "../../src/orchestrator/storage/migrations/registry.js";
import { SqliteQualifiedCheckpointMigrationPreflight } from "../../src/orchestrator/storage/qualified-checkpoint-migration-preflight.js";
import type { SqliteConnection } from "../../src/orchestrator/storage/sqlite-driver.js";

export interface CurrentProjectStoreIdentity {
  readonly projectId: string;
  readonly vaultId: string;
  readonly storeId: string;
}

export function applyCurrentProjectStoreSchema(
  connection: SqliteConnection,
  identity: CurrentProjectStoreIdentity,
  appliedAt: string,
): number[] {
  const preflight = new SqliteQualifiedCheckpointMigrationPreflight();
  return new MigrationRunner().apply(
    connection,
    PROJECT_STORE_MIGRATIONS,
    appliedAt,
    {
      kind: "bootstrap-empty",
      beforeMigration(migrationConnection, migration): void {
        if (migration.version !== 3) return;
        migrationConnection.prepare(`
          INSERT INTO project_meta(
            singleton, project_id, vault_id, store_id, schema_version, created_at
          ) VALUES (1, $projectId, $vaultId, $storeId, 2, $createdAt)
        `).run({
          $projectId: identity.projectId,
          $vaultId: identity.vaultId,
          $storeId: identity.storeId,
          $createdAt: appliedAt,
        });
        migrationConnection.exec(`
          INSERT INTO maintenance_state(
            singleton, epoch, mode, owner_id, fencing_token, lease_expires_at, requested_at
          ) VALUES (1, 0, 'idle', NULL, 0, NULL, NULL)
        `);
        preflight.assertEligibleAndStage(
          migrationConnection,
          {
            binding: {
              projectId: identity.projectId,
              vaultId: identity.vaultId,
              storeId: identity.storeId,
            },
          } as ProjectContext,
        );
      },
    },
  );
}
