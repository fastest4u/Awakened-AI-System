---
title: "2026-05-21 - replace Codex CLI with OpenCode-style Codex device auth"
type: session-log
agent: codex
session-date: "2026-05-21"
duration-minutes: 4
outcomes:
  - Explained feasibility of replacing Codex CLI dependency with an OpenCode-style direct Codex device auth adapter.
  - "Identified this as possible but substantially larger than a provider swap because it requires implementing/maintaining OAuth device flow, token storage/refresh, API request adapter, and AI SDK LanguageModel provider compatibility."
tags:
  - session-log
  - project/general
created: "2026-05-21"
updated: "2026-05-21"
---

# 2026-05-21 - replace Codex CLI with OpenCode-style Codex device auth

## TL;DR
- Explained feasibility of replacing Codex CLI dependency with an OpenCode-style direct Codex device auth adapter.
- Identified this as possible but substantially larger than a provider swap because it requires implementing/maintaining OAuth device flow, token storage/refresh, API request adapter, and AI SDK LanguageModel provider compatibility.

## Goal
replace Codex CLI with OpenCode-style Codex device auth

## What Was Done
- Explained feasibility of replacing Codex CLI dependency with an OpenCode-style direct Codex device auth adapter.
- Identified this as possible but substantially larger than a provider swap because it requires implementing/maintaining OAuth device flow, token storage/refresh, API request adapter, and AI SDK LanguageModel provider compatibility.

## Files Touched
- None

## Decisions Made
- None

## Open Follow-ups
- [ ] If approved, investigate OpenCode/OpenAI Codex auth plugin internals and choose between importing an existing adapter or writing a private AI SDK provider.

## References
- None

## Verification
Planning-only response based on current project architecture and prior provider discussions; no code changed.

## Confidence Log
| Claim / Question | Confidence Stated | Actual Result | Lesson |
|---|---|---|---|
| None | n/a | n/a | n/a |
