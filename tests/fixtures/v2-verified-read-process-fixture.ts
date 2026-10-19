import { writeFileSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createCwdProjectionReadCore } from "../../src/orchestrator/projections/stable-directory-read-core.js";
import { releaseOwnedReadLock } from "../../src/orchestrator/verified-read/cleanup.js";
import { decodeCleanupBootstrap, decodeReadBootstrap } from "../../src/orchestrator/verified-read/protocol.js";
import { executeVerifiedRead, executeFullNoteVerifiedRead } from "../../src/orchestrator/verified-read/child.js";
import { decodeFullNoteReadBootstrap } from "../../src/orchestrator/verified-read/full-note-protocol.js";

// Fault selection exists only in this test executable, never production argv/env/bootstrap.
const kind = process.argv[2];
if (kind === "writer") {
  const database = new DatabaseSync("independent-writer.sqlite");
  database.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('independent-owned-writer');");
  writeFileSync("writer-ready", "sqlite-open");
  process.on("message", value => { if (value === "stop") { database.close(); process.disconnect(); } });
} else if (kind === "read-hang") {
  process.once("message", value => {
    const bootstrap = decodeReadBootstrap(value);
    const core = createCwdProjectionReadCore(bootstrap.binding.projectionDirectory);
    if (core.acquireLock(bootstrap.lockToken) !== "acquired") throw new Error("fixture lock unavailable");
    // This marker is inside the real lock operation, after exclusive creation+fsync+ownership proof.
    // The following wait never yields to cancellation/IPC; only exact-handle process termination can stop it.
    writeFileSync("read-blocked", "owned-lock-acquired-before-synchronous-wait");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw new Error("infinite wait unexpectedly returned");
  });
} else if (kind === "query-hang" || kind === "workflow-query-hang" || kind === "workflow-packing-hang") {
  process.once("message", async value => {
    const bootstrap = decodeReadBootstrap(value); let queryObserved = false;
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql) {
      // Fixed canonical SELECT only, after executeVerifiedRead has validated the same detached image.
      if (kind === "query-hang" && /SELECT item\.project_id, item\.session_id, item\.item_id, item\.normalized_key/u.test(sql)
        && /FROM canonical_items AS item/u.test(sql) && /item\.item_id = \$id COLLATE BINARY/u.test(sql)) {
        if (!queryObserved || readFileSync(".projection-manifest.publish.lock", "utf8") !== bootstrap.lockToken) throw new Error("query boundary not owned");
        writeFileSync("query-blocked", "validated-image-owned-lock-fixed-canonical-query");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        throw new Error("infinite query wait unexpectedly returned");
      }
      if (kind === "workflow-query-hang" && /FROM canonical_items AS item/u.test(sql)
        && /ORDER BY item\.item_id COLLATE BINARY ASC LIMIT \$pageLimit/u.test(sql)) {
        if (!queryObserved || readFileSync(".projection-manifest.publish.lock", "utf8") !== bootstrap.lockToken) throw new Error("workflow query boundary not owned");
        writeFileSync("workflow-query-blocked", "validated-image-owned-lock-fixed-workflow-list-query");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        throw new Error("infinite workflow query wait unexpectedly returned");
      }
      return prepare.call(this, sql);
    };
    const byteLength = Buffer.byteLength;
    if (kind === "workflow-packing-hang") Buffer.byteLength = function (value, encoding) {
      if (typeof value === "string" && value.includes('"workflowBoundsVersion"') && value.includes('"kind":"success"')) {
        if (!queryObserved || readFileSync(".projection-manifest.publish.lock", "utf8") !== bootstrap.lockToken) throw new Error("workflow packing boundary not owned");
        writeFileSync("workflow-packing-blocked", "validated-image-owned-lock-prospective-workflow-envelope-packing");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        throw new Error("infinite workflow packing wait unexpectedly returned");
      }
      return byteLength(value, encoding);
    };
    const reply = await executeVerifiedRead(bootstrap, { inspectBuild: () => "a".repeat(64), now: () => performance.now(),
      wait: async ms => { await new Promise(resolve => setTimeout(resolve, ms)); }, signal: new AbortController().signal,
      emitStage(stage) { if (stage.phase === "query") queryObserved = true; process.send!(stage); } });
    process.send!(reply, sendError => { if (sendError) process.exitCode = 1; process.disconnect(); });
  });
} else if (kind === "full-note-query-hang" || kind === "full-note-packing-hang" || kind === "full-note-capture-replace" || kind === "full-note-late-success") {
  // Protocol4/executor4 only. Build identity is read from the independently measured current dist manifest.
  const measured = (JSON.parse(readFileSync(new URL("../../../dist/v2-build.json", import.meta.url), "utf8")) as { buildIdentityHash: string }).buildIdentityHash;
  process.once("message", async value => {
    const bootstrap = decodeFullNoteReadBootstrap(value); let queryObserved = false, revalidateObserved = false;
    const owned = (label: string) => { if (!queryObserved || revalidateObserved || readFileSync(".projection-manifest.publish.lock", "utf8") !== bootstrap.lockToken) throw new Error(`${label} boundary not owned`); };
    const prepare = DatabaseSync.prototype.prepare;
    if (kind === "full-note-query-hang") DatabaseSync.prototype.prepare = function (sql) {
      // Fixed dedicated governed side-row SELECT only, after the captured schema3 image was validated.
      if (/FROM governed_notes/u.test(sql) && /item_id = \$itemId COLLATE BINARY/u.test(sql) && queryObserved) {
        owned("full-note query"); writeFileSync("full-note-query-blocked", "validated-image-owned-lock-fixed-governed-side-row-query");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        throw new Error("infinite full-note query wait unexpectedly returned");
      }
      return prepare.call(this, sql);
    };
    const byteLength = Buffer.byteLength;
    if (kind === "full-note-packing-hang") Buffer.byteLength = function (input, encoding) {
      // The complete success envelope charges its closed key only while packing inside the query stage.
      if (input === '"closed"' && queryObserved && !revalidateObserved) {
        owned("full-note packing"); writeFileSync("full-note-packing-blocked", "validated-image-owned-lock-full-note-envelope-packing");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        throw new Error("infinite full-note packing wait unexpectedly returned");
      }
      return byteLength(input, encoding);
    };
    let late: { reply?: unknown; cancelled: boolean } = { cancelled: false };
    const deliver = (reply: unknown) => process.send!(reply, sendError => { if (sendError) process.exitCode = 1; process.disconnect(); });
    if (kind === "full-note-late-success") process.on("message", () => { late.cancelled = true; if (late.reply !== undefined) deliver(late.reply); });
    const reply = await executeFullNoteVerifiedRead(bootstrap, { inspectBuild: () => measured, now: () => performance.now(),
      wait: async ms => { await new Promise(resolve => setTimeout(resolve, ms)); }, signal: new AbortController().signal,
      emitStage(stage) {
        if (stage.phase === "query") queryObserved = true; if (stage.phase === "revalidate") revalidateObserved = true;
        if (kind === "full-note-capture-replace" && stage.phase === "validate") {
          // After locked named capture, replace the named generation bytes; the captured copy must be what is queried.
          const manifest = JSON.parse(readFileSync("projection-manifest.json", "utf8")) as { databaseFile: string };
          writeFileSync(manifest.databaseFile, "replaced-after-capture"); writeFileSync("full-note-capture-replaced", manifest.databaseFile);
        }
        process.send!(stage);
      } });
    if (kind === "full-note-late-success") {
      // Withheld terminal: delivered only after the parent's cancel, i.e. after the lane failed.
      writeFileSync("full-note-late-held", reply.kind); late = { ...late, reply };
      if (late.cancelled) deliver(reply);
      return;
    }
    deliver(reply);
  });
} else if (kind === "cleanup-hang") {
  process.once("message", value => {
    decodeCleanupBootstrap(value); writeFileSync("cleanup-blocked", "cleanup-bootstrap-decoded-no-reply");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    throw new Error("infinite cleanup wait unexpectedly returned");
  });
} else if (kind === "cleanup") {
  process.once("message", value => {
    const bootstrap = decodeCleanupBootstrap(value);
    const reply = releaseOwnedReadLock(bootstrap, "a".repeat(64));
    process.send!(reply, sendError => { if (sendError) process.exitCode = 1; process.disconnect(); });
  });
} else if (kind === "cleanup-measured") {
  process.once("message", value => {
    const bootstrap = decodeCleanupBootstrap(value);
    const measured = (JSON.parse(readFileSync(new URL("../../../dist/v2-build.json", import.meta.url), "utf8")) as { buildIdentityHash: string }).buildIdentityHash;
    const reply = releaseOwnedReadLock(bootstrap, measured);
    process.send!(reply, sendError => { if (sendError) process.exitCode = 1; process.disconnect(); });
  });
} else throw new Error("fixture mode required");
