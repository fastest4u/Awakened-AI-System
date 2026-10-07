import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { assertNativeWorkflowMatchesRequest } from "../src/orchestrator/verified-read/workflow-protocol.js";
import type { NativeWorkflowCursor, WorkflowCursorBinding, NativePagedOperation, NativeWorkflowRequest, NativeWorkflowResult, ListCanonicalRecordsRequest, NativeCanonicalPageResult } from "../src/orchestrator/verified-read/workflow-contracts.js";
import type { NativeSelectionScope, NativeContentFilters } from "../src/orchestrator/verified-read/content-contracts.js";
import type { VerifiedReadBinding, VerifiedReadReceipt } from "../src/orchestrator/verified-read/contracts.js";
import { readBootstrap, readReceipt, READ_HASH } from "./support/v2-verified-read-fixture.js";
const invalid = {code:"FRESH_START_INPUT_INVALID"}; const stale = {code:"V2_CONTENT_CURSOR_STALE"};
const binding = readBootstrap().binding as VerifiedReadBinding;
const scope: NativeSelectionScope = {projectId:binding.projectionBinding.projectId,workspaceId:binding.projectionBinding.workspaceId,
  branchScopeId:null,branchRef:null,sessionId:null,visibility:"branch"};
const cursor: NativeWorkflowCursor = {version:1,operation:"list-canonical-records",selectionHash:READ_HASH,schemaVersion:2,
  projectionGeneration:1,projectionEventPosition:"100",imageSha256:READ_HASH,lastId:"a",lastEventPosition:null};
const raw = (value: unknown) => Buffer.from(canonicalJson(value)).toString("base64url");
async function api() {
  let loaded: Record<string,unknown> | undefined;
  try { loaded = await import(`../src/orchestrator/verified-read/${"workflow-cursor"}.js`); }
  catch(error) {if ((error as {code?:string}).code!=="ERR_MODULE_NOT_FOUND") throw error;}
  assert.equal(typeof loaded?.decodeWorkflowCursor,"function","cursor codec and binding API is missing");
  return loaded as unknown as {
    decodeWorkflowCursor(value:unknown):NativeWorkflowCursor; encodeWorkflowCursor(value:NativeWorkflowCursor):string;
    assertWorkflowCursorMatches(value:NativeWorkflowCursor,bound:WorkflowCursorBinding):void;
    createWorkflowSelectionHash(operation:NativePagedOperation,binding:VerifiedReadBinding,scope:NativeSelectionScope,filters:NativeContentFilters):string;
    nextWorkflowCursor(bound:WorkflowCursorBinding,last:{id:string;eventPosition:bigint|null}):string;
  };
}
// Break caught: ambiguous noncanonical transport, permissive selectors, or classifying binding changes as malformed input.
test("cursor_binding_and_encoding",async()=>{
  const impl = await api(); const encoded = impl.encodeWorkflowCursor(cursor);
  assert.equal(encoded,raw(cursor)); assert.deepEqual(impl.decodeWorkflowCursor(encoded),cursor);
  assert.ok(Object.isFrozen(impl.decodeWorkflowCursor(encoded)));
  for (const change of [{extra:1},{version:2},{schemaVersion:1},{lastId:0},{lastId:""},{lastId:"\ud800"},{lastId:"x".repeat(2049)},
    {projectionGeneration:0},{projectionGeneration:2147483648},{projectionEventPosition:"01"},{projectionEventPosition:"9223372036854775808"},
    {lastEventPosition:"1"},{operation:"follow-up-radar",lastEventPosition:null},{operation:"recent-canonical-records",lastEventPosition:"101"},
    {selectionHash:"g".repeat(64)},{imageSha256:null}]) assert.throws(()=>impl.decodeWorkflowCursor(raw({...cursor,...change})),invalid);
  for (const value of ["",encoded+"=", "x".repeat(2049),Buffer.from(JSON.stringify(cursor)).toString("base64url"),
    Buffer.from(" "+canonicalJson(cursor)).toString("base64url"), Buffer.from([0xff]).toString("base64url"),"\ud800"])
    assert.throws(()=>impl.decodeWorkflowCursor(value),invalid);
  assert.throws(()=>impl.encodeWorkflowCursor({...cursor,lastId:"x".repeat(1500)}),invalid);
  const event = {...cursor,operation:"recent-canonical-records" as const,lastEventPosition:"100"};
  assert.deepEqual(impl.decodeWorkflowCursor(impl.encodeWorkflowCursor(event)),event);
  const {lastId:_id,lastEventPosition:_position,...bound}=cursor;
  assert.doesNotThrow(()=>impl.assertWorkflowCursorMatches(cursor,bound));
  for (const change of [{operation:"recent-canonical-records"},{selectionHash:"b".repeat(64)},{projectionGeneration:2},
    {projectionEventPosition:"99"},{imageSha256:"c".repeat(64)}])
    assert.throws(()=>impl.assertWorkflowCursorMatches(cursor,{...bound,...change} as WorkflowCursorBinding),stale);
  assert.equal(impl.nextWorkflowCursor(bound,{id:"later",eventPosition:null}),raw({...cursor,lastId:"later"}));
});
// Break caught: omitting any semantic scope/image identity from authority, hashing page size, or trusting a child cursor.
test("cursor_narrows_only_and_limit_is_not_authority",async()=>{
  const impl = await api();
  const hash = impl.createWorkflowSelectionHash(cursor.operation,binding,scope,{});
  const refusesChangedHash = (changedHash:string) => assert.throws(()=>impl.assertWorkflowCursorMatches({...cursor,selectionHash:hash},
    {...cursor,selectionHash:changedHash}),stale);
  const expected = createHash("sha256").update(canonicalJson({operation:cursor.operation,order:"item-id-binary-asc",
    projectionBinding:binding.projectionBinding,selectionScope:scope,expectedRelease:binding.expectedRelease,
    controlGeneration:binding.controlGeneration,compositionEpoch:binding.compositionEpoch,
    filters:{visibility:"branch",validAt:null,knownAt:null}})).digest("hex");
  assert.equal(hash,expected); assert.equal(impl.createWorkflowSelectionHash(cursor.operation,binding,scope,{visibility:"branch"}),hash);
  for (const operation of ["recent-canonical-records","follow-up-radar"] as const) assert.notEqual(impl.createWorkflowSelectionHash(operation,binding,scope,{}),hash);
  for (const filters of [{visibility:"project" as const},{validAt:"2026-01-01T00:00:00.000Z"},{knownAt:"1"}])
    { assert.notEqual(impl.createWorkflowSelectionHash(cursor.operation,binding,scope,filters),hash);
      refusesChangedHash(impl.createWorkflowSelectionHash(cursor.operation,binding,scope,filters)); }
  for (const key of Object.keys(binding.expectedRelease)) {
    const value=binding.expectedRelease[key as keyof typeof binding.expectedRelease];
    const changed = {...binding,expectedRelease:{...binding.expectedRelease,[key]:typeof value==="number"?2:"different"}};
    assert.notEqual(impl.createWorkflowSelectionHash(cursor.operation,changed,scope,{}),hash,key);
    refusesChangedHash(impl.createWorkflowSelectionHash(cursor.operation,changed,scope,{}));
  }
  for (const changed of [{...binding,controlGeneration:"1"},{...binding,compositionEpoch:"new"},
    {...binding,projectionBinding:{...binding.projectionBinding,branchRef:"refs/heads/other"}}])
    { assert.notEqual(impl.createWorkflowSelectionHash(cursor.operation,changed,scope,{}),hash);
      refusesChangedHash(impl.createWorkflowSelectionHash(cursor.operation,changed,scope,{})); }
  for (const key of Object.keys(scope)) {
    const changedHash=impl.createWorkflowSelectionHash(cursor.operation,binding,{...scope,[key]:"other"},{});
    assert.notEqual(changedHash,hash,key); refusesChangedHash(changedHash);
  }
  assert.equal(impl.createWorkflowSelectionHash(cursor.operation,{...binding,eventsFile:{...binding.eventsFile,path:"different"}},scope,{}),hash);
  const bound:WorkflowCursorBinding={...cursor,selectionHash:hash};
  assert.doesNotThrow(()=>impl.assertWorkflowCursorMatches({...cursor,selectionHash:hash,lastId:"z"},bound));
  const next=impl.nextWorkflowCursor(bound,{id:"a",eventPosition:null});
  const content = {operation:cursor.operation,selectionScope:scope,workflowBoundsVersion:"v2-native-read-workflow-bounds-1",order:"item-id-binary-asc",
    items:[{item:{id:"a",kind:"canonical",...scope,status:"verified",confidence:"high",verificationMethod:"event",validFrom:null,validTo:null,
      knownFromEventPosition:"1",sourceEventPosition:"20",textKind:"canonical-summary",text:"native",conflictGroupId:null,supersedingItemId:null},conflict:null}],
    hasMore:true,nextCursor:next,byteBounded:false} as NativeCanonicalPageResult;
  const receipt = {...readReceipt(),operation:cursor.operation,projectionEventPosition:"100"} as VerifiedReadReceipt;
  const request = {operation:cursor.operation,parameters:{limit:1},consistency:"project-strong",minimumEventPosition:"0",budgetMs:5000} as ListCanonicalRecordsRequest;
  for (const limit of [1,5,10]) assert.doesNotThrow(()=>assertNativeWorkflowMatchesRequest(content,{...request,parameters:{limit}},binding,receipt));
  assert.throws(()=>assertNativeWorkflowMatchesRequest({...content,nextCursor:impl.nextWorkflowCursor(bound,{id:"z",eventPosition:null})},request,binding,receipt),invalid);
  assert.throws(()=>assertNativeWorkflowMatchesRequest({...content,nextCursor:impl.encodeWorkflowCursor({...cursor,selectionHash:hash,imageSha256:"b".repeat(64)})},request,binding,receipt),stale);
});
