import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import childProcess, { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

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
] as const;

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
] as const;

const EVIDENCE_MARKER = 'V2_FULL_NOTE_NATIVE_EVIDENCE_V1';
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
] as const;

const failureCode = 'FULL_BODY_NOTES_GATE_FAILED';
const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');

type GateProfile = Readonly<{
  profile: string;
  gate: string;
  failure: string;
  totalTimeoutMs: number;
  cleanupTimeoutMs: number;
  stageOutputMaximumBytes: number;
  evidenceRecordMaximumBytes: number;
  evidenceAggregateMaximumBytes: number;
  testNames: readonly string[];
  privatePaths: readonly string[];
  evidenceCaseIds: readonly string[];
}>;

type GateModule = {
  FULL_BODY_NOTES_GATE_PROFILE: GateProfile;
  runFullBodyNotesGate(options?: { root?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<void>;
  parseFullNoteNativeEvidenceStage(
    stage: string,
    stageOrdinal: number,
    stream: { bytes: number; stdout: string; stderr?: string; overflow: boolean; outputSha256: string },
    context: {
      measurement?: { buildIdentityHash: string; artifacts: { path: string; sha256: string }[] } | null;
      compiledMeasurement?: { privateClosure: { path: string; sha256: string }[] } | null;
    },
  ): {
    valid: boolean;
    status: string;
    recordCount: number;
    aggregateBytes: number;
    caseIds: string[];
    records: { stage: string; stageOrdinal: number; outputBytes: number; outputSha256: string; record: Record<string, any> }[];
  };
};

async function loadGateModule(): Promise<GateModule> {
  const runnerPath = join(process.cwd(), 'scripts/run-v2-full-body-notes.js');
  assert.equal(existsSync(runnerPath), true, 'expected scripts/run-v2-full-body-notes.js to exist');
  const mod = (await import(pathToFileURL(runnerPath).href)) as Partial<GateModule>;
  assert.equal(typeof mod.runFullBodyNotesGate, 'function', 'expected runFullBodyNotesGate export');
  assert.equal(typeof mod.parseFullNoteNativeEvidenceStage, 'function', 'expected parseFullNoteNativeEvidenceStage export');
  assert.ok(mod.FULL_BODY_NOTES_GATE_PROFILE, 'expected FULL_BODY_NOTES_GATE_PROFILE export');
  return mod as GateModule;
}

const footer = 'ℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 1\n';

function buildSyntheticEvidenceRecords(identities: {
  buildIdentityHash: string;
  writerSha256: string;
  emittedReaderSha256: string;
  helperSha256: string;
}): Record<string, any>[] {
  const capabilityPurposes = [
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
  const evidencePurposes = ['data-key-wrap', 'original-input-commitment', 'redacted-content-fingerprint'];
  const makeConfig = (revokedCapability = false, revokedEvidence = false) => ({
    capabilityKeys: capabilityPurposes.map((purpose, idx) => ({
      purpose,
      keyId: `g10/${purpose}/1`,
      current: true,
      status: revokedCapability && idx === 0 ? 'revoked' : 'available',
    })),
    evidenceKeys: evidencePurposes.map((purpose, idx) => ({
      purpose,
      keyId: `g10/${purpose}`,
      version: '1',
      current: true,
      status: revokedEvidence && idx === 0 ? 'revoked' : 'available',
    })),
    policy: {
      policyId: 'g10-policy',
      policyVersion: '1',
      publicRulesSha256: 'a52e605a6a985beed88937e3556841fb6444f67a5d584c7aeac9a53998aeaebb',
    },
    timing: {
      requestTimeoutMs: 15000,
      closeTimeoutMs: 5000,
      recoveryProofLifetimeMs: 60000,
      maxPending: 128,
      executorLeaseMs: 15000,
      heartbeatIntervalMs: 5000,
      appendRetryDeadlineMs: 15000,
      sqliteBusyTimeoutMs: 5000,
      privateReadBudgetMs: 5000,
    },
  });
  const baseScope = {
    projectId: '2f35722f-0869-4cba-83a9-78fb21a2cfab',
    vaultId: '17be376a-9708-4f0d-9549-0e86010442ef',
    storeId: 'b928d43b-5514-491e-995b-0210bc7f9b8d',
    workspaceId: '52986cb6f4182dbabd65f827db0a84bb1cc8641dd48979adacb20469abadf9e4',
    branchScopeId: null,
    branchRef: null,
    sessionId: 'd78de789-2aa9-4130-aea6-a7752b906b4b',
  };
  const imageScope = { ...baseScope, sessionId: null };
  const siblingScope = { ...baseScope, sessionId: '08782042-9394-43f8-932c-7eceff66343b' };
  const projectScope = { ...imageScope };
  const writerId = { path: 'dist-test/tests/fixtures/project-store-governed-note-worker.js', sha256: identities.writerSha256 };
  const emittedReaderId = { path: 'dist/internal/v2-internal-verified-read.js', sha256: identities.emittedReaderSha256 };
  const helperId = { path: 'dist-test/tests/fixtures/v2-verified-read-process-fixture.js', sha256: identities.helperSha256 };
  const defaultStatuses = Array.from({ length: 28 }, () => 1);
  const revokedCapStatuses = [2, 0, ...Array.from({ length: 26 }, () => 1)];
  const revokedEvStatuses = [...Array.from({ length: 22 }, () => 1), 2, 0, 1, 1, 1, 1];
  const eventHash = '8233b469e1dad31e971e8d5a6c5c9025463590d6171a6d759ebe06a5b68a4b43';
  const imageSha = 'a90c391ada46a698077cfa00cb3319896fe95287859fd5176454e25252202439';
  const beforeImageSha = '625591ed104c35016269796611a86a05046dd35090441c65cde4b4f3e9fecc47';

  return EVIDENCE_CASES.map((caseId, idx) => {
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
    const outcome = isUncertainty
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

    const hexSuffix = (idx + 1).toString(16).padStart(12, '0');
    const cmdUuid = `9a55134f-a79d-43ce-b12f-${hexSuffix}`;
    const idemUuid = `2008ddfd-b6c8-44dd-bda3-${hexSuffix}`;
    const recUuid = `e05ef8e8-7790-4648-a69a-${hexSuffix}`;
    const ev1Uuid = `637486d6-134a-4a75-ae1d-${hexSuffix}`;
    const ev2Uuid = `7349d183-1531-41cb-99f6-${hexSuffix}`;
    const hasRecovery = caseId === 'v1-recovery-v2' || caseId === 'ended-refused' || isUncertainty;
    const opUuid = hasRecovery ? `87597d9c-453b-4ac1-9755-${hexSuffix}` : null;
    const reqUuid = hasRecovery ? `f5f8706f-d32e-46cd-b01c-${hexSuffix}` : null;
    const recoveryDisposition =
      caseId === 'v1-recovery-v2' || isUncertainty ? 'committed' : caseId === 'ended-refused' ? 'refused' : null;

    const fixture = isNativeUpgrade
      ? null
      : {
          runId: '41f9da41-c300-488c-856c-59f592d94e39',
          fixtureId: '80e126b7-21d8-4dcb-894f-0cc8a62980e6',
          ownerGeneration: '1',
          fixtureResetCount: 0,
          retained: isUncertainty,
        };

    const write = isNativeUpgrade
      ? null
      : {
          commandId: cmdUuid,
          idempotencyKey: idemUuid,
          operationId: opUuid,
          requestId: reqUuid,
          recordId: isPreEffectRefusal ? null : recUuid,
          sourceEventIds: isPreEffectRefusal ? null : [ev1Uuid, ev2Uuid],
          receiptVersion: isPreEffectRefusal ? null : caseId === 'v1-kind-absent' || caseId === 'v1-recovery-v2' ? 1 : 2,
          scope: { ...baseScope },
          terminalPosition: isPreEffectRefusal ? null : '6',
          recoveryDisposition,
        };

    const kindMap: Record<string, string | null> = {
      'round-trip-session-log-root': 'session-log',
      'round-trip-insight-root': 'insight',
      'round-trip-mistake-root': 'mistake',
      'round-trip-adr-root': 'adr',
      'round-trip-insight-child': 'insight',
      'escaped-65536-old-route': 'adr',
      'v1-kind-absent': 'insight',
      'v1-recovery-v2': 'insight',
      'ended-refused': 'insight',
      'captured-image-stable': 'insight',
    };
    const recordKind = isReadFail || caseId === 'sibling-refused' || isNativeUpgrade ? null : (kindMap[caseId] ?? 'insight');
    const bodyAvailability =
      isReadFail || caseId === 'sibling-refused'
        ? null
        : caseId === 'v1-kind-absent' || caseId === 'v1-recovery-v2' || isNativeUpgrade
          ? 'absent'
          : 'present';
    const readScope = isReadFail
      ? null
      : isNativeUpgrade
        ? { ...projectScope }
        : caseId === 'sibling-refused'
          ? { ...siblingScope }
          : { ...baseScope };
    const readCode =
      caseId === 'native-cancel'
        ? 'WORKER_CLOSED'
        : caseId === 'whole-checksum-refused'
          ? 'INTEGRITY_FAILURE'
          : isHelperFault
            ? 'WORKER_TIMEOUT'
            : null;

    const read = isPreEffectRefusal
      ? null
      : {
          ids: {
            requestId: `354bdb2f-b9a8-4157-8023-${hexSuffix}:1`,
            attemptId: `a89b440c-a77b-4ebd-9667-${hexSuffix}`,
            laneEpoch: caseId === 'sibling-refused' ? 'g10-1-sibling' : isNativeUpgrade ? 'fixture-epoch' : 'g10-1',
          },
          operation: 'get-full-note',
          scope: readScope,
          imageScope: { ...imageScope },
          selectionSessionId: readScope ? readScope.sessionId : null,
          requestedId: recUuid,
          recordKind,
          bodyAvailability,
          requiredPosition: isReadFail ? null : '6',
          capturedPosition: isReadFail ? null : '6',
          capturedHash: isReadFail ? null : eventHash,
          projectionPosition: isReadFail ? null : '6',
          projectionHash: isReadFail ? null : eventHash,
          projectionGeneration: isReadFail ? null : isNativeUpgrade ? 3 : 1,
          projectionSchemaVersion: isReadFail ? null : 3,
          imageSha256: isReadFail ? null : imageSha,
          code: readCode,
          cleanup: isUncertainty ? 'incomplete' : 'complete',
          ownerState: isUncertainty ? 'quarantined' : isReadFail || isHelperSuccess ? 'closed' : 'available',
        };

    const upgrade =
      caseId === 'same-position-upgrade'
        ? {
            before: { schemaVersion: 2, generation: 2, position: '6', eventHash, imageSha256: beforeImageSha },
            after: { schemaVersion: 3, generation: 3, position: '6', eventHash, imageSha256: imageSha },
            tailBefore: { position: '6', hash: eventHash, count: '6' },
            tailAfter: { position: '6', hash: eventHash, count: '6' },
            eventAppendCountDelta: 0,
          }
        : null;

    const detail =
      caseId === 'escaped-65536-old-route'
        ? { bodyBytes: 65536, completeReplyBytes: 133469, metadataBytes: 2398, oldReplyBytes: 2169 }
        : caseId === 'native-deadline' || caseId === 'native-cancel' || caseId === 'native-packing-fault'
          ? {
              phaseOrdinal: 5,
              phase: 'query',
              actualReadBudgetMs: 2000,
              elapsedMs: 1200,
              parentResponsive: true,
              independentWriterSurvived: true,
            }
          : caseId === 'captured-image-stable'
            ? { replacementAfterCapture: true, returnedCapturedImage: true }
            : caseId === 'whole-checksum-refused'
              ? { imageShaRecomputed: true, wholeChecksumMismatch: true }
              : isUncertainty
                ? { lateSuccessObserved: true, futureReadRefused: true, originalOwnerRetained: true }
                : null;

    return {
      version: 1,
      stage: 'v2-full-note-entry',
      caseId,
      outcome,
      fixture,
      write,
      read,
      upgrade,
      identities: {
        buildIdentityHash: identities.buildIdentityHash,
        writer: isNativeUpgrade ? null : { ...writerId },
        reader: isPreEffectRefusal ? null : isHelperFault || isHelperSuccess ? { ...helperId } : { ...emittedReaderId },
        cleanup: isHelperFault ? { ...helperId } : null,
      },
      configuration: isNativeUpgrade
        ? null
        : makeConfig(caseId === 'revoked-refused', caseId === 'source-key-unavailable'),
      observations: {
        ownerWorkerThreadId: isNativeUpgrade ? null : 3,
        providerThreadId: isNativeUpgrade ? null : 3,
        openWriterConnectionCount: isNativeUpgrade ? null : 1,
        factoryConnectionIdentityCount: isNativeUpgrade ? null : 1,
        factoryFenceIdentityCount: isNativeUpgrade ? null : 1,
        factoryKeyProviderIdentityCount: isNativeUpgrade ? null : 1,
        parentProviderRpcCalls: isNativeUpgrade ? null : 0,
        createPosts: isNativeUpgrade ? null : 1,
        recoveryPosts: isNativeUpgrade ? null : hasRecovery ? 1 : 0,
        pairs: isNativeUpgrade ? null : isPreEffectRefusal ? 0 : 1,
        pairHeaderFailures: isNativeUpgrade ? null : 0,
        safeOutputLeaks: isNativeUpgrade ? null : 0,
        metricLeaks: isNativeUpgrade ? null : 0,
        logLeaks: isNativeUpgrade ? null : 0,
        privacyLeaks: isNativeUpgrade ? null : 0,
        statuses: isNativeUpgrade
          ? null
          : caseId === 'revoked-refused'
            ? [...revokedCapStatuses]
            : caseId === 'source-key-unavailable'
              ? [...revokedEvStatuses]
              : [...defaultStatuses],
        workerExits: isNativeUpgrade ? null : 0,
        workerExitCode: null,
        cleanupDisposition: null,
        adapterReusableAfterDisposition: isPreEffectRefusal ? null : !(isReadFail || isHelperSuccess),
        imageClosed: isPreEffectRefusal || isReadFail ? null : true,
        readerClosed: isPreEffectRefusal || isReadFail ? null : true,
        lockClosed: isPreEffectRefusal ? null : true,
        readClose: isPreEffectRefusal
          ? null
          : {
              ordinal: idx + 1,
              code: isHelperFault && !isUncertainty ? null : 0,
              signal: isHelperFault && !isUncertainty ? 'SIGKILL' : null,
              stdoutDrained: true,
              stderrDrained: true,
            },
        cleanupClose: isHelperFault
          ? {
              ordinal: idx + 100,
              code: isUncertainty ? null : 0,
              signal: isUncertainty ? 'SIGKILL' : null,
              stdoutDrained: true,
              stderrDrained: true,
            }
          : null,
        detail,
      },
    };
  });
}

function physicalSnapshot(root: string): Map<string, string> {
  const result = new Map<string, string>();
  function visit(relative: string) {
    const path = join(root, relative);
    const stat = fs.lstatSync(path, { bigint: true });
    assert.equal(stat.isSymbolicLink(), false);
    const actual = realpathSync.native(path);
    assert.equal(
      process.platform === 'win32' ? actual.toLowerCase() : actual,
      process.platform === 'win32' ? path.toLowerCase() : path,
    );
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(path).sort()) visit(relative ? `${relative}/${name}` : name);
    } else {
      assert.ok(stat.isFile());
      assert.equal(stat.nlink, 1n);
      result.set(relative, sha256(readFileSync(path)));
    }
  }
  visit('');
  return result;
}

function fixtureGit(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['--git-dir', join(root, '.git'), '--work-tree', root, '-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const recordPrefix = "import{appendFileSync}from'node:fs';const log=x=>appendFileSync('trace',x+'\\n');";
const syntheticEntryTestSource = `${recordPrefix}
import{test}from'node:test';
import{readFileSync}from'node:fs';
import{createHash}from'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
test('v2-full-note-entry',t=>{
  log('v2-full-note-entry');
  const build=JSON.parse(readFileSync('dist/v2-build.json','utf8'));
  const writerSha=sha(readFileSync('dist-test/tests/fixtures/project-store-governed-note-worker.js'));
  const helperSha=sha(readFileSync('dist-test/tests/fixtures/v2-verified-read-process-fixture.js'));
  const readerSha=build.artifacts.find(a=>a.path==='internal/v2-internal-verified-read.js').sha256;
  const template=JSON.parse(readFileSync('node_modules/synthetic/evidence-template.json','utf8'));
  for(const rec of template){
    rec.identities.buildIdentityHash=build.buildIdentityHash;
    if(rec.identities.writer)rec.identities.writer.sha256=writerSha;
    if(rec.identities.reader)rec.identities.reader.sha256=rec.identities.reader.path.startsWith('dist/')?readerSha:helperSha;
    if(rec.identities.cleanup)rec.identities.cleanup.sha256=helperSha;
    t.diagnostic('${EVIDENCE_MARKER} '+JSON.stringify(rec));
  }
});`;

let staticSeed: { root: string; files: Map<string, string> } | undefined;
function seedRoot() {
  if (staticSeed) {
    assert.deepEqual(physicalSnapshot(staticSeed.root), staticSeed.files);
    return staticSeed;
  }
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'full-body-gate-seed-')));
  const put = (path: string, value: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  const git = (...args: string[]) => fixtureGit(root, ...args);
  put('package.json', '{"type":"module"}');
  put('.gitignore', 'node_modules/\ndist/\ndist-test/\ntrace\n');
  put('docs/input.md', 'tracked documentation');
  put('docs/evidence/v2-full-body-notes.md', '# Unqualified prepared evidence\n\nStatus: UNQUALIFIED\n');
  put('memory/note.md', 'mutable vault');
  put('src/input.ts', 'export const input=1;');
  put('tests/input.ts', 'export {};');
  put('tsconfig.test.json', '{}');
  put('node_modules/synthetic/input.js', 'export const dependency=1;');
  put(
    'node_modules/synthetic/evidence-template.json',
    JSON.stringify(
      buildSyntheticEvidenceRecords({
        buildIdentityHash: '0'.repeat(64),
        writerSha256: '1'.repeat(64),
        emittedReaderSha256: '2'.repeat(64),
        helperSha256: '3'.repeat(64),
      }),
    ),
  );
  put('scripts/check-runtime.js', `${recordPrefix}log('runtime');process.exit(0);`);
  put(
    'node_modules/typescript/bin/tsc',
    `${recordPrefix}const a=process.argv.slice(2);if(JSON.stringify(a)==='["--noEmit"]')log('typecheck');else if(JSON.stringify(a)==='["-p","tsconfig.test.json"]')log('compile');else process.exit(79);process.exit(0);`,
  );
  put(
    'scripts/build.js',
    `${recordPrefix}log('build');
import{mkdirSync,writeFileSync,readFileSync}from'node:fs';import{createHash}from'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');const canon=v=>Array.isArray(v)?'['+v.map(canon).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}':JSON.stringify(v);
const paths=['v2.js','v2-admin.js','workers/project-store.worker.js','internal/v2-internal-verified-read.js','internal/v2-internal-verified-read-cleanup.js'];
const artifacts=paths.map(path=>{mkdirSync('dist/'+path.split('/').slice(0,-1).join('/'),{recursive:true});writeFileSync('dist/'+path,path);return{path,bytes:Buffer.byteLength(path),sha256:sha(path)}});
for(const artifact of artifacts.slice(3)){const path='node_modules/synthetic/input.js',bytes=readFileSync(path);writeFileSync('dist/'+artifact.path+'.closure.json',JSON.stringify({artifact,inputs:[{path,bytes:bytes.length,sha256:sha(bytes)}],sourceChecked:true,emittedChecked:true}));}
const body={schemaVersion:1,deploymentId:'synthetic-owned',runtime:{nodeVersion:process.versions.node,platform:process.platform,arch:process.arch,executableSha256:sha(readFileSync(process.execPath))},artifacts};writeFileSync('dist/v2-build.json',JSON.stringify({...body,buildIdentityHash:sha(canon(body))}));process.exit(0);`,
  );
  put('scripts/smoke-worker.js', `${recordPrefix}log('worker-smoke');process.exit(0);`);
  put('scripts/smoke-v2-fresh-start.js', `${recordPrefix}log('fresh-start-smoke');process.exit(0);`);
  git('init', '--quiet');
  git('config', 'core.symlinks', 'false');
  git('add', '--', 'package.json', '.gitignore', 'src', 'tests', 'scripts', 'docs', 'memory', 'tsconfig.test.json');
  git('-c', 'user.name=Owned Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'owned fixture');
  for (const path of ['.git/objects/info/alternates', '.git/objects/info/http-alternates', '.git/commondir', 'dist', 'dist-test', 'trace', '.fresh-start-foundation.lock']) {
    assert.equal(existsSync(join(root, path)), false);
  }
  staticSeed = { root, files: physicalSnapshot(root) };
  return staticSeed;
}

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'full-body-gate-')));
  const source = seedRoot();
  const seed = source.root;
  for (const path of source.files.keys()) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    fs.copyFileSync(join(seed, path), target, fs.constants.COPYFILE_EXCL);
    const before = fs.lstatSync(join(seed, path), { bigint: true });
    const after = fs.lstatSync(target, { bigint: true });
    assert.equal(after.nlink, 1n);
    assert.notEqual(`${before.dev}:${before.ino}`, `${after.dev}:${after.ino}`);
  }
  assert.deepEqual(physicalSnapshot(root), source.files);
  const put = (path: string, value: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  const git = (...args: string[]) => fixtureGit(root, ...args);
  const commit = () => {
    git('add', '--', 'package.json', '.gitignore', 'src', 'tests', 'scripts', 'docs', 'memory', 'tsconfig.test.json');
    git('-c', 'user.name=Owned Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'owned fixture');
  };
  for (const name of names) {
    put(
      `dist-test/tests/${name}.test.js`,
      name === 'v2-full-note-entry'
        ? syntheticEntryTestSource
        : `${recordPrefix}import{test}from'node:test';test('${name}',()=>log('${name}'));`,
    );
  }
  for (const path of privatePaths) put(`dist-test/${path}`, `export const custody = ${JSON.stringify(path)};\n`);
  put('dist-test/unlisted.map', 'whole compiled tree');
  const events: any[] = [];
  const native: any[] = [];
  const trace = () => (existsSync(join(root, 'trace')) ? readFileSync(join(root, 'trace'), 'utf8').trim().split('\n').filter(Boolean) : []);
  let outputFault: ((actual: string) => string) | undefined;
  let protocolFault = '';
  let faultStage = 5;
  let onEvent: ((event: any) => void) | undefined;
  let onAdmission: (() => void) | undefined;
  let released = false;
  let publicationAfterRelease = false;
  let lockIdentity: { dev: bigint; ino: bigint } | undefined;
  let releaseAttempt: any;

  async function run(options: { timeoutMs?: number; signal?: AbortSignal; unlinkFault?: boolean; closeFault?: boolean } = {}) {
    events.length = 0;
    native.length = 0;
    released = false;
    publicationAfterRelease = false;
    lockIdentity = undefined;
    releaseAttempt = undefined;
    if (existsSync(join(root, 'trace'))) rmSync(join(root, 'trace'), { force: true });

    const mod = await loadGateModule();
    const originalSpawn = childProcess.spawn;
    const write = process.stdout.write;
    const errorWrite = process.stderr.write;
    const unlink = fs.unlinkSync;
    const close = fs.closeSync;
    const open = fs.openSync;
    let errorsBeforeRelease = '';
    process.stderr.write = function (chunk: any, ...args: any[]) {
      errorsBeforeRelease += String(chunk);
      return Reflect.apply(errorWrite, process.stderr, [chunk, ...args]);
    } as typeof errorWrite;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const watchdog = setTimeout(cancel, 180000);
    let helpers = 0;
    let ownedDescriptor: number | undefined;
    fs.openSync = ((path: any, ...args: any[]) => {
      const fd = Reflect.apply(open, fs, [path, ...args]);
      if (path === join(root, '.fresh-start-foundation.lock')) {
        ownedDescriptor = fd;
        lockIdentity = fs.fstatSync(fd, { bigint: true });
      }
      return fd;
    }) as typeof open;
    fs.closeSync = ((fd: number) => {
      if (options.closeFault && fd === ownedDescriptor) throw new Error('injected close');
      return close(fd);
    }) as typeof close;
    fs.unlinkSync = ((path: any) => {
      if (path === join(root, '.fresh-start-foundation.lock')) {
        if (options.unlinkFault) {
          const current = fs.lstatSync(path, { bigint: true });
          releaseAttempt = {
            stageCount: events.filter(event => event.stage).length,
            errorsBeforeRelease,
            dev: current.dev,
            ino: current.ino,
          };
          throw new Error('injected unlink');
        }
        unlink(path);
        released = true;
        return;
      }
      return unlink(path);
    }) as typeof unlink;
    process.stdout.write = function (chunk: any, ...args: any[]) {
      if (typeof chunk === 'string') {
        try {
          const event = JSON.parse(chunk);
          events.push(event);
          if (event.observation === 'qualification') {
            publicationAfterRelease = released && !existsSync(join(root, '.fresh-start-foundation.lock'));
          }
          onEvent?.(event);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
      return Reflect.apply(write, process.stdout, [chunk, ...args]);
    } as typeof write;
    childProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => {
      const child = originalSpawn(...args);
      if (args[2]?.cwd !== root || !args[1]?.some(arg => arg.endsWith('v2-verified-read-job.ps1'))) return child;
      const index = ++helpers;
      const proof: any = { index, closed: false };
      native.push(proof);
      const out = child.stdout!;
      const register = out.on;
      let observed = '';
      let buffered = '';
      let captured = '';
      register.call(out, 'data', (chunk: Buffer) => {
        observed += chunk.toString();
        let end;
        while ((end = observed.indexOf('\n')) >= 0) {
          const line = observed.slice(0, end);
          observed = observed.slice(end + 1);
          const value = JSON.parse(line);
          if (value.kind === 'ready') proof.ready = true;
          if (value.kind === 'started') {
            proof.started = true;
            onAdmission?.();
          }
          if (value.kind === 'direct-exit') proof.direct = value;
          if (value.kind === 'closure') proof.closure = value;
        }
      });
      child.once('close', (code, signal) => {
        proof.closeObserved = true;
        proof.closeCode = code;
        proof.closed = code === 0 && signal === null;
      });
      if (index === faultStage && (outputFault || protocolFault)) {
        out.on = ((event: any, listener: any) => {
          if (event !== 'data') return Reflect.apply(register, out, [event, listener]);
          return Reflect.apply(register, out, [
            event,
            (chunk: Buffer) => {
              buffered += chunk.toString();
              let end;
              while ((end = buffered.indexOf('\n')) >= 0) {
                const line = buffered.slice(0, end);
                buffered = buffered.slice(end + 1);
                const value = JSON.parse(line);
                if (value.kind === 'stdout' && outputFault) {
                  captured += Buffer.from(value.bytes, 'base64').toString('utf8');
                  continue;
                }
                if (value.kind === 'direct-exit' && protocolFault === 'missing-direct') continue;
                if (value.kind === 'closure') {
                  if (outputFault) {
                    const changed = Buffer.from(outputFault(captured));
                    for (let offset = 0; offset < changed.length; offset += 4096) {
                      listener(
                        Buffer.from(
                          JSON.stringify({ kind: 'stdout', bytes: changed.subarray(offset, offset + 4096).toString('base64') }) + '\n',
                        ),
                      );
                    }
                  }
                  if (protocolFault === 'missing-closure') continue;
                  if (protocolFault === 'active') {
                    listener(Buffer.from(JSON.stringify({ ...value, activeProcesses: 1 }) + '\n'));
                    continue;
                  }
                  if (protocolFault === 'fragment') {
                    listener(Buffer.from(line + '\n{'));
                    continue;
                  }
                }
                listener(Buffer.from(line + '\n'));
              }
            },
          ]);
        }) as typeof out.on;
      }
      return child;
    }) as typeof originalSpawn;
    syncBuiltinESMExports();
    try {
      const value = await mod.runFullBodyNotesGate({ root, timeoutMs: options.timeoutMs, signal: controller.signal });
      return { ok: true, value, error: null as Error | null };
    } catch (error) {
      assert.equal((error as Error).message, failureCode);
      return { ok: false, value: undefined, error: error as Error };
    } finally {
      clearTimeout(watchdog);
      options.signal?.removeEventListener('abort', cancel);
      process.stdout.write = write;
      process.stderr.write = errorWrite;
      childProcess.spawn = originalSpawn;
      fs.unlinkSync = unlink;
      fs.closeSync = close;
      fs.openSync = open;
      syncBuiltinESMExports();
    }
  }

  return {
    root,
    seed,
    put,
    git,
    commit,
    events,
    native,
    trace,
    run,
    faultOutput(value: ((actual: string) => string) | undefined, stage = 5) {
      outputFault = value;
      protocolFault = '';
      faultStage = stage;
    },
    faultProtocol(value: string, stage = 1) {
      protocolFault = value;
      outputFault = undefined;
      faultStage = stage;
    },
    observe(value: ((event: any) => void) | undefined) {
      onEvent = value;
    },
    observeAdmission(value: (() => void) | undefined) {
      onAdmission = value;
    },
    publishedAfterRelease: () => publicationAfterRelease,
    releaseObservation: () => ({ lockIdentity, releaseAttempt }),
  };
}

function refused(f: ReturnType<typeof fixture>, result: { ok: boolean }) {
  assert.equal(result.ok, false);
  assert.equal(f.events.filter(event => event.observation === 'qualification').length, 0);
}

test('full_body_gate_is_literal_contained_and_zero_skip', { timeout: 180000 }, async () => {
  const mod = await loadGateModule();
  const profile = mod.FULL_BODY_NOTES_GATE_PROFILE;
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  assert.equal(pkg.scripts?.['test:v2-full-body-notes'], 'node scripts/run-v2-full-body-notes.js');
  const evidencePath = join(process.cwd(), 'docs/evidence/v2-full-body-notes.md');
  assert.equal(existsSync(evidencePath), true, 'expected docs/evidence/v2-full-body-notes.md to exist');
  const evidenceDoc = readFileSync(evidencePath, 'utf8');
  assert.match(evidenceDoc, /# Full-body governed notes/u);
  assert.match(evidenceDoc, /productionReady.*false/u);

  const registrySource = readFileSync(join(process.cwd(), 'src/orchestrator/lifecycle/validation-profile.registry.ts'), 'utf8');
  assert.equal(registrySource.includes('full-body-notes'), false, 'outer 35-minute gate must not enter lifecycle validation registry');
  assert.match(registrySource, /300_?000/u);
  assert.match(registrySource, /1_?048_?576/u);

  const cliResult = spawnSync(process.execPath, ['scripts/run-v2-full-body-notes.js', '--root=PRIVATE_PATH'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  const cliAcceptedArgs = cliResult.status === 0;
  assert.equal(cliAcceptedArgs, false);
  assert.equal(cliResult.status, 1);
  assert.equal(cliResult.stdout, '');
  assert.equal(cliResult.stderr, `${failureCode}\n`);

  assert.equal(profile.profile, 'full-body-notes');
  assert.equal(profile.gate, 'v2-full-body-notes');
  assert.equal(profile.totalTimeoutMs, 2100000);
  assert.equal(profile.cleanupTimeoutMs, 5000);
  assert.equal(profile.stageOutputMaximumBytes, 16 * 1024 * 1024);
  assert.equal(profile.evidenceRecordMaximumBytes, 16384);
  assert.equal(profile.evidenceAggregateMaximumBytes, 131072);
  assert.deepEqual(profile.testNames, names);
  assert.deepEqual(profile.privatePaths, privatePaths);
  assert.deepEqual(profile.evidenceCaseIds, EVIDENCE_CASES);

  const f = fixture();
  f.put('memory/note.md', 'approved mutable memory');
  const runResult = await f.run();
  assert.equal(runResult.ok, true);
  assert.equal(runResult.value, undefined);
  assert.deepEqual(f.trace(), ['runtime', 'typecheck', 'build', 'compile', ...names, 'worker-smoke', 'fresh-start-smoke']);
  const receipts = f.events.filter(event => event.stage);
  assert.equal(receipts.length, 37);
  assert.equal(receipts.filter(event => event.counts).length, 31);
  assert.equal(f.events.filter(event => event.observation === 'qualification').length, 1);
  assert.equal(f.native.length, 37);
  const windowsJobActiveZero = f.native.every(
    value => value.direct?.nativeCode === 0 && value.closure?.activeProcesses === 0 && value.closed === true,
  );
  const lockReleasedBeforeQualification = f.publishedAfterRelease();
  const q = f.events.find(event => event.observation === 'qualification');
  const candidateEvent = f.events.find(event => event.observation === 'candidate');
  const identityIncludesTrackedDocsAndModesAndBlobIds =
    typeof candidateEvent?.sourceSha256 === 'string' &&
    candidateEvent.sourceFiles >= 8 &&
    candidateEvent.productFiles >= 6 &&
    q.sourceSha256 === candidateEvent.sourceSha256;
  const identityIncludesCompiledFixtureWorker =
    Array.isArray(q.compiledMeasurement?.privateClosure) &&
    q.compiledMeasurement.privateClosure.some(
      (entry: { path: string }) => entry.path === 'dist-test/tests/fixtures/project-store-governed-note-worker.js',
    ) &&
    q.compiledMeasurement.privateClosure.some(
      (entry: { path: string }) => entry.path === 'dist-test/tests/fixtures/v2-verified-read-process-fixture.js',
    );

  const failure = new Error(profile.failure);
  const success = {
    skipped: q.skipped,
    windowsJobActiveZero,
    lockReleasedBeforeQualification,
  };
  assert.equal(cliAcceptedArgs, false);
  assert.equal(profile.totalTimeoutMs, 2100000);
  assert.equal(profile.cleanupTimeoutMs, 5000);
  assert.equal(profile.stageOutputMaximumBytes, 16 * 1024 * 1024);
  assert.equal(failure.message, 'FULL_BODY_NOTES_GATE_FAILED');
  assert.equal(success.skipped, 0);
  assert.equal(success.windowsJobActiveZero, true);
  assert.equal(success.lockReleasedBeforeQualification, true);
  assert.equal(identityIncludesTrackedDocsAndModesAndBlobIds, true);
  assert.equal(identityIncludesCompiledFixtureWorker, true);

  assert.equal(q.profile, 'full-body-notes');
  assert.equal(q.gate, 'v2-full-body-notes');
  assert.equal(q.totalMs, 2100000);
  assert.equal(q.completedStages, 37);
  assert.equal(q.testFiles, 31);
  assert.equal(q.tests, 31);
  assert.equal(q.compiledMeasurement.privateClosure.length, privatePaths.length);
  assert.equal(q.compiledMeasurement.listedTests.length, 31);
  assert.equal(q.measurement.artifacts.length, 5);
  assert.equal(q.measurement.closures.length, 2);
  assert.equal(q.nativeEvidence.stage, 'v2-full-note-entry');
  assert.equal(q.nativeEvidence.stageOrdinal, 19);
  assert.equal(q.nativeEvidence.status, 'complete');
  assert.equal(q.nativeEvidence.recordCount, 21);
  assert.deepEqual(q.nativeEvidence.caseIds, EVIDENCE_CASES);
});

test('qualification_binds_candidate_and_private_closure', { timeout: 120000 }, async () => {
  await loadGateModule();
  const first = fixture();
  const second = fixture();
  const seedBefore = physicalSnapshot(first.seed);
  assert.equal(first.seed, second.seed);
  for (const path of seedBefore.keys()) {
    const seed = fs.lstatSync(join(first.seed, path), { bigint: true });
    const a = fs.lstatSync(join(first.root, path), { bigint: true });
    const b = fs.lstatSync(join(second.root, path), { bigint: true });
    assert.equal(seed.nlink, 1n);
    assert.equal(a.nlink, 1n);
    assert.equal(b.nlink, 1n);
    assert.notEqual(`${seed.dev}:${seed.ino}`, `${a.dev}:${a.ino}`);
    assert.notEqual(`${a.dev}:${a.ino}`, `${b.dev}:${b.ino}`);
  }

  // Missing explicit compiled fixture worker or process helper refuses immediately after compile (stage 4).
  for (const missingPath of [
    'tests/fixtures/project-store-governed-note-worker.js',
    'tests/fixtures/v2-verified-read-process-fixture.js',
  ]) {
    const f = fixture();
    fs.renameSync(join(f.root, 'dist-test', missingPath), join(f.root, 'retained-private-entry.js'));
    refused(f, await f.run());
    assert.deepEqual(f.trace(), ['runtime', 'typecheck', 'build', 'compile']);
  }

  // Compiled directory junction refuses immediately after compile.
  {
    const f = fixture();
    fs.renameSync(join(f.root, 'dist-test/src'), join(f.root, 'retained-compiled'));
    fs.symlinkSync(join(f.root, 'retained-compiled'), join(f.root, 'dist-test/src'), 'junction');
    assert.ok(fs.lstatSync(join(f.root, 'dist-test/src')).isSymbolicLink());
    refused(f, await f.run());
    assert.deepEqual(f.trace(), ['runtime', 'typecheck', 'build', 'compile']);
  }

  // Runtime executable raw identity change refuses before typecheck.
  {
    const f = fixture();
    const original = fs.readFileSync;
    let changed = false;
    f.observe(event => {
      if (event.stage === 'runtime') changed = true;
    });
    (fs as any).readFileSync = (path: any, ...args: any[]) =>
      path === process.execPath && changed ? Buffer.from('different executable identity') : Reflect.apply(original, fs, [path, ...args]);
    syncBuiltinESMExports();
    try {
      refused(f, await f.run());
      assert.deepEqual(f.trace(), ['runtime']);
    } finally {
      (fs as any).readFileSync = original;
      syncBuiltinESMExports();
    }
  }

  // Measured input mutations after snapshot refuse at the next verification checkpoint.
  for (const [mutatedPath, triggerStage, expectedTraceLength] of [
    ['docs/input.md', 'runtime', 1],
    ['docs/evidence/v2-full-body-notes.md', 'runtime', 1],
    ['src/input.ts', 'runtime', 1],
    ['dist/v2.js', names[0], 5],
    ['dist/v2-build.json', names[0], 5],
    ['dist/internal/v2-internal-verified-read.js.closure.json', names[0], 5],
    ['node_modules/synthetic/input.js', names[0], 5],
    ['dist-test/unlisted.map', names[0], 5],
    ['dist-test/tests/fixtures/project-store-governed-note-worker.js', names[0], 5],
    ['dist-test/tests/fixtures/v2-verified-read-process-fixture.js', names[0], 5],
    ['dist-test/tests/v2-full-body-note-privacy.test.js', names[0], 5],
  ] as const) {
    const f = fixture();
    f.observe(event => {
      if (event.stage === triggerStage) f.put(mutatedPath, 'changed after snapshot');
    });
    refused(f, await f.run());
    assert.equal(f.trace().at(-1), triggerStage);
    assert.equal(f.trace().length, expectedTraceLength);
  }
});

test('gate_rejects_dirty_docs_and_product_inputs', async () => {
  await loadGateModule();
  for (const mode of [
    'docs-dirty',
    'evidence-dirty',
    'source-dirty',
    'untracked',
    'ignored',
    'assume-unchanged',
    'skip-worktree',
    'docs-assume',
    'source-mode',
    'docs-mode',
    'directory',
    'source-junction',
  ] as const) {
    const f = fixture();
    if (mode === 'docs-dirty') f.put('docs/input.md', 'dirty');
    if (mode === 'evidence-dirty') f.put('docs/evidence/v2-full-body-notes.md', 'dirty evidence');
    if (mode === 'source-dirty') f.put('src/input.ts', 'dirty');
    if (mode === 'untracked') f.put('scripts/extra.js', 'untracked');
    if (mode === 'ignored') {
      f.put('.git/info/exclude', 'scripts/hidden.js\n');
      f.put('scripts/hidden.js', 'ignored');
    }
    if (mode === 'assume-unchanged' || mode === 'skip-worktree') {
      f.git('update-index', `--${mode}`, 'src/input.ts');
      f.put('src/input.ts', 'hidden');
    }
    if (mode === 'docs-assume') {
      f.git('update-index', '--assume-unchanged', 'docs/input.md');
      f.put('docs/input.md', 'hidden docs');
    }
    if (mode === 'source-mode' || mode === 'docs-mode') {
      const path = mode === 'source-mode' ? 'src/input.ts' : 'docs/input.md';
      const oid = f.git('rev-parse', `HEAD:${path}`).trim();
      f.git('update-index', '--cacheinfo', `120000,${oid},${path}`);
      f.git('-c', 'user.name=Owned Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'noncanonical mode');
      assert.equal(f.git('diff', '--name-only', 'HEAD').trim(), '', 'mode is independently clean, not a dirty-file surrogate');
    }
    if (mode === 'directory') {
      fs.renameSync(join(f.root, 'src/input.ts'), join(f.root, 'saved-input'));
      mkdirSync(join(f.root, 'src/input.ts'));
    }
    if (mode === 'source-junction') {
      fs.renameSync(join(f.root, 'src'), join(f.root, 'retained-source'));
      fs.symlinkSync(join(f.root, 'retained-source'), join(f.root, 'src'), 'junction');
      assert.ok(fs.lstatSync(join(f.root, 'src')).isSymbolicLink());
      assert.equal(f.git('diff', '--name-only', 'HEAD').trim(), '');
    }
    refused(f, await f.run());
    assert.equal(f.native.length, 0, `expected 0 native launches for ${mode}`);
    assert.deepEqual(f.trace(), []);
  }
});

test('gate_enforces_deadline_cancellation_and_host_containment', { timeout: 60000 }, async () => {
  await loadGateModule();
  const f = fixture();
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2100001]) {
    refused(f, await f.run({ timeoutMs }));
  }
  const preAborted = new AbortController();
  preAborted.abort();
  refused(f, await f.run({ signal: preAborted.signal }));
  assert.deepEqual(f.trace(), []);
  assert.equal(f.native.length, 0);

  // Deadline includes source identity work and prevents stage launch.
  refused(f, await f.run({ timeoutMs: 1 }));
  assert.deepEqual(f.trace(), []);

  // Post-runtime abort prevents typecheck and later stages.
  const g = fixture();
  const postRuntimeAbort = new AbortController();
  g.observe(event => {
    if (event.stage === 'runtime') postRuntimeAbort.abort();
  });
  refused(g, await g.run({ signal: postRuntimeAbort.signal }));
  assert.deepEqual(g.trace(), ['runtime']);

  // Mid-stage native abort closes the active Windows Job cleanly with code 130 and releases owned lock.
  const h = fixture();
  h.put('scripts/check-runtime.js', `${recordPrefix}log('runtime');setTimeout(()=>process.exit(0),30000);`);
  h.commit();
  const midStageAbort = new AbortController();
  h.observeAdmission(() => {
    setTimeout(() => midStageAbort.abort(), 50);
  });
  refused(h, await h.run({ timeoutMs: 60000, signal: midStageAbort.signal }));
  assert.equal(h.native.length, 1);
  const actual = h.native[0];
  const receipt = h.events.find(event => event.stage);
  assert.ok(actual.started && actual.direct && actual.closure && actual.closed);
  assert.ok(Number.isInteger(actual.direct.nativeCode));
  assert.equal(actual.closure.activeProcesses, 0);
  assert.equal(receipt.cleanup, 'complete');
  assert.equal(receipt.closure, 'windows-job-active-zero');
  assert.equal(receipt.code, 130);
  assert.equal(existsSync(join(h.root, '.fresh-start-foundation.lock')), false);

  // Unsupported containment host refuses and retains ownership lock.
  const u = fixture();
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'unsupported' });
  try {
    refused(u, await u.run());
    assert.equal(u.native.length, 0);
    assert.ok(existsSync(join(u.root, '.fresh-start-foundation.lock')));
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});

test('gate_enforces_lock_ownership_native_containment_and_footer_coherence', { timeout: 240000 }, async () => {
  await loadGateModule();

  // Foreign lock remains untouched and never launches.
  {
    const f = fixture();
    f.put('.fresh-start-foundation.lock', 'foreign');
    refused(f, await f.run());
    assert.equal(readFileSync(join(f.root, '.fresh-start-foundation.lock'), 'utf8'), 'foreign');
    assert.equal(f.native.length, 0);
  }

  // Owned finalization faults (replace, missing, unlink, close) withhold qualification and preserve uncertainty.
  for (const mode of ['replace', 'missing', 'unlink', 'close'] as const) {
    const f = fixture();
    f.put('docs/input.md', 'early identity refusal');
    const original = fs.lstatSync;
    let changedLock = false;
    if (mode === 'replace' || mode === 'missing') {
      (fs as any).lstatSync = ((path: any, options: any) => {
        if (!changedLock && path === join(f.root, '.fresh-start-foundation.lock')) {
          changedLock = true;
          fs.renameSync(path, join(f.root, 'retained-original-lock'));
          if (mode === 'replace') f.put('.fresh-start-foundation.lock', 'replacement');
        }
        return original(path, options);
      }) as typeof original;
      syncBuiltinESMExports();
    }
    try {
      refused(f, await f.run({ unlinkFault: mode === 'unlink', closeFault: mode === 'close' }));
    } finally {
      (fs as any).lstatSync = original;
      syncBuiltinESMExports();
    }
    assert.equal(f.native.length, 0);
    if (mode === 'replace') assert.equal(readFileSync(join(f.root, '.fresh-start-foundation.lock'), 'utf8'), 'replacement');
    if (mode === 'unlink' || mode === 'close') assert.ok(existsSync(join(f.root, '.fresh-start-foundation.lock')));
  }

  // Missing positive containment at runtime retains ownership.
  for (const mode of ['missing-direct', 'missing-closure', 'active', 'fragment'] as const) {
    const f = fixture();
    f.faultProtocol(mode, 1);
    refused(f, await f.run());
    assert.deepEqual(f.trace(), ['runtime']);
    assert.ok(existsSync(join(f.root, '.fresh-start-foundation.lock')));
    assert.equal(f.events.find(event => event.stage)?.cleanup, 'incomplete');
  }

  // Native nonzero stops at runtime and never leaks stderr/output.
  {
    const f = fixture();
    f.put('scripts/check-runtime.js', "console.error('PRIVATE_NATIVE_SECRET');process.exit(17);");
    f.commit();
    refused(f, await f.run());
    assert.equal(f.native.length, 1);
    assert.equal(f.events.find(event => event.stage).nativeCode, 17);
    assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE_NATIVE_SECRET/);
  }

  // First test footer refusals with actual native closure and no later stage.
  for (const [, change] of [
    ['nested-incomplete', (s: string) => footer + s.replace(/^ℹ tests \d+$/m, 'ℹ tests broken')],
    ['truncated', (s: string) => s.trimEnd()],
    ['contradictory', (s: string) => s.replace(/^ℹ pass \d+$/m, 'ℹ pass 99')],
    ['zero-tests', (_s: string) => footer.replace(/(tests|pass) 1/g, '$1 0')],
    ['governed-skip', (_s: string) => footer.replace('pass 1', 'pass 0').replace('skipped 0', 'skipped 1')],
    ['todo', (_s: string) => footer.replace('pass 1', 'pass 0').replace('todo 0', 'todo 1')],
    ['cancelled', (_s: string) => footer.replace('pass 1', 'pass 0').replace('cancelled 0', 'cancelled 1')],
    ['output-overflow', (_s: string) => 'PRIVATE_CANARY'.repeat(1400000) + '\n' + footer],
  ] as const) {
    const f = fixture();
    f.faultOutput(change, 5);
    refused(f, await f.run());
    assert.deepEqual(f.trace(), ['runtime', 'typecheck', 'build', 'compile', names[0]]);
    assert.equal(f.native[4].closure.nativeCode, 0);
    assert.equal(f.native[4].closure.activeProcesses, 0);
    assert.ok(f.native[4].closed);
    assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE_CANARY/);
    assert.equal(existsSync(join(f.root, '.fresh-start-foundation.lock')), false);
  }

  // Complete 37-stage result is withheld when final owned lock unlink fails after valid postflight.
  {
    const f = fixture();
    refused(f, await f.run({ unlinkFault: true }));
    assert.deepEqual(f.trace(), ['runtime', 'typecheck', 'build', 'compile', ...names, 'worker-smoke', 'fresh-start-smoke']);
    assert.equal(f.native.length, 37);
    assert.ok(
      f.native.every(
        value => value.direct.nativeCode === 0 && value.closure.nativeCode === 0 && value.closure.activeProcesses === 0 && value.closed,
      ),
    );
    const { lockIdentity, releaseAttempt } = f.releaseObservation();
    assert.equal(releaseAttempt.stageCount, 37);
    assert.equal(releaseAttempt.errorsBeforeRelease, '');
    const retained = fs.lstatSync(join(f.root, '.fresh-start-foundation.lock'), { bigint: true });
    assert.ok(retained.isFile() && !retained.isSymbolicLink());
    assert.equal(retained.dev, lockIdentity!.dev);
    assert.equal(retained.ino, lockIdentity!.ino);
    assert.equal(retained.dev, releaseAttempt.dev);
    assert.equal(retained.ino, releaseAttempt.ino);
    assert.equal(f.publishedAfterRelease(), false);
  }
});

test('gate_validates_bounded_safe_native_evidence_records', { timeout: 90000 }, async () => {
  const mod = await loadGateModule();
  const parse = mod.parseFullNoteNativeEvidenceStage;
  const ids = {
    buildIdentityHash: 'b'.repeat(64),
    writerSha256: 'c'.repeat(64),
    emittedReaderSha256: 'd'.repeat(64),
    helperSha256: 'e'.repeat(64),
  };
  const context = {
    measurement: {
      buildIdentityHash: ids.buildIdentityHash,
      artifacts: [
        { path: 'internal/v2-internal-verified-read.js', sha256: ids.emittedReaderSha256 },
        { path: 'internal/v2-internal-verified-read-cleanup.js', sha256: 'f'.repeat(64) },
      ],
    },
    compiledMeasurement: {
      privateClosure: [
        { path: 'dist-test/tests/fixtures/project-store-governed-note-worker.js', sha256: ids.writerSha256 },
        { path: 'dist-test/tests/fixtures/v2-verified-read-process-fixture.js', sha256: ids.helperSha256 },
      ],
    },
  };
  const makeRecords = () => buildSyntheticEvidenceRecords(ids);
  const makeTranscript = (records: Record<string, any>[], eol = '\n') => {
    const lines = [
      '✔ pure_retrieval_closure_guard_is_causal (1.0ms)',
      ...records.map(r => `ℹ ${EVIDENCE_MARKER} ${JSON.stringify(r)}`),
      'ℹ non-ASCII diagnostic note: ภาษาไทย 😀 literal text',
      '✔ native_full_note_evidence_inventory_is_exact (0.2ms)',
      ...footer.trimEnd().split('\n'),
    ];
    return lines.join(eol) + eol;
  };
  const runParse = (stdout: string, stage = 'v2-full-note-entry', stderr = '', overflow = false, customContext = context) =>
    parse(
      stage,
      19,
      { bytes: Buffer.byteLength(stdout, 'utf8'), stdout, stderr, overflow, outputSha256: sha256(stdout) },
      customContext,
    );

  // Valid LF, CRLF, and 2-byte chunked StringDecoder splitting 3-byte UTF-8 'ℹ' and non-ASCII characters.
  for (const eol of ['\n', '\r\n']) {
    const raw = Buffer.from(makeTranscript(makeRecords(), eol), 'utf8');
    const decoder = new StringDecoder('utf8');
    let decoded = '';
    for (let i = 0; i < raw.length; i += 2) decoded += decoder.write(raw.subarray(i, i + 2));
    decoded += decoder.end();
    const res = runParse(decoded);
    assert.equal(res.valid, true);
    assert.equal(res.status, 'complete');
    assert.equal(res.recordCount, 21);
    assert.deepEqual(res.caseIds, EVIDENCE_CASES);
    assert.ok(res.aggregateBytes > 0 && res.aggregateBytes <= 131072);
    assert.ok(res.records.every(r => r.stage === 'v2-full-note-entry' && r.stageOrdinal === 19));
  }

  // Missing case refuses.
  {
    const records = makeRecords().slice(0, 20);
    const res = runParse(makeTranscript(records));
    assert.equal(res.valid, false);
    assert.equal(res.status, 'missing-cases');
    assert.equal(res.recordCount, 20);
  }

  // Duplicate case refuses.
  {
    const records = makeRecords();
    const dup = [...records, records[0]!];
    const res = runParse(makeTranscript(dup));
    assert.equal(res.valid, false);
    assert.equal(res.status, 'duplicate-case');
  }

  // Unknown case refuses.
  {
    const records = makeRecords();
    records[0] = { ...records[0], caseId: 'unknown-case-id' };
    const res = runParse(makeTranscript(records));
    assert.equal(res.valid, false);
    assert.equal(res.status, 'unknown-case');
  }

  // Extra top-level or nested private field refuses.
  {
    const records = makeRecords();
    records[0] = { ...records[0], extraSecret: 'forbidden' };
    assert.equal(runParse(makeTranscript(records)).valid, false);
    const nested = makeRecords();
    nested[0] = { ...nested[0], fixture: { ...nested[0]!.fixture, absolutePath: 'C:\\secret' } };
    assert.equal(runParse(makeTranscript(nested)).valid, false);
  }

  // Duplicate JSON key in raw wire line refuses via canonical reserialization check.
  {
    const base = makeTranscript(makeRecords());
    const dupKey = base.replace('{"version":1,', '{"version":1,"version":1,');
    const res = runParse(dupKey);
    assert.equal(res.valid, false);
    assert.equal(res.status, 'malformed-json');
  }

  // Single record > 16384 bytes refuses.
  {
    const records = makeRecords();
    records[0]!.read.ids.laneEpoch = 'x'.repeat(16384);
    const res = runParse(makeTranscript(records));
    assert.equal(res.valid, false);
    assert.equal(res.status, 'record-overflow');
  }

  // Aggregate records > 131072 bytes refuses.
  {
    const records = makeRecords().map(r => ({
      ...r,
      write: r.write
        ? { ...r.write, scope: { ...r.write.scope, branchRef: 'b'.repeat(6500) } }
        : r.write,
    }));
    const res = runParse(makeTranscript(records));
    assert.equal(res.valid, false);
    assert.notEqual(res.status, 'complete');
  }

  // Truncated / unterminated line, ANSI escape, wrong framing, after-footer, stderr marker, wrong-stage marker, overflow.
  {
    const validText = makeTranscript(makeRecords());
    assert.equal(runParse(validText.trimEnd()).status, 'unterminated');
    assert.equal(runParse(validText.replace(`ℹ ${EVIDENCE_MARKER}`, `\u001b[32mℹ ${EVIDENCE_MARKER}`)).status, 'ansi-or-control');
    assert.equal(runParse(validText.replace(`ℹ ${EVIDENCE_MARKER}`, `\uFFFD ${EVIDENCE_MARKER}`)).status, 'ansi-or-control');
    assert.equal(runParse(validText.replace(`ℹ ${EVIDENCE_MARKER}`, `# ${EVIDENCE_MARKER}`)).status, 'malformed-framing');
    assert.equal(runParse(validText.replace(`ℹ ${EVIDENCE_MARKER}`, `  ℹ ${EVIDENCE_MARKER}`)).status, 'malformed-framing');
    assert.equal(runParse(validText.replace(`ℹ ${EVIDENCE_MARKER}`, EVIDENCE_MARKER)).status, 'malformed-framing');
    assert.equal(runParse(`${validText}ℹ ${EVIDENCE_MARKER} {}\n`).status, 'after-footer');
    assert.equal(runParse(validText, 'v2-full-note-entry', `ℹ ${EVIDENCE_MARKER} {}\n`).status, 'wrong-stream');
    assert.equal(runParse(validText, 'runtime').status, 'wrong-stage');
    assert.equal(runParse(validText, 'v2-full-note-entry', '', true).status, 'overflow');
  }

  // Stale invoked build / writer / reader / cleanup hash vs runner checkpoint refuses.
  for (const staleKey of ['build', 'writer', 'reader', 'cleanup'] as const) {
    const records = makeRecords();
    if (staleKey === 'build') records[0]!.identities.buildIdentityHash = '9'.repeat(64);
    if (staleKey === 'writer') records[0]!.identities.writer.sha256 = '9'.repeat(64);
    if (staleKey === 'reader') records[0]!.identities.reader.sha256 = '9'.repeat(64);
    if (staleKey === 'cleanup') records[17]!.identities.cleanup.sha256 = '9'.repeat(64);
    const res = runParse(makeTranscript(records));
    assert.equal(res.valid, false);
    assert.equal(res.status, 'stale-identity');
  }

  // Forbidden secret material or unexpected-failure outcome refuses.
  for (const forbidden of ['fixture_secret', 'lockToken', 'Literal **markdown**', 'seed']) {
    const records = makeRecords();
    records[0]!.read.ids.laneEpoch = forbidden;
    const res = runParse(makeTranscript(records));
    assert.equal(res.valid, false);
    assert.equal(res.status, 'invalid-record');
  }
  {
    const records = makeRecords();
    records[0]!.outcome = 'unexpected-failure';
    const res = runParse(makeTranscript(records));
    assert.equal(res.valid, false);
    assert.equal(res.status, 'unexpected-failure');
  }

  // Real contained stage execution refuses a wrong-stage marker at stage 1 (runtime).
  {
    const f = fixture();
    f.put('scripts/check-runtime.js', `${recordPrefix}log('runtime');console.log('ℹ ${EVIDENCE_MARKER} {}');process.exit(0);`);
    f.commit();
    refused(f, await f.run());
    assert.deepEqual(f.trace(), ['runtime']);
    assert.equal(f.events.find(e => e.stage === 'runtime')?.nativeEvidence?.status, 'wrong-stage');
  }

  // Real contained stage execution: valid 21 records in v2-full-note-entry (stage 19) cannot override missing Job closure (activeProcesses=1).
  {
    const f = fixture();
    f.faultProtocol('active', 19);
    refused(f, await f.run());
    assert.equal(f.trace().at(-1), 'v2-full-note-entry');
    assert.equal(f.trace().length, 19);
    const entryReceipt = f.events.find(e => e.stage === 'v2-full-note-entry');
    assert.equal(entryReceipt.cleanup, 'incomplete');
    assert.equal(entryReceipt.nativeEvidence?.status, 'complete');
    assert.equal(entryReceipt.nativeEvidence?.recordCount, 21);
    assert.ok(existsSync(join(f.root, '.fresh-start-foundation.lock')), 'uncertain stage after valid records must retain lock');
  }
});
