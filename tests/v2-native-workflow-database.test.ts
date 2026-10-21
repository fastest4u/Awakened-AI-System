import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { PROJECTION_SCHEMA_SQL_V2 } from "../src/orchestrator/projections/schema.js";
import type { ProjectionManifestV2 } from "../src/orchestrator/projections/manifest-codec.js";
import type { RetrievalEligibilityContext, RetrievalItem } from "../src/orchestrator/retrieval/contracts.js";
import { READ_HASH, READ_UUID, readScope } from "./support/v2-verified-read-fixture.js";

type Key = { id: string; eventPosition: bigint | null };
type CanonicalPage = { items: readonly { item: RetrievalItem; eligibleConflictMemberCount: number | null }[]; hasMore: boolean };
type FollowPage = { items: readonly RetrievalItem[]; hasMore: boolean };
async function api() {
  const mod = await import("../src/orchestrator/retrieval/database-core.js") as unknown as Record<string, unknown>;
  assert.equal(typeof mod.collectCanonicalPageFromProjectionDatabase, "function", "fixed canonical keyset API is missing");
  assert.equal(typeof mod.collectFollowUpPageFromProjectionDatabase, "function", "query-free trusted session follow-up API is missing");
  return mod as unknown as {
    collectCanonicalPageFromProjectionDatabase(db: DatabaseSync, manifest: ProjectionManifestV2, ctx: RetrievalEligibilityContext & { order: "id" | "event"; limit: number; after: Key | null }): CanonicalPage;
    collectFollowUpPageFromProjectionDatabase(db: DatabaseSync, manifest: ProjectionManifestV2, ctx: RetrievalEligibilityContext & { limit: number; after: Key | null }): FollowPage;
  };
}
function fixture() {
  const db = new DatabaseSync(":memory:"); db.exec(PROJECTION_SCHEMA_SQL_V2);
  const scope = readScope() as RetrievalEligibilityContext["binding"];
  const manifest = { ...scope, schemaVersion: 2, generation: 1, terminalEventPosition: "100", terminalEventHash: READ_HASH,
    databaseFile: "owned.sqlite", databaseSha256: READ_HASH, coreChecksums: {}, createdAt: "2026-10-01T00:00:00.000Z" } as ProjectionManifestV2;
  db.prepare(`UPDATE projection_metadata SET project_id=?,vault_id=?,store_id=?,workspace_id=?,generation=1,
    terminal_event_position=100,terminal_event_hash=?,created_at=? WHERE singleton=1`)
    .run(scope.projectId, scope.vaultId, scope.storeId, scope.workspaceId, READ_HASH, manifest.createdAt);
  const context = { binding: scope, sessionId: READ_UUID };
  function canonical(id: string, position = 20, changes: {project?: string; session?: string; status?: string; known?: number; from?: string; to?: string; group?: string} = {}) {
    db.prepare(`INSERT INTO canonical_items(project_id,session_id,item_id,normalized_key,status,confidence,verification_method,valid_from,valid_to,
      summary,content_hash,known_from_event_position,source_event_id,source_event_position,conflict_group_id) VALUES(?,?,?,?,?,'high','event',?,?,?, ?,?,'event',?,?)`)
      .run(changes.project ?? scope.projectId, changes.session ?? null, id, id, changes.status ?? "verified", changes.from ?? "2026-01-01T00:00:00.000Z",
        changes.to ?? null, "unrelated summary", READ_HASH, changes.known ?? 1, position, changes.group ?? null);
  }
  function follow(id: string, position = 20, session = READ_UUID, status = "open", project: string = scope.projectId) {
    db.prepare(`INSERT INTO tasks_followups(project_id,session_id,follow_up_id,status,summary,confidence,source_event_id,source_event_position)
      VALUES(?,?,?,?, 'no query matches here','high','event',?)`).run(project,session,id,status,position);
  }
  return { db, manifest, context, canonical, follow };
}
// Break caught: locale ordering, OFFSET traversal, historical duplicates or a SQL bound above limit+1.
test("canonical_binary_and_latest_state_keysets", async () => {
  const impl = await api(); const f = fixture();
  try {
    const expectedIds = ["A", "B", "Z", "a", "b", "c", "d", "e", "f", "g", "h", "é"];
    for (const id of [...expectedIds].reverse()) f.canonical(id);
    const observed: {sql: string; parameters: unknown; count: number}[] = [];
    const prepare = f.db.prepare.bind(f.db);
    f.db.prepare = ((sql: string) => {
      const statement = prepare(sql); const all = statement.all.bind(statement);
      statement.all = ((...args: Parameters<typeof all>) => { const rows = all(...args); observed.push({ sql, parameters: args[0], count: rows.length }); return rows; }) as typeof statement.all;
      return statement;
    }) as typeof f.db.prepare;
    const first = impl.collectCanonicalPageFromProjectionDatabase(f.db,f.manifest,{...f.context,order:"id",limit:5,after:null});
    assert.deepEqual(first.items.map(row => row.item.id),expectedIds.slice(0,5)); assert.equal(first.hasMore,true);
    for (const limit of [1,5,10]) {
      const ids: string[] = []; let after: Key | null = null; let final: CanonicalPage;
      do { final = impl.collectCanonicalPageFromProjectionDatabase(f.db,f.manifest,{...f.context,order:"id",limit,after});
        ids.push(...final.items.map(row=>row.item.id)); const last = final.items.at(-1)?.item; after = last ? {id:last.id,eventPosition:null}:null;
      } while(final.hasMore);
      assert.deepEqual(ids,expectedIds); assert.equal(final.hasMore,false);
    }
    f.db.prepare = prepare;
    for (const call of observed.filter(call=>/FROM canonical_items AS item/.test(call.sql))) {
      assert.ok(!/OFFSET|instr\(/i.test(call.sql)); assert.match(call.sql,/LIMIT \$pageLimit/);
      const params = call.parameters as Record<string, number>; assert.ok(params.$pageLimit<=11); assert.ok(call.count<=params.$pageLimit);
    }
    f.db.prepare("UPDATE canonical_items SET source_event_position=30 WHERE item_id='a'").run();
    const recent = impl.collectCanonicalPageFromProjectionDatabase(f.db,f.manifest,{...f.context,order:"event",limit:10,after:null});
    assert.deepEqual(recent.items.map(row=>row.item.id),["a","A","B","Z","b","c","d","e","f","g"]);
    const last = recent.items.at(-1)!.item;
    const final = impl.collectCanonicalPageFromProjectionDatabase(f.db,f.manifest,{...f.context,order:"event",limit:10,after:{id:last.id,eventPosition:last.sourceEventPosition}});
    assert.deepEqual(final.items.map(row=>row.item.id),["h","é"]); assert.equal(final.hasMore,false);
    assert.equal([...recent.items,...final.items].filter(row=>row.item.id==="a").length,1);
    for (const limit of [1,5,10]) {
      const ids: string[]=[]; let after: Key|null=null; let page:CanonicalPage;
      do {
        page=impl.collectCanonicalPageFromProjectionDatabase(f.db,f.manifest,{...f.context,order:"event",limit,after});
        ids.push(...page.items.map(row=>row.item.id)); const last=page.items.at(-1)?.item;
        after=last?{id:last.id,eventPosition:last.sourceEventPosition}:null;
      } while(page.hasMore);
      assert.deepEqual(ids,["a","A","B","Z","b","c","d","e","f","g","h","é"]);
    }
  } finally { f.db.close(); }
});
// Break caught: substring dependence, session leakage, ignoring eligibility, or swallowing corrupt/schema errors as empty.
test("query_free_session_radar_and_corrupt_rows", async () => {
  const impl = await api(); const f = fixture();
  try {
    for (const id of ["b","A","a"]) f.follow(id,20,READ_UUID,id==="a"?"blocked":"open");
    f.follow("foreign",30,"22222222-2222-4222-8222-222222222222"); f.follow("done",30,READ_UUID,"completed");
    f.follow("project",30,READ_UUID,"open","22222222-2222-4222-8222-222222222222"); f.follow("future",101);
    const first = impl.collectFollowUpPageFromProjectionDatabase(f.db,f.manifest,{...f.context,limit:1,after:null});
    assert.deepEqual(first.items.map(row=>row.id),["A"]); assert.equal(first.hasMore,true);
    const final = impl.collectFollowUpPageFromProjectionDatabase(f.db,f.manifest,{...f.context,limit:5,after:{id:"A",eventPosition:20n}});
    assert.deepEqual(final.items.map(row=>row.id),["a","b"]); assert.equal(final.hasMore,false);
    for (const limit of [1,5,10]) {
      const ids:string[]=[]; let after:Key|null=null; let page:FollowPage;
      do {
        page=impl.collectFollowUpPageFromProjectionDatabase(f.db,f.manifest,{...f.context,limit,after});
        ids.push(...page.items.map(row=>row.id)); const last=page.items.at(-1);
        after=last?{id:last.id,eventPosition:last.sourceEventPosition}:null;
      } while(page.hasMore);
      assert.deepEqual(ids,["A","a","b"]); assert.equal(page.hasMore,false);
    }
    for (const context of [{binding:f.context.binding},{...f.context,visibility:"branch" as const},{...f.context,knownAt:19n}])
      assert.deepEqual(impl.collectFollowUpPageFromProjectionDatabase(f.db,f.manifest,{...context,limit:10,after:null}).items,[]);
    f.canonical("visible",20); f.canonical("foreign",20,{session:"22222222-2222-4222-8222-222222222222"});
    f.canonical("expired",20,{status:"expired"}); f.canonical("future",101); f.canonical("time",20,{from:"2027-01-01T00:00:00.000Z"});
    const visible = impl.collectCanonicalPageFromProjectionDatabase(f.db,f.manifest,{...f.context,validAt:"2026-10-01T00:00:00.000Z",order:"id",limit:10,after:null});
    assert.deepEqual(visible.items.map(row=>row.item.id),["visible"]);
    for (const limit of [0,11,1.5]) assert.throws(()=>impl.collectCanonicalPageFromProjectionDatabase(f.db,f.manifest,{...f.context,order:"id",limit,after:null}));
    assert.throws(()=>impl.collectCanonicalPageFromProjectionDatabase(f.db,{...f.manifest,schemaVersion:1} as unknown as ProjectionManifestV2,{...f.context,order:"id",limit:5,after:null}));
    f.db.exec("PRAGMA ignore_check_constraints=ON; UPDATE tasks_followups SET confidence='invalid' WHERE follow_up_id='A'");
    assert.throws(()=>impl.collectFollowUpPageFromProjectionDatabase(f.db,f.manifest,{...f.context,limit:5,after:null}),{code:"RETRIEVAL_PROJECTION_INVALID"});
    f.db.exec("DROP TABLE tasks_followups");
    assert.throws(()=>impl.collectFollowUpPageFromProjectionDatabase(f.db,f.manifest,{binding:f.context.binding,limit:5,after:null}),{code:"RETRIEVAL_PROJECTION_INVALID"});
  } finally { f.db.close(); }
});


// Break caught: synthetic acknowledgements or checkpoint corpus diverging from the committed projection/admission contract.
test("workflow_fixture_committed_corpus_and_admission", async () => {
  const impl = await api();
  const { makeNativeWorkflowFixture, nativeWorkflowRequest, nativeWorkflowReceipt, nativeWorkflowSuccessBase } = await import("./support/v2-native-workflow-fixture.js");
  const f = await makeNativeWorkflowFixture(undefined,{session:{sessionId:READ_UUID,minimumEventPosition:"0"}});
  try {
    const corpus = await f.appendWorkflowCorpus({canonicalCount:12,followUpCount:12,matchingFollowUps:false});
    await f.publish(); const image = f.captureImage();
    try {
      const page=impl.collectCanonicalPageFromProjectionDatabase(image.database,image.manifest,{binding:f.binding.projectionBinding,sessionId:READ_UUID,order:"id",limit:10,after:null});
      assert.deepEqual(page.items.map(row=>row.item.id),[...corpus.canonicalIds].sort().slice(0,10)); assert.equal(page.hasMore,true);
      const follow=impl.collectFollowUpPageFromProjectionDatabase(image.database,image.manifest,{binding:f.binding.projectionBinding,sessionId:READ_UUID,limit:10,after:null});
      assert.equal(follow.items.length,10); assert.equal(follow.hasMore,true); assert.ok(follow.items.every(row=>corpus.followUpIds.includes(row.id)&&!row.summary.includes("native")));
      const request = nativeWorkflowRequest("follow-up-radar"); const receipt=nativeWorkflowReceipt(f,request,image.manifest);
      assert.equal(receipt.scope.sessionId,null); assert.equal(receipt.projectionEventPosition,image.manifest.terminalEventPosition);
      assert.equal(nativeWorkflowSuccessBase(f,request,image.manifest).fence.requiredPosition,receipt.requiredEventPosition);
    } finally { image.close(); }
  } finally { f.cleanup(); }
});


// Break caught: conflict counts gaining hidden scope or accepting anchors that broaden or escape the selected image.
test("canonical_scoped_conflict_counts_and_anchor_boundaries", async () => {
  const impl=await api(); const f=fixture();
  try {
    const group=READ_UUID;
    for (const [id,status] of [["a","candidate"],["b","provisional"],["c","verified"],["d","conflicted"],["e","superseded"]])
      f.canonical(id,20,{status,group});
    f.canonical("hidden-session",20,{session:"22222222-2222-4222-8222-222222222222",group});
    f.canonical("hidden-project",20,{project:"22222222-2222-4222-8222-222222222222",group});
    f.canonical("hidden-time",20,{from:"2027-01-01T00:00:00.000Z",group});
    for(const status of ["retracted","expired","erased-evidence"]) f.canonical(status,20,{status,group});
    const context={...f.context,order:"id" as const,limit:5,after:null,validAt:"2026-10-01T00:00:00.000Z"};
    const page=impl.collectCanonicalPageFromProjectionDatabase(f.db,f.manifest,context);
    assert.deepEqual(page.items.map(row=>row.item.status),["candidate","provisional","verified","conflicted","superseded"]);
    assert.deepEqual(page.items.map(row=>row.eligibleConflictMemberCount),[5,5,5,5,5]); assert.equal(page.hasMore,false);
    for(const after of [{id:"",eventPosition:null},{id:"\ud800",eventPosition:null},{id:"x".repeat(2049),eventPosition:null},{id:"a",eventPosition:1n}])
      assert.throws(()=>impl.collectCanonicalPageFromProjectionDatabase(f.db,f.manifest,{...context,after}),{code:"RETRIEVAL_REQUEST_INVALID"});
    for(const eventPosition of [null,-1n,101n,9223372036854775808n])
      assert.throws(()=>impl.collectCanonicalPageFromProjectionDatabase(f.db,f.manifest,{...context,order:"event",after:{id:"a",eventPosition}}),{code:"RETRIEVAL_REQUEST_INVALID"});
    f.db.exec("PRAGMA ignore_check_constraints=ON; UPDATE canonical_items SET known_from_event_position=21 WHERE item_id='a'");
    assert.throws(()=>impl.collectCanonicalPageFromProjectionDatabase(f.db,f.manifest,context),{code:"RETRIEVAL_PROJECTION_INVALID"});
    f.db.exec("DROP TABLE canonical_items");
    assert.throws(()=>impl.collectCanonicalPageFromProjectionDatabase(f.db,f.manifest,context),{code:"RETRIEVAL_PROJECTION_INVALID"});
    f.db.exec("UPDATE projection_metadata SET schema_version=1");
    assert.throws(()=>impl.collectFollowUpPageFromProjectionDatabase(f.db,f.manifest,{binding:f.context.binding,limit:5,after:null}),{code:"RETRIEVAL_PROJECTION_INVALID"});
  } finally {f.db.close();}
});
