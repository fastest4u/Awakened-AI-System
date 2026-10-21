import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { makeGovernedNoteDomainFixture } from "./support/governed-note-domain-fixture.js";
import { makeGovernedNoteFixture } from "./support/governed-note-fixture.js";
import { encodePreparedGovernedNoteCreateV1, encodePreparedGovernedNoteCreateV2 } from "../src/orchestrator/governed-notes/codec.js";
import { decodeWorkerRequest, decodeWorkerResponseForRequest, encodeWorkerBindingAssertion, encodeAppendResultWire } from "../src/orchestrator/runtime/worker-protocol.js";
import * as fixtureCodecs from "../src/orchestrator/governed-notes/fixture-control.js";
import { executeGovernedFixtureActionV1, executeGovernedFixtureActionV2 } from "../src/orchestrator/governed-notes/run.js";
import type { GovernedNoteCommandV2, PreparedGovernedNoteCreateV2, GovernedNoteReceiptV2 } from "../src/orchestrator/governed-notes/contracts.js";

test("queued_v2_send_uses_owned_snapshot", async t => {
 const f=await makeGovernedNoteDomainFixture();t.after(f.cleanup);
 const body=' e\u0301\r\n\t'+ '"'.repeat(60000), command=f.commandV2({content:{format:"markdown",body}}), prepared=f.prepareCreateV2(command);
 const request=decodeWorkerRequest({id:"v2",type:"governed-note-create",binding:encodeWorkerBindingAssertion(f.rootContext),prepared:encodePreparedGovernedNoteCreateV2(prepared)});
 assert.equal(request.type,"governed-note-create");
 if(request.type!=="governed-note-create")throw Error();
 assert.equal(JSON.parse(request.prepared.command).content.body,body);
 assert.ok(Object.isFrozen(request.prepared));
});
test("request_version_selects_expected_success",async t=>{
 const f=await makeGovernedNoteDomainFixture();t.after(f.cleanup);
 const p=f.prepareCreateV2(f.commandV2()), data=encodeAppendResultWire(f.service().createV2(p,f.rootContext));
 const req=decodeWorkerRequest({id:"v2",type:"governed-note-create",binding:encodeWorkerBindingAssertion(f.rootContext),prepared:encodePreparedGovernedNoteCreateV2(p)});
 assert.equal(decodeWorkerResponseForRequest({id:req.id,ok:true,data},req).ok,true);
 assert.throws(()=>decodeGovernedNoteCreateSuccessV1(data,p.command));
 const {content:_content,...receipt1}=data.response as import("../src/orchestrator/governed-notes/contracts.js").GovernedNoteStoredReceiptV2;
 assert.throws(()=>decodeWorkerResponseForRequest({id:req.id,ok:true,data:{...data,response:{...receipt1,resultVersion:1}}},req));
 assert.throws(()=>decodeWorkerResponseForRequest({id:req.id,ok:true,data:{...data,response:{...data.response as object,body:"x".repeat(65536)}}},req));
 assert.throws(()=>decodeWorkerResponseForRequest({id:"x".repeat(16384),ok:true,data},{...req,id:"x".repeat(16384)}));
 const p1=f.prepareCreate(f.command({commandId:p.command.commandId,idempotencyKey:p.command.idempotencyKey}));
 const req1=decodeWorkerRequest({id:"v1",type:"governed-note-create",binding:encodeWorkerBindingAssertion(f.rootContext),prepared:encodePreparedGovernedNoteCreateV1(p1)});
 assert.throws(()=>decodeWorkerResponseForRequest({id:req1.id,ok:true,data},req1));
});
test("v2_preparation_accepts_65536_body",async t=>{
 const candidate=fixtureCodecs as typeof fixtureCodecs & {decodeGovernedFixtureActionV2(value:unknown):unknown};
 assert.equal(typeof candidate.decodeGovernedFixtureActionV2,"function","V2 body-aware fixture ingress required");
 const f=await makeGovernedNoteFixture();t.after(()=>f.cleanup());
 const fixture=f as typeof f & {prepareCreateV2(c:GovernedNoteCommandV2):Promise<PreparedGovernedNoteCreateV2>;run:typeof f.run & {createV2(p:typeof f.permit,c:PreparedGovernedNoteCreateV2):Promise<GovernedNoteReceiptV2>}};
 const command:GovernedNoteCommandV2={version:2,operation:"create-governed-note",commandId:randomUUID(),idempotencyKey:randomUUID(),recordKind:"insight",summary:"Owned summary",confidence:"high",provenance:[{kind:"retained-evidence",identity:f.sourceId}],content:{format:"markdown",body:'x'+'"'.repeat(65535)}};
 const prepared=await fixture.prepareCreateV2(command);
 assert.equal(prepared.command.content.body,command.content.body);
 assert.ok(Buffer.byteLength(JSON.stringify(prepared))<=262144);
 await assert.rejects(fixture.run.createV2(f.permit,{...prepared,command:{...prepared.command,content:{format:"markdown",body:"changed after proof"}}}));
 assert.equal(f.observations().pairs,0);
 const recovery1=await f.prepareRecovery(command),recovery2=await f.prepareRecoveryV2(command);
 const creating=fixture.run.createV2(f.permit,prepared);
 const blocked1=f.run.recover(f.permit,recovery1),blocked2=f.run.recoverV2(f.permit,recovery2);
 await Promise.all([assert.rejects(blocked1,{code:"GOVERNED_NOTE_OWNER_BUSY"}),assert.rejects(blocked2,{code:"GOVERNED_NOTE_OWNER_BUSY"})]);
 assert.equal((await creating).resultVersion,2);
 assert.equal(f.observations().openWriterConnectionCount,1);
 assert.equal(f.observations().factoryConnectionIdentityCount,1);assert.equal(f.observations().factoryFenceIdentityCount,1);assert.equal(f.observations().factoryKeyProviderIdentityCount,1);assert.equal(f.observations().parentProviderRpcCalls,0);
 assert.equal(f.observations().pairHeaderFailures,0);assert.equal(f.observations().privacyLeaks,0);
});
function commandFor(f:Awaited<ReturnType<typeof makeGovernedNoteFixture>>,body="Literal body"):GovernedNoteCommandV2{return {version:2,operation:"create-governed-note",commandId:randomUUID(),idempotencyKey:randomUUID(),recordKind:"insight",summary:"Owned summary",confidence:"high",provenance:[{kind:"retained-evidence",identity:f.sourceId}],content:{format:"markdown",body}};}
test("fixed_sibling_scenario_has_real_distinct_active_child",async t=>{
 const f=await makeGovernedNoteFixture({child:true,scenario:"full-note-sibling-v2"});t.after(()=>f.cleanup());
 const facts=(f.observations() as unknown as {scenario:{siblingSessionId:string;siblingForkPosition:string;siblingActive:boolean}}).scenario;
 assert.ok(facts,"worker must publish checked sibling facts");assert.notEqual(facts.siblingSessionId,f.childSessionId);assert.ok(BigInt(facts.siblingForkPosition)>0n);assert.equal(facts.siblingActive,true);
 const p=await f.prepareCreateV2(commandFor(f));assert.equal((await f.run.createV2(f.permit,p)).resultVersion,2);t.diagnostic(JSON.stringify({caseId:"full-note-sibling-v2",rootSessionId:f.rootSessionId,childSessionId:f.childSessionId,facts}));
});
test("fixed_terminal_scenario_preserves_original_recovery_and_real_completion",async t=>{
 const f=await makeGovernedNoteFixture({child:true,scenario:"full-note-child-terminal-v2"});t.after(()=>f.cleanup());
 const a=commandFor(f),receipt=await f.run.createV2(f.permit,await f.prepareCreateV2(a)),b=await f.prepareCreateV2(commandFor(f));
 const recovery=await f.prepareRecoveryV2(a),facts=(f.observations() as unknown as {scenario:{terminalPosition:string;authorityPosition:string;revocationPosition:string;originalCommandId:string;originalIdempotencyKey:string;state:string;rootActive:boolean}}).scenario;
 assert.ok(facts,"worker must publish checked completion facts");assert.equal(facts.state,"completed");assert.equal(facts.rootActive,true);assert.equal(facts.terminalPosition,facts.authorityPosition);assert.equal(facts.terminalPosition,facts.revocationPosition);assert.ok(BigInt(facts.terminalPosition)>BigInt(receipt.terminalPosition));assert.equal(facts.originalCommandId,a.commandId);assert.equal(facts.originalIdempotencyKey,a.idempotencyKey);
 assert.equal(recovery.request.commandId,a.commandId);assert.equal(recovery.request.idempotencyKey,a.idempotencyKey);
 const before=f.observations().pairs;await assert.rejects(f.run.createV2(f.permit,b));await assert.rejects(f.run.recoverV2(f.permit,recovery));assert.equal(f.observations().pairs,before);assert.equal(f.observations().ownerReusable,true);
 const proofMints=f.observations().proofMints;await assert.rejects(f.prepareRecoveryV2(a));assert.equal(f.observations().proofMints,proofMints);
 t.diagnostic(JSON.stringify({caseId:"full-note-child-terminal-v2",rootSessionId:f.rootSessionId,childSessionId:f.childSessionId,noteTerminalPosition:receipt.terminalPosition,recovery:{operationId:recovery.request.operationId,requestId:recovery.request.requestId,commandId:recovery.request.commandId,idempotencyKey:recovery.request.idempotencyKey,expiresAt:recovery.request.expiresAt},facts}));
});
import { ProjectStoreWorkerBackend } from "../src/orchestrator/runtime/project-store-worker-backend.js";
import { ProjectStoreWorkerRuntime } from "../src/orchestrator/runtime/project-store-worker-runtime.js";
import { encodeWorkerBinding, encodeFreshStartContextWire, type WorkerRequest } from "../src/orchestrator/runtime/worker-protocol.js";
import { encodePreparedGovernedNoteRecoveryV1, encodePreparedGovernedNoteRecoveryV2 } from "../src/orchestrator/governed-notes/codec.js";
import { decodeGovernedNoteCreateSuccessV1 } from "../src/orchestrator/governed-notes/worker-protocol.js";
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}

test("missing_v2_runtime_refuses_before_effects",async t=>{
 const f=await makeGovernedNoteDomainFixture();t.after(f.cleanup);let calls=0;
 for(const mode of ["v1-only","absent","throwing"]as const){
  const backend=new ProjectStoreWorkerBackend({selfUrl:new URL("../src/workers/project-store.worker.js",import.meta.url),executorLeaseMs:15000,appendRetryDeadlineMs:15000,trustedFreshStartBuildInspector:()=>f.retained.admission.trusted.measuredBuildHash,keyProvider:f.retained.lifecycle.broker,...(mode==="absent"?{}:{governedNoteRuntimeFactory:{create(){if(mode==="throwing")throw Error("private marker");return {create(){calls++;throw Error();},recover(){calls++;throw Error();}};}}})});
  try{
   const opening=backend.dispatch({id:"open",type:"open",binding:encodeWorkerBinding(f.rootContext),freshStart:encodeFreshStartContextWire(f.retained.admission.trusted)});
   if(mode==="throwing"){await assert.rejects(opening);continue;}await opening;
   const p=f.prepareCreateV2(f.commandV2()),r=f.prepareRecoveryV2(p.command,new Date(Number(f.clock.nowMs()+60000n)).toISOString()),before=f.rows();
   for(const [type,prepared]of [["governed-note-create",encodePreparedGovernedNoteCreateV2(p)],["governed-note-recover",encodePreparedGovernedNoteRecoveryV2(r)]]as const)await assert.rejects(backend.dispatch(decodeWorkerRequest({id:randomUUID(),type,binding:encodeWorkerBindingAssertion(f.rootContext),prepared})),{code:"GOVERNED_NOTE_UNAVAILABLE"});
   assert.deepEqual(f.rows(),before);assert.equal(calls,0);
  }finally{await backend.close();}
 }
});
test("worker_fifo_keeps_v2_semantic_snapshot_before_dequeue",async t=>{
 const f=await makeGovernedNoteDomainFixture();t.after(f.cleanup);const gate=deferred<void>(),seen:WorkerRequest[]=[],out:unknown[]=[];
 const runtime=new ProjectStoreWorkerRuntime({backend:{async dispatch(request){seen.push(request);if(request.id==="hold"){await gate.promise;return {} as never;}return {resultVersion:2,operation:"recover-governed-note-result",outcome:"not-found",commandId:"unused",idempotencyKey:"unused"} as never;},async close(){},async heartbeat(){return {mode:"idle"};},async quiesceAndClose(){throw Error();},async quiesceObservedAndClose(){throw Error();}},port:{postMessage(v){out.push(v);},close(){}},scheduler:{setInterval(){return {};},clearInterval(){}},heartbeatIntervalMs:5000});
 const command=f.commandV2({content:{format:"markdown",body:" e\u0301\r\n\t"+'"'.repeat(65520)}}),prepared=encodePreparedGovernedNoteCreateV2(f.prepareCreateV2(command));
 runtime.receive({id:"hold",type:"governed-note-create",binding:encodeWorkerBindingAssertion(f.rootContext),prepared});await turn();
 const mutable=structuredClone({id:"queued",type:"governed-note-create",binding:encodeWorkerBindingAssertion(f.rootContext),prepared});runtime.receive(mutable);
 (mutable.prepared as {command:string}).command="{}";mutable.prepared.authorization.targetSessionId=randomUUID() as never;assert.equal(seen.length,1);gate.resolve();await turn();await turn();
 const queued=seen[1]!;assert.equal(queued.type,"governed-note-create");if(queued.type!=="governed-note-create")throw Error();assert.equal(JSON.parse(queued.prepared.command).content.body,command.content.body);assert.equal(queued.prepared.authorization.targetSessionId,prepared.authorization.targetSessionId);assert.equal(Object.isFrozen(queued.prepared),true);
});
test("fixture_v2_exact_body_paths_correlation_and_frozen_legacy_bounds",async t=>{
 const f=await makeGovernedNoteDomainFixture();t.after(f.cleanup);const command=f.commandV2({content:{format:"markdown",body:"x"+'"'.repeat(65535)}}),action={kind:"prepare-create-v2"as const,authoritySessionId:f.retained.rootAuthority.sessionId,command};
 const binding=encodeWorkerBindingAssertion(f.rootContext),expected={runId:randomUUID(),storeId:binding.storeId,ownerGeneration:"1",binding},envelope={version:2,requestId:randomUUID(),...expected,action};
 const owned=fixtureCodecs.decodeGovernedFixtureRequestV2(envelope,expected),prepared=f.prepareCreateV2(command);
 const reply=fixtureCodecs.decodeGovernedFixtureReplyV2({version:2,requestId:envelope.requestId,ok:true,result:{kind:action.kind,prepared}},owned);assert.equal(reply.ok,true);
 const oversizedAuthorization={...prepared.authorization,proof:{...prepared.authorization.proof!,proofFingerprint:"x".repeat(16385)}};
 assert.ok(Buffer.byteLength(JSON.stringify(oversizedAuthorization))>16384);
 assert.throws(()=>encodePreparedGovernedNoteCreateV2({...prepared,authorization:oversizedAuthorization}));
 const largeMetadata={...command,summary:'"'.repeat(2048),provenance:Array.from({length:64},()=>({kind:"retained-evidence"as const,identity:randomUUID()})),content:{format:"markdown"as const,body:"x"}};
 assert.ok(Buffer.byteLength(JSON.stringify({...largeMetadata,content:{format:"markdown",body:""}}))>8192);
 assert.throws(()=>fixtureCodecs.decodeGovernedFixtureActionV2({...action,command:largeMetadata}));

 let invoked=0;const accessor={...command,content:{format:"markdown",get body(){invoked++;return command.content.body;}}};
 for(const bad of [{...envelope,version:1},{...envelope,requestId:randomUUID(),action:{...action,kind:"unknown",command:accessor}},{...envelope,action:{...action,command:accessor}},{...envelope,action:{...action,command:{...command,summary:"x".repeat(2049)}}},{...envelope,action:{...action,command:new Proxy(command,{})}},{...envelope,action:{...action,extra:true}}])assert.throws(()=>fixtureCodecs.decodeGovernedFixtureRequestV2(bad,expected));
 assert.equal(invoked,0);
 for(const body of ["x".repeat(65537),"\ud800","\u0000x"," \r\n"]){assert.throws(()=>fixtureCodecs.decodeGovernedFixtureActionV2({...action,command:{...command,content:{format:"markdown",body}}}));}
 for(const bad of [{version:1,requestId:envelope.requestId,ok:true,result:{kind:action.kind,prepared}},{version:2,requestId:randomUUID(),ok:true,result:{kind:action.kind,prepared}},{version:2,requestId:envelope.requestId,ok:true,result:{kind:"prepare-create",prepared}},{version:2,requestId:envelope.requestId,ok:false,error:{code:"GOVERNED_NOTE_UNAVAILABLE",message:"x".repeat(16385),details:{}}}])assert.throws(()=>fixtureCodecs.decodeGovernedFixtureReplyV2(bad,owned));
 const policy={kind:"set-fixture-controls"as const,controls:{kind:"policy"as const,policy:{policyId:"large-policy",policyVersion:"1",rules:Array.from({length:8},(_,n)=>({kind:"literal"as const,ruleId:`literal-${n}`,value:`${n}`+"x".repeat(1500)}))}}};
 assert.ok(Buffer.byteLength(JSON.stringify(policy))>8192);assert.doesNotThrow(()=>fixtureCodecs.decodeGovernedFixtureActionV1(policy));assert.doesNotThrow(()=>fixtureCodecs.decodeGovernedFixtureActionV2(policy));assert.doesNotThrow(()=>fixtureCodecs.decodeGovernedFixtureRequestV1({...envelope,version:1,action:policy},expected));assert.doesNotThrow(()=>fixtureCodecs.decodeGovernedFixtureRequestV2({...envelope,action:policy},expected));
 assert.throws(()=>fixtureCodecs.decodeGovernedFixtureResultV2({kind:"applied",applied:true,body:"x".repeat(17000)},policy));
});
test("recovery_request_version_selects_envelope_with_either_receipt",async t=>{
 const f=await makeGovernedNoteDomainFixture();t.after(f.cleanup);
 for(const version of [1,2]as const){const c=version===1?f.command():f.commandV2();if(version===1)f.service().create(f.prepareCreate(c as ReturnType<typeof f.command>),f.rootContext);else f.service().createV2(f.prepareCreateV2(c as GovernedNoteCommandV2),f.rootContext);
 const r=f.prepareRecoveryV2(c,new Date(Number(f.clock.nowMs()+60000n)).toISOString()),data=f.service().recoverV2(r,f.rootContext),req=decodeWorkerRequest({id:randomUUID(),type:"governed-note-recover",binding:encodeWorkerBindingAssertion(f.rootContext),prepared:encodePreparedGovernedNoteRecoveryV2(r)});
 assert.equal(decodeWorkerResponseForRequest({id:req.id,ok:true,data},req).ok,true);assert.throws(()=>decodeWorkerResponseForRequest({id:req.id,ok:true,data:{...data,resultVersion:1}},req));
 const r1=f.prepareRecovery(c,new Date(Number(f.clock.nowMs()+60000n)).toISOString()),req1=decodeWorkerRequest({...req,prepared:encodePreparedGovernedNoteRecoveryV1(r1)});assert.throws(()=>decodeWorkerResponseForRequest({id:req.id,ok:true,data},req1));
 }
});
test("v2_controller_recovery_serializes_both_versions_and_uncertainty_is_absorbing",async t=>{
 const f=await makeGovernedNoteFixture({scenario:"delay-absent"});t.after(()=>f.cleanup());
 const c=commandFor(f),p=await f.prepareCreateV2(c),r=await f.prepareRecoveryV2(c),v1={...c,version:1 as const};const {content:_body,...c1}=v1;const p1=await f.prepareCreate(c1);
 const pending=f.run.recoverV2(f.permit,r);
 await assert.rejects(f.run.createV2(f.permit,p),{code:"GOVERNED_NOTE_OWNER_BUSY"});await assert.rejects(f.run.create(f.permit,p1),{code:"GOVERNED_NOTE_OWNER_BUSY"});await assert.rejects(f.prepareCreateV2(commandFor(f)),{code:"GOVERNED_NOTE_OWNER_BUSY"});await assert.rejects(f.prepareCreate(c1),{code:"GOVERNED_NOTE_OWNER_BUSY"});assert.equal((await pending).resultVersion,2);
 await assert.rejects(f.run.createV2({}as never,p),{code:"GOVERNED_NOTE_INPUT_INVALID"});
});
test("v2_failed_read_rollback_closes_actual_owner_without_replay",async t=>{
 const f=await makeGovernedNoteFixture({scenario:"read-rollback-failure"});t.after(()=>f.cleanup());const c=commandFor(f),r=await f.prepareRecoveryV2(c),before=f.observations();
 await assert.rejects(f.run.recoverV2(f.permit,r));await assert.rejects(f.run.reopen(f.permit));await assert.rejects(f.run.createV2(f.permit,await (async()=>{const domain=await makeGovernedNoteDomainFixture();try{return domain.prepareCreateV2(domain.commandV2());}finally{await domain.cleanup();}})()));
 assert.equal(f.observations().ownerReusable,false);assert.equal(f.observations().ownerGeneration,before.ownerGeneration);assert.equal(f.observations().proofMints,before.proofMints);assert.equal(f.observations().failedReadRollbacks,1n);assert.equal(f.observations().queuedDispatches,0n);assert.equal(r.request.commandId,c.commandId);
});

test("legacy_retained_batch_over_8192_remains_accepted_in_both_fixture_versions",async t=>{
 const f=await makeGovernedNoteDomainFixture();t.after(f.cleanup);
 const invocation=f.retained.invocation({version:1,commandType:"retain-evidence-batch",commandId:randomUUID(),idempotencyKey:randomUUID(),targetSessionId:f.retained.rootAuthority.sessionId,conversationId:randomUUID(),frames:[{frameId:randomUUID(),ordinal:"0",role:"user",category:"user-message",occurredAt:f.clock.now(),mediaType:"text/plain; charset=utf-8",content:"x".repeat(9000),previousFrameId:null,toolCorrelationId:null,artifactHashes:[]}]});
 try{const action={kind:"retain"as const,prepared:{command:invocation.input.command,authorization:invocation.authorization}},binding=encodeWorkerBindingAssertion(f.rootContext),expected={runId:randomUUID(),storeId:binding.storeId,ownerGeneration:"1",binding};
 assert.ok(Buffer.byteLength(JSON.stringify(action))>8192);assert.doesNotThrow(()=>fixtureCodecs.decodeGovernedFixtureActionV1(action));assert.doesNotThrow(()=>fixtureCodecs.decodeGovernedFixtureActionV2(action));
 assert.doesNotThrow(()=>fixtureCodecs.decodeGovernedFixtureRequestV1({version:1,requestId:randomUUID(),...expected,action},expected));assert.doesNotThrow(()=>fixtureCodecs.decodeGovernedFixtureRequestV2({version:2,requestId:randomUUID(),...expected,action},expected));
 }finally{invocation.input.canonicalOriginalBytes.fill(0);}
});
import { EventEmitter } from "node:events";
import { ProjectStoreExecutor, type WorkerLike } from "../src/orchestrator/runtime/project-store-executor.js";
test("executor_v2_owns_input_until_reply_and_preserves_original_uncertain_ids",async t=>{
 const f=await makeGovernedNoteDomainFixture();t.after(f.cleanup);let workers=0;
 class Transport extends EventEmitter implements WorkerLike{posts:WorkerRequest[]=[];postMessage(value:unknown){const r=value as WorkerRequest;this.posts.push(r);if(r.type==="open")queueMicrotask(()=>this.emit("message",{id:r.id,ok:true,data:{...encodeWorkerBindingAssertion(f.rootContext),executorId:randomUUID()}}));}async terminate(){return 0;}}
 const transport=new Transport(),executor=new ProjectStoreExecutor({workerUrl:new URL("../src/workers/project-store.worker.js",import.meta.url),context:f.rootContext,requestTimeoutMs:15000,closeTimeoutMs:5000,maxPending:128,executorLeaseMs:15000,heartbeatIntervalMs:5000,appendRetryDeadlineMs:15000},{workerFactory(){workers++;return transport;}});await executor.open();
 try{const p=f.prepareCreateV2(f.commandV2({content:{format:"markdown",body:" e\u0301\r\n "+"x".repeat(32000)}})),mutable=structuredClone(p),pending=executor.createGovernedNoteV2(mutable),sent=transport.posts.at(-1)!;
 (mutable.command.content as {body:string}).body="changed";(mutable.command as {commandId:string}).commandId=randomUUID();
 assert.equal(sent.type,"governed-note-create");if(sent.type!=="governed-note-create")throw Error();assert.equal(JSON.parse(sent.prepared.command).content.body,p.command.content.body);assert.equal(JSON.parse(sent.prepared.command).commandId,p.command.commandId);
 transport.emit("message",{id:sent.id,ok:true,data:encodeAppendResultWire(f.service().createV2(p,f.rootContext))});const result=await pending;assert.equal(result.response.resultVersion,2);assert.equal(typeof result.lastGlobalPosition,"bigint");
 const next=f.prepareCreateV2(f.commandV2()),lost=executor.createGovernedNoteV2(next);transport.emit("exit",1);await assert.rejects(lost,(error:unknown)=>{assert.equal((error as {code:string}).code,"COMMAND_OUTCOME_UNKNOWN");assert.deepEqual((error as {details:unknown}).details,{commandId:next.command.commandId,idempotencyKey:next.command.idempotencyKey});return true;});assert.equal(executor.canReuse(),false);assert.equal(workers,1);
 }finally{transport.emit("exit",1);await executor.close();}
});
test("unknown_private_action_ack_closes_owner_and_cannot_renew_or_reopen",async()=>{
 const f=await makeGovernedNoteFixture({scenario:"action-outcome-unknown"}),p=await f.prepareCreateV2(commandFor(f)),before=f.observations();
 await assert.rejects(f.controls({kind:"clock",now:"2026-10-09T00:00:01.000Z"}));assert.equal(f.observations().ownerReusable,false);
 await assert.rejects(f.run.createV2(f.permit,p),{code:"GOVERNED_NOTE_OWNERSHIP_UNCERTAIN"});await assert.rejects(f.prepareRecoveryV2(p.command));await assert.rejects(f.run.reopen(f.permit));assert.equal(f.observations().proofMints,before.proofMints);assert.equal(f.observations().createPosts,before.createPosts);assert.equal(f.observations().ownerGeneration,before.ownerGeneration);
 try{await f.cleanup();}catch{/* The original uncertain fixture is retained; physical owner closure is observed below. */}
 for(let n=0;n<100&&f.observations().workerExits===0;n++)await new Promise(r=>setTimeout(r,10));assert.equal(f.observations().workerExits,1);assert.equal(f.observations().openWriterConnectionCount,0);
});
test("v1_fixture_entry_keeps_closed_actions_on_v2_run",async t=>{
 const f=await makeGovernedNoteFixture();t.after(()=>f.cleanup());const command=commandFor(f);
 const actions=[{kind:"prepare-create-v2"as const,authoritySessionId:f.rootSessionId,command},{kind:"prepare-recovery-v2"as const,authoritySessionId:f.rootSessionId,operationId:randomUUID(),requestId:randomUUID(),commandId:command.commandId,idempotencyKey:command.idempotencyKey}];
 for(const action of actions)await t.test(`rejects ${action.kind} before dispatch`,async()=>{
  const before=f.observations();
  await assert.rejects(executeGovernedFixtureActionV1(f.run,f.permit,action as never),{code:"GOVERNED_NOTE_INPUT_INVALID"});
  const after=f.observations();
  for(const key of ["actionPosts","proofMints","createPosts","recoveryPosts","pairs","ownerGeneration","openWriterConnectionCount","factoryConnectionIdentityCount"]as const)assert.equal(after[key],before[key],key);
  assert.equal(after.ownerReusable,true);
 });
 await t.test("explicit v2 and legacy v1 helpers retain their admitted results",async()=>{
  for(const action of actions){const result=await executeGovernedFixtureActionV2(f.run,f.permit,action);assert.equal(result.kind,action.kind);}
  const {content:_content,...legacyFields}=command;
  const legacy=await executeGovernedFixtureActionV1(f.run,f.permit,{kind:"prepare-create",authoritySessionId:f.rootSessionId,command:{...legacyFields,version:1}});
  assert.equal(legacy.kind,"prepare-create");if(legacy.kind!=="prepare-create")throw Error();assert.equal(legacy.prepared.command.version,1);
  const action=actions[1]!;if(action.kind!=="prepare-recovery-v2")throw Error();
  const recovered=await executeGovernedFixtureActionV1(f.run,f.permit,{...action,kind:"prepare-recovery"});
  assert.equal(recovered.kind,"prepare-recovery");if(recovered.kind!=="prepare-recovery")throw Error();assert.equal(recovered.prepared.request.version,1);
  t.diagnostic(JSON.stringify({caseId:"v1-fixture-entry-closed-on-v2-run",commandId:command.commandId,idempotencyKey:command.idempotencyKey,operationId:action.operationId,requestId:action.requestId,rootSessionId:f.rootSessionId}));
 });
});
