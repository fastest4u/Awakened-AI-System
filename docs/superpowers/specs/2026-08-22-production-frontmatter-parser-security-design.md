# Production Frontmatter Parser Security Design

## Goal

Remove the release-blocking `gray-matter -> js-yaml@3` dependency chain without
changing the externally observable frontmatter contract. The server remains a
never-throw reader: a malformed note produces diagnostics for that note and
does not crash retrieval, indexing, validation, or repair flows.

## Scope

- Replace `gray-matter` with the maintained `yaml` package (`^2.9.0`).
- Parse only the content between the already-validated opening and closing
  frontmatter delimiters in `parseFrontmatter`.
- Preserve YAML 1.1 scalar compatibility so existing unquoted ISO dates still
  become `Date` values and are normalized by the existing schema layer.
- Preserve duplicate-key rejection, detailed source-line diagnostics, input
  body extraction, BOM/blank-line behavior, and the never-throw boundary.
- Bring the MCP SDK and its vulnerable transitive packages to audited fixed
  versions, and update direct build-time tools to audited fixed versions.

## Non-goals

- No production deployment, production routing change, vault migration, or
  content rewrite.
- No change to canonical frontmatter serialization or the public MCP tool
  contract.
- No automatic acceptance or suppression of audit findings.

## Design

`parseFrontmatter` retains its structural checks and delimiter scanning. It
will call `parseDocument(innerYaml, { schema: "yaml-1.1", strict: true,
uniqueKeys: true, lineCounter })` and inspect `document.errors` before calling
`toJS()`. `LineCounter` converts YAML offsets to source-file line numbers; the
existing error classifier remains the sole place that maps parser failures to
stable diagnostic codes.

Only a top-level YAML mapping is accepted as frontmatter data. A scalar, list,
or null document produces `FRONTMATTER_INVALID_YAML` and an empty data object.
The body continues to be the original content after the closing delimiter, so
CRLF handling and body indentation remain unchanged.

Dependencies will declare the patched minimum MCP SDK and direct build tools.
NPM overrides will constrain only vulnerable transitive packages to versions
within their parents' accepted semver ranges. The resulting lockfile is the
release artifact; it must be reproducible with `npm ci`.

## Compatibility and Failure Handling

- Valid mappings, arrays, quoted scalar round trips, unquoted date coercion,
  BOM handling, leading-blank recovery, and CRLF preservation are regression
  tested.
- Duplicate keys, invalid indentation, and unquoted-colon failures retain
  their current diagnostic codes and 1-based source lines.
- Parser exceptions and parser-reported errors are both contained; no caller
  sees an uncaught YAML exception.
- An invalid top-level document is rejected rather than coerced into a map.

## Verification and Rollback

Before completion, run focused frontmatter/unit/service tests, `npm ci`,
runtime/type/build gates, the complete Subproject 2 release suite, artifact
smoke, and `npm audit --audit-level=high` (including production dependencies).
Review the lockfile diff and `git diff --check`.

Rollback is a normal git revert of this dependency/parser commit, followed by
`npm ci`; it does not need a data migration or database rollback. Do not deploy
as part of this work. Full MCP production cutover remains gated on Subprojects
3–5 and separate explicit approval.
