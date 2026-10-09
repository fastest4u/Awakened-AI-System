import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { decodeGovernedFixtureActionV1 } from "../src/orchestrator/governed-notes/fixture-control.js";
import { makeGovernedNoteFixture } from "./support/governed-note-fixture.js";

test("closed fixture actions admit a bounded owned clock snapshot without invoking accessors", () => {
  const action = {kind:"set-fixture-controls", controls:{kind:"clock",now:"2026-10-09T00:00:00.000Z"}};
  assert.deepEqual(decodeGovernedFixtureActionV1(action), action);
  let calls=0;
  assert.throws(()=>decodeGovernedFixtureActionV1({get kind(){calls++;return "bootstrap";}}));
  assert.throws(()=>decodeGovernedFixtureActionV1(new Proxy({}, {ownKeys(){calls++;return [];}})));
  assert.equal(calls,0);
});

test("bootstrap proof mint and mutation use one controlled local worker owner", {timeout:120000}, async (t) => {
  let fixture: Awaited<ReturnType<typeof makeGovernedNoteFixture>> | undefined;
  try {
    await assert.doesNotReject(async()=>{fixture=await makeGovernedNoteFixture();});
    assert.ok(fixture);
    assert.equal(fixture.observations().openWriterConnectionCount,1);
    assert.equal(fixture.observations().parentProviderRpcCalls,0);
    assert.equal(fixture.observations().factoryConnectionIdentityCount,1);assert.equal(fixture.observations().factoryFenceIdentityCount,1);assert.equal(fixture.observations().factoryKeyProviderIdentityCount,1);
    for(const recordKind of ["session-log","insight","mistake","adr"] as const){
      const command={version:1 as const,operation:"create-governed-note" as const,commandId:randomUUID(),idempotencyKey:randomUUID(),recordKind,summary:"g10unique fixture_secret",confidence:"low" as const,provenance:[{kind:"retained-evidence" as const,identity:fixture.sourceId}]};
      const receipt=await fixture.run.create(fixture.permit,await fixture.prepareCreate(command));
      assert.equal(receipt.recordKind,recordKind);assert.equal(receipt.status,"candidate");assert.equal(receipt.verificationStatus,"unverified");
      const recovered=await fixture.run.recover(fixture.permit,await fixture.prepareRecovery(command));
      assert.equal(recovered.outcome,"committed");
    }
    assert.equal(fixture.observations().pairs,4);assert.equal(fixture.observations().pairHeaderFailures,0);assert.equal(fixture.observations().privacyLeaks,0);assert.equal(fixture.observations().safeOutputLeaks,0);assert.equal(fixture.observations().metricLeaks,0);assert.equal(fixture.observations().logLeaks,0);t.diagnostic(JSON.stringify(fixture.observations(),(_k,v:unknown)=>typeof v==="bigint"?v.toString():v));
  }finally{await fixture?.cleanup();}
});

function commandFor(f:Awaited<ReturnType<typeof makeGovernedNoteFixture>>,summary="g10unique fixture_secret"){
 return {version:1 as const,operation:"create-governed-note" as const,commandId:randomUUID(),idempotencyKey:randomUUID(),recordKind:"insight" as const,summary,confidence:"low" as const,provenance:[{kind:"retained-evidence" as const,identity:f.sourceId}]};
}
const code=(expected:string)=>(error:unknown)=>typeof error==="object"&&error!==null&&"code"in error&&error.code===expected;

test("own child uses current same-session authority and retained-only provenance",{timeout:120000},async()=>{
 const f=await makeGovernedNoteFixture({child:true});try{
  const command=commandFor(f),prepared=await f.prepareCreate(command),receipt=await f.run.create(f.permit,prepared);
  for(const recordKind of ["session-log","mistake","adr"] as const)await f.run.create(f.permit,await f.prepareCreate({...commandFor(f),recordKind}));
  assert.equal(receipt.scope.sessionId,f.childSessionId);assert.notEqual(receipt.scope.sessionId,f.rootSessionId);
  const invalid=commandFor(f);invalid.provenance[0]!.identity=randomUUID();
  await assert.rejects(f.run.create(f.permit,await f.prepareCreate(invalid)),code("GOVERNED_NOTE_PROVENANCE_INELIGIBLE"));
  assert.equal(f.observations().providerThreadId,f.observations().ownerWorkerThreadId);
 }finally{await f.cleanup();}
});

test("normal reopen preserves provider history and status and historical note replay",{timeout:120000},async()=>{
 const f=await makeGovernedNoteFixture();try{
  const command=commandFor(f),first=await f.run.create(f.permit,await f.prepareCreate(command));
  await f.controls({kind:"evidence-key-rotate",purpose:"original-input-commitment",ref:{keyId:"g10/original-input-commitment",version:"2"}});
  await f.controls({kind:"evidence-key-status",purpose:"data-key-wrap",ref:{keyId:"g10/data-key-wrap",version:"1"},status:"revoked"});
  await f.controls({kind:"policy",policy:{policyId:"g10-next",policyVersion:"2",rules:[]}});
  const expected=f.observations().statuses,before=f.observations();
  await f.run.close(f.permit);assert.equal(f.observations().disposed,1);assert.equal(f.observations().openWriterConnectionCount,0);
  f.permit=await f.run.reopen(f.permit);assert.ok(f.observations().ownerGeneration>before.ownerGeneration);assert.deepEqual(f.observations().statuses,expected);
  const replay=await f.run.create(f.permit,await f.prepareCreate(command));assert.equal(replay.recordId,first.recordId);assert.equal(replay.replay,true);
  const recovery=await f.run.recover(f.permit,await f.prepareRecovery(command));assert.equal(recovery.outcome,"committed");
 }finally{await f.cleanup();}
});

test("lost downstream CLIENT result and revoked source key retain healthy receipt-only recovery",{timeout:120000},async()=>{
 const f=await makeGovernedNoteFixture();try{
  const command=commandFor(f);await f.run.create(f.permit,await f.prepareCreate(command)); // executor/controller accepted; downstream client discards delivery
  await f.controls({kind:"evidence-key-status",purpose:"data-key-wrap",ref:{keyId:"g10/data-key-wrap",version:"1"},status:"revoked"});
  const prepared=await f.prepareRecovery(command),before=f.observations();
  const result=await f.run.recover(f.permit,prepared);assert.equal(result.outcome,"committed");
  const after=f.observations();assert.equal(after.unwrap,before.unwrap);assert.equal(after.originalMac,before.originalMac);assert.equal(after.createPosts,before.createPosts);
  await assert.rejects(f.run.create(f.permit,await f.prepareCreate(commandFor(f))),code("GOVERNED_NOTE_KEY_UNAVAILABLE"));
 }finally{await f.cleanup();}
});

for(const [name,scenario,committed]of [["delayed committed delivery after worker authorization expiry","delay-committed",true],["delayed not-found delivery after worker authorization expiry","delay-absent",false]] as const){
 test(name,{timeout:120000},async(t)=>{
  const f=await makeGovernedNoteFixture({scenario});try{
   const command=commandFor(f),create=await f.prepareCreate(command);if(committed)await f.run.create(f.permit,create);
   const prepared=await f.prepareRecovery(command),before=f.observations(),pending=f.run.recover(f.permit,prepared);void pending.catch(()=>undefined);
   try{
    const deadline=Date.now()+10000;while(f.observations().commit!==1&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(f.observations().commit,1);assert.equal(f.observations().delivery,0);
    await assert.rejects(f.run.create(f.permit,create),code("GOVERNED_NOTE_OWNER_BUSY"));
    await assert.rejects(f.controls({kind:"clock",now:"2026-10-09T01:00:00.000Z"}),code("GOVERNED_NOTE_OWNER_BUSY"));
    await assert.rejects(f.run.close(f.permit),code("GOVERNED_NOTE_OWNER_BUSY"));
    const result=await pending;assert.equal(result.outcome,committed?"committed":"not-found");
    const after=f.observations();assert.equal(after.detach,1);assert.equal(after.detachTime,after.expiresAt-1n);assert.equal(after.deliveryTime,after.expiresAt+1n);assert.equal(after.commit,1);assert.equal(after.createPosts,before.createPosts);assert.equal(after.proofMints,before.proofMints);assert.equal(after.actionPosts,before.actionPosts);t.diagnostic(JSON.stringify({case:name,...after,parentCapabilityClockDependency:"absent: controller owns no capability clock",proofRenewals:after.proofMints-before.proofMints},(_k,v:unknown)=>typeof v==="bigint"?v.toString():v));
   }finally{await pending.catch(()=>undefined);}
  }finally{await f.cleanup();}
 });
}

for(const committed of [true,false])test(`detach at expiry refuses ${committed?"committed receipt":"absence"} without renewal`,{timeout:120000},async()=>{
 const f=await makeGovernedNoteFixture({scenario:"detach-expired"});try{
  const command=commandFor(f);if(committed)await f.run.create(f.permit,await f.prepareCreate(command));const prepared=await f.prepareRecovery(command),before=f.observations();
  await assert.rejects(f.run.recover(f.permit,prepared));assert.equal(f.observations().detach,0);assert.equal(f.observations().commit,0);assert.equal(f.observations().createPosts,before.createPosts);assert.equal(f.observations().proofMints,before.proofMints);
 }finally{await f.cleanup();}
});


test("current capability refusal is independent of valid active recovery admission",{timeout:120000},async()=>{
 const f=await makeGovernedNoteFixture();try{
  const command=commandFor(f);await f.run.create(f.permit,await f.prepareCreate(command));const prepared=await f.prepareRecovery(command);
  await f.controls({kind:"capability-key-status",purpose:"root-session-handle",keyId:"g10/root-session-handle/1",status:"revoked"});
  const before=f.observations();await assert.rejects(f.run.recover(f.permit,prepared));assert.equal(f.observations().detach,0);assert.equal(f.observations().createPosts,before.createPosts);
 }finally{await f.cleanup();}
});

test("injected actual command-recovery guard independently withholds committed and absent results",{timeout:120000},async()=>{
 const f=await makeGovernedNoteFixture({scenario:"admission-denied"});try{
  const command=commandFor(f);await f.run.create(f.permit,await f.prepareCreate(command));
  for(const ids of [command,{commandId:randomUUID(),idempotencyKey:randomUUID()}]){const prepared=await f.prepareRecovery(ids);await assert.rejects(f.run.recover(f.permit,prepared),code("FRESH_START_BUILD_MISMATCH"));assert.equal(f.observations().detach,0);assert.equal(f.observations().commit,0);}assert.equal(f.observations().admissionFault,2);
 }finally{await f.cleanup();}
});

test("missing optional fixture factory refuses safe and closes its initialized owner",{timeout:120000},async()=>{
 let unexpected:Awaited<ReturnType<typeof makeGovernedNoteFixture>>|undefined;try{await assert.rejects(async()=>{unexpected=await makeGovernedNoteFixture({scenario:"missing-factory"});},code("GOVERNED_NOTE_UNAVAILABLE"));}finally{await unexpected?.cleanup();}
});

for(const scenario of ["malformed-control","timeout-control","action-outcome-unknown"] as const)test(`private ${scenario} makes healthy executor controller permanently uncertain`,{timeout:120000},async()=>{
 const f=await makeGovernedNoteFixture({scenario});try{
  await assert.rejects(f.controls({kind:"clock",now:"2026-10-09T00:01:00.000Z"}),code("GOVERNED_NOTE_UNAVAILABLE"));
  await assert.rejects(f.run.reopen(f.permit),code("GOVERNED_NOTE_UNAVAILABLE"));
  await assert.rejects(f.prepareRecovery({commandId:randomUUID(),idempotencyKey:randomUUID()}),code("GOVERNED_NOTE_UNAVAILABLE"));
 }finally{await f.cleanup();}
});

import { activateFreshTestStore,freshStore,freshGenesis,freshRelease,FRESH_IDENTITY } from "./support/fresh-start-fixture.js";
import { SqliteFreshStartRepository } from "../src/orchestrator/fresh-start/fresh-start.repository.js";
import { expectedSchemaFingerprint } from "../src/orchestrator/storage/schema-fingerprint.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import { decodeProvisioning } from "./support/governed-note-local-providers.js";
import { randomBytes } from "node:crypto";

test("initialized activation opt-in refuses missing identity/installation and stale or nonprepared state while default stays bare-store",async()=>{
 const defaults=freshStore();try{const active=await activateFreshTestStore(defaults.connection);assert.equal(active.trusted.generation,1n);}finally{defaults.cleanup();}
 for(const mode of ["missing","wrong","active","stale"] as const){const f=freshStore();try{
  const identity={...FRESH_IDENTITY},repository=new SqliteFreshStartRepository(f.connection);
  if(mode!=="missing")repository.transact(identity,tx=>tx.install(freshGenesis(),freshRelease({schemaIdentityHash:expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS)})));
  if(mode==="active")await activateFreshTestStore(f.connection,identity,{alreadyInitialized:true});
  if(mode==="stale"){
   const active=await activateFreshTestStore(f.connection,identity,{alreadyInitialized:true});
   await active.control.transition({identity,expectedGeneration:1n,expectedMode:"active",expectedReleaseId:active.release.releaseId,nextMode:"disabled",nextRelease:active.release,approvalEnvelope:new Uint8Array([1])});
   await active.control.transition({identity,expectedGeneration:2n,expectedMode:"disabled",expectedReleaseId:active.release.releaseId,nextMode:"prepared",nextRelease:active.release,approvalEnvelope:new Uint8Array([1])});
  }
  await assert.rejects(activateFreshTestStore(f.connection,mode==="wrong"?{...identity,storeId:randomUUID() as typeof identity.storeId}:identity,{alreadyInitialized:true}));
 }finally{f.cleanup();}}
 const f=freshStore();try{await assert.rejects(activateFreshTestStore(f.connection,undefined,{alreadyInitialized:true}));}finally{f.cleanup();}
});

test("bounded provisioning and nested action discrimination reject proxies without executing traps",()=>{
 const provisioning={version:1,runId:randomUUID(),fixtureId:randomUUID(),seed:randomBytes(32).toString("base64url"),capabilityKeys:[],evidenceKeys:[],policy:{policyId:"test",policyVersion:"1",rules:[]},clockNow:"2026-10-09T00:00:00.000Z"};
 assert.equal(decodeProvisioning(provisioning).seed,provisioning.seed);
 assert.throws(()=>decodeProvisioning({...provisioning,seed:provisioning.seed+"="}));
 assert.throws(()=>decodeProvisioning({...provisioning,evidenceKeys:Array.from({length:257},(_,i)=>({purpose:"data-key-wrap",ref:{keyId:`key${i}`,version:"1"},current:i===0,status:"available"}))}));
 let calls=0;assert.throws(()=>decodeGovernedFixtureActionV1({kind:"set-fixture-controls",controls:{get kind(){calls++;return "clock";}}}));assert.equal(calls,0);
 const prepared={command:{version:1,commandType:"retain-evidence-batch",commandId:randomUUID(),idempotencyKey:randomUUID(),targetSessionId:randomUUID(),conversationId:randomUUID(),frames:[{frameId:randomUUID(),ordinal:"0",role:"user",category:"user-message",occurredAt:provisioning.clockNow,mediaType:"text/plain; charset=utf-8",content:"x".repeat(4096),previousFrameId:null,toolCorrelationId:null,artifactHashes:[]}]},authorization:{kind:"protected",authoritySessionId:"",targetSessionId:"",proof:{proofVersion:1,target:"semantic-command",proofNonce:randomUUID(),proofFingerprint:"a".repeat(64)},approval:null,childBindingGrant:null}};
 prepared.authorization.authoritySessionId=prepared.command.targetSessionId;prepared.authorization.targetSessionId=prepared.command.targetSessionId;
 assert.equal(decodeGovernedFixtureActionV1({kind:"retain",prepared}).kind,"retain");
});

test("exclusive fixture action excludes create/recovery/close through acknowledged disposition",{timeout:120000},async()=>{
 const f=await makeGovernedNoteFixture({scenario:"delay-control"});try{
  const command=commandFor(f),prepared=await f.prepareCreate(command),recovery=await f.prepareRecovery(command);
  const before=f.observations(),control=f.controls({kind:"clock",now:"2026-10-09T00:00:01.000Z"});void control.catch(()=>undefined);
  try{await assert.rejects(f.run.create(f.permit,prepared),code("GOVERNED_NOTE_OWNER_BUSY"));await assert.rejects(f.run.recover(f.permit,recovery),code("GOVERNED_NOTE_OWNER_BUSY"));await assert.rejects(f.run.close(f.permit),code("GOVERNED_NOTE_OWNER_BUSY"));assert.equal(f.observations().createPosts,before.createPosts);}finally{await control;}
  await f.run.create(f.permit,await f.prepareCreate(command));
 }finally{await f.cleanup();}
});

test("worker-local provider exception markers never enter safe errors or durable diagnostics",{timeout:120000},async()=>{
 const f=await makeGovernedNoteFixture({scenario:"provider-error"});try{
  const command=commandFor(f);let failure:unknown;
  try{await f.run.create(f.permit,await f.prepareCreate(command));}catch(error){failure=error;}
  assert.ok(failure);const safe=JSON.stringify(failure);assert.equal(safe.includes("fixture_exception_marker"),false);assert.equal(safe.includes("fixture_secret"),false);assert.equal(f.observations().pairs,0);assert.equal(f.observations().privacyLeaks,0);assert.equal(f.observations().safeOutputLeaks,0);assert.equal(f.observations().metricLeaks,0);assert.equal(f.observations().logLeaks,0);
 }finally{await f.cleanup();}
});

for(const committed of [true,false])test(`expiry before lookup withholds ${committed?"receipt":"absence"}`,{timeout:120000},async()=>{
 const f=await makeGovernedNoteFixture();try{const command=commandFor(f);if(committed)await f.run.create(f.permit,await f.prepareCreate(command));const prepared=await f.prepareRecovery(command),before=f.observations();await f.controls({kind:"clock",now:prepared.request.expiresAt});await assert.rejects(f.run.recover(f.permit,prepared));assert.equal(f.observations().detach,0);assert.equal(f.observations().commit,0);assert.equal(f.observations().proofMints,before.proofMints);}finally{await f.cleanup();}
});
for(const committed of [true,false])test(`injected failed read COMMIT withholds detached ${committed?"receipt":"absence"}`,{timeout:120000},async()=>{
 const f=await makeGovernedNoteFixture({scenario:"read-commit-failure"});try{const command=commandFor(f);if(committed)await f.run.create(f.permit,await f.prepareCreate(command));const prepared=await f.prepareRecovery(command),before=f.observations();await assert.rejects(f.run.recover(f.permit,prepared),code("GOVERNED_NOTE_UNAVAILABLE"));const after=f.observations();assert.equal(after.detach,1);assert.equal(after.commit,0);assert.equal(after.failedReadCommit,1);assert.equal(after.delivery,0);assert.equal(after.createPosts,before.createPosts);assert.equal(after.proofMints,before.proofMints);}finally{await f.cleanup();}
});
test("missing historical note commitment key refuses create replay while receipt recovery remains available",{timeout:120000},async()=>{
 const f=await makeGovernedNoteFixture();try{const command=commandFor(f);const receipt=await f.run.create(f.permit,await f.prepareCreate(command));await f.controls({kind:"evidence-key-rotate",purpose:"original-input-commitment",ref:{keyId:"g10/original-input-commitment",version:"2"}});await f.controls({kind:"evidence-key-status",purpose:"original-input-commitment",ref:{keyId:"g10/original-input-commitment",version:"1"},status:"unavailable"});await assert.rejects(f.run.create(f.permit,await f.prepareCreate(command)),code("GOVERNED_NOTE_KEY_UNAVAILABLE"));const before=f.observations(),recovered=await f.run.recover(f.permit,await f.prepareRecovery(command));assert.equal(recovered.outcome,"committed");if(recovered.outcome==="committed")assert.equal(recovered.receipt.recordId,receipt.recordId);assert.equal(f.observations().originalMac,before.originalMac);assert.equal(f.observations().pairs,1);}finally{await f.cleanup();}
});
