import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pureRetrievalInputs = new Set(['database-core.ts', 'selection-core.ts', 'contracts.ts', 'eligibility.ts', 'ranking.ts']
    .map(name => 'src/orchestrator/retrieval/' + name));
function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
}

/** Independent F1 deployment integrity; this is not signed production evidence. */
export function freshStartBuild(outDir, inspectIsolatedSyntax) {
    const deploymentId = randomUUID();
    const artifacts = new Map();
    const names = ['v2.js', 'v2-admin.js', 'workers/project-store.worker.js',
        'internal/v2-internal-verified-read.js', 'internal/v2-internal-verified-read-cleanup.js'];
    const captures = new Map();
    const sourceRoot = path.resolve(outDir, '..');
    return {
        options: {
            define: { __V2_DEPLOYMENT_ID__: JSON.stringify(deploymentId) },
            metafile: true,
            write: false,
            plugins: [{ name: 'fresh-start-captured-inputs', setup(build) {
                build.onLoad({ filter: /\.[cm]?[jt]s$/, namespace: 'file' }, args => {
                    const name = path.relative(sourceRoot, args.path).split(path.sep).join('/');
                    if (!/^(src\/|node_modules\/)[a-zA-Z0-9_./@-]+\.[cm]?[jt]s$/.test(name)) throw new Error('FRESH_START_BUILD_MISMATCH');
                    const bytes = readFileSync(args.path);
                    const entry = { path: name, bytes: bytes.length, sha256: digest(bytes) };
                    if (captures.has(name) && canonical(captures.get(name).entry) !== canonical(entry)) throw new Error('FRESH_START_BUILD_MISMATCH');
                    captures.set(name, { entry, bytes });
                    return { contents: bytes, loader: name.endsWith('.ts') ? 'ts' : 'js', resolveDir: path.dirname(args.path) };
                });
            } }],
            // Bundled CJS dependencies may require Node builtins; no external packages.
            banner: { js: "import { createRequire as __v2CreateRequire } from 'node:module'; const require = __v2CreateRequire(import.meta.url);" },
        },
        accept(result) {
            if (result.warnings.length || result.outputFiles.length !== 1) throw new Error('FRESH_START_BUILD_MISMATCH');
            for (const output of Object.values(result.metafile.outputs)) for (const item of output.imports) {
                if (!item.external || !isBuiltin(item.path)) throw new Error('FRESH_START_BUILD_MISMATCH');
            }
            const file = result.outputFiles[0];
            const name = path.relative(outDir, file.path).split(path.sep).join('/');
            if (!names.includes(name) || artifacts.has(name)) throw new Error('FRESH_START_BUILD_MISMATCH');
            const artifact = { path: name, bytes: file.contents.length, sha256: digest(file.contents) };
            if (names.slice(3).includes(name)) {
                const inputs = Object.entries(result.metafile.inputs).map(([inputName, input]) => {
                    const captured = captures.get(inputName);
                    if (!captured || captured.entry.bytes !== input.bytes || /\/(?:stable-directory|builder|coordinator|integrity|manifest)\.ts$|\/workers\//.test(inputName)
                        || (inputName.includes('/retrieval/') && !pureRetrievalInputs.has(inputName))) throw new Error('FRESH_START_BUILD_MISMATCH');
                    inspectIsolatedSyntax(inputName, captured.bytes, false);
                    for (const imported of input.imports) if (/^(node:)?(child_process|worker_threads)$/.test(imported.path)) throw new Error('FRESH_START_BUILD_MISMATCH');
                    return captured.entry;
                }).sort((a, b) => a.path.localeCompare(b.path));
                const runtimeImports = [...new Set(Object.values(result.metafile.outputs).flatMap(output => output.imports.map(item => item.path)))].sort();
                if (runtimeImports.some(value => /^(node:)?(child_process|worker_threads)$/.test(value))) throw new Error('FRESH_START_BUILD_MISMATCH');
                inspectIsolatedSyntax(name, Buffer.from(file.contents), true);
                mkdirSync(path.dirname(file.path), { recursive: true });
                writeFileSync(file.path + '.closure.json', canonical({ artifact, inputs, runtimeImports, sourceChecked: true, emittedChecked: true, metafile: result.metafile }) + '\n');
            }
            artifacts.set(name, artifact);
            mkdirSync(path.dirname(file.path), { recursive: true });
            writeFileSync(file.path, file.contents);
        },
        finish() {
            if (artifacts.size !== names.length) throw new Error('FRESH_START_BUILD_MISMATCH');
            for (const captured of captures.values()) {
                const bytes = readFileSync(path.join(sourceRoot, captured.entry.path));
                if (captured.entry.bytes !== bytes.length || captured.entry.sha256 !== digest(bytes)) throw new Error('FRESH_START_BUILD_MISMATCH');
            }
            const entries = names.map(name => {
                const entry = artifacts.get(name), bytes = readFileSync(path.join(outDir, name));
                if (entry.bytes !== bytes.length || entry.sha256 !== digest(bytes)) throw new Error('FRESH_START_BUILD_MISMATCH');
                return entry;
            });
            const body = { schemaVersion: 1, deploymentId, runtime: { nodeVersion: process.versions.node,
                platform: process.platform, arch: process.arch, executableSha256: digest(readFileSync(process.execPath)) }, artifacts: entries };
            writeFileSync(path.join(outDir, 'v2-build.json'), canonical({ ...body, buildIdentityHash: digest(canonical(body)) }) + '\n');
        },
    };
}
