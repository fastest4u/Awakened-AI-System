import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isBuiltin } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const outDir = path.resolve(__dirname, '../dist');
const outFile = path.join(outDir, 'index.js');
// Only builtins execute before invalidation, including when a dependency/command cannot load.
mkdirSync(path.join(outDir, 'internal'), { recursive: true });
writeFileSync(path.join(outDir, 'internal', 'v2-shadow-migration-build.json'), '{"eligible":false,"schemaVersion":1}\n');
const { default: esbuild } = await import('esbuild');
const { default: obfuscator } = await import('javascript-obfuscator');
const { default: ts } = await import('typescript');
const { rehearsalManifestPath, rehearsalArtifactPaths, rehearsalRecipePaths, rehearsalBuildRoot,
    readBuildBytes, measureBuildFiles, assertBuildFiles, assertBuildResolutionMetadata, cleanBuildHead, assertCommittedBuildFiles,
    buildRuntimeIdentity, buildToolIdentity, privateBuildIdentity, buildCanonical, buildDigest, buildRefusal,
} = await import('./run-v2-shadow-migration-rehearsal.js');
const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));

function assertClosedSyntax(name, bytes, emitted = false) {
    const source = ts.createSourceFile(name, bytes.toString('utf8'), ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) buildRefusal();
    function visit(node) {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            && (emitted || node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]) || !isBuiltin(node.arguments[0].text))) buildRefusal();
        const ordinaryRequireMethod = node.text === 'require' && node.parent && ((ts.isPropertyAccessExpression(node.parent)
            && node.parent.name === node && node.parent.expression.kind === ts.SyntaxKind.ThisKeyword)
            || ((ts.isMethodDeclaration(node.parent) || ts.isMethodSignature(node.parent)) && node.parent.name === node));
        if (ts.isIdentifier(node) && !ordinaryRequireMethod && ['require', 'createRequire', 'eval', 'Function'].includes(node.text)) buildRefusal();
        if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
            && ['require', 'createRequire', 'eval', 'Function'].includes(node.argumentExpression.text)) buildRefusal();
        if (emitted && (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
            && (!ts.isStringLiteral(node.moduleSpecifier) || !isBuiltin(node.moduleSpecifier.text))) buildRefusal();
        ts.forEachChild(node, visit);
    }
    visit(source);
}

function measuredPrivateBuild() {
    const captures = new Map(), emitted = new Map(); let total = 0;
    const runtimeImports = new Set();
    const plugin = { name: 'private-measured-inputs', setup(build) {
        build.onLoad({ filter: /.*/, namespace: 'file' }, args => {
            const name = path.relative(rehearsalBuildRoot, args.path).split(path.sep).join('/');
            if (!/^(src\/[a-zA-Z0-9_./-]+\.ts|node_modules\/zod\/[a-zA-Z0-9_./-]+\.js)$/.test(name)) buildRefusal();
            assertBuildResolutionMetadata([name]);
            const bytes = readBuildBytes(name); total += bytes.length;
            if (captures.size >= 512 || total > 64 * 1024 * 1024) buildRefusal();
            assertClosedSyntax(name, bytes);
            const entry = { path: name, bytes: bytes.length, sha256: buildDigest(bytes) };
            if (captures.has(name) && buildCanonical(captures.get(name)) !== buildCanonical(entry)) buildRefusal();
            captures.set(name, entry);
            // These exact bytes, not a subsequent pathname read, are handed to esbuild.
            return { contents: bytes, loader: name.endsWith('.ts') ? 'ts' : 'js', resolveDir: path.dirname(args.path) };
        });
    } };
    function accept(result) {
        if (result.warnings.length) buildRefusal();
        for (const [name, input] of Object.entries(result.metafile.inputs)) {
            if (captures.get(name)?.bytes !== input.bytes) buildRefusal();
        }
        for (const output of Object.values(result.metafile.outputs)) for (const item of output.imports) {
            if (!item.external || item.kind !== 'import-statement' || !isBuiltin(item.path)) buildRefusal();
            runtimeImports.add(item.path);
        }
        if (result.outputFiles.length !== 1) buildRefusal();
        for (const file of result.outputFiles) {
            const name = path.relative(rehearsalBuildRoot, file.path).split(path.sep).join('/');
            if (!rehearsalArtifactPaths.slice(0, 2).includes(name) || emitted.has(name) || file.contents.length > 32 * 1024 * 1024) buildRefusal();
            assertClosedSyntax(name, Buffer.from(file.contents), true);
            emitted.set(name, { path: name, bytes: file.contents.length, sha256: buildDigest(file.contents) });
            writeFileSync(file.path, file.contents);
        }
    }
    return { plugin, accept, assertArtifacts(entries) {
        if (emitted.size !== 2 || entries.filter(entry => emitted.has(entry.path)).some(entry => buildCanonical(entry) !== buildCanonical(emitted.get(entry.path)))) buildRefusal();
    }, finish(results) {
        const actual = new Set(results.flatMap(result => Object.keys(result.metafile.inputs)));
        if (actual.size !== captures.size || [...captures.keys()].some(name => !actual.has(name))) buildRefusal();
        const inputs = [...captures.values()].sort((a, b) => a.path < b.path ? -1 : 1);
        assertBuildFiles(inputs);
        assertBuildResolutionMetadata(inputs.map(entry => entry.path));
        assertBuildFiles([...emitted.values()].sort((a, b) => a.path < b.path ? -1 : 1));
        return { inputs, runtimeImports: [...runtimeImports].sort() };
    } };
}

async function build() {
    // Ensure dist directory exists
    if (!existsSync(outDir)) {
        mkdirSync(outDir, { recursive: true });
    }

    if (process.cwd() !== rehearsalBuildRoot || process.env.ESBUILD_BINARY_PATH) buildRefusal();
    const initialHead = cleanBuildHead(), recipes = measureBuildFiles(rehearsalRecipePaths);
    const commandBefore = measureBuildFiles(['scripts/run-v2-shadow-migration-rehearsal.js']);
    const runtime = buildRuntimeIdentity(), buildTools = buildToolIdentity();
    if (buildTools.esbuildVersion !== esbuild.version || buildTools.typescriptVersion !== ts.version) buildRefusal();
    const config = JSON.parse(readBuildBytes('tsconfig.json'));
    if (config.extends) buildRefusal();
    const measured = measuredPrivateBuild();

    console.log('🚀 Step 1: Bundling with esbuild...');
    await esbuild.build({
        entryPoints: ['src/index.ts'],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: outFile,
        target: 'node24.16',
        minify: true, // Minify the bundle first
        packages: 'external', // Do not bundle node_modules
    });

    console.log('🛡️ Step 2: Obfuscating code...');
    const code = readFileSync(outFile, 'utf8');

    // Medium obfuscation settings for a balance between security and performance
    const obfuscationResult = obfuscator.obfuscate(code, {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.5,
        deadCodeInjection: false,
        debugProtection: false,
        disableConsoleOutput: false,
        identifierNamesGenerator: 'hexadecimal',
        log: false,
        numbersToExpressions: true,
        renameGlobals: false,
        selfDefending: false,
        simplify: true,
        splitStrings: true,
        splitStringsChunkLength: 10,
        stringArray: true,
        stringArrayCallsTransform: true,
        stringArrayCallsTransformThreshold: 0.5,
        stringArrayEncoding: ['base64'],
        stringArrayIndexShift: true,
        stringArrayRotate: true,
        stringArrayShuffle: true,
        stringArrayWrappersCount: 1,
        stringArrayWrappersChainedCalls: true,
        stringArrayWrappersParametersMaxCount: 2,
        stringArrayWrappersType: 'variable',
        stringArrayThreshold: 0.75,
        unicodeEscapeSequence: false,
        target: 'node'
    });

    writeFileSync(outFile, obfuscationResult.getObfuscatedCode(), 'utf8');

    console.log('🧰 Step 3: Bundling CLI (dist/cli.js)...');
    await esbuild.build({
        entryPoints: ['src/cli.ts'],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: path.join(outDir, 'cli.js'),
        target: 'node24.16',
        minify: true,
        packages: 'external',
        banner: { js: '#!/usr/bin/env node' },
    });

    console.log('🧵 Step 4: Bundling project-store worker (dist/workers/project-store.worker.js)...');
    await esbuild.build({
        entryPoints: ['src/workers/project-store.worker.ts'],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: path.join(outDir, 'workers', 'project-store.worker.js'),
        target: 'node24.16',
        minify: true,
        packages: 'external',
    });

    console.log('🧵 Step 5: Bundling upgrade phase worker (dist/workers/project-store-upgrade-phase.worker.js)...');
    await esbuild.build({
        entryPoints: ['src/workers/project-store-upgrade-phase.worker.ts'],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: path.join(outDir, 'workers', 'project-store-upgrade-phase.worker.js'),
        target: 'node24.16',
        minify: true,
        packages: 'external',
    });

    console.log('🧵 Bundling isolated compatibility worker (dist/internal/stable-compatibility-directory.worker.js)...');
    const compatibilityBuild = await esbuild.build({
        entryPoints: ['src/orchestrator/materialization/stable-compatibility-directory.worker.ts'],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: path.join(outDir, 'internal', 'stable-compatibility-directory.worker.js'),
        target: 'node24.16',
        minify: true,
        packages: 'external',
        metafile: true,
        write: false,
        plugins: [measured.plugin],
        tsconfig: path.join(rehearsalBuildRoot, 'tsconfig.json'),
    });
    measured.accept(compatibilityBuild);

    // Unlike public entries, embed the existing zod dependency in this private bundle.
    console.log('Bundling private V2 rehearsal preflight...');
    const rehearsalBuild = await esbuild.build({
        entryPoints: ['src/orchestrator/migration/v2-shadow-migration-rehearsal.ts'],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: path.join(outDir, 'internal', 'v2-shadow-migration-rehearsal.js'),
        target: 'node24.16',
        minify: true,
        metafile: true,
        write: false,
        plugins: [measured.plugin],
        tsconfig: path.join(rehearsalBuildRoot, 'tsconfig.json'),
    });
    measured.accept(rehearsalBuild);

    writeFileSync(
        path.join(outDir, 'build-info.json'),
        `${JSON.stringify({
            builtAt: new Date().toISOString(),
            version: packageJson.version,
        }, null, 2)}\n`,
        'utf8'
    );

    const captured = measured.finish([compatibilityBuild, rehearsalBuild]);
    assertBuildFiles(recipes); assertBuildFiles(commandBefore);
    const artifacts = measureBuildFiles(rehearsalArtifactPaths);
    measured.assertArtifacts(artifacts);
    if (initialHead !== null && cleanBuildHead() === initialHead) {
        assertCommittedBuildFiles([...recipes, ...captured.inputs, artifacts[2]]);
        assertBuildFiles(recipes); assertBuildFiles(captured.inputs); assertBuildFiles(artifacts);
        if (cleanBuildHead() !== initialHead || buildCanonical(buildRuntimeIdentity()) !== buildCanonical(runtime)) buildRefusal();
        const body = { schemaVersion: 1, eligible: true, commit: initialHead, runtime, buildTools, recipes, ...captured, artifacts };
        writeFileSync(path.join(rehearsalBuildRoot, rehearsalManifestPath), buildCanonical({ ...body, buildIdentityHash: privateBuildIdentity(body) }) + '\n');
    }

    console.log('✅ Build completed successfully! Output: dist/index.js (MCP server) + dist/cli.js (memory-vault CLI) + dist/workers/project-store.worker.js + dist/workers/project-store-upgrade-phase.worker.js');
}

build().catch((error) => {
    console.error('❌ Build failed:', error);
    process.exit(1);
});
