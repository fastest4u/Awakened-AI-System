import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    return JSON.stringify(value);
}

/** Independent F1 deployment integrity; this is not signed production evidence. */
export function freshStartBuild(outDir) {
    const deploymentId = randomUUID();
    const artifacts = new Map();
    const names = ['v2.js', 'v2-admin.js', 'workers/project-store.worker.js'];
    return {
        options: {
            define: { __V2_DEPLOYMENT_ID__: JSON.stringify(deploymentId) },
            metafile: true,
            write: false,
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
            artifacts.set(name, { path: name, bytes: file.contents.length, sha256: digest(file.contents) });
            mkdirSync(path.dirname(file.path), { recursive: true });
            writeFileSync(file.path, file.contents);
        },
        finish() {
            if (artifacts.size !== names.length) throw new Error('FRESH_START_BUILD_MISMATCH');
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
