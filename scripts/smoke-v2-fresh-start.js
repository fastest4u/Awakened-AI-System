import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const deployment = fileURLToPath(new URL('../dist/', import.meta.url));
const temp = realpathSync.native(tmpdir());
const root = realpathSync.native(mkdtempSync(join(temp, 'fresh-start-built-smoke-')));
const scope = relative(temp, root);
assert.ok(scope && !isAbsolute(scope) && scope !== '..' && !scope.startsWith(`..${sep}`));
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const secret = 'SMOKE-CREDENTIAL-MUST-NOT-LEAK';
const archive = join(root, 'archive'), vault = join(root, 'memory-v2'), releaseId = randomUUID();
let child;
let childClosed = true;
try {
  for (const path of ['v2.js', 'v2-admin.js', 'workers/project-store.worker.js']) assert.ok(lstatSync(join(deployment, path)).isFile());
  const build = JSON.parse(readFileSync(join(deployment, 'v2-build.json'), 'utf8'));
  mkdirSync(archive); writeFileSync(join(archive, 'sentinel.txt'), secret);
  const sentinel = lstatSync(join(archive, 'sentinel.txt'), { bigint: true });
  const accessLog = join(root, 'archive-access.log'), monitor = join(root, 'monitor.cjs');
  // Observe actual compiled filesystem calls, permitting only path metadata.
  writeFileSync(monitor, `const fs=require('node:fs'),p=require('node:path'),u=require('node:url');
const archive=${JSON.stringify(archive.toLowerCase())},log=${JSON.stringify(accessLog)},append=fs.appendFileSync.bind(fs);
function check(x){if(x instanceof URL)x=u.fileURLToPath(x);if(typeof x!=='string'&&!Buffer.isBuffer(x))return;
const v=p.resolve(String(x)).toLowerCase();if(v===archive||v.startsWith(archive+p.sep)){append(log,'access\\n');throw Error('ARCHIVE_ACCESS_DENIED');}}
for(const n of ['readFileSync','readFile','readdirSync','readdir','opendirSync','opendir','openSync','open','createReadStream','writeFileSync','writeFile','appendFileSync','appendFile','createWriteStream']){const original=fs[n];fs[n]=function(x,...a){check(x);return original.call(this,x,...a)}}
for(const n of ['readFile','readdir','opendir','open','writeFile','appendFile']){const original=fs.promises[n];fs.promises[n]=function(x,...a){check(x);return original.call(this,x,...a)}}
require('node:module').syncBuiltinESMExports();`);
  const env = { ...process.env, MEMORY_PROJECT_ROOT: root, MEMORY_V2_VAULT_PATH: vault,
    MEMORY_V1_ARCHIVE_PATH: archive, MEMORY_V2_RELEASE_ID: releaseId, MEMORY_V2_ACTIVE: 'true', MEMORY_V2_PRODUCTION_READY: 'true' };
  const manifest = join(root, 'release.json');
  writeFileSync(manifest, JSON.stringify({ initializationId: randomUUID(), release: {
    profileVersion: 1, releaseId, buildIdentityHash: build.buildIdentityHash,
    // Independently checked schema-8 golden; changed schema must update the
    // reviewed release contract, not silently bless the runtime's own answer.
    schemaIdentityHash: '2dd25f0de16cdd89a1022b83fcaa35cf21c59374c132b2a2094db96adf4856a2',
    configurationHash: hash({ projectRoot: root, v2VaultRoot: vault, v1ArchiveRoot: archive, releaseId }),
    capabilityManifestHash: hash({ profile: 'fresh-start', version: 1, tools: ['memory_v2Status'], content: 'unavailable' }),
    recoveryPolicyHash: hash({ profile: 'fresh-start', version: 1, productionReady: false, promotion: 'closed' }),
    evidenceDigest: hash({ purpose: 'isolated-compiled-foundation-smoke' }), createdAt: new Date().toISOString(),
  } }));
  const admin = command => {
    const result = spawnSync(process.execPath, ['--require', monitor, join(deployment, 'v2-admin.js'), command,
      '--project-root', root, '--v2-vault-root', vault, '--v1-archive-root', archive, '--release-manifest', manifest],
    { cwd: root, env, encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 65536 });
    assert.equal(result.error, undefined); assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
    return result;
  };
  const prepared = admin('initialize-fresh'); assert.equal(prepared.status, 0, prepared.stderr);
  const status = JSON.parse(prepared.stdout);
  assert.equal(status.mode, 'prepared'); assert.equal(status.generation, '0'); assert.equal(status.schemaVersion, 8);
  assert.equal(status.productionReady, false); assert.equal(status.buildIdentityHash, build.buildIdentityHash);
  assert.equal(status.releaseId, releaseId);
  assert.deepEqual(Object.keys(status).sort(), ['profile', 'profileVersion', 'projectId', 'vaultId', 'storeId', 'releaseId',
    'mode', 'generation', 'schemaVersion', 'schemaIdentityHash', 'buildIdentityHash', 'productionReady'].sort());
  for (const command of ['resume-initialization', 'status']) {
    const result = admin(command); assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), status);
  }
  const activate = admin('activate'); assert.equal(activate.status, 1); assert.match(activate.stderr, /FRESH_START_RELEASE_NOT_READY/);
  child = spawn(process.execPath, ['--require', monitor, join(deployment, 'v2.js')], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  childClosed = false;
  let stdout = '', stderr = '', buffer = '', id = 0;
  const replies = new Map();
  const closed = new Promise(resolve => child.once('close', code => { childClosed = true; resolve(code); }));
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => {
    stdout += data; buffer += data;
    for (;;) {
      const end = buffer.indexOf('\n'); if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const reply = JSON.parse(line); replies.get(reply.id)?.resolve(reply); }
      catch { for (const waiter of replies.values()) waiter.reject(new Error('SMOKE_PROTOCOL_INVALID')); }
    }
  });
  child.on('error', error => { for (const waiter of replies.values()) waiter.reject(error); });
  child.on('exit', () => { for (const waiter of replies.values()) waiter.reject(new Error('SMOKE_CHILD_EXITED')); });
  async function call(method, params) {
    const requestId = ++id; let timer;
    try { return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('SMOKE_DEADLINE')), 15000);
      replies.set(requestId, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    }); } finally { clearTimeout(timer); replies.delete(requestId); }
  }
  await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'built-smoke', version: '1' } });
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  assert.deepEqual((await call('tools/list', {})).result.tools.map(tool => tool.name), ['memory_v2Status']);
  assert.deepEqual(JSON.parse((await call('tools/call', { name: 'memory_v2Status', arguments: {} })).result.content[0].text), status);
  for (const name of ['memory_search', 'memory_writeInsight', 'memory_appendEvent', 'memory_migrationRun', 'memory_v2Activate']) {
    const result = await call('tools/call', { name, arguments: { credential: secret, productionReady: true } });
    assert.equal(result.error.data.code, 'FRESH_START_RELEASE_NOT_READY');
  }
  assert.equal((await call('tools/call', { name: 'memory_v2Status', arguments: { secret } })).error.data.code, 'FRESH_START_INPUT_INVALID');
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { assert.equal(await closed, 0); } finally { clearTimeout(timer); }
  assert.ok(!stdout.includes(root) && !stdout.includes(secret) && !stderr.includes(secret));
  assert.ok(stdout.trim().split('\n').every(line => JSON.parse(line).jsonrpc === '2.0'));
  assert.equal(existsSync(accessLog), false);
  const after = lstatSync(join(archive, 'sentinel.txt'), { bigint: true });
  assert.equal(after.ino, sentinel.ino); assert.equal(after.dev, sentinel.dev); assert.equal(after.nlink, sentinel.nlink);
  assert.equal(readFileSync(join(archive, 'sentinel.txt'), 'utf8'), secret);
  console.log('PASS built fresh-start: prepared identity, restart, redaction, content denial and archive isolation');
} finally {
  if (child && !childClosed) {
    child.kill('SIGKILL');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SMOKE_CLEANUP_UNCONFIRMED')), 5000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }
  rmSync(root, { recursive: true, force: true });
}
