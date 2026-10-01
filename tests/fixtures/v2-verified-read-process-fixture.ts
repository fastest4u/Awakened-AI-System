import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createCwdProjectionReadCore } from "../../src/orchestrator/projections/stable-directory-read-core.js";
import { releaseOwnedReadLock } from "../../src/orchestrator/verified-read/cleanup.js";
import { decodeCleanupBootstrap, decodeReadBootstrap } from "../../src/orchestrator/verified-read/protocol.js";

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
} else if (kind === "cleanup") {
  process.once("message", value => {
    const bootstrap = decodeCleanupBootstrap(value);
    const reply = releaseOwnedReadLock(bootstrap, "a".repeat(64));
    process.send!(reply, sendError => { if (sendError) process.exitCode = 1; process.disconnect(); });
  });
} else throw new Error("fixture mode required");
