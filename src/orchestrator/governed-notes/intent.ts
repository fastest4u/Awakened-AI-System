import { createHash, timingSafeEqual } from "node:crypto";
import type { GovernedNoteCommandV1, GovernedNoteAuthoritySnapshotV1, GovernedNoteWitnessV1 } from "./contracts.js";
import type { ProjectBinding } from "../projections/contracts.js";
import { evidenceMac, evidenceMacInput, requireEvidenceKey, type EvidenceKeyRefV1, type EvidenceKeyProvider } from "../privacy/evidence-key-provider.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { decodeGovernedNoteCommandV1 } from "./codec.js";
import { GovernedNoteError } from "./errors.js";

/** Raw original text is transient. Only the provider MAC is durable. */
export function buildGovernedNoteOriginalCommitment(command: GovernedNoteCommandV1, authority: GovernedNoteAuthoritySnapshotV1, binding: ProjectBinding, ref: EvidenceKeyRefV1, provider: EvidenceKeyProvider): string {
  const owned = decodeGovernedNoteCommandV1(command), scope = { projectId: authority.projectId, storeId: authority.storeId };
  let canonical: Buffer | undefined, input: Buffer | undefined;
  try {
    const historical = requireEvidenceKey(provider, scope, "original-input-commitment", ref);
    canonical = Buffer.from(canonicalJson({ authority, binding, command: owned }), "utf8");
    input = evidenceMacInput(scope, historical, canonical.toString("utf8"));
    return evidenceMac(provider, scope, "original-input-commitment", historical, "governed-note-original-input/v1", input);
  } catch { throw new GovernedNoteError("GOVERNED_NOTE_KEY_UNAVAILABLE", { commandId: owned.commandId, idempotencyKey: owned.idempotencyKey }); }
  finally { canonical?.fill(0); input?.fill(0); }
}

/** Called only after durable witness authentication. Historical replay never selects current keys. */
export function assertGovernedNoteOriginalEquality(command: GovernedNoteCommandV1, authority: GovernedNoteAuthoritySnapshotV1, binding: ProjectBinding, witness: GovernedNoteWitnessV1, provider: EvidenceKeyProvider): void {
  const owned = decodeGovernedNoteCommandV1(command);
  if (canonicalJson(authority) !== canonicalJson(witness.authority) || canonicalJson(binding) !== canonicalJson(witness.binding)) throw new GovernedNoteError("SESSION_OWNERSHIP_MISMATCH");
  if (owned.commandId !== witness.commandId || owned.idempotencyKey !== witness.idempotencyKey) throw new GovernedNoteError("IDEMPOTENCY_CONFLICT");
  if (typeof witness.originalInputCommitment !== "string" || !/^[0-9a-f]{64}$/.test(witness.originalInputCommitment)) throw new GovernedNoteError("INTEGRITY_FAILURE");
  let expected: Buffer | undefined, actual: Buffer | undefined;
  try {
    expected = Buffer.from(witness.originalInputCommitment, "hex");
    actual = Buffer.from(buildGovernedNoteOriginalCommitment(owned, authority, binding, witness.originalCommitmentKeyRef, provider), "hex");
    if (!timingSafeEqual(expected, actual)) throw new GovernedNoteError("IDEMPOTENCY_CONFLICT");
  } finally { expected?.fill(0); actual?.fill(0); }
}

export function governedNoteCommandHash(witness: GovernedNoteWitnessV1): string {
  return createHash("sha256").update("project-memory/governed-note-command/v1\n", "utf8").update(canonicalJson(witness), "utf8").digest("hex");
}
export function governedNoteSummaryHash(summary: string): string {
  return createHash("sha256").update("project-memory/governed-note-summary/v1\n", "utf8").update(canonicalJson(summary), "utf8").digest("hex");
}
