import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, renameSync, writeFileSync, existsSync, readdirSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ImmutableProjectionBuilder } from "../src/orchestrator/projections/builder.js";
import { V2ProjectionBuildCoordinator } from "../src/orchestrator/projections/coordinator.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import { SqliteProjectionEventReader, type ProjectionEventSnapshotV3 } from "../src/orchestrator/projections/event-reader.js";
import { ProjectionIntegrityService, assertUnpublishedProjectionV3Image } from "../src/orchestrator/projections/integrity.js";
import { assertCapturedProjectionV3Image, readCapturedProjectionV3Rows } from "../src/orchestrator/projections/captured-image-v3.js";
import { openImmutableProjectionImage } from "../src/orchestrator/projections/immutable-image.js";
import { projectionCoreChecksum } from "../src/orchestrator/projections/checksum.js";
import { parseProjectionManifestV3, parseProjectionManifestForPublication } from "../src/orchestrator/projections/manifest-codec.js";
import { FreshStartInitializer } from "../src/orchestrator/fresh-start/fresh-start-initializer.js";
import { freshInitializationFixture } from "./support/fresh-start-fixture.js";
import { makeGovernedNoteDomainFixture } from "./support/governed-note-domain-fixture.js";
import { acquireProjectionManifestPublicationLease } from "../src/orchestrator/projections/manifest.js";
import { filesystemStableProjectionDirectoryOperations as directoryOps } from "../src/orchestrator/projections/stable-directory.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";

const binding: ProjectBinding = { projectId:"1".repeat(64) as never, vaultId:"2".repeat(64) as never,
  storeId:"3".repeat(64) as never, workspaceId:"4".repeat(64) as never, branchScopeId:null, branchRef:null, sessionId:null };
const driver = new NodeSqliteDriver({DatabaseSync});
function empty(): ProjectionEventSnapshotV3 { return {binding,eventCount:0,aggregateBytes:0,terminalEventPosition:0n,
  terminalEventHash:"0".repeat(64),events:()=>[],dispositions:()=>[],close(){}}; }
function emptyReader() {return {openCommittedSnapshot:async()=>empty(),openCommittedSnapshotV3:async()=>empty()};}
const integrityFailure=/INTEGRITY_FAILURE/;
const literalBody="  # Literal e\u0301\r\n\t```text\r\nไทย 😀  \r\n```\n";
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function sourceBinding(f:Awaited<ReturnType<typeof makeGovernedNoteDomainFixture>>):ProjectBinding {
  const b=f.rootContext.binding;
  return {projectId:b.projectId,vaultId:b.vaultId,storeId:b.storeId,workspaceId:b.workspaceId,
    branchScopeId:f.rootContext.branchScopeId??null,branchRef:f.rootContext.workspace.kind==="git"?f.rootContext.workspace.branchRef:null,sessionId:null};
}

test("same_position_no_events_requires_schema3_generation",async()=>{
  const root=mkdtempSync(join(tmpdir(),"full-body-publication-"));
  try {
    const builder=new ImmutableProjectionBuilder({driver,projectionDirectory:root}),eventReader=emptyReader();
    const c=new V2ProjectionBuildCoordinator({builder,eventReader,projectionDirectory:root,schema3:{builder,eventReader}});
    const old=await c.ensurePublished(binding,0n,15000),bytes=readFileSync(old.databasePath);
    await assert.rejects(c.leasePublishedV3ForEvaluation(binding),{code:"PROJECTION_LEASE_UNAVAILABLE"});
    assert.equal(existsSync(join(root,".projection-manifest.publish.lock")),false);
    assert.equal(typeof c.ensurePublishedV3,"function","same-position schema3 publication must be available");
    const lease=await c.leasePublishedForEvaluation(binding);
    try {
      const published=await c.ensurePublishedV3(binding,0n,15000);
      assert.equal(published.manifest.schemaVersion,3);
      assert.equal(published.manifest.terminalEventPosition,old.manifest.terminalEventPosition);
      assert.equal(published.manifest.terminalEventHash,old.manifest.terminalEventHash);
      assert.notEqual(published.manifest.generation,old.manifest.generation);
      assert.match(published.manifest.databaseFile,/^projections-3-\d+\.sqlite$/);
      assert.deepEqual(readFileSync(old.databasePath),bytes);
      const modernLease=await c.leasePublishedV3ForEvaluation(binding);
      try {assert.equal(modernLease.manifest.schemaVersion,3);assert.equal(modernLease.database.prepare("SELECT count(*) AS n FROM governed_notes").get()!.n,0);}
      finally{modernLease.close();}
    }finally{lease.close();}
    await c.ensurePublishedV3(binding,0n,15000);
    assert.equal(existsSync(old.databasePath),false);
    assert.ok(readdirSync(root).some(name=>/^\.projections-2-retired-/.test(name)));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("owned_image_contains_and_checks_body_and_rejects_rehashed_tampering",async()=>{
  const f=await makeGovernedNoteDomainFixture(),root=mkdtempSync(join(tmpdir(),"body-image-"));
  try {
    const legacy=f.command({recordKind:"adr"});f.service().create(f.prepareCreate(legacy),f.rootContext);
    const command=f.commandV2({content:{format:"markdown",body:literalBody}});f.service().createV2(f.prepareCreateV2(command),f.rootContext);
    const b=sourceBinding(f),reader=new SqliteProjectionEventReader({driver,eventStorePath:f.retained.path});
    const builder=new ImmutableProjectionBuilder({driver,projectionDirectory:root});
    const c=new V2ProjectionBuildCoordinator({builder,eventReader:reader,projectionDirectory:root,schema3:{builder,eventReader:reader}});
    const published=await c.ensurePublishedV3(b,0n,15000),manifest=published.manifest;
    const bytes=readFileSync(published.databasePath),captured=openImmutableProjectionImage(bytes);
    try {
      assertCapturedProjectionV3Image(captured,manifest);
      const rows=readCapturedProjectionV3Rows(captured);
      assert.equal(rows.governedNotes.length,2);
      assert.equal(rows.governedNotes.find(row=>row.recordKind==="insight")!.body,literalBody);
      assert.deepEqual(Object.values(rows.governedNotes.find(row=>row.recordKind==="adr")!).filter(v=>v===null),[null,null,null]);
      assert.ok(rows.canonicalItems.every(row=>row.summary==="Raw é summary"));
      const independent=createHash("sha256").update("project-memory/projection-core/v1\n"+canonicalJson(["governedNotes",3,b.projectId,manifest.terminalEventPosition,rows.governedNotes])).digest("hex");
      assert.equal(manifest.coreChecksums.governedNotes,independent);
      assertUnpublishedProjectionV3Image(bytes,manifest.databaseFile,b);
      const integrity=new ProjectionIntegrityService({driver,eventStorePath:f.retained.path,projectionDirectory:root});
      assert.equal(integrity.verify(b,manifest).status,"passed");
      const source=await reader.openCommittedSnapshotV3(b);
      try{assert.equal(integrity.verifyCommittedSnapshot(b,manifest,source).status,"passed");}finally{source.close();}
      for(const mutation of ["body","missing","source-position","marker","schema","checksum-name"] as const){
        const tamperPath=join(root,"tampered.sqlite");writeFileSync(tamperPath,bytes);
        const db=new DatabaseSync(tamperPath);
        try{
          db.exec("PRAGMA foreign_keys=OFF");
          if(mutation==="body")db.exec("UPDATE governed_notes SET body='tampered' WHERE body IS NOT NULL");
          if(mutation==="missing")db.exec("DELETE FROM governed_notes WHERE body IS NOT NULL");
          if(mutation==="source-position")db.exec("UPDATE governed_notes SET source_event_position=1 WHERE body IS NOT NULL");
          if(mutation==="marker")db.exec("UPDATE canonical_items SET verification_method='generic' WHERE verification_method='governed-note-unverified-v2'");
          if(mutation==="schema")db.exec("CREATE TABLE extra_unchecked(body TEXT)");
          if(mutation==="checksum-name")db.exec("DELETE FROM projection_core_checksums WHERE projection_name='governedNotes'");
          // Recompute image SHA: refusal must reach table checksums or body/cross-row validation.
          const changed=readFileSync(tamperPath),rehash={...manifest,databaseSha256:hash(changed)};
          assert.notEqual(rehash.databaseSha256,manifest.databaseSha256);
          const image=openImmutableProjectionImage(changed);
          try{assert.throws(()=>assertCapturedProjectionV3Image(image,rehash),integrityFailure);}finally{image.close();}
          assert.throws(()=>assertUnpublishedProjectionV3Image(changed,manifest.databaseFile,b),integrityFailure);
          if(mutation==="body"){
            const row=db.prepare("SELECT project_id AS projectId,item_id AS itemId,record_kind AS recordKind,format,body,body_content_hash AS bodyContentHash,CAST(source_event_position AS TEXT) AS sourceEventPosition FROM governed_notes ORDER BY project_id COLLATE BINARY,item_id COLLATE BINARY").all();
            const checksum=projectionCoreChecksum("governedNotes",3,b.projectId,BigInt(manifest.terminalEventPosition),row as never);
            db.prepare("UPDATE projection_core_checksums SET checksum=? WHERE projection_name='governedNotes'").run(checksum);
            const again=readFileSync(tamperPath),image2=openImmutableProjectionImage(again);
            try{assert.throws(()=>assertCapturedProjectionV3Image(image2,{...manifest,databaseSha256:hash(again),coreChecksums:{...manifest.coreChecksums,governedNotes:checksum}}),integrityFailure);}finally{image2.close();}
          }
        }finally{db.close();}
      }
      assert.throws(()=>parseProjectionManifestForPublication({...manifest,databaseFile:manifest.databaseFile.replace("-3-","-2-")},b));
      const {governedNotes:_,...wrong}=manifest.coreChecksums;assert.throws(()=>parseProjectionManifestV3({...manifest,coreChecksums:wrong},b));
    }finally{captured.close();}
  }finally{rmSync(root,{recursive:true,force:true});await f.cleanup();}
});

test("legacy_genesis_schema3_rebuild_is_deterministic",async()=>{
  const f=freshInitializationFixture(),root=mkdtempSync(join(tmpdir(),"body-rebuild-"));
  try{
    const receipt=await new FreshStartInitializer(f.dependencies).initializeFresh(f.input);assert.equal("genesisVersion" in receipt,false);
    const journal=JSON.parse(readFileSync(f.journalPath,"utf8")),b=Object.fromEntries(["projectId","vaultId","storeId","workspaceId","branchScopeId","branchRef","sessionId"].map(key=>[key,journal.projection[key]])) as unknown as ProjectBinding;
    const reader=new SqliteProjectionEventReader({driver,eventStorePath:f.databasePath}),builder=new ImmutableProjectionBuilder({driver,projectionDirectory:root});
    const first=await reader.openCommittedSnapshotV3(b);
    let a;try{a=await builder.buildV3(first,1);}finally{first.close();}
    const second=await reader.openCommittedSnapshotV3(b);
    let z;try{z=await builder.buildV3(second,2);}finally{second.close();}
    assert.deepEqual(a.manifest.coreChecksums,z.manifest.coreChecksums);assert.equal(Object.keys(a.manifest.coreChecksums).length,9);
    assert.deepEqual(await new FreshStartInitializer().openExisting(f.input),receipt);
    await assert.rejects(builder.buildV3({...empty(),dispositions:undefined} as unknown as ProjectionEventSnapshotV3,3),integrityFailure);
  }finally{rmSync(root,{recursive:true,force:true});f.cleanup();}
});

for(const boundary of ["after-journal-reserved","after-store-published","after-projection-verified","after-receipt-installed"] as const){
  test(`new_private_schema3_initialization_resumes_recorded_profile_after_${boundary}`,async()=>{
    const f=freshInitializationFixture();
    try{
      await assert.rejects(new FreshStartInitializer({...f.dependencies,projectionSchemaVersion:3,faultInjector:{hit(at){if(at===boundary)throw Error("owned interruption");}}}).initializeFresh(f.input),{message:"owned interruption"});
      const journal=JSON.parse(readFileSync(f.journalPath,"utf8"));assert.equal(journal.version,2);assert.equal(journal.projectionSchemaVersion,3);
      if(boundary==="after-journal-reserved")assert.equal(journal.projection,null);
      await assert.rejects(new FreshStartInitializer({...f.dependencies,projectionSchemaVersion:2}).resumeInitialization(f.input),{code:"FRESH_START_JOURNAL_MISMATCH"});
      const receipt=await new FreshStartInitializer(f.dependencies).resumeInitialization(f.input);
      assert.equal("genesisVersion" in receipt&&receipt.genesisVersion,2);assert.equal("projectionSchemaVersion" in receipt&&receipt.projectionSchemaVersion,3);
      assert.equal(Object.keys(receipt.projectionChecksums).length,9);assert.equal(receipt.storeId,journal.identity.storeId);
      assert.deepEqual(await new FreshStartInitializer().openExisting(f.input),receipt);
      assert.equal(JSON.parse(readFileSync(f.journalPath,"utf8")).projection.schemaVersion,3);
      const connection=driver.open(f.databasePath,{mode:"read-only-existing",busyTimeoutMs:5000});
      try{assert.equal(connection.prepare("SELECT count(*) AS n FROM events").get()!.n,0n);}finally{connection.close();}
    }finally{f.cleanup();}
  });
}

test("schema3_orphan_uses_shared_floor_and_exact_profile_retirement",async()=>{
  const root=mkdtempSync(join(tmpdir(),"body-orphan-"));
  try{
    const builder=new ImmutableProjectionBuilder({driver,projectionDirectory:root}),reader=emptyReader();
    const orphan=await builder.buildV3(empty(),99);renameSync(orphan.temporaryDatabasePath,join(root,orphan.manifest.databaseFile));
    const c=new V2ProjectionBuildCoordinator({builder,eventReader:reader,projectionDirectory:root,schema3:{builder,eventReader:reader}});
    const result=await c.ensurePublishedV3(binding,0n,15000);assert.equal(result.manifest.generation,100);assert.equal(result.manifest.highestObservedGeneration,100);
    assert.equal(existsSync(join(root,orphan.manifest.databaseFile)),false);assert.ok(readdirSync(root).some(n=>/^\.projections-3-retired-/.test(n)));
    const journal=JSON.parse(readFileSync(join(root,"projection-reconciliation-v2.json"),"utf8"));assert.equal(journal.highestReservedGeneration,99);assert.equal(journal.retirements[0].state,"retired");
    await c.ensurePublishedV3(binding,0n,15000);assert.equal(JSON.parse(readFileSync(join(root,"projection-reconciliation-v2.json"),"utf8")).highestReservedGeneration,100);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("same_position_upgrade_deadline_releases_reusable_owner",async()=>{
  const root=mkdtempSync(join(tmpdir(),"body-deadline-"));
  try{
    let time=0;const builder=new ImmutableProjectionBuilder({driver,projectionDirectory:root}),reader=emptyReader();
    const c=new V2ProjectionBuildCoordinator({builder,eventReader:reader,projectionDirectory:root,now:()=>time,schema3:{builder,eventReader:reader}});
    const before=await c.ensurePublished(binding,0n,100);time=100;
    await assert.rejects(c.ensurePublishedV3(binding,0n,0),{code:"PROJECTION_LAG"});assert.equal(existsSync(join(root,".projection-manifest.publish.lock")),false);
    const result=await c.ensurePublishedV3(binding,0n,100);assert.equal(result.manifest.generation,before.manifest.generation+1);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("schema3_interrupted_install_retains_orphan_for_reconciliation",async()=>{
  const root=mkdtempSync(join(tmpdir(),"body-interrupted-"));
  try{
    const builder=new ImmutableProjectionBuilder({driver,projectionDirectory:root}),reader=emptyReader();
    const c=new V2ProjectionBuildCoordinator({builder,eventReader:reader,projectionDirectory:root,schema3:{builder,eventReader:reader},faultInjector:{hit(at){if(at==="after-v2-generation-install-before-manifest")throw Error("owned interruption");}}});
    await assert.rejects(c.ensurePublishedV3(binding,0n,15000),{message:"owned interruption"});assert.equal(existsSync(join(root,"projections-3-1.sqlite")),true);
    assert.equal(existsSync(join(root,"projection-manifest.json")),false);
    const restarted=new V2ProjectionBuildCoordinator({builder,eventReader:reader,projectionDirectory:root,schema3:{builder,eventReader:reader}});
    const recovered=await restarted.ensurePublishedV3(binding,0n,15000);
    assert.equal(recovered.manifest.generation,2);
    assert.equal(existsSync(join(root,"projections-3-1.sqlite")),false);
    assert.ok(readdirSync(root).some(name=>name.startsWith(".projections-3-retired-")));
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("schema3_capture_refuses_more_than_64MiB_before_reading",async()=>{
  const root=mkdtempSync(join(tmpdir(),"body-cap-"));
  try{
    const file=join(root,"projections-3-1.sqlite");writeFileSync(file,"");truncateSync(file,64*1024*1024+1);
    const lease=acquireProjectionManifestPublicationLease(root);
    try{assert.throws(()=>directoryOps.readGenerationImage(root,lease.directoryIdentity,lease.lockToken,"projections-3-1.sqlite"));}finally{lease.release(false);}
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("actual_encoded_checksum_and_source_declarations_keep_capacity_limits",async()=>{
  const row={body:"\t".repeat(65536)},rows=Array.from({length:257},()=>row);
  assert.ok(Buffer.byteLength(JSON.stringify(rows),"utf8")>32*1024*1024);
  assert.throws(()=>projectionCoreChecksum("governedNotes",3,binding.projectId,1n,rows),{message:"PROJECTION_CHECKSUM_INVALID"});
  const root=mkdtempSync(join(tmpdir(),"body-limits-"));
  try{
    const builder=new ImmutableProjectionBuilder({driver,projectionDirectory:root});
    for(const patch of [{eventCount:100001},{aggregateBytes:64*1024*1024+1}])await assert.rejects(builder.buildV3({...empty(),...patch},1),integrityFailure);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("interleaved_scopes_keep_global_attestation_and_filtered_owned_dispositions",async()=>{
  const root=mkdtempSync(join(tmpdir(),"body-scope-")),sourcePath=join(root,"events.sqlite"),projectionDirectory=join(root,"images");
  const source=new DatabaseSync(sourcePath);
  try{
    const { eventHash, payloadHash }=await import("../src/orchestrator/crypto/event-hash.js");
    const { PROJECT_MEMORY_APPLICATION_ID }=await import("../src/orchestrator/runtime/runtime-capabilities.js");
    source.exec(`PRAGMA journal_mode=WAL; PRAGMA application_id=${PROJECT_MEMORY_APPLICATION_ID};
      CREATE TABLE project_meta(singleton INTEGER PRIMARY KEY,project_id TEXT,vault_id TEXT,store_id TEXT) STRICT;
      CREATE TABLE command_dedup(project_id TEXT,command_id TEXT,idempotency_key TEXT,command_type TEXT) STRICT;`);
    source.prepare("INSERT INTO project_meta VALUES (1,?,?,?)").run(binding.projectId,binding.vaultId,binding.storeId);
    let previous="0".repeat(64),terminal="";
    for(let position=1;position<=3;position++){
      const payload={ignored:position},material={globalPosition:String(position),eventId:`00000000-0000-4000-8000-${String(position).padStart(12,"0")}`,
        projectId:binding.projectId,vaultId:binding.vaultId,storeId:binding.storeId,workspaceId:position===2?"9".repeat(64):binding.workspaceId,
        branchScopeId:null,branchRef:null,streamId:"project",streamType:"project",streamVersion:String(position),eventType:"IgnoredEvent",eventSchemaVersion:1,
        sessionId:null,parentSessionId:null,actorRole:"primary",agentId:"projection-test",clientInstanceId:"projection-client",
        correlationId:`00000000-0000-4000-9000-${String(position).padStart(12,"0")}`,causationId:null,
        commandId:`00000000-0000-4000-a000-${String(position).padStart(12,"0")}`,idempotencyKey:`scope/${position}`,commandEventIndex:0,
        occurredAt:"2026-10-09T00:00:00.000Z",recordedAt:"2026-10-09T00:00:00.000Z",visibilityScope:"project",confidence:"low",verificationStatus:"unverified",
        sourceRefs:[],evidenceRefs:[],evidenceDigests:[],payloadHash:payloadHash(payload),previousGlobalHash:previous};
      terminal=eventHash(material);
      const integer=new Set(["globalPosition","streamVersion","eventSchemaVersion","commandEventIndex"]);
      const arrays=new Set(["sourceRefs","evidenceRefs","evidenceDigests"]);
      const entries=Object.entries({...material,payloadJson:canonicalJson(payload),eventHash:terminal,lifecycleIntentJson:null}).map(([key,value])=>{
        let column=key.replace(/[A-Z]/g,char=>"_"+char.toLowerCase());if(arrays.has(key))column+="_json";
        return {column,type:integer.has(key)?"INTEGER":"TEXT",value:arrays.has(key)?canonicalJson(value):integer.has(key)?Number(value):value};
      });
      if(position===1)source.exec(`CREATE TABLE events(${entries.map(e=>`${e.column} ${e.type}`).join(",")}) STRICT`);
      source.prepare(`INSERT INTO events VALUES (${entries.map(()=>"?").join(",")})`).run(...entries.map(e=>e.value) as (string|number|null)[]);
      previous=terminal;
    }
    const reader=new SqliteProjectionEventReader({driver,eventStorePath:sourcePath}),builder=new ImmutableProjectionBuilder({driver,projectionDirectory});
    const checked=await reader.openCommittedSnapshotV3(binding);
    assert.equal(checked.eventCount,3);
    try{assert.deepEqual([...checked.dispositions()].map(x=>x.event.globalPosition),[1n,3n]);}finally{checked.close();}
    const c=new V2ProjectionBuildCoordinator({builder,eventReader:reader,projectionDirectory,schema3:{builder,eventReader:reader}});
    const published=await c.ensurePublishedV3(binding,3n,15000);assert.equal(published.manifest.terminalEventPosition,"3");assert.equal(published.manifest.terminalEventHash,terminal);
    const committed=await reader.openCommittedSnapshotV3(binding);
    try{assert.equal(new ProjectionIntegrityService({driver,eventStorePath:sourcePath,projectionDirectory}).verifyCommittedSnapshot(binding,published.manifest,committed).status,"passed");}finally{committed.close();}
    assert.equal(new ProjectionIntegrityService({driver,eventStorePath:sourcePath,projectionDirectory}).verify(binding,published.manifest).status,"passed");
    // Actual stored UTF-8 row exceeds 1 MiB, refused by preflight before decoding an invalid payload.
    source.prepare("UPDATE events SET payload_json=? WHERE global_position=1").run(JSON.stringify({padding:"x".repeat(1024*1024)}));
    assert.ok(Number(source.prepare("SELECT length(CAST(payload_json AS BLOB)) AS n FROM events WHERE global_position=1").get()!.n)>1024*1024);
    await assert.rejects(reader.openCommittedSnapshotV3(binding),integrityFailure);
  }finally{source.close();rmSync(root,{recursive:true,force:true});}
});


test("schema3_capture_counts_exact_canonical_array_bytes_at_32MiB",async()=>{
  const { PROJECTION_SCHEMA_SQL_V3 }=await import("../src/orchestrator/projections/schema.js");
  const db=new DatabaseSync(":memory:");
  try{
    db.exec(PROJECTION_SCHEMA_SQL_V3);
    db.exec("PRAGMA foreign_keys=OFF");
    // This serializer oracle deliberately isolates row packing from relational admission.
    const coreBytes=Object.values(readCapturedProjectionV3Rows(db)).reduce((n,rows)=>n+Buffer.byteLength(JSON.stringify(rows),"utf8"),0)-2;
    const rows=Array.from({length:256},(_,index)=>({projectId:binding.projectId,
      itemId:`00000000-0000-4000-8000-${String(index).padStart(12,"0")}`,recordKind:"insight",format:"markdown",
      body:index===255?"":"x"+"\t".repeat(65535),bodyContentHash:"a".repeat(64),sourceEventPosition:"1"}));
    const limit=32*1024*1024;
    const remaining=limit-coreBytes-Buffer.byteLength(JSON.stringify(rows),"utf8");
    assert.ok(remaining>0&&remaining<=65536);
    rows[255]!.body="x".repeat(remaining);
    assert.equal(coreBytes+Buffer.byteLength(JSON.stringify(rows),"utf8"),limit);
    const insert=db.prepare("INSERT INTO governed_notes VALUES(?,?,?,?,?,?,?)");
    for(const row of rows)insert.run(row.projectId,row.itemId,row.recordKind,row.format,row.body,row.bodyContentHash,1);
    const captured=readCapturedProjectionV3Rows(db);
    assert.equal(Object.values(captured).reduce((n,value)=>n+Buffer.byteLength(JSON.stringify(value),"utf8"),0),limit);
    db.prepare("UPDATE governed_notes SET body=body||'x' WHERE item_id=?").run(rows[255]!.itemId);
    assert.throws(()=>readCapturedProjectionV3Rows(db),integrityFailure);
  }finally{db.close();}
});

test("schema3_ambiguous_manifest_observation_retains_publication_evidence",async()=>{
  const root=mkdtempSync(join(tmpdir(),"body-ambiguous-"));
  try{
    const builder=new ImmutableProjectionBuilder({driver,projectionDirectory:root}),reader=emptyReader();
    const c=new V2ProjectionBuildCoordinator({builder,eventReader:reader,projectionDirectory:root,schema3:{builder,eventReader:reader},
      faultInjector:{hit(at){if(at==="after-manifest-replace-before-validation"){
        writeFileSync(join(root,"projection-manifest.json"),"unreadable retained evidence");
        throw Error("owned ambiguity");
      }}}});
    await assert.rejects(c.ensurePublishedV3(binding,0n,15000));
    assert.equal(existsSync(join(root,"projections-3-1.sqlite")),true);
    assert.equal(existsSync(join(root,".projection-manifest.publish.lock")),true);
    assert.equal(readFileSync(join(root,"projection-manifest.json"),"utf8"),"unreadable retained evidence");
    await assert.rejects(c.ensurePublishedV3(binding,0n,15000));
  }finally{rmSync(root,{recursive:true,force:true});}
});
