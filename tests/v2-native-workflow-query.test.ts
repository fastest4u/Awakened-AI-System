import assert from "node:assert/strict";
import { it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { NativeQueryContext } from "../src/orchestrator/verified-read/content-query.js";
import { queryNativeContent } from "../src/orchestrator/verified-read/content-query.js";
import { nextWorkflowCursor } from "../src/orchestrator/verified-read/workflow-cursor.js";
import type { NativeWorkflowRequest } from "../src/orchestrator/verified-read/workflow-contracts.js";
import { makeNativeContentFixture, NATIVE_SESSION, type NativeContentFixture } from "./support/v2-native-content-fixture.js";
import type { ProjectionManifestV2 } from "../src/orchestrator/projections/manifest-codec.js";

function context(f: NativeContentFixture, m: ProjectionManifestV2, request: NativeWorkflowRequest): NativeQueryContext {
  const fence=f.admission.capture(request); f.admission.revalidate(fence,m);
  return { request,binding:f.binding,remainingMs:5000,receipt:{operation:request.operation,consistency:request.consistency,
    scope:{...f.binding.projectionBinding,sessionId:null},releaseId:f.release.releaseId,controlGeneration:f.binding.controlGeneration,
    requiredEventPosition:fence.requiredPosition,projectionGeneration:m.generation,projectionEventPosition:m.terminalEventPosition,
    projectionEventHash:m.terminalEventHash,imageSha256:m.databaseSha256,verification:"image-scope-position-and-active-admission"} };
}
function request(operation: NativeWorkflowRequest["operation"], parameters: object = {}): NativeWorkflowRequest {
  return { operation,consistency:"project-strong",minimumEventPosition:"0",budgetMs:5000,
    parameters:operation==="build-context-pack"?{query:"no-text-matches",...parameters}:parameters } as NativeWorkflowRequest;
}
// Break caught: absent workflow dispatch or returning data before matching receipt/image authority.
it("workflow_dispatch_and_receipt_image_match",async()=>{
  const f=await makeNativeContentFixture(undefined,{session:{sessionId:NATIVE_SESSION,minimumEventPosition:"0"}});
  try { await f.appendCorpus(); await f.publish(); const image=f.captureImage();
    try { for(const operation of ["list-canonical-records","recent-canonical-records","follow-up-radar","build-context-pack"] as const) {
      const ctx=context(f,image.manifest,request(operation)); const result:any=queryNativeContent(image.database,image.manifest,ctx);
      assert.equal(result.operation,operation);
      assert.throws(()=>queryNativeContent(image.database,image.manifest,{...ctx,receipt:{...ctx.receipt,imageSha256:"9".repeat(64)}}),{code:"INTEGRITY_FAILURE"});
      assert.throws(()=>queryNativeContent(image.database,image.manifest,{...ctx,remainingMs:0}),{code:"WORKER_TIMEOUT"});
    }
    const first:any=queryNativeContent(image.database,image.manifest,context(f,image.manifest,request("list-canonical-records",{limit:1})));
    assert.equal(first.page.items.length,1); assert.equal(first.page.hasMore,true);
    const cursor=nextWorkflowCursor(first.cursorBinding,{id:first.page.items[0].item.id,eventPosition:null});
    const second:any=queryNativeContent(image.database,image.manifest,context(f,image.manifest,request("list-canonical-records",{limit:10,cursor})));
    assert.ok(second.page.items.every((entry:any)=>entry.item.id>first.page.items[0].item.id));
    await f.publish(); const next=f.captureImage();
    try { assert.throws(()=>queryNativeContent(next.database,next.manifest,context(f,next.manifest,request("list-canonical-records",{cursor}))),{code:"V2_CONTENT_CURSOR_STALE"});
      assert.equal((queryNativeContent(next.database,next.manifest,context(f,next.manifest,request("list-canonical-records"))) as any).page.items.length,5);
      const closed=new DatabaseSync(":memory:"); closed.close();
      assert.throws(()=>queryNativeContent(closed,next.manifest,context(f,next.manifest,request("list-canonical-records",{cursor}))),{code:"V2_CONTENT_CURSOR_STALE"});
      assert.throws(()=>queryNativeContent(next.database,next.manifest,context(f,next.manifest,request("list-canonical-records",{cursor:"%%%"}))),{code:"FRESH_START_INPUT_INVALID"});
    } finally {next.close();}
    } finally {image.close();}
  } finally {f.cleanup();}
});
// Break caught: replacing trusted selection session with project receipt's null session.
it("context_project_receipt_keeps_selection_session",async()=>{
 const f=await makeNativeContentFixture(undefined,{session:{sessionId:NATIVE_SESSION,minimumEventPosition:"0"}});
 try {const corpus=await f.appendCorpus();await f.publish();const image=f.captureImage();try {
  const ctx=context(f,image.manifest,request("build-context-pack"));assert.equal(ctx.receipt.scope.sessionId,null);
  const candidate:any=queryNativeContent(image.database,image.manifest,ctx);
  assert.equal(candidate.operation,"build-context-pack");assert.equal(candidate.selectionScope.sessionId,NATIVE_SESSION);
  assert.deepEqual(new Set(candidate.followUps.items.map((item:any)=>item.id)),new Set([corpus.ids.openFollowUp,corpus.ids.blockedFollowUp]));
  assert.equal((queryNativeContent(image.database,image.manifest,context(f,image.manifest,request("build-context-pack",{visibility:"project"}))) as any).followUps.items.length,0);
 }finally{image.close();}}finally{f.cleanup();}
});
// Break caught: text-filtered supplementation, reopening the published pathname after capture, wrong source positions.
it("context_query_free_radar_uses_one_database",async()=>{
 const f=await makeNativeContentFixture(undefined,{session:{sessionId:NATIVE_SESSION,minimumEventPosition:"0"}});
 try {const corpus=await f.appendCorpus();await f.publish();const image=f.captureImage();try {
  await f.publish();const distinctCapturedDatabaseHandles=new Set<DatabaseSync>();
    const observedDatabase=new Proxy(image.database,{get(target,key){
    const value=Reflect.get(target,key,target);
    if(key==="prepare")return (...args:Parameters<DatabaseSync["prepare"]>)=>{
      distinctCapturedDatabaseHandles.add(target);return target.prepare(...args);
    };
    return typeof value==="function"?value.bind(target):value;
  }});
  const run=(operation:NativeWorkflowRequest["operation"])=>queryNativeContent(observedDatabase,image.manifest,context(f,image.manifest,request(operation))) as any;
  const candidate=run("build-context-pack");const radar=run("follow-up-radar");
  assert.equal(candidate.ranked.rankedCandidates.length,0);assert.deepEqual(candidate.followUps.items,radar.page.items);
  assert.equal(candidate.followUps.items[0].sourceEventPosition.toString(),corpus.sourcePositions.openFollowUp);
  assert.equal(distinctCapturedDatabaseHandles.size,1);
 }finally{image.close();}}finally{f.cleanup();}
});
// Break caught: losing query-free 10+1 lookahead or dropping duplicates before shared-budget packing can account for them.
it("context_zero_ranked_overflow_and_duplicate_budget",async()=>{
 const f=await makeNativeContentFixture(undefined,{session:{sessionId:NATIVE_SESSION,minimumEventPosition:"0"}});
 try {await f.appendCorpus();await f.publish();const image=f.captureImage();const db=new DatabaseSync(":memory:");try {
  db.deserialize((image.database as DatabaseSync & {serialize():Uint8Array}).serialize());
  const row=db.prepare("SELECT * FROM tasks_followups LIMIT 1").get()!;
  for(let n=0;n<12;n++)db.prepare("INSERT INTO tasks_followups SELECT project_id, session_id, ?, status, summary, confidence, source_event_id, source_event_position, anchor FROM tasks_followups WHERE follow_up_id = ?").run(`overflow-${n}`,row.follow_up_id as string);
  const candidate:any=queryNativeContent(db,image.manifest,context(f,image.manifest,request("build-context-pack")));
  assert.equal(candidate.ranked.rankedCandidates.length,0);assert.equal(candidate.followUps.items.length,10);assert.equal(candidate.followUps.hasMore,true);
  const duplicate:any=queryNativeContent(db,image.manifest,context(f,image.manifest,request("build-context-pack",{query:"native open follow-up"})));
  assert.ok(duplicate.ranked.rankedCandidates.some((rank:any)=>duplicate.followUps.items.some((item:any)=>item.id===rank.item.id)));
  assert.ok(duplicate.ranked.selection.usedTokens<=2048);assert.ok(duplicate.ranked.selection.candidates.length<=10);
 }finally{db.close();image.close();}}finally{f.cleanup();}
});
