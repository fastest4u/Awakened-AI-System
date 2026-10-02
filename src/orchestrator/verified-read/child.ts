import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createCwdProjectionReadCore } from "../projections/stable-directory-read-core.js";
import { parseProjectionManifestV2, type ProjectionManifestV2 } from "../projections/manifest-codec.js";
import { openImmutableProjectionImage } from "../projections/immutable-image.js";
import { readProjectionImageMetadata } from "../projections/image-metadata.js";
import { assertBoundSqliteConnectionIdentity, NodeSqliteDriver } from "../storage/node-sqlite-driver.js";
import type { SqliteConnection } from "../storage/sqlite-driver.js";
import { SqliteVerifiedReadAdmission } from "./admission.js";
import type { ReadBootstrap, ReadPhase, ReadReply, ReadTerminalReply, VerifiedReadReceipt } from "./contracts.js";
import { decodeReadBootstrap, decodeVerifiedReadReceipt, verifiedReadFailure } from "./protocol.js";

/** Fixed owner closures only. Never transported in bootstrap, argv or environment. */
export interface VerifiedReadChildDependencies {
  inspectBuild(): string;
  now(): number;
  wait(ms: number, signal: AbortSignal): Promise<void>;
  signal: AbortSignal;
  emitStage(reply: Extract<ReadReply, { kind: "stage" }>): void;
}
function fail(code: string): never { throw new Error(code); }

/** Metadata certification of an already published image; never builds or repairs publication. */
export async function executeVerifiedRead(bootstrap: ReadBootstrap, dependencies: VerifiedReadChildDependencies): Promise<ReadTerminalReply> {
  const started = dependencies.now();
  const input = decodeReadBootstrap(bootstrap);
  const deadline = started + input.remainingMs;
  let reader: SqliteConnection | undefined;
  let image: DatabaseSync | undefined;
  let imageAttempted = false, readerAttempted = false, lockAttempted = false;
  let imageClosed = true, readerClosed = true, lockClosed = true;
  let lockOwned = false;
  let primary: unknown;
  const core = createCwdProjectionReadCore(input.binding.projectionDirectory);
  const remaining = () => deadline - dependencies.now();
  const checkpoint = (): number => {
    if (dependencies.signal.aborted) {
      if (verifiedReadFailure(dependencies.signal.reason).code === "WORKER_PROTOCOL_ERROR") fail("WORKER_PROTOCOL_ERROR");
      fail("WORKER_CLOSED");
    }
    const budget = remaining();
    if (!Number.isFinite(budget) || budget <= 0) fail("WORKER_TIMEOUT");
    return Math.max(0, Math.floor(budget));
  };
  const stage = (phase: ReadPhase, observedProjectionPosition: string | null = null): void => {
    checkpoint(); dependencies.emitStage(Object.freeze({ version: 2, ids: input.ids, kind: "stage", phase, observedProjectionPosition }));
    checkpoint();
  };
  const closeImage = (): void => {
    if (!image || imageAttempted) return;
    imageAttempted = true; image.close(); imageClosed = true;
  };
  const closeReader = (): void => {
    if (!reader || readerAttempted) return;
    readerAttempted = true; reader.close(); readerClosed = true;
  };
  const closeLock = (): void => {
    if (!lockOwned || lockAttempted) return;
    lockAttempted = true;
    if (core.releaseOwnedLock(input.lockToken, false) !== "released") fail("PROJECTION_PATH_INVALID");
    lockClosed = true; lockOwned = false;
  };
  const manifest = () => {
    checkpoint(); const captured = core.captureManifest(); checkpoint();
    if (captured.state === "missing") return null;
    try { return { snapshot: captured, value: parseProjectionManifestV2(JSON.parse(Buffer.from(captured.bytesBase64, "base64").toString("utf8")) as unknown, input.binding.projectionBinding) }; }
    catch { return fail("INTEGRITY_FAILURE"); }
  };
  const lag = (required: string, observed: string | null): never => {
    throw Object.assign(new Error("PROJECTION_LAG"), { code: "PROJECTION_LAG", positions: Object.freeze({ required, observed }) });
  };
  try {
    // Content execution is deliberately unavailable until same-image integration (Task 5).
    if (input.request.operation !== "verify-published-view") fail("FRESH_START_INPUT_INVALID");
    checkpoint(); const measured = dependencies.inspectBuild(); checkpoint();
    if (!/^[0-9a-f]{64}$/u.test(measured) || measured !== input.binding.expectedRelease.buildIdentityHash) fail("FRESH_START_BUILD_MISMATCH");
    // Openers own native allocation until return; a throw cannot prove their hidden cleanup completed.
    readerClosed = false;
    reader = new NodeSqliteDriver({ DatabaseSync }).open(input.binding.eventsFile.path,
      { mode: "read-only-existing", bindFileIdentity: true, busyTimeoutMs: checkpoint() });
    // This is the exact owner-returned connection, rather than a path-only guard or wrapper.
    try { assertBoundSqliteConnectionIdentity(reader, input.binding.eventsFile.path, input.binding.eventsFile); }
    catch { fail("FRESH_START_PATH_CHANGED"); }
    const admission = new SqliteVerifiedReadAdmission(reader, input.binding, measured);
    stage("admission"); const fence = admission.capture(input.request); checkpoint();
    stage("projection-wait");
    let waits = 0, observed: string | null = null, selected: ProjectionManifestV2;
    let capturedBytes: Uint8Array;
    while (true) {
      const candidate = manifest(); observed = candidate?.value.terminalEventPosition ?? null;
      if (candidate && BigInt(candidate.value.terminalEventPosition) >= BigInt(fence.requiredPosition)) {
        checkpoint();
        // A throwing acquire can leave partial evidence: it proves no ownership and is never released here.
        lockClosed = false;
        const acquired = core.acquireLock(input.lockToken);
        if (acquired === "busy") lockClosed = true;
        else {
          lockOwned = true; lockAttempted = false; checkpoint();
          const locked = manifest(); observed = locked?.value.terminalEventPosition ?? null;
          if (locked && BigInt(locked.value.terminalEventPosition) >= BigInt(fence.requiredPosition)) {
            stage("capture", observed);
            const captured = core.captureGeneration(input.lockToken, locked.value.databaseFile, 64 * 1024 * 1024); checkpoint();
            // Compare the real locked bytes AND provenance after named image capture, before releasing this token.
            const after = core.captureManifest(); checkpoint();
            if (after.state !== "present" || after.ctimeNs !== locked.snapshot.ctimeNs
              || after.bytesBase64 !== locked.snapshot.bytesBase64
              || after.fileIdentity.device !== locked.snapshot.fileIdentity.device
              || after.fileIdentity.inode !== locked.snapshot.fileIdentity.inode
              || after.fileIdentity.size !== locked.snapshot.fileIdentity.size
              || after.fileIdentity.sha256 !== locked.snapshot.fileIdentity.sha256) fail("PROJECTION_PATH_INVALID");
            selected = locked.value; capturedBytes = captured.bytes; break;
          }
          closeLock(); checkpoint();
        }
      }
      // Full fixed delays only, all within the retained remaining budget; no lock across await.
      if (waits >= 600 || remaining() < 50) lag(fence.requiredPosition, observed);
      checkpoint(); waits++;
      try { await dependencies.wait(50, dependencies.signal); }
      catch (error) { if (dependencies.signal.aborted) checkpoint(); throw error; }
      if (dependencies.signal.aborted) checkpoint();
      if (waits >= 600 || remaining() <= 0) lag(fence.requiredPosition, observed);
    }
    stage("validate", selected.terminalEventPosition);
    const sha256 = createHash("sha256").update(capturedBytes).digest("hex");
    if (sha256 !== selected.databaseSha256) fail("INTEGRITY_FAILURE");
    const imageTimeout = checkpoint(); imageClosed = false;
    image = openImmutableProjectionImage(capturedBytes, imageTimeout); checkpoint();
    const metadata = readProjectionImageMetadata(image, selected); checkpoint();
    const receipt: VerifiedReadReceipt = decodeVerifiedReadReceipt({ operation: input.request.operation, consistency: input.request.consistency,
      scope: { ...input.binding.projectionBinding, sessionId: input.request.consistency === "session-strong" ? input.binding.session!.sessionId : null },
      releaseId: fence.releaseId, controlGeneration: fence.controlGeneration, requiredEventPosition: fence.requiredPosition,
      projectionGeneration: metadata.generation, projectionEventPosition: metadata.terminalEventPosition,
      projectionEventHash: metadata.terminalEventHash, imageSha256: sha256, verification: "image-scope-position-and-active-admission" });
    closeImage(); closeLock(); checkpoint();
    stage("revalidate", selected.terminalEventPosition);
    admission.revalidate(fence, selected); checkpoint();
    // Linearizes at final authority observation. Closure is still required before any terminal success.
    closeReader(); checkpoint();
    return Object.freeze({ version: 2, ids: input.ids, kind: "success", receipt: Object.freeze({ ...receipt, operation: "verify-published-view" as const }), fence,
      closed: Object.freeze({ image: true, reader: true, lock: true }) });
  } catch (error) { primary = error; }
  // Each resource gets one close attempt. Cleanup errors never replace the primary failure.
  for (const close of [closeImage, closeLock, closeReader]) {
    try { close(); } catch (error) { primary ??= error; }
  }
  const failure = verifiedReadFailure(primary);
  return Object.freeze({ version: 2, ids: input.ids, kind: "failure", failure: Object.freeze({ ...failure,
    cleanup: imageClosed && readerClosed && lockClosed ? "complete" : "incomplete" }) });
}
