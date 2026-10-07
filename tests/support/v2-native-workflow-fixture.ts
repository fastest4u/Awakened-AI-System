import { randomUUID } from "node:crypto";
import type { JsonValue } from "../../src/orchestrator/contracts/event.js";
import type { ProjectionManifestV2 } from "../../src/orchestrator/projections/manifest-codec.js";
import type { ReadSuccessBase, VerifiedReadReceipt } from "../../src/orchestrator/verified-read/contracts.js";
import type { BuildContextPackRequest, NativePageParameters, NativeWorkflowRequest } from "../../src/orchestrator/verified-read/workflow-contracts.js";
import { command } from "../fixtures/fresh-start-admission-child.js";
import { FRESH_NOW } from "./fresh-start-fixture.js";
import { READ_HASH, readBootstrap, type ReadFixtureOptions } from "./v2-verified-read-fixture.js";
import { makeNativeContentFixture, nativeLifecycleSetup, NATIVE_SESSION, NATIVE_OTHER_SESSION, type NativeContentFixture } from "./v2-native-content-fixture.js";

export function nativeWorkflowRequest(operation: NativeWorkflowRequest["operation"], parameters?: NativePageParameters | BuildContextPackRequest["parameters"]): NativeWorkflowRequest {
  return Object.freeze({ operation, parameters: Object.freeze(parameters ?? (operation === "build-context-pack" ? { query: "native" } : {})),
    consistency: "project-strong", minimumEventPosition: "0", budgetMs: 5000 }) as NativeWorkflowRequest;
}
export function nativeWorkflowReceipt(fixture: NativeContentFixture, request: NativeWorkflowRequest, manifest: ProjectionManifestV2): VerifiedReadReceipt {
  const fence = fixture.admission.capture(request); fixture.admission.revalidate(fence, manifest);
  return Object.freeze({ operation: request.operation, consistency: request.consistency,
    scope: Object.freeze({ ...fixture.binding.projectionBinding, sessionId: request.consistency === "session-strong" ? fixture.binding.session?.sessionId ?? null : null }),
    releaseId: fixture.release.releaseId, controlGeneration: fixture.binding.controlGeneration, requiredEventPosition: fence.requiredPosition,
    projectionGeneration: manifest.generation, projectionEventPosition: manifest.terminalEventPosition, projectionEventHash: manifest.terminalEventHash,
    imageSha256: manifest.databaseSha256, verification: "image-scope-position-and-active-admission" });
}
/** Closed is capacity reservation for packer tests; it does not acknowledge a running child. */
export function nativeWorkflowSuccessBase(fixture: NativeContentFixture, request: NativeWorkflowRequest, manifest: ProjectionManifestV2): ReadSuccessBase {
  const receipt = nativeWorkflowReceipt(fixture, request, manifest);
  return Object.freeze({ version: 3, ids: Object.freeze({ ...readBootstrap().ids }), kind: "success", receipt,
    fence: fixture.admission.capture(request), closed: Object.freeze({ image: true, reader: true, lock: true }) });
}
export async function makeNativeWorkflowFixture(buildHash = READ_HASH, options: ReadFixtureOptions = {}): Promise<NativeContentFixture & {
  appendWorkflowCorpus(options?: {canonicalCount?: number; followUpCount?: number; matchingFollowUps?: boolean}): Promise<{canonicalIds: readonly string[]; followUpIds: readonly string[]}>;
}> {
  const fixture = await makeNativeContentFixture(buildHash, options); let appended = false;
  return { ...fixture, async appendWorkflowCorpus(settings = {}) {
    if (appended) throw new Error("workflow corpus already appended"); appended = true;
    const canonicalCount = settings.canonicalCount ?? 12, followUpCount = settings.followUpCount ?? 12;
    if (![canonicalCount,followUpCount].every(n=>Number.isInteger(n)&&n>=0&&n<=64)) throw new Error("invalid owned corpus count");
    const canonicalIds: string[] = [], followUpIds: string[] = [];
    for (let i=0;i<canonicalCount;i++) {
      const id = randomUUID(); canonicalIds.push(id); const seed = command();
      fixture.appendSynthetic({ ...seed,commandId:randomUUID(),correlationId:randomUUID(),idempotencyKey:`workflow/${randomUUID()}`,
        streamId:`workflow/${randomUUID()}`,streamType:"memory",expectedStreamVersion:0n,
        events:[{...seed.events[0]!,eventType:"MemorySourceRecorded",eventSchemaVersion:2,visibilityScope:"project",
          payload:{sourceVersion:2,binding:fixture.binding.projectionBinding as unknown as JsonValue,itemId:id,normalizedKey:`native:${id}`,
            status:"verified",confidence:"high",verificationMethod:"committed-event",validFrom:FRESH_NOW,validTo:null,
            summary:`native canonical ${i}`,contentHash:READ_HASH,conflictGroupId:null,supersedingItemId:null}}] });
    }
    const lifecycle = nativeLifecycleSetup(fixture);
    try {
      const session = fixture.binding.session?.sessionId ?? NATIVE_SESSION;
      const descriptor = await lifecycle.start(session); const other = await lifecycle.start(NATIVE_OTHER_SESSION);
      const checkpoint = await lifecycle.checkpoint(session,descriptor,{checkpointVersion:1,taskSummary:"workflow checkpoint",
        completedItems:[],inProgressItems:Array.from({length:Math.ceil(followUpCount/2)},(_,i)=>({summary:`${settings.matchingFollowUps ? "native" : "unrelated"} progress ${i}`,confidence:"high"})),
        blockers:Array.from({length:Math.floor(followUpCount/2)},(_,i)=>({summary:`${settings.matchingFollowUps ? "native" : "unrelated"} blocker ${i}`,confidence:"medium"})),
        nextActions:[],decisions:[],assumptions:[],unresolvedConflicts:[],filesTouched:[],artifactReferences:[],sourceReferences:[],commandResults:[],testResults:[],materialClaims:[]});
      for(let i=0;i<Math.ceil(followUpCount/2);i++) followUpIds.push(`${checkpoint.eventId}/follow-up/in-progress/${i}`);
      for(let i=0;i<Math.floor(followUpCount/2);i++) followUpIds.push(`${checkpoint.eventId}/follow-up/blocker/${i}`);
      await lifecycle.checkpoint(NATIVE_OTHER_SESSION,other,{checkpointVersion:1,taskSummary:"foreign workflow checkpoint",completedItems:[],
        inProgressItems:[{summary:"native foreign follow-up",confidence:"high"}],blockers:[],nextActions:[],decisions:[],assumptions:[],unresolvedConflicts:[],
        filesTouched:[],artifactReferences:[],sourceReferences:[],commandResults:[],testResults:[],materialClaims:[]});
      return Object.freeze({canonicalIds:Object.freeze(canonicalIds),followUpIds:Object.freeze(followUpIds)});
    } finally {lifecycle.close();}
  } };
}
