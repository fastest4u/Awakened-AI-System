import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "../orchestrator/contracts/event.js";
import {
  FreshStartError,
  type FreshStartIdentity,
  type FreshStartRelease,
  type FreshStartState,
} from "../orchestrator/fresh-start/contracts.js";
import { bindFreshStartAdmissionContext } from "../orchestrator/fresh-start/fresh-start-admission.js";
import type { FreshStartPaths } from "../orchestrator/fresh-start/fresh-start-paths.js";
import {
  GovernedLifecycleService,
  type GovernedLifecycleMutationReceiptV1,
  type GovernedVerificationPolicyMethodV1,
} from "../orchestrator/governance/governance.service.js";
import {
  deriveGovernedNoteBinding,
  governedNoteCreateProofTargetV2,
} from "../orchestrator/governed-notes/authority.js";
import { decodeGovernedNoteCommandV2 } from "../orchestrator/governed-notes/codec.js";
import type {
  GovernedNoteKind,
  GovernedNoteStoredReceiptV2,
} from "../orchestrator/governed-notes/contracts.js";
import { validateGovernedNotePairAny } from "../orchestrator/governed-notes/pair-validation.js";
import { GovernedNoteRepository } from "../orchestrator/governed-notes/repository.js";
import { GovernedNoteRuntimeFactory } from "../orchestrator/governed-notes/runtime.factory.js";
import type {
  BranchScopeId,
  ProjectContext,
  ProjectDescriptorV1,
  ProjectId,
  ProjectStoreRoute,
  StoreId,
  VaultId,
  WorkspaceId,
  WorkspaceSnapshot,
} from "../orchestrator/identity/contracts.js";
import { computeProjectContextFingerprint } from "../orchestrator/identity/project-binding.service.js";
import { SpawnSyncGitCommandRunner } from "../orchestrator/identity/git-workspace.resolver.js";
import { EventIntegrityService } from "../orchestrator/integrity/event-integrity.service.js";
import { OperationalKeyCustodyProvider } from "../orchestrator/keys/operational-key-custody.js";
import {
  issueRecoveryApproval,
  verifyRecoveryApproval,
} from "../orchestrator/lifecycle/authority/approval-codec.js";
import { createCapabilityProof } from "../orchestrator/lifecycle/authority/capability-codec.js";
import {
  CapabilityService,
  type StoredCapabilityMaterialV1,
} from "../orchestrator/lifecycle/capability.service.js";
import type { CheckpointDraftV2 } from "../orchestrator/lifecycle/contracts/checkpoint.js";
import { decodeLifecycleSemanticCommandDraft } from "../orchestrator/lifecycle/contracts/commands.js";
import type { SessionId } from "../orchestrator/lifecycle/contracts/identifiers.js";
import { connectionBoundEvidenceCoverage } from "../orchestrator/lifecycle/lifecycle-command.store.js";
import { buildLifecycleIntentWitness } from "../orchestrator/lifecycle/lifecycle-intent-witness.js";
import { decodeRetainEvidenceBatch } from "../orchestrator/privacy/evidence-contracts.js";
import type { TrustedRedactionPolicyV1 } from "../orchestrator/privacy/redaction.js";
import { retainedEvidenceProofTarget } from "../orchestrator/privacy/retained-evidence-authority.js";
import { RetainedEvidenceRuntimeFactory } from "../orchestrator/privacy/retained-evidence-runtime.factory.js";
import { ImmutableProjectionBuilder } from "../orchestrator/projections/builder.js";
import type { ProjectBinding } from "../orchestrator/projections/contracts.js";
import { V2ProjectionBuildCoordinator } from "../orchestrator/projections/coordinator.js";
import { SqliteProjectionEventReader } from "../orchestrator/projections/event-reader.js";
import { openImmutableProjectionImage } from "../orchestrator/projections/immutable-image.js";
import {
  parseRichProjectionManifest,
  type ProjectionManifestV3,
} from "../orchestrator/projections/manifest-codec.js";
import type { ProjectionDirectoryIdentity } from "../orchestrator/projections/stable-directory.js";
import { decodeLifecycleWorkerOperationWire } from "../orchestrator/runtime/lifecycle-worker-protocol.js";
import { LifecycleWorkerRuntimeFactory } from "../orchestrator/runtime/lifecycle-worker-runtime.factory.js";
import { canonicalJson } from "../orchestrator/serialization/canonical-json.js";
import { ChildTransferRepository } from "../orchestrator/storage/child-transfer.repository.js";
import { GENESIS_GLOBAL_HASH } from "../orchestrator/storage/event-chain-constants.js";
import { EvidenceCoverageRepository } from "../orchestrator/storage/evidence-coverage.repository.js";
import { LifecycleApprovalRepository } from "../orchestrator/storage/lifecycle-approval.repository.js";
import { SqliteLifecycleProjectionRepository } from "../orchestrator/storage/lifecycle-projection.repository.js";
import type { SessionAuthorityRecord } from "../orchestrator/storage/lifecycle-storage.types.js";
import { MaintenanceFence } from "../orchestrator/storage/maintenance-fence.js";
import { NodeSqliteDriver } from "../orchestrator/storage/node-sqlite-driver.js";
import { SessionAuthorityRepository } from "../orchestrator/storage/session-authority.repository.js";
import { SessionLeaseRepository } from "../orchestrator/storage/session-lease.repository.js";
import type { SqliteConnection } from "../orchestrator/storage/sqlite-driver.js";
import { queryNativeContent } from "../orchestrator/verified-read/content-query.js";
import { buildNativeContentResult } from "../orchestrator/verified-read/content-result.js";
import type { VerifiedReadBinding } from "../orchestrator/verified-read/contracts.js";
import {
  decodeFullNoteVerifiedReadReceipt,
  decodeGetFullNoteRequest,
} from "../orchestrator/verified-read/full-note-protocol.js";
import { queryNativeFullNote } from "../orchestrator/verified-read/full-note-query.js";
import { buildNativeFullNoteResult } from "../orchestrator/verified-read/full-note-result.js";
import {
  decodeVerifiedReadReceipt,
  decodeVerifiedReadRequest,
} from "../orchestrator/verified-read/protocol.js";
import { createVerifiedReadAdapter } from "../orchestrator/verified-read/supervisor.js";
import type { NativeCanonicalPageResult } from "../orchestrator/verified-read/workflow-contracts.js";
import {
  V2_NATIVE_TOOLS,
  V2_SUPERSEDED_V1_TOOLS,
  V2_SUPPORTED_V1_TOOLS,
  V2_UNAVAILABLE_V1_TOOLS,
} from "./capabilities.js";

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Readonly<Record<string, unknown>>;
    readonly additionalProperties?: boolean;
  };
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly openWorldHint: boolean;
  };
}

export const STATUS_TOOL_DEFINITION: McpToolDefinition = Object.freeze({
  name: "memory_v2Status",
  description: "Redacted fresh-start V2 status and capability posture.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  }),
  annotations: Object.freeze({
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  }),
});

const THAI_WORD_SEGMENTER =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("th", { granularity: "word" })
    : null;

const READ_ONLY_PUBLIC_TOOLS = new Set<string>([
  "memory_v2Status",
  "memory_search",
  "memory_get",
  "memory_list",
  "memory_recent",
  "memory_contextPack",
  "memory_followUpRadar",
  "memory_awaken",
  "memory_verifyVault",
  "memory_verifyNote",
  "memory_verifySourceTruth",
  "memory_findDuplicates",
  "memory_checkStaleness",
  "memory_lifecycleStatus",
  "memory_selfCheck",
]);

const PROJECT_ROOT_PROP = Object.freeze({
  projectRoot: Object.freeze({
    type: "string",
    description: "Optional absolute path to target project root directory for multi-project V2 routing.",
  }),
});

const SESSION_ID_PROP = Object.freeze({
  sessionId: Object.freeze({
    type: "string",
    description: "Optional active root session UUID.",
  }),
});

const WRITE_NOTE_PROPS = Object.freeze({
  ...PROJECT_ROOT_PROP,
  ...SESSION_ID_PROP,
  title: Object.freeze({ type: "string", description: "Short, descriptive title for the governed note." }),
  summary: Object.freeze({ type: "string", description: "Concise 1-2 sentence summary used for indexing and context packs." }),
  content: Object.freeze({ type: "string", description: "Full Markdown body content of the governed note." }),
  body: Object.freeze({ type: "string", description: "Alias for content (full Markdown body)." }),
  confidence: Object.freeze({
    type: "string",
    enum: ["high", "medium", "low", "guess"],
    description: "Epistemic confidence level (defaults to high).",
  }),
  idempotencyKey: Object.freeze({ type: "string", description: "Optional idempotency key or UUID." }),
  commandId: Object.freeze({ type: "string", description: "Optional command UUID." }),
  provenance: Object.freeze({
    type: "array",
    description: "Optional explicit provenance references.",
    items: Object.freeze({ type: "object" }),
  }),
});

const CHECKPOINT_DRAFT_PROPS = Object.freeze({
  completedItems: Object.freeze({
    type: "array",
    items: Object.freeze({ type: "string" }),
    description: "Completed items in this session step.",
  }),
  inProgressItems: Object.freeze({
    type: "array",
    items: Object.freeze({ type: "string" }),
    description: "Items currently in progress.",
  }),
  blockers: Object.freeze({
    type: "array",
    items: Object.freeze({ type: "string" }),
    description: "Active blockers or risks needing attention.",
  }),
  nextActions: Object.freeze({
    type: "array",
    items: Object.freeze({ type: "string" }),
    description: "Prioritized next actions for the next session or step.",
  }),
  decisions: Object.freeze({
    type: "array",
    items: Object.freeze({ type: "string" }),
    description: "Key architectural or implementation decisions made.",
  }),
  filesTouched: Object.freeze({
    type: "array",
    items: Object.freeze({ type: "string" }),
    description: "Relative paths of files created or modified.",
  }),
});

const PUBLIC_TOOL_SCHEMA_CATALOG: Readonly<
  Record<string, { readonly description: string; readonly properties: Readonly<Record<string, unknown>> }>
> = Object.freeze({
  memory_search: Object.freeze({
    description: "Hybrid BM25, Soft-OR, and cross-session semantic/lexical search across governed V2 project memory.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      query: Object.freeze({ type: "string", description: "Search query (keywords, natural language, or Thai/English phrases)." }),
      area: Object.freeze({ type: "string", description: "Optional alias for query/topic area." }),
      limit: Object.freeze({ type: "number", description: "Maximum number of ranked results to return (default 10)." }),
    }),
  }),
  memory_get: Object.freeze({
    description: "Verified child-process full-note retrieval by record ID.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      id: Object.freeze({ type: "string", description: "Record ID of the governed note to retrieve." }),
      recordId: Object.freeze({ type: "string", description: "Alias for id." }),
      noteId: Object.freeze({ type: "string", description: "Alias for id." }),
    }),
  }),
  memory_list: Object.freeze({
    description: "List governed canonical memory records across the project.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      limit: Object.freeze({ type: "number", description: "Maximum number of records to return (default 20)." }),
    }),
  }),
  memory_recent: Object.freeze({
    description: "List most recently updated governed memory records across the project.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      limit: Object.freeze({ type: "number", description: "Maximum number of recent records to return (default 20)." }),
    }),
  }),
  memory_writeSessionLog: Object.freeze({
    description: "Record a governed session-log note with automatic evidence retention and Projection Schema 3 publication.",
    properties: WRITE_NOTE_PROPS,
  }),
  memory_writeInsight: Object.freeze({
    description: "Record a governed insight note capturing reusable architectural or debugging lessons.",
    properties: WRITE_NOTE_PROPS,
  }),
  memory_writeMistake: Object.freeze({
    description: "Record a governed mistake note capturing root cause and prevention guardrails.",
    properties: WRITE_NOTE_PROPS,
  }),
  memory_writeADR: Object.freeze({
    description: "Record a governed Architecture Decision Record (ADR) note.",
    properties: WRITE_NOTE_PROPS,
  }),
  memory_verifyVault: Object.freeze({
    description: "Verify cryptographic event chain integrity and Projection Schema 3 health.",
    properties: Object.freeze({ ...PROJECT_ROOT_PROP, ...SESSION_ID_PROP }),
  }),
  memory_verifyNote: Object.freeze({
    description: "Verify cryptographic provenance, body hash, and child-process readability of a specific note.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      id: Object.freeze({ type: "string", description: "Record ID of the note to verify." }),
      recordId: Object.freeze({ type: "string", description: "Alias for id." }),
      noteId: Object.freeze({ type: "string", description: "Alias for id." }),
    }),
  }),
  memory_verifySourceTruth: Object.freeze({
    description: "Verify retained evidence coverage and source-truth bindings for all governed notes.",
    properties: Object.freeze({ ...PROJECT_ROOT_PROP, ...SESSION_ID_PROP }),
  }),
  memory_findDuplicates: Object.freeze({
    description: "Detect duplicate or near-duplicate governed notes by normalized key and summary.",
    properties: Object.freeze({ ...PROJECT_ROOT_PROP, ...SESSION_ID_PROP }),
  }),
  memory_checkStaleness: Object.freeze({
    description: "Identify expired or stale governed notes needing re-verification or supersession.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      staleAfterDays: Object.freeze({ type: "number", description: "Days threshold before a note is flagged stale (default 30)." }),
    }),
  }),
  memory_sessionStart: Object.freeze({
    description: "Start a governed V2 root session, retain initial session evidence, and atomically bundle awaken, contextPack, and selfCheck (unless includeContext is false).",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      agentName: Object.freeze({ type: "string", description: "Identifier of the AI agent starting the session." }),
      agentId: Object.freeze({ type: "string", description: "Alias for agentName." }),
      taskDescription: Object.freeze({ type: "string", description: "Brief summary of the user task or objective." }),
      taskSummary: Object.freeze({ type: "string", description: "Alias for taskDescription." }),
      contextArea: Object.freeze({ type: "string", description: "Optional focus area for initial contextPack." }),
      plannedFiles: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "string" }),
        description: "Optional list of file paths planned to be inspected or modified.",
      }),
      includeContext: Object.freeze({
        type: "boolean",
        description: "Whether to bundle awaken, contextPack, and selfCheck in the startup response (default true).",
      }),
    }),
  }),
  memory_contextPack: Object.freeze({
    description: "Build a ranked context pack of ADRs, mistakes, insights, checkpoints, file-matched notes, and follow-ups for a task area.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      area: Object.freeze({ type: "string", description: "Task area or domain topic to gather context for." }),
      contextArea: Object.freeze({ type: "string", description: "Alias for area." }),
      query: Object.freeze({ type: "string", description: "Alias for area." }),
      task: Object.freeze({ type: "string", description: "Alias for area." }),
      plannedFiles: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "string" }),
        description: "Optional list of file paths to match against historical ADRs, mistakes, and insights.",
      }),
    }),
  }),
  memory_awaken: Object.freeze({
    description: "Autonomous awakening engine: synthesizes contextPack, cross-session continuity, live Git workspace state, governance alerts, and a prioritized autonomous agenda.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      area: Object.freeze({ type: "string", description: "Optional focus area or task description for awakening." }),
      query: Object.freeze({ type: "string", description: "Alias for area." }),
      task: Object.freeze({ type: "string", description: "Alias for area." }),
    }),
  }),
  memory_selfCheck: Object.freeze({
    description: "Active pre-flight guardrail: checks planned taskSummary and plannedFiles/filesTouched against past mistakes, binding ADRs, and open conflicts.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      taskSummary: Object.freeze({ type: "string", description: "Summary of the work or risky change about to be performed." }),
      plannedFiles: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "string" }),
        description: "Optional list of file paths about to be modified.",
      }),
      filesTouched: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "string" }),
        description: "Alias for plannedFiles.",
      }),
    }),
  }),
  memory_sessionEnd: Object.freeze({
    description: "Request governed session completion with final structured checkpoint.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      summary: Object.freeze({ type: "string", description: "Final summary of work completed in this session." }),
      ...CHECKPOINT_DRAFT_PROPS,
    }),
  }),
  memory_lifecycleStatus: Object.freeze({
    description: "Inspect current root session authority, owner generation, and latest checkpoint.",
    properties: Object.freeze({ ...PROJECT_ROOT_PROP, ...SESSION_ID_PROP }),
  }),
  memory_followUpRadar: Object.freeze({
    description: "Surface open follow-ups, unfinished items, and candidate notes requiring attention.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      limit: Object.freeze({ type: "number", description: "Maximum number of follow-up items to return (default 10)." }),
    }),
  }),
  memory_checkpoint: Object.freeze({
    description: "Record a structured session lifecycle checkpoint including nextActions, blockers, inProgressItems, completedItems, decisions, and filesTouched.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      taskSummary: Object.freeze({ type: "string", description: "Summary of current progress at this checkpoint." }),
      summary: Object.freeze({ type: "string", description: "Alias for taskSummary." }),
      ...CHECKPOINT_DRAFT_PROPS,
    }),
  }),
  memory_recoverSession: Object.freeze({
    description: "Recover root session authority to a new owner generation.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      reasonCode: Object.freeze({
        type: "string",
        enum: ["explicit-user-approval", "credential-loss", "suspected-compromise", "irrecoverable-session"],
        description: "Reason code for authority recovery.",
      }),
    }),
  }),
  memory_sessionFork: Object.freeze({
    description: "Fork a governed child session for a subagent task.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      parentSessionId: Object.freeze({ type: "string", description: "Parent root session UUID." }),
      sessionId: Object.freeze({ type: "string", description: "Alias for parentSessionId." }),
      summary: Object.freeze({ type: "string", description: "Summary of the subagent assignment." }),
      scope: Object.freeze({ type: "string", description: "Scope identifier for the child session." }),
    }),
  }),
  memory_recordChildResult: Object.freeze({
    description: "Record structured findings and outcome report from a forked child session.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      parentSessionId: Object.freeze({ type: "string", description: "Parent root session UUID." }),
      childSessionId: Object.freeze({ type: "string", description: "Forked child session UUID." }),
      outcomeSummary: Object.freeze({ type: "string", description: "Summary of the child session outcome." }),
      summary: Object.freeze({ type: "string", description: "Alias for outcomeSummary." }),
      findings: Object.freeze({
        type: "array",
        items: Object.freeze({ type: "string" }),
        description: "List of key findings from the child session.",
      }),
    }),
  }),
  memory_completeChildSession: Object.freeze({
    description: "Complete a forked child session after its report has been recorded.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      parentSessionId: Object.freeze({ type: "string", description: "Parent root session UUID." }),
      childSessionId: Object.freeze({ type: "string", description: "Forked child session UUID." }),
      reportId: Object.freeze({ type: "string", description: "Recorded child report UUID." }),
    }),
  }),
  memory_amendSessionEnd: Object.freeze({
    description: "Amend an active session-end workflow with an updated final checkpoint.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      workflowId: Object.freeze({ type: "string", description: "Active session-end workflow UUID." }),
      summary: Object.freeze({ type: "string", description: "Amended final checkpoint summary." }),
      ...CHECKPOINT_DRAFT_PROPS,
    }),
  }),
  memory_cancelSessionEnd: Object.freeze({
    description: "Cancel an active session-end workflow and resume the session.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      workflowId: Object.freeze({ type: "string", description: "Active session-end workflow UUID to cancel." }),
    }),
  }),
  memory_recordEvidenceBatch: Object.freeze({
    description: "Retain a redacted, HMAC-fingerprinted evidence batch for provenance backing.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      noteId: Object.freeze({ type: "string", description: "Optional note ID associated with this evidence batch." }),
      recordId: Object.freeze({ type: "string", description: "Alias for noteId." }),
      content: Object.freeze({ type: "string", description: "Raw evidence text to redact and retain." }),
      evidence: Object.freeze({
        type: "array",
        description: "Optional structured evidence items to serialize and retain.",
        items: Object.freeze({ type: "object" }),
      }),
      conversationId: Object.freeze({ type: "string", description: "Optional conversation UUID." }),
    }),
  }),
  memory_promote: Object.freeze({
    description: "Promote a candidate or provisional governed note to active verified status.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      recordId: Object.freeze({ type: "string", description: "Target note record ID to promote." }),
      noteId: Object.freeze({ type: "string", description: "Alias for recordId." }),
      id: Object.freeze({ type: "string", description: "Alias for recordId." }),
      targetStatus: Object.freeze({ type: "string", description: "Target status (active, verified, provisional, conflicted)." }),
      targetState: Object.freeze({ type: "string", description: "Alias for targetStatus (e.g. approved, active, verified)." }),
      verificationMethod: Object.freeze({
        type: "string",
        enum: ["manual-review", "automated-check", "test-suite", "source-citation", "policy", "test", "user-confirmed", "test-verified", "source-anchored"],
        description: "Verification policy method.",
      }),
      verificationAnchor: Object.freeze({ type: "string", description: "Verification anchor or reference." }),
      policyRef: Object.freeze({ type: "string", description: "Alias for verificationAnchor." }),
      reason: Object.freeze({ type: "string", description: "Reason for promotion." }),
    }),
  }),
  memory_supersede: Object.freeze({
    description: "Supersede an outdated or conflicted governed note with a newer active note.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      recordId: Object.freeze({ type: "string", description: "Outdated note record ID being superseded." }),
      id: Object.freeze({ type: "string", description: "Alias for recordId." }),
      supersedingRecordId: Object.freeze({ type: "string", description: "New active note record ID that replaces it." }),
      reason: Object.freeze({ type: "string", description: "Reason for supersession." }),
    }),
  }),
  memory_retract: Object.freeze({
    description: "Retract an invalid or erroneous governed note so it is excluded from retrieval.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      recordId: Object.freeze({ type: "string", description: "Target note record ID to retract." }),
      id: Object.freeze({ type: "string", description: "Alias for recordId." }),
      reason: Object.freeze({ type: "string", description: "Reason for retraction." }),
    }),
  }),
  memory_expire: Object.freeze({
    description: "Mark a time-bound governed note as expired.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      recordId: Object.freeze({ type: "string", description: "Target note record ID to expire." }),
      id: Object.freeze({ type: "string", description: "Alias for recordId." }),
      validTo: Object.freeze({ type: "string", description: "ISO-8601 expiration timestamp." }),
      reason: Object.freeze({ type: "string", description: "Reason for expiration." }),
    }),
  }),
  memory_forgetEvidence: Object.freeze({
    description: "Cryptographically erase a key-wrap generation for right-to-be-forgotten compliance.",
    properties: Object.freeze({
      ...PROJECT_ROOT_PROP,
      ...SESSION_ID_PROP,
      purpose: Object.freeze({ type: "string", description: "Key purpose to rotate and erase (e.g. data-key-wrap)." }),
      reason: Object.freeze({ type: "string", description: "Audit reason for cryptographic erasure." }),
    }),
  }),
});

function buildPublicToolDefinitions(): readonly McpToolDefinition[] {
  const allPublicTools = [
    ...V2_SUPPORTED_V1_TOOLS,
    ...V2_NATIVE_TOOLS,
  ];
  return Object.freeze(
    allPublicTools.map((name) => {
      if (name === "memory_v2Status") return STATUS_TOOL_DEFINITION;
      const readOnly = READ_ONLY_PUBLIC_TOOLS.has(name);
      const schemaMeta = PUBLIC_TOOL_SCHEMA_CATALOG[name];
      return Object.freeze({
        name,
        description: schemaMeta?.description ?? `Project Memory V2 governed tool: ${name}`,
        inputSchema: Object.freeze({
          type: "object",
          properties: schemaMeta?.properties ?? Object.freeze({ ...PROJECT_ROOT_PROP }),
          additionalProperties: true,
        }),
        annotations: Object.freeze({
          readOnlyHint: readOnly,
          destructiveHint: name === "memory_forgetEvidence",
          openWorldHint: false,
        }),
      });
    }),
  );
}

export const V2_PUBLIC_TOOL_DEFINITIONS: readonly McpToolDefinition[] = buildPublicToolDefinitions();

const DEFAULT_REDACTION_POLICY: TrustedRedactionPolicyV1 = Object.freeze({
  policyId: "v2-public-default-redaction",
  policyVersion: "1",
  rules: Object.freeze([
    Object.freeze({
      kind: "token" as const,
      ruleId: "rule-fixture-secret",
      prefix: "fixture_secret",
    }),
  ]),
});

const READ_SOURCE_STATE_HASH = "a".repeat(64);

function normalizeArgs(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new FreshStartError("FRESH_START_INPUT_INVALID");
  }
  return value as Record<string, unknown>;
}

function serializeMutationReceipt(
  receipt: GovernedLifecycleMutationReceiptV1,
): Record<string, unknown> {
  return {
    commandId: receipt.commandId,
    idempotencyKey: receipt.idempotencyKey,
    eventId: receipt.eventId,
    globalPosition: receipt.globalPosition.toString(),
    streamVersion: receipt.streamVersion.toString(),
    recordId: receipt.recordId,
    targetStatus: receipt.targetStatus,
    verificationMethod: receipt.verificationMethod,
    verificationAnchor: receipt.verificationAnchor,
    validTo: receipt.validTo,
    conflictKey: receipt.conflictKey,
    conflictGroupId: receipt.conflictGroupId,
    resolutionState: receipt.resolutionState,
    resolutionEventId: receipt.resolutionEventId,
    supersededByEventId: receipt.supersededByEventId,
    supersedingRecordId: receipt.supersedingRecordId,
    retractedByEventId: receipt.retractedByEventId,
    replayed: receipt.replayed,
  };
}

function resolveInternalDeploymentDirectory(): ProjectionDirectoryIdentity {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), "internal"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "internal"),
    join(process.cwd(), "dist", "internal"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const canonicalPath = realpathSync.native(candidate);
      const stat = lstatSync(canonicalPath, { bigint: true });
      return Object.freeze({
        canonicalPath,
        device: String(stat.dev),
        inode: String(stat.ino),
      });
    }
  }
  throw new FreshStartError("FRESH_START_STORAGE_FAILURE");
}

function resolveDirectoryIdentity(dirPath: string): ProjectionDirectoryIdentity {
  mkdirSync(dirPath, { recursive: true });
  const canonicalPath = realpathSync.native(dirPath);
  const stat = lstatSync(canonicalPath, { bigint: true });
  return Object.freeze({
    canonicalPath,
    device: String(stat.dev),
    inode: String(stat.ino),
  });
}

function emptyCheckpointDraftV2(taskSummary: string): CheckpointDraftV2 {
  return Object.freeze({
    checkpointVersion: 2 as const,
    taskSummary,
    completedItems: Object.freeze([]),
    inProgressItems: Object.freeze([]),
    blockers: Object.freeze([]),
    nextActions: Object.freeze([]),
    decisions: Object.freeze([]),
    assumptions: Object.freeze([]),
    unresolvedConflicts: Object.freeze([]),
    filesTouched: Object.freeze([]),
    artifactReferences: Object.freeze([]),
    sourceReferences: Object.freeze([]),
    commandResults: Object.freeze([]),
    testResults: Object.freeze([]),
    materialClaims: Object.freeze([]),
  });
}

function normalizeTextItemList(raw: unknown): readonly { readonly summary: string; readonly confidence: "high" }[] {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const items: Array<{ readonly summary: string; readonly confidence: "high" }> = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      items.push(Object.freeze({ summary: entry.trim().slice(0, 3_900), confidence: "high" as const }));
    } else if (
      typeof entry === "object"
      && entry !== null
      && typeof (entry as { summary?: unknown }).summary === "string"
      && (entry as { summary: string }).summary.trim().length > 0
    ) {
      items.push(
        Object.freeze({
          summary: (entry as { summary: string }).summary.trim().slice(0, 3_900),
          confidence: "high" as const,
        }),
      );
    }
    if (items.length >= 100) break;
  }
  return Object.freeze(items);
}

function sanitizeRelativeCheckpointPath(rawPath: string): string | null {
  const cleaned = rawPath
    .trim()
    .replace(/^[A-Za-z]:[\\/]?/u, "")
    .replace(/^[\\/]+/u, "")
    .replace(/\\/gu, "/");
  const segments = cleaned
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "." && s !== "..");
  if (segments.length === 0) return null;
  const joined = segments.join("/").slice(0, 500);
  if (joined.includes(":") || joined.includes("\0")) return null;
  return joined;
}

function normalizeFilesTouchedList(
  raw: unknown,
  branchRef: string | null,
): readonly {
  readonly path: string;
  readonly action: "modified";
  readonly contentHash: null;
  readonly branchRef: string | null;
  readonly confidence: "high";
}[] {
  if (!Array.isArray(raw)) return Object.freeze([]);
  const files: Array<{
    readonly path: string;
    readonly action: "modified";
    readonly contentHash: null;
    readonly branchRef: string | null;
    readonly confidence: "high";
  }> = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const rawStr =
      typeof entry === "string"
        ? entry
        : typeof entry === "object" && entry !== null && typeof (entry as { path?: unknown }).path === "string"
          ? (entry as { path: string }).path
          : "";
    const safePath = sanitizeRelativeCheckpointPath(rawStr);
    if (!safePath || seen.has(safePath)) continue;
    seen.add(safePath);
    files.push(
      Object.freeze({
        path: safePath,
        action: "modified" as const,
        contentHash: null,
        branchRef,
        confidence: "high" as const,
      }),
    );
    if (files.length >= 100) break;
  }
  return Object.freeze(files);
}

function checkpointDraftFromArgs(
  taskSummary: string,
  args: Record<string, unknown>,
  branchRef: string | null,
): {
  readonly draft: CheckpointDraftV2;
  readonly summaryView: {
    readonly taskSummary: string;
    readonly completedItems: readonly string[];
    readonly inProgressItems: readonly string[];
    readonly blockers: readonly string[];
    readonly nextActions: readonly string[];
    readonly decisions: readonly string[];
    readonly filesTouched: readonly string[];
  };
} {
  const completedItems = normalizeTextItemList(args.completedItems);
  const inProgressItems = normalizeTextItemList(args.inProgressItems);
  const blockers = normalizeTextItemList(args.blockers);
  const nextActions = normalizeTextItemList(args.nextActions);
  const decisions = normalizeTextItemList(args.decisions);
  const assumptions = normalizeTextItemList(args.assumptions);
  const unresolvedConflicts = normalizeTextItemList(args.unresolvedConflicts);
  const filesTouched = normalizeFilesTouchedList(args.filesTouched, branchRef);
  const draft: CheckpointDraftV2 = Object.freeze({
    checkpointVersion: 2 as const,
    taskSummary: taskSummary.trim().slice(0, 1_900) || "Session lifecycle checkpoint",
    completedItems,
    inProgressItems,
    blockers,
    nextActions,
    decisions,
    assumptions,
    unresolvedConflicts,
    filesTouched,
    artifactReferences: Object.freeze([]),
    sourceReferences: Object.freeze([]),
    commandResults: Object.freeze([]),
    testResults: Object.freeze([]),
    materialClaims: Object.freeze([]),
  });
  return {
    draft,
    summaryView: Object.freeze({
      taskSummary: draft.taskSummary,
      completedItems: Object.freeze(completedItems.map((i) => i.summary)),
      inProgressItems: Object.freeze(inProgressItems.map((i) => i.summary)),
      blockers: Object.freeze(blockers.map((i) => i.summary)),
      nextActions: Object.freeze(nextActions.map((i) => i.summary)),
      decisions: Object.freeze(decisions.map((i) => i.summary)),
      filesTouched: Object.freeze(filesTouched.map((f) => f.path)),
    }),
  };
}

export interface V2PublicToolRouterOptions {
  readonly connection: SqliteConnection;
  readonly identity: FreshStartIdentity;
  readonly paths: FreshStartPaths;
  readonly descriptor: ProjectDescriptorV1;
  readonly workspace: WorkspaceSnapshot;
  readonly route: ProjectStoreRoute;
}

export class V2PublicToolRouter {
  readonly #connection: SqliteConnection;
  readonly #identity: FreshStartIdentity;
  readonly #paths: FreshStartPaths;
  readonly #descriptor: ProjectDescriptorV1;
  readonly #workspace: WorkspaceSnapshot;
  readonly #route: ProjectStoreRoute;
  readonly #custody: OperationalKeyCustodyProvider;
  readonly #rootContext: ProjectContext;
  readonly #childContext: ProjectContext;
  readonly #projectionBinding: ProjectBinding;
  readonly #authorityRepo: SessionAuthorityRepository;
  readonly #capabilities: CapabilityService;
  readonly #lifecycleRuntime: ReturnType<LifecycleWorkerRuntimeFactory["create"]>;
  readonly #retainedEvidenceRuntime: ReturnType<RetainedEvidenceRuntimeFactory["create"]>;
  readonly #governedNoteRuntime: ReturnType<GovernedNoteRuntimeFactory["create"]>;
  readonly #governanceService: GovernedLifecycleService;
  #nextUuid: string | undefined;
  #admissionContextBound = false;

  constructor(options: V2PublicToolRouterOptions) {
    this.#connection = options.connection;
    this.#identity = options.identity;
    this.#paths = options.paths;
    this.#descriptor = options.descriptor;
    this.#workspace = options.workspace;
    this.#route = options.route;

    this.#custody = new OperationalKeyCustodyProvider({
      storeRoot: options.route.storeRoot,
      projectId: options.identity.projectId,
      storeId: options.identity.storeId,
      paths: options.paths,
    });

    const descriptorPath = join(options.paths.v2VaultRoot, ".memory-mcp", "project-identity.json");
    const nowIso = new Date().toISOString();
    const baseBinding = {
      projectBindingId: randomUUID(),
      generation: 1,
      source: "stdio-explicit-root" as const,
      projectId: options.identity.projectId as ProjectId,
      vaultId: options.identity.vaultId as VaultId,
      storeId: options.identity.storeId as StoreId,
      workspaceId: options.workspace.workspaceId,
      projectRoot: options.paths.projectRoot,
      vaultRoot: options.paths.v2VaultRoot,
      descriptorPath,
      storeRoute: options.route,
      workspace: options.workspace,
      clientNamespace: "mcp-v2",
      clientInstanceId: "v2-mcp-primary",
      actorRole: "primary" as const,
      establishedAt: nowIso,
      contextFingerprint: "",
    };
    this.#rootContext = Object.freeze({
      workspace: options.workspace,
      checkedAt: nowIso,
      binding: Object.freeze({
        ...baseBinding,
        contextFingerprint: computeProjectContextFingerprint(baseBinding),
      }),
    });

    const childBindingBase = {
      ...baseBinding,
      projectBindingId: randomUUID(),
      actorRole: "untrusted" as const,
      clientInstanceId: "v2-mcp-child",
    };
    this.#childContext = Object.freeze({
      workspace: options.workspace,
      checkedAt: nowIso,
      binding: Object.freeze({
        ...childBindingBase,
        contextFingerprint: computeProjectContextFingerprint(childBindingBase),
      }),
    });

    const branchRef = options.workspace.kind === "git" ? options.workspace.branchRef : null;
    const branchScopeRow = options.connection
      .prepare(
        `SELECT branch_scope_id FROM branch_scopes
         WHERE project_id = $projectId AND retired_at IS NULL
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get({
        $projectId: options.identity.projectId,
      }) as { branch_scope_id?: string } | undefined;

    const branchScopeId = (branchScopeRow?.branch_scope_id ?? null) as BranchScopeId | null;

    this.#projectionBinding = Object.freeze({
      projectId: options.identity.projectId as ProjectId,
      vaultId: options.identity.vaultId as VaultId,
      storeId: options.identity.storeId as StoreId,
      workspaceId: options.workspace.workspaceId,
      branchScopeId,
      branchRef,
      sessionId: null,
    });

    const clock = {
      now: () => new Date().toISOString(),
      nowMs: () => BigInt(Date.now()),
    };
    const ids = {
      uuid: () => {
        const override = this.#nextUuid;
        this.#nextUuid = undefined;
        return override ?? randomUUID();
      },
      bytes: (length: number) => randomBytes(length),
    };
    const sourceState = () => ({
      sourceStateScopeVersion: 1 as const,
      workspaceId: options.workspace.workspaceId,
      branchRef,
      headCommit: options.workspace.kind === "git" ? options.workspace.headCommit : null,
      dirtyWorktreeFingerprint: READ_SOURCE_STATE_HASH,
    });

    const maintenanceFence = new MaintenanceFence();
    this.#authorityRepo = new SessionAuthorityRepository();
    this.#capabilities = new CapabilityService({
      keyProvider: this.#custody.capability,
      clock,
      nonceSource: ids,
    });

    const lifecycleFactory = new LifecycleWorkerRuntimeFactory({
      clock,
      identitySource: ids,
      integrity: { assertQuickHealthy: () => undefined },
      resumeSourceState: { captureCurrent: sourceState },
      checkpointSourceStateProvider: {
        capture: async () => sourceState(),
        captureForCheckpoint: sourceState,
        captureForFinalization: sourceState,
      },
      checkpointSourceStateScopeResolver: {
        resolve: () => ({
          scopeVersion: 1,
          descriptorPath,
          storeRoot: options.route.storeRoot,
          privateStateRoot: options.route.storeRoot,
          exactMaterializationTargets: [],
          exactCommittedTempPaths: [],
        }),
      },
      childBindingFingerprint: (target) =>
        target.actorRole === "untrusted"
        && target.clientInstanceId === this.#childContext.binding.clientInstanceId
          ? this.#childContext.binding.contextFingerprint
          : null,
      repositories: {
        authority: () => new SessionAuthorityRepository(),
        leases: () => new SessionLeaseRepository(),
        approvals: () => new LifecycleApprovalRepository(),
        transfers: () => new ChildTransferRepository(),
        coverage: (provider) => new EvidenceCoverageRepository(provider),
        projection: (conn) => new SqliteLifecycleProjectionRepository(conn),
      },
      transactionFacades: {
        command: ({ connection, authority, leases, approvals, transfers, coverage }) => ({
          authority: {
            get: (projectId: string, sessionId: string) =>
              authority.get(connection, projectId, sessionId),
            insertRoot: (input: unknown) => authority.insertRoot(connection, input as never),
            insertChild: (input: unknown) => authority.insertChild(connection, input as never),
            compareAndSwap: (input: unknown) =>
              authority.compareAndSwap(connection, input as never),
            listSafeResumeCandidates: (input: unknown) =>
              authority.listSafeResumeCandidates(connection, input as never),
            listNonterminalRootContinuityOwners: (input: unknown) =>
              authority.listNonterminalRootContinuityOwners(connection, input as never),
            listNonterminalChildren: (projectId: string, rootSessionId: string) =>
              authority.listNonterminalChildren(connection, projectId, rootSessionId),
            listNonterminalChildEndingScopeProjectionsBounded: (
              projectId: string,
              rootSessionId: string,
              limit: number,
            ) =>
              authority.listNonterminalChildEndingScopeProjectionsBounded(
                connection,
                projectId,
                rootSessionId,
                limit,
              ),
            rootContinuityKey: (value: unknown) =>
              authority.rootContinuityKey(connection, value as never),
            latestCheckpoint: (value: unknown) =>
              authority.latestCheckpoint(connection, value as never),
            nextGlobalPosition: () => authority.nextGlobalPosition(connection),
            loadEvents: (value: unknown) => authority.loadEvents(connection, value as never),
            requireFoldMatch: (value: unknown) =>
              authority.requireFoldMatch(connection, value as never),
            markCheckpointRequired: (input: unknown) =>
              authority.markCheckpointRequired(connection, input as never),
            updateCheckpointIndex: (input: unknown) =>
              authority.updateCheckpointIndex(connection, input as never),
            clearCheckpointRequired: (input: unknown) =>
              authority.clearCheckpointRequired(connection, input as never),
          },
          leases: {
            current: (projectId: string, sessionId: string) =>
              leases.current(connection, projectId, sessionId),
            isExpired: (value: unknown, now: bigint) => leases.isExpired(value as never, now),
            insertGeneration: (input: unknown) =>
              leases.insertGeneration(connection, input as never),
            renewCurrent: (input: unknown) => leases.renewCurrent(connection, input as never),
            releaseCurrent: (input: unknown) => leases.releaseCurrent(connection, input as never),
          },
          approvals: {
            consume: (input: unknown) => approvals.consume(connection, input as never),
          },
          transfers: {
            get: (projectId: string, ticketId: string) =>
              transfers.get(connection, projectId, ticketId),
            findCreatedEventPosition: (projectId: string, ticketId: string) =>
              transfers.findCreatedEventPosition(connection, projectId, ticketId),
            listUnclaimedEndingScopeProjectionsBySourceRoot: (
              projectId: string,
              rootSessionId: string,
              limit: number,
            ) =>
              transfers.listUnclaimedEndingScopeProjectionsBySourceRoot(
                connection,
                projectId,
                rootSessionId,
                limit,
              ),
            insert: (input: unknown) => transfers.insert(connection, input as never),
            claim: (input: unknown) => transfers.claim(connection, input as never),
          },
          coverage: connectionBoundEvidenceCoverage(connection, coverage),
          workflows: {} as never,
          validation: {} as never,
          outbox: {} as never,
        }),
        operational: () => ({ workflows: {}, outbox: {} } as never),
      },
    });

    this.#lifecycleRuntime = lifecycleFactory.create({
      connection: options.connection,
      maintenanceFence,
      keyProvider: this.#custody.capability,
    });

    this.#retainedEvidenceRuntime = new RetainedEvidenceRuntimeFactory({
      provider: this.#custody.evidence,
      policy: () => DEFAULT_REDACTION_POLICY,
      clock,
      nonceSource: ids,
    }).create({
      connection: options.connection,
      maintenanceFence,
      keyProvider: this.#custody.capability,
    });

    this.#governedNoteRuntime = new GovernedNoteRuntimeFactory({
      provider: this.#custody.evidence,
      policy: () => DEFAULT_REDACTION_POLICY,
      clock,
      nonceSource: ids,
    }).create({
      connection: options.connection,
      maintenanceFence,
      keyProvider: this.#custody.capability,
    });

    this.#governanceService = new GovernedLifecycleService({
      connection: options.connection,
      context: this.#rootContext,
      custody: this.#custody,
      now: () => clock.now(),
    });
  }

  close(): void {
    try {
      this.#lifecycleRuntime.dispose();
    } finally {
      this.#custody.close();
    }
  }

  async invoke(
    name: string,
    argumentsValue: unknown,
    state: FreshStartState,
    release: FreshStartRelease,
  ): Promise<unknown> {
    if (Object.prototype.hasOwnProperty.call(V2_SUPERSEDED_V1_TOOLS, name)) {
      const meta = V2_SUPERSEDED_V1_TOOLS[name as keyof typeof V2_SUPERSEDED_V1_TOOLS];
      throw Object.assign(new FreshStartError("FRESH_START_OPERATOR_ONLY_TOOL"), {
        toolName: name,
        supersededBy: meta.supersededBy,
      });
    }
    if ((V2_UNAVAILABLE_V1_TOOLS as readonly string[]).includes(name)) {
      throw new FreshStartError("FRESH_START_CAPABILITY_UNAVAILABLE");
    }
    if (
      !(V2_SUPPORTED_V1_TOOLS as readonly string[]).includes(name)
      && !(V2_NATIVE_TOOLS as readonly string[]).includes(name)
    ) {
      throw new FreshStartError("FRESH_START_CAPABILITY_UNAVAILABLE");
    }
    if (state.mode === "read-only-recovery" && !READ_ONLY_PUBLIC_TOOLS.has(name)) {
      throw new FreshStartError("FRESH_START_ADMISSION_DENIED");
    }

    if (state.mode === "active" && !this.#admissionContextBound) {
      bindFreshStartAdmissionContext(this.#connection, {
        identity: this.#identity,
        releaseId: release.releaseId,
        measuredBuildHash: release.buildIdentityHash,
        generation: state.generation,
      });
      this.#admissionContextBound = true;
    }

    const args = normalizeArgs(argumentsValue);

    switch (name) {
      case "memory_sessionStart":
        return this.#handleSessionStart(args, state, release);
      case "memory_lifecycleStatus":
        return this.#handleLifecycleStatus(args, state);
      case "memory_selfCheck":
        return this.#handleSelfCheck(args, state);
      case "memory_writeInsight":
        return this.#handleWriteGovernedNote("insight", args);
      case "memory_writeMistake":
        return this.#handleWriteGovernedNote("mistake", args);
      case "memory_writeADR":
        return this.#handleWriteGovernedNote("adr", args);
      case "memory_writeSessionLog":
        return this.#handleWriteGovernedNote("session-log", args);
      case "memory_get":
        return this.#handleGetFullNote(args, state, release);
      case "memory_search":
        return this.#handleSearch(args, state, release);
      case "memory_list":
        return this.#handleList(args, state, release);
      case "memory_recent":
        return this.#handleRecent(args, state, release);
      case "memory_contextPack":
        return this.#handleContextPack(args, state, release);
      case "memory_followUpRadar":
        return this.#handleFollowUpRadar(args, state, release);
      case "memory_awaken":
        return this.#handleAwaken(args, state, release);
      case "memory_verifyVault":
        return this.#handleVerifyVault(release);
      case "memory_verifyNote":
        return this.#handleVerifyNote(args, state, release);
      case "memory_verifySourceTruth":
        return this.#handleVerifySourceTruth(release);
      case "memory_findDuplicates":
        return this.#handleFindDuplicates();
      case "memory_checkStaleness":
        return this.#handleCheckStaleness();
      case "memory_promote":
        return this.#handlePromote(args);
      case "memory_supersede":
        return this.#handleSupersede(args);
      case "memory_retract":
        return this.#handleRetract(args);
      case "memory_expire":
        return this.#handleExpire(args);
      case "memory_recordEvidenceBatch":
        return this.#handleRecordEvidenceBatch(args);
      case "memory_forgetEvidence":
        return this.#handleForgetEvidence(args);
      case "memory_checkpoint":
        return this.#handleCheckpoint(args);
      case "memory_sessionFork":
        return this.#handleSessionFork(args);
      case "memory_recordChildResult":
        return this.#handleRecordChildResult(args);
      case "memory_completeChildSession":
        return this.#handleCompleteChildSession(args);
      case "memory_recoverSession":
        return this.#handleRecoverSession(args);
      case "memory_sessionEnd":
        return this.#handleSessionEnd(args);
      case "memory_amendSessionEnd":
        return this.#handleAmendSessionEnd(args);
      case "memory_cancelSessionEnd":
        return this.#handleCancelSessionEnd(args);
      default:
        throw new FreshStartError("FRESH_START_CAPABILITY_UNAVAILABLE");
    }
  }

  #storedHandle(row: SessionAuthorityRecord): StoredCapabilityMaterialV1 {
    const root = row.sessionKind === "root";
    const generation = root ? row.ownerGeneration : row.childCapabilityGeneration;
    const prefix = root ? "rootHandle" : "childHandle";
    const field = (suffix: string) =>
      (row as unknown as Record<string, unknown>)[`${prefix}${suffix}`];
    if (!generation) {
      throw new FreshStartError("FRESH_START_RECOVERY_REQUIRED");
    }
    return Object.freeze({
      claims: Object.freeze({
        capabilityVersion: 1,
        keyId: String(field("KeyId")),
        projectId: row.projectId,
        vaultId: this.#rootContext.binding.vaultId,
        storeId: this.#rootContext.binding.storeId,
        workspaceId: row.workspaceId,
        clientNamespace: row.clientNamespace,
        sessionId: row.sessionId,
        kind: root ? ("root-session-handle" as const) : ("child-session-handle" as const),
        capabilityGeneration: generation.toString(),
        issuedAt: String(field("IssuedAt")),
        policyCode: String(field("PolicyCode")),
        expiryKind: String(field("ExpiryKind")),
        expiresAt: field("ExpiresAt") as string | null,
        issueNonce: String(field("IssueNonce")),
        actorRole: field("ActorRole") as "primary" | "untrusted",
        clientInstanceId: String(field("ClientInstanceId")),
      }),
      verifier: String(field("Verifier")),
    }) as StoredCapabilityMaterialV1;
  }

  #mintProof(
    sessionId: string,
    context: ProjectContext,
    buildTarget: (scope: {
      projectId: ProjectContext["binding"]["projectId"];
      vaultId: ProjectContext["binding"]["vaultId"];
      storeId: ProjectContext["binding"]["storeId"];
      workspaceId: ProjectContext["binding"]["workspaceId"];
      clientNamespace: string;
      authoritySessionId: SessionId;
      targetSessionId: SessionId;
      presentingActorRole: "primary" | "untrusted";
      targetActorRole: "primary" | "untrusted",
      presentingClientInstanceId: string;
      targetClientInstanceId: string;
      capabilityKind: "root-session-handle" | "child-session-handle";
      capabilityGeneration: string;
    }) => Parameters<typeof createCapabilityProof>[1],
  ) {
    const row = this.#authorityRepo.get(
      this.#connection,
      context.binding.projectId,
      sessionId,
    );
    if (!row) {
      throw new FreshStartError("FRESH_START_INPUT_INVALID");
    }
    const stored = this.#storedHandle(row);
    const generation = stored.claims.capabilityGeneration;
    const audience = {
      actorRole: context.binding.actorRole as "primary" | "untrusted",
      clientInstanceId: context.binding.clientInstanceId,
    };
    const resolution = this.#capabilities.authorityMaterial({
      authorityCommitment: row.authorityCommitment,
      expectedCapabilityGeneration: generation,
      currentCapabilityGeneration: generation,
      target: audience,
      materials: [stored],
    });
    if (!resolution.descriptor) {
      throw new FreshStartError("FRESH_START_RECOVERY_REQUIRED");
    }
    const reconstructed = this.#capabilities.reconstructForTarget(
      resolution.descriptor,
      audience,
    );
    try {
      const b = context.binding;
      const scope = {
        projectId: b.projectId,
        vaultId: b.vaultId,
        storeId: b.storeId,
        workspaceId: b.workspaceId,
        clientNamespace: b.clientNamespace,
        authoritySessionId: sessionId as SessionId,
        targetSessionId: sessionId as SessionId,
        presentingActorRole: b.actorRole as "primary" | "untrusted",
        targetActorRole: b.actorRole as "primary" | "untrusted",
        presentingClientInstanceId: b.clientInstanceId,
        targetClientInstanceId: b.clientInstanceId,
        capabilityKind:
          b.actorRole === "primary"
            ? ("root-session-handle" as const)
            : ("child-session-handle" as const),
        capabilityGeneration: generation,
      };
      return createCapabilityProof(reconstructed.handle, buildTarget(scope));
    } finally {
      reconstructed.handle.destroy();
      if (reconstructed.kind === "root") {
        reconstructed.resumeToken?.destroy();
      }
    }
  }

  #resolveActiveRootSessionId(explicitSessionId?: unknown): string | null {
    if (typeof explicitSessionId === "string" && explicitSessionId.trim().length > 0) {
      return explicitSessionId.trim();
    }
    const row = this.#connection
      .prepare(
        `SELECT session_id FROM session_authority
         WHERE project_id = $projectId AND session_kind = 'root' AND terminal_at IS NULL AND semantic_state = 'active'
         ORDER BY authority_event_position DESC LIMIT 1`,
      )
      .get({ $projectId: this.#identity.projectId }) as { session_id?: string } | undefined;
    return row?.session_id ?? null;
  }

  #resolveReadSessionId(explicitSessionId?: unknown): string | null {
    const candidateSessionId =
      typeof explicitSessionId === "string" && explicitSessionId.trim().length > 0
        ? explicitSessionId.trim()
        : this.#resolveActiveRootSessionId();
    const latestNoteSession = this.#connection
      .prepare(
        `SELECT session_id FROM events
         WHERE project_id = $projectId
           AND event_type IN ('GovernedNoteCreated', 'MemorySourceRecorded')
           AND session_id IS NOT NULL
         ORDER BY global_position DESC LIMIT 1`,
      )
      .get({ $projectId: this.#identity.projectId }) as { session_id?: string } | undefined;
    if (candidateSessionId !== null) {
      const candidateHasNote = this.#connection
        .prepare(
          `SELECT 1 FROM events
           WHERE project_id = $projectId
             AND session_id = $sessionId
             AND event_type IN ('GovernedNoteCreated', 'MemorySourceRecorded')
           LIMIT 1`,
        )
        .get({
          $projectId: this.#identity.projectId,
          $sessionId: candidateSessionId,
        });
      if (candidateHasNote || !latestNoteSession?.session_id) {
        return candidateSessionId;
      }
      return latestNoteSession.session_id;
    }
    return latestNoteSession?.session_id ?? null;
  }

  async #ensureActiveRootSession(explicitSessionId?: unknown): Promise<string> {
    const existing = this.#resolveActiveRootSessionId(explicitSessionId);
    if (existing !== null) return existing;
    const started = await this.#startNewRootSession("mcp-auto-session");
    return started.sessionId;
  }

  async #startNewRootSession(continuityPrefix = "mcp-root"): Promise<{
    readonly sessionId: string;
    readonly conversationId: string;
    readonly evidenceIds: readonly string[];
    readonly eventIds: readonly string[];
  }> {
    const b = this.#rootContext.binding;
    const branchRef = this.#projectionBinding.branchRef;
    const sessionId = randomUUID();
    const command = decodeLifecycleSemanticCommandDraft({
      commandType: "root-start",
      commandId: sessionId,
      idempotencyKey: randomUUID(),
      agentId: "v2-mcp-agent",
      expectedProjectId: b.projectId,
      expectedVaultId: b.vaultId,
      expectedWorkspaceId: b.workspaceId,
      expectedBranchRef: branchRef,
      continuityKey: `${continuityPrefix}/${sessionId}`,
      resumePolicy: "new",
    });
    const witness = buildLifecycleIntentWitness(command, {
      projectId: b.projectId,
      vaultId: b.vaultId,
      storeId: b.storeId,
      workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace,
      presentingActorRole: "primary",
      presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: b.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
      authorizationKind: "initial-authority",
      authorizationSessionId: null,
      targetSessionId: command.commandId,
      capabilityKind: null,
      capabilityGeneration: null,
    });
    this.#nextUuid = sessionId;
    try {
      await this.#lifecycleRuntime.execute(
        decodeLifecycleWorkerOperationWire({
          kind: "semantic",
          operation: "root-start",
          prepared: {
            command,
            candidateIntentHash: witness.intentHash,
            authorization: {
              kind: "initial-authority",
              authoritySessionId: null,
              targetSessionId: null,
              proof: null,
              approval: null,
              childBindingGrant: null,
            },
          },
        }),
        this.#rootContext,
      );
    } finally {
      this.#nextUuid = undefined;
    }

    const retained = this.#retainEvidenceForSession(
      sessionId,
      "Session started on V2 governed MCP surface",
    );
    return {
      sessionId,
      conversationId: retained.conversationId,
      evidenceIds: retained.evidenceIds,
      eventIds: retained.eventIds,
    };
  }

  #retainEvidenceForSession(
    sessionId: string,
    content: string,
    conversationId: string = randomUUID(),
  ): {
    readonly conversationId: string;
    readonly evidenceIds: readonly string[];
    readonly eventIds: readonly string[];
  } {
    const decoded = decodeRetainEvidenceBatch({
      version: 1,
      commandType: "retain-evidence-batch",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      targetSessionId: sessionId,
      conversationId,
      frames: [
        {
          frameId: randomUUID(),
          ordinal: "0",
          role: "user",
          category: "user-message",
          occurredAt: new Date().toISOString(),
          mediaType: "text/plain; charset=utf-8",
          content,
          previousFrameId: null,
          toolCorrelationId: null,
          artifactHashes: [],
        },
      ],
    });
    try {
      const proof = this.#mintProof(sessionId, this.#rootContext, (scope) =>
        retainedEvidenceProofTarget(decoded, scope, randomUUID()),
      );
      const result = this.#retainedEvidenceRuntime.execute(
        {
          command: decoded.command,
          authorization: {
            kind: "protected",
            authoritySessionId: sessionId as SessionId,
            targetSessionId: sessionId as SessionId,
            proof,
            approval: null,
            childBindingGrant: null,
          },
        },
        this.#rootContext,
      );
      return {
        conversationId,
        evidenceIds: result.response.evidenceIds,
        eventIds: result.eventIds,
      };
    } finally {
      decoded.canonicalOriginalBytes.fill(0);
    }
  }

  async #publishProjectionV3(force = false): Promise<ProjectionManifestV3> {
    const projectionDir = join(this.#route.storeRoot, "projections");
    mkdirSync(projectionDir, { recursive: true });
    const manifestPath = join(projectionDir, "projection-manifest.json");
    let activeProjectionBinding: ProjectBinding = this.#projectionBinding;
    if (existsSync(manifestPath)) {
      try {
        const rawManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          projectId?: string;
          vaultId?: string;
          storeId?: string;
          workspaceId?: string;
          branchScopeId?: string | null;
          branchRef?: string | null;
        };
        if (rawManifest.projectId === this.#projectionBinding.projectId) {
          activeProjectionBinding = Object.freeze({
            ...this.#projectionBinding,
            branchScopeId:
              (rawManifest.branchScopeId ?? this.#projectionBinding.branchScopeId) as BranchScopeId | null,
            branchRef:
              rawManifest.branchRef !== undefined
                ? rawManifest.branchRef
                : this.#projectionBinding.branchRef,
          });
        }
        const prior = parseRichProjectionManifest(rawManifest, activeProjectionBinding);
        if (
          !force
          && prior.schemaVersion === 3
          && prior.terminalEventPosition.toString() === this.#currentGlobalPosition()
        ) {
          return prior;
        }
      } catch {
        // Proceed to coordinator-governed build/reconciliation.
      }
    }

    const branchScopeRow = this.#connection
      .prepare(
        `SELECT branch_scope_id FROM branch_scopes
         WHERE project_id = $projectId AND retired_at IS NULL
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get({
        $projectId: this.#identity.projectId,
      }) as { branch_scope_id?: string } | undefined;
    if (
      branchScopeRow?.branch_scope_id
      && branchScopeRow.branch_scope_id !== activeProjectionBinding.branchScopeId
    ) {
      activeProjectionBinding = Object.freeze({
        ...activeProjectionBinding,
        branchScopeId: branchScopeRow.branch_scope_id as BranchScopeId,
      });
    }

    const driver = new NodeSqliteDriver({ DatabaseSync });
    const eventReader = new SqliteProjectionEventReader({
      driver,
      eventStorePath: this.#route.eventsPath,
      busyTimeoutMs: 5000,
    });
    const builder = new ImmutableProjectionBuilder({
      driver,
      projectionDirectory: projectionDir,
      now: () => new Date().toISOString(),
    });
    const coordinator = new V2ProjectionBuildCoordinator({
      eventReader,
      builder,
      projectionDirectory: projectionDir,
      schema3: {
        eventReader,
        builder,
      },
    });
    const published = await coordinator.ensurePublishedV3(
      activeProjectionBinding,
      BigInt(this.#currentGlobalPosition()),
      30_000,
    );
    return published.manifest;
  }

  async #withVerifiedReadAdapter<T>(
    state: FreshStartState,
    release: FreshStartRelease,
    sessionId: string | null,
    fn: (
      adapter: Pick<ReturnType<typeof createVerifiedReadAdapter>, "query" | "queryFullNote">,
    ) => Promise<T>,
  ): Promise<T> {
    const manifest = await this.#publishProjectionV3(false);
    const projectionDirectory = resolveDirectoryIdentity(
      join(this.#route.storeRoot, "projections"),
    );
    const executorStateDirectory = resolveDirectoryIdentity(
      join(this.#route.storeRoot, "verified-read-executor"),
    );
    const deploymentDirectory = resolveInternalDeploymentDirectory();
    const eventsPath = realpathSync.native(this.#route.eventsPath);
    const eventsStat = lstatSync(eventsPath, { bigint: true });
    const binding: VerifiedReadBinding = Object.freeze({
      projectionBinding: Object.freeze({
        projectId: manifest.projectId,
        vaultId: manifest.vaultId,
        storeId: manifest.storeId,
        workspaceId: manifest.workspaceId,
        branchScopeId: manifest.branchScopeId,
        branchRef: manifest.branchRef,
        sessionId: null,
      }),
      expectedRelease: release,
      controlGeneration: state.generation.toString(),
      session: sessionId ? Object.freeze({ sessionId, minimumEventPosition: "0" }) : null,
      eventsFile: Object.freeze({
        path: eventsPath,
        device: String(eventsStat.dev),
        inode: String(eventsStat.ino),
      }),
      projectionDirectory,
      executorStateDirectory,
      deploymentDirectory,
      compositionEpoch: `v2-mcp-${state.generation.toString()}`,
    });
    const runInProcessVerifiedRead = async (): Promise<T> => {
      const bytes = readFileSync(
        join(this.#route.storeRoot, "projections", manifest.databaseFile),
      );
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== manifest.databaseSha256) {
        throw new FreshStartError("FRESH_START_STORAGE_FAILURE");
      }
      const image = openImmutableProjectionImage(bytes);
      const fence = Object.freeze({
        releaseId: release.releaseId,
        controlGeneration: state.generation.toString(),
        capturedPosition: manifest.terminalEventPosition.toString(),
        capturedHash: manifest.terminalEventHash,
        requiredPosition: manifest.terminalEventPosition.toString(),
      });
      const ids = Object.freeze({
        requestId: randomUUID(),
        attemptId: randomUUID(),
        laneEpoch: binding.compositionEpoch,
      });
      const closed = Object.freeze({ image: true, reader: true, lock: true } as const);
      try {
        return await fn({
          queryFullNote: async (rawReq) => {
            const req = decodeGetFullNoteRequest(rawReq, binding.session);
            const receipt = decodeFullNoteVerifiedReadReceipt({
              operation: "get-full-note",
              consistency: req.consistency,
              scope: {
                ...binding.projectionBinding,
                sessionId: req.consistency === "session-strong" ? binding.session!.sessionId : null,
              },
              releaseId: fence.releaseId,
              controlGeneration: fence.controlGeneration,
              requiredEventPosition: fence.requiredPosition,
              projectionGeneration: manifest.generation,
              projectionEventPosition: manifest.terminalEventPosition.toString(),
              projectionEventHash: manifest.terminalEventHash,
              imageSha256: sha256,
              verification: "image-scope-position-and-active-admission",
              projectionSchemaVersion: 3,
            });
            const base = Object.freeze({
              version: 4 as const,
              ids,
              kind: "success" as const,
              receipt,
              fence,
              closed,
            });
            const candidate = queryNativeFullNote(image, manifest, {
              request: req,
              binding,
              receipt,
              remainingMs: req.budgetMs,
            });
            const content = buildNativeFullNoteResult(candidate, base);
            return Object.freeze({ receipt, content });
          },
          query: async (rawReq) => {
            const req = decodeVerifiedReadRequest(rawReq, binding.session);
            if (req.operation === "verify-published-view") {
              throw new FreshStartError("FRESH_START_INPUT_INVALID");
            }
            const receipt = decodeVerifiedReadReceipt({
              operation: req.operation,
              consistency: req.consistency,
              scope: {
                ...binding.projectionBinding,
                sessionId: req.consistency === "session-strong" ? binding.session!.sessionId : null,
              },
              releaseId: fence.releaseId,
              controlGeneration: fence.controlGeneration,
              requiredEventPosition: fence.requiredPosition,
              projectionGeneration: manifest.generation,
              projectionEventPosition: manifest.terminalEventPosition.toString(),
              projectionEventHash: manifest.terminalEventHash,
              imageSha256: sha256,
              verification: "image-scope-position-and-active-admission",
            });
            const base = Object.freeze({
              version: 3 as const,
              ids,
              kind: "success" as const,
              receipt,
              fence,
              closed,
            });
            const candidate = queryNativeContent(image, manifest, {
              request: req,
              binding,
              receipt,
              remainingMs: req.budgetMs,
            });
            const content = buildNativeContentResult(candidate, base);
            return Object.freeze({ receipt, content });
          },
        });
      } finally {
        image.close();
      }
    };

    if (state.mode === "read-only-recovery") {
      const tailRow = this.#connection
        .prepare(
          `SELECT global_position, event_hash FROM events
           WHERE project_id = $projectId
           ORDER BY global_position DESC LIMIT 1`,
        )
        .get({ $projectId: this.#identity.projectId }) as
        | { global_position?: bigint; event_hash?: string }
        | undefined;
      const tailPosition = tailRow?.global_position ?? 0n;
      const tailHash = tailRow?.event_hash ?? GENESIS_GLOBAL_HASH;
      if (
        state.recoveryPosition === null
        || state.recoveryHash === null
        || state.recoveryPosition !== tailPosition
        || state.recoveryHash !== tailHash
      ) {
        throw new FreshStartError("FRESH_START_RECOVERY_REQUIRED");
      }
      return await runInProcessVerifiedRead();
    }

    const ownerFile = join(
      this.#route.storeRoot,
      "verified-read-executor",
      "verified-read-owner.json",
    );
    try {
      if (existsSync(ownerFile)) {
        const parsedOwner = JSON.parse(readFileSync(ownerFile, "utf8")) as { state?: string };
        if (parsedOwner?.state === "incomplete") {
          rmSync(ownerFile, { force: true });
        }
      }
    } catch {
      // Ignore stale owner check races.
    }

    try {
      const adapter = createVerifiedReadAdapter(binding);
      try {
        return await fn(adapter);
      } finally {
        await adapter.close();
      }
    } catch (err) {
      if (err instanceof FreshStartError) {
        throw err;
      }
      try {
        if (existsSync(ownerFile)) {
          const parsedOwner = JSON.parse(readFileSync(ownerFile, "utf8")) as { state?: string };
          if (parsedOwner?.state === "incomplete") {
            rmSync(ownerFile, { force: true });
          }
        }
      } catch {
        // Ignore cleanup races.
      }
      return await runInProcessVerifiedRead();
    }
  }

  async #handleSessionStart(
    args: Record<string, unknown>,
    state: FreshStartState,
    release: FreshStartRelease,
  ): Promise<Record<string, unknown>> {
    const agentName =
      typeof args.agentName === "string" && args.agentName.trim().length > 0
        ? args.agentName.trim()
        : typeof args.agentId === "string" && args.agentId.trim().length > 0
          ? args.agentId.trim()
          : "mcp-root";
    const started = await this.#startNewRootSession(agentName);
    const includeContext = args.includeContext !== false;
    if (!includeContext || state.mode !== "active") {
      return {
        ok: true,
        sessionId: started.sessionId,
        conversationId: started.conversationId,
        status: "active",
        mode: state.mode, latestCheckpoint: this.#readLatestProjectCheckpoint(), sessions: await this.#listProjectSessionsWithActivity(),
      };
    }

    const taskSummary =
      typeof args.taskSummary === "string" && args.taskSummary.trim().length > 0
        ? args.taskSummary.trim()
        : typeof args.taskDescription === "string" && args.taskDescription.trim().length > 0
          ? args.taskDescription.trim()
          : typeof args.contextArea === "string" && args.contextArea.trim().length > 0
            ? args.contextArea.trim()
            : "session-start";
    const plannedFiles = Array.isArray(args.plannedFiles)
      ? args.plannedFiles.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
      : Array.isArray(args.filesTouched)
        ? args.filesTouched.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
        : [];

    const awaken = await this.#handleAwaken(
      {
        ...args,
        sessionId: started.sessionId,
        area: typeof args.contextArea === "string" ? args.contextArea : taskSummary,
        plannedFiles,
      },
      state,
      release,
    );
    const selfCheck = await this.#handleSelfCheck(
      {
        sessionId: started.sessionId,
        taskSummary,
        plannedFiles,
        filesTouched: plannedFiles,
      },
      state,
    );

    return {
      ok: true,
      sessionId: started.sessionId,
      conversationId: started.conversationId,
      status: "active",
      mode: state.mode, latestCheckpoint: this.#readLatestProjectCheckpoint(), sessions: await this.#listProjectSessionsWithActivity(),
      awaken,
      contextPack: awaken.contextPack,
      selfCheck,
    };
  }

  async #handleLifecycleStatus(
    args: Record<string, unknown>,
    state: FreshStartState,
  ): Promise<Record<string, unknown>> {
    const sessionId =
      state.mode === "read-only-recovery"
        ? this.#resolveActiveRootSessionId(args.sessionId)
        : await this.#ensureActiveRootSession(args.sessionId);
    const row = sessionId
      ? this.#authorityRepo.get(this.#connection, this.#identity.projectId, sessionId)
      : null;
    return {
      ok: true,
      sessionId,
      status: row?.semanticState ?? "active",
      state: row?.semanticState ?? "active",
      ownerGeneration: row?.ownerGeneration?.toString() ?? "1",
      latestCheckpointId: row?.latestCheckpointId ?? null,
      mode: state.mode, latestCheckpoint: this.#readLatestProjectCheckpoint(), sessions: await this.#listProjectSessionsWithActivity(),
    };
  }

  async #listProjectSessionsWithActivity(): Promise<Array<Record<string, unknown>>> {
    const rows = this.#connection
      .prepare(
        `SELECT session_id, session_kind, parent_session_id, semantic_state,
                root_handle_issued_at, child_handle_issued_at, latest_checkpoint_id
         FROM session_authority
         WHERE project_id = $projectId
         ORDER BY authority_event_position DESC LIMIT 30`,
      )
      .all({ $projectId: this.#identity.projectId }) as Array<{
      session_id: string;
      session_kind: string;
      parent_session_id: string | null;
      semantic_state: string;
      root_handle_issued_at: string | null;
      child_handle_issued_at: string | null;
      latest_checkpoint_id: string | null;
    }>;

    const allNotes = await this.#listProjectNotesFromProjection();
    const notesBySession = new Map<string, typeof allNotes>();
    for (const n of allNotes) {
      if (!n.sessionId) continue;
      const list = notesBySession.get(n.sessionId) ?? [];
      list.push(n);
      notesBySession.set(n.sessionId, list);
    }
    const latestCp = this.#readLatestProjectCheckpoint();

    return rows.map((r) => {
      const sNotes = notesBySession.get(r.session_id) ?? [];
      const sLog = sNotes.find((n) => n.recordKind === "session-log");
      const firstNote = sNotes[0];
      const isCpMatch = latestCp?.sessionId === r.session_id;
      const currentTask =
        isCpMatch && latestCp?.taskSummary
          ? latestCp.taskSummary
          : sLog
            ? sLog.summary || sLog.title
            : firstNote
              ? `จัดการความจำ: ${firstNote.title}`
              : r.semantic_state === "active"
                ? "AI กำลังทำงานและซิงก์บริบทในเซสชันนี้ (Active AI Session)"
                : "เซสชันดำเนินการเสร็จสิ้น";
      return {
        sessionId: r.session_id,
        kind: r.session_kind,
        parentSessionId: r.parent_session_id,
        semanticState: r.semantic_state,
        leaseState: r.semantic_state === "active" ? "active-lease" : "released",
        issuedAt: r.root_handle_issued_at ?? r.child_handle_issued_at ?? null,
        latestCheckpointId: r.latest_checkpoint_id,
        currentTask,
        inProgressItems: isCpMatch ? latestCp?.inProgressItems ?? [] : [],
        nextActions: isCpMatch ? latestCp?.nextActions ?? [] : [],
        blockers: isCpMatch ? latestCp?.blockers ?? [] : [],
        noteCount: sNotes.length,
        noteIds: sNotes.map((n) => n.recordId),
        noteTitles: sNotes.map((n) => n.title),
        filesTouched: [...new Set(sNotes.flatMap((n) => n.filePaths))],
      };
    });
  }

  #extractFilePathsAndSymbols(text: string): {
    readonly filePaths: readonly string[];
    readonly symbols: readonly string[];
  } {
    const pathMatches =
      text.match(
        /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}|[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sql|py|php|go|rs|java|toml|yaml|yml)/gu,
      ) ?? [];
    const normalizedPaths = [
      ...new Set(
        pathMatches
          .map((p) => p.replace(/\\/gu, "/").replace(/^\.\//u, "").trim())
          .filter((p) => p.length >= 3 && !p.startsWith("http")),
      ),
    ];

    const symbolMatches =
      text.match(
        /#[a-zA-Z][a-zA-Z0-9_]{2,}|`([a-zA-Z_][a-zA-Z0-9_]{2,})`|(?:\b[a-z]+[A-Z][a-zA-Z0-9_]*\b)|(?:\b[A-Z][a-z0-9]+[A-Z][a-zA-Z0-9_]*\b)/gu,
      ) ?? [];
    const symbols = [
      ...new Set(
        symbolMatches
          .map((s) => s.replace(/`/gu, "").trim())
          .filter((s) => s.length >= 3),
      ),
    ];

    return Object.freeze({
      filePaths: Object.freeze(normalizedPaths),
      symbols: Object.freeze(symbols),
    });
  }

  #tokenizeMultilingual(text: string): string[] {
    const lower = text.trim().toLowerCase();
    if (!lower) return [];
    const tokens: string[] = [
      ...(lower.match(/[0-9a-z_./-]{2,}/giu) ?? []),
    ];

    if (/[\u0E00-\u0E7F]/u.test(lower)) {
      if (THAI_WORD_SEGMENTER) {
        for (const seg of THAI_WORD_SEGMENTER.segment(lower)) {
          const word = seg.segment.trim();
          if (seg.isWordLike && word.length >= 2) {
            tokens.push(word);
          }
        }
      }
      for (const chunk of lower.match(/[\u0E00-\u0E7F]{2,}/gu) ?? []) {
        tokens.push(chunk);
      }
    }

    const stopWords = new Set([
      "the",
      "and",
      "for",
      "with",
      "from",
      "that",
      "this",
      "into",
      "about",
      "การ",
      "ของ",
      "และ",
      "ใน",
      "ที่",
      "ให้",
      "ด้วย",
      "จาก",
      "สำหรับ",
    ]);
    return [...new Set(tokens.filter((t) => t.length >= 2 && !stopWords.has(t)))];
  }

  async #listProjectNotesFromProjection(): Promise<
    Array<{
      readonly id: string;
      readonly recordId: string;
      readonly kind: string;
      readonly recordKind: string;
      readonly normalizedKey: string;
      readonly title: string;
      readonly summary: string;
      readonly body: string;
      readonly status: string;
      readonly verificationMethod: string;
      readonly confidence: string;
      readonly validFrom: string;
      readonly validTo: string | null;
      readonly sourceEventPosition: number;
      readonly sessionId: string | null;
      readonly filePaths: readonly string[];
      readonly symbols: readonly string[];
      readonly lowerSearchText: string;
    }>
  > {
    const projectedRows = await this.#withProjectedImage((db) => {
      return db
        .prepare(
          `SELECT c.item_id, c.session_id, c.normalized_key, c.status, c.confidence,
                  c.verification_method, c.valid_from, c.valid_to, c.summary,
                  c.source_event_position, g.record_kind, g.body
           FROM canonical_items c
           LEFT JOIN governed_notes g
             ON g.project_id = c.project_id AND g.item_id = c.item_id
           WHERE c.project_id = $projectId
             AND c.status NOT IN ('retracted', 'superseded', 'expired', 'erased-evidence')
           ORDER BY c.source_event_position DESC, c.item_id ASC`,
        )
        .all({ $projectId: this.#identity.projectId }) as Array<{
        item_id: string;
        session_id: string | null;
        normalized_key: string;
        status: string;
        confidence: string;
        verification_method: string;
        valid_from: string;
        valid_to: string | null;
        summary: string;
        source_event_position: number | bigint;
        record_kind: string | null;
        body: string | null;
      }>;
    });

    const mergedById = new Map<
      string,
      {
        item_id: string;
        session_id: string | null;
        normalized_key: string;
        status: string;
        confidence: string;
        verification_method: string;
        valid_from: string;
        valid_to: string | null;
        summary: string;
        source_event_position: number;
        record_kind: string | null;
        body: string | null;
      }
    >();

    for (const r of projectedRows) {
      mergedById.set(r.item_id, {
        ...r,
        source_event_position: Number(r.source_event_position),
      });
    }

    try {
      const eventRows = this.#connection
        .prepare(
          `SELECT global_position, event_type, event_schema_version, session_id, payload_json
           FROM events
           WHERE project_id = $projectId
             AND (event_type = 'MemorySourceRecorded' OR stream_type = 'governed-lifecycle')
           ORDER BY global_position ASC`,
        )
        .all({ $projectId: this.#identity.projectId }) as Array<{
        global_position: number | bigint;
        event_type: string;
        event_schema_version: number | bigint;
        session_id: string | null;
        payload_json: string;
      }>;

      for (const row of eventRows) {
        const eventType = String(row.event_type);
        const schemaVersion = Number(row.event_schema_version);
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
        } catch (parseErr) {
          process.stderr.write(
            `[v2-public-tools] Skipped malformed event payload at position ${String(row.global_position)}: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}\n`,
          );
          continue;
        }
        if (eventType === "MemorySourceRecorded") {
          const item = (schemaVersion >= 3 ? payload.item : payload) as Record<string, unknown> | undefined;
          if (!item || typeof item.itemId !== "string") continue;
          const itemId = item.itemId;
          const normalizedKey = String(item.normalizedKey ?? `governed-note/insight/${itemId}`);
          const recordKind =
            typeof item.recordKind === "string"
              ? item.recordKind
              : normalizedKey.startsWith("governed-note/")
                ? (normalizedKey.split("/")[1] ?? "insight")
                : "insight";
          const contentObj = item.content as { body?: unknown } | undefined;
          const body = typeof contentObj?.body === "string" ? contentObj.body : "";
          const bindingObj = payload.binding as { sessionId?: unknown } | undefined;
          const sessionId =
            typeof row.session_id === "string"
              ? row.session_id
              : typeof bindingObj?.sessionId === "string"
                ? bindingObj.sessionId
                : null;
          const existing = mergedById.get(itemId);
          if (!existing) {
            mergedById.set(itemId, {
              item_id: itemId,
              session_id: sessionId,
              normalized_key: normalizedKey,
              status: typeof item.status === "string" ? item.status : "candidate",
              confidence: typeof item.confidence === "string" ? item.confidence : "high",
              verification_method:
                typeof item.verificationMethod === "string"
                  ? item.verificationMethod
                  : "governed-note-unverified-v2",
              valid_from: typeof item.validFrom === "string" ? item.validFrom : "",
              valid_to: typeof item.validTo === "string" ? item.validTo : null,
              summary: typeof item.summary === "string" ? item.summary : "",
              source_event_position: Number(row.global_position),
              record_kind: recordKind,
              body,
            });
          } else if (!existing.body && body) {
            existing.body = body;
          }
        } else {
          const erasedIds = Array.isArray(payload.erasedRecordIds)
            ? payload.erasedRecordIds.map(String)
            : [];
          if (eventType === "EvidenceErased") {
            for (const targetId of [String(payload.recordId ?? ""), ...erasedIds]) {
              if (targetId) mergedById.delete(targetId);
            }
          } else if (typeof payload.recordId === "string") {
            const target = mergedById.get(payload.recordId);
            if (target) {
              const nextStatus =
                typeof payload.targetStatus === "string" ? payload.targetStatus : target.status;
              if (
                nextStatus === "retracted"
                || nextStatus === "superseded"
                || nextStatus === "expired"
                || nextStatus === "erased-evidence"
              ) {
                mergedById.delete(payload.recordId);
              } else {
                target.status = nextStatus;
                if (typeof payload.verificationMethod === "string") {
                  target.verification_method = payload.verificationMethod;
                }
                if (typeof payload.validFrom === "string") {
                  target.valid_from = payload.validFrom;
                }
                if (payload.validTo === null || typeof payload.validTo === "string") {
                  target.valid_to = payload.validTo;
                }
              }
            }
          }
        }
      }
    } catch (foldErr) {
      // Fall back to projected rows if direct event fold fails.
      process.stderr.write(
        `[v2-public-tools] Event fold fallback to projected rows: ${foldErr instanceof Error ? foldErr.message : String(foldErr)}\n`,
      );
    }

    const combinedRows = [...mergedById.values()]
      .filter(
        (r) =>
          !["retracted", "superseded", "expired", "erased-evidence"].includes(r.status),
      )
      .sort(
        (a, b) =>
          b.source_event_position - a.source_event_position
          || a.item_id.localeCompare(b.item_id),
      );

    return combinedRows.map((r) => {
      const recordKind = r.record_kind ?? "insight";
      const colonIdx = r.summary.indexOf(": ");
      const title = colonIdx > 0 ? r.summary.slice(0, colonIdx) : r.summary;
      const body = r.body ?? "";
      const extracted = this.#extractFilePathsAndSymbols(`${r.summary}\n${body}`);
      const lowerSearchText = `${title} ${r.summary} ${r.normalized_key} ${body}`.toLowerCase();
      return Object.freeze({
        id: r.item_id,
        recordId: r.item_id,
        kind: recordKind,
        recordKind,
        normalizedKey: r.normalized_key,
        title,
        summary: r.summary,
        body,
        status: r.status,
        verificationMethod: r.verification_method,
        confidence: r.confidence,
        validFrom: r.valid_from,
        validTo: r.valid_to,
        sourceEventPosition: Number(r.source_event_position),
        sessionId: r.session_id,
        filePaths: extracted.filePaths,
        symbols: extracted.symbols,
        lowerSearchText,
      });
    });
  }

  #doesNoteMatchFilePath(
    note: {
      readonly title: string;
      readonly summary: string;
      readonly body: string;
      readonly filePaths?: readonly string[];
    },
    targetFile: string,
  ): boolean {
    const normTarget = targetFile.replace(/\\/gu, "/").replace(/^\.\//u, "").trim().toLowerCase();
    if (!normTarget) return false;
    const targetBase = basename(normTarget);
    const notePaths = (note.filePaths ?? []).map((p) => p.toLowerCase());
    if (
      notePaths.some(
        (np) =>
          np === normTarget ||
          np.endsWith(`/${normTarget}`) ||
          normTarget.endsWith(`/${np}`) ||
          (targetBase.length >= 5 && basename(np) === targetBase),
      )
    ) {
      return true;
    }
    const combined = `${note.title} ${note.summary} ${note.body}`.replace(/\\/gu, "/").toLowerCase();
    return combined.includes(normTarget);
  }

  #scoreHybridNoteMatch(
    note: {
      readonly title: string;
      readonly summary: string;
      readonly body: string;
      readonly normalizedKey: string;
      readonly status: string;
      readonly recordKind: string;
      readonly sourceEventPosition: number;
      readonly filePaths?: readonly string[];
      readonly symbols?: readonly string[];
    },
    rawQuery: string,
    extraTerms: readonly string[] = [],
    corpusNotes?: ReadonlyArray<{
      readonly title: string;
      readonly summary: string;
      readonly body: string;
      readonly normalizedKey: string;
      readonly lowerSearchText?: string;
    }>,
  ): number {
    const qLower = rawQuery.trim().toLowerCase();
    const titleLower = note.title.toLowerCase();
    const summaryLower = note.summary.toLowerCase();
    const bodyLower = note.body.toLowerCase();
    const keyLower = note.normalizedKey.toLowerCase();
    const combinedHeader = `${titleLower} ${summaryLower} ${keyLower}`;
    const combinedAll = `${combinedHeader} ${bodyLower}`;

    let score = 0;
    if (qLower.length >= 2) {
      if (combinedHeader.includes(qLower)) score += 500;
      else if (bodyLower.includes(qLower)) score += 300;
    }

    for (const term of extraTerms) {
      if (this.#doesNoteMatchFilePath(note, term)) {
        score += 260;
      }
    }

    const tokens = [
      ...new Set([
        ...this.#tokenizeMultilingual(rawQuery),
        ...extraTerms.flatMap((t) => this.#tokenizeMultilingual(t)),
      ]),
    ];

    const totalDocs = corpusNotes && corpusNotes.length > 0 ? corpusNotes.length : 1;
    const tokenIdf = (token: string): number => {
      if (!corpusNotes || corpusNotes.length <= 1) return 1.0;
      let df = 0;
      for (const doc of corpusNotes) {
        const docText =
          doc.lowerSearchText ??
          `${doc.title} ${doc.summary} ${doc.normalizedKey} ${doc.body}`.toLowerCase();
        if (docText.includes(token)) df += 1;
      }
      return Math.max(0.4, Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5)) + 0.5);
    };

    let matchedTokens = 0;
    for (const token of tokens) {
      const idf = tokenIdf(token);
      if (combinedHeader.includes(token)) {
        score += Math.round(120 * idf);
        matchedTokens += 1;
      } else if (bodyLower.includes(token)) {
        score += Math.round(60 * idf);
        matchedTokens += 1;
      } else if (/[\u0E00-\u0E7F]/u.test(token) && token.length >= 4) {
        // Sub-phrase N-gram matching for unspaced Thai queries
        let ngramHits = 0;
        const ngramLen = 4;
        const totalNgrams = token.length - ngramLen + 1;
        for (let i = 0; i <= token.length - ngramLen; i += 1) {
          const gram = token.slice(i, i + ngramLen);
          if (combinedAll.includes(gram)) ngramHits += 1;
        }
        if (ngramHits > 0) {
          score += Math.round((ngramHits / totalNgrams) * 140 * idf);
          matchedTokens += 1;
        }
      }
    }

    if (score === 0 && matchedTokens === 0) return 0;

    if (note.status === "verified" || note.status === "active") score += 45;
    else if (note.status === "provisional") score += 25;
    else if (note.status === "candidate") score += 10;

    if (note.recordKind === "adr" || note.recordKind === "mistake") score += 20;
    else if (note.recordKind === "insight") score += 10;

    score += Math.min(note.sourceEventPosition, 50);
    return score;
  }

  #readLatestProjectCheckpoint(): {
    readonly checkpointId: string;
    readonly sessionId: string;
    readonly occurredAt: string;
    readonly taskSummary: string;
    readonly completedItems: readonly string[];
    readonly inProgressItems: readonly string[];
    readonly blockers: readonly string[];
    readonly nextActions: readonly string[];
    readonly decisions: readonly string[];
    readonly filesTouched: readonly string[];
  } | null {
    const row = this.#connection
      .prepare(
        `SELECT session_id, occurred_at, payload_json
         FROM events
         WHERE project_id = $projectId AND event_type = 'SessionCheckpointRecorded'
         ORDER BY global_position DESC LIMIT 1`,
      )
      .get({ $projectId: this.#identity.projectId }) as
      | { session_id?: string | null; occurred_at: string; payload_json: string }
      | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.payload_json) as {
        checkpoint?: {
          checkpointId?: string;
          sessionId?: string;
          taskSummary?: string;
          completedItems?: Array<{ summary?: string }>;
          inProgressItems?: Array<{ summary?: string }>;
          blockers?: Array<{ summary?: string }>;
          nextActions?: Array<{ summary?: string }>;
          decisions?: Array<{ summary?: string }>;
          filesTouched?: Array<{ path?: string }>;
        };
      };
      const cp = parsed.checkpoint;
      if (!cp) return null;
      const toStrings = (items?: Array<{ summary?: string }>) =>
        Object.freeze(
          (items ?? [])
            .map((i) => (typeof i?.summary === "string" ? i.summary : ""))
            .filter((s) => s.length > 0),
        );
      return Object.freeze({
        checkpointId: String(cp.checkpointId ?? ""),
        sessionId: String(cp.sessionId ?? row.session_id ?? ""),
        occurredAt: row.occurred_at,
        taskSummary: String(cp.taskSummary ?? ""),
        completedItems: toStrings(cp.completedItems),
        inProgressItems: toStrings(cp.inProgressItems),
        blockers: toStrings(cp.blockers),
        nextActions: toStrings(cp.nextActions),
        decisions: toStrings(cp.decisions),
        filesTouched: Object.freeze(
          (cp.filesTouched ?? [])
            .map((f) => (typeof f?.path === "string" ? f.path : ""))
            .filter((p) => p.length > 0),
        ),
      });
    } catch {
      return null;
    }
  }

  #inspectLiveWorkspaceState(): {
    readonly projectRoot: string;
    readonly branch: string | null;
    readonly headCommit: string | null;
    readonly isDirty: boolean;
    readonly modifiedFiles: readonly string[];
    readonly untrackedFiles: readonly string[];
  } {
    const branch = this.#workspace.kind === "git" ? this.#workspace.branchRef : null;
    const headCommit = this.#workspace.kind === "git" ? this.#workspace.headCommit : null;
    const modifiedFiles: string[] = [];
    const untrackedFiles: string[] = [];
    try {
      const gitRes = new SpawnSyncGitCommandRunner().run(this.#paths.projectRoot, [
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
      ]);
      if (gitRes.exitCode === 0 && gitRes.stdout.trim().length > 0) {
        for (const rawLine of gitRes.stdout.split(/\r?\n/u)) {
          if (rawLine.length < 4) continue;
          const status = rawLine.slice(0, 2);
          const filePath = rawLine.slice(3).trim();
          if (!filePath) continue;
          if (status === "??") untrackedFiles.push(filePath);
          else modifiedFiles.push(filePath);
        }
      }
    } catch {
      // Non-git or unavailable git binary degrades gracefully.
    }
    return Object.freeze({
      projectRoot: this.#paths.projectRoot,
      branch,
      headCommit,
      isDirty: modifiedFiles.length > 0 || untrackedFiles.length > 0,
      modifiedFiles: Object.freeze(modifiedFiles.slice(0, 50)),
      untrackedFiles: Object.freeze(untrackedFiles.slice(0, 50)),
    });
  }

  async #handleSelfCheck(
    args: Record<string, unknown>,
    state: FreshStartState,
  ): Promise<Record<string, unknown>> {
    const sessionId =
      state.mode === "read-only-recovery"
        ? this.#resolveActiveRootSessionId(args.sessionId)
        : await this.#ensureActiveRootSession(args.sessionId);
    const taskSummary = typeof args.taskSummary === "string" ? args.taskSummary : null;
    const rawPlanned = Array.isArray(args.plannedFiles)
      ? args.plannedFiles
      : Array.isArray(args.filesTouched)
        ? args.filesTouched
        : [];
    const filesTouched = rawPlanned.filter(
      (f): f is string => typeof f === "string" && f.trim().length > 0,
    );

    const allNotes = await this.#listProjectNotesFromProjection();
    const queryText = taskSummary ?? "";
    const scoredMistakes = allNotes
      .filter((n) => n.recordKind === "mistake")
      .map((n) => ({
        note: n,
        score: queryText || filesTouched.length > 0
          ? this.#scoreHybridNoteMatch(n, queryText, filesTouched, allNotes)
          : 1,
      }))
      .sort((a, b) => b.score - a.score || b.note.sourceEventPosition - a.note.sourceEventPosition);

    const scoredADRs = allNotes
      .filter((n) => n.recordKind === "adr")
      .map((n) => ({
        note: n,
        score: queryText || filesTouched.length > 0
          ? this.#scoreHybridNoteMatch(n, queryText, filesTouched, allNotes)
          : 1,
      }))
      .sort((a, b) => b.score - a.score || b.note.sourceEventPosition - a.note.sourceEventPosition);

    const fileSpecificWarnings: Array<{
      readonly filePath: string;
      readonly recordId: string;
      readonly recordKind: string;
      readonly title: string;
      readonly summary: string;
    }> = [];
    for (const filePath of filesTouched) {
      for (const note of allNotes) {
        if (
          (note.recordKind === "mistake" || note.recordKind === "adr") &&
          this.#doesNoteMatchFilePath(note, filePath)
        ) {
          fileSpecificWarnings.push({
            filePath,
            recordId: note.recordId,
            recordKind: note.recordKind,
            title: note.title,
            summary: note.summary,
          });
        }
      }
    }

    const pastMistakesToAvoid = (
      scoredMistakes.some((m) => m.score > 0)
        ? scoredMistakes.filter((m) => m.score > 0)
        : scoredMistakes
    )
      .slice(0, 5)
      .map(({ note, score }) => ({
        id: note.id,
        recordId: note.recordId,
        title: note.title,
        summary: note.summary,
        status: note.status,
        filePaths: note.filePaths,
        relevanceScore: score,
      }));

    const bindingADRs = (
      scoredADRs.some((a) => a.score > 0) ? scoredADRs.filter((a) => a.score > 0) : scoredADRs
    )
      .slice(0, 5)
      .map(({ note, score }) => ({
        id: note.id,
        recordId: note.recordId,
        title: note.title,
        summary: note.summary,
        status: note.status,
        filePaths: note.filePaths,
        relevanceScore: score,
      }));

    const openConflicts = allNotes
      .filter((n) => n.status === "conflicted")
      .map((n) => ({
        id: n.id,
        recordId: n.recordId,
        title: n.title,
        summary: n.summary,
      }));

    const hasHighRiskMistakeMatch =
      scoredMistakes.some((m) => m.score >= 120) ||
      fileSpecificWarnings.some((w) => w.recordKind === "mistake");
    const riskLevel: "low" | "medium" | "high" =
      openConflicts.length > 0 || hasHighRiskMistakeMatch
        ? "high"
        : pastMistakesToAvoid.length > 0 || bindingADRs.length > 0 || filesTouched.length > 0
          ? "medium"
          : "low";

    const preFlightChecklist: string[] = [];
    for (const w of fileSpecificWarnings.slice(0, 3)) {
      preFlightChecklist.push(`File guardrail (${w.filePath}): ${w.summary}`);
    }
    for (const m of pastMistakesToAvoid.slice(0, 3)) {
      preFlightChecklist.push(`Avoid past mistake: ${m.summary}`);
    }
    for (const a of bindingADRs.slice(0, 3)) {
      preFlightChecklist.push(`Comply with ADR: ${a.summary}`);
    }
    if (filesTouched.length > 0) {
      preFlightChecklist.push(`Run automated tests covering touched files (${filesTouched.join(", ")})`);
    }
    if (preFlightChecklist.length === 0) {
      preFlightChecklist.push("Verify changes with unit tests and record ADR/Insight before session end.");
    }

    return {
      ok: true,
      sessionId,
      status: "healthy",
      taskSummary,
      filesTouched,
      plannedFiles: filesTouched,
      riskLevel,
      pastMistakesToAvoid,
      bindingADRs,
      fileSpecificWarnings,
      openConflicts,
      preFlightChecklist,
      mode: state.mode, latestCheckpoint: this.#readLatestProjectCheckpoint(), sessions: await this.#listProjectSessionsWithActivity(),
    };
  }

  async #handleWriteGovernedNote(
    recordKind: GovernedNoteKind,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const sessionId = await this.#ensureActiveRootSession(args.sessionId);
    const hasExplicitTitle = typeof args.title === "string" && args.title.trim().length > 0;
    const title = hasExplicitTitle
      ? String(args.title).trim()
      : `Governed ${recordKind}`;
    const explicitSummary = typeof args.summary === "string" && args.summary.trim().length > 0
      ? args.summary.trim()
      : "";
    const rawSummary = explicitSummary.length > 0
      ? hasExplicitTitle && !explicitSummary.includes(title)
        ? `${title}: ${explicitSummary}`
        : explicitSummary
      : title;
    const body = typeof args.content === "string" && args.content.trim().length > 0
      ? args.content
      : typeof args.body === "string" && args.body.trim().length > 0
        ? args.body
        : `# ${title}\n\n${rawSummary}`;
    const confidence =
      args.confidence === "high"
      || args.confidence === "medium"
      || args.confidence === "low"
      || args.confidence === "guess"
        ? args.confidence
        : ("high" as const);

    const rawIdempotencyKey =
      typeof args.idempotencyKey === "string" && args.idempotencyKey.trim().length > 0
        ? args.idempotencyKey.trim()
        : null;
    const rawCommandId =
      typeof args.commandId === "string" && args.commandId.trim().length > 0
        ? args.commandId.trim()
        : null;
    const toCanonicalUuidV4 = (namespace: string, text: string): string => {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
        return text.toLowerCase();
      }
      const bytes = Buffer.from(
        createHash("sha256").update(`${namespace}:${text}`, "utf8").digest().subarray(0, 16),
      );
      bytes[6] = (bytes[6]! & 0x0f) | 0x40;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = bytes.toString("hex");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    };
    const idempotencyKey = rawIdempotencyKey
      ? toCanonicalUuidV4("v2-governed-note-idempotency", rawIdempotencyKey)
      : randomUUID();
    const commandId = rawCommandId
      ? toCanonicalUuidV4("v2-governed-note-command", rawCommandId)
      : rawIdempotencyKey
        ? toCanonicalUuidV4("v2-governed-note-command", rawIdempotencyKey)
        : randomUUID();

    const prior =
      rawIdempotencyKey !== null || rawCommandId !== null
        ? new GovernedNoteRepository(this.#connection).findGovernedNotePriorAny(
            commandId,
            idempotencyKey,
          )
        : null;

    const explicitProvenance =
      Array.isArray(args.provenance) && args.provenance.length > 0
        ? args.provenance
        : null;
    let provenance: unknown;
    let evidenceId: string | null = null;
    if (explicitProvenance !== null) {
      provenance = explicitProvenance;
      for (const entry of explicitProvenance) {
        if (
          typeof entry === "object"
          && entry !== null
          && (entry as { kind?: unknown }).kind === "retained-evidence"
          && typeof (entry as { identity?: unknown }).identity === "string"
        ) {
          evidenceId = (entry as { identity: string }).identity;
          break;
        }
      }
    } else if (prior !== null) {
      provenance = prior.witness.provenance.map((p) => ({
        kind: p.kind,
        identity: p.identity,
      }));
      evidenceId = prior.witness.provenance[0]?.identity ?? null;
    } else {
      const retained = this.#retainEvidenceForSession(
        sessionId,
        `${title}\n${rawSummary}\n${body}`,
      );
      evidenceId = retained.evidenceIds[0]!;
      provenance = [{ kind: "retained-evidence", identity: evidenceId }];
    }

    const command = decodeGovernedNoteCommandV2({
      version: 2,
      operation: "create-governed-note",
      commandId,
      idempotencyKey,
      recordKind,
      summary: rawSummary,
      confidence,
      provenance,
      content: {
        format: "markdown",
        body,
      },
    });
    const noteBinding = deriveGovernedNoteBinding(
      this.#connection,
      this.#rootContext,
      sessionId,
    );
    const proof = this.#mintProof(sessionId, this.#rootContext, (scope) =>
      governedNoteCreateProofTargetV2(command, scope, noteBinding, randomUUID()),
    );
    let responseReceipt: GovernedNoteStoredReceiptV2;
    try {
      const created = this.#governedNoteRuntime.createV2(
        {
          command,
          authorization: {
            kind: "protected",
            authoritySessionId: sessionId as SessionId,
            targetSessionId: sessionId as SessionId,
            proof,
            approval: null,
            childBindingGrant: null,
          },
        },
        this.#rootContext,
      );
      responseReceipt = created.response;
    } catch (err) {
      if (
        prior !== null
        && prior.witness.witnessVersion === 2
        && prior.witness.binding.sessionId === sessionId
        && err instanceof Error
        && "code" in err
        && (err as { code?: unknown }).code === "SESSION_OWNERSHIP_MISMATCH"
      ) {
        responseReceipt = prior.result.response as GovernedNoteStoredReceiptV2;
      } else {
        throw err;
      }
    }

    await this.#publishProjectionV3();
    if (recordKind === "adr" || recordKind === "mistake") {
      await this.#publishProjectionV3(); await this.#syncIdeMemoryRulesFile();
    }
    return {
      ok: true,
      id: responseReceipt.recordId,
      noteId: responseReceipt.recordId,
      recordId: responseReceipt.recordId,
      recordKind: responseReceipt.recordKind,
      status: responseReceipt.status,
      verificationStatus: responseReceipt.verificationStatus,
      eventId: responseReceipt.sourceEventIds[0],
      sourceEventIds: responseReceipt.sourceEventIds,
      evidenceId,
      bodyContentHash: responseReceipt.content.contentHash,
      terminalPosition: responseReceipt.terminalPosition,
    };
  }

  #resolveNoteSessionId(recordId: string, explicitSessionId?: unknown): string | null {
    if (typeof explicitSessionId === "string" && explicitSessionId.trim().length > 0) {
      return explicitSessionId.trim();
    }
    const rows = this.#connection
      .prepare(
        `SELECT session_id, payload_json FROM events
         WHERE project_id = $projectId AND event_type IN ('GovernedNoteCreated', 'MemorySourceRecorded')
         ORDER BY global_position DESC`,
      )
      .all({ $projectId: this.#identity.projectId }) as Array<{
      session_id?: string | null;
      payload_json: string;
    }>;
    for (const row of rows) {
      if (row.payload_json.includes(recordId) && typeof row.session_id === "string") {
        return row.session_id;
      }
    }
    return this.#resolveActiveRootSessionId();
  }

  async #handleGetFullNote(
    args: Record<string, unknown>,
    state: FreshStartState,
    release: FreshStartRelease,
  ): Promise<Record<string, unknown>> {
    const id = String(args.id ?? args.recordId ?? args.noteId ?? "").trim();
    if (!id) throw new FreshStartError("FRESH_START_INPUT_INVALID");
    const sessionId = this.#resolveNoteSessionId(id, args.sessionId);
    const verified = await this.#withVerifiedReadAdapter(state, release, sessionId, async (adapter) => {
      const res = await adapter.queryFullNote({
        operation: "get-full-note",
        consistency: sessionId ? "session-strong" : "project-strong",
        minimumEventPosition: "0",
        budgetMs: 5000,
        parameters: { id },
      });
      if (!res.content.item) {
        return {
          ok: false,
          id,
          recordId: id,
          found: false,
        };
      }
      return {
        ok: true,
        recordId: res.content.item.id,
        ...res.content.item,
        conflict: res.content.conflict,
      };
    });
    if (verified.ok === false) {
      const allNotes = await this.#listProjectNotesFromProjection();
      const fallback = allNotes.find((n) => n.id === id || n.recordId === id);
      if (fallback) {
        return {
          ok: true,
          id: fallback.id,
          recordId: fallback.recordId,
          kind: fallback.recordKind,
          recordKind: fallback.recordKind,
          normalizedKey: fallback.normalizedKey,
          title: fallback.title,
          summary: fallback.summary,
          text: fallback.summary,
          body: fallback.body,
          content: {
            format: "markdown",
            body: fallback.body,
          },
          status: fallback.status,
          confidence: fallback.confidence,
          verificationMethod: fallback.verificationMethod,
          validFrom: fallback.validFrom,
          validTo: fallback.validTo,
          sessionId: fallback.sessionId,
          sourceEventPosition: String(fallback.sourceEventPosition),
          filePaths: fallback.filePaths,
          symbols: fallback.symbols,
          conflict: null,
        };
      }
    }
    return verified;
  }

  async #handleSearch(
    args: Record<string, unknown>,
    state: FreshStartState,
    release: FreshStartRelease,
  ): Promise<Record<string, unknown>> {
    const query = String(args.query ?? args.area ?? "").trim() || "governed";
    const limit = typeof args.limit === "number" ? args.limit : 10;
    const sessionId = this.#resolveReadSessionId(args.sessionId);
    const verifiedResult = await this.#withVerifiedReadAdapter(state, release, sessionId, async (adapter) => {
      const res = await adapter.query({
        operation: "search-projected-content",
        consistency: sessionId ? "session-strong" : "project-strong",
        minimumEventPosition: "0",
        budgetMs: 5000,
        parameters: { query, limit: Math.max(1, Math.min(10, Math.trunc(limit))) },
      });
      return {
        ok: true,
        ...res.content,
      };
    });

    const existingItems = Array.isArray((verifiedResult as { items?: unknown }).items)
      ? ([...(verifiedResult as unknown as { items: Array<Record<string, unknown>> }).items])
      : [];
    const seenIds = new Set<string>(
      existingItems
        .map((item) => String(item.id ?? item.recordId ?? ""))
        .filter((id) => id.length > 0),
    );

    if (existingItems.length < limit) {
      const allProjectNotes = await this.#listProjectNotesFromProjection();
      const hybridMatches = allProjectNotes
        .filter((note) => !seenIds.has(note.id))
        .map((note) => ({
          note,
          score: this.#scoreHybridNoteMatch(note, query, [], allProjectNotes),
        }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || b.note.sourceEventPosition - a.note.sourceEventPosition);

      for (const { note, score } of hybridMatches) {
        if (existingItems.length >= limit) break;
        seenIds.add(note.id);
        existingItems.push({
          id: note.id,
          recordId: note.recordId,
          kind: note.recordKind,
          recordKind: note.recordKind,
          normalizedKey: note.normalizedKey,
          title: note.title,
          summary: note.summary,
          status: note.status,
          confidence: note.confidence,
          validFrom: note.validFrom,
          validTo: note.validTo,
          sessionId: note.sessionId, sourceEventPosition: note.sourceEventPosition.toString(),
          filePaths: note.filePaths,
          symbols: note.symbols,
          hybridScore: score,
        });
      }
    }

    return {
      ...verifiedResult,
      items: existingItems,
    };
  }

  async #handleList(
    args: Record<string, unknown>,
    state: FreshStartState,
    release: FreshStartRelease,
  ): Promise<Record<string, unknown>> {
    const limit = typeof args.limit === "number" ? args.limit : 20;
    const sessionId = this.#resolveReadSessionId(args.sessionId);
    const verifiedResult = await this.#withVerifiedReadAdapter(state, release, sessionId, async (adapter) => {
      const res = await adapter.query({
        operation: "list-canonical-records",
        consistency: sessionId ? "session-strong" : "project-strong",
        minimumEventPosition: "0",
        budgetMs: 5000,
        parameters: { limit: Math.max(1, Math.min(10, Math.trunc(limit))) },
      });
      const content = res.content as NativeCanonicalPageResult;
      const items = content.items.map((entry) => ({
        ...entry.item, recordId: entry.item.id, summary: entry.item.text,
        conflict: entry.conflict,
      }));
      return {
        ok: true,
        items,
        hasMore: content.hasMore,
        nextCursor: content.nextCursor,
      };
    });

    const allProjectNotes = await this.#listProjectNotesFromProjection();
    const noteMap = new Map(allProjectNotes.map((n) => [n.id, n]));
    const items = (verifiedResult.items as Array<Record<string, unknown>>).map((i) => {
      const enriched = noteMap.get(String(i.id ?? i.recordId ?? ""));
      return enriched
        ? {
            ...i,
            id: enriched.id,
            recordId: enriched.recordId,
            kind: enriched.recordKind,
            recordKind: enriched.recordKind,
            title: enriched.title,
            summary: enriched.summary,
            body: enriched.body,
            sessionId: enriched.sessionId,
            filePaths: enriched.filePaths,
            symbols: enriched.symbols,
          }
        : i;
    });
    const seenIds = new Set<string>(items.map((i) => String(i.id ?? "")));
    if (items.length < limit) {
      for (const note of allProjectNotes) {
        if (items.length >= limit) break;
        if (seenIds.has(note.id)) continue;
        seenIds.add(note.id);
        items.push({
          id: note.id,
          recordId: note.recordId,
          kind: note.recordKind,
          recordKind: note.recordKind,
          normalizedKey: note.normalizedKey,
          title: note.title,
          summary: note.summary,
          body: note.body,
          status: note.status,
          confidence: note.confidence,
          validFrom: note.validFrom,
          validTo: note.validTo,
          sessionId: note.sessionId,
          sourceEventPosition: note.sourceEventPosition.toString(),
          filePaths: note.filePaths,
          symbols: note.symbols,
        });
      }
    }

    return {
      ...verifiedResult,
      items,
    };
  }

  async #handleRecent(
    args: Record<string, unknown>,
    state: FreshStartState,
    release: FreshStartRelease,
  ): Promise<Record<string, unknown>> {
    const limit = typeof args.limit === "number" ? args.limit : 20;
    const sessionId = this.#resolveReadSessionId(args.sessionId);
    const verifiedResult = await this.#withVerifiedReadAdapter(state, release, sessionId, async (adapter) => {
      const res = await adapter.query({
        operation: "recent-canonical-records",
        consistency: sessionId ? "session-strong" : "project-strong",
        minimumEventPosition: "0",
        budgetMs: 5000,
        parameters: { limit: Math.max(1, Math.min(10, Math.trunc(limit))) },
      });
      const content = res.content as NativeCanonicalPageResult;
      const items = content.items.map((entry) => ({
        ...entry.item, recordId: entry.item.id, summary: entry.item.text,
        conflict: entry.conflict,
      }));
      return {
        ok: true,
        items,
        hasMore: content.hasMore,
        nextCursor: content.nextCursor,
      };
    });

    const allProjectNotes = await this.#listProjectNotesFromProjection();
    const noteMap = new Map(allProjectNotes.map((n) => [n.id, n]));
    const items = (verifiedResult.items as Array<Record<string, unknown>>).map((i) => {
      const enriched = noteMap.get(String(i.id ?? i.recordId ?? ""));
      return enriched
        ? {
            ...i,
            id: enriched.id,
            recordId: enriched.recordId,
            kind: enriched.recordKind,
            recordKind: enriched.recordKind,
            title: enriched.title,
            summary: enriched.summary,
            body: enriched.body,
            sessionId: enriched.sessionId,
            filePaths: enriched.filePaths,
            symbols: enriched.symbols,
          }
        : i;
    });
    const seenIds = new Set<string>(items.map((i) => String(i.id ?? "")));
    if (items.length < limit) {
      for (const note of allProjectNotes) {
        if (items.length >= limit) break;
        if (seenIds.has(note.id)) continue;
        seenIds.add(note.id);
        items.push({
          id: note.id,
          recordId: note.recordId,
          kind: note.recordKind,
          recordKind: note.recordKind,
          normalizedKey: note.normalizedKey,
          title: note.title,
          summary: note.summary,
          body: note.body,
          status: note.status,
          confidence: note.confidence,
          validFrom: note.validFrom,
          validTo: note.validTo,
          sessionId: note.sessionId,
          sourceEventPosition: note.sourceEventPosition.toString(),
          filePaths: note.filePaths,
          symbols: note.symbols,
        });
      }
    }

    return {
      ...verifiedResult,
      items,
    };
  }

  async #handleContextPack(
    args: Record<string, unknown>,
    state: FreshStartState,
    release: FreshStartRelease,
  ): Promise<Record<string, unknown>> {
    const query =
      String(args.area ?? args.contextArea ?? args.query ?? args.task ?? "context").trim() ||
      "context";
    const plannedFiles = Array.isArray(args.plannedFiles)
      ? args.plannedFiles.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
      : Array.isArray(args.filesTouched)
        ? args.filesTouched.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
        : [];
    const sessionId = this.#resolveReadSessionId(args.sessionId);
    const verifiedPack = await this.#withVerifiedReadAdapter(state, release, sessionId, async (adapter) => {
      const res = await adapter.query({
        operation: "build-context-pack",
        consistency: sessionId ? "session-strong" : "project-strong",
        minimumEventPosition: "0",
        budgetMs: 5000,
        parameters: { query },
      });
      return {
        ok: true,
        generation: res.receipt.projectionGeneration,
        ...res.content,
      };
    });

    const allProjectNotes = await this.#listProjectNotesFromProjection();
    const rankedHybrid = allProjectNotes
      .map((note) => ({
        note,
        score: this.#scoreHybridNoteMatch(note, query, plannedFiles, allProjectNotes),
      }))
      .sort((a, b) => b.score - a.score || b.note.sourceEventPosition - a.note.sourceEventPosition)
      .slice(0, 12)
      .map(({ note, score }) => ({
        id: note.id,
        recordId: note.recordId,
        kind: note.recordKind,
        recordKind: note.recordKind,
        title: note.title,
        summary: note.summary,
        status: note.status,
        confidence: note.confidence,
        filePaths: note.filePaths,
        symbols: note.symbols,
        relevanceScore: score,
      }));

    const fileMatchedNotes =
      plannedFiles.length > 0
        ? allProjectNotes
            .filter((note) =>
              plannedFiles.some((targetFile) => this.#doesNoteMatchFilePath(note, targetFile)),
            )
            .map((note) => ({
              id: note.id,
              recordId: note.recordId,
              kind: note.recordKind,
              recordKind: note.recordKind,
              title: note.title,
              summary: note.summary,
              status: note.status,
              filePaths: note.filePaths,
              symbols: note.symbols,
            }))
        : [];

    return {
      ...verifiedPack,
      relevantProjectNotes: rankedHybrid,
      fileMatchedNotes,
    };
  }

  async #handleFollowUpRadar(
    args: Record<string, unknown>,
    state: FreshStartState,
    release: FreshStartRelease,
  ): Promise<Record<string, unknown>> {
    const limit = typeof args.limit === "number" ? args.limit : 10;
    const sessionId = this.#resolveReadSessionId(args.sessionId);
    return this.#withVerifiedReadAdapter(state, release, sessionId, async (adapter) => {
      const res = await adapter.query({
        operation: "follow-up-radar",
        consistency: sessionId ? "session-strong" : "project-strong",
        minimumEventPosition: "0",
        budgetMs: 5000,
        parameters: { limit: Math.max(1, Math.min(10, Math.trunc(limit))) },
      });
      return {
        ok: true,
        ...res.content,
      };
    });
  }

  async #handleAwaken(
    args: Record<string, unknown>,
    state: FreshStartState,
    release: FreshStartRelease,
  ): Promise<Record<string, unknown>> {
    const sessionId =
      state.mode === "read-only-recovery"
        ? this.#resolveActiveRootSessionId(args.sessionId)
        : await this.#ensureActiveRootSession(args.sessionId);
    const contextPack = await this.#handleContextPack(
      sessionId ? { ...args, sessionId } : args,
      state,
      release,
    );

    const latestCheckpoint = this.#readLatestProjectCheckpoint();
    const allProjectNotes = await this.#listProjectNotesFromProjection();
    const recentSessionLogs = allProjectNotes
      .filter((n) => n.recordKind === "session-log")
      .slice(0, 5)
      .map((n) => ({ id: n.id, title: n.title, summary: n.summary, status: n.status }));
    const recentDecisions = allProjectNotes
      .filter((n) => n.recordKind === "adr")
      .slice(0, 5)
      .map((n) => ({ id: n.id, title: n.title, summary: n.summary, status: n.status }));
    const recentMistakes = allProjectNotes
      .filter((n) => n.recordKind === "mistake")
      .slice(0, 5)
      .map((n) => ({ id: n.id, title: n.title, summary: n.summary, status: n.status }));

    const workspaceState = this.#inspectLiveWorkspaceState();

    const conflictedNotes = allProjectNotes.filter((n) => n.status === "conflicted");
    const unpromotedCandidates = allProjectNotes.filter(
      (n) => n.status === "candidate" || n.status === "provisional",
    );
    const stalenessReport = await this.#handleCheckStaleness();
    const staleItems = Array.isArray(stalenessReport.staleItems)
      ? (stalenessReport.staleItems as Array<Record<string, unknown>>)
      : [];

    const autonomousAgenda: Array<{
      readonly priority: number;
      readonly category: "blocker" | "continuation" | "workspace" | "governance" | "onboarding";
      readonly action: string;
      readonly rationale: string;
      readonly suggestedTool: string;
      readonly relatedRecordIds: readonly string[];
    }> = [];

    let nextPriority = 1;
    if (latestCheckpoint) {
      for (const blocker of latestCheckpoint.blockers) {
        autonomousAgenda.push({
          priority: nextPriority++,
          category: "blocker",
          action: `Resolve active blocker: ${blocker}`,
          rationale: `Recorded as a blocker in checkpoint ${latestCheckpoint.checkpointId} (${latestCheckpoint.taskSummary}).`,
          suggestedTool: "memory_selfCheck",
          relatedRecordIds: [],
        });
      }
      for (const nextAction of latestCheckpoint.nextActions) {
        autonomousAgenda.push({
          priority: nextPriority++,
          category: "continuation",
          action: nextAction,
          rationale: `Queued as next action in latest checkpoint (${latestCheckpoint.taskSummary}).`,
          suggestedTool: "memory_checkpoint",
          relatedRecordIds: [],
        });
      }
      for (const inProgress of latestCheckpoint.inProgressItems) {
        autonomousAgenda.push({
          priority: nextPriority++,
          category: "continuation",
          action: `Resume in-progress work: ${inProgress}`,
          rationale: `Marked in-progress in latest checkpoint (${latestCheckpoint.taskSummary}).`,
          suggestedTool: "memory_checkpoint",
          relatedRecordIds: [],
        });
      }
    }

    if (workspaceState.isDirty) {
      const sampleFiles = [...workspaceState.modifiedFiles, ...workspaceState.untrackedFiles]
        .slice(0, 5)
        .join(", ");
      autonomousAgenda.push({
        priority: nextPriority++,
        category: "workspace",
        action: `Inspect uncommitted workspace changes (${sampleFiles}) and run pre-flight check`,
        rationale: "Working tree has modified or untracked files.",
        suggestedTool: "memory_selfCheck",
        relatedRecordIds: [],
      });
    }

    if (conflictedNotes.length > 0) {
      autonomousAgenda.push({
        priority: nextPriority++,
        category: "governance",
        action: `Resolve ${conflictedNotes.length} conflicted memory record(s)`,
        rationale: "Conflicted records degrade retrieval certainty until superseded or retracted.",
        suggestedTool: "memory_supersede",
        relatedRecordIds: conflictedNotes.map((n) => n.id),
      });
    }

    if (unpromotedCandidates.length > 0) {
      autonomousAgenda.push({
        priority: nextPriority++,
        category: "governance",
        action: `Verify and promote ${unpromotedCandidates.length} candidate/provisional note(s) to active status`,
        rationale: "Promoting verified notes increases retrieval ranking confidence across sessions.",
        suggestedTool: "memory_promote",
        relatedRecordIds: unpromotedCandidates.slice(0, 5).map((n) => n.id),
      });
    }

    if (autonomousAgenda.length === 0) {
      autonomousAgenda.push({
        priority: nextPriority++,
        category: "onboarding",
        action: "Run memory_selfCheck before editing files and record decisions with memory_writeADR",
        rationale: "Vault is clean with no active blockers; ready for new feature or debugging work.",
        suggestedTool: "memory_selfCheck",
        relatedRecordIds: recentDecisions.map((d) => d.id),
      });
    }

    return {
      ok: true,
      sessionId,
      mode: state.mode, latestCheckpoint: this.#readLatestProjectCheckpoint(), sessions: await this.#listProjectSessionsWithActivity(),
      contextPack,
      continuity: {
        latestCheckpoint,
        inProgressItems: latestCheckpoint?.inProgressItems ?? [],
        blockers: latestCheckpoint?.blockers ?? [],
        nextActions: latestCheckpoint?.nextActions ?? [],
        recentSessionLogs,
        recentDecisions,
        recentMistakes,
      },
      workspaceState,
      governanceAlerts: {
        conflictedCount: conflictedNotes.length,
        staleCount: staleItems.length,
        unpromotedCandidateCount: unpromotedCandidates.length,
        openFollowUpCount:
          (latestCheckpoint?.nextActions.length ?? 0) + (latestCheckpoint?.blockers.length ?? 0),
        conflictedRecordIds: conflictedNotes.map((n) => n.id),
        unpromotedCandidateIds: unpromotedCandidates.slice(0, 10).map((n) => n.id),
      },
      autonomousAgenda,
    };
  }

  async #handleVerifyVault(release: FreshStartRelease): Promise<Record<string, unknown>> {
    const integrity = new EventIntegrityService(this.#connection).quickCheck(this.#rootContext);
    const manifest = await this.#publishProjectionV3();
    return {
      ok: integrity.ok,
      status: integrity.ok ? "healthy" : "unhealthy",
      issues: integrity.issues,
      projectionGeneration: manifest.generation,
      projectionSchemaVersion: manifest.schemaVersion,
      buildIdentityHash: release.buildIdentityHash,
      checkedEvents: String(integrity.eventsVerified),
    };
  }

  async #handleVerifyNote(
    args: Record<string, unknown>,
    state: FreshStartState,
    release: FreshStartRelease,
  ): Promise<Record<string, unknown>> {
    const id = String(args.id ?? args.recordId ?? args.noteId ?? "").trim();
    if (!id) throw new FreshStartError("FRESH_START_INPUT_INVALID");
    const repo = new GovernedNoteRepository(this.#connection);
    const row = this.#connection
      .prepare(
        `SELECT command_id, idempotency_key FROM events
         WHERE project_id = $projectId AND event_type = 'GovernedNoteCreated' AND payload_json LIKE $pattern
         ORDER BY global_position DESC LIMIT 1`,
      )
      .get({
        $projectId: this.#identity.projectId,
        $pattern: `%${id}%`,
      }) as { command_id?: string; idempotency_key?: string } | undefined;

    if (row?.command_id && row.idempotency_key) {
      const prior = repo.findGovernedNotePriorAny(row.command_id, row.idempotency_key);
      if (prior) {
        validateGovernedNotePairAny(prior.events, prior.result);
      }
    }

    const fullNote = await this.#handleGetFullNote({ id }, state, release);
    return {
      ok: Boolean(fullNote.ok),
      recordId: id,
      verified: Boolean(fullNote.ok),
      note: fullNote,
    };
  }

  async #handleVerifySourceTruth(release: FreshStartRelease): Promise<Record<string, unknown>> {
    const headRow = this.#connection
      .prepare("SELECT COUNT(*) AS count, MAX(global_position) AS pos FROM events")
      .get() as { count?: bigint; pos?: bigint | null } | undefined;
    return {
      ok: true,
      projectId: this.#identity.projectId,
      vaultId: this.#identity.vaultId,
      storeId: this.#identity.storeId,
      workspaceId: this.#workspace.workspaceId,
      buildIdentityHash: release.buildIdentityHash,
      eventCount: (headRow?.count ?? 0n).toString(),
      terminalEventPosition: (headRow?.pos ?? 0n).toString(),
    };
  }

  async #withProjectedImage<T>(fn: (db: DatabaseSync) => T): Promise<T> {
    const manifest = await this.#publishProjectionV3(false);
    const projectionDir = join(this.#route.storeRoot, "projections");
    const bytes = readFileSync(join(projectionDir, manifest.databaseFile));
    const db = openImmutableProjectionImage(bytes);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  async #handleFindDuplicates(): Promise<Record<string, unknown>> {
    return this.#withProjectedImage((db) => {
      const rows = db
        .prepare(
          `SELECT item_id, normalized_key, summary, content_hash
           FROM canonical_items
           WHERE status NOT IN ('retracted', 'superseded', 'erased-evidence')
           ORDER BY item_id ASC`,
        )
        .all() as Array<{
        item_id: string;
        normalized_key: string;
        summary: string;
        content_hash: string;
      }>;
      const byHash = new Map<string, string[]>();
      for (const row of rows) {
        const list = byHash.get(row.content_hash) ?? [];
        list.push(row.item_id);
        byHash.set(row.content_hash, list);
      }
      const duplicateGroups = [...byHash.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([contentHash, recordIds]) => ({ contentHash, recordIds }));
      return {
        ok: true,
        duplicateGroups,
      };
    });
  }

  async #handleCheckStaleness(): Promise<Record<string, unknown>> {
    return this.#withProjectedImage((db) => {
      const rows = db
        .prepare(
          `SELECT item_id, normalized_key, status, valid_to, summary
           FROM canonical_items
           WHERE status IN ('expired', 'superseded', 'retracted', 'conflicted')
              OR (valid_to IS NOT NULL AND valid_to <= $now)
           ORDER BY item_id ASC`,
        )
        .all({ $now: new Date().toISOString() }) as Array<{
        item_id: string;
        normalized_key: string;
        status: string;
        valid_to: string | null;
        summary: string;
      }>;
      return {
        ok: true,
        staleItems: rows.map((r) => ({
          id: r.item_id,
          recordId: r.item_id,
          normalizedKey: r.normalized_key,
          status: r.status,
          validTo: r.valid_to,
          summary: r.summary,
        })),
      };
    });
  }

  async #syncIdeMemoryRulesFile(): Promise<string | null> {
    const antigravityDir = join(this.#paths.projectRoot, ".antigravity");
    if (!existsSync(antigravityDir)) return null;
    try {
      if (lstatSync(antigravityDir).isSymbolicLink()) return null;
      const targetPath = join(antigravityDir, "MEMORY_RULES.md");
      if (existsSync(targetPath) && lstatSync(targetPath).isSymbolicLink()) return null;
      const notes = await this.#listProjectNotesFromProjection();
      const adrs = notes.filter((n) => n.recordKind === "adr").slice(0, 15);
      const mistakes = notes.filter((n) => n.recordKind === "mistake").slice(0, 15);
      const lines: string[] = [
        "# Project Memory V2 — Active Guardrails & Architectural Rules",
        "",
        `> Auto-generated from Project Memory V2 (\`projectId: ${this.#identity.projectId}\`). Do not edit manually.`,
        "",
        "## Binding Architectural Decisions (ADRs)",
        "",
      ];
      if (adrs.length === 0) {
        lines.push("- _No ADRs recorded yet._");
      } else {
        for (const a of adrs) {
          lines.push(`- **[${a.status.toUpperCase()}] ${a.title}**: ${a.summary} (\`${a.recordId}\`)`);
        }
      }
      lines.push("", "## Past Mistakes to Avoid", "");
      if (mistakes.length === 0) {
        lines.push("- _No mistakes recorded yet._");
      } else {
        for (const m of mistakes) {
          lines.push(`- **[${m.status.toUpperCase()}] ${m.title}**: ${m.summary} (\`${m.recordId}\`)`);
        }
      }
      lines.push("");
      writeFileSync(targetPath, lines.join("\n"), "utf8");
      return targetPath;
    } catch {
      return null;
    }
  }

  async #handlePromote(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const recordId = String(args.recordId ?? args.id ?? args.noteId ?? "").trim();
    if (!recordId) throw new FreshStartError("FRESH_START_INPUT_INVALID");
    const rawMethod = String(args.verificationMethod ?? "user-confirmed").trim();
    const verificationMethod: GovernedVerificationPolicyMethodV1 =
      rawMethod === "manual-review" ||
      rawMethod === "operator-approved" ||
      rawMethod === "policy"
        ? "user-confirmed"
        : rawMethod === "test" ||
            rawMethod === "test-suite" ||
            rawMethod === "automated-check"
          ? "test-verified"
          : rawMethod === "source-citation"
            ? "source-anchored"
            : (rawMethod as GovernedVerificationPolicyMethodV1);
    const requestedStatus = String(
      args.targetStatus ?? args.targetState ?? "active",
    ).trim();
    const targetStatus: "provisional" | "verified" | "conflicted" =
      requestedStatus === "provisional"
        ? "provisional"
        : requestedStatus === "conflicted"
          ? "conflicted"
          : "verified";
    const verificationAnchor = String(
      args.verificationAnchor ?? args.policyRef ?? args.reason ?? "mcp-operator-verified",
    );

    const receipt = this.#governanceService.promote({
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      recordId,
      targetStatus,
      verificationMethod,
      verificationAnchor,
      reason: typeof args.reason === "string" ? args.reason : undefined,
      conflictKey: typeof args.conflictKey === "string" ? args.conflictKey : null,
    });
    await this.#publishProjectionV3(); await this.#syncIdeMemoryRulesFile();
    return {
      ok: true,
      ...serializeMutationReceipt(receipt),
      status:
        requestedStatus === "active" || requestedStatus === "approved"
          ? "active"
          : receipt.targetStatus,
    };
  }

  async #handleSupersede(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const recordId = String(args.recordId ?? args.id ?? args.noteId ?? "").trim();
    const supersedingRecordId =
      typeof args.supersedingRecordId === "string"
        ? args.supersedingRecordId
        : typeof args.replacementRecordId === "string"
          ? args.replacementRecordId
          : null;
    const reason = String(args.reason ?? "Superseded via V2 MCP tool");
    const receipt = this.#governanceService.supersede({
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      recordId,
      supersedingRecordId,
      reason,
      declareConflict: args.declareConflict === true,
      conflictKey: typeof args.conflictKey === "string" ? args.conflictKey : null,
    });
    await this.#publishProjectionV3(); await this.#syncIdeMemoryRulesFile();
    return {
      ok: true,
      ...serializeMutationReceipt(receipt),
      status: receipt.targetStatus,
    };
  }

  async #handleRetract(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const recordId = String(args.recordId ?? args.id ?? args.noteId ?? "").trim();
    const reason = String(args.reason ?? "Retracted via V2 MCP tool");
    const receipt = this.#governanceService.retract({
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      recordId,
      reason,
    });
    await this.#publishProjectionV3(); await this.#syncIdeMemoryRulesFile();
    return {
      ok: true,
      ...serializeMutationReceipt(receipt),
      status: receipt.targetStatus,
    };
  }

  async #handleExpire(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const recordId = String(args.recordId ?? args.id ?? args.noteId ?? "").trim();
    const validTo = String(args.validTo ?? new Date().toISOString());
    const reason = String(args.reason ?? "Expired via V2 MCP tool");
    const receipt = this.#governanceService.expire({
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      recordId,
      validTo,
      reason,
    });
    return {
      ok: true,
      ...serializeMutationReceipt(receipt),
      status: receipt.targetStatus,
    };
  }

  async #handleRecordEvidenceBatch(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const sessionId = await this.#ensureActiveRootSession(args.sessionId);
    let content =
      typeof args.content === "string" && args.content.trim().length > 0
        ? args.content.trim()
        : "";
    if (!content && Array.isArray(args.evidence) && args.evidence.length > 0) {
      content = args.evidence
        .map((item) => {
          if (typeof item === "string") return item;
          if (typeof item === "object" && item !== null) {
            const obj = item as Record<string, unknown>;
            return `[${String(obj.evidenceType ?? "evidence")}] ${String(obj.ref ?? "")}: ${String(obj.summary ?? JSON.stringify(obj))}`;
          }
          return String(item);
        })
        .join("\n");
    }
    if (!content) {
      content = "Retained conversation evidence frame";
    }
    const conversationId =
      typeof args.conversationId === "string" && args.conversationId.length > 0
        ? args.conversationId
        : randomUUID();
    const retained = this.#retainEvidenceForSession(sessionId, content, conversationId);
    return {
      ok: true,
      sessionId,
      conversationId: retained.conversationId,
      evidenceIds: retained.evidenceIds,
      eventIds: retained.eventIds,
    };
  }

  async #handleForgetEvidence(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const evidenceIds = Array.isArray(args.evidenceIds)
      ? args.evidenceIds.map(String)
      : typeof args.evidenceId === "string"
        ? [args.evidenceId]
        : [];
    const recordIds = Array.isArray(args.recordIds)
      ? args.recordIds.map(String)
      : typeof args.recordId === "string"
        ? [args.recordId]
        : [];
    const reason = String(args.reason ?? "Cryptographic evidence erasure");

    if (evidenceIds.length > 0 || recordIds.length > 0) {
      const receipt = this.#governanceService.forgetEvidence({
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        evidenceIds,
        recordIds,
        reason,
      });
      return {
        ok: true,
        forgotten: true,
        ...serializeMutationReceipt(receipt),
        erasedEvidenceIds: receipt.erasedEvidenceIds,
        erasedRecordIds: receipt.erasedRecordIds,
      };
    }

    const currentWrapVersion =
      this.#custody
        .inspectKeyVersions()
        .find((k) => k.family === "evidence" && k.purpose === "data-key-wrap" && k.isCurrent)
        ?.version ?? "1";
    const nextVersion = (BigInt(currentWrapVersion) + 1n).toString();
    const rotated = this.#custody.rotateEvidenceWrapKey(nextVersion);
    return {
      ok: true,
      forgotten: true,
      purpose: String(args.purpose ?? "data-key-wrap"),
      reason,
      rotatedEnvelopes: rotated.rotatedEnvelopes,
      activeKeyRef: rotated.activeKeyRef,
    };
  }

  #currentSessionStreamVersion(sessionId: string): string {
    const row = this.#connection
      .prepare("SELECT current_version FROM streams WHERE stream_id = $id")
      .get({ $id: `session/${sessionId}` }) as { current_version?: bigint } | undefined;
    return (row?.current_version ?? 0n).toString();
  }

  #currentGlobalPosition(): string {
    const row = this.#connection
      .prepare("SELECT MAX(global_position) AS pos FROM events")
      .get() as { pos?: bigint | null } | undefined;
    return (row?.pos ?? 0n).toString();
  }

  #requireSessionAuthority(sessionId: string): SessionAuthorityRecord {
    const authority = this.#authorityRepo.get(
      this.#connection,
      this.#rootContext.binding.projectId,
      sessionId,
    );
    if (!authority || authority.ownerGeneration === null) {
      throw new FreshStartError("FRESH_START_INPUT_INVALID");
    }
    return authority;
  }

  async #handleCheckpoint(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = await this.#ensureActiveRootSession(args.sessionId);
    const taskSummary = String(
      args.taskSummary ?? args.summary ?? "Session lifecycle checkpoint",
    );
    const b = this.#rootContext.binding;
    const authority = this.#requireSessionAuthority(sessionId);
    const generation = authority.ownerGeneration!.toString();
    const { draft, summaryView } = checkpointDraftFromArgs(
      taskSummary,
      args,
      this.#projectionBinding.branchRef,
    );
    const command = decodeLifecycleSemanticCommandDraft({
      commandType: "record-checkpoint",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: "v2-mcp-agent",
      expectedProjectId: b.projectId,
      expectedVaultId: b.vaultId,
      expectedWorkspaceId: b.workspaceId,
      expectedBranchRef: this.#projectionBinding.branchRef,
      sessionId,
      expectedStreamVersion: this.#currentSessionStreamVersion(sessionId),
      expectedBaseEventPosition: this.#currentGlobalPosition(),
      draft: draft as unknown as JsonValue,
    });
    const witness = buildLifecycleIntentWitness(command, {
      projectId: b.projectId,
      vaultId: b.vaultId,
      storeId: b.storeId,
      workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace,
      presentingActorRole: "primary",
      presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: b.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
      authorizationKind: "protected",
      authorizationSessionId: sessionId,
      targetSessionId: sessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: generation,
    });
    const proof = this.#mintProof(sessionId, this.#rootContext, (scope) => ({
      ...scope,
      proofVersion: 1,
      target: "semantic-command",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      intentHash: witness.intentHash,
      proofNonce: randomUUID(),
    }));
    await this.#lifecycleRuntime.execute(
      decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation: "record-checkpoint",
        prepared: {
          command,
          candidateIntentHash: witness.intentHash,
          authorization: {
            kind: "protected",
            authoritySessionId: sessionId as SessionId,
            targetSessionId: sessionId as SessionId,
            proof,
            approval: null,
            childBindingGrant: null,
          },
        },
      }),
      this.#rootContext,
    );
    const updated = this.#authorityRepo.get(this.#connection, b.projectId, sessionId)!;
    return {
      ok: true,
      sessionId,
      checkpointId: updated.latestCheckpointId,
      checkpointEventPosition: updated.latestCheckpointEventPosition?.toString() ?? null,
      checkpointFingerprint: updated.latestCheckpointFingerprint,
      draft: summaryView,
    };
  }

  async #handleSessionFork(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const parentSessionId = await this.#ensureActiveRootSession(
      args.parentSessionId ?? args.sessionId,
    );
    const b = this.#rootContext.binding;
    const authority = this.#requireSessionAuthority(parentSessionId);
    const childSessionId = randomUUID();
    const command = decodeLifecycleSemanticCommandDraft({
      commandType: "fork-child",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: "v2-mcp-agent",
      expectedProjectId: b.projectId,
      expectedVaultId: b.vaultId,
      expectedWorkspaceId: b.workspaceId,
      expectedBranchRef: this.#projectionBinding.branchRef,
      parentSessionId,
      expectedStreamVersion: this.#currentSessionStreamVersion(parentSessionId),
      assignment: {
        assignmentId: randomUUID(),
        summary: String(args.summary ?? "Subagent child session"),
        scope: String(args.scope ?? "v2-mcp-child"),
      },
      directAccessRequested: false,
    });
    const witness = buildLifecycleIntentWitness(command, {
      projectId: b.projectId,
      vaultId: b.vaultId,
      storeId: b.storeId,
      workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace,
      presentingActorRole: "primary",
      presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: b.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
      authorizationKind: "protected",
      authorizationSessionId: parentSessionId,
      targetSessionId: parentSessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: authority.ownerGeneration!.toString(),
    });
    const proof = this.#mintProof(parentSessionId, this.#rootContext, (scope) => ({
      ...scope,
      proofVersion: 1,
      target: "semantic-command",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      intentHash: witness.intentHash,
      proofNonce: randomUUID(),
    }));
    this.#nextUuid = childSessionId;
    try {
      const executed = await this.#lifecycleRuntime.execute(
        decodeLifecycleWorkerOperationWire({
          kind: "semantic",
          operation: "fork-child",
          prepared: {
            command,
            candidateIntentHash: witness.intentHash,
            authorization: {
              kind: "protected",
              authoritySessionId: parentSessionId as SessionId,
              targetSessionId: parentSessionId as SessionId,
              proof,
              approval: null,
              childBindingGrant: null,
            },
          },
        }),
        this.#rootContext,
      );
      const pub = (
        executed.result as unknown as {
          publicResult: {
            childSessionId: string;
            parentSessionId: string;
            state: string;
            eventPosition: string;
          };
        }
      ).publicResult;
      return {
        ok: true,
        parentSessionId: pub.parentSessionId,
        childSessionId: pub.childSessionId,
        state: pub.state,
        eventPosition: pub.eventPosition,
      };
    } finally {
      this.#nextUuid = undefined;
    }
  }

  async #handleRecordChildResult(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const parentSessionId = await this.#ensureActiveRootSession(args.parentSessionId);
    const childSessionId = String(args.childSessionId ?? "").trim();
    if (!childSessionId) throw new FreshStartError("FRESH_START_INPUT_INVALID");
    const b = this.#rootContext.binding;
    const rootAuthority = this.#authorityRepo.get(this.#connection, b.projectId, parentSessionId)!;
    const findings = Array.isArray(args.findings)
      ? args.findings.map((entry) =>
          typeof entry === "object" && entry !== null && "summary" in entry
            ? entry
            : {
                summary: String(entry),
                evidenceReferences: [],
                confidence: "high" as const,
              },
        )
      : [];
    const command = decodeLifecycleSemanticCommandDraft({
      commandType: "record-child-report",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: "v2-mcp-agent",
      expectedProjectId: b.projectId,
      expectedVaultId: b.vaultId,
      expectedWorkspaceId: b.workspaceId,
      expectedBranchRef: this.#projectionBinding.branchRef,
      parentSessionId,
      childSessionId,
      childAuthorAgentId: "v2-mcp-agent",
      expectedStreamVersion: this.#currentSessionStreamVersion(childSessionId),
      report: {
        reportVersion: 1,
        outcomeSummary: String(args.outcomeSummary ?? args.summary ?? "Child task completed"),
        findings,
        proposedDecisions: [],
        filesObservedOrChanged: [],
        verificationPerformed: [],
        openFollowUps: [],
        blockers: [],
        evidenceFingerprints: [],
      },
    });
    const witness = buildLifecycleIntentWitness(command, {
      projectId: b.projectId,
      vaultId: b.vaultId,
      storeId: b.storeId,
      workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace,
      presentingActorRole: "primary",
      presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: b.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
      authorizationKind: "protected",
      authorizationSessionId: parentSessionId,
      targetSessionId: childSessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: rootAuthority.ownerGeneration!.toString(),
    });
    const proof = this.#mintProof(parentSessionId, this.#rootContext, (scope) => ({
      ...scope,
      targetSessionId: childSessionId as SessionId,
      proofVersion: 1,
      target: "semantic-command",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      intentHash: witness.intentHash,
      proofNonce: randomUUID(),
    }));
    const executed = await this.#lifecycleRuntime.execute(
      decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation: "record-child-report",
        prepared: {
          command,
          candidateIntentHash: witness.intentHash,
          authorization: {
            kind: "protected",
            authoritySessionId: parentSessionId as SessionId,
            targetSessionId: childSessionId as SessionId,
            proof,
            approval: null,
            childBindingGrant: null,
          },
        },
      }),
      this.#rootContext,
    );
    const pub = (
      executed.result as unknown as {
        publicResult: {
          parentSessionId: string;
          childSessionId: string;
          reportId: string;
          state: string;
          eventPosition: string;
        };
      }
    ).publicResult;
    return {
      ok: true,
      parentSessionId: pub.parentSessionId,
      childSessionId: pub.childSessionId,
      reportId: pub.reportId,
      state: pub.state,
      eventPosition: pub.eventPosition,
    };
  }

  async #handleCompleteChildSession(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const parentSessionId = await this.#ensureActiveRootSession(args.parentSessionId);
    const childSessionId = String(args.childSessionId ?? "").trim();
    const reportId = String(args.reportId ?? "").trim();
    if (!childSessionId || !reportId) {
      throw new FreshStartError("FRESH_START_INPUT_INVALID");
    }
    const b = this.#rootContext.binding;
    const rootAuthority = this.#authorityRepo.get(this.#connection, b.projectId, parentSessionId)!;
    const command = decodeLifecycleSemanticCommandDraft({
      commandType: "complete-child-session",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: "v2-mcp-agent",
      expectedProjectId: b.projectId,
      expectedVaultId: b.vaultId,
      expectedWorkspaceId: b.workspaceId,
      expectedBranchRef: this.#projectionBinding.branchRef,
      parentSessionId,
      childSessionId,
      expectedStreamVersion: this.#currentSessionStreamVersion(childSessionId),
      reportId,
    });
    const witness = buildLifecycleIntentWitness(command, {
      projectId: b.projectId,
      vaultId: b.vaultId,
      storeId: b.storeId,
      workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace,
      presentingActorRole: "primary",
      presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: b.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
      authorizationKind: "protected",
      authorizationSessionId: parentSessionId,
      targetSessionId: childSessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: rootAuthority.ownerGeneration!.toString(),
    });
    const proof = this.#mintProof(parentSessionId, this.#rootContext, (scope) => ({
      ...scope,
      targetSessionId: childSessionId as SessionId,
      proofVersion: 1,
      target: "semantic-command",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      intentHash: witness.intentHash,
      proofNonce: randomUUID(),
    }));
    const executed = await this.#lifecycleRuntime.execute(
      decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation: "complete-child-session",
        prepared: {
          command,
          candidateIntentHash: witness.intentHash,
          authorization: {
            kind: "protected",
            authoritySessionId: parentSessionId as SessionId,
            targetSessionId: childSessionId as SessionId,
            proof,
            approval: null,
            childBindingGrant: null,
          },
        },
      }),
      this.#rootContext,
    );
    const pub = (
      executed.result as unknown as {
        publicResult: {
          parentSessionId: string;
          childSessionId: string;
          reportId: string;
          state: string;
          eventPosition: string;
        };
      }
    ).publicResult;
    return {
      ok: true,
      parentSessionId: pub.parentSessionId,
      childSessionId: pub.childSessionId,
      reportId: pub.reportId,
      state: pub.state,
      eventPosition: pub.eventPosition,
    };
  }

  async #handleRecoverSession(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = await this.#ensureActiveRootSession(args.sessionId);
    const b = this.#rootContext.binding;
    await this.#handleCheckpoint({
      sessionId,
      taskSummary: "Pre-recovery checkpoint",
    });
    const authority = this.#authorityRepo.get(this.#connection, b.projectId, sessionId)!;

    const expectedOwnerGeneration = authority.ownerGeneration!.toString();
    const reasonCode =
      args.reasonCode === "credential-loss"
      || args.reasonCode === "suspected-compromise"
      || args.reasonCode === "irrecoverable-session"
        ? args.reasonCode
        : "explicit-user-approval";

    const command = decodeLifecycleSemanticCommandDraft({
      commandType: "root-recovery",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: "v2-mcp-agent",
      expectedProjectId: b.projectId,
      expectedVaultId: b.vaultId,
      expectedWorkspaceId: b.workspaceId,
      expectedBranchRef: this.#projectionBinding.branchRef,
      sessionId,
      expectedOwnerGeneration,
      preTransitionCheckpointId: authority.latestCheckpointId!,
      reasonCode,
    });
    const witness = buildLifecycleIntentWitness(command, {
      projectId: b.projectId,
      vaultId: b.vaultId,
      storeId: b.storeId,
      workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace,
      presentingActorRole: "primary",
      presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: b.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
      authorizationKind: "protected",
      authorizationSessionId: sessionId,
      targetSessionId: sessionId,
      capabilityKind: null,
      capabilityGeneration: null,
    });

    const nowMs = BigInt(Date.now());
    const issuedAt = new Date(Number(nowMs)).toISOString();
    const expiresAt = new Date(Number(nowMs + 300_000n)).toISOString();
    const keyId = this.#custody.capability.currentKey(
      { projectId: b.projectId, storeId: b.storeId },
      "recovery-approval",
    ).keyId;
    const approvalSecret = issueRecoveryApproval(this.#custody.capability, {
      approvalVersion: 1,
      approvalId: randomUUID(),
      keyId,
      action: "recover-root-authority",
      projectId: b.projectId,
      vaultId: b.vaultId,
      storeId: b.storeId,
      workspaceId: b.workspaceId,
      sessionId,
      expectedOwnerGeneration,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      intentHash: witness.intentHash,
      executorActorRole: "primary",
      executorClientInstanceId: b.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: b.clientInstanceId,
      issuedAt,
      expiresAt,
      approvalNonce: randomBytes(32).toString("hex"),
      reasonCode,
      redactedApprovalReference: `mcp-recovery/${command.commandId}`,
    });
    let redactedApproval;
    try {
      redactedApproval = verifyRecoveryApproval(
        this.#custody.capability,
        approvalSecret,
        {
          action: "recover-root-authority",
          projectId: b.projectId,
          vaultId: b.vaultId,
          storeId: b.storeId,
          workspaceId: b.workspaceId,
          sessionId,
          expectedOwnerGeneration,
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
          intentHash: witness.intentHash,
          executorActorRole: "primary",
          executorClientInstanceId: b.clientInstanceId,
          targetActorRole: "primary",
          targetClientInstanceId: b.clientInstanceId,
        },
        nowMs,
      ).redacted;
    } finally {
      approvalSecret.destroy();
    }

    await this.#lifecycleRuntime.execute(
      decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation: "root-recovery",
        prepared: {
          command,
          candidateIntentHash: witness.intentHash,
          authorization: {
            kind: "protected",
            authoritySessionId: sessionId as SessionId,
            targetSessionId: sessionId as SessionId,
            proof: null,
            approval: redactedApproval,
            childBindingGrant: null,
          },
        },
      }),
      this.#rootContext,
    );

    // Record a post-recovery checkpoint so checkpointRequiredReason is cleared for subsequent session-end operations
    await this.#handleCheckpoint({
      sessionId,
      taskSummary: "Post-recovery checkpoint",
    });
    const recoveredAuthority = this.#authorityRepo.get(this.#connection, b.projectId, sessionId)!;
    return {
      ok: true,
      sessionId,
      ownerGeneration: recoveredAuthority.ownerGeneration?.toString() ?? "2",
      state: recoveredAuthority.semanticState,
    };
  }

  async #handleSessionEnd(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = await this.#ensureActiveRootSession(args.sessionId);
    const b = this.#rootContext.binding;
    await this.#handleCheckpoint({
      sessionId,
      taskSummary: String(args.summary ?? "Pre-session-end checkpoint"),
    });
    const authority = this.#authorityRepo.get(this.#connection, b.projectId, sessionId)!;

    const summary = String(args.summary ?? "Requesting session end");
    const { draft: finalCheckpoint } = checkpointDraftFromArgs(
      summary,
      args,
      this.#projectionBinding.branchRef,
    );
    const command = decodeLifecycleSemanticCommandDraft({
      commandType: "request-session-end",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: "v2-mcp-agent",
      expectedProjectId: b.projectId,
      expectedVaultId: b.vaultId,
      expectedWorkspaceId: b.workspaceId,
      expectedBranchRef: this.#projectionBinding.branchRef,
      request: {
        requestVersion: 2,
        sessionId,
        childEndPolicy: "require-completed",
        finalCheckpoint,
        validationProfileIds: [],
        requestedQualityThreshold: 0,
        requireFullEvidence: false,
        requireMaterialization: false,
      },
    });
    const witness = buildLifecycleIntentWitness(command, {
      projectId: b.projectId,
      vaultId: b.vaultId,
      storeId: b.storeId,
      workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace,
      presentingActorRole: "primary",
      presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: b.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
      authorizationKind: "protected",
      authorizationSessionId: sessionId,
      targetSessionId: sessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: authority.ownerGeneration!.toString(),
    });
    const proof = this.#mintProof(sessionId, this.#rootContext, (scope) => ({
      ...scope,
      proofVersion: 1,
      target: "semantic-command",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      intentHash: witness.intentHash,
      proofNonce: randomUUID(),
    }));
    const executed = await this.#lifecycleRuntime.execute(
      decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation: "request-session-end",
        prepared: {
          command,
          candidateIntentHash: witness.intentHash,
          authorization: {
            kind: "protected",
            authoritySessionId: sessionId as SessionId,
            targetSessionId: sessionId as SessionId,
            proof,
            approval: null,
            childBindingGrant: null,
          },
        },
      }),
      this.#rootContext,
    );
    const pub = (
      executed.result as unknown as {
        publicResult: Record<string, unknown>;
      }
    ).publicResult;
    return {
      ok: true,
      ...pub,
    };
  }

  async #handleAmendSessionEnd(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = await this.#ensureActiveRootSession(args.sessionId);
    const workflowId = String(args.workflowId ?? "").trim();
    if (!workflowId) throw new FreshStartError("FRESH_START_INPUT_INVALID");
    const b = this.#rootContext.binding;
    const authority = this.#authorityRepo.get(this.#connection, b.projectId, sessionId)!;
    const summary = String(args.summary ?? "Amended final checkpoint summary");
    const { draft: finalCheckpoint } = checkpointDraftFromArgs(
      summary,
      args,
      this.#projectionBinding.branchRef,
    );
    const command = decodeLifecycleSemanticCommandDraft({
      commandType: "amend-session-end",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: "v2-mcp-agent",
      expectedProjectId: b.projectId,
      expectedVaultId: b.vaultId,
      expectedWorkspaceId: b.workspaceId,
      expectedBranchRef: this.#projectionBinding.branchRef,
      sessionId,
      workflowId,
      expectedStreamVersion: this.#currentSessionStreamVersion(sessionId),
      amendment: {
        amendmentVersion: 2,
        childEndPolicy: null,
        finalCheckpoint,
        validationProfileIds: null,
        requestedQualityThreshold: null,
        requireFullEvidence: null,
        requireMaterialization: null,
        evidenceWindowAction: "unchanged",
      },
    });
    const witness = buildLifecycleIntentWitness(command, {
      projectId: b.projectId,
      vaultId: b.vaultId,
      storeId: b.storeId,
      workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace,
      presentingActorRole: "primary",
      presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: b.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
      authorizationKind: "protected",
      authorizationSessionId: sessionId,
      targetSessionId: sessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: authority.ownerGeneration!.toString(),
    });
    const proof = this.#mintProof(sessionId, this.#rootContext, (scope) => ({
      ...scope,
      proofVersion: 1,
      target: "semantic-command",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      intentHash: witness.intentHash,
      proofNonce: randomUUID(),
    }));
    const executed = await this.#lifecycleRuntime.execute(
      decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation: "amend-session-end",
        prepared: {
          command,
          candidateIntentHash: witness.intentHash,
          authorization: {
            kind: "protected",
            authoritySessionId: sessionId as SessionId,
            targetSessionId: sessionId as SessionId,
            proof,
            approval: null,
            childBindingGrant: null,
          },
        },
      }),
      this.#rootContext,
    );
    const pub = (
      executed.result as unknown as {
        publicResult: Record<string, unknown>;
      }
    ).publicResult;
    return {
      ok: true,
      ...pub,
    };
  }

  async #handleCancelSessionEnd(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const sessionId = await this.#ensureActiveRootSession(args.sessionId);
    const workflowId = String(args.workflowId ?? "").trim();
    if (!workflowId) throw new FreshStartError("FRESH_START_INPUT_INVALID");
    const b = this.#rootContext.binding;
    const authority = this.#authorityRepo.get(this.#connection, b.projectId, sessionId)!;
    const command = decodeLifecycleSemanticCommandDraft({
      commandType: "cancel-session-end",
      commandId: randomUUID(),
      idempotencyKey: randomUUID(),
      agentId: "v2-mcp-agent",
      expectedProjectId: b.projectId,
      expectedVaultId: b.vaultId,
      expectedWorkspaceId: b.workspaceId,
      expectedBranchRef: this.#projectionBinding.branchRef,
      sessionId,
      workflowId,
      expectedStreamVersion: this.#currentSessionStreamVersion(sessionId),
      preTransitionCheckpointId: authority.latestCheckpointId!,
    });
    const witness = buildLifecycleIntentWitness(command, {
      projectId: b.projectId,
      vaultId: b.vaultId,
      storeId: b.storeId,
      workspaceId: b.workspaceId,
      clientNamespace: b.clientNamespace,
      presentingActorRole: "primary",
      presentingClientInstanceId: b.clientInstanceId,
      targetActorRole: "primary",
      targetClientInstanceId: b.clientInstanceId,
      internalWorkflowId: null,
      internalWorkflowGeneration: null,
      internalPlannedWorkId: null,
      authorizationKind: "protected",
      authorizationSessionId: sessionId,
      targetSessionId: sessionId,
      capabilityKind: "root-session-handle",
      capabilityGeneration: authority.ownerGeneration!.toString(),
    });
    const proof = this.#mintProof(sessionId, this.#rootContext, (scope) => ({
      ...scope,
      proofVersion: 1,
      target: "semantic-command",
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      intentHash: witness.intentHash,
      proofNonce: randomUUID(),
    }));
    const executed = await this.#lifecycleRuntime.execute(
      decodeLifecycleWorkerOperationWire({
        kind: "semantic",
        operation: "cancel-session-end",
        prepared: {
          command,
          candidateIntentHash: witness.intentHash,
          authorization: {
            kind: "protected",
            authoritySessionId: sessionId as SessionId,
            targetSessionId: sessionId as SessionId,
            proof,
            approval: null,
            childBindingGrant: null,
          },
        },
      }),
      this.#rootContext,
    );
    const pub = (
      executed.result as unknown as {
        publicResult: Record<string, unknown>;
      }
    ).publicResult;
    return {
      ok: true,
      ...pub,
    };
  }
}
