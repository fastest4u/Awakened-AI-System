import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { ProjectStoreExecutor, type WorkerLike, type ExecutorScheduler } from "../src/orchestrator/runtime/project-store-executor.js";
import { encodeWorkerBindingAssertion, type WorkerRequest } from "../src/orchestrator/runtime/worker-protocol.js";
import { createGovernedNoteRunV1, type GovernedNoteOwnerConstructionV1, type GovernedNoteOwnerPortV1, type GovernedNoteRunOptionsV1 } from "../src/orchestrator/governed-notes/run.js";
import { allocateFreshGovernedNoteFixtureV1 as allocate } from "../src/orchestrator/governed-notes/fixture-allocation.js";
import type { GovernedNoteCloseObservationV1, GovernedNoteRecoveryResultV1, PreparedGovernedNoteCreateV1, PreparedGovernedNoteRecoveryV1, TrustedGovernedNoteTimingV1 } from "../src/orchestrator/governed-notes/contracts.js";
import { GovernedNoteError } from "../src/orchestrator/governed-notes/errors.js";
import { FreshStartInitializer } from "../src/orchestrator/fresh-start/fresh-start-initializer.js";
import { ProjectBindingService } from "../src/orchestrator/identity/project-binding.service.js";
import { WorkerProjectStoreIdentityProbe } from "../src/orchestrator/runtime/project-store-identity-probe.js";
import { freshRelease } from "./support/fresh-start-fixture.js";
import { expectedSchemaFingerprint } from "../src/orchestrator/storage/schema-fingerprint.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import type { FreshStartGenesis } from "../src/orchestrator/fresh-start/contracts.js";
import { governedIdentityWorkerUrl } from "./support/governed-note-fixture.js";
import { fileURLToPath } from "node:url";

const timing: TrustedGovernedNoteTimingV1 = {requestTimeoutMs: 15000, closeTimeoutMs: 5000, recoveryProofLifetimeMs: 60000, maxPending: 128, executorLeaseMs: 15000, heartbeatIntervalMs: 5000, appendRetryDeadlineMs: 15000, sqliteBusyTimeoutMs: 5000};
const session = "11111111-1111-1111-8111-111111111111";
function deferred<T>() { let resolve!: (v:T) => void, reject!: (e:unknown) => void; const promise = new Promise<T>((r,j) => {resolve=r;reject=j;}); return {promise,resolve,reject}; }
function safe(code: string, details: object = {}) { return (e: unknown) => { assert.ok(e instanceof Error && "code" in e && "details" in e); assert.equal(e.message,code); assert.equal(e.code,code); assert.deepEqual(e.details,details); return true; }; }
function prepared(): PreparedGovernedNoteCreateV1 { return {command:{version:1,operation:"create-governed-note",commandId:randomUUID(),idempotencyKey:randomUUID(),recordKind:"insight",summary:"Owned controller test",confidence:"high",provenance:[{kind:"source-event",identity:randomUUID()}]},authorization:{kind:"protected",authoritySessionId:session as never,targetSessionId:session as never,proof:{proofVersion:1,target:"semantic-command",proofNonce:randomUUID(),proofFingerprint:"a".repeat(64)},approval:null,childBindingGrant:null}}; }
function ids(p: PreparedGovernedNoteCreateV1) { return {commandId:p.command.commandId,idempotencyKey:p.command.idempotencyKey}; }
function recovery(p: PreparedGovernedNoteCreateV1): PreparedGovernedNoteRecoveryV1 { return {request:{version:1,operation:"recover-governed-note-result",operationId:randomUUID(),requestId:randomUUID(),...ids(p),expiresAt:"2026-10-09T00:01:00.000Z"},authorization:{kind:"bounded-operation",authoritySessionId:session as never,targetSessionId:session as never,proof:{proofVersion:1,target:"bounded-operation",proofNonce:randomUUID(),proofFingerprint:"a".repeat(64)},audience:{presentingActorRole:"primary",presentingClientInstanceId:"test",targetActorRole:"primary",targetClientInstanceId:"test"}}}; }
function absent(p: PreparedGovernedNoteRecoveryV1): GovernedNoteRecoveryResultV1 { return {resultVersion:1,operation:"recover-governed-note-result",outcome:"not-found",commandId:p.request.commandId,idempotencyKey:p.request.idempotencyKey}; }
type CreateResult = Awaited<ReturnType<GovernedNoteOwnerPortV1["createGovernedNote"]>>;
function receipt(c: GovernedNoteOwnerConstructionV1, p: PreparedGovernedNoteCreateV1): CreateResult { const eventIds = [randomUUID(),randomUUID()]; return {deduplicated:false,firstGlobalPosition:1n,lastGlobalPosition:2n,finalStreamVersion:2n,eventIds,responseHash:"b".repeat(64),response:{resultVersion:1,operation:"create-governed-note",...ids(p),recordId:randomUUID(),recordKind:p.command.recordKind,status:"candidate",verificationStatus:"unverified",scope:{projectId:c.context.binding.projectId,vaultId:c.context.binding.vaultId,storeId:c.context.binding.storeId,workspaceId:c.context.binding.workspaceId,branchScopeId:null,branchRef:null,sessionId:session as never},sourceEventIds:eventIds as [string,string],terminalPosition:"2"}}; }
class Owner implements GovernedNoteOwnerPortV1 {
  healthy: unknown = true; creates=0; recovers=0; closes=0; opens=0;
  openAction=async () => {}; createAction: (p:PreparedGovernedNoteCreateV1)=>Promise<CreateResult>;
  recoverAction=async (p:PreparedGovernedNoteRecoveryV1):Promise<GovernedNoteRecoveryResultV1> => absent(p);
  closeAction=async ():Promise<GovernedNoteCloseObservationV1> => ({disposition:"graceful-confirmed",ownerId:this.ownerId});
  readonly ownerId=randomUUID();
  constructor(readonly construction: GovernedNoteOwnerConstructionV1) { this.createAction=async p=>receipt(construction,p); }
  canReuse() { if (this.healthy instanceof Error) throw this.healthy; return this.healthy as boolean; }
  async open() {this.opens++;await this.openAction();}
  async createGovernedNote(p:PreparedGovernedNoteCreateV1) {this.creates++;return this.createAction(p);}
  async recoverGovernedNoteResult(p:PreparedGovernedNoteRecoveryV1) {this.recovers++;return this.recoverAction(p);}
  async closeForGovernedNoteController() {this.closes++;this.healthy=false;return this.closeAction();}
}
// Real initializer, real descriptors/routes and closed worker probes. Fake owners
// test controller custody only; prepared proof-shaped values confer no authority.
function harness(change: Partial<GovernedNoteRunOptionsV1> = {}) {
  const parentDirectory=realpathSync.native(mkdtempSync(join(tmpdir(),"g09-owned-")));
  const owners:Owner[]=[]; let initialized=0; let directory="";let genesis:FreshStartGenesis|undefined;
  const options:GovernedNoteRunOptionsV1={timing,freshInitializer:{async initialize({freshDirectory}) {
    initialized++;directory=freshDirectory;
    const v2VaultRoot=join(freshDirectory,"vault"),v1ArchiveRoot=join(freshDirectory,"archive");mkdirSync(v2VaultRoot);mkdirSync(v1ArchiveRoot);
    const {projectId:_p,vaultId:_v,storeId:_s,...release}=freshRelease({schemaIdentityHash:expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS)});
    genesis=await new FreshStartInitializer({inspectBuild:()=>release.buildIdentityHash,actorFingerprint:"c".repeat(64)}).initializeFresh({projectRoot:freshDirectory,v2VaultRoot,v1ArchiveRoot,initializationId:randomUUID(),release});
    const workerUrl=governedIdentityWorkerUrl();
    assert.equal(fileURLToPath(workerUrl),join(process.cwd(),"dist/workers/project-store.worker.js"));
    const service=new ProjectBindingService({identityProbe:new WorkerProjectStoreIdentityProbe({workerUrl,requestTimeoutMs:5000})});
    const binding=await service.establish({source:"explicit-cli",projectRoot:freshDirectory,vaultRoot:v2VaultRoot,clientNamespace:"g09",clientInstanceId:"test",actorRole:"primary",generation:1});
    assert.equal(binding.ok,true);if(!binding.ok) throw new Error("binding setup refused");
    const context=await service.revalidate(binding.binding);
    return {context,freshStartContext:{identity:{projectId:genesis.projectId,vaultId:genesis.vaultId,storeId:genesis.storeId},releaseId:genesis.releaseId,measuredBuildHash:release.buildIdentityHash,generation:0n}};
  }},ownerFactory:c=>{const o=new Owner(c);owners.push(o);return o;},...change};
  const run=createGovernedNoteRunV1(options);
  return {run,options,owners,parentDirectory,get initialized(){return initialized;},get directory(){return directory;},get genesis(){assert.ok(genesis);return genesis;},async open(){const fixture=await allocate(run,{parentDirectory});const permit=await run.open(fixture);return {fixture,permit,owner:owners.at(-1)!};}};
}

test("governed identity worker selection refuses missing or mismatched current artifacts",t=>{
  const original=join(process.cwd(),"dist"),retainedInputs:string[]=[];
  for(const fault of ["missing-manifest","malformed-manifest","manifest-identity","runtime","missing-worker","worker-bytes","worker-hardlink","workers-junction"]){
    const root=realpathSync.native(mkdtempSync(join(tmpdir(),"governed-identity-input-"))),owned=join(root,"dist");retainedInputs.push(root);cpSync(original,owned,{recursive:true});
    const manifest=join(owned,"v2-build.json"),worker=join(owned,"workers/project-store.worker.js");
    if(fault==="missing-manifest")renameSync(manifest,join(root,"retained-manifest"));
    if(fault==="malformed-manifest")writeFileSync(manifest,"{");
    if(fault==="manifest-identity"||fault==="runtime"){const value=JSON.parse(readFileSync(manifest,"utf8"));if(fault==="manifest-identity")value.buildIdentityHash="0".repeat(64);else {value.runtime.nodeVersion="0.0.0";const {buildIdentityHash:_old,...body}=value;value.buildIdentityHash=createHash("sha256").update(JSON.stringify(body)).digest("hex");}writeFileSync(manifest,JSON.stringify(value));}
    if(fault==="missing-worker")renameSync(worker,join(root,"retained-worker"));
    if(fault==="worker-bytes")writeFileSync(worker,"export {};\n");
    if(fault==="worker-hardlink"){const retained=join(root,"retained-worker");renameSync(worker,retained);linkSync(retained,worker);}
    if(fault==="workers-junction"){const retained=join(root,"retained-workers");renameSync(join(owned,"workers"),retained);symlinkSync(retained,join(owned,"workers"),"junction");}
    assert.throws(()=>governedIdentityWorkerUrl(owned),{message:"GOVERNED_IDENTITY_WORKER_UNAVAILABLE"},fault);
  }
  // Success cannot cache approval: a later replacement in the same owned copy is refused.
  const owned=join(realpathSync.native(mkdtempSync(join(tmpdir(),"governed-identity-live-"))),"dist");cpSync(original,owned,{recursive:true});
  assert.equal(fileURLToPath(governedIdentityWorkerUrl(owned)),join(owned,"workers/project-store.worker.js"));
  writeFileSync(join(owned,"workers/project-store.worker.js"),"export {};\n");
  assert.throws(()=>governedIdentityWorkerUrl(owned),{message:"GOVERNED_IDENTITY_WORKER_UNAVAILABLE"});
  retainedInputs.push(owned);t.diagnostic(JSON.stringify({retainedInputs}));
});

test("mandatory timing rejects before allocation or owner side effects",()=>{
  for(const bad of [0,2147483648,NaN,1.5,undefined]) assert.throws(()=>harness({timing:{...timing,requestTimeoutMs:bad,appendRetryDeadlineMs:bad} as never}),safe("GOVERNED_NOTE_CONFIG_INVALID"));
  for(const patch of [{closeTimeoutMs:0},{recoveryProofLifetimeMs:120001},{maxPending:129},{appendRetryDeadlineMs:1}]) assert.throws(()=>harness({timing:{...timing,...patch} as never}),safe("GOVERNED_NOTE_CONFIG_INVALID"));
});
test("fresh allocation is opaque, contained, and cannot attach a prior directory",{timeout:20000},async()=>{
  const h=harness(),{fixture,permit,owner}=await h.open();assert.deepEqual(Object.keys(fixture),[]);assert.deepEqual(Object.keys(permit),[]);
  assert.equal(h.initialized,1);assert.match(h.directory.slice(h.parentDirectory.length+1),/^[0-9a-f-]{36}$/);assert.equal(owner.construction.freshStartContext.generation,0n);
  const other=harness();await assert.rejects(other.run.open(fixture),safe("GOVERNED_NOTE_INPUT_INVALID"));await assert.rejects(h.run.open({} as never),safe("GOVERNED_NOTE_INPUT_INVALID"));
  await assert.rejects(allocate({} as never,{parentDirectory:h.directory}),safe("GOVERNED_NOTE_INPUT_INVALID"));assert.equal(other.owners.length,0);assert.ok(existsSync(h.directory));await h.run.close(permit);
});
test("open reserves synchronously before construction and rejects reentrant duplicate open",{timeout:20000},async()=>{
  let duplicate:Promise<unknown>|undefined;let fixture:Awaited<ReturnType<typeof allocate>>;const h=harness();
  const run=createGovernedNoteRunV1({...h.options,ownerFactory:c=>{duplicate=run.open(fixture);void duplicate.catch(()=>{});const o=new Owner(c);h.owners.push(o);return o;}});
  fixture=await allocate(run,{parentDirectory:h.parentDirectory});const permit=await run.open(fixture);
  await assert.rejects(duplicate!,safe("GOVERNED_NOTE_INPUT_INVALID"));assert.equal(h.owners.length,1);await run.close(permit);
});
test("active create makes recovery busy and recovery holds exclusive admission through disposition",{timeout:20000},async()=>{
  const h=harness(),{permit,owner}=await h.open(),p=prepared(),createGate=deferred<CreateResult>(),readGate=deferred<GovernedNoteRecoveryResultV1>();
  owner.createAction=()=>createGate.promise;owner.recoverAction=()=>readGate.promise;
  try {const pending=h.run.create(permit,p);await assert.rejects(h.run.recover(permit,recovery(p)),safe("GOVERNED_NOTE_OWNER_BUSY"));assert.equal(owner.recovers,0);
    createGate.resolve(receipt(owner.construction,p));await pending;const read=h.run.recover(permit,recovery(p));
    await assert.rejects(h.run.create(permit,p),safe("GOVERNED_NOTE_OWNER_BUSY"));await assert.rejects(h.run.recover(permit,recovery(p)),safe("GOVERNED_NOTE_OWNER_BUSY"));await assert.rejects(h.run.close(permit),safe("GOVERNED_NOTE_OWNER_BUSY"));assert.equal(owner.creates,1);assert.equal(owner.recovers,1);assert.equal(owner.closes,0);
    readGate.resolve(absent(recovery(p)));await read;await h.run.close(permit);
  } finally {createGate.resolve(receipt(owner.construction,p));readGate.resolve(absent(recovery(p)));}
});
test("normal release alone permits same-run reopen with new generation and invalidates old permit",{timeout:20000},async()=>{
  const h=harness(),{permit,fixture,owner}=await h.open();await assert.rejects(h.run.reopen(permit),safe("GOVERNED_NOTE_INPUT_INVALID"));await h.run.close(permit);const next=await h.run.reopen(permit);
  assert.notEqual(next,permit);assert.equal(h.owners.length,2);assert.equal(owner.construction.ownerGeneration,"1");assert.equal(h.owners[1]!.construction.ownerGeneration,"2");assert.equal(h.owners[1]!.construction.fixtureId,owner.construction.fixtureId);
  for(const p of [permit,{} as never]) await assert.rejects(h.run.create(p,prepared()),safe("GOVERNED_NOTE_INPUT_INVALID"));await assert.rejects(h.run.open(fixture),safe("GOVERNED_NOTE_INPUT_INVALID"));await h.run.close(next);
});
test("identical unavailable error is definitive only on a still healthy owner",{timeout:60000},async()=>{
  for(const healthy of [true,false]) {const h=harness(),{permit,owner}=await h.open(),p=prepared();owner.recoverAction=async()=>{owner.healthy=healthy;throw new GovernedNoteError("WORKER_UNAVAILABLE");};
    await assert.rejects(h.run.recover(permit,recovery(p)),safe(healthy?"WORKER_UNAVAILABLE":"GOVERNED_NOTE_OWNERSHIP_UNCERTAIN",healthy?{}:ids(p)));
    owner.healthy=true;owner.recoverAction=async q=>absent(q);
    if(healthy){await h.run.recover(permit,recovery(p));await h.run.close(permit);}else {await assert.rejects(h.run.recover(permit,recovery(p)),safe("GOVERNED_NOTE_OWNERSHIP_UNCERTAIN",ids(p)));await assert.rejects(h.run.reopen(permit),safe("GOVERNED_NOTE_UNAVAILABLE"));assert.equal(owner.recovers,1);}
  }
});
test("false, throwing and malformed health fail closed before dispatch",{timeout:60000},async()=>{
  for(const health of [false,new Error("private"),undefined,"true"]) {const h=harness(),{permit,owner}=await h.open(),p=prepared();owner.healthy=health;await assert.rejects(h.run.create(permit,p),safe("GOVERNED_NOTE_OWNERSHIP_UNCERTAIN",ids(p)));assert.equal(owner.creates,0);owner.healthy=true;await assert.rejects(h.run.close(permit),safe("GOVERNED_NOTE_UNAVAILABLE"));assert.equal(h.owners.length,1);}
});
test("independent health failure at success disposition poisons and late receipt cannot heal",{timeout:20000},async()=>{
  const h=harness(),{permit,owner}=await h.open(),a=prepared(),b=prepared(),late=deferred<CreateResult>();owner.createAction=p=>p.command.commandId===a.command.commandId?late.promise:Promise.resolve(receipt(owner.construction,p));
  try {const pending=h.run.create(permit,a);void pending.catch(()=>{});owner.healthy=false;await assert.rejects(h.run.create(permit,b),safe("GOVERNED_NOTE_OWNERSHIP_UNCERTAIN",ids(b)));owner.healthy=true;late.resolve(receipt(owner.construction,a));await assert.rejects(pending,safe("GOVERNED_NOTE_OWNERSHIP_UNCERTAIN",ids(a)));await assert.rejects(h.run.reopen(permit),safe("GOVERNED_NOTE_UNAVAILABLE"));assert.equal(h.owners.length,1);assert.ok(existsSync(h.directory));} finally {late.resolve(receipt(owner.construction,a));}
});
test("intentional DRAINING allows admitted creates to settle while rejecting ingress",{timeout:20000},async()=>{
  const h=harness(),{permit,owner}=await h.open(),p=prepared(),createGate=deferred<CreateResult>(),closeGate=deferred<GovernedNoteCloseObservationV1>();owner.createAction=()=>createGate.promise;owner.closeAction=()=>closeGate.promise;
  try {const create=h.run.create(permit,p),close=h.run.close(permit);void close.catch(()=>{});assert.equal(owner.healthy,false);
    await assert.rejects(h.run.create(permit,p),safe("GOVERNED_NOTE_OWNER_BUSY"));await assert.rejects(h.run.recover(permit,recovery(p)),safe("GOVERNED_NOTE_OWNER_BUSY"));await assert.rejects(h.run.reopen(permit),safe("GOVERNED_NOTE_INPUT_INVALID"));
    createGate.resolve(receipt(owner.construction,p));assert.equal((await create).replay,false);assert.equal(h.owners.length,1);closeGate.resolve({disposition:"graceful-confirmed",ownerId:owner.ownerId});await close;const next=await h.run.reopen(permit);await h.run.close(next);
  } finally {createGate.resolve(receipt(owner.construction,p));closeGate.resolve({disposition:"ownership-uncertain",ownerId:owner.ownerId});}
});
test("queue-full is definitive while protocol, unknown outcome and forced close are absorbing",{timeout:60000},async()=>{
  const h=harness(),{permit,owner}=await h.open(),p=prepared();owner.createAction=async()=>{throw new GovernedNoteError("STORE_QUEUE_FULL");};await assert.rejects(h.run.create(permit,p),safe("STORE_QUEUE_FULL"));await h.run.recover(permit,recovery(p));
  owner.createAction=async()=>{throw new GovernedNoteError("COMMAND_OUTCOME_UNKNOWN",ids(p));};await assert.rejects(h.run.create(permit,p),safe("GOVERNED_NOTE_OWNERSHIP_UNCERTAIN",ids(p)));await assert.rejects(h.run.close(permit),safe("GOVERNED_NOTE_UNAVAILABLE"));
  for(const disposition of ["ownership-uncertain","bad","reject"]) {const f=harness(),o=await f.open();o.owner.closeAction=async()=>{if(disposition==="reject")throw new Error("cleanup secret");return {disposition,ownerId:o.owner.ownerId} as never;};await assert.rejects(f.run.close(o.permit),safe("GOVERNED_NOTE_UNAVAILABLE"));await assert.rejects(f.run.reopen(o.permit),safe("GOVERNED_NOTE_UNAVAILABLE"));assert.equal(f.owners.length,1);}
});
test("malformed and mismatched results or errors never release recovery admission",{timeout:60000},async()=>{
  for(const fault of ["ids","extra","error","protocol","health"]) {const h=harness(),{permit,owner}=await h.open(),p=prepared();owner.recoverAction=async q=>{if(fault==="error")throw {code:"WORKER_UNAVAILABLE",message:"WORKER_UNAVAILABLE",details:{secret:true}};if(fault==="protocol")throw new GovernedNoteError("WORKER_PROTOCOL_ERROR");if(fault==="health")owner.healthy=false;return {...absent(q),...(fault==="ids"?{commandId:randomUUID()}:fault==="extra"?{extra:true}:{})} as never;};
    await assert.rejects(h.run.recover(permit,recovery(p)),safe("GOVERNED_NOTE_OWNERSHIP_UNCERTAIN",ids(p)));owner.healthy=true;await assert.rejects(h.run.reopen(permit),safe("GOVERNED_NOTE_UNAVAILABLE"));assert.equal(owner.recovers,1);
  }
});
test("constructor, open and reopen uncertainty use empty details and never replace again",{timeout:60000},async()=>{
  for(const fault of ["constructor","open","health","reopen"]) {const h=harness();let constructions=0;const run=createGovernedNoteRunV1({...h.options,ownerFactory:c=>{constructions++;if(fault==="constructor"||fault==="reopen"&&constructions===2)throw new Error("private");const o=new Owner(c);if(fault==="open")o.openAction=async()=>{throw new Error("private");};if(fault==="health")o.healthy=false;return o;}}),fixture=await allocate(run,{parentDirectory:h.parentDirectory});
    if(fault==="reopen"){const p=await run.open(fixture);await run.close(p);await assert.rejects(run.reopen(p),safe("GOVERNED_NOTE_UNAVAILABLE"));await assert.rejects(run.reopen(p),safe("GOVERNED_NOTE_UNAVAILABLE"));assert.equal(constructions,2);}else {await assert.rejects(run.open(fixture),safe("GOVERNED_NOTE_UNAVAILABLE"));await assert.rejects(run.open(fixture),safe("GOVERNED_NOTE_UNAVAILABLE"));assert.equal(constructions,1);}
  }
});
test("directory and initialized file replacement or hardlinks deny construction",{timeout:60000},async()=>{
  for(const fault of ["directory","events","descriptor","manifest","hardlink","symlink"]) {const h=harness(),fixture=await allocate(h.run,{parentDirectory:h.parentDirectory});let path=h.directory;
    if(fault!=="directory")path=fault==="symlink"?join(h.directory,"vault",".memory-mcp","v2"):join(h.directory,"vault",".memory-mcp",fault==="descriptor"?"project-identity.json":join("v2",fault==="manifest"?"store-manifest.json":"events.sqlite"));
    if(fault==="hardlink")linkSync(path,path+".alias");else {renameSync(path,path+".original");if(fault==="directory")mkdirSync(path);else if(fault==="symlink")symlinkSync(path+".original",path,process.platform==="win32"?"junction":"dir");else writeFileSync(path,"replacement");}
    await assert.rejects(h.run.open(fixture),safe("GOVERNED_NOTE_UNAVAILABLE"));assert.equal(h.owners.length,0);assert.ok(existsSync(path));await assert.rejects(h.run.open(fixture),safe("GOVERNED_NOTE_UNAVAILABLE"));
  }
});
test("symlink parents, alias spelling and setup failure never mint an attachable fixture",{timeout:20000},async()=>{
  const h=harness(),alias=join(h.parentDirectory,"alias"),target=join(h.parentDirectory,"target");mkdirSync(target);symlinkSync(target,alias,process.platform==="win32"?"junction":"dir");
  await assert.rejects(allocate(h.run,{parentDirectory:alias}),safe("GOVERNED_NOTE_UNAVAILABLE"));assert.deepEqual(readdirSync(target),[]);assert.equal(h.initialized,0);
  const bad=harness({freshInitializer:{async initialize(){throw new Error("private setup");}}});await assert.rejects(allocate(bad.run,{parentDirectory:bad.parentDirectory}),safe("GOVERNED_NOTE_UNAVAILABLE"));assert.equal(readdirSync(bad.parentDirectory).length,1);assert.equal(bad.owners.length,0);
});
test("returned escaped routes and replacement across async initialization are refused",{timeout:60000},async()=>{
  for(const fault of ["escape","replace"]) {const h=harness(),run=createGovernedNoteRunV1({...h.options,freshInitializer:{async initialize(i){const result=await h.options.freshInitializer.initialize(i);if(fault==="replace"){renameSync(i.freshDirectory,i.freshDirectory+".original");mkdirSync(i.freshDirectory);return result;}return {...result,context:{...result.context,binding:{...result.context.binding,storeRoute:{...result.context.binding.storeRoute,eventsPath:join(h.parentDirectory,"events.sqlite")}}}};}}});await assert.rejects(allocate(run,{parentDirectory:h.parentDirectory}),safe("GOVERNED_NOTE_UNAVAILABLE"));assert.equal(h.owners.length,0);}
});

test("exclusive mkdir collision preserves existing contents without initializing or retrying",async t=>{
  const h=harness(),mkdir=fs.mkdirSync;let collisions=0,path="";
  t.mock.method(fs,"mkdirSync",((candidate:string)=>{collisions++;path=candidate;mkdir(candidate);writeFileSync(join(candidate,"sentinel"),"keep");return mkdir(candidate);}) as typeof mkdir);
  syncBuiltinESMExports();
  try{await assert.rejects(allocate(h.run,{parentDirectory:h.parentDirectory}),safe("GOVERNED_NOTE_UNAVAILABLE"));assert.equal(collisions,1);assert.equal(h.initialized,0);assert.deepEqual(readdirSync(path),["sentinel"]);}finally{t.mock.restoreAll();syncBuiltinESMExports();}
});
test("invalid inputs and cross-run permits post nothing and do not consume admission",{timeout:20000},async()=>{
  const h=harness(),{permit,owner}=await h.open(),other=harness(),p=prepared();await assert.rejects(other.run.create(permit,p),safe("GOVERNED_NOTE_INPUT_INVALID"));
  await assert.rejects(h.run.create(permit,{...p,command:{...p.command,commandId:"invalid"}}),safe("GOVERNED_NOTE_INPUT_INVALID"));await assert.rejects(h.run.recover(permit,{...recovery(p),authorization:{} as never}),safe("GOVERNED_NOTE_INPUT_INVALID"));assert.equal(owner.creates,0);assert.equal(owner.recovers,0);assert.equal((await h.run.create(permit,p)).replay,false);await h.run.close(permit);
});
test("malformed create scope, ID and envelope disqualify the owner",{timeout:60000},async()=>{
  for(const fault of ["scope","ids","extra"]){const h=harness(),{permit,owner}=await h.open(),p=prepared();owner.createAction=async()=>{const value=receipt(owner.construction,p);if(fault==="scope")value.response.scope={...value.response.scope,sessionId:randomUUID() as never};if(fault==="ids")value.response.commandId=randomUUID();if(fault==="extra")(value.response as unknown as Record<string,unknown>).extra=true;return value;};await assert.rejects(h.run.create(permit,p),safe("GOVERNED_NOTE_OWNERSHIP_UNCERTAIN",ids(p)));await assert.rejects(h.run.reopen(permit),safe("GOVERNED_NOTE_UNAVAILABLE"));}
});
class ManualScheduler implements ExecutorScheduler {
  timers=new Map<object,{callback:()=>void;delay:number}>();created:number[]=[];
  setTimeout(callback:()=>void,delay:number){const key={};this.created.push(delay);this.timers.set(key,{callback,delay});return key;}
  clearTimeout(key:object){this.timers.delete(key);}
  fire(delay:number){const pair=[...this.timers].find(([,timer])=>timer.delay===delay);assert.ok(pair);this.timers.delete(pair[0]);pair[1].callback();}
}
class ControlledWorker extends EventEmitter implements WorkerLike {
  posts:WorkerRequest[]=[];terminations=0;
  constructor(private readonly construction:GovernedNoteOwnerConstructionV1,private readonly genesis:FreshStartGenesis){super();}
  postMessage(value:unknown){const request=value as WorkerRequest;this.posts.push(request);if(request.type==="open")queueMicrotask(()=>this.emit("message",{id:request.id,ok:true,data:{...encodeWorkerBindingAssertion(this.construction.context),executorId:randomUUID(),freshStart:{...request.freshStart,eventPosition:this.genesis.semanticPosition,eventHash:this.genesis.terminalHash}}}));}
  async terminate(){this.terminations++;return 0;}
}
test("R and C integer endpoints use injected scheduler observations without native waiting",{timeout:60000},async()=>{
  for(const endpoint of [1,2147483647])for(const operation of ["create","recover","close"]){
    const h=harness(),scheduler=new ManualScheduler();let executor!:ProjectStoreExecutor,worker!:ControlledWorker,constructions=0;
    const configured={...timing,requestTimeoutMs:endpoint,appendRetryDeadlineMs:endpoint,closeTimeoutMs:endpoint};
    const run=createGovernedNoteRunV1({...h.options,timing:configured,ownerFactory:c=>{constructions++;worker=new ControlledWorker(c,h.genesis);executor=new ProjectStoreExecutor({workerUrl:new URL("../src/workers/project-store.worker.js",import.meta.url),context:c.context,freshStart:c.freshStartContext,...configured},{workerFactory:()=>worker,scheduler});return {open:async()=>{await executor.open();},canReuse:()=>executor.canReuse(),createGovernedNote:p=>executor.createGovernedNote(p),recoverGovernedNoteResult:p=>executor.recoverGovernedNoteResult(p),closeForGovernedNoteController:()=>executor.closeForGovernedNoteController()};}});
    const fixture=await allocate(run,{parentDirectory:h.parentDirectory}),permit=await run.open(fixture),p=prepared();
    const pending=operation==="close"?run.close(permit):operation==="create"?run.create(permit,p):run.recover(permit,recovery(p));void pending.catch(()=>{});
    scheduler.fire(endpoint);await assert.rejects(pending,safe(operation==="close"?"GOVERNED_NOTE_UNAVAILABLE":"GOVERNED_NOTE_OWNERSHIP_UNCERTAIN",operation==="close"?{}:ids(p)));
    await assert.rejects(run.reopen(permit),safe("GOVERNED_NOTE_UNAVAILABLE"));assert.equal(constructions,1);assert.equal(worker.terminations,1);assert.equal(worker.posts.filter(r=>r.type==="governed-note-create"||r.type==="governed-note-recover").length,operation==="close"?0:1);assert.ok(scheduler.created.every(delay=>delay===endpoint));assert.ok(existsSync(h.directory));
  }
});
test("replacement during the first native spelling observation refuses before initializer",async t=>{
  let calls=0,swaps=0;const h=harness({freshInitializer:{async initialize(){calls++;throw new Error("should not initialize replacement");}}}),native=fs.realpathSync.native;
  t.mock.method(fs.realpathSync,"native",((path:string)=>{if(swaps===0&&path.startsWith(h.parentDirectory+sep)&&/^[0-9a-f-]{36}$/.test(path.slice(h.parentDirectory.length+1))){swaps++;renameSync(path,path+".original");mkdirSync(path);}return native(path);}) as typeof native);
  try{await assert.rejects(allocate(h.run,{parentDirectory:h.parentDirectory}),safe("GOVERNED_NOTE_UNAVAILABLE"));assert.equal(swaps,1);assert.equal(calls,0);}finally{t.mock.restoreAll();}
});
