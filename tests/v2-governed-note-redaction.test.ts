import test from "node:test";
import assert from "node:assert/strict";
import { redactGovernedNoteSummaryV1, type TrustedRedactionPolicyV1, type TrustedRedactionRuleV1 } from "../src/orchestrator/privacy/redaction.js";
const policy = (rules: readonly TrustedRedactionRuleV1[] = []): TrustedRedactionPolicyV1 => Object.freeze({ policyId: "notes", policyVersion: "1", rules: Object.freeze(rules.map(rule => Object.freeze({ ...rule }))) });
test("plain summary shares accepted redaction and NFC trim without fake frames", () => {
  const result = redactGovernedNoteSummaryV1("  e\u0301\npassword=private-value\nAuthorization: Bearer private-token ", policy());
  assert.deepEqual(result, { summary: "é\npassword=[REDACTED]\nAuthorization: [REDACTED]", policyId: "notes", policyVersion: "1" }); assert.ok(Object.isFrozen(result));
  assert.equal(Buffer.byteLength(redactGovernedNoteSummaryV1("🙂".repeat(512), policy()).summary), 2048);
});
test("policy and secret expansion cannot escape output cap", () => {
  const rules = Array.from({ length: 256 }, (_, n): TrustedRedactionRuleV1 => ({ kind: "literal", ruleId: `rule-${n}`, value: `unmatched-${n}` }));
  assert.equal(redactGovernedNoteSummaryV1("visible", policy(rules)).summary, "visible");
  assert.throws(() => redactGovernedNoteSummaryV1("visible", policy([...rules, { kind: "literal", ruleId: "over", value: "unmatched" }])), { code: "GOVERNED_NOTE_LIMIT_EXCEEDED" });
  assert.equal(redactGovernedNoteSummaryV1("x", policy([{ kind: "literal", ruleId: "literal", value: "🙂".repeat(512) }])).summary, "x");
  assert.throws(() => redactGovernedNoteSummaryV1("x", policy([{ kind: "literal", ruleId: "literal", value: "🙂".repeat(512) + "x" }])), { code: "GOVERNED_NOTE_LIMIT_EXCEEDED" });
  assert.throws(() => redactGovernedNoteSummaryV1("x ".repeat(200), policy([{ kind: "literal", ruleId: "expand", value: "x" }])), { code: "GOVERNED_NOTE_LIMIT_EXCEEDED" });
  assert.throws(() => redactGovernedNoteSummaryV1("visible", policy([{ kind: "process-secret", ruleId: "required", referenceId: "missing", required: true, value: null }])), { code: "GOVERNED_NOTE_POLICY_UNAVAILABLE" });
  for (const text of ["", " \n\t", "\ud800"]) assert.throws(() => redactGovernedNoteSummaryV1(text, policy()), { code: "GOVERNED_NOTE_INPUT_INVALID" });
  for (const text of ["x".repeat(2049), "\u0344".repeat(600)]) assert.throws(() => redactGovernedNoteSummaryV1(text, policy()), { code: "GOVERNED_NOTE_LIMIT_EXCEEDED" });
  let calls = 0; const hostile = new Proxy(policy(), { ownKeys() { calls++; throw Error("trap"); } });
  assert.throws(() => redactGovernedNoteSummaryV1("visible", hostile), { code: "GOVERNED_NOTE_POLICY_UNAVAILABLE" }); assert.equal(calls, 0);
});
