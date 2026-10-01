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

/** One response deadline for all stages; only owned termination has a separate 5s observation. */
function runChild(args, root, deadline, signal) {
  return new Promise(resolveResult => {
    if (signal?.aborted) { resolveResult({ code: 130, uncertain: false }); return; }
    if (performance.now() >= deadline) { resolveResult({ code: 124, uncertain: false }); return; }
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
      env, windowsHide: true, detached: process.platform !== 'win32' });
    // Actual close includes output drainage; a descendant retaining either pipe
    // cannot be mistaken for positive closure of the owned process tree.
    child.stdout.pipe(process.stdout, { end: false }); child.stderr.pipe(process.stderr, { end: false });
    let finished = false, stopped = 0, exited, killer, killerClosed = true, cleanupTimer, cleanupDeadline;
    const cancel = () => stop(130);
    const timer = setTimeout(() => stop(124), Math.max(1, deadline - performance.now()));
    function finish(code, uncertain = false) {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(cleanupTimer); signal?.removeEventListener('abort', cancel);
      if (uncertain) { child.stdout.destroy(); child.stderr.destroy(); child.unref(); killer?.unref(); }
      resolveResult({ code, uncertain });
    }
    function observe() {
      if (cleanupDeadline !== undefined && performance.now() >= cleanupDeadline) { finish(1, true); return; }
      if (exited !== undefined && killerClosed) finish(stopped || exited);
    }
    function stop(code) {
      if (stopped || finished) return;
      stopped = code; cleanupDeadline = performance.now() + 5000;
      cleanupTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); killer?.kill('SIGKILL'); } catch {}
        finish(1, true);
      }, 5000);
      if (!child.pid) { finish(1, true); return; }
      if (process.platform === 'win32') {
        killerClosed = false;
        // Absolute OS executable, scoped solely to the child this gate created.
        killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false });
        killer.once('error', () => { try { child.kill('SIGKILL'); } catch {} finish(1, true); });
        killer.once('close', result => {
          killerClosed = true;
          if (result !== 0) { finish(1, true); return; }
          observe();
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') { finish(1, true); return; } }
        observe();
      }
    }
    child.once('error', () => finish(1, stopped !== 0));
    child.once('close', (code, childSignal) => { exited = childSignal ? 1 : code ?? 1; observe(); });
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
  });
}

/** Internal fixture seam; the CLI always runs this checkout's fixed operation. */
export async function runVerifiedReadGate({ root = repository, timeoutMs = 900000, signal } = {}) {
  const arrival = performance.now(); let descriptor, identity, lock, retainLock = false, result = 1;
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900000) throw new Error('VERIFIED_READ_DEADLINE_INVALID');
    const deadline = arrival + timeoutMs;
    if (signal?.aborted) return 130;
    root = realpathSync.native(root); lock = join(root, '.fresh-start-foundation.lock');
    try { descriptor = openSync(lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('FOUNDATION_OUTPUT_BUSY'); throw error; }
    identity = fstatSync(descriptor, { bigint: true });
    const stages = [['build', [join(root, 'scripts/build.js')]],
      ['compile', [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.test.json']],
      ...targets.map(name => [name, ['--test', '--test-concurrency=1', '--test-reporter=spec', join(root, `dist-test/tests/${name}.test.js`)]]),
      ['smoke', [join(root, 'scripts/smoke-v2-fresh-start.js')]]];
    for (const [stage, args] of stages) {
      const started = performance.now(); const child = await runChild(args, root, deadline, signal);
      process.stdout.write(JSON.stringify({ gate: 'v2-internal-verified-read', stage, code: child.code,
        durationMs: performance.now() - started, elapsedMs: performance.now() - arrival, cleanup: child.uncertain ? 'incomplete' : 'complete' }) + '\n');
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
  if (result === 0) process.stdout.write('PASS internal verified-read: measured build, one compile, twenty serial files and smoke\n');
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
