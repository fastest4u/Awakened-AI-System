import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import { describe, it } from "node:test";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import type { LifecycleAudience } from "../src/orchestrator/lifecycle/contracts/commands.js";
import { LifecycleError } from "../src/orchestrator/lifecycle/errors.js";
import {
  CAPABILITY_MAC_DOMAIN,
  CAPABILITY_VERIFIER_DOMAIN,
  PROOF_DOMAIN_TEXT,
  capabilityProofDigest,
  capabilityProofMac,
  createCapabilityProof,
  issueCapability,
  reconstructCapability,
  verifyCapability,
  verifyCapabilityProof,
  type BoundedOperationProofTargetV1,
  type CapabilityClaimsV1,
  type CapabilityUseExpectationV1,
  type SemanticCommandProofTargetV1,
} from "../src/orchestrator/lifecycle/authority/capability-codec.js";
import { SecretString } from "../src/orchestrator/lifecycle/authority/redacted-secret.js";
import {
  CapabilityService,
  MAX_BOUNDED_PROOF_HORIZON_MS,
  type CapabilityNonceSource,
} from "../src/orchestrator/lifecycle/capability.service.js";
import {
  DeterministicCapabilityKeyProvider,
  syntheticProofReference,
} from "./support/lifecycle-authority-reference.js";

const UUID = {
  project: "00000000-0000-4000-8000-000000000001",
  vault: "00000000-0000-4000-8000-000000000002",
  store: "00000000-0000-4000-8000-000000000003",
  session: "00000000-0000-4000-8000-000000000010",
  command: "00000000-0000-4000-8000-000000000020",
  operation: "00000000-0000-4000-8000-000000000030",
  request: "00000000-0000-4000-8000-000000000040",
  nonce: "00000000-0000-4000-8000-000000000050",
} as const;

const WORKSPACE_ID = "1".repeat(64);
const NOW = "2026-07-14T00:00:00.000Z";
const NOW_MS = BigInt(Date.parse(NOW));

class DeterministicNonceSource implements CapabilityNonceSource {
  #byte = 0x21;
  #uuid = 100;

  bytes(length: number): Uint8Array {
    const value = Buffer.alloc(length, this.#byte);
    this.#byte += 1;
    return value;
  }

  uuid(): string {
    const value = `00000000-0000-4000-8000-${this.#uuid.toString(16).padStart(12, "0")}`;
    this.#uuid += 1;
    return value;
  }
}

function primary(clientInstanceId = "primary-a"): LifecycleAudience {
  return {
    presentingActorRole: "primary",
    presentingClientInstanceId: clientInstanceId,
    targetActorRole: "primary",
    targetClientInstanceId: clientInstanceId,
  };
}

function claims(
  provider: DeterministicCapabilityKeyProvider,
  overrides: Partial<CapabilityClaimsV1> = {},
): CapabilityClaimsV1 {
  const kind = overrides.kind ?? "root-session-handle";
  const keyId = provider.currentKey(
    { projectId: UUID.project, storeId: UUID.store },
    kind,
  ).keyId;
  return {
    capabilityVersion: 1,
    projectId: UUID.project,
    vaultId: UUID.vault,
    storeId: UUID.store,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "desktop/tests",
    sessionId: UUID.session,
    kind,
    capabilityGeneration: "7",
    issuedAt: NOW,
    policyCode: kind === "root-resume-token"
      ? "resume-default-v1"
      : kind === "child-session-handle"
        ? "child-default-v1"
        : "root-default-v1",
    expiryKind: kind === "child-session-handle" ? "absolute" : "until-revoked",
    expiresAt: kind === "child-session-handle" ? "2026-07-14T01:00:00.000Z" : null,
    issueNonce: "a".repeat(64),
    actorRole: kind === "child-session-handle" ? "untrusted" : "primary",
    clientInstanceId: kind === "root-resume-token"
      ? null
      : kind === "child-session-handle"
        ? "child-a"
        : "primary-a",
    ...overrides,
    keyId: overrides.keyId ?? keyId,
  } as CapabilityClaimsV1;
}

function useExpectation(
  capability: CapabilityClaimsV1,
  audience: LifecycleAudience,
): CapabilityUseExpectationV1 {
  return {
    projectId: capability.projectId,
    vaultId: capability.vaultId,
    storeId: capability.storeId,
    workspaceId: capability.workspaceId,
    clientNamespace: capability.clientNamespace,
    sessionId: capability.sessionId,
    kind: capability.kind,
    capabilityGeneration: capability.capabilityGeneration,
    audience,
  };
}

function semanticTarget(
  overrides: Partial<SemanticCommandProofTargetV1> = {},
): SemanticCommandProofTargetV1 {
  return {
    proofVersion: 1,
    target: "semantic-command",
    projectId: UUID.project,
    vaultId: UUID.vault,
    storeId: UUID.store,
    workspaceId: WORKSPACE_ID,
    clientNamespace: "desktop/tests",
    authoritySessionId: UUID.session,
    targetSessionId: UUID.session,
    presentingActorRole: "primary",
    presentingClientInstanceId: "primary-a",
    targetActorRole: "primary",
    targetClientInstanceId: "primary-a",
    capabilityKind: "root-session-handle",
    capabilityGeneration: "7",
    commandId: UUID.command,
    idempotencyKey: "command/root/20",
    intentHash: "b".repeat(64),
    proofNonce: UUID.nonce,
    ...overrides,
  };
}

function boundedTarget(
  overrides: Partial<BoundedOperationProofTargetV1> = {},
): BoundedOperationProofTargetV1 {
  return {
    proofVersion: 1,
    target: "bounded-operation",
    operationType: "renew-root-lease",
    operationId: UUID.operation,
    requestId: UUID.request,
    operationHash: "c".repeat(64),
    authoritySessionId: UUID.session,
    targetSessionId: UUID.session,
    presentingActorRole: "primary",
    presentingClientInstanceId: "primary-a",
    targetActorRole: "primary",
    targetClientInstanceId: "primary-a",
    capabilityGeneration: "7",
    proofNonce: UUID.nonce,
    expiresAt: "2026-07-14T00:00:30.000Z",
    ...overrides,
  };
}

function expectLifecycleCode(code: string, action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof LifecycleError);
    assert.equal(error.code, code);
    assert.doesNotMatch(String(error), /pmcap1|proofFingerprint|key material/i);
    return true;
  });
}

function tampered(secret: SecretString): SecretString {
  return secret.withValue((value: string) => {
    const replacement = value.endsWith("A") ? "B" : "A";
    return SecretString.from(`${value.slice(0, -1)}${replacement}`);
  });
}

describe("capability codec and service", () => {
  it("pins capability and proof domains", () => {
    assert.equal(CAPABILITY_MAC_DOMAIN, "pm-lifecycle-capability-v1");
    assert.equal(CAPABILITY_VERIFIER_DOMAIN, "pm-lifecycle-capability-verifier-v1");
    assert.equal(PROOF_DOMAIN_TEXT, "pm-lifecycle-command-proof-v1");
  });

  it("makes deterministic provider keys project/store scoped so routing bugs are observable", () => {
    const provider = new DeterministicCapabilityKeyProvider();
    const bytes = Buffer.from("scope-routing-vector", "utf8");
    const common = {
      purpose: "root-session-handle" as const,
      keyId: provider.currentKey(
        { projectId: UUID.project, storeId: UUID.store },
        "root-session-handle",
      ).keyId,
      domain: CAPABILITY_MAC_DOMAIN,
      bytes,
    };
    const mac = Buffer.from(provider.mac({
      projectId: UUID.project,
      storeId: UUID.store,
      ...common,
    }));
    try {
      assert.equal(provider.verify({
        projectId: "00000000-0000-4000-8000-000000000099",
        storeId: UUID.store,
        ...common,
        mac,
      }), false);
      assert.equal(provider.verify({
        projectId: UUID.project,
        storeId: "00000000-0000-4000-8000-000000000098",
        ...common,
        mac,
      }), false);
    } finally {
      bytes.fill(0);
      mac.fill(0);
    }
  });

  it("issues a strict canonical four-segment capability and verifies the exact audience", () => {
    const provider = new DeterministicCapabilityKeyProvider();
    const capability = claims(provider);
    const bearer = issueCapability(provider, capability);
    try {
      bearer.withValue((value: string) => {
        const segments = value.split(".");
        assert.equal(segments.length, 4);
        assert.equal(segments[0], "pmcap1");
        assert.equal(
          segments[1],
          Buffer.from(capability.keyId, "utf8").toString("base64url"),
        );
        assert.equal(
          segments[2],
          Buffer.from(canonicalJson(capability), "utf8").toString("base64url"),
        );
        assert.equal(segments.some((segment: string) => segment.includes("=")), false);
      });
      assert.deepEqual(
        verifyCapability(provider, bearer, useExpectation(capability, primary()), NOW_MS),
        capability,
      );

      expectLifecycleCode("SESSION_CAPABILITY_INVALID", () => verifyCapability(
        provider,
        bearer,
        useExpectation(capability, primary("primary-b")),
        NOW_MS,
      ));
    } finally {
      bearer.destroy();
    }
  });

  it("makes root handles client-bound, resume tokens portable at rest but presenter-bound at use, and child handles exact", () => {
    const provider = new DeterministicCapabilityKeyProvider();
    const root = claims(provider);
    const resume = claims(provider, { kind: "root-resume-token" });
    const child = claims(provider, { kind: "child-session-handle" });
    const rootBearer = issueCapability(provider, root);
    const resumeBearer = issueCapability(provider, resume);
    const childBearer = issueCapability(provider, child);
    try {
      assert.equal(verifyCapability(provider, rootBearer, useExpectation(root, primary()), NOW_MS).kind, root.kind);
      expectLifecycleCode("SESSION_CAPABILITY_INVALID", () => verifyCapability(
        provider,
        rootBearer,
        useExpectation(root, primary("primary-b")),
        NOW_MS,
      ));
      const portableAudience = primary("primary-b");
      assert.equal(
        verifyCapability(provider, resumeBearer, useExpectation(resume, portableAudience), NOW_MS).kind,
        "root-resume-token",
      );
      expectLifecycleCode("SESSION_CAPABILITY_INVALID", () => verifyCapability(
        provider,
        resumeBearer,
        useExpectation(resume, {
          ...portableAudience,
          targetClientInstanceId: "primary-c",
        }),
        NOW_MS,
      ));

      const childAudience: LifecycleAudience = {
        presentingActorRole: "untrusted",
        presentingClientInstanceId: "child-a",
        targetActorRole: "untrusted",
        targetClientInstanceId: "child-a",
      };
      assert.equal(
        verifyCapability(provider, childBearer, useExpectation(child, childAudience), NOW_MS).kind,
        "child-session-handle",
      );
      expectLifecycleCode("SESSION_CAPABILITY_INVALID", () => verifyCapability(
        provider,
        childBearer,
        useExpectation(child, { ...childAudience, presentingClientInstanceId: "child-b" }),
        NOW_MS,
      ));
    } finally {
      rootBearer.destroy();
      resumeBearer.destroy();
      childBearer.destroy();
    }
  });

  it("uses the exact independent HKDF/HMAC vector and digests raw proof bytes", () => {
    const target = semanticTarget();
    const reference = syntheticProofReference(target);
    try {
      const actualMac = capabilityProofMac(reference.bearer, target);
      try {
        assert.equal(timingSafeEqual(actualMac, reference.expectedProofMac), true);
        assert.equal(capabilityProofDigest(actualMac), reference.expectedProofDigest);
        const proof = createCapabilityProof(reference.bearer, target);
        const proofBytes = Buffer.from(proof.proofFingerprint, "hex");
        try {
          assert.equal(proofBytes.length, reference.expectedProofMac.length);
          assert.equal(timingSafeEqual(proofBytes, reference.expectedProofMac), true);
        } finally {
          proofBytes.fill(0);
        }
        assert.deepEqual(
          verifyCapabilityProof(reference.bearer, target, proof),
          { version: 1, nonce: UUID.nonce, digest: reference.expectedProofDigest },
        );
      } finally {
        actualMac.fill(0);
      }
      const provider = new DeterministicCapabilityKeyProvider();
      expectLifecycleCode("SESSION_CAPABILITY_INVALID", () => verifyCapability(
        provider,
        reference.bearer,
        useExpectation(claims(provider), primary()),
        NOW_MS,
      ));
    } finally {
      reference.destroy();
    }
  });

  it("separates semantic-command and bounded-operation proof domains", () => {
    const provider = new DeterministicCapabilityKeyProvider();
    const bearer = issueCapability(provider, claims(provider));
    const semantic = semanticTarget();
    const bounded = boundedTarget();
    try {
      const semanticProof = createCapabilityProof(bearer, semantic);
      const boundedProof = createCapabilityProof(bearer, bounded);
      assert.notEqual(semanticProof.proofFingerprint, boundedProof.proofFingerprint);
      expectLifecycleCode("SESSION_CAPABILITY_INVALID", () => verifyCapabilityProof(
        bearer,
        bounded,
        semanticProof,
      ));
      expectLifecycleCode("SESSION_CAPABILITY_INVALID", () => verifyCapabilityProof(
        bearer,
        semantic,
        boundedProof,
      ));
    } finally {
      bearer.destroy();
    }
  });

  it("rejects the strict semantic and bounded proof-target negative matrix", () => {
    const provider = new DeterministicCapabilityKeyProvider();
    const bearer = issueCapability(provider, claims(provider));
    const semantic = semanticTarget();
    const { commandId: _commandId, ...missingCommandId } = semantic;
    const invalidTargets: unknown[] = [
      { ...semantic, unknownTargetField: true },
      missingCommandId,
      { ...semantic, capabilityGeneration: "01" },
      { ...semantic, projectId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
      { ...semantic, proofNonce: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" },
      { ...semantic, target: "bounded-operation" },
      { ...boundedTarget(), commandId: UUID.command },
      { ...boundedTarget(), expiresAt: "2026-07-14T00:00:30Z" },
    ];
    try {
      for (const target of invalidTargets) {
        expectLifecycleCode("SESSION_CAPABILITY_INVALID", () => createCapabilityProof(
          bearer,
          target as SemanticCommandProofTargetV1,
        ));
      }
    } finally {
      bearer.destroy();
    }
  });

  it("returns the same safe capability error for invalid structure and invalid MAC", () => {
    const provider = new DeterministicCapabilityKeyProvider();
    const capability = claims(provider);
    const valid = issueCapability(provider, capability);
    const invalidStructure = SecretString.from("pmcap1.invalid");
    const invalidMac = tampered(valid);
    const errors: LifecycleError[] = [];
    try {
      for (const bearer of [invalidStructure, invalidMac]) {
        try {
          verifyCapability(provider, bearer, useExpectation(capability, primary()), NOW_MS);
          assert.fail("invalid bearer verified");
        } catch (error) {
          assert.ok(error instanceof LifecycleError);
          errors.push(error);
        }
      }
      assert.equal(errors[0]!.code, "SESSION_CAPABILITY_INVALID");
      assert.equal(errors[1]!.code, "SESSION_CAPABILITY_INVALID");
      assert.equal(errors[0]!.message, errors[1]!.message);
      assert.deepEqual(errors[0]!.toJSON(), errors[1]!.toJSON());
    } finally {
      valid.destroy();
      invalidStructure.destroy();
      invalidMac.destroy();
    }
  });

  it("rejects the strict capability wire negative matrix before accepting claims", () => {
    const provider = new DeterministicCapabilityKeyProvider();
    const capability = claims(provider);
    const valid = issueCapability(provider, capability);
    const invalidBearers = valid.withValue((value) => {
      const segments = value.split(".");
      const parsed = JSON.parse(
        Buffer.from(segments[2]!, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      const claimsSegment = (claimsValue: unknown): string => Buffer.from(
        canonicalJson(claimsValue),
        "utf8",
      ).toString("base64url");
      return [
        SecretString.from([segments[0], `${segments[1]}=`, segments[2], segments[3]].join(".")),
        SecretString.from([
          segments[0],
          Buffer.from("different-key-id", "utf8").toString("base64url"),
          segments[2],
          segments[3],
        ].join(".")),
        SecretString.from([
          segments[0],
          segments[1],
          Buffer.from([0xc3, 0x28]).toString("base64url"),
          segments[3],
        ].join(".")),
        SecretString.from([
          segments[0],
          segments[1],
          Buffer.from(JSON.stringify(parsed, null, 2), "utf8").toString("base64url"),
          segments[3],
        ].join(".")),
        SecretString.from([
          segments[0], segments[1], claimsSegment({ ...parsed, unknownClaim: true }), segments[3],
        ].join(".")),
        SecretString.from([
          segments[0], segments[1], claimsSegment({ ...parsed, capabilityGeneration: "01" }), segments[3],
        ].join(".")),
        SecretString.from([
          segments[0], segments[1], claimsSegment({
            ...parsed,
            projectId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
          }), segments[3],
        ].join(".")),
        SecretString.from([
          segments[0], segments[1], claimsSegment({
            ...parsed,
            issuedAt: "2026-07-14T00:00:00Z",
          }), segments[3],
        ].join(".")),
        SecretString.from(`pmcap1.${"A".repeat(50_000)}.A.A`),
      ];
    });
    try {
      for (const bearer of invalidBearers) {
        expectLifecycleCode("SESSION_CAPABILITY_INVALID", () => verifyCapability(
          provider,
          bearer,
          useExpectation(capability, primary()),
          NOW_MS,
        ));
      }
    } finally {
      valid.destroy();
      for (const bearer of invalidBearers) bearer.destroy();
    }
  });

  it("fails closed for missing or revoked historical keys without substituting current", () => {
    for (const status of ["unavailable", "revoked"] as const) {
      const provider = new DeterministicCapabilityKeyProvider();
      const capability = claims(provider);
      provider.setStatus(capability.kind, capability.keyId, status);
      expectLifecycleCode("SESSION_CAPABILITY_KEY_UNAVAILABLE", () => reconstructCapability(
        provider,
        capability,
      ));
      assert.equal(
        provider.calls.filter((call) => call.operation === "currentKey").length,
        1,
        "only the test claim factory requested current key",
      );
    }
  });

  it("requires explicit provider, clock, and nonce dependencies and emits descriptors without reconstruction", () => {
    expectLifecycleCode("SESSION_CAPABILITY_KEY_UNAVAILABLE", () => {
      new CapabilityService({} as never);
    });

    const provider = new DeterministicCapabilityKeyProvider();
    const service = new CapabilityService({
      keyProvider: provider,
      clock: { nowMs: () => NOW_MS },
      nonceSource: new DeterministicNonceSource(),
    });
    const material = service.prepareCapability({
      projectId: UUID.project,
      vaultId: UUID.vault,
      storeId: UUID.store,
      workspaceId: WORKSPACE_ID,
      clientNamespace: "desktop/tests",
      sessionId: UUID.session,
      kind: "root-session-handle",
      capabilityGeneration: "7",
      policyCode: "root-default-v1",
      expiryKind: "until-revoked",
      expiresAt: null,
      actorRole: "primary",
      clientInstanceId: "primary-a",
    });
    const macCallsBeforeDescriptor = provider.calls.filter((call) => call.operation === "mac").length;
    const described = service.authorityMaterial({
      authorityCommitment: "d".repeat(64),
      expectedCapabilityGeneration: "7",
      currentCapabilityGeneration: "7",
      target: { actorRole: "primary", clientInstanceId: "primary-a" },
      materials: [material],
    });
    assert.equal(described.status, "current");
    assert.equal(described.descriptor?.authorityCommitment, "d".repeat(64));
    assert.equal(provider.calls.filter((call) => call.operation === "mac").length, macCallsBeforeDescriptor);
    assert.equal(
      provider.calls.every((call) => !Object.hasOwn(call, "bytes") && !Object.hasOwn(call, "key")),
      true,
    );
  });

  it("reconstructs only for the authenticated target and rejects verifier mismatch", () => {
    const provider = new DeterministicCapabilityKeyProvider();
    const service = new CapabilityService({
      keyProvider: provider,
      clock: { nowMs: () => NOW_MS },
      nonceSource: new DeterministicNonceSource(),
    });
    const common = {
      projectId: UUID.project,
      vaultId: UUID.vault,
      storeId: UUID.store,
      workspaceId: WORKSPACE_ID,
      clientNamespace: "desktop/tests",
      sessionId: UUID.session,
      capabilityGeneration: "7",
      expiryKind: "until-revoked" as const,
      expiresAt: null,
      actorRole: "primary" as const,
    };
    const handle = service.prepareCapability({
      ...common,
      kind: "root-session-handle",
      policyCode: "root-default-v1",
      clientInstanceId: "primary-a",
    });
    const resume = service.prepareCapability({
      ...common,
      kind: "root-resume-token",
      policyCode: "resume-default-v1",
      clientInstanceId: null,
    });
    const target = { actorRole: "primary" as const, clientInstanceId: "primary-a" };
    const resolution = service.authorityMaterial({
      authorityCommitment: "d".repeat(64),
      expectedCapabilityGeneration: "7",
      currentCapabilityGeneration: "7",
      target,
      materials: [handle, resume],
    });
    assert.equal(resolution.status, "current");
    assert.ok(resolution.descriptor !== undefined);

    const delivered = service.reconstructForTarget(resolution.descriptor, target);
    try {
      assert.equal(delivered.kind, "root");
      if (delivered.kind !== "root") assert.fail("expected root authority material");
      assert.ok(delivered.resumeToken !== null);
      assert.equal(
        verifyCapability(provider, delivered.handle, useExpectation(handle.claims, primary()), NOW_MS).kind,
        "root-session-handle",
      );
      assert.equal(
        verifyCapability(
          provider,
          delivered.resumeToken!,
          useExpectation(resume.claims, primary()),
          NOW_MS,
        ).kind,
        "root-resume-token",
      );
    } finally {
      delivered.handle.destroy();
      if (delivered.kind === "root") delivered.resumeToken?.destroy();
    }

    expectLifecycleCode("SESSION_CAPABILITY_INVALID", () => service.reconstructForTarget(
      resolution.descriptor!,
      { actorRole: "primary", clientInstanceId: "primary-b" },
    ));
    const verifierMismatch = {
      ...resolution.descriptor,
      materials: resolution.descriptor.materials.map((material, index) => ({
        ...material,
        verifier: index === 0 ? "0".repeat(64) : material.verifier,
      })),
    };
    expectLifecycleCode("SESSION_CAPABILITY_INVALID", () => service.reconstructForTarget(
      verifierMismatch,
      target,
    ));
  });

  it("binds service proof verification to capability scope and bounded expiry", () => {
    const provider = new DeterministicCapabilityKeyProvider();
    const service = new CapabilityService({
      keyProvider: provider,
      clock: { nowMs: () => NOW_MS },
      nonceSource: new DeterministicNonceSource(),
    });
    const material = service.prepareCapability({
      projectId: UUID.project,
      vaultId: UUID.vault,
      storeId: UUID.store,
      workspaceId: WORKSPACE_ID,
      clientNamespace: "desktop/tests",
      sessionId: UUID.session,
      kind: "root-session-handle",
      capabilityGeneration: "7",
      policyCode: "root-default-v1",
      expiryKind: "until-revoked",
      expiresAt: null,
      actorRole: "primary",
      clientInstanceId: "primary-a",
    });
    const bearer = reconstructCapability(provider, material.claims);
    try {
      const wrongProject = semanticTarget({
        projectId: "00000000-0000-4000-8000-000000000099",
      });
      const wrongProjectProof = createCapabilityProof(bearer, wrongProject);
      expectLifecycleCode("SESSION_CAPABILITY_INVALID", () => service.verifyProof(
        material,
        wrongProject,
        wrongProjectProof,
      ));

      const wrongAuthority = semanticTarget({
        authoritySessionId: "00000000-0000-4000-8000-000000000098",
      });
      const wrongAuthorityProof = createCapabilityProof(bearer, wrongAuthority);
      expectLifecycleCode("SESSION_CAPABILITY_INVALID", () => service.verifyProof(
        material,
        wrongAuthority,
        wrongAuthorityProof,
      ));

      const expiredTarget = boundedTarget({ expiresAt: NOW });
      const expiredProof = createCapabilityProof(bearer, expiredTarget);
      expectLifecycleCode("SESSION_CAPABILITY_EXPIRED", () => service.verifyProof(
        material,
        expiredTarget,
        expiredProof,
      ));
    } finally {
      bearer.destroy();
    }
  });

  it("enforces the explicit 120-second bounded-operation proof horizon", () => {
    assert.equal(MAX_BOUNDED_PROOF_HORIZON_MS, 120_000n);
    const provider = new DeterministicCapabilityKeyProvider();
    const service = new CapabilityService({
      keyProvider: provider,
      clock: { nowMs: () => NOW_MS },
      nonceSource: new DeterministicNonceSource(),
    });
    const material = service.prepareCapability({
      projectId: UUID.project,
      vaultId: UUID.vault,
      storeId: UUID.store,
      workspaceId: WORKSPACE_ID,
      clientNamespace: "desktop/tests",
      sessionId: UUID.session,
      kind: "root-session-handle",
      capabilityGeneration: "7",
      policyCode: "root-default-v1",
      expiryKind: "until-revoked",
      expiresAt: null,
      actorRole: "primary",
      clientInstanceId: "primary-a",
    });
    const bearer = reconstructCapability(provider, material.claims);
    try {
      const atMaximum = boundedTarget({
        expiresAt: new Date(Number(NOW_MS + MAX_BOUNDED_PROOF_HORIZON_MS)).toISOString(),
      });
      assert.equal(
        service.verifyProof(material, atMaximum, createCapabilityProof(bearer, atMaximum)).version,
        1,
      );
      const beyondMaximum = boundedTarget({
        expiresAt: new Date(Number(NOW_MS + MAX_BOUNDED_PROOF_HORIZON_MS + 1n)).toISOString(),
      });
      expectLifecycleCode("SESSION_CAPABILITY_INVALID", () => service.verifyProof(
        material,
        beyondMaximum,
        createCapabilityProof(bearer, beyondMaximum),
      ));
    } finally {
      bearer.destroy();
    }
  });

  it("reports unavailable historical material as stale and rejects duplicate material", () => {
    const provider = new DeterministicCapabilityKeyProvider();
    const service = new CapabilityService({
      keyProvider: provider,
      clock: { nowMs: () => NOW_MS },
      nonceSource: new DeterministicNonceSource(),
    });
    const material = service.prepareCapability({
      projectId: UUID.project,
      vaultId: UUID.vault,
      storeId: UUID.store,
      workspaceId: WORKSPACE_ID,
      clientNamespace: "desktop/tests",
      sessionId: UUID.session,
      kind: "root-session-handle",
      capabilityGeneration: "7",
      policyCode: "root-default-v1",
      expiryKind: "until-revoked",
      expiresAt: null,
      actorRole: "primary",
      clientInstanceId: "primary-a",
    });
    expectLifecycleCode("SESSION_CAPABILITY_INVALID", () => service.authorityMaterial({
      authorityCommitment: "d".repeat(64),
      expectedCapabilityGeneration: "7",
      currentCapabilityGeneration: "7",
      target: { actorRole: "primary", clientInstanceId: "primary-a" },
      materials: [material, material],
    }));

    provider.setStatus(material.claims.kind, material.claims.keyId, "revoked");
    assert.deepEqual(service.authorityMaterial({
      authorityCommitment: "d".repeat(64),
      expectedCapabilityGeneration: "7",
      currentCapabilityGeneration: "7",
      target: { actorRole: "primary", clientInstanceId: "primary-a" },
      materials: [material],
    }), {
      status: "stale",
      recoveryCode: "SESSION_CAPABILITY_KEY_UNAVAILABLE",
    });
  });
});
