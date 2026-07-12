import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseTrustedProjectBindingRequest } from "../src/orchestrator/identity/project-binding.request.js";

describe("parseTrustedProjectBindingRequest", () => {
  it("accepts one complete host request", () => {
    assert.deepEqual(parseTrustedProjectBindingRequest({
      source: "stdio-explicit-root",
      projectRoot: "C:/work/project",
      vaultRoot: "C:/work/project/memory",
      clientNamespace: "codex",
      clientInstanceId: "client-1",
      actorRole: "primary",
      generation: 1,
    }), {
      source: "stdio-explicit-root",
      projectRoot: "C:/work/project",
      vaultRoot: "C:/work/project/memory",
      clientNamespace: "codex",
      clientInstanceId: "client-1",
      actorRole: "primary",
      generation: 1,
    });
  });

  it("rejects dynamic or missing roots", () => {
    for (const projectRoot of [undefined, "", "dynamic", " auto "]) {
      assert.throws(() => parseTrustedProjectBindingRequest({
        source: "stdio-explicit-root",
        projectRoot,
        vaultRoot: "C:/work/project/memory",
        clientNamespace: "codex",
        clientInstanceId: "client-1",
        actorRole: "primary",
        generation: 1,
      }), /PROJECT_ROOT_NOT_EXPLICIT/);
    }
  });

  it("rejects untrusted source, role, empty client identity, and invalid generation", () => {
    const valid = {
      source: "stdio-explicit-root",
      projectRoot: "C:/work/project",
      vaultRoot: "C:/work/project/memory",
      clientNamespace: "codex",
      clientInstanceId: "client-1",
      actorRole: "primary",
      generation: 1,
    };
    assert.throws(() => parseTrustedProjectBindingRequest({ ...valid, source: "model-argument" }), /BINDING_SOURCE_INVALID/);
    assert.throws(() => parseTrustedProjectBindingRequest({ ...valid, actorRole: "child" }), /ACTOR_ROLE_INVALID/);
    assert.throws(() => parseTrustedProjectBindingRequest({ ...valid, clientInstanceId: "" }), /CLIENT_INSTANCE_INVALID/);
    assert.throws(() => parseTrustedProjectBindingRequest({ ...valid, generation: 0 }), /BINDING_GENERATION_INVALID/);
  });
});
