---
title: Adopt OAuth Device Code Grant for Codex Auth
type: adr
status: accepted
confidence: high
decision-date: "2026-05-21"
supersedes: []
tags: []
created: "2026-05-21"
updated: "2026-05-21"
---

## Context
PKCE auth flow required local callback capture which often failed on restricted network environments or remote developer workspaces.

## Decision
Adopted OAuth Device Code Grant (RFC 8628) for ChatGPT / Codex client authentication in SPX.

## Consequences
- Eliminates local callback port 1455 dependency.
- Enables seamless authentication by displaying user code in dashboard settings UI.
- Background polling simplifies the final authorization step for the user.
