import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFixedStages } from './run-v2-internal-verified-read.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const retained = ['contracts', 'redaction', 'envelope', 'migration', 'command', 'replay', 'integrity']
  .map(name => `v2-retained-evidence-${name}`);
const events = ['event-hash', 'event-append-transaction', 'event-store', 'stored-event-authenticator', 'event-integrity',
  'projection-source-event-codec', 'projection-folds', 'lifecycle-projection-folds', 'projection-runtime'];
const storage = ['migration-registry', 'migration-runner', 'project-store-bootstrap', 'project-store-upgrade', 'project-store-upgrade-phase-runner', 'sqlite-driver'];
const lifecycle = ['lifecycle-command-store', 'lifecycle-worker-protocol', 'lifecycle-worker-runtime', 'lifecycle-executor', 'project-store-executor',
  'evidence-coverage', 'fresh-start-admission', 'session-end-policy', 'session-end.coordinator', 'ci-lifecycle-gates', 'ci-fresh-start-foundation'];
const entry = ['v2-retained-evidence-entry', 'v2-foundation-entry', 'runtime-capabilities'];
const gates = ['v2-internal-verified-read-gate', 'v2-native-content-gate'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const testArgs = names => ['--test', '--test-concurrency=1', '--test-reporter=spec', ...names.map(name => `dist-test/tests/${name}.test.js`)];
const npmCli = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
const npm = name => [npmCli, 'run', name];
const matrix = [ ['runtime', npm('check:runtime')], ['compile', npm('test:build')], ['retained', testArgs(retained)],
  ['events', testArgs(events)], ['storage', testArgs(storage)], ['lifecycle', testArgs(lifecycle)], ['typecheck', npm('typecheck')],
  ['build', npm('build')], ['entry', testArgs(entry)], ['worker-smoke', ['scripts/smoke-worker.js']],
  ['fresh-start-smoke', ['scripts/smoke-v2-fresh-start.js']], ['gate-regressions', testArgs(gates)] ];

function git(root, args) {
  const result = spawnSync('git', ['--work-tree', root, '-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.error || result.status !== 0) throw new Error('RETAINED_EVIDENCE_IDENTITY_UNAVAILABLE');
  return result.stdout.trim();
}
function sourceIdentity(root) {
  const candidate = git(root, ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/.test(candidate)) throw new Error('RETAINED_EVIDENCE_IDENTITY_UNAVAILABLE');
  const paths = git(root, ['ls-files', 'src', 'tests', 'scripts', 'package.json', 'package-lock.json', 'tsconfig*.json']).split('\n').filter(Boolean).sort();
  const inputs = paths.map(path => ({ path, sha256: sha(readFileSync(join(root, path))) }));
  return { candidate, sourceSha256: sha(JSON.stringify(inputs)), sourceFiles: inputs.length,
    trackedChanges: git(root, ['status', '--porcelain', '--untracked-files=no']) !== '' };
}
function artifacts(root) {
  const bytes = readFileSync(join(root, 'dist/v2-build.json')), build = JSON.parse(bytes);
  const measured = build.artifacts.map(artifact => {
    const digest = sha(readFileSync(join(root, 'dist', artifact.path)));
    if (digest !== artifact.sha256) throw new Error('RETAINED_EVIDENCE_ARTIFACT_CHANGED');
    return { path: artifact.path, sha256: digest };
  });
  return { manifestSha256: sha(bytes), buildIdentityHash: build.buildIdentityHash, artifacts: measured };
}
function compiledIdentity(root) {
  const inputs = [];
  function visit(directory, prefix) {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink()) throw new Error('RETAINED_EVIDENCE_COMPILED_LINK');
      const path = `${prefix}/${item.name}`;
      if (item.isDirectory()) visit(join(directory, item.name), path);
      else if (item.isFile()) inputs.push({ path, sha256: sha(readFileSync(join(directory, item.name))) });
      else throw new Error('RETAINED_EVIDENCE_COMPILED_ENTRY');
    }
  }
  visit(join(root, 'dist-test'), 'dist-test'); inputs.sort((a, b) => a.path.localeCompare(b.path));
  return { files: inputs.length, sha256: sha(JSON.stringify(inputs)) };
}

/** Internal receipt parser seam; native exit and closure remain independent. */
export function parseFinalSpecCounts(stdout) {
  const lines = stdout.split(/\r?\n/);
  if (lines.pop() !== '') return {};
  const keys = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
  const summaryLine = line => /^ℹ (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)(?: |$)/.test(line);
  // Locate the final summary field, even when malformed or incomplete. Never
  // fall back to an earlier complete footer forwarded by a nested test runner.
  const end = lines.findLastIndex(summaryLine), start = end - keys.length;
  if (start < 0 || summaryLine(lines.slice(0, start).findLast(line => line !== '') ?? '')) return {};
  const counts = {};
  for (const [index, key] of keys.entries()) {
    const match = new RegExp(`^ℹ ${key} (0|[1-9]\\d*)$`).exec(lines[start + index]);
    if (!match || !Number.isSafeInteger(Number(match[1]))) return {};
    counts[key] = Number(match[1]);
  }
  const duration = /^ℹ duration_ms ((?:0|[1-9]\d*)(?:\.\d+)?)$/.exec(lines[end]);
  const total = counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo;
  if (!duration || !Number.isFinite(Number(duration[1])) || !Number.isSafeInteger(total) || total !== counts.tests) return {};
  // Successful spec output ends at its footer. On native failures Node appends
  // its explicit failure report; it must agree with the same complete counts.
  const suffix = lines.slice(end + 1);
  if (suffix.length && (counts.fail + counts.cancelled === 0 || suffix[0] !== '' || suffix[1] !== '✖ failing tests:'
    || suffix[2] !== '' || !suffix[3]?.startsWith('test at '))) return {};
  return counts;
}

/** Internal owned-root seam; both CLI profiles remain fixed. No caller-supplied stages/files. */
export async function runRetainedEvidenceGate({ root = repository, group = 'focused', timeoutMs = 1500000, signal } = {}) {
  if (!['focused', 'acceptance'].includes(group)) { process.stderr.write('RETAINED_EVIDENCE_ARGUMENTS_INVALID\n'); return 1; }
  let identity, measurement, compiledMeasurement;
  const stages = group === 'acceptance' ? matrix : [matrix[0], matrix[1], matrix[7], ['focused', testArgs([...retained, 'v2-retained-evidence-entry'])]];
  const streams = new Map();
  const receipts = [];
  return runFixedStages({ root, timeoutMs, maximumMs: 1500000, signal, profile: group, gate: 'v2-retained-evidence',
    failure: 'RETAINED_EVIDENCE_GATE_FAILED', passed: `PASS private retained-evidence ${group}; review and remaining F2/F3/F4 are separate\n`,
    stages: () => stages, forwardOutput: false,
    beforeStages(currentRoot) {
      identity = sourceIdentity(currentRoot);
      if (group === 'acceptance' && identity.trackedChanges) throw new Error('RETAINED_EVIDENCE_COMMITTED_CANDIDATE_REQUIRED');
      process.stdout.write(JSON.stringify({ gate: 'v2-retained-evidence', observation: 'candidate', ...identity,
        runtime: { node: process.version, platform: process.platform, arch: process.arch, executableSha256: sha(readFileSync(process.execPath)) } }) + '\n');
    },
    observeOutput(stage, kind, bytes) {
      let value = streams.get(stage); if (!value) { value = { bytes: 0, hash: createHash('sha256'), decoder: new StringDecoder('utf8'), stdout: '', stderr: '', overflow: false }; streams.set(stage, value); }
      value.hash.update(kind); value.hash.update(bytes); value.bytes += bytes.length;
      if (value.bytes > 16 * 1024 * 1024) { value.overflow = true; return; }
      if (kind === 'stdout') value.stdout += value.decoder.write(bytes); else value.stderr += bytes.toString('utf8');
    },
    observeStage(receipt, currentRoot) {
      const value = streams.get(receipt.stage) ?? { bytes: 0, hash: createHash('sha256'), stdout: '', stderr: '', overflow: false };
      value.stdout += value.decoder?.end() ?? '';
      const counts = parseFinalSpecCounts(value.stdout);
      const isTest = stages.find(([name]) => name === receipt.stage)?.[1][0] === '--test';
      const validCounts = !isTest || Number.isSafeInteger(counts.tests) && counts.tests > 0 && counts.fail === 0 && counts.cancelled === 0
        && counts.pass + counts.skipped + counts.todo === counts.tests;
      const observed = { ...receipt, counts: isTest ? counts : null, outputBytes: value.bytes, outputSha256: value.hash.digest('hex'), outputOverflow: value.overflow };
      receipts.push(observed); process.stdout.write(JSON.stringify(observed) + '\n');
      // Raw native bytes are inspected in memory; never copied to report/log artifacts.
      value.stdout = ''; value.stderr = ''; streams.delete(receipt.stage);
      if (value.overflow || receipt.code === 0 && !validCounts) throw new Error('RETAINED_EVIDENCE_RECEIPT_INVALID');
      if (receipt.stage === 'compile' && receipt.code === 0) { compiledMeasurement = compiledIdentity(currentRoot); process.stdout.write(JSON.stringify({ observation: 'compiled-inputs', ...compiledMeasurement }) + '\n'); }
      if (receipt.stage === 'build' && receipt.code === 0) { measurement = artifacts(currentRoot); process.stdout.write(JSON.stringify({ observation: 'measured-artifacts', ...measurement }) + '\n'); }
    },
    afterStages(currentRoot) {
      const final = sourceIdentity(currentRoot);
      if (JSON.stringify(final) !== JSON.stringify(identity) || JSON.stringify(artifacts(currentRoot)) !== JSON.stringify(measurement)
        || JSON.stringify(compiledIdentity(currentRoot)) !== JSON.stringify(compiledMeasurement)) throw new Error('RETAINED_EVIDENCE_CANDIDATE_CHANGED');
      const compiled = [...new Set(group === 'acceptance' ? [...retained, ...events, ...storage, ...lifecycle, ...entry, ...gates] : [...retained, 'v2-retained-evidence-entry'])]
        .map(name => ({ path: `dist-test/tests/${name}.test.js`, sha256: sha(readFileSync(join(currentRoot, `dist-test/tests/${name}.test.js`))) }));
      process.stdout.write(JSON.stringify({ observation: 'qualification', ...identity, measurement, compiledMeasurement, compiled, completedStages: receipts.length,
        closure: receipts.every(value => value.cleanup === 'complete' && value.closure === 'windows-job-active-zero') }) + '\n');
    } });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && (args.length !== 2 || args[0] !== '--group' || !['focused', 'acceptance'].includes(args[1]))) throw new Error('invalid arguments');
    process.exitCode = await runRetainedEvidenceGate({ group: args[1] ?? 'focused', signal: controller.signal });
  } catch { process.stderr.write('RETAINED_EVIDENCE_ARGUMENTS_INVALID\n'); process.exitCode = 1; }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
