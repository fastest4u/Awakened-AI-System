# Task 8 fix round 1 scoped independent review

Reviewer: task8_review. Range: `36c5f9d015ddd94e99d95c49072286a4bdf926b2..375aa6fa780f1870ca0f9c470f153e46cebd08df`.

- **Unchecked repository authority — ADDRESSED.** Publisher line 180 constructs the repository from the verified target connection; independent repository injection is removed. Tests line 172 check unrelated and protected repositories receive zero transactions while evidence reaches the verified target.
- **Incomplete rollout identity checks — ADDRESSED.** Publisher line 195 checks build, migration, configuration, and baseline hashes. The fixture uses authenticated identities at test line 64; independent mismatch regressions start at line 165.
- **Missing cleanup-failure coverage — ADDRESSED.** Integrity line 1326 independently attempts both cleanup operations and redacts failures. Tests line 191 cover private database, pinned descriptor, publication lease, and committed snapshot cleanup, including remaining resource release, protected-byte preservation, and no projection-verified transition.

New breakage: none. Out-of-scope observations: none.

Specification compliance: approved for scoped fixes. Code quality: approved. All findings addressed; no new Critical/Important breakage.

Reviewer checked appended report with focused 9/9, full final covering publisher/integrity 58/58, and typecheck exit 0. No repeated suites, Git probes or checkout mutations. Memory closure verified.

Controller must still obtain one clean six-file gate before Task 8 closure. First broad 128/133 result remains historical failure evidence; focused passes do not supersede it.
