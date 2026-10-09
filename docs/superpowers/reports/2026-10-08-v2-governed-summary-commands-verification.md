# Governed summary commands verification

Status: actual6 G11 qualification ACCEPTED on runtime `0ecb75b2a814c408255c940ef0e850135a1d9911`:34 stages/28 files/945 passes, zero fail/cancelled/skipped/todo. Whole-review I1 and later scoped changes were accepted. Root memory closure succeeded at2026-10-09T13:24:51.369Z. This report does not claim acceptance of the entire F2 branch or PROD.

Original G11 owners are the fixed runner, its focused gate tests, package alias, two documentary files and approved-plan progress checkboxes. The separately scoped I1 prerequisite below adds three product and four test owners. Shared runner, Windows Job bridge, final spec parser, accepted Task6 gate and build artifact inventory remain unchanged. Human-approved Ruling16 (2026-10-09) prospectively sets the single total maximum/default to2100000ms and injected range1..2100000ms, superseding only the original900000ms ceiling in plan `2ed388d`. Original spec `c258b1b`, product/per-case clocks and actual1–5 historical outcomes remain unchanged;35 minutes is a ceiling, not a fit/ETA/SLA or passing qualification.

Focused implementation evidence: covering 48/48 passed, zero fail/cancelled/skipped/todo, Node footer 302473.4365ms; compiler and focused command both exited 0. Exact compiler/test commands, UTC epoch metadata and complete outputs are retained privately under `.superpowers/sdd/2026-10-08-v2-governed-summary-commands/task-11-evidence/`; compilation setup failures are distinct from behavioral RED. The covering command is `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-governed-note-gate.test.js`, preceded by `npm run test:build`.

Whole-branch review of clean candidate `3f116dd026f6545006f6f9b690da8c2826cb7147` found one Important I1, subsequently corrected and approved. Actual6 `npm run test:v2-governed-summary-commands` exited0 and was accepted by root after complete record and independent binding checks. Qualified runtime HEAD is `0ecb75b2a814c408255c940ef0e850135a1d9911`; later docs-only publication changes the tracked source digest and is not qualified by that earlier run. First documentary HEAD `20abff0af8ffa2425fd510ab07f7c65af651c962` is recorded in the retained publication report. This terminal closure HEAD is recorded after commit in the retained closure report, not self-referentially guessed here.

The [evidence document](../evidence/2026-10-08-v2-governed-summary-commands.md) contains the immutable34/28 inventory, exact disposable profile, accepted G10 provenance, all sixteen Rulings and their reasons/costs, native limits, historical preservation and remaining whole F2/F3/F4/PROD obligations. `productionReady:false`, closed promotion, status-only public registration, full-evidence requirement, content/capability unverified gates and V1 isolation stay in force.

Root owns the single human task's project-memory lifecycle. Root successfully ended session `memory-1791520927093` at `2026-10-09T13:24:51.369Z`, saving `05_Agent_Session_Logs/2026-10-09-f2-g11-governed-summary-qualification-and-evidence-publication.md`. Returned vault health: ok,0 errors/0 warnings, score60/gradeD; lifecycle quality:100/gradeA, no warnings. The lifecycle score is distinct from vault health. Verified tool result is retained in `.superpowers/sdd/2026-10-08-v2-governed-summary-commands/root-memory-closure.json`, SHA256 `87afb936ff01d9e9f05db8eeb021d5a29bf3c8447a9cff05163e6e770355f554`.

## Focused control evidence

| Evidence stem | Command | Start UTC epoch ms | End UTC epoch ms | Exit |
| --- | --- | ---: | ---: | ---: |
| `red-build` | `npm run test:build` | 1791521416728 | 1791521451682 | 2 |
| `red-build-2` | `npm run test:build` | 1791521475656 | 1791521512304 | 0 |
| `red-test` | `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-governed-note-gate.test.js` | 1791521572415 | 1791521598398 | 1 |
| `green-build` | `npm run test:build` | 1791521697940 | 1791521750037 | 0 |
| `green-test` | `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-governed-note-gate.test.js` | 1791521765675 | 1791522002199 | 0 |
| `covering-build` | `npm run test:build` | 1791522087497 | 1791522122098 | 0 |
| `covering-test` | `node --test --test-concurrency=1 --test-reporter=spec dist-test/tests/v2-governed-note-gate.test.js` | 1791522151713 | 1791522454364 | 0 |

Each stem identifies complete private `.txt` output and `.meta.json` under the evidence directory above. Initial `red-build` exit2 is a TypeScript setup failure for a readonly test mock binding, not behavioral RED. `red-build-2` then passed; `red-test` reached the callable refusal scaffold and recorded43 tests/13 pass/30 fail, zero cancelled/skipped/todo,25735.256ms. The positive inventory/CLI assertions establish missing behavior; early generic-refusal passes and missing native observations do not independently prove every later rejection path.

Intermediate `green-test` passed43/43,236256.8321ms. It is superseded for final test inputs by `covering-test`, after Ruling11 and four cheap additional controls. No source/runner change was made between the intermediate and covering runs; the changed test harness received a covering compile. No default/all/old/broad gate, build sweep, install, stress run or benchmark repetition was used.

The covering file has exactly one complete successful synthetic34/28 inventory and one Ruling11 complete negative inventory. Happy case42323.1908ms; final-owned-unlink negative case43277.3713ms. These are reporter durations for those fixture cases, not current-candidate qualification times. Both exercised34 real Windows Jobs with direct native exit0, active-zero/drained-output proof and actual bridge close. The happy case resolved void and published once after actual owned unlink. The negative case reached all34 stages and valid postflight without prior gate error, injected only the exact owned unlink failure, published nothing and retained the original regular lock's dev/ino. The shared callback ordering and isolated first fault establish the prepared-result boundary. Earlier missing/replaced/close/unlink controls remain early-refusal evidence and are not mislabeled as after-prepared controls.

Other controls refuse dirty tracked docs/product, hidden index flags, clean noncanonical Git modes, untracked/ignored product, source and compiled directory junctions, missing explicit private worker, executable hash substitution, measured source/artifact/manifest/read-closure/dependency/whole-tree/private-provider/test mutation, malformed/incoherent/incomplete outer footer, zero tests, governed skip/todo/cancelled, overflow, native nonzero, missing direct/closure/active-zero proof or bridge fragment, unsupported host, foreign lock, abort and elapsed total budget. All negative output stays bounded/sanitized. The current selected Windows inventory has no allowed inherited skip; unknown skips refuse.

`covering-inputs.json` and `covering-inspection.json` confirm frozen runner/test/package/compiled-test hashes, exactly two complete native groups and one synthetic qualification, and no unexpected diagnostic output. Shared runner/Job bridge/parser/Task6 gate/build script Git blobs remain unchanged. `retained-fixture-index.json` inventories this task's retained synthetic roots and lock identities; no recursive deletion or reset was performed. No provider, row, key, bearer or proof bytes are included in published control evidence.

All48 final cases completed naturally. No manual process termination, native hang, manufactured closure or revised900000ms actual-gate budget was used. This does not establish that the real34/28 gate fits900000ms; earlier G10 and other bundled timings cannot be divided into per-file predictions.

## Accepted whole-review I1 correction — historical composite verification

The complete review of approved plan base `2ed388d1a691acf3ded4a4b8e98b226777700596` through clean G11 candidate `3f116dd026f6545006f6f9b690da8c2826cb7147` requested one Important correction: failed recovery ROLLBACK was flattened into an ordinary error while its worker remained reusable. No Critical/new Minor or separate G11 blocker was reported. The single scoped correction review was accepted; actual6 later qualified the complete current inventory.

The correction records cleanup uncertainty against the actual connection, invalidates its backend, and uses a private error-identity marker to latch the runtime terminal. Already-enqueued requests cannot reach dispatch. Closing the actual worker transport produces actual worker exit, which invokes the unchanged executor poison path and unchanged controller health rules. Public error text is not a health certificate. Later resource cleanup cannot heal the connection or grant a new generation. A read failure whose ROLLBACK succeeds remains reusable.

Human-approved G09 identity semantics remain unchanged: transport loss makes the recovery outcome unknown to the parent, so existing ownership-uncertainty disposition retains the ORIGINAL command/idempotency IDs. No new IDs, mutation receipt, public wire field, command, option or provider channel was introduced. The controller, executor, codecs, build inventory and shared gates were unchanged. Root recorded this as the missing disposition under existing Ruling8, not a separate Ruling. Later Rulings12–16 concern test isolation, bounded scheduling, diagnostics and the explicitly approved outer ceiling; earlier reasons, costs and limits still apply.

Causal RED: compilation exited0; four selected controls produced1 pass/3 failures,12707.5094ms,exit1. Before teardown, the actual failed-rollback worker remained reusable with an open read transaction, and the queued copy reached backend dispatch and recovery a second time. The exact fixture-generated secondary correlation reply was locally consumed so an unrelated protocol fault could not mask that premise. The successful-rollback counterpart reused and reopened normally. Both direct-service failures detected renewed admission before any manual cleanup.

One necessary product build and covering compile exited0. The complete affected recovery/entry cohort produced101 tests/100 passes/1 failure, zero cancelled/skipped/todo,201053.0075ms,exit1. Its sole failure was the new assertion's descriptive disposition literal instead of the existing literal `ownership-uncertain`. The product correction and causal native observations already succeeded. After correcting ONLY that assertion, a covering compile exited0 and the exact failed native control passed1/1,zero fail/cancelled/skipped/todo,7562.7517ms,exit0. This is composite verification, not an all-green101-test run. The other100 passed controls were not repeated. Complete commands, selection identity, outputs and numeric UTC metadata remain private in `task-11-fix1-evidence/`.

The final native control observed one actual worker exit0, nonreusable owner, zero queued dispatch/replies, one recovery invocation, and the open read transaction at physical connection closure. It asserted original IDs, subsequent create/recovery/close/reopen refusal, cached `ownership-uncertain` closure, unchanged generation and no public diagnostic leaks. Direct controls also refused further admission after later successful SQL cleanup. Positive rollback preserved recovery/create reuse and normal graceful reopen.

Source raw/blob identities, executable,15 emitted files and1052 compiled files were captured. Product/runtime/emitted/shared identities stayed unchanged across both verification runs; the only compiled retry difference was the entry-test assertion. Native fixture roots and original identities remain retained. No actual gate, G11 synthetic rerun, old/default/all/stress gate or second product build was performed. These timings do not establish fit within900000ms. Those historical I1 checks did not qualify a runtime; the later actual6 result below does. `productionReady:false`, closed promotion, V1 isolation and all whole F2/F3/F4/PROD obligations remain open.

| Private evidence stem | Start UTC epoch ms | End UTC epoch ms | Exit |
| --- | ---: | ---: | ---: |
| `assertion-correction-compile` | 1791525228153 | 1791525273834 | 0 |
| `assertion-correction-test` | 1791525307261 | 1791525315051 | 0 |
| `covering-compile` | 1791524890296 | 1791524929179 | 0 |
| `covering-product-build` | 1791524847098 | 1791524874583 | 0 |
| `covering-test` | 1791524969069 | 1791525170356 | 1 |
| `red-build` | 1791524652082 | 1791524687010 | 0 |
| `red-test` | 1791524706705 | 1791524719619 | 1 |

## Later corrections and failed-attempt preservation

After actual1 deadline exhaustion, the three-test fixture correction used fresh physical synthetic roots/Git and current emitted worker identity, with five targeted controls and49/49 controls covering174 receipts (68 full /90 early-prefix); this did not cure actual2 deadline exhaustion. No proof/results cache or shared native helper change was introduced. Ruling12 then isolated original controls in fresh Worker realms with fixed2 and all-active-pool cooperative abort/join. Its initial full57 run failed11pass/46fail, including44 unadmitted controls; first completion/cause remains UNKNOWN and happy stage6 native closure UNCERTAIN. Changed diagnostic input later passed59/59 with176 receipts, including two cancellation-guard Jobs;175 helper observations included one unsupported-host no-Job case. That pass never heals the earlier uncertain fixture.

Ruling13 tried entry/ownership registration scheduling: affected47 produced45pass/2fail; ownership21/21 passed, entry24/26 exposed two cleanup/controller-close unavailable outcomes. First body/cleanup cause and fallback physical disposition remain UNKNOWN. Entry source/JS/map was restored exactly, ownership bounded groups retained, followed by scoped acceptance. No body/helper/RCL or per-case timeout changed; old failed fixtures were not reset.

Ruling14 diagnostic history stays separate: first entry native7 was reporter-loader setup, not a product failure; changed file-URL CLI smoke produced expected synthetic25pass/1fail; current original serial entry26/26 and fixed ownership21/21 later passed. These are current diagnostic results, not fixes or explanations of actual3/4 lost causes. Fixed allowlisted diagnostic titles are not republished here, and raw private error/payload text was never collected.

Ruling15 verification is composite: pure RED6 produced2pass/4fail; selected7 later produced6pass/1fail while the one genuine synthetic ownership13-prefix integration passed. Two pure variants localized incomplete entry mapping15 instead of26 across five finite registration loops. After table/AST-only correction and compile, pure6/6 passed; native13 was not repeated. All13 final closures active-zero; stage6 direct snapshot had activeProcesses1, so not every direct snapshot was active-zero. No all-green selected7 claim. Prior full controls and later actual6 are distinct evidence.

Ruling16 human-approved35-minute ceiling used one compile, semantic pure RED1/0pass/1fail then selected GREEN4/4 (footer64018.6583ms),35 genuine Jobs: canonical happy34 plus original post-runtime-abort1. One synthetic qualification after owned release, default2100000; no product build. Static/EOL inspection setup correction was not behavioral RED. R16 review SpecApproved/QualityApproved SHA256 `2c90d1475245c57aef7c1b791966bf539112c17f0639b2dce3a8bcb6aa152fbe`; actual6 was separately authorized afterward.

| Historical actual attempt | Runtime | Original cap ms | Exit / stopping stage | Complete outer tests pass/total | Qualification |
| --- | --- | ---: | --- | --- | --- |
| 1 | `4a0ca1d0c95a5ce0c9ff22a541f9208d49bc76ab` | 900000 | 124 /19 retained-command; deadline | 483/483 | none |
| 2 | `5ee702502cb0a12edc60a970984d0e357f7a6ded` | 900000 | 124 /17 gate controls; deadline | 424/424 | none |
| 3 | `29f8c751297cff4939bea42789ab0891d8f2a38d` | 900000 | 1 /15 entry25/26; lost leaf/cause UNKNOWN | 421/422 | none |
| 4 | `29f8c751297cff4939bea42789ab0891d8f2a38d` | 900000 | 1 /13 ownership20/21; lost leaf/cause UNKNOWN | 280/281 | none |
| 5 | `f0280ed2f9d4cb92b48aff6f495e2ace73026a8f` | 900000 | 124 /17 gate controls; deadline | 424/424 | none |

Attempts1/2/5 incomplete stage footers do not prove a failed assertion or completion of nested controls. All attempted outer closures were positive, but unavailable inner fixture dispositions are not fabricated. Later current passes do not attribute old functional causes or heal old roots/locks/IDs. Complete attempts1–5 safe records, numeric UTC metadata/freezes and reports remain under the same ignored SDD directory without replacement. All16 decisions/reasons/costs remain in the evidence document.

## Accepted actual6 complete record

Exactly `npm run test:v2-governed-summary-commands`, no args, in `C:/Users/Server/.codex/worktrees/v2-prod-readiness/Awakened-AI-System`. Start `2026-10-09T12:43:58.1227190+00:00` /1791549838122; end `2026-10-09T13:06:52.6773378+00:00` /1791551212677; exit0. Wrapper1374555ms, last stage cumulative1365078.1755ms, final qualification1369547.9944ms under2100000ms. Deadline origin unavailable; no reconstructed timestamp. Runtime HEAD `0ecb75b2a814c408255c940ef0e850135a1d9911`, source digest `ed0d6261e12ce1d8da39a75cb0787d6fbf4cf633921a300c1900558e6ae5c0a0`, compiled digest `4ca27798f0ec81a00b2e2dd71199150200f8e9b4bc4fb3f1028eefd88016f060`. Full measurement/provider/policy/closure hashes are in the evidence document and qualification artifact.

All34 stage receipts are native0/code0, cleanup complete/windows-job-active-zero, no overflow. Every28 footer has fail/cancelled/skipped/todo0. Totals945/945; suites are per-file structural counts, not extra tests. No unrun stage. Raw child titles/error/provider/proof/key bodies remain discarded; only fixed stage names/numbers/digests below.

| # | Fixed stage | Tests/pass (suites) | Duration ms | Runner cumulative ms | Output bytes | Safe output SHA256 |
| --- | --- | --- | ---: | ---: | ---: | --- |
| 1 | `runtime` | — | 2601.8654 | 5112.1429 | 353 | `2a2565244ca8f27d71ddd5399f93d51379a2b2ea98a49b744923ccf346a9260b` |
| 2 | `typecheck` | — | 31110.163300000004 | 38605.1621 | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| 3 | `build` | — | 37679.7627 | 76285.3841 | 703 | `31de06ef9f363b4f3b441d2b8242737c7bdcc93fba37fa24196e20386b387eb5` |
| 4 | `compile` | — | 86317.516 | 163102.2593 | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| 5 | `v2-governed-note-contracts` | 17/17 (0) | 2450.184600000008 | 166982.49910000002 | 1498 | `635253a72cc7d9839ac5a66d9d27b7d75fe057c1409171f78a9c125c6c5c42d5` |
| 6 | `v2-governed-note-redaction` | 2/2 (0) | 1712.180800000002 | 174122.5862 | 269 | `4ae678c8bcf867f49ba8de9eb21f8a9714f378b0e841c0c1a36b459f029cf194` |
| 7 | `v2-governed-note-authority` | 13/13 (0) | 12861.899600000004 | 186985.38700000002 | 1211 | `a255fe728b7f97428bd93af066dea6114fdc1e018ded4b8c3af764a64811c92c` |
| 8 | `v2-governed-note-provenance` | 84/84 (0) | 86934.5338 | 273920.3088 | 7511 | `3c8c616dfea6982bec936fd71908c4661a94f85bbd01ecd393feecb074c0cfd8` |
| 9 | `v2-governed-note-codec` | 24/24 (0) | 40016.7267 | 313937.4774 | 2183 | `288159be5f4083318390ca1b91df07f7c9eba67143f500875218ea7b8e060d86` |
| 10 | `v2-governed-note-command` | 30/30 (0) | 21401.88690000004 | 335339.7253 | 2628 | `81402dd672f493244185376646297943e9e47b9b98348ae9368b3750dd88b19f` |
| 11 | `v2-governed-note-replay` | 15/15 (0) | 12448.478100000008 | 347788.5481 | 1302 | `ba8e8431c8e44c2b1ca873e68ae3483ee2ceeb813554db663fdb0d6a8ba5c852` |
| 12 | `v2-governed-note-recovery` | 75/75 (0) | 56328.30210000003 | 404117.59380000003 | 6455 | `50ef2f00e5c4caecb209af6ac2405ff899e7f1a4c9ff3ba4baeae10a3e637a44` |
| 13 | `v2-governed-note-ownership` | 21/21 (3) | 151457.8395 | 555575.7618999999 | 3200 | `0c456c4fe51a37f4df34dab9e580e7dfe52fc298cfd86f2bc38b7cef84386a3a` |
| 14 | `v2-governed-note-executor` | 115/115 (0) | 37229.97490000003 | 592806.1015999999 | 7762 | `c04bcf2f6c83337b3be5157ff762d83523c194eefa3a0df27be7185133a2f350` |
| 15 | `v2-governed-note-entry` | 26/26 (0) | 197870.8421 | 790677.3781 | 6617 | `18a29dc45f988cf863439770ab20f912eecc4d1b516b437cd3139ef8165c90a8` |
| 16 | `v2-governed-note-candidate-read` | 2/2 (0) | 28556.604700000025 | 819234.7893999999 | 3035 | `23100591f5e41914d013b46b950207e27caa48ff4f751ad44ea202bfb2e08ef1` |
| 17 | `v2-governed-note-gate` | 66/66 (1) | 261271.93240000017 | 1080507.2159 | 354733 | `475ab5163a916514534141e3befd233bc253e6d7e8e433635d3cf936fa3ec666` |
| 18 | `v2-retained-evidence-redaction` | 12/12 (0) | 1749.7890999999363 | 1082260.3202 | 1190 | `fdf7ec354ec81afb3762426d87a01a185cb7be64d7eedbddff9db9fbb0a5d78b` |
| 19 | `v2-retained-evidence-command` | 31/31 (0) | 22379.812899999786 | 1104640.4059000001 | 2957 | `10c8d8610c7df11afb1e59bcb3c8bd33c864f88327a12157f4f02561b532d81d` |
| 20 | `v2-retained-evidence-replay` | 22/22 (0) | 25998.3526000001 | 1130639.3386000001 | 2179 | `292f055359fec5214322df01ca3e228513aa20f61157737c39c8c560c59ca540` |
| 21 | `v2-retained-evidence-integrity` | 32/32 (0) | 26100.32750000013 | 1156739.9767 | 2922 | `c9961622e4cc04247eb8bf4517f2e13df5e707dc07b6293491976e4d975885b8` |
| 22 | `v2-retained-evidence-entry` | 42/42 (0) | 38319.228399999905 | 1195059.5641 | 4144 | `c81ec4ce9191cffae1f880ce2181b8176920e913ed4994a0e9c9fbee3038af0f` |
| 23 | `event-append-transaction` | 26/26 (0) | 14182.38779999991 | 1209242.2599 | 2553 | `a3c443ecc391dcfddd0b439695e27d65bbb124f7738b9e4d4d85f9231fe0d381` |
| 24 | `event-store` | 26/26 (1) | 3294.817700000014 | 1212537.5554 | 2675 | `864fd8997997b2260d18ceba5c50afd0dd6706c41a43630dbf7471f384818c49` |
| 25 | `event-integrity` | 72/72 (7) | 15205.070899999933 | 1227743.0064 | 6905 | `e9be17b079a24d946b2837a5f7a25e11f1492594f703926eb7be8589f3c271fa` |
| 26 | `stored-event-authenticator` | 4/4 (1) | 1676.7834999999031 | 1229420.0924 | 534 | `238069ec56d1e979ae9c61631c3ca33d854bc791cf41dd07392faa8cba4597ad` |
| 27 | `projection-source-event-codec` | 20/20 (1) | 2020.8197999999393 | 1231441.175 | 2106 | `6c8d3d5a93c16a513ab3361eacb4532c93e58da50d49e6c338855b6f7bce8485` |
| 28 | `projection-folds` | 23/23 (1) | 1606.0407000000123 | 1233047.5843 | 2287 | `72050dc7adefb3735e7e84de474e8938833766c22892fd85d23bfd8a07af0330` |
| 29 | `project-store-executor` | 74/74 (9) | 37195.51140000019 | 1270243.3777 | 7787 | `75bb131fba4b8bf187a34583b52aaa906af1339fe5616c123ec18fb691328672` |
| 30 | `lifecycle-worker-protocol` | 19/19 (1) | 2544.4247000000905 | 1272788.1586 | 1722 | `c7a6058d49026a9a257f8e39c0903eede2543bb7706cec0c1a933b8f76b07c6d` |
| 31 | `fresh-start-admission` | 43/43 (0) | 24870.171800000127 | 1297658.6252000001 | 7508 | `8e2e6056dd1ab98dbb43eb0d260f2100a6fc9e14fcde907e9222bea7de794f81` |
| 32 | `v2-foundation-entry` | 9/9 (0) | 49407.968300000066 | 1347066.8976 | 1062 | `36af37fc60f112d7824a6b1ec686da11320e37f81ce2e4166bc2e9300ceea218` |
| 33 | `worker-smoke` | — | 4030.9131999998353 | 1351098.2461 | 80 | `e08bbbd4629019796f220ede7279a42cc4c75a6755605740ed2b5aedb3131719` |
| 34 | `fresh-start-smoke` | — | 13979.699999999953 | 1365078.1755000001 | 100 | `775784438c34f56c261f9ccdefcb597a6b916cc1c0c0ebdc56d3fb2983f428ca` |

Exactly one final qualifier follows all receipts. Positive finalization is source-bound: unchanged shared runner returns0 only after genuine Job settlement, drained output, bridge close and original owned descriptor/path unlink; unchanged local gate then rechecks deadline/abort and publishes. Lock absent before/after is additional evidence, not a release certificate. Original lock dev/ino, raw native frame/direct snapshot certificates and deadline origin are not emitted. No Worker/PID/elapsed substitution. Both smokes passed; no public activation or semantic authority enlargement followed.

| Retained actual6 artifact | SHA256 |
| --- | --- |
| `task-11-evidence/actual-gate-6.txt` | `63a06be77712e76179b3826b0af62888fb8b99e17de4dd3df21fe450e40dbe52` |
| `task-11-evidence/actual-gate-6.meta.json` | `eb14cdb05d09401dc8f3aef43247e0215bf466c2a129ddeabe003ba9a54b9c3f` |
| `task-11-evidence/actual-gate-6-before-identities.json` | `49c9ce184bc979940b9ea9b4c51d58999698ba7ab7723a0d4cd6c30dd5f2fe62` |
| `task-11-evidence/actual-gate-6-after-identities.json` | `2d22f30af65069fe9ff6aa8388926eae1f88f9bde934e0c05a418f6907f44237` |
| `task-11-evidence/actual-gate-6-observations.json` | `828690525910079cabc43da98e4026bb1fa490fd5599174ee1603013f28b417d` |
| `task-11-evidence/actual-gate-6-qualification.json` | `1d471a1312af86a21e165fa625f59f60d3c8ed5a2a25c4caa090e769feac398e` |
| `task-11-evidence/actual-gate-6-inspection.json` | `bbfb62e276e745c6749f4ec9bc1df06bec404993ef236b32730c5d522c79133d` |
| `actual-gate-6-report.md` | `d3135b6a556c461deae321fa265a3373f7f09697a8e6000a00e86e53d7d2470f` |
| `actual-gate-6-root-verification.json` | `69e8f06ecd141bcf1986d55aef759dc080f74515f82f065ed8cb9be17f026a6c` |

All locators above are under `.superpowers/sdd/2026-10-08-v2-governed-summary-commands/`. Root fully read the complete record and accepted independent zero-drift binding at2026-10-09T13:12:56.7402805Z.690 source raw/Git blob/mode/flags,Node and1052 compiled files unchanged; prescribed build alone changed10/15 emitted files, with5 artifacts/2 closures/81 inputs and41 explicit compiled paths verified. Main-candidate qualification is actual6; historical synthetic qualifiers are not substituted.

Root memory session closure and returned health are verified as recorded above. G11 steps5–7 are checked, with step7 updated only after successful memoryEnd. First documentary HEAD is `20abff0af8ffa2425fd510ab07f7c65af651c962`; this terminal closure HEAD is recorded after commit in `actual-gate-6-closure-report.md`. Both change the tracked source digest and neither replaces measured runtime `0ecb75b2a814c408255c940ef0e850135a1d9911`. No native/build/test follows documentation edits. `productionReady:false`, closed promotion, status-only public registration, V1 isolation and full F2/full-body/public/actual-host/F3/F4/PROD obligations remain open.
