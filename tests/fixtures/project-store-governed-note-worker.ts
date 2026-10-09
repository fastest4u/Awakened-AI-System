import { FreshStartAdmissionGuard } from "../../src/orchestrator/fresh-start/fresh-start-admission.js";
import { GovernedNoteRepository } from "../../src/orchestrator/governed-notes/repository.js";
import { randomBytes, randomUUID } from "node:crypto";
import type { CapabilityKeyProvider } from "../../src/orchestrator/lifecycle/authority/capability-key-provider.js";
import type { JsonValue } from "../../src/orchestrator/contracts/event.js";
import type { ProjectContext } from "../../src/orchestrator/identity/contracts.js";
import type { SqliteConnection } from "../../src/orchestrator/storage/sqlite-driver.js";
import { LifecycleWorkerRuntimeFactory } from "../../src/orchestrator/runtime/lifecycle-worker-runtime.factory.js";
import { decodeLifecycleWorkerOperationWire, type LifecycleWorkerOperationWire } from "../../src/orchestrator/runtime/lifecycle-worker-protocol.js";
import { SessionAuthorityRepository } from "../../src/orchestrator/storage/session-authority.repository.js";
import { SessionLeaseRepository } from "../../src/orchestrator/storage/session-lease.repository.js";
import { LifecycleApprovalRepository } from "../../src/orchestrator/storage/lifecycle-approval.repository.js";
import { ChildTransferRepository } from "../../src/orchestrator/storage/child-transfer.repository.js";
import { EvidenceCoverageRepository } from "../../src/orchestrator/storage/evidence-coverage.repository.js";
import { SqliteLifecycleProjectionRepository } from "../../src/orchestrator/storage/lifecycle-projection.repository.js";
import { MaintenanceFence } from "../../src/orchestrator/storage/maintenance-fence.js";
import { connectionBoundEvidenceCoverage } from "../../src/orchestrator/lifecycle/lifecycle-command.store.js";
import { buildLifecycleIntentWitness } from "../../src/orchestrator/lifecycle/lifecycle-intent-witness.js";
import { CapabilityService, type AuthorityMaterialDescriptorV1 } from "../../src/orchestrator/lifecycle/capability.service.js";
import { createCapabilityProof } from "../../src/orchestrator/lifecycle/authority/capability-codec.js";
import { CHILD_BINDING_GRANT_DOMAIN } from "../../src/orchestrator/lifecycle/authority/authority-material-adapter.js";
import { decodeLifecycleSemanticCommandDraft } from "../../src/orchestrator/lifecycle/contracts/commands.js";
import type { EvidenceKeyProvider, EvidenceKeyPurpose, EvidenceKeyRefV1, EvidenceKeyScope, WrappedEvidenceKeyV1 } from "../../src/orchestrator/privacy/evidence-key-provider.js";
import type { TrustedRedactionPolicyV1 } from "../../src/orchestrator/privacy/redaction.js";
import { canonicalJson } from "../../src/orchestrator/serialization/canonical-json.js";
import { decodeRetainEvidenceBatch } from "../../src/orchestrator/privacy/evidence-contracts.js";

import { parentPort,workerData,threadId,type MessagePort } from "node:worker_threads";
import { ProjectStoreWorkerBackend } from "../../src/orchestrator/runtime/project-store-worker-backend.js";
import { ProjectStoreWorkerRuntime } from "../../src/orchestrator/runtime/project-store-worker-runtime.js";
import { RetainedEvidenceRuntimeFactory } from "../../src/orchestrator/privacy/retained-evidence-runtime.factory.js";
import { GovernedNoteRuntimeFactory } from "../../src/orchestrator/governed-notes/runtime.factory.js";
import { decodeWorkerBinding,encodeWorkerBindingAssertion } from "../../src/orchestrator/runtime/worker-protocol.js";
import { deriveGovernedNoteBinding,governedNoteCreateProofTarget,governedNoteRecoveryProofTarget } from "../../src/orchestrator/governed-notes/authority.js";
import { decodeGovernedNoteRecoveryV1 } from "../../src/orchestrator/governed-notes/codec.js";
import { boundedRetainedJson,retainedExactRecord } from "../../src/orchestrator/privacy/evidence-contracts.js";
import { retainedEvidenceProofTarget } from "../../src/orchestrator/privacy/retained-evidence-authority.js";
import { GovernedNoteError } from "../../src/orchestrator/governed-notes/errors.js";
import { decodeGovernedFixtureRequestV1,decodeGovernedFixtureReplyV1,type GovernedFixtureActionV1,type TrustedGovernedFixtureFactoryV1 } from "../../src/orchestrator/governed-notes/fixture-control.js";
import { LocalGovernedProviders,decodeProvisioning,observationView,OBS,writeSafeId } from "../support/governed-note-local-providers.js";
import type { StoredCapabilityMaterialV1 } from "../../src/orchestrator/lifecycle/capability.service.js";
import type { SessionAuthorityRecord } from "../../src/orchestrator/storage/lifecycle-storage.types.js";
const data=workerData as {g10:{context:unknown;provisioning:unknown;ownerGeneration:string;port:MessagePort;observation:SharedArrayBuffer;buildHash:string;scenario:string;bootstrapConsumed:boolean};executorLeaseMs:number;appendRetryDeadlineMs:number;heartbeatIntervalMs:number};
if(!parentPort)throw new Error("G10_WORKER_REQUIRED");
const config=data.g10,context=decodeWorkerBinding(config.context),state=decodeProvisioning(config.provisioning),observation=observationView(config.observation);
if(boundedRetainedJson({context:config.context,provisioning:config.provisioning,ownerGeneration:config.ownerGeneration,buildHash:config.buildHash,scenario:config.scenario,bootstrapConsumed:config.bootstrapConsumed},4*1024*1024).bytes+config.observation.byteLength>4*1024*1024)throw new Error("G10_STARTUP_LIMIT");
Atomics.store(observation,OBS.version,1);Atomics.store(observation,OBS.generation,Number(config.ownerGeneration));Atomics.store(observation,OBS.thread,threadId);
const times=new BigInt64Array(config.observation,6144,16);Atomics.store(times,3,BigInt(config.ownerGeneration));
const providers=new LocalGovernedProviders(state,{projectId:context.binding.projectId,storeId:context.binding.storeId},config.observation),clock=providers.clock;
const rootContext:ProjectContext={...context,binding:{...context.binding,actorRole:"primary",clientInstanceId:"g10-root"}};
const childContext:ProjectContext={...context,binding:{...context.binding,actorRole:"untrusted",clientInstanceId:"g10-child"}};
// Binding fingerprints are the real context formula, not authority snapshots.
import { computeProjectContextFingerprint } from "../../src/orchestrator/identity/project-binding.service.js";

rootContext.binding.contextFingerprint=computeProjectContextFingerprint(rootContext.binding);childContext.binding.contextFingerprint=computeProjectContextFingerprint(childContext.binding);
let nextSessionId:string|undefined,bootstrapped=config.bootstrapConsumed;
const ids={uuid:()=>{const next=nextSessionId;nextSessionId=undefined;return next??randomUUID();},bytes:randomBytes};
const READ_HASH="a".repeat(64);
const sourceState=()=>({sourceStateScopeVersion:1 as const,workspaceId:context.binding.workspaceId,branchRef:context.workspace.kind==="git"?context.workspace.branchRef:null,headCommit:context.workspace.kind==="git"?context.workspace.headCommit:null,dirtyWorktreeFingerprint:READ_HASH});
const lifecycleFactory = new LifecycleWorkerRuntimeFactory({ clock, identitySource: ids,
    integrity: { assertQuickHealthy: () => undefined }, resumeSourceState: { captureCurrent: sourceState },
    checkpointSourceStateProvider: { capture: async () => sourceState(), captureForCheckpoint: sourceState, captureForFinalization: sourceState },
    checkpointSourceStateScopeResolver: { resolve: () => ({ scopeVersion: 1, descriptorPath: context.binding.descriptorPath,
      storeRoot: context.binding.storeRoute.storeRoot, privateStateRoot: context.binding.storeRoute.storeRoot,
      exactMaterializationTargets: [], exactCommittedTempPaths: [] }) }, childBindingFingerprint: target => target.actorRole === "untrusted" && target.clientInstanceId === childContext.binding.clientInstanceId ? childContext.binding.contextFingerprint : null,
    repositories: { authority: () => new SessionAuthorityRepository(), leases: () => new SessionLeaseRepository(),
      approvals: () => new LifecycleApprovalRepository(), transfers: () => new ChildTransferRepository(),
      coverage: provider => new EvidenceCoverageRepository(provider), projection: connection => new SqliteLifecycleProjectionRepository(connection) },
    transactionFacades: {
      command: ({ connection, authority, leases, approvals, transfers, coverage }) => ({
        authority: {
          get: (projectId: string, sessionId: string) => authority.get(connection, projectId, sessionId),
          insertRoot: (input: unknown) => authority.insertRoot(connection, input as never),
          insertChild: (input: unknown) => authority.insertChild(connection, input as never),
          compareAndSwap: (input: unknown) => authority.compareAndSwap(connection, input as never),
          listSafeResumeCandidates: (input: unknown) => authority.listSafeResumeCandidates(connection, input as never),
          listNonterminalRootContinuityOwners: (input: unknown) => authority.listNonterminalRootContinuityOwners(connection, input as never),
          listNonterminalChildren: (projectId: string, rootSessionId: string) => authority.listNonterminalChildren(connection, projectId, rootSessionId),
          listNonterminalChildEndingScopeProjectionsBounded: (projectId: string, rootSessionId: string, limit: number) =>
            authority.listNonterminalChildEndingScopeProjectionsBounded(connection, projectId, rootSessionId, limit),
          rootContinuityKey: (value: unknown) => authority.rootContinuityKey(connection, value as never),
          latestCheckpoint: (value: unknown) => authority.latestCheckpoint(connection, value as never),
          nextGlobalPosition: () => authority.nextGlobalPosition(connection),
          loadEvents: (value: unknown) => authority.loadEvents(connection, value as never),
          requireFoldMatch: (value: unknown) => authority.requireFoldMatch(connection, value as never),
          markCheckpointRequired: (input: unknown) => authority.markCheckpointRequired(connection, input as never),
          updateCheckpointIndex: (input: unknown) => authority.updateCheckpointIndex(connection, input as never),
          clearCheckpointRequired: (input: unknown) => authority.clearCheckpointRequired(connection, input as never),
        },
        leases: { current: (projectId: string, sessionId: string) => leases.current(connection, projectId, sessionId),
          isExpired: (value: unknown, now: bigint) => leases.isExpired(value as never, now),
          insertGeneration: (input: unknown) => leases.insertGeneration(connection, input as never),
          renewCurrent: (input: unknown) => leases.renewCurrent(connection, input as never),
          releaseCurrent: (input: unknown) => leases.releaseCurrent(connection, input as never) },
        approvals: { consume: (input: unknown) => approvals.consume(connection, input as never) },
        transfers: { get: (projectId: string, ticketId: string) => transfers.get(connection, projectId, ticketId),
          findCreatedEventPosition: (projectId: string, ticketId: string) => transfers.findCreatedEventPosition(connection, projectId, ticketId),
          listUnclaimedEndingScopeProjectionsBySourceRoot: (projectId: string, rootSessionId: string, limit: number) =>
            transfers.listUnclaimedEndingScopeProjectionsBySourceRoot(connection, projectId, rootSessionId, limit),
          insert: (input: unknown) => transfers.insert(connection, input as never), claim: (input: unknown) => transfers.claim(connection, input as never) },
        coverage: connectionBoundEvidenceCoverage(connection, coverage), workflows: {}, validation: {}, outbox: {},
      }), operational: () => ({ workflows: {}, outbox: {} } as never),
    },
  });

let connection:SqliteConnection|undefined,recovery=false,readCommitExpected=false,lastExpiry="";
const identities=new Set<SqliteConnection>(),fences=new Set<MaintenanceFence>(),keyProviders=new Set<CapabilityKeyProvider>();
function observeConnection(input:{connection:SqliteConnection;maintenanceFence:MaintenanceFence;keyProvider:CapabilityKeyProvider}):void{identities.add(input.connection);fences.add(input.maintenanceFence);keyProviders.add(input.keyProvider);Atomics.store(observation,OBS.connections,identities.size);Atomics.store(observation,OBS.fences,fences.size);Atomics.store(observation,OBS.keyProviders,keyProviders.size);connection=input.connection;Atomics.store(observation,OBS.writers,1);}
function localClock(now:string):void{providers.control({kind:"clock",now});}
const tokenMarkers=new Set<string>();
function scanPublic(value:unknown,index:number):void{const text=JSON.stringify(value,(_key,v:unknown)=>typeof v==="bigint"?v.toString():v);if(["fixture_secret","fixture_exception_marker",...tokenMarkers].some(marker=>text.includes(marker))||providers.containsPrivateMaterial(text))Atomics.add(observation,index,1);}

function scanDurable():void{
 if(!connection)return;
 const rows=connection.prepare("SELECT * FROM events WHERE event_type IN ('GovernedNoteCreated','MemorySourceRecorded') ORDER BY global_position").all();
 const dedup=connection.prepare("SELECT * FROM command_dedup WHERE command_type='create-governed-note'").all();
 let failures=0;const repository=new GovernedNoteRepository(connection);
 for(const row of rows.filter(r=>r.event_type==='GovernedNoteCreated')){
  try{const prior=repository.findGovernedNotePrior(String(row.command_id),String(row.idempotency_key));if(!prior||prior.events.length!==2||prior.events[0].eventType!=="GovernedNoteCreated"||prior.events[1].eventType!=="MemorySourceRecorded"||prior.events.some(e=>e.verificationStatus!=="unverified"||e.visibilityScope!=="session")||prior.result.response.status!=="candidate"||JSON.parse(prior.events[1].payloadJson).item.status!=="candidate")failures++;}catch{failures++;}
 }
 const text=JSON.stringify({rows,dedup},(_key,value:unknown)=>typeof value==="bigint"?value.toString():value);
 const markers=["fixture_secret","fixture_exception_marker",...tokenMarkers];
 Atomics.store(observation,OBS.pairs,rows.filter(r=>r.event_type==='GovernedNoteCreated').length);Atomics.store(observation,OBS.pairHeaderFailures,failures);Atomics.store(observation,OBS.privacyLeaks,markers.some(marker=>text.includes(marker))||providers.containsPrivateMaterial(text)?1:0);
}
const originalEvidenceMac=providers.evidence.mac.bind(providers.evidence);
providers.evidence.mac=(scope,purpose,ref,domain,bytes)=>{if(config.scenario==="provider-error"&&domain==="governed-note-original-input/v1"){Atomics.add(observation,OBS.providerFailure,1);throw new Error("fixture_exception_marker");}return originalEvidenceMac(scope,purpose,ref,domain,bytes);};
const governedFactory=new GovernedNoteRuntimeFactory({provider:providers.evidence,policy:()=>providers.state.policy,clock,nonceSource:ids,faults:{inject(point){
 if(point==="recovery-before-final-verify"&&["delay-committed","delay-absent","detach-expired"].includes(config.scenario))localClock(new Date(Date.parse(lastExpiry)+(config.scenario==="detach-expired"?0:-1)).toISOString());
 if(point==="recovery-before-final-verify"&&config.scenario==="admission-denied"){
  const row=connection!.prepare("SELECT release_id FROM fresh_start_control_state").get()!;
  Atomics.add(observation,OBS.admissionFault,1);
  new FreshStartAdmissionGuard(connection!).assertRequestAllowed({identity:{projectId:context.binding.projectId,vaultId:context.binding.vaultId,storeId:context.binding.storeId},releaseId:String(row.release_id),measuredBuildHash:"0".repeat(64),generation:1n,operation:"command-recovery"});
 }
 if(point==="recovery-after-detach"){Atomics.store(observation,OBS.detach,1);Atomics.store(times,1,clock.nowMs());if(!recovery||Atomics.load(observation,OBS.transaction)!==1)throw new Error("G10_DETACH_OUTSIDE_TRANSACTION");if(config.scenario.startsWith("delay-"))localClock(new Date(Date.parse(lastExpiry)+1).toISOString());}
 if(point==="recovery-before-commit")readCommitExpected=true;
}}});
const retainedFactory=new RetainedEvidenceRuntimeFactory({provider:providers.evidence,policy:()=>providers.state.policy,clock,nonceSource:ids});
function storedHandle(row:SessionAuthorityRecord):StoredCapabilityMaterialV1{
 const root=row.sessionKind==="root",generation=root?row.ownerGeneration:row.childCapabilityGeneration;
 const prefix=root?"rootHandle":"childHandle";
 const value=(suffix:string)=>(row as unknown as Record<string,unknown>)[prefix+suffix];
 if(!generation)throw new Error("G10_CURRENT_MATERIAL_UNAVAILABLE");
 return {claims:{capabilityVersion:1,keyId:value("KeyId"),projectId:row.projectId,vaultId:context.binding.vaultId,storeId:context.binding.storeId,workspaceId:row.workspaceId,clientNamespace:row.clientNamespace,sessionId:row.sessionId,kind:root?"root-session-handle":"child-session-handle",capabilityGeneration:generation.toString(),issuedAt:value("IssuedAt"),policyCode:value("PolicyCode"),expiryKind:value("ExpiryKind"),expiresAt:value("ExpiresAt"),issueNonce:value("IssueNonce"),actorRole:value("ActorRole"),clientInstanceId:value("ClientInstanceId")},verifier:value("Verifier")} as StoredCapabilityMaterialV1;
}
const fixtureFactory:TrustedGovernedFixtureFactoryV1={create(input){
 observeConnection(input);providers.publishProviderStatus();const {connection,lifecycleRuntime,retainedEvidenceRuntime}=input;
 const originalClose=connection.close.bind(connection);connection.close=()=>{originalClose();Atomics.store(observation,OBS.writers,0);};
 const originalExec=connection.exec.bind(connection);
 connection.exec=(sql:string)=>{if(sql==="COMMIT"&&readCommitExpected&&config.scenario==="read-commit-failure"){readCommitExpected=false;Atomics.add(observation,OBS.failedReadCommit,1);throw new Error("fixture_exception_marker");}const result=originalExec(sql);if(sql==="BEGIN DEFERRED")Atomics.store(observation,OBS.transaction,1);if(sql==="COMMIT"||sql==="ROLLBACK"){if(sql==="COMMIT"&&readCommitExpected){Atomics.store(observation,OBS.commit,1);readCommitExpected=false;}Atomics.store(observation,OBS.transaction,0);}return result;};
 const repository=new SessionAuthorityRepository(),capabilities=new CapabilityService({keyProvider:input.keyProvider,clock,nonceSource:ids});
 const audience=(c:ProjectContext)=>({actorRole:c.binding.actorRole as "primary"|"untrusted",clientInstanceId:c.binding.clientInstanceId});
 function material(sessionId:string,c:ProjectContext){const row=repository.get(connection,c.binding.projectId,sessionId);if(!row)throw new GovernedNoteError("SESSION_CAPABILITY_INVALID");const stored=storedHandle(row),generation=stored.claims.capabilityGeneration;const resolution=capabilities.authorityMaterial({authorityCommitment:row.authorityCommitment,expectedCapabilityGeneration:generation,currentCapabilityGeneration:generation,target:audience(c),materials:[stored]});if(!resolution.descriptor)throw new GovernedNoteError("SESSION_CAPABILITY_INVALID");return {row,generation,value:capabilities.reconstructForTarget(resolution.descriptor,audience(c))};}
 function scope(sessionId:string,c:ProjectContext,generation:string){const b=c.binding;return {projectId:b.projectId,vaultId:b.vaultId,storeId:b.storeId,workspaceId:b.workspaceId,clientNamespace:b.clientNamespace,authoritySessionId:sessionId,targetSessionId:sessionId,presentingActorRole:b.actorRole as "primary"|"untrusted",targetActorRole:b.actorRole as "primary"|"untrusted",presentingClientInstanceId:b.clientInstanceId,targetClientInstanceId:b.clientInstanceId,capabilityKind:c.binding.actorRole==="primary"?"root-session-handle" as const:"child-session-handle" as const,capabilityGeneration:generation};}
 function proof(sessionId:string,c:ProjectContext,build:(s:ReturnType<typeof scope>)=>Parameters<typeof createCapabilityProof>[1]){const m=material(sessionId,c);try{m.value.handle.withValue(value=>{if(tokenMarkers.size<256)tokenMarkers.add(value);});Atomics.add(observation,OBS.proofMints,1);return createCapabilityProof(m.value.handle,build(scope(sessionId,c,m.generation)));}finally{m.value.handle.destroy();if(m.value.kind==="root")m.value.resumeToken?.destroy();}}
 const protectedAuth=(sessionId:string,p:ReturnType<typeof createCapabilityProof>)=>({kind:"protected" as const,authoritySessionId:sessionId as never,targetSessionId:sessionId as never,proof:p,approval:null,childBindingGrant:null});
 async function bootstrap(rootSessionId:string,childSessionId:string){
  if(bootstrapped)throw new GovernedNoteError("GOVERNED_NOTE_UNAVAILABLE");bootstrapped=true;
  const b=rootContext.binding,common={projectId:b.projectId,vaultId:b.vaultId,storeId:b.storeId,workspaceId:b.workspaceId,clientNamespace:b.clientNamespace,presentingActorRole:"primary" as const,presentingClientInstanceId:b.clientInstanceId,targetActorRole:"primary" as const,targetClientInstanceId:b.clientInstanceId,internalWorkflowId:null,internalWorkflowGeneration:null,internalPlannedWorkId:null};
  const command=decodeLifecycleSemanticCommandDraft({commandType:"root-start",commandId:randomUUID(),idempotencyKey:randomUUID(),agentId:"fixture-agent",expectedProjectId:b.projectId,expectedVaultId:b.vaultId,expectedWorkspaceId:b.workspaceId,expectedBranchRef:null,continuityKey:`g10/${rootSessionId}`,resumePolicy:"new"});
  const witness=buildLifecycleIntentWitness(command,{...common,authorizationKind:"initial-authority",authorizationSessionId:null,targetSessionId:command.commandId,capabilityKind:null,capabilityGeneration:null});
  nextSessionId=rootSessionId;
  const started=await lifecycleRuntime.execute(decodeLifecycleWorkerOperationWire({kind:"semantic",operation:"root-start",prepared:{command,candidateIntentHash:witness.intentHash,authorization:{kind:"initial-authority",authoritySessionId:null,targetSessionId:null,proof:null,approval:null,childBindingGrant:null}}}),rootContext);
  if((started.result as unknown as {publicResult?:{sessionId:string}}).publicResult?.sessionId!==rootSessionId)throw new GovernedNoteError("GOVERNED_NOTE_UNAVAILABLE");
  const row=repository.get(connection,b.projectId,rootSessionId)!,version=connection.prepare("SELECT current_version FROM streams WHERE stream_id=$id").get({$id:`session/${rootSessionId}`})!.current_version;
  const childCommand=decodeLifecycleSemanticCommandDraft({commandType:"fork-child",commandId:randomUUID(),idempotencyKey:randomUUID(),agentId:"fixture-agent",expectedProjectId:b.projectId,expectedVaultId:b.vaultId,expectedWorkspaceId:b.workspaceId,expectedBranchRef:null,parentSessionId:rootSessionId,expectedStreamVersion:String(version),assignment:{assignmentId:randomUUID(),summary:"Owned synthetic child",scope:"governed-fixture"},directAccessRequested:true});
  const childWitness=buildLifecycleIntentWitness(childCommand,{...common,targetActorRole:"untrusted",targetClientInstanceId:childContext.binding.clientInstanceId,authorizationKind:"protected",authorizationSessionId:rootSessionId,targetSessionId:rootSessionId,capabilityKind:"root-session-handle",capabilityGeneration:row.ownerGeneration!.toString()});
  const claims={grantVersion:1 as const,grantId:randomUUID(),projectId:b.projectId,storeId:b.storeId,parentSessionId:rootSessionId,targetActorRole:"untrusted" as const,targetClientInstanceId:childContext.binding.clientInstanceId,issuedAt:clock.now(),expiresAt:new Date(Number(clock.nowMs()+60000n)).toISOString(),bindingFingerprint:childContext.binding.contextFingerprint};
  const bytes=Buffer.from(canonicalJson(claims));let mac:Uint8Array|undefined;
  try{
   const keyId=input.keyProvider.currentKey({projectId:b.projectId,storeId:b.storeId},"child-binding-grant").keyId;mac=input.keyProvider.mac({projectId:b.projectId,storeId:b.storeId,purpose:"child-binding-grant",keyId,domain:CHILD_BINDING_GRANT_DOMAIN,bytes});
   const p=proof(rootSessionId,rootContext,s=>({...s,targetActorRole:"untrusted",targetClientInstanceId:childContext.binding.clientInstanceId,proofVersion:1,target:"semantic-command",commandId:childCommand.commandId,idempotencyKey:childCommand.idempotencyKey,intentHash:childWitness.intentHash,proofNonce:randomUUID()}));
   nextSessionId=childSessionId;
   const child=await lifecycleRuntime.execute(decodeLifecycleWorkerOperationWire({kind:"semantic",operation:"fork-child",prepared:{command:childCommand,candidateIntentHash:childWitness.intentHash,authorization:{...protectedAuth(rootSessionId,p),childBindingGrant:{...claims,mac:Buffer.from(mac).toString("base64url")}}}}),rootContext);
   if((child.result as unknown as {publicResult?:{childSessionId:string}}).publicResult?.childSessionId!==childSessionId)throw new GovernedNoteError("GOVERNED_NOTE_UNAVAILABLE");
  }finally{bytes.fill(0);mac?.fill(0);nextSessionId=undefined;}
  for(const [index,sessionId,c]of [[0,rootSessionId,rootContext],[1,childSessionId,childContext]] as const){
   const decoded=decodeRetainEvidenceBatch({version:1,commandType:"retain-evidence-batch",commandId:randomUUID(),idempotencyKey:randomUUID(),targetSessionId:sessionId,conversationId:randomUUID(),frames:[{frameId:randomUUID(),ordinal:"0",role:"user",category:"user-message",occurredAt:clock.now(),mediaType:"text/plain; charset=utf-8",content:"Retained fixture_secret original",previousFrameId:null,toolCorrelationId:null,artifactHashes:[]}]});
   try{const p=proof(sessionId,c,s=>retainedEvidenceProofTarget(decoded,s,randomUUID()));const result=retainedEvidenceRuntime.execute({command:decoded.command,authorization:protectedAuth(sessionId,p)},c);writeSafeId(config.observation,index,result.response.evidenceIds[0]!);writeSafeId(config.observation,index+2,result.eventIds[0]!);Atomics.add(observation,OBS.sourceCount,1);}finally{decoded.canonicalOriginalBytes.fill(0);}
  }
  return {kind:"bootstrap" as const,rootSessionId,childSessionId};
 }
 return {async execute(action:GovernedFixtureActionV1){Atomics.add(observation,OBS.actionPosts,1);
  switch(action.kind){
   case "bootstrap":return bootstrap(action.rootSessionId,action.childSessionId);
   case "retain":return {kind:"retain",receipt:retainedEvidenceRuntime.execute(action.prepared,context).response};
   case "prepare-create":{const p=proof(action.authoritySessionId,context,s=>governedNoteCreateProofTarget(action.command,s,deriveGovernedNoteBinding(connection,context,action.authoritySessionId),randomUUID()));return {kind:"prepare-create",prepared:{command:action.command,authorization:protectedAuth(action.authoritySessionId,p)}};}
   case "prepare-recovery":{const request=decodeGovernedNoteRecoveryV1({version:1,operation:"recover-governed-note-result",operationId:action.operationId,requestId:action.requestId,commandId:action.commandId,idempotencyKey:action.idempotencyKey,expiresAt:new Date(Number(clock.nowMs()+60000n)).toISOString()});lastExpiry=request.expiresAt;Atomics.store(times,0,BigInt(Date.parse(lastExpiry)));const p=proof(action.authoritySessionId,context,s=>governedNoteRecoveryProofTarget(request,context,deriveGovernedNoteBinding(connection,context,action.authoritySessionId),s.capabilityGeneration,randomUUID()));const b=context.binding;return {kind:"prepare-recovery",prepared:{request,authorization:{kind:"bounded-operation",authoritySessionId:action.authoritySessionId as never,targetSessionId:action.authoritySessionId as never,proof:p,audience:{presentingActorRole:b.actorRole,targetActorRole:b.actorRole,presentingClientInstanceId:b.clientInstanceId,targetClientInstanceId:b.clientInstanceId}}}};}
   case "change-authority":{const result=await lifecycleRuntime.execute(action.operation,context);if((result.result as unknown as {kind?:string;publicResult?:{operation:string}}).kind!=="success"||(result.result as unknown as {publicResult?:{operation:string}}).publicResult?.operation!==action.operation.operation)throw new GovernedNoteError("GOVERNED_NOTE_UNAVAILABLE");return {kind:"applied",applied:true};}
   case "set-fixture-controls":providers.control(action.controls);return {kind:"applied",applied:true};
  }
 },dispose(){providers.dispose();tokenMarkers.clear();}};
}};
const backend=new ProjectStoreWorkerBackend({selfUrl:new URL(import.meta.url),executorLeaseMs:data.executorLeaseMs,appendRetryDeadlineMs:data.appendRetryDeadlineMs,keyProvider:providers.capability,trustedFreshStartBuildInspector:()=>config.buildHash,
 lifecycleRuntimeFactory:{create(input){observeConnection(input);const lifecycle=lifecycleFactory.create(input);return {execute:(operation,c)=>lifecycle.execute(operation,c),dispose(){try{lifecycle.dispose();}finally{providers.dispose();}}};}},retainedEvidenceRuntimeFactory:{create(input){observeConnection(input);return retainedFactory.create(input);}},
 governedNoteRuntimeFactory:{create(input){observeConnection(input);const runtime=governedFactory.create(input);return {create(p,c){Atomics.add(observation,OBS.createPosts,1);try{const result=runtime.create(p,c);scanDurable();return result;}catch(error){scanDurable();throw error;}},recover(p,c){Atomics.add(observation,OBS.recoveryPosts,1);recovery=true;try{return runtime.recover(p,c);}finally{recovery=false;}}};}},trustedGovernedFixtureFactory:config.scenario==="missing-factory"?undefined:fixtureFactory});
const runtime=new ProjectStoreWorkerRuntime({backend,trustedGovernedFixtureActions:{execute:(binding,action)=>backend.executeTrustedGovernedFixtureAction(binding,action)},heartbeatIntervalMs:data.heartbeatIntervalMs,
 scheduler:{setInterval:(callback,ms)=>setInterval(callback,ms),clearInterval:handle=>clearInterval(handle as NodeJS.Timeout)},port:{postMessage(value){
  scanPublic(value,OBS.safeOutputLeaks);scanPublic(Array.from(observation.slice(0,33)),OBS.metricLeaks);
  const r=value as {ok?:boolean;data?:{operation?:string;closed?:boolean}};
  if(r.ok&&r.data?.operation==="recover-governed-note-result"&&config.scenario.startsWith("delay-")&&Atomics.load(observation,OBS.commit)===1){setTimeout(()=>{Atomics.store(times,2,clock.nowMs());Atomics.store(observation,OBS.delivery,1);parentPort!.postMessage(value);},500);return;}
  parentPort!.postMessage(value);
 },close(){Atomics.store(observation,OBS.closed,1);config.port.close();parentPort!.close();}}});
config.port.on("message",async(value:unknown)=>{
 let request:ReturnType<typeof decodeGovernedFixtureRequestV1>|undefined,executed=false;
 try{request=decodeGovernedFixtureRequestV1(value,{runId:state.runId,storeId:context.binding.storeId,ownerGeneration:config.ownerGeneration,binding:encodeWorkerBindingAssertion(context)});const result=await runtime.enqueueTrustedGovernedFixtureAction(request.binding,request.action);executed=true;const reply=decodeGovernedFixtureReplyV1({version:1,requestId:request.requestId,ok:true,result},request);
 if(request.action.kind==="set-fixture-controls"){
  if(config.scenario==="action-outcome-unknown")throw Object.assign(new Error("fixture_exception_marker"),{code:"OPERATION_OUTCOME_UNKNOWN"});
  if(config.scenario==="timeout-control")return;
  if(config.scenario==="malformed-control"){config.port.postMessage({...reply,requestId:randomUUID()});return;}
  if(config.scenario==="delay-control"){setTimeout(()=>config.port.postMessage(reply),500);return;}
 }config.port.postMessage(reply);}
 catch(error){
  // An executed action without a validated ACK has no nonexecution certificate.
  // Closing this private port produces the controller's local transport-loss certificate.
  if(!request||executed||!(error instanceof GovernedNoteError)||["COMMAND_OUTCOME_UNKNOWN","GOVERNED_NOTE_OWNERSHIP_UNCERTAIN","WORKER_PROTOCOL_ERROR","WORKER_UNAVAILABLE"].includes(error.code)){config.port.close();return;}
  config.port.postMessage({version:1,requestId:request.requestId,ok:false,error:{code:"GOVERNED_NOTE_UNAVAILABLE",message:"GOVERNED_NOTE_UNAVAILABLE",details:{}}});
 }
});
parentPort.on("message",value=>runtime.receive(value));
