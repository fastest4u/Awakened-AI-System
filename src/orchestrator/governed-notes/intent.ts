import { createHash, timingSafeEqual } from "node:crypto";
import type { GovernedNoteCommandV1, GovernedNoteAuthoritySnapshotV1, GovernedNoteWitnessV1, GovernedNoteCommandV2, GovernedNoteWitnessV2 } from "./contracts.js";
import type { ProjectBinding } from "../projections/contracts.js";
import { evidenceMac, evidenceMacInput, requireEvidenceKey, type EvidenceKeyRefV1, type EvidenceKeyProvider } from "../privacy/evidence-key-provider.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { decodeGovernedNoteCommandV1, decodeGovernedNoteCommandV2 } from "./codec.js";
import { GovernedNoteError } from "./errors.js";

/** Receives an owned version-decoded original; raw text remains transient. */
function buildDecodedOriginalCommitment(owned: GovernedNoteCommandV1 | GovernedNoteCommandV2, authority: GovernedNoteAuthoritySnapshotV1, binding: ProjectBinding, ref: EvidenceKeyRefV1, provider: EvidenceKeyProvider, domain: "governed-note-original-input/v1" | "governed-note-original-input/v2"): string {
  const scope = { projectId: authority.projectId, storeId: authority.storeId };
  let canonical: Buffer | undefined, input: Buffer | undefined;
  try {
    const historical = requireEvidenceKey(provider, scope, "original-input-commitment", ref);
    canonical = Buffer.from(canonicalJson({ authority, binding, command: owned }), "utf8");
    input = evidenceMacInput(scope, historical, canonical.toString("utf8"));
    return evidenceMac(provider, scope, "original-input-commitment", historical, domain, input);
  } catch { throw new GovernedNoteError("GOVERNED_NOTE_KEY_UNAVAILABLE", { commandId: owned.commandId, idempotencyKey: owned.idempotencyKey }); }
  finally { canonical?.fill(0); input?.fill(0); }
}

/** Called only after durable witness authentication with its version's builder. */
function assertDecodedOriginalEquality(owned: GovernedNoteCommandV1 | GovernedNoteCommandV2, authority: GovernedNoteAuthoritySnapshotV1, binding: ProjectBinding, witness: GovernedNoteWitnessV1 | GovernedNoteWitnessV2, buildCommitment: () => string): void {
  if (canonicalJson(authority) !== canonicalJson(witness.authority) || canonicalJson(binding) !== canonicalJson(witness.binding)) throw new GovernedNoteError("SESSION_OWNERSHIP_MISMATCH");
  if (owned.commandId !== witness.commandId || owned.idempotencyKey !== witness.idempotencyKey) throw new GovernedNoteError("IDEMPOTENCY_CONFLICT");
  if (typeof witness.originalInputCommitment !== "string" || !/^[0-9a-f]{64}$/.test(witness.originalInputCommitment)) throw new GovernedNoteError("INTEGRITY_FAILURE");
  let expected: Buffer | undefined, actual: Buffer | undefined;
  try {
    expected = Buffer.from(witness.originalInputCommitment, "hex");
    actual = Buffer.from(buildCommitment(), "hex");
    if (!timingSafeEqual(expected, actual)) throw new GovernedNoteError("IDEMPOTENCY_CONFLICT");
  } finally { expected?.fill(0); actual?.fill(0); }
}

/** Raw original text is transient. Only the provider MAC is durable. */
export function buildGovernedNoteOriginalCommitment(command: GovernedNoteCommandV1, authority: GovernedNoteAuthoritySnapshotV1, binding: ProjectBinding, ref: EvidenceKeyRefV1, provider: EvidenceKeyProvider): string {
  return buildDecodedOriginalCommitment(decodeGovernedNoteCommandV1(command), authority, binding, ref, provider, "governed-note-original-input/v1");
}

/** Called only after durable witness authentication. Historical replay never selects current keys. */
export function assertGovernedNoteOriginalEquality(command: GovernedNoteCommandV1, authority: GovernedNoteAuthoritySnapshotV1, binding: ProjectBinding, witness: GovernedNoteWitnessV1, provider: EvidenceKeyProvider): void {
  const owned = decodeGovernedNoteCommandV1(command);
  assertDecodedOriginalEquality(owned, authority, binding, witness, () => buildDecodedOriginalCommitment(owned, authority, binding, witness.originalCommitmentKeyRef, provider, "governed-note-original-input/v1"));
}

export function governedNoteCommandHash(witness: GovernedNoteWitnessV1): string {
  return createHash("sha256").update("project-memory/governed-note-command/v1\n", "utf8").update(canonicalJson(witness), "utf8").digest("hex");
}
/** Raw original text is transient. Only the provider MAC is durable. */
export function buildGovernedNoteOriginalCommitmentV2(command: GovernedNoteCommandV2, authority: GovernedNoteAuthoritySnapshotV1, binding: ProjectBinding, ref: EvidenceKeyRefV1, provider: EvidenceKeyProvider): string {
  return buildDecodedOriginalCommitment(decodeGovernedNoteCommandV2(command), authority, binding, ref, provider, "governed-note-original-input/v2");
}

/** Called only after durable witness authentication. Historical replay never selects current keys. */
export function assertGovernedNoteOriginalEqualityV2(command: GovernedNoteCommandV2, authority: GovernedNoteAuthoritySnapshotV1, binding: ProjectBinding, witness: GovernedNoteWitnessV2, provider: EvidenceKeyProvider): void {
  const owned = decodeGovernedNoteCommandV2(command);
  assertDecodedOriginalEquality(owned, authority, binding, witness, () => buildDecodedOriginalCommitment(owned, authority, binding, witness.originalCommitmentKeyRef, provider, "governed-note-original-input/v2"));
}
export function governedNoteCommandHashV2(witness: GovernedNoteWitnessV2): string {
  return createHash("sha256").update("project-memory/governed-note-command/v2\n", "utf8").update(canonicalJson(witness), "utf8").digest("hex");
}
export function governedNoteSummaryHash(summary: string): string {
  return createHash("sha256").update("project-memory/governed-note-summary/v1\n", "utf8").update(canonicalJson(summary), "utf8").digest("hex");
}
