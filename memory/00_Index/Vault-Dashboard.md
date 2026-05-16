---
title: Vault Dashboard
type: dashboard
created: 2026-05-16
updated: 2026-05-16
tags:
  - dashboard
  - project/general
---
# Vault Dashboard

Use `memory_verifyVault` for MCP-side health. In Obsidian, Dataview and Tasks make the vault browsable.

## Recent Sessions

```dataview
TABLE file.mtime AS Updated, agent, outcomes
FROM "05_Agent_Session_Logs"
WHERE type = "session-log"
SORT row["session-date"] DESC
LIMIT 10
```

## Open Mistakes

```dataview
TABLE severity, area, confidence, file.mtime AS Updated
FROM "08_Mistakes"
WHERE type = "mistake" AND status = "open"
SORT severity DESC
```

## Active ADRs

```dataview
TABLE status, confidence, file.mtime AS Updated
FROM "04_Architecture_Decisions"
WHERE type = "adr" AND status != "superseded"
SORT row["decision-date"] DESC
```

## Open Tasks

```tasks
not done
path includes memory
sort by priority
sort by due
```
