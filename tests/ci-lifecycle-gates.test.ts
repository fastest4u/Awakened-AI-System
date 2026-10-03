import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import test from "node:test";
import ts from "typescript";

const ROOT = new URL("../../", import.meta.url);

const MIGRATION_OUTPUT = "${{ runner.temp }}/v2-shadow-migration-functional/evidence.json";
const SHADOW_MIGRATION_TESTS = [
  "sqlite-driver", "v2-shadow-migration-contracts", "v2-shadow-migration-runtime", "v1-source-copy",
  "v2-migration-package", "v2-shadow-migration-repository", "v2-shadow-importer", "v2-imported-event-reader",
  "v2-shadow-projection", "v2-parity-lifecycle-fixture", "recording-git-command-runner", "v2-snapshot-parity",
  "retrieval-evaluation", "retrieval-service", "stable-compatibility-directory", "v2-shadow-compatibility",
  "v2-shadow-migration-runner", "v2-shadow-migration-rehearsal", "ci-lifecycle-gates",
];
const SHADOW_MIGRATION_SCRIPT = "npm run test:build && node --test --test-concurrency=1 --test-reporter=spec "
  + SHADOW_MIGRATION_TESTS.map(name => `dist-test/tests/${name}.test.js`).join(" ");

function assertMigrationScripts(scripts: Record<string, string>, producer: string): void {
  assert.equal(scripts["test:v2-shadow-migration"], SHADOW_MIGRATION_SCRIPT, "exact complete migration producer gate");
  assert.equal(scripts["rehearse:v2-shadow-migration"], "npm run build && node scripts/run-v2-shadow-migration-rehearsal.js");
  assert.equal(scripts["test:build-artifacts"], "npm run build && node scripts/smoke-worker.js && node scripts/smoke-v2-shadow-compatibility.js && node scripts/smoke-v2-fresh-start.js");
  // Identity/coverage only. Executing this production-backed case proves the
  // finalized content, immutable publication and redaction; YAML cannot do that.
  assert.match(producer, /^test\("retains synthetic functional evidence from the fresh compiled rehearsal command", async t => \{$/m);
}
const MIGRATION_GATE = [
  "      - name: Run V2 shadow migration gate",
  "        env:",
  `          V2_SHADOW_MIGRATION_TEST_EVIDENCE_OUTPUT: ${MIGRATION_OUTPUT}`,
  "        run: npm run test:v2-shadow-migration",
].join("\n");
const MIGRATION_UPLOAD = [
  "      - name: Upload V2 shadow migration functional synthetic evidence",
  "        uses: actions/upload-artifact@v7",
  "        with:",
  "          name: v2-shadow-migration-functional-synthetic-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}",
  `          path: ${MIGRATION_OUTPUT}`,
  "          if-no-files-found: error",
  "          retention-days: 14",
].join("\n");

function source(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8").replace(/\r\n?/g, "\n");
}

const BASE = "0e375d4643d4b630f36f874a3bb192e96739ac46";
const FROZEN_0002 = "68B4039048A359C523B7842F6D17BAA5760E9760D2B4E9F80BB8A48DC339EB06";
const FROZEN_0002_SQL = "85666a0bdee4455068f03a81e9d3720df172d15fce6d8e6f0cb3f5f7d0a81293";
const SCHEMA_TWO_PROVENANCE = "866bb0d22ac4225b8a06db9e528a9eaed847c02c";
const FOCUSED_TESTS = [
  "migration-runner", "session-lifecycle-migration", "qualified-checkpoint-migration",
  "project-store-upgrade", "project-store-executor", "lifecycle-contracts", "checkpoint.service",
  "evidence-coverage", "event-integrity", "lifecycle-worker-protocol", "lifecycle-executor",
  "session-end-policy", "session-end.coordinator", "validation-profile-runner", "lifecycle-recovery",
  "compatibility-log-renderer", "compatibility-log-materializer", "lifecycle-compatibility",
  "lifecycle.concurrent", "lifecycle.crash", "lifecycle.security",
  "session-end-effective-state-migration", "session-end-effective-state", "session-end-workflow",
  "session-end-child-saga", "session-end.crash", "lifecycle-validation-result.repository",
  "lifecycle-materialization-queue", "lifecycle-render-closure.reader", "lifecycle-faults",
  "lifecycle-fixture-protocol", "lifecycle-worker-runtime", "lifecycle.stress",
];

const PROTECTED_VERSION_ONE_PATHS = [
  "src/app.ts", "src/index.ts", "src/controllers", "src/schemas", "src/services",
] as const;

const EXTENDED_PRODUCTION_ENTRY_PATHS = [
  "src/app.ts", "src/index.ts", "src/cli.ts", "src/cli", "src/controllers", "src/schemas",
  "src/services", "src/workers", "src/orchestrator/runtime",
] as const;

const SEALED_EVALUATOR_BASE = "68e77fa10165c99243ded1e8c1c80d1e0f7da92f";
const APPROVED_SEALED_AND_ROLLOUT_SOURCE_DIFF = Object.freeze([
  "src/orchestrator/contracts/event.ts",
  "src/orchestrator/fresh-start/contracts.ts",
  "src/orchestrator/fresh-start/fresh-start-admission.ts",
  "src/orchestrator/fresh-start/fresh-start-control-plane.ts",
  "src/orchestrator/fresh-start/fresh-start-initializer.ts",
  "src/orchestrator/fresh-start/fresh-start-paths.ts",
  "src/orchestrator/fresh-start/fresh-start.repository.ts",
  "src/orchestrator/fresh-start/operator-approval.ts",
  "src/orchestrator/identity/git-workspace.resolver.ts",
  "src/orchestrator/integrity/event-integrity.service.ts",
  "src/orchestrator/integrity/lifecycle-integrity.service.ts",
  "src/orchestrator/integrity/stored-event-authenticator.ts",
  "src/orchestrator/lifecycle/lifecycle-command.processor.ts",
  "src/orchestrator/lifecycle/lifecycle-command.store.ts",
  "src/orchestrator/lifecycle/lifecycle-operational.store.ts",
  "src/orchestrator/lifecycle/lifecycle-query.service.ts",
  "src/orchestrator/materialization/stable-compatibility-directory.ts",
  "src/orchestrator/materialization/stable-compatibility-directory.worker.ts",
  "src/orchestrator/materialization/v2-shadow-compatibility.materializer.ts",
  "src/orchestrator/migration/v1-source-copy.ts",
  "src/orchestrator/migration/v2-imported-event-reader.ts",
  "src/orchestrator/migration/v2-migration-package.ts",
  "src/orchestrator/migration/v2-shadow-importer.ts",
  "src/orchestrator/migration/v2-shadow-migration-evidence.ts",
  "src/orchestrator/migration/v2-shadow-migration-rehearsal.ts",
  "src/orchestrator/migration/v2-shadow-migration-runner.ts",
  "src/orchestrator/migration/v2-shadow-migration-runtime.ts",
  "src/orchestrator/migration/v2-shadow-migration.contracts.ts",
  "src/orchestrator/migration/v2-shadow-projection.ts",
  "src/orchestrator/parity/v2-expected-difference.ts",
  "src/orchestrator/parity/v2-snapshot-parity.ts",
  "src/orchestrator/privacy/evidence-contracts.ts",
  "src/orchestrator/privacy/evidence-envelope.ts",
  "src/orchestrator/privacy/evidence-key-provider.ts",
  "src/orchestrator/privacy/redaction.ts",
  "src/orchestrator/privacy/retained-evidence-authority.ts",
  "src/orchestrator/privacy/retained-evidence-codec.ts",
  "src/orchestrator/privacy/retained-evidence-intent.ts",
  "src/orchestrator/privacy/retained-evidence-reader.ts",
  "src/orchestrator/privacy/retained-evidence-runtime.factory.ts",
  "src/orchestrator/privacy/retained-evidence-worker-protocol.ts",
  "src/orchestrator/privacy/retained-evidence.repository.ts",
  "src/orchestrator/privacy/retained-evidence.service.ts",
  "src/orchestrator/projections/builder.ts",
  "src/orchestrator/projections/checksum.ts",
  "src/orchestrator/projections/contracts.ts",
  "src/orchestrator/projections/event-reader.ts",
  "src/orchestrator/projections/folds.ts",
  "src/orchestrator/projections/image-metadata.ts",
  "src/orchestrator/projections/immutable-image.ts",
  "src/orchestrator/projections/integrity.ts",
  "src/orchestrator/projections/manifest-codec.ts",
  "src/orchestrator/projections/manifest.ts",
  "src/orchestrator/projections/schema.ts",
  "src/orchestrator/projections/source-event-codec.ts",
  "src/orchestrator/projections/stable-directory-read-core.ts",
  "src/orchestrator/projections/v2-reader-lease.ts",
  "src/orchestrator/retrieval/candidates.ts",
  "src/orchestrator/retrieval/contracts.ts",
  "src/orchestrator/retrieval/database-core.ts",
  "src/orchestrator/retrieval/eligibility.ts",
  "src/orchestrator/retrieval/evaluation.ts",
  "src/orchestrator/retrieval/selection-core.ts",
  "src/orchestrator/retrieval/service.ts",
  "src/orchestrator/retrieval/v2-candidates.ts",
  "src/orchestrator/rollout/rollout-cohort.ts",
  "src/orchestrator/rollout/rollout-control-plane.ts",
  "src/orchestrator/runtime/project-store-executor.ts",
  "src/orchestrator/runtime/project-store-worker-backend.ts",
  "src/orchestrator/runtime/worker-protocol.ts",
  "src/orchestrator/storage/event-append-transaction.ts",
  "src/orchestrator/storage/event-chain-constants.ts",
  "src/orchestrator/storage/lifecycle-projection.repository.ts",
  "src/orchestrator/storage/migrations/0006-v2-rollout-control-plane.ts",
  "src/orchestrator/storage/migrations/0007-v2-shadow-migration.ts",
  "src/orchestrator/storage/migrations/0008-v2-fresh-start.ts",
  "src/orchestrator/storage/migrations/0009-retained-evidence.ts",
  "src/orchestrator/storage/migrations/registry.ts",
  "src/orchestrator/storage/node-sqlite-driver.ts",
  "src/orchestrator/storage/project-store-bootstrap.service.ts",
  "src/orchestrator/storage/rollout-control-plane.repository.ts",
  "src/orchestrator/storage/session-end.repository.ts",
  "src/orchestrator/storage/sqlite-driver.ts",
  "src/orchestrator/storage/v2-shadow-migration.repository.ts",
  "src/orchestrator/verified-read/admission.ts",
  "src/orchestrator/verified-read/child.ts",
  "src/orchestrator/verified-read/cleanup.ts",
  "src/orchestrator/verified-read/content-contracts.ts",
  "src/orchestrator/verified-read/content-protocol.ts",
  "src/orchestrator/verified-read/content-query.ts",
  "src/orchestrator/verified-read/content-result.ts",
  "src/orchestrator/verified-read/contracts.ts",
  "src/orchestrator/verified-read/ownership.ts",
  "src/orchestrator/verified-read/protocol.ts",
  "src/orchestrator/verified-read/supervisor.ts",
  "src/orchestrator/verified-read/wire-data.ts",
  "src/v2-admin.ts",
  "src/v2.ts",
  "src/v2/admin.ts",
  "src/v2/app.ts",
  "src/v2/build-identity.ts",
  "src/v2/composition.ts",
  "src/v2/config.ts",
  "src/v2/internal-verified-read-cleanup.entry.ts",
  "src/v2/internal-verified-read.entry.ts",
  "src/workers/project-store.worker.ts",
]);
const VALID_V2_AGGREGATE = Object.freeze({
  corpusVersion: "retrieval-evaluation-v2",
  queryCount: 504,
  failedQueryCount: 0,
  languageCounts: Object.freeze({ en: 162, th: 171, mixed: 171 }),
  criticalClassCounts: Object.freeze({
    identifiers: 56, "code-artifacts": 56, "session-continuity": 56, "follow-ups": 56,
    "stale-superseded-facts": 56, conflicts: 56, "cross-project-near-duplicates": 56,
    "semantic-paraphrases": 56, "temporal-boundaries": 56,
  }),
  crossProjectContamination: 0,
  recallAt10: 1, mrr: 1, ndcgAt10: 1, citationPrecision: 1, citationRecall: 1,
  staleActiveMemoryRate: 0, exactIdentifierPathRecall: 1, currentSessionCheckpointRecallAt10: 1,
  openFollowUpRecallAt10: 1, nextActionRecallAt10: 1, semanticParaphraseRecallAt10: 1,
  bitemporalAccuracy: 1, conflictRecall: 1, conflictPrecision: 1,
  unsupportedHighImpactVerifiedClaims: 0,
});

function typescriptFiles(directory: string): readonly string[] {
  const files: string[] = [];
  const visit = (relativeDirectory: string): void => {
    for (const entry of readdirSync(new URL(`${relativeDirectory}/`, ROOT), { withFileTypes: true })) {
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) visit(relativePath);
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(relativePath);
    }
  };
  visit(directory);
  return Object.freeze(files.sort());
}

const PRODUCTION_CONTROLLER_PATHS = typescriptFiles("src/controllers");
const PRODUCTION_ENTRY_SOURCE_PATHS = Object.freeze([
  "src/v2.ts", "src/v2-admin.ts", ...typescriptFiles("src/v2"),
  "src/app.ts",
  "src/index.ts",
  "src/cli.ts",
  ...typescriptFiles("src/cli"),
  ...PRODUCTION_CONTROLLER_PATHS,
  ...typescriptFiles("src/schemas"),
  ...typescriptFiles("src/services"),
  ...typescriptFiles("src/workers"),
  ...typescriptFiles("src/orchestrator/runtime"),
]);
const PROTECTED_VERSION_ONE_SOURCE_PATHS = Object.freeze([
  "src/app.ts",
  "src/index.ts",
  ...PRODUCTION_CONTROLLER_PATHS,
  ...typescriptFiles("src/schemas"),
  ...typescriptFiles("src/services"),
]);

function productionToolNames(): readonly string[] {
  return Object.freeze(PRODUCTION_ENTRY_SOURCE_PATHS.flatMap((path) => (
    [...source(path).matchAll(/registerTool\(\s*["']([^"']+)["']/g)]
      .map((match) => match[1]!)
  )));
}

function subproject3Script(): string {
  const packageJson = JSON.parse(source("package.json")) as { scripts?: Record<string, string> };
  const script = packageJson.scripts?.["test:subproject-3"];
  if (typeof script !== "string") assert.fail("test:subproject-3 must exist");
  return script;
}

const REQUIRED_SUBPROJECT_THREE_FOCUSED_TESTS = Object.freeze([
  "lifecycle-command-store",
  "lifecycle-contracts",
  "cli.orchestrator-admin",
  "project-binding.service",
  "project-store-bootstrap",
  "rollout-control-plane",
  "runtime-capabilities",
  "stored-event-authenticator",
]);

function assertRequiredSubprojectThreeFocusedTests(script: string): void {
  for (const target of REQUIRED_SUBPROJECT_THREE_FOCUSED_TESTS) {
    assert.match(
      script,
      new RegExp(`dist-test/tests/${target.replace(/[.]/g, "\\.")}\\.test\\.js`),
      `Subproject 3 focused gate must include ${target}.test.js`,
    );
  }
}

interface ProductionIsolationSource {
  readonly path: string;
  readonly contents: string;
}

const JAVASCRIPT_TRIVIA = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))`;
const FORBIDDEN_V2_PRODUCTION_MODULE_WIRING = new RegExp(
  String.raw`(?:from(?:${JAVASCRIPT_TRIVIA})+|import(?:(?:${JAVASCRIPT_TRIVIA})*\((?:${JAVASCRIPT_TRIVIA})*|(?:${JAVASCRIPT_TRIVIA})+)|require(?:${JAVASCRIPT_TRIVIA})*\((?:${JAVASCRIPT_TRIVIA})*)["'][^"']*(?:\/(?:projections|retrieval)\/(?:v2-[^"']*|evaluation)|\/runtime\/(?:projection-runtime|v2-[^"']*)|\/orchestrator\/rollout\/)[^"']*["']`,
);
const FORBIDDEN_SHADOW_PRODUCTION_MODULE_WIRING = new RegExp(
  String.raw`(?:from(?:${JAVASCRIPT_TRIVIA})+|import(?:(?:${JAVASCRIPT_TRIVIA})*\((?:${JAVASCRIPT_TRIVIA})*|(?:${JAVASCRIPT_TRIVIA})+)|require(?:${JAVASCRIPT_TRIVIA})*\((?:${JAVASCRIPT_TRIVIA})*)["'][^"']*(?:\/(?:migration|parity)\/|\/materialization\/(?:v2-shadow-compatibility|stable-compatibility-directory))[^"']*["']`,
);
const FORBIDDEN_V2_PRODUCTION_TOOL_REGISTRATION = /registerTool\(\s*["']memory_(?:retrieval|projection|migration|parity|appendEvent|eventAppend)/;
const FORBIDDEN_SHADOW_ENVIRONMENT = /process\s*\.\s*env\s*(?:\.\s*[A-Za-z0-9_]*(?:V2|SHADOW_MIGRATION)[A-Za-z0-9_]*|\[\s*["'][^"']*(?:V2|SHADOW_MIGRATION)[^"']*["']\s*\])/i;

// Only these reviewed prepared-composition edges may cross the old V1-only
// fence. No directory-prefix exemption grants future callers the same access.
const PREPARED_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  "src/v2.ts": ["src/v2/app.ts", "src/v2/config.ts"],
  "src/v2-admin.ts": ["src/v2/admin.ts", "src/v2/config.ts"],
  "src/v2/admin.ts": ["src/orchestrator/fresh-start/fresh-start-initializer.ts", "src/orchestrator/fresh-start/fresh-start-paths.ts", "src/orchestrator/fresh-start/contracts.ts", "src/v2/build-identity.ts", "src/v2/config.ts", "src/v2/composition.ts"],
  "src/v2/app.ts": ["src/orchestrator/fresh-start/contracts.ts", "src/v2/composition.ts", "src/v2/config.ts"],
  "src/v2/config.ts": ["src/orchestrator/fresh-start/contracts.ts", "src/orchestrator/fresh-start/fresh-start-paths.ts"],
  "src/v2/composition.ts": ["src/orchestrator/fresh-start/fresh-start-initializer.ts", "src/orchestrator/fresh-start/fresh-start-paths.ts", "src/orchestrator/fresh-start/contracts.ts", "src/orchestrator/fresh-start/fresh-start.repository.ts", "src/orchestrator/fresh-start/operator-approval.ts", "src/v2/build-identity.ts", "src/v2/config.ts"],
  "src/v2/build-identity.ts": ["src/orchestrator/fresh-start/contracts.ts"],
  "src/v2/internal-verified-read.entry.ts": ["src/v2/build-identity.ts"],
  "src/v2/internal-verified-read-cleanup.entry.ts": ["src/v2/build-identity.ts"],
  "src/workers/project-store.worker.ts": ["src/v2/build-identity.ts"],
  "src/orchestrator/runtime/project-store-executor.ts": ["src/orchestrator/fresh-start/fresh-start-admission.ts"],
  "src/orchestrator/runtime/project-store-worker-backend.ts": ["src/orchestrator/fresh-start/fresh-start-admission.ts", "src/orchestrator/fresh-start/contracts.ts"],
  "src/orchestrator/runtime/worker-protocol.ts": ["src/orchestrator/fresh-start/fresh-start-admission.ts"],
};
function canonicalModuleSpecifiers(candidate: ProductionIsolationSource): readonly string[] {
  // Parse source as data: never execute it or interpret a quoted prefix as the
  // whole argument. Parentheses, operators, spreads and options remain AST nodes.
  const parsed = ts.createSourceFile(candidate.path, candidate.contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  const readLiteral = (node: ts.Node): void => {
    assert.ok(ts.isStringLiteral(node), "V2_PRODUCTION_ISOLATION: unsupported module call shape");
    const raw = node.getText(parsed);
    assert.ok((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")),
      "V2_PRODUCTION_ISOLATION: unsupported module call shape");
    assert.ok(!raw.includes("\\"), "V2_PRODUCTION_ISOLATION: unsupported escaped module literal");
    specifiers.push(raw.slice(1, -1));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) readLiteral(node.moduleSpecifier);
    } else if (ts.isExternalModuleReference(node)) {
      assert.ok(node.expression, "V2_PRODUCTION_ISOLATION: unsupported module call shape");
      readLiteral(node.expression);
    } else if (ts.isImportTypeNode(node)) {
      assert.ok(ts.isLiteralTypeNode(node.argument), "V2_PRODUCTION_ISOLATION: unsupported module call shape");
      readLiteral(node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      let callee: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(callee) || ts.isAsExpression(callee)
        || ts.isTypeAssertionExpression(callee) || ts.isNonNullExpression(callee) || ts.isSatisfiesExpression(callee)) callee = callee.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
        assert.ok(callee === node.expression && !node.questionDotToken && !node.typeArguments
          && node.arguments.length === 1 && !node.arguments.hasTrailingComma,
        "V2_PRODUCTION_ISOLATION: unsupported module call shape");
        const argument = node.arguments[0]!;
        assert.ok(!ts.isTemplateExpression(argument) && !ts.isNoSubstitutionTemplateLiteral(argument),
          "V2_PRODUCTION_ISOLATION: unsupported template module argument");
        readLiteral(argument);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
}

function normalizedModuleTarget(caller: string, specifier: string): string | null {
  // This fence intentionally accepts canonical literal spellings only. Raw
  // JavaScript escapes are not URL escapes; never normalize them as path text
  // or execute source to decode them (including escaped relative prefixes).
  assert.ok(!specifier.includes("\\"), "V2_PRODUCTION_ISOLATION: unsupported escaped module literal");
  // Bare packages/builtins are not repository-relative modules. Resolve file
  // URLs and relative literals as Node does before testing the protected target.
  if (!specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("file:")) return null;
  const url = new URL(specifier, new URL(caller, ROOT));
  const target = relative(fileURLToPath(ROOT), fileURLToPath(url)).split(sep).join("/").toLowerCase();
  return target.replace(/\.js$/, ".ts");
}

function assertProductionIsolation(sources: readonly ProductionIsolationSource[]): void {
  for (const candidate of sources) {
    if (PRODUCTION_ENTRY_SOURCE_PATHS.includes(candidate.path)) {
      const specifiers = canonicalModuleSpecifiers(candidate);
      assert.doesNotMatch(candidate.contents, FORBIDDEN_SHADOW_PRODUCTION_MODULE_WIRING, `V2_PRODUCTION_ISOLATION: ${candidate.path} must not import migration/parity/materialization`);
      assert.doesNotMatch(candidate.contents, /(?:from|import|require)[\s\S]{0,40}["'][^"']*(?:tests\/|fixtures\/)[^"']*["']/, "V2_PRODUCTION_ISOLATION: no test fixture wiring");
      assert.doesNotMatch(candidate.contents, FORBIDDEN_SHADOW_ENVIRONMENT, "V2_PRODUCTION_ISOLATION: no environment activation");
      for (const specifier of specifiers) {
        const target = normalizedModuleTarget(candidate.path, specifier);
        if (target === "src/v2.ts" || target === "src/v2-admin.ts" || target?.startsWith("src/v2/")
          || target?.startsWith("src/orchestrator/fresh-start/")) assert.ok(
          PREPARED_IMPORTS[candidate.path]?.includes(target), "V2_PRODUCTION_ISOLATION: unapproved prepared composition edge");
      }
      assert.doesNotMatch(
        candidate.contents,
        FORBIDDEN_V2_PRODUCTION_MODULE_WIRING,
        `V2_PRODUCTION_ISOLATION: ${candidate.path} must not wire Version 2 production behavior`,
      );
      assert.doesNotMatch(
        candidate.contents,
        FORBIDDEN_V2_PRODUCTION_TOOL_REGISTRATION,
        `V2_PRODUCTION_ISOLATION: ${candidate.path} must not wire Version 2 production behavior`,
      );
    }
    if (candidate.path === "tests/retrieval-evaluation.test.ts") {
      assert.doesNotMatch(
        candidate.contents,
        /\b(?:answerReplay|answersByQuery|expectedAnswers)\b/,
        "V2_PRODUCTION_ISOLATION: evaluator fixtures must not derive retrieval answers",
      );
      assert.match(
        candidate.contents,
        /assertNoAnswerDerivedFields\(query, `queries\[\$\{index\}\]`\);/,
        "V2_PRODUCTION_ISOLATION: evaluator fixtures must reject answer-derived fields",
      );
    }
  }
}

function sourceBetween(
  evaluator: string,
  startMarker: string,
  endMarker: string,
  label: string,
): string {
  const start = evaluator.indexOf(startMarker);
  const end = evaluator.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${label} must have stable bounds`);
  return evaluator.slice(start, end);
}

function realV2HarnessTestBody(evaluator: string): string {
  return sourceBetween(
    evaluator,
    '  it("hydrates authenticated sources, reproduces V1, and seals V2 through the detached lease bridge", async () => {',
    '\n  });\n});\n\ndescribe("sealed V2 threshold predicate", () => {',
    "real V2 harness test",
  );
}

function realV2BridgeImplementation(evaluator: string): string {
  return sourceBetween(
    evaluator,
    "async function createV2EvaluationBridge(",
    "\nfunction directSourceRequest(",
    "real V2 bridge implementation",
  );
}

function sealedEvaluationRequestFactory(evaluator: string): string {
  return sourceBetween(
    evaluator,
    "function requestFor(",
    "\n/** Sealed V2 evaluation never permits vector retrieval into its measured result. */",
    "sealed evaluation request factory",
  );
}

function assertSealedEvaluationRequestFactory(requestFor: string): void {
  assert.match(
    requestFor,
    /const vector = Object\.freeze\(\{ enabled: false \} as const\);/,
    "sealed request factory must disable vector retrieval",
  );
  assert.match(
    requestFor,
    /assertSealedEvaluationVectorDisabled\(vector\);/,
    "sealed request factory must enforce disabled vectors",
  );
}

function assertRealBridgeDataflow(bridge: string): void {
  assert.match(bridge, /service:\s*new InternalRetrievalService\(\{ projections, candidates \}\),/, "real bridge service must use projections and candidates");
  assert.match(bridge, /const original = originalLeases\.get\(lease\);[\s\S]*?return adapter\.collectEligible\(original, request\);/, "real bridge candidates must delegate the preserved lease");
}

function assertNoV2EntryWiring(entry: string): void {
  assert.doesNotMatch(entry, FORBIDDEN_V2_PRODUCTION_MODULE_WIRING, "V2 entry wiring is forbidden");
  assert.doesNotMatch(entry, FORBIDDEN_SHADOW_PRODUCTION_MODULE_WIRING, "V2 entry wiring is forbidden");
}

function runRetrievalEvaluation(...targets: readonly string[]) {
  return spawnSync(
    process.execPath,
    ["scripts/run-retrieval-evaluation.js", ...targets],
    { cwd: fileURLToPath(ROOT), encoding: "utf8" },
  );
}

function runRetrievalEvaluationWithChildOutput(output: string) {
  const directory = mkdtempSync(join(tmpdir(), "retrieval-evaluation-runner-"));
  const loader = join(directory, "mock-child-process.mjs");
  const mockedChildProcess = [
    'import { EventEmitter } from "node:events";',
    "export function spawn() {",
    "  const child = new EventEmitter();",
    "  child.stdout = new EventEmitter();",
    "  child.stderr = new EventEmitter();",
    `  queueMicrotask(() => { child.stdout.emit("data", Buffer.from(${JSON.stringify(output)})); child.emit("close", 0, null); });`,
    "  return child;",
    "}",
  ].join("\n");
  writeFileSync(loader, [
    `const childProcess = ${JSON.stringify(`data:text/javascript,${encodeURIComponent(mockedChildProcess)}`)};`,
    "export async function resolve(specifier, context, nextResolve) {",
    '  if (specifier === "node:child_process") return { url: childProcess, shortCircuit: true };',
    "  return nextResolve(specifier, context);",
    "}",
  ].join("\n"));
  try {
    return spawnSync(
      process.execPath,
      ["--experimental-loader", pathToFileURL(loader).href, "scripts/run-retrieval-evaluation.js"],
      { cwd: fileURLToPath(ROOT), encoding: "utf8" },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const PLAIN_WORKFLOW_KEY = "[A-Za-z][A-Za-z0-9_-]*";
const PLAIN_MAPPING_LINE = new RegExp(`^ *${PLAIN_WORKFLOW_KEY}:(?: .*)?$`);
const PLAIN_LIST_MAPPING_LINE = new RegExp(`^ *- ${PLAIN_WORKFLOW_KEY}:(?: .*)?$`);
const PLAIN_SCALAR_LIST_ITEM = /^ *- (?![?&*!|>{[\],])\S(?:.*\S)?$/;

function isPermittedRunBlockHeader(line: string): boolean {
  return /^ *run: \|(?:\s+#.*)?$/.test(line);
}

function structuralWorkflowLines(yaml: string): readonly string[] {
  const structuralLines: string[] = [];
  let blockScalarIndent: number | null = null;
  for (const line of yaml.split("\n")) {
    const indentation = /^[ ]*/.exec(line)?.[0].length ?? 0;
    if (blockScalarIndent !== null) {
      if (line.trim().length === 0 || indentation > blockScalarIndent) continue;
      blockScalarIndent = null;
    }
    structuralLines.push(line);
    if (isPermittedRunBlockHeader(line)) {
      blockScalarIndent = indentation;
    }
  }
  return structuralLines;
}

function unquotedStructuralLine(line: string): string {
  return line
    .replace(/\$\{\{[\s\S]*?\}\}/g, () => "EXPRESSION")
    .replace(/"(?:\\.|[^"\\])*"|'(?:''|[^'])*'/g, () => "SCALAR")
    .replace(/\s+#.*$/, "");
}

function assertCanonicalWorkflowGrammar(yaml: string, label: string): void {
  for (const line of structuralWorkflowLines(yaml)) {
    assert.doesNotMatch(line, /\t/, `${label} contains unsupported YAML tab`);
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    assert.doesNotMatch(line, /^\s*%/, `${label} contains unsupported YAML directive`);
    assert.doesNotMatch(line, /^\s*(?:---|\.\.\.)(?:\s+#.*)?$/, `${label} contains unsupported YAML document marker`);
    assert.doesNotMatch(line, /^\s*(?:-\s*)?\?/, `${label} contains explicit YAML key`);
    assert.doesNotMatch(line, /^\s*(?:-\s*)?:/, `${label} contains explicit YAML value`);
    assert.doesNotMatch(
      line,
      /^\s*(?:-\s*)?(?:"(?:\\.|[^"\\])*"|'(?:''|[^'])*')\s*:/,
      `${label} contains quoted YAML mapping key`,
    );
    if (isPermittedRunBlockHeader(line)) continue;
    const structural = unquotedStructuralLine(line);
    assert.doesNotMatch(structural, /[{}\[\]]/, `${label} contains unsupported flow-style YAML`);
    assert.doesNotMatch(structural, /(?:^|\s)<<\s*:/, `${label} contains unsupported YAML merge key`);
    assert.doesNotMatch(structural, /[&*]/, `${label} contains unsupported YAML anchor or alias`);
    assert.doesNotMatch(structural, /!/, `${label} contains unsupported YAML tag`);
    assert.doesNotMatch(
      structural,
      /^\s*(?:-\s*)?[A-Za-z][A-Za-z0-9_-]*:\s*[>|]/,
      `${label} contains unsupported YAML block scalar`,
    );
    assert.ok(
      PLAIN_MAPPING_LINE.test(structural)
        || PLAIN_LIST_MAPPING_LINE.test(structural)
        || PLAIN_SCALAR_LIST_ITEM.test(structural),
      `${label} contains non-canonical YAML structural line`,
    );
  }
}

function workflowJobs(yaml: string): ReadonlyMap<string, string> {
  const jobs = new Map<string, string>();
  const jobSection = yaml.slice(yaml.indexOf("\njobs:\n") + "\njobs:\n".length);
  const matches = [...jobSection.matchAll(/^  ([a-z][a-z0-9_-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9_-]*:|(?![\s\S]))/gm)];
  for (const match of matches) {
    assert.ok(!jobs.has(match[1]!), "duplicate workflow job");
    jobs.set(match[1]!, match[0]!);
  }
  return jobs;
}

interface WorkflowStep {
  readonly name: string | null;
  readonly body: string;
  readonly ownerJob: string;
}

function normalizeYamlScalar(raw: string): string {
  let value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) value = JSON.parse(value) as string;
  else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
  else value = value.replace(/\s+#.*$/, "");
  const expression = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(value);
  return expression?.[1]?.trim() ?? value;
}

function yamlScalar(block: string, key: string): string | null {
  const indent = key === "max-parallel" ? 6 : ["path", "fetch-depth"].includes(key) ? 10 : 8;
  const match = new RegExp(`^ {${indent}}${key}: *(.*)$`, "m").exec(block);
  return match === null ? null : normalizeYamlScalar(match[1]!);
}

function workflowSteps(job: string, ownerJob = "unknown"): readonly WorkflowStep[] {
  return [...job.matchAll(/^      -(?<first>[^\n]*)(?:\n|$)(?<rest>[\s\S]*?)(?=^      -|^  [a-z][a-z0-9_-]*:|(?![\s\S]))/gm)]
    .map((match) => {
      const first = match.groups?.first ?? "";
      const name = /^ name: (.+)$/.exec(first)?.[1];
      return {
        name: name === undefined ? null : normalizeYamlScalar(name),
        body: `${first}\n${match.groups?.rest ?? ""}`,
        ownerJob,
      };
    });
}

function assertNoJobBypass(job: string, label: string): void {
  assert.doesNotMatch(job, /^    if:\s*/m, `${label} must not declare if`);
  assert.doesNotMatch(
    job,
    /^    continue-on-error:\s*/m,
    `${label} must not declare continue-on-error`,
  );
}

function requiredStep(job: string, name: string): WorkflowStep {
  const candidates = workflowSteps(job).filter((candidate) => candidate.name === name);
  assert.equal(candidates.length, 1, `exactly one executable ${name} step is required`);
  const step = candidates[0];
  assert.ok(step, `missing executable ${name} step`);
  assert.equal(yamlScalar(step.body, "if"), null, `${name} must not declare if`);
  assert.equal(
    yamlScalar(step.body, "continue-on-error"),
    null,
    `${name} must not declare continue-on-error`,
  );
  return step;
}

function workflowActions(job: string, ownerJob: string): readonly {
  readonly step: WorkflowStep;
  readonly uses: string;
  readonly withPath: string | null;
}[] {
  return workflowSteps(job, ownerJob).flatMap((step) => [...step.body.matchAll(/(?:^|\n)\s*uses:\s*(.+)$/gm)]
    .map((match) => ({
      step,
      uses: normalizeYamlScalar(match[1]!),
      withPath: yamlScalar(step.body, "path"),
    })));
}

// This is deliberately a closed subset, not a general YAML parser. Validate
// hierarchy before the bounded scalar readers can see a nested or duplicate key.
function assertWorkflowStructure(yaml: string): void {
  const maps: Record<string, readonly string[]> = {
    "": ["name", "on", "permissions", "concurrency", "jobs"],
    "on": ["push", "pull_request", "workflow_dispatch", "schedule"],
    "on/schedule/*": ["cron"],
    "permissions": ["contents"],
    "concurrency": ["group", "cancel-in-progress"],
    "jobs": ["release-gates", "minimum-runtime-rejection", "stress"],
    "jobs/*": ["name", "runs-on", "strategy", "steps", "if", "continue-on-error"],
    "jobs/*/strategy": ["fail-fast", "max-parallel", "matrix"],
    "jobs/*/strategy/matrix": ["os", "node-version"],
    "jobs/*/steps/*": ["name", "uses", "run", "shell", "with", "env", "if", "continue-on-error"],
    "jobs/*/steps/*/with": ["name", "path", "if-no-files-found", "retention-days", "fetch-depth", "node-version"],
    "jobs/*/steps/*/env": ["V2_SHADOW_MIGRATION_TEST_EVIDENCE_OUTPUT"],
  };
  const lists = new Set(["on/schedule", "jobs/*/steps", "jobs/*/strategy/matrix/os", "jobs/*/strategy/matrix/node-version"]);
  type Frame = { indent: number; path: string; list: boolean; keys: Set<string> };
  const stack: Frame[] = [{ indent: 0, path: "", list: false, keys: new Set() }];
  for (const line of structuralWorkflowLines(yaml)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = /^ */.exec(line)![0].length;
    while (stack.length > 1 && indent < stack[stack.length - 1]!.indent) stack.pop();
    let frame = stack[stack.length - 1]!;
    assert.equal(indent, frame.indent, "unsupported YAML nesting or indentation");
    let text = line.trim();
    if (text.startsWith("- ")) {
      assert.ok(frame.list, "list requires an approved sequence parent");
      text = text.slice(2);
      if (frame.path.includes("/matrix/")) {
        assert.ok(/^(?:[a-z][a-z0-9-]*|"[0-9.]+")$/.test(text), "matrix items must be literal scalars");
        continue;
      }
      frame = { indent: indent + 2, path: `${frame.path}/*`, list: false, keys: new Set() };
      stack.push(frame);
    } else assert.equal(frame.list, false, "sequence item must begin with dash");
    const pair = /^([A-Za-z][A-Za-z0-9_-]*):(?: (.*))?$/.exec(text);
    assert.ok(pair, "mapping must be a canonical key/value");
    const key = pair[1]!, value = pair[2] ?? "";
    assert.ok(maps[frame.path]?.includes(key), `unsupported YAML key or parent: ${frame.path}/${key}`);
    assert.ok(!frame.keys.has(key), `duplicate YAML key: ${frame.path}/${key}`);
    frame.keys.add(key);
    const child = frame.path === "jobs" ? "jobs/*" : frame.path ? `${frame.path}/${key}` : key;
    if (maps[child] || lists.has(child)) {
      assert.equal(value, "", `container must not have a scalar: ${child}`);
      stack.push({ indent: frame.indent + 2, path: child, list: lists.has(child), keys: new Set() });
    } else {
      assert.ok(value !== "" || frame.path === "on", `scalar must not be a nested mapping: ${child}`);
      if (value === "|") assert.equal(key, "run");
    }
  }
}

function compactStep(body: string): string {
  return body.split("\n").filter(line => line.trim() !== "" && !line.trimStart().startsWith("#"))
    .map(line => line.trim()).join("\n");
}

function assertWorkflowReleaseContract(ci: string, stress: string): void {
  assertCanonicalWorkflowGrammar(ci, "CI workflow");
  assertCanonicalWorkflowGrammar(stress, "stress workflow");
  assertWorkflowStructure(ci);
  assertWorkflowStructure(stress);
  const ciJobs = workflowJobs(ci);
  const stressJobs = workflowJobs(stress);
  assert.deepEqual([...ciJobs.keys()], ["release-gates", "minimum-runtime-rejection"]);
  assert.deepEqual([...stressJobs.keys()], ["stress"]);
  const releaseGates = ciJobs.get("release-gates");
  const minimumRuntime = ciJobs.get("minimum-runtime-rejection");
  const stressJob = stressJobs.get("stress");
  assert.ok(releaseGates, "CI must have a release-gates job");
  assert.ok(minimumRuntime, "CI must retain the minimum-runtime rejection job");
  assert.ok(stressJob, "stress workflow must have a stress job");
  assertNoJobBypass(releaseGates!, "release-gates job");
  assertNoJobBypass(minimumRuntime!, "minimum-runtime-rejection job");
  assertNoJobBypass(stressJob!, "stress job");
  for (const job of [...ciJobs.values(), ...stressJobs.values()]) {
    const steps = workflowSteps(job);
    const names = steps.map(step => step.name);
    assert.ok(names.every(name => name !== null), "every executable step must be named");
    assert.equal(new Set(names).size, names.length, "duplicate executable step name");
    for (const step of steps) {
      if (step.name !== "Upload stress logs") requiredStep(job, step.name!);
      assert.equal(yamlScalar(step.body, "continue-on-error"), null, "no step may suppress failures");
      if (step.name !== "Run V2 shadow migration gate") assert.equal(yamlScalar(step.body, "env"), null);
    }
  }
  const checkouts = [...ciJobs.entries(), ...stressJobs.entries()]
    .flatMap(([ownerJob, job]) => workflowSteps(job, ownerJob))
    .filter((step) => step.name === "Check out repository");
  assert.equal(checkouts.length, 3, "every checkout site must be explicit");
  for (const checkout of checkouts) {
    assert.equal(yamlScalar(checkout.body, "if"), null, "checkout must not declare if");
    assert.equal(yamlScalar(checkout.body, "uses"), "actions/checkout@v6");
    assert.equal(yamlScalar(checkout.body, "fetch-depth"), "0");
    assert.equal(compactStep(checkout.body), "name: Check out repository\nuses: actions/checkout@v6\nwith:\nfetch-depth: 0",
      "checkout must retain its exact full-history configuration");
  }
  assert.equal(yamlScalar(requiredStep(releaseGates!, "Run lifecycle release gates").body, "run"), "npm run test:subproject-2");
  assert.equal(yamlScalar(requiredStep(releaseGates!, "Require immutable lifecycle base commit").body, "run"), `git cat-file -e "${BASE}^{commit}"`);
  assert.equal(yamlScalar(requiredStep(releaseGates!, "Protect Version 1 production routing").body, "run"), `git diff --exit-code ${BASE} -- src/app.ts src/index.ts src/controllers src/schemas src/services`);
  assert.equal(yamlScalar(requiredStep(releaseGates!, "Run V2 rollout control-plane gate").body, "run"), "npm run test:rollout-control-plane");
  const releaseSteps = workflowSteps(releaseGates!);
  const protectedRoutingIndex = releaseSteps.findIndex((step) => step.name === "Protect Version 1 production routing");
  const rolloutGateIndex = releaseSteps.findIndex((step) => step.name === "Run V2 rollout control-plane gate");
  assert.equal(rolloutGateIndex, protectedRoutingIndex + 1, "the rollout control-plane gate must immediately follow the Version 1 routing guard");
  assert.equal(yamlScalar(requiredStep(releaseGates!, "Build").body, "run"), "npm run build");
  assert.equal(yamlScalar(requiredStep(releaseGates!, "Test build artifacts").body, "run"), "npm run test:build-artifacts");
  const expectedReleaseSteps = [
    "name: Check out repository\nuses: actions/checkout@v6\nwith:\nfetch-depth: 0",
    "name: Set up Node.js\nuses: actions/setup-node@v6\nwith:\nnode-version: ${{ matrix.node-version }}",
    "name: Install dependencies\nrun: npm ci",
    "name: Check runtime capabilities\nrun: npm run check:runtime",
    "name: Typecheck\nrun: npm run typecheck",
    "name: Build\nrun: npm run build",
    "name: Run tests\nrun: npm run test:all",
    "name: Run lifecycle release gates\nrun: npm run test:subproject-2",
    `name: Require immutable lifecycle base commit\nrun: git cat-file -e "${BASE}^{commit}"`,
    `name: Protect Version 1 production routing\nrun: git diff --exit-code ${BASE} -- src/app.ts src/index.ts src/controllers src/schemas src/services`,
    "name: Run V2 rollout control-plane gate\nrun: npm run test:rollout-control-plane",
    compactStep(MIGRATION_GATE.replace("      - ", "")),
    "name: Run V2 fresh-start foundation gate\nrun: npm run test:v2-fresh-start-foundation",
    "name: Test build artifacts\nrun: npm run test:build-artifacts",
    compactStep(MIGRATION_UPLOAD.replace("      - ", "")),
  ];
  assert.deepEqual(releaseSteps.map(step => compactStep(step.body)), expectedReleaseSteps,
    "release steps must match the exact unconditional producer/build/upload order");
  assert.equal(ci.split("V2_SHADOW_MIGRATION_TEST_EVIDENCE_OUTPUT").length - 1, 1, "exactly one producer output setting");
  assert.ok(!stress.includes("V2_SHADOW_MIGRATION_TEST_EVIDENCE_OUTPUT"), "stress must not select migration output");
  assert.equal(workflowSteps(minimumRuntime!).filter((step) => step.name === "Check out repository").length, 1);
  assert.equal(yamlScalar(stressJob!, "max-parallel"), "1", "stress must remain serial");
  assert.deepEqual(workflowSteps(stressJob!).map(step => step.name), [
    "Check out repository", "Set up Node.js", "Install dependencies", "Build tests",
    "Run default and lifecycle concurrent, crash, and security tests", "Run release stress test",
    "Run lifecycle stress test", "Upload stress logs",
  ], "stress gate and uploader order must remain unchanged");
  assert.deepEqual(workflowSteps(minimumRuntime!).map(step => step.name), [
    "Check out repository", "Set up Node.js 22.22.3", "Require the documented minimum-runtime rejection",
  ]);
  assert.match(requiredStep(stressJob!, "Run default and lifecycle concurrent, crash, and security tests").body, /event-store\.concurrent\.test\.js.*event-store\.crash\.test\.js.*lifecycle\.concurrent\.test\.js.*lifecycle\.crash\.test\.js.*lifecycle\.security\.test\.js/s);
  assert.match(requiredStep(stressJob!, "Run release stress test").body, /npm run test:stress/);
  assert.match(requiredStep(stressJob!, "Run lifecycle stress test").body, /npm run test:lifecycle-stress/);
  const actions = [
    ...[...ciJobs].flatMap(([ownerJob, job]) => workflowActions(job, ownerJob).map(action => ({ ...action, workflow: "ci.yml" }))),
    ...[...stressJobs].flatMap(([ownerJob, job]) => workflowActions(job, ownerJob).map(action => ({ ...action, workflow: "sqlite-stress.yml" }))),
  ];
  for (const action of actions) {
    assert.ok(action.uses.length > 0, "workflow action must have a non-empty uses scalar");
    if (action.withPath !== null) {
      assert.doesNotMatch(action.withPath, /\*\.sqlite\*|\.memory-mcp|pending[-_ ]?(authorization|credential)|\.md\b/i);
    }
  }
  const uploads = actions.filter((action) => action.uses.startsWith("actions/upload-artifact@"));
  assert.equal(uploads.length, 2, "exactly two classified upload-artifact slots are allowed");
  assert.deepEqual(uploads.map(upload => ({ workflow: upload.workflow, owner: upload.step.ownerJob,
    step: upload.step.name, action: upload.uses })), [
    { workflow: "ci.yml", owner: "release-gates", step: "Upload V2 shadow migration functional synthetic evidence", action: "actions/upload-artifact@v7" },
    { workflow: "sqlite-stress.yml", owner: "stress", step: "Upload stress logs", action: "actions/upload-artifact@v7" },
  ], "upload manifest must preserve workflow, owner, step, action and classification order");
  const stressUpload = uploads[1]!;
  assert.equal(compactStep(stressUpload.step.body), [
    "name: Upload stress logs", "if: ${{ always() }}", "uses: actions/upload-artifact@v7", "with:",
    "name: sqlite-stress-logs-${{ matrix.os }}-${{ github.run_id }}-${{ github.run_attempt }}",
    "path: ci-logs/sqlite-stress-${{ matrix.os }}.log", "if-no-files-found: error", "retention-days: 14",
  ].join("\n"), "stress upload must retain its exact historical transport policy");
  assert.equal(workflowSteps(stressJob!).at(-1)?.name, "Upload stress logs", "stress upload must follow its gates");
}

test("migration package scripts require the complete compiled producer and both built smokes", () => {
  const scripts = (JSON.parse(source("package.json")) as { scripts: Record<string, string> }).scripts;
  const producer = source("tests/v2-shadow-migration-rehearsal.test.ts");
  assertMigrationScripts(scripts, producer);
  for (const replacement of [
    SHADOW_MIGRATION_SCRIPT.replace(" dist-test/tests/v2-shadow-migration-rehearsal.test.js", ""),
    SHADOW_MIGRATION_SCRIPT.replace(" --test-reporter=spec", " --test-reporter=spec --test-name-pattern=preflight"),
    SHADOW_MIGRATION_SCRIPT + " || true", "echo '{}' > evidence.json", "cp stale.json evidence.json",
  ]) assert.throws(() => assertMigrationScripts({ ...scripts, "test:v2-shadow-migration": replacement }, producer));
  assert.throws(() => assertMigrationScripts(scripts, producer.replace(
    'test("retains synthetic functional evidence', 'test.skip("retains synthetic functional evidence')));
  assert.throws(() => assertMigrationScripts(scripts, producer.replace(
    "retains synthetic functional evidence from the fresh compiled rehearsal command", "preflight refusal only")));
});

test("release configuration gates lifecycle V2 without production routing", () => {
  const packageJson = JSON.parse(source("package.json")) as { scripts?: Record<string, string> };
  const script = packageJson.scripts?.["test:subproject-2"];
  if (typeof script !== "string") assert.fail("test:subproject-2 must exist");
  const expectedScript = [
    "npm", "run", "test:build", "&&", "node", "--test", "--test-concurrency=1", "--test-reporter=spec",
    ...FOCUSED_TESTS.map((name) => `dist-test/tests/${name}.test.js`),
  ].join(" ");
  assert.equal(script, expectedScript, "test:subproject-2 must be canonical and ordered");
  for (const name of FOCUSED_TESTS) {
    assert.match(script, new RegExp(`dist-test/tests/${name.replace(/[.]/g, "\\.")}\\.test\\.js`));
  }

  const ci = source(".github/workflows/ci.yml");
  const stress = source(".github/workflows/sqlite-stress.yml");
  assertWorkflowReleaseContract(ci, stress);

  const smoke = source("scripts/smoke-worker.js");
  assert.match(smoke, /\[1,2,3,4,5,6,7,8,9\]/);
  assert.match(smoke, /schemaVersion !== 9/);
  assert.match(smoke, /migration0007\?\.name !== "v2-shadow-migration"/);
  assert.match(smoke, /migration0007\?\.checksum !== "fc3becb6329a7bcbc9c6775c436260a61cca6dffa432f8817bc583623df2c32a"/);
  assert.match(smoke, /manifest\.schemaVersion !== 1/);
  assert.match(smoke, new RegExp(FROZEN_0002));
  assert.match(smoke, new RegExp(FROZEN_0002_SQL));
  assert.match(
    smoke,
    /if\s*\(\s*frozenMigration0002 !== FROZEN_0002_SHA256\s*\|\|\s*migration0002 !== FROZEN_0002_SQL_SHA256\s*\)/s,
    "both frozen migration values must be in one executable gate",
  );
  assert.match(smoke, new RegExp(SCHEMA_TWO_PROVENANCE));
  assert.match(smoke, /execFileSync\("git", \["show",/);
  assert.match(smoke, /HISTORICAL_SCHEMA_TWO_READER_PROVENANCE\.sourceSha256/);
  assert.match(smoke, /workerData\.registry/);
  assert.match(smoke, /historicalSchemaTwoRegistry/);
  assert.match(smoke, /verifyRecordedMigrationPrefix/);
  assert.match(smoke, /setTimeout\(/);
  assert.match(smoke, /reader\.off\("message"/);
  assert.match(smoke, /SCHEMA_TOO_NEW/);
  assert.match(smoke, /LIFECYCLE_V2_DISABLED/);
  assert.match(smoke, /zero lifecycle event\/dedup\/workflow effect/);
  assert.match(smoke, /event_count.*dedup_count.*workflow_count/s);
});

test("workflow parser rejects duplicate jobs, mappings, and executable steps", () => {
  const ci = source(".github/workflows/ci.yml"), stress = source(".github/workflows/sqlite-stress.yml");
  for (const mutated of [
    ci.replace("  release-gates:\n", "  release-gates:\n    if: false\n  release-gates:\n"),
    ci.replace("    steps:\n", "    steps:\n      - run: echo forged\n    steps:\n"),
    ci.replace("        run: npm run build", "        run: npm run build\n        run: echo stale"),
    ci.replace("      - name: Build\n", "      - name: Build\n        run: echo forged\n\n      - name: Build\n"),
  ]) {
    assert.notEqual(mutated, ci);
    assert.throws(() => assertWorkflowReleaseContract(mutated, stress));
  }
});

test("workflow parser accepts only the two classified upload slots", () => {
  assert.doesNotThrow(() => assertWorkflowReleaseContract(source(".github/workflows/ci.yml"), source(".github/workflows/sqlite-stress.yml")));
});

test("workflow full-suite gate rejects fallback to the reduced default profile", () => {
  const ci = source(".github/workflows/ci.yml"), stress = source(".github/workflows/sqlite-stress.yml");
  assertWorkflowReleaseContract(ci, stress);
  const reduced = ci.replace("run: npm run test:all", "run: npm test");
  assert.notEqual(reduced, ci);
  assert.throws(() => assertWorkflowReleaseContract(reduced, stress));
});

test("workflow parser preserves exact stress scalar policy and checkout ownership", () => {
  const ci = source(".github/workflows/ci.yml"), stress = source(".github/workflows/sqlite-stress.yml");
  for (const mutated of [
    stress.replace("max-parallel: 1", "max-parallel: 10"),
    stress.replace("retention-days: 14", "retention-days: 140"),
    stress.replace("if-no-files-found: error", "if-no-files-found: warn"),
    stress.replace("if: ${{ always() }}", "if: success()"),
    stress.replace("uses: actions/upload-artifact@v7", "uses: actions/upload-artifact@v6"),
    stress.replace("          fetch-depth: 0", "          fetch-depth: 0\n          path: alternate-checkout"),
  ]) {
    assert.notEqual(mutated, stress);
    assert.throws(() => assertWorkflowReleaseContract(ci, mutated));
  }
});

test("workflow scalar readers reject shell-block text masquerading as the serial setting", () => {
  const ci = source(".github/workflows/ci.yml"), stress = source(".github/workflows/sqlite-stress.yml");
  const forged = stress.replace("      max-parallel: 1\n", "")
    .replace("        run: |\n", "        run: |\n          max-parallel: 1\n");
  assert.notEqual(forged, stress);
  assert.throws(() => assertWorkflowReleaseContract(ci, forged), /stress must remain serial/);
});

test("workflow parser rejects synthetic upload identity, policy, owner, and order substitutions", () => {
  const ci = source(".github/workflows/ci.yml"), stress = source(".github/workflows/sqlite-stress.yml");
  const mutations = [
    ci.replace(MIGRATION_UPLOAD, ""),
    ci.replace(MIGRATION_UPLOAD, `${MIGRATION_UPLOAD}\n${MIGRATION_UPLOAD}`),
    ...[["@v7", "@v6"], ["name: Upload V2", "name: Renamed V2"],
      ["functional-synthetic-", "production-rehearsal-"], ["retention-days: 14", "retention-days: 140"],
      ["if-no-files-found: error", "if-no-files-found: ignore"],
      ["        with:", "        if: success()\n        with:"],
      ["        with:", "        continue-on-error: true\n        with:"],
    ].map(([from, to]) => ci.replace(MIGRATION_UPLOAD, MIGRATION_UPLOAD.replace(from!, to!))),
    ci.replace(MIGRATION_UPLOAD, "").replace("      - name: Build\n", `${MIGRATION_UPLOAD}\n      - name: Build\n`),
    ci.replace(MIGRATION_UPLOAD, "").replace("    name: Reject Node", `${MIGRATION_UPLOAD}\n    name: Reject Node`),
    ci.replace(MIGRATION_UPLOAD, "").replace("    steps:\n", `    nested:\n      steps:\n${MIGRATION_UPLOAD.split("\n").map(line => `  ${line}`).join("\n")}\n    steps:\n`),
  ];
  for (const mutated of mutations) {
    assert.notEqual(mutated, ci);
    assert.throws(() => assertWorkflowReleaseContract(mutated, stress));
  }
  assert.throws(() => assertWorkflowReleaseContract(ci.replace(MIGRATION_UPLOAD, ""), `${stress}\n${MIGRATION_UPLOAD}\n`));
});

test("workflow parser rejects payload paths and nonliteral evidence transport", () => {
  const ci = source(".github/workflows/ci.yml"), stress = source(".github/workflows/sqlite-stress.yml");
  for (const path of [
    "${{ runner.temp }}/v2-shadow-migration-functional", "${{ runner.temp }}/**/*.json",
    "${{ runner.temp }}/v2-shadow-migration-functional/../evidence.json", "${{ inputs.evidence }}",
    "source-copy/evidence.json", "package/evidence.json", "events.sqlite", "events.sqlite-wal",
    "compatibility.md", "command.log", "evidence.json.tmp", "evidence.json.reservation",
    `${MIGRATION_OUTPUT} other.json`, `|\n            ${MIGRATION_OUTPUT}\n            source.sqlite`,
  ]) {
    const mutated = ci.replace(`          path: ${MIGRATION_OUTPUT}`, `          path: ${path}`);
    assert.notEqual(mutated, ci);
    assert.throws(() => assertWorkflowReleaseContract(mutated, stress), path);
  }
});

test("workflow parser binds output exclusively to the fresh producer gate", () => {
  const ci = source(".github/workflows/ci.yml"), stress = source(".github/workflows/sqlite-stress.yml");
  const env = `        env:\n          V2_SHADOW_MIGRATION_TEST_EVIDENCE_OUTPUT: ${MIGRATION_OUTPUT}\n`;
  const mutations = [
    ci.replace(MIGRATION_GATE, ""),
    ...[["        env:", "        if: always()\n        env:"],
      ["        env:", "        continue-on-error: false\n        env:"],
      ["npm run test:v2-shadow-migration", "echo '{}' > evidence.json"],
      ["npm run test:v2-shadow-migration", "cp stale.json evidence.json"],
      ["npm run test:v2-shadow-migration", "npm run test:v2-shadow-migration || true"],
      ["        run:", "        nested:\n          run:"],
    ].map(([from, to]) => ci.replace(MIGRATION_GATE, MIGRATION_GATE.replace(from!, to!))),
    ci.replace(env, "").replace("        run: npm run build", `${env}        run: npm run build`),
    ci.replace(env, "").replace("jobs:\n", `env:\n  V2_SHADOW_MIGRATION_TEST_EVIDENCE_OUTPUT: ${MIGRATION_OUTPUT}\njobs:\n`),
    ci.replace(env, env.replace(MIGRATION_OUTPUT, "${{ inputs.path }}")),
    ci.replace(env, `${env}          NODE_ENV: production\n`),
    ci.replace("      - name: Build\n", "      - name: Forge evidence\n        run: cp stale.json evidence.json\n      - name: Build\n"),
    ci.replace(MIGRATION_UPLOAD, MIGRATION_UPLOAD.replace("          path:", "          nested:\n            path:")),
    ci.replace(MIGRATION_UPLOAD, MIGRATION_UPLOAD.replace("          path:", "          path: source.sqlite\n          path:")),
  ];
  for (const mutated of mutations) {
    assert.notEqual(mutated, ci);
    assert.throws(() => assertWorkflowReleaseContract(mutated, stress));
  }
});

test("workflow parser closes conditional, scalar, and upload-owner bypasses", () => {
  const ci = source(".github/workflows/ci.yml");
  const stress = source(".github/workflows/sqlite-stress.yml");
  assert.throws(
    () => assertWorkflowReleaseContract(
      ci.replace("  release-gates:\n", "  release-gates:\n    if: ${{ !true }}\n"),
      stress,
    ),
    /release-gates job must not declare if/,
  );
  assert.throws(
    () => assertWorkflowReleaseContract(
      ci.replace("  release-gates:\n", "  release-gates:\n    continue-on-error: true\n"),
      stress,
    ),
    /release-gates job must not declare continue-on-error/,
  );
  assert.throws(
    () => assertWorkflowReleaseContract(
      ci.replace(
        "      - name: Run V2 rollout control-plane gate\n        run: npm run test:rollout-control-plane",
        "      - name: Run V2 rollout control-plane gate\n        continue-on-error: true\n        run: npm run test:rollout-control-plane",
      ),
      stress,
    ),
    /Run V2 rollout control-plane gate must not declare continue-on-error/,
  );

  const quotedUnnamedUpload = stress.replace(
    "      - name: Upload stress logs\n        if: ${{ always() }}\n        uses: actions/upload-artifact@v7",
    "      - uses: \"actions/upload-artifact@v7\"\n        if: '${{ always() }}'",
  );
  assert.throws(() => assertWorkflowReleaseContract(ci, quotedUnnamedUpload), /every executable step must be named/);

  const uploadBlock = [
    "      - uses: actions/upload-artifact@v7",
    "        if: ${{ always() }}",
    "        with:",
    "          path: ci-logs/sqlite-stress-${{ matrix.os }}.log",
    "          retention-days: 14",
  ].join("\n");
  assert.throws(
    () => assertWorkflowReleaseContract(
      ci.replace("\n  minimum-runtime-rejection:", `\n${uploadBlock}\n\n  minimum-runtime-rejection:`),
      stress.replace(/\n      - name: Upload stress logs[\s\S]*$/m, "\n"),
    ),
    /every executable step must be named/,
  );

  const extraUploader = stress.replace(
    "      - name: Upload stress logs",
    `${uploadBlock.replace("actions/upload-artifact@v7", "actions/upload-artifact@v6")}\n\n      - name: Upload stress logs`,
  );
  assert.throws(() => assertWorkflowReleaseContract(ci, extraUploader), /every executable step must be named/);
});

test("workflow parser rejects quoted conditional keys before reading jobs", () => {
  const ci = source(".github/workflows/ci.yml");
  const stress = source(".github/workflows/sqlite-stress.yml");
  assert.throws(
    () => assertWorkflowReleaseContract(
      ci.replace("  release-gates:\n", "  release-gates:\n    \"if\": ${{ !true }}\n"),
      stress,
    ),
    /quoted YAML mapping key/,
  );
});

test("workflow parser rejects quoted action keys before enumerating uploads", () => {
  const ci = source(".github/workflows/ci.yml");
  const stress = source(".github/workflows/sqlite-stress.yml");
  const hiddenQuotedUpload = stress.replace(
    "      - name: Upload stress logs",
    [
      "      - 'uses': 'actions/upload-artifact@v7'",
      "        if: '${{ always() }}'",
      "",
      "      - name: Upload stress logs",
    ].join("\n"),
  );
  assert.throws(() => assertWorkflowReleaseContract(ci, hiddenQuotedUpload), /quoted YAML mapping key/);
});

test("workflow parser rejects flow-style actions before enumerating uploads", () => {
  const ci = source(".github/workflows/ci.yml");
  const stress = source(".github/workflows/sqlite-stress.yml");
  const hiddenFlowUpload = stress.replace(
    "      - name: Upload stress logs",
    [
      "      - { uses: actions/upload-artifact@v7, if: ${{ always() }}, with: { path: ci-logs/sqlite-stress-${{ matrix.os }}.log } }",
      "",
      "      - name: Upload stress logs",
    ].join("\n"),
  );
  assert.throws(() => assertWorkflowReleaseContract(ci, hiddenFlowUpload), /flow-style YAML/);
});

test("workflow parser rejects YAML anchors, aliases, merges, and tags in structural grammar", () => {
  const ci = source(".github/workflows/ci.yml");
  const stress = source(".github/workflows/sqlite-stress.yml");
  const mutations = [
    ci.replace("    name: Node", "    name: &ci_name Node"),
    ci.replace("    name: Node", "    name: *ci_name"),
    ci.replace("    name: Node", "    <<: *ci_defaults\n    name: Node"),
    ci.replace("    name: Node", "    name: !ci_tag Node"),
  ];
  for (const mutatedCi of mutations) {
    assert.throws(() => assertWorkflowReleaseContract(mutatedCi, stress), /unsupported YAML (?:anchor|alias|merge key|tag)/);
  }
});

test("workflow parser rejects explicit YAML keys and values before reading jobs or actions", () => {
  const ci = source(".github/workflows/ci.yml");
  const stress = source(".github/workflows/sqlite-stress.yml");
  const explicitCondition = ci.replace(
    "  release-gates:\n",
    ["  release-gates:", "    ? if", "    : ${{ !true }}", ""].join("\n"),
  );
  assert.throws(() => assertWorkflowReleaseContract(explicitCondition, stress), /explicit YAML key/);

  const hiddenExplicitUpload = stress.replace(
    "      - name: Upload stress logs",
    [
      "      ? \"uses\"",
      "      : actions/upload-artifact@v7",
      "",
      "      - name: Upload stress logs",
    ].join("\n"),
  );
  assert.throws(() => assertWorkflowReleaseContract(ci, hiddenExplicitUpload), /explicit YAML key/);
});

test("workflow parser rejects directives, document markers, tabs, and exotic block scalars", () => {
  const ci = source(".github/workflows/ci.yml");
  const stress = source(".github/workflows/sqlite-stress.yml");
  const mutations = [
    `%YAML 1.2\n${ci}`,
    `---\n${ci}`,
    ci.replace("    name: Node", "\tname: Node"),
    ci.replace("    name: Node", "    name: >"),
  ];
  for (const mutatedCi of mutations) {
    assert.throws(() => assertWorkflowReleaseContract(mutatedCi, stress), /(?:directive|document marker|tab|block scalar)/);
  }
});

test("Subproject 3 evaluation runner rejects malformed aggregate-looking TAP output", () => {
  const malformedThenValid = [
    '# {"corpusVersion":"retrieval-evaluation-v2"',
    JSON.stringify(VALID_V2_AGGREGATE),
    "",
  ].join("\n");
  const result = runRetrievalEvaluationWithChildOutput(malformedThenValid);
  assert.notEqual(result.status, 0, "a malformed aggregate-looking line must fail closed");
  assert.match(`${result.stdout}\n${result.stderr}`, /RETRIEVAL_EVALUATION_REPORT_INVALID/);
});

test("Subproject 3 evaluation runner rejects aggregate shape and leakage", () => {
  for (const invalid of [
    { ...VALID_V2_AGGREGATE, queryText: "leak" },
    { ...VALID_V2_AGGREGATE, languageCounts: { en: 162, th: 171 } },
    { ...VALID_V2_AGGREGATE, recallAt10: 1.1 },
    { ...VALID_V2_AGGREGATE, failedQueryCount: 505 },
  ]) {
    const result = runRetrievalEvaluationWithChildOutput(`${JSON.stringify(invalid)}\n`);
    assert.notEqual(result.status, 0, "invalid aggregate shape must fail closed");
    assert.match(`${result.stdout}\n${result.stderr}`, /RETRIEVAL_EVALUATION_REPORT_INVALID/);
  }
});

test("Subproject 3 evaluation guard binds the sealed production request factory", () => {
  const requestFor = sealedEvaluationRequestFactory(source("src/orchestrator/retrieval/evaluation.ts"));
  assertSealedEvaluationRequestFactory(requestFor);
  assert.throws(
    () => assertSealedEvaluationRequestFactory(requestFor.replace("enabled: false", "enabled: true")),
    /sealed request factory must disable vector retrieval/,
  );
  assert.throws(
    () => assertSealedEvaluationRequestFactory(requestFor.replace("assertSealedEvaluationVectorDisabled(vector);", "")),
    /sealed request factory must enforce disabled vectors/,
  );
});

test("Subproject 3 evaluation guard proves real bridge dataflow", () => {
  const evaluator = source("tests/retrieval-evaluation.test.ts");
  const bridge = realV2BridgeImplementation(evaluator);
  assert.throws(
    () => assertRealBridgeDataflow(bridge.replace("service: new InternalRetrievalService({ projections, candidates }),", "service: replacementService,")),
    /real bridge service/,
  );
  assert.throws(
    () => assertRealBridgeDataflow(bridge.replace("return adapter.collectEligible(original, request);", "return answerReplay.get(request.query);")),
    /preserved lease/,
  );
});

test("Subproject 3 evaluation guard rejects dynamic V2 entry wiring", () => {
  for (const forbiddenWiring of [
    'import "../orchestrator/migration/v2-shadow-migration-runner.js";',
    'const parity = import("../parity/v2-snapshot-parity.js");',
    'const worker = require("../materialization/stable-compatibility-directory.js");',
    'async function load() { return import("../orchestrator/retrieval/evaluation.js"); }',
    'const load = () => require("../orchestrator/runtime/projection-runtime.js");',
    'const controlPlane = await import("../orchestrator/rollout/rollout-control-plane.js");',
    'import { cohortBucket } from "../orchestrator/rollout/rollout-cohort.js";',
    'import "../orchestrator/rollout/x.js";',
    'const controlPlane = await import ( "../orchestrator/rollout/x.js" );',
    'const controlPlane = require ( "../orchestrator/rollout/x.js" );',
    'const controlPlane = import/*x*/("../orchestrator/rollout/x.js");',
    'import/*x*/"../orchestrator/rollout/x.js";',
    'const controlPlane = require/*x*/("../orchestrator/rollout/x.js");',
    'const controlPlane = import// x\n("../orchestrator/rollout/x.js");',
    'import// x\n"../orchestrator/rollout/x.js";',
    'const controlPlane = require// x\n("../orchestrator/rollout/x.js");',
  ]) {
    assert.throws(() => assertNoV2EntryWiring(forbiddenWiring), /V2 entry wiring/);
    assert.throws(
      () => assertProductionIsolation([{ path: "src/index.ts", contents: forbiddenWiring }]),
      /V2_PRODUCTION_ISOLATION/,
    );
  }
});

test("shadow isolation rejects public migration/parity tools and environment activation on every entry", () => {
  for (const path of PRODUCTION_ENTRY_SOURCE_PATHS) {
    for (const contents of [
      'server.registerTool("memory_migrationRun", {});',
      'server.registerTool("memory_parityCompare", {});',
      'server.registerTool("memory_appendEvent", {});',
      'import "../../tests/support/fresh-start-fixture.js";',
      'if (process.env.V2_SHADOW_ENABLED) activate();',
      'if (process.env["V2_MIGRATION_ENABLED"]) activate();',
    ]) assert.throws(() => assertProductionIsolation([{ path, contents }]), /V2_PRODUCTION_ISOLATION/);
  }
});

test("prepared composition permits exact reviewed edges while refusing fresh-start wiring in V1", () => {
  assert.doesNotThrow(() => assertProductionIsolation(PRODUCTION_ENTRY_SOURCE_PATHS.map(path => ({ path, contents: source(path) }))));
  for (const [path, specifier] of [
    ["src/index.ts", "./orchestrator/fresh-start/fresh-start-control-plane.js"],
    ["src/app.ts", "./orchestrator/fresh-start/fresh-start-control-plane.js"],
    ["src/v2.ts", "./orchestrator/fresh-start/fresh-start-control-plane.js"],
    ["src/v2/app.ts", "../orchestrator/fresh-start/fresh-start-control-plane.js"],
  ] as const) {
    assert.throws(() => assertProductionIsolation([{ path,
      contents: `import { activate } from "${specifier}";` }]), /unapproved prepared composition edge/);
  }
});

test("prepared composition rejects normalized executable entry imports from the worker", () => {
  for (const contents of [
    'import "../v2.js";',
    'import "../v2-admin.js";',
    'const entry = import("../v2.js");',
    'const entry = require("../v2-admin.js");',
    'export { runV2Server } from "../v2.js";',
    'import "../v2/../v2.js";',
  ]) assert.throws(() => assertProductionIsolation([{ path: "src/workers/project-store.worker.ts", contents }]),
    /unapproved prepared composition edge/, contents);
});

test("prepared composition rejects unapproved same-directory composition imports", () => {
  for (const contents of [
    'import "./composition.js";',
    'const composition = import("./composition.js");',
    'const composition = require("./composition.js");',
    'export { createV2Foundation } from "./composition.js";',
    'import "./../v2/./composition.js";',
  ]) assert.throws(() => assertProductionIsolation([{ path: "src/v2/build-identity.ts", contents }]),
    /unapproved prepared composition edge/, contents);
});

for (const [label, path, specifier] of [
  ["Unicode executable entry", "src/workers/project-store.worker.ts", String.raw`../v\u0032.js`],
  ["hex executable entry", "src/workers/project-store.worker.ts", String.raw`../v\x32-admin.js`],
  ["escaped same-directory composition", "src/v2/build-identity.ts", String.raw`\u002e/composition.js`],
] as const) test(`prepared composition rejects unsupported escaped literals: ${label}`, () => {
  for (const contents of [
    `import "${specifier}";`,
    `import { value } from '${specifier}';`,
    `const entry = import("${specifier}");`,
    `const entry = require('${specifier}');`,
    `export * from "${specifier}";`,
  ]) assert.throws(() => assertProductionIsolation([{ path, contents }]),
    /V2_PRODUCTION_ISOLATION: unsupported escaped module literal/, contents);
});

test("prepared composition rejects unsupported template module arguments", () => {
  for (const contents of [
    'const entry = import(`../v2.js`);',
    'const entry = require(`../v2-admin.js`);',
    'const entry = import(/* trivia */ `../v${2}.js`);',
  ]) assert.throws(() => assertProductionIsolation([{ path: "src/workers/project-store.worker.ts", contents }]),
    /V2_PRODUCTION_ISOLATION: unsupported template module argument/, contents);
});

test("prepared composition authorizes normalized caller-target pairs rather than import spelling", () => {
  for (const contents of [
    'import "../v2/build-identity.js";',
    'import "../v2/../v2/./build-identity.js";',
  ]) assert.doesNotThrow(() => assertProductionIsolation([{ path: "src/workers/project-store.worker.ts", contents }]));
  assert.doesNotThrow(() => assertProductionIsolation([{ path: "src/v2/app.ts", contents: 'import "./composition.js";' }]));
});

for (const [label, argumentsSource] of [
  ["concatenation", '"../v2" + ".js"'],
  ["parenthesized", '("../v2.js")'],
  ["variable", 'target'],
  ["conditional", 'true ? "../v2.js" : "node:fs"'],
  ["comma expression", '(0, "../v2.js")'],
  ["spread", '...["../v2.js"]'],
  ["missing", ''],
  ["extra argument", '"node:fs", "../v2.js"'],
  ["type assertion", '"../v2.js" as string'],
] as const) test(`prepared composition rejects complete unsupported call shape: ${label}`, () => {
  for (const loader of ["import", "require"]) {
    for (const trivia of ["", " /* before */ ", " // before\n"]) {
      const contents = `const target = "../v2.js"; const entry = ${loader}${trivia}( /* argument */ ${argumentsSource} /* end */ );`;
      assert.throws(() => assertProductionIsolation([{ path: "src/workers/project-store.worker.ts", contents }]),
        /V2_PRODUCTION_ISOLATION: unsupported module call shape/, contents);
    }
  }
});

test("prepared composition accepts complete canonical syntax with trivia and static exports", () => {
  for (const contents of [
    'const entry = import /* before */ ( /* argument */ "../v2/build-identity.js" /* end */ );',
    "const entry = require // before\n ( // argument\n '../v2/../v2/./build-identity.js' // end\n );",
    'import /* before */ { inspect } from /* target */ "../v2/build-identity.js";',
    'export /* before */ { inspect } from /* target */ "../v2/build-identity.js";',
    'export * from "../v2/build-identity.js";',
  ]) assert.doesNotThrow(() => assertProductionIsolation([{ path: "src/workers/project-store.worker.ts", contents }]), contents);
});

test("Subproject 3 evaluation guard covers every production entry surface", () => {
  for (const path of EXTENDED_PRODUCTION_ENTRY_PATHS) {
    assert.ok(
      PRODUCTION_ENTRY_SOURCE_PATHS.includes(path)
        || PRODUCTION_ENTRY_SOURCE_PATHS.some((candidate) => candidate.startsWith(`${path}/`)),
      `${path} must be scanned for V2 routing`,
    );
  }
});

test("Subproject 3 focused gate includes lifecycle isolation and rejects answer-derived evaluation", () => {
  const packageJson = JSON.parse(source("package.json")) as { scripts?: Record<string, string> };
  assert.equal(
    packageJson.scripts?.["test:rollout-control-plane"],
    "npm run test:build && node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/rollout-control-plane.test.js dist-test/tests/migration-registry.test.js dist-test/tests/project-store-bootstrap.test.js dist-test/tests/project-store-upgrade.test.js dist-test/tests/project-store-upgrade-phase-runner.test.js dist-test/tests/ci-lifecycle-gates.test.js",
    "test:rollout-control-plane must be exact and ordered",
  );
  const script = subproject3Script();
  assertRequiredSubprojectThreeFocusedTests(script);
  assert.match(
    script,
    /dist-test\/tests\/rollout-control-plane\.test\.js dist-test\/tests\/ci-lifecycle-gates\.test\.js/,
    "rollout-control-plane must run immediately before ci-lifecycle-gates",
  );
  for (const target of REQUIRED_SUBPROJECT_THREE_FOCUSED_TESTS) {
    assert.throws(
      () => assertRequiredSubprojectThreeFocusedTests(script.replace(`${target}.test.js`, "")),
      new RegExp(target.replace(/[.]/g, "\\.")),
    );
  }

  assert.throws(
    () => assertProductionIsolation([{
      path: "src/index.ts",
      contents: `${source("src/index.ts")}\nserver.registerTool("memory_retrievalV2", {});`,
    }]),
    /V2_PRODUCTION_ISOLATION/,
  );
  assert.throws(
    () => assertProductionIsolation([{
      path: "tests/retrieval-evaluation.test.ts",
      contents: `${source("tests/retrieval-evaluation.test.ts")}\nconst answerReplay = new Map();`,
    }]),
    /V2_PRODUCTION_ISOLATION/,
  );
  assert.doesNotThrow(() => assertProductionIsolation([
    ...PRODUCTION_ENTRY_SOURCE_PATHS.map((path) => ({ path, contents: source(path) })),
    { path: "tests/retrieval-evaluation.test.ts", contents: source("tests/retrieval-evaluation.test.ts") },
  ]));
});

test("Subproject 3 evaluation and projection runtime remain internal-only", () => {
  const toolNames = productionToolNames();
  assert.equal(toolNames.includes("memory_retrievalExplain"), false);
  assert.equal(
    toolNames.some((name) => /^memory_(?:retrieval|projection)/.test(name)),
    false,
    "no Version 2 retrieval or projection tool may be registered",
  );

  const script = subproject3Script();
  assert.match(script, /npm run test:build/);
  assert.match(script, /projection-runtime\.test\.js/);
  assert.match(script, /retrieval-evaluation\.test\.js/);
  assert.match(script, /ci-lifecycle-gates\.test\.js/);
  assert.ok(
    script.indexOf("projection-runtime.test.js") < script.indexOf("retrieval-evaluation.test.js"),
    "the runtime matrix must finish before corpus evaluation",
  );
  assert.ok(
    script.indexOf("retrieval-evaluation.test.js") < script.indexOf("ci-lifecycle-gates.test.js"),
    "corpus evaluation must finish before the isolation gate",
  );

  const protectedDiff = execFileSync(
    "git",
    ["diff", "--name-only", BASE, "--", ...PROTECTED_VERSION_ONE_PATHS],
    { cwd: fileURLToPath(ROOT), encoding: "utf8" },
  ).trim();
  assert.equal(protectedDiff, "", "Version 1 production paths must remain byte-unchanged");
  const sealedSourceDiff = execFileSync(
    "git",
    ["diff", "--name-only", SEALED_EVALUATOR_BASE, "--", "src"],
    { cwd: fileURLToPath(ROOT), encoding: "utf8" },
  ).trim();
  assert.deepEqual(
    sealedSourceDiff === "" ? [] : sealedSourceDiff.split(/\r?\n/),
    APPROVED_SEALED_AND_ROLLOUT_SOURCE_DIFF,
    "only the approved sealed-source remediations may change production source after the sealed evaluator baseline",
  );
  for (const path of PRODUCTION_ENTRY_SOURCE_PATHS) {
    assertNoV2EntryWiring(source(path));
    assert.doesNotMatch(
      source(path),
      /\bmemory_(?:retrieval|projection)\w*/,
      `${path} must not expose a Version 2 retrieval or projection tool`,
    );
  }

  const runtime = source("src/orchestrator/runtime/projection-runtime.ts");
  assert.doesNotMatch(runtime, /(?:\bV2\b|\/v2-[\w-]*|\bv2-[\w-]*)/i, "V2 must remain evaluator-only");

  const evaluator = source("tests/retrieval-evaluation.test.ts");
  const measuredEvaluator = source("src/orchestrator/retrieval/evaluation.ts");
  const realV2Test = realV2HarnessTestBody(evaluator);
  const realV2Bridge = realV2BridgeImplementation(evaluator);
  const sealedRequest = sealedEvaluationRequestFactory(measuredEvaluator);
  assertSealedEvaluationRequestFactory(sealedRequest);
  assertRealBridgeDataflow(realV2Bridge);
  assert.match(
    realV2Test,
    /const bridge = await createV2EvaluationBridge\(\s*harness\.primaryV2Coordinator,\s*harness\.primary\.binding,\s*\);[\s\S]*?const v2Report = await evaluateSealedRetrieval\(\s*harness\.corpus,\s*bridge\.service\s*\);/,
    "the named V2 harness test must bridge its primary coordinator before sealed retrieval",
  );
  assert.match(
    realV2Bridge,
    /const originalLease = await coordinator\.leasePublishedForEvaluation\(binding\);/,
    "the bounded V2 bridge must acquire its coordinator evaluation lease",
  );
  assert.match(
    realV2Bridge,
    /const original = originalLeases\.get\(lease\);[\s\S]*?return adapter\.collectEligible\(original, request\);/,
    "the bounded V2 bridge must adapt eligible candidates from the preserved lease",
  );
  const reportAssertion = evaluator.indexOf('assert.equal(v2Report.corpusVersion, "retrieval-evaluation-v2")');
  const reportWrite = evaluator.indexOf("process.stdout.write");
  assert.ok(reportAssertion >= 0 && reportWrite > reportAssertion, "V2 report version must be checked before output");
  assert.match(
    evaluator,
    /process\.env\.RETRIEVAL_EVALUATION_REAL_REPORT === "sealed-v2"/,
    "only the sealed runner may enable the aggregate V2 report",
  );

  const invalid = runRetrievalEvaluation(
    "dist-test/tests/retrieval-evaluation.test.js",
    "dist-test/tests/ci-lifecycle-gates.test.js",
  );
  assert.notEqual(invalid.status, 0, "the runner must reject a second test target");
  assert.match(`${invalid.stdout}\n${invalid.stderr}`, /RETRIEVAL_EVALUATION_TARGET_INVALID/);

  const normal = runRetrievalEvaluation();
  assert.equal(normal.status, 0, normal.stderr);
  assert.match(normal.stdout, /^\{[^\n]*"corpusVersion":"retrieval-evaluation-v2"[^\n]*\}\r?\n$/);
  const aggregate = JSON.parse(normal.stdout) as Record<string, unknown>;
  assert.equal(aggregate.corpusVersion, "retrieval-evaluation-v2");
  assert.doesNotMatch(
    normal.stdout,
    /queryText|expectedCitations|relevanceGrades|projectId|source-events|judgments\.json|v1-shadow-baseline|[A-Za-z]:\\|\/tmp\//,
    "runner output must contain only the aggregate V2 report",
  );
});
