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
export function createCiDiagnosticCollector(write) {
    let incomplete = false;
    const encountered = new Set();
    function closed(value, keys) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !descriptors[key]
            || !Object.hasOwn(descriptors[key], 'value'))) throw new Error('invalid');
        return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
    }
    const cases = ['recipe-measurement', 'regular-control', 'link-control', 'size-control', 'read-control', 'identity-control', 'path-control',
        'coordinator-control', 'manifest-control', 'integrity-control', 'admission-control', 'durability-control', 'cleanup-control'];
    const predicate = value => typeof value === 'boolean' || value === 'unknown';
    const decimal = value => value === 'unknown' || typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
    return { observe(record) {
        if (incomplete) return false;
        try {
            const family = Object.getOwnPropertyDescriptor(record, 'family')?.value;
            const build = family === 'build';
            const sanitized = closed(record, ['schemaVersion', 'family', 'caseId', 'platform', 'boundary', 'phase',
                ...(build ? ['recipeId'] : []), 'reason', 'observed']);
            if (sanitized.schemaVersion !== 1 || !cases.includes(sanitized.caseId)
                || !['aix', 'android', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd'].includes(sanitized.platform)) throw new Error('invalid');
            const predicates = build ? ['regular', 'singleLink', 'withinSizeLimit', 'descriptorEqual', 'pathEqual', 'sizeEqual', 'mtimeEqual', 'ctimeEqual']
                : ['absolute', 'normalized', 'resolved', 'statSuccess', 'nativeRealpathSuccess', 'directory', 'symlink', 'canonicalEqual', 'relativeAbsolute', 'parentEscape', 'walkReachedBase'];
            const counts = build ? ['linkCount', 'size', 'limit'] : [];
            sanitized.observed = closed(sanitized.observed, [...predicates, ...counts, 'operation', 'errorCode']);
            if (predicates.some(key => !predicate(sanitized.observed[key])) || counts.some(key => !decimal(sanitized.observed[key]))
                || !['lstat', 'realpath', 'open', 'fstat', 'read', 'close', 'none', 'unknown'].includes(sanitized.observed.operation)
                || !['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'EIO', 'none', 'unknown'].includes(sanitized.observed.errorCode)) throw new Error('invalid');
            if (build ? sanitized.phase !== 'guard-observation' || !rehearsalRecipePaths.includes(sanitized.recipeId)
                || !['recipe-path', 'descriptor-before', 'read', 'descriptor-after'].includes(sanitized.boundary)
                || !['path', 'non-regular', 'link-count', 'size', 'short-read', 'identity-change', 'filesystem', 'unknown'].includes(sanitized.reason)
                : !['coordinator', 'manifest', 'integrity', 'fresh-admission', 'durable-directory'].includes(family)
                || sanitized.boundary !== 'path-snapshot' || sanitized.phase !== 'pre-boundary-snapshot'
                || !['snapshot', 'filesystem'].includes(sanitized.reason)) throw new Error('invalid');
            const key = `${sanitized.caseId}:${sanitized.boundary}`;
            if (encountered.size >= 16 || encountered.has(key)) throw new Error('invalid');
            const line = JSON.stringify(sanitized);
            if (Buffer.byteLength(line, 'utf8') > 2048) throw new Error('invalid');
            write(line); encountered.add(key); return true;
        } catch { incomplete = true; return false; }
    }, get incomplete() { return incomplete; } };
}
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
function observeBuild(observation, name, boundary, reason, observed = {}) {
    if (!observation) return;
    try {
        observation.observe({ schemaVersion: 1, family: 'build', caseId: observation.caseId, platform: process.platform,
            boundary, phase: 'guard-observation', recipeId: name, reason, observed: {
                regular: 'unknown', singleLink: 'unknown', withinSizeLimit: 'unknown', linkCount: 'unknown', size: 'unknown', limit: 'unknown',
                descriptorEqual: 'unknown', pathEqual: 'unknown', sizeEqual: 'unknown', mtimeEqual: 'unknown', ctimeEqual: 'unknown',
                operation: 'none', errorCode: 'none', ...observed } });
    } catch { /* Observation never replaces a product outcome. */ }
}
function observedFilesystem(observation, name, boundary, operation, action) {
    if (!observation) return action();
    try { return action(); }
    catch (error) {
        let code;
        try { code = Object.getOwnPropertyDescriptor(error, 'code')?.value; } catch { /* Unavailable error metadata stays unknown. */ }
        observeBuild(observation, name, boundary, 'filesystem', { operation,
            errorCode: ['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'EIO'].includes(code) ? code : 'unknown' });
        throw error;
    }
}
function observedRefusal(observation, name, boundary, reason, observed) {
    observeBuild(observation, name, boundary, reason, observed); buildRefusal();
}
function checkedPath(name, observation) {
    if (typeof name !== 'string' || name.length > 240 || !/^[a-zA-Z0-9_@./-]+$/.test(name)
        || name.split('/').some(p => !p || p === '.' || p === '..')) observedRefusal(observation, name, 'recipe-path', 'path');
    const absolute = path.join(rehearsalBuildRoot, name);
    let cursor = rehearsalBuildRoot;
    for (const part of name.split('/')) {
        cursor = path.join(cursor, part);
        if (observedFilesystem(observation, name, 'recipe-path', 'lstat', () => fs.lstatSync(cursor)).isSymbolicLink())
            observedRefusal(observation, name, 'recipe-path', 'path');
    }
    if (observedFilesystem(observation, name, 'recipe-path', 'realpath', () => fs.realpathSync(absolute)) !== absolute)
        observedRefusal(observation, name, 'recipe-path', 'path');
    return absolute;
}
export function readBuildBytes(name, maximum = MAX_FILE, observation) {
    return readAbsoluteBuildBytes(checkedPath(name, observation), maximum, observation, name);
}
function readAbsoluteBuildBytes(absolute, maximum, observation, name) {
    const fd = observedFilesystem(observation, name, 'descriptor-before', 'open', () => fs.openSync(absolute, 'r'));
    try {
        const before = observedFilesystem(observation, name, 'descriptor-before', 'fstat', () => fs.fstatSync(fd, { bigint: true }));
        const regular = before.isFile(), singleLink = regular ? before.nlink === 1n : 'unknown';
        const withinSizeLimit = singleLink === true ? before.size <= BigInt(maximum) : 'unknown';
        if (!regular || singleLink === false || withinSizeLimit === false) observedRefusal(observation, name, 'descriptor-before',
            !regular ? 'non-regular' : singleLink === false ? 'link-count' : 'size',
            { regular, singleLink, withinSizeLimit, linkCount: String(before.nlink), size: String(before.size), limit: String(maximum) });
        const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
        while (offset < bytes.length) {
            const count = observedFilesystem(observation, name, 'read', 'read', () => fs.readSync(fd, bytes, offset, bytes.length - offset, offset));
            if (count === 0) observedRefusal(observation, name, 'read', 'short-read',
                { regular, singleLink, withinSizeLimit, linkCount: String(before.nlink), size: String(before.size), limit: String(maximum) }); offset += count;
        }
        const after = observedFilesystem(observation, name, 'descriptor-after', 'fstat', () => fs.fstatSync(fd, { bigint: true })),
            leaf = observedFilesystem(observation, name, 'descriptor-after', 'lstat', () => fs.lstatSync(absolute, { bigint: true }));
        for (const stat of [after, leaf]) {
            const finalRegular = stat.isFile(), finalSingleLink = finalRegular ? stat.nlink === 1n : 'unknown';
            const identityEqual = finalSingleLink === true ? stat.dev === before.dev && stat.ino === before.ino : 'unknown';
            const sizeEqual = identityEqual === true ? stat.size === before.size : 'unknown';
            const mtimeEqual = sizeEqual === true ? stat.mtimeNs === before.mtimeNs : 'unknown';
            const ctimeEqual = mtimeEqual === true ? stat.ctimeNs === before.ctimeNs : 'unknown';
            if (!finalRegular || finalSingleLink === false || identityEqual === false || sizeEqual === false || mtimeEqual === false || ctimeEqual === false)
                observedRefusal(observation, name, 'descriptor-after', !finalRegular ? 'non-regular' : finalSingleLink === false ? 'link-count' : 'identity-change',
                    { regular: finalRegular, singleLink: finalSingleLink, withinSizeLimit: 'unknown', linkCount: String(stat.nlink), size: String(stat.size), limit: String(maximum),
                        descriptorEqual: stat === after ? identityEqual : true, pathEqual: stat === leaf ? identityEqual : 'unknown', sizeEqual, mtimeEqual, ctimeEqual });
        }
        return bytes;
    } finally { observedFilesystem(observation, name, 'descriptor-after', 'close', () => fs.closeSync(fd)); }
}
export function measureBuildFiles(names, observation) {
    if (names.length > 512 || new Set(names).size !== names.length) buildRefusal();
    let total = 0;
    return [...names].sort().map(name => {
        const bytes = readBuildBytes(name, MAX_FILE, observation); total += bytes.length;
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
