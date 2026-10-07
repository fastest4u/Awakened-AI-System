import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
const names = [
    'v2-native-workflow-contracts', 'v2-native-workflow-database', 'v2-native-workflow-cursor', 'v2-native-workflow-query', 'v2-native-workflow-result', 'v2-native-workflow-entry', 'v2-native-workflow-gate', 'v2-native-content-contracts', 'v2-native-content-query', 'v2-native-content-result', 'v2-native-content-child', 'v2-native-content-supervisor', 'v2-native-content-entry', 'v2-native-content-gate', 'v2-internal-verified-read-contracts', 'v2-internal-verified-read-admission', 'v2-internal-verified-read-child', 'v2-internal-verified-read-cleanup', 'v2-internal-verified-read-ownership', 'v2-internal-verified-read-supervisor', 'v2-internal-verified-read-entry', 'v2-internal-verified-read-gate', 'retrieval-database-core', 'retrieval-selection-core', 'retrieval-candidates', 'v2-retrieval-candidates', 'retrieval-eligibility', 'retrieval-ranking', 'ci-lifecycle-gates'
];
type Run = (options: {
    root: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}) => Promise<number>;
async function gate(): Promise<Run> {
    let module: any;
    try {
        module = await import(new URL('../../scripts/run-v2-native-read-workflows.js', import.meta.url).href);
    }
    catch (e) {
        if ((e as any).code !== 'ERR_MODULE_NOT_FOUND')
            throw e;
    }
    assert.equal(typeof module?.runNativeReadWorkflowsGate, 'function', 'fixed workflow gate export is absent');
    return module.runNativeReadWorkflowsGate;
}
function fixture() {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'workflow-gate-')));
    const put = (path: string, bytes: string) => {
        mkdirSync(dirname(join(root, path)), {
            recursive: true
        });
        writeFileSync(join(root, path), bytes);
    };
    const git = (...args: string[]) => {
        const r = spawnSync('git', [
            '--git-dir', join(root, '.git'), '--work-tree', root, '-C', root, ...args
        ], {
            encoding: 'utf8', windowsHide: true, timeout: 10000
        });
        assert.equal(r.status, 0, r.stderr);
        return r.stdout;
    };
    const record = "import{appendFileSync}from'node:fs';const log=x=>appendFileSync('trace',x+'\\n');";
    put('package.json', '{"type":"module"}');
    put('.gitignore', 'node_modules/\ndist/\ndist-test/\ntrace\n.fresh-start-foundation.lock\nready\n');
    put('node_modules/synthetic/input.js', 'export const dependency=1;');
    put('docs/input.md', 'tracked documentation');
    put('memory/note.md', 'mutable vault');
    put('src/input.ts', 'export const input=1;');
    put('tsconfig.test.json', '{}');
    put('tests/input.ts', 'export {};');
    put('scripts/check-runtime.js', record + "log('runtime');");
    put('node_modules/typescript/bin/tsc', record + "log(process.argv.includes('--noEmit')?'typecheck':'compile');");
    put('scripts/build.js', record + `log('build');
import{mkdirSync,writeFileSync,readFileSync}from'node:fs';import{createHash}from'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const paths=['v2.js','v2-admin.js','workers/project-store.worker.js','internal/v2-internal-verified-read.js','internal/v2-internal-verified-read-cleanup.js'];
const artifacts=paths.map(path=>{mkdirSync('dist/'+path.split('/').slice(0,-1).join('/'),{recursive:true});writeFileSync('dist/'+path,path);return{path,bytes:Buffer.byteLength(path),sha256:sha(path)}});
for(const artifact of artifacts.slice(3)){const path='node_modules/synthetic/input.js',bytes=readFileSync(path);writeFileSync('dist/'+artifact.path+'.closure.json',JSON.stringify({artifact,inputs:[{path,bytes:bytes.length,sha256:sha(bytes)}],runtimeImports:['node:fs'],sourceChecked:true,emittedChecked:true}));}
const body={schemaVersion:1,deploymentId:'synthetic-owned',runtime:{nodeVersion:process.versions.node,platform:process.platform,arch:process.arch,executableSha256:sha(readFileSync(process.execPath))},artifacts};writeFileSync('dist/v2-build.json',JSON.stringify({...body,buildIdentityHash:sha(canonical(body))}));`);
    for (const name of names)
        put(`dist-test/tests/${name}.test.js`, record + `import{test}from'node:test';test('${name}',()=>log('${name}'));`);
    put('scripts/smoke-v2-fresh-start.js', record + "log('smoke');");
    git('init', '--quiet');
    git('add', '--', 'package.json', '.gitignore', 'src', 'tests', 'scripts', 'docs', 'memory', 'tsconfig.test.json');
    git('-c', 'user.name=Owned Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'owned synthetic gate inputs');
    const events: any[] = [];
    let ran = false;
    let result: number | undefined;
    const helpers: ReturnType<typeof childProcess.spawn>[] = [];
    const capture = {
        nonJsonBuffers: 0, nonJsonStrings: 0, jsonWrites: 0, legacyStages: 0, legacyParseFailures: 0, legacyLostRuntime: false
    };
    const footer = {
        fault: '', observed: false, actual: '', changed: '', nativeCode: undefined as number | undefined, activeProcesses: undefined as number | undefined, closed: false
    };
    function observeOwnedFooterBoundary(child: ReturnType<typeof childProcess.spawn>) {
        const stdout = child.stdout!, register = stdout.on;
        let frames = '', actualFrames = '';
        const output: Buffer[] = [];
        // An independent observer sees the original bridge's kernel proof
        // and actual helper close. Only its stdout payload is corrupted.
        stdout.on('data', bytes => {
            actualFrames += bytes.toString();
            let end;
            while ((end = actualFrames.indexOf('\n')) >= 0) {
                const line = actualFrames.slice(0, end);
                actualFrames = actualFrames.slice(end + 1);
                try {
                    const value = JSON.parse(line);
                    if (value.kind === 'closure') {
                        footer.nativeCode = value.nativeCode;
                        footer.activeProcesses = value.activeProcesses;
                    }
                }
                catch {
                }
            }
        });
        child.once('close', (code, signal) => {
            footer.closed = code === 0 && signal === null;
        });
        stdout.on = ((event: any, listener: any) => {
            if (event !== 'data')
                return Reflect.apply(register, stdout, [
                    event, listener
                ]);
            return Reflect.apply(register, stdout, [
                event, (chunk: Buffer) => {
                    frames += chunk.toString();
                    let end;
                    let forwarded = '';
                    while ((end = frames.indexOf('\n')) >= 0) {
                        const line = frames.slice(0, end);
                        frames = frames.slice(end + 1);
                        const value = JSON.parse(line);
                        if (value.kind === 'stdout') {
                            output.push(Buffer.from(value.bytes, 'base64'));
                            continue;
                        }
                        if (value.kind === 'closure') {
                            footer.actual = Buffer.concat(output).toString('utf8');
                            let changed = footer.actual;
                            const nested = 'ℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 1\n';
                            if (footer.fault === 'nested')
                                changed = changed.replace(/^ℹ tests \d+$/m, nested + 'ℹ tests broken');
                            if (footer.fault === 'truncated')
                                changed = changed.replace(/(ℹ duration_ms [^\r\n]+)\r?\n$/, '$1');
                            if (footer.fault === 'incoherent')
                                changed = changed.replace(/^ℹ pass \d+$/m, 'ℹ pass 99');
                            if (footer.fault === 'zero')
                                changed = changed.replace(/^ℹ (tests|pass|skipped) \d+$/gm, 'ℹ $1 0');
                            footer.changed = changed;
                            footer.observed = changed !== footer.actual;
                            forwarded += JSON.stringify({
                                kind: 'stdout', bytes: Buffer.from(changed).toString('base64')
                            }) + '\n';
                        }
                        forwarded += line + '\n';
                    }
                    if (forwarded)
                        listener(Buffer.from(forwarded));
                }
            ]);
        }) as typeof stdout.on;
    }
    function cleanupOwnedFixture() {
        const stages = events.filter(e => e.stage);
        const complete = stages.length === helpers.length && stages.every(e => e.cleanup === 'complete' && e.closure === 'windows-job-active-zero');
        if (!existsSync(join(root, '.fresh-start-foundation.lock')) && (!ran || result !== undefined && (helpers.length === 0 || complete)))
            rmSync(root, { recursive: true, force: true });
        else
            console.error(`Retained uncertain workflow fixture: ${root}`);
    }
    return {
        root, put, git, events, capture, footer, setFooterFault(fault: string) {
            footer.fault = fault;
        }, commit() {
            git('add', '--', 'scripts');
            git('-c', 'user.name=Owned Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'owned fault');
        },
        trace: () => existsSync(join(root, 'trace')) ? readFileSync(join(root, 'trace'), 'utf8').trim().split('\n') : [],
        async run(run: Run, options: Omit<Parameters<Run>[0], 'root'> = {}) {
            const write = process.stdout.write, originalSpawn = childProcess.spawn;
            let legacyBuffer = '';
            ran = true;
            const controller = new AbortController(), cancel = () => controller.abort();
            options.signal?.addEventListener('abort', cancel, {
                once: true
            });
            if (options.signal?.aborted)
                cancel();
            const timer = setTimeout(cancel, 120000);
            // Gate emit() writes complete JSON strings. Node's child test harness also
            // writes unrelated binary IPC chunks; never join those into a JSON record.
            process.stdout.write = function captureCompleteJsonWrites(chunk: any, ...args: any[]) {
                let parsed = false;
                // Replay the rejected assembler for evidence, never for ownership.
                legacyBuffer += String(chunk);
                let legacyEnd;
                while ((legacyEnd = legacyBuffer.indexOf('\n')) >= 0) {
                    const line = legacyBuffer.slice(0, legacyEnd);
                    legacyBuffer = legacyBuffer.slice(legacyEnd + 1);
                    try {
                        if (JSON.parse(line).stage)
                            capture.legacyStages++;
                    }
                    catch {
                        if (line) {
                            capture.legacyParseFailures++;
                            if (line.includes('"stage":"runtime"'))
                                capture.legacyLostRuntime = true;
                        }
                    }
                }
                if (typeof chunk === 'string')
                    for (const line of chunk.split(/\r?\n/)) {
                        try {
                            const event = JSON.parse(line);
                            events.push(event);
                            capture.jsonWrites++;
                            parsed = true;
                        }
                        catch {
                        }
                    }
                if (!parsed) {
                    if (Buffer.isBuffer(chunk))
                        capture.nonJsonBuffers++;
                    else if (String(chunk))
                        capture.nonJsonStrings++;
                }
                return Reflect.apply(write, process.stdout, [
                    chunk, ...args
                ]);
            } as typeof write;
            childProcess.spawn = ((...args: Parameters<typeof originalSpawn>) => {
                const child = originalSpawn(...args);
                if (args[2]?.cwd === root && args[1]?.some(arg => arg.endsWith('v2-verified-read-job.ps1'))) {
                    helpers.push(child);
                    if (footer.fault && helpers.length === 5) {
                        observeOwnedFooterBoundary(child);
                    }
                }
                return child;
            }) as typeof originalSpawn;
            syncBuiltinESMExports();
            try {
                return result = await run({
                    root, ...options, signal: controller.signal
                });
            }
            finally {
                clearTimeout(timer);
                options.signal?.removeEventListener('abort', cancel);
                process.stdout.write = write;
                childProcess.spawn = originalSpawn;
                syncBuiltinESMExports();
            }
        },
        cleanup: cleanupOwnedFixture
    };
}
const native = {
    skip: process.platform !== 'win32', timeout: 180000
};
test('workflow_gate_exact_inventory_and_single_build', native, async (t) => {
    const run = await gate(), f = fixture();
    try {
        f.git('config', 'core.autocrlf', 'true');
        f.put('src/input.ts', 'export const input=1;\n');
        f.git('add', '--', 'src/input.ts');
        f.git('-c', 'user.name=Owned Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'owned line-ending input');
        rmSync(join(f.root, 'src/input.ts')); // Known owned fixture input; force actual Git checkout materialization.
        f.git('checkout-index', '-f', '-u', '--', 'src/input.ts');
        assert.equal(readFileSync(join(f.root, 'src/input.ts'), 'utf8'), 'export const input=1;\r\n');
        assert.equal(f.git('status', '--porcelain', '--', 'src/input.ts').trim(), '');
        f.put('memory/note.md', 'mutable note after commit');
        assert.equal(await f.run(run), 0);
        const stageReceipts = f.events.filter(e => e.stage), testStageReceipts = stageReceipts.filter(e => names.includes(e.stage));
        assert.deepEqual(f.trace(), [
            'runtime', 'typecheck', 'build', 'compile', ...names, 'smoke'
        ]);
        assert.equal(stageReceipts.length, 34);
        assert.equal(testStageReceipts.length, 29);
        assert.equal(stageReceipts.filter(e => e.stage === 'build').length, 1);
        assert.equal(stageReceipts.filter(e => e.stage === 'compile').length, 1);
        assert.ok(stageReceipts.every(e => e.cleanup === 'complete' && e.closure === 'windows-job-active-zero' && e.nativeCode === 0 && e.totalMs === 1500000 && e.profile === 'native-read-workflows'));
        assert.ok(testStageReceipts.every(e => e.counts.tests === 1 && e.counts.pass === 1 && e.counts.todo === 0));
        assert.equal(f.events.filter(e => e.observation === 'qualification').length, 1);
        t.diagnostic(`complete JSON emit capture ${JSON.stringify(f.capture)}`);
    }
    finally {
        f.cleanup();
    }
});
test('workflow_gate_preserves_other_profiles_and_lock', async () => {
    const run = await gate(), f = fixture();
    try {
        const old = readFileSync(new URL('../../scripts/run-v2-internal-verified-read.js', import.meta.url), 'utf8');
        assert.match(old, /const maximumMs = profile === 'native-content' \? 1500000 : 900000/);
        assert.doesNotMatch(old, /native-read-workflows/);
        writeFileSync(join(f.root, '.fresh-start-foundation.lock'), 'foreign-owner');
        assert.equal(await f.run(run), 1);
        assert.deepEqual(f.trace(), []);
        assert.equal(readFileSync(join(f.root, '.fresh-start-foundation.lock'), 'utf8'), 'foreign-owner');
        rmSync(join(f.root, '.fresh-start-foundation.lock')); // Positively identified marker created by this test; no launch.
        for (const timeoutMs of [
            0, -1, 1500001, 1.5, NaN
        ])
            assert.equal(await f.run(run, {
                timeoutMs
            }), 1);
        const c = new AbortController();
        c.abort();
        assert.equal(await f.run(run, {
            signal: c.signal
        }), 130);
        const r = spawnSync(process.execPath, [
            new URL('../../scripts/run-v2-native-read-workflows.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), '--profile', 'metadata'
        ], {
            encoding: 'utf8', timeout: 10000
        });
        assert.equal(r.status, 1);
        assert.match(r.stderr, /NATIVE_READ_WORKFLOWS_GATE_FAILED/);
    }
    finally {
        f.cleanup();
    }
});
for (const [fault, code] of [
    [
        'todo', 1
    ], [
        'failure', 17
    ], [
        'overflow', 1
    ], [
        'nested', 1
    ], [
        'truncated', 1
    ], [
        'incoherent', 1
    ], [
        'zero', 1
    ], [
        'source', 1
    ], [
        'compiled', 1
    ], [
        'compiled-unlisted', 1
    ], [
        'artifact', 1
    ], [
        'closure-input', 1
    ]
] as const)
    test(`workflow_gate_refuses_incoherent_receipts_and_identity_drift_${fault}`, native, async () => {
        const run = await gate(), f = fixture();
        try {
            if (fault === 'todo')
                f.put(`dist-test/tests/${names[0]}.test.js`, "import{test}from'node:test';test.todo('not proof');");
            if (fault === 'failure')
                f.put('scripts/check-runtime.js', "process.stdout.write('ℹ tests 1\\nℹ suites 0\\nℹ pass 1\\nℹ fail 0\\nℹ cancelled 0\\nℹ skipped 0\\nℹ todo 0\\nℹ duration_ms 1\\n');process.exit(17);");
            if ([
                'nested', 'truncated', 'incoherent', 'zero'
            ].includes(fault))
                f.setFooterFault(fault);
            if (fault === 'overflow')
                f.put('scripts/check-runtime.js', "process.stdout.write('x'.repeat(16*1024*1024+1));");
            if ([
                'source', 'compiled', 'compiled-unlisted', 'artifact', 'closure-input'
            ].includes(fault)) {
                const path = fault === 'source' ? 'src/input.ts' : fault === 'compiled' ? `dist-test/tests/${names[0]}.test.js` : fault === 'compiled-unlisted' ? 'dist-test/unlisted.js' : fault === 'artifact' ? 'dist/v2.js' : 'node_modules/synthetic/input.js';
                f.put('scripts/smoke-v2-fresh-start.js', `import{appendFileSync}from'node:fs';appendFileSync('${path}','drift');`);
            }
            f.commit();
            assert.equal(await f.run(run), code);
            assert.equal(f.events.some(e => e.observation === 'qualification'), false);
            if (f.footer.fault) {
                assert.equal(f.footer.observed, true, 'owned outer-footer corruption was not observed');
                assert.match(f.footer.actual, /ℹ tests 1\r?\n/);
                assert.match(f.footer.actual, /ℹ pass 1\r?\n/);
                assert.equal(f.footer.nativeCode, 0);
                assert.equal(f.footer.activeProcesses, 0);
                assert.equal(f.footer.closed, true);
                const stages = f.events.filter(e => e.stage), receipt = stages.at(-1);
                assert.equal(stages.length, 5);
                assert.equal(receipt.stage, names[0]);
                assert.equal(receipt.nativeCode, 0);
                assert.equal(receipt.code, 0);
                assert.equal(receipt.cleanup, 'complete');
                assert.equal(receipt.closure, 'windows-job-active-zero');
                assert.equal(receipt.counts.tests, fault === 'zero' ? 0 : undefined);
            }
            assert.ok(f.events.filter(e => e.stage).every(e => e.cleanup === 'complete' && e.closure === 'windows-job-active-zero'));
        }
        finally {
            f.cleanup();
        }
    });
for (const cancel of [
    false, true
])
    test(`workflow_gate_${cancel ? 'cancel' : 'timeout'}_owned_closure`, {
        ...native, timeout: 25000
    }, async () => {
        const run = await gate(), f = fixture();
        f.put('scripts/check-runtime.js', "import{writeFileSync}from'node:fs';writeFileSync('ready','ready');setInterval(()=>{},1000);");
        f.commit();
        const controller = new AbortController();
        const pending = f.run(run, {
            timeoutMs: 10000, signal: controller.signal
        });
        try {
            const end = performance.now() + 10000;
            while (!existsSync(join(f.root, 'ready'))) {
                assert.ok(performance.now() < end);
                await new Promise(r => setTimeout(r, 10));
            }
            if (cancel)
                controller.abort();
            assert.equal(await pending, cancel ? 130 : 124);
            assert.equal(f.events.filter(e => e.stage).length, 1);
            assert.equal(f.events.find(e => e.stage).closure, 'windows-job-active-zero');
        }
        finally {
            controller.abort();
            await pending;
            f.cleanup();
        }
    });
for (const [kind, path] of [
    [
        'dirty', 'src/input.ts'
    ], [
        'untracked', 'src/untracked.ts'
    ], [
        'other-tracked', 'docs/input.md'
    ]
] as const)
    test(`workflow_gate_clean_committed_candidate_required_${kind}`, async () => {
        const run = await gate(), f = fixture();
        try {
            f.put(path, 'dirty');
            assert.equal(await f.run(run), 1);
            assert.deepEqual(f.trace(), []);
        }
        finally {
            f.cleanup();
        }
    });
test('workflow_gate_job_proof_loss_retains_owned_output', {
    ...native, timeout: 25000
}, async (t) => {
    const run = await gate(), f = fixture();
    f.put('scripts/check-runtime.js', "import{writeFileSync}from'node:fs';writeFileSync('ready','ready');setInterval(()=>{},1000);");
    f.commit();
    const original = childProcess.spawn;
    let helper: ReturnType<typeof original> | undefined;
    t.mock.method(childProcess, 'spawn', ((...args: Parameters<typeof original>) => {
        const child = original(...args);
        if (args[2]?.cwd === f.root && args[1]?.some(arg => arg.endsWith('v2-verified-read-job.ps1')))
            helper = child;
        return child;
    }) as typeof original);
    syncBuiltinESMExports();
    const controller = new AbortController();
    const pending = f.run(run, {
        timeoutMs: 10000, signal: controller.signal
    });
    try {
        const end = performance.now() + 10000;
        while (!existsSync(join(f.root, 'ready'))) {
            assert.ok(performance.now() < end);
            await new Promise(r => setTimeout(r, 10));
        }
        assert.ok(helper);
        assert.equal(helper.kill('SIGKILL'), true);
        assert.equal(await pending, 1);
        assert.equal(f.events.find(e => e.stage).cleanup, 'incomplete');
        assert.equal(existsSync(join(f.root, '.fresh-start-foundation.lock')), true);
    }
    finally {
        controller.abort();
        await pending;
        t.mock.restoreAll();
        syncBuiltinESMExports();
        f.cleanup();
        t.diagnostic(`Uncertain workflow root retained: ${f.root}`);
    }
});
test('workflow_gate_unsupported_platform_retains_output', {
    timeout: 15000
}, async (t) => {
    const run = await gate(), f = fixture(), platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    // Behavioral fail-closed control only; this host does not qualify non-Windows containment.
    Object.defineProperty(process, 'platform', {
        ...platform, value: 'linux'
    });
    try {
        assert.equal(await f.run(run), 1);
        assert.deepEqual(f.trace(), []);
        assert.equal(existsSync(join(f.root, '.fresh-start-foundation.lock')), true);
    }
    finally {
        Object.defineProperty(process, 'platform', platform);
        f.cleanup();
        t.diagnostic(`Unsupported behavioral-control root retained: ${f.root}`);
    }
});
for (const [ignore, path] of [
    [
        'local', 'tests/ignored.ts'
    ], [
        'global', 'src/ambient.d.ts'
    ]
] as const) {
    test(`workflow_gate_fix_I1_ignored_product_${ignore}`, native, async () => {
        const run = await gate();
        const f = fixture();
        try {
            if (ignore === 'local')
                f.put('.git/info/exclude', path + '\n');
            else {
                f.put('global-ignore', path + '\n');
                f.git('config', 'core.excludesFile', join(f.root, 'global-ignore'));
            }
            f.put(path, 'declare const uncommitted: unique symbol;');
            assert.equal(await f.run(run), 1, 'ignored compiler input must refuse before launch');
            assert.deepEqual(f.trace(), []);
            assert.equal(f.events.some(e => e.observation === 'qualification'), false);
        }
        finally {
            f.cleanup();
        }
    });
}
for (const flag of [
    '--assume-unchanged', '--skip-worktree'
] as const) {
    test(`workflow_gate_fix_I2_hidden_tracked_${flag.slice(2)}`, native, async () => {
        const run = await gate();
        const f = fixture();
        try {
            f.git('update-index', flag, '--', 'tests/input.ts');
            f.put('tests/input.ts', 'export const hiddenChange = true;');
            assert.equal(await f.run(run), 1, 'hidden modified tracked bytes must refuse before launch');
            assert.deepEqual(f.trace(), []);
            assert.equal(f.events.some(e => e.observation === 'qualification'), false);
        }
        finally {
            f.cleanup();
        }
    });
}
for (const mode of [
    'deadline', 'validation-abort', 'publication-abort'
] as const) {
    test(`workflow_gate_fix_I3_final_${mode}`, native, async (t) => {
        const run = await gate();
        const f = fixture();
        const controller = new AbortController();
        const timeoutMs = 90000;
        let marker = false;
        let started = 0;
        const originalGit = childProcess.spawnSync;
        const originalUnlink = fs.unlinkSync;
        if (mode === 'publication-abort') {
            t.mock.method(fs, 'unlinkSync', ((path: Parameters<typeof originalUnlink>[0]) => {
                const result = originalUnlink(path);
                if (String(path) === join(f.root, '.fresh-start-foundation.lock')) {
                    marker = true;
                    controller.abort();
                }
                return result;
            }) as typeof originalUnlink);
        }
        else {
            t.mock.method(childProcess, 'spawnSync', ((...args: Parameters<typeof originalGit>) => {
                if (!marker && args[0] === 'git' && args[1]?.includes(f.root)
                    && args[1]?.includes('rev-parse') && f.events.some(e => e.stage === 'smoke')) {
                    marker = true;
                    if (mode === 'validation-abort')
                        controller.abort();
                    else {
                        // Real elapsed time crosses the original budget inside final validation.
                        const delay = Math.max(1, started + timeoutMs + 1000 - performance.now());
                        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
                    }
                }
                return originalGit(...args);
            }) as typeof originalGit);
        }
        syncBuiltinESMExports();
        try {
            started = performance.now();
            const result = await f.run(run, {
                timeoutMs, signal: controller.signal
            });
            assert.equal(marker, true, 'named final boundary was not reached');
            const stages = f.events.filter(e => e.stage);
            assert.equal(stages.length, 34);
            assert.ok(stages.every(e => e.code === 0 && e.nativeCode === 0
                && e.cleanup === 'complete' && e.closure === 'windows-job-active-zero'));
            if (mode === 'deadline')
                assert.ok(performance.now() - started > timeoutMs);
            assert.equal(result, mode === 'publication-abort' ? 130 : 1, 'late final validation/publication must refuse');
            assert.equal(f.events.some(e => e.observation === 'qualification'), false);
            t.diagnostic(`final boundary ${mode}: observed=true; actual native stages=34; positive closure=true`);
        }
        finally {
            controller.abort();
            t.mock.restoreAll();
            syncBuiltinESMExports();
            f.cleanup();
        }
    });
}
