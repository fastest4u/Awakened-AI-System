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
const names = ['v2-native-workflow-contracts', 'v2-native-workflow-database', 'v2-native-workflow-cursor',
  'v2-native-workflow-query', 'v2-native-workflow-result', 'v2-native-workflow-entry', 'v2-native-workflow-gate',
  'v2-native-content-contracts', 'v2-native-content-query', 'v2-native-content-result', 'v2-native-content-child',
  'v2-native-content-supervisor', 'v2-native-content-entry', 'v2-native-content-gate',
  'v2-internal-verified-read-contracts', 'v2-internal-verified-read-admission', 'v2-internal-verified-read-child',
  'v2-internal-verified-read-cleanup', 'v2-internal-verified-read-ownership', 'v2-internal-verified-read-supervisor',
  'v2-internal-verified-read-entry', 'v2-internal-verified-read-gate', 'retrieval-database-core',
  'retrieval-selection-core', 'retrieval-candidates', 'v2-retrieval-candidates', 'retrieval-eligibility',
  'retrieval-ranking', 'ci-lifecycle-gates'];
const artifactNames = ['v2.js', 'v2-admin.js', 'workers/project-store.worker.js',
  'internal/v2-internal-verified-read.js', 'internal/v2-internal-verified-read-cleanup.js'];
const failure = 'NATIVE_READ_WORKFLOWS_GATE_FAILED';
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
  // Lowercase tags hide assume-unchanged entries; S hides skip-worktree entries.
  if (git(root, ['ls-files', '-v', '-z', '--', ...visible]).split('\0').filter(Boolean)
    .some(entry => !entry.startsWith('H '))) throw new Error(failure);
  if (git(root, ['diff', '--name-only', '-z', 'HEAD', '--', ...visible])) throw new Error(failure);
  if (git(root, ['status', '--porcelain', '--untracked-files=all', '--', ...selectors]).trim()) throw new Error(failure);
  const committed = git(root, ['ls-tree', '-r', '-z', candidate]).split('\0').filter(Boolean).map(entry => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (!match) throw new Error(failure);
    return { path: match[3], oid: match[2] };
  }).filter(entry => /^(src|tests|scripts)\//.test(entry.path)
    || ['package.json', 'package-lock.json'].includes(entry.path)
    || /^tsconfig[^/]*\.json$/.test(entry.path)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const paths = productPaths(root);
  if (!paths.length || !equal(paths, committed.map(entry => entry.path))) throw new Error(failure);
  const inputs = paths.map(path => ({ path, sha256: sha(bytes(root, path)) }));
  // One bounded batch applies Git's clean filters and line-ending conversion,
  // comparing committed blobs without writing objects or trusting index stats.
  const filtered = git(root, ['hash-object', '--stdin-paths'], paths.join('\n') + '\n').trim().split(/\r?\n/);
  if (!equal(filtered, committed.map(entry => entry.oid))) throw new Error(failure);
  return { candidate, sourceSha256: sha(canonical(inputs)), sourceFiles: inputs.length };
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
  return { files: inputs.length, sha256: sha(canonical(inputs)), listedTests };
}

/** Owned-root test seam. The command line cannot select roots, stages or providers. */
export async function runNativeReadWorkflowsGate({ root = repository, timeoutMs = 1500000, signal } = {}) {
  const deadline = performance.now() + timeoutMs;
  const assertWithinBound = () => {
    if (signal?.aborted || performance.now() >= deadline) throw new Error(failure);
  };
  let identity, measurement, compiledMeasurement, qualification;
  const streams = new Map(), receipts = [];
  const result = await runFixedStages({ root, timeoutMs, maximumMs: 1500000, signal,
    profile: 'native-read-workflows', gate: 'v2-native-read-workflows', failure, forwardOutput: false,
    stages: currentRoot => [['runtime', [join(currentRoot, 'scripts/check-runtime.js'), '--json']],
      ['typecheck', [join(currentRoot, 'node_modules/typescript/bin/tsc'), '--noEmit']],
      ['build', [join(currentRoot, 'scripts/build.js')]],
      ['compile', [join(currentRoot, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.test.json']],
      ...names.map(name => [name, ['--test', '--test-concurrency=1', '--test-reporter=spec', join(currentRoot, `dist-test/tests/${name}.test.js`)]]),
      ['smoke', [join(currentRoot, 'scripts/smoke-v2-fresh-start.js')]]],
    beforeStages(currentRoot) { identity = sourceIdentity(currentRoot); assertWithinBound(); emit({ observation: 'candidate', ...identity }); },
    observeOutput(stage, kind, value) {
      let stream = streams.get(stage);
      if (!stream) { stream = { bytes: 0, hash: createHash('sha256'), decoder: new StringDecoder('utf8'), stdout: '', overflow: false }; streams.set(stage, stream); }
      stream.hash.update(kind); stream.hash.update(value); stream.bytes += value.length;
      if (stream.bytes > 16 * 1024 * 1024) { stream.overflow = true; return; }
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
      // Preserve an actual primary native failure; its receipt is never qualification.
      if (receipt.code !== 0) return;
      if (receipt.nativeCode !== 0 || receipt.cleanup !== 'complete' || receipt.closure !== 'windows-job-active-zero'
        || stream.overflow || !validCounts) throw new Error(failure);
      if (receipt.stage === 'build') { measurement = artifacts(currentRoot); emit({ observation: 'measured-artifacts', ...measurement }); }
      if (receipt.stage === 'compile') { compiledMeasurement = compiledIdentity(currentRoot); emit({ observation: 'compiled-inputs', ...compiledMeasurement }); }
      assertWithinBound();
    },
    afterStages(currentRoot) {
      if (receipts.length !== 34 || !measurement || !compiledMeasurement || !equal(sourceIdentity(currentRoot), identity)
        || !equal(artifacts(currentRoot), measurement) || !equal(compiledIdentity(currentRoot), compiledMeasurement)) throw new Error(failure);
      qualification = { observation: 'qualification', gate: 'v2-native-read-workflows', ...identity,
        measurement, compiledMeasurement, completedStages: receipts.length,
        tests: receipts.filter(receipt => names.includes(receipt.stage)).reduce((total, receipt) => total + receipt.counts.tests, 0),
        skipped: receipts.filter(receipt => names.includes(receipt.stage)).reduce((total, receipt) => total + receipt.counts.skipped, 0),
        closure: 'windows-job-active-zero' };
      assertWithinBound();
    } });
  // Shared finalization validates and releases the common lock before success is published.
  if (result === 0) {
    const publication = JSON.stringify(qualification) + '\n';
    if (signal?.aborted || performance.now() >= deadline) {
      process.stderr.write(failure + '\n');
      return signal?.aborted ? 130 : 124;
    }
    process.stdout.write(publication);
    process.stdout.write('PASS private native read workflows; remaining F2/F3/F4 are separate\n');
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    if (process.argv.length !== 2) throw new Error(failure);
    process.exitCode = await runNativeReadWorkflowsGate({ signal: controller.signal });
  } catch { process.stderr.write(failure + '\n'); process.exitCode = 1; }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
