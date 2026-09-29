import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";

import { decodeFreshStartGenesis, decodeFreshStartRelease } from "../src/orchestrator/fresh-start/contracts.js";
import { SqliteFreshStartRepository } from "../src/orchestrator/fresh-start/fresh-start.repository.js";
import type { SqliteConnection } from "../src/orchestrator/storage/sqlite-driver.js";
import { FRESH_IDENTITY, FRESH_NOW, FRESH_RELEASE_ID, freshGenesis, freshRelease, freshStore } from "./support/fresh-start-fixture.js";

const open: { connection: SqliteConnection; cleanup(): void }[] = [];
function fixture(): { connection: SqliteConnection; repository: SqliteFreshStartRepository } {
  const store = freshStore();
  open.push(store);
  return { connection: store.connection, repository: new SqliteFreshStartRepository(store.connection) };
}
afterEach(() => { for (const store of open.splice(0)) store.cleanup(); });

describe("fresh-start repository", () => {
  it("installs prepared without semantic events", () => {
    const { connection, repository } = fixture();
    const genesis = freshGenesis(); const release = freshRelease();
    const state = repository.transact(FRESH_IDENTITY, (tx) => {
      assert.equal(tx.installation(), null);
      assert.equal(tx.state(), null);
      tx.install(genesis, release);
      assert.deepEqual(tx.installation(), genesis);
      assert.deepEqual(tx.release(release.releaseId), release);
      return tx.state();
    });
    assert.equal(state?.mode, "prepared");
    assert.equal(state?.generation, 0n);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM events").get()?.n, 0n);
  });

  it("rejects duplicate installation and immutable-record rewrites", () => {
    const { connection, repository } = fixture();
    repository.transact(FRESH_IDENTITY, (tx) => tx.install(freshGenesis(), freshRelease()));
    assert.throws(() => repository.transact(FRESH_IDENTITY, (tx) => tx.install(freshGenesis(), freshRelease())), { code: "FRESH_START_ALREADY_INITIALIZED" });
    assert.throws(() => connection.exec("DELETE FROM fresh_start_installation"));
    assert.throws(() => connection.exec("UPDATE fresh_start_releases SET evidence_digest = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'"));
    const original = connection.prepare("SELECT evidence_digest FROM fresh_start_releases WHERE release_id = $id").get({ $id: FRESH_RELEASE_ID })?.evidence_digest;
    assert.throws(() => connection.exec(`INSERT OR REPLACE INTO fresh_start_releases
      SELECT project_id, vault_id, store_id, release_id, profile_version, build_identity_hash,
        schema_identity_hash, configuration_hash, capability_manifest_hash, recovery_policy_hash,
        '${"0".repeat(64)}', created_at FROM fresh_start_releases`));
    assert.equal(connection.prepare("SELECT evidence_digest FROM fresh_start_releases WHERE release_id = $id").get({ $id: FRESH_RELEASE_ID })?.evidence_digest, original);
  });

  it("rejects malformed releases and genesis at the trust boundary", () => {
    for (const malformed of [null, [], { ...freshRelease(), extra: true }, { ...freshRelease(), releaseId: "UPPER" }, { ...freshRelease(), releaseId: "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa" }, { ...freshRelease(), evidenceDigest: "A".repeat(64) }, { ...freshRelease(), createdAt: "2026-09-29" }, new Proxy({}, { getPrototypeOf(): never { throw Error("sensitive"); } })]) {
      assert.throws(() => decodeFreshStartRelease(malformed), { code: "FRESH_START_INPUT_INVALID" });
    }
    for (const malformed of [{ ...freshGenesis(), extra: true }, { ...freshGenesis(), semanticPosition: "00" }, { ...freshGenesis(), terminalHash: "a".repeat(64) }, { ...freshGenesis(), projectionChecksums: {} }]) {
      assert.throws(() => decodeFreshStartGenesis(malformed), { code: "FRESH_START_INPUT_INVALID" });
    }
  });

  it("rejects a wrong installation identity and foreign release", () => {
    const { repository } = fixture();
    const wrong = { ...FRESH_IDENTITY, vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } as typeof FRESH_IDENTITY;
    assert.throws(() => repository.transact(wrong, (tx) => tx.install(freshGenesis(), freshRelease())), { code: "FRESH_START_IDENTITY_MISMATCH" });
    assert.throws(() => repository.transact(FRESH_IDENTITY, (tx) => tx.install(freshGenesis(), freshRelease({ releaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }))), { code: "FRESH_START_RELEASE_MISMATCH" });
  });

  it("refuses initialization when the destination contains a legacy stream", () => {
    const { connection, repository } = fixture();
    connection.prepare(`INSERT INTO streams(project_id, stream_id, stream_type, current_version, created_at, updated_at)
      VALUES ($projectId, $streamId, 'session', 0, $now, $now)`).run({
      $projectId: FRESH_IDENTITY.projectId, $streamId: "99999999-9999-4999-8999-999999999999", $now: FRESH_NOW,
    });
    assert.throws(() => repository.transact(FRESH_IDENTITY, (tx) => tx.install(freshGenesis(), freshRelease())), { code: "FRESH_START_ALREADY_INITIALIZED" });
    assert.equal(connection.prepare("SELECT count(*) AS n FROM fresh_start_installation").get()?.n, 0n);
  });

  it("adds an immutable replacement release under the installed identity", () => {
    const { connection, repository } = fixture();
    repository.transact(FRESH_IDENTITY, (tx) => tx.install(freshGenesis(), freshRelease()));
    const replacement = freshRelease({ releaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    repository.transact(FRESH_IDENTITY, (tx) => tx.insertRelease(replacement));
    assert.deepEqual(repository.transact(FRESH_IDENTITY, (tx) => tx.release(replacement.releaseId)), replacement);
    assert.throws(() => repository.transact(FRESH_IDENTITY, (tx) => tx.insertRelease(replacement)), { code: "FRESH_START_STORAGE_FAILURE" });
    assert.throws(() => connection.exec("DELETE FROM fresh_start_releases WHERE release_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'"));
  });

  it("rolls back failed installation and rejects escaped or asynchronous transactions", () => {
    const { repository } = fixture();
    let escaped: Parameters<Parameters<SqliteFreshStartRepository["transact"]>[1]>[0] | undefined;
    assert.throws(() => repository.transact(FRESH_IDENTITY, (tx) => { tx.install(freshGenesis(), freshRelease()); throw Error("abort"); }), /abort/);
    assert.equal(repository.transact(FRESH_IDENTITY, (tx) => tx.installation()), null);
    repository.transact(FRESH_IDENTITY, (tx) => { escaped = tx; });
    assert.throws(() => escaped?.state(), { code: "FRESH_START_TRANSACTION_CLOSED" });
    assert.throws(() => repository.transact(FRESH_IDENTITY, () => repository.transact(FRESH_IDENTITY, (tx) => tx.state())), { code: "FRESH_START_TRANSACTION_REENTRANT" });
    assert.throws(() => repository.transact(FRESH_IDENTITY, () => Promise.resolve(1)), { code: "FRESH_START_ASYNC_TRANSACTION" });
  });

  it("revokes a returned transaction before inspecting getters and proxies", () => {
    for (const wrap of [
      (action: () => void): object => ({ get then(): undefined { action(); return undefined; } }),
      (action: () => void): object => new Proxy({}, { get(_target, key): undefined { if (key === "then") action(); return undefined; } }),
    ]) {
      const { repository } = fixture();
      assert.throws(() => repository.transact(FRESH_IDENTITY, (tx) => wrap(() => tx.install(freshGenesis(), freshRelease()))), {
        code: "FRESH_START_TRANSACTION_CLOSED",
      });
      assert.equal(repository.transact(FRESH_IDENTITY, (tx) => tx.installation()), null);
    }
  });

  it("observes rejected native Promises and revoked async continuations without process rejection", () => {
    for (const operation of [
      "() => Promise.reject(new Error('rejected promise'))",
      "async (tx) => { await Promise.resolve(); tx.state(); }",
    ]) {
      const script = `
        import { freshStore, FRESH_IDENTITY } from './dist-test/tests/support/fresh-start-fixture.js';
        import { SqliteFreshStartRepository } from './dist-test/src/orchestrator/fresh-start/fresh-start.repository.js';
        const store = freshStore();
        const repository = new SqliteFreshStartRepository(store.connection);
        let code;
        try { repository.transact(FRESH_IDENTITY, ${operation}); }
        catch (error) { code = error.code; }
        if (code !== 'FRESH_START_ASYNC_TRANSACTION') throw Error('wrong synchronous error: ' + code);
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (repository.transact(FRESH_IDENTITY, (tx) => tx.installation()) !== null) throw Error('transaction mutated');
        store.cleanup();
        process.stdout.write('observed and closed\\n');
      `;
      const child = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", script], {
        cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
      });
      assert.equal(child.status, 0, child.stderr || child.error?.message);
      assert.match(child.stdout, /observed and closed/u);
    }
  });

  it("uses adjacent generation CAS and consumes approval identity once", () => {
    const { repository } = fixture();
    repository.transact(FRESH_IDENTITY, (tx) => tx.install(freshGenesis(), freshRelease()));
    const change = {
      expectedMode: "prepared" as const, expectedGeneration: 0n, expectedReleaseId: FRESH_RELEASE_ID,
      nextMode: "active" as const, nextReleaseId: FRESH_RELEASE_ID,
      transitionId: "66666666-6666-4666-8666-666666666666",
      authorization: { kind: "operator" as const, approvalId: "77777777-7777-4777-8777-777777777777", nonceDigest: "3".repeat(64), actorFingerprint: "4".repeat(64), requestDigest: "5".repeat(64) },
      evidenceDigest: "6".repeat(64), recoveryPosition: null, recoveryHash: null, recordedAt: FRESH_NOW,
    };
    const state = repository.transact(FRESH_IDENTITY, (tx) => tx.transition(change));
    assert.equal(state.mode, "active"); assert.equal(state.generation, 1n);
    assert.throws(() => repository.transact(FRESH_IDENTITY, (tx) => tx.transition({ ...change,
      expectedMode: "active", expectedGeneration: 1n,
      nextReleaseId: "99999999-9999-4999-8999-999999999999",
      transitionId: "88888888-8888-4888-8888-888888888888",
    })), { code: "FRESH_START_RELEASE_MISMATCH" });
    assert.throws(() => repository.transact(FRESH_IDENTITY, (tx) => tx.transition(change)), { code: "FRESH_START_STALE_STATE" });
    assert.throws(() => repository.transact(FRESH_IDENTITY, (tx) => tx.transition({ ...change, expectedMode: "active", expectedGeneration: 1n, nextMode: "disabled", transitionId: "88888888-8888-4888-8888-888888888888" })), { code: "FRESH_START_APPROVAL_REUSED" });
  });
});
