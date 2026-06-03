import esbuild from 'esbuild';
import obfuscator from 'javascript-obfuscator';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const outDir = path.resolve(__dirname, '../dist');
const outFile = path.join(outDir, 'index.js');
const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));

async function build() {
    // Ensure dist directory exists
    if (!existsSync(outDir)) {
        mkdirSync(outDir, { recursive: true });
    }

    console.log('🚀 Step 1: Bundling with esbuild...');
    await esbuild.build({
        entryPoints: ['src/index.ts'],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: outFile,
        target: 'es2022',
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
        target: 'es2022',
        minify: true,
        packages: 'external',
        banner: { js: '#!/usr/bin/env node' },
    });

    writeFileSync(
        path.join(outDir, 'build-info.json'),
        `${JSON.stringify({
            builtAt: new Date().toISOString(),
            version: packageJson.version,
        }, null, 2)}\n`,
        'utf8'
    );

    console.log('✅ Build completed successfully! Output: dist/index.js (MCP server) + dist/cli.js (memory-vault CLI)');
}

build().catch((error) => {
    console.error('❌ Build failed:', error);
    process.exit(1);
});
