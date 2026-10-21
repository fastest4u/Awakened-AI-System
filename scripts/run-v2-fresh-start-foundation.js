import { spawn } from 'node:child_process';
import { closeSync, fstatSync, lstatSync, openSync, realpathSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const targets = ['fresh-start-repository', 'fresh-start-initializer', 'fresh-start-control-plane',
  'fresh-start-admission', 'v2-foundation-entry', 'ci-fresh-start-foundation'];

// Spawn Node directly: no shell/npm intermediary whose exit could hide the
// compiler/test exit. Each active child owns a process tree, never a global name.
function runChild(args, root, timeoutMs, signal) {
  return new Promise((resolveResult, rejectResult) => {
    if (signal?.aborted) { resolveResult(130); return; }
    const env = { ...process.env };
    // A gate invoked from a test process must still execute its child files.
    // Node otherwise silently suppresses a nested --test run with exit zero.
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', shell: false,
      env, windowsHide: true, detached: process.platform !== 'win32' });
    let stopped = 0, closed = false, killer, cleanupTimer, childExit, killerClosed = true;
    const stop = code => {
      if (stopped || closed) return;
      stopped = code;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        // /T scopes termination to descendants of the one child this invocation
        // created; /F is needed because console signals are not portable here.
        killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killerClosed = false;
        killer.on('error', () => { try { child.kill('SIGKILL'); } catch {} });
        killer.once('close', code => {
          killerClosed = true;
          if (code !== 0) { finish(1, true); return; }
          if (childExit !== undefined) finish(stopped);
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
      }
      cleanupTimer = setTimeout(() => {
        try { killer?.kill('SIGKILL'); child.kill('SIGKILL'); } catch {}
        finish(1, true); // Retain ownership when process-tree cleanup is unconfirmed.
      }, 5000);
    };
    const cancel = () => stop(130);
    const timer = setTimeout(() => stop(124), timeoutMs);
    function finish(code, uncertain = false) {
      if (closed) return;
      closed = true; clearTimeout(timer); clearTimeout(cleanupTimer);
      signal?.removeEventListener('abort', cancel);
      if (uncertain) {
        // A failed OS termination must not keep the gate alive indefinitely.
        // The retained lock prevents another gate from touching shared outputs.
        child.unref(); killer?.unref();
        rejectResult(new Error('FOUNDATION_CLEANUP_UNCONFIRMED'));
      }
      else resolveResult(code);
    }
    child.once('error', () => finish(1));
    child.once('close', (code, childSignal) => {
      childExit = childSignal ? 1 : code ?? 1;
      if (killerClosed) finish(stopped || childExit);
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

/** Internal orchestration seam; the command line always selects this checkout.
 * Alternate roots/deadlines let real isolated child fixtures exercise ownership
 * without introducing environment switches into the shipped V2 composition. */
export async function runFoundationGate({ root = repository, timeoutMs = 300000, signal } = {}) {
  let descriptor, identity, lock, retainLock = false;
  try {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error('FOUNDATION_DEADLINE_INVALID');
    root = realpathSync.native(root);
    lock = join(root, '.fresh-start-foundation.lock');
    try { descriptor = openSync(lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('FOUNDATION_OUTPUT_BUSY'); throw error; }
    identity = fstatSync(descriptor, { bigint: true });
    const compile = await runChild([join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.test.json'], root, timeoutMs, signal);
    if (compile !== 0) return compile;
    for (const name of targets) {
      const tests = await runChild(['--test', '--test-concurrency=1', '--test-reporter=spec',
        join(root, `dist-test/tests/${name}.test.js`)], root, timeoutMs, signal);
      if (tests !== 0) return tests;
    }
    if (signal?.aborted) return 130;
  } catch (error) {
    retainLock = error.message === 'FOUNDATION_CLEANUP_UNCONFIRMED';
    process.stderr.write(`${error.message === 'FOUNDATION_OUTPUT_BUSY' ? error.message : 'FOUNDATION_GATE_FAILED'}\n`);
    return 1;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      // Never unlink another owner's replacement; abrupt OS death leaves the
      // lock closed for operator investigation instead of unsafe lock stealing.
      const current = lstatSync(lock, { bigint: true });
      if (current.dev !== identity.dev || current.ino !== identity.ino || !current.isFile()) throw new Error('FOUNDATION_LOCK_CHANGED');
      if (!retainLock) unlinkSync(lock);
    }
  }
  process.stdout.write('PASS fresh-start foundation: six files completed\n');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    if (process.argv.length !== 2) throw new Error('FOUNDATION_ARGUMENTS_INVALID');
    process.exitCode = await runFoundationGate({ signal: controller.signal });
  } catch { process.stderr.write('FOUNDATION_GATE_FAILED\n'); process.exitCode = 1; }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
