import type { DatabaseSync } from "node:sqlite";
import type { ProjectionManifestV2 } from "../projections/manifest-codec.js";
import type { RetrievalEligibilityContext } from "../retrieval/contracts.js";
import { collectCanonicalPageFromProjectionDatabase, collectFollowUpPageFromProjectionDatabase,
  type ProjectionCanonicalPage, type ProjectionFollowUpPage, type ProjectionPageKey } from "../retrieval/database-core.js";
import type { NativeSelectionScope } from "./content-contracts.js";
import type { VerifiedReadBinding, VerifiedReadReceipt } from "./contracts.js";
import type { NativeWorkflowRequest, WorkflowCursorBinding } from "./workflow-contracts.js";
import { assertWorkflowCursorMatches, createWorkflowSelectionHash, decodeWorkflowCursor } from "./workflow-cursor.js";
import { collectNativeRankedQuery, type NativeRankedQuery } from "./content-ranking.js";
export type NativeWorkflowQueryContext = Readonly<{ request: NativeWorkflowRequest; binding: VerifiedReadBinding;
  receipt: VerifiedReadReceipt; eligibility: RetrievalEligibilityContext; selectionScope: NativeSelectionScope; remainingMs: number }>;
export type NativeWorkflowCandidate =
  | Readonly<{ operation: "list-canonical-records" | "recent-canonical-records"; selectionScope: NativeSelectionScope; cursorBinding: WorkflowCursorBinding; page: ProjectionCanonicalPage }>
  | Readonly<{ operation: "follow-up-radar"; selectionScope: NativeSelectionScope; cursorBinding: WorkflowCursorBinding; page: ProjectionFollowUpPage }>
  | Readonly<{ operation: "build-context-pack"; selectionScope: NativeSelectionScope; ranked: NativeRankedQuery; followUps: ProjectionFollowUpPage }>;
/** Only database primitives: no pathname, parent query, provider, or image lease. */
export function queryNativeWorkflow(database: DatabaseSync, manifest: ProjectionManifestV2, context: NativeWorkflowQueryContext): NativeWorkflowCandidate {
  const deadline=performance.now()+context.remainingMs;
  const checkDeadline=()=>{if(performance.now()>=deadline)throw Object.assign(new Error("WORKER_TIMEOUT"),{code:"WORKER_TIMEOUT"});};
  checkDeadline();
  const {request,selectionScope,eligibility}=context;
  if(request.operation==="build-context-pack") {
    const ranked=collectNativeRankedQuery(database,manifest,{eligibility,query:request.parameters.query,limit:10,
      requiredEventPosition:context.receipt.requiredEventPosition,remainingMs:Math.max(0,deadline-performance.now())});
    checkDeadline();
    const followUps=collectFollowUpPageFromProjectionDatabase(database,manifest,{...eligibility,limit:10,after:null});
    checkDeadline();
    return Object.freeze({operation:request.operation,selectionScope,ranked,followUps});
  }
  const cursorBinding:WorkflowCursorBinding=Object.freeze({version:1,operation:request.operation,
    selectionHash:createWorkflowSelectionHash(request.operation,context.binding,selectionScope,request.parameters),
    schemaVersion:2,projectionGeneration:manifest.generation,projectionEventPosition:manifest.terminalEventPosition,imageSha256:manifest.databaseSha256});
  let after:ProjectionPageKey|null=null;
  if(request.parameters.cursor!==undefined) {
    const cursor=decodeWorkflowCursor(request.parameters.cursor);
    assertWorkflowCursorMatches(cursor,cursorBinding);
    after={id:cursor.lastId,eventPosition:cursor.lastEventPosition===null?null:BigInt(cursor.lastEventPosition)};
  }
  checkDeadline();
  const pageContext={...eligibility,limit:request.parameters.limit??5,after};
  if(request.operation==="follow-up-radar") {
    const page=collectFollowUpPageFromProjectionDatabase(database,manifest,pageContext);
    checkDeadline(); return Object.freeze({operation:request.operation,selectionScope,cursorBinding,page});
  }
  const page=collectCanonicalPageFromProjectionDatabase(database,manifest,{...pageContext,order:request.operation==="list-canonical-records"?"id":"event"});
  checkDeadline(); return Object.freeze({operation:request.operation,selectionScope,cursorBinding,page});
}
