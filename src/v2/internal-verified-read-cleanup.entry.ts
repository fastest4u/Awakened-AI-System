import { performance } from "node:perf_hooks";
import { releaseOwnedReadLock } from "../orchestrator/verified-read/cleanup.js";
import { decodeCleanupBootstrap, decodeCleanupReply } from "../orchestrator/verified-read/protocol.js";
import { inspectV2BuildAsync } from "./build-identity.js";

let received = false;
let closing = false;
let active: AbortController | undefined;
let timer: NodeJS.Timeout | undefined;
function close(): void { closing = true; active?.abort(); if (timer) clearTimeout(timer); if (process.connected) process.disconnect(); }
if (!process.send || process.argv.length !== 2) { process.exitCode = 1; close(); }
else {
  process.once("disconnect", () => { if (!closing) { process.exitCode = 1; close(); } });
  process.on("message", async value => {
    if (received) { process.exitCode = 1; close(); return; }
    received = true;
    try {
      const started = performance.now();
      const bootstrap = decodeCleanupBootstrap(value), deadline = started + bootstrap.remainingMs;
      active = new AbortController();
      const remaining = () => active!.signal.aborted ? 0 : Math.max(0, deadline - performance.now());
      timer = setTimeout(() => active!.abort(), remaining());
      let measured = "";
      if (remaining() > 0) try { measured = await inspectV2BuildAsync(import.meta.url, active.signal); } catch { /* Refuse uncertain/expired identity. */ }
      if (closing || !process.connected) return;
      // Identity measurement has closed every handle. Recheck the receipt deadline before ownership work.
      const input = { ...bootstrap, remainingMs: remaining() };
      let reply = releaseOwnedReadLock(input, measured);
      if (remaining() <= 0) reply = { version: 1, ids: bootstrap.ids, kind: "cleanup", outcome: "failed", cleanup: "incomplete" };
      if (closing || !process.connected) return;
      process.send!(decodeCleanupReply(reply), error => { if (error) process.exitCode = 1; close(); });
    } catch { process.exitCode = 1; close(); }
  });
}
