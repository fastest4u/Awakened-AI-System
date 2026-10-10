import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as folds from "../src/orchestrator/projections/folds.js";
import * as schemas from "../src/orchestrator/projections/schema.js";
import * as checksums from "../src/orchestrator/projections/checksum.js";
import { PROJECTION_NAMES_V1 } from "../src/orchestrator/projections/manifest-codec.js";
import { SqliteProjectionEventReader, replayCommittedProjectionSources } from "../src/orchestrator/projections/event-reader.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { payloadHash } from "../src/orchestrator/crypto/event-hash.js";
import { governedNoteBodyHash } from "../src/orchestrator/governed-notes/body-content.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import { decodeProjectionEvent } from "../src/orchestrator/projections/source-event-codec.js";
import type { ProjectionFoldState, CanonicalItemProjection } from "../src/orchestrator/projections/contracts.js";
import type { GovernedNotePrior } from "../src/orchestrator/governed-notes/pair-validation.js";
import type { StoredEvent } from "../src/orchestrator/contracts/event.js";
import { GovernedNoteRepository } from "../src/orchestrator/governed-notes/repository.js";
import { makeGovernedNoteDomainFixture } from "./support/governed-note-domain-fixture.js";

type SideRow = Readonly<{projectId:string; itemId:string; recordKind:string; format:string|null; body:string|null; bodyContentHash:string|null; sourceEventPosition:string}>;
type State = Omit<ProjectionFoldState,"schemaVersion"> & {schemaVersion:3; governedNotes:readonly SideRow[]};
type Disposition = {event:StoredEvent; governedNotePrior:GovernedNotePrior|null};
function api() {
  const candidate = folds as unknown as {
    ProjectionFoldAccumulatorV3: new()=>{append(source:Disposition):void;finish():State};
    validateGovernedNoteProjectionRows(items:readonly CanonicalItemProjection[],rows:readonly SideRow[],terminal:bigint|null):readonly SideRow[];
  };
  assert.equal(typeof candidate.ProjectionFoldAccumulatorV3,"function","schema3 authenticated source fold is required");
  assert.equal(typeof candidate.validateGovernedNoteProjectionRows,"function","schema3 cross-table integrity is required");
  return candidate;
}
const safeFailure = {message:"INTEGRITY_FAILURE"};
const literalBody = "  # Literal e\u0301\r\n\t```text\r\nไทย 😀  \r\n```\n";

test("authenticated_v1_kind_and_v2_body_fold", async () => {
  const {ProjectionFoldAccumulatorV3} = api();
  const fixture = await makeGovernedNoteDomainFixture();
  try {
    for (const kind of ["session-log","insight","mistake","adr"] as const) {
      for (const version of [1,2] as const) {
        const command = version === 1 ? fixture.command({recordKind:kind}) : fixture.commandV2({recordKind:kind,content:{format:"markdown",body:literalBody}});
        if(command.version===1) fixture.service().create(fixture.prepareCreate(command),fixture.rootContext);
        else fixture.service().createV2(fixture.prepareCreateV2(command),fixture.rootContext);
        const prior = new GovernedNoteRepository(fixture.connection).findGovernedNotePriorAny(command.commandId,command.idempotencyKey)!;
        const fold = new ProjectionFoldAccumulatorV3();
        fold.append({event:prior.events[0],governedNotePrior:prior});
        assert.equal(fold.finish().canonicalItems.length,0,"Created is validated and unprojected");
        fold.append({event:{...prior.events[1],payload:{untrusted:"cache"}},governedNotePrior:prior});
        const state=fold.finish(), row=state.governedNotes[0]!;
        assert.equal(row.recordKind,kind);
        assert.equal(row.sourceEventPosition,prior.events[1].globalPosition.toString());
        assert.equal(typeof row.sourceEventPosition,"string");
        assert.deepEqual([row.format,row.body,row.bodyContentHash],version===1?[null,null,null]:["markdown",literalBody,prior.witness.witnessVersion===2?prior.witness.bodyContentHash:null]);
        assert.equal(state.lexicalChunks[0]!.text,"Raw é summary");
        assert.equal(Object.hasOwn(state.canonicalItems[0]!,"content"),false);
        if(version===1){
          const decoded=decodeProjectionEvent(prior.events[1]); assert.equal(decoded.kind,"projected");
          const old=new folds.ProjectionFoldAccumulator();if(decoded.kind==="projected")old.append(decoded.event);
          assert.deepEqual(state.canonicalItems,old.finish().canonicalItems);
          assert.deepEqual(state.lexicalChunks,old.finish().lexicalChunks);
        }
        assert.throws(()=>new ProjectionFoldAccumulatorV3().append({event:prior.events[1],governedNotePrior:null}),safeFailure);
        assert.throws(()=>new ProjectionFoldAccumulatorV3().append({event:prior.events[1],governedNotePrior:{...prior,witness:{...prior.witness,recordKind:kind==="adr"?"mistake":"adr"}} as GovernedNotePrior}),safeFailure);
        assert.throws(()=>new ProjectionFoldAccumulatorV3().append({event:{...prior.events[1],eventHash:"0".repeat(64)},governedNotePrior:prior}),safeFailure);
        assert.throws(()=>new ProjectionFoldAccumulatorV3().append({event:prior.events[0],governedNotePrior:null}),safeFailure);
        for(const patch of [{verificationMethod:"governed-note-unverified-v9"},{normalizedKey:"generic/key"},{normalizedKey:null},{recordKind:"unknown"}]){
          const payload=JSON.parse(prior.events[1].payloadJson);Object.assign(payload.item,patch);
          const mutated={...prior.events[1],payloadJson:canonicalJson(payload),payloadHash:payloadHash(payload)};
          assert.throws(()=>new ProjectionFoldAccumulatorV3().append({event:mutated,governedNotePrior:prior}),safeFailure);
          assert.throws(()=>new ProjectionFoldAccumulatorV3().append({event:mutated,governedNotePrior:null}),safeFailure);
        }
        assert.throws(()=>fold.append({event:prior.events[1],governedNotePrior:prior}),safeFailure);
      }
    }
    const b = fixture.rootContext.binding;
    const binding:ProjectBinding={projectId:b.projectId,vaultId:b.vaultId,storeId:b.storeId,workspaceId:b.workspaceId,branchScopeId:fixture.rootContext.branchScopeId??null,branchRef:fixture.rootContext.workspace.kind==="git"?fixture.rootContext.workspace.branchRef:null,sessionId:null};
    const options={driver:new NodeSqliteDriver({DatabaseSync}),eventStorePath:fixture.retained.path};
    const reader=new SqliteProjectionEventReader(options);
    const snapshot=await reader.openCommittedSnapshotV3(binding);
    const sources=[...snapshot.dispositions()];
    assert.throws(()=>snapshot.events(),safeFailure);
    assert.throws(()=>snapshot.dispositions(),safeFailure);
    snapshot.close();
    assert.equal(sources.filter(source=>source.governedNotePrior!==null).length,16);
    assert.ok(sources.every(source=>Object.keys(source.event.payload as object).length===0));
    const replayed:bigint[]=[];
    const replayResult=replayCommittedProjectionSources(binding,{...options,terminalEventPosition:snapshot.terminalEventPosition},source=>replayed.push(source.event.globalPosition));
    assert.deepEqual(replayed,sources.map(source=>source.event.globalPosition));
    assert.equal(replayResult.terminalEventHash,snapshot.terminalEventHash);
    const full=new ProjectionFoldAccumulatorV3();
    for(const source of sources)full.append(source);
    assert.equal(full.finish().governedNotes.length,8);
    const closed=await reader.openCommittedSnapshotV3(binding);
    const iterator=closed.dispositions()[Symbol.iterator]();
    iterator.next();closed.close();assert.throws(()=>iterator.next(),safeFailure);
    const eventsOnly=await reader.openCommittedSnapshotV3(binding);
    const events=eventsOnly.events();assert.throws(()=>eventsOnly.dispositions(),safeFailure);
    assert.equal([...events].length,sources.length);eventsOnly.close();
  } finally {await fixture.cleanup();}
});

function rowFixture() {
  const projectId="a".repeat(64), itemId="00000000-0000-4000-8000-000000000001";
  const side:SideRow={projectId,itemId,recordKind:"insight",format:null,body:null,bodyContentHash:null,sourceEventPosition:"9007199254740993"};
  const item:CanonicalItemProjection={projectId:projectId as never,itemId,sessionId:null,normalizedKey:`governed-note/insight/${itemId}`,status:"candidate",confidence:"low",verificationMethod:"governed-note-unverified-v1",validFrom:"2026-10-09T00:00:00.000Z",validTo:null,summary:"Summary",contentHash:"b".repeat(64),conflictGroupId:null,supersedingItemId:null,knownFromEventPosition:9007199254740993n,sourceEventId:"00000000-0000-4000-8000-000000000002",sourceEventPosition:9007199254740993n,anchor:null};
  return {side,item};
}
test("schema3_checksum_rows_are_canonical",()=>{
  const {validateGovernedNoteProjectionRows:validate}=api(), {side,item}=rowFixture();
  const second={...side,projectId:"0".repeat(64)},secondItem={...item,projectId:second.projectId as never};
  const rows=validate([item,secondItem],[side,second],9007199254740993n);
  assert.deepEqual(rows.map(row=>[row.projectId,row.itemId]),[[second.projectId,second.itemId],[side.projectId,side.itemId]]);
  assert.deepEqual(Object.keys(rows[0]!).sort(),["projectId","itemId","recordKind","format","body","bodyContentHash","sourceEventPosition"].sort());
  const expected=createHash("sha256").update('project-memory/projection-core/v1\n'+JSON.stringify(["governedNotes",3,side.projectId,"9007199254740993",rows.map(row=>Object.fromEntries(Object.entries(row).sort(([a],[b])=>a<b?-1:a>b?1:0)))])).digest("hex");
  assert.equal(checksums.projectionCoreChecksum("governedNotes" as never,3,side.projectId,9007199254740993n,rows),expected);
  assert.throws(()=>checksums.projectionCoreChecksum("governedNotes" as never,2,side.projectId,1n,[]),{message:"PROJECTION_CHECKSUM_INVALID"});
});

test("side_table_integrity_precedes_absence",()=>{
  const {validateGovernedNoteProjectionRows:validate}=api(),{side,item}=rowFixture(),terminal=item.sourceEventPosition;
  assert.deepEqual(validate([item],[side],terminal),[side]);
  for(const rows of [[],[side,side],[{...side,itemId:"00000000-0000-4000-8000-000000000099"}],[{...side,recordKind:"unknown"}],[{...side,format:"markdown"}],[{...side,sourceEventPosition:"0"}],[{...side,sourceEventPosition:"9007199254740992"}]]) assert.throws(()=>validate([item],rows,terminal),safeFailure);
  for(const changed of [{...item,verificationMethod:"generic"},{...item,normalizedKey:"generic/key"},{...item,verificationMethod:"governed-note-unverified-v9"}]) assert.throws(()=>validate([changed],[side],terminal),safeFailure);
  assert.throws(()=>validate([{...item,verificationMethod:"governed-note-unverified-v2"}],[],terminal),safeFailure);
  assert.deepEqual(validate([{...item,verificationMethod:"generic",normalizedKey:"generic/key"}],[],terminal),[]);
  const modern={...item,verificationMethod:"governed-note-unverified-v2"};
  const bodyRow={...side,format:"markdown",body:literalBody,bodyContentHash:governedNoteBodyHash({format:"markdown",body:literalBody})};
  assert.deepEqual(validate([modern],[bodyRow],terminal),[bodyRow]);
  for(const patch of [{body:null},{bodyContentHash:null},{format:null},{bodyContentHash:"A".repeat(64)},{bodyContentHash:"0".repeat(64)},{body:" "},{body:"bad\u0000"},{body:"x".repeat(65537)},{body:"\ud800"},{body:"changed"},{sourceEventPosition:"9223372036854775808"},{sourceEventPosition:"09007199254740993"}])assert.throws(()=>validate([modern],[{...bodyRow,...patch}],terminal),safeFailure);
  for(const malformed of [{...item,normalizedKey:"governed-note/invalid"},{...modern,normalizedKey:"generic/key"},{...item,verificationMethod:"governed-note-unverified-v9",normalizedKey:"generic/key"}])assert.throws(()=>validate([malformed],[],terminal),safeFailure);
  let calls=0;const accessor={...side};Object.defineProperty(accessor,"body",{enumerable:true,get(){calls++;return null;}});
  assert.throws(()=>validate([item],[accessor],terminal),safeFailure);assert.equal(calls,0);
  assert.throws(()=>validate([item],[new Proxy(side,{})],terminal),safeFailure);
});

test("frozen_historical_profiles",()=>{
  const sql=(schemas as unknown as {PROJECTION_SCHEMA_SQL_V3:string}).PROJECTION_SCHEMA_SQL_V3;
  assert.equal(typeof sql,"string","schema3 SQL profile is required");
  const db=new DatabaseSync(":memory:");
  try {
    db.exec(sql);db.exec("PRAGMA foreign_keys=ON");
    assert.equal(db.prepare("SELECT schema_version FROM projection_metadata").get()!.schema_version,3);
    assert.equal(db.prepare("SELECT count(*) AS n FROM governed_notes").get()!.n,0);
    const {side}=rowFixture();
    db.prepare("INSERT INTO canonical_items(project_id,item_id,normalized_key,status,confidence,verification_method,valid_from,summary,content_hash,known_from_event_position,source_event_id,source_event_position) VALUES (?,?,?,'candidate','low','governed-note-unverified-v1','2026-10-09T00:00:00.000Z','Summary',?,1,?,1)").run(side.projectId,side.itemId,`governed-note/insight/${side.itemId}`,"b".repeat(64),side.itemId);
    const insert=db.prepare("INSERT INTO governed_notes VALUES (?,?,?,?,?,?,?)");
    // Each CHECK oracle starts without a side row, with its valid FK parent present.
    for(const tuple of [["unknown",null,null,null,1],["insight","markdown",null,null,1],["insight",null,"body",null,1],["insight","markdown","body","invalid",1],["insight",null,null,null,0]])assert.throws(()=>insert.run(side.projectId,side.itemId,...tuple as [string,string|null,string|null,string|null,number]),/CHECK constraint failed/);
    assert.throws(()=>insert.run(side.projectId,"00000000-0000-4000-8000-000000000099","insight",null,null,null,1),/FOREIGN KEY constraint failed/);
    insert.run(side.projectId,side.itemId,"insight",null,null,null,1);
    assert.throws(()=>insert.run(side.projectId,side.itemId,"insight",null,null,null,1),/UNIQUE constraint failed/);
    db.prepare("INSERT INTO projection_core_checksums VALUES ('governedNotes',?)").run("b".repeat(64));
  }finally{db.close();}
  assert.equal(schemas.PROJECTION_SCHEMA_VERSION,2);
  assert.deepEqual((checksums as unknown as {PROJECTION_NAMES_V2:unknown}).PROJECTION_NAMES_V2,checksums.PROJECTION_NAMES);
  assert.deepEqual((checksums as unknown as {PROJECTION_NAMES_V3:unknown}).PROJECTION_NAMES_V3,[...checksums.PROJECTION_NAMES,"governedNotes"]);
  assert.equal(PROJECTION_NAMES_V1.includes("retrievalFeedback"),true);
});
