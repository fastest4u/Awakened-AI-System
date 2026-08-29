import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const evaluationTest = fileURLToPath(new URL(
  "../dist-test/tests/retrieval-evaluation.test.js",
  import.meta.url,
));

const TARGET_INVALID = "RETRIEVAL_EVALUATION_TARGET_INVALID";
const REPORT_INVALID = "RETRIEVAL_EVALUATION_REPORT_INVALID";
const TEST_FAILED = "RETRIEVAL_EVALUATION_TEST_FAILED";
const REPORT_ENVIRONMENT = "sealed-v2";
const REPORT_CORPUS_VERSION = "retrieval-evaluation-v2";
const LANGUAGE_KEYS = ["en", "th", "mixed"];
const CLASS_KEYS = [
  "identifiers", "code-artifacts", "session-continuity", "follow-ups", "stale-superseded-facts",
  "conflicts", "cross-project-near-duplicates", "semantic-paraphrases", "temporal-boundaries",
];
const COUNT_KEYS = ["queryCount", "failedQueryCount", "crossProjectContamination", "unsupportedHighImpactVerifiedClaims"];
const METRIC_KEYS = [
  "recallAt10", "mrr", "ndcgAt10", "citationPrecision", "citationRecall", "staleActiveMemoryRate",
  "exactIdentifierPathRecall", "currentSessionCheckpointRecallAt10", "openFollowUpRecallAt10",
  "nextActionRecallAt10", "semanticParaphraseRecallAt10", "bitemporalAccuracy", "conflictRecall", "conflictPrecision",
];
const REPORT_KEYS = ["corpusVersion", ...COUNT_KEYS, "languageCounts", "criticalClassCounts", ...METRIC_KEYS];
const { NODE_TEST_CONTEXT: _nodeTestContext, ...runnerEnvironment } = process.env;

function requestedEvaluationTarget() {
  if (process.argv.length > 3) throw new Error(TARGET_INVALID);
  const requested = process.argv[2] === undefined
    ? evaluationTest
    : resolve(root, process.argv[2]);
  if (requested !== evaluationTest || !existsSync(evaluationTest)) throw new Error(TARGET_INVALID);
  return requested;
}

function aggregateReport(output) {
  const reports = [];
  for (const line of output.split(/\r?\n/)) {
    const candidate = line.trim().replace(/^#\s*/, "");
    if (!candidate.startsWith("{")) continue;
    let report;
    try {
      report = JSON.parse(candidate);
    } catch {
      throw new Error(REPORT_INVALID);
    }
    reports.push(JSON.stringify(validReport(report)));
  }
  if (reports.length !== 1) throw new Error(REPORT_INVALID);
  return reports[0];
}

function exactRecord(value, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(REPORT_INVALID);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) throw new Error(REPORT_INVALID);
  return value;
}

function nonnegative(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(REPORT_INVALID);
  return value;
}

function unitInterval(value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(REPORT_INVALID);
  return value;
}

function validReport(value) {
  const report = exactRecord(value, REPORT_KEYS);
  if (report.corpusVersion !== REPORT_CORPUS_VERSION) throw new Error(REPORT_INVALID);
  for (const key of COUNT_KEYS) nonnegative(report[key]);
  if (report.failedQueryCount > report.queryCount) throw new Error(REPORT_INVALID);
  const languageCounts = exactRecord(report.languageCounts, LANGUAGE_KEYS);
  const criticalClassCounts = exactRecord(report.criticalClassCounts, CLASS_KEYS);
  for (const key of LANGUAGE_KEYS) nonnegative(languageCounts[key]);
  for (const key of CLASS_KEYS) nonnegative(criticalClassCounts[key]);
  for (const key of METRIC_KEYS) unitInterval(report[key]);
  return report;
}

function runEvaluation() {
  const target = requestedEvaluationTarget();
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=tap",
      target,
    ], {
      cwd: root,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...runnerEnvironment, RETRIEVAL_EVALUATION_REAL_REPORT: REPORT_ENVIRONMENT },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

function propagateExit(result) {
  if (result.signal !== null) {
    try {
      process.kill(process.pid, result.signal);
    } catch {
      process.exit(1);
    }
    return;
  }
  if (result.code !== 0) throw new Error(TEST_FAILED);
  process.stdout.write(`${aggregateReport(`${result.stdout}\n${result.stderr}`)}\n`);
}

runEvaluation().then(propagateExit).catch((error) => {
  console.error(error instanceof Error ? error.message : "RETRIEVAL_EVALUATION_FAILED");
  process.exit(1);
});
