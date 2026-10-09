import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import childProcess, { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { createHash } from 'node:crypto';

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
    const result = spawnSync('git', ['--git-dir', join(root, '.git'), '--work-tree', root, '-C', root, ...args],
        { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
}
const record = "import{appendFileSync}from'node:fs';const log=x=>appendFileSync('trace',x+'\\n');";
let staticSeed: { root: string; files: Map<string, string> } | undefined;
function seedRoot() {
    if (staticSeed) {
        assert.deepEqual(physicalSnapshot(staticSeed.root), staticSeed.files);
        return staticSeed;
    }
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
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'governed-gate-')));
    const source = seedRoot(), seed = source.root;
    for (const path of source.files.keys()) {
        const target = join(root, path); mkdirSync(dirname(target), { recursive: true });
        fs.copyFileSync(join(seed, path), target, fs.constants.COPYFILE_EXCL);
        const before = fs.lstatSync(join(seed, path), { bigint: true }), after = fs.lstatSync(target, { bigint: true });
        assert.equal(after.nlink, 1n); assert.notEqual(`${before.dev}:${before.ino}`, `${after.dev}:${after.ino}`);
    }
    assert.deepEqual(physicalSnapshot(root), source.files);
    const put = (path: string, value: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
    const git = (...args: string[]) => fixtureGit(root, ...args);
    const commit = () => { git('add', '--', 'package.json', '.gitignore', 'src', 'tests', 'scripts', 'docs', 'memory', 'tsconfig.test.json'); git('-c', 'user.name=Owned Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'owned fixture'); };
    for (const name of names) put(`dist-test/tests/${name}.test.js`, record + `import{test}from'node:test';test('${name}',()=>log('${name}'));`);
    for (const path of privatePaths) put('dist-test/' + path, 'export {};');
    put('dist-test/unlisted.map', 'whole compiled tree');
    const events: any[] = [], native: any[] = [];
    const trace = () => existsSync(join(root, 'trace')) ? readFileSync(join(root, 'trace'), 'utf8').trim().split('\n') : [];
    let outputFault: ((actual: string) => string) | undefined, protocolFault = '', faultStage = 5;
    let onEvent: ((event: any) => void) | undefined;
    let released = false, publicationAfterRelease = false;
    let lockIdentity: { dev: bigint; ino: bigint } | undefined, releaseAttempt: any;
    async function run(options: { timeoutMs?: number; signal?: AbortSignal; unlinkFault?: boolean; closeFault?: boolean } = {}) {
        const originalSpawn = childProcess.spawn, write = process.stdout.write, errorWrite = process.stderr.write, unlink = fs.unlinkSync, close = fs.closeSync;
        let errorsBeforeRelease = '';
        process.stderr.write = function (chunk: any, ...args: any[]) { errorsBeforeRelease += String(chunk); return Reflect.apply(errorWrite, process.stderr, [chunk, ...args]); } as typeof errorWrite;
        const controller = new AbortController(), cancel = () => controller.abort();
        options.signal?.addEventListener('abort', cancel, { once: true }); if (options.signal?.aborted) cancel();
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
            const index = ++helpers, proof: any = { index, closed: false }; native.push(proof);
            const out = child.stdout!, register = out.on; let observed = '', buffered = '', captured = '';
            register.call(out, 'data', (chunk: Buffer) => {
                observed += chunk.toString(); let end;
                while ((end = observed.indexOf('\n')) >= 0) { const line = observed.slice(0, end); observed = observed.slice(end + 1); const value = JSON.parse(line); if (value.kind === 'direct-exit') proof.direct = value; if (value.kind === 'closure') proof.closure = value; }
            });
            child.once('close', (code, signal) => { proof.closed = code === 0 && signal === null; });
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
        try { const value = await (await gate())({ root, timeoutMs: options.timeoutMs, signal: controller.signal }); return { ok: true, value }; }
        catch (error) { assert.equal((error as Error).message, failure); return { ok: false, value: undefined }; }
        finally { clearTimeout(watchdog); options.signal?.removeEventListener('abort', cancel); process.stdout.write = write; process.stderr.write = errorWrite; childProcess.spawn = originalSpawn; fs.unlinkSync = unlink; fs.closeSync = close; fs.openSync = open; syncBuiltinESMExports(); }
    }
    return { root, seed, put, git, commit, events, native, trace, run,
        faultOutput(value: (actual: string) => string) { outputFault = value; },
        faultProtocol(value: string) { protocolFault = value; faultStage = 1; },
        observe(value: (event: any) => void) { onEvent = value; },
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
    assert.equal(q.profile, 'governed-summary-commands'); assert.equal(q.totalMs, 900000); assert.equal(q.tests, 28);
});

test('invalid total budgets and pre-abort launch nothing', async () => {
    const f = fixture();
    for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 900001]) refused(f, await f.run({ timeoutMs }));
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
