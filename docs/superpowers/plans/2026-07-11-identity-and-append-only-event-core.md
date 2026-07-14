# Identity and Append-Only Event Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the disabled-by-default V2 foundation that binds every operation to one explicit project, stores immutable idempotent events in a WAL-safe per-project SQLite database, and proves isolation, integrity, retry, and crash behavior before any V1 lifecycle traffic is cut over.

**Architecture:** V2 lives under `src/orchestrator/` and is isolated from the existing Markdown-first services. A transport-private `ProjectBinding` resolves a descriptor, Git worktree identity, store manifest, and canonical store path before content access; a dedicated worker owns each process-local `DatabaseSync` connection. The event store performs command deduplication, optimistic stream checks, global hash chaining, and all event inserts in one `BEGIN IMMEDIATE` transaction, while Markdown and query projections remain outside this subproject.

**Tech Stack:** TypeScript 5.8, Node.js `node:sqlite`, SQLite WAL/STRICT tables/FTS5, Node worker threads and child processes, Zod 3, esbuild, native `node:test`, PowerShell-compatible npm scripts.

## Global Constraints

- Runtime floor: Node.js 22.22.3 with runtime SQLite 3.51.3 or newer.
- Recommended runtime: Node.js 24.16.0 or newer within the supported Node.js 24 LTS line.
- Production multi-process WAL mode fails closed unless `node:sqlite` loads, `SELECT sqlite_version()` is at least `3.51.3`, WAL actually activates, FTS5 works, and the required PRAGMA and transaction probes pass.
- Every memory-bearing operation resolves to exactly one explicit project before any content read or write; heuristic workspace candidates are diagnostics only.
- Git linked worktrees share `<git-common-dir>/project-memory/<projectId>/v2/` but keep distinct deterministic `workspaceId` values. Non-Git stores use `<vaultRoot>/.memory-mcp/v2/`.
- Ordinary reads, startup, and mode `off` never create a project descriptor, store manifest, SQLite database, directory, or semantic event.
- Mode is `off` by default. With mode absent or `off`, the existing V1 tool surface, schemas, responses, files, resolver behavior, and 406-test regression floor remain unchanged.
- One command may append multiple events. Command idempotency is unique on `(projectId, idempotencyKey)` in `command_dedup`; event ordering is unique on `(projectId, commandId, commandEventIndex)`.
- All source events are append-only. `events`, committed command-dedup rows, project identity rows, and applied migration rows reject `UPDATE` and `DELETE`.
- SQLite positions and stream versions use `bigint` internally and decimal strings at MCP or worker JSON boundaries.
- Production MCP authoritative-store connections are created inside their owning worker and are never transferred between threads. The explicit offline bootstrap CLI may own its short-lived initialization connection in the CLI process.
- Windows tests use IPC barriers and cooperative handle closure; they do not depend on Unix signals, shell interpolation, timing sleeps, or replacing an open SQLite file.
- Subprojects 2–5 own root/child lifecycle cutover, evidence encryption, query projections, retrieval, promotion/global scope, legacy import, backup publication, and primary-mode cutover. This plan only creates their typed storage seams and schema-owned operational rows.
- Do not modify `src/services/memory-lifecycle.service.ts`, `src/services/memory-workflow.service.ts`, retrieval ranking, embedding providers, or legacy note materialization in this subproject.
- No new production dependency is required; use Node core modules plus the repository's existing Zod dependency.

---

## File Structure

### Runtime, configuration, and build

| File | Responsibility |
| --- | --- |
| `.node-version` | Pin the recommended local/CI Node runtime. |
| `package.json` / `package-lock.json` | Declare the minimum runtime, Node 22 types, runtime/build/stress scripts. |
| `scripts/check-runtime.js` | Standalone fail-closed runtime and temporary-file SQLite capability probe. |
| `scripts/smoke-worker.js` | Start the built worker, perform `ping`, and close it without starting MCP stdio. |
| `scripts/build.js` | Emit the MCP server, CLI, and unobfuscated worker entry as Node 22 ESM bundles. |
| `src/orchestrator/identity/project-binding.request.ts` | Validate a trusted host's explicit roots, namespace, client instance, role, and generation without accepting model input. |
| `src/orchestrator/runtime/runtime-capabilities.ts` | Shared version comparison and typed runtime capability diagnostics. |

### Project identity and routing

| File | Responsibility |
| --- | --- |
| `src/orchestrator/identity/contracts.ts` | Branded IDs, descriptor, workspace snapshot, route, binding, and context contracts. |
| `src/orchestrator/identity/canonical-path.ts` | Canonical `realpath` helpers and containment checks. |
| `src/orchestrator/identity/project-descriptor.schema.ts` | Strict Zod descriptor schema. |
| `src/orchestrator/identity/project-descriptor.repository.ts` | Inspect and explicitly create the versioned descriptor with no overwrite. |
| `src/orchestrator/identity/git-workspace.resolver.ts` | Resolve top-level, Git/common dirs, HEAD, ref, detached state, and workspace ID without shell strings. |
| `src/orchestrator/identity/project-store.router.ts` | Derive, but never create, canonical Git or non-Git store paths. |
| `src/orchestrator/identity/store-manifest.schema.ts` | Strict schema for local physical-store identity. |
| `src/orchestrator/identity/store-manifest.repository.ts` | Inspect and explicitly create a no-overwrite store manifest. |
| `src/orchestrator/identity/project-binding.service.ts` | Establish and revalidate transport-private project authority. |
| `src/orchestrator/diagnostics/project-status.service.ts` | Return safe bound/blocked/not-ready status and diagnostic candidates. |

### Event and storage core

| File | Responsibility |
| --- | --- |
| `src/orchestrator/contracts/event.ts` | JSON, event, append-command, append-result, and stored-event contracts. |
| `src/orchestrator/serialization/canonical-json.ts` | Reject non-JSON values and serialize objects with deterministic key order. |
| `src/orchestrator/crypto/event-hash.ts` | Domain-separated payload, command, response, outbox, and event SHA-256 hashes. |
| `src/orchestrator/storage/sqlite-driver.ts` | Narrow named-parameter, bigint-safe SQLite interfaces. |
| `src/orchestrator/storage/node-sqlite-driver.ts` | Hardened `DatabaseSync` adapter and verified PRAGMAs. |
| `src/orchestrator/storage/migration.ts` | Versioned migration contract. |
| `src/orchestrator/storage/migration-runner.ts` | Checksum, ordering, transaction, and immutable migration history. |
| `src/orchestrator/storage/migrations/0001-event-core.ts` | STRICT source tables, indexes, foreign keys, and immutability triggers. |
| `src/orchestrator/storage/project-store-bootstrap.service.ts` | Explicitly create descriptor/store identity, database, and first migration. |
| `src/orchestrator/storage/branch-scope.repository.ts` | Persist branch lineage IDs without hashing mutable branch names. |
| `src/orchestrator/storage/maintenance-fence.ts` | Acquire, observe, acknowledge, expire, and release fenced maintenance epochs. |
| `src/orchestrator/storage/event-store.ts` | Atomic append, deduplication, stream CAS, hash chain, response replay, and rollback. |
| `src/orchestrator/integrity/integrity.types.ts` | Quick/full integrity report contracts. |
| `src/orchestrator/integrity/event-integrity.service.ts` | Verify SQLite, schema fingerprints, identities, streams, commands, and the full event chain. |

### Worker and application integration

| File | Responsibility |
| --- | --- |
| `src/orchestrator/runtime/worker-protocol.ts` | JSON-safe discriminated worker requests, responses, and decimal bigint encoding. |
| `src/orchestrator/runtime/project-store-identity-probe.ts` | Use a one-shot worker to verify an existing database before finalizing a binding. |
| `src/orchestrator/runtime/project-store-executor.ts` | Bounded async request queue, timeout, worker lifecycle, and pending rejection. |
| `src/workers/project-store.worker.ts` | Own the SQLite connection and dispatch open/append/integrity/close requests. |
| `src/cli/parse-args.ts` | Preserve current CLI parsing and add explicit `orchestrator-init` arguments. |
| `src/cli/run-command.ts` | Preserve current CLI behavior and invoke V2 init/status/integrity administration explicitly. |
| `src/cli.ts` | Thin executable wrapper around parsed command execution. |

### Tests and CI

Focused tests live in `tests/project-binding.request.test.ts`, `tests/runtime-capabilities.test.ts`, `tests/project-descriptor.repository.test.ts`, `tests/git-workspace.resolver.test.ts`, `tests/project-store.router.test.ts`, `tests/project-binding.service.test.ts`, `tests/canonical-json.test.ts`, `tests/event-hash.test.ts`, `tests/sqlite-driver.test.ts`, `tests/migration-runner.test.ts`, `tests/project-store-bootstrap.test.ts`, `tests/event-store.test.ts`, `tests/maintenance-fence.test.ts`, `tests/event-integrity.test.ts`, `tests/project-store-executor.test.ts`, and `tests/cli.orchestrator-admin.test.ts`.

Real cross-process fixtures live in `tests/fixtures/project-store-child.ts` and `tests/fixtures/project-store-crash-child.ts`; exit gates live in `tests/event-store.concurrent.test.ts`, `tests/event-store.crash.test.ts`, and `tests/event-store.stress.test.ts`. CI definitions live in `.github/workflows/ci.yml` and `.github/workflows/sqlite-stress.yml`.

---

### Task 1: Lock the WAL-safe Runtime and Package Contract

**Files:**
- Create: `.node-version`
- Create: `scripts/check-runtime.js`
- Create: `tests/runtime-capabilities.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Node core `node:sqlite`, `node:fs`, `node:os`, and `node:path`.
- Produces: `npm run check:runtime`; JSON stdout `{ ok, nodeVersion, sqliteVersion, wal, fts5 }`; process exit `1` with code `SQLITE_CAPABILITY_MISSING` when unsafe.

- [ ] **Step 1: Write the failing package/runtime contract test**

```ts
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const root = process.cwd();

describe("event-store runtime contract", () => {
  it("declares the WAL-safe Node floor", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(pkg.engines.node, ">=22.22.3");
    assert.match(pkg.devDependencies["@types/node"], /^\^22\./);
  });

  it("passes the functional runtime probe on a supported runtime", () => {
    const result = spawnSync(process.execPath, [join(root, "scripts", "check-runtime.js"), "--json"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.wal, true);
    assert.equal(report.fts5, true);
    assert.match(report.sqliteVersion, /^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:build && node --test --test-reporter=spec dist-test/tests/runtime-capabilities.test.js`

Expected: FAIL because `engines.node`, `scripts/check-runtime.js`, and Node 22 type metadata do not exist.

- [ ] **Step 3: Add the engine, scripts, recommended runtime, and Node 22 types**

Set `.node-version` to:

```text
24.16.0
```

Apply this `package.json` contract and run `npm install --save-dev @types/node@^22` so the lockfile is regenerated by npm:

```json
{
  "engines": { "node": ">=22.22.3" },
  "scripts": {
    "check:runtime": "node scripts/check-runtime.js",
    "prestart": "npm run check:runtime",
    "prebuild": "npm run check:runtime",
    "pretest": "npm run check:runtime"
  },
  "devDependencies": {
    "@types/node": "^22.0.0"
  }
}
```

Preserve every existing script and dependency while merging these keys.

- [ ] **Step 4: Implement the standalone functional probe**

Create `scripts/check-runtime.js` with these exact gates: strictly parse stable dotted numeric versions; dynamically import `node:sqlite`; create a unique temporary file; verify SQLite `>=3.51.3`; request and read back WAL; set and read back `foreign_keys=ON`, `synchronous=FULL`, `busy_timeout=5000`, `trusted_schema=OFF`, and temporary probe `application_id=0x504d454d`; create/insert/query an FTS5 table; prove `BEGIN IMMEDIATE` plus `ROLLBACK`; close the database before removing the temporary directory. Emit one compact JSON object to stdout in `--json` mode and a concise success line otherwise. On any failure emit compact JSON to stderr with `{ ok:false, code:"SQLITE_CAPABILITY_MISSING", message }` and set `process.exitCode = 1`.

The central comparison and failure shape must be:

```js
const MIN_NODE = "22.22.3";
const MIN_SQLITE = "3.51.3";

function parseStableVersion(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`${label} must be a stable numeric x.y.z version, received ${value}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseStableVersion(left, "observed version");
  const b = parseStableVersion(right, "minimum version");
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

function fail(message) {
  const body = { ok: false, code: "SQLITE_CAPABILITY_MISSING", message };
  process.stderr.write(`${JSON.stringify(body)}\n`);
  process.exitCode = 1;
}
```

The complete executable body is:

```js
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MIN_NODE = "22.22.3";
const MIN_SQLITE = "3.51.3";
const APPLICATION_ID = 0x504d454d;
const asJson = process.argv.includes("--json");

function parseStableVersion(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`${label} must be a stable numeric x.y.z version, received ${value}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseStableVersion(left, "observed version");
  const b = parseStableVersion(right, "minimum version");
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  }
  return 0;
}

function value(row, key) {
  if (!row || !(key in row)) throw new Error(`Capability query did not return ${key}`);
  return row[key];
}

async function main() {
  const nodeVersion = process.versions.node;
  if (compareVersions(nodeVersion, MIN_NODE) < 0) throw new Error(`Node ${nodeVersion} is below ${MIN_NODE}`);
  const sqlite = await import("node:sqlite");
  const directory = mkdtempSync(join(tmpdir(), "project-memory-runtime-"));
  const path = join(directory, "capability.sqlite");
  let database;
  try {
    database = new sqlite.DatabaseSync(path, {
      open: true,
      readOnly: false,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      allowBareNamedParameters: false,
      allowUnknownNamedParameters: false,
      timeout: 5000,
    });
    const sqliteVersion = String(value(database.prepare("SELECT sqlite_version() AS version").get(), "version"));
    if (compareVersions(sqliteVersion, MIN_SQLITE) < 0) throw new Error(`SQLite ${sqliteVersion} is below ${MIN_SQLITE}`);
    const journalMode = String(value(database.prepare("PRAGMA journal_mode = WAL").get(), "journal_mode")).toLowerCase();
    database.exec(`
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA trusted_schema = OFF;
      PRAGMA application_id = ${APPLICATION_ID};
    `);
    const synchronous = Number(value(database.prepare("PRAGMA synchronous").get(), "synchronous"));
    const foreignKeys = Number(value(database.prepare("PRAGMA foreign_keys").get(), "foreign_keys"));
    const busyTimeoutMs = Number(value(database.prepare("PRAGMA busy_timeout").get(), "timeout"));
    const trustedSchema = Number(value(database.prepare("PRAGMA trusted_schema").get(), "trusted_schema"));
    const applicationId = Number(value(database.prepare("PRAGMA application_id").get(), "application_id"));
    database.exec("CREATE VIRTUAL TABLE capability_fts USING fts5(content)");
    database.prepare("INSERT INTO capability_fts(content) VALUES (?)").run("wal-safe-token");
    const ftsCount = Number(value(database.prepare("SELECT count(*) AS count FROM capability_fts WHERE capability_fts MATCH ?").get("wal-safe-token"), "count"));
    database.exec("CREATE TABLE rollback_probe(value TEXT NOT NULL) STRICT");
    database.exec("BEGIN IMMEDIATE");
    database.prepare("INSERT INTO rollback_probe(value) VALUES (?)").run("must-rollback");
    database.exec("ROLLBACK");
    const rollbackCount = Number(value(database.prepare("SELECT count(*) AS count FROM rollback_probe").get(), "count"));
    if (journalMode !== "wal" || synchronous !== 2 || foreignKeys !== 1 || busyTimeoutMs !== 5000 || trustedSchema !== 0 || applicationId !== APPLICATION_ID || ftsCount !== 1 || rollbackCount !== 0) {
      throw new Error("One or more functional SQLite capability checks failed");
    }
    const report = {
      ok: true,
      nodeVersion,
      sqliteVersion,
      nodeVersionAtLeastMinimum: true,
      sqliteVersionAtLeastMinimum: true,
      nodeSqlite: true,
      wal: true,
      fts5: true,
      foreignKeys: true,
      synchronousFull: true,
      busyTimeoutMs: 5000,
      trustedSchemaOff: true,
      transactionRollback: true,
      applicationId,
    };
    process.stdout.write(asJson ? `${JSON.stringify(report)}\n` : `Runtime OK: Node ${nodeVersion}, SQLite ${sqliteVersion}, WAL, FTS5\n`);
  } finally {
    database?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: "SQLITE_CAPABILITY_MISSING", message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 5: Run focused and existing gates**

Run:

```powershell
npm run check:runtime
npm run typecheck
npm run test:build
node --test --test-reporter=spec dist-test/tests/runtime-capabilities.test.js
```

Expected: runtime probe reports Node `>=22.22.3`, SQLite `>=3.51.3`, WAL and FTS5 true; all commands exit `0`.

- [ ] **Step 6: Commit**

```powershell
git add .node-version package.json package-lock.json scripts/check-runtime.js tests/runtime-capabilities.test.ts
git commit -m "build: require a WAL-safe SQLite runtime"
```

---

### Task 2: Define Trusted Explicit Project-Binding Requests

**Files:**
- Create: `src/orchestrator/identity/project-binding.request.ts`
- Create: `tests/project-binding.request.test.ts`

**Interfaces:**
- Consumes: a host-constructed object outside model-controlled MCP arguments.
- Produces: `parseTrustedProjectBindingRequest(input): TrustedProjectBindingRequest` with literal roots, stable client identity, role, source, and positive generation.

- [ ] **Step 1: Write the failing request-validation tests**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:build && node --test --test-reporter=spec dist-test/tests/project-binding.request.test.js`

Expected: TypeScript compilation fails because `project-binding.request.ts` does not exist.

- [ ] **Step 3: Implement the host-only request parser**

```ts
export type TrustedActorRole = "primary" | "maintenance" | "untrusted";
export type ProjectBindingSource = "stdio-explicit-root" | "mcp-roots" | "trusted-ide-adapter" | "explicit-cli";

export interface TrustedProjectBindingRequest {
  source: ProjectBindingSource;
  projectRoot: string;
  vaultRoot: string;
  clientNamespace: string;
  clientInstanceId: string;
  actorRole: TrustedActorRole;
  generation: number;
}

const DYNAMIC_ROOTS = new Set(["dynamic", "auto"]);
const SOURCES = new Set<ProjectBindingSource>(["stdio-explicit-root", "mcp-roots", "trusted-ide-adapter", "explicit-cli"]);
const ROLES = new Set<TrustedActorRole>(["primary", "maintenance", "untrusted"]);

export function parseTrustedProjectBindingRequest(input: Record<string, unknown>): TrustedProjectBindingRequest {
  const projectRoot = typeof input.projectRoot === "string" ? input.projectRoot.trim() : "";
  const vaultRoot = typeof input.vaultRoot === "string" ? input.vaultRoot.trim() : "";
  if (!projectRoot || DYNAMIC_ROOTS.has(projectRoot.toLowerCase())) throw new Error("PROJECT_ROOT_NOT_EXPLICIT");
  if (!vaultRoot || DYNAMIC_ROOTS.has(vaultRoot.toLowerCase())) throw new Error("VAULT_ROOT_NOT_EXPLICIT");
  if (!SOURCES.has(input.source as ProjectBindingSource)) throw new Error("BINDING_SOURCE_INVALID");
  if (!ROLES.has(input.actorRole as TrustedActorRole)) throw new Error("ACTOR_ROLE_INVALID");
  const clientNamespace = typeof input.clientNamespace === "string" ? input.clientNamespace.trim() : "";
  const clientInstanceId = typeof input.clientInstanceId === "string" ? input.clientInstanceId.trim() : "";
  if (!clientNamespace) throw new Error("CLIENT_NAMESPACE_INVALID");
  if (!clientInstanceId) throw new Error("CLIENT_INSTANCE_INVALID");
  if (!Number.isSafeInteger(input.generation) || Number(input.generation) <= 0) throw new Error("BINDING_GENERATION_INVALID");
  return {
    source: input.source as ProjectBindingSource,
    projectRoot,
    vaultRoot,
    clientNamespace,
    clientInstanceId,
    actorRole: input.actorRole as TrustedActorRole,
    generation: Number(input.generation),
  };
}
```

This type is never exported through a Zod tool schema. Subproject 5 will decide how operational modes construct it; this subproject consumes only a trusted request.

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:build && node --test --test-reporter=spec dist-test/tests/project-binding.request.test.js`

Expected: PASS with three subtests.

- [ ] **Step 5: Commit**

```powershell
git add src/orchestrator/identity/project-binding.request.ts tests/project-binding.request.test.ts
git commit -m "feat: validate trusted project binding requests"
```

---

### Task 3: Create Explicit Project Identity Without Read-Time Side Effects

**Files:**
- Create: `src/orchestrator/identity/contracts.ts`
- Create: `src/orchestrator/identity/canonical-path.ts`
- Create: `src/orchestrator/identity/project-descriptor.schema.ts`
- Create: `src/orchestrator/identity/project-descriptor.repository.ts`
- Create: `tests/project-descriptor.repository.test.ts`

**Interfaces:**
- Consumes: existing project and vault directories supplied by an explicit bootstrap caller.
- Produces: branded identity contracts, `canonicalExistingDirectory(path)`, `assertContainedPath(root, target)`, `ProjectDescriptorRepository.inspect(vaultRoot)`, and `createExplicit(projectRoot, vaultRoot)`.

- [ ] **Step 1: Write failing descriptor tests**

```ts
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ProjectDescriptorRepository } from "../src/orchestrator/identity/project-descriptor.repository.js";

describe("ProjectDescriptorRepository", () => {
  let root: string;
  let projectRoot: string;
  let vaultRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-identity-"));
    projectRoot = join(root, "project");
    vaultRoot = join(projectRoot, "memory");
    mkdirSync(vaultRoot, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reports missing without creating files or directories", () => {
    const repository = new ProjectDescriptorRepository();
    assert.equal(repository.inspect(vaultRoot).status, "missing");
    assert.equal(existsSync(join(vaultRoot, ".memory-mcp")), false);
  });

  it("creates one strict descriptor only through the explicit method", () => {
    const repository = new ProjectDescriptorRepository({
      now: () => "2026-07-11T00:00:00.000Z",
      randomId: (() => {
        const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
        return () => ids.shift()!;
      })(),
    });
    const descriptor = repository.createExplicit(projectRoot, vaultRoot);
    assert.equal(descriptor.projectId, "11111111-1111-4111-8111-111111111111");
    assert.equal(descriptor.vaultId, "22222222-2222-4222-8222-222222222222");
    assert.equal(repository.inspect(vaultRoot).status, "valid");
  });

  it("never overwrites an existing descriptor", () => {
    const repository = new ProjectDescriptorRepository();
    const first = repository.createExplicit(projectRoot, vaultRoot);
    assert.throws(() => repository.createExplicit(projectRoot, vaultRoot), /PROJECT_DESCRIPTOR_EXISTS/);
    const saved = JSON.parse(readFileSync(join(vaultRoot, ".memory-mcp", "project-identity.json"), "utf8"));
    assert.equal(saved.projectId, first.projectId);
  });

  it("rejects extra fields and malformed identity", () => {
    const directory = join(vaultRoot, ".memory-mcp");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "project-identity.json"), JSON.stringify({ schemaVersion: 1, projectId: "x", vaultId: "y", createdAt: "now", extra: true }));
    const result = new ProjectDescriptorRepository().inspect(vaultRoot);
    assert.equal(result.status, "invalid");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:build && node --test --test-reporter=spec dist-test/tests/project-descriptor.repository.test.js`

Expected: compilation fails because the identity modules do not exist.

- [ ] **Step 3: Add the identity contracts and strict schema**

```ts
import type { ProjectBindingSource, TrustedActorRole } from "./project-binding.request.js";

export type ProjectId = string & { readonly __projectId: unique symbol };
export type VaultId = string & { readonly __vaultId: unique symbol };
export type StoreId = string & { readonly __storeId: unique symbol };
export type WorkspaceId = string & { readonly __workspaceId: unique symbol };
export type BranchScopeId = string & { readonly __branchScopeId: unique symbol };

export interface ProjectDescriptorV1 {
  schemaVersion: 1;
  projectId: ProjectId;
  vaultId: VaultId;
  createdAt: string;
}

export interface GitWorkspaceSnapshot {
  kind: "git";
  worktreeRoot: string;
  gitDir: string;
  gitCommonDir: string;
  headCommit: string;
  branchRef: string | null;
  detached: boolean;
  workspaceId: WorkspaceId;
}

export interface NonGitWorkspaceSnapshot {
  kind: "non-git";
  workspaceRoot: string;
  workspaceId: WorkspaceId;
}

export type WorkspaceSnapshot = GitWorkspaceSnapshot | NonGitWorkspaceSnapshot;

export interface ProjectStoreRoute {
  kind: "git-common" | "vault-local";
  storeRoot: string;
  eventsPath: string;
  storeManifestPath: string;
  projectionManifestPath: string;
}

export interface ProjectBinding {
  projectBindingId: string;
  generation: number;
  contextFingerprint: string;
  source: ProjectBindingSource;
  projectId: ProjectId;
  vaultId: VaultId;
  storeId: StoreId;
  workspaceId: WorkspaceId;
  clientNamespace: string;
  clientInstanceId: string;
  actorRole: TrustedActorRole;
  projectRoot: string;
  vaultRoot: string;
  descriptorPath: string;
  storeRoute: ProjectStoreRoute;
  workspace: WorkspaceSnapshot;
  establishedAt: string;
}

export interface ProjectContext {
  binding: ProjectBinding;
  workspace: WorkspaceSnapshot;
  branchScopeId?: BranchScopeId;
  checkedAt: string;
}
```

Use this strict Zod schema and cast only after parsing:

```ts
import { z } from "zod";
import type { ProjectDescriptorV1 } from "./contracts.js";

export const projectDescriptorSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().uuid(),
  vaultId: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export function parseProjectDescriptor(value: unknown): ProjectDescriptorV1 {
  return projectDescriptorSchema.parse(value) as ProjectDescriptorV1;
}
```

- [ ] **Step 4: Implement canonical paths and exclusive descriptor creation**

`canonicalExistingDirectory()` must reject empty input, call `realpathSync.native`, assert the result is a directory, and return `resolve(realPath)`. `assertContainedPath()` must reject empty inputs, compute `relative(canonicalRoot, canonicalTarget)`, allow the empty result when both paths are the same directory, and reject only `..`, a value beginning with `..${sep}`, or an absolute relative result. On Windows it compares canonicalized drive/UNC identity without locale-sensitive lowercasing.

The repository contract is:

```ts
export type DescriptorInspection =
  | { status: "valid"; path: string; descriptor: ProjectDescriptorV1 }
  | { status: "missing"; path: string }
  | { status: "invalid"; path: string; issues: string[] };

export interface ProjectDescriptorDependencies {
  now: () => string;
  randomId: () => string;
}

export class ProjectDescriptorRepository {
  constructor(private readonly dependencies: ProjectDescriptorDependencies = {
    now: () => new Date().toISOString(),
    randomId: randomUUID,
  }) {}

  inspect(vaultRoot: string): DescriptorInspection;
  createExplicit(projectRoot: string, vaultRoot: string): ProjectDescriptorV1;
}
```

`inspect()` reads only `<vaultRoot>/.memory-mcp/project-identity.json`. `createExplicit()` first canonicalizes both existing directories, builds the parsed descriptor, writes canonical pretty JSON plus one trailing newline to a same-directory exclusive temporary file, calls `fsyncSync`, closes it, then uses `linkSync(tempPath, descriptorPath)` as the atomic no-overwrite publication step. Convert `EEXIST` to `PROJECT_DESCRIPTOR_EXISTS`, always unlink the temporary name, and never accept `overwrite`.

- [ ] **Step 5: Run identity tests and typecheck**

Run:

```powershell
npm run typecheck
npm run test:build
node --test --test-reporter=spec dist-test/tests/project-descriptor.repository.test.js
```

Expected: four descriptor tests pass and no `.memory-mcp` directory is created by inspection.

- [ ] **Step 6: Commit**

```powershell
git add src/orchestrator/identity tests/project-descriptor.repository.test.ts
git commit -m "feat: add explicit project identity descriptor"
```

---

### Task 4: Resolve Git Workspaces and Route Isolated Stores

**Files:**
- Create: `src/orchestrator/identity/git-workspace.resolver.ts`
- Create: `src/orchestrator/identity/project-store.router.ts`
- Create: `src/orchestrator/identity/store-manifest.schema.ts`
- Create: `src/orchestrator/identity/store-manifest.repository.ts`
- Create: `tests/git-workspace.resolver.test.ts`
- Create: `tests/project-store.router.test.ts`

**Interfaces:**
- Consumes: parsed `ProjectDescriptorV1`, canonical project/vault roots, and exact Git subprocess results.
- Produces: `GitWorkspaceResolver.inspect(projectRoot, descriptor): WorkspaceSnapshot`, `ProjectStoreRouter.route(descriptor, vaultRoot, workspace): ProjectStoreRoute`, and strict physical-store manifest inspection/creation.

- [ ] **Step 1: Write failing resolver and routing tests**

Use an injected runner and assert this exact matrix:

```ts
const calls: Array<{ cwd: string; args: string[] }> = [];
const runner: GitCommandRunner = {
  run(cwd, args) {
    calls.push({ cwd, args });
    const key = args.join(" ");
    const outputs: Record<string, string> = {
      "rev-parse --show-toplevel": "C:/repo/worktree-a\n",
      "rev-parse --path-format=absolute --absolute-git-dir": "C:/repo/.git/worktrees/a\n",
      "rev-parse --path-format=absolute --git-common-dir": "C:/repo/.git\n",
      "rev-parse HEAD": "0123456789abcdef0123456789abcdef01234567\n",
      "symbolic-ref -q HEAD": "refs/heads/feature/a\n",
    };
    return outputs[key] === undefined
      ? { exitCode: 1, stdout: "", stderr: "unexpected args" }
      : { exitCode: 0, stdout: outputs[key], stderr: "" };
  },
};
```

Tests must prove:

- normal checkout and linked worktree snapshots record exact `gitDir`, shared `gitCommonDir`, full `branchRef`, and HEAD;
- two worktree roots yield different `workspaceId` values but the same `storeRoot`;
- detached HEAD sets `branchRef: null` and `detached: true`;
- a non-Git directory produces `kind: "non-git"` without fabricating Git paths;
- spaces, Thai/Unicode segments, Windows drive-case drift, and UNC paths remain single argv/path values and canonicalize deterministically;
- the real runner uses `spawnSync("git", args, { shell:false })` and never concatenates a shell command;
- Git route is `<commonDir>/project-memory/<projectId>/v2`, non-Git route is `<vaultRoot>/.memory-mcp/v2`;
- routing and manifest inspection create nothing;
- manifest `projectId`/`vaultId` mismatch is invalid and a second explicit create never overwrites.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/git-workspace.resolver.test.js dist-test/tests/project-store.router.test.js
```

Expected: compilation fails because resolver, router, and manifest modules do not exist.

- [ ] **Step 3: Implement the Git runner and deterministic workspace identity**

```ts
export interface GitCommandResult { exitCode: number; stdout: string; stderr: string }
export interface GitCommandRunner { run(cwd: string, args: string[]): GitCommandResult }

export class SpawnSyncGitCommandRunner implements GitCommandRunner {
  run(cwd: string, args: string[]): GitCommandResult {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.error?.message ?? "",
    };
  }
}

export function deriveGitWorkspaceId(projectId: ProjectId, gitCommonDir: string, gitDir: string): WorkspaceId {
  assertContainedPath(gitCommonDir, gitDir);
  const administrativeIdentity = gitDir.replace(/\\/g, "/");
  return createHash("sha256")
    .update("project-memory/workspace/v1\0", "utf8")
    .update(projectId, "utf8")
    .update("\0", "utf8")
    .update(administrativeIdentity, "utf8")
    .digest("hex") as WorkspaceId;
}

export function deriveNonGitWorkspaceId(projectId: ProjectId, vaultId: VaultId): WorkspaceId {
  return createHash("sha256")
    .update("project-memory/non-git-workspace/v1\0", "utf8")
    .update(projectId, "utf8")
    .update("\0", "utf8")
    .update(vaultId, "utf8")
    .digest("hex") as WorkspaceId;
}
```

`GitWorkspaceResolver.inspect()` issues only the five argument arrays shown in Step 1. Treat the directory as non-Git only when Git executed successfully enough to return its verified not-a-repository diagnostic. Executable-not-found, timeout, permission, dubious-ownership/safe-directory, malformed output, and every later probe failure are `GIT_PROBE_FAILED`. Cover an unborn HEAD with a typed not-ready result; canonicalize every returned filesystem directory before deriving identity.

- [ ] **Step 4: Implement pure routing and strict store manifests**

```ts
export interface StoreManifestV1 {
  schemaVersion: 1;
  storeId: StoreId;
  projectId: ProjectId;
  vaultId: VaultId;
  createdAt: string;
  lastIntegrity:
    | { status: "never" }
    | { status: "passed" | "failed"; checkedAt: string; schemaFingerprint: string; terminalEventHash: string };
}

export class ProjectStoreRouter {
  route(descriptor: ProjectDescriptorV1, vaultRoot: string, workspace: WorkspaceSnapshot): ProjectStoreRoute {
    const base = workspace.kind === "git"
      ? resolve(workspace.gitCommonDir, "project-memory", descriptor.projectId, "v2")
      : resolve(canonicalExistingDirectory(vaultRoot), ".memory-mcp", "v2");
    return {
      kind: workspace.kind === "git" ? "git-common" : "vault-local",
      storeRoot: base,
      eventsPath: join(base, "events.sqlite"),
      storeManifestPath: join(base, "store-manifest.json"),
      projectionManifestPath: join(base, "current-projection.json"),
    };
  }
}
```

The manifest schema is strict, UUID-validating, and RFC3339-validating. Its repository mirrors the descriptor repository's `inspect()` and explicit `create()` behavior, including same-directory exclusive temporary publication and `STORE_MANIFEST_EXISTS`. It accepts a caller-supplied `storeId` so bootstrap can write identical identity into SQLite and the manifest. `recordIntegrity(route, expectedIds, result)` may atomically replace only `lastIntegrity`; it reparses the current file, preserves every identity field byte-for-byte, verifies the expected store identity, writes and fsyncs a same-directory temporary file, then atomically replaces the manifest.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npm run typecheck
npm run test:build
node --test --test-reporter=spec dist-test/tests/git-workspace.resolver.test.js dist-test/tests/project-store.router.test.js
```

Expected: all routing, linked-worktree, detached-HEAD, non-Git, no-side-effect, and no-overwrite tests pass.

- [ ] **Step 6: Commit**

```powershell
git add src/orchestrator/identity tests/git-workspace.resolver.test.ts tests/project-store.router.test.ts
git commit -m "feat: route isolated project stores"
```

---

### Task 5: Freeze Canonical JSON and Hash Contracts

**Files:**
- Create: `src/orchestrator/contracts/event.ts`
- Create: `src/orchestrator/serialization/canonical-json.ts`
- Create: `src/orchestrator/crypto/event-hash.ts`
- Create: `tests/canonical-json.test.ts`
- Create: `tests/event-hash.test.ts`

**Interfaces:**
- Consumes: untrusted command/event values and immutable event-envelope material.
- Produces: `JsonValue`, `PendingEvent`, `AppendCommand`, `AppendResult`, `StoredEvent`, `canonicalJson(value)`, `payloadHash(value)`, `commandHash(material)`, `responseHash(value)`, `outboxHash(value)`, and `eventHash(material)`.

- [ ] **Step 1: Write failing canonicalization tests**

```ts
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";

describe("canonicalJson", () => {
  it("sorts object keys, preserves arrays and strings, and normalizes negative zero", () => {
    assert.equal(
      canonicalJson({ z: -0, a: ["ไทย", 3, true, null], nested: { b: 2, a: 1 } }),
      '{"a":["ไทย",3,true,null],"nested":{"a":1,"b":2},"z":0}',
    );
  });

  it("rejects values outside the JSON domain", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [undefined, 1n, Number.NaN, Number.POSITIVE_INFINITY, new Date(), cycle, () => true]) {
      assert.throws(() => canonicalJson(value), /CANONICAL_JSON_INVALID/);
    }
  });

  it("rejects symbols, accessors, and class instances instead of silently dropping data", () => {
    class Example { value = 1 }
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
    assert.throws(() => canonicalJson({ [Symbol("x")]: 1 }), /CANONICAL_JSON_INVALID/);
    assert.throws(() => canonicalJson(accessor), /CANONICAL_JSON_INVALID/);
    assert.throws(() => canonicalJson(new Example()), /CANONICAL_JSON_INVALID/);
  });
});
```

- [ ] **Step 2: Write failing golden hash-vector tests**

Use these locked vectors; changing any domain string, field name, decimal encoding, array order, or canonicalization rule must fail review:

```ts
const payload = { z: -0, a: ["ไทย", 3, true, null], nested: { b: 2, a: 1 } };
assert.equal(payloadHash(payload), "392e7a273f8bf98f2d6aed8b485f468dc1fc649056ee8b648a628011f7cad2d9");

assert.equal(commandHash({
  commandId: "33333333-3333-4333-8333-333333333333",
  commandType: "AppendTest",
  projectId: "11111111-1111-4111-8111-111111111111",
  storeId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "workspace-a",
  git: {
    headCommit: "0123456789abcdef0123456789abcdef01234567",
    branchRef: "refs/heads/main",
    detached: false,
  },
  streamId: "stream-1",
  streamType: "test",
  expectedStreamVersion: "0",
  correlationId: "corr-1",
  agentId: "agent-a",
  events: [{
    eventType: "TestRecorded",
    eventSchemaVersion: 1,
    occurredAt: "2026-07-11T00:00:00.000Z",
    visibilityScope: "project",
    confidence: "high",
    verificationStatus: "verified",
    payload,
    sourceRefs: [],
    evidenceRefs: [],
    evidenceDigests: [],
  }],
  outbox: [],
}), "5af04ec6906046ac558dd4ae3390722906f6dbc276f85915fa0f08a24fc02d58");

assert.equal(responseHash({
  eventIds: ["44444444-4444-4444-8444-444444444444"],
  firstGlobalPosition: "1",
  lastGlobalPosition: "1",
  finalStreamVersion: "1",
  response: { accepted: true },
}), "1d0c59cbfde32fbb1d9b2cb927276f9d92979d1dad90d13c076223cf118f9f34");

assert.equal(
  outboxHash({ kind: "projection", position: "1" }),
  "e03329f03392fdfed8f0e8c4b020bbd18ed8152abdc1ba5f6f680d64c10092d1",
);

assert.equal(eventHash({
  globalPosition: "1",
  eventId: "44444444-4444-4444-8444-444444444444",
  projectId: "11111111-1111-4111-8111-111111111111",
  vaultId: "55555555-5555-4555-8555-555555555555",
  storeId: "22222222-2222-4222-8222-222222222222",
  workspaceId: "workspace-a",
  branchScopeId: null,
  branchRef: "refs/heads/main",
  streamId: "stream-1",
  streamType: "test",
  streamVersion: "1",
  eventType: "TestRecorded",
  eventSchemaVersion: 1,
  sessionId: null,
  parentSessionId: null,
  actorRole: "primary",
  agentId: "agent-a",
  clientInstanceId: "client-a",
  correlationId: "corr-1",
  causationId: null,
  commandId: "33333333-3333-4333-8333-333333333333",
  idempotencyKey: "idem-1",
  commandEventIndex: 0,
  occurredAt: "2026-07-11T00:00:00.000Z",
  recordedAt: "2026-07-11T00:00:01.000Z",
  visibilityScope: "project",
  confidence: "high",
  verificationStatus: "verified",
  sourceRefs: [],
  evidenceRefs: [],
  evidenceDigests: [],
  payloadHash: payloadHash(payload),
  previousGlobalHash: "0".repeat(64),
}), "dfb2678844522cffb3681a7402c209ce9ad741e9ad0a3367a911dbba53057de0");
```

This vector locks the 64-zero genesis hash and every immutable envelope field used by the event hash.

- [ ] **Step 3: Run tests to verify they fail**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/canonical-json.test.js dist-test/tests/event-hash.test.js
```

Expected: compilation fails because the event contracts and serialization/hash modules do not exist.

- [ ] **Step 4: Implement the event contracts**

```ts
import type { BranchScopeId, ProjectContext, ProjectId, StoreId, VaultId, WorkspaceId } from "../identity/contracts.js";
import type { TrustedActorRole } from "../identity/project-binding.request.js";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type VisibilityScope = "session" | "workspace" | "branch" | "project" | "global";
export type Confidence = "high" | "medium" | "low" | "guess";
export type VerificationStatus = "unverified" | "provisional" | "verified" | "conflicted";

export interface EvidenceDigest {
  ciphertextHash: string;
  keyedFingerprint: string;
}

export interface PendingEvent {
  eventType: string;
  eventSchemaVersion: number;
  occurredAt: string;
  visibilityScope: VisibilityScope;
  sessionId?: string;
  parentSessionId?: string;
  causationId?: string;
  confidence: Confidence;
  verificationStatus: VerificationStatus;
  payload: JsonValue;
  sourceRefs: string[];
  evidenceRefs: string[];
  evidenceDigests: EvidenceDigest[];
}

export interface PendingOutbox {
  targetKey: string;
  kind: string;
  eventIndex: number;
  payload: JsonValue;
}

export interface AppendCommand<TResponse extends JsonValue> {
  context: ProjectContext;
  commandId: string;
  idempotencyKey: string;
  commandType: string;
  correlationId: string;
  agentId: string;
  expectedStreamVersion: bigint;
  streamId: string;
  streamType: string;
  events: PendingEvent[];
  outbox: PendingOutbox[];
  publicResponse: TResponse;
}

export interface AppendResult<TResponse extends JsonValue> {
  deduplicated: boolean;
  firstGlobalPosition: bigint;
  lastGlobalPosition: bigint;
  finalStreamVersion: bigint;
  eventIds: string[];
  response: TResponse;
  responseHash: string;
}

export interface StoredEvent {
  globalPosition: bigint;
  eventId: string;
  projectId: ProjectId;
  vaultId: VaultId;
  storeId: StoreId;
  workspaceId: WorkspaceId;
  branchScopeId: BranchScopeId | null;
  branchRef: string | null;
  streamId: string;
  streamType: string;
  streamVersion: bigint;
  eventType: string;
  eventSchemaVersion: number;
  sessionId: string | null;
  parentSessionId: string | null;
  actorRole: TrustedActorRole;
  agentId: string;
  clientInstanceId: string;
  correlationId: string;
  causationId: string | null;
  commandId: string;
  idempotencyKey: string;
  commandEventIndex: number;
  occurredAt: string;
  recordedAt: string;
  visibilityScope: Exclude<VisibilityScope, "global">;
  confidence: Confidence;
  verificationStatus: VerificationStatus;
  sourceRefs: string[];
  evidenceRefs: [];
  evidenceDigests: [];
  payload: JsonValue;
  payloadJson: string;
  payloadHash: string;
  previousGlobalHash: string;
  eventHash: string;
}
```

Hash-material interfaces convert bigint fields to decimal strings before canonicalization.

- [ ] **Step 5: Implement strict canonical JSON and domain-separated hashes**

`canonicalJson(value: unknown)` recursively accepts only null, booleans, strings, finite numbers, arrays, and plain objects whose own enumerable properties are data properties. It tracks visited objects to reject cycles, sorts object keys by JavaScript code-unit order, preserves array order and strings byte-for-byte, and renders `-0` as `0`.

```ts
import { createHash } from "node:crypto";
import { canonicalJson } from "../serialization/canonical-json.js";

function hashDomain(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\n${canonicalJson(value)}`, "utf8").digest("hex");
}

export const payloadHash = (value: unknown) => hashDomain("project-memory/payload/v1", value);
export const commandHash = (value: unknown) => hashDomain("project-memory/command/v1", value);
export const responseHash = (value: unknown) => hashDomain("project-memory/response/v1", value);
export const eventHash = (value: unknown) => hashDomain("project-memory/event/v1", value);
export const outboxHash = (value: unknown) => hashDomain("project-memory/outbox/v1", value);
```

- [ ] **Step 6: Run focused tests**

Run:

```powershell
npm run typecheck
npm run test:build
node --test --test-reporter=spec dist-test/tests/canonical-json.test.js dist-test/tests/event-hash.test.js
```

Expected: canonicalization rejection tests and all five golden hashes pass.

- [ ] **Step 7: Commit**

```powershell
git add src/orchestrator/contracts src/orchestrator/serialization src/orchestrator/crypto tests/canonical-json.test.ts tests/event-hash.test.ts
git commit -m "feat: define canonical event hash contracts"
```

---

### Task 6: Build the Hardened SQLite Driver and Shared Capability Gate

**Files:**
- Create: `src/orchestrator/runtime/runtime-capabilities.ts`
- Create: `src/orchestrator/storage/sqlite-driver.ts`
- Create: `src/orchestrator/storage/node-sqlite-driver.ts`
- Create: `tests/sqlite-driver.test.ts`

**Interfaces:**
- Consumes: a dynamically loaded `typeof import("node:sqlite")` module and a concrete database path.
- Produces: `compareVersions`, `probeRuntimeCapabilities`, `SqliteDriver.open(path, options)`, bigint-safe named statements, and typed `SQLITE_CAPABILITY_MISSING` failures.

- [ ] **Step 1: Write failing driver and capability tests**

Tests use a real temporary SQLite file and prove:

```ts
assert.equal(compareVersions("3.51.3", "3.51.3"), 0);
assert.equal(compareVersions("3.53.0", "3.51.3"), 1);
assert.equal(compareVersions("3.51.2", "3.51.3"), -1);
assert.throws(() => compareVersions("3.51.3-rc1", "3.51.3"), /stable numeric x\.y\.z/);

const report = await probeRuntimeCapabilities(probePath);
assert.equal(report.ok, true);
if (!report.ok) assert.fail(report.message);
assert.equal(report.sqliteVersionAtLeastMinimum, true);
assert.equal(report.wal, true);
assert.equal(report.fts5, true);

const connection = driver.open(databasePath, { mode: "create", busyTimeoutMs: 5000 });
connection.exec("CREATE TABLE sample(value INTEGER NOT NULL) STRICT");
connection.prepare("INSERT INTO sample(value) VALUES ($value)").run({ $value: 9007199254740993n });
assert.equal(connection.prepare("SELECT value FROM sample").get()!.value, 9007199254740993n);
connection.close();
```

Also assert that `mode: "existing"` refuses a missing path, WAL reads back as `wal`, extensions are not exposed by the abstraction, `foreign_keys=1`, `synchronous=2`, `trusted_schema=0`, `busy_timeout=5000`, FTS5 query returns the inserted token, and a rolled-back row count is zero.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:build && node --test --test-reporter=spec dist-test/tests/sqlite-driver.test.js`

Expected: compilation fails because the capability and driver modules do not exist.

- [ ] **Step 3: Define the narrow driver interfaces**

```ts
export type SqliteValue = null | number | bigint | string | Uint8Array;
export type SqliteParams = Record<`$${string}`, SqliteValue>;
export type SqliteRow = Record<string, SqliteValue>;

export interface SqliteRunResult {
  changes: bigint;
  lastInsertRowid: bigint;
}

export interface SqliteStatement {
  run(params?: SqliteParams): SqliteRunResult;
  get(params?: SqliteParams): SqliteRow | undefined;
  all(params?: SqliteParams): SqliteRow[];
  iterate(params?: SqliteParams): IterableIterator<SqliteRow>;
}

export interface SqliteConnection {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteOpenOptions {
  mode: "create" | "existing" | "read-only-existing";
  busyTimeoutMs: number;
}

export interface SqliteDriver {
  open(path: string, options: SqliteOpenOptions): SqliteConnection;
}
```

Only `$`-prefixed named parameters cross this abstraction. Dynamic identifiers and caller-provided SQL are forbidden.

- [ ] **Step 4: Implement the dynamic capability probe**

`probeRuntimeCapabilities(probePath)` dynamically imports `node:sqlite`, returns a discriminated success/failure object, and performs the same functional checks as `scripts/check-runtime.js`, including setting and reading the fixed application ID only in the disposable probe. It must close the database on every path. The driver test compares the shared report with `scripts/check-runtime.js --json` so the standalone prebuild gate cannot silently drift. Use constants:

```ts
export const MINIMUM_NODE_VERSION = "22.22.3";
export const MINIMUM_SQLITE_VERSION = "3.51.3";
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;
export const PROJECT_MEMORY_APPLICATION_ID = 0x504d454d;

export interface RuntimeCapabilityReport {
  nodeVersion: string;
  sqliteVersion: string;
  nodeVersionAtLeastMinimum: true;
  sqliteVersionAtLeastMinimum: true;
  nodeSqlite: true;
  wal: true;
  fts5: true;
  foreignKeys: true;
  synchronousFull: true;
  busyTimeoutMs: 5000;
  trustedSchemaOff: true;
  transactionRollback: true;
  applicationId: 0x504d454d;
}

export type RuntimeCapabilityResult =
  | ({ ok: true } & RuntimeCapabilityReport)
  | {
      ok: false;
      code: "SQLITE_CAPABILITY_MISSING";
      message: string;
      nodeVersion: string;
      sqliteVersion?: string;
      checks: Record<string, boolean>;
    };
```

Do not convert a failed import or failed WAL/FTS/transaction probe into a warning. Return `code: "SQLITE_CAPABILITY_MISSING"`, a safe message, the observed versions, and individual boolean checks.

- [ ] **Step 5: Implement the `DatabaseSync` adapter**

Construct `DatabaseSync` with:

```ts
const database = new sqlite.DatabaseSync(path, {
  open: true,
  readOnly: options.mode === "read-only-existing",
  enableForeignKeyConstraints: true,
  enableDoubleQuotedStringLiterals: false,
  allowExtension: false,
  allowBareNamedParameters: false,
  allowUnknownNamedParameters: false,
  timeout: options.busyTimeoutMs,
});
```

For writable modes, immediately execute the fixed PRAGMAs and read each value back. Read-only existing mode sets connection-local foreign-key/trusted-schema controls and verifies the database's current journal/application identity without requesting a journal transition. Throw `SQLITE_CAPABILITY_MISSING` if any result differs. Every wrapped `StatementSync` calls `setReadBigInts(true)` before use; call `run/get/all/iterate` with zero arguments when no parameters exist and convert `changes` and `lastInsertRowid` to bigint without passing through JavaScript number. `existing` and `read-only-existing` first perform a read-only open/identity check so a missing path cannot be created; the subsequent writable open immediately rechecks application ID and `project_meta` before any write. Local administrator replacement during that narrow handoff remains outside the stated local-process threat boundary.

- [ ] **Step 6: Run focused tests**

Run:

```powershell
npm run typecheck
npm run test:build
node --test --test-reporter=spec dist-test/tests/sqlite-driver.test.js
```

Expected: version comparison, real WAL, FTS5, PRAGMA, bigint, rollback, and missing-existing-path tests pass.

- [ ] **Step 7: Commit**

```powershell
git add src/orchestrator/runtime/runtime-capabilities.ts src/orchestrator/storage/sqlite-driver.ts src/orchestrator/storage/node-sqlite-driver.ts tests/sqlite-driver.test.ts
git commit -m "feat: add hardened node sqlite driver"
```

---

### Task 7: Create Checksummed Migrations and Explicit Store Bootstrap

**Files:**
- Create: `src/orchestrator/storage/migration.ts`
- Create: `src/orchestrator/storage/migration-runner.ts`
- Create: `src/orchestrator/storage/migrations/0001-event-core.ts`
- Create: `src/orchestrator/storage/project-store-bootstrap.service.ts`
- Create: `src/orchestrator/storage/branch-scope.repository.ts`
- Create: `tests/migration-runner.test.ts`
- Create: `tests/project-store-bootstrap.test.ts`

**Interfaces:**
- Consumes: explicit project/vault roots, parsed descriptor, routed store, `SqliteDriver`, capability report, UUID/clock dependencies, and explicit replica decision.
- Produces: `MigrationRunner.apply()`, schema version `1`, `ProjectStoreBootstrapService.initialize(input)`, and persistent branch-lineage operations.

- [ ] **Step 1: Write failing migration and bootstrap tests**

The migration test must use a real file and assert:

```ts
const applied = runner.apply(connection, [eventCoreMigration], "2026-07-11T00:00:00.000Z");
assert.deepEqual(applied, [1]);
assert.deepEqual(runner.apply(connection, [eventCoreMigration], "2026-07-11T00:00:01.000Z"), []);
assert.throws(() => connection.exec("UPDATE schema_migrations SET name='changed' WHERE version=1"), /SCHEMA_MIGRATIONS_IMMUTABLE/);
assert.throws(() => runner.apply(connection, [{ ...eventCoreMigration, sql: `${eventCoreMigration.sql}\nSELECT 1;` }], "2026-07-11T00:00:02.000Z"), /MIGRATION_CHECKSUM_MISMATCH/);
```

The bootstrap test must assert this exact behavior matrix:

- an explicit `initialize()` call with a missing descriptor creates descriptor, routed directory, `events.sqlite`, one manifest, migration row, `project_meta`, and idle maintenance state;
- inspection/startup without explicit initialization creates none of those paths;
- an existing descriptor with neither manifest nor database returns `PROJECT_REPLICA_DECISION_REQUIRED` unless `replicaDecision: "initialize-local"` is supplied;
- an existing descriptor plus matching valid database but missing manifest is the crash-recovery state: read `project_meta` and publish the same `storeId` automatically without a replica decision or second database;
- manifest without database, malformed database, wrong application ID, or any descriptor/database mismatch fails closed and never initializes over the evidence;
- descriptor, manifest, and `project_meta` IDs must be identical;
- a nonzero wrong `application_id` returns `STORE_UNAVAILABLE` and is never overwritten;
- a second successful initialization is an idempotent inspection result and never replaces identity;
- an existing migration version newer than the binary returns `SCHEMA_TOO_NEW`, and two first-open contenders converge on one checksummed schema without a partial migration;
- an injected crash while building the same-directory bootstrap database leaves no published `events.sqlite`; a crash after database publication but before manifest publication is recovered from the complete `project_meta` identity;
- a branch rename keeps its UUID only through explicit `recordRename`; retiring a scope and reusing the name creates a new UUID.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/migration-runner.test.js dist-test/tests/project-store-bootstrap.test.js
```

Expected: compilation fails because migration, bootstrap, and branch-scope modules do not exist.

- [ ] **Step 3: Define the migration contract and checksum runner**

```ts
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export function migrationChecksum(migration: Migration): string {
  return createHash("sha256").update(migration.sql, "utf8").digest("hex");
}

export class MigrationRunner {
  apply(connection: SqliteConnection, migrations: readonly Migration[], appliedAt: string): number[];
}
```

`apply()` verifies strictly increasing positive versions and unique names before touching the connection. It reads `PRAGMA application_id`: value `0` is set to `PROJECT_MEMORY_APPLICATION_ID` only during explicit bootstrap; any other value must equal that constant. If `schema_migrations` exists, verify every recorded name/checksum before applying a later version and reject a recorded version newer than the binary as `SCHEMA_TOO_NEW`. Apply each migration with `BEGIN IMMEDIATE`, re-read migration state after acquiring the writer lock, execute its fixed SQL only when still absent, insert its version/name/raw-SQL SHA-256/applied time, and `COMMIT`; catch every error, attempt `ROLLBACK`, then rethrow the original typed failure.

- [ ] **Step 4: Create migration `0001-event-core` with exact source tables**

The SQL must create STRICT tables with these keys and checks:

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY CHECK (version > 0),
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE project_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  project_id TEXT NOT NULL UNIQUE,
  vault_id TEXT NOT NULL UNIQUE,
  store_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE branch_scopes (
  project_id TEXT NOT NULL,
  branch_scope_id TEXT NOT NULL,
  current_ref TEXT,
  created_head TEXT NOT NULL,
  detached INTEGER NOT NULL CHECK (detached IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  PRIMARY KEY (project_id, branch_scope_id),
  FOREIGN KEY (project_id) REFERENCES project_meta(project_id)
) STRICT;

CREATE UNIQUE INDEX branch_scopes_active_ref
ON branch_scopes(project_id, current_ref)
WHERE current_ref IS NOT NULL AND retired_at IS NULL;

CREATE TABLE streams (
  project_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  stream_type TEXT NOT NULL CHECK (length(stream_type) > 0),
  current_version INTEGER NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, stream_id),
  UNIQUE (project_id, stream_id, stream_type),
  FOREIGN KEY (project_id) REFERENCES project_meta(project_id)
) STRICT;

CREATE TABLE events (
  global_position INTEGER PRIMARY KEY CHECK (global_position > 0),
  event_id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  store_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  branch_scope_id TEXT,
  branch_ref TEXT,
  stream_id TEXT NOT NULL,
  stream_type TEXT NOT NULL CHECK (length(stream_type) > 0),
  stream_version INTEGER NOT NULL CHECK (stream_version > 0),
  event_type TEXT NOT NULL CHECK (length(event_type) > 0),
  event_schema_version INTEGER NOT NULL CHECK (event_schema_version > 0),
  session_id TEXT,
  parent_session_id TEXT,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('primary','maintenance','untrusted')),
  agent_id TEXT NOT NULL,
  client_instance_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  command_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_event_index INTEGER NOT NULL CHECK (command_event_index >= 0),
  occurred_at TEXT NOT NULL CHECK (length(trim(occurred_at)) > 0),
  recorded_at TEXT NOT NULL CHECK (length(trim(recorded_at)) > 0),
  visibility_scope TEXT NOT NULL CHECK (visibility_scope IN ('session','workspace','branch','project','global')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low','guess')),
  verification_status TEXT NOT NULL CHECK (verification_status IN ('unverified','provisional','verified','conflicted')),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  evidence_refs_json TEXT NOT NULL CHECK (json_valid(evidence_refs_json)),
  evidence_digests_json TEXT NOT NULL CHECK (json_valid(evidence_digests_json)),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  previous_global_hash TEXT NOT NULL CHECK (length(previous_global_hash) = 64),
  event_hash TEXT NOT NULL CHECK (length(event_hash) = 64),
  UNIQUE (project_id, stream_id, stream_version),
  UNIQUE (project_id, command_id, command_event_index),
  FOREIGN KEY (project_id, stream_id, stream_type) REFERENCES streams(project_id, stream_id, stream_type),
  FOREIGN KEY (project_id, branch_scope_id) REFERENCES branch_scopes(project_id, branch_scope_id)
) STRICT;

CREATE INDEX events_project_idempotency
ON events(project_id, idempotency_key);

CREATE TABLE command_dedup (
  project_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  command_hash TEXT NOT NULL CHECK (length(command_hash) = 64),
  state TEXT NOT NULL CHECK (state = 'committed'),
  first_global_position INTEGER NOT NULL,
  last_global_position INTEGER NOT NULL CHECK (last_global_position >= first_global_position),
  final_stream_version INTEGER NOT NULL CHECK (final_stream_version > 0),
  event_ids_json TEXT NOT NULL CHECK (json_valid(event_ids_json)),
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  response_hash TEXT NOT NULL CHECK (length(response_hash) = 64),
  committed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, idempotency_key),
  UNIQUE (project_id, command_id),
  FOREIGN KEY (project_id) REFERENCES project_meta(project_id)
) STRICT;

CREATE TABLE workflow_instances (
  project_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_type TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  state TEXT NOT NULL,
  phase TEXT NOT NULL,
  root_command_id TEXT NOT NULL,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, workflow_id),
  FOREIGN KEY (project_id) REFERENCES project_meta(project_id)
) STRICT;

CREATE TABLE outbox (
  project_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  event_position INTEGER NOT NULL CHECK (event_position > 0),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('pending','claimed','completed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claim_owner TEXT,
  claim_token INTEGER,
  claim_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, target_key),
  FOREIGN KEY (project_id) REFERENCES project_meta(project_id),
  FOREIGN KEY (event_position) REFERENCES events(global_position)
) STRICT;

CREATE TABLE maintenance_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  epoch INTEGER NOT NULL CHECK (epoch >= 0),
  mode TEXT NOT NULL CHECK (mode IN ('idle','quiescing')),
  owner_id TEXT,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
  lease_expires_at TEXT,
  requested_at TEXT
) STRICT;

CREATE TABLE executor_leases (
  project_id TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  binding_generation INTEGER NOT NULL CHECK (binding_generation > 0),
  context_fingerprint TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (project_id, executor_id),
  FOREIGN KEY (project_id) REFERENCES project_meta(project_id)
) STRICT;

CREATE TABLE maintenance_acknowledgements (
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  executor_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY (epoch, executor_id)
) STRICT;

CREATE TABLE maintenance_required_executors (
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  executor_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  required_at TEXT NOT NULL,
  PRIMARY KEY (epoch, executor_id)
) STRICT;
```

Add `BEFORE UPDATE` and `BEFORE DELETE` triggers for `schema_migrations`, `project_meta`, `events`, and `command_dedup`, with stable messages `SCHEMA_MIGRATIONS_IMMUTABLE`, `PROJECT_META_IMMUTABLE`, `EVENTS_IMMUTABLE`, and `COMMAND_DEDUP_IMMUTABLE`. Add an `events_identity_guard` `BEFORE INSERT` trigger that raises `EVENT_PROJECT_IDENTITY_MISMATCH` unless the event's project/vault/store IDs equal the singleton `project_meta`. Add non-empty/hash/range indexes used by append and integrity queries. This migration intentionally does not create evidence, session-authority, session-lease, or projection tables; `executor_leases` is operational writer coordination only.

- [ ] **Step 5: Implement explicit, crash-recoverable bootstrap**

```ts
export interface ProjectStoreBootstrapInput {
  projectRoot: string;
  vaultRoot: string;
  replicaDecision?: "initialize-local";
}

export interface ProjectStoreBootstrapResult {
  descriptor: ProjectDescriptorV1;
  manifest: StoreManifestV1;
  route: ProjectStoreRoute;
  createdDescriptor: boolean;
  createdStore: boolean;
  recoveredManifest: boolean;
}

export type ProjectStoreBootstrapFaultBoundary =
  | "after-temp-schema-before-identity"
  | "after-temp-complete-before-publish"
  | "after-database-publish-before-manifest";

export interface ProjectStoreBootstrapFaultInjector {
  hit(boundary: ProjectStoreBootstrapFaultBoundary): void;
}

export const NO_PROJECT_STORE_BOOTSTRAP_FAULTS: ProjectStoreBootstrapFaultInjector = { hit: () => undefined };

export interface ProjectStoreBootstrapService {
  initialize(input: ProjectStoreBootstrapInput): Promise<ProjectStoreBootstrapResult>;
}
```

The service is called only by an explicit warn-then-run adapter. Its state machine is exact: no descriptor means create-new; valid descriptor plus valid manifest/database means return initialized; valid descriptor plus no manifest/database means require `initialize-local`; valid descriptor plus matching valid database and no manifest means recover the manifest automatically; every published partial state with mismatched or corrupt identity fails closed.

Creation resolves Git/route, creates the store directory, runs the target-directory capability probe, and builds a uniquely named same-directory database such as `.events.sqlite.bootstrap-<uuid>.tmp`. Migration 1, exactly one `project_meta`, and the idle `maintenance_state` are completed and verified in that unpublished database. Invoke the optional bootstrap fault injector at the three named boundaries above so tests can prove both unpublished-crash and published-before-manifest recovery without timing sleeps. Then run `PRAGMA wal_checkpoint(TRUNCATE)`, close every statement/connection, verify the application ID, migration checksum, identity, foreign keys, and integrity, and publish the closed database to `events.sqlite` with the same no-overwrite `linkSync` pattern used by the descriptor. Unlink the temporary name only after successful publication. A crash before publication therefore exposes no authoritative database; a crash after publication exposes a complete database whose missing manifest is recoverable. Production construction always uses `NO_PROJECT_STORE_BOOTSTRAP_FAULTS`.

On publication `EEXIST`, remove only this contender's temporary link, open the winning `events.sqlite` read-only, and adopt it only if every descriptor/project/vault/schema invariant matches; otherwise fail closed. Random bootstrap temporary files are never considered stores or recovery candidates. Fsync the completed file and, where the platform supports directory handles, its containing directory before publishing the manifest. Recovery reads the existing `storeId`, never chooses a new one, and reports `recoveredManifest: true`.

- [ ] **Step 6: Implement persistent branch lineage operations**

```ts
export interface BranchLocator { branchRef: string | null; headCommit: string; detached: boolean }

export class BranchScopeRepository {
  inspect(connection: SqliteConnection, projectId: ProjectId, locator: BranchLocator): BranchScopeId | null;
  resolveOrCreate(connection: SqliteConnection, projectId: ProjectId, locator: BranchLocator, now: string): BranchScopeId;
  recordRename(connection: SqliteConnection, projectId: ProjectId, branchScopeId: BranchScopeId, newRef: string, now: string): void;
  retire(connection: SqliteConnection, projectId: ProjectId, branchScopeId: BranchScopeId, now: string): void;
}
```

Every mutating method requires the caller's existing transaction. Detached scopes are matched by creation commit. Named scopes match only active `current_ref`; a rename updates one known scope; retirement clears active reuse. No method hashes a branch name into the durable ID.

- [ ] **Step 7: Run focused tests**

Run:

```powershell
npm run typecheck
npm run test:build
node --test --test-reporter=spec dist-test/tests/migration-runner.test.js dist-test/tests/project-store-bootstrap.test.js
```

Expected: migration checksum/immutability and explicit bootstrap/recovery/identity/branch-lineage tests pass.

- [ ] **Step 8: Commit**

```powershell
git add src/orchestrator/storage/migration.ts src/orchestrator/storage/migration-runner.ts src/orchestrator/storage/migrations src/orchestrator/storage/project-store-bootstrap.service.ts src/orchestrator/storage/branch-scope.repository.ts tests/migration-runner.test.ts tests/project-store-bootstrap.test.ts
git commit -m "feat: initialize the immutable event schema"
```

---

### Task 8: Implement Atomic Multi-Event Append, Deduplication, and Fencing

**Files:**
- Create: `src/orchestrator/storage/maintenance-fence.ts`
- Create: `src/orchestrator/storage/event-store.ts`
- Create: `tests/maintenance-fence.test.ts`
- Create: `tests/event-store.test.ts`

**Interfaces:**
- Consumes: one identity-verified existing connection, `AppendCommand`, UUID/clock dependencies, and the current maintenance epoch.
- Produces: `EventStore.append(command): AppendResult`, exact dedup replay, `EVENT_CONFLICT`, `STREAM_TYPE_MISMATCH`, `IDEMPOTENCY_CONFLICT`, `MAINTENANCE_QUIESCING`, and fenced maintenance state transitions.

- [ ] **Step 1: Write failing event-store contract tests**

Create one real temporary store per test and assert:

```ts
const first = store.append({
  context,
  commandId: "33333333-3333-4333-8333-333333333333",
  idempotencyKey: "client-a:command-1",
  commandType: "RecordPair",
  correlationId: "correlation-1",
  agentId: "agent-primary",
  expectedStreamVersion: 0n,
  streamId: "stream-1",
  streamType: "test",
  events: [event("FirstRecorded", { ordinal: 1 }), event("SecondRecorded", { ordinal: 2 })],
  outbox: [{ targetKey: "test/stream-1/2", kind: "test-materialization", eventIndex: 1, payload: { streamId: "stream-1" } }],
  publicResponse: { accepted: true },
});

assert.deepEqual([first.firstGlobalPosition, first.lastGlobalPosition, first.finalStreamVersion], [1n, 2n, 2n]);
assert.equal(first.deduplicated, false);

const replay = store.append(theSameCommand);
assert.equal(replay.deduplicated, true);
assert.deepEqual({ ...replay, deduplicated: false }, first);

const rows = connection.prepare(`
  SELECT global_position, stream_version, command_event_index, previous_global_hash, event_hash
  FROM events ORDER BY global_position
`).all();
assert.deepEqual(rows.map((row) => row.command_event_index), [0n, 1n]);
assert.equal(rows[0].previous_global_hash, "0".repeat(64));
assert.equal(rows[1].previous_global_hash, rows[0].event_hash);
```

Add explicit tests for:

- same idempotency key plus changed command type, payload, expected version, or stream returns `IDEMPOTENCY_CONFLICT` and leaves counts unchanged;
- same `commandId` with another key returns `IDEMPOTENCY_CONFLICT`;
- appending to an existing stream with a different `streamType` returns `STREAM_TYPE_MISMATCH` before event insertion;
- expected version mismatch returns `EVENT_CONFLICT` with expected/actual decimal strings and no rows;
- injected duplicate event UUID fails the second insert and rolls back stream, events, command_dedup, and outbox as one unit;
- `events` and `command_dedup` reject update/delete;
- batch size `0` or `129`, local `visibilityScope: "global"`, non-empty `evidenceRefs`, non-empty `evidenceDigests`, malformed/empty/impossible `occurredAt` (including `2026-02-30T00:00:00Z` and `2026-01-01T24:00:00Z`), an invalid injected `recordedAt`, noncanonical payload, non-Git branch visibility, and session scope without `sessionId` fail before `BEGIN IMMEDIATE`;
- outbox `eventIndex` outside the event batch, duplicate/empty target keys, empty kind, or more than 128 outbox rows fail before `BEGIN IMMEDIATE`;
- a quiescing maintenance epoch rejects a new append but allows read-only replay of an already committed dedup row;
- a required executor whose lease later expires still blocks successful release until it acknowledges; abort release records no checkpoint/copy success, and a new epoch may exclude the stale lease;
- `commandEventIndex` and stream versions are contiguous for a 128-event boundary batch.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm run test:build
node --test --test-reporter=spec dist-test/tests/maintenance-fence.test.js dist-test/tests/event-store.test.js
```

Expected: compilation fails because event-store and maintenance-fence modules do not exist.

- [ ] **Step 3: Implement maintenance fencing**

```ts
export interface MaintenanceLease {
  epoch: bigint;
  fencingToken: bigint;
  ownerId: string;
  leaseExpiresAt: string;
}

export class MaintenanceFence {
  assertAppendAllowed(connection: SqliteConnection): void;
  registerExecutor(connection: SqliteConnection, projectId: ProjectId, executorId: string, bindingGeneration: number, contextFingerprint: string, leaseExpiresAt: string, now: string): void;
  renewExecutor(connection: SqliteConnection, projectId: ProjectId, executorId: string, leaseExpiresAt: string, now: string): void;
  closeExecutor(connection: SqliteConnection, projectId: ProjectId, executorId: string, now: string): void;
  acquire(connection: SqliteConnection, ownerId: string, leaseExpiresAt: string, now: string): MaintenanceLease;
  acknowledge(connection: SqliteConnection, lease: MaintenanceLease, executorId: string, now: string): void;
  allRequiredExecutorsAcknowledged(connection: SqliteConnection, lease: MaintenanceLease): boolean;
  release(connection: SqliteConnection, lease: MaintenanceLease, requireAllAcknowledged: boolean, now: string): void;
}
```

Every method runs inside the caller's `BEGIN IMMEDIATE` transaction. Executor registration fails while quiescing; renewal cannot change binding generation/fingerprint; close marks the lease closed. `acquire()` increments both epoch and fencing token only when idle or when the previous lease is expired, then snapshots every live unexpired executor into `maintenance_required_executors`. `acknowledge()` inserts one row keyed by epoch/executor and rejects a stale token or an executor outside that snapshot. A required executor's later lease expiry never counts as acknowledgement for the current epoch: missing acknowledgement aborts checkpoint/copy and the owner may only clear the fence as an explicit abort. A later maintenance attempt may acquire a new epoch after stale leases expire. Successful `release(..., true, ...)` requires every snapshotted executor acknowledgement plus matching owner/epoch/token; a stale owner can never clear a newer fence. `assertAppendAllowed()` reads the row in the same transaction as the append and throws `MAINTENANCE_QUIESCING` whenever mode is quiescing, regardless of process-local state.

- [ ] **Step 4: Define exact command validation and hash material**

Set:

```ts
export const MAX_EVENTS_PER_COMMAND = 128;
export const MAX_CANONICAL_COMMAND_BYTES = 4 * 1024 * 1024;
export const GENESIS_GLOBAL_HASH = "0".repeat(64);
```

The command hash includes `commandId`, `commandType`, bound `projectId`, `storeId`, `workspaceId`, current Git `headCommit`/`branchRef`/detached locator when present, `streamId`, `streamType`, decimal expected version, correlation ID, attributed agent ID, every semantic pending-event field in input order, and every pending outbox target/kind/event index/payload in input order. It excludes generated event IDs, generated `branchScopeId`, generated outbox content hashes, `recordedAt`, generated global positions, and `idempotencyKey`. Validate the UUID command ID, non-empty key/type/stream/correlation/agent, one-to-128 event/outbox counts, unique deterministic outbox target keys, valid event indexes, exact bound identity, and canonical byte limit before opening the transaction.

Until Subproject 4, evidence references/digests must be empty and `visibilityScope: "global"` is rejected. Until Subproject 2, session fields are stored as opaque attribution only; this task does not authorize lifecycle actions.

Define these support contracts in `event-store.ts` before the class:

```ts
export class EventStoreError extends Error {
  constructor(public readonly code: string, public readonly details: Record<string, JsonValue> = {}) {
    super(code);
    this.name = "EventStoreError";
  }
}

interface ValidatedAppendCommand {
  recordedAt: string;
  hashMaterial: JsonValue;
  canonicalBytes: number;
  eventIds: string[];
  payloadJson: string[];
  payloadHashes: string[];
}

interface DedupRow {
  commandId: string;
  commandHash: string;
  responseJson: string;
  responseHash: string;
}

interface GlobalTail { globalPosition: bigint; eventHash: string }
interface StreamHead { currentVersion: bigint; streamType: string }

interface StoredCommandResponse<TResponse extends JsonValue> {
  eventIds: string[];
  firstGlobalPosition: string;
  lastGlobalPosition: string;
  finalStreamVersion: string;
  response: TResponse;
}

interface EventStoreStatements {
  findDedup(projectId: string, idempotencyKey: string): DedupRow | undefined;
  findCommandId(projectId: string, commandId: string): { idempotencyKey: string } | undefined;
  readStream(projectId: string, streamId: string): StreamHead | undefined;
  insertStream(projectId: string, streamId: string, streamType: string, now: string): void;
  readGlobalTail(): GlobalTail;
  insertEvent(event: StoredEvent): void;
  compareAndSwapStream(projectId: string, streamId: string, expected: bigint, next: bigint, now: string): bigint;
  insertOutbox(projectId: string, pending: PendingOutbox, event: StoredEvent, contentHash: string, now: string): void;
  insertDedup<T extends JsonValue>(command: AppendCommand<T>, commandHash: string, response: StoredCommandResponse<T>, responseHash: string, now: string): void;
}

function buildStoredCommandResponse<T extends JsonValue>(publicResponse: T, events: StoredEvent[]): StoredCommandResponse<T> {
  return {
    eventIds: events.map((event) => event.eventId),
    firstGlobalPosition: events[0].globalPosition.toString(),
    lastGlobalPosition: events.at(-1)!.globalPosition.toString(),
    finalStreamVersion: events.at(-1)!.streamVersion.toString(),
    response: publicResponse,
  };
}

function decodeStoredResponse<T extends JsonValue>(responseJson: string, expectedHash: string, deduplicated: boolean): AppendResult<T> {
  const parsed = JSON.parse(responseJson) as StoredCommandResponse<T>;
  if (canonicalJson(parsed) !== responseJson || responseHash(parsed) !== expectedHash) throw new EventStoreError("INTEGRITY_FAILURE");
  if (!Array.isArray(parsed.eventIds) || parsed.eventIds.some((id) => typeof id !== "string")) throw new EventStoreError("INTEGRITY_FAILURE");
  const decimal = /^(0|[1-9]\d*)$/;
  if (!decimal.test(parsed.firstGlobalPosition) || !decimal.test(parsed.lastGlobalPosition) || !decimal.test(parsed.finalStreamVersion)) {
    throw new EventStoreError("INTEGRITY_FAILURE");
  }
  return {
    deduplicated,
    firstGlobalPosition: BigInt(parsed.firstGlobalPosition),
    lastGlobalPosition: BigInt(parsed.lastGlobalPosition),
    finalStreamVersion: BigInt(parsed.finalStreamVersion),
    eventIds: parsed.eventIds,
    response: parsed.response,
    responseHash: expectedHash,
  };
}
```

`SqliteEventStoreStatements` prepares fixed SQL in its constructor. The exact mutations are: insert stream with version `0`; select stream version plus immutable stream type; select global tail descending limit one; insert every explicit event column; CAS-update stream with `WHERE project_id=$projectId AND stream_id=$streamId AND current_version=$expected`; insert outbox with its event position; insert the committed command row. No method accepts dynamic SQL or identifiers.

The pure validation/materialization functions are:

```ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

function assertCanonicalRfc3339(value: string, field: string): void {
  const match = RFC3339.exec(value);
  if (!match) throw new EventStoreError("TIMESTAMP_INVALID", { field });
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
  const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const valid = year >= 1
    && month >= 1 && month <= 12
    && day >= 1 && day <= (monthDays[month - 1] ?? 0)
    && hour >= 0 && hour <= 23
    && minute >= 0 && minute <= 59
    && second >= 0 && second <= 59
    && offsetHour >= 0 && offsetHour <= 23
    && offsetMinute >= 0 && offsetMinute <= 59;
  if (!valid) throw new EventStoreError("TIMESTAMP_INVALID", { field });
}

function validateAppendCommand<T extends JsonValue>(
  command: AppendCommand<T>,
  recordedAt: string,
  randomId: () => string,
): ValidatedAppendCommand {
  if (!UUID.test(command.commandId)) throw new EventStoreError("COMMAND_ID_INVALID");
  assertCanonicalRfc3339(recordedAt, "recordedAt");
  for (const [field, value] of Object.entries({
    idempotencyKey: command.idempotencyKey,
    commandType: command.commandType,
    correlationId: command.correlationId,
    agentId: command.agentId,
    streamId: command.streamId,
    streamType: command.streamType,
  })) {
    if (typeof value !== "string" || value.trim() === "") throw new EventStoreError("COMMAND_INVALID", { field });
  }
  if (command.events.length < 1 || command.events.length > MAX_EVENTS_PER_COMMAND) throw new EventStoreError("EVENT_BATCH_SIZE_INVALID");
  if (command.outbox.length > MAX_EVENTS_PER_COMMAND) throw new EventStoreError("OUTBOX_BATCH_SIZE_INVALID");
  const targetKeys = new Set<string>();
  const payloadJson: string[] = [];
  const payloadHashes: string[] = [];
  const eventIds: string[] = [];
  const normalizedEvents = command.events.map((event) => {
    if (!event.eventType.trim() || !Number.isSafeInteger(event.eventSchemaVersion) || event.eventSchemaVersion <= 0) throw new EventStoreError("EVENT_INVALID");
    assertCanonicalRfc3339(event.occurredAt, "occurredAt");
    if (event.visibilityScope === "global") throw new EventStoreError("GLOBAL_SCOPE_DENIED");
    if (event.visibilityScope === "branch" && command.context.workspace.kind !== "git") throw new EventStoreError("WORKSPACE_AMBIGUOUS");
    if (event.visibilityScope === "session" && !event.sessionId) throw new EventStoreError("SESSION_NOT_FOUND");
    if (event.evidenceRefs.length !== 0 || event.evidenceDigests.length !== 0) throw new EventStoreError("EVIDENCE_NOT_AVAILABLE_IN_SUBPROJECT_1");
    const json = canonicalJson(event.payload);
    payloadJson.push(json);
    payloadHashes.push(payloadHash(event.payload));
    const eventId = randomId();
    if (!UUID.test(eventId)) throw new EventStoreError("EVENT_ID_INVALID");
    eventIds.push(eventId);
    return {
      eventType: event.eventType,
      eventSchemaVersion: event.eventSchemaVersion,
      occurredAt: event.occurredAt,
      visibilityScope: event.visibilityScope,
      sessionId: event.sessionId ?? null,
      parentSessionId: event.parentSessionId ?? null,
      causationId: event.causationId ?? null,
      confidence: event.confidence,
      verificationStatus: event.verificationStatus,
      payload: event.payload,
      sourceRefs: event.sourceRefs,
      evidenceRefs: [],
      evidenceDigests: [],
    };
  });
  const normalizedOutbox = command.outbox.map((item) => {
    if (!item.targetKey.trim() || !item.kind.trim()) throw new EventStoreError("OUTBOX_INVALID");
    if (!Number.isSafeInteger(item.eventIndex) || item.eventIndex < 0 || item.eventIndex >= command.events.length) throw new EventStoreError("OUTBOX_EVENT_INDEX_INVALID");
    if (targetKeys.has(item.targetKey)) throw new EventStoreError("OUTBOX_TARGET_CONFLICT");
    targetKeys.add(item.targetKey);
    canonicalJson(item.payload);
    return item;
  });
  canonicalJson(command.publicResponse);
  const hashMaterial: JsonValue = {
    commandId: command.commandId,
    commandType: command.commandType,
    projectId: command.context.binding.projectId,
    storeId: command.context.binding.storeId,
    workspaceId: command.context.binding.workspaceId,
    git: command.context.workspace.kind === "git" ? {
      headCommit: command.context.workspace.headCommit,
      branchRef: command.context.workspace.branchRef,
      detached: command.context.workspace.detached,
    } : null,
    streamId: command.streamId,
    streamType: command.streamType,
    expectedStreamVersion: command.expectedStreamVersion.toString(),
    correlationId: command.correlationId,
    agentId: command.agentId,
    events: normalizedEvents,
    outbox: normalizedOutbox,
  };
  const canonicalBytes = Buffer.byteLength(canonicalJson(hashMaterial), "utf8");
  if (canonicalBytes > MAX_CANONICAL_COMMAND_BYTES) throw new EventStoreError("COMMAND_TOO_LARGE");
  return { recordedAt, hashMaterial, canonicalBytes, eventIds, payloadJson, payloadHashes };
}

function materializeEvents<T extends JsonValue>(
  command: AppendCommand<T>,
  validated: ValidatedAppendCommand,
  tail: GlobalTail,
  branchScopeId: BranchScopeId | undefined,
): StoredEvent[] {
  let previousGlobalHash = tail.eventHash;
  return command.events.map((pending, index) => {
    const storedWithoutHash = {
      globalPosition: tail.globalPosition + BigInt(index + 1),
      eventId: validated.eventIds[index],
      projectId: command.context.binding.projectId,
      vaultId: command.context.binding.vaultId,
      storeId: command.context.binding.storeId,
      workspaceId: command.context.binding.workspaceId,
      branchScopeId: branchScopeId ?? null,
      branchRef: command.context.workspace.kind === "git" ? command.context.workspace.branchRef : null,
      streamId: command.streamId,
      streamType: command.streamType,
      streamVersion: command.expectedStreamVersion + BigInt(index + 1),
      eventType: pending.eventType,
      eventSchemaVersion: pending.eventSchemaVersion,
      sessionId: pending.sessionId ?? null,
      parentSessionId: pending.parentSessionId ?? null,
      actorRole: command.context.binding.actorRole,
      agentId: command.agentId,
      clientInstanceId: command.context.binding.clientInstanceId,
      correlationId: command.correlationId,
      causationId: pending.causationId ?? null,
      commandId: command.commandId,
      idempotencyKey: command.idempotencyKey,
      commandEventIndex: index,
      occurredAt: pending.occurredAt,
      recordedAt: validated.recordedAt,
      visibilityScope: pending.visibilityScope as Exclude<VisibilityScope, "global">,
      confidence: pending.confidence,
      verificationStatus: pending.verificationStatus,
      sourceRefs: pending.sourceRefs,
      evidenceRefs: [] as [],
      evidenceDigests: [] as [],
      payload: pending.payload,
      payloadJson: validated.payloadJson[index],
      payloadHash: validated.payloadHashes[index],
      previousGlobalHash,
    };
    const hashMaterial = {
      ...storedWithoutHash,
      globalPosition: storedWithoutHash.globalPosition.toString(),
      streamVersion: storedWithoutHash.streamVersion.toString(),
      payload: undefined,
      payloadJson: undefined,
    };
    delete (hashMaterial as Record<string, unknown>).payload;
    delete (hashMaterial as Record<string, unknown>).payloadJson;
    const computedEventHash = eventHash(hashMaterial);
    previousGlobalHash = computedEventHash;
    return { ...storedWithoutHash, eventHash: computedEventHash };
  });
}

function normalizeEventStoreError(error: unknown): EventStoreError {
  if (error instanceof EventStoreError) return error;
  if (typeof error === "object" && error !== null && "errcode" in error && typeof error.errcode === "number" && (error.errcode & 0xff) === 5) {
    return new EventStoreError("SQLITE_BUSY", { retryable: true });
  }
  return new EventStoreError("STORE_UNAVAILABLE", { retryable: false });
}
```

- [ ] **Step 5: Implement the single-transaction append sequence**

Prepare all fixed statements once. The method sequence is exact:

```ts
export class EventStore {
  constructor(
    private readonly connection: SqliteConnection,
    private readonly statements: EventStoreStatements,
    private readonly maintenance: MaintenanceFence,
    private readonly branchScopes: BranchScopeRepository,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly randomId: () => string = randomUUID,
  ) {}

  append<TResponse extends JsonValue>(command: AppendCommand<TResponse>): AppendResult<TResponse> {
    const validated = validateAppendCommand(command, this.now(), this.randomId);
    const computedCommandHash = commandHash(validated.hashMaterial);
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.statements.findDedup(command.context.binding.projectId, command.idempotencyKey);
      if (prior) {
        if (prior.commandHash !== computedCommandHash || prior.commandId !== command.commandId) {
          throw new EventStoreError("IDEMPOTENCY_CONFLICT");
        }
        this.connection.exec("ROLLBACK");
        return decodeStoredResponse<TResponse>(prior.responseJson, prior.responseHash, true);
      }

      if (this.statements.findCommandId(command.context.binding.projectId, command.commandId)) {
        throw new EventStoreError("IDEMPOTENCY_CONFLICT");
      }
      this.maintenance.assertAppendAllowed(this.connection);
      const branchScopeId = command.context.workspace.kind === "git"
        ? this.branchScopes.resolveOrCreate(this.connection, command.context.binding.projectId, {
            branchRef: command.context.workspace.branchRef,
            headCommit: command.context.workspace.headCommit,
            detached: command.context.workspace.detached,
          }, validated.recordedAt)
        : undefined;
      let stream = this.statements.readStream(command.context.binding.projectId, command.streamId);
      if (stream === undefined) {
        this.statements.insertStream(command.context.binding.projectId, command.streamId, command.streamType, validated.recordedAt);
        stream = { currentVersion: 0n, streamType: command.streamType };
      } else if (stream.streamType !== command.streamType) {
        throw new EventStoreError("STREAM_TYPE_MISMATCH", {
          expected: stream.streamType,
          actual: command.streamType,
        });
      }
      const currentVersion = stream.currentVersion;
      if (currentVersion !== command.expectedStreamVersion) {
        throw new EventStoreError("EVENT_CONFLICT", {
          expected: command.expectedStreamVersion.toString(),
          actual: currentVersion.toString(),
        });
      }

      const tail = this.statements.readGlobalTail();
      const storedEvents = materializeEvents(command, validated, tail, branchScopeId);
      for (const storedEvent of storedEvents) this.statements.insertEvent(storedEvent);
      const nextVersion = currentVersion + BigInt(storedEvents.length);
      const changes = this.statements.compareAndSwapStream(command.context.binding.projectId, command.streamId, currentVersion, nextVersion, validated.recordedAt);
      if (changes !== 1n) throw new EventStoreError("EVENT_CONFLICT");
      for (const pendingOutbox of command.outbox) {
        this.statements.insertOutbox(
          command.context.binding.projectId,
          pendingOutbox,
          storedEvents[pendingOutbox.eventIndex],
          outboxHash(pendingOutbox.payload),
          validated.recordedAt,
        );
      }
      const storedResponse = buildStoredCommandResponse(command.publicResponse, storedEvents);
      const computedResponseHash = responseHash(storedResponse);
      this.statements.insertDedup(command, computedCommandHash, storedResponse, computedResponseHash, validated.recordedAt);
      this.connection.exec("COMMIT");
      return decodeStoredResponse<TResponse>(canonicalJson(storedResponse), computedResponseHash, false);
    } catch (error) {
      try { this.connection.exec("ROLLBACK"); } catch { /* transaction is already closed */ }
      throw normalizeEventStoreError(error);
    }
  }
}
```

`SqliteEventStoreStatements.readGlobalTail()` returns position `0n` plus `GENESIS_GLOBAL_HASH` when empty. Its outbox insert maps `eventIndex` to that event's global position and stores status `pending` with zero attempts. The command insert stores exactly one canonical response containing public response, event IDs, decimal first/last positions, and decimal final stream version.

Only a primary SQLite error code whose low byte is `5` is retryable busy. The direct store reports that typed condition; it does not sleep, retry unknown errors, or mint a new key. Worker retry policy is added in Task 11.

- [ ] **Step 6: Run focused tests**

Run:

```powershell
npm run typecheck
npm run test:build
node --test --test-reporter=spec dist-test/tests/maintenance-fence.test.js dist-test/tests/event-store.test.js
```

Expected: atomicity, multi-event order, dedup replay/conflict, CAS, immutability, validation, hash-chain, and fencing tests pass.

- [ ] **Step 7: Commit**

```powershell
git add src/orchestrator/storage/maintenance-fence.ts src/orchestrator/storage/event-store.ts tests/maintenance-fence.test.ts tests/event-store.test.ts
git commit -m "feat: append idempotent immutable event batches"
```

---

### Task 9: Enforce Transport-Private Project Binding and Revalidation

**Files:**
- Create: `src/orchestrator/identity/project-binding.service.ts`
- Create: `src/orchestrator/diagnostics/project-status.service.ts`
- Create: `tests/project-binding.service.test.ts`

**Interfaces:**
- Consumes: `TrustedProjectBindingRequest`, canonical paths, descriptor, Git snapshot, store route/manifest, and worker-verified existing-store identity.
- Produces: `ProjectBindingService.establish(config)`, `revalidate(binding)`, `ProjectBindingProvider`, typed fail-closed resolutions, and safe `ProjectStatus` diagnostics.

- [ ] **Step 1: Write failing binding tests**

Test the full establishment/revalidation matrix:

```ts
const resolution = await service.establish({
  source: "explicit-cli",
  projectRoot,
  vaultRoot,
  clientNamespace: "codex",
  clientInstanceId: "client-1",
  actorRole: "primary",
  generation: 1,
});
assert.equal(resolution.ok, true);
if (!resolution.ok) assert.fail(resolution.message);
assert.equal(resolution.binding.projectId, descriptor.projectId);
assert.equal(resolution.binding.storeId, manifest.storeId);
assert.equal(resolution.binding.workspace.workspaceId, resolution.binding.workspaceId);
```

Also prove:

- absent or `dynamic` explicit root is `PROJECT_ROOT_NOT_EXPLICIT` before descriptor/Git/store calls;
- missing/invalid descriptor returns the matching typed code and creates nothing;
- missing manifest plus missing database is `PROJECT_REPLICA_DECISION_REQUIRED`; missing manifest plus matching valid database is nonmutating `STORE_MANIFEST_RECOVERY_REQUIRED` with explicit CLI remediation;
- descriptor/manifest/project_meta mismatch returned by the one-shot identity-probe worker is `PROJECT_ID_MISMATCH`, `VAULT_ID_MISMATCH`, or `STORE_ID_MISMATCH` before content service construction;
- a self-consistent heuristic candidate for another project is visible only in diagnostics and cannot replace the explicit binding;
- linked worktrees share store identity and have distinct stable workspace IDs derived from per-worktree Git administrative identity, not movable checkout paths;
- Git missing, timeout, permission, dubious-ownership, malformed-output, or unexpected command failure returns `GIT_PROBE_FAILED`; only Git's verified not-a-repository result creates a non-Git snapshot;
- descriptor, manifest, branch ref, Git common dir, or binding generation change makes `revalidate()` fail instead of following focus;
- no `ProjectBinding` or context fingerprint appears in model-controlled Zod inputs.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:build && node --test --test-reporter=spec dist-test/tests/project-binding.service.test.js`

Expected: compilation fails because binding and status services do not exist.

- [ ] **Step 3: Implement the private context fingerprint**

Use the `ProjectBinding` and `ProjectContext` contracts created in Task 3. Add one pure helper to the binding service:

```ts
export function computeProjectContextFingerprint(binding: Omit<ProjectBinding, "contextFingerprint" | "projectBindingId" | "establishedAt">): string {
  const material = {
    generation: binding.generation,
    projectId: binding.projectId,
    vaultId: binding.vaultId,
    storeId: binding.storeId,
    workspaceId: binding.workspaceId,
    projectRoot: binding.projectRoot,
    vaultRoot: binding.vaultRoot,
    eventsPath: binding.storeRoute.eventsPath,
    clientNamespace: binding.clientNamespace,
    clientInstanceId: binding.clientInstanceId,
    actorRole: binding.actorRole,
  };
  return createHash("sha256")
    .update(`project-memory/project-context/v1\n${canonicalJson(material)}`, "utf8")
    .digest("hex");
}
```

The fingerprint contains no secret capability and is recomputed, not trusted from input, during every revalidation.

- [ ] **Step 4: Implement fail-closed establishment and revalidation**

```ts
export type ProjectBindingFailureCode =
  | "PROJECT_BINDING_REQUIRED"
  | "PROJECT_ROOT_NOT_EXPLICIT"
  | "PROJECT_ROOT_MISSING"
  | "VAULT_ROOT_MISSING"
  | "PROJECT_DESCRIPTOR_MISSING"
  | "PROJECT_DESCRIPTOR_INVALID"
  | "PROJECT_REPLICA_DECISION_REQUIRED"
  | "STORE_MANIFEST_RECOVERY_REQUIRED"
  | "PROJECT_ID_MISMATCH"
  | "VAULT_ID_MISMATCH"
  | "STORE_ID_MISMATCH"
  | "WORKSPACE_AMBIGUOUS"
  | "GIT_PROBE_FAILED"
  | "STORE_ROUTE_INVALID"
  | "STORE_UNAVAILABLE";

export type ProjectBindingResolution =
  | { ok: true; binding: ProjectBinding }
  | { ok: false; code: ProjectBindingFailureCode; message: string; details: Record<string, unknown>; remediation: string[] };

export interface ProjectBindingProvider {
  current(): ProjectBinding | null;
  require(): ProjectBinding;
}

export interface ProjectStoreIdentityProbe {
  verify(route: ProjectStoreRoute, expected: { projectId: ProjectId; vaultId: VaultId; storeId: StoreId }): Promise<void>;
}

export class ProjectBindingService {
  establish(request: TrustedProjectBindingRequest): Promise<ProjectBindingResolution>;
  revalidate(binding: ProjectBinding): Promise<ProjectContext>;
}
```

Establishment order is fixed: validate explicit config; canonicalize roots; inspect descriptor; resolve Git; route; inspect manifest; invoke the injected one-shot `ProjectStoreIdentityProbe`; verify `application_id`, migration checksum, and `project_meta` inside that worker; close the worker connection; construct binding. No SQLite connection opens before route and manifest validation, and no production connection is created on the MCP event-loop thread. Revalidation repeats canonical roots, descriptor, Git, route, manifest, IDs, worker-owned identity probe, and fingerprint before returning context.

For Git workspace identity, hash `projectId` plus the canonical per-worktree `gitDir`; a linked worktree move does not change its administrative directory under the Git common directory. For non-Git, hash `projectId` plus `vaultId`. Do not hash the mutable branch name or checkout path. A move of the entire Git common directory requires explicit rebind and is reported rather than silently attached.

- [ ] **Step 5: Implement safe project status**

`ProjectStatusService` returns mode, `disabled | bound | blocked | not-ready`, `contentAuthorized`, safe project/vault/store/workspace/branch summaries, runtime capability summary, typed failure/remediation, and labeled heuristic candidates. It omits `projectBindingId`, context fingerprint, capability tokens, environment values, and unselected candidate content.

- [ ] **Step 6: Run focused tests**

Run:

```powershell
npm run typecheck
npm run test:build
node --test --test-reporter=spec dist-test/tests/project-binding.service.test.js
```

Expected: explicit binding, worktree, heuristic rejection, mismatch, replica-decision, Git-failure, and revalidation tests pass.

- [ ] **Step 7: Commit**

```powershell
git add src/orchestrator/identity/contracts.ts src/orchestrator/identity/project-binding.service.ts src/orchestrator/diagnostics/project-status.service.ts tests/project-binding.service.test.ts
git commit -m "feat: enforce private project binding"
```

---

### Task 10: Verify Authoritative Store Integrity Without Projections

**Files:**
- Create: `src/orchestrator/integrity/integrity.types.ts`
- Create: `src/orchestrator/integrity/event-integrity.service.ts`
- Create: `tests/event-integrity.test.ts`

**Interfaces:**
- Consumes: revalidated `ProjectContext`, existing connection, migration definitions, hash functions, and optional tail limit.
- Produces: `quickCheck(context, tailLimit)`, `fullCheck(context)`, `verifyRange(context, first, last)`, and structured `IntegrityReport`.

- [ ] **Step 1: Write failing integrity tests**

Tests must create a valid store with multiple streams and commands, then assert:

```ts
const quick = integrity.quickCheck(context, 256);
assert.equal(quick.ok, true);
assert.equal(quick.mode, "quick");
assert.equal(quick.lastGlobalPosition, "4");

const full = integrity.fullCheck(context);
assert.equal(full.ok, true);
assert.equal(full.mode, "full");
assert.equal(full.eventsVerified, 4);
```

Use disposable copies to prove each independent failure is detected:

- wrong descriptor/manifest/project_meta identity;
- `PRAGMA quick_check` or foreign-key failure;
- changed migration checksum or missing immutable trigger;
- stream head not equal to maximum stream version;
- stream metadata type not equal to every event type recorded for that stream;
- command range containing another command or missing an event;
- response JSON not matching response hash;
- noncontiguous global position or stream version;
- payload JSON not matching payload hash;
- broken previous hash or event hash;
- orphan command/event row.

For tamper simulation, explicitly drop an event immutability trigger in a disposable database, update one payload/hash field, and assert both schema fingerprint and chain verification fail. Restore no test database in place; delete the entire test root only after closing all handles.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:build && node --test --test-reporter=spec dist-test/tests/event-integrity.test.js`

Expected: compilation fails because integrity modules do not exist.

- [ ] **Step 3: Define the integrity report**

```ts
export interface IntegrityIssue {
  code: string;
  message: string;
  globalPosition?: string;
  streamId?: string;
  commandId?: string;
}

export interface IntegrityReport {
  ok: boolean;
  mode: "quick" | "full" | "range";
  projectId: string;
  storeId: string;
  firstGlobalPosition: string;
  lastGlobalPosition: string;
  eventsVerified: number;
  streamsVerified: number;
  commandsVerified: number;
  schemaFingerprint: string;
  terminalEventHash: string;
  issues: IntegrityIssue[];
}
```

- [ ] **Step 4: Implement consistent-snapshot quick and full checks**

Every check begins a deferred read transaction and commits or rolls back before returning. `quickCheck()` runs `PRAGMA quick_check`, `PRAGMA foreign_key_check`, identity equality, application ID, required migration checksums, required table/index/trigger schema fingerprint, stream-head version/type parity, command range/response-hash checks, and a bounded event-tail chain. `fullCheck()` additionally runs `PRAGMA integrity_check`, iterates every event with bigint reads from genesis, recomputes canonical payload/event hashes, checks non-empty RFC3339 occurred/recorded timestamps, contiguous global and per-stream versions, verifies every stream head and type, and proves every command range contains exactly its indexed command events in zero-based order.

`verifyRange()` begins with the trusted predecessor hash at `first - 1`, verifies through `last`, and reports range bounds. None of these methods reads a projection, Markdown file, embedding provider, or external service.

After the database read transaction closes, the caller records the completed report through `StoreManifestRepository.recordIntegrity()`. A manifest-recording failure is returned separately from database integrity and never changes the authoritative event result.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npm run typecheck
npm run test:build
node --test --test-reporter=spec dist-test/tests/event-integrity.test.js
```

Expected: valid quick/full/range checks pass and every isolated corruption fixture reports its exact issue code.

- [ ] **Step 6: Commit**

```powershell
git add src/orchestrator/integrity tests/event-integrity.test.ts
git commit -m "feat: verify authoritative event integrity"
```

---

### Task 11: Isolate SQLite in a Bounded Worker Executor

**Files:**
- Create: `src/orchestrator/runtime/worker-protocol.ts`
- Create: `src/orchestrator/runtime/project-store-identity-probe.ts`
- Create: `src/orchestrator/runtime/project-store-executor.ts`
- Create: `src/workers/project-store.worker.ts`
- Create: `scripts/smoke-worker.js`
- Create: `tests/project-store-executor.test.ts`
- Modify: `scripts/build.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: revalidated binding, canonical existing `eventsPath`, `storeId`, binding generation/fingerprint, and JSON-safe commands.
- Produces: `ProjectStoreExecutor.open/append/quickIntegrity/fullIntegrity/close`, a built `dist/workers/project-store.worker.js`, bounded queue errors, and outcome-unknown mutation failures.

- [ ] **Step 1: Write failing protocol and executor tests**

Use the compiled worker URL injected by the test and assert:

- `ping` works before a store opens and reports observed Node/SQLite versions;
- `open` creates the `DatabaseSync` and prepared statements inside the worker, verifies existing identity, and returns the expected store/fingerprint;
- append round-trips bigint values as decimal strings and returns the same replay response after a lost-response simulation;
- an idle executor renews through the injected heartbeat, observes a foreign maintenance epoch without a parent request, drains/acknowledges/closes, and cannot be counted as quiesced before close confirmation;
- every request repeats `storeId`, binding generation, and context fingerprint; mismatch poisons and closes the worker with `PROJECT_ID_MISMATCH`, `STORE_ID_MISMATCH`, or `PROJECT_BINDING_REQUIRED` with stale-generation details;
- pending count `129` with limit `128` returns `STORE_QUEUE_FULL` without posting the rejected message;
- `messageerror`, worker `error`, abnormal exit, and explicit timeout reject every pending request;
- read timeout is `WORKER_TIMEOUT`; mutation timeout/death is `COMMAND_OUTCOME_UNKNOWN` and includes only the original command ID/idempotency key as recovery data;
- graceful close waits for pending reads, closes SQLite in the worker, receives acknowledgement, and only then terminates; bounded forced termination is used after close deadline;
- after close on Windows, the test can rename and delete the SQLite file, proving no handle remains open.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:build && node --test --test-reporter=spec dist-test/tests/project-store-executor.test.js`

Expected: compilation fails because worker protocol, executor, and worker entry do not exist.

- [ ] **Step 3: Define a JSON-safe discriminated worker protocol**

```ts
export interface ProjectStoreRouteWire {
  kind: "git-common" | "vault-local";
  storeRoot: string;
  eventsPath: string;
  storeManifestPath: string;
  projectionManifestPath: string;
}

export interface StoreIdentityWire {
  projectId: string;
  vaultId: string;
  storeId: string;
}

export type WorkspaceSnapshotWire =
  | {
      kind: "git";
      worktreeRoot: string;
      gitDir: string;
      gitCommonDir: string;
      headCommit: string;
      branchRef: string | null;
      detached: boolean;
      workspaceId: string;
    }
  | {
      kind: "non-git";
      workspaceRoot: string;
      workspaceId: string;
    };

export interface WorkerBinding extends StoreIdentityWire, WorkerBindingAssertion {
  projectBindingId: string;
  source: "stdio-explicit-root" | "mcp-roots" | "trusted-ide-adapter" | "explicit-cli";
  projectRoot: string;
  vaultRoot: string;
  descriptorPath: string;
  storeRoute: ProjectStoreRouteWire;
  workspaceId: string;
  workspace: WorkspaceSnapshotWire;
  clientNamespace: string;
  clientInstanceId: string;
  actorRole: "primary" | "maintenance" | "untrusted";
  establishedAt: string;
  checkedAt: string;
}

export interface PendingEventWire {
  eventType: string;
  eventSchemaVersion: number;
  occurredAt: string;
  visibilityScope: "session" | "workspace" | "branch" | "project";
  sessionId: string | null;
  parentSessionId: string | null;
  causationId: string | null;
  confidence: "high" | "medium" | "low" | "guess";
  verificationStatus: "unverified" | "provisional" | "verified" | "conflicted";
  payload: JsonValue;
  sourceRefs: string[];
  evidenceRefs: [];
  evidenceDigests: [];
}

export interface PendingOutboxWire {
  targetKey: string;
  kind: string;
  eventIndex: number;
  payload: JsonValue;
}

export interface AppendCommandWire {
  commandId: string;
  idempotencyKey: string;
  commandType: string;
  correlationId: string;
  agentId: string;
  expectedStreamVersion: string;
  streamId: string;
  streamType: string;
  events: PendingEventWire[];
  outbox: PendingOutboxWire[];
  publicResponse: JsonValue;
}

export interface AppendResultWire {
  deduplicated: boolean;
  firstGlobalPosition: string;
  lastGlobalPosition: string;
  finalStreamVersion: string;
  eventIds: string[];
  response: JsonValue;
  responseHash: string;
}

export interface MaintenanceLeaseWire {
  epoch: string;
  fencingToken: string;
  ownerId: string;
  leaseExpiresAt: string;
}

export interface WorkerPingResult {
  nodeVersion: string;
  sqliteVersion: string;
  walSafe: boolean;
}

export interface WorkerOpenResult extends StoreIdentityWire, WorkerBindingAssertion {
  executorId: string;
}

export type WorkerRequest =
  | { id: string; type: "ping" }
  | { id: string; type: "verifyIdentity"; route: ProjectStoreRouteWire; expected: StoreIdentityWire }
  | { id: string; type: "open"; binding: WorkerBinding }
  | { id: string; type: "append"; binding: WorkerBindingAssertion; command: AppendCommandWire }
  | { id: string; type: "quickIntegrity"; binding: WorkerBindingAssertion; tailLimit: number }
  | { id: string; type: "fullIntegrity"; binding: WorkerBindingAssertion }
  | { id: string; type: "quiesce"; binding: WorkerBindingAssertion; lease: MaintenanceLeaseWire }
  | { id: string; type: "close" };

export interface WorkerBindingAssertion {
  storeId: string;
  bindingGeneration: number;
  contextFingerprint: string;
}

export type WorkerSuccessData =
  | WorkerPingResult
  | WorkerOpenResult
  | AppendResultWire
  | IntegrityReport
  | { verified: true }
  | { quiesced: true; epoch: string; connectionClosed: true }
  | { closed: true };

export type WorkerResponse =
  | { id: string; ok: true; data: WorkerSuccessData }
  | { id: string; ok: false; error: { code: string; message: string; details: Record<string, JsonValue> } };
```

Wire decoder functions convert only `/^(0|[1-9]\d*)$/` decimal strings to bigint, reject values above domain bounds where a number is required, reject missing/extra fields, and compare every binding assertion before touching SQLite. `WorkerBinding` is the lossless JSON form of the already revalidated `ProjectBinding` plus `checkedAt`: map `bindingGeneration` back to `generation`, `storeRoute` back to the complete route, and the discriminated workspace back without inventing a path or timestamp. The worker verifies `workspaceId === workspace.workspaceId`, `storeRoute.eventsPath` is the opened canonical path, and the supplied fingerprint matches the reconstructed binding before creating `ProjectContext`. `AppendCommandWire` cannot supply or override authority.

- [ ] **Step 4: Implement the executor lifecycle and queue**

```ts
export interface ProjectStoreExecutorOptions {
  workerUrl: URL;
  binding: ProjectBinding;
  maxPending: number;
  requestTimeoutMs: number;
  closeTimeoutMs: number;
  executorLeaseMs: number;
  heartbeatIntervalMs: number;
}

export interface ProjectStoreExecutor {
  open(): Promise<WorkerOpenResult>;
  append<T extends JsonValue>(command: AppendCommand<T>): Promise<AppendResult<T>>;
  quickIntegrity(tailLimit?: number): Promise<IntegrityReport>;
  fullIntegrity(): Promise<IntegrityReport>;
  quiesce(lease: MaintenanceLease): Promise<void>;
  close(): Promise<void>;
}

export const DEFAULT_MAX_PENDING = 128;
export const DEFAULT_EXECUTOR_LEASE_MS = 15000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
```

Construct `new Worker(options.workerUrl, { workerData: minimalNonsecretConfig })` without a browser-style `type` option. `WorkerProjectStoreIdentityProbe` starts a one-shot worker, sends `verifyIdentity`, and requires the read-only connection to close before resolving. Key executor reuse by canonical `eventsPath`, `storeId`, binding generation, and context fingerprint—not `projectId` alone. Reject queue overflow before allocating a timer. Handle `message`, `messageerror`, `error`, and `exit`; any protocol corruption poisons the executor. On rebind, poison and close the old generation before returning a replacement.

Use production defaults `executorLeaseMs=15000` and `heartbeatIntervalMs=5000`. After `open()` registers the lease, a worker-owned periodic heartbeat runs even when the request queue is idle. Each tick performs one short transaction: renew while maintenance is idle; when quiescing, stop new mutations, drain the already accepted queue, acknowledge the exact epoch/token, close SQLite, and notify the parent. Tests inject a manual heartbeat scheduler instead of sleeping. `quiesce()` triggers the same path immediately. The parent does not report quiesced until acknowledgement and connection-close confirmation both arrive; explicit reopen is allowed only after a newer idle-state check.

If an append request times out or the worker exits after posting it, reject with `COMMAND_OUTCOME_UNKNOWN`; recovery explicitly retries the same command ID and idempotency key through a newly revalidated executor. Never synthesize a key or automatically issue a semantically new command.

- [ ] **Step 5: Implement the worker-owned store**

The worker holds no SQLite object before `verifyIdentity` or `open`. `verifyIdentity` dynamically loads `node:sqlite`, opens read-only, verifies application/project/vault/store identity and migration checksums, closes, and exits without mutation. `open` repeats the runtime capability/version gate in a disposable probe, opens the existing path, verifies identity again, then creates `EventStore` and `EventIntegrityService`. Every later request validates binding assertion before dispatch.

For primary SQLite busy errors only (`errcode & 0xff === 5`), retry the exact append request with bounded jitter while total elapsed time remains below the configured deadline and the original key is unchanged. Do not retry constraint, corruption, identity, schema, hash, or unknown errors. `close` releases statements/connections and acknowledges before `parentPort.close()`.

- [ ] **Step 6: Emit and smoke-test the worker build artifact**

Modify `scripts/build.js` to emit three explicit bundles. The worker build is:

```js
await esbuild.build({
  entryPoints: ["src/workers/project-store.worker.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: path.join(outDir, "workers", "project-store.worker.js"),
  target: "node22",
  minify: true,
  packages: "external",
});
```

Set server and CLI targets to `node22`. Keep the worker out of the obfuscation pass so stack traces and protocol failures remain diagnosable. `scripts/smoke-worker.js` spawns the built URL, sends `ping`, asserts a safe SQLite version, sends `close`, and exits nonzero on error, timeout, or abnormal exit without starting MCP stdio. Add `"test:build-artifacts": "npm run build && node scripts/smoke-worker.js"` to `package.json` in this task.

- [ ] **Step 7: Run focused and artifact tests**

Run:

```powershell
npm run typecheck
npm run test:build
node --test --test-reporter=spec dist-test/tests/project-store-executor.test.js
npm run test:build-artifacts
node --check dist/workers/project-store.worker.js
```

Expected: executor lifecycle tests pass, built worker answers ping/close, and all SQLite handles are released.

- [ ] **Step 8: Commit**

```powershell
git add src/orchestrator/runtime/worker-protocol.ts src/orchestrator/runtime/project-store-identity-probe.ts src/orchestrator/runtime/project-store-executor.ts src/workers/project-store.worker.ts scripts/build.js scripts/smoke-worker.js tests/project-store-executor.test.ts package.json
git commit -m "feat: isolate project stores in workers"
```

---

### Task 12: Add Explicit V2 Administration Without Touching the V1 MCP Runtime

**Files:**
- Create: `src/cli/parse-args.ts`
- Create: `src/cli/run-command.ts`
- Create: `tests/cli.orchestrator-admin.test.ts`
- Modify: `src/cli.ts`

**Interfaces:**
- Consumes: explicit CLI roots, runtime probe, bootstrap service, binding service, identity-probe worker, executor, and integrity service.
- Produces: `orchestrator-init`, `orchestrator-status`, and `orchestrator-integrity` CLI commands while leaving `src/app.ts`, `src/index.ts`, every MCP controller/schema, lifecycle, and V1 output untouched.

- [ ] **Step 1: Write failing CLI administration tests**

Tests invoke `runCliCommand()` with in-memory stdout/stderr writers and injected fakes. Assert:

- all three commands require literal `--project-root` and `--vault` and reject `dynamic`/`auto`;
- `orchestrator-init` without `--apply` performs descriptor/Git/route/manifest inspection only and creates no path;
- `orchestrator-init --apply` creates a new descriptor/store, while descriptor plus no database requires `--replica initialize-local`;
- matching database plus missing manifest automatically recovers that manifest with the database's existing `storeId`;
- `orchestrator-status` establishes a trusted explicit CLI binding, verifies runtime/store identity in a one-shot worker, and prints only safe IDs/paths/capabilities;
- `orchestrator-integrity` opens a bound executor, runs quick or `--full` integrity, closes every handle, and never appends an event;
- repeated init is idempotent, mismatched identity fails closed, and unknown replica values are rejected;
- every existing non-help CLI command, option default, stdout/stderr string, and exit code remains unchanged; the sole intentional legacy-output delta is an appended V2 section in `help`, while every pre-existing help line remains byte-identical and in the same order;
- importing `src/app.ts` or running the MCP bundle performs no V2 action because those files are unchanged.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:build && node --test --test-reporter=spec dist-test/tests/cli.orchestrator-admin.test.js`

Expected: compilation fails because split CLI modules and V2 administration commands do not exist.

- [ ] **Step 3: Split the existing parser without changing legacy fields**

Move the current `Command`, `CliOptions`, `HELP`, and argument loop from `src/cli.ts` into `src/cli/parse-args.ts` byte-for-byte, then extend them with these exact fields/cases. Preserve the old help text as an unchanged prefix and append one separately tested V2 section:

```ts
export type Command =
  | "validate" | "report" | "fix" | "migrate" | "init" | "diagnose"
  | "orchestrator-init" | "orchestrator-status" | "orchestrator-integrity" | "help";

export interface CliOptions {
  command: Command;
  dryRun: boolean;
  backup: boolean;
  unsafe: boolean;
  confirm: boolean;
  rollback: boolean;
  format: "text" | "json" | "markdown";
  vault?: string;
  projectRoot?: string;
  replicaDecision?: "initialize-local";
  fullIntegrity: boolean;
  paths: string[];
}
```

Recognize `--project-root <path>`, `--replica initialize-local`, and `--full`. Keep `--apply` mapped to `dryRun=false`; reject a missing option value and an unknown replica value with exit code `2`. Add help text for:

```text
orchestrator-init       Inspect or explicitly initialize V2 identity/store (--apply writes)
orchestrator-status     Verify and print one explicitly bound V2 project/store
orchestrator-integrity  Run quick integrity, or full integrity with --full
```

- [ ] **Step 4: Implement typed administration dependencies and safe results**

```ts
export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface OrchestratorAdminDependencies {
  runtimeProbe(): Promise<RuntimeCapabilityResult>;
  inspectInitialization(projectRoot: string, vaultRoot: string): Promise<ProjectInitializationInspection>;
  bootstrap: ProjectStoreBootstrapService;
  bindingService: ProjectBindingService;
  executorFactory(binding: ProjectBinding): ProjectStoreExecutor;
  clientInstanceId(): string;
}

export interface ProjectInitializationSummary {
  projectRoot: string;
  vaultRoot: string;
  routeState: "pending-project-identity" | "resolved";
  storeRoot?: string;
  eventsPath?: string;
  projectId?: string;
  vaultId?: string;
  storeId?: string;
}

export type PendingProjectInitializationSummary = ProjectInitializationSummary & {
  routeState: "pending-project-identity";
  storeRoot?: never;
  eventsPath?: never;
  projectId?: never;
  vaultId?: never;
  storeId?: never;
};

export type RoutedProjectInitializationSummary = ProjectInitializationSummary & {
  routeState: "resolved";
  storeRoot: string;
  eventsPath: string;
  projectId: string;
  vaultId: string;
  storeId?: string;
};

export type InitializedProjectSummary = RoutedProjectInitializationSummary & { storeId: string };

export type ProjectInitializationInspection =
  | { state: "new-project"; summary: PendingProjectInitializationSummary; remediation: ["rerun with --apply"] }
  | { state: "replica-decision-required"; summary: RoutedProjectInitializationSummary; remediation: ["rerun with --replica initialize-local --apply"] }
  | { state: "recoverable-manifest"; summary: InitializedProjectSummary; remediation: ["rerun with --apply"] }
  | { state: "initialized"; summary: InitializedProjectSummary; remediation: [] }
  | { state: "blocked"; code: string; message: string; summary: ProjectInitializationSummary; remediation: string[] };

export type OrchestratorAdminResult =
  | { action: "init-inspection"; inspection: ProjectInitializationInspection }
  | { action: "initialized"; result: ProjectStoreBootstrapResult }
  | { action: "status"; projectId: string; vaultId: string; storeId: string; workspaceId: string; eventsPath: string; runtime: RuntimeCapabilityReport }
  | { action: "integrity"; report: IntegrityReport };
```

`ProjectInitializationInspection` performs no directory, descriptor, manifest, database, or event creation. A missing descriptor returns `routeState: "pending-project-identity"` and no guessed store path because Git routing contains the not-yet-created `projectId`; only explicit apply creates that identity and resolves the route.

- [ ] **Step 5: Implement the three V2 command branches**

`runCliCommand(options, io, dependencies)` first routes all legacy commands through the moved existing implementation. For a V2 command, validate required roots through `parseTrustedProjectBindingRequest` using source `explicit-cli`, namespace `memory-vault-cli`, a generated client instance, maintenance role for integrity and untrusted role for status. Run the disposable runtime probe before store access.

For init dry-run, print `inspectInitialization()`. For init apply, call `bootstrap.initialize({ projectRoot, vaultRoot, replicaDecision })`. For status, establish the binding and print only the safe status fields in `OrchestratorAdminResult`. For integrity, establish binding, construct/open the executor, call quick/full integrity, and close in `finally`. Map typed errors to compact JSON on stderr and exit code `1`; invalid CLI input uses exit code `2`. Never print binding IDs, fingerprints, environment values, worker data, or capability secrets.

- [ ] **Step 6: Keep the executable wrapper thin**

`src/cli.ts` imports `parseCliArgs`, `runCliCommand`, and the concrete dependency factory, then invokes them once. It retains the current top-level error handling and exit-code behavior. Do not import any V2 module from `src/app.ts` or `src/index.ts`; operational `off/shadow/primary`, MCP tool registration, shadow writes, and primary cutover remain Subproject 5 work.

- [ ] **Step 7: Run focused and full regression tests**

Run:

```powershell
npm run typecheck
npm run test:build
node --test --test-reporter=spec dist-test/tests/cli.orchestrator-admin.test.js
npm test
```

Expected: V2 admin tests pass and the complete pre-existing suite remains at or above 406 passing tests with no V1 MCP file change.

- [ ] **Step 8: Commit**

```powershell
git add src/cli/parse-args.ts src/cli/run-command.ts src/cli.ts tests/cli.orchestrator-admin.test.ts
git commit -m "feat: add explicit event-store administration"
```

---

### Task 13: Prove Cross-Process Isolation, Crash Recovery, and Release Gates

**Files:**
- Create: `tests/fixtures/project-store-child.ts`
- Create: `tests/fixtures/project-store-crash-child.ts`
- Create: `tests/event-store.concurrent.test.ts`
- Create: `tests/event-store.crash.test.ts`
- Create: `tests/event-store.stress.test.ts`
- Create: `scripts/run-stress.js`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/sqlite-stress.yml`
- Modify: `src/orchestrator/storage/event-store.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: built test fixtures, real temporary project stores, `child_process.fork`, IPC barriers, original idempotency keys, and integrity service.
- Produces: default contention/crash tests, full `16 × 250 × 10` release stress, Windows handle-release proof, and minimum/recommended-runtime CI.

- [ ] **Step 1: Write the real child-process fixture protocol**

Both fixtures use JSON IPC messages only:

```ts
type FixtureStartAction =
  | {
      kind: "initialize";
      request: TrustedProjectBindingRequest;
      replicaDecision?: "initialize-local";
    }
  | {
      kind: "open";
      route: ProjectStoreRouteWire;
      binding: WorkerBinding;
    };

type ParentMessage =
  | { type: "start"; action: FixtureStartAction }
  | { type: "append"; command: AppendCommandWire }
  | { type: "close" };

type ChildMessage =
  | { type: "ready"; childId: string }
  | {
      type: "started";
      childId: string;
      result:
        | { kind: "initialized"; route: ProjectStoreRouteWire; createdDescriptor: boolean; createdStore: boolean; recoveredManifest: boolean }
        | { kind: "opened"; identity: StoreIdentityWire; executorId: string };
    }
  | { type: "result"; commandId: string; result: AppendResultWire }
  | { type: "error"; commandId?: string; code: string; message: string }
  | { type: "closed"; childId: string };
```

The child touches neither the filesystem nor SQLite before receiving `start`. The parent waits until every child reports `ready`, broadcasts an explicit initialize or open action, and waits for every `started` or typed `error` response before sending appends. The concurrent first-initialization case sends the same initialize action to two ready children and asserts that one creates the descriptor/store while the other returns the same identity as already initialized; if the platform cannot serialize descriptor publication, the loser may return only the documented typed already-initialized result and must then succeed on a nonmutating identity probe. No correctness assertion uses `setTimeout` as a synchronization substitute. Timeouts exist only as bounded test cleanup. Cooperative `close` is primary cleanup, followed by `child.kill()` and awaited exit when a child is unresponsive.

The crash fixture accepts one boundary: `before-begin`, `after-first-insert-before-commit`, or `after-commit-before-response`. At the selected boundary it calls `process.exit(137)`. Add this narrow optional seam to `event-store.ts`:

```ts
export type EventStoreFaultBoundary =
  | "before-begin"
  | "after-first-insert-before-commit"
  | "after-commit-before-response";

export interface EventStoreFaultContext {
  projectId: string;
  commandId: string;
  idempotencyKey: string;
}

export interface EventStoreFaultInjector {
  hit(boundary: EventStoreFaultBoundary, context: EventStoreFaultContext): void;
}

export const NO_EVENT_STORE_FAULTS: EventStoreFaultInjector = { hit: () => undefined };
```

Inject `EventStoreFaultInjector` as the final constructor dependency with `NO_EVENT_STORE_FAULTS` as its default. Call `hit("before-begin", context)` immediately before `BEGIN IMMEDIATE`, call `hit("after-first-insert-before-commit", context)` immediately after inserting the first event row, and call `hit("after-commit-before-response", context)` immediately after `COMMIT` and before decoding the response. Only the crash fixture supplies a non-noop injector; the worker and all production composition use the default.

- [ ] **Step 2: Write the default concurrent isolation test**

Run four child processes against one store, each with a distinct stream and 25 sequential commands, while two more children write 25 commands to another project containing identical stream names/payloads. After every child closes, assert:

- Project P has exactly 100 events and Project Q exactly 50;
- no project/vault/store ID from Q appears in P and vice versa;
- global positions are contiguous, every per-stream version is contiguous, command effects are unique, and the full hash chain passes;
- linked-worktree bindings share only P's store; workspace identity remains distinct;
- two explicit first-initialization child processes converge on one descriptor/store/migration identity or one returns the typed already-initialized result; neither leaves a partial schema;
- `PRAGMA integrity_check` and `foreign_key_check` pass;
- both SQLite files can be renamed and renamed back after child shutdown.

- [ ] **Step 3: Write crash and lost-response tests**

For each boundary, retry the exact original command ID/idempotency key after process exit:

- before begin and pre-commit death leave no semantic effect before retry;
- post-commit/pre-response death leaves one committed effect, and retry returns the stored response without a second event;
- killing a worker from the parent returns `COMMAND_OUTCOME_UNKNOWN`, not success or an auto-generated retry;
- a maintenance owner crash cannot release a newer fencing token;
- after each recovery, quick and full integrity pass and every file handle closes.

- [ ] **Step 4: Write the serialized release stress test**

`tests/event-store.stress.test.ts` skips unless `MEMORY_EVENT_STRESS=1`. When enabled, for seeds `0` through `9`, start 16 processes with one distinct stream each and append 250 commands per process. After each seed assert exactly 4,000 committed events, 4,000 command rows, positions `1..4000`, stream versions `1..250`, no duplicate command effect, valid terminal hash, valid identities, successful integrity/foreign-key checks, and zero leftover worker/process handles.

`scripts/run-stress.js` first runs `npm run test:build`, then spawns the compiled stress test with `MEMORY_EVENT_STRESS=1`, `--test-concurrency=1`, and inherited stdio. Add `"test:stress": "node scripts/run-stress.js"` to `package.json` so the gate works identically on Windows and Unix.

- [ ] **Step 5: Run tests to verify failures before fixture implementation**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/event-store.concurrent.test.js dist-test/tests/event-store.crash.test.js
```

Expected: tests fail because child fixture executables and boundary hooks are not implemented.

- [ ] **Step 6: Implement fixtures and make default tests pass**

Run:

```powershell
npm run test:build
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/event-store.concurrent.test.js dist-test/tests/event-store.crash.test.js
```

Expected: all cross-process, isolation, crash, dedup recovery, fencing, and handle-release tests pass without timing sleeps.

- [ ] **Step 7: Add minimum/recommended CI and scheduled stress**

`.github/workflows/ci.yml` uses an Ubuntu/Windows matrix with Node `22.22.3` and `24.16.0`, then runs `npm ci`, `npm run check:runtime`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:build-artifacts`. Add an Ubuntu Node `22.13.0` negative job that succeeds only when `scripts/check-runtime.js` rejects that runtime.

`.github/workflows/sqlite-stress.yml` is serialized, supports schedule and manual dispatch, runs on both Windows and Ubuntu at Node `24.16.0`, and executes `npm ci`, the default concurrent/crash tests, then `npm run test:stress`. Upload test logs only; never upload event databases containing user memory.

- [ ] **Step 8: Run the release gates locally**

Run:

```powershell
npm ci
npm run check:runtime
npm run typecheck
npm test
npm run build
npm run test:build-artifacts
npm run test:stress
```

Expected: all commands exit `0`; stress completes ten seeds with exactly 4,000 events per seed and no integrity or isolation error.

- [ ] **Step 9: Commit**

```powershell
git add src/orchestrator/storage/event-store.ts tests/fixtures tests/event-store.concurrent.test.ts tests/event-store.crash.test.ts tests/event-store.stress.test.ts scripts/run-stress.js .github/workflows/ci.yml .github/workflows/sqlite-stress.yml package.json
git commit -m "test: prove event-store process safety"
```

---

## Final Verification and Subproject 1 Exit Review

- [ ] Run `git diff --check` and inspect the complete staged diff.
- [ ] Run `npm ci`, `npm run check:runtime`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:build-artifacts`, and `npm run test:stress`.
- [ ] Confirm the implementation diff does not modify `src/app.ts`, `src/index.ts`, MCP schemas/controllers, or any V1 service; the existing 406-test regression floor must therefore remain the executable compatibility gate for this subproject.
- [ ] Confirm two projects and linked worktrees cannot cross-route under real processes.
- [ ] Confirm committed retries return one semantic effect and pre-commit crashes return none.
- [ ] Confirm quick/full integrity, migration checksums, immutable triggers, maintenance fences, and Windows handle release pass.
- [ ] Confirm `src/services/memory-lifecycle.service.ts`, `src/services/memory-workflow.service.ts`, retrieval/projection code, evidence encryption, global memory, and primary cutover remain unchanged.
- [ ] Run the `superpowers:requesting-code-review` workflow against the implementation diff.
- [ ] Run `memory_verifyVault`, record exact verification in `memory_sessionEnd`, and do not enable primary mode.

Subproject 1 exits only when all gates above pass. The next independently reviewed plan is Subproject 2: root/child lifecycle and checkpoints.
