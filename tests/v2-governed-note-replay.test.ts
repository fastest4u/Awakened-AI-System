import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { makeGovernedNoteDomainFixture, type GovernedNoteDomainFixtureV1 } from "./support/governed-note-domain-fixture.js";
import { GovernedNoteRepository } from "../src/orchestrator/governed-notes/repository.js";
import { DatabaseSync } from "node:sqlite";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { bindFreshStartAdmissionContext } from "../src/orchestrator/fresh-start/fresh-start-admission.js";
import { GovernedNoteService } from "../src/orchestrator/governed-notes/service.js";
import { GovernedNoteAuthorityVerifier } from "../src/orchestrator/governed-notes/authority.js";
import { GovernedNoteProvenanceRepository } from "../src/orchestrator/governed-notes/provenance.repository.js";
import { EventAppendTransaction, SqliteEventAppendStatements } from "../src/orchestrator/storage/event-append-transaction.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import { join } from "node:path";
import type { ProjectContext } from "../src/orchestrator/identity/contracts.js";
import { computeProjectContextFingerprint } from "../src/orchestrator/identity/project-binding.service.js";
import { checkpointFixture } from "./support/lifecycle-fixtures.js";
import type { JsonValue } from "../src/orchestrator/contracts/event.js";

test("exact replay returns original IDs before current policy or source/current-key preparation",async t=>{
  let policyCalls=0, refuse=false;
  const f=await makeGovernedNoteDomainFixture({policy:()=>{policyCalls++; if(refuse) throw new Error("private-policy-marker"); return f.policy;}}); t.after(f.cleanup);
  const command=f.command(), result=f.service().create(f.prepareCreate(command),f.rootContext), before=f.rows();
  refuse=true; const previousCalls=policyCalls, currentCalls=f.provider.calls.current;
  f.provider.rotate("original-input-commitment"); f.provider.setStatus("original-input-commitment","unavailable"); f.provider.setStatus("data-key-wrap","revoked");
  const reordered={...command,provenance:[...command.provenance].reverse()};
  const replay=f.service().create(f.prepareCreate(reordered),f.rootContext);
  assert.equal(replay.deduplicated,true); assert.deepEqual(replay.eventIds,result.eventIds); assert.deepEqual(replay.response,result.response); assert.equal(replay.responseHash,result.responseHash);
  assert.equal(policyCalls,previousCalls); assert.equal(f.provider.calls.current,currentCalls); assert.deepEqual(f.rows(),before);
});
for(const change of ["secret","unicode","whitespace","kind","confidence","provenance","command","idempotency"] as const){
  test(`same identities with different ${change} conflicts`,async t=>{
    const f=await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
    const command=f.command({summary:" raw e\u0301 fixture_first "}); f.service().create(f.prepareCreate(command),f.rootContext); const before=f.rows();
    const changed={...command,...(change === "secret"?{summary:" raw e\u0301 fixture_second "}:change === "unicode"?{summary:command.summary.normalize("NFC")}:change === "whitespace"?{summary:command.summary.trim()}:change === "kind"?{recordKind:"adr" as const}:change === "confidence"?{confidence:"high" as const}:change === "provenance"?{provenance:command.provenance.slice(0,1)}:change === "command"?{commandId:randomUUID()}:{idempotencyKey:randomUUID()})};
    assert.throws(()=>f.service().create(f.prepareCreate(changed),f.rootContext),{code:"IDEMPOTENCY_CONFLICT"}); assert.deepEqual(f.rows(),before);
  });
}
test("missing historical note key refuses with exact original note IDs",async t=>{
  const f=await makeGovernedNoteDomainFixture();t.after(f.cleanup); const command=f.command(); f.service().create(f.prepareCreate(command),f.rootContext);const before=f.rows();
  f.provider.rotate("original-input-commitment");f.provider.forget("original-input-commitment","1");
  assert.throws(()=>f.service().create(f.prepareCreate(command),f.rootContext),(e:unknown)=>{assert.deepEqual((e as {details:unknown}).details,{commandId:command.commandId,idempotencyKey:command.idempotencyKey});assert.equal((e as Error & {code:string}).code,"GOVERNED_NOTE_KEY_UNAVAILABLE");return true;});assert.deepEqual(f.rows(),before);
});
for(const matching of [true,false])test(`concurrent ${matching?"equivalent":"different raw"} winner overrides speculative preparation`,async t=>{
  let f:GovernedNoteDomainFixtureV1, armed=true, winner:ReturnType<ReturnType<GovernedNoteDomainFixtureV1["service"]>["create"]>|undefined;
  const commandHolder:{value?:ReturnType<GovernedNoteDomainFixtureV1["command"]>}={};
  f=await makeGovernedNoteDomainFixture({faults:{inject(p){if(p!=="before-begin"||!armed)return;armed=false;const original=commandHolder.value!;const command=matching?original:{...original,summary:"different raw summary"};
    // A second real domain connection wins before the first service's BEGIN.
    // This is not a worker-owner custody/reopen qualification.
    const connection=new NodeSqliteDriver({DatabaseSync}).open(f.retained.path,{mode:"existing",busyTimeoutMs:1000});
    try{
      bindFreshStartAdmissionContext(connection,f.retained.admission.trusted);
      const events=new EventAppendTransaction(connection,new SqliteEventAppendStatements(connection),new MaintenanceFence(),new BranchScopeRepository());
      winner=new GovernedNoteService({connection,events,repository:new GovernedNoteRepository(connection),provenance:new GovernedNoteProvenanceRepository(),authority:new GovernedNoteAuthorityVerifier({connection,capabilities:f.capabilities,clock:f.clock}),provider:f.provider,policy:()=>f.policy,clock:f.clock}).create(f.prepareCreate(command),f.rootContext);
    }finally{connection.close();}
  }}});t.after(f.cleanup);
  const command=f.command();commandHolder.value=command;const before=f.rows();
  if(matching){const result=f.service().create(f.prepareCreate(command),f.rootContext);assert.equal(result.deduplicated,true);assert.deepEqual(result.eventIds,winner!.eventIds);assert.deepEqual(result.response,winner!.response);}
  else assert.throws(()=>f.service().create(f.prepareCreate(command),f.rootContext),{code:"IDEMPOTENCY_CONFLICT"});
  assert.equal(f.rows().events,before.events+2);assert.equal(f.rows().dedup,before.dedup+1);const prior=new GovernedNoteRepository(f.connection).findGovernedNotePrior(command.commandId,command.idempotencyKey)!;assert.deepEqual(prior.result.response,winner!.response);
});

test("failed replay rollback is unknown even if a second cleanup rollback could succeed",async t=>{
  const f=await makeGovernedNoteDomainFixture();t.after(f.cleanup);const command=f.command();f.service().create(f.prepareCreate(command),f.rootContext);const before=f.rows();
  const exec=f.connection.exec.bind(f.connection);let attempts=0;
  f.connection.exec=sql=>{if(sql==="ROLLBACK"&&attempts++===0)throw new Error("private-rollback-first");exec(sql);};
  try{assert.throws(()=>f.service().create(f.prepareCreate(command),f.rootContext),{code:"COMMAND_OUTCOME_UNKNOWN",details:{commandId:command.commandId,idempotencyKey:command.idempotencyKey}});assert.deepEqual(f.rows(),before);}
  finally{f.connection.exec=exec;try{exec("ROLLBACK");}catch{/* The service may already have completed cleanup. */}}
});

test("replay requires current branch binding equal to authenticated witness",async t=>{
  const f=await makeGovernedNoteDomainFixture();t.after(f.cleanup);
  const contextFor=(branchRef:string):ProjectContext=>{
    const workspace={kind:"git" as const,workspaceId:f.rootContext.binding.workspaceId,branchRef,headCommit:"a".repeat(40),detached:false,worktreeRoot:f.retained.root,gitDir:join(f.retained.root,".git"),gitCommonDir:join(f.retained.root,".git")};
    const branchScopeId=new BranchScopeRepository().resolveOrCreate(f.connection,f.rootContext.binding.projectId,workspace,f.clock.now());
    const context={...f.rootContext,workspace,branchScopeId,binding:{...f.rootContext.binding,workspace}};context.binding.contextFingerprint=computeProjectContextFingerprint(context.binding);return context;
  };
  const a=contextFor("refs/heads/note-a"),b=contextFor("refs/heads/note-b");
  const input=f.retained.invocation({version:1,commandType:"retain-evidence-batch",commandId:randomUUID(),idempotencyKey:randomUUID(),targetSessionId:f.retained.rootAuthority.sessionId,conversationId:randomUUID(),frames:[{frameId:randomUUID(),ordinal:"0",role:"user",category:"user-message",occurredAt:f.clock.now(),mediaType:"text/plain; charset=utf-8",content:"Branch attribution",previousFrameId:null,toolCorrelationId:null,artifactHashes:[]}]},f.retained.rootAuthority,a);
  let source:string;try{source=f.retained.service().retain(input).eventIds[0]!;}finally{input.input.canonicalOriginalBytes.fill(0);}
  const command=f.command({provenance:[{kind:"source-event",identity:source}]});f.service().create(f.prepareCreate(command,a),a);const before=f.rows();
  assert.throws(()=>f.service().create(f.prepareCreate(command,b),b),{code:"SESSION_OWNERSHIP_MISMATCH"});assert.deepEqual(f.rows(),before);
});

test("genuine transfer to a distinct incoming owner refuses historical root and child note replay",async t=>{
  const f=await makeGovernedNoteDomainFixture();t.after(f.cleanup);
  const root=f.prepareCreate(f.command()),childCommand=f.command({provenance:f.sources.child.map(({kind,identity})=>({kind,identity}))}),child=f.prepareCreate(childCommand,f.childContext);
  f.service().create(root,f.rootContext);f.service().create(child,f.childContext);
  const {checkpointId:_i,sessionId:_s,parentSessionId:_p,baseEventPosition:_b,checkpointEventPosition:_e,createdAt:_at,creatorAgentId:_a,creatorClientInstanceId:_c,sourceState:_st,childSummaries:_ch,evidenceCoverage:_cv,...draft}=checkpointFixture();
  await f.retained.lifecycle.checkpoint(f.retained.rootAuthority.sessionId,f.retained.rootAuthority.descriptor,draft as unknown as JsonValue);
  const incoming={...f.rootContext,binding:{...f.rootContext.binding,clientInstanceId:"note-replay-incoming-owner"}};incoming.binding.contextFingerprint=computeProjectContextFingerprint(incoming.binding);
  const resumed=await f.retained.lifecycle.resumeAfterExpiry(f.retained.rootAuthority.sessionId,f.retained.rootAuthority.descriptor,incoming);assert.equal(resumed.publicResult.ownerGeneration,"2");
  const before=f.rows();
  for(const [prepared,context] of [[root,f.rootContext],[child,f.childContext]] as const)assert.throws(()=>f.service().create(prepared,context),(e:unknown)=>{assert.ok(e instanceof Error);assert.ok(["SESSION_OWNERSHIP_MISMATCH","SESSION_HANDLE_STALE"].includes((e as Error & {code:string}).code));return true;});
  assert.deepEqual(f.rows(),before);
});
