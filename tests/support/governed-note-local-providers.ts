import { createCipheriv,createDecipheriv,createHmac,randomBytes,timingSafeEqual } from "node:crypto";
import { threadId } from "node:worker_threads";
import type { CapabilityKeyProvider,CapabilityKeyPurpose,KeyScope,KeyedMacInput,KeyedOpenInput,KeyedSealInput } from "../../src/orchestrator/lifecycle/authority/capability-key-provider.js";
import type { EvidenceKeyProvider,EvidenceKeyPurpose,EvidenceKeyRefV1,EvidenceKeyScope,WrappedEvidenceKeyV1 } from "../../src/orchestrator/privacy/evidence-key-provider.js";
import type { TrustedRedactionPolicyV1 } from "../../src/orchestrator/privacy/redaction.js";
import { boundedRetainedJson,retainedDataEntries,retainedExactRecord } from "../../src/orchestrator/privacy/evidence-contracts.js";
import { decodeEvidenceKeyRef,retainedIdentifier } from "../../src/orchestrator/privacy/retained-evidence-codec.js";
import { parseCanonicalTimestamp } from "../../src/orchestrator/lifecycle/contracts/identifiers.js";
import { CAPABILITY_PURPOSES,EVIDENCE_PURPOSES,decodeFixturePolicy,decodeGovernedFixtureControlsV1,fixtureUuid,type GovernedFixtureControlsV1 } from "../../src/orchestrator/governed-notes/fixture-control.js";
export type SyntheticCapabilityKeyStateV1=Readonly<{purpose:CapabilityKeyPurpose;keyId:string;current:boolean;status:"available"|"revoked"|"unavailable"}>;
export type SyntheticEvidenceKeyStateV1=Readonly<{purpose:EvidenceKeyPurpose;ref:EvidenceKeyRefV1;current:boolean;status:"available"|"revoked"|"unavailable"}>;
export type SyntheticGovernedNoteProvisioningV1=Readonly<{version:1;runId:string;fixtureId:string;seed:string;capabilityKeys:readonly SyntheticCapabilityKeyStateV1[];evidenceKeys:readonly SyntheticEvidenceKeyStateV1[];policy:TrustedRedactionPolicyV1;clockNow:string}>;
function refuse():never{throw new Error("G10_PROVIDER_UNAVAILABLE");}
export function decodeProvisioning(value:unknown):SyntheticGovernedNoteProvisioningV1{
 boundedRetainedJson(value,4*1024*1024);const r=retainedExactRecord(value,["version","runId","fixtureId","seed","capabilityKeys","evidenceKeys","policy","clockNow"]);
 if(r.version!==1)refuse();fixtureUuid(r.runId);fixtureUuid(r.fixtureId);
 if(typeof r.seed!=="string"||! /^[A-Za-z0-9_-]{43}$/.test(r.seed))refuse();const seed=Buffer.from(r.seed,"base64url");try{if(seed.length!==32||seed.toString("base64url")!==r.seed)refuse();}finally{seed.fill(0);}
 if(typeof r.clockNow!=="string")refuse();parseCanonicalTimestamp(r.clockNow,"clock");decodeFixturePolicy(r.policy);
 const capabilities=retainedDataEntries(r.capabilityKeys,256),evidence=retainedDataEntries(r.evidenceKeys,256);if(!Array.isArray(r.capabilityKeys)||!Array.isArray(r.evidenceKeys)||capabilities.length+evidence.length>256)refuse();
 for(const [entries,purposes,isEvidence] of [[capabilities,CAPABILITY_PURPOSES,false],[evidence,EVIDENCE_PURPOSES,true]] as const){
  const seen=new Set<string>(),current=new Map<string,number>();
  for(const [,value]of entries){const k=retainedExactRecord(value,isEvidence?["purpose","ref","current","status"]:["purpose","keyId","current","status"]);if(!(purposes as readonly unknown[]).includes(k.purpose)||typeof k.current!=="boolean"||!["available","revoked","unavailable"].includes(k.status as string))refuse();
   const key=isEvidence?JSON.stringify(decodeEvidenceKeyRef(k.ref)):retainedIdentifier(k.keyId),identity=`${k.purpose}/${key}`;if(seen.has(identity))refuse();seen.add(identity);current.set(k.purpose as string,(current.get(k.purpose as string)??0)+(k.current?1:0));
  }for(const count of current.values())if(count!==1)refuse();
 }
 return boundedRetainedJson(value,4*1024*1024).snapshot as unknown as SyntheticGovernedNoteProvisioningV1;
}
export function applyProvisioningControl(input:SyntheticGovernedNoteProvisioningV1,raw:GovernedFixtureControlsV1):SyntheticGovernedNoteProvisioningV1{
 const control=decodeGovernedFixtureControlsV1(raw);let capabilityKeys=input.capabilityKeys.map(k=>({...k})),evidenceKeys=input.evidenceKeys.map(k=>({...k,ref:{...k.ref}})),policy=input.policy,clockNow=input.clockNow;
 if(control.kind==="clock")clockNow=control.now;
 else if(control.kind==="policy")policy=control.policy;
 else if(control.kind==="capability-key-status"){const found=capabilityKeys.find(k=>k.purpose===control.purpose&&k.keyId===control.keyId);if(!found)refuse();found.status=control.status;}
 else if(control.kind==="evidence-key-status"){const found=evidenceKeys.find(k=>k.purpose===control.purpose&&k.ref.keyId===control.ref.keyId&&k.ref.version===control.ref.version);if(!found)refuse();found.status=control.status;}
 else{if(evidenceKeys.some(k=>k.purpose===control.purpose&&k.ref.keyId===control.ref.keyId&&k.ref.version===control.ref.version))refuse();evidenceKeys=evidenceKeys.map(k=>k.purpose===control.purpose?{...k,current:false}:k);evidenceKeys.push({purpose:control.purpose,ref:{...control.ref},current:true,status:"available"});}
 return decodeProvisioning({...input,capabilityKeys,evidenceKeys,policy,clockNow});
}
// Fixed diagnostic layout only. It cannot accept actions, paths, opcodes, keys or provider data from the parent.
export const OBSERVATION_BYTES=16384;
export const OBS={version:0,generation:1,thread:2,providerThread:3,providerCalls:4,connections:5,writers:6,disposed:7,capabilityEntries:8,evidenceEntries:9,unwrap:10,originalMac:11,createPosts:12,recoveryPosts:13,proofMints:14,transaction:15,detach:16,commit:17,delivery:18,closed:19,actionPosts:20,sourceCount:21,pairs:22,pairHeaderFailures:23,privacyLeaks:24,admissionFault:25,corrupted:26,providerFailure:27,fences:28,keyProviders:29,safeOutputLeaks:30,metricLeaks:31,failedReadCommit:32,capabilityStatusBase:64,evidenceStatusBase:576} as const;
export function observationView(buffer:SharedArrayBuffer):Int32Array{if(!(buffer instanceof SharedArrayBuffer)||buffer.byteLength!==OBSERVATION_BYTES)refuse();return new Int32Array(buffer);}
export function writeSafeId(buffer:SharedArrayBuffer,index:number,value:string):void{fixtureUuid(value);if(index<0||index>7)refuse();new Uint8Array(buffer,8192+index*36,36).set(Buffer.from(value));}
export function readSafeId(buffer:SharedArrayBuffer,index:number):string{return fixtureUuid(Buffer.from(new Uint8Array(buffer,8192+index*36,36)).toString());}
export class LocalGovernedProviders {
 state:SyntheticGovernedNoteProvisioningV1;
 readonly capability:CapabilityKeyProvider;readonly evidence:EvidenceKeyProvider;
 readonly clock={now:()=>this.state.clockNow,nowMs:()=>BigInt(Date.parse(this.state.clockNow))};
 readonly #keys=new Map<string,Buffer>();readonly #seed:Buffer;#disposed=false;
 constructor(state:SyntheticGovernedNoteProvisioningV1,readonly scope:KeyScope,readonly observation:SharedArrayBuffer){
  this.state=decodeProvisioning(state);this.#seed=Buffer.from(this.state.seed,"base64url");this.refresh();
  const key=(s:KeyScope,purpose:string,id:string)=>this.key(s,purpose,id);
  const mac=(input:KeyedMacInput)=>createHmac("sha256",key(input,input.purpose,input.keyId)).update(input.domain).update("\n").update(input.bytes).digest();
  this.capability={
   currentKey:(s,p)=>{this.call();this.checkScope(s);const k=this.state.capabilityKeys.find(k=>k.purpose===p&&k.current);if(!k||k.status!=="available")refuse();return {keyId:k.keyId};},
   status:(s,p,id)=>{this.call();this.checkScope(s);return this.state.capabilityKeys.find(k=>k.purpose===p&&k.keyId===id)?.status??"unavailable";},
   mac:input=>{this.call();return mac(input);},verify:input=>{this.call();const expected=mac(input);try{return input.mac.length===expected.length&&timingSafeEqual(input.mac,expected);}finally{expected.fill(0);}},
   fingerprint:input=>{this.call();const bytes=mac(input);try{return bytes.toString("hex");}finally{bytes.fill(0);}},
   seal:(input:KeyedSealInput)=>{this.call();const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key(input,input.purpose,input.keyId),nonce);cipher.setAAD(Buffer.from(input.domain));const ciphertext=Buffer.concat([cipher.update(input.bytes),cipher.final()]);try{return {version:1,keyId:input.keyId,algorithm:"aes-256-gcm",nonce:nonce.toString("base64url"),ciphertext:ciphertext.toString("base64url"),tag:cipher.getAuthTag().toString("base64url")};}finally{ciphertext.fill(0);nonce.fill(0);}},
   open:(input:KeyedOpenInput)=>{this.call();const cipher=createDecipheriv("aes-256-gcm",key(input,input.purpose,input.keyId),Buffer.from(input.sealed.nonce,"base64url"));cipher.setAAD(Buffer.from(input.domain));cipher.setAuthTag(Buffer.from(input.sealed.tag,"base64url"));const first=cipher.update(Buffer.from(input.sealed.ciphertext,"base64url"));try{return Buffer.concat([first,cipher.final()]);}finally{first.fill(0);}},
  };
  const ek=(s:EvidenceKeyScope,p:EvidenceKeyPurpose,r:EvidenceKeyRefV1)=>key(s,p,`${r.keyId}/${r.version}`);
  this.evidence={
   currentKey:(s,p)=>{this.call();this.checkScope(s);const k=this.state.evidenceKeys.find(k=>k.purpose===p&&k.current);if(!k||k.status!=="available")refuse();return {...k.ref};},
   status:(s,p,r)=>{this.call();this.checkScope(s);return this.state.evidenceKeys.find(k=>k.purpose===p&&k.ref.keyId===r.keyId&&k.ref.version===r.version)?.status??"unavailable";},
   wrap:(s,r,dataKey,aad)=>{this.call();const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",ek(s,"data-key-wrap",r),nonce);cipher.setAAD(aad);const ciphertext=Buffer.concat([cipher.update(dataKey),cipher.final()]);try{return {formatVersion:1,keyRef:{...r},algorithm:"AES-256-GCM",nonce:nonce.toString("base64url"),ciphertext:ciphertext.toString("base64url"),tag:cipher.getAuthTag().toString("base64url")};}finally{ciphertext.fill(0);nonce.fill(0);}},
   unwrap:(s,w:WrappedEvidenceKeyV1,aad)=>{this.call();Atomics.add(observationView(this.observation),OBS.unwrap,1);const cipher=createDecipheriv("aes-256-gcm",ek(s,"data-key-wrap",w.keyRef),Buffer.from(w.nonce,"base64url"));cipher.setAAD(aad);cipher.setAuthTag(Buffer.from(w.tag,"base64url"));const first=cipher.update(Buffer.from(w.ciphertext,"base64url"));try{return Buffer.concat([first,cipher.final()]);}finally{first.fill(0);}},
   mac:(s,p,r,domain,bytes)=>{this.call();if(p==="original-input-commitment")Atomics.add(observationView(this.observation),OBS.originalMac,1);return createHmac("sha256",ek(s,p,r)).update(domain).update("\n").update(bytes).digest();},
  };
 }
 private call():void{if(this.#disposed)refuse();const o=observationView(this.observation);Atomics.store(o,OBS.providerThread,threadId);Atomics.add(o,OBS.providerCalls,1);}
 private checkScope(s:KeyScope):void{if(this.#disposed||s.projectId!==this.scope.projectId||s.storeId!==this.scope.storeId)refuse();}
 private key(s:KeyScope,p:string,id:string):Buffer{this.checkScope(s);const cap=this.state.capabilityKeys.find(k=>k.purpose===p&&k.keyId===id),evidence=this.state.evidenceKeys.find(k=>k.purpose===p&&`${k.ref.keyId}/${k.ref.version}`===id);if((cap??evidence)?.status!=="available")refuse();return this.#keys.get(`${p}/${id}`)??refuse();}
 private refresh():void{const o=observationView(this.observation);const statuses={available:1,revoked:2,unavailable:3};
  for(const [entries,base]of [[this.state.capabilityKeys,OBS.capabilityStatusBase],[this.state.evidenceKeys,OBS.evidenceStatusBase]] as const)entries.forEach((k,i)=>{const id="keyId"in k?k.keyId:`${k.ref.keyId}/${k.ref.version}`,identity=`${k.purpose}/${id}`;if(!this.#keys.has(identity))this.#keys.set(identity,createHmac("sha256",this.#seed).update("g10-local-provider/v1\n").update(this.scope.projectId).update("\n").update(this.scope.storeId).update("\n").update(identity).digest());Atomics.store(o,base+i*2,statuses[k.status]);Atomics.store(o,base+i*2+1,k.current?1:0);});
  Atomics.store(o,OBS.capabilityEntries,this.state.capabilityKeys.length);Atomics.store(o,OBS.evidenceEntries,this.state.evidenceKeys.length);
 }
 control(control:GovernedFixtureControlsV1):void{if(this.#disposed)refuse();this.state=applyProvisioningControl(this.state,control);this.refresh();this.publishProviderStatus();}
 containsPrivateMaterial(text:string):boolean{if(text.includes(this.state.seed))return true;for(const key of this.#keys.values())if(text.includes(key.toString("hex"))||text.includes(key.toString("base64url")))return true;return false;}
 publishProviderStatus():void{
  const o=observationView(this.observation),states={available:1,revoked:2,unavailable:3};
  this.state.capabilityKeys.forEach((k,i)=>{Atomics.store(o,OBS.capabilityStatusBase+i*2,states[this.capability.status(this.scope,k.purpose,k.keyId)]);let current:string|undefined;try{current=this.capability.currentKey(this.scope,k.purpose).keyId;}catch{}Atomics.store(o,OBS.capabilityStatusBase+i*2+1,current===k.keyId?1:0);});
  this.state.evidenceKeys.forEach((k,i)=>{Atomics.store(o,OBS.evidenceStatusBase+i*2,states[this.evidence.status(this.scope,k.purpose,k.ref)]);let current:EvidenceKeyRefV1|undefined;try{current=this.evidence.currentKey(this.scope,k.purpose);}catch{}Atomics.store(o,OBS.evidenceStatusBase+i*2+1,current?.keyId===k.ref.keyId&&current?.version===k.ref.version?1:0);});
 }
 dispose():void{if(this.#disposed)return;this.#disposed=true;for(const key of this.#keys.values())key.fill(0);this.#keys.clear();this.#seed.fill(0);Atomics.store(observationView(this.observation),OBS.disposed,1);}
}
