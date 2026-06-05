---
title: "2026-05-16 - Implementing Code Obfuscation for IP Protection"
type: session-log
agent: Antigravity
session-date: "2026-05-16"
duration-minutes: 10
outcomes:
  - Replaced standard tsc build with an obfuscated build pipeline.
  - Added build script to bundle using esbuild and obfuscate the generated file.
  - Verified the obfuscated server starts successfully without module loading errors.
tags:
  - session-log
  - project/general
created: "2026-05-16"
updated: "2026-05-16"
---

# 2026-05-16 - Implementing Code Obfuscation for IP Protection

## TL;DR
- Replaced standard tsc build with an obfuscated build pipeline.
- Added build script to bundle using esbuild and obfuscate the generated file.
- Verified the obfuscated server starts successfully without module loading errors.

## Goal
Implementing Code Obfuscation for IP Protection

## What Was Done
- Replaced standard tsc build with an obfuscated build pipeline.
- Added build script to bundle using esbuild and obfuscate the generated file.
- Verified the obfuscated server starts successfully without module loading errors.

## Files Touched
- scripts/build.js
- package.json
- dist/index.js

## Decisions Made
- Used esbuild for bundling and javascript-obfuscator for code obfuscation.
- Externalized node_modules during the esbuild phase to avoid dynamic require crashes in the MCP server.

## Open Follow-ups
- [x] None

## References
- None

## Verification
Ran `npm run build` to verify the pipeline and `node dist/index.js` to ensure the server starts properly.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| Bundling with esbuild and obfuscating with javascript-obfuscator will protect the source code. | high | The new build script correctly minifies and obfuscates the output in dist/index.js. | Esbuild needs 'packages: external' to prevent dynamic require errors with Node.js builtin modules and external dependencies when outputting ESM. |
