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
writeFileSync(path.join(outDir, 'v2-build.json'), '{"schemaVersion":1,"incomplete":true}\n');
const { freshStartBuild } = await import('./fresh-start-build.js');
const { rehearsalManifestPath, rehearsalArtifactPaths, rehearsalRecipePaths, rehearsalBuildRoot,
    readBuildBytes, measureBuildFiles, assertBuildFiles, assertBuildResolutionMetadata, assertBuildToolResolution, cleanBuildHead, assertCommittedBuildFiles,
    buildRuntimeIdentity, buildToolIdentity, privateBuildIdentity, buildCanonical, buildDigest, buildRefusal,
} = await import('./run-v2-shadow-migration-rehearsal.js');
const selectedTools = assertBuildToolResolution();
const { default: esbuild } = await import(selectedTools.esbuild);
const { default: obfuscator } = await import('javascript-obfuscator');
const { default: ts } = await import(selectedTools.typescript);
const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));

function assertClosedSyntax(name, bytes, emitted = false, isolated = false) {
    const source = ts.createSourceFile(name, bytes.toString('utf8'), ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) buildRefusal();
    const nodes = [];
    function collect(node) { nodes.push(node); ts.forEachChild(node, collect); }
    collect(source);
    const permitted = new Set(), loaderNames = new Set();
    // One unchanged production module lazily loads one Node builtin. Prove every
    // binding use, independently again after esbuild renames the emitted bindings.
    if (emitted || name === 'src/orchestrator/storage/schema-fingerprint.ts') {
        const imports = nodes.filter(node => ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'createRequire');
        if (imports.length > (isolated && emitted ? 2 : 1)) buildRefusal();
        for (const specifier of imports) {
            const declaration = specifier.parent.parent.parent;
            if (!ts.isImportDeclaration(declaration) || !ts.isStringLiteral(declaration.moduleSpecifier)
                || declaration.moduleSpecifier.text !== 'node:module' || declaration.importClause.isTypeOnly || specifier.isTypeOnly
                || (!emitted && specifier.name.text !== 'createRequire')) buildRefusal();
            const factory = specifier.name.text;
            permitted.add(specifier.name); if (specifier.propertyName) permitted.add(specifier.propertyName);
            loaderNames.add(factory);
            const factories = nodes.filter(node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === factory);
            if (factories.length !== 1) buildRefusal();
            const call = factories[0], argument = call.arguments[0], binding = call.parent;
            if (call.questionDotToken || call.arguments.length !== 1 || !ts.isPropertyAccessExpression(argument)
                || argument.name.text !== 'url' || !ts.isMetaProperty(argument.expression)
                || argument.expression.keywordToken !== ts.SyntaxKind.ImportKeyword || argument.expression.name.text !== 'meta'
                || !ts.isVariableDeclaration(binding) || binding.initializer !== call || !ts.isIdentifier(binding.name)
                || !ts.isVariableDeclarationList(binding.parent)
                || (!emitted && (!(binding.parent.flags & ts.NodeFlags.Const) || binding.name.text !== 'require'))) buildRefusal();
            permitted.add(call.expression); permitted.add(binding.name); loaderNames.add(binding.name.text);
            const calls = nodes.filter(node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === binding.name.text);
            if (calls.length !== 1 && !(isolated && emitted && factory === '__v2CreateRequire' && calls.length === 0)) buildRefusal();
            for (const builtin of calls) {
                if (builtin.questionDotToken || builtin.arguments.length !== 1 || !ts.isStringLiteral(builtin.arguments[0])
                    || builtin.arguments[0].text !== 'node:sqlite') buildRefusal();
                permitted.add(builtin.expression);
            }
        }
    }
    function visit(node) {
        if (isolated && (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
            && ts.isStringLiteral(node.moduleSpecifier) && /^(node:)?(child_process|worker_threads)$/.test(node.moduleSpecifier.text)) buildRefusal();
        if (isolated && ts.isPropertyAccessExpression(node) && node.name.text === 'getBuiltinModule') buildRefusal();
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            && (emitted || node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]) || !isBuiltin(node.arguments[0].text))) buildRefusal();
        const ordinaryRequireMethod = node.text === 'require' && node.parent && ((ts.isPropertyAccessExpression(node.parent)
            && node.parent.name === node && node.parent.expression.kind === ts.SyntaxKind.ThisKeyword)
            || ((ts.isMethodDeclaration(node.parent) || ts.isMethodSignature(node.parent)) && node.parent.name === node));
        if (ts.isIdentifier(node) && !permitted.has(node)
            && (loaderNames.has(node.text) || (!ordinaryRequireMethod && ['require', 'createRequire', 'eval', 'Function'].includes(node.text)))) buildRefusal();
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
    const freshStart = freshStartBuild(outDir, (name, bytes, emitted) => assertClosedSyntax(name, bytes, emitted, true));

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
    const storeWorkerBuild = await esbuild.build({
        entryPoints: ['src/workers/project-store.worker.ts'],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: path.join(outDir, 'workers', 'project-store.worker.js'),
        target: 'node24.16',
        minify: true,
        ...freshStart.options,
    });
    freshStart.accept(storeWorkerBuild);

    console.log('Bundling prepared-only V2 service and local administration...');
    const v2Build = await esbuild.build({
        entryPoints: ['src/v2.ts'],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: path.join(outDir, 'v2.js'),
        target: 'node24.16',
        minify: true,
        ...freshStart.options,
    });
    freshStart.accept(v2Build);
    const v2AdminBuild = await esbuild.build({
        entryPoints: ['src/v2-admin.ts'],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: path.join(outDir, 'v2-admin.js'),
        target: 'node24.16',
        minify: true,
        ...freshStart.options,
    });
    freshStart.accept(v2AdminBuild);

    console.log('Bundling measured isolated V2 verified-read and cleanup entries...');
    for (const [entry, artifact] of [
        ['src/v2/internal-verified-read.entry.ts', 'internal/v2-internal-verified-read.js'],
        ['src/v2/internal-verified-read-cleanup.entry.ts', 'internal/v2-internal-verified-read-cleanup.js'],
    ]) {
        const result = await esbuild.build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm',
            outfile: path.join(outDir, artifact), target: 'node24.16', minify: true, ...freshStart.options });
        freshStart.accept(result);
    }

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
    assertBuildToolResolution();
    if (initialHead !== null && cleanBuildHead() === initialHead) {
        assertCommittedBuildFiles([...recipes, ...captured.inputs, artifacts[2]]);
        assertBuildFiles(recipes); assertBuildFiles(captured.inputs); assertBuildFiles(artifacts);
        if (cleanBuildHead() !== initialHead || buildCanonical(buildRuntimeIdentity()) !== buildCanonical(runtime)) buildRefusal();
        const body = { schemaVersion: 1, eligible: true, commit: initialHead, runtime, buildTools, recipes, ...captured, artifacts };
        writeFileSync(path.join(rehearsalBuildRoot, rehearsalManifestPath), buildCanonical({ ...body, buildIdentityHash: privateBuildIdentity(body) }) + '\n');
    }

    freshStart.finish();
    console.log('✅ Build completed successfully! Output: V1 server/CLI, V2 foundation server/admin, workers and private rehearsal artifacts.');
}

build().catch((error) => {
    console.error('❌ Build failed:', error);
    process.exit(1);
});
