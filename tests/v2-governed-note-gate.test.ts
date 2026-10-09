import assert from 'node:assert/strict';
import { AssertionError } from 'node:assert';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import childProcess, { spawnSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import nodeTest, { describe, after } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

type Body = (context: { diagnostic(message: string): void }) => void | Promise<void>;
const controls: { name: string; timeout?: number; body: Body }[] = [];
function test(name: string, options: { timeout: number } | Body, body?: Body) {
    assert.ok(!controls.some(value => value.name === name));
    controls.push({ name, timeout: typeof options === 'function' ? undefined : options.timeout,
        body: typeof options === 'function' ? options : body! });
}
const realmAbort = new AbortController();
const pendingGates = new Set<Promise<unknown>>();
const outcomes = ['completed', 'completed-after-abort', 'assertion-failed', 'other-failed', 'aborted-before-body'] as const;
const phases = ['body', 'fixture-git', 'fixture-copy', 'fixture-write', 'gate'] as const;
const gitOperations = ['init', 'config', 'add', 'commit', 'status', 'diff', 'rev-parse', 'update-index', 'other'] as const;
type Phase = typeof phases[number];
type NativeAvailability = { ordinal: number; ready: boolean; started: boolean; direct: boolean; closure: boolean; closed: boolean;
    closeObserved: boolean; closeCode: number | null; directCode: number | null; closureCode: number | null; activeProcesses: number | null };
type BodyDiagnostic = { outcome: typeof outcomes[number]; phase: Phase; abortBeforeCatch: boolean;
    git: { operation: typeof gitOperations[number]; status: number | null; category: 'none' | 'timeout' | 'launch' | 'other' } | null;
    native: NativeAvailability[] };
let phase: Phase = 'body';
let gitDiagnostic: BodyDiagnostic['git'] = null;
const observedHelpers: any[] = [];
function bodyDiagnostic(outcome: BodyDiagnostic['outcome'], abortBeforeCatch: boolean): BodyDiagnostic {
    return { outcome, phase, abortBeforeCatch, git: gitDiagnostic, native: observedHelpers.map((proof, index) => ({
        ordinal: index + 1, ready: proof.ready === true, started: proof.started === true, direct: !!proof.direct,
        closure: !!proof.closure, closed: proof.closed === true, closeObserved: proof.closeObserved === true,
        closeCode: proof.closeCode ?? null, directCode: proof.direct?.nativeCode ?? null,
        closureCode: proof.closure?.nativeCode ?? null, activeProcesses: proof.closure?.activeProcesses ?? null })) };
}
const exactKeys = (value: any, keys: string[]) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const numericOrNull = (value: unknown) => value === null || Number.isSafeInteger(value);
function validBody(value: any): value is BodyDiagnostic {
    return exactKeys(value, ['outcome', 'phase', 'abortBeforeCatch', 'git', 'native'])
        && outcomes.includes(value.outcome) && phases.includes(value.phase) && typeof value.abortBeforeCatch === 'boolean'
        && (value.git === null || exactKeys(value.git, ['operation', 'status', 'category']) && gitOperations.includes(value.git.operation)
            && numericOrNull(value.git.status) && ['none', 'timeout', 'launch', 'other'].includes(value.git.category))
        && Array.isArray(value.native) && value.native.length <= 34 && value.native.every((proof: any, index: number) =>
            exactKeys(proof, ['ordinal', 'ready', 'started', 'direct', 'closure', 'closed', 'closeObserved', 'closeCode', 'directCode', 'closureCode', 'activeProcesses'])
            && proof.ordinal === index + 1 && ['ready', 'started', 'direct', 'closure', 'closed', 'closeObserved'].every(key => typeof proof[key] === 'boolean')
            && numericOrNull(proof.directCode) && numericOrNull(proof.closeCode) && numericOrNull(proof.closureCode) && numericOrNull(proof.activeProcesses)
            && (proof.activeProcesses === null || proof.activeProcesses >= 0)
            && proof.direct === (proof.directCode !== null) && proof.closure === (proof.closureCode !== null && proof.activeProcesses !== null));
}

// Cheap guards precede the scheduler implementation. They exercise the same
// transport/admission path as the original bodies, without native work.
function registerIsolationGuards() {
    nodeTest('control isolation guard confines builtin and process faults to one fresh realm', async () => {
        const before = { read: fs.readFileSync, namedRead: readFileSync, spawn: childProcess.spawn,
            namedSpawn: spawn, write: process.stdout.write, error: process.stderr.write, platform: process.platform };
        const state = new SharedArrayBuffer(16), pool = new ControlPool();
        const results = await Promise.all([pool.run('probe:mutate', undefined, state), pool.run('probe:companion', undefined, state)]);
        assert.ok(results.every(value => value.exitCode === 0 && value.stdoutEnded && value.stderrEnded));
        assert.equal(Atomics.load(new Int32Array(state), 1), 1);
        assert.deepEqual({ read: fs.readFileSync, namedRead: readFileSync, spawn: childProcess.spawn,
            namedSpawn: spawn, write: process.stdout.write, error: process.stderr.write, platform: process.platform }, before);
    });
    nodeTest('control isolation guard admits at most two fresh workers and joins their output', async () => {
        const state = new SharedArrayBuffer(16), pool = new ControlPool();
        const results = await Promise.all(Array.from({ length: 4 }, () => pool.run('probe:bounded', undefined, state)));
        assert.equal(pool.maximumActive, 2); assert.equal(Atomics.load(new Int32Array(state), 0), 0);
        assert.equal(Atomics.load(new Int32Array(state), 1), 2);
        assert.equal(new Set(results.map(value => value.token)).size, 4);
        assert.ok(results.every(value => value.stdout === 'CONTROL_GUARD_DRAIN\n' && value.stderr === 'CONTROL_GUARD_DRAIN\n'
            && value.stdoutEnded && value.stderrEnded && value.exitCode === 0));
    });
    nodeTest('control isolation guard refuses missing malformed duplicate and misattributed completion', async () => {
        for (const mode of ['missing', 'malformed', 'duplicate', 'wrong-id', 'wrong-token', 'premature', 'unknown']) {
            const pool = new ControlPool();
            await assert.rejects(pool.run('probe:' + mode), /CONTROL_ISOLATION_FAILED/);
            assert.equal(pool.active, 0);
        }
    });
    nodeTest('control isolation guard worker failure stops queued admission and awaits sibling cancellation', async () => {
        const state = new SharedArrayBuffer(16), pool = new ControlPool();
        const results = await Promise.allSettled([pool.run('probe:wait-abort', undefined, state),
            pool.run('probe:fail', undefined, state), pool.run('probe:never', undefined, state)]);
        assert.ok(results.every(value => value.status === 'rejected'));
        assert.equal(pool.launched, 2); assert.equal(pool.active, 0);
        assert.equal(Atomics.load(new Int32Array(state), 2), 1, 'sibling finally finished before join');
        assert.equal(Atomics.load(new Int32Array(state), 3), 0, 'queued body never dispatched');
    });
    nodeTest('control isolation guard cancellation joins cooperative cleanup and refuses subsequent admission', async () => {
        const state = new SharedArrayBuffer(16), pool = new ControlPool(), words = new Int32Array(state);
        const result = pool.run('probe:wait-abort', undefined, state);
        // Attach the rejection handler before cancellation can reject it.
        const settled = Promise.allSettled([result]);
        await until(() => Atomics.load(words, 0) === 1);
        pool.cancel();
        assert.equal((await settled)[0].status, 'rejected');
        await assert.rejects(pool.run('probe:never', undefined, state), /CONTROL_ISOLATION_FAILED/);
        assert.equal(Atomics.load(words, 2), 1); assert.equal(Atomics.load(words, 3), 0);
        assert.equal(pool.active, 0);
    });
    nodeTest('control isolation guard unexpected worker exit cannot supply completion or native proof', async () => {
        const pool = new ControlPool(); await assert.rejects(pool.run('probe:exit'), /CONTROL_ISOLATION_FAILED/);
        assert.equal(pool.active, 0); assert.equal(pool.launched, 1);
    });
    nodeTest('control isolation guard shared interrupt route cancels every registered pool and unregisters after join', async () => {
        const pool = new ControlPool();
        const result = await pool.run('probe:interrupt-registry');
        assert.equal(result.exitCode, 0); assert.ok(result.stdoutEnded && result.stderrEnded);
        assert.deepEqual(result.diagnostics, ['handler-event-routing-only; two pools joined; no native work']);
    });
    nodeTest('control isolation guard fixed categories distinguish body failure from cancellation without raw payloads', async () => {
        for (const [id, outcome] of [['probe:assertion', 'assertion-failed'], ['probe:other-failure', 'other-failed'],
            ['probe:abort-after-body', 'completed-after-abort']] as const) {
            const pool = new ControlPool(); await assert.rejects(pool.run(id), /CONTROL_ISOLATION_FAILED/);
            assert.equal(pool.joined[0].body?.outcome, outcome);
            assert.doesNotMatch(JSON.stringify(pool.joined[0].body), /PRIVATE_DIAGNOSTIC_CANARY/);
            const [completion, cancellation] = pool.receipts;
            assert.equal(completion.kind, 'completion'); assert.equal(completion.controlId, id);
            assert.equal(cancellation.kind, 'cancel'); assert.equal(cancellation.category, 'body-result');
            assert.equal(cancellation.controlId, id); assert.ok(completion.sequence < cancellation.sequence);
            assert.ok(completion.receivedAt <= cancellation.receivedAt);
        }
        const pool = new ControlPool(), pending = pool.run('probe:never', undefined, new SharedArrayBuffer(16));
        const result = Promise.allSettled([pending]); pool.cancel(); await result;
        assert.equal(pool.joined[0].body?.outcome, 'aborted-before-body');
    });
    nodeTest('control isolation guard rejects unknown diagnostic fields and nonnumeric native availability', async () => {
        for (const id of ['probe:malformed-body', 'probe:extra-body-field', 'probe:bad-native']) {
            const pool = new ControlPool(); await assert.rejects(pool.run(id), /CONTROL_ISOLATION_FAILED/);
            assert.equal(pool.joined[0].body, undefined);
            assert.equal(pool.receipts[0].kind, 'cancel'); assert.equal(pool.receipts[0].category, 'protocol');
        }
    });
    nodeTest('control native cancellation guard closes two admitted Jobs before joining and refuses queued admission', async t => {
        const state = new SharedArrayBuffer(16), words = new Int32Array(state), pool = new ControlPool();
        const settled = Promise.allSettled([pool.run('probe:native-abort', 60000, state),
            pool.run('probe:native-abort', 60000, state), pool.run('probe:never', undefined, state)]);
        let admitted = false;
        try { await until(() => Atomics.load(words, 0) === 2, 60000); admitted = true; }
        catch { /* Refuse only after all admitted work has joined below. */ }
        finally { pool.cancel(); }
        assert.ok((await settled).every(value => value.status === 'rejected'));
        assert.ok(admitted, 'both actual runtime stages must be admitted');
        assert.equal(pool.launched, 2); assert.equal(pool.active, 0); assert.equal(Atomics.load(words, 3), 0);
        assert.equal(pool.joined.length, 2);
        for (const joined of pool.joined) {
            assert.equal(joined.exitCode, 0); assert.ok(joined.stdoutEnded && joined.stderrEnded);
            assert.equal(joined.diagnostics.length, 1);
            const evidence = JSON.parse(joined.diagnostics[0]);
            assert.equal(evidence.observation, 'native-cancellation-guard');
            assert.equal(evidence.assertionsComplete, true);
            t.diagnostic(JSON.stringify({ ...evidence, token: joined.token, workerExitCode: joined.exitCode,
                stdoutEnded: joined.stdoutEnded, stderrEnded: joined.stderrEnded }));
        }
    });
}

const isolationFailure = () => new Error('CONTROL_ISOLATION_FAILED');
const ownerUrl = new URL(import.meta.url);
const ownerHash = createHash('sha256').update(readFileSync(ownerUrl)).digest('hex');
type JoinedControl = { token: string; exitCode: number; stdout: string; stderr: string;
    stdoutEnded: boolean; stderrEnded: boolean; diagnostics: string[]; body?: BodyDiagnostic };
type CancelCategory = 'requested' | 'interrupt' | 'body-result' | 'case-deadline' | 'protocol' | 'worker-error' | 'output' | 'worker-lifecycle';
type ControlReceipt = { kind: 'completion' | 'cancel'; sequence: number; receivedAt: number; controlId: string | null;
    category?: CancelCategory; body?: BodyDiagnostic; token?: string };
type Request = { id: string; timeout?: number; state?: SharedArrayBuffer;
    resolve(value: JoinedControl): void; reject(error: Error): void };
const activePools = new Set<ControlPool>();
let interrupted = false;
function installInterruptRouting() {
    const cancel = () => {
        interrupted = true;
        for (const pool of [...activePools]) pool.cancel('interrupt');
    };
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    return () => { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); };
}
class ControlPool {
    active = 0; maximumActive = 0; launched = 0;
    readonly joined: JoinedControl[] = [];
    readonly receipts: ControlReceipt[] = [];
    private sequence = 0;
    private original = false;
    private failed = false;
    private queue: Request[] = [];
    private inflight = new Set<() => void>();
    run(id: string, timeout?: number, state?: SharedArrayBuffer): Promise<JoinedControl> {
        if (this.failed || interrupted) return Promise.reject(isolationFailure());
        this.original ||= id.startsWith('control:');
        activePools.add(this);
        return new Promise((resolve, reject) => { this.queue.push({ id, timeout, state, resolve, reject }); this.pump(); });
    }
    cancel(category: CancelCategory = 'requested', controlId: string | null = null) {
        if (!this.failed) this.record({ kind: 'cancel', category, controlId });
        this.failed = true;
        for (const request of this.queue.splice(0)) request.reject(isolationFailure());
        for (const cancel of this.inflight) cancel();
        this.unregisterWhenJoined();
    }
    private record(value: Omit<ControlReceipt, 'sequence' | 'receivedAt'>) {
        const receipt = { ...value, sequence: ++this.sequence, receivedAt: performance.now() };
        this.receipts.push(receipt);
        if (this.original) process.stdout.write(JSON.stringify({ observation: 'control-receipt', ownerSha256: ownerHash, ...receipt }) + '\n');
    }
    private unregisterWhenJoined() { if (this.active === 0 && this.queue.length === 0) activePools.delete(this); }
    private pump() {
        while (!this.failed && this.active < 2 && this.queue.length) {
            const request = this.queue.shift()!;
            this.active++; this.launched++; this.maximumActive = Math.max(this.maximumActive, this.active);
            void this.execute(request).then(result => {
                this.active--;
                if (this.failed) request.reject(isolationFailure()); else request.resolve(result);
                this.pump(); this.unregisterWhenJoined();
            }, () => { this.active--; this.cancel('worker-lifecycle', request.id); request.reject(isolationFailure()); });
        }
    }
    private async execute(request: Request): Promise<JoinedControl> {
        const token = randomUUID();
        const worker = new Worker(ownerUrl, { workerData: { owner: 'governed-control-v1', id: request.id,
            token, hash: ownerHash, state: request.state }, stdout: true, stderr: true });
        let invalid = false, ready = false, completed = false, ok = false;
        const result: JoinedControl = { token, exitCode: -1, stdout: '', stderr: '', stdoutEnded: false, stderrEnded: false, diagnostics: [] };
        const cancel = () => { invalid = true; worker.postMessage({ kind: 'abort', token }); };
        this.inflight.add(cancel);
        // Case deadlines request cooperative cancellation; they never abandon a
        // Worker or substitute terminate()/exit for the runner's native proof.
        const timer = request.timeout === undefined ? undefined : setTimeout(() => this.cancel('case-deadline', request.id), request.timeout);
        const drain = (stream: NodeJS.ReadableStream, channel: 'stdout' | 'stderr') => new Promise<void>(resolve => {
            stream.on('data', (bytes: Buffer) => {
                if (Buffer.byteLength(result[channel]) + bytes.length > 8 * 1024 * 1024) { invalid = true; this.cancel('output', request.id); }
                else result[channel] += bytes.toString('utf8');
            });
            stream.once('end', () => { result[channel === 'stdout' ? 'stdoutEnded' : 'stderrEnded'] = true; resolve(); });
            stream.once('error', () => { invalid = true; this.cancel('output', request.id); resolve(); });
            stream.once('close', () => { if (!result[channel === 'stdout' ? 'stdoutEnded' : 'stderrEnded']) { invalid = true; resolve(); } });
        });
        const drained = Promise.all([drain(worker.stdout!, 'stdout'), drain(worker.stderr!, 'stderr')]);
        worker.on('message', value => {
            if (!value || value.id !== request.id || value.token !== token || value.hash !== ownerHash) { invalid = true; this.cancel('protocol', request.id); return; }
            if (value.kind === 'ready' && !ready && !completed && Object.keys(value).length === 4) {
                ready = true; worker.postMessage({ kind: 'start', token });
            } else if (value.kind === 'complete' && ready && !completed && Object.keys(value).length === 7
                && typeof value.ok === 'boolean' && Array.isArray(value.diagnostics)
                && validBody(value.body) && value.ok === (value.body.outcome === 'completed')
                && value.diagnostics.every((entry: unknown) => typeof entry === 'string' && entry.length < 1048576)) {
                completed = true; ok = value.ok; result.diagnostics = value.diagnostics; result.body = value.body;
                this.record({ kind: 'completion', controlId: request.id, token, body: value.body });
                if (!ok) this.cancel('body-result', request.id);
            } else { invalid = true; this.cancel('protocol', request.id); }
        });
        worker.once('error', () => { invalid = true; this.cancel('worker-error', request.id); });
        try {
            result.exitCode = await new Promise<number>(resolve => worker.once('exit', resolve));
            await drained;
            if (invalid || !ready || !completed || !ok || result.exitCode !== 0 || !result.stdoutEnded || !result.stderrEnded) throw isolationFailure();
            return result;
        } finally {
            clearTimeout(timer); this.inflight.delete(cancel);
            this.joined.push(result);
            if (request.id.startsWith('control:')) {
                // Only the existing safe runner records cross this boundary.
                // Arbitrary worker errors/output never become a diagnostic lane.
                for (const line of result.stdout.split('\n').filter(Boolean)) {
                    try {
                        const record = JSON.parse(line);
                        if (!(record.gate === 'v2-governed-summary-commands'
                            || ['candidate', 'measured-artifacts', 'compiled-inputs'].includes(record.observation))) throw isolationFailure();
                        process.stdout.write(JSON.stringify({ ...record, controlId: request.id, controlToken: token }) + '\n');
                    } catch { invalid = true; }
                }
                for (const line of result.stderr.split('\n').filter(Boolean)) {
                    if (['GOVERNED_SUMMARY_COMMANDS_GATE_FAILED', 'FOUNDATION_OUTPUT_BUSY',
                        'VERIFIED_READ_OUTPUT_CLOSURE_UNCONFIRMED'].includes(line)) process.stderr.write(line + '\n');
                    else invalid = true;
                }
                process.stdout.write(JSON.stringify({ observation: 'control-lifecycle', controlId: request.id, token,
                    completed, ok, exitCode: result.exitCode, stdoutEnded: result.stdoutEnded, stderrEnded: result.stderrEnded,
                    nativeClosure: 'asserted-only-by-original-body', disposition: invalid ? 'uncertain' : 'joined' }) + '\n');
            }
            if (invalid) throw isolationFailure();
        }
    }
}

async function until(predicate: () => boolean, timeout = 10000) {
    const limit = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() >= limit) throw isolationFailure();
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

async function probe(id: string, state: SharedArrayBuffer | undefined, diagnostics: string[]) {
    const words = state && new Int32Array(state);
    if (id === 'probe:assertion') assert.fail('PRIVATE_DIAGNOSTIC_CANARY');
    else if (id === 'probe:other-failure') throw new Error('PRIVATE_DIAGNOSTIC_CANARY');
    else if (id === 'probe:abort-after-body') realmAbort.abort();
    else if (id === 'probe:mutate') {
        const read = fs.readFileSync, originalSpawn = childProcess.spawn, write = process.stdout.write,
            error = process.stderr.write, platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        try {
            fs.readFileSync = (() => Buffer.from('isolated')) as unknown as typeof read;
            childProcess.spawn = (() => { throw isolationFailure(); }) as typeof spawn;
            process.stdout.write = (() => true) as typeof write; process.stderr.write = (() => true) as typeof error;
            Object.defineProperty(process, 'platform', { ...platform, value: 'isolated' }); syncBuiltinESMExports();
            assert.equal(readFileSync(ownerUrl).toString(), 'isolated'); assert.throws(() => spawn('unused'), /CONTROL_ISOLATION_FAILED/);
            assert.equal(process.platform, 'isolated');
            Atomics.store(words!, 0, 1); await until(() => Atomics.load(words!, 1) === 1);
        } finally {
            fs.readFileSync = read; childProcess.spawn = originalSpawn; process.stdout.write = write; process.stderr.write = error;
            Object.defineProperty(process, 'platform', platform); syncBuiltinESMExports();
        }
    } else if (id === 'probe:companion') {
        await until(() => Atomics.load(words!, 0) === 1);
        assert.equal(createHash('sha256').update(readFileSync(ownerUrl)).digest('hex'), ownerHash);
        assert.equal(readFileSync, fs.readFileSync); assert.equal(spawn, childProcess.spawn);
        assert.notEqual(process.platform, 'isolated');
        process.stdout.write('CONTROL_GUARD_DRAIN\n'); process.stderr.write('CONTROL_GUARD_DRAIN\n');
        Atomics.store(words!, 1, 1);
    } else if (id === 'probe:bounded') {
        const active = Atomics.add(words!, 0, 1) + 1;
        Atomics.store(words!, 1, Math.max(Atomics.load(words!, 1), active));
        assert.ok(active <= 2); await until(() => Atomics.load(words!, 1) === 2);
        await new Promise(resolve => setTimeout(resolve, 20));
        Atomics.sub(words!, 0, 1);
        // Completion is intentionally followed by a scheduled write below:
        // the parent must wait for normal exit and both drained streams.
        setTimeout(() => { process.stdout.write('CONTROL_GUARD_DRAIN\n'); process.stderr.write('CONTROL_GUARD_DRAIN\n'); }, 20);
    } else if (id === 'probe:wait-abort') {
        Atomics.store(words!, 0, 1);
        try { await until(() => realmAbort.signal.aborted); }
        finally { await new Promise(resolve => setTimeout(resolve, 20)); Atomics.store(words!, 2, 1); }
    } else if (id === 'probe:fail') {
        await until(() => Atomics.load(words!, 0) === 1); throw isolationFailure();
    } else if (id === 'probe:interrupt-registry') {
        const a = new SharedArrayBuffer(16), b = new SharedArrayBuffer(16);
        const first = new ControlPool(), second = new ControlPool();
        const listeners = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
        const uninstall = installInterruptRouting();
        const settled = Promise.allSettled([first.run('probe:wait-abort', undefined, a), second.run('probe:wait-abort', undefined, b)]);
        let admitted = false;
        try {
            await until(() => Atomics.load(new Int32Array(a), 0) === 1 && Atomics.load(new Int32Array(b), 0) === 1);
            assert.equal(activePools.size, 2); admitted = true;
        } catch { /* Event routing below must still join admitted work. */ }
        finally { process.emit('SIGINT'); }
        const outcomes = await settled;
        uninstall();
        assert.ok(admitted); assert.ok(outcomes.every(value => value.status === 'rejected'));
        assert.equal(activePools.size, 0); assert.equal(first.active + second.active, 0);
        assert.equal(Atomics.load(new Int32Array(a), 2), 1); assert.equal(Atomics.load(new Int32Array(b), 2), 1);
        await assert.rejects(new ControlPool().run('probe:never', undefined, a), /CONTROL_ISOLATION_FAILED/);
        assert.equal(Atomics.load(new Int32Array(a), 3), 0);
        assert.deepEqual([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')], listeners);
        diagnostics.push('handler-event-routing-only; two pools joined; no native work');
    } else if (id === 'probe:native-abort') {
        const f = fixture();
        f.put('scripts/check-runtime.js', record + "log('runtime');setTimeout(()=>process.exit(0),30000);"); f.commit();
        f.observeAdmission(() => Atomics.add(words!, 0, 1));
        const result = await f.run({ timeoutMs: 60000 });
        refused(f, result); assert.ok(realmAbort.signal.aborted);
        // CreateProcess admission precedes execution of the child's first JS
        // instruction. Cancellation may therefore leave no runtime trace.
        assert.ok(f.trace().length <= 1 && f.trace().every(value => value === 'runtime')); assert.equal(f.native.length, 1);
        const actual = f.native[0], receipt = f.events.find(event => event.stage);
        assert.ok(actual.started && actual.direct && actual.closure && actual.closed);
        assert.ok(Number.isInteger(actual.direct.nativeCode)); assert.equal(actual.closure.activeProcesses, 0);
        assert.equal(receipt.cleanup, 'complete'); assert.equal(receipt.closure, 'windows-job-active-zero');
        assert.equal(receipt.code, 130); assert.equal(existsSync(join(f.root, '.fresh-start-foundation.lock')), false);
        diagnostics.push(JSON.stringify({ observation: 'native-cancellation-guard', assertionsComplete: true,
            root: f.root, direct: actual.direct, closure: actual.closure, bridgeClosed: actual.closed, receipt,
            trace: f.trace(), laterStages: 0, qualification: false, lockPresent: false }));
    } else if (id === 'probe:never') { Atomics.store(words!, 3, 1); }
    else if (id === 'probe:exit') { process.exit(0); }
    else if (!['probe:missing', 'probe:malformed', 'probe:duplicate', 'probe:wrong-id', 'probe:wrong-token', 'probe:premature',
        'probe:malformed-body', 'probe:extra-body-field', 'probe:bad-native'].includes(id)) throw isolationFailure();
}

async function runRealm() {
    const data = workerData;
    assert.ok(parentPort && data?.owner === 'governed-control-v1' && data.hash === ownerHash && typeof data.token === 'string');
    const port = parentPort!;
    const envelope = (kind: string) => ({ kind, id: data.id, token: data.token, hash: ownerHash });
    const diagnostics: string[] = [];
    const completed = (body: BodyDiagnostic) => ({ ...envelope('complete'), ok: body.outcome === 'completed', diagnostics, body });
    let start!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    port.on('message', value => {
        if (value?.token !== data.token) { realmAbort.abort(); start(); }
        else if (value.kind === 'abort') { realmAbort.abort(); start(); }
        else if (value.kind === 'start') start();
        else { realmAbort.abort(); start(); }
    });
    if (data.id === 'probe:premature') port.postMessage(completed(bodyDiagnostic('completed', false)));
    port.postMessage(envelope('ready')); await started;
    let outcome: BodyDiagnostic['outcome'] = 'aborted-before-body', abortBeforeCatch = false;
    try {
        if (realmAbort.signal.aborted) throw isolationFailure();
        outcome = 'other-failed';
        if (typeof data.id === 'string' && data.id.startsWith('probe:')) await probe(data.id, data.state, diagnostics);
        else {
            const index = controls.findIndex((_value, index) => data.id === 'control:' + index);
            assert.ok(index >= 0); await controls[index].body({ diagnostic(message) { diagnostics.push(message); } });
        }
        outcome = realmAbort.signal.aborted ? 'completed-after-abort' : 'completed';
    } catch (error) {
        abortBeforeCatch = realmAbort.signal.aborted;
        if (outcome !== 'aborted-before-body') outcome = error instanceof AssertionError ? 'assertion-failed' : 'other-failed';
        realmAbort.abort();
    }
    finally {
        // Real gate promises always settle through their unchanged runner. A
        // body exception is never permission to abandon an in-flight Job.
        await Promise.allSettled([...pendingGates]);
        const result = completed(bodyDiagnostic(outcome, abortBeforeCatch));
        if (data.id === 'probe:malformed') port.postMessage({ ...result, ok: 'true' });
        else if (data.id === 'probe:malformed-body') port.postMessage({ ...result, body: { ...result.body, phase: 'PRIVATE_DIAGNOSTIC_CANARY' } });
        else if (data.id === 'probe:extra-body-field') port.postMessage({ ...result, body: { ...result.body, message: 'PRIVATE_DIAGNOSTIC_CANARY' } });
        else if (data.id === 'probe:bad-native') port.postMessage({ ...result, body: { ...result.body, native: [{ ordinal: 1, ready: true,
            started: true, direct: true, closure: false, closed: false, closeObserved: false, closeCode: null,
            directCode: 'PRIVATE_DIAGNOSTIC_CANARY', closureCode: null, activeProcesses: null }] } });
        else if (data.id === 'probe:wrong-id') port.postMessage({ ...result, id: 'control:other' });
        else if (data.id === 'probe:wrong-token') port.postMessage({ ...result, token: 'other' });
        else if (data.id !== 'probe:missing') { port.postMessage(result); if (data.id === 'probe:duplicate') port.postMessage(result); }
        port.close();
    }
}

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
const failure = 'GOVERNED_SUMMARY_COMMANDS_GATE_FAILED';
type Run = (options: { root: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<void>;
async function gate(): Promise<Run> {
    const module: any = await import(new URL('../../scripts/run-v2-governed-summary-commands.js', import.meta.url).href);
    return module.runGovernedSummaryCommandsGate;
}
const footer = 'ℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 1\n';

// All fixtures are retained, especially missing/replaced ownership. No teardown
// infers release from a PID, elapsed interval, child exit or fabricated Job frame.
function physicalSnapshot(root: string): Map<string, string> {
    const result = new Map<string, string>();
    function visit(relative: string) {
        const path = join(root, relative), stat = fs.lstatSync(path, { bigint: true });
        assert.equal(stat.isSymbolicLink(), false);
        const actual = realpathSync.native(path);
        assert.equal(process.platform === 'win32' ? actual.toLowerCase() : actual, process.platform === 'win32' ? path.toLowerCase() : path);
        if (stat.isDirectory()) {
            for (const name of fs.readdirSync(path).sort()) visit(relative ? relative + '/' + name : name);
        } else {
            assert.ok(stat.isFile()); assert.equal(stat.nlink, 1n);
            result.set(relative, createHash('sha256').update(readFileSync(path)).digest('hex'));
        }
    }
    visit(''); return result;
}
function fixtureGit(root: string, ...args: string[]) {
    phase = 'fixture-git';
    const operation = args.includes('commit') ? 'commit' : gitOperations.find(value => value === args[0]) ?? 'other';
    gitDiagnostic = { operation, status: null, category: 'launch' };
    const result = spawnSync('git', ['--git-dir', join(root, '.git'), '--work-tree', root, '-C', root, ...args],
        { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    gitDiagnostic = { operation, status: result.status, category: result.error
        ? (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'timeout' : result.status === null ? 'launch' : 'other' : 'none' };
    assert.equal(result.status, 0, result.stderr); return result.stdout;
}
const record = "import{appendFileSync}from'node:fs';const log=x=>appendFileSync('trace',x+'\\n');";
let staticSeed: { root: string; files: Map<string, string> } | undefined;
function seedRoot() {
    if (staticSeed) {
        assert.deepEqual(physicalSnapshot(staticSeed.root), staticSeed.files);
        return staticSeed;
    }
    phase = 'fixture-write';
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'governed-gate-seed-')));
    const put = (path: string, value: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
    const git = (...args: string[]) => fixtureGit(root, ...args);
    put('package.json', '{"type":"module"}');
    put('.gitignore', 'node_modules/\ndist/\ndist-test/\ntrace\n');
    put('docs/input.md', 'tracked documentation'); put('memory/note.md', 'mutable vault');
    put('src/input.ts', 'export const input=1;'); put('tests/input.ts', 'export {};'); put('tsconfig.test.json', '{}');
    put('node_modules/synthetic/input.js', 'export const dependency=1;');
    put('scripts/check-runtime.js', record + "log('runtime');process.exit(0);");
    put('node_modules/typescript/bin/tsc', record + "const a=process.argv.slice(2);if(JSON.stringify(a)==='[\"--noEmit\"]')log('typecheck');else if(JSON.stringify(a)==='[\"-p\",\"tsconfig.test.json\"]')log('compile');else process.exit(79);process.exit(0);");
    put('scripts/build.js', record + `log('build');
import{mkdirSync,writeFileSync,readFileSync}from'node:fs';import{createHash}from'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');const canon=v=>Array.isArray(v)?'['+v.map(canon).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}':JSON.stringify(v);
const paths=['v2.js','v2-admin.js','workers/project-store.worker.js','internal/v2-internal-verified-read.js','internal/v2-internal-verified-read-cleanup.js'];
const artifacts=paths.map(path=>{mkdirSync('dist/'+path.split('/').slice(0,-1).join('/'),{recursive:true});writeFileSync('dist/'+path,path);return{path,bytes:Buffer.byteLength(path),sha256:sha(path)}});
for(const artifact of artifacts.slice(3)){const path='node_modules/synthetic/input.js',bytes=readFileSync(path);writeFileSync('dist/'+artifact.path+'.closure.json',JSON.stringify({artifact,inputs:[{path,bytes:bytes.length,sha256:sha(bytes)}],sourceChecked:true,emittedChecked:true}));}
const body={schemaVersion:1,deploymentId:'synthetic-owned',runtime:{nodeVersion:process.versions.node,platform:process.platform,arch:process.arch,executableSha256:sha(readFileSync(process.execPath))},artifacts};writeFileSync('dist/v2-build.json',JSON.stringify({...body,buildIdentityHash:sha(canon(body))}));process.exit(0);`);
    put('scripts/smoke-worker.js', record + "log('worker-smoke');process.exit(0);");
    put('scripts/smoke-v2-fresh-start.js', record + "log('fresh-start-smoke');process.exit(0);");
    git('init', '--quiet'); git('config', 'core.symlinks', 'false');
    const commit = () => { git('add', '--', 'package.json', '.gitignore', 'src', 'tests', 'scripts', 'docs', 'memory', 'tsconfig.test.json'); git('-c', 'user.name=Owned Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'owned fixture'); };
    commit();
    for (const path of ['.git/objects/info/alternates', '.git/objects/info/http-alternates', '.git/commondir', 'dist', 'dist-test', 'trace', '.fresh-start-foundation.lock']) assert.equal(existsSync(join(root, path)), false);
    staticSeed = { root, files: physicalSnapshot(root) }; return staticSeed;
}
function fixture() {
    phase = 'fixture-write';
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'governed-gate-')));
    const source = seedRoot(), seed = source.root;
    phase = 'fixture-copy';
    for (const path of source.files.keys()) {
        const target = join(root, path); mkdirSync(dirname(target), { recursive: true });
        fs.copyFileSync(join(seed, path), target, fs.constants.COPYFILE_EXCL);
        const before = fs.lstatSync(join(seed, path), { bigint: true }), after = fs.lstatSync(target, { bigint: true });
        assert.equal(after.nlink, 1n); assert.notEqual(`${before.dev}:${before.ino}`, `${after.dev}:${after.ino}`);
    }
    assert.deepEqual(physicalSnapshot(root), source.files);
    const put = (path: string, value: string) => { phase = 'fixture-write'; mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
    const git = (...args: string[]) => fixtureGit(root, ...args);
    const commit = () => { git('add', '--', 'package.json', '.gitignore', 'src', 'tests', 'scripts', 'docs', 'memory', 'tsconfig.test.json'); git('-c', 'user.name=Owned Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'owned fixture'); };
    for (const name of names) put(`dist-test/tests/${name}.test.js`, record + `import{test}from'node:test';test('${name}',()=>log('${name}'));`);
    for (const path of privatePaths) put('dist-test/' + path, 'export {};');
    put('dist-test/unlisted.map', 'whole compiled tree');
    const events: any[] = [], native: any[] = [];
    const trace = () => existsSync(join(root, 'trace')) ? readFileSync(join(root, 'trace'), 'utf8').trim().split('\n') : [];
    let outputFault: ((actual: string) => string) | undefined, protocolFault = '', faultStage = 5;
    let onEvent: ((event: any) => void) | undefined;
    let onAdmission: (() => void) | undefined;
    let released = false, publicationAfterRelease = false;
    let lockIdentity: { dev: bigint; ino: bigint } | undefined, releaseAttempt: any;
    async function run(options: { timeoutMs?: number; signal?: AbortSignal; unlinkFault?: boolean; closeFault?: boolean } = {}) {
        phase = 'gate';
        const originalSpawn = childProcess.spawn, write = process.stdout.write, errorWrite = process.stderr.write, unlink = fs.unlinkSync, close = fs.closeSync;
        let errorsBeforeRelease = '';
        process.stderr.write = function (chunk: any, ...args: any[]) { errorsBeforeRelease += String(chunk); return Reflect.apply(errorWrite, process.stderr, [chunk, ...args]); } as typeof errorWrite;
        const controller = new AbortController(), cancel = () => controller.abort();
        options.signal?.addEventListener('abort', cancel, { once: true }); if (options.signal?.aborted) cancel();
        realmAbort.signal.addEventListener('abort', cancel, { once: true }); if (realmAbort.signal.aborted) cancel();
        const watchdog = setTimeout(cancel, 180000);
        let helpers = 0, ownedDescriptor: number | undefined;
        const open = fs.openSync;
        fs.openSync = ((path: any, ...args: any[]) => { const fd = Reflect.apply(open, fs, [path, ...args]); if (path === join(root, '.fresh-start-foundation.lock')) { ownedDescriptor = fd; lockIdentity = fs.fstatSync(fd, { bigint: true }); } return fd; }) as typeof open;
        fs.closeSync = ((fd: number) => { if (options.closeFault && fd === ownedDescriptor) throw new Error('injected close'); return close(fd); }) as typeof close;
        fs.unlinkSync = ((path: any) => { if (path === join(root, '.fresh-start-foundation.lock')) { if (options.unlinkFault) { const current = fs.lstatSync(path, { bigint: true }); releaseAttempt = { stageCount: events.filter(event => event.stage).length, errorsBeforeRelease, dev: current.dev, ino: current.ino }; throw new Error('injected unlink'); } unlink(path); released = true; return; } return unlink(path); }) as typeof unlink;
        process.stdout.write = function (chunk: any, ...args: any[]) {
            if (typeof chunk === 'string') {
                try { const event = JSON.parse(chunk); events.push(event); if (event.observation === 'qualification') publicationAfterRelease = released && !existsSync(join(root, '.fresh-start-foundation.lock')); onEvent?.(event); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
            }
            return Reflect.apply(write, process.stdout, [chunk, ...args]);
        } as typeof write;
        childProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => {
            const child = originalSpawn(...args);
            if (args[2]?.cwd !== root || !args[1]?.some(arg => arg.endsWith('v2-verified-read-job.ps1'))) return child;
            const index = ++helpers, proof: any = { index, closed: false }; native.push(proof); observedHelpers.push(proof);
            const out = child.stdout!, register = out.on; let observed = '', buffered = '', captured = '';
            register.call(out, 'data', (chunk: Buffer) => {
                observed += chunk.toString(); let end;
                while ((end = observed.indexOf('\n')) >= 0) { const line = observed.slice(0, end); observed = observed.slice(end + 1); const value = JSON.parse(line); if (value.kind === 'ready') proof.ready = true; if (value.kind === 'started') { proof.started = true; onAdmission?.(); } if (value.kind === 'direct-exit') proof.direct = value; if (value.kind === 'closure') proof.closure = value; }
            });
            child.once('close', (code, signal) => { proof.closeObserved = true; proof.closeCode = code; proof.closed = code === 0 && signal === null; });
            if (index === faultStage && (outputFault || protocolFault)) {
                out.on = ((event: any, listener: any) => {
                    if (event !== 'data') return Reflect.apply(register, out, [event, listener]);
                    return Reflect.apply(register, out, [event, (chunk: Buffer) => {
                        buffered += chunk.toString(); let end;
                        while ((end = buffered.indexOf('\n')) >= 0) {
                            const line = buffered.slice(0, end); buffered = buffered.slice(end + 1); const value = JSON.parse(line);
                            if (value.kind === 'stdout' && outputFault) { captured += Buffer.from(value.bytes, 'base64').toString('utf8'); continue; }
                            if (value.kind === 'direct-exit' && protocolFault === 'missing-direct') continue;
                            if (value.kind === 'closure') {
                                if (outputFault) { const changed = Buffer.from(outputFault(captured)); for (let offset = 0; offset < changed.length; offset += 4096) listener(Buffer.from(JSON.stringify({ kind: 'stdout', bytes: changed.subarray(offset, offset + 4096).toString('base64') }) + '\n')); }
                                if (protocolFault === 'missing-closure') continue;
                                if (protocolFault === 'active') { listener(Buffer.from(JSON.stringify({ ...value, activeProcesses: 1 }) + '\n')); continue; }
                                if (protocolFault === 'fragment') { listener(Buffer.from(line + '\n{')); continue; }
                            }
                            listener(Buffer.from(line + '\n'));
                        }
                    }]);
                }) as typeof out.on;
            }
            return child;
        }) as typeof originalSpawn;
        syncBuiltinESMExports();
        let execution: Promise<void> | undefined;
        try {
            execution = (await gate())({ root, timeoutMs: options.timeoutMs, signal: controller.signal });
            pendingGates.add(execution);
            const value = await execution; phase = 'body'; return { ok: true, value };
        }
        catch (error) { assert.equal((error as Error).message, failure); phase = 'body'; return { ok: false, value: undefined }; }
        finally { if (execution) pendingGates.delete(execution); clearTimeout(watchdog); options.signal?.removeEventListener('abort', cancel); realmAbort.signal.removeEventListener('abort', cancel); process.stdout.write = write; process.stderr.write = errorWrite; childProcess.spawn = originalSpawn; fs.unlinkSync = unlink; fs.closeSync = close; fs.openSync = open; syncBuiltinESMExports(); }
    }
    return { root, seed, put, git, commit, events, native, trace, run,
        faultOutput(value: (actual: string) => string) { outputFault = value; },
        faultProtocol(value: string) { protocolFault = value; faultStage = 1; },
        observe(value: (event: any) => void) { onEvent = value; },
        observeAdmission(value: () => void) { onAdmission = value; },
        publishedAfterRelease: () => publicationAfterRelease, releaseObservation: () => ({ lockIdentity, releaseAttempt }) };
}
function refused(f: ReturnType<typeof fixture>, result: { ok: boolean }) {
    assert.equal(result.ok, false); assert.equal(f.events.filter(event => event.observation === 'qualification').length, 0);
}

test('static seed copies own independent Git and worktree files without inherited evidence', t => {
    const first = fixture(), second = fixture();
    const seedBefore = physicalSnapshot(first.seed);
    assert.equal(first.seed, second.seed);
    for (const path of seedBefore.keys()) {
        const seed = fs.lstatSync(join(first.seed, path), { bigint: true });
        const a = fs.lstatSync(join(first.root, path), { bigint: true });
        const b = fs.lstatSync(join(second.root, path), { bigint: true });
        assert.equal(seed.nlink, 1n); assert.equal(a.nlink, 1n); assert.equal(b.nlink, 1n);
        assert.notEqual(`${seed.dev}:${seed.ino}`, `${a.dev}:${a.ino}`);
        assert.notEqual(`${a.dev}:${a.ino}`, `${b.dev}:${b.ino}`);
    }
    for (const root of [first.seed, first.root, second.root]) {
        for (const path of ['.fresh-start-foundation.lock', 'trace', 'dist', '.git/objects/info/alternates', '.git/objects/info/http-alternates', '.git/commondir']) assert.equal(existsSync(join(root, path)), false);
    }
    assert.equal(existsSync(join(first.seed, 'dist-test')), false);
    const secondBefore = physicalSnapshot(second.root);
    first.put('src/input.ts', 'export const changed=2;'); first.commit();
    assert.deepEqual(physicalSnapshot(first.seed), seedBefore);
    assert.deepEqual(physicalSnapshot(second.root), secondBefore);
    assert.equal(first.git('status', '--porcelain').trim(), '');
    assert.equal(second.git('status', '--porcelain').trim(), '');
    assert.equal(first.events.length + second.events.length + first.native.length + second.native.length, 0);
    t.diagnostic(JSON.stringify({ staticSeed: first.seed, seedFiles: seedBefore.size,
        seedInventorySha256: createHash('sha256').update(JSON.stringify([...seedBefore])).digest('hex'),
        physicalRoots: [first.seed, first.root, second.root].map(root => {
            const stat = fs.lstatSync(root, { bigint: true }), index = fs.lstatSync(join(root, '.git/index'), { bigint: true });
            return { root, dev: stat.dev.toString(), ino: stat.ino.toString(), indexDev: index.dev.toString(), indexIno: index.ino.toString() };
        }) }));
});

test('fixed inventory resolves void only after 34 real contained stages and owned final release', { timeout: 180000 }, async () => {
    const f = fixture(); f.put('memory/note.md', 'approved mutable memory');
    const result = await f.run(); assert.equal(result.ok, true); assert.equal(result.value, undefined);
    assert.deepEqual(f.trace(), ['runtime', 'typecheck', 'build', 'compile', ...names, 'worker-smoke', 'fresh-start-smoke']);
    const receipts = f.events.filter(event => event.stage); assert.equal(receipts.length, 34);
    assert.equal(receipts.filter(event => event.counts).length, 28);
    assert.equal(f.events.filter(event => event.observation === 'qualification').length, 1);
    assert.ok(f.publishedAfterRelease()); assert.equal(f.native.length, 34);
    assert.ok(f.native.every(value => value.direct.nativeCode === 0 && value.closure.activeProcesses === 0 && value.closed));
    const q = f.events.find(event => event.observation === 'qualification');
    assert.equal(q.compiledMeasurement.privateClosure.length, 13); assert.equal(q.compiledMeasurement.listedTests.length, 28);
    assert.equal(q.measurement.artifacts.length, 5); assert.equal(q.measurement.closures.length, 2);
    assert.equal(q.profile, 'governed-summary-commands'); assert.equal(q.totalMs, 2100000); assert.equal(q.tests, 28);
});

test('invalid total budgets and pre-abort launch nothing', async () => {
    const f = fixture();
    for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2100001]) refused(f, await f.run({ timeoutMs }));
    const c = new AbortController(); c.abort(); refused(f, await f.run({ signal: c.signal }));
    assert.deepEqual(f.trace(), []); assert.equal(f.native.length, 0);
});

for (const mode of ['docs-dirty', 'source-dirty', 'untracked', 'ignored', 'assume-unchanged', 'skip-worktree', 'docs-assume', 'source-mode', 'docs-mode', 'directory'] as const) {
    test(`source identity refuses ${mode} before native launch`, async () => {
        const f = fixture();
        if (mode === 'docs-dirty') f.put('docs/input.md', 'dirty');
        if (mode === 'source-dirty') f.put('src/input.ts', 'dirty');
        if (mode === 'untracked') f.put('scripts/extra.js', 'untracked');
        if (mode === 'ignored') { f.put('.git/info/exclude', 'scripts/hidden.js\n'); f.put('scripts/hidden.js', 'ignored'); }
        if (mode === 'assume-unchanged' || mode === 'skip-worktree') { f.git('update-index', '--' + mode, 'src/input.ts'); f.put('src/input.ts', 'hidden'); }
        if (mode === 'docs-assume') { f.git('update-index', '--assume-unchanged', 'docs/input.md'); f.put('docs/input.md', 'hidden docs'); }
        if (mode === 'source-mode' || mode === 'docs-mode') {
            const path = mode === 'source-mode' ? 'src/input.ts' : 'docs/input.md';
            const oid = f.git('rev-parse', 'HEAD:' + path).trim(); f.git('update-index', '--cacheinfo', '120000,' + oid + ',' + path);
            f.git('-c', 'user.name=Owned Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'noncanonical mode');
            assert.equal(f.git('diff', '--name-only', 'HEAD').trim(), '', 'mode is independently clean, not a dirty-file surrogate');
        }
        if (mode === 'directory') { fs.renameSync(join(f.root, 'src/input.ts'), join(f.root, 'saved-input')); mkdirSync(join(f.root, 'src/input.ts')); }
        refused(f, await f.run()); assert.equal(f.native.length, 0); assert.deepEqual(f.trace(), []);
    });
}

test('foreign common lock remains untouched and never launches', async () => {
    const f = fixture(); f.put('.fresh-start-foundation.lock', 'foreign'); refused(f, await f.run());
    assert.equal(readFileSync(join(f.root, '.fresh-start-foundation.lock'), 'utf8'), 'foreign'); assert.equal(f.native.length, 0);
});

for (const [label, change] of [
    ['nested-incomplete', (s: string) => footer + s.replace(/^ℹ tests \d+$/m, 'ℹ tests broken')],
    ['truncated', (s: string) => s.trimEnd()], ['contradictory', (s: string) => s.replace(/^ℹ pass \d+$/m, 'ℹ pass 99')],
    ['zero-tests', (_s: string) => footer.replace(/(tests|pass) 1/g, '$1 0')],
    ['governed-skip', (_s: string) => footer.replace('pass 1', 'pass 0').replace('skipped 0', 'skipped 1')],
    ['todo', (_s: string) => footer.replace('pass 1', 'pass 0').replace('todo 0', 'todo 1')],
    ['cancelled', (_s: string) => footer.replace('pass 1', 'pass 0').replace('cancelled 0', 'cancelled 1')],
    ['output-overflow', (_s: string) => 'PRIVATE_CANARY'.repeat(1400000) + '\n' + footer]
] as const) {
    test(`first governed footer refuses ${label} with actual native closure and no later stage`, { timeout: 60000 }, async () => {
        const f = fixture(); f.faultOutput(change); refused(f, await f.run());
        assert.deepEqual(f.trace(), ['runtime', 'typecheck', 'build', 'compile', names[0]]);
        assert.equal(f.native[4].closure.nativeCode, 0); assert.equal(f.native[4].closure.activeProcesses, 0); assert.ok(f.native[4].closed);
        assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE_CANARY/);
        assert.equal(existsSync(join(f.root, '.fresh-start-foundation.lock')), false);
    });
}

for (const mode of ['missing-direct', 'missing-closure', 'active', 'fragment']) {
    test(`missing positive containment ${mode} retains ownership`, { timeout: 20000 }, async () => {
        const f = fixture(); f.faultProtocol(mode); refused(f, await f.run());
        assert.deepEqual(f.trace(), ['runtime']); assert.ok(existsSync(join(f.root, '.fresh-start-foundation.lock')));
        assert.equal(f.events.find(event => event.stage)?.cleanup, 'incomplete');
    });
}

for (const path of ['docs/input.md', 'src/input.ts', 'dist/v2.js', 'dist/v2-build.json',
    'dist/internal/v2-internal-verified-read.js.closure.json', 'node_modules/synthetic/input.js',
    'dist-test/unlisted.map', 'dist-test/tests/fixtures/project-store-governed-note-worker.js',
    'dist-test/tests/support/governed-note-local-providers.js', 'dist-test/tests/v2-governed-note-redaction.test.js']) {
    test(`measured input mutation ${path} refuses at first test`, { timeout: 60000 }, async () => {
        const f = fixture(); f.observe(event => { if (event.stage === names[0]) f.put(path, 'changed after snapshot'); });
        refused(f, await f.run()); assert.equal(f.trace().at(-1), names[0]); assert.equal(f.trace().length, 5);
    });
}

test('native nonzero stops at runtime and does not leak output', { timeout: 20000 }, async () => {
    const f = fixture(); f.put('scripts/check-runtime.js', "console.error('PRIVATE_NATIVE_SECRET');process.exit(17);"); f.commit();
    refused(f, await f.run()); assert.equal(f.native.length, 1); assert.equal(f.events.find(event => event.stage).nativeCode, 17);
    assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE_NATIVE_SECRET/);
});

for (const mode of ['replace', 'missing', 'unlink', 'close']) {
    test(`owned finalization ${mode} withholds qualification and preserves uncertainty`, async () => {
        const f = fixture(); f.put('docs/input.md', 'early identity refusal');
        const original = fs.lstatSync; let changedLock = false;
        if (mode === 'replace' || mode === 'missing') {
            (fs as any).lstatSync = ((path: any, options: any) => {
                if (!changedLock && path === join(f.root, '.fresh-start-foundation.lock')) {
                    changedLock = true; fs.renameSync(path, join(f.root, 'retained-original-lock'));
                    if (mode === 'replace') f.put('.fresh-start-foundation.lock', 'replacement');
                }
                return original(path, options);
            }) as typeof original; syncBuiltinESMExports();
        }
        try { refused(f, await f.run({ unlinkFault: mode === 'unlink', closeFault: mode === 'close' })); }
        finally { (fs as any).lstatSync = original; syncBuiltinESMExports(); }
        assert.equal(f.native.length, 0);
        if (mode === 'replace') assert.equal(readFileSync(join(f.root, '.fresh-start-foundation.lock'), 'utf8'), 'replacement');
        if (mode === 'unlink' || mode === 'close') assert.ok(existsSync(join(f.root, '.fresh-start-foundation.lock')));
    });
}

test('deadline includes identity and earlier stages; post-runtime abort prevents later stage', { timeout: 20000 }, async () => {
    const f = fixture(); refused(f, await f.run({ timeoutMs: 1 })); assert.deepEqual(f.trace(), []);
    const g = fixture(), controller = new AbortController(); g.observe(event => { if (event.stage === 'runtime') controller.abort(); });
    refused(g, await g.run({ signal: controller.signal })); assert.deepEqual(g.trace(), ['runtime']);
});

test('unsupported containment host refuses instead of skipping governed acceptance', async () => {
    const f = fixture(), descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'unsupported' });
    try { refused(f, await f.run()); assert.equal(f.native.length, 0); assert.ok(existsSync(join(f.root, '.fresh-start-foundation.lock'))); }
    finally { Object.defineProperty(process, 'platform', descriptor); }
});

test('CLI accepts no selectors and prints only the fixed failure', () => {
    const result = spawnSync(process.execPath, ['scripts/run-v2-governed-summary-commands.js', '--root=PRIVATE_PATH'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, failure + '\n');
});



// Ruling11: the sole additional complete NEGATIVE inventory. The same native
// Jobs execute; only the exact owned lock unlink throws after valid postflight.
test('prepared 34-stage result is withheld when final owned unlink fails', { timeout: 180000 }, async () => {
    const f = fixture(); refused(f, await f.run({ unlinkFault: true }));
    assert.deepEqual(f.trace(), ['runtime', 'typecheck', 'build', 'compile', ...names, 'worker-smoke', 'fresh-start-smoke']);
    assert.equal(f.native.length, 34);
    assert.ok(f.native.every(value => value.direct.nativeCode === 0 && value.closure.nativeCode === 0
        && value.closure.activeProcesses === 0 && value.closed));
    const { lockIdentity, releaseAttempt } = f.releaseObservation();
    assert.equal(releaseAttempt.stageCount, 34);
    // Shared runner catches before/postflight failures before entering finally;
    // empty prior stderr plus the all-success sequence isolates final unlink.
    assert.equal(releaseAttempt.errorsBeforeRelease, '');
    const retained = fs.lstatSync(join(f.root, '.fresh-start-foundation.lock'), { bigint: true });
    assert.ok(retained.isFile() && !retained.isSymbolicLink());
    assert.equal(retained.dev, lockIdentity!.dev); assert.equal(retained.ino, lockIdentity!.ino);
    assert.equal(retained.dev, releaseAttempt.dev); assert.equal(retained.ino, releaseAttempt.ino);
    assert.equal(f.publishedAfterRelease(), false);
});

test('actual source directory junction refuses despite clean Git bytes', async () => {
    const f = fixture(); fs.renameSync(join(f.root, 'src'), join(f.root, 'retained-source'));
    fs.symlinkSync(join(f.root, 'retained-source'), join(f.root, 'src'), 'junction');
    assert.ok(fs.lstatSync(join(f.root, 'src')).isSymbolicLink());
    assert.equal(f.git('diff', '--name-only', 'HEAD').trim(), '');
    refused(f, await f.run()); assert.equal(f.native.length, 0);
});

test('missing explicit private worker refuses immediately after compile', { timeout: 20000 }, async () => {
    const f = fixture(); fs.renameSync(join(f.root, 'dist-test/' + privatePaths[0]), join(f.root, 'retained-worker.js'));
    refused(f, await f.run()); assert.deepEqual(f.trace(), ['runtime', 'typecheck', 'build', 'compile']);
});

test('compiled directory junction refuses immediately after compile', { timeout: 20000 }, async () => {
    const f = fixture(); fs.renameSync(join(f.root, 'dist-test/src'), join(f.root, 'retained-compiled'));
    fs.symlinkSync(join(f.root, 'retained-compiled'), join(f.root, 'dist-test/src'), 'junction');
    assert.ok(fs.lstatSync(join(f.root, 'dist-test/src')).isSymbolicLink());
    refused(f, await f.run()); assert.deepEqual(f.trace(), ['runtime', 'typecheck', 'build', 'compile']);
});

test('runtime executable raw identity change refuses before typecheck', { timeout: 20000 }, async () => {
    const f = fixture(), original = fs.readFileSync; let changed = false;
    f.observe(event => { if (event.stage === 'runtime') changed = true; });
    (fs as any).readFileSync = (path: any, ...args: any[]) => path === process.execPath && changed
        ? Buffer.from('different executable identity') : Reflect.apply(original, fs, [path, ...args]);
    syncBuiltinESMExports();
    try { refused(f, await f.run()); assert.deepEqual(f.trace(), ['runtime']); }
    finally { (fs as any).readFileSync = original; syncBuiltinESMExports(); }
});


// Ruling15: finite diagnostic text hints; never test-event authentication.
const metadataTitles: Record<string, string[]> = {
  "v2-governed-note-entry": [
    "closed fixture actions admit a bounded owned clock snapshot without invoking accessors",
    "bootstrap proof mint and mutation use one controlled local worker owner",
    "failed read rollback terminalizes the same native owner before queued admission",
    "positive read rollback keeps the same native owner reusable",
    "own child uses current same-session authority and retained-only provenance",
    "normal reopen preserves provider history and status and historical note replay",
    "lost downstream CLIENT result and revoked source key retain healthy receipt-only recovery",
    "delayed committed delivery after worker authorization expiry",
    "delayed not-found delivery after worker authorization expiry",
    "detach at expiry refuses committed receipt without renewal",
    "detach at expiry refuses absence without renewal",
    "current capability refusal is independent of valid active recovery admission",
    "injected actual command-recovery guard independently withholds committed and absent results",
    "missing optional fixture factory refuses safe and closes its initialized owner",
    "private malformed-control makes healthy executor controller permanently uncertain",
    "private timeout-control makes healthy executor controller permanently uncertain",
    "private action-outcome-unknown makes healthy executor controller permanently uncertain",
    "initialized activation opt-in refuses missing identity/installation and stale or nonprepared state while default stays bare-store",
    "bounded provisioning and nested action discrimination reject proxies without executing traps",
    "exclusive fixture action excludes create/recovery/close through acknowledged disposition",
    "worker-local provider exception markers never enter safe errors or durable diagnostics",
    "expiry before lookup withholds receipt",
    "expiry before lookup withholds absence",
    "injected failed read COMMIT withholds detached receipt",
    "injected failed read COMMIT withholds detached absence",
    "missing historical note commitment key refuses create replay while receipt recovery remains available"
  ],
  "v2-governed-note-ownership": [
    "governed identity worker selection refuses missing or mismatched current artifacts",
    "mandatory timing rejects before allocation or owner side effects",
    "fresh allocation is opaque, contained, and cannot attach a prior directory",
    "open reserves synchronously before construction and rejects reentrant duplicate open",
    "active create makes recovery busy and recovery holds exclusive admission through disposition",
    "normal release alone permits same-run reopen with new generation and invalidates old permit",
    "identical unavailable error is definitive only on a still healthy owner",
    "false, throwing and malformed health fail closed before dispatch",
    "independent health failure at success disposition poisons and late receipt cannot heal",
    "intentional DRAINING allows admitted creates to settle while rejecting ingress",
    "queue-full is definitive while protocol, unknown outcome and forced close are absorbing",
    "malformed and mismatched results or errors never release recovery admission",
    "constructor, open and reopen uncertainty use empty details and never replace again",
    "directory and initialized file replacement or hardlinks deny construction",
    "symlink parents, alias spelling and setup failure never mint an attachable fixture",
    "returned escaped routes and replacement across async initialization are refused",
    "exclusive mkdir collision preserves existing contents without initializing or retrying",
    "invalid inputs and cross-run permits post nothing and do not consume admission",
    "malformed create scope, ID and envelope disqualify the owner",
    "R and C integer endpoints use injected scheduler observations without native waiting",
    "replacement during the first native spelling observation refuses before initializer"
  ]
};
const metadataRegistrations = {
  "v2-governed-note-entry": [
    {
      "kind": "test",
      "name": "closed fixture actions admit a bounded owned clock snapshot without invoking accessors",
      "options": null,
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "bootstrap proof mint and mutation use one controlled local worker owner",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "failed read rollback terminalizes the same native owner before queued admission",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "positive read rollback keeps the same native owner reusable",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "own child uses current same-session authority and retained-only provenance",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "normal reopen preserves provider history and status and historical note replay",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "lost downstream CLIENT result and revoked source key retain healthy receipt-only recovery",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "delayed committed delivery after worker authorization expiry",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "delayed not-found delivery after worker authorization expiry",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "detach at expiry refuses committed receipt without renewal",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "detach at expiry refuses absence without renewal",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "current capability refusal is independent of valid active recovery admission",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "injected actual command-recovery guard independently withholds committed and absent results",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "missing optional fixture factory refuses safe and closes its initialized owner",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "private malformed-control makes healthy executor controller permanently uncertain",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "private timeout-control makes healthy executor controller permanently uncertain",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "private action-outcome-unknown makes healthy executor controller permanently uncertain",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "initialized activation opt-in refuses missing identity/installation and stale or nonprepared state while default stays bare-store",
      "options": null,
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "bounded provisioning and nested action discrimination reject proxies without executing traps",
      "options": null,
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "exclusive fixture action excludes create/recovery/close through acknowledged disposition",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "worker-local provider exception markers never enter safe errors or durable diagnostics",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "expiry before lookup withholds receipt",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "expiry before lookup withholds absence",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "injected failed read COMMIT withholds detached receipt",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "injected failed read COMMIT withholds detached absence",
      "options": "{timeout:120000}",
      "nesting": 0
    },
    {
      "kind": "test",
      "name": "missing historical note commitment key refuses create replay while receipt recovery remains available",
      "options": "{timeout:120000}",
      "nesting": 0
    }
  ],
  "v2-governed-note-ownership": [
    {
      "kind": "describe",
      "name": "governed note ownership",
      "options": "{ concurrency: 1 }",
      "nesting": 0
    },
    {
      "kind": "describe",
      "name": "independent ownership controls",
      "options": "{ concurrency: 2 }",
      "nesting": 1
    },
    {
      "kind": "test",
      "name": "governed identity worker selection refuses missing or mismatched current artifacts",
      "options": null,
      "nesting": 2
    },
    {
      "kind": "test",
      "name": "mandatory timing rejects before allocation or owner side effects",
      "options": null,
      "nesting": 2
    },
    {
      "kind": "test",
      "name": "fresh allocation is opaque, contained, and cannot attach a prior directory",
      "options": "{timeout:20000}",
      "nesting": 2
    },
    {
      "kind": "test",
      "name": "open reserves synchronously before construction and rejects reentrant duplicate open",
      "options": "{timeout:20000}",
      "nesting": 2
    },
    {
      "kind": "test",
      "name": "active create makes recovery busy and recovery holds exclusive admission through disposition",
      "options": "{timeout:20000}",
      "nesting": 2
    },
    {
      "kind": "test",
      "name": "normal release alone permits same-run reopen with new generation and invalidates old permit",
      "options": "{timeout:20000}",
      "nesting": 2
    },
    {
      "kind": "test",
      "name": "identical unavailable error is definitive only on a still healthy owner",
      "options": "{timeout:60000}",
      "nesting": 2
    },
    {
      "kind": "test",
      "name": "false, throwing and malformed health fail closed before dispatch",
      "options": "{timeout:60000}",
      "nesting": 2
    },
    {
      "kind": "test",
      "name": "independent health failure at success disposition poisons and late receipt cannot heal",
      "options": "{timeout:20000}",
      "nesting": 2
    },
    {
      "kind": "test",
      "name": "intentional DRAINING allows admitted creates to settle while rejecting ingress",
      "options": "{timeout:20000}",
      "nesting": 2
    },
    {
      "kind": "test",
      "name": "queue-full is definitive while protocol, unknown outcome and forced close are absorbing",
      "options": "{timeout:60000}",
      "nesting": 2
    },
    {
      "kind": "test",
      "name": "malformed and mismatched results or errors never release recovery admission",
      "options": "{timeout:60000}",
      "nesting": 2
    },
    {
      "kind": "test",
      "name": "constructor, open and reopen uncertainty use empty details and never replace again",
      "options": "{timeout:60000}",
      "nesting": 2
    },
    {
      "kind": "test",
      "name": "directory and initialized file replacement or hardlinks deny construction",
      "options": "{timeout:60000}",
      "nesting": 2
    },
    {
      "kind": "test",
      "name": "symlink parents, alias spelling and setup failure never mint an attachable fixture",
      "options": "{timeout:20000}",
      "nesting": 2
    },
    {
      "kind": "test",
      "name": "returned escaped routes and replacement across async initialization are refused",
      "options": "{timeout:60000}",
      "nesting": 2
    },
    {
      "kind": "test",
      "name": "exclusive mkdir collision preserves existing contents without initializing or retrying",
      "options": null,
      "nesting": 1
    },
    {
      "kind": "describe",
      "name": "independent admission controls",
      "options": "{ concurrency: 2 }",
      "nesting": 1
    },
    {
      "kind": "test",
      "name": "invalid inputs and cross-run permits post nothing and do not consume admission",
      "options": "{timeout:20000}",
      "nesting": 2
    },
    {
      "kind": "test",
      "name": "malformed create scope, ID and envelope disqualify the owner",
      "options": "{timeout:60000}",
      "nesting": 2
    },
    {
      "kind": "test",
      "name": "R and C integer endpoints use injected scheduler observations without native waiting",
      "options": "{timeout:60000}",
      "nesting": 2
    },
    {
      "kind": "test",
      "name": "replacement during the first native spelling observation refuses before initializer",
      "options": null,
      "nesting": 1
    }
  ]
};

function metadataTranscript(stage: string, failed: number[] = [3], eol = '\n') {
    const titles = metadataTitles[stage], own = stage.endsWith('ownership');
    const lines: string[] = [], fail = new Set(failed);
    const row = (title: string, nesting: number, isFail: boolean) => lines.push('  '.repeat(nesting) + (isFail ? '✖ ' : '✔ ') + title + ' (1ms)');
    if (own) lines.push('▶ governed note ownership', '  ▶ independent ownership controls');
    titles.forEach((title, index) => {
        const ordinal = index + 1; row(title, own ? (ordinal === 17 || ordinal === 21 ? 1 : 2) : 0, fail.has(ordinal));
        if (own && ordinal === 16) row('independent ownership controls', 1, failed.some(x => x <= 16));
        if (own && ordinal === 17) lines.push('  ▶ independent admission controls');
        if (own && ordinal === 20) row('independent admission controls', 1, failed.some(x => x >= 18 && x <= 20));
    });
    if (own) row('governed note ownership', 0, failed.length > 0);
    const counts = { tests: titles.length, suites: own ? 3 : 0, pass: titles.length - failed.length, fail: failed.length, cancelled: 0, skipped: 0, todo: 0 };
    lines.push(...Object.entries({ ...counts, duration_ms: 1 }).map(([k, v]) => 'ℹ ' + k + ' ' + v));
    return { text: lines.join(eol) + eol, counts };
}
async function metadataParser(): Promise<any> {
    return (await import(new URL('../../scripts/run-v2-governed-summary-commands.js', import.meta.url).href)).deriveStockSpecFailureCandidates;
}
function metadataOptions() { return { nativeCode: 1, outputOverflow: false, mappingBound: true }; }
function assertMetadataPrivacy(value: any) {
    assert.deepEqual(Object.keys(value).sort(), ['version', 'origin', 'authenticity', 'status', 'candidateOrdinals', 'reason', 'phase'].sort());
    assert.equal(value.version, 1); assert.equal(value.origin, 'stock-spec-text'); assert.equal(value.authenticity, 'unverified-text');
    assert.equal(value.phase, 'unavailable'); assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 1024);
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_METADATA|governed identity|fixture|provider|proof|stack/);
}
function registerFailureMetadataTests() {
    nodeTest('failure metadata pure exact entry and nested ownership failures stay unverified', async () => {
        const derive = await metadataParser();
        for (const stage of Object.keys(metadataTitles)) for (const failed of [[3], [2, 18], [17, 21]]) {
            const x = metadataTranscript(stage, failed), result = derive(stage, x.text, x.counts, metadataOptions());
            assert.equal(result.status, 'candidate'); assert.deepEqual(result.candidateOrdinals, failed); assertMetadataPrivacy(result);
        }
    });
    nodeTest('failure metadata pure final reprints CRLF and split Unicode never duplicate candidates', async () => {
        const derive = await metadataParser(), { StringDecoder } = await import('node:string_decoder');
        for (const stage of Object.keys(metadataTitles)) for (const eol of ['\n', '\r\n']) {
            const x = metadataTranscript(stage, [3], eol), suffix = eol + '✖ failing tests:' + eol + eol + 'test at PRIVATE_METADATA_PATH:1:1' + eol + '✖ ' + metadataTitles[stage][2] + ' (1ms)' + eol + '  PRIVATE_METADATA_BODY' + eol;
            const bytes = Buffer.from(x.text + suffix), decoder = new StringDecoder('utf8'); let text = '';
            for (let i = 0; i < bytes.length; i += 2) text += decoder.write(bytes.subarray(i, i + 2)); text += decoder.end();
            const result = derive(stage, text, x.counts, metadataOptions()); assert.equal(result.status, 'candidate'); assert.deepEqual(result.candidateOrdinals, [3]); assertMetadataPrivacy(result);
        }
    });
    nodeTest('failure metadata pure duplicate unknown missing reordered suite and control rows refuse hints', async () => {
        const derive = await metadataParser(), stage = 'v2-governed-note-ownership', x = metadataTranscript(stage), lines = x.text.split('\n');
        const variants = [
            lines.slice(0, 3).concat(lines[2], lines.slice(3)).join('\n'),
            x.text.replace(metadataTitles[stage][0], 'PRIVATE_METADATA_UNKNOWN'),
            lines.filter((_, i) => i !== 3).join('\n'),
            lines.map((v, i) => i === 2 ? lines[3] : i === 3 ? lines[2] : v).join('\n'),
            x.text.replace('  ✖ independent ownership controls', '  ✔ independent ownership controls'),
            x.text.replace('  ▶ independent ownership controls', '  ▶ PRIVATE_METADATA_SUITE'),
            x.text.replace('    ✔ ', '   ✔ '),
            '\u001b[31m' + x.text, x.text.replace('(1ms)', '(NaNms)'), x.text.replace('(1ms)', '(Infinityms)'),
            x.text.replace('(1ms)', '(1ms) # SKIP'), x.text.replace('\n', '\r'), x.text + '\u0000'
        ];
        for (const text of variants) { const result = derive(stage, text, x.counts, metadataOptions()); assert.notEqual(result.status, 'candidate'); assert.deepEqual(result.candidateOrdinals, []); assertMetadataPrivacy(result); }
    });
    nodeTest('failure metadata pure footer native mapping and overflow eligibility cannot manufacture failures', async () => {
        const derive = await metadataParser(), stage = 'v2-governed-note-entry', x = metadataTranscript(stage);
        for (const name of Object.keys(metadataTitles)) {
            const transcript = metadataTranscript(name);
            for (const duration of [1, 900000, 900001, 2100000]) {
                for (const text of [transcript.text.replaceAll('(1ms)', `(${duration}ms)`),
                    transcript.text.replace('duration_ms 1', `duration_ms ${duration}`)]) {
                    const result = derive(name, text, transcript.counts, metadataOptions());
                    assert.equal(result.status, 'candidate'); assert.deepEqual(result.candidateOrdinals, [3]); assertMetadataPrivacy(result);
                }
            }
            for (const text of [transcript.text.replaceAll('(1ms)', '(2100001ms)'),
                transcript.text.replace('duration_ms 1', 'duration_ms 2100001')]) {
                const result = derive(name, text, transcript.counts, metadataOptions());
                assert.notEqual(result.status, 'candidate'); assert.deepEqual(result.candidateOrdinals, []); assertMetadataPrivacy(result);
            }
        }
        const variants: [string, any, any][] = [
            [x.text.trimEnd(), x.counts, metadataOptions()], [x.text, {}, metadataOptions()],
            [x.text, { ...x.counts, fail: 2 }, metadataOptions()], [x.text, { ...x.counts, cancelled: 1 }, metadataOptions()],
            [x.text, { ...x.counts, skipped: 1 }, metadataOptions()], [x.text, x.counts, { ...metadataOptions(), nativeCode: 0 }],
            [x.text, x.counts, { ...metadataOptions(), mappingBound: false }], [x.text, x.counts, { ...metadataOptions(), outputOverflow: true }],
            ['x'.repeat(16 * 1024 * 1024 + 1), x.counts, metadataOptions()],
            [footer + x.text, x.counts, metadataOptions()], [x.text + 'ℹ tests broken\n', x.counts, metadataOptions()],
            [x.text.replace('ℹ fail 1', 'ℹ fail 9007199254740992'), x.counts, metadataOptions()]
        ];
        for (const [text, counts, options] of variants) { const result = derive(stage, text, counts, options); assert.notEqual(result.status, 'candidate'); assertMetadataPrivacy(result); }
        const pass = metadataTranscript(stage, []); assert.notEqual(derive(stage, pass.text, pass.counts, metadataOptions()).status, 'candidate');
        assert.notEqual(derive('PRIVATE_METADATA_STAGE', x.text, x.counts, metadataOptions()).status, 'candidate');
    });
    nodeTest('failure metadata pure coherent injected transcript is a hint and cannot expose payloads', async () => {
        const derive = await metadataParser(), stage = 'v2-governed-note-entry', x = metadataTranscript(stage);
        const result = derive(stage, 'PRIVATE_METADATA_SECRET\n' + x.text, x.counts, metadataOptions());
        assert.equal(result.status, 'candidate'); assert.deepEqual(result.candidateOrdinals, [3]); assertMetadataPrivacy(result);
        let calls = 0; const accessor = { get fail() { calls++; throw new Error('PRIVATE_METADATA'); } };
        const proxy = new Proxy({}, { get() { calls++; throw new Error('PRIVATE_METADATA'); }, getOwnPropertyDescriptor() { calls++; throw new Error('PRIVATE_METADATA'); } });
        for (const input of [null, undefined, 1, [], accessor, proxy]) {
            for (const result of [derive(stage, x.text, input, metadataOptions()), derive(stage, input, x.counts, metadataOptions()), derive(stage, x.text, x.counts, input)]) {
                assert.notEqual(result.status, 'candidate'); assertMetadataPrivacy(result);
            }
        }
        assert.equal(calls, 0);
    });
    nodeTest('failure metadata pure mapping follows exact original AST titles options nesting and source binding', async () => {
        const ts = await import('typescript'), derive = await metadataParser();
        for (const stage of Object.keys(metadataTitles)) {
            const path = join(process.cwd(), 'tests', stage + '.test.ts'), source = readFileSync(path, 'utf8'), ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
            const actual: { kind: string; name: string; options: string | null; nesting: number }[] = [];
            let expandedLoops = 0;
            function literal(node: import('typescript').Expression, environment: Map<string, unknown>): unknown {
                if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return literal(node.expression, environment);
                if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
                if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
                if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
                if (ts.isIdentifier(node)) { assert.ok(environment.has(node.text)); return environment.get(node.text); }
                if (ts.isArrayLiteralExpression(node)) { assert.ok(node.elements.length <= 3); return node.elements.map(x => literal(x as import('typescript').Expression, environment)); }
                if (ts.isConditionalExpression(node)) {
                    const value = literal(node.condition, environment); assert.equal(typeof value, 'boolean');
                    return literal(value ? node.whenTrue : node.whenFalse, environment);
                }
                if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(span => {
                    const value = literal(span.expression, environment); assert.equal(typeof value, 'string'); return value + span.literal.text;
                }).join('');
                assert.fail('UNSUPPORTED_FIXED_REGISTRATION_EXPRESSION');
            }
            function containsRegistration(node: import('typescript').Node): boolean {
                if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['test', 'describe'].includes(node.expression.text)) return true;
                return ts.forEachChild(node, containsRegistration) === true;
            }
            function visit(node: import('typescript').Node, environment = new Map<string, unknown>(), nesting = 0) {
                if (ts.isForOfStatement(node)) {
                    if (!containsRegistration(node.statement)) return;
                    assert.ok(ts.isVariableDeclarationList(node.initializer)); assert.equal(node.initializer.declarations.length, 1);
                    const binding = node.initializer.declarations[0].name, values = literal(node.expression, environment);
                    assert.ok(Array.isArray(values)); assert.ok(values.length >= 2 && values.length <= 3); expandedLoops++;
                    for (const value of values) {
                        const next = new Map(environment);
                        if (ts.isIdentifier(binding)) next.set(binding.text, value);
                        else {
                            assert.ok(ts.isArrayBindingPattern(binding)); assert.ok(Array.isArray(value)); assert.equal(value.length, binding.elements.length);
                            binding.elements.forEach((element, i) => { assert.ok(ts.isBindingElement(element) && ts.isIdentifier(element.name)); next.set(element.name.text, value[i]); });
                        }
                        visit(node.statement, next, nesting);
                    }
                    return;
                }
                if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['test', 'describe'].includes(node.expression.text)) {
                    const name = literal(node.arguments[0], environment); assert.equal(typeof name, 'string');
                    actual.push({ kind: node.expression.text, name: name as string, options: node.arguments.length === 3 ? node.arguments[1].getText(ast) : null, nesting });
                    if (node.expression.text === 'describe') { const callback = node.arguments.at(-1)!; assert.ok(ts.isArrowFunction(callback)); visit(callback.body, environment, nesting + 1); }
                    return; // Never traverse or execute test bodies.
                }
                ts.forEachChild(node, child => visit(child, environment, nesting));
            }
            visit(ast);
            assert.equal(expandedLoops, stage.endsWith('entry') ? 5 : 0);
            assert.equal(actual.filter(row => row.kind === 'test').length, stage.endsWith('entry') ? 26 : 21);
            assert.equal(actual.filter(row => row.kind === 'describe').length, stage.endsWith('entry') ? 0 : 3);
            assert.equal(metadataTitles[stage].length, stage.endsWith('entry') ? 26 : 21);
            assert.deepEqual(actual, metadataRegistrations[stage as keyof typeof metadataRegistrations]);
            assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), stage.endsWith('entry')
                ? 'f694910b699bbdd48fc678451530e734e410f3e9b3d588680bb3ad2ff2b3cf94'
                : 'feab26c807734d07c0c3b904f1951c3c97bdbd71e64f7defbb1e326295064df7');
            const x = metadataTranscript(stage); assert.equal(derive(stage, x.text, x.counts, metadataOptions()).status, 'candidate');
            assert.equal(derive(stage, x.text, x.counts, { ...metadataOptions(), mappingBound: false }).reason, 'mapping-unavailable');
        }
    });
}

test('failure metadata native ownership prefix keeps genuine exit and closure independent of hints', { timeout: 180000 }, async t => {
    const f = fixture(), stage = 'v2-governed-note-ownership';
    for (const name of Object.keys(metadataTitles)) f.put('tests/' + name + '.test.ts', readFileSync(join(process.cwd(), 'tests', name + '.test.ts'), 'utf8'));
    const leaf = (ordinal: number) => 'test(' + JSON.stringify(metadataTitles[stage][ordinal - 1]) + ',()=>{' + (ordinal === 3 ? "throw new Error('PRIVATE_METADATA_NATIVE_CANARY');" : '') + '});';
    const code = record + "log('" + stage + "');import{test,describe}from'node:test';describe('governed note ownership',{concurrency:1},()=>{describe('independent ownership controls',{concurrency:2},()=>{" + Array.from({ length: 16 }, (_, i) => leaf(i + 1)).join('') + '});' + leaf(17) + "describe('independent admission controls',{concurrency:2},()=>{" + [18, 19, 20].map(leaf).join('') + '});' + leaf(21) + '});';
    f.put('dist-test/tests/' + stage + '.test.js', code); f.commit(); refused(f, await f.run());
    assert.deepEqual(f.trace(), ['runtime', 'typecheck', 'build', 'compile', ...names.slice(0, 9)]);
    const receipts = f.events.filter(event => event.stage); assert.equal(receipts.length, 13); assert.equal(f.native.length, 13);
    assert.ok(f.native.every(value => value.direct && value.closure && value.closure.activeProcesses === 0 && value.closed));
    assert.ok(f.native.slice(0, 12).every(value => value.direct.nativeCode === 0 && value.closure.nativeCode === 0));
    assert.equal(f.native[12].direct.nativeCode, 1); assert.equal(f.native[12].closure.nativeCode, 1);
    const last = receipts.at(-1); assert.equal(last.code, 1); assert.equal(last.nativeCode, 1); assert.equal(last.cleanup, 'complete');
    assert.deepEqual(last.counts, { tests: 21, suites: 3, pass: 20, fail: 1, cancelled: 0, skipped: 0, todo: 0 });
    assert.equal(last.failureMetadata.status, 'candidate'); assert.deepEqual(last.failureMetadata.candidateOrdinals, [3]); assertMetadataPrivacy(last.failureMetadata);
    assert.equal(receipts.filter(event => event.failureMetadata).length, 1); assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE_METADATA_NATIVE_CANARY/);
    assert.equal(existsSync(join(f.root, '.fresh-start-foundation.lock')), false);
    t.diagnostic(JSON.stringify({ metadataIntegration: true, root: f.root, stages: receipts.map(value => ({ stage: value.stage, code: value.code, nativeCode: value.nativeCode, cleanup: value.cleanup, closure: value.closure })), failureMetadata: last.failureMetadata, native: f.native }));
});

if (isMainThread) {
    const uninstall = installInterruptRouting();
    after(() => { uninstall(); assert.equal(activePools.size, 0); });
    registerFailureMetadataTests();
    registerIsolationGuards();
    describe('isolated governed controls', { concurrency: 2 }, () => {
        const pool = new ControlPool();
        after(() => { assert.equal(pool.active, 0); });
        for (const [index, control] of controls.entries()) {
            nodeTest(control.name, async t => {
                const result = await pool.run('control:' + index, control.timeout);
                for (const diagnostic of result.diagnostics) t.diagnostic(diagnostic);
                assert.equal(result.exitCode, 0); assert.ok(result.stdoutEnded && result.stderrEnded);
            });
        }
    });
} else {
    await runRealm();
}
