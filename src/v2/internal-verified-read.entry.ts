import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { executeVerifiedRead, executeFullNoteVerifiedRead } from "../orchestrator/verified-read/child.js";
import type { ReadBootstrap, ReadTerminalReply, FullNoteReadBootstrapV1, FullNoteReadTerminalReplyV1, ReadReply, FullNoteReadReplyV1 } from "../orchestrator/verified-read/contracts.js";
import { assertReadReplyEnvelope, readEnvelopeVersion, decodeReadBootstrap, decodeReadCancel, decodeReadReply } from "../orchestrator/verified-read/protocol.js";
import { decodeFullNoteReadBootstrap, decodeFullNoteReadCancel, decodeFullNoteReadReply } from "../orchestrator/verified-read/full-note-protocol.js";
import { inspectV2Build } from "./build-identity.js";

// Fixed private IPC entry. The measured build recipe is the sole source of execution identity.
const controller = new AbortController();
let bootstrap: ReadBootstrap | FullNoteReadBootstrapV1 | undefined;
let terminal = false, protocolFault = false;
function disconnect(): void { if (process.connected) process.disconnect(); }
function protocolFailure(): void {
  protocolFault = true; controller.abort(new Error("WORKER_PROTOCOL_ERROR"));
  if (!bootstrap || terminal) { process.exitCode = 1; disconnect(); }
}
function ownedReply(reply: ReadReply | FullNoteReadReplyV1): ReadReply | FullNoteReadReplyV1 {
  if (!bootstrap) throw new Error("WORKER_PROTOCOL_ERROR");
  assertReadReplyEnvelope(reply, bootstrap.version, bootstrap.ids);
  return bootstrap.version === 4 ? decodeFullNoteReadReply(reply, bootstrap.request) : decodeReadReply(reply);
}
function finish(reply: ReadTerminalReply | FullNoteReadTerminalReplyV1): void {
  if (terminal) return;
  terminal = true;
  const final = protocolFault ? { version: bootstrap!.version, ids: bootstrap!.ids, kind: "failure" as const,
    failure: { code: "WORKER_PROTOCOL_ERROR" as const, cleanup: reply.kind === "failure" ? reply.failure.cleanup : "complete" as const, positions: null } } : reply;
  if (!process.send || !process.connected) { process.exitCode = 1; disconnect(); return; }
  process.send(ownedReply(final), error => { if (error) process.exitCode = 1; disconnect(); });
}
if (!process.send || process.argv.length !== 2) { process.exitCode = 1; disconnect(); }
else {
  process.on("disconnect", () => controller.abort());
  process.on("message", value => {
    if (bootstrap) {
      try {
        const cancel = bootstrap.version === 4 ? decodeFullNoteReadCancel(value) : decodeReadCancel(value);
        if (cancel.ids.requestId !== bootstrap.ids.requestId || cancel.ids.attemptId !== bootstrap.ids.attemptId
          || cancel.ids.laneEpoch !== bootstrap.ids.laneEpoch) protocolFailure();
        else controller.abort(); // Known duplicate cancel remains idempotent.
      } catch { protocolFailure(); }
      return;
    }
    try { bootstrap = readEnvelopeVersion(value) === 4 ? decodeFullNoteReadBootstrap(value) : decodeReadBootstrap(value); } catch { protocolFailure(); return; }
    const dependencies = { inspectBuild: () => inspectV2Build(import.meta.url), now: () => performance.now(),
      wait: async (ms: number, signal: AbortSignal) => { await setTimeout(ms, undefined, { signal }); }, signal: controller.signal,
      emitStage: (reply: Extract<ReadReply | FullNoteReadReplyV1, { kind: "stage" }>) => { if (!process.send || !process.connected) throw new Error("WORKER_CLOSED");
        process.send(ownedReply(reply), error => { if (error) controller.abort(); }); } };
    void (bootstrap.version === 4 ? executeFullNoteVerifiedRead(bootstrap, dependencies) : executeVerifiedRead(bootstrap, dependencies))
      .then(finish, () => { process.exitCode = 1; disconnect(); });
  });
}
