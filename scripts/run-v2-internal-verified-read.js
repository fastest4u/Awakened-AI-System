import { spawn } from 'node:child_process';
import { closeSync, fstatSync, lstatSync, openSync, realpathSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const targets = ['v2-internal-verified-read-contracts', 'stable-directory-read-core', 'projection-image-metadata',
  'v2-internal-verified-read-admission', 'v2-internal-verified-read-child', 'v2-internal-verified-read-cleanup',
  'v2-internal-verified-read-ownership', 'v2-internal-verified-read-supervisor', 'v2-internal-verified-read-entry',
  'v2-internal-verified-read-gate', 'projection-manifest', 'projection-integrity', 'v2-reader-lease', 'retrieval-candidates',
  'v2-retrieval-candidates', 'fresh-start-admission', 'sqlite-driver', 'v2-foundation-entry', 'ci-fresh-start-foundation', 'event-append-transaction'];
const nativeTargets = ['retrieval-database-core', 'retrieval-selection-core', 'v2-native-content-contracts', 'v2-native-content-query',
  'v2-native-content-result', 'v2-native-content-child', 'v2-native-content-supervisor', 'v2-native-content-entry', 'v2-native-content-gate',
  'v2-internal-verified-read-contracts', 'v2-internal-verified-read-admission', 'v2-internal-verified-read-child',
  'v2-internal-verified-read-cleanup', 'v2-internal-verified-read-ownership', 'v2-internal-verified-read-supervisor',
  'v2-internal-verified-read-entry', 'v2-internal-verified-read-gate', 'retrieval-candidates', 'v2-retrieval-candidates',
  'retrieval-eligibility', 'retrieval-ranking', 'retrieval-service', 'projection-runtime', 'retrieval-explain', 'retrieval-vector-cache',
  'stable-directory-read-core', 'projection-image-metadata', 'projection-manifest', 'projection-integrity', 'v2-reader-lease',
  'v2-foundation-entry', 'ci-fresh-start-foundation', 'ci-lifecycle-gates'];

const jobBridge = fileURLToPath(new URL('./v2-verified-read-job.ps1', import.meta.url));
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/** One response deadline; advancement requires positive kernel Job closure,
 * direct stage exit and drained output. Unsupported containment fails closed.
 */
function runChild(args, root, deadline, signal, profile) {
  return new Promise(resolveResult => {
    if (signal?.aborted) { resolveResult({ code: 130, uncertain: false }); return; }
    if (performance.now() >= deadline) { resolveResult({ code: 124, uncertain: false }); return; }
    if (process.platform !== 'win32') { resolveResult({ code: 1, uncertain: true }); return; }
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-File', jobBridge],
      { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], shell: false, env, windowsHide: true });
    child.stderr.pipe(process.stderr, { end: false });
    let finished = false, stopped = 0, ready = false, started = false, directExit = false, proof, buffer = '', cleanupTimer, cleanupDeadline;
    const cancel = () => stop(130);
    const timer = setTimeout(() => stop(124), Math.max(1, deadline - performance.now()));
    function finish(code, uncertain = false) {
      if (finished) return;
      if (!uncertain && cleanupDeadline !== undefined && performance.now() >= cleanupDeadline) { code = 1; uncertain = true; }
      finished = true; clearTimeout(timer); clearTimeout(cleanupTimer); signal?.removeEventListener('abort', cancel);
      if (uncertain) {
        // Only this exact spawned helper handle is terminated. Its Job has
        // kill-on-close, but missing positive query proof still retains output.
        try { child.kill('SIGKILL'); } catch {}
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      } else child.stdin.end();
      resolveResult({ code, uncertain, closure: uncertain ? undefined : 'windows-job-active-zero' });
    }
    function beginCleanup() {
      if (cleanupDeadline !== undefined) return;
      cleanupDeadline = performance.now() + 5000;
      cleanupTimer = setTimeout(() => finish(1, true), Math.max(1, cleanupDeadline - performance.now()));
    }
    function stop(code) {
      if (stopped || finished) return;
      stopped = code;
      beginCleanup();
      if (ready) child.stdin.write(`${code}\n`);
    }
    child.stdin.on('error', () => finish(1, true));
    child.stdout.on('data', bytes => {
      if (finished) return;
      buffer += bytes.toString('utf8');
      try {
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          if (line.length > 16384) throw new Error('JOB_FRAME_TOO_LARGE');
          const value = JSON.parse(line);
          if (value.kind === 'ready' && Object.keys(value).length === 1 && !ready && !proof) {
            const remaining = Math.max(0, Math.floor(deadline - performance.now()));
            if (!remaining && !stopped) stop(124);
            ready = true;
            const encoded = value => Buffer.from(value, 'utf8').toString('base64');
            child.stdin.write([encoded(process.execPath), encoded(root), String(remaining), String(stopped), String(args.length), ...args.map(encoded)].join('\n') + '\n');
          } else if (value.kind === 'started' && ready && !started && !proof && Object.keys(value).length === 1) started = true;
          else if (value.kind === 'direct-exit' && started && !directExit && !proof && Object.keys(value).length === 3
            && Number.isInteger(value.nativeCode) && Number.isSafeInteger(value.activeProcesses) && value.activeProcesses >= 0) {
            directExit = true;
            if (value.nativeCode !== 0) beginCleanup();
            process.stdout.write(JSON.stringify({ gate: 'v2-internal-verified-read', observation: 'direct-child-exit',
              profile, code: value.nativeCode, activeProcesses: value.activeProcesses }) + '\n');
          } else if ((value.kind === 'stdout' || value.kind === 'stderr') && started && !proof
            && Object.keys(value).length === 2 && typeof value.bytes === 'string'
            && /^[A-Za-z0-9+/]*={0,2}$/.test(value.bytes)) {
            // Stage bytes never become protocol frames: only the private bridge
            // can emit metadata from its separately captured native pipes.
            (value.kind === 'stdout' ? process.stdout : process.stderr).write(Buffer.from(value.bytes, 'base64'));
          } else if (value.kind === 'closure' && ready && (!started || directExit) && !proof && Object.keys(value).length === 3
            && value.activeProcesses === 0 && Number.isInteger(value.nativeCode)) proof = value;
          else throw new Error('JOB_FRAME_INVALID');
        }
        if (buffer.length > 16384) throw new Error('JOB_FRAME_TOO_LARGE');
      } catch { finish(1, true); }
    });
    child.once('error', () => finish(1, true));
    child.once('close', (code, childSignal) => {
      if (code !== 0 || childSignal || !proof || buffer.trim()) finish(1, true);
      else finish(stopped || proof.nativeCode);
    });
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
  });
}

/** Internal fixture seam; the CLI always runs this checkout's fixed operation. */
export async function runVerifiedReadGate({ root = repository, timeoutMs, signal, profile = 'metadata' } = {}) {
  const arrival = performance.now(); let descriptor, identity, lock, retainLock = false, result = 1;
  try {
    if (profile !== 'metadata' && profile !== 'native-content') throw new Error('VERIFIED_READ_PROFILE_INVALID');
    const maximumMs = profile === 'native-content' ? 1500000 : 900000;
    if (timeoutMs === undefined) timeoutMs = maximumMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximumMs) throw new Error('VERIFIED_READ_DEADLINE_INVALID');
    const deadline = arrival + timeoutMs;
    if (signal?.aborted) return 130;
    root = realpathSync.native(root); lock = join(root, '.fresh-start-foundation.lock');
    try { descriptor = openSync(lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('FOUNDATION_OUTPUT_BUSY'); throw error; }
    identity = fstatSync(descriptor, { bigint: true });
    const stages = [['build', [join(root, 'scripts/build.js')]],
      ['compile', [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.test.json']],
      ...(profile === 'metadata' ? targets : nativeTargets).map(name => [name, ['--test', '--test-concurrency=1', '--test-reporter=spec', join(root, `dist-test/tests/${name}.test.js`)]]),
      ['smoke', [join(root, 'scripts/smoke-v2-fresh-start.js')]]];
    for (const [stage, args] of stages) {
      const started = performance.now(); const child = await runChild(args, root, deadline, signal, profile);
      process.stdout.write(JSON.stringify({ gate: 'v2-internal-verified-read', profile, totalMs: timeoutMs, stage, code: child.code,
        durationMs: performance.now() - started, elapsedMs: performance.now() - arrival, cleanup: child.uncertain ? 'incomplete' : 'complete', closure: child.closure }) + '\n');
      result = child.code;
      if (child.uncertain) { retainLock = true; result = 1; break; }
      if (result !== 0) break;
    }
    if (signal?.aborted && result === 0) result = 130;
    if (performance.now() >= deadline && result === 0) result = 124;
  } catch (error) {
    process.stderr.write((error.message === 'FOUNDATION_OUTPUT_BUSY' ? error.message : 'VERIFIED_READ_GATE_FAILED') + '\n');
    result = 1;
  } finally {
    if (descriptor !== undefined) {
      try {
        const current = lstatSync(lock, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error('VERIFIED_READ_LOCK_CHANGED');
        closeSync(descriptor); descriptor = undefined;
        if (!retainLock) unlinkSync(lock);
      } catch {
        retainLock = true; result = 1; process.stderr.write('VERIFIED_READ_OUTPUT_CLOSURE_UNCONFIRMED\n');
      } finally { if (descriptor !== undefined) { try { closeSync(descriptor); } catch {} } }
    }
  }
  if (result === 0) process.stdout.write(profile === 'metadata'
    ? 'PASS internal verified-read: measured build, one compile, twenty serial files and smoke\n'
    : `PASS native content: measured build, one compile, ${nativeTargets.length} serial files and smoke\n`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(); const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    if (process.argv.length !== 2) throw new Error('VERIFIED_READ_ARGUMENTS_INVALID');
    process.exitCode = await runVerifiedReadGate({ signal: controller.signal });
  } catch { process.stderr.write('VERIFIED_READ_GATE_FAILED\n'); process.exitCode = 1; }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
