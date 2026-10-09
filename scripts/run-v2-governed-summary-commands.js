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
const names = ['v2-governed-note-contracts', 'v2-governed-note-redaction', 'v2-governed-note-authority',
  'v2-governed-note-provenance', 'v2-governed-note-codec', 'v2-governed-note-command', 'v2-governed-note-replay',
  'v2-governed-note-recovery', 'v2-governed-note-ownership', 'v2-governed-note-executor', 'v2-governed-note-entry',
  'v2-governed-note-candidate-read', 'v2-governed-note-gate', 'v2-retained-evidence-redaction',
  'v2-retained-evidence-command', 'v2-retained-evidence-replay', 'v2-retained-evidence-integrity',
  'v2-retained-evidence-entry', 'event-append-transaction', 'event-store', 'event-integrity',
  'stored-event-authenticator', 'projection-source-event-codec', 'projection-folds', 'project-store-executor',
  'lifecycle-worker-protocol', 'fresh-start-admission', 'v2-foundation-entry'];
const privatePaths = ['tests/fixtures/project-store-governed-note-worker.js', 'tests/support/governed-note-local-providers.js',
  'tests/support/governed-note-fixture.js', 'src/orchestrator/governed-notes/runtime.factory.js',
  'src/orchestrator/governed-notes/service.js', 'src/orchestrator/governed-notes/run.js',
  'src/orchestrator/governed-notes/fixture-allocation.js', 'src/orchestrator/governed-notes/fixture-control.js',
  'src/orchestrator/runtime/project-store-worker-runtime.js', 'src/orchestrator/runtime/project-store-worker-backend.js',
  'src/orchestrator/runtime/project-store-executor.js', 'src/orchestrator/privacy/retained-evidence-runtime.factory.js',
  'src/orchestrator/runtime/lifecycle-worker-runtime.factory.js'];
const artifactNames = ['v2.js', 'v2-admin.js', 'workers/project-store.worker.js',
  'internal/v2-internal-verified-read.js', 'internal/v2-internal-verified-read-cleanup.js'];
const failure = 'GOVERNED_SUMMARY_COMMANDS_GATE_FAILED';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
    : JSON.stringify(value);
const equal = (a, b) => canonical(a) === canonical(b);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');

function git(root, args, input) {
  const result = spawnSync('git', ['--work-tree', root, '-C', root, ...args],
    { input, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(failure);
  return result.stdout;
}
// Refuse links and non-file inputs, including linked intermediate directories.
function bytes(root, path) {
  if (!/^[a-zA-Z0-9_./@-]+$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(failure);
  const parts = path.split('/'); let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part); const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error(failure);
  }
  return readFileSync(current);
}
// Walk product inputs independently of Git ignore rules. Generated outputs and
// the mutable vault are outside this inventory.
function productPaths(root) {
  const paths = [];
  function visit(path) {
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) throw new Error(failure);
    if (stat.isFile()) { paths.push(path); return; }
    if (!stat.isDirectory()) throw new Error(failure);
    for (const entry of readdirSync(join(root, path))) visit(path + '/' + entry);
  }
  for (const entry of readdirSync(root)) {
    if (['src', 'tests', 'scripts', 'package.json', 'package-lock.json'].includes(entry)
      || /^tsconfig.*\.json$/.test(entry)) visit(entry);
  }
  return paths.sort();
}
function sourceIdentity(root) {
  const candidate = git(root, ['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(candidate)) throw new Error(failure);
  const selectors = ['src', 'tests', 'scripts', 'package.json', 'package-lock.json', 'tsconfig*.json'];
  const visible = ['.', ':(exclude)memory/**'];
  if (git(root, ['ls-files', '-v', '-z', '--', ...visible]).split('\0').filter(Boolean)
    .some(entry => !entry.startsWith('H '))) throw new Error(failure);
  if (git(root, ['diff', '--name-only', '-z', 'HEAD', '--', ...visible])) throw new Error(failure);
  if (git(root, ['status', '--porcelain', '--untracked-files=all', '--', ...selectors]).trim()) throw new Error(failure);
  // Unlike historical documentary exclusions, all tracked non-memory files are
  // qualifying inputs here. Validate raw bytes AND actual committed Git blobs.
  const committed = git(root, ['ls-tree', '-r', '-z', candidate]).split('\0').filter(Boolean).map(entry => {
    const match = /^(\d{6}) (\S+) ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (!match) throw new Error(failure);
    return { mode: match[1], type: match[2], oid: match[3], path: match[4] };
  }).filter(entry => !entry.path.startsWith('memory/')).map(entry => {
    if (!['100644', '100755'].includes(entry.mode) || entry.type !== 'blob') throw new Error(failure);
    return { path: entry.path, mode: entry.mode, oid: entry.oid };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const isProduct = path => /^(src|tests|scripts)\//.test(path)
    || ['package.json', 'package-lock.json'].includes(path) || /^tsconfig[^/]*\.json$/.test(path);
  const paths = productPaths(root);
  if (!paths.length || !equal(paths, committed.filter(entry => isProduct(entry.path)).map(entry => entry.path))) throw new Error(failure);
  const inputs = committed.map(entry => ({ ...entry, sha256: sha(bytes(root, entry.path)) }));
  const filtered = git(root, ['hash-object', '--stdin-paths'], committed.map(entry => entry.path).join('\n') + '\n').trim().split(/\r?\n/);
  if (!equal(filtered, committed.map(entry => entry.oid))) throw new Error(failure);
  return { candidate, sourceSha256: sha(canonical(inputs)), sourceFiles: inputs.length, productFiles: paths.length };
}
function artifacts(root) {
  const manifest = bytes(root, 'dist/v2-build.json'), build = JSON.parse(manifest);
  const { buildIdentityHash, ...body } = build;
  const runtime = { nodeVersion: process.versions.node, platform: process.platform, arch: process.arch,
    executableSha256: sha(readFileSync(process.execPath)) };
  if (build.schemaVersion !== 1 || typeof build.deploymentId !== 'string' || !build.deploymentId
    || !equal(build.runtime, runtime) || buildIdentityHash !== sha(canonical(body))
    || !Array.isArray(build.artifacts) || !equal(build.artifacts.map(entry => entry.path), artifactNames)) throw new Error(failure);
  const measured = build.artifacts.map(entry => {
    const value = bytes(root, 'dist/' + entry.path);
    if (entry.bytes !== value.length || entry.sha256 !== sha(value)) throw new Error(failure);
    return { path: entry.path, bytes: value.length, sha256: sha(value) };
  });
  const closures = artifactNames.slice(3).map(path => {
    const closureBytes = bytes(root, 'dist/' + path + '.closure.json'), closure = JSON.parse(closureBytes);
    if (!equal(closure.artifact, measured.find(entry => entry.path === path)) || closure.sourceChecked !== true
      || closure.emittedChecked !== true || !Array.isArray(closure.inputs) || !closure.inputs.length) throw new Error(failure);
    const seen = new Set();
    const inputs = closure.inputs.map(input => {
      if (!/^(src|node_modules)\//.test(input.path) || seen.has(input.path)) throw new Error(failure);
      seen.add(input.path); const value = bytes(root, input.path);
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
  visit('dist-test'); inputs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const listedTests = names.map(name => {
    const path = `dist-test/tests/${name}.test.js`, entry = inputs.find(input => input.path === path);
    if (!entry) throw new Error(failure); return entry;
  });
  const privateClosure = privatePaths.map(relative => {
    const path = 'dist-test/' + relative, entry = inputs.find(input => input.path === path);
    if (!entry) throw new Error(failure); return entry;
  });
  return { files: inputs.length, sha256: sha(canonical(inputs)), listedTests, privateClosure };
}


const profile = 'governed-summary-commands', gate = 'v2-governed-summary-commands', maximumMs = 900000;
const dispositions = new WeakMap();
function refusal(code = 1) {
  const error = new Error(failure);
  dispositions.set(error, Number.isInteger(code) && code > 0 && code <= 0xffffffff ? code : 1);
  return error;
}
function absent(path) {
  try { lstatSync(path); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}
// The selected inventory contains one inherited boolean platform skip, in
// retained-entry on non-Windows. No inherited skip is permitted on this Windows
// containment profile. Unknown titles/reasons are never copied to public output.
function skipIdentities(stage, counts) {
  if (!counts || counts.skipped === 0) return [];
  throw refusal();
}

/** Internal owned-root seam. CLI cannot choose roots, stages or providers.
 * @returns {Promise<void>} Resolves only after positive contained finalization.
 */
async function runGate({ root = repository, timeoutMs = maximumMs, signal } = {}) {
  const arrival = performance.now(), deadline = arrival + timeoutMs;
  let boundFailure, identity, runtimeSha256, measurement, compiledMeasurement, qualification, ownedLock;
  const receipts = [], streams = new Map();
  const assertWithinBound = () => {
    if (signal?.aborted || performance.now() >= deadline) {
      boundFailure = signal?.aborted ? 130 : 124; throw refusal(boundFailure);
    }
  };
  const assertOwnedLock = currentRoot => {
    const stat = lstatSync(join(currentRoot, '.fresh-start-foundation.lock'), { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
      || ownedLock && (stat.dev !== ownedLock.dev || stat.ino !== ownedLock.ino)) throw refusal();
    ownedLock ??= stat;
  };
  const verifyIdentity = currentRoot => {
    assertOwnedLock(currentRoot);
    if (!equal(sourceIdentity(currentRoot), identity) || sha(readFileSync(process.execPath)) !== runtimeSha256
      || measurement && !equal(artifacts(currentRoot), measurement)
      || compiledMeasurement && !equal(compiledIdentity(currentRoot), compiledMeasurement)) throw refusal();
    assertWithinBound();
  };
  const expectedStages = ['runtime', 'typecheck', 'build', 'compile', ...names, 'worker-smoke', 'fresh-start-smoke'];
  const result = await runFixedStages({ root, timeoutMs, maximumMs, signal, profile, gate, failure, forwardOutput: false,
    stages: currentRoot => [['runtime', [join(currentRoot, 'scripts/check-runtime.js'), '--json']],
      ['typecheck', [join(currentRoot, 'node_modules/typescript/bin/tsc'), '--noEmit']],
      ['build', [join(currentRoot, 'scripts/build.js')]],
      ['compile', [join(currentRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.test.json']],
      ...names.map(name => [name, ['--test', '--test-concurrency=1', '--test-reporter=spec', join(currentRoot, `dist-test/tests/${name}.test.js`)]]),
      ['worker-smoke', [join(currentRoot, 'scripts/smoke-worker.js')]],
      ['fresh-start-smoke', [join(currentRoot, 'scripts/smoke-v2-fresh-start.js')]]],
    beforeStages(currentRoot) {
      root = currentRoot; assertOwnedLock(currentRoot);
      identity = sourceIdentity(currentRoot); runtimeSha256 = sha(readFileSync(process.execPath));
      assertWithinBound(); emit({ observation: 'candidate', ...identity, runtimeSha256 });
    },
    observeOutput(stage, kind, value) {
      let stream = streams.get(stage);
      if (!stream) { stream = { bytes: 0, hash: createHash('sha256'), decoder: new StringDecoder('utf8'), stdout: '', overflow: false }; streams.set(stage, stream); }
      stream.hash.update(kind); stream.hash.update(value); stream.bytes += value.length;
      if (stream.bytes > 16 * 1024 * 1024) { stream.overflow = true; stream.stdout = ''; return; }
      if (kind === 'stdout') stream.stdout += stream.decoder.write(value);
    },
    observeStage(receipt, currentRoot) {
      const stream = streams.get(receipt.stage) ?? { bytes: 0, hash: createHash('sha256'), stdout: '', overflow: false };
      stream.stdout += stream.decoder?.end() ?? '';
      const isTest = names.includes(receipt.stage), counts = isTest ? parseFinalSpecCounts(stream.stdout) : null;
      const validCounts = !isTest || Number.isSafeInteger(counts.tests) && counts.tests > 0 && counts.fail === 0
        && counts.cancelled === 0 && counts.todo === 0 && counts.pass + counts.skipped === counts.tests;
      const observed = { ...receipt, counts, outputBytes: stream.bytes, outputSha256: stream.hash.digest('hex'), outputOverflow: stream.overflow };
      receipts.push(observed); emit(observed); stream.stdout = ''; streams.delete(receipt.stage);
      if (receipt.code !== 0) return; // preserve native nonzero; never qualify it
      if (receipt.stage !== expectedStages[receipts.length - 1] || receipt.nativeCode !== 0
        || receipt.cleanup !== 'complete' || receipt.closure !== 'windows-job-active-zero'
        || stream.overflow || !validCounts) throw refusal();
      observed.skips = skipIdentities(receipt.stage, counts);
      assertOwnedLock(currentRoot);
      if (receipt.stage === 'build') {
        measurement = artifacts(currentRoot);
        if (measurement.runtime.executableSha256 !== runtimeSha256) throw refusal();
        emit({ observation: 'measured-artifacts', ...measurement });
      }
      if (receipt.stage === 'compile') { compiledMeasurement = compiledIdentity(currentRoot); emit({ observation: 'compiled-inputs', ...compiledMeasurement }); }
      // An early checkpoint makes startup/first-test mutation refusals bounded;
      // final remeasurement still binds everything through all remaining stages.
      if (receipt.stage === 'runtime' || receipt.stage === names[0]) verifyIdentity(currentRoot);
      assertWithinBound();
    },
    afterStages(currentRoot) {
      if (receipts.length !== 34 || receipts.filter(receipt => names.includes(receipt.stage)).length !== 28
        || !measurement || !compiledMeasurement || !equal(receipts.map(receipt => receipt.stage), expectedStages)
        || receipts.some(receipt => receipt.code !== 0 || receipt.nativeCode !== 0 || receipt.cleanup !== 'complete'
          || receipt.closure !== 'windows-job-active-zero')) throw refusal();
      verifyIdentity(currentRoot);
      qualification = { observation: 'qualification', gate, profile, totalMs: timeoutMs, ...identity,
        runtimeSha256, measurement, compiledMeasurement, completedStages: receipts.length, testFiles: 28,
        tests: receipts.filter(receipt => names.includes(receipt.stage)).reduce((total, receipt) => total + receipt.counts.tests, 0),
        skipped: 0, skips: [], closure: 'windows-job-active-zero',
        inputs: { requestTimeoutMs: 15000, closeTimeoutMs: 5000, recoveryProofLifetimeMs: 60000, maxPending: 128,
          executorLeaseMs: 15000, heartbeatIntervalMs: 5000, appendRetryDeadlineMs: 15000, sqliteBusyTimeoutMs: 5000, readTimeoutMs: 5000 } };
      assertWithinBound();
    } });
  if (result !== 0) throw refusal(boundFailure ?? result);
  // Shared result zero is only returned after its descriptor/path identity and
  // owned unlink succeeded. Absence is an additional check, not a release proof.
  if (!qualification || !absent(join(root, '.fresh-start-foundation.lock'))) throw refusal();
  qualification.elapsedMs = performance.now() - arrival;
  const publication = JSON.stringify(qualification) + '\n';
  assertWithinBound();
  process.stdout.write(publication);
}
export async function runGovernedSummaryCommandsGate(options = {}) {
  try { await runGate(options); }
  catch (error) { throw dispositions.has(error) ? error : refusal(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    if (process.argv.length !== 2) throw refusal();
    await runGovernedSummaryCommandsGate({ signal: controller.signal }); process.exitCode = 0;
  } catch (error) { process.stderr.write(failure + '\n'); process.exitCode = dispositions.get(error) ?? 1; }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
