---
title: Memory Digest
type: dashboard
tags:
  - digest
  - token-economy
  - project/general
created: "2026-05-16"
updated: "2026-05-16"
---

# Memory Digest

This page is the compact map agents should update when repeated lessons become durable.

## Stable Decisions

```dataview
TABLE status, confidence, file.link AS Note
FROM "04_Architecture_Decisions"
WHERE type = "adr" AND status = "accepted"
SORT row["decision-date"] DESC
LIMIT 10
```

## Durable Insights

```dataview
TABLE confidence, file.link AS Note
FROM "07_Insights"
WHERE type = "insight"
SORT file.mtime DESC
LIMIT 10
```

## Failure Modes

```dataview
TABLE severity, area, confidence, file.link AS Note
FROM "08_Mistakes"
WHERE type = "mistake" AND status = "open"
SORT severity DESC
LIMIT 10
```
