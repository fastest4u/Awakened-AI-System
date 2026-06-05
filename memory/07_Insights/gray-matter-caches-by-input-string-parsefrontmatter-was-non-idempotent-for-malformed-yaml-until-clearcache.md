---
title: "gray-matter caches by input string: parseFrontmatter was non-idempotent for malformed YAML until clearCache()"
type: insight
derived-from:
  - src/utils/frontmatter.ts
  - tests/frontmatter.test.ts
confidence: high
status: active
created: "2026-06-03"
updated: "2026-06-03"
tags:
  - frontmatter
  - gray-matter
  - parsing
  - bug
  - idempotency
---
Discovered 2026-06-03 while hardening the frontmatter system. gray-matter@4 caches parse results keyed by the input STRING. When the same malformed note is parsed twice in one process, the FIRST `matter()` call throws (e.g. YAMLException 'bad indentation' / 'incomplete explicit mapping pair') and parseFrontmatter records the critical diagnostic, but the SECOND call on the identical string returns the cached, non-throwing, empty result — so the critical diagnostic is silently dropped the second time.

Empirically verified (gray-matter@4.0.3): tryParse(badIndent) => throw, then tryParse(badIndent) again => no-throw. Calling `matter.clearCache()` before each parse => throw, throw (consistent).

Real-world impact: validate() then fix()/migrate() on the SAME unparseable file in one process — the second pass would see hasCritical=false and could rewrite a file the first pass correctly blocked. It also made the test helper `codes(result.raw)` (which re-parses) return [] for a string that did diagnose a critical on first parse.

Fix: call `(matter as unknown as { clearCache?: () => void }).clearCache?.()` immediately before `matter(toParse)` in src/utils/frontmatter.ts (clearCache exists at runtime but not in gray-matter's TS types). The cache provides no benefit here (notes are read fresh each time) and actively breaks correctness, so always clear it.

Lesson: a 'pure' parse wrapper is not idempotent if the underlying library caches by input. Verify idempotency by parsing the same malformed input twice. Relates to [[frontmatter-parsing-in-project-memory-gray-matter-crash-surface-and-verified-behavior-matrix]] and [[frontmatter-audit-confirmed-safety-gaps-adversarial-correction-duplicate-key-detection-is-not-dead]].
