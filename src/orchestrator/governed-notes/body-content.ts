import { createHash } from "node:crypto";
import type { MarkdownNoteContentV1 } from "./contracts.js";
import { GovernedNoteError } from "./errors.js";
import { retainedExactRecord, retainedStringMetrics, RetainedEvidenceError } from "../privacy/evidence-contracts.js";
import { canonicalJson } from "../serialization/canonical-json.js";

/** Literal Markdown is inert text; only validity is checked, never normalization. */
export function assertMarkdownNoteBodyV1(body: unknown): asserts body is string {
  try { retainedStringMetrics(body, 65536); }
  catch (error) { throw new GovernedNoteError(error instanceof RetainedEvidenceError && error.code === "RETAINED_EVIDENCE_LIMIT_EXCEEDED" ? "GOVERNED_NOTE_LIMIT_EXCEEDED" : "GOVERNED_NOTE_INPUT_INVALID"); }
  if (typeof body !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body) || body.trim().length === 0) throw new GovernedNoteError("GOVERNED_NOTE_INPUT_INVALID");
}

export function governedNoteBodyHash(content: MarkdownNoteContentV1): string {
  let r: Record<string, unknown>;
  try { r = retainedExactRecord(content, ["format", "body"]); }
  catch { throw new GovernedNoteError("GOVERNED_NOTE_INPUT_INVALID"); }
  if (r.format !== "markdown") throw new GovernedNoteError("GOVERNED_NOTE_INPUT_INVALID");
  assertMarkdownNoteBodyV1(r.body);
  return createHash("sha256").update("project-memory/governed-note-body/v1\n").update(canonicalJson({ format: "markdown", body: r.body })).digest("hex");
}
