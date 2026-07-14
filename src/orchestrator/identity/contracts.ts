import type { ProjectBindingSource, TrustedActorRole } from "./project-binding.request.js";

export type ProjectId = string & { readonly __projectId: unique symbol };
export type VaultId = string & { readonly __vaultId: unique symbol };
export type StoreId = string & { readonly __storeId: unique symbol };
export type WorkspaceId = string & { readonly __workspaceId: unique symbol };
export type BranchScopeId = string & { readonly __branchScopeId: unique symbol };

export interface ProjectDescriptorV1 {
  schemaVersion: 1;
  projectId: ProjectId;
  vaultId: VaultId;
  createdAt: string;
}

export interface GitWorkspaceSnapshot {
  kind: "git";
  worktreeRoot: string;
  gitDir: string;
  gitCommonDir: string;
  headCommit: string;
  branchRef: string | null;
  detached: boolean;
  workspaceId: WorkspaceId;
}

export interface NonGitWorkspaceSnapshot {
  kind: "non-git";
  workspaceRoot: string;
  workspaceId: WorkspaceId;
}

export type WorkspaceSnapshot = GitWorkspaceSnapshot | NonGitWorkspaceSnapshot;

export interface ProjectStoreRoute {
  kind: "git-common" | "vault-local";
  storeRoot: string;
  eventsPath: string;
  storeManifestPath: string;
  projectionManifestPath: string;
}

export interface ProjectBinding {
  projectBindingId: string;
  generation: number;
  contextFingerprint: string;
  source: ProjectBindingSource;
  projectId: ProjectId;
  vaultId: VaultId;
  storeId: StoreId;
  workspaceId: WorkspaceId;
  clientNamespace: string;
  clientInstanceId: string;
  actorRole: TrustedActorRole;
  projectRoot: string;
  vaultRoot: string;
  descriptorPath: string;
  storeRoute: ProjectStoreRoute;
  workspace: WorkspaceSnapshot;
  establishedAt: string;
}

export interface ProjectContext {
  binding: ProjectBinding;
  workspace: WorkspaceSnapshot;
  branchScopeId?: BranchScopeId;
  checkedAt: string;
}
