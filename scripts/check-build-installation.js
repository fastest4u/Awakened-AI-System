import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rehearsalBuildRoot, readBuildBytes, buildCanonical, buildRefusal } from './run-v2-shadow-migration-rehearsal.js';

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

// Import is inert. Task 2 adds the after-phase capability check; no partial success.
if (import.meta.main) {
    try {
        if (!process.argv[1]) buildRefusal();
        const command = path.resolve(process.argv[1]);
        if (pathToFileURL(command).href !== import.meta.url || fs.realpathSync.native(command) !== command) buildRefusal();
        if (process.argv.length !== 3 || !['before', 'after'].includes(process.argv[2])) buildRefusal();
        if (process.argv[2] !== 'before') buildRefusal();
        assertBuildInstallationPolicy();
        process.stdout.write('BUILD_INSTALLATION_POLICY_OK\n');
    } catch {
        process.stderr.write('REHEARSAL_BUILD_INVALID\n');
        process.exitCode = 1;
    }
}
