import { writeFileSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createCwdProjectionReadCore } from "../../src/orchestrator/projections/stable-directory-read-core.js";
import { releaseOwnedReadLock } from "../../src/orchestrator/verified-read/cleanup.js";
import { decodeCleanupBootstrap, decodeReadBootstrap } from "../../src/orchestrator/verified-read/protocol.js";
import { executeVerifiedRead } from "../../src/orchestrator/verified-read/child.js";

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
} else if (kind === "cleanup") {
  process.once("message", value => {
    const bootstrap = decodeCleanupBootstrap(value);
    const reply = releaseOwnedReadLock(bootstrap, "a".repeat(64));
    process.send!(reply, sendError => { if (sendError) process.exitCode = 1; process.disconnect(); });
  });
} else throw new Error("fixture mode required");
