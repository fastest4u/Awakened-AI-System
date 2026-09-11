# Task 7 final scoped review

Reviewer: `task7_review`; fix range `f314c58e86040c332846e65fd7b094896ea0f69f`..`b6c9dab575bbe18e18b6463072adcbb31cb0220c`.

1. **Capacity failures use the wrong error code — ADDRESSED.** `src/orchestrator/migration/v2-imported-event-reader.ts:139,163,215,224` separates capacity limits from integrity failures and emits `MIGRATION_LIMIT_EXCEEDED`. Normalization preserves that classification. Boundary regressions cover exact/+1 count and byte ceilings.
2. **Catch-all redaction destroys operational error classification — ADDRESSED.** `src/orchestrator/migration/v2-imported-event-reader.ts:48–60,124–127,247–258` preserves allowlisted migration codes and the approved native-primary/typed SQLite busy form using fresh redacted errors. Cleanup preserves the original operational failure, attempts rollback and close once, and protects against throwing/changing classification metadata.

New breakage: None. Out-of-scope observations: None. Broader retry orchestration remains Task 11.

Verification: reviewed scoped diff and appended report; accepted recorded 148/148 gate and successful build/typecheck without rerunning. Checked the existing SQLite busy helper and error class for the newly introduced integration. No checkout mutations or additional probes. Memory closure and lifecycle verification passed.

Fix round: All findings addressed; no new Critical/Important breakage.

Spec compliance: Compliant under the approved classification contract.

Task quality: Approved.
