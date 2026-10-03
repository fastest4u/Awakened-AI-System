import assert from "node:assert/strict";
import test from "node:test";
import { decodeRetainEvidenceBatch } from "../src/orchestrator/privacy/evidence-contracts.js";
import { redactEvidence, type TrustedRedactionPolicyV1, type TrustedRedactionRuleV1 } from "../src/orchestrator/privacy/redaction.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";

const invalidPolicy = { code: "RETAINED_EVIDENCE_POLICY_UNAVAILABLE" };
const limit = { code: "RETAINED_EVIDENCE_LIMIT_EXCEEDED" };
function id(n = 1) { return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`; }
function input(content: unknown, json = false) {
  return decodeRetainEvidenceBatch({ version: 1, commandType: "retain-evidence-batch", commandId: id(), idempotencyKey: id(2), targetSessionId: id(3), conversationId: id(4), frames: [{ frameId: id(5), ordinal: "0", role: "user", category: "user-message", occurredAt: "2026-10-02T01:02:03.004Z", mediaType: json ? "application/json" : "text/plain; charset=utf-8", content, previousFrameId: null, toolCorrelationId: null, artifactHashes: [] }] });
}
function policy(rules: TrustedRedactionRuleV1[] = [], policyId = "policy-1"): TrustedRedactionPolicyV1 { return Object.freeze({ policyId, policyVersion: "1", rules: Object.freeze(rules.map(rule => Object.freeze(rule))) }); }
function redact(content: unknown, rules: TrustedRedactionRuleV1[] = [], json = false) { const bounded = input(content, json); try { return redactEvidence(bounded, policy(rules)); } finally { bounded.canonicalOriginalBytes.fill(0); } }
function absent(result: unknown, value: string) { assert.equal(JSON.stringify(result).includes(value), false, "redacted encryption input must exclude matched value"); }

test("mandatory credential fields authorization headers and private-key blocks redact with no optional rules", () => {
  const secret = "synthetic-credential-value";
  const content = { password: secret, nested: { api_key: secret, authorization: `Bearer ${secret}` }, harmless: "visible", key: `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----` };
  const result = redact(content, [], true); absent(result, secret);
  assert.equal((result.frames[0]!.content as { harmless: string }).harmless, "visible"); assert.ok(result.spanCount >= 4);
  const text = redact(`password=${secret}\nAuthorization: Bearer ${secret}\n-----BEGIN RSA PRIVATE KEY-----\n${secret}\n-----END RSA PRIVATE KEY-----`); absent(text, secret); assert.ok(text.spanCount >= 3);
  for (const span of result.frames[0]!.manifest) assert.deepEqual(Object.keys(span).sort(), ["endByte", "ruleId", "startByte"]);
});
test("literal process-secret and configured token scanners redact every JSON free-text value and key", () => {
  const secret = "synthetic-hidden-value";
  const result = redact({ [secret]: secret, nested: [secret, { x: "cfg_abc123-XYZ" }], selector: "visible" }, [{ kind: "literal", ruleId: "literal-user", value: secret }, { kind: "token", ruleId: "configured-token", prefix: "cfg_" }], true);
  absent(result, secret); absent(result, "cfg_abc123-XYZ"); assert.equal(result.spanCount, 4);
  const resolved = redact(`before ${secret} after`, [{ kind: "process-secret", ruleId: "resolved-process", referenceId: "process-key", required: true, value: secret }]); absent(resolved, secret); assert.equal(resolved.spanCount, 1);
});
test("overlapping and duplicate matches choose stable rule IDs and union ranges deterministically", () => {
  const a: TrustedRedactionRuleV1 = { kind: "literal", ruleId: "a-rule", value: "abcdef" }; const z: TrustedRedactionRuleV1 = { kind: "literal", ruleId: "z-rule", value: "cdefgh" };
  const duplicate: TrustedRedactionRuleV1 = { kind: "literal", ruleId: "b-rule", value: "abcdef" };
  const first = redact("abcdefgh", [z, duplicate, a]); const second = redact("abcdefgh", [a, z, duplicate]);
  assert.deepEqual(first, second); assert.deepEqual(first.frames[0]!.manifest, [{ ruleId: "a-rule", startByte: 0, endByte: 8 }]); assert.equal(first.frames[0]!.content, "[REDACTED]");
});
test("JSON escapes and Unicode spans refer to original bytes", () => {
  const secret = "é\"\n🙂"; const content = { a: "前" + secret + "後" };
  const result = redact(content, [{ kind: "literal", ruleId: "unicode-rule", value: secret }], true);
  const originalPrefix = '{"a":"前'; const encoded = JSON.stringify(secret).slice(1, -1);
  assert.deepEqual(result.frames[0]!.manifest, [{ ruleId: "unicode-rule", startByte: Buffer.byteLength(originalPrefix, "utf8"), endByte: Buffer.byteLength(originalPrefix + encoded, "utf8") }]);
  assert.deepEqual(result.frames[0]!.content, { a: "前[REDACTED]後" }); absent(result, secret);
  const text = redact("前" + secret + "後", [{ kind: "literal", ruleId: "unicode-rule", value: secret }]);
  assert.deepEqual(text.frames[0]!.manifest, [{ ruleId: "unicode-rule", startByte: 3, endByte: 3 + Buffer.byteLength(secret) }]);
});
test("missing mandatory secret and untrusted regex callback mutable or hostile policy refuse safely", () => {
  const bounded = input("visible"); let calls = 0;
  const bad = [policy([{ kind: "process-secret", ruleId: "mandatory", referenceId: "missing", required: true, value: null }]), policy([{ kind: "regex", ruleId: "regex", pattern: ".*" } as never]), policy([{ kind: "callback", ruleId: "callback", callback() { calls++; } } as never]), { policyId: "mutable", policyVersion: "1", rules: [] }, policy([{ kind: "literal", ruleId: "extra", value: "x", regex: "x" } as never]), policy([{ kind: "literal", ruleId: "duplicate", value: "x" }, { kind: "literal", ruleId: "duplicate", value: "y" }])];
  for (const value of bad) assert.throws(() => redactEvidence(bounded, value), invalidPolicy);
  const getter = Object.freeze(Object.defineProperty({ policyVersion: "1", rules: Object.freeze([]) }, "policyId", { enumerable: true, get() { calls++; throw new Error("do not read"); } }));
  assert.throws(() => redactEvidence(bounded, getter as never), invalidPolicy);
  assert.throws(() => redactEvidence(bounded, new Proxy(policy(), { ownKeys() { calls++; throw new Error("do not inspect"); } })), invalidPolicy);
  assert.equal(calls, 0); bounded.canonicalOriginalBytes.fill(0);
});
test("256 rules accept and 257 refuse", () => {
  const rules = Array.from({ length: 256 }, (_, n): TrustedRedactionRuleV1 => ({ kind: "literal", ruleId: `rule-${n}`, value: `unmatched-${n}` }));
  assert.equal(redact("visible", rules).spanCount, 0); const bounded = input("visible"); assert.throws(() => redactEvidence(bounded, policy([...rules, { kind: "literal", ruleId: "over", value: "unmatched-over" }])), limit); bounded.canonicalOriginalBytes.fill(0);
});
test("2,048 literal UTF-8 bytes accept and 2,049 refuse", () => {
  const value = "🙂".repeat(512); assert.equal(Buffer.byteLength(value), 2_048); assert.equal(redact(value, [{ kind: "literal", ruleId: "literal", value }]).spanCount, 1);
  const bounded = input("visible"); assert.throws(() => redactEvidence(bounded, policy([{ kind: "literal", ruleId: "literal", value: value + "x" }])), limit); bounded.canonicalOriginalBytes.fill(0);
});
test("4,096 spans accept and 4,097 refuse the whole batch", () => {
  assert.equal(redact("x ".repeat(4_096), [{ kind: "literal", ruleId: "one", value: "x" }]).spanCount, 4_096);
  const bounded = input("x ".repeat(4_097)); assert.throws(() => redactEvidence(bounded, policy([{ kind: "literal", ruleId: "one", value: "x" }])), limit); bounded.canonicalOriginalBytes.fill(0);
});
test("128 scalar policy/version/rule/reference IDs accept and 129 refuse", () => {
  const valid = "🙂".repeat(128); const bounded = input("visible");
  assert.equal(redactEvidence(bounded, policy([{ kind: "literal", ruleId: valid, value: "absent" }], valid)).policyId, valid);
  for (const field of ["policyId", "policyVersion"]) { assert.throws(() => redactEvidence(bounded, Object.freeze({ ...policy(), [field]: valid + "x" })), limit); }
  assert.throws(() => redactEvidence(bounded, policy([{ kind: "literal", ruleId: valid + "x", value: "absent" }])), limit);
  assert.throws(() => redactEvidence(bounded, policy([{ kind: "process-secret", ruleId: "process", referenceId: valid + "x", required: false, value: null }])), limit);
  assert.throws(() => redactEvidence(bounded, policy([], "\ud800")), invalidPolicy); bounded.canonicalOriginalBytes.fill(0);
});
test("redacted JSON remains valid and deep bounded JSON redacts iteratively", () => {
  let content: unknown = "synthetic-depth-secret"; for (let n = 0; n < 12_000; n++) content = [content];
  const result = redact(content, [{ kind: "literal", ruleId: "deep", value: "synthetic-depth-secret" }], true); assert.equal(result.spanCount, 1);
  let leaf: unknown = result.frames[0]!.content; for (let n = 0; n < 12_000; n++) leaf = (leaf as unknown[])[0]; assert.equal(leaf, "[REDACTED]");
  const ordinary = redact({ a: 'quote"slash\\line\n', password: "synthetic-value" }, [], true); assert.doesNotThrow(() => JSON.parse(canonicalJson(ordinary.frames[0]!.content))); assert.ok(Object.isFrozen(ordinary.frames)); assert.ok(Object.isFrozen(ordinary.frames[0]!.manifest));
});
