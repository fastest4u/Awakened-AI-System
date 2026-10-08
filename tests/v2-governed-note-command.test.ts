import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { makeGovernedNoteDomainFixture, type GovernedNoteDomainFixtureV1 } from "./support/governed-note-domain-fixture.js";
import { GovernedNoteRepository } from "../src/orchestrator/governed-notes/repository.js";
import { EventStoreError } from "../src/orchestrator/storage/event-append-transaction.js";
import { GovernedNoteService } from "../src/orchestrator/governed-notes/service.js";
import { EventAppendTransaction, SqliteEventAppendStatements } from "../src/orchestrator/storage/event-append-transaction.js";
import { BranchScopeRepository } from "../src/orchestrator/storage/branch-scope.repository.js";
import { GovernedNoteProvenanceRepository } from "../src/orchestrator/governed-notes/provenance.repository.js";
import { MaintenanceFence } from "../src/orchestrator/storage/maintenance-fence.js";
import { FRESH_IDENTITY, FRESH_NOW } from "./support/fresh-start-fixture.js";
import { GovernedNoteError } from "../src/orchestrator/governed-notes/errors.js";

const bytes = (f: GovernedNoteDomainFixtureV1) => JSON.stringify([f.retained.rows(), f.connection.prepare("SELECT * FROM streams").all(), f.connection.prepare("SELECT * FROM outbox").all()], (_, v) => typeof v === "bigint" ? String(v) : v);
function safeFailure(fn: () => unknown, code: string, ids?: {commandId:string;idempotencyKey:string}) {
  assert.throws(fn, (e: unknown) => { assert.ok(e instanceof Error); assert.equal((e as {code?:string}).code, code); assert.equal(e.message, code); if (ids) assert.deepEqual((e as unknown as {details:unknown}).details, ids); return true; });
}
for (const kind of ["session-log", "insight", "mistake", "adr"] as const) for (const child of [false, true]) {
  test(`${kind} ${child ? "child" : "root"} commits exactly one candidate pair and committed receipt`, async t => {
    const f = await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
    const context = child ? f.childContext : f.rootContext;
    const command = f.command({ recordKind: kind, provenance: f.sources[child ? "child" : "root"].map(({kind,identity}) => ({kind,identity})), summary: "  private fixture_secret_123 é  " });
    const before = f.rows(), result = f.service().create(f.prepareCreate(command, context), context), after = f.rows();
    assert.equal(result.deduplicated, false); assert.equal(result.finalStreamVersion, 2n);
    assert.deepEqual(after, { events: before.events+2, dedup: before.dedup+1, streams: before.streams+1, outbox: before.outbox, authorization: before.authorization });
    const prior = new GovernedNoteRepository(f.connection).findGovernedNotePrior(command.commandId, command.idempotencyKey)!;
    assert.deepEqual(prior.result.response, result.response); assert.deepEqual(result.eventIds, [prior.witness.noteEventId, prior.witness.sourceEventId]);
    assert.equal(result.response.status, "candidate"); assert.equal(result.response.verificationStatus, "unverified");
    assert.equal(result.response.scope.sessionId, child ? f.retained.childAuthority.sessionId : f.retained.rootAuthority.sessionId);
    assert.equal(prior.events[1].globalPosition, prior.events[0].globalPosition+1n);
    assert.equal(JSON.parse(prior.events[1].payloadJson).item.summary, "private [REDACTED] é");
    assert.equal(bytes(f).includes("fixture_secret_123"), false); assert.equal(JSON.stringify(result.response).includes("fixture_secret_123"), false);
    for (const path of [f.retained.path, f.retained.path+"-wal"]) if (existsSync(path)) assert.equal(readFileSync(path).includes(Buffer.from("fixture_secret_123")),false);
  });
}
for (const point of ["before-begin", "after-note-event", "after-source-event", "after-dedup", "before-commit"] as const) {
  test(`${point} failure rolls back actual pair and dedup`, async t => {
    let f: GovernedNoteDomainFixtureV1, observed: { n: unknown; s: unknown; d: unknown } | undefined;
    f = await makeGovernedNoteDomainFixture({ faults: { inject(p) {
      if (p !== point) return;
      const n = f.connection.prepare("SELECT count(*) AS n FROM events WHERE event_type='GovernedNoteCreated'").get()!.n;
      const s = f.connection.prepare("SELECT count(*) AS n FROM events WHERE event_type='MemorySourceRecorded'").get()!.n;
      const d = f.connection.prepare("SELECT count(*) AS n FROM command_dedup WHERE command_type='create-governed-note'").get()!.n;
      observed = { n, s, d };
      throw new Error("private-provider-marker");
    } } }); t.after(f.cleanup);
    const command = f.command(), before = bytes(f);
    safeFailure(() => f.service().create(f.prepareCreate(command), f.rootContext), "GOVERNED_NOTE_UNAVAILABLE");
    assert.deepEqual(observed, { n: point === "before-begin" ? 0n : 1n,
      s: point === "before-begin" || point === "after-note-event" ? 0n : 1n,
      d: point === "after-dedup" || point === "before-commit" ? 1n : 0n });
    assert.equal(bytes(f), before);
  });
}
for (const point of ["before-begin", "after-note-event", "after-source-event", "after-dedup"] as const) {
  test(`${point} arbitrary busy-shaped fault is not a retry certificate`, async t => {
    let observed=false;
    const f = await makeGovernedNoteDomainFixture({ faults: { inject(p) { if (p === point) { observed=true; throw Object.assign(new Error("private-busy-marker"), { code:"SQLITE_BUSY", errcode:5 }); } } } }); t.after(f.cleanup);
    const before = bytes(f);
    assert.throws(() => f.service().create(f.prepareCreate(f.command()), f.rootContext), (e: unknown) => { assert.ok(e instanceof Error); assert.equal(e instanceof EventStoreError && e.details.retryable === true, false); assert.equal(e.message.includes("private-busy-marker"), false); return true; });
    assert.equal(observed,true); assert.equal(bytes(f), before);
  });
}
test("actual native writer lock before BEGIN is safely retryable and writes nothing", async t => {
  let locker: DatabaseSync | undefined;
  const f = await makeGovernedNoteDomainFixture({ faults: { inject(p) { if (p === "before-begin") { locker = new DatabaseSync(f.retained.path); locker.exec("BEGIN IMMEDIATE"); } } } }); t.after(f.cleanup);
  const before = bytes(f);
  try { assert.throws(() => f.service().create(f.prepareCreate(f.command()), f.rootContext), (e: unknown) => e instanceof EventStoreError && e.code === "SQLITE_BUSY" && e.details.retryable === true); }
  finally { locker?.exec("ROLLBACK"); locker?.close(); }
  assert.equal(bytes(f), before);
});
for (const mode of ["commit-throws", "commit-then-throws", "postcommit", "rollback-fails"] as const) {
  test(`${mode} preserves original IDs as unknown without retry`, async t => {
    const f = await makeGovernedNoteDomainFixture({ faults: { inject(p) { if (mode === "postcommit" && p === "after-commit-before-response" || mode === "rollback-fails" && p === "after-dedup") throw Object.assign(new Error("private-fault"), {errcode:5}); } } }); t.after(f.cleanup);
    const command = f.command(), prepared = f.prepareCreate(command), before = f.rows(), exec = f.connection.exec.bind(f.connection);
    f.connection.exec = sql => { if (sql === "COMMIT" && (mode === "commit-throws" || mode === "commit-then-throws")) { if (mode === "commit-then-throws") exec(sql); throw Object.assign(new Error("private-native-response"), {errcode:5}); } if (sql === "ROLLBACK" && mode === "rollback-fails") throw new Error("private-rollback"); exec(sql); };
    try {
      safeFailure(() => f.service().create(prepared, f.rootContext), "COMMAND_OUTCOME_UNKNOWN", {commandId:command.commandId,idempotencyKey:command.idempotencyKey});
      if (mode === "postcommit" || mode === "commit-then-throws") { assert.equal(f.rows().events, before.events+2); assert.ok(new GovernedNoteRepository(f.connection).findGovernedNotePrior(command.commandId, command.idempotencyKey)); }
      if (mode === "commit-throws") assert.deepEqual(f.rows(), before);
    } finally { f.connection.exec = exec; if (mode === "rollback-fails") exec("ROLLBACK"); }
  });
}
for (const fence of ["control", "maintenance", "source-key", "source-row", "authority-fold"] as const) {
  test(`${fence} changed after preparation refuses before note writes`, async t => {
    let f: GovernedNoteDomainFixtureV1, changed=false, afterSetup:string|undefined;
    f = await makeGovernedNoteDomainFixture({ faults: { inject(p) {
      if (p !== "before-begin") return;
      if (fence === "control") f.retained.admission.control.stop({identity:FRESH_IDENTITY,expectedGeneration:1n,target:"disabled",reasonCode:"privacy-failure"});
      if (fence === "maintenance") { f.connection.exec("BEGIN IMMEDIATE"); new MaintenanceFence().acquire(f.connection,"note-test","2026-09-29T00:01:00.000Z",FRESH_NOW); f.connection.exec("COMMIT"); }
      if (fence === "source-key") f.provider.setStatus("data-key-wrap", "revoked");
      if (fence === "source-row") {
        // Explicit privileged corruption; restore schema guards before service revalidation.
        const guards=f.connection.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='retained_evidence_blobs'").all();
        for(const guard of guards)f.connection.exec(`DROP TRIGGER "${String(guard.name).replaceAll('"','""')}"`);
        f.connection.exec("PRAGMA foreign_keys=OFF");
        try { f.connection.prepare("DELETE FROM retained_evidence_blobs WHERE evidence_id=$id").run({$id:f.sources.root.find(s=>s.kind === "retained-evidence")!.identity}); }
        finally { for(const guard of guards)f.connection.exec(String(guard.sql)); f.connection.exec("PRAGMA foreign_keys=ON"); }
      }
      if (fence === "authority-fold") f.connection.prepare("UPDATE session_authority SET authority_commitment=$bad WHERE session_id=$id").run({$bad:"f".repeat(64),$id:f.retained.rootAuthority.sessionId});
      changed=true;
      afterSetup=bytes(f);
    } } }); t.after(f.cleanup);
    const command=f.command(), before=f.rows();
    assert.throws(()=>f.service().create(f.prepareCreate(command),f.rootContext));
    assert.equal(changed,true);
    assert.equal(bytes(f),afterSetup);
    assert.equal(f.rows().events,before.events); assert.equal(f.rows().dedup,before.dedup);
    assert.equal(f.rows().streams,before.streams);
  });
}
test("source key refusal uses note identities", async t => {
  const f=await makeGovernedNoteDomainFixture(); t.after(f.cleanup);
  const command=f.command(), prepared=f.prepareCreate(command), before=bytes(f);
  f.provider.setStatus("data-key-wrap","unavailable");
  safeFailure(()=>f.service().create(prepared,f.rootContext),"GOVERNED_NOTE_KEY_UNAVAILABLE",{commandId:command.commandId,idempotencyKey:command.idempotencyKey});
  assert.equal(bytes(f),before);
});

test("provider native-shaped busy remains safe key refusal and clears borrowed MAC bytes",async t=>{
  const f=await makeGovernedNoteDomainFixture();t.after(f.cleanup);
  const command=f.command(), before=bytes(f);let borrowed:Uint8Array|undefined;
  f.provider.mac=(_s,_p,_r,_d,input)=>{borrowed=input;throw Object.assign(new Error("private-provider-marker"),{code:"SQLITE_BUSY",errcode:5});};
  safeFailure(()=>f.service().create(f.prepareCreate(command),f.rootContext),"GOVERNED_NOTE_KEY_UNAVAILABLE",{commandId:command.commandId,idempotencyKey:command.idempotencyKey});
  assert.ok(borrowed);assert.equal(borrowed.every(v=>v===0),true);assert.equal(bytes(f),before);assert.equal(bytes(f).includes("private-provider-marker"),false);
});

test("cleanup discards genuine preparation without masking primary failure or acknowledging uncertain cleanup",async t=>{
  const f=await makeGovernedNoteDomainFixture();t.after(f.cleanup);
  for(const committed of [false,true]){
    const events=new EventAppendTransaction(f.connection,new SqliteEventAppendStatements(f.connection),new MaintenanceFence(),new BranchScopeRepository());
    const discard=events.discardGovernedNote.bind(events);let discarded=false;
    events.discardGovernedNote=p=>{discard(p);discarded=true;throw new Error("private-cleanup");};
    const service=new GovernedNoteService({connection:f.connection,events,repository:new GovernedNoteRepository(f.connection),provenance:new GovernedNoteProvenanceRepository(),authority:f.verifier,provider:f.provider,policy:()=>f.policy,clock:f.clock,faults:{inject(p){if(!committed&&p==="after-dedup")throw new GovernedNoteError("IDEMPOTENCY_CONFLICT");}}});
    const command=f.command(),before=f.rows();
    safeFailure(()=>service.create(f.prepareCreate(command),f.rootContext),committed?"COMMAND_OUTCOME_UNKNOWN":"IDEMPOTENCY_CONFLICT",committed?{commandId:command.commandId,idempotencyKey:command.idempotencyKey}:undefined);
    assert.equal(discarded,true);assert.equal(f.rows().events,before.events+(committed?2:0));
  }
});
