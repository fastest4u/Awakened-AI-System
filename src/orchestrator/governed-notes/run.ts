import { decodeGovernedFixtureActionV1, decodeGovernedFixtureResultV1, isGovernedFixtureTransportUncertain, type GovernedFixtureActionV1, type GovernedFixtureResultV1, type GovernedFixtureActionPortV1 } from "./fixture-control.js";
import type { ProjectContext } from "../identity/contracts.js";
import type { FreshStartTrustedContext } from "../fresh-start/fresh-start-admission.js";
import type { ProjectStoreExecutor } from "../runtime/project-store-executor.js";
import type { GovernedNoteRunV1, TrustedGovernedNoteTimingV1, FreshGovernedNoteFixtureV1 } from "./contracts.js";
import { GovernedNoteError } from "./errors.js";
import { randomUUID } from "node:crypto";
import { types } from "node:util";
import { FreshGovernedNoteAllocation, type AllocatedGovernedNoteFixture } from "./fixture-allocation.js";
import { decodeGovernedNoteErrorV1, decodePreparedGovernedNoteCreateV1, decodePreparedGovernedNoteRecoveryV1, encodePreparedGovernedNoteCreateV1, encodePreparedGovernedNoteRecoveryV1, validateGovernedNoteTimingV1 } from "./codec.js";
import { decodeGovernedNoteCreateSuccessV1, decodeGovernedNoteRecoverySuccessV1 } from "./worker-protocol.js";
import { encodeAppendResultWire } from "../runtime/worker-protocol.js";
import { retainedExactRecord } from "../privacy/evidence-contracts.js";
import type { GovernedNoteOwnerPermitV1, GovernedNoteRecoveryIdsV1, GovernedNoteStoredReceiptV1 } from "./contracts.js";
export type GovernedNoteFreshInitializationPortV1 = Readonly<{ initialize(input: Readonly<{freshDirectory: string; fixtureId: string}>): Promise<Readonly<{context: ProjectContext; freshStartContext: FreshStartTrustedContext}>> }>;
export type GovernedNoteOwnerConstructionV1 = Readonly<{runId: string; fixtureId: string; ownerGeneration: string; context: ProjectContext; freshStartContext: FreshStartTrustedContext; timing: TrustedGovernedNoteTimingV1}>;
export type GovernedNoteOwnerPortV1 = Readonly<{open(): Promise<void>; fixtureActions?: GovernedFixtureActionPortV1}> & Pick<ProjectStoreExecutor, "createGovernedNote" | "recoverGovernedNoteResult" | "closeForGovernedNoteController" | "canReuse">;
export type GovernedNoteRunOptionsV1 = Readonly<{timing: TrustedGovernedNoteTimingV1; freshInitializer: GovernedNoteFreshInitializationPortV1; ownerFactory: (input: GovernedNoteOwnerConstructionV1) => GovernedNoteOwnerPortV1}>;
type Phase="RESERVED"|"OPEN"|"RECOVERY_EXCLUSIVE"|"DRAINING"|"RELEASE_CONFIRMED"|"OWNERSHIP_UNCERTAIN";
type Slot={fixture:AllocatedGovernedNoteFixture;phase:Phase;owner:GovernedNoteOwnerPortV1|null;permit:GovernedNoteOwnerPermitV1|null;creates:number;generation:bigint};
const fixtureIngress=new WeakMap<GovernedNoteRunV1,(permit:GovernedNoteOwnerPermitV1,action:GovernedFixtureActionV1)=>Promise<GovernedFixtureResultV1>>();
const allocations=new WeakMap<GovernedNoteRunV1,FreshGovernedNoteAllocation>();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function invalid():never {throw new GovernedNoteError("GOVERNED_NOTE_INPUT_INVALID");}
function busy():never {throw new GovernedNoteError("GOVERNED_NOTE_OWNER_BUSY");}
function uncertain(slot:Slot,ids:GovernedNoteRecoveryIdsV1|null=null):never {
  slot.phase="OWNERSHIP_UNCERTAIN";
  throw new GovernedNoteError(ids?"GOVERNED_NOTE_OWNERSHIP_UNCERTAIN":"GOVERNED_NOTE_UNAVAILABLE",ids);
}
function healthy(slot:Slot):boolean {try{return slot.owner?.canReuse()===true;}catch{return false;}}
function assertScope(receipt:GovernedNoteStoredReceiptV1,slot:Slot,sessionId:string):void {
  const {context}=slot.fixture,b=context.binding,scope=receipt.scope;
  for(const key of ["projectId","vaultId","storeId","workspaceId"] as const)if(scope[key]!==b[key])invalid();
  if(scope.sessionId!==sessionId||scope.branchRef!==(context.workspace.kind==="git"?context.workspace.branchRef:null)
    ||(context.branchScopeId!==undefined&&scope.branchScopeId!==context.branchScopeId)||(context.workspace.kind!=="git"&&scope.branchScopeId!==null))invalid();
}
function errorDisposition(error:unknown,slot:Slot,ids:GovernedNoteRecoveryIdsV1,create:boolean):GovernedNoteError {
  try {
    if(error===null||typeof error!=="object"||types.isProxy(error))return uncertain(slot,ids);
    // Executor exceptions carry Error's nonenumerable message. Read only owned
    // data descriptors, never inherited/getter/provider text or arbitrary cause.
    const pick=(key:string)=>{const d=Object.getOwnPropertyDescriptor(error,key);if(!d||!("value" in d))invalid();return d.value;};
    const decoded=decodeGovernedNoteErrorV1({code:pick("code"),message:pick("message"),details:pick("details")},ids);
    if(["COMMAND_OUTCOME_UNKNOWN","GOVERNED_NOTE_OWNERSHIP_UNCERTAIN","WORKER_PROTOCOL_ERROR","PROJECT_BINDING_REQUIRED","PROJECT_ID_MISMATCH","VAULT_ID_MISMATCH","STORE_ID_MISMATCH"].includes(decoded.code)
      ||create&&decoded.code==="INTEGRITY_FAILURE")return uncertain(slot,ids);
    settle(slot,ids);return new GovernedNoteError(decoded.code,ids);
  } catch {return uncertain(slot,ids);}
}
function settle(slot:Slot,ids:GovernedNoteRecoveryIdsV1):void {
  if(slot.phase==="OWNERSHIP_UNCERTAIN")uncertain(slot,ids);
  // Intentional close makes executor.canReuse false. An admitted create may
  // still settle definitively in DRAINING; G08 alone determines final release.
  if(slot.phase!=="DRAINING"&&!healthy(slot))uncertain(slot,ids);
}
export function createGovernedNoteRunV1(options: GovernedNoteRunOptionsV1): GovernedNoteRunV1 {
  const timing=validateGovernedNoteTimingV1(options.timing),runId=randomUUID();
  const allocation=new FreshGovernedNoteAllocation(options.freshInitializer),factory=options.ownerFactory;
  const slots=new WeakMap<FreshGovernedNoteFixtureV1,Slot>(),permits=new WeakMap<GovernedNoteOwnerPermitV1,Slot>(),releasedOwners=new Set<string>();
  let generation=0n;
  function lookup(permit:GovernedNoteOwnerPermitV1):Slot {const slot=permits.get(permit);if(!slot||slot.permit!==permit)invalid();return slot;}
  function admit(slot:Slot,ids:GovernedNoteRecoveryIdsV1|null):void {
    if(slot.phase==="OWNERSHIP_UNCERTAIN")uncertain(slot,ids);
    if(slot.phase==="RECOVERY_EXCLUSIVE"||slot.phase==="DRAINING")busy();
    if(slot.phase!=="OPEN")invalid();
    if(!healthy(slot))uncertain(slot,ids);
    try{allocation.verify(slot.fixture);}catch{uncertain(slot,ids);}
  }
  async function construct(slot:Slot):Promise<GovernedNoteOwnerPermitV1> {
    // Caller reserves synchronously before either verification or the factory.
    try {
      if(generation===9223372036854775807n)uncertain(slot);
      slot.generation=++generation;allocation.verify(slot.fixture);
      slot.owner=factory(Object.freeze({runId,fixtureId:slot.fixture.fixtureId,ownerGeneration:slot.generation.toString(),context:slot.fixture.context,freshStartContext:slot.fixture.freshStartContext,timing}));
      await slot.owner.open();allocation.verify(slot.fixture);
      if(slot.phase!=="RESERVED"||!healthy(slot))uncertain(slot);
      const permit=Object.freeze({}) as GovernedNoteOwnerPermitV1;
      slot.permit=permit;permits.set(permit,slot);slot.phase="OPEN";return permit;
    }catch{return uncertain(slot);}
  }
  const run=Object.freeze<GovernedNoteRunV1>({
    async open(fixture) {
      const record=allocation.lookup(fixture),existing=slots.get(fixture);
      if(existing){if(existing.phase==="OWNERSHIP_UNCERTAIN")uncertain(existing);invalid();}
      const slot:Slot={fixture:record,phase:"RESERVED",owner:null,permit:null,creates:0,generation:0n};slots.set(fixture,slot);return construct(slot);
    },
    async create(permit,input) {
      const slot=lookup(permit),owned=decodePreparedGovernedNoteCreateV1(encodePreparedGovernedNoteCreateV1(input)),ids={commandId:owned.command.commandId,idempotencyKey:owned.command.idempotencyKey};
      admit(slot,ids);slot.creates++;
      let result;
      try{result=await slot.owner!.createGovernedNote(owned);}catch(error){const failure=errorDisposition(error,slot,ids,true);slot.creates--;throw failure;}
      try {
        const decoded=decodeGovernedNoteCreateSuccessV1(encodeAppendResultWire(result),ids);assertScope(decoded.response,slot,owned.authorization.targetSessionId);settle(slot,ids);slot.creates--;
        return Object.freeze({...decoded.response,replay:decoded.deduplicated});
      }catch{return uncertain(slot,ids);}
    },
    async recover(permit,input) {
      const slot=lookup(permit),owned=decodePreparedGovernedNoteRecoveryV1(encodePreparedGovernedNoteRecoveryV1(input)),ids={commandId:owned.request.commandId,idempotencyKey:owned.request.idempotencyKey};
      admit(slot,ids);if(slot.creates>0)busy();slot.phase="RECOVERY_EXCLUSIVE";
      let result;
      try{result=await slot.owner!.recoverGovernedNoteResult(owned);}catch(error){const failure=errorDisposition(error,slot,ids,false);slot.phase="OPEN";throw failure;}
      try{const decoded=decodeGovernedNoteRecoverySuccessV1(result,ids);if(decoded.outcome==="committed")assertScope(decoded.receipt,slot,owned.authorization.targetSessionId);settle(slot,ids);slot.phase="OPEN";return decoded;}catch{return uncertain(slot,ids);}
    },
    async close(permit) {
      const slot=lookup(permit);
      if(slot.phase==="OWNERSHIP_UNCERTAIN")uncertain(slot);
      if(slot.phase==="RECOVERY_EXCLUSIVE"||slot.phase==="DRAINING")busy();
      if(slot.phase!=="OPEN")invalid();if(!healthy(slot))uncertain(slot);
      slot.phase="DRAINING";
      try {
        const observed=retainedExactRecord(await slot.owner!.closeForGovernedNoteController(),["disposition","ownerId"]);
        if(slot.phase as Phase!=="DRAINING"||slot.creates!==0||observed.disposition!=="graceful-confirmed"||typeof observed.ownerId!=="string"||!UUID.test(observed.ownerId)||releasedOwners.has(observed.ownerId))uncertain(slot);
        allocation.verify(slot.fixture);releasedOwners.add(observed.ownerId);slot.phase="RELEASE_CONFIRMED";
      }catch{return uncertain(slot);}
    },
    async reopen(permit) {
      const slot=lookup(permit);if(slot.phase==="OWNERSHIP_UNCERTAIN")uncertain(slot);if(slot.phase!=="RELEASE_CONFIRMED")invalid();slot.phase="RESERVED";return construct(slot);
    },
  });
  fixtureIngress.set(run,async(permit,action)=>{
    const slot=lookup(permit),owned=decodeGovernedFixtureActionV1(action);
    admit(slot,null);if(slot.creates>0)busy();
    if(!slot.owner!.fixtureActions)throw new GovernedNoteError("GOVERNED_NOTE_UNAVAILABLE");
    slot.phase="RECOVERY_EXCLUSIVE";
    let result;
    try{result=await slot.owner!.fixtureActions.execute(owned);}
    catch(error){
      if(owned.kind==="bootstrap"||isGovernedFixtureTransportUncertain(error)||slot.phase as Phase==="OWNERSHIP_UNCERTAIN"||!healthy(slot))return uncertain(slot);
      try{
        if(error===null||typeof error!=="object"||types.isProxy(error))return uncertain(slot);
        const pick=(key:string)=>{const d=Object.getOwnPropertyDescriptor(error,key);if(!d||!("value" in d))invalid();return d.value;};
        const ids=owned.kind==="prepare-create"?owned.command:owned.kind==="prepare-recovery"?owned:owned.kind==="retain"?owned.prepared.command:null;
        const decoded=decodeGovernedNoteErrorV1({code:pick("code"),message:pick("message"),details:pick("details")},ids);
        if(["COMMAND_OUTCOME_UNKNOWN","WORKER_PROTOCOL_ERROR","GOVERNED_NOTE_OWNERSHIP_UNCERTAIN"].includes(decoded.code))return uncertain(slot);
        slot.phase="OPEN";throw new GovernedNoteError(decoded.code,ids);
      }catch(failure){if(slot.phase==="OPEN")throw failure;return uncertain(slot);}
    }
    try{const decoded=decodeGovernedFixtureResultV1(result,owned);if(slot.phase as Phase!=="RECOVERY_EXCLUSIVE"||!healthy(slot))return uncertain(slot);slot.phase="OPEN";return decoded;}catch{return uncertain(slot);}
  });
  allocations.set(run,allocation);return run;
}
/** Internal allocator bridge: membership is read-only and cannot be registered externally. */
export async function allocateForGovernedNoteRun(run: GovernedNoteRunV1,input:Readonly<{parentDirectory:string}>):Promise<FreshGovernedNoteFixtureV1> {const allocator=allocations.get(run);if(!allocator)invalid();return allocator.allocate(input);}

/** Trusted composition ingress, deliberately absent from the five-method facade. */
export async function executeGovernedFixtureActionV1(run:GovernedNoteRunV1,permit:GovernedNoteOwnerPermitV1,action:GovernedFixtureActionV1):Promise<GovernedFixtureResultV1>{const execute=fixtureIngress.get(run);if(!execute)invalid();return execute(permit,action);}
