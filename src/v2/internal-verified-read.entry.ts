import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { executeVerifiedRead } from "../orchestrator/verified-read/child.js";
import type { ReadBootstrap, ReadTerminalReply } from "../orchestrator/verified-read/contracts.js";
import { decodeReadBootstrap, decodeReadCancel, decodeReadReply } from "../orchestrator/verified-read/protocol.js";
import { inspectV2Build } from "./build-identity.js";

// Fixed private IPC entry. The measured build recipe is the sole source of execution identity.
const controller = new AbortController();
let bootstrap: ReadBootstrap | undefined;
let terminal = false, protocolFault = false;
function disconnect(): void { if (process.connected) process.disconnect(); }
function protocolFailure(): void {
  protocolFault = true; controller.abort(new Error("WORKER_PROTOCOL_ERROR"));
  if (!bootstrap || terminal) { process.exitCode = 1; disconnect(); }
}
function finish(reply: ReadTerminalReply): void {
  if (terminal) return;
  terminal = true;
  const final = protocolFault ? { version: 2 as const, ids: reply.ids, kind: "failure" as const,
    failure: { code: "WORKER_PROTOCOL_ERROR" as const, cleanup: reply.kind === "failure" ? reply.failure.cleanup : "complete" as const, positions: null } } : reply;
  if (!process.send || !process.connected) { process.exitCode = 1; disconnect(); return; }
  process.send(decodeReadReply(final), error => { if (error) process.exitCode = 1; disconnect(); });
}
if (!process.send || process.argv.length !== 2) { process.exitCode = 1; disconnect(); }
else {
  process.on("disconnect", () => controller.abort());
  process.on("message", value => {
    if (bootstrap) {
      try {
        const cancel = decodeReadCancel(value);
        if (cancel.ids.requestId !== bootstrap.ids.requestId || cancel.ids.attemptId !== bootstrap.ids.attemptId
          || cancel.ids.laneEpoch !== bootstrap.ids.laneEpoch) protocolFailure();
        else controller.abort(); // Known duplicate cancel remains idempotent.
      } catch { protocolFailure(); }
      return;
    }
    try { bootstrap = decodeReadBootstrap(value); } catch { protocolFailure(); return; }
    void executeVerifiedRead(bootstrap, { inspectBuild: () => inspectV2Build(import.meta.url), now: () => performance.now(),
      wait: async (ms, signal) => { await setTimeout(ms, undefined, { signal }); }, signal: controller.signal,
      emitStage: reply => { if (!process.send || !process.connected) throw new Error("WORKER_CLOSED");
        process.send(decodeReadReply(reply), error => { if (error) controller.abort(); }); } })
      .then(finish, () => { process.exitCode = 1; disconnect(); });
  });
}
