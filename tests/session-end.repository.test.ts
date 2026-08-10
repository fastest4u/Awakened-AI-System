import { strict as assert } from "node:assert";
import { it } from "node:test";

const moduleUrl = new URL(
  "../src/orchestrator/storage/session-end.repository.js",
  import.meta.url,
).href;

function validPlans(): readonly Record<string, unknown>[] {
  return Object.freeze([Object.freeze({
    profileId: "alpha",
    profileVersion: 1,
    runId: "11111111-1111-4111-8111-111111111111",
    resultId: "22222222-2222-4222-8222-222222222222",
    commandId: "33333333-3333-4333-8333-333333333333",
    idempotencyKey: "validation/alpha",
  })]);
}

function planAtCanonicalByteLength(length: number): readonly Record<string, unknown>[] {
  const seed = { ...validPlans()[0]!, profileId: "" };
  const fixed = Buffer.byteLength(JSON.stringify([seed]), "utf8");
  return Object.freeze([Object.freeze({ ...seed, profileId: "x".repeat(length - fixed) })]);
}

it("strictly decodes the six-key persisted validation plan and rejects ordering identity cap violations", async () => {
  const repository = await (new Function("url", "return import(url)") as (
    url: string,
  ) => Promise<Record<string, unknown>>)(moduleUrl);
  const decode = repository.decodePersistedValidationPlansV1;
  assert.equal(typeof decode, "function");
  assert.deepEqual(Reflect.apply(decode as Function, undefined, [validPlans()]), validPlans());
  for (const hostile of [
    [],
    [{ ...validPlans()[0]!, profileId: "z" }, { ...validPlans()[0]!, profileId: "a", profileVersion: 2, runId: "44444444-4444-4444-8444-444444444444", resultId: "55555555-5555-4555-8555-555555555555", commandId: "66666666-6666-4666-8666-666666666666", idempotencyKey: "validation/a" }],
    [{ ...validPlans()[0]!, profileConfigurationHash: "must-not-persist" }],
    [validPlans()[0]!, { ...validPlans()[0]!, commandId: "66666666-6666-4666-8666-666666666666", resultId: "55555555-5555-4555-8555-555555555555", runId: "44444444-4444-4444-8444-444444444444", idempotencyKey: "validation/alpha-duplicate" }],
    [validPlans()[0]!, { ...validPlans()[0]!, profileId: "beta", commandId: "66666666-6666-4666-8666-666666666666", resultId: "55555555-5555-4555-8555-555555555555", idempotencyKey: "validation/beta" }],
    planAtCanonicalByteLength(262_145),
    Array.from({ length: 65 }, (_, index) => ({ ...validPlans()[0]!, profileId: `profile-${index.toString().padStart(2, "0")}`, runId: `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`, resultId: `${index.toString(16).padStart(8, "0")}-2222-4222-8222-222222222222`, commandId: `${index.toString(16).padStart(8, "0")}-3333-4333-8333-333333333333`, idempotencyKey: `validation/${index}` })),
  ]) {
    assert.throws(() => Reflect.apply(decode as Function, undefined, [hostile]), (error: unknown) => (
      typeof error === "object" && error !== null && "code" in error
        && (error as { code?: unknown }).code === "INTEGRITY_FAILURE"
    ));
  }
  assert.deepEqual(
    Reflect.apply(decode as Function, undefined, [planAtCanonicalByteLength(262_144)]),
    planAtCanonicalByteLength(262_144),
  );
});
