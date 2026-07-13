import type { RuntimeCapabilityResult } from "../runtime/runtime-capabilities.js";
import type {
  ProjectBindingFailure,
  ProjectBindingProvider,
} from "../identity/project-binding.service.js";
import { describeProjectBindingFailure } from "../identity/project-binding.service.js";
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

const RUNTIME_CHECK_NAMES = [
  "nodeVersionAtLeastMinimum",
  "nodeSqlite",
  "sqliteVersionAtLeastMinimum",
  "wal",
  "fts5",
  "foreignKeys",
  "synchronousFull",
  "busyTimeout",
  "trustedSchemaOff",
  "transactionRollback",
  "applicationId",
] as const;

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

function safeVersion(value: unknown): string {
  return typeof value === "string" && STABLE_VERSION.test(value) ? value : "unknown";
}

function safeChecks(value: unknown): Record<string, boolean> {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const checks: Record<string, boolean> = {};
  for (const name of RUNTIME_CHECK_NAMES) {
    if (typeof record[name] === "boolean") checks[name] = record[name];
  }
  return checks;
}

function successfulRuntimeShape(
  runtime: Record<string, unknown>,
): runtime is Record<string, unknown> & {
  nodeVersion: string;
  sqliteVersion: string;
  nodeSqlite: true;
  wal: true;
  fts5: true;
  foreignKeys: true;
  synchronousFull: true;
  busyTimeoutMs: 5000;
  trustedSchemaOff: true;
  transactionRollback: true;
  applicationId: 0x504d454d;
} {
  return typeof runtime.nodeVersion === "string"
    && STABLE_VERSION.test(runtime.nodeVersion)
    && typeof runtime.sqliteVersion === "string"
    && STABLE_VERSION.test(runtime.sqliteVersion)
    && runtime.nodeVersionAtLeastMinimum === true
    && runtime.sqliteVersionAtLeastMinimum === true
    && runtime.nodeSqlite === true
    && runtime.wal === true
    && runtime.fts5 === true
    && runtime.foreignKeys === true
    && runtime.synchronousFull === true
    && runtime.busyTimeoutMs === 5000
    && runtime.trustedSchemaOff === true
    && runtime.transactionRollback === true
    && runtime.applicationId === 0x504d454d;
}

function unsafeRuntimeSummary(
  runtime: RuntimeCapabilityResult | null,
): { summary: SafeRuntimeCapabilitySummary | null; ready: boolean } {
  if (runtime === null) return { summary: null, ready: false };
  if (typeof runtime !== "object") {
    return {
      ready: false,
      summary: {
        ok: false,
        code: "SQLITE_CAPABILITY_MISSING",
        nodeVersion: "unknown",
        checks: {},
      },
    };
  }
  const record = runtime as unknown as Record<string, unknown>;
  if (record.ok === true && successfulRuntimeShape(record)) {
    return {
      ready: true,
      summary: {
        ok: true,
        nodeVersion: record.nodeVersion,
        sqliteVersion: record.sqliteVersion,
        nodeSqlite: record.nodeSqlite,
        wal: record.wal,
        fts5: record.fts5,
        foreignKeys: record.foreignKeys,
        synchronousFull: record.synchronousFull,
        busyTimeoutMs: record.busyTimeoutMs,
        trustedSchemaOff: record.trustedSchemaOff,
        transactionRollback: record.transactionRollback,
        applicationId: record.applicationId,
      },
    };
  }
  const sqliteVersion = safeVersion(record.sqliteVersion);
  return {
    ready: false,
    summary: {
      ok: false,
      code: "SQLITE_CAPABILITY_MISSING",
      nodeVersion: safeVersion(record.nodeVersion),
      ...(sqliteVersion === "unknown" ? {} : { sqliteVersion }),
      checks: safeChecks(record.checks),
    },
  };
}

function runtimeSummary(
  runtime: RuntimeCapabilityResult | null,
): { summary: SafeRuntimeCapabilitySummary | null; ready: boolean } {
  try {
    return unsafeRuntimeSummary(runtime);
  } catch {
    return {
      ready: false,
      summary: {
        ok: false,
        code: "SQLITE_CAPABILITY_MISSING",
        nodeVersion: "unknown",
        checks: {},
      },
    };
  }
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
      : { failure: describeProjectBindingFailure(input.failure.code) };
    const state: ProjectStatusState = input.mode === "off"
      ? "disabled"
      : input.failure !== undefined
        ? "blocked"
        : !runtime.ready || binding === null
          ? "not-ready"
          : "bound";
    const contentAuthorized = state === "bound";

    return {
      mode: input.mode,
      state,
      contentAuthorized,
      ...(contentAuthorized && binding !== null ? bindingSummary(binding) : {}),
      runtime: runtime.summary,
      ...failureSummary,
      heuristicCandidates: safeCandidates(input.heuristicCandidates),
    };
  }
}
