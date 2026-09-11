# Task 8 implementation report

Status: DONE_WITH_CONCERNS — final covering gate passes; no clean single amended full-gate run yet.

Worktree: `C:/Users/Server/.codex/worktrees/subproject-3-projections`
Branch: `codex/subproject-3-projections`
Base: `5890fe68430177ce46960d95750120a72f270edf`
Runtime: Node `v24.16.0`.

## Implemented

- Internal deterministic V1-reference baseline preparation and V2-shadow publication, using package creation time for generation content and numeric monotonic operation time for coordinator deadlines.
- V1 baseline checksum with the specified canonical logical-field domain. V1 preparation occurs before revision/import in the real fixture; publication verifies the immutable rollout revision baseline and ledger/source/package identities.
- V2 publication uses only `V2ImportedProjectionEventReader`, followed by a separate committed-snapshot integrity check and reliable snapshot close. Original events are authenticated, decoded, folded, and bounded by terminal/count/full-row-byte checks, then compared against descriptor-pinned published bytes with existing schema/row/reference/FTS verification.
- V1 reopens descriptor-pinned bytes as a private in-memory image and reuses the legacy builder verification helpers. The FTS integrity INSERT cannot mutate the published image. Source/package/directory/image checks precede atomic manifest publication.
- Lease-serialized durable V1 manifest publication, repeat adoption without byte changes, and recovery of exactly `projections-1-1.sqlite` after the generation-before-manifest crash boundary. Recovery derives metadata from verified source/package, replays expected checksums, validates exact schema and stored metadata including creation time, and hashes the pinned verified image.
- Exact production UUIDv4-or-legacy-SHA256 project/vault/store predicates in both projection SQL schemas; workspace remains SHA256. Known historical SQL schemas are preserved verbatim and accepted only with all three authenticated legacy-hash binding identities. No row-layout or schema-version changes.

## Approved scope adjustments

Controller approved the narrow `builder.ts` private-image verification helper; bounded orphan recovery and manifest adoption; and `schema.ts` plus direct `projection-schema.test.ts` identity regression coverage. Controller owns the modified plan and the task brief; neither is included in this implementation commit.

## TDD evidence

1. Module-absence RED:

   `npm run test:build`

   Exit 1: `tests/v2-shadow-projection.test.ts(10,75): error TS2307: Cannot find module '../src/orchestrator/migration/v2-shadow-projection.js' or its corresponding type declarations.`

   `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-projection.test.js`

   Before successful compilation: `Could not find 'dist-test/tests/v2-shadow-projection.test.js'`.

2. Committed-snapshot seam RED:

   `npm run test:build`

   Exit 1: four TS2339 errors for absent `ProjectionIntegrityService.verifyCommittedSnapshot`, plus the expected absent publisher module.

3. Production identity behavior RED:

   `node --test --test-reporter=spec --test-name-pattern='production identity domain' dist-test/tests/projection-schema.test.js`

   2 tests, 0 pass, 2 fail. Both actual SQLite schemas rejected a production UUID with `CHECK constraint failed: project_id IS NULL OR (length(project_id) = 64 AND project_id NOT GLOB '*[^0-9a-f]*')`.

4. Crash-boundary RED:

   `node --test --test-name-pattern='recovers after generation' --test-reporter=spec dist-test/tests/v2-shadow-projection.test.js`

   1 test, 0 pass, 1 fail: `AssertionError: Missing expected rejection.` The generation-before-manifest injection boundary was absent.

5. Unknown lazy-reader-error RED:

   `node --test --test-reporter=spec --test-name-pattern='authenticates original events and checks' dist-test/tests/projection-integrity.test.js`

   1 test, 0 pass, 1 fail: expected the redacted migration ledger error; actual `LifecycleError: INTEGRITY_FAILURE`. The generator boundary now preserves Task 7 classifications and redacts unknown reader failures.

## Focused GREEN evidence before final gate

- `npm run test:build`: exit 0.
- Publication + schema suites: 9/10 passing before crash recovery implementation; only named crash RED remained.
- `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-projection.test.js`: 6/6 passing after crash recovery, including unchanged V1 adoption, successful publication, both generation tamper cases, and wrapper tamper.
- `node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern='committed snapshot integrity' dist-test/tests/projection-integrity.test.js`: 2/2 passing, including exact historical V1/V2 images and authenticated committed snapshot checks.
- `npm run typecheck`: exit 0.

## Final gate and verification caveat

The amended six-file gate was started with:

`node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-projection.test.js dist-test/tests/projection-builder.test.js dist-test/tests/projection-coordinator.test.js dist-test/tests/projection-integrity.test.js dist-test/tests/v2-reader-lease.test.js dist-test/tests/projection-schema.test.js`

A later test-only rebuild overlapped that long run: only the added non-busy `EventStoreError` case in the new committed-snapshot test changed. No shared/default production runtime changed during that overlap. This overlap is disclosed rather than treated as isolated gate evidence. A separate focused attempt during concurrent runs failed during fixture creation with `PROJECTION_PATH_INVALID`, caused by a native stable-directory `spawnSync` ETIMEDOUT; it is not counted as behavior RED.

The six-file gate exited 1: **133 tests, 128 pass, 5 fail, 0 skip**, duration 790873.4299 ms. All ten publisher tests passed. Two coordinator failures were `MATERIALIZATION_CONFLICT` at publication-lease finish/begin. Two other coordinator failures were `PROJECTION_PATH_INVALID` with explicit native `spawnSync ... ETIMEDOUT` causes. The fifth failure was the newly added non-busy `EventStoreError` taxonomy regression. Host measurements supplied by the controller showed CPU pressure, but that is not asserted to prove a load-only root cause.

After this gate exited, the same isolated taxonomy command reproduced the intended 1-test RED (actual LifecycleError, expected migration ledger integrity). The private new-seam fix preserves only native/typed primary busy as retryable; non-busy EventStoreError is now an unknown reader error, redacted to ledger integrity. This change does not touch existing `verify()` or coordinator/lease behavior.

The four failed coordinator cases were rerun, without configuration, timeout, retry, or coordinator edits:

`node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern='reconciles before opening a source snapshot for a non-fresh V2 request|removes a verified V2 orphan before a non-fresh source failure|does not reconcile a final V2 generation named by the lease registry|acquires a published V2 evaluator lease from a stable private image' dist-test/tests/projection-coordinator.test.js`

Exit 0: **4 tests, 4 pass, 0 fail, 0 skip**, 32416.4485 ms. Their failing stacks were in existing publication lease/stable-directory operations. Task 8 changes the accepted projection metadata schema and exact schema-image checks, but not these timeout/lease operations; the same compiled shared code passed isolated reproduction. This resolves reproducibility in that isolated run, not the absence of a clean full gate.

Final self-review additionally strengthened the immutable revision test to change the baseline on the exact referenced revision (rather than fail an earlier revision-ID mismatch), and added an early protected-target guard in the new publisher. Path-guard RED command:

`node --test --test-reporter=spec --test-name-pattern='rejects a protected source destination' dist-test/tests/v2-shadow-projection.test.js`

Exit 1: **1 test, 0 pass, 1 fail**, expected no target connection access, actual `1 !== 0`. The final guard rejects source/package/live/projection containment and source-file identity aliases before consulting the mutation-capable target connection. These final amendments affect only the new publisher/new committed-snapshot method and their new tests. The controller explicitly directed a final publisher/integrity covering gate plus typecheck, reserving a clean amended full gate until after independent review.

## Files

- `src/orchestrator/migration/v2-shadow-projection.ts`
- `src/orchestrator/projections/builder.ts`
- `src/orchestrator/projections/integrity.ts`
- `src/orchestrator/projections/schema.ts`
- `tests/v2-shadow-projection.test.ts`
- `tests/projection-integrity.test.ts`
- `tests/projection-schema.test.ts`
- This task report.

## Self-review

Checked identity/terminal/package/revision binding, byte-domain accounting, private-image ownership, source and generation immutability, startup adoption, exact historical schema compatibility, safe error redaction, and scoped diff. Found and addressed the native snapshot test's single-use iteration assumption and the lazy-reader unknown-error classification gap. `git diff --check` passed; Git emitted existing LF-to-CRLF conversion warnings only. No public composition, V2 registration, rollout activation, live-store/vault mutations, dependencies, or runtime-floor changes were made.

## Final verification

After the final source changes, `npm run test:build` exited 0, followed by:

`node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-projection.test.js dist-test/tests/projection-integrity.test.js`

Exit 0: **49 tests, 49 pass, 0 fail, 0 skip**, 218005.4821 ms. Output includes both historical-image and committed-snapshot cases, all 36 existing integrity replay cases, and all 11 publisher cases. This is GREEN for the final non-busy error taxonomy branch, exact referenced-revision baseline mismatch, and early protected-source target guard. Output was clean.

The four isolated coordinator regressions also passed 4/4 on the same unchanged shared/default runtime. The original full-gate result remains 128/133; it is not claimed as a clean full pass. A clean amended six-file gate remains a controller follow-up after independent review.

Final `npm run typecheck` exited 0 after all source/test changes. Final `git diff --check` exited 0; only Git's LF-to-CRLF conversion warnings appeared. Self-review is complete. The only remaining concern is absence of one clean amended full-gate run; the controller owns independent review and that final full gate. Commit subject: `feat: verify V2 shadow projections`. Only the seven scoped source/test files and this report are staged; the controller-owned plan is excluded. The separate gate-output artifact is retained locally, and its final failure section is preserved in full below.

## Preserved six-file gate final output and failure traces

```text
✔ publishes both projection generations at the exact source position (9933.4489ms)
✔ adopts a prepared V1 baseline without rewriting its published bytes (5407.7855ms)
✔ recovers after generation installation before baseline manifest without rewriting the image (28442.5681ms)
✔ refuses orphan adoption after UPDATE corruption (7375.1843ms)
✔ refuses orphan adoption after CREATE corruption (8453.7849ms)
✔ refuses orphan adoption after UPDATE corruption (6969.0441ms)
✔ rejects an immutable revision with a different baseline (6778.2815ms)
✔ does not record projection-verified after V1 generation tamper (8902.3622ms)
✔ does not record projection-verified after V2 generation tamper (12023.79ms)
✔ rejects committed wrapper tamper before projection verification (8152.8463ms)
ℹ tests 133
ℹ suites 7
ℹ pass 128
ℹ fail 5
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 790873.4299

✖ failing tests:

test at dist-test\tests\projection-coordinator.test.js:1083:5
✖ reconciles before opening a source snapshot for a non-fresh V2 request (35353.3731ms)
  Error [LifecycleError]: MATERIALIZATION_CONFLICT: Compatibility materialization could not be reconciled
      at materializationConflict (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/manifest.js:84:11)
      at finishManifestPublicationAttempt (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/manifest.js:592:20)
      at Object.release (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/manifest.js:628:13)
      at file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/coordinator.js:500:23
      at async #serialized (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/coordinator.js:964:20)
      at async TestContext.<anonymous> (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/tests/projection-coordinator.test.js:1096:9)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Suite.processPendingSubtests (node:internal/test_runner/test:897:7) {
    code: 'MATERIALIZATION_CONFLICT',
    retryable: true,
    safeMessage: 'Compatibility materialization could not be reconciled',
    recoveryActions: [ 'reconcile-materialization' ]
  }

test at dist-test\tests\projection-coordinator.test.js:1111:5
✖ removes a verified V2 orphan before a non-fresh source failure (5736.1958ms)
  Error [LifecycleError]: MATERIALIZATION_CONFLICT: Compatibility materialization could not be reconciled
      at materializationConflict (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/manifest.js:84:11)
      at beginManifestPublicationAttempt (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/manifest.js:552:20)
      at acquireProjectionManifestPublicationLease (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/manifest.js:617:21)
      at file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/coordinator.js:429:27
      at #serialized (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/coordinator.js:964:26)
      at async TestContext.<anonymous> (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/tests/projection-coordinator.test.js:1124:9)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Suite.processPendingSubtests (node:internal/test_runner/test:897:7) {
    code: 'MATERIALIZATION_CONFLICT',
    retryable: true,
    safeMessage: 'Compatibility materialization could not be reconciled',
    recoveryActions: [ 'reconcile-materialization' ]
  }

test at dist-test\tests\projection-coordinator.test.js:1147:5
✖ does not reconcile a final V2 generation named by the lease registry (11666.4603ms)
  AssertionError [ERR_ASSERTION]: The input did not match the regular expression /post-install/u. Input:
  
  'Error: PROJECTION_PATH_INVALID'
  
      at async TestContext.<anonymous> (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/tests/projection-coordinator.test.js:1164:9)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Suite.processPendingSubtests (node:internal/test_runner/test:897:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: Error: PROJECTION_PATH_INVALID
        at invalid (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/stable-directory.js:839:11)
        at runStableMutation (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/stable-directory.js:895:16)
        at Object.captureManifest (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/stable-directory.js:1228:39)
        ... 5 lines matching cause stack trace ...
        at async strict.rejects (node:assert:769:25)
        at async TestContext.<anonymous> (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/tests/projection-coordinator.test.js:1164:9) {
      [cause]: Error: spawnSync C:\Program Files\nodejs\node.exe ETIMEDOUT
          at Object.spawnSync (node:internal/child_process:1143:20)
          at spawnSync (node:child_process:911:24)
          at runStableMutation (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/stable-directory.js:871:20)
          at Object.captureManifest (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/stable-directory.js:1228:39)
          at #loadPublishedLocked (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/coordinator.js:586:72)
          at #reconcileEntry (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/coordinator.js:614:49)
          at file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/coordinator.js:436:56
          at #serialized (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/coordinator.js:964:26)
          at async waitForActual (node:assert:646:5)
          at async strict.rejects (node:assert:769:25)
    },
    expected: /post-install/u,
    operator: 'rejects',
    diff: 'simple'
  }

test at dist-test\tests\projection-coordinator.test.js:1176:5
✖ acquires a published V2 evaluator lease from a stable private image (26008.8449ms)
  Error: PROJECTION_PATH_INVALID
      at invalid (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/stable-directory.js:839:11)
      at runStableMutation (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/stable-directory.js:895:16)
      at Object.cleanupKnownTemps (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/stable-directory.js:1144:13)
      ... 5 lines matching cause stack trace ...
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Suite.processPendingSubtests (node:internal/test_runner/test:897:7) {
    [cause]: Error: spawnSync C:\Program Files\nodejs\node.exe ETIMEDOUT
        at Object.spawnSync (node:internal/child_process:1143:20)
        at spawnSync (node:child_process:911:24)
        at runStableMutation (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/stable-directory.js:871:20)
        at Object.cleanupKnownTemps (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/stable-directory.js:1144:13)
        at #cleanupKnownTemps (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/coordinator.js:881:59)
        at file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/coordinator.js:446:40
        at #serialized (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/coordinator.js:964:26)
        at async publishedV2CoordinatorFixture (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/tests/projection-coordinator.test.js:189:5)
        at async TestContext.<anonymous> (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/tests/projection-coordinator.test.js:1177:25)
        at async Test.run (node:internal/test_runner/test:1313:7) {
      errno: -4039,
      code: 'ETIMEDOUT',
      syscall: 'spawnSync C:\\Program Files\\nodejs\\node.exe',
      path: 'C:\\Program Files\\nodejs\\node.exe',
      spawnargs: [ '-e', '\n"use strict";\nconst { createHash } = require("node:crypto");\nconst {\n  closeSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,\n  realpathSync, readdirSync, linkSync, renameSync, unlinkSync, writeSync,\n} = require("node:fs");\nconst { basename, resolve } = require("node:path");\nconst [\n  operation, expectedPath, expectedDevice, expectedInode, ...operationArguments\n] = process.argv.slice(1);\nconst MAX_MANIFEST_BYTES = 65536;\nconst MAX_GENERATION_BYTES = 536870912;\nconst MANIFEST_NAME = "projection-manifest.json";\nconst MANIFEST_TEMP_NAME = ".projection-manifest.json.tmp";\nconst LOCK_NAME = ".projection-manifest.publish.lock";\nconst RECONCILIATION_JOURNAL_NAME = "projection-reconciliation-v2.json";\nconst RECONCILIATION_JOURNAL_TEMP_NAME = ".projection-reconciliation-v2.json.tmp";\nconst TOKEN = /^[0-9a-f]{32}$/u;\nconst V2_GENERATION = /^projections-2-([1-9][0-9]{0,9})\\.sqlite$/u;\nconst V2_RETIRED = /^\\.projections-2-retired-([0-9a-f]{32})\\.sqlite$/u;\nconst normalized = (path) => {\n  const value = resolve(path);\n  return process.platform === "win32" ? value.toLowerCase() : value;\n};\nconst invalid = () => { throw new Error("PROJECTION_PATH_INVALID"); };\nconst integrity = () => { throw new Error("INTEGRITY_FAILURE"); };\nconst assertDirectory = () => {\n  const directory = lstatSync(".", { bigint: true });\n  if (!directory.isDirectory() || directory.isSymbolicLink()) invalid();\n  if (\n    normalized(realpathSync.native(".")) !== normalized(expectedPath)\n    || directory.dev.toString() !== expectedDevice\n    || directory.ino.toString() !== expectedInode\n  ) invalid();\n  return directory;\n};\nconst captureManifest = () => {\n  const manifestName = MANIFEST_NAME;\n  let before;\n  try {\n    before = lstatSync(manifestName, { bigint: true });\n  } catch (error) {\n    if (error && error.code === "ENOENT") {\n      const directory = assertDirectory();\n      return {\n        state: "missing",\n        directoryDevice: directory.dev.toString(),\n        directoryInode: directory.ino.toString(),\n      };\n    }\n    throw error;\n  }\n  if (\n    !before.isFile()\n    || before.isSymbolicLink()\n    || before.size < 0n\n    || before.size > BigInt(MAX_MANIFEST_BYTES)\n  ) invalid();\n  let handle;\n  try {\n    handle = openSync(manifestName, "r");\n    const opened = fstatSync(handle, { bigint: true });\n    if (\n      !opened.isFile()\n      || opened.dev !== before.dev\n      || opened.ino !== before.ino\n      || opened.size !== before.size\n    ) invalid();\n    const bytes = readFileSync(handle);\n    const openedAfter = fstatSync(handle, { bigint: true });\n    const after = lstatSync(manifestName, { bigint: true });\n    if (\n      bytes.byteLength !== Number(before.size)\n      || openedAfter.dev !== opened.dev\n      || openedAfter.ino !== opened.ino\n      || openedAfter.size !== opened.size\n      || after.dev !== before.dev\n      || after.ino !== before.ino\n      || after.size !== before.size\n      || !after.isFile()\n      || after.isSymbolicLink()\n    ) invalid();\n    const directory = assertDirectory();\n    return {\n      state: "present",\n      directoryDevice: directory.dev.toString(),\n      directoryInode: directory.ino.toString(),\n      device: opened.dev.toString(),\n      inode: opened.ino.toString(),\n      size: opened.size.toString(),\n      sha256: createHash("sha256").update(bytes).digest("hex"),\n      bytesBase64: bytes.toString("base64"),\n    };\n  } finally {\n    if (handle !== undefined) closeSync(handle);\n  }\n};\nconst syncDirectory = () => {\n  let handle;\n  try {\n    handle = openSync(".", "r");\n    fsyncSync(handle);\n  } catch (error) {\n    const code = error && error.code;\n    if (\n      code !== "EINVAL" && code !== "EISDIR" && code !== "ENOTSUP"\n      && code !== "EOPNOTSUPP"\n      && !(process.platform === "win32" && (code === "EACCES" || code === "EBADF" || code === "EPERM"))\n    ) throw error;\n  } finally {\n    if (handle !== undefined) closeSync(handle);\n  }\n};\nconst sidecarPresent = (name) => {\n  for (const suffix of ["-wal", "-shm"]) {\n    try {\n      lstatSync(name + suffix);\n      return true;\n    } catch (error) {\n      if (error && error.code === "ENOENT") continue;\n      integrity();\n    }\n  }\n  return false;\n};\nconst captureFileIdentity = (name, maximumBytes = MAX_MANIFEST_BYTES) => {\n  const before = lstatSync(name, { bigint: true });\n  if (\n    !before.isFile()\n    || before.isSymbolicLink()\n    || before.size < 0n\n    || before.size > BigInt(maximumBytes)\n  ) invalid();\n  let handle;\n  try {\n    handle = openSync(name, "r");\n    const opened = fstatSync(handle, { bigint: true });\n    if (\n      !opened.isFile()\n      || opened.dev !== before.dev\n      || opened.ino !== before.ino\n      || opened.size !== before.size\n      || opened.ctimeNs !== before.ctimeNs\n    ) invalid();\n    const bytes = readFileSync(handle);\n    const openedAfter = fstatSync(handle, { bigint: true });\n    const after = lstatSync(name, { bigint: true });\n    if (\n      bytes.byteLength !== Number(before.size)\n      || openedAfter.dev !== opened.dev\n      || openedAfter.ino !== opened.ino\n      || openedAfter.size !== opened.size\n      || openedAfter.ctimeNs !== opened.ctimeNs\n      || after.dev !== before.dev\n      || after.ino !== before.ino\n      || after.size !== before.size\n      || after.ctimeNs !== before.ctimeNs\n      || !after.isFile()\n      || after.isSymbolicLink()\n    ) invalid();\n    assertDirectory();\n    return {\n      device: opened.dev.toString(),\n      inode: opened.ino.toString(),\n      size: opened.size.toString(),\n      ctimeNs: opened.ctimeNs.toString(),\n      sha256: createHash("sha256").update(bytes).digest("hex"),\n      bytes,\n    };\n  } finally {\n    if (handle !== undefined) closeSync(handle);\n  }\n};\nconst assertToken = (token) => {\n  if (typeof token !== "string" || !TOKEN.test(token)) invalid();\n  return token;\n};\nconst assertLock = (token) => {\n  const lock = captureFileIdentity(LOCK_NAME);\n  if (lock.bytes.toString("utf8") !== token) invalid();\n};\nconst linkIfAbsent = (source, target) => {\n  try {\n    linkSync(source, target);\n    return true;\n  } catch (error) {\n    if (error && error.code === "EEXIST") return false;\n    throw error;\n  }\n};\nconst removeRegularFile = (name) => {\n  const entry = lstatSync(name);\n  if (!entry.isFile() || entry.isSymbolicLink()) invalid();\n  unlinkSync(name);\n};\nconst fileMatchesArguments = (file, offset) => (\n  file.device === operationArguments[offset]\n  && file.inode === operationArguments[offset + 1]\n  && file.size === operationArguments[offset + 2]\n  && file.sha256 === operationArguments[offset + 3]\n);\nconst sameGenerationIdentity = (file, expected) => (\n  file.device === expected.device\n  && file.inode === expected.inode\n  && file.size === expected.size\n  && file.ctimeNs === expected.ctimeNs\n  && file.sha256 === expected.sha256\n);\nconst sameGenerationRenameContinuity = (file, expected) => (\n  file.device === expected.device\n  && file.inode === expected.inode\n  && file.size === expected.size\n  && file.sha256 === expected.sha256\n);\nconst exactKeys = (value, keys) => (\n  typeof value === "object" && value !== null && !Array.isArray(value)\n  && Reflect.ownKeys(value).length === keys.length\n  && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))\n);\nconst validGeneration = (value) => (\n  Number.isSafeInteger(value) && value >= 0 && value <= 2147483647\n);\nconst validRetirementGeneration = (value) => (\n  Number.isSafeInteger(value) && value >= 1 && value <= 2147483647\n);\nconst exactRetirementImage = (value) => {\n  if (\n    !exactKeys(value, ["device", "inode", "size", "ctimeNs", "sha256"])\n    || typeof value.device !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value.device)\n    || typeof value.inode !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value.inode)\n    || typeof value.size !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value.size)\n    || BigInt(value.size) > BigInt(MAX_GENERATION_BYTES)\n    || typeof value.ctimeNs !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value.ctimeNs)\n    || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256)\n  ) invalid();\n  return {\n    device: value.device,\n    inode: value.inode,\n    size: value.size,\n    ctimeNs: value.ctimeNs,\n    sha256: value.sha256,\n  };\n};\nconst exactRetirement = (value) => {\n  if (!validRetirementGeneration(value && value.generation)) invalid();\n  if (value.state === "intent") {\n    if (\n      !exactKeys(value, ["state", "generation", "finalFilename", "retiredFilename", "image"])\n      || typeof value.finalFilename !== "string"\n      || !V2_GENERATION.test(value.finalFilename)\n      || Number(V2_GENERATION.exec(value.finalFilename)[1]) !== value.generation\n      || typeof value.retiredFilename !== "string" || !V2_RETIRED.test(value.retiredFilename)\n    ) invalid();\n    return {\n      state: "intent",\n      generation: value.generation,\n      finalFilename: value.finalFilename,\n      retiredFilename: value.retiredFilename,\n      image: exactRetirementImage(value.image),\n    };\n  }\n  if (\n    value.state !== "retired"\n    || !exactKeys(value, ["state", "generation", "retiredFilename", "image"])\n    || typeof value.retiredFilename !== "string" || !V2_RETIRED.test(value.retiredFilename)\n  ) invalid();\n  return {\n    state: "retired",\n    generation: value.generation,\n    retiredFilename: value.retiredFilename,\n    image: exactRetirementImage(value.image),\n  };\n};\nconst canonicalJournalBytes = (journal) => Buffer.from(JSON.stringify(journal) + "\\n", "utf8");\nconst exactJournal = (bytes) => {\n  let value;\n  try { value = JSON.parse(bytes.toString("utf8")); } catch { invalid(); }\n  if (!validGeneration(value && value.highestReservedGeneration)) invalid();\n  if (exactKeys(value, ["highestReservedGeneration"])) {\n    const legacy = { highestReservedGeneration: value.highestReservedGeneration };\n    if (!canonicalJournalBytes(legacy).equals(bytes)) throw new Error("JOURNAL_FORMAT_MISMATCH");\n    return { highestReservedGeneration: legacy.highestReservedGeneration, retirements: [] };\n  }\n '... 21104 more characters, 'cleanup', 'C:\\Users\\Server\\AppData\\Local\\Temp\\projection-v2-evaluation-lease-Z1NhVG\\projections', '2297733719', '54043195529258971' ]
    }
  }

test at dist-test\tests\projection-integrity.test.js:85:5
✖ authenticates original events and checks the pinned published image without source-path replay (6638.8658ms)
  AssertionError [ERR_ASSERTION]: The validation function is expected to return "true". Received false
  
  Caught error:
  
  LifecycleError: INTEGRITY_FAILURE: Lifecycle integrity verification failed
      at TestContext.<anonymous> (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/tests/projection-integrity.test.js:95:24)
      at async Test.run (node:internal/test_runner/test:1313:7)
      at async Suite.processPendingSubtests (node:internal/test_runner/test:897:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: LifecycleError: INTEGRITY_FAILURE: Lifecycle integrity verification failed
        at integrity (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/integrity.js:78:11)
        at ProjectionIntegrityService.verifyCommittedSnapshot (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/src/orchestrator/projections/integrity.js:1113:20)
        at file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/tests/projection-integrity.test.js:95:45
        at getActual (node:assert:611:5)
        at strict.throws (node:assert:759:24)
        at TestContext.<anonymous> (file:///C:/Users/Server/.codex/worktrees/subproject-3-projections/dist-test/tests/projection-integrity.test.js:95:24)
        at async Test.run (node:internal/test_runner/test:1313:7)
        at async Suite.processPendingSubtests (node:internal/test_runner/test:897:7),
    operator: 'throws',
    diff: 'simple'
  }

```

## Independent-review fix round 1 (2026-09-11)

Base: `36c5f9d015ddd94e99d95c49072286a4bdf926b2`. Scope: publisher, narrow V1 integrity cleanup, publisher tests, and this report only. Controller plan changes are excluded.

### Changes and review response

1. Removed the independently injectable repository from `V2ShadowProjectionPublisherOptions`. Publication constructs `SqliteV2ShadowMigrationRepository` from the already file-identity-verified target connection, before its first transaction. Regression callers deliberately supply an obsolete excess repository property backed by a real unrelated or protected fixture database: neither receives a transaction; publication evidence goes to the verified target only. No live user store is opened.
2. The referenced immutable revision must match the authenticated package build identity, sealed migration identity, configuration checksum, and prepared V1 baseline. Success fixtures now use the actual identities; each unrelated revision identity has its own rejection test before V2 publication.
3. Native private-database and pinned-descriptor close failures are caught separately so both cleanup attempts occur, followed by a fresh redacted integrity failure. This changes only the new V1 verification/recovery method, not existing `verify()` or coordinator/default behavior.
4. Cleanup tests instrument real native operations: private database close, pinned descriptor close, stable-directory lease-release subprocess, and Task 7 committed reader connection close. Each operation actually releases its resource before throwing an injected sensitive error. Tests cover direct integrity redaction, remaining resource release, snapshot rollback/close, absence of the on-disk publication lock, unchanged protected main/WAL/SHM and published-image bytes, source/package unchanged assertions, and no `projection-verified` transition. No shared timeout/retry policy or cleanup implementation outside approved scope is changed.

### RED evidence

An initial `npm run test:build` exited 1 for test-only TS2322: mode `read-only` is not in the production driver union. Corrected to `read-only-existing`; subsequent build exited 0. This compiler error is not behavior RED.

Command (after successful test build):

```text
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern='unrelated revision|injected .* repository' dist-test/tests/v2-shadow-projection.test.js
```

Observed output, exit 1:

```text
FAIL rejects unrelated revision build identity: AssertionError [ERR_ASSERTION]: Missing expected rejection.
FAIL rejects unrelated revision migration identity: AssertionError [ERR_ASSERTION]: Missing expected rejection.
FAIL rejects unrelated revision configuration identity: AssertionError [ERR_ASSERTION]: Missing expected rejection.
FAIL never transacts through an injected unrelated repository: ShadowMigrationError MIGRATION_LEDGER_INTEGRITY_FAILURE
FAIL never transacts through an injected protected repository: ShadowMigrationError MIGRATION_SOURCE_MUTATED
tests 5; suites 0; pass 0; fail 5; cancelled 0; skipped 0; todo 0; duration_ms 32938.052
```

The initial protected test opened the authenticated source copy, changing its SQLite sidecar identity and triggering source authentication before repository use. That case is not counted as authority RED. It was corrected to use the isolated fixture's protected live-store path, without touching any real live store. The next serial build exited 0.

Command:

```text
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern='injected protected repository|cleanup failure' dist-test/tests/v2-shadow-projection.test.js
```

Observed output, exit 1:

```text
FAIL never transacts through an injected protected repository: ShadowMigrationError MIGRATION_LEDGER_INTEGRITY_FAILURE
FAIL redacts private-database cleanup failure and releases remaining resources:
  AssertionError [ERR_ASSERTION]: The validation function is expected to return "true". Received false
  Caught error: Error: sensitive-close-failure
  at #inspectV1Generation (dist-test/src/orchestrator/projections/integrity.js:1172:27)
  at ProjectionIntegrityService.verifyV1Generation (dist-test/src/orchestrator/projections/integrity.js:1118:51)
FAIL redacts pinned-image cleanup failure and releases remaining resources:
  AssertionError [ERR_ASSERTION]: The validation function is expected to return "true". Received false
  Caught error: Error: sensitive-close-failure
  at Object.close (dist-test/src/orchestrator/projections/integrity.js:180:17)
  at #inspectV1Generation (dist-test/src/orchestrator/projections/integrity.js:1175:25)
PASS redacts v1-lease cleanup failure and releases remaining resources
PASS redacts committed-snapshot cleanup failure and releases remaining resources
tests 5; suites 0; pass 2; fail 3; cancelled 0; skipped 0; todo 0; duration_ms 23257.8803
```

The last two tests establish already-correct cleanup behavior; they are not claimed as RED. The private image cleanup tests prove the additional direct integrity error leak before the implementation change.

### Focused GREEN

After minimal implementation fixes, `npm run test:build` exited 0. Command:

```text
node --test --test-concurrency=1 --test-reporter=spec --test-name-pattern='unrelated revision|injected .* repository|cleanup failure' dist-test/tests/v2-shadow-projection.test.js
```

Observed output, exit 0:

```text
PASS rejects unrelated revision build identity
PASS rejects unrelated revision migration identity
PASS rejects unrelated revision configuration identity
PASS never transacts through an injected unrelated repository
PASS never transacts through an injected protected repository
PASS redacts private-database cleanup failure and releases remaining resources
PASS redacts pinned-image cleanup failure and releases remaining resources
PASS redacts v1-lease cleanup failure and releases remaining resources
PASS redacts committed-snapshot cleanup failure and releases remaining resources
tests 9; suites 0; pass 9; fail 0; cancelled 0; skipped 0; todo 0; duration_ms 49442.3454
```

Following that run, final tests were strengthened with unchanged sidecar/source/package assertions and on-disk lease absence; the normal fixture no longer passes the removed repository option. The final covering gate below verifies those assertions. All builds and runtime gates in this fix round are serialized; no concurrent test-output rebuild occurs.

### Final covering verification and self-review

Final `npm run test:build` exited 0, then the following covering gate exited 0 (58 tests, 58 pass, 0 fail/cancelled/skip/todo, 2 suites, 286760.0265 ms):

```text
node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-shadow-projection.test.js dist-test/tests/projection-integrity.test.js
```

Complete final covering output:

```text
▶ committed snapshot integrity
  ✔ verifies exact historical V1 and V2 schema images with authenticated legacy hash bindings (6900.4159ms)
  ✔ authenticates original events and checks the pinned published image without source-path replay (3669.5936ms)
✔ committed snapshot integrity (10571.615ms)
▶ full projection integrity replay
  ✔ opens a committed snapshot for production UUID project-store identities (1.5919ms)
  ✔ accepts a production UUID project identity in the projection checksum domain (1.157ms)
  ✔ returns a frozen pass report only for an exact authoritative replay (3843.4708ms)
  ✔ rejects a re-signed WAL-only mutation that a pathname reader observes (3458.3184ms)
  ✔ maps a published generation sidecar to manifest-path integrity failure (3536.806ms)
  ✔ maps a non-ENOENT exact sidecar lstat failure through integrity verification (4013.3442ms)
  ✔ rejects a sidecar introduced at either pinned-image inspection boundary (9043.1779ms)
  ✔ replays a scale generation through the bounded linear core (4268.2651ms)
  ✔ does not sort the full expected projection while comparing a scale generation (3935.4641ms)
  ✔ fails closed when authoritative replay exceeds its configured event bound (3572.7602ms)
  ✔ fails closed when authoritative replay exceeds its configured byte bound (3976.0697ms)
  ✔ reuses stored-event authentication to reject authoritative metadata tamper (3452.0029ms)
  ✔ rejects an oversized stored payload before a full event row reaches JavaScript (3494.4707ms)
  ✔ rejects a same-byte generation replacement race before opening SQLite (3415.644ms)
  ✔ keeps descriptor-captured A bytes across an A-to-B-to-A generation pathname swap (3505.9934ms)
  ✔ does not create or clean any scratch inspection pathname (4944.7025ms)
  ✔ opens the pinned byte image only through in-memory deserialization (1.6058ms)
  ✔ detects a missing derived row after outer hashes are recomputed (4557.9526ms)
  ✔ detects an extra derived row after outer hashes are recomputed (3773.8134ms)
  ✔ detects provenance-tampered V2 rows after database and logical hashes are recomputed (4063.3279ms)
  ✔ detects canonical row reordering even though logical core rows are unchanged (3516.5544ms)
  ✔ detects cross-project rows after outer hashes are recomputed (3499.1842ms)
  ✔ detects noncanonical derived values after outer hashes are recomputed (3631.7081ms)
  ✔ detects a checksum-mismatched manifest without touching either database (3468.4004ms)
  ✔ maps manifest scope identity mismatch to the safe integrity contract (4689.3821ms)
  ✔ rejects a valid V1 manifest before any V2 source or projection byte path is opened (4724.8261ms)
  ✔ detects projection metadata and terminal identity tampering (8637.789ms)
  ✔ accepts a valid unpublished V2 image through the shared semantic validator (3423.0259ms)
  ✔ detects invalid derived references after outer hashes are recomputed (9380.8554ms)
  ✔ rejects a re-signed unpublished V2 image with a corrupt cross-table reference (3949.368ms)
  ✔ detects FTS index tampering even when core rows and checksums are unchanged (3630.2281ms)
  ✔ rejects a re-signed unpublished V2 image with FTS semantic tampering (3951.3384ms)
  ✔ detects a dropped required retrieval index after the database hash is re-signed (3582.4576ms)
  ✔ detects persistent FTS rank configuration tampering after the database hash is re-signed (3628.7172ms)
  ✔ detects rank-sensitive FTS docsize tampering after the database hash is re-signed (3822.1866ms)
  ✔ rejects database bytes that no longer match the published manifest (5260.5005ms)
✔ full projection integrity replay (143659.298ms)
✔ publishes both projection generations at the exact source position (8657.6596ms)
✔ adopts a prepared V1 baseline without rewriting its published bytes (4909.6234ms)
✔ recovers after generation installation before baseline manifest without rewriting the image (15155.3706ms)
✔ refuses orphan adoption after UPDATE corruption (6571.917ms)
✔ refuses orphan adoption after CREATE corruption (4093.4833ms)
✔ refuses orphan adoption after UPDATE corruption (3950.679ms)
✔ rejects an immutable revision with a different baseline (5160.413ms)
✔ does not record projection-verified after V1 generation tamper (4095.1043ms)
✔ does not record projection-verified after V2 generation tamper (7241.4726ms)
✔ rejects committed wrapper tamper before projection verification (5250.4529ms)
✔ rejects unrelated revision build identity (5009.3321ms)
✔ rejects unrelated revision migration identity (4353.0887ms)
✔ rejects unrelated revision configuration identity (6156.4107ms)
✔ never transacts through an injected unrelated repository (9432.7ms)
✔ never transacts through an injected protected repository (9126.1796ms)
✔ redacts private-database cleanup failure and releases remaining resources (4430.1911ms)
✔ redacts pinned-image cleanup failure and releases remaining resources (8898.3785ms)
✔ redacts v1-lease cleanup failure and releases remaining resources (7030.5814ms)
✔ redacts committed-snapshot cleanup failure and releases remaining resources (8136.2267ms)
✔ rejects a protected source destination before consulting the target connection (4101.0316ms)
ℹ tests 58
ℹ suites 2
ℹ pass 58
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 286760.0265

```

`npm run typecheck` exited 0 after the covering gate; output was `> tsc --noEmit` with no diagnostics. Self-review: all three review findings addressed; real repository transaction ownership is no longer injectable, every required revision identity is checked, both V1 cleanup resources are attempted and redacted, and four cleanup boundaries are covered. Existing synchronous `verify()` and shared coordinator/lease implementation are unchanged. Tests restore builtin instrumentation before fixture cleanup and perform real publication/authentication/native cleanup. `git diff --check` for scoped files exited 0 with only repository LF-to-CRLF notices.

The original 128/133 broad-gate outcome, isolated coordinator 4/4, original covering 49/49, and all original caveats above remain unchanged. Per controller instruction, no amended six-file gate was run in this fix round; scoped re-review and one clean full gate remain required before Task 8 closure.
