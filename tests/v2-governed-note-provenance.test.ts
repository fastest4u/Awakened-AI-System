import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { makeGovernedNoteDomainFixture, type GovernedNoteDomainFixtureV1 } from "./support/governed-note-domain-fixture.js";
import { FRESH_NOW } from "./support/fresh-start-fixture.js";
import { GovernedNoteProvenanceRepository, GovernedNoteProvenanceKeyUnavailable } from "../src/orchestrator/governed-notes/provenance.repository.js";
import type { GovernedNoteCommandV1, GovernedNoteAuthoritySnapshotV1 } from "../src/orchestrator/governed-notes/contracts.js";
import type { EvidenceKeyProvider, EvidenceKeyPurpose, EvidenceKeyRefV1, EvidenceKeyScope } from "../src/orchestrator/privacy/evidence-key-provider.js";
import type { ProjectBinding } from "../src/orchestrator/projections/contracts.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { eventHash } from "../src/orchestrator/crypto/event-hash.js";
import { checkpointFixture } from "./support/lifecycle-fixtures.js";
import type { JsonValue } from "../src/orchestrator/contracts/event.js";
import { computeProjectContextFingerprint } from "../src/orchestrator/identity/project-binding.service.js";
import { createCapabilityProof } from "../src/orchestrator/lifecycle/authority/capability-codec.js";
import { deriveGovernedNoteBinding, governedNoteCreateProofTarget } from "../src/orchestrator/governed-notes/authority.js";

type Fixture = GovernedNoteDomainFixtureV1;
const repository = new GovernedNoteProvenanceRepository();
const descriptorKeys = ["identity", "kind", "sourceCommandId", "sourceEventHash", "sourceEventId", "sourceEventPosition", "sourceIdempotencyKey"];
const refs = (f: Fixture, child = false): GovernedNoteCommandV1["provenance"] => (child ? f.sources.child : f.sources.root).map(({kind,identity}) => ({kind,identity}));
function admission(f: Fixture, child = false) {
  const context = child ? f.childContext : f.rootContext;
  const command = f.command({ provenance: refs(f, child) });
  const handle = f.verifier.verifyCreate(f.prepareCreate(command, context), context);
  return { authority: f.verifier.revalidateCreate(handle), binding: f.verifier.bindingForCreate(handle) };
}
function spy(f: Fixture) {
  let unwrap = 0;
  const statuses: { scope: EvidenceKeyScope; purpose: EvidenceKeyPurpose; ref: EvidenceKeyRefV1 }[] = [];
  const forbidden = (): never => { throw new Error("provenance performed a content operation"); };
  const provider: EvidenceKeyProvider = { currentKey: forbidden, wrap: forbidden, mac: forbidden,
    unwrap() { unwrap++; return forbidden(); },
    status(scope, purpose, ref) { statuses.push({ scope: {...scope}, purpose, ref: {...ref} }); return f.provider.status(scope, purpose, ref); } };
  return { provider, statuses, unwrap: () => unwrap };
}
function snapshot(f: Fixture) {
  return Object.fromEntries(["events", "command_dedup", "streams", "outbox", "retained_evidence_command_authorizations", "retained_evidence_blobs", "retained_evidence_stream_heads"].map(table => [table, f.connection.prepare(`SELECT * FROM ${table}`).all()]));
}
/** Disposable privileged setup only: all guards are restored before the validation oracle. */
function corrupt(f: Fixture, mutate: () => void): void {
  const triggers = f.connection.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all();
  for (const trigger of triggers) f.connection.exec(`DROP TRIGGER "${String(trigger.name).replaceAll('"', '""')}"`);
  f.connection.exec("PRAGMA foreign_keys=OFF; PRAGMA ignore_check_constraints=ON");
  try { mutate(); } finally { for (const trigger of triggers) f.connection.exec(String(trigger.sql)); f.connection.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON"); }
}
function validate(f: Fixture, references = refs(f), admitted = admission(f), provider = spy(f).provider) {
  return repository.validate(f.connection, references, admitted.authority, admitted.binding, provider);
}
function refusesWithoutWrites(f: Fixture, operation: () => unknown, code: string) {
  const before = snapshot(f); assert.throws(operation, { code }); assert.deepEqual(snapshot(f), before);
}
const retainedSource = (f: Fixture, options: Parameters<Fixture["retainSource"]>[0] = {}) => f.retainSource(options);

for (const child of [false, true]) test(`both direct selectors authenticate the same genuine ${child ? "child" : "root"} retained parent`, async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const admitted = admission(f, child), s = spy(f), before = snapshot(f);
  const input = refs(f, child).map(reference => ({...reference})).reverse(), result = validate(f, input, admitted, s.provider), actual = (child ? f.sources.child : f.sources.root)[0]!;
  assert.equal(result.length, 2); assert.deepEqual(result.map(({kind}) => kind), ["retained-evidence", "source-event"]);
  for (const descriptor of result) { assert.equal(descriptor.sourceEventHash, actual.sourceEventHash); assert.equal(descriptor.sourceEventPosition, actual.sourceEventPosition); assert.equal(descriptor.sourceCommandId, actual.sourceCommandId); assert.equal(descriptor.sourceIdempotencyKey, actual.sourceIdempotencyKey); assert.equal(descriptor.sourceEventId, actual.sourceEventId); assert.deepEqual(Object.keys(descriptor).sort(), descriptorKeys); assert.ok(Object.isFrozen(descriptor)); }
  assert.ok(Object.isFrozen(result)); input[0]!.identity = randomUUID(); assert.notEqual(result[1]!.identity, input[0]!.identity);
  assert.equal(s.statuses.length, 3); assert.equal(s.unwrap(), 0); assert.deepEqual(snapshot(f), before);
  assert.deepEqual(s.statuses.map(({purpose}) => purpose).sort(), ["data-key-wrap", "original-input-commitment", "redacted-content-fingerprint"]);
  for (const status of s.statuses) assert.deepEqual(status.scope, {projectId: admitted.authority.projectId, storeId: admitted.authority.storeId});
});

test("source-event authenticates every batch item and historical intact parents survive head continuation", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const admitted = admission(f), s = spy(f), first = retainedSource(f, {frames: 2});
  retainedSource(f, {conversationId: first.command.conversationId, ordinal: "2", previousFrameId: first.command.frames[1]!.frameId});
  const reference = [{kind: "source-event" as const, identity: first.event.eventId}];
  const accepted = validate(f, reference, admitted, s.provider); assert.equal(accepted.length, 1); assert.equal(accepted[0]!.sourceEventPosition, first.event.globalPosition.toString());
  const last = first.result.response.evidenceIds[1]!;
  corrupt(f, () => f.connection.prepare("UPDATE retained_evidence_blobs SET encrypted_item_json=json_set(encrypted_item_json,'$.tag','AAAA') WHERE evidence_id=$id").run({$id:last}));
  refusesWithoutWrites(f, () => validate(f, reference, admitted, s.provider), "INTEGRITY_FAILURE"); assert.equal(s.unwrap(), 0);
});

test("intact root-on-child retained storage is ineligible for same-child provenance", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const source = retainedSource(f, {rootOnChild:true}), admitted = admission(f,true), s = spy(f);
  refusesWithoutWrites(f, () => validate(f, [{kind:"source-event",identity:source.event.eventId}], admitted, s.provider), "GOVERNED_NOTE_PROVENANCE_INELIGIBLE"); assert.equal(s.statuses.length,0); assert.equal(s.unwrap(),0);
});

test("different genuine session and missing event/item selectors are ineligible", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  refusesWithoutWrites(f, () => validate(f, refs(f), admission(f,true)), "GOVERNED_NOTE_PROVENANCE_INELIGIBLE");
  for (const kind of ["source-event","retained-evidence"] as const) refusesWithoutWrites(f, () => validate(f,[{kind,identity:randomUUID()}]), "GOVERNED_NOTE_PROVENANCE_INELIGIBLE");
  const lifecycle = f.connection.prepare("SELECT event_id FROM events WHERE event_type='SessionStarted' LIMIT 1").get()!;
  refusesWithoutWrites(f, () => validate(f,[{kind:"source-event",identity:String(lifecycle.event_id)}]), "GOVERNED_NOTE_PROVENANCE_INELIGIBLE");
});

for (const family of ["MemorySourceRecorded", "GovernedNoteCreated", "SessionCheckpointRecorded", "SessionEnded", "schema2"] as const) test(`excluded ${family} cannot supply provenance authority`, async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const admitted = admission(f), id = f.sources.root[0]!.sourceEventId;
  corrupt(f, () => f.connection.prepare(family === "schema2" ? "UPDATE events SET event_schema_version=2 WHERE event_id=$id" : "UPDATE events SET event_type=$type WHERE event_id=$id").run(family === "schema2" ? {$id:id} : {$id:id,$type:family}));
  refusesWithoutWrites(f, () => validate(f, refs(f), admitted), "GOVERNED_NOTE_PROVENANCE_INELIGIBLE");
});

// Removing any exact authority field comparison must expose an eligibility failure here.
for (const [field, changed] of Object.entries({ projectId:randomUUID(), vaultId:randomUUID(), storeId:randomUUID(), workspaceId:"a".repeat(64), clientNamespace:"foreign", presentingActorRole:"untrusted", presentingClientInstanceId:"foreign", targetActorRole:"untrusted", targetClientInstanceId:"foreign", rootOwnerGeneration:"2", authorizingOwnerGeneration:"2", authorizingCapabilityGeneration:"2", targetOwnerGeneration:"2", targetCapabilityGeneration:"2", parentSessionId:randomUUID(), rootSessionId:randomUUID(), targetSessionId:randomUUID(), authorizationSessionId:randomUUID(), capabilityKind:"child-session-handle" })) test(`recorded authority must match current ${field}`, async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const admitted = admission(f);
  const authority = {...admitted.authority,[field]:changed} as GovernedNoteAuthoritySnapshotV1;
  refusesWithoutWrites(f, () => validate(f, refs(f), {...admitted,authority}), "GOVERNED_NOTE_PROVENANCE_INELIGIBLE");
});
for (const [field, changed] of Object.entries({projectId:randomUUID(),vaultId:randomUUID(),storeId:randomUUID(),workspaceId:"b".repeat(64),sessionId:randomUUID(),branchScopeId:randomUUID(),branchRef:"refs/heads/foreign"})) test(`all projection binding fields match: ${field}`, async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const admitted = admission(f), binding = {...admitted.binding,[field]:changed} as ProjectBinding;
  refusesWithoutWrites(f, () => validate(f, refs(f), {...admitted,binding}), "GOVERNED_NOTE_PROVENANCE_INELIGIBLE");
});

const corruptions = ["dedup-missing", "authorization-missing", "both-missing", "blob-missing", "event-missing", "predecessor-missing", "predecessor-hash", "genesis-anchor", "payload", "noncanonical-payload", "event-hash", "lifecycle-witness", "dedup-state", "dedup-witness", "dedup-outbox", "physical-outbox", "result", "authorization", "head-frame", "head-ordinal", "head-version", "item-binding", "ciphertext", "wrap", "wrap-ref", "nonce", "algorithm", "noncanonical-item", "transport-digest"] as const;
for (const tamper of corruptions) test(`retained corruption ${tamper} refuses without writes or provider operations`, async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const admitted = admission(f), s = spy(f), actual = f.sources.root[0]!, id = actual.sourceEventId;
  const params = {$id:id,$cmd:actual.sourceCommandId,$pos:BigInt(actual.sourceEventPosition)};
  corrupt(f, () => {
    const run = (sql:string) => f.connection.prepare(sql).run(sql.includes("$cmd") ? {$cmd:params.$cmd} : sql.includes("$pos") ? {$pos:params.$pos} : sql.includes("$id") ? {$id:id} : {});
    switch(tamper) {
      case "dedup-missing": run("DELETE FROM command_dedup WHERE command_id=$cmd"); break;
      case "authorization-missing": run("DELETE FROM retained_evidence_command_authorizations WHERE command_id=$cmd"); break;
      case "both-missing": run("DELETE FROM command_dedup WHERE command_id=$cmd"); run("DELETE FROM retained_evidence_command_authorizations WHERE command_id=$cmd"); break;
      case "blob-missing": run("DELETE FROM retained_evidence_blobs WHERE event_id=$id"); break;
      case "event-missing": run("DELETE FROM events WHERE event_id=$id"); break;
      case "predecessor-missing": run("DELETE FROM events WHERE global_position=$pos-1"); break;
      case "predecessor-hash": run("UPDATE events SET event_hash='"+"0".repeat(64)+"' WHERE global_position=$pos-1"); break;
      case "genesis-anchor": run("DELETE FROM events WHERE global_position=1"); run("UPDATE events SET global_position=1,previous_global_hash='"+"1".repeat(64)+"' WHERE event_id=$id"); break;
      case "payload": run("UPDATE events SET payload_json='{}' WHERE event_id=$id"); break;
      case "noncanonical-payload": run("UPDATE events SET payload_json=' '||payload_json WHERE event_id=$id"); break;
      case "event-hash": run("UPDATE events SET event_hash='"+"0".repeat(64)+"' WHERE event_id=$id"); break;
      case "lifecycle-witness": run("UPDATE events SET lifecycle_intent_json='{}' WHERE event_id=$id"); break;
      case "dedup-state": run("UPDATE command_dedup SET state='pending' WHERE command_id=$cmd"); break;
      case "dedup-witness": run("UPDATE command_dedup SET lifecycle_authorization_kind='protected' WHERE command_id=$cmd"); break;
      case "dedup-outbox": run("UPDATE command_dedup SET outbox_order_json='[\"unexpected\"]' WHERE command_id=$cmd"); break;
      case "physical-outbox": f.connection.prepare("INSERT INTO outbox(project_id,target_key,event_position,kind,payload_json,content_hash,status,created_at,updated_at) VALUES($p,'unexpected',$pos,'unexpected','{}',$hash,'pending',$now,$now)").run({$p:admitted.authority.projectId,$pos:params.$pos,$hash:"0".repeat(64),$now:FRESH_NOW}); break;
      case "result": run("UPDATE command_dedup SET response_hash='"+"0".repeat(64)+"' WHERE command_id=$cmd"); break;
      case "authorization": run("UPDATE retained_evidence_command_authorizations SET authorization_json='{}' WHERE event_id=$id"); break;
      case "head-frame": run("UPDATE retained_evidence_stream_heads SET last_frame_id='"+randomUUID()+"'"); break;
      case "head-ordinal": run("UPDATE retained_evidence_stream_heads SET last_ordinal=last_ordinal+1"); break;
      case "head-version": run("UPDATE retained_evidence_stream_heads SET version=version+1"); break;
      default: {
        const row = f.connection.prepare("SELECT encrypted_item_json FROM retained_evidence_blobs WHERE event_id=$id").get({$id:id})!;
        const item = JSON.parse(String(row.encrypted_item_json));
        if(tamper === "item-binding") item.binding.evidenceId=randomUUID();
        else if(tamper === "ciphertext") item.ciphertext=Buffer.from("different ciphertext").toString("base64url");
        else if(tamper === "wrap") item.wrappedKey.tag=Buffer.alloc(16).toString("base64url");
        else if(tamper === "wrap-ref") item.wrappedKey.keyRef.version="99";
        else if(tamper === "nonce") item.nonce="AAAA";
        else if(tamper === "algorithm") item.algorithm="AES-128-GCM";
        else if(tamper === "transport-digest") item.ciphertextHash="0".repeat(64);
        f.connection.prepare("UPDATE retained_evidence_blobs SET encrypted_item_json=$json WHERE event_id=$id").run({$id:id,$json:(tamper === "noncanonical-item" ? " " : "")+canonicalJson(item)});
      }
    }
  });
  for (const reference of refs(f)) refusesWithoutWrites(f, () => validate(f, [reference], admitted, s.provider), tamper === "blob-missing" && reference.kind === "retained-evidence" ? "GOVERNED_NOTE_PROVENANCE_INELIGIBLE" : "INTEGRITY_FAILURE");
  assert.equal(s.unwrap(),0); assert.equal(s.statuses.length,0);
});

for (const backing of ["authorization", "blob"] as const) test(`absent event selector detects surviving orphan ${backing}`, async t => {
  const f=await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const admitted=admission(f), id=f.sources.root[0]!.sourceEventId;
  corrupt(f,()=> { f.connection.prepare("DELETE FROM events WHERE event_id=$id").run({$id:id}); if(backing === "blob") f.connection.prepare("DELETE FROM retained_evidence_command_authorizations WHERE event_id=$id").run({$id:id}); else f.connection.prepare("DELETE FROM retained_evidence_blobs WHERE event_id=$id").run({$id:id}); });
  refusesWithoutWrites(f,()=>validate(f,[{kind:"source-event",identity:id}],admitted),"INTEGRITY_FAILURE");
});

for (const purpose of ["data-key-wrap","redacted-content-fingerprint","original-input-commitment"] as const) for (const state of ["revoked","unavailable","forgotten","throw"] as const) test(`authenticated historical ${purpose} ${state} gives safe internal refusal`,async t=> {
  const f=await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const admitted=admission(f), s=spy(f), before=snapshot(f);
  for(const p of ["data-key-wrap","redacted-content-fingerprint","original-input-commitment"] as const) f.provider.rotate(p);
  assert.equal(validate(f,refs(f),admitted,s.provider).length,2);
  for(const status of s.statuses) { assert.equal(status.ref.version,"1"); assert.equal(status.ref.keyId,`synthetic/${status.purpose}`); }
  if(state === "forgotten") f.provider.forget(purpose,"1"); else if(state !== "throw") f.provider.setStatus(purpose,state,"1");
  const provider = state === "throw" ? {...s.provider,status():never {throw new Error("private provider fixture_opaque");}} : s.provider;
  assert.throws(()=>validate(f,refs(f),admitted,provider),error=> {assert.ok(error instanceof GovernedNoteProvenanceKeyUnavailable); assert.equal(error.message,"GOVERNED_NOTE_PROVENANCE_KEY_UNAVAILABLE"); assert.equal("details" in error,false); assert.equal("cause" in error,false); assert.equal(JSON.stringify(error).includes("fixture_opaque"),false); return true;});
  assert.equal(s.unwrap(),0); assert.deepEqual(snapshot(f),before);
});

test("repository rereads source truth on every call and owns no transaction",async t=> {
  const f=await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const admitted=admission(f), s=spy(f);
  f.connection.exec("BEGIN IMMEDIATE"); try { assert.equal(validate(f,refs(f),admitted,s.provider).length,2); } finally {f.connection.exec("ROLLBACK");}
  corrupt(f,()=>f.connection.prepare("DELETE FROM retained_evidence_command_authorizations WHERE event_id=$id").run({$id:f.sources.root[0]!.sourceEventId}));
  refusesWithoutWrites(f,()=>validate(f,refs(f),admitted,s.provider),"INTEGRITY_FAILURE"); assert.equal(s.unwrap(),0);
});

test("a non-genesis predecessor hole refuses even when the retained parent hash consistently uses zero", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const admitted = admission(f), s = spy(f), source = f.sources.root[0]!;
  const event = f.retained.repository.findPrior(source.sourceCommandId, source.sourceIdempotencyKey)!.event;
  const { payload: _payload, payloadJson: _json, eventHash: _hash, lifecycleIntentJson: _lifecycle, ...header } = event;
  const hashInput = {...header, globalPosition: String(event.globalPosition), streamVersion: String(event.streamVersion)};
  assert.equal(eventHash(hashInput), event.eventHash); assert.ok(event.globalPosition > 1n);
  corrupt(f, () => {
    f.connection.prepare("DELETE FROM events WHERE global_position=$pos").run({$pos:event.globalPosition - 1n});
    f.connection.prepare("UPDATE events SET previous_global_hash=$zero,event_hash=$hash WHERE event_id=$id").run({$id:event.eventId,$zero:"0".repeat(64),$hash:eventHash({...hashInput,previousGlobalHash:"0".repeat(64)})});
  });
  for (const reference of refs(f)) refusesWithoutWrites(f, () => validate(f, [reference], admitted, s.provider), "INTEGRITY_FAILURE");
  assert.equal(s.statuses.length,0); assert.equal(s.unwrap(),0);
});

test("a retained batch refuses when an earlier conversation frame has a physical gap", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const admitted = admission(f), s = spy(f), first = retainedSource(f);
  const later = retainedSource(f,{conversationId:first.command.conversationId,ordinal:"1",previousFrameId:first.command.frames[0]!.frameId});
  corrupt(f,()=>f.connection.prepare("DELETE FROM retained_evidence_blobs WHERE evidence_id=$id").run({$id:first.result.response.evidenceIds[0]!}));
  refusesWithoutWrites(f,()=>validate(f,[{kind:"source-event",identity:later.event.eventId}],admitted,s.provider),"INTEGRITY_FAILURE");
  assert.equal(s.statuses.length,0); assert.equal(s.unwrap(),0);
});

test("genuine current authority after root resume cannot authorize older-generation retained attribution", async t => {
  const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const command = f.command(), s = spy(f), prepared = f.prepareCreate(command);
  const { checkpointId: _i, sessionId: _s, parentSessionId: _p, baseEventPosition: _b, checkpointEventPosition: _e, createdAt: _at, creatorAgentId: _a, creatorClientInstanceId: _c, sourceState: _st, childSummaries: _ch, evidenceCoverage: _cv, ...draft } = checkpointFixture();
  const checkpoint = await f.retained.lifecycle.checkpoint(f.retained.rootAuthority.sessionId,f.retained.rootAuthority.descriptor,draft as unknown as JsonValue);
  const beforeResume = admission(f);
  refusesWithoutWrites(f,()=>validate(f,[{kind:"source-event",identity:checkpoint.eventId}],beforeResume,s.provider),"GOVERNED_NOTE_PROVENANCE_INELIGIBLE");
  const incoming = {...f.rootContext,binding:{...f.rootContext.binding,clientInstanceId:"governed-provenance-incoming-owner"}};
  incoming.binding.contextFingerprint = computeProjectContextFingerprint(incoming.binding);
  const resumed = await f.retained.lifecycle.resumeAfterExpiry(f.retained.rootAuthority.sessionId,f.retained.rootAuthority.descriptor,incoming);
  assert.equal(resumed.publicResult.ownerGeneration,"2");
  const issuedAt = f.connection.prepare("SELECT root_handle_issued_at FROM session_authority WHERE session_id=$id").get({$id:f.retained.rootAuthority.sessionId})!.root_handle_issued_at as string;
  f.clock.set(BigInt(Date.parse(issuedAt)));
  const material = f.capabilities.reconstructForTarget(resumed.authorityMaterial.descriptor,{actorRole:"primary",clientInstanceId:incoming.binding.clientInstanceId});
  try {
    const scope = {...f.scope(f.rootContext),capabilityGeneration:"2",presentingClientInstanceId:incoming.binding.clientInstanceId,targetClientInstanceId:incoming.binding.clientInstanceId};
    const proof = createCapabilityProof(material.handle,governedNoteCreateProofTarget(command,scope,deriveGovernedNoteBinding(f.connection,incoming,scope.targetSessionId),randomUUID()));
    const handle = f.verifier.verifyCreate({...prepared,authorization:{...prepared.authorization,proof}},incoming), authority = f.verifier.revalidateCreate(handle), binding = f.verifier.bindingForCreate(handle);
    assert.equal(authority.rootOwnerGeneration,"2"); assert.equal(authority.authorizingOwnerGeneration,"2"); assert.equal(authority.targetOwnerGeneration,"2");
    refusesWithoutWrites(f,()=>validate(f,refs(f),{authority,binding},s.provider),"GOVERNED_NOTE_PROVENANCE_INELIGIBLE"); assert.equal(s.statuses.length,0); assert.equal(s.unwrap(),0);
  } finally { material.handle.destroy(); if(material.kind === "root") material.resumeToken?.destroy(); }
});

test("invalid, duplicate, and oversized selector sets never reach sources",async t=> {
  const f=await makeGovernedNoteDomainFixture(); t.after(f.cleanup); const admitted=admission(f), reference=refs(f)[0]!;
  for(const references of [[],[reference,reference],[{...reference,identity:"bad"}],[{...reference,extra:true}],Array.from({length:65},()=>({kind:"source-event",identity:randomUUID()}))]) {
    assert.throws(()=>validate(f,references as GovernedNoteCommandV1["provenance"],admitted),error=> {assert.ok(error instanceof Error); assert.match(error.message,/GOVERNED_NOTE_(INPUT_INVALID|LIMIT_EXCEEDED)/); return true;});
  }
});
