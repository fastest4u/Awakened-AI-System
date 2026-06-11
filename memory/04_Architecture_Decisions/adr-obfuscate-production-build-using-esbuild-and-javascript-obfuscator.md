---
title: "ADR: Obfuscate Production Build using esbuild and javascript-obfuscator"
type: adr
status: accepted
confidence: high
decision-date: "2026-05-16"
supersedes: []
tags:
  - architecture
  - security
  - build-system
  - obfuscation
created: "2026-05-16"
updated: "2026-05-16"
---

## Context
The project's Node.js MCP Server code was easily readable after compilation because tsc only removes types and outputs standard JavaScript. The user requested code encryption/protection (obfuscation) to prevent reverse engineering.

## Decision
Implement a two-step build process using esbuild for bundling the project source code into a single file and javascript-obfuscator for obfuscating the output, rather than relying solely on tsc.

## Consequences
- The dist/index.js output will be completely obfuscated and unreadable, enhancing IP protection.
- Debugging production errors will be significantly harder due to obfuscated stack traces.
- Build times will slightly increase.
- External node dependencies (like @modelcontextprotocol/sdk) remain excluded from bundling to avoid runtime dynamic require issues.
