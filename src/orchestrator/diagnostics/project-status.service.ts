import type { RuntimeCapabilityResult } from "../runtime/runtime-capabilities.js";
import type {
  ProjectBindingFailure,
  ProjectBindingProvider,
} from "../identity/project-binding.service.js";
import type { ProjectBinding } from "../identity/contracts.js";

export type OrchestratorMode = "off" | "shadow" | "primary";
export type ProjectStatusState = "disabled" | "bound" | "blocked" | "not-ready";

export interface HeuristicProjectCandidate {
  label: "heuristic";
  projectRoot: string;
  vaultRoot?: string;
  projectId?: string;
  vaultId?: string;
  reason: string;
}

export interface SafeHeuristicProjectCandidate {
  label: "heuristic-unselected";
  projectRoot: string;
  vaultRoot?: string;
  projectId?: string;
  vaultId?: string;
  reason: string;
}

export interface ProjectStatusInput {
  mode: OrchestratorMode;
  runtime: RuntimeCapabilityResult | null;
  failure?: ProjectBindingFailure;
  heuristicCandidates?: readonly HeuristicProjectCandidate[];
}

export interface SafeRuntimeCapabilitySummary {
  ok: boolean;
  code?: "SQLITE_CAPABILITY_MISSING";
  nodeVersion: string;
  sqliteVersion?: string;
  checks?: Record<string, boolean>;
  nodeSqlite?: true;
  wal?: true;
  fts5?: true;
  foreignKeys?: true;
  synchronousFull?: true;
  busyTimeoutMs?: 5000;
  trustedSchemaOff?: true;
  transactionRollback?: true;
  applicationId?: 0x504d454d;
}

export interface ProjectStatus {
  mode: OrchestratorMode;
  state: ProjectStatusState;
  contentAuthorized: boolean;
  project?: { projectId: string; root: string };
  vault?: { vaultId: string; root: string };
  store?: {
    storeId: string;
    kind: "git-common" | "vault-local";
    root: string;
    eventsPath: string;
  };
  workspace?: {
    workspaceId: string;
    kind: "git" | "non-git";
    root: string;
  };
  branch?: {
    ref: string | null;
    headCommit: string;
    detached: boolean;
  };
  runtime: SafeRuntimeCapabilitySummary | null;
  failure?: {
    code: ProjectBindingFailure["code"];
    message: string;
    remediation: string[];
  };
  heuristicCandidates: SafeHeuristicProjectCandidate[];
}

function runtimeSummary(
  runtime: RuntimeCapabilityResult | null,
): SafeRuntimeCapabilitySummary | null {
  if (runtime === null) return null;
  if (!runtime.ok) {
    return {
      ok: false,
      code: runtime.code,
      nodeVersion: runtime.nodeVersion,
      ...(runtime.sqliteVersion === undefined ? {} : { sqliteVersion: runtime.sqliteVersion }),
      checks: { ...runtime.checks },
    };
  }
  return {
    ok: true,
    nodeVersion: runtime.nodeVersion,
    sqliteVersion: runtime.sqliteVersion,
    nodeSqlite: runtime.nodeSqlite,
    wal: runtime.wal,
    fts5: runtime.fts5,
    foreignKeys: runtime.foreignKeys,
    synchronousFull: runtime.synchronousFull,
    busyTimeoutMs: runtime.busyTimeoutMs,
    trustedSchemaOff: runtime.trustedSchemaOff,
    transactionRollback: runtime.transactionRollback,
    applicationId: runtime.applicationId,
  };
}

function bindingSummary(binding: ProjectBinding): Pick<
  ProjectStatus,
  "project" | "vault" | "store" | "workspace" | "branch"
> {
  const workspace = binding.workspace.kind === "git"
    ? {
        workspaceId: binding.workspaceId,
        kind: "git" as const,
        root: binding.workspace.worktreeRoot,
      }
    : {
        workspaceId: binding.workspaceId,
        kind: "non-git" as const,
        root: binding.workspace.workspaceRoot,
      };
  return {
    project: { projectId: binding.projectId, root: binding.projectRoot },
    vault: { vaultId: binding.vaultId, root: binding.vaultRoot },
    store: {
      storeId: binding.storeId,
      kind: binding.storeRoute.kind,
      root: binding.storeRoute.storeRoot,
      eventsPath: binding.storeRoute.eventsPath,
    },
    workspace,
    ...(binding.workspace.kind === "git"
      ? {
          branch: {
            ref: binding.workspace.branchRef,
            headCommit: binding.workspace.headCommit,
            detached: binding.workspace.detached,
          },
        }
      : {}),
  };
}

function safeCandidates(
  candidates: readonly HeuristicProjectCandidate[] | undefined,
): SafeHeuristicProjectCandidate[] {
  return (candidates ?? []).map((candidate) => ({
    label: "heuristic-unselected",
    projectRoot: candidate.projectRoot,
    ...(candidate.vaultRoot === undefined ? {} : { vaultRoot: candidate.vaultRoot }),
    ...(candidate.projectId === undefined ? {} : { projectId: candidate.projectId }),
    ...(candidate.vaultId === undefined ? {} : { vaultId: candidate.vaultId }),
    reason: candidate.reason,
  }));
}

export class ProjectStatusService {
  constructor(private readonly bindingProvider: ProjectBindingProvider) {}

  status(input: ProjectStatusInput): ProjectStatus {
    const binding = this.bindingProvider.current();
    const runtime = runtimeSummary(input.runtime);
    const failureSummary = input.failure === undefined
      ? {}
      : {
          failure: {
            code: input.failure.code,
            message: input.failure.message,
            remediation: [...input.failure.remediation],
          },
        };
    const unavailable = input.failure !== undefined || input.runtime?.ok === false;
    const state: ProjectStatusState = input.mode === "off"
      ? "disabled"
      : unavailable
        ? "blocked"
        : binding === null
          ? "not-ready"
          : "bound";
    const contentAuthorized = state === "bound";

    return {
      mode: input.mode,
      state,
      contentAuthorized,
      ...(contentAuthorized && binding !== null ? bindingSummary(binding) : {}),
      runtime,
      ...failureSummary,
      heuristicCandidates: safeCandidates(input.heuristicCandidates),
    };
  }
}
