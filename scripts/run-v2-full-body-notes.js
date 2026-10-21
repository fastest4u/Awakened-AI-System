import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { runFixedStages } from './run-v2-internal-verified-read.js';
import { parseFinalSpecCounts } from './run-v2-retained-evidence.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const names = [
  'v2-full-body-note-contracts',
  'v2-full-body-note-privacy',
  'v2-full-body-note-command',
  'v2-full-body-note-projection',
  'v2-full-body-note-genesis',
  'v2-full-body-note-publication',
  'v2-full-body-note-summary-regression',
  'v2-full-body-note-runtime',
  'v2-full-note-contracts',
  'v2-full-note-query',
  'v2-full-note-result',
  'v2-full-note-protocol',
  'v2-full-note-child',
  'v2-full-note-supervisor',
  'v2-full-note-entry',
  'v2-full-body-notes-gate',
  'v2-governed-note-contracts',
  'v2-governed-note-codec',
  'v2-governed-note-recovery',
  'v2-governed-note-ownership',
  'v2-governed-note-candidate-read',
  'projection-source-event-codec',
  'projection-schema',
  'projection-coordinator',
  'projection-integrity',
  'fresh-start-repository',
  'fresh-start-admission',
  'v2-native-content-query',
  'v2-native-content-entry',
  'v2-native-workflow-cursor',
  'v2-native-workflow-query',
];
const privatePaths = [
  'tests/fixtures/project-store-governed-note-worker.js',
  'tests/fixtures/v2-verified-read-process-fixture.js',
  'tests/support/governed-note-local-providers.js',
  'tests/support/governed-note-fixture.js',
  'tests/support/v2-native-content-fixture.js',
  'src/orchestrator/governed-notes/runtime.factory.js',
  'src/orchestrator/governed-notes/service.js',
  'src/orchestrator/governed-notes/run.js',
  'src/orchestrator/governed-notes/fixture-allocation.js',
  'src/orchestrator/governed-notes/fixture-control.js',
  'src/orchestrator/governed-notes/worker-protocol.js',
  'src/orchestrator/governed-notes/body-content.js',
  'src/orchestrator/runtime/project-store-worker-runtime.js',
  'src/orchestrator/runtime/project-store-worker-backend.js',
  'src/orchestrator/runtime/project-store-executor.js',
  'src/orchestrator/runtime/worker-protocol.js',
  'src/orchestrator/privacy/retained-evidence-runtime.factory.js',
  'src/orchestrator/runtime/lifecycle-worker-runtime.factory.js',
  'src/orchestrator/projections/captured-image-v3.js',
  'src/orchestrator/verified-read/full-note-query.js',
  'src/orchestrator/verified-read/full-note-protocol.js',
  'src/orchestrator/verified-read/full-note-result.js',
  'src/orchestrator/verified-read/child.js',
  'src/orchestrator/verified-read/supervisor.js',
  'src/v2/internal-verified-read.entry.js',
];
const artifactNames = [
  'v2.js',
  'v2-admin.js',
  'workers/project-store.worker.js',
  'internal/v2-internal-verified-read.js',
  'internal/v2-internal-verified-read-cleanup.js',
];
const EVIDENCE_STAGE = 'v2-full-note-entry';
const EVIDENCE_MARKER = 'V2_FULL_NOTE_NATIVE_EVIDENCE_V1';
const EVIDENCE_RECORD_LIMIT = 16384;
const EVIDENCE_AGGREGATE_LIMIT = 131072;
const EVIDENCE_CASES = [
  'round-trip-session-log-root',
  'round-trip-insight-root',
  'round-trip-mistake-root',
  'round-trip-adr-root',
  'round-trip-insight-child',
  'escaped-65536-old-route',
  'same-position-upgrade',
  'v1-kind-absent',
  'generic-kind-absent',
  'v1-recovery-v2',
  'sibling-refused',
  'ended-refused',
  'revoked-refused',
  'ineligible-source-refused',
  'source-key-unavailable',
  'captured-image-stable',
  'whole-checksum-refused',
  'native-deadline',
  'native-cancel',
  'native-packing-fault',
  'late-success-uncertain-cleanup',
];
const RECORD_KEYS = [
  'version',
  'stage',
  'caseId',
  'outcome',
  'fixture',
  'write',
  'read',
  'upgrade',
  'identities',
  'configuration',
  'observations',
];
const BLOCK_KEYS = {
  fixture: ['runId', 'fixtureId', 'ownerGeneration', 'fixtureResetCount', 'retained'],
  write: [
    'commandId',
    'idempotencyKey',
    'operationId',
    'requestId',
    'recordId',
    'sourceEventIds',
    'receiptVersion',
    'scope',
    'terminalPosition',
    'recoveryDisposition',
  ],
  read: [
    'ids',
    'operation',
    'scope',
    'imageScope',
    'selectionSessionId',
    'requestedId',
    'recordKind',
    'bodyAvailability',
    'requiredPosition',
    'capturedPosition',
    'capturedHash',
    'projectionPosition',
    'projectionHash',
    'projectionGeneration',
    'projectionSchemaVersion',
    'imageSha256',
    'code',
    'cleanup',
    'ownerState',
  ],
  upgrade: ['before', 'after', 'tailBefore', 'tailAfter', 'eventAppendCountDelta'],
  identities: ['buildIdentityHash', 'writer', 'reader', 'cleanup'],
  configuration: ['capabilityKeys', 'evidenceKeys', 'policy', 'timing'],
  observations: [
    'ownerWorkerThreadId',
    'providerThreadId',
    'openWriterConnectionCount',
    'factoryConnectionIdentityCount',
    'factoryFenceIdentityCount',
    'factoryKeyProviderIdentityCount',
    'parentProviderRpcCalls',
    'createPosts',
    'recoveryPosts',
    'pairs',
    'pairHeaderFailures',
    'safeOutputLeaks',
    'metricLeaks',
    'logLeaks',
    'privacyLeaks',
    'statuses',
    'workerExits',
    'workerExitCode',
    'cleanupDisposition',
    'adapterReusableAfterDisposition',
    'imageClosed',
    'readerClosed',
    'lockClosed',
    'readClose',
    'cleanupClose',
    'detail',
  ],
};
const SCOPE_KEYS = ['projectId', 'vaultId', 'storeId', 'workspaceId', 'branchScopeId', 'branchRef', 'sessionId'];
const CAPABILITY_PURPOSES = [
  'root-session-handle',
  'root-resume-token',
  'child-session-handle',
  'child-binding-grant',
  'continuity-index',
  'evidence-fingerprint',
  'validation-output-fingerprint',
  'materialization-fingerprint',
  'recovery-approval',
  'abandonment-approval',
  'pending-authorization-encryption',
];
const EVIDENCE_PURPOSES = ['data-key-wrap', 'original-input-commitment', 'redacted-content-fingerprint'];
const DEFAULT_TIMING = {
  requestTimeoutMs: 15000,
  closeTimeoutMs: 5000,
  recoveryProofLifetimeMs: 60000,
  maxPending: 128,
  executorLeaseMs: 15000,
  heartbeatIntervalMs: 5000,
  appendRetryDeadlineMs: 15000,
  sqliteBusyTimeoutMs: 5000,
  privateReadBudgetMs: 5000,
};

const profile = 'full-body-notes';
const gate = 'v2-full-body-notes';
const failure = 'FULL_BODY_NOTES_GATE_FAILED';
const maximumMs = 2100000;
const cleanupMaximumMs = 5000;
const stageOutputLimit = 16 * 1024 * 1024;

export const FULL_BODY_NOTES_GATE_PROFILE = Object.freeze({
  profile,
  gate,
  failure,
  totalTimeoutMs: maximumMs,
  cleanupTimeoutMs: cleanupMaximumMs,
  stageOutputMaximumBytes: stageOutputLimit,
  evidenceRecordMaximumBytes: EVIDENCE_RECORD_LIMIT,
  evidenceAggregateMaximumBytes: EVIDENCE_AGGREGATE_LIMIT,
  testNames: Object.freeze([...names]),
  privatePaths: Object.freeze([...privatePaths]),
  evidenceCaseIds: Object.freeze([...EVIDENCE_CASES]),
});

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value =>
  Array.isArray(value)
    ? '[' + value.map(canonical).join(',') + ']'
    : value && typeof value === 'object'
      ? '{' +
        Object.keys(value)
          .sort()
          .map(key => JSON.stringify(key) + ':' + canonical(value[key]))
          .join(',') +
        '}'
      : JSON.stringify(value);
const equal = (a, b) => canonical(a) === canonical(b);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V1_5 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const MAX_INT64 = 9223372036854775807n;

function isExactKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}
function isDecimalPosition(value, allowZero = true) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return false;
  try {
    const n = BigInt(value);
    return (allowZero ? n >= 0n : n >= 1n) && n <= MAX_INT64;
  } catch {
    return false;
  }
}
function isBoundedText(value, maxBytes = 128) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maxBytes &&
    !/[\x00-\x1f\x7f\uFFFD]/.test(value)
  );
}
function isValidScope(scope, mode) {
  if (!isExactKeys(scope, SCOPE_KEYS)) return false;
  const idValidator = mode === 'read' ? v => UUID_V4.test(v) || HEX_64.test(v) : v => UUID_V1_5.test(v) || HEX_64.test(v);
  const sessionValidator = mode === 'read' ? v => UUID_V4.test(v) : v => UUID_V1_5.test(v);
  if (!idValidator(scope.projectId) || !idValidator(scope.vaultId) || !idValidator(scope.storeId)) return false;
  if (!HEX_64.test(scope.workspaceId)) return false;
  if (scope.branchScopeId !== null && !sessionValidator(scope.branchScopeId)) return false;
  if (scope.branchRef !== null && !isBoundedText(scope.branchRef, 1024)) return false;
  if (mode === 'image') return scope.sessionId === null;
  if (scope.sessionId !== null && !sessionValidator(scope.sessionId)) return false;
  return true;
}
function isValidCloseRecord(value) {
  if (value === null) return true;
  if (!isExactKeys(value, ['ordinal', 'code', 'signal', 'stdoutDrained', 'stderrDrained'])) return false;
  if (!Number.isSafeInteger(value.ordinal) || value.ordinal < 1) return false;
  if (value.code !== null && !Number.isSafeInteger(value.code)) return false;
  if (value.signal !== null && !isBoundedText(value.signal, 32)) return false;
  return value.stdoutDrained === true && value.stderrDrained === true;
}

function validateEvidenceRecord(record, context) {
  if (!isExactKeys(record, RECORD_KEYS)) return 'invalid-record';
  for (const [block, keys] of Object.entries(BLOCK_KEYS)) {
    if (record[block] !== null && !isExactKeys(record[block], keys)) return 'invalid-record';
  }
  const caseId = record.caseId;
  const isNativeUpgrade = caseId === 'same-position-upgrade' || caseId === 'generic-kind-absent';
  const isPreEffectRefusal =
    caseId === 'ineligible-source-refused' || caseId === 'source-key-unavailable' || caseId === 'revoked-refused';
  const isHelperFault =
    caseId === 'native-deadline' ||
    caseId === 'native-cancel' ||
    caseId === 'native-packing-fault' ||
    caseId === 'late-success-uncertain-cleanup';
  const isHelperSuccess = caseId === 'captured-image-stable';
  const isReadFail = isHelperFault || caseId === 'whole-checksum-refused';
  const isUncertainty = caseId === 'late-success-uncertain-cleanup';

  const expectedOutcome = isUncertainty
    ? 'expected-uncertainty'
    : isPreEffectRefusal ||
        caseId === 'sibling-refused' ||
        caseId === 'ended-refused' ||
        caseId === 'native-deadline' ||
        caseId === 'native-cancel' ||
        caseId === 'native-packing-fault' ||
        caseId === 'whole-checksum-refused'
      ? 'expected-refusal'
      : 'expected-success';
  if (record.outcome !== expectedOutcome) return 'invalid-record';

  // 1. fixture
  if (isNativeUpgrade) {
    if (record.fixture !== null) return 'invalid-record';
  } else {
    const f = record.fixture;
    if (!f || !UUID_V4.test(f.runId) || !UUID_V4.test(f.fixtureId)) return 'invalid-record';
    if (!isDecimalPosition(f.ownerGeneration, false) || f.fixtureResetCount !== 0) return 'invalid-record';
    if (f.retained !== isUncertainty) return 'invalid-record';
  }

  // 2. write
  if (isNativeUpgrade) {
    if (record.write !== null) return 'invalid-record';
  } else {
    const w = record.write;
    if (!w || !UUID_V4.test(w.commandId) || !UUID_V4.test(w.idempotencyKey)) return 'invalid-record';
    const hasRecovery = caseId === 'v1-recovery-v2' || caseId === 'ended-refused' || isUncertainty;
    if (hasRecovery) {
      if (!UUID_V4.test(w.operationId) || !UUID_V4.test(w.requestId)) return 'invalid-record';
      const expectedDisposition = caseId === 'ended-refused' ? 'refused' : 'committed';
      if (w.recoveryDisposition !== expectedDisposition) return 'invalid-record';
    } else if (w.operationId !== null || w.requestId !== null || w.recoveryDisposition !== null) {
      return 'invalid-record';
    }
    if (!isValidScope(w.scope, 'write') || w.scope.sessionId === null) return 'invalid-record';
    if (isPreEffectRefusal) {
      if (w.recordId !== null || w.sourceEventIds !== null || w.receiptVersion !== null || w.terminalPosition !== null) {
        return 'invalid-record';
      }
    } else {
      if (!UUID_V4.test(w.recordId)) return 'invalid-record';
      if (
        !Array.isArray(w.sourceEventIds) ||
        w.sourceEventIds.length !== 2 ||
        !UUID_V4.test(w.sourceEventIds[0]) ||
        !UUID_V4.test(w.sourceEventIds[1]) ||
        w.sourceEventIds[0] === w.sourceEventIds[1]
      ) {
        return 'invalid-record';
      }
      const expectedReceiptVersion = caseId === 'v1-kind-absent' || caseId === 'v1-recovery-v2' ? 1 : 2;
      if (w.receiptVersion !== expectedReceiptVersion || !isDecimalPosition(w.terminalPosition, false)) return 'invalid-record';
    }
  }

  // 3. read
  if (isPreEffectRefusal) {
    if (record.read !== null) return 'invalid-record';
  } else {
    const r = record.read;
    if (!r || !isExactKeys(r.ids, ['requestId', 'attemptId', 'laneEpoch'])) return 'invalid-record';
    if (!isBoundedText(r.ids.requestId) || !isBoundedText(r.ids.attemptId) || !isBoundedText(r.ids.laneEpoch)) {
      return 'invalid-record';
    }
    if (r.operation !== 'get-full-note' || !isValidScope(r.imageScope, 'image')) return 'invalid-record';
    if (!isBoundedText(r.requestedId)) return 'invalid-record';
    if (isReadFail) {
      if (
        r.scope !== null ||
        r.selectionSessionId !== null ||
        r.recordKind !== null ||
        r.bodyAvailability !== null ||
        r.requiredPosition !== null ||
        r.capturedPosition !== null ||
        r.capturedHash !== null ||
        r.projectionPosition !== null ||
        r.projectionHash !== null ||
        r.projectionGeneration !== null ||
        r.projectionSchemaVersion !== null ||
        r.imageSha256 !== null
      ) {
        return 'invalid-record';
      }
      const expectedCode =
        caseId === 'native-cancel'
          ? 'WORKER_CLOSED'
          : caseId === 'whole-checksum-refused'
            ? 'INTEGRITY_FAILURE'
            : 'WORKER_TIMEOUT';
      if (r.code !== expectedCode) return 'invalid-record';
      if (r.cleanup !== (isUncertainty ? 'incomplete' : 'complete')) return 'invalid-record';
      if (r.ownerState !== (isUncertainty ? 'quarantined' : 'closed')) return 'invalid-record';
    } else {
      if (!isValidScope(r.scope, 'read')) return 'invalid-record';
      if (!equal({ ...r.scope, sessionId: null }, r.imageScope)) return 'invalid-record';
      if (r.selectionSessionId !== r.scope.sessionId) return 'invalid-record';
      if (isNativeUpgrade) {
        if (r.scope.sessionId !== null || r.recordKind !== null || r.bodyAvailability !== 'absent') return 'invalid-record';
      } else if (caseId === 'sibling-refused') {
        if (
          r.scope.sessionId === null ||
          r.scope.sessionId === record.write.scope.sessionId ||
          r.recordKind !== null ||
          r.bodyAvailability !== null
        ) {
          return 'invalid-record';
        }
      } else if (caseId === 'v1-kind-absent' || caseId === 'v1-recovery-v2') {
        if (r.scope.sessionId !== record.write.scope.sessionId || r.recordKind !== 'insight' || r.bodyAvailability !== 'absent') {
          return 'invalid-record';
        }
      } else {
        if (
          r.scope.sessionId !== record.write.scope.sessionId ||
          !['session-log', 'insight', 'mistake', 'adr'].includes(r.recordKind) ||
          r.bodyAvailability !== 'present'
        ) {
          return 'invalid-record';
        }
      }
      if (
        !isDecimalPosition(r.requiredPosition, false) ||
        !isDecimalPosition(r.capturedPosition, false) ||
        !isDecimalPosition(r.projectionPosition, false) ||
        BigInt(r.projectionPosition) < BigInt(r.requiredPosition) ||
        r.capturedPosition !== r.projectionPosition
      ) {
        return 'invalid-record';
      }
      if (!HEX_64.test(r.capturedHash) || !HEX_64.test(r.projectionHash) || r.capturedHash !== r.projectionHash) {
        return 'invalid-record';
      }
      if (!Number.isSafeInteger(r.projectionGeneration) || r.projectionGeneration < 1 || r.projectionGeneration > 2147483647) {
        return 'invalid-record';
      }
      if (r.projectionSchemaVersion !== 3 || !HEX_64.test(r.imageSha256) || r.code !== null || r.cleanup !== 'complete') {
        return 'invalid-record';
      }
      if (r.ownerState !== (isHelperSuccess ? 'closed' : 'available')) return 'invalid-record';
    }
  }

  // 4. upgrade
  if (caseId === 'same-position-upgrade') {
    const u = record.upgrade;
    if (
      !u ||
      !isExactKeys(u.before, ['schemaVersion', 'generation', 'position', 'eventHash', 'imageSha256']) ||
      !isExactKeys(u.after, ['schemaVersion', 'generation', 'position', 'eventHash', 'imageSha256']) ||
      !isExactKeys(u.tailBefore, ['position', 'hash', 'count']) ||
      !isExactKeys(u.tailAfter, ['position', 'hash', 'count'])
    ) {
      return 'invalid-record';
    }
    if (
      u.before.schemaVersion !== 2 ||
      u.after.schemaVersion !== 3 ||
      !Number.isSafeInteger(u.before.generation) ||
      !Number.isSafeInteger(u.after.generation) ||
      u.after.generation <= u.before.generation ||
      !isDecimalPosition(u.before.position, false) ||
      u.before.position !== u.after.position ||
      !HEX_64.test(u.before.eventHash) ||
      u.before.eventHash !== u.after.eventHash ||
      !HEX_64.test(u.before.imageSha256) ||
      !HEX_64.test(u.after.imageSha256) ||
      u.before.imageSha256 === u.after.imageSha256 ||
      !equal(u.tailBefore, u.tailAfter) ||
      u.tailBefore.position !== u.before.position ||
      u.tailBefore.hash !== u.before.eventHash ||
      !isDecimalPosition(u.tailBefore.count, false) ||
      u.eventAppendCountDelta !== 0
    ) {
      return 'invalid-record';
    }
  } else if (record.upgrade !== null) {
    return 'invalid-record';
  }

  // 5. identities (and independent runner checkpoint cross-check)
  const id = record.identities;
  if (!id || !HEX_64.test(id.buildIdentityHash)) return 'invalid-record';
  const expectedBuildHash = context?.measurement?.buildIdentityHash;
  if (expectedBuildHash && id.buildIdentityHash !== expectedBuildHash) return 'stale-identity';

  const expectedWriterSha = context?.compiledMeasurement?.privateClosure?.find(
    entry => entry.path === 'dist-test/tests/fixtures/project-store-governed-note-worker.js',
  )?.sha256;
  const expectedHelperSha = context?.compiledMeasurement?.privateClosure?.find(
    entry => entry.path === 'dist-test/tests/fixtures/v2-verified-read-process-fixture.js',
  )?.sha256;
  const expectedEmittedReaderSha = context?.measurement?.artifacts?.find(
    entry => entry.path === 'internal/v2-internal-verified-read.js',
  )?.sha256;

  if (isNativeUpgrade) {
    if (id.writer !== null) return 'invalid-record';
  } else {
    if (
      !isExactKeys(id.writer, ['path', 'sha256']) ||
      id.writer.path !== 'dist-test/tests/fixtures/project-store-governed-note-worker.js' ||
      !HEX_64.test(id.writer.sha256)
    ) {
      return 'invalid-record';
    }
    if (expectedWriterSha && id.writer.sha256 !== expectedWriterSha) return 'stale-identity';
  }

  if (isPreEffectRefusal) {
    if (id.reader !== null || id.cleanup !== null) return 'invalid-record';
  } else if (isHelperFault || isHelperSuccess) {
    if (
      !isExactKeys(id.reader, ['path', 'sha256']) ||
      id.reader.path !== 'dist-test/tests/fixtures/v2-verified-read-process-fixture.js' ||
      !HEX_64.test(id.reader.sha256)
    ) {
      return 'invalid-record';
    }
    if (expectedHelperSha && id.reader.sha256 !== expectedHelperSha) return 'stale-identity';
    if (isHelperFault) {
      if (
        !isExactKeys(id.cleanup, ['path', 'sha256']) ||
        id.cleanup.path !== 'dist-test/tests/fixtures/v2-verified-read-process-fixture.js' ||
        !HEX_64.test(id.cleanup.sha256)
      ) {
        return 'invalid-record';
      }
      if (expectedHelperSha && id.cleanup.sha256 !== expectedHelperSha) return 'stale-identity';
    } else if (id.cleanup !== null) {
      return 'invalid-record';
    }
  } else {
    if (
      !isExactKeys(id.reader, ['path', 'sha256']) ||
      id.reader.path !== 'dist/internal/v2-internal-verified-read.js' ||
      !HEX_64.test(id.reader.sha256) ||
      id.cleanup !== null
    ) {
      return 'invalid-record';
    }
    if (expectedEmittedReaderSha && id.reader.sha256 !== expectedEmittedReaderSha) return 'stale-identity';
  }

  // 6. configuration
  if (isNativeUpgrade) {
    if (record.configuration !== null) return 'invalid-record';
  } else {
    const c = record.configuration;
    if (
      !c ||
      !Array.isArray(c.capabilityKeys) ||
      c.capabilityKeys.length !== CAPABILITY_PURPOSES.length ||
      !Array.isArray(c.evidenceKeys) ||
      c.evidenceKeys.length !== EVIDENCE_PURPOSES.length ||
      c.capabilityKeys.length + c.evidenceKeys.length > 16
    ) {
      return 'invalid-record';
    }
    for (let i = 0; i < CAPABILITY_PURPOSES.length; i++) {
      const entry = c.capabilityKeys[i];
      if (
        !isExactKeys(entry, ['purpose', 'keyId', 'current', 'status']) ||
        entry.purpose !== CAPABILITY_PURPOSES[i] ||
        !isBoundedText(entry.keyId) ||
        typeof entry.current !== 'boolean' ||
        !['available', 'revoked', 'unavailable'].includes(entry.status)
      ) {
        return 'invalid-record';
      }
    }
    for (let i = 0; i < EVIDENCE_PURPOSES.length; i++) {
      const entry = c.evidenceKeys[i];
      if (
        !isExactKeys(entry, ['purpose', 'keyId', 'version', 'current', 'status']) ||
        entry.purpose !== EVIDENCE_PURPOSES[i] ||
        !isBoundedText(entry.keyId) ||
        !isBoundedText(entry.version) ||
        typeof entry.current !== 'boolean' ||
        !['available', 'revoked', 'unavailable'].includes(entry.status)
      ) {
        return 'invalid-record';
      }
    }
    if (
      !isExactKeys(c.policy, ['policyId', 'policyVersion', 'publicRulesSha256']) ||
      !isBoundedText(c.policy.policyId) ||
      !isBoundedText(c.policy.policyVersion) ||
      !HEX_64.test(c.policy.publicRulesSha256) ||
      !equal(c.timing, DEFAULT_TIMING)
    ) {
      return 'invalid-record';
    }
  }

  // 7. observations
  const o = record.observations;
  if (!o || !isValidCloseRecord(o.readClose) || !isValidCloseRecord(o.cleanupClose)) return 'invalid-record';
  if (isNativeUpgrade) {
    if (
      o.ownerWorkerThreadId !== null ||
      o.providerThreadId !== null ||
      o.openWriterConnectionCount !== null ||
      o.statuses !== null
    ) {
      return 'invalid-record';
    }
  } else {
    if (
      !Number.isSafeInteger(o.ownerWorkerThreadId) ||
      o.ownerWorkerThreadId < 1 ||
      o.providerThreadId !== o.ownerWorkerThreadId ||
      o.openWriterConnectionCount !== 1 ||
      o.factoryConnectionIdentityCount !== 1 ||
      o.factoryFenceIdentityCount !== 1 ||
      o.factoryKeyProviderIdentityCount !== 1 ||
      o.parentProviderRpcCalls !== 0 ||
      !Number.isSafeInteger(o.createPosts) ||
      o.createPosts < 0 ||
      !Number.isSafeInteger(o.recoveryPosts) ||
      o.recoveryPosts < 0 ||
      !Number.isSafeInteger(o.pairs) ||
      o.pairs < 0 ||
      o.pairHeaderFailures !== 0 ||
      o.safeOutputLeaks !== 0 ||
      o.metricLeaks !== 0 ||
      o.logLeaks !== 0 ||
      o.privacyLeaks !== 0 ||
      !Array.isArray(o.statuses) ||
      o.statuses.length !== 28 ||
      o.workerExits !== 0 ||
      o.workerExitCode !== null ||
      o.cleanupDisposition !== null
    ) {
      return 'invalid-record';
    }
    const allKeys = [...record.configuration.capabilityKeys, ...record.configuration.evidenceKeys];
    for (let i = 0; i < allKeys.length; i++) {
      const expectedStatusSlot = allKeys[i].status === 'available' ? 1 : allKeys[i].status === 'revoked' ? 2 : 3;
      if (o.statuses[i * 2] !== expectedStatusSlot || ![0, 1].includes(o.statuses[i * 2 + 1])) return 'invalid-record';
    }
  }

  if (caseId === 'escaped-65536-old-route') {
    if (
      !isExactKeys(o.detail, ['bodyBytes', 'completeReplyBytes', 'metadataBytes', 'oldReplyBytes']) ||
      o.detail.bodyBytes !== 65536 ||
      !Number.isSafeInteger(o.detail.completeReplyBytes) ||
      o.detail.completeReplyBytes <= 16384 ||
      o.detail.completeReplyBytes > 262144 ||
      !Number.isSafeInteger(o.detail.metadataBytes) ||
      o.detail.metadataBytes < 1 ||
      o.detail.metadataBytes > 65536 ||
      !Number.isSafeInteger(o.detail.oldReplyBytes) ||
      o.detail.oldReplyBytes < 1 ||
      o.detail.oldReplyBytes > 16384
    ) {
      return 'invalid-record';
    }
  } else if (caseId === 'native-deadline' || caseId === 'native-cancel' || caseId === 'native-packing-fault') {
    if (
      !isExactKeys(o.detail, [
        'phaseOrdinal',
        'phase',
        'actualReadBudgetMs',
        'elapsedMs',
        'parentResponsive',
        'independentWriterSurvived',
      ]) ||
      !Number.isSafeInteger(o.detail.phaseOrdinal) ||
      o.detail.phaseOrdinal < 1 ||
      !isBoundedText(o.detail.phase, 32) ||
      !Number.isSafeInteger(o.detail.actualReadBudgetMs) ||
      o.detail.actualReadBudgetMs < 1 ||
      !Number.isSafeInteger(o.detail.elapsedMs) ||
      o.detail.elapsedMs < 0 ||
      o.detail.parentResponsive !== true ||
      o.detail.independentWriterSurvived !== true
    ) {
      return 'invalid-record';
    }
  } else if (caseId === 'captured-image-stable') {
    if (
      !isExactKeys(o.detail, ['replacementAfterCapture', 'returnedCapturedImage']) ||
      o.detail.replacementAfterCapture !== true ||
      o.detail.returnedCapturedImage !== true
    ) {
      return 'invalid-record';
    }
  } else if (caseId === 'whole-checksum-refused') {
    if (
      !isExactKeys(o.detail, ['imageShaRecomputed', 'wholeChecksumMismatch']) ||
      o.detail.imageShaRecomputed !== true ||
      o.detail.wholeChecksumMismatch !== true
    ) {
      return 'invalid-record';
    }
  } else if (isUncertainty) {
    if (
      !isExactKeys(o.detail, ['lateSuccessObserved', 'futureReadRefused', 'originalOwnerRetained']) ||
      o.detail.lateSuccessObserved !== true ||
      o.detail.futureReadRefused !== true ||
      o.detail.originalOwnerRetained !== true ||
      o.adapterReusableAfterDisposition !== false
    ) {
      return 'invalid-record';
    }
  } else if (o.detail !== null) {
    return 'invalid-record';
  }

  return 'ok';
}

export function parseFullNoteNativeEvidenceStage(stage, stageOrdinal, stream, context = {}) {
  const stdout = typeof stream?.stdout === 'string' ? stream.stdout : '';
  const stderr = typeof stream?.stderr === 'string' ? stream.stderr : '';
  const outputBytes = Number.isSafeInteger(stream?.bytes) ? stream.bytes : Buffer.byteLength(stdout, 'utf8');
  const outputSha256 = typeof stream?.outputSha256 === 'string' && HEX_64.test(stream.outputSha256) ? stream.outputSha256 : sha(stdout);
  const records = [];
  let aggregateBytes = 0;
  const finish = (valid, status) => ({
    valid,
    status,
    recordCount: records.length,
    aggregateBytes,
    caseIds: records.map(entry => entry.record.caseId),
    records,
  });

  if (stage !== EVIDENCE_STAGE) {
    if (stdout.includes(EVIDENCE_MARKER) || stderr.includes(EVIDENCE_MARKER)) return finish(false, 'wrong-stage');
    return finish(true, 'not-applicable');
  }
  if (stream?.overflow === true || outputBytes > stageOutputLimit) return finish(false, 'overflow');
  if (stderr.includes(EVIDENCE_MARKER)) return finish(false, 'wrong-stream');
  if (!stdout.endsWith('\n')) return finish(false, 'unterminated');

  const seenCases = new Set();
  const prefix = `ℹ ${EVIDENCE_MARKER} `;
  let seenFooterStart = false;

  for (let offset = 0; offset < stdout.length; ) {
    const end = stdout.indexOf('\n', offset);
    if (end < 0) return finish(false, 'unterminated');
    const stop = end > offset && stdout[end - 1] === '\r' ? end - 1 : end;
    const line = stdout.slice(offset, stop);
    offset = end + 1;

    if (/^ℹ (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)(?: |$)/.test(line)) {
      seenFooterStart = true;
    }

    if (!line.includes(EVIDENCE_MARKER)) continue;
    if (seenFooterStart) return finish(false, 'after-footer');
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\uFFFD]/.test(line)) return finish(false, 'ansi-or-control');
    if (!line.startsWith(prefix)) return finish(false, 'malformed-framing');

    const payloadLine = line.slice('ℹ '.length);
    const recordBytes = Buffer.byteLength(payloadLine, 'utf8');
    if (recordBytes > EVIDENCE_RECORD_LIMIT || Buffer.byteLength(line, 'utf8') > EVIDENCE_RECORD_LIMIT) {
      return finish(false, 'record-overflow');
    }
    aggregateBytes += recordBytes;
    if (aggregateBytes > EVIDENCE_AGGREGATE_LIMIT) return finish(false, 'aggregate-overflow');

    const jsonText = line.slice(prefix.length);
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return finish(false, 'malformed-json');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || JSON.stringify(parsed) !== jsonText) {
      return finish(false, 'malformed-json');
    }
    for (const forbidden of ['fixture_secret', 'lockToken', 'Literal **markdown**', 'seed', 'PRIVATE_']) {
      if (jsonText.includes(forbidden)) return finish(false, 'invalid-record');
    }
    if (parsed.version !== 1 || parsed.stage !== EVIDENCE_STAGE) return finish(false, 'invalid-record');
    if (typeof parsed.caseId !== 'string' || !EVIDENCE_CASES.includes(parsed.caseId)) {
      return finish(false, 'unknown-case');
    }
    if (seenCases.has(parsed.caseId)) return finish(false, 'duplicate-case');
    if (parsed.outcome === 'unexpected-failure') {
      seenCases.add(parsed.caseId);
      records.push({ stage, stageOrdinal, outputBytes, outputSha256, record: parsed });
      return finish(false, 'unexpected-failure');
    }
    const validation = validateEvidenceRecord(parsed, context);
    if (validation !== 'ok') return finish(false, validation);
    seenCases.add(parsed.caseId);
    records.push({ stage, stageOrdinal, outputBytes, outputSha256, record: parsed });
  }

  if (records.length !== EVIDENCE_CASES.length || EVIDENCE_CASES.some(caseId => !seenCases.has(caseId))) {
    return finish(false, 'missing-cases');
  }
  return finish(true, 'complete');
}

function git(root, args, input) {
  const result = spawnSync('git', ['--work-tree', root, '-C', root, ...args], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(failure);
  return result.stdout;
}
function bytes(root, path) {
  if (!/^[a-zA-Z0-9_./@-]+$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(failure);
  }
  const parts = path.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error(failure);
    }
  }
  return readFileSync(current);
}
function productPaths(root) {
  const paths = [];
  function visit(path) {
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) throw new Error(failure);
    if (stat.isFile()) {
      paths.push(path);
      return;
    }
    if (!stat.isDirectory()) throw new Error(failure);
    for (const entry of readdirSync(join(root, path))) visit(path + '/' + entry);
  }
  for (const entry of readdirSync(root)) {
    if (['src', 'tests', 'scripts', 'package.json', 'package-lock.json'].includes(entry) || /^tsconfig.*\.json$/.test(entry)) {
      visit(entry);
    }
  }
  return paths.sort();
}
function sourceIdentity(root) {
  const candidate = git(root, ['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(candidate)) throw new Error(failure);
  const selectors = ['src', 'tests', 'scripts', 'package.json', 'package-lock.json', 'tsconfig*.json'];
  const visible = ['.', ':(exclude)memory/**'];
  if (
    git(root, ['ls-files', '-v', '-z', '--', ...visible])
      .split('\0')
      .filter(Boolean)
      .some(entry => !entry.startsWith('H '))
  ) {
    throw new Error(failure);
  }
  if (git(root, ['diff', '--name-only', '-z', 'HEAD', '--', ...visible])) throw new Error(failure);
  if (git(root, ['status', '--porcelain', '--untracked-files=all', '--', ...selectors]).trim()) throw new Error(failure);
  const committed = git(root, ['ls-tree', '-r', '-z', candidate])
    .split('\0')
    .filter(Boolean)
    .map(entry => {
      const match = /^(\d{6}) (\S+) ([a-f0-9]{40})\t(.+)$/.exec(entry);
      if (!match) throw new Error(failure);
      return { mode: match[1], type: match[2], oid: match[3], path: match[4] };
    })
    .filter(entry => !entry.path.startsWith('memory/'))
    .map(entry => {
      if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob') throw new Error(failure);
      return { path: entry.path, mode: entry.mode, oid: entry.oid };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const isProduct = path =>
    /^(src|tests|scripts)\//.test(path) || ['package.json', 'package-lock.json'].includes(path) || /^tsconfig[^/]*\.json$/.test(path);
  const paths = productPaths(root);
  if (!paths.length || !equal(paths, committed.filter(entry => isProduct(entry.path)).map(entry => entry.path))) {
    throw new Error(failure);
  }
  const inputs = committed.map(entry => ({ ...entry, sha256: sha(bytes(root, entry.path)) }));
  const filtered = git(root, ['hash-object', '--stdin-paths'], committed.map(entry => entry.path).join('\n') + '\n')
    .trim()
    .split(/\r?\n/);
  if (!equal(filtered, committed.map(entry => entry.oid))) throw new Error(failure);
  return { candidate, sourceSha256: sha(canonical(inputs)), sourceFiles: inputs.length, productFiles: paths.length };
}
function artifacts(root) {
  const manifest = bytes(root, 'dist/v2-build.json');
  const build = JSON.parse(manifest);
  const { buildIdentityHash, ...body } = build;
  const runtime = {
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    executableSha256: sha(readFileSync(process.execPath)),
  };
  if (
    build.schemaVersion !== 1 ||
    typeof build.deploymentId !== 'string' ||
    !build.deploymentId ||
    !equal(build.runtime, runtime) ||
    buildIdentityHash !== sha(canonical(body)) ||
    !Array.isArray(build.artifacts) ||
    !equal(
      build.artifacts.map(entry => entry.path),
      artifactNames,
    )
  ) {
    throw new Error(failure);
  }
  const measured = build.artifacts.map(entry => {
    const value = bytes(root, 'dist/' + entry.path);
    if (entry.bytes !== value.length || entry.sha256 !== sha(value)) throw new Error(failure);
    return { path: entry.path, bytes: value.length, sha256: sha(value) };
  });
  const closures = artifactNames.slice(3).map(path => {
    const closureBytes = bytes(root, 'dist/' + path + '.closure.json');
    const closure = JSON.parse(closureBytes);
    if (
      !equal(
        closure.artifact,
        measured.find(entry => entry.path === path),
      ) ||
      closure.sourceChecked !== true ||
      closure.emittedChecked !== true ||
      !Array.isArray(closure.inputs) ||
      !closure.inputs.length
    ) {
      throw new Error(failure);
    }
    const seen = new Set();
    const inputs = closure.inputs.map(input => {
      if (!/^(src|node_modules)\//.test(input.path) || seen.has(input.path)) throw new Error(failure);
      seen.add(input.path);
      const value = bytes(root, input.path);
      if (input.bytes !== value.length || input.sha256 !== sha(value)) throw new Error(failure);
      return { path: input.path, bytes: value.length, sha256: sha(value) };
    });
    return { path, sha256: sha(closureBytes), inputSha256: sha(canonical(inputs)), inputFiles: inputs.length };
  });
  return { manifestSha256: sha(manifest), buildIdentityHash, runtime, artifacts: measured, closures };
}
function compiledIdentity(root) {
  const inputs = [];
  function visit(path) {
    const stat = lstatSync(join(root, path));
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(failure);
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const child = path + '/' + entry.name;
      if (entry.isSymbolicLink()) throw new Error(failure);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) inputs.push({ path: child, sha256: sha(bytes(root, child)) });
      else throw new Error(failure);
    }
  }
  visit('dist-test');
  inputs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const listedTests = names.map(name => {
    const path = `dist-test/tests/${name}.test.js`;
    const entry = inputs.find(input => input.path === path);
    if (!entry) throw new Error(failure);
    return entry;
  });
  const privateClosure = privatePaths.map(relative => {
    const path = 'dist-test/' + relative;
    const entry = inputs.find(input => input.path === path);
    if (!entry) throw new Error(failure);
    return entry;
  });
  return { files: inputs.length, sha256: sha(canonical(inputs)), listedTests, privateClosure };
}

const dispositions = new WeakMap();
function refusal(code = 1) {
  const error = new Error(failure);
  dispositions.set(error, Number.isInteger(code) && code > 0 && code <= 0xffffffff ? code : 1);
  return error;
}
function absent(path) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}
function skipIdentities(_stage, counts) {
  if (!counts || counts.skipped === 0) return [];
  throw refusal();
}

async function runGate({ root = repository, timeoutMs = maximumMs, signal } = {}) {
  const arrival = performance.now();
  const deadline = arrival + timeoutMs;
  let boundFailure;
  let identity;
  let runtimeSha256;
  let measurement;
  let compiledMeasurement;
  let nativeEvidenceResult;
  let qualification;
  let ownedLock;
  const receipts = [];
  const streams = new Map();
  const assertWithinBound = () => {
    if (signal?.aborted || performance.now() >= deadline) {
      boundFailure = signal?.aborted ? 130 : 124;
      throw refusal(boundFailure);
    }
  };
  const assertOwnedLock = currentRoot => {
    const stat = lstatSync(join(currentRoot, '.fresh-start-foundation.lock'), { bigint: true });
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1n ||
      (ownedLock && (stat.dev !== ownedLock.dev || stat.ino !== ownedLock.ino))
    ) {
      throw refusal();
    }
    ownedLock ??= stat;
  };
  const verifyIdentity = currentRoot => {
    assertOwnedLock(currentRoot);
    if (
      !equal(sourceIdentity(currentRoot), identity) ||
      sha(readFileSync(process.execPath)) !== runtimeSha256 ||
      (measurement && !equal(artifacts(currentRoot), measurement)) ||
      (compiledMeasurement && !equal(compiledIdentity(currentRoot), compiledMeasurement))
    ) {
      throw refusal();
    }
    assertWithinBound();
  };
  const expectedStages = ['runtime', 'typecheck', 'build', 'compile', ...names, 'worker-smoke', 'fresh-start-smoke'];
  const result = await runFixedStages({
    root,
    timeoutMs,
    maximumMs,
    signal,
    profile,
    gate,
    failure,
    forwardOutput: false,
    stages: currentRoot => [
      ['runtime', [join(currentRoot, 'scripts/check-runtime.js'), '--json']],
      ['typecheck', [join(currentRoot, 'node_modules/typescript/bin/tsc'), '--noEmit']],
      ['build', [join(currentRoot, 'scripts/build.js')]],
      ['compile', [join(currentRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.test.json']],
      ...names.map(name => [
        name,
        ['--test', '--test-concurrency=1', '--test-reporter=spec', join(currentRoot, `dist-test/tests/${name}.test.js`)],
      ]),
      ['worker-smoke', [join(currentRoot, 'scripts/smoke-worker.js')]],
      ['fresh-start-smoke', [join(currentRoot, 'scripts/smoke-v2-fresh-start.js')]],
    ],
    beforeStages(currentRoot) {
      root = currentRoot;
      assertOwnedLock(currentRoot);
      identity = sourceIdentity(currentRoot);
      runtimeSha256 = sha(readFileSync(process.execPath));
      assertWithinBound();
      emit({ observation: 'candidate', ...identity, runtimeSha256 });
    },
    observeOutput(stage, kind, value) {
      let stream = streams.get(stage);
      if (!stream) {
        stream = {
          bytes: 0,
          hash: createHash('sha256'),
          decoder: new StringDecoder('utf8'),
          stderrDecoder: new StringDecoder('utf8'),
          stdout: '',
          stderr: '',
          overflow: false,
        };
        streams.set(stage, stream);
      }
      stream.hash.update(kind);
      stream.hash.update(value);
      stream.bytes += value.length;
      if (stream.bytes > stageOutputLimit) {
        stream.overflow = true;
        stream.stdout = '';
        stream.stderr = '';
        return;
      }
      if (kind === 'stdout') stream.stdout += stream.decoder.write(value);
      else if (kind === 'stderr' || kind === 'bridge-stderr') stream.stderr += stream.stderrDecoder.write(value);
    },
    observeStage(receipt, currentRoot) {
      const stream = streams.get(receipt.stage) ?? {
        bytes: 0,
        hash: createHash('sha256'),
        stdout: '',
        stderr: '',
        overflow: false,
      };
      stream.stdout += stream.decoder?.end() ?? '';
      stream.stderr += stream.stderrDecoder?.end() ?? '';
      const outputSha256 = stream.hash.digest('hex');
      const isTest = names.includes(receipt.stage);
      const counts = isTest ? parseFinalSpecCounts(stream.stdout) : null;
      const validCounts =
        !isTest ||
        (Number.isSafeInteger(counts.tests) &&
          counts.tests > 0 &&
          counts.fail === 0 &&
          counts.cancelled === 0 &&
          counts.todo === 0 &&
          counts.pass + counts.skipped === counts.tests);
      const stageOrdinal = receipts.length + 1;
      const nativeEvidence = parseFullNoteNativeEvidenceStage(
        receipt.stage,
        stageOrdinal,
        { bytes: stream.bytes, stdout: stream.stdout, stderr: stream.stderr, overflow: stream.overflow, outputSha256 },
        { measurement, compiledMeasurement },
      );
      if (receipt.stage === EVIDENCE_STAGE) nativeEvidenceResult = nativeEvidence;
      const observed = {
        ...receipt,
        counts,
        outputBytes: stream.bytes,
        outputSha256,
        outputOverflow: stream.overflow,
        ...(nativeEvidence.status !== 'not-applicable'
          ? {
              nativeEvidence: {
                status: nativeEvidence.status,
                recordCount: nativeEvidence.recordCount,
                aggregateBytes: nativeEvidence.aggregateBytes,
                caseIds: nativeEvidence.caseIds,
              },
            }
          : {}),
      };
      receipts.push(observed);
      emit(observed);
      stream.stdout = '';
      stream.stderr = '';
      streams.delete(receipt.stage);
      if (receipt.code !== 0) return;
      if (
        receipt.stage !== expectedStages[receipts.length - 1] ||
        receipt.nativeCode !== 0 ||
        receipt.cleanup !== 'complete' ||
        receipt.closure !== 'windows-job-active-zero' ||
        stream.overflow ||
        !validCounts ||
        !nativeEvidence.valid
      ) {
        throw refusal();
      }
      observed.skips = skipIdentities(receipt.stage, counts);
      assertOwnedLock(currentRoot);
      if (receipt.stage === 'build') {
        measurement = artifacts(currentRoot);
        if (measurement.runtime.executableSha256 !== runtimeSha256) throw refusal();
        emit({ observation: 'measured-artifacts', ...measurement });
      }
      if (receipt.stage === 'compile') {
        compiledMeasurement = compiledIdentity(currentRoot);
        emit({ observation: 'compiled-inputs', ...compiledMeasurement });
      }
      if (receipt.stage === 'runtime' || receipt.stage === names[0]) verifyIdentity(currentRoot);
      assertWithinBound();
    },
    afterStages(currentRoot) {
      if (
        receipts.length !== 37 ||
        receipts.filter(receipt => names.includes(receipt.stage)).length !== 31 ||
        !measurement ||
        !compiledMeasurement ||
        !nativeEvidenceResult?.valid ||
        nativeEvidenceResult.recordCount !== 21 ||
        !equal(
          receipts.map(receipt => receipt.stage),
          expectedStages,
        ) ||
        receipts.some(
          receipt =>
            receipt.code !== 0 ||
            receipt.nativeCode !== 0 ||
            receipt.cleanup !== 'complete' ||
            receipt.closure !== 'windows-job-active-zero',
        )
      ) {
        throw refusal();
      }
      verifyIdentity(currentRoot);
      qualification = {
        observation: 'qualification',
        gate,
        profile,
        totalMs: timeoutMs,
        ...identity,
        runtimeSha256,
        measurement,
        compiledMeasurement,
        nativeEvidence: {
          version: 1,
          stage: EVIDENCE_STAGE,
          stageOrdinal: expectedStages.indexOf(EVIDENCE_STAGE) + 1,
          status: nativeEvidenceResult.status,
          recordCount: nativeEvidenceResult.recordCount,
          aggregateBytes: nativeEvidenceResult.aggregateBytes,
          caseIds: nativeEvidenceResult.caseIds,
          records: nativeEvidenceResult.records,
        },
        completedStages: receipts.length,
        testFiles: 31,
        tests: receipts.filter(receipt => names.includes(receipt.stage)).reduce((total, receipt) => total + receipt.counts.tests, 0),
        skipped: 0,
        skips: [],
        closure: 'windows-job-active-zero',
        inputs: {
          requestTimeoutMs: 15000,
          closeTimeoutMs: 5000,
          recoveryProofLifetimeMs: 60000,
          maxPending: 128,
          executorLeaseMs: 15000,
          heartbeatIntervalMs: 5000,
          appendRetryDeadlineMs: 15000,
          sqliteBusyTimeoutMs: 5000,
          readTimeoutMs: 5000,
        },
      };
      assertWithinBound();
    },
  });
  if (result !== 0) throw refusal(boundFailure ?? result);
  if (!qualification || !absent(join(root, '.fresh-start-foundation.lock'))) throw refusal();
  qualification.elapsedMs = performance.now() - arrival;
  const publication = JSON.stringify(qualification) + '\n';
  assertWithinBound();
  process.stdout.write(publication);
}

export async function runFullBodyNotesGate(options = {}) {
  try {
    await runGate(options);
  } catch (error) {
    throw dispositions.has(error) ? error : refusal();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    if (process.argv.length !== 2) throw refusal();
    await runFullBodyNotesGate({ signal: controller.signal });
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(failure + '\n');
    process.exitCode = dispositions.get(error) ?? 1;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}
