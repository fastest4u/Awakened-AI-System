import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire, isBuiltin } from 'node:module';

// Private trusted-producer consistency helpers. These grant no source/target authority.
export const rehearsalBuildRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const rehearsalManifestPath = 'dist/internal/v2-shadow-migration-build.json';
export const rehearsalArtifactPaths = Object.freeze(['dist/internal/stable-compatibility-directory.worker.js',
    'dist/internal/v2-shadow-migration-rehearsal.js', 'scripts/run-v2-shadow-migration-rehearsal.js']);
const nativePackage = `node_modules/@esbuild/${process.platform}-${process.arch}`;
const nativeSubpath = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
export const rehearsalRecipePaths = Object.freeze(['package.json', 'package-lock.json', 'tsconfig.json', 'scripts/build.js', 'scripts/fresh-start-build.js',
    'node_modules/zod/package.json', 'node_modules/esbuild/package.json', 'node_modules/esbuild/lib/main.js',
    'node_modules/typescript/package.json', 'node_modules/typescript/lib/typescript.js',
    `${nativePackage}/package.json`, `${nativePackage}/${nativeSubpath}`].sort());
const DOMAIN = 'project-memory/v2-shadow-migration-private-build/v1\n';
const HASH = /^[0-9a-f]{64}$/;
const MAX_FILE = 32 * 1024 * 1024, MAX_TOTAL = 128 * 1024 * 1024;
export function buildRefusal() { throw new Error('REHEARSAL_BUILD_INVALID'); }
export const buildDigest = bytes => createHash('sha256').update(bytes).digest('hex');
export function buildCanonical(value) {
    if (Array.isArray(value)) return `[${value.map(buildCanonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${buildCanonical(value[k])}`).join(',')}}`;
    return JSON.stringify(value);
}
function checkedPath(name) {
    if (typeof name !== 'string' || name.length > 240 || !/^[a-zA-Z0-9_@./-]+$/.test(name)
        || name.split('/').some(p => !p || p === '.' || p === '..')) buildRefusal();
    const absolute = path.join(rehearsalBuildRoot, name);
    let cursor = rehearsalBuildRoot;
    for (const part of name.split('/')) {
        cursor = path.join(cursor, part);
        if (fs.lstatSync(cursor).isSymbolicLink()) buildRefusal();
    }
    if (fs.realpathSync(absolute) !== absolute) buildRefusal();
    return absolute;
}
export function readBuildBytes(name, maximum = MAX_FILE) {
    return readAbsoluteBuildBytes(checkedPath(name), maximum);
}
function readAbsoluteBuildBytes(absolute, maximum) {
    const fd = fs.openSync(absolute, 'r');
    try {
        const before = fs.fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum)) buildRefusal();
        const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (count === 0) buildRefusal(); offset += count;
        }
        const after = fs.fstatSync(fd, { bigint: true }), leaf = fs.lstatSync(absolute, { bigint: true });
        for (const stat of [after, leaf]) if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== before.dev || stat.ino !== before.ino
            || stat.size !== before.size || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs) buildRefusal();
        return bytes;
    } finally { fs.closeSync(fd); }
}
export function measureBuildFiles(names) {
    if (names.length > 512 || new Set(names).size !== names.length) buildRefusal();
    let total = 0;
    return [...names].sort().map(name => {
        const bytes = readBuildBytes(name); total += bytes.length;
        if (total > MAX_TOTAL) buildRefusal();
        return { path: name, bytes: bytes.length, sha256: buildDigest(bytes) };
    });
}
export function assertBuildFiles(entries) {
    if (buildCanonical(measureBuildFiles(entries.map(e => e.path))) !== buildCanonical(entries)) buildRefusal();
}
export function assertBuildResolutionMetadata(names) {
    const visited = new Set();
    for (const name of names) {
        let parent = path.posix.dirname(name);
        while (parent !== '.' && !visited.has(parent)) {
            visited.add(parent);
            for (const leaf of ['package.json', 'tsconfig.json', 'jsconfig.json']) {
                const candidate = `${parent}/${leaf}`;
                if (fs.existsSync(path.join(rehearsalBuildRoot, candidate)) && !rehearsalRecipePaths.includes(candidate)) buildRefusal();
            }
            parent = path.posix.dirname(parent);
        }
    }
}
export function assertBuildToolResolution() {
    try {
        if (process.env.ESBUILD_BINARY_PATH) buildRefusal();
        // Refuse nearer namespaces explicitly, including on cached finalization checks.
        // Node may cache a prior resolution; their newly added files must not be hidden.
        for (const name of ['scripts/node_modules', 'node_modules/esbuild/node_modules', 'node_modules/esbuild/lib/node_modules',
            'node_modules/typescript/node_modules', 'node_modules/typescript/lib/node_modules']) {
            try { fs.lstatSync(path.join(rehearsalBuildRoot, name)); buildRefusal(); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const entries = { esbuild: 'node_modules/esbuild/lib/main.js', typescript: 'node_modules/typescript/lib/typescript.js' };
        const native = `${nativePackage}/${nativeSubpath}`;
        assertBuildResolutionMetadata([...Object.values(entries), native, 'scripts/run-v2-shadow-migration-rehearsal.js']);
        const selected = {};
        for (const [name, entry] of Object.entries(entries)) {
            // This module and build.js share scripts/, hence the same ESM lookup scope.
            // import.meta.resolve also honors import-conditional package exports.
            const actual = import.meta.resolve(name), expected = pathToFileURL(checkedPath(entry)).href;
            if (actual !== expected) buildRefusal();
            selected[name] = actual;
        }
        // Match the installed wrapper's own CommonJS package-subpath resolution.
        // No missing-package fallback, downloaded binary or alternate path is admitted.
        const fromWrapper = createRequire(selected.esbuild);
        if (fromWrapper.resolve(`${nativePackage.slice('node_modules/'.length)}/${nativeSubpath}`) !== checkedPath(native)) buildRefusal();
        return Object.freeze(selected);
    } catch { buildRefusal(); }
}
function git(args) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    return execFileSync('git', ['-c', 'core.fsmonitor=false', '--no-optional-locks', ...args],
        { cwd: rehearsalBuildRoot, env, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function cleanBuildHead() {
    try {
        if (fs.realpathSync(git(['rev-parse', '--show-toplevel'])) !== rehearsalBuildRoot
            || git(['rev-parse', '--is-inside-work-tree']) !== 'true'
            || git(['status', '--porcelain=v1', '--untracked-files=all']) !== ''
            || git(['ls-files', '-v']).split('\n').some(line => line && !line.startsWith('H '))) return null;
        const head = git(['rev-parse', '--verify', 'HEAD^{commit}']);
        return /^[0-9a-f]{40}$/.test(head) ? head : null;
    } catch { return null; }
}
export function assertCommittedBuildFiles(entries) {
    const tracked = entries.filter(e => !e.path.startsWith('node_modules/'));
    const tree = new Map(git(['ls-tree', '-rz', '--full-tree', 'HEAD', '--', ...tracked.map(e => e.path)]).split('\0').filter(Boolean).map(line => {
        const match = /^100(?:644|755) blob ([0-9a-f]{40})\t(.+)$/.exec(line);
        if (!match) buildRefusal(); return [match[2], match[1]];
    }));
    for (const entry of tracked) {
        const blob = tree.get(entry.path); if (!blob) buildRefusal();
        const bytes = readBuildBytes(entry.path);
        const objectHash = value => createHash('sha1').update(`blob ${value.length}\0`).update(value).digest('hex');
        // Git's normal Windows text checkout may use CRLF; the manifest still binds raw bytes.
        if (objectHash(bytes) !== blob) {
            const attributes = git(['check-attr', 'text', 'filter', '--', entry.path]);
            if (attributes.includes(': text: unset') || !attributes.includes(': filter: unspecified')
                || objectHash(Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'))) !== blob) buildRefusal();
        }
    }
}
export function buildRuntimeIdentity() {
    return { nodeVersion: process.version, platform: process.platform, architecture: process.arch,
        executableSha256: buildDigest(readAbsoluteBuildBytes(process.execPath, 256 * 1024 * 1024)) };
}
export function buildToolIdentity() {
    const identity = { esbuildVersion: JSON.parse(readBuildBytes('node_modules/esbuild/package.json')).version,
        typescriptVersion: JSON.parse(readBuildBytes('node_modules/typescript/package.json')).version };
    if (Object.values(identity).some(version => typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))) buildRefusal();
    return identity;
}
export function privateBuildIdentity(body) { return buildDigest(DOMAIN + buildCanonical(body)); }
function exact(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) buildRefusal();
}
function entries(value, expectedPaths) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 512) buildRefusal();
    let total = 0, previous = '';
    for (const entry of value) {
        exact(entry, ['path', 'bytes', 'sha256']);
        if (typeof entry.path !== 'string' || entry.path <= previous || !Number.isSafeInteger(entry.bytes)
            || entry.bytes < 0 || entry.bytes > MAX_FILE || typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256)) buildRefusal();
        if (!expectedPaths && !/^(src\/[a-zA-Z0-9_./-]+\.ts|node_modules\/zod\/[a-zA-Z0-9_./-]+\.js)$/.test(entry.path)) buildRefusal();
        previous = entry.path; total += entry.bytes;
    }
    if (total > MAX_TOTAL || (expectedPaths && buildCanonical(value.map(e => e.path)) !== buildCanonical([...expectedPaths].sort()))) buildRefusal();
}
function decodeManifest(bytes) {
    const value = JSON.parse(bytes.toString('utf8'));
    exact(value, ['schemaVersion', 'eligible', 'commit', 'runtime', 'buildTools', 'recipes', 'inputs', 'artifacts', 'runtimeImports', 'buildIdentityHash']);
    if (value.schemaVersion !== 1 || value.eligible !== true || !/^[0-9a-f]{40}$/.test(value.commit)
        || !HASH.test(value.buildIdentityHash) || bytes.toString('utf8') !== buildCanonical(value) + '\n') buildRefusal();
    exact(value.runtime, ['nodeVersion', 'platform', 'architecture', 'executableSha256']);
    exact(value.buildTools, ['esbuildVersion', 'typescriptVersion']);
    if (buildCanonical(value.runtime) !== buildCanonical(buildRuntimeIdentity())
        || buildCanonical(value.buildTools) !== buildCanonical(buildToolIdentity())) buildRefusal();
    entries(value.recipes, rehearsalRecipePaths); entries(value.inputs); entries(value.artifacts, rehearsalArtifactPaths);
    if (!Array.isArray(value.runtimeImports) || value.runtimeImports.length === 0 || value.runtimeImports.length > 100
        || value.runtimeImports.some((name, i) => typeof name !== 'string' || !isBuiltin(name) || (i && name <= value.runtimeImports[i - 1]))) buildRefusal();
    const { buildIdentityHash, ...body } = value;
    if (privateBuildIdentity(body) !== buildIdentityHash) buildRefusal();
    return value;
}

// No import of the built entry occurs here. C3 must call this before import and
// retain assertUnchanged through finalization; a handoff is consistency only.
export function validateV2ShadowMigrationBuild(buildIdentityHash) {
    try {
        if (typeof buildIdentityHash !== 'string' || !HASH.test(buildIdentityHash)) buildRefusal();
        const bytes = readBuildBytes(rehearsalManifestPath, 256 * 1024), value = decodeManifest(bytes);
        const check = () => {
            if (cleanBuildHead() !== value.commit || buildIdentityHash !== value.buildIdentityHash
                || !readBuildBytes(rehearsalManifestPath, 256 * 1024).equals(bytes)
                || buildCanonical(buildRuntimeIdentity()) !== buildCanonical(value.runtime)) buildRefusal();
            assertBuildFiles(value.recipes); assertBuildFiles(value.inputs); assertBuildFiles(value.artifacts);
            assertBuildToolResolution();
            assertBuildResolutionMetadata(value.inputs.map(entry => entry.path));
            assertCommittedBuildFiles([...value.recipes, ...value.inputs, value.artifacts[2]]);
            if (cleanBuildHead() !== value.commit) buildRefusal();
        };
        check();
        return Object.freeze({ commit: value.commit, buildIdentityHash, assertUnchanged: () => { try { check(); } catch { buildRefusal(); } } });
    } catch { buildRefusal(); }
}

async function runCommand(args) {
    if (process.env.NODE_ENV !== 'production-rehearsal') buildRefusal();
    const names = ['--config', '--source-root', '--package-root', '--work-root', '--evidence-output'];
    if (args.length !== names.length * 2) buildRefusal();
    const values = new Map();
    for (let index = 0; index < args.length; index += 2) {
        const name = args[index], value = args[index + 1];
        if (!names.includes(name) || values.has(name) || !value || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes('\0')) buildRefusal();
        values.set(name, value);
    }
    const configPath = values.get('--config');
    let cursor = configPath;
    while (true) {
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink() || fs.realpathSync.native(cursor) !== cursor) buildRefusal();
        const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    const configBytes = readAbsoluteBuildBytes(configPath, 1024 * 1024);
    const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configBytes));
    if (!config || typeof config !== 'object' || Array.isArray(config)) buildRefusal();
    const build = validateV2ShadowMigrationBuild(config.buildIdentityHash);
    const originalConfig = fs.lstatSync(configPath, { bigint: true });
    const assertUnchanged = () => {
        build.assertUnchanged();
        const current = fs.lstatSync(configPath, { bigint: true });
        if (current.dev !== originalConfig.dev || current.ino !== originalConfig.ino
            || !readAbsoluteBuildBytes(configPath, 1024 * 1024).equals(configBytes)) buildRefusal();
    };
    assertUnchanged();
    // The manifest and all consumed artifacts were checked before this sole built import.
    const entry = await import(pathToFileURL(path.join(rehearsalBuildRoot, 'dist/internal/v2-shadow-migration-rehearsal.js')).href);
    const result = await entry.runV2ShadowMigrationRehearsal({ config, sourceRoot: values.get('--source-root'),
        packageRoot: values.get('--package-root'), workRoot: values.get('--work-root'), evidenceOutput: values.get('--evidence-output') },
        { commit: build.commit, buildIdentityHash: build.buildIdentityHash, protectedRoots: [rehearsalBuildRoot, configPath], assertUnchanged });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.gates.some(gate => gate.status !== 'passed')) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runCommand(process.argv.slice(2)).catch(() => { process.stderr.write('REHEARSAL_REFUSED\n'); process.exitCode = 1; });
}
