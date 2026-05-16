import esbuild from 'esbuild';
import obfuscator from 'javascript-obfuscator';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const outDir = path.resolve(__dirname, '../dist');
const outFile = path.join(outDir, 'index.js');

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
    
    console.log('✅ Build and obfuscation completed successfully! Output saved to: dist/index.js');
}

build().catch((error) => {
    console.error('❌ Build failed:', error);
    process.exit(1);
});
