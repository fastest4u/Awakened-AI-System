import { randomUUID,randomBytes,createHash } from "node:crypto";
import { closeSync,cpSync,existsSync,fstatSync,lstatSync,mkdirSync,mkdtempSync,openSync,readFileSync,realpathSync,renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,dirname,parse,resolve,sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Worker,MessageChannel } from "node:worker_threads";
import { FreshStartInitializer } from "../../src/orchestrator/fresh-start/fresh-start-initializer.js";
import type { FreshStartRelease } from "../../src/orchestrator/fresh-start/contracts.js";
import { ProjectBindingService } from "../../src/orchestrator/identity/project-binding.service.js";
import { WorkerProjectStoreIdentityProbe } from "../../src/orchestrator/runtime/project-store-identity-probe.js";
import { ProjectStoreExecutor } from "../../src/orchestrator/runtime/project-store-executor.js";
import { NodeSqliteDriver } from "../../src/orchestrator/storage/node-sqlite-driver.js";
import { expectedSchemaFingerprint } from "../../src/orchestrator/storage/schema-fingerprint.js";
import { PROJECT_STORE_MIGRATIONS } from "../../src/orchestrator/storage/migrations/registry.js";
import { createGovernedNoteRunV1,executeGovernedFixtureActionV1 } from "../../src/orchestrator/governed-notes/run.js";
import { allocateFreshGovernedNoteFixtureV1 } from "../../src/orchestrator/governed-notes/fixture-allocation.js";
import { decodeGovernedFixtureRequestV1,decodeGovernedFixtureReplyV1,governedFixtureTransportUncertain,CAPABILITY_PURPOSES,EVIDENCE_PURPOSES,type GovernedFixtureControlsV1 } from "../../src/orchestrator/governed-notes/fixture-control.js";
import { GovernedNoteError } from "../../src/orchestrator/governed-notes/errors.js";
import { encodeWorkerBinding,encodeWorkerBindingAssertion } from "../../src/orchestrator/runtime/worker-protocol.js";
import type { GovernedNoteRunV1,FreshGovernedNoteFixtureV1,GovernedNoteOwnerPermitV1,GovernedNoteCommandV1,GovernedNoteRecoveryIdsV1,PreparedGovernedNoteCreateV1,PreparedGovernedNoteRecoveryV1,GovernedNoteReceiptV1,TrustedGovernedNoteTimingV1 } from "../../src/orchestrator/governed-notes/contracts.js";
import type { VerifiedReadBinding } from "../../src/orchestrator/verified-read/contracts.js";
import { ImmutableProjectionBuilder } from "../../src/orchestrator/projections/builder.js";
import { openCommittedProjectionEventSnapshot } from "../../src/orchestrator/projections/event-reader.js";
import { publishProjectionManifest,PROJECTION_MANIFEST_FILENAME } from "../../src/orchestrator/projections/manifest.js";
import { activateFreshTestStore,freshRelease } from "./fresh-start-fixture.js";
import { decodeProvisioning,applyProvisioningControl,OBS,OBSERVATION_BYTES,observationView,readSafeId,type SyntheticGovernedNoteProvisioningV1 } from "./governed-note-local-providers.js";
export const G10_TIMING:TrustedGovernedNoteTimingV1=Object.freeze({requestTimeoutMs:15000,closeTimeoutMs:5000,recoveryProofLifetimeMs:60000,maxPending:128,executorLeaseMs:15000,heartbeatIntervalMs:5000,appendRetryDeadlineMs:15000,sqliteBusyTimeoutMs:5000});

// Governed tests only. No successful check, worker, or identity proof is cached.
// Focused callers require a matching source/emitted freeze; the real gate builds
// and binds source, artifacts and compiled inputs independently of this selector.
export function governedIdentityWorkerUrl(directory=join(process.cwd(),"dist")):URL {
 const unavailable=()=>new Error("GOVERNED_IDENTITY_WORKER_UNAVAILABLE");
 const sha=(bytes:Uint8Array|string)=>createHash("sha256").update(bytes).digest("hex");
 const canonical=(value:any):string=>Array.isArray(value)?`[${value.map(canonical).join(",")}]`:value&&typeof value==="object"?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`:JSON.stringify(value);
 const samePath=(a:string,b:string)=>process.platform==="win32"?a.toLowerCase()===b.toLowerCase():a===b;
 function ordinary(path:string,directory:boolean){
  const absolute=resolve(path),root=parse(absolute).root;let current=root;
  const parts=absolute.slice(root.length).split(sep).filter(Boolean);
  for(let i=0;i<parts.length;i++){
   current=join(current,parts[i]!);const stat=lstatSync(current,{bigint:true}),isDirectory=i<parts.length-1||directory;
   if(stat.isSymbolicLink()||(isDirectory?!stat.isDirectory():!stat.isFile()||stat.nlink!==1n)||!samePath(realpathSync.native(current),current))throw unavailable();
  }
  return lstatSync(absolute,{bigint:true});
 }
 function bytes(path:string){
  const before=ordinary(path,false),fd=openSync(path,"r");
  try{
   const opened=fstatSync(fd,{bigint:true});if(opened.dev!==before.dev||opened.ino!==before.ino||opened.nlink!==1n)throw unavailable();
   const value=readFileSync(fd),after=ordinary(path,false),final=fstatSync(fd,{bigint:true});
   for(const current of [after,final])if(current.dev!==before.dev||current.ino!==before.ino||current.size!==before.size||current.mtimeNs!==before.mtimeNs||current.nlink!==1n)throw unavailable();
   return value;
  }finally{closeSync(fd);}
 }
 try{
  const root=resolve(directory);ordinary(root,true);
  const manifestPath=join(root,"v2-build.json"),raw=bytes(manifestPath);if(raw.length>1024*1024)throw unavailable();
  const build=JSON.parse(raw.toString("utf8")),{buildIdentityHash,...body}=build;
  const runtime={nodeVersion:process.versions.node,platform:process.platform,arch:process.arch,executableSha256:sha(bytes(process.execPath))};
  const paths=["v2.js","v2-admin.js","workers/project-store.worker.js","internal/v2-internal-verified-read.js","internal/v2-internal-verified-read-cleanup.js"];
  if(build.schemaVersion!==1||typeof build.deploymentId!=="string"||!build.deploymentId||buildIdentityHash!==sha(canonical(body))||canonical(build.runtime)!==canonical(runtime)||!Array.isArray(build.artifacts)||canonical(build.artifacts.map((entry:any)=>entry.path))!==canonical(paths))throw unavailable();
  for(const entry of build.artifacts){const actual=bytes(join(root,entry.path));if(entry.bytes!==actual.length||entry.sha256!==sha(actual))throw unavailable();}
  if(!bytes(manifestPath).equals(raw))throw unavailable();
  return pathToFileURL(join(root,"workers/project-store.worker.js"));
 }catch{throw unavailable();}
}

export interface GovernedNoteNativeFixtureV1 {
 run:GovernedNoteRunV1;fixture:FreshGovernedNoteFixtureV1;permit:GovernedNoteOwnerPermitV1;sourceId:string;rootSessionId:string;childSessionId:string;
 prepareCreate(command:GovernedNoteCommandV1):Promise<PreparedGovernedNoteCreateV1>;
 prepareRecovery(ids:GovernedNoteRecoveryIdsV1):Promise<PreparedGovernedNoteRecoveryV1>;
 verifiedReadBinding(receipt:GovernedNoteReceiptV1):Promise<VerifiedReadBinding>;
 controls(control:GovernedFixtureControlsV1):Promise<void>;
 observations():Readonly<{ownerReusable:boolean;workerExits:number;workerExitCode:number|null;cleanupDisposition:string|null;recoveryPosts:number;transactionOpen:number;readRollbacks:bigint;failedReadRollbacks:bigint;closedWithReadTransaction:bigint;queuedRecoveries:bigint;queuedDispatches:bigint;queuedReplies:bigint;openWriterConnectionCount:number;parentProviderRpcCalls:number;factoryConnectionIdentityCount:number;factoryFenceIdentityCount:number;factoryKeyProviderIdentityCount:number;admissionFault:number;failedReadCommit:number;safeOutputLeaks:number;metricLeaks:number;logLeaks:number;logBytes:number;providerThreadId:number;ownerWorkerThreadId:number;disposed:number;ownerGeneration:bigint;detach:number;commit:number;delivery:number;expiresAt:bigint;detachTime:bigint;deliveryTime:bigint;createPosts:number;actionPosts:number;proofMints:number;unwrap:number;originalMac:number;pairs:number;pairHeaderFailures:number;privacyLeaks:number;statuses:readonly number[]}>;
 cleanup():Promise<void>;
}
export async function makeGovernedNoteFixture(options:Readonly<{child?:boolean;scenario?:string}>={}):Promise<GovernedNoteNativeFixtureV1>{
 const parentDirectory=realpathSync.native(mkdtempSync(join(tmpdir(),"g10-owned-"))),driver=new NodeSqliteDriver({DatabaseSync});
 const rootSessionId=randomUUID(),childSessionId=randomUUID(),sessionId=options.child?childSessionId:rootSessionId;
 const manifest=JSON.parse(readFileSync(join(process.cwd(),"dist/v2-build.json"),"utf8")) as {buildIdentityHash:string};
 let release:FreshStartRelease|undefined,freshDirectory="",initializationHandlesClosed=false,provisioning:SyntheticGovernedNoteProvisioningV1|undefined,bootstrapConsumed=false;
 let observation:SharedArrayBuffer|undefined,generation="",closed=false,readGeneration=0;
 let ownerReusable=()=>false,workerExits=0,workerExitCode:number|null=null,cleanupDisposition:string|null=null;
 let cleanupOwner:(()=>ReturnType<ProjectStoreExecutor["closeForGovernedNoteController"]>)|undefined;
 const logs:string[]=[];let logBytes=0;
 const run=createGovernedNoteRunV1({timing:G10_TIMING,freshInitializer:{async initialize(input){
  freshDirectory=input.freshDirectory;const v2VaultRoot=join(freshDirectory,"vault"),v1ArchiveRoot=join(freshDirectory,"archive");mkdirSync(v2VaultRoot);mkdirSync(v1ArchiveRoot);
  const {projectId:_p,vaultId:_v,storeId:_s,...requested}=freshRelease({releaseId:randomUUID(),buildIdentityHash:manifest.buildIdentityHash,schemaIdentityHash:expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS)});
  const genesis=await new FreshStartInitializer({inspectBuild:()=>manifest.buildIdentityHash,actorFingerprint:"c".repeat(64)}).initializeFresh({projectRoot:freshDirectory,v2VaultRoot,v1ArchiveRoot,initializationId:randomUUID(),release:requested});
   const service=new ProjectBindingService({identityProbe:new WorkerProjectStoreIdentityProbe({workerUrl:governedIdentityWorkerUrl(),requestTimeoutMs:5000})});
  const established=await service.establish({source:"explicit-cli",projectRoot:freshDirectory,vaultRoot:v2VaultRoot,clientNamespace:"g10",clientInstanceId:options.child?"g10-child":"g10-root",actorRole:options.child?"untrusted":"primary",generation:1});
  if(!established.ok)throw new Error("G10_BINDING_REFUSED");const context=await service.revalidate(established.binding);
  const activation=driver.open(context.binding.storeRoute.eventsPath,{mode:"existing",busyTimeoutMs:5000});
  try{const active=await activateFreshTestStore(activation,{projectId:genesis.projectId,vaultId:genesis.vaultId,storeId:genesis.storeId},{alreadyInitialized:true});release=active.release;return {context,freshStartContext:active.trusted};}
  finally{activation.close();initializationHandlesClosed=true;}
 }},ownerFactory(construction){
  if(!initializationHandlesClosed)throw new Error("G10_INITIALIZER_HANDLES_OPEN");
  provisioning??=decodeProvisioning({version:1,runId:construction.runId,fixtureId:construction.fixtureId,seed:randomBytes(32).toString("base64url"),capabilityKeys:CAPABILITY_PURPOSES.map(purpose=>({purpose,keyId:`g10/${purpose}/1`,current:true,status:"available"})),evidenceKeys:EVIDENCE_PURPOSES.map(purpose=>({purpose,ref:{keyId:`g10/${purpose}`,version:"1"},current:true,status:"available"})),policy:{policyId:"g10-policy",policyVersion:"1",rules:[{kind:"token",ruleId:"fixture-token",prefix:"fixture_"}]},clockNow:"2026-10-09T00:00:00.000Z"});
  if(provisioning.runId!==construction.runId||provisioning.fixtureId!==construction.fixtureId)throw new Error("G10_PROVISIONING_BINDING");
  const channel=new MessageChannel(),buffer=new SharedArrayBuffer(OBSERVATION_BYTES);observation=buffer;generation=construction.ownerGeneration;
  const expected={runId:construction.runId,storeId:construction.context.binding.storeId,ownerGeneration:generation,binding:encodeWorkerBindingAssertion(construction.context)};
  let pending:{request:ReturnType<typeof decodeGovernedFixtureRequestV1>;resolve:(value:ReturnType<typeof decodeGovernedFixtureReplyV1>)=>void;reject:(error:unknown)=>void;timer:NodeJS.Timeout}|undefined,portDisposed=false;
  function fail(){if(pending){clearTimeout(pending.timer);const rejected=pending;pending=undefined;rejected.reject(governedFixtureTransportUncertain());}}
  channel.port1.on("message",value=>{if(!pending)return;const active=pending;try{const reply=decodeGovernedFixtureReplyV1(value,active.request);clearTimeout(active.timer);pending=undefined;active.resolve(reply);}catch{fail();}});
  channel.port1.on("messageerror",fail);channel.port1.on("close",()=>{if(!portDisposed)fail();});
  const fixtureActions={async execute(action:Parameters<typeof executeGovernedFixtureActionV1>[2]){
    if(portDisposed||pending)throw governedFixtureTransportUncertain();
    const request=decodeGovernedFixtureRequestV1({version:1,requestId:randomUUID(),...expected,action},expected);
    const reply=await new Promise<ReturnType<typeof decodeGovernedFixtureReplyV1>>((resolve,reject)=>{const timer=setTimeout(()=>fail(),15000);pending={request,resolve,reject,timer};try{channel.port1.postMessage(request);}catch{fail();}});
    if(!reply.ok)throw new GovernedNoteError(reply.error.code,reply.error.details as GovernedNoteRecoveryIdsV1);
    if(action.kind==="set-fixture-controls")provisioning=applyProvisioningControl(provisioning!,action.controls);
    if(action.kind==="bootstrap")bootstrapConsumed=true;
    return reply.result;
   },dispose(){if(portDisposed)return;portDisposed=true;fail();channel.port1.close();}};
  const executor=new ProjectStoreExecutor({workerUrl:new URL("../fixtures/project-store-governed-note-worker.js",import.meta.url),context:construction.context,freshStart:construction.freshStartContext,...construction.timing},{workerFactory:(url,workerOptions)=>{const worker=new Worker(url,{stdout:true,stderr:true,workerData:{...workerOptions.workerData,g10:{context:encodeWorkerBinding(construction.context),provisioning,ownerGeneration:generation,port:channel.port2,observation:buffer,buildHash:manifest.buildIdentityHash,scenario:options.scenario??"normal",bootstrapConsumed}},transferList:[channel.port2]});
   worker.on("exit",code=>{workerExits++;workerExitCode=code;});
   const capture=(chunk:Buffer)=>{logBytes+=chunk.byteLength;if(logBytes<=65536)logs.push(chunk.toString());};worker.stdout?.on("data",capture);worker.stderr?.on("data",capture);return worker;}});
  ownerReusable=()=>executor.canReuse();
  cleanupOwner=async()=>{try{const result=await executor.closeForGovernedNoteController();cleanupDisposition=result.disposition;return result;}finally{fixtureActions.dispose();}};
  closed=false;
  return {async open(){await executor.open();},createGovernedNote:p=>executor.createGovernedNote(p),recoverGovernedNoteResult:p=>executor.recoverGovernedNoteResult(p),canReuse:()=>executor.canReuse(),fixtureActions,
   async closeForGovernedNoteController(){try{const result=await executor.closeForGovernedNoteController();closed=result.disposition==="graceful-confirmed";return result;}finally{fixtureActions.dispose();}}};
 }});
 const fixture=await allocateFreshGovernedNoteFixtureV1(run,{parentDirectory});let permit=await run.open(fixture);
 try{
  await executeGovernedFixtureActionV1(run,permit,{kind:"bootstrap",rootSessionId,childSessionId});
  const sourceId=readSafeId(observation!,options.child?1:0);
  const result:GovernedNoteNativeFixtureV1={run,fixture,get permit(){return permit;},set permit(value){permit=value;},sourceId,rootSessionId,childSessionId,
   async prepareCreate(command){const result=await executeGovernedFixtureActionV1(run,permit,{kind:"prepare-create",authoritySessionId:sessionId,command});if(result.kind!=="prepare-create")throw new Error("G10_PREPARED_KIND");return result.prepared;},
   async prepareRecovery(ids){const result=await executeGovernedFixtureActionV1(run,permit,{kind:"prepare-recovery",authoritySessionId:sessionId,operationId:randomUUID(),requestId:randomUUID(),commandId:ids.commandId,idempotencyKey:ids.idempotencyKey});if(result.kind!=="prepare-recovery")throw new Error("G10_PREPARED_KIND");return result.prepared;},
   async controls(controls){await executeGovernedFixtureActionV1(run,permit,{kind:"set-fixture-controls",controls});},
   observations(){const o=observationView(observation!);if(Atomics.load(o,OBS.version)!==1||Atomics.load(new BigInt64Array(observation!,6144,16),3).toString()!==generation)throw new Error("G10_OBSERVATION_IDENTITY");const times=new BigInt64Array(observation!,6144,16),capabilityCount=Atomics.load(o,OBS.capabilityEntries),evidenceCount=Atomics.load(o,OBS.evidenceEntries);
    if(capabilityCount<0||evidenceCount<0||capabilityCount+evidenceCount>256)throw new Error("G10_OBSERVATION_BOUNDS");
    const statuses=[...Array.from({length:capabilityCount*2},(_,i)=>Atomics.load(o,OBS.capabilityStatusBase+i)),...Array.from({length:evidenceCount*2},(_,i)=>Atomics.load(o,OBS.evidenceStatusBase+i))];
    if(statuses.some((value,index)=>index%2===0?value<1||value>3:value!==0&&value!==1))throw new Error("G10_OBSERVATION_STATUS");
    return Object.freeze({ownerReusable:ownerReusable(),workerExits,workerExitCode,cleanupDisposition,recoveryPosts:Atomics.load(o,OBS.recoveryPosts),transactionOpen:Atomics.load(o,OBS.transaction),readRollbacks:Atomics.load(times,4),failedReadRollbacks:Atomics.load(times,5),closedWithReadTransaction:Atomics.load(times,6),queuedRecoveries:Atomics.load(times,7),queuedDispatches:Atomics.load(times,8),queuedReplies:Atomics.load(times,9),openWriterConnectionCount:Atomics.load(o,OBS.writers),parentProviderRpcCalls:0,factoryConnectionIdentityCount:Atomics.load(o,OBS.connections),factoryFenceIdentityCount:Atomics.load(o,OBS.fences),factoryKeyProviderIdentityCount:Atomics.load(o,OBS.keyProviders),admissionFault:Atomics.load(o,OBS.admissionFault),failedReadCommit:Atomics.load(o,OBS.failedReadCommit),safeOutputLeaks:Atomics.load(o,OBS.safeOutputLeaks),metricLeaks:Atomics.load(o,OBS.metricLeaks),logBytes,logLeaks:logBytes>65536||["fixture_secret","fixture_exception_marker",provisioning!.seed].some(marker=>logs.join("").includes(marker))?1:0,providerThreadId:Atomics.load(o,OBS.providerThread),ownerWorkerThreadId:Atomics.load(o,OBS.thread),disposed:Atomics.load(o,OBS.disposed),ownerGeneration:Atomics.load(times,3),detach:Atomics.load(o,OBS.detach),commit:Atomics.load(o,OBS.commit),delivery:Atomics.load(o,OBS.delivery),expiresAt:Atomics.load(times,0),detachTime:Atomics.load(times,1),deliveryTime:Atomics.load(times,2),createPosts:Atomics.load(o,OBS.createPosts),actionPosts:Atomics.load(o,OBS.actionPosts),proofMints:Atomics.load(o,OBS.proofMints),unwrap:Atomics.load(o,OBS.unwrap),originalMac:Atomics.load(o,OBS.originalMac),pairs:Atomics.load(o,OBS.pairs),pairHeaderFailures:Atomics.load(o,OBS.pairHeaderFailures),privacyLeaks:Atomics.load(o,OBS.privacyLeaks),statuses:Object.freeze(statuses)});},
   async verifiedReadBinding(receipt){
    if(!release)throw new Error("G10_RELEASE_MISSING");
    const directory=(name:string)=>{const path=join(freshDirectory,name);try{mkdirSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}const canonicalPath=realpathSync.native(path),stat=lstatSync(canonicalPath,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error("G10_DIRECTORY_INVALID");return {canonicalPath,device:String(stat.dev),inode:String(stat.ino)};};
    const projectionDirectory=directory("read-projection"),executorStateDirectory=directory("read-state"),deployment=directory("read-deployment");
    for(const artifact of ["v2.js","v2-admin.js","workers/project-store.worker.js","internal/v2-internal-verified-read.js","internal/v2-internal-verified-read-cleanup.js","v2-build.json"]){const target=join(deployment.canonicalPath,artifact);mkdirSync(dirname(target),{recursive:true});cpSync(join(process.cwd(),"dist",artifact),target);}
    const canonicalPath=realpathSync.native(join(deployment.canonicalPath,"internal")),stat=lstatSync(canonicalPath,{bigint:true});
    const path=join(freshDirectory,"vault/.memory-mcp/v2/events.sqlite"),eventsStat=lstatSync(path,{bigint:true});
    const binding:VerifiedReadBinding={projectionBinding:{...receipt.scope,sessionId:null},expectedRelease:release,controlGeneration:"1",session:{sessionId:receipt.scope.sessionId!,minimumEventPosition:receipt.terminalPosition},eventsFile:{path,device:String(eventsStat.dev),inode:String(eventsStat.ino)},projectionDirectory,executorStateDirectory,deploymentDirectory:{canonicalPath,device:String(stat.dev),inode:String(stat.ino)},compositionEpoch:`g10-${generation}`};
    const snapshot=openCommittedProjectionEventSnapshot(binding.projectionBinding,{driver,eventStorePath:path,busyTimeoutMs:5000});
    // Corruption is confined to detached read input; immutable durable events remain unchanged.
    const projectionInput=options.scenario==="corrupt-companion"?{...snapshot,*events(){for(const event of snapshot.events())yield event.eventType==="MemorySourceRecorded"&&event.commandId===receipt.commandId?Object.freeze({...event,payloadJson:"{}"}):event;}}:snapshot;
    try{const staged=await new ImmutableProjectionBuilder({driver,projectionDirectory:projectionDirectory.canonicalPath,now:()=>"2026-10-09T00:00:00.000Z"}).buildV2(projectionInput,++readGeneration);publishProjectionManifest({projectionDirectory:projectionDirectory.canonicalPath,manifest:staged.manifest,expectedBinding:binding.projectionBinding},{beforeManifestInstall:{install(directory){renameSync(staged.temporaryDatabasePath,join(directory,staged.manifest.databaseFile));}}});}catch(error){if(options.scenario==="corrupt-companion"&&existsSync(join(projectionDirectory.canonicalPath,PROJECTION_MANIFEST_FILENAME)))throw new Error("G10_CORRUPTION_PUBLISHED");throw error;}finally{snapshot.close();}
    return binding;
   },async cleanup(){if(!closed){try{await run.close(permit);}catch(error){const physical=await cleanupOwner?.();if(physical?.disposition!=="graceful-confirmed"&&!(options.scenario==="read-rollback-failure"&&workerExits===1))throw error;closed=true;}}}
  };return result;
 }catch(error){try{await run.close(permit);}catch{try{await cleanupOwner?.();}catch{/* Preserve uncertain original fixture and original setup failure. */}}throw error;}
}
