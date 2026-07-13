import { randomUUID } from "node:crypto";
import type {
  BranchScopeId,
  ProjectId,
} from "../identity/contracts.js";
import type { SqliteConnection } from "./sqlite-driver.js";

export interface BranchLocator {
  branchRef: string | null;
  headCommit: string;
  detached: boolean;
}

export interface BranchScopeRepositoryDependencies {
  randomId: () => BranchScopeId;
}

function validateLocator(locator: BranchLocator): void {
  if (
    locator.detached !== (locator.branchRef === null)
    || locator.headCommit.trim().length === 0
    || (locator.branchRef !== null && locator.branchRef.trim().length === 0)
  ) {
    throw new Error("BRANCH_LOCATOR_INVALID");
  }
}

function scopeId(value: unknown): BranchScopeId | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("BRANCH_SCOPE_INVALID");
  }
  return value as BranchScopeId;
}

export class BranchScopeRepository {
  constructor(private readonly dependencies: BranchScopeRepositoryDependencies = {
    randomId: () => randomUUID() as BranchScopeId,
  }) {}

  inspect(
    connection: SqliteConnection,
    projectId: ProjectId,
    locator: BranchLocator,
  ): BranchScopeId | null {
    validateLocator(locator);
    const row = locator.detached
      ? connection.prepare(`
          SELECT branch_scope_id
          FROM branch_scopes
          WHERE project_id = $projectId
            AND detached = 1
            AND created_head = $headCommit
            AND retired_at IS NULL
          ORDER BY created_at, branch_scope_id
          LIMIT 1
        `).get({
          $projectId: projectId,
          $headCommit: locator.headCommit,
        })
      : connection.prepare(`
          SELECT branch_scope_id
          FROM branch_scopes
          WHERE project_id = $projectId
            AND detached = 0
            AND current_ref = $branchRef
            AND retired_at IS NULL
          LIMIT 1
        `).get({
          $projectId: projectId,
          $branchRef: locator.branchRef,
        });
    return scopeId(row?.branch_scope_id);
  }

  resolveOrCreate(
    connection: SqliteConnection,
    projectId: ProjectId,
    locator: BranchLocator,
    now: string,
  ): BranchScopeId {
    validateLocator(locator);
    const existing = this.inspect(connection, projectId, locator);
    if (existing !== null) return existing;

    const branchScopeId = this.dependencies.randomId();
    connection.prepare(`
      INSERT INTO branch_scopes(
        project_id,
        branch_scope_id,
        current_ref,
        created_head,
        detached,
        created_at,
        updated_at,
        retired_at
      ) VALUES (
        $projectId,
        $branchScopeId,
        $currentRef,
        $createdHead,
        $detached,
        $createdAt,
        $updatedAt,
        NULL
      )
    `).run({
      $projectId: projectId,
      $branchScopeId: branchScopeId,
      $currentRef: locator.branchRef,
      $createdHead: locator.headCommit,
      $detached: locator.detached ? 1 : 0,
      $createdAt: now,
      $updatedAt: now,
    });
    return branchScopeId;
  }

  recordRename(
    connection: SqliteConnection,
    projectId: ProjectId,
    branchScopeId: BranchScopeId,
    newRef: string,
    now: string,
  ): void {
    if (newRef.trim().length === 0) throw new Error("BRANCH_REF_INVALID");
    const changed = connection.prepare(`
      UPDATE branch_scopes
      SET current_ref = $newRef,
          detached = 0,
          updated_at = $updatedAt
      WHERE project_id = $projectId
        AND branch_scope_id = $branchScopeId
        AND retired_at IS NULL
    `).run({
      $newRef: newRef,
      $updatedAt: now,
      $projectId: projectId,
      $branchScopeId: branchScopeId,
    }).changes;
    if (changed !== 1n) throw new Error("BRANCH_SCOPE_NOT_ACTIVE");
  }

  retire(
    connection: SqliteConnection,
    projectId: ProjectId,
    branchScopeId: BranchScopeId,
    now: string,
  ): void {
    const changed = connection.prepare(`
      UPDATE branch_scopes
      SET current_ref = NULL,
          retired_at = $retiredAt,
          updated_at = $updatedAt
      WHERE project_id = $projectId
        AND branch_scope_id = $branchScopeId
        AND retired_at IS NULL
    `).run({
      $retiredAt: now,
      $updatedAt: now,
      $projectId: projectId,
      $branchScopeId: branchScopeId,
    }).changes;
    if (changed !== 1n) throw new Error("BRANCH_SCOPE_NOT_ACTIVE");
  }
}
