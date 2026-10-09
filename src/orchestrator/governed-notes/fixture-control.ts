import type { ProjectContext } from "../identity/contracts.js";
import type { CapabilityKeyPurpose } from "../lifecycle/authority/capability-key-provider.js";
import type { EvidenceKeyPurpose,EvidenceKeyRefV1 } from "../privacy/evidence-key-provider.js";
import { redactGovernedNoteSummaryV1,type TrustedRedactionPolicyV1 } from "../privacy/redaction.js";
import { boundedRetainedJson,decodeRetainedEvidenceReceipt,retainedDataEntries,retainedExactRecord,type RetainedEvidenceReceiptV1 } from "../privacy/evidence-contracts.js";
import { decodeEvidenceKeyRef,retainedIdentifier } from "../privacy/retained-evidence-codec.js";
import { decodePreparedRetainedEvidenceCommand,encodePreparedRetainedEvidenceCommand,type PreparedRetainedEvidenceCommandV1 } from "../privacy/retained-evidence-worker-protocol.js";
import type { RetainedEvidenceRuntimeCreateInput,RetainedEvidenceRuntime } from "../privacy/retained-evidence-runtime.factory.js";
import { decodeLifecycleWorkerOperationWire,type LifecycleWorkerOperationWire } from "../runtime/lifecycle-worker-protocol.js";
import type { LifecycleWorkerRuntime } from "../runtime/lifecycle-worker-runtime.js";
import { decodeWorkerBindingAssertion,type WorkerBindingAssertion } from "../runtime/worker-protocol.js";
import { parseCanonicalTimestamp,parseCanonicalUuid,parseUnsignedDecimal } from "../lifecycle/contracts/identifiers.js";
import { decodeGovernedNoteCommandV1,decodeGovernedNoteErrorV1,decodePreparedGovernedNoteCreateV1,decodePreparedGovernedNoteRecoveryV1,encodePreparedGovernedNoteCreateV1,encodePreparedGovernedNoteRecoveryV1 } from "./codec.js";
import { GovernedNoteError,type GovernedNoteErrorV1 } from "./errors.js";
import type { GovernedNoteCommandV1,GovernedNoteRuntime,PreparedGovernedNoteCreateV1,PreparedGovernedNoteRecoveryV1 } from "./contracts.js";

export type FixtureLifecycleOperationV1=Extract<LifecycleWorkerOperationWire,{operation:"abandon-session"|"create-child-transfer"|"claim-child-transfer"|"suspend-child-session"}>;
export type GovernedFixtureControlsV1=
 |Readonly<{kind:"clock";now:string}>
 |Readonly<{kind:"policy";policy:TrustedRedactionPolicyV1}>
 |Readonly<{kind:"evidence-key-status";purpose:EvidenceKeyPurpose;ref:EvidenceKeyRefV1;status:"available"|"revoked"|"unavailable"}>
 |Readonly<{kind:"evidence-key-rotate";purpose:EvidenceKeyPurpose;ref:EvidenceKeyRefV1}>
 |Readonly<{kind:"capability-key-status";purpose:CapabilityKeyPurpose;keyId:string;status:"available"|"revoked"|"unavailable"}>;
export type GovernedFixtureActionV1=
 |Readonly<{kind:"bootstrap";rootSessionId:string;childSessionId:string}>
 |Readonly<{kind:"retain";prepared:PreparedRetainedEvidenceCommandV1}>
 |Readonly<{kind:"prepare-create";authoritySessionId:string;command:GovernedNoteCommandV1}>
 |Readonly<{kind:"prepare-recovery";authoritySessionId:string;operationId:string;requestId:string;commandId:string;idempotencyKey:string}>
 |Readonly<{kind:"change-authority";operation:FixtureLifecycleOperationV1}>
 |Readonly<{kind:"set-fixture-controls";controls:GovernedFixtureControlsV1}>;
export type GovernedFixtureResultV1=
 |Readonly<{kind:"bootstrap";rootSessionId:string;childSessionId:string}>
 |Readonly<{kind:"retain";receipt:RetainedEvidenceReceiptV1}>
 |Readonly<{kind:"prepare-create";prepared:PreparedGovernedNoteCreateV1}>
 |Readonly<{kind:"prepare-recovery";prepared:PreparedGovernedNoteRecoveryV1}>
 |Readonly<{kind:"applied";applied:true}>;
export interface GovernedFixtureActionPortV1 {execute(action:GovernedFixtureActionV1):Promise<GovernedFixtureResultV1>;dispose():void;}
export interface TrustedGovernedFixtureFactoryV1 {create(input:RetainedEvidenceRuntimeCreateInput & Readonly<{context:ProjectContext;lifecycleRuntime:LifecycleWorkerRuntime;retainedEvidenceRuntime:RetainedEvidenceRuntime;governedNoteRuntime:GovernedNoteRuntime}>):GovernedFixtureActionPortV1;}
export const FIXTURE_REQUEST_BYTES=4*1024*1024;
export const CAPABILITY_PURPOSES=Object.freeze(["root-session-handle","root-resume-token","child-session-handle","child-binding-grant","continuity-index","evidence-fingerprint","validation-output-fingerprint","materialization-fingerprint","recovery-approval","abandonment-approval","pending-authorization-encryption"] as const);
export const EVIDENCE_PURPOSES=Object.freeze(["data-key-wrap","original-input-commitment","redacted-content-fingerprint"] as const);
function invalid():never{throw new GovernedNoteError("GOVERNED_NOTE_INPUT_INVALID");}
export function fixtureUuid(value:unknown):string{if(typeof value!=="string"||value[14]!=="4")invalid();try{return parseCanonicalUuid(value,"fixture");}catch{return invalid();}}
function session(value:unknown):string{if(typeof value!=="string")invalid();return parseCanonicalUuid(value,"session");}
function record(value:unknown):Record<string,unknown>{return Object.fromEntries(retainedDataEntries(value,32));}
function status(value:unknown):void{if(!["available","revoked","unavailable"].includes(value as string))invalid();}
export function decodeFixturePolicy(value:unknown):TrustedRedactionPolicyV1{const policy=boundedRetainedJson(value,FIXTURE_REQUEST_BYTES).snapshot as unknown as TrustedRedactionPolicyV1;redactGovernedNoteSummaryV1("g10-policy-validation",policy);return policy;}
export function decodeGovernedFixtureControlsV1(value:unknown):GovernedFixtureControlsV1{
 const r=record(value);let owned:unknown;
 switch(r.kind){
 case "clock":retainedExactRecord(value,["kind","now"]);if(typeof r.now!=="string")invalid();parseCanonicalTimestamp(r.now,"clock");owned=r;break;
 case "policy":retainedExactRecord(value,["kind","policy"]);owned={kind:r.kind,policy:decodeFixturePolicy(r.policy)};break;
 case "evidence-key-status":case "evidence-key-rotate":
  retainedExactRecord(value,r.kind==="evidence-key-status"?["kind","purpose","ref","status"]:["kind","purpose","ref"]);
  if(!(EVIDENCE_PURPOSES as readonly unknown[]).includes(r.purpose))invalid();if(r.kind==="evidence-key-status")status(r.status);
  owned={...r,ref:decodeEvidenceKeyRef(r.ref)};break;
 case "capability-key-status":retainedExactRecord(value,["kind","purpose","keyId","status"]);if(!(CAPABILITY_PURPOSES as readonly unknown[]).includes(r.purpose))invalid();retainedIdentifier(r.keyId);status(r.status);owned=r;break;
 default:return invalid();
 }return boundedRetainedJson(owned,FIXTURE_REQUEST_BYTES).snapshot as unknown as GovernedFixtureControlsV1;
}
export function decodeGovernedFixtureActionV1(value:unknown):GovernedFixtureActionV1{
 // Traverse the original envelope before normalization; retained batches have their own larger scalar caps.
 boundedRetainedJson(value,FIXTURE_REQUEST_BYTES);const r=record(value);let owned:unknown;
 switch(r.kind){
 case "bootstrap":retainedExactRecord(value,["kind","rootSessionId","childSessionId"]);fixtureUuid(r.rootSessionId);fixtureUuid(r.childSessionId);if(r.rootSessionId===r.childSessionId)invalid();owned=r;break;
 case "retain":retainedExactRecord(value,["kind","prepared"]);owned={kind:r.kind,prepared:decodePreparedRetainedEvidenceCommand(encodePreparedRetainedEvidenceCommand(r.prepared))};break;
 case "prepare-create":retainedExactRecord(value,["kind","authoritySessionId","command"]);owned={kind:r.kind,authoritySessionId:session(r.authoritySessionId),command:decodeGovernedNoteCommandV1(r.command)};break;
 case "prepare-recovery":retainedExactRecord(value,["kind","authoritySessionId","operationId","requestId","commandId","idempotencyKey"]);session(r.authoritySessionId);for(const k of ["operationId","requestId","commandId","idempotencyKey"])fixtureUuid(r[k]);owned=r;break;
 case "change-authority":{retainedExactRecord(value,["kind","operation"]);const op=decodeLifecycleWorkerOperationWire(r.operation);if(!["abandon-session","create-child-transfer","claim-child-transfer","suspend-child-session"].includes(op.operation))invalid();owned={kind:r.kind,operation:op};break;}
 case "set-fixture-controls":retainedExactRecord(value,["kind","controls"]);owned={kind:r.kind,controls:decodeGovernedFixtureControlsV1(r.controls)};break;
 default:return invalid();
 }return boundedRetainedJson(owned,FIXTURE_REQUEST_BYTES).snapshot as unknown as GovernedFixtureActionV1;
}
export function decodeGovernedFixtureResultV1(value:unknown,action:GovernedFixtureActionV1):GovernedFixtureResultV1{
 boundedRetainedJson(value,16384);const r=record(value);
 if(action.kind==="bootstrap"){
  retainedExactRecord(value,["kind","rootSessionId","childSessionId"]);if(r.kind!==action.kind||r.rootSessionId!==action.rootSessionId||r.childSessionId!==action.childSessionId)invalid();
 }else if(action.kind==="prepare-create"){
  retainedExactRecord(value,["kind","prepared"]);if(r.kind!==action.kind)invalid();const p=decodePreparedGovernedNoteCreateV1(encodePreparedGovernedNoteCreateV1(r.prepared as PreparedGovernedNoteCreateV1));
  if(p.authorization.authoritySessionId!==action.authoritySessionId||boundedRetainedJson(p.command,8192).canonical!==boundedRetainedJson(action.command,8192).canonical)invalid();
 }else if(action.kind==="prepare-recovery"){
  retainedExactRecord(value,["kind","prepared"]);if(r.kind!==action.kind)invalid();const p=decodePreparedGovernedNoteRecoveryV1(encodePreparedGovernedNoteRecoveryV1(r.prepared as PreparedGovernedNoteRecoveryV1));
  if(p.authorization.authoritySessionId!==action.authoritySessionId)invalid();for(const k of ["operationId","requestId","commandId","idempotencyKey"] as const)if(p.request[k]!==action[k])invalid();
 }else if(action.kind==="retain"){
  retainedExactRecord(value,["kind","receipt"]);if(r.kind!==action.kind)invalid();const q=retainedExactRecord(r.receipt,["resultVersion","operation","retentionFormat","targetSessionId","conversationId","commandId","idempotencyKey","evidenceIds","eventPosition","finalStreamVersion"]);
  const command=action.prepared.command;
  for(const k of ["commandId","idempotencyKey","targetSessionId","conversationId"] as const)if(q[k]!==command[k])invalid();
  const receipt=decodeRetainedEvidenceReceipt(q);
  if(parseUnsignedDecimal(receipt.eventPosition,"position")<1n||parseUnsignedDecimal(receipt.finalStreamVersion,"version")<1n)invalid();
  if(receipt.evidenceIds.length!==command.frames.length)invalid();
 }else{retainedExactRecord(value,["kind","applied"]);if(r.kind!=="applied"||r.applied!==true)invalid();}
 return boundedRetainedJson(value,16384).snapshot as unknown as GovernedFixtureResultV1;
}
export type GovernedFixtureRequestV1=Readonly<{version:1;requestId:string;runId:string;storeId:string;ownerGeneration:string;binding:WorkerBindingAssertion;action:GovernedFixtureActionV1}>;
export type GovernedFixtureReplyV1=Readonly<{version:1;requestId:string;ok:true;result:GovernedFixtureResultV1}>|Readonly<{version:1;requestId:string;ok:false;error:GovernedNoteErrorV1}>;
export function decodeGovernedFixtureRequestV1(value:unknown,expected:Readonly<{runId:string;storeId:string;ownerGeneration:string;binding:WorkerBindingAssertion}>):GovernedFixtureRequestV1{
 boundedRetainedJson(value,FIXTURE_REQUEST_BYTES);const r=retainedExactRecord(value,["version","requestId","runId","storeId","ownerGeneration","binding","action"]);
 if(r.version!==1||r.runId!==expected.runId||r.storeId!==expected.storeId||r.ownerGeneration!==expected.ownerGeneration)invalid();fixtureUuid(r.requestId);fixtureUuid(r.runId);
 if(typeof r.ownerGeneration!=="string"||parseUnsignedDecimal(r.ownerGeneration,"generation")<1n)invalid();
 const binding=decodeWorkerBindingAssertion(r.binding);if(boundedRetainedJson(binding,4096).canonical!==boundedRetainedJson(expected.binding,4096).canonical)invalid();
 return Object.freeze({...r,binding,action:decodeGovernedFixtureActionV1(r.action)}) as GovernedFixtureRequestV1;
}
export function decodeGovernedFixtureReplyV1(value:unknown,request:GovernedFixtureRequestV1):GovernedFixtureReplyV1{
 boundedRetainedJson(value,16384);const r=record(value);retainedExactRecord(value,r.ok===true?["version","requestId","ok","result"]:["version","requestId","ok","error"]);
 if(r.version!==1||r.requestId!==request.requestId)invalid();if(r.ok===true)return Object.freeze({version:1,requestId:request.requestId,ok:true,result:decodeGovernedFixtureResultV1(r.result,request.action)});
 if(r.ok!==false)invalid();const a=request.action,ids=a.kind==="prepare-create"?a.command:a.kind==="prepare-recovery"?a:a.kind==="retain"?a.prepared.command:null;
 return Object.freeze({version:1,requestId:request.requestId,ok:false,error:decodeGovernedNoteErrorV1(r.error,ids)});
}
// A private local disposition certificate. A safe error code by itself cannot certify transport loss.
const uncertainFailures=new WeakSet<object>();
export function governedFixtureTransportUncertain():Error{const error=new GovernedNoteError("GOVERNED_NOTE_UNAVAILABLE");uncertainFailures.add(error);return error;}
export function isGovernedFixtureTransportUncertain(error:unknown):boolean{return typeof error==="object"&&error!==null&&uncertainFailures.has(error);}
