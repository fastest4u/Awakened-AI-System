import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryBootstrapService, resolveServerEntrypoint } from "../src/services/memory-bootstrap.service.js";

/** Normalize separators so platform-specific tests run on any OS. */
const toPosix = (p: string) => p.replace(/\\/g, "/");

/** Walk up from this compiled test file to the directory containing package.json. */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("package.json not found above test file");
    dir = parent;
  }
  return dir;
}

describe("resolveServerEntrypoint", () => {
  it("ends with dist/index.js and resolves under the package root", () => {
    const entry = resolveServerEntrypoint();
    assert.ok(entry.endsWith("dist/index.js"), `expected path ending with dist/index.js, got ${entry}`);
    assert.equal(entry, toPosix(join(packageRoot(), "dist", "index.js")));
  });

  it("exists relative to the package root (requires `npm run build` once)", (t) => {
    const entry = resolveServerEntrypoint();
    assert.ok(existsSync(join(packageRoot(), "package.json")));
    // dist/ is a gitignored build artifact; on a fresh clone it does not exist
    // yet, so skip the existence assertion instead of failing `npm test`.
    if (!existsSync(entry)) {
      t.skip("dist/index.js not built; run `npm run build` to enable this assertion");
      return;
    }
    assert.ok(existsSync(entry), `expected ${entry} to exist; run \`npm run build\` first`);
  });

  it("resolves the bundled module URL (dist/index.js) to itself, not one directory above dist", () => {
    const bundled = pathToFileURL(join(packageRoot(), "dist", "index.js")).href;
    assert.equal(resolveServerEntrypoint(bundled), toPosix(join(packageRoot(), "dist", "index.js")));
  });

  it("walks up to the nearest package.json regardless of module depth", () => {
    const tmp = mkdtempSync(join(tmpdir(), "memory-entrypoint-"));
    try {
      const pkg = join(tmp, "pkg");
      mkdirSync(join(pkg, "dist"), { recursive: true });
      mkdirSync(join(pkg, "dist-test", "src", "services"), { recursive: true });
      writeFileSync(join(pkg, "package.json"), "{}\n", "utf8");
      const expected = toPosix(join(pkg, "dist", "index.js"));

      const fromBundle = pathToFileURL(join(pkg, "dist", "index.js")).href;
      assert.equal(resolveServerEntrypoint(fromBundle), expected);

      const fromTestBuild = pathToFileURL(join(pkg, "dist-test", "src", "services", "memory-bootstrap.service.js")).href;
      assert.equal(resolveServerEntrypoint(fromTestBuild), expected);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("MemoryBootstrapService generated client configs", () => {
  let projectDir: string;
  let expectedRoot: string;
  let expectedEntry: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "memory-bootstrap-"));
    expectedRoot = toPosix(resolve(projectDir));
    expectedEntry = toPosix(join(packageRoot(), "dist", "index.js"));
    const service = new MemoryBootstrapService(join(projectDir, "memory"));
    service.bootstrap({ projectName: "Test Project", ideConfigs: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  function readJson(relativePath: string) {
    return JSON.parse(readFileSync(join(projectDir, relativePath), "utf8"));
  }

  it("writes the real entrypoint and literal project root into mcpServers-style configs", () => {
    const configs = [
      ".cursor/mcp.json",
      ".windsurf/mcp_config.example.json",
      ".antigravity/mcp.json",
      ".antigravity/mcp_config.json",
      ".antigravity/mcp.example.json",
    ];
    for (const relativePath of configs) {
      const server = readJson(relativePath).mcpServers["project-memory"];
      assert.equal(server.command, "node", relativePath);
      assert.equal(server.args[0], expectedEntry, relativePath);
      assert.equal(server.env.MEMORY_PROJECT_ROOT, expectedRoot, relativePath);
    }
  });

  it("writes the real entrypoint and literal project root into the zed config", () => {
    const server = readJson(".zed/settings.json").context_servers["project-memory"];
    assert.equal(server.args[0], expectedEntry);
    assert.equal(server.env.MEMORY_PROJECT_ROOT, expectedRoot);
  });

  it("writes the real entrypoint and literal project root into the opencode config", () => {
    const server = readJson("opencode.json").mcp["project-memory"];
    assert.deepEqual(server.command, ["node", expectedEntry]);
    assert.equal(server.environment.MEMORY_PROJECT_ROOT, expectedRoot);
  });

  it("writes the real entrypoint and literal project root into the codex toml with a dynamic opt-in comment", () => {
    const toml = readFileSync(join(projectDir, ".codex", "config.toml"), "utf8");
    assert.ok(toml.includes(`args = [${JSON.stringify(expectedEntry)}]`), toml);
    assert.ok(toml.includes(`MEMORY_PROJECT_ROOT = ${JSON.stringify(expectedRoot)}`), toml);
    assert.ok(!toml.includes('MEMORY_PROJECT_ROOT = "dynamic"'), toml);
    assert.ok(/^#.*"dynamic".*auto-detection/m.test(toml), "expected a comment documenting the dynamic opt-in");
  });

  it("documents the dynamic sentinel as an opt-in alternative in generated docs", () => {
    const antigravity = readFileSync(join(projectDir, ".antigravity", "AGENTS.md"), "utf8");
    assert.ok(antigravity.includes("`dynamic`"));
    assert.ok(antigravity.includes(`\`${expectedRoot}\``));

    const clientSetup = readFileSync(join(projectDir, "memory", "00_Index", "AI-Client-Setup.md"), "utf8");
    assert.ok(clientSetup.includes("## MEMORY_PROJECT_ROOT"));
    assert.ok(clientSetup.includes("`dynamic`"));
  });
});
