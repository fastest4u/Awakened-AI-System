import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { rehearsalBuildRoot, readBuildBytes, readBuildFileSnapshot, assertBuildToolResolution,
    buildDigest, buildCanonical, buildRefusal } from './run-v2-shadow-migration-rehearsal.js';

const VERSION = '0.28.2';
const ESBUILD_INTEGRITY = 'sha512-HKVLS8dvII+xoKW9kmqxbRKrnWEXfJJr/FZhhJmiqIB0e053QNYFqOBouTMO/k5sID4MvCiUCvv8b9M4h32wIA==';
// Reviewed lock identities, never learned from installed package metadata/bytes.
// These lock records do not broaden the existing resolver's platform admission.
const NATIVE_LOCK_INTEGRITIES = Object.freeze({
    'aix-ppc64': 'sha512-XExcO+dvLKvVtNTibSTBej1NCAbaGhWn9Ww1ZPx80qsahhPFe/8jgWP0IchNe0F3HwkU7n8ejhH8bjonqht8mQ==',
    'android-arm': 'sha512-kXXoiPVVGQcnIYGOeaovwOURpniDBpSq4A03qkQ+BMQqtGG6HYap3xne9C1O1yo4TR3qxlCX5IqqmX6fFo2Lqg==',
    'android-arm64': 'sha512-5YfKeeI8qWfBZIX+u2xZC3Zlb3Os/gLS2sbEKM+I4ZOcsWmHS2WLysCcQZDAFRslDUU5Oiq44gf6PYN1vGwG5A==',
    'android-x64': 'sha512-O387ite7SzUyCcy3JQX4P4bLtEA7bLLkx+esve5JHnyYfNTxcVpXZo9jhdB0lTKN44gztELTdU7nS8Nr16Fs1Q==',
    'darwin-arm64': 'sha512-n4KqkOQrraxHJcgjM1RvwbigfQKIKJVpM7xp+KsxiyUSrRdIXnt73VhrPAx0fV44hgfmIVKjxMN9J1t5jySVkw==',
    'darwin-x64': 'sha512-uq6suIWYP37qzGddBKPw5QEQPi6HiLGsO7UmkpfyaYNQ3D+rN6w6WfwH+nuqcGXWvawGwxOEroO4YGnFh95azw==',
    'freebsd-arm64': 'sha512-n+I0BTSRIoy+d6RPKnEVwql5UwBJolytvY4mAOIEJorKlqgPII8ix6slVVrfZ5Tnj7glIZvloylbB/EJPMWEXw==',
    'freebsd-x64': 'sha512-78XJTJkvPs0kz2w61301PJjXl4g7q3JqiYMZ/M/yVI73EHBrCRTgkhu9oqG7vPqq+a/yadEW8aD+agKlk5xrmg==',
    'linux-arm': 'sha512-XlDnu2q5yoqems+xay6wSAcg9DDD7K9RLKZEBOMZm3ckNpJBvOX20tSfby8KfrrhINDyv9V2YVZKY/SpoGJI8w==',
    'linux-arm64': 'sha512-pW4AC0P3it8c7do9MVM4p51FzHzdM/TZrerurgRcHJ2WTa1VQ1CIq18xncfpBJw4ojkiZZrKW2yIBWBP92j6Ug==',
    'linux-ia32': 'sha512-CYbnj78HsIeA+DhgUKgFCfvNsTHFhMMrinUrMZpDXJXKN8T3XViTZ/+wtHeVxEWY8ewSzTFN+nRmSwO2tZaLUQ==',
    'linux-loong64': 'sha512-buwkd8nsph4R+ajRvw0qM5Hja/TXQow3ptzWO2EbG/cqcIkHloRrdlBtQlshyYGTNFvfkfJ5tpPLVkY4DtsPfQ==',
    'linux-mips64el': 'sha512-ZVykbDyk7519VwiNb9Lcj9m8XM6v5V9uKPvrEMkkEedVewf+0itkhahp4HDpgERXhwLRpWFypsGbG/J8s0QjJA==',
    'linux-ppc64': 'sha512-CAXl+Dtd9UUuJd8pKKdwh6MLm3MUMiqMPmhZ3tTSXPqfyQ3vDl6R5hZdZ/kYojK4ofXtdfSv1tFq8XzWx3heNQ==',
    'linux-riscv64': 'sha512-GeXCej4IQtU1B+QlDV8W/RRvbzI3O/Stss+/bCXv4lZls5WGRtu2a+3JkA3i4qIUlMXpcHebWpF8AkJhATowuA==',
    'linux-s390x': 'sha512-3H1weTYZPxt/WOhByszQZybS9w5lKzUn1FDMsgEChbHWQwHYQQRfBxgCcZvPhjHfKyJjIievvMmEUawJrdY9Dg==',
    'linux-x64': 'sha512-4xTZr1FUmSoQW4XIWmit3tzQrUTZM+N3P0XV8xROKYF50XfI7xeO90+1bZvNwxIufQ9hDQVRJH5YhgPVF8A/HQ==',
    'netbsd-arm64': 'sha512-sSATRjPeDBg3pdgHoQfoYBob11Kk1FGa9lui5RIHZCoCkJa9QKlvl3/vKz2usCmYYjs7ymJR/2Nnsqe+Hjt5nw==',
    'netbsd-x64': 'sha512-lqnzCV+mM0gIADaKihiCg6ifgfU2L3h5E33rNQBN1Y4MaVGnzryzmvvf7UHxprpQdE8hpqLolJ9Rl+SkIRDpyw==',
    'openbsd-arm64': 'sha512-AL2qJILH7lNjrDmCQDvdxMfAUIv8KMNZOvrwAQ8i8//ntL9FflhOyMJ8OZSMBb8/AWXe3/5v5S20y3zCoZWKoQ==',
    'openbsd-x64': 'sha512-QtiuPytchRyC4rwUKhexJdQKvDuZ6hWloi3igqPQNUJCS1/v9EiO3UTOXR6A3FoMo4fnAKbWJdqaIwhOzh8qEw==',
    'openharmony-arm64': 'sha512-WkhYDmpTjLvGlScA1rwjRUmhl4k8oXR3cIbtqWmELgU/dFeHHlEllxDvdWcNJV9rbzCexB5vz8gtNewWLgCT7Q==',
    'sunos-x64': 'sha512-GPMSkTOtMnv2U2F8gxe4Io6qmVs+YKyp832Etqqxr0hFngmXQ3rzwytelm3GIn7T4VviRUlf3sOgBOiTdvaf7g==',
    'win32-arm64': 'sha512-PIhhEkE9uPBleRBrQEJpUn7MBnibZzbGzYWPmY3x+YoVg/95zbjB4CxPPOQ8l5tYYM4mMaCthF8/1DIfBQQyWQ==',
    'win32-ia32': 'sha512-YmJbfTlvU7Sdn9BB+4PRES4oB6pxgS37MAONj+hBr/cpXS1aBPKXxNnDbu+QCWPj0o9dgyxeq79g6c5P8KeuYA==',
    'win32-x64': 'sha512-5ebpxr3nWMzrL/rnUI755Jkuee0bHL/Gq0WTF9lvcpv73wAp5eu8MfBUgWK9bhWvZjj7yX8etf/8tI8Ney695g==',
});
// Independent reviewed 0.28.2 executable pins from the approved A specification.
// Mutable installed metadata cannot introduce a trusted native digest.
const NATIVE_DIGESTS = Object.freeze({
    '@esbuild/aix-ppc64/bin/esbuild': '6de148b932fc5d3b28a97f9f0bc4de8e2b47db478b8ad679e0eaa6b96e00420d',
    '@esbuild/android-arm64/bin/esbuild': '84efbbd2cbf21bbfec2aaf304bee79cb2a4a05fe2ea7b861a87f7b8f213ac27d',
    '@esbuild/darwin-arm64/bin/esbuild': '10b6243df618d374bb2d5c9cfbe7052e1405f6aa4e53a6164f11a91b9f2e1384',
    '@esbuild/darwin-x64/bin/esbuild': '7fe5c9c905fff0a05d92db98929434ab4d3b6dd92d7a7688922db74380c75df3',
    '@esbuild/freebsd-arm64/bin/esbuild': '6aba108a68b93064e491bfb1ecfa28843b4d4e504dff0627f53f68f6bb015c01',
    '@esbuild/freebsd-x64/bin/esbuild': '8a237e222bee0e50556e7b00d83ec2ff43721bf72f19811a5f0ee56f1d40177c',
    '@esbuild/linux-arm/bin/esbuild': 'd88f751b22095b2f3b42c8c2e8a3f36fabc1705438c5d6e78366b681f8b4e7a5',
    '@esbuild/linux-arm64/bin/esbuild': '90bd269553d258e80b19e3ccab4f98f0831f87442a2f056510ce24fd1b425fc2',
    '@esbuild/linux-ia32/bin/esbuild': 'b1e2d87d79f9a2baa0d3043cdf0dc6716f9f2eea66c58f47588641fd6019f36f',
    '@esbuild/linux-loong64/bin/esbuild': '55a66f9854d6798f36b2b5471db74f2e552481887ea14d8bda1634a512383a43',
    '@esbuild/linux-mips64el/bin/esbuild': '6bf7921a3af4a801051e056d85c360fe24bb446f488ef3da25f0b8e5cf973db1',
    '@esbuild/linux-ppc64/bin/esbuild': 'c30df60d09bb0ba4853d7b06e244ce966890d61ce60cadd9b22335f6379c316a',
    '@esbuild/linux-riscv64/bin/esbuild': '36bdcdc8230eef385838cdfeb0d9a1565cbe4b9ace30097a511d77e894de36a1',
    '@esbuild/linux-s390x/bin/esbuild': 'bbbc1f92a76a5ca6e2976065222e42b02797363a1f119490dda315f74047741f',
    '@esbuild/linux-x64/bin/esbuild': 'e1698a3d5c6c0798fee4fd3b5cc816651f460c63d390a7a26ea4beb0b1884100',
    '@esbuild/netbsd-arm64/bin/esbuild': '62548519d7ae875d060aa8c94bfb8ed38ef191671a5173d9f626bdb6b7516970',
    '@esbuild/netbsd-x64/bin/esbuild': 'f9d0e59d2b404559e3a0c958164d96960ebf0e04583b878b1d64d8f1c3698fcc',
    '@esbuild/openbsd-arm64/bin/esbuild': 'e10c45a0b62456632da41df058d7626b2e7cfe710780a2dc7f9f84681753f3aa',
    '@esbuild/openbsd-x64/bin/esbuild': '720bbe607736716f2ecd37962436c5589d801966e868a2ae4e0e7e62d1e4e887',
    '@esbuild/sunos-x64/bin/esbuild': '01a3bd9183631ca749f34d15601ea21ba6834614184c5c859f99d54bd683203d',
    '@esbuild/win32-arm64/esbuild.exe': '530fb3933af14eefe85dfd06502f826e6ef60fdf4e75228ea67c696db312ecb1',
    '@esbuild/win32-ia32/esbuild.exe': 'b2e62af5c17e00939583be0a0762fdc469f352869a617edc91371b00454c76f0',
    '@esbuild/win32-x64/esbuild.exe': 'c7bee37877d0aa6a046e52783fa0a2cf1a9ce5579d68bb3083bda99d4bff18ef',
});
const ROOT_HOOKS = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'dependencies'];
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'];
const DECLARATIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const PACKAGE_NAME = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/;
const PACKAGE_PATH = /^node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(?:\/node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+)*$/;
const PACKAGE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function object(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) buildRefusal();
    return value;
}
function scripts(record) {
    const value = record.scripts === undefined ? {} : object(record.scripts);
    if (Object.values(value).some(command => typeof command !== 'string')) buildRefusal();
    return value;
}
function declarations(record, field) {
    const value = record[field] === undefined ? {} : object(record[field]);
    for (const [name, range] of Object.entries(value)) {
        if (!PACKAGE_NAME.test(name) || name.split('/').some(part => part === '.' || part === '..')
            || typeof range !== 'string' || range.length > 240
            || !/^[~^<>=*|.0-9 xXv+-]+$/.test(range) || !/[0-9* xX]/.test(range)) buildRefusal();
    }
    return value;
}
function absent(name) {
    try { fs.lstatSync(path.join(rehearsalBuildRoot, name)); return false; }
    catch (error) { if (error.code !== 'ENOENT') throw error; return true; }
}
function lockedDependency(packages, from, name) {
    let cursor = from;
    while (true) {
        const candidate = cursor ? `${cursor}/node_modules/${name}` : `node_modules/${name}`;
        if (Object.hasOwn(packages, candidate)) return candidate;
        if (!cursor) return null;
        cursor = path.posix.dirname(cursor);
        if (cursor === '.') cursor = '';
    }
}

function installationPolicy() {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    if (root !== rehearsalBuildRoot || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()
        || fs.realpathSync.native(root) !== root) buildRefusal();
    // The existing reader retains full descriptor/leaf, size, timestamp and link guards.
    const pkg = object(JSON.parse(readBuildBytes('package.json')));
    const lock = object(JSON.parse(readBuildBytes('package-lock.json')));
    const packages = object(lock.packages), rootRecord = object(packages['']);
    if (lock.lockfileVersion !== 3 || Object.keys(packages).length > 512
        || pkg.name !== lock.name || pkg.version !== lock.version || pkg.name !== rootRecord.name || pkg.version !== rootRecord.version
        || !PACKAGE_NAME.test(pkg.name) || !PACKAGE_VERSION.test(pkg.version)) buildRefusal();
    for (const record of [pkg, rootRecord]) {
        if (Object.hasOwn(record, 'workspaces') || Object.hasOwn(record, 'hasInstallScript')
            || ROOT_HOOKS.some(hook => Object.hasOwn(scripts(record), hook))) buildRefusal();
    }
    if (pkg.gypfile !== false && !absent('binding.gyp')) {
        readBuildBytes('binding.gyp'); buildRefusal();
    }
    for (const field of DECLARATIONS) {
        if (buildCanonical(declarations(pkg, field)) !== buildCanonical(declarations(rootRecord, field))) buildRefusal();
    }
    // Root overrides can redirect a registry edge to a local/Git source during ci.
    // Only the existing flat version-range override shape is reviewed here.
    declarations(pkg, 'overrides');
    const required = [], optional = [], setup = [];
    for (const [packagePath, raw] of Object.entries(packages).sort(([a], [b]) => a < b ? -1 : 1)) {
        if (packagePath === '') continue;
        const record = object(raw);
        if (!PACKAGE_PATH.test(packagePath) || packagePath.length > 220
            || packagePath.split('/').some(part => part === '.' || part === '..')
            || typeof record.version !== 'string' || !PACKAGE_VERSION.test(record.version) || Object.hasOwn(record, 'link')
            || Object.hasOwn(record, 'inBundle') || Object.hasOwn(record, 'workspaces')) buildRefusal();
        const name = packagePath.slice(packagePath.lastIndexOf('node_modules/') + 'node_modules/'.length);
        if (record.name !== undefined && record.name !== name) buildRefusal();
        const leaf = name.split('/').at(-1);
        if (record.resolved !== `https://registry.npmjs.org/${name}/-/${leaf}-${record.version}.tgz`
            || typeof record.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(record.integrity)
            || Buffer.from(record.integrity.slice(7), 'base64').toString('base64') !== record.integrity.slice(7)) buildRefusal();
        for (const flag of ['hasInstallScript', 'optional', 'devOptional', 'dev', 'peer', 'gypfile']) {
            if (record[flag] !== undefined && typeof record[flag] !== 'boolean') buildRefusal();
        }
        const installScripts = scripts(record);
        const declaredSetup = INSTALL_HOOKS.filter(hook => Object.hasOwn(installScripts, hook));
        if (record.gypfile === true || declaredSetup.length && (packagePath !== 'node_modules/esbuild'
            || declaredSetup.length !== 1 || declaredSetup[0] !== 'postinstall' || installScripts.postinstall !== 'node install.js')) buildRefusal();
        if (record.hasInstallScript === true || declaredSetup.length) setup.push({ path: packagePath, name, version: record.version });
        (record.optional === true || record.devOptional === true ? optional : required).push(packagePath);
        for (const field of DECLARATIONS) declarations(record, field);
        if (name.startsWith('@esbuild/')) {
            if (record.version !== VERSION || record.optional !== true
                || record.integrity !== NATIVE_LOCK_INTEGRITIES[name.slice('@esbuild/'.length)]) buildRefusal();
        }
    }
    if (buildCanonical(setup) !== buildCanonical([{ path: 'node_modules/esbuild', name: 'esbuild', version: VERSION }])) buildRefusal();
    const esbuild = packages['node_modules/esbuild'];
    const nativeName = `@esbuild/${process.platform}-${process.arch}`;
    if (esbuild.integrity !== ESBUILD_INTEGRITY || esbuild.hasInstallScript !== true
        || !Object.hasOwn(NATIVE_LOCK_INTEGRITIES, nativeName.slice('@esbuild/'.length))
        || !Object.hasOwn(packages, `node_modules/${nativeName}`)
        || declarations(esbuild, 'optionalDependencies')[nativeName] !== VERSION) buildRefusal();
    // Complete lock-derived roots and dependency edges, without filesystem searching.
    for (const [packagePath, record] of Object.entries(packages)) {
        for (const field of ['dependencies', ...(packagePath === '' ? ['devDependencies'] : []), 'optionalDependencies', 'peerDependencies']) {
            for (const name of Object.keys(declarations(record, field))) {
                const optionalPeer = field === 'peerDependencies' && record.peerDependenciesMeta?.[name]?.optional === true;
                if (!lockedDependency(packages, packagePath, name) && field !== 'optionalDependencies' && !optionalPeer) buildRefusal();
            }
        }
    }
    return { packages, required, optional, nativeName };
}

export function assertBuildInstallationPolicy() {
    try { installationPolicy(); }
    catch { buildRefusal(); }
}

function otherPlatform(record) {
    function admits(values, current) {
        if (values === undefined) return true;
        if (!Array.isArray(values) || !values.length || values.some(value => typeof value !== 'string')) buildRefusal();
        const positive = values.filter(value => !value.startsWith('!'));
        return !values.includes(`!${current}`) && (positive.length === 0 || positive.includes(current) || positive.includes('any'));
    }
    return !admits(record.os, process.platform) || !admits(record.cpu, process.arch);
}

function assertInstalledSetupDisposition() {
    const { packages, required, nativeName } = installationPolicy();
    // Required reachability is independent of mutable optional/devOptional flags.
    // Dev is included. Every present package's required dependencies/peers must
    // also exist; an absent platform optional cannot excuse a root-required edge.
    const requiredPaths = new Set([...required, `node_modules/${nativeName}`]);
    for (const [name, record] of Object.entries(packages)) {
        if (name && record.devOptional === true && record.optional !== true) requiredPaths.add(name);
        if (name && !requiredPaths.has(name) && absent(name)) continue;
        for (const field of ['dependencies', ...(name === '' ? ['devDependencies'] : []), 'peerDependencies']) {
            for (const dependency of Object.keys(declarations(record, field))) {
                if (field === 'dependencies' && Object.hasOwn(declarations(record, 'optionalDependencies'), dependency)) continue;
                if (field === 'peerDependencies' && record.peerDependenciesMeta?.[dependency]?.optional === true) continue;
                const resolved = lockedDependency(packages, name, dependency);
                if (!resolved) buildRefusal();
                requiredPaths.add(resolved);
            }
        }
    }
    // Compute the transitive closure even when a falsely optional parent was
    // absent on the first pass and appeared earlier than its required ancestor.
    const pending = [...requiredPaths];
    for (let i = 0; i < pending.length; i++) {
        const from = pending[i], record = packages[from];
        for (const field of ['dependencies', 'peerDependencies']) {
            for (const dependency of Object.keys(declarations(record, field))) {
                if (field === 'dependencies' && Object.hasOwn(declarations(record, 'optionalDependencies'), dependency)) continue;
                if (field === 'peerDependencies' && record.peerDependenciesMeta?.[dependency]?.optional === true) continue;
                const resolved = lockedDependency(packages, from, dependency);
                if (!resolved) buildRefusal();
                if (!requiredPaths.has(resolved)) { requiredPaths.add(resolved); pending.push(resolved); }
            }
        }
    }
    for (const [name, record] of Object.entries(packages)) {
        if (!name) continue;
        if (absent(name)) {
            if (requiredPaths.has(name) || record.optional !== true || !otherPlatform(record)) buildRefusal();
            continue;
        }
        const installed = object(JSON.parse(readBuildBytes(`${name}/package.json`)));
        const expectedName = name.slice(name.lastIndexOf('node_modules/') + 'node_modules/'.length);
        if (installed.name !== expectedName || installed.version !== record.version
            || installed.gypfile !== undefined && typeof installed.gypfile !== 'boolean') buildRefusal();
        const commands = scripts(installed), hooks = INSTALL_HOOKS.filter(hook => Object.hasOwn(commands, hook));
        if (hooks.length && (name !== 'node_modules/esbuild' || hooks.length !== 1
            || hooks[0] !== 'postinstall' || commands.postinstall !== 'node install.js')) buildRefusal();
        if (installed.gypfile !== false && !Object.hasOwn(commands, 'install') && !Object.hasOwn(commands, 'preinstall')
            && !absent(`${name}/binding.gyp`)) {
            readBuildBytes(`${name}/binding.gyp`); buildRefusal();
        }
    }
}

function probeNative(absolute) {
    return new Promise((resolve, reject) => {
        let child, failed = false, settled = false, closed = false, cleanup;
        const output = { stdout: [], stderr: [] }, lengths = { stdout: 0, stderr: 0 };
        const finish = () => {
            if (settled) return;
            settled = true; clearTimeout(deadline); clearTimeout(cleanup);
            if (failed || !closed) { reject(new Error('REHEARSAL_BUILD_INVALID')); return; }
            resolve();
        };
        const fail = () => {
            failed = true;
            if (closed) { finish(); return; }
            if (cleanup) return;
            // Invocation deadline remains 10 seconds. This separate bounded
            // cleanup wait cannot turn timeout/overflow into later success.
            cleanup = setTimeout(finish, 1000);
            try { if (!child || !child.kill('SIGKILL')) finish(); }
            catch { finish(); }
        };
        const deadline = setTimeout(fail, 10000);
        try {
            child = spawn(absolute, ['--version'], { shell: false, windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'] });
            for (const stream of ['stdout', 'stderr']) {
                child[stream].on('data', chunk => {
                    if (settled || failed) return;
                    const bytes = Buffer.from(chunk); lengths[stream] += bytes.length;
                    if (lengths[stream] > 1024 || stream === 'stderr' && bytes.length > 0) { fail(); return; }
                    output[stream].push(bytes);
                });
                child[stream].on('error', fail);
            }
            child.on('error', fail);
            child.on('close', (code, signal) => {
                closed = true;
                if (code !== 0 || signal !== null || child.exitCode !== 0 || child.signalCode !== null
                    || lengths.stderr !== 0 || !/^0\.28\.2\r?\n$/.test(Buffer.concat(output.stdout).toString('utf8'))) failed = true;
                finish();
            });
        } catch { fail(); }
    });
}

export async function assertBuildInstallationCapability() {
    try {
        assertBuildInstallationPolicy();
        assertInstalledSetupDisposition();
        assertBuildToolResolution();
        const { packages, nativeName } = installationPolicy();
        const wrapper = object(JSON.parse(readBuildBytes('node_modules/esbuild/package.json')));
        const typescript = object(JSON.parse(readBuildBytes('node_modules/typescript/package.json')));
        const nativeRecord = packages[`node_modules/${nativeName}`];
        const nativeMetadata = object(JSON.parse(readBuildBytes(`node_modules/${nativeName}/package.json`)));
        const native = `node_modules/${nativeName}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`;
        const pin = NATIVE_DIGESTS[native.slice('node_modules/'.length)];
        if (!pin || otherPlatform(nativeRecord) || otherPlatform(nativeMetadata)
            || buildCanonical(nativeMetadata.os) !== buildCanonical(nativeRecord.os)
            || buildCanonical(nativeMetadata.cpu) !== buildCanonical(nativeRecord.cpu)
            || wrapper.name !== 'esbuild' || wrapper.version !== VERSION
            || buildCanonical(declarations(wrapper, 'optionalDependencies')) !== buildCanonical(packages['node_modules/esbuild'].optionalDependencies)
            || buildCanonical(object(wrapper['esbuild.binaryHashes'])) !== buildCanonical(NATIVE_DIGESTS)
            || typescript.name !== 'typescript' || typescript.version !== packages['node_modules/typescript'].version) buildRefusal();
        const names = ['package.json', 'package-lock.json', 'node_modules/esbuild/lib/main.js',
            'node_modules/typescript/lib/typescript.js', native,
            ...Object.keys(packages).filter(name => name && !absent(name)).map(name => `${name}/package.json`)];
        if (names.length > 512 || new Set(names).size !== names.length) buildRefusal();
        let total = 0;
        const snapshots = names.map(name => {
            const value = readBuildFileSnapshot(name); total += value.bytes.length;
            if (total > 128 * 1024 * 1024) buildRefusal();
            return { name, ...value };
        });
        if (buildDigest(snapshots.find(value => value.name === native).bytes) !== pin) buildRefusal();
        await probeNative(path.join(rehearsalBuildRoot, native));
        for (const before of snapshots) {
            const after = readBuildFileSnapshot(before.name);
            if (!before.bytes.equals(after.bytes) || buildDigest(before.bytes) !== buildDigest(after.bytes)
                || Object.keys(before.identity).some(key => before.identity[key] !== after.identity[key])) buildRefusal();
        }
        assertBuildInstallationPolicy();
        assertInstalledSetupDisposition();
        assertBuildToolResolution();
    } catch { buildRefusal(); }
}

// Import is inert. Both CLI phases own their complete assertions.
if (import.meta.main) {
    try {
        if (!process.argv[1]) buildRefusal();
        const command = path.resolve(process.argv[1]);
        if (pathToFileURL(command).href !== import.meta.url || fs.realpathSync.native(command) !== command) buildRefusal();
        if (process.argv.length !== 3 || !['before', 'after'].includes(process.argv[2])) buildRefusal();
        if (process.argv[2] === 'before') {
            assertBuildInstallationPolicy();
            process.stdout.write('BUILD_INSTALLATION_POLICY_OK\n');
        } else {
            await assertBuildInstallationCapability();
            process.stdout.write('BUILD_INSTALLATION_CAPABILITY_OK\n');
        }
    } catch {
        process.stderr.write('REHEARSAL_BUILD_INVALID\n');
        process.exitCode = 1;
    }
}
