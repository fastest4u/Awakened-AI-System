import type { JsonValue } from "../contracts/event.js";
import { GOVERNED_NOTE_LIMITS } from "../governed-notes/contracts.js";
import { GovernedNoteError } from "../governed-notes/errors.js";
import { canonicalJson } from "../serialization/canonical-json.js";
import { assertRetainedByteLimit, boundedRetainedJson, retainedDataEntries, retainedExactRecord, retainedStringMetrics, RETAINED_EVIDENCE_LIMITS, RetainedEvidenceError, type BoundedEvidenceInputV1, type RetainedEvidenceFrameV1 } from "./evidence-contracts.js";

export type TrustedRedactionRuleV1 =
  | { readonly kind: "literal"; readonly ruleId: string; readonly value: string }
  | { readonly kind: "token"; readonly ruleId: string; readonly prefix: string }
  | { readonly kind: "process-secret"; readonly ruleId: string; readonly referenceId: string; readonly required: boolean; readonly value: string | null };
export interface TrustedRedactionPolicyV1 { readonly policyId: string; readonly policyVersion: string; readonly rules: readonly TrustedRedactionRuleV1[]; }
export interface RedactionSpanV1 { readonly ruleId: string; readonly startByte: number; readonly endByte: number; }
export type RedactedEvidenceFrameV1 = RetainedEvidenceFrameV1 & { readonly manifest: readonly RedactionSpanV1[]; };
export interface RedactedEvidenceBatchV1 { readonly policyId: string; readonly policyVersion: string; readonly frames: readonly RedactedEvidenceFrameV1[]; readonly spanCount: number; }
/** Plain-text transformation shares the retained processor; its manifest stays transient. */
export function redactGovernedNoteSummaryV1(summary: string, policy: TrustedRedactionPolicyV1): Readonly<{ summary: string; policyId: string; policyVersion: string }> {
  const checkSummary = (value: string): void => {
    try { retainedStringMetrics(value, GOVERNED_NOTE_LIMITS.summaryBytes); }
    catch (error) { throw new GovernedNoteError(error instanceof RetainedEvidenceError && error.code === "RETAINED_EVIDENCE_LIMIT_EXCEEDED" ? "GOVERNED_NOTE_LIMIT_EXCEEDED" : "GOVERNED_NOTE_INPUT_INVALID"); }
    if (value.length === 0) throw new GovernedNoteError("GOVERNED_NOTE_INPUT_INVALID");
  };
  checkSummary(summary); const normalized = summary.normalize("NFC").trim(); checkSummary(normalized);
  let trusted: TrustedRedactionPolicyV1; let transformed: string;
  try {
    trusted = trustedPolicy(policy);
    transformed = transformString(normalized, false, 0, trusted.rules, [], GOVERNED_NOTE_LIMITS.spans);
  } catch (error) { throw new GovernedNoteError(error instanceof RetainedEvidenceError && error.code === "RETAINED_EVIDENCE_LIMIT_EXCEEDED" ? "GOVERNED_NOTE_LIMIT_EXCEEDED" : "GOVERNED_NOTE_POLICY_UNAVAILABLE"); }
  checkSummary(transformed);
  return Object.freeze({ summary: transformed, policyId: trusted.policyId, policyVersion: trusted.policyVersion });
}
const POLICY = "RETAINED_EVIDENCE_POLICY_UNAVAILABLE";
const PLACEHOLDER = "[REDACTED]";
const CREDENTIAL_RULE = "builtin:credential-field";
const AUTHORIZATION_RULE = "builtin:authorization-header";
const PRIVATE_KEY_RULE = "builtin:private-key-block";
const CREDENTIAL_FIELDS = new Set(["password", "passwd", "secret", "secretkey", "awssecretaccesskey", "clientsecret", "apikey", "accesstoken", "refreshtoken", "token", "privatekey", "credential", "credentials"]);
function unavailable(): never { throw new RetainedEvidenceError(POLICY); }
function fieldName(value: string): string { return value.toLowerCase().replace(/[_-]/g, ""); }
function fieldRule(value: string): string | undefined {
  const normalized = fieldName(value);
  return normalized === "authorization" || normalized === "proxyauthorization" ? AUTHORIZATION_RULE : CREDENTIAL_FIELDS.has(normalized) ? CREDENTIAL_RULE : undefined;
}
function policyId(value: unknown): string {
  const metrics = retainedStringMetrics(value, RETAINED_EVIDENCE_LIMITS.identifierScalars * 4, POLICY);
  assertRetainedByteLimit(metrics.scalars, RETAINED_EVIDENCE_LIMITS.identifierScalars);
  if (metrics.scalars === 0) unavailable();
  return value as string;
}
function literal(value: unknown): string {
  const metrics = retainedStringMetrics(value, RETAINED_EVIDENCE_LIMITS.literalBytes, POLICY);
  if (metrics.bytes === 0) unavailable();
  return value as string;
}
function trustedPolicy(value: TrustedRedactionPolicyV1): TrustedRedactionPolicyV1 {
  const record = retainedExactRecord(value, ["policyId", "policyVersion", "rules"], POLICY);
  const entries = retainedDataEntries(record.rules, RETAINED_EVIDENCE_LIMITS.rules, POLICY);
  if (!Object.isFrozen(value) || !Array.isArray(record.rules)) unavailable();
  if (!Object.isFrozen(record.rules)) unavailable();
  const rules: TrustedRedactionRuleV1[] = []; const ids = new Set<string>();
  for (const [, item] of entries) {
    const fields = retainedDataEntries(item, RETAINED_EVIDENCE_LIMITS.batchBytes, POLICY);
    const kind = fields.find(([key]) => key === "kind")?.[1];
    const expected = kind === "literal" ? ["kind", "ruleId", "value"] : kind === "token" ? ["kind", "ruleId", "prefix"] : kind === "process-secret" ? ["kind", "ruleId", "referenceId", "required", "value"] : undefined;
    if (expected === undefined) unavailable();
    const rule = retainedExactRecord(item, expected, POLICY);
    if (!Object.isFrozen(item)) unavailable();
    const ruleId = policyId(rule.ruleId); if (ids.has(ruleId) || ruleId.startsWith("builtin:")) unavailable(); ids.add(ruleId);
    if (kind === "literal") rules.push(Object.freeze({ kind, ruleId, value: literal(rule.value) }));
    else if (kind === "token") rules.push(Object.freeze({ kind, ruleId, prefix: literal(rule.prefix) }));
    else {
      const referenceId = policyId(rule.referenceId);
      if (typeof rule.required !== "boolean" || (rule.value === null && rule.required)) unavailable();
      rules.push(Object.freeze({ kind: "process-secret", ruleId, referenceId, required: rule.required, value: rule.value === null ? null : literal(rule.value) }));
    }
  }
  rules.sort((a, b) => a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0);
  return Object.freeze({ policyId: policyId(record.policyId), policyVersion: policyId(record.policyVersion), rules: Object.freeze(rules) });
}

interface CharacterSpan { ruleId: string; start: number; end: number; }
/** Merge immediately: memory is bounded by input characters, including duplicate rules. */
function mergeSpan(spans: CharacterSpan[], candidate: CharacterSpan): void {
  if (candidate.end <= candidate.start) return;
  let low = 0; let high = spans.length;
  while (low < high) { const mid = (low + high) >>> 1; if (spans[mid]!.end <= candidate.start) low = mid + 1; else high = mid; }
  let last = low;
  while (last < spans.length && spans[last]!.start < candidate.end) {
    const prior = spans[last]!; candidate.start = Math.min(candidate.start, prior.start); candidate.end = Math.max(candidate.end, prior.end);
    if (prior.ruleId < candidate.ruleId) candidate.ruleId = prior.ruleId;
    last++;
  }
  spans.splice(low, last - low, candidate);
}
function tokenCharacter(unit: number): boolean { return (unit >= 48 && unit <= 57) || (unit >= 65 && unit <= 90) || (unit >= 97 && unit <= 122) || [43, 45, 46, 47, 61, 95].includes(unit); }
function scanText(text: string, rules: readonly TrustedRedactionRuleV1[], forcedRule?: string): CharacterSpan[] {
  const spans: CharacterSpan[] = [];
  const add = (ruleId: string, start: number, end: number) => mergeSpan(spans, { ruleId, start, end });
  if (forcedRule !== undefined) add(forcedRule, 0, text.length);
  for (const rule of rules) {
    const pattern = rule.kind === "token" ? rule.prefix : rule.value;
    if (pattern === null) continue;
    let from = 0;
    while (from <= text.length - pattern.length) {
      const start = text.indexOf(pattern, from); if (start === -1) break;
      let end = start + pattern.length;
      if (rule.kind === "token") while (end < text.length && tokenCharacter(text.charCodeAt(end))) end++;
      add(rule.ruleId, start, end); from = start + 1;
    }
  }
  // Fixed field scanner: name[:=]value, with quoted and unquoted scalar values.
  for (let index = 0; index < text.length;) {
    const start = index;
    while (index < text.length && /[A-Za-z_-]/.test(text[index]!)) index++;
    if (index === start) { index++; continue; }
    const name = text.slice(start, index); const ruleId = fieldRule(name);
    if (ruleId === undefined) continue;
    let cursor = index; while (text[cursor] === " " || text[cursor] === "\t" || text[cursor] === '"' || text[cursor] === "'") cursor++;
    if (text[cursor] !== ":" && text[cursor] !== "=") continue;
    cursor++; while (text[cursor] === " " || text[cursor] === "\t") cursor++;
    const quote = text[cursor] === '"' || text[cursor] === "'" ? text[cursor++] : undefined;
    const valueStart = cursor;
    if (ruleId === AUTHORIZATION_RULE && quote === undefined) { while (cursor < text.length && text[cursor] !== "\r" && text[cursor] !== "\n") cursor++; }
    else if (quote !== undefined) { while (cursor < text.length && text[cursor] !== quote && text[cursor] !== "\r" && text[cursor] !== "\n") { if (text[cursor] === "\\" && cursor + 1 < text.length) cursor++; cursor++; } }
    else while (cursor < text.length && !/[\s,;}]/.test(text[cursor]!)) cursor++;
    add(ruleId, valueStart, cursor); index = cursor;
  }
  // Fixed PEM scanner, including incomplete blocks: never leave trailing key bytes.
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf("-----BEGIN ", from); if (start === -1) break;
    const labelEnd = text.indexOf("-----", start + 11);
    if (labelEnd === -1) break;
    const label = text.slice(start + 11, labelEnd);
    if (label !== "PRIVATE KEY" && !label.endsWith(" PRIVATE KEY")) { from = labelEnd + 5; continue; }
    const closing = `-----END ${label}-----`; const closeStart = text.indexOf(closing, labelEnd + 5);
    const end = closeStart === -1 ? text.length : closeStart + closing.length;
    add(PRIVATE_KEY_RULE, start, end); from = end;
  }
  return spans;
}

function transformString(text: string, json: boolean, startByte: number, rules: readonly TrustedRedactionRuleV1[], manifest: RedactionSpanV1[], maximumSpans: number, forcedRule?: string): string {
  const spans = scanText(text, rules, forcedRule);
  assertRetainedByteLimit(manifest.length + spans.length, maximumSpans);
  if (spans.length === 0) return text;
  const offsets = new Uint32Array(text.length + 1);
  try {
    let bytes = 0;
    for (let index = 0; index < text.length; index++) {
      offsets[index] = bytes; const unit = text.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) { offsets[index + 1] = bytes; bytes += 4; index++; }
      else bytes += json && (unit === 34 || unit === 92 || [8, 9, 10, 12, 13].includes(unit)) ? 2 : json && unit < 32 ? 6 : unit < 128 ? 1 : unit < 2048 ? 2 : 3;
    }
    offsets[text.length] = bytes;
    const chunks: string[] = []; let cursor = 0;
    for (const span of spans) {
      manifest.push(Object.freeze({ ruleId: span.ruleId, startByte: startByte + offsets[span.start]!, endByte: startByte + offsets[span.end]! }));
      chunks.push(text.slice(cursor, span.start), PLACEHOLDER); cursor = span.end;
    }
    chunks.push(text.slice(cursor)); return chunks.join("");
  } finally { offsets.fill(0); }
}

function transformJson(content: JsonValue, rules: readonly TrustedRedactionRuleV1[], manifest: RedactionSpanV1[], maximumSpans: number): JsonValue {
  type Task = { readonly kind: "value"; readonly value: JsonValue; readonly assign: (value: JsonValue) => void; readonly forcedRule?: string }
    | { readonly kind: "property"; readonly key: string; readonly value: JsonValue; readonly copy: Record<string, JsonValue> }
    | { readonly kind: "token"; readonly bytes: number }
    | { readonly kind: "close"; readonly copy: object };
  const holder: { value?: JsonValue } = {}; let cursor = 0;
  const tasks: Task[] = [{ kind: "value", value: content, assign: value => { holder.value = value; } }];
  while (tasks.length !== 0) {
    const task = tasks.pop()!;
    if (task.kind === "token") { cursor += task.bytes; continue; }
    if (task.kind === "close") { cursor++; Object.freeze(task.copy); continue; }
    if (task.kind === "property") {
      const key = transformString(task.key, true, cursor + 1, rules, manifest, maximumSpans);
      cursor += retainedStringMetrics(task.key, RETAINED_EVIDENCE_LIMITS.frameBytes).quotedBytes + 1;
      if (Object.hasOwn(task.copy, key)) unavailable(); // A collision must not discard evidence.
      tasks.push({ kind: "value", value: task.value, forcedRule: fieldRule(task.key), assign: value => { Object.defineProperty(task.copy, key, { value, enumerable: true, writable: true, configurable: true }); } });
      continue;
    }
    const value = task.value;
    if (typeof value === "string") {
      task.assign(transformString(value, true, cursor + 1, rules, manifest, maximumSpans, task.forcedRule));
      cursor += retainedStringMetrics(value, RETAINED_EVIDENCE_LIMITS.frameBytes).quotedBytes; continue;
    }
    if (task.forcedRule !== undefined && value !== null) {
      const bytes = boundedRetainedJson(value, RETAINED_EVIDENCE_LIMITS.frameBytes).bytes;
      assertRetainedByteLimit(manifest.length + 1, maximumSpans);
      manifest.push(Object.freeze({ ruleId: task.forcedRule, startByte: cursor, endByte: cursor + bytes })); cursor += bytes;
      task.assign(PLACEHOLDER); continue;
    }
    if (value === null || typeof value !== "object") { task.assign(value); cursor += canonicalJson(value).length; continue; }
    const array = Array.isArray(value); const entries = retainedDataEntries(value, RETAINED_EVIDENCE_LIMITS.frameBytes);
    const copy: JsonValue[] | Record<string, JsonValue> = array ? [] : Object.create(Object.getPrototypeOf(value)) as Record<string, JsonValue>;
    task.assign(copy); cursor++; tasks.push({ kind: "close", copy });
    for (let index = entries.length - 1; index >= 0; index--) {
      const [key, child] = entries[index]!;
      if (array) tasks.push({ kind: "value", value: child as JsonValue, assign: item => { Object.defineProperty(copy, key, { value: item, enumerable: true, writable: true, configurable: true }); } });
      else tasks.push({ kind: "property", key, value: child as JsonValue, copy: copy as Record<string, JsonValue> });
      if (index > 0) tasks.push({ kind: "token", bytes: 1 });
    }
  }
  return holder.value!;
}

export function redactEvidence(input: BoundedEvidenceInputV1, policy: TrustedRedactionPolicyV1): RedactedEvidenceBatchV1 {
  const trusted = trustedPolicy(policy); const frames: RedactedEvidenceFrameV1[] = []; let spanCount = 0; let redactedBytes = 0;
  for (const frame of input.command.frames) {
    const manifest: RedactionSpanV1[] = []; const remaining = RETAINED_EVIDENCE_LIMITS.spans - spanCount;
    const content = frame.mediaType === "application/json" ? transformJson(frame.content, trusted.rules, manifest, remaining) : transformString(frame.content, false, 0, trusted.rules, manifest, remaining);
    manifest.sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
    spanCount += manifest.length;
    // Transformation can grow short matches. Recheck against the encrypted-bundle budget;
    // actual metadata/wrapped-key/ciphertext accounting belongs to the envelope layer.
    redactedBytes += frame.mediaType === "application/json" ? boundedRetainedJson(content, 2_097_152).bytes : retainedStringMetrics(content, 2_097_152).bytes;
    assertRetainedByteLimit(redactedBytes, 2_097_152);
    frames.push(Object.freeze({ ...frame, content, manifest: Object.freeze(manifest) }) as RedactedEvidenceFrameV1);
  }
  return Object.freeze({ policyId: trusted.policyId, policyVersion: trusted.policyVersion, frames: Object.freeze(frames), spanCount });
}
