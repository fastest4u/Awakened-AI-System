import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const worker = fileURLToPath(new URL('../dist/internal/stable-compatibility-directory.worker.js', import.meta.url));
const rehearsal = fileURLToPath(new URL('../dist/internal/v2-shadow-migration-rehearsal.js', import.meta.url));
assert.ok(lstatSync(worker).isFile());
assert.ok(lstatSync(rehearsal).isFile());
const tempBase = realpathSync.native(tmpdir());
const root = realpathSync.native(mkdtempSync(join(tempBase, 'v2-compatibility-built-smoke-')));
const scope = relative(tempBase, root);
assert.ok(scope && !isAbsolute(scope) && scope !== '..' && !scope.startsWith(`..${sep}`));
const isolated = join(root, 'isolated'), protectedRoot = join(root, 'protected');
const identity = path => { const stat = lstatSync(path, { bigint: true }); return { device: String(stat.dev), inode: String(stat.ino), links: String(stat.nlink) }; };
const pin = path => { const { device, inode } = identity(path); return { device, inode }; };
const bytes = Buffer.from('Built-only UTF-8 compatibility ไทย\n');
const contentSha256 = createHash('sha256').update(bytes).digest('hex');
try {
  mkdirSync(isolated); mkdirSync(protectedRoot); writeFileSync(join(protectedRoot, 'sentinel.md'), 'protected');
  const protectedBefore = identity(join(protectedRoot, 'sentinel.md'));
  const request = { schemaVersion: 1, requestId: randomBytes(16).toString('hex'), operation: 'publish', parentPath: isolated,
    parentIdentity: pin(isolated), forbiddenIdentities: [pin(protectedRoot)], basename: 'artifact.md', attemptToken: randomBytes(16).toString('hex'),
    byteLength: bytes.length, contentSha256, bytesBase64: bytes.toString('base64') };
  const call = body => {
    const result = spawnSync(process.execPath, [worker, '--stable-compatibility-worker'], { cwd: isolated, windowsHide: true,
      input: JSON.stringify(body), encoding: 'utf8', timeout: 10000, maxBuffer: 16384, stdio: ['pipe', 'pipe', 'pipe'] });
    assert.equal(result.error, undefined); assert.equal(result.stderr, '');
    return { status: result.status, response: JSON.parse(result.stdout) };
  };
  const published = call(request); assert.equal(published.status, 0); assert.equal(published.response.state, 'published');
  assert.equal(published.response.requestId, request.requestId); assert.deepEqual(readFileSync(join(isolated, 'artifact.md')), bytes);
  const installed = identity(join(isolated, 'artifact.md'));
  const verified = call({ ...request, requestId: randomBytes(16).toString('hex'), operation: 'verify', bytesBase64: null });
  assert.equal(verified.status, 0); assert.equal(verified.response.state, 'verified');
  const replay = call({ ...request, requestId: randomBytes(16).toString('hex') });
  assert.equal(replay.status, 0); assert.equal(replay.response.state, 'verified');
  assert.deepEqual(identity(join(isolated, 'artifact.md')), installed);
  const malformed = call({ ...request, unexpected: 'must reject' });
  assert.equal(malformed.status, 1); assert.equal(malformed.response.code, 'COMPATIBILITY_INTEGRITY_FAILURE');
  assert.deepEqual(readdirSync(protectedRoot), ['sentinel.md']);
  assert.deepEqual(identity(join(protectedRoot, 'sentinel.md')), protectedBefore);
  assert.equal(readFileSync(join(protectedRoot, 'sentinel.md'), 'utf8'), 'protected');
  console.log('PASS built compatibility worker: exact publication, durable verified no-op, malformed rejection, protected identity/links/bytes unchanged');
  const preflight = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    const entry = await import(${JSON.stringify(pathToFileURL(rehearsal).href)});
    for (const input of [undefined, null, {}]) {
      await assert.rejects(entry.preflightV2ShadowMigrationRehearsal(input, { driver: { open() { throw new Error('unexpected open'); } } }),
        { code: 'MIGRATION_SOURCE_INVALID' });
    }
  `], { cwd: isolated, windowsHide: true, encoding: 'utf8', timeout: 10000, maxBuffer: 16384 });
  assert.equal(preflight.status, 0, preflight.stderr); assert.equal(preflight.stderr, ''); assert.equal(preflight.stdout, '');
  assert.deepEqual(readdirSync(isolated), ['artifact.md']);
  assert.deepEqual(identity(join(isolated, 'artifact.md')), installed);
  assert.deepEqual(readFileSync(join(isolated, 'artifact.md')), bytes);
  assert.deepEqual(readdirSync(protectedRoot), ['sentinel.md']);
  assert.deepEqual(identity(join(protectedRoot, 'sentinel.md')), protectedBefore);
  console.log('PASS built rehearsal preflight: inert import and missing/invalid configuration refusal without selected-root mutation');
} finally { rmSync(root, { recursive: true, force: true }); }
