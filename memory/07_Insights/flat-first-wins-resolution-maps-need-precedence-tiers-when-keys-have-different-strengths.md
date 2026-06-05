---
title: Flat first-wins resolution maps need precedence tiers when keys have different strengths
type: insight
derived-from:
  - "05_Agent_Session_Logs/2026-06-04-review-harden-and-ship-memory-index-tier-2-backlink-graph-section-anchors-via-pr-6.md"
  - "05_Agent_Session_Logs/2026-06-03-implement-tier-1-memory-index-incremental-persistent-index-bm25-ranked-search.md"
confidence: high
status: active
created: "2026-06-04"
updated: "2026-06-04"
tags:
  - memory-index
  - backlink-graph
  - retrieval
  - wikilinks
  - bug-pattern
---
The Tier 2 backlink graph (`IndexRepository.ensureLinkGraph`) resolves wikilink targets through one map keyed by path, basename, title, id, and alias. The original code registered all of a note's keys in a single note-by-note loop with first-registration-wins over sorted-path order. That looks deterministic, but it has **no precedence between key kinds**: a weak key (title/alias) of an earlier-sorted note silently pre-empts the strong key (path/basename) of a later-sorted note. Concrete failure caught in adversarial review: a note merely *titled* "Setup" (sorted earlier) stole the `setup` key from the note literally named `guide/setup.md`, so a bare `setup` link backlinked to the wrong, unrelated note.

**Fix / rule:** when many key kinds share one resolution namespace with first-wins, register them in **precedence tiers across ALL items** — strongest first (path/basename), then declared identity (title/id), then weakest (aliases) — so each tier only fills keys an earlier tier left open. A single per-item loop conflates the tiers and lets weak keys shadow strong ones. Within a tier, sorted-first-wins is the (documented) tie-break; cross-folder duplicate basenames still resolve to the lexicographically-first path (a bare basename link can't disambiguate folder) — a separate, lower-severity limitation.

Related: section anchoring (`splitSections`) had the analogous "looks fine until real data" trap — ATX heading detection must skip fenced code blocks, or `# comment` lines inside ``` fences become fake headings. Both bugs passed the original tests; they only surface on realistic vault content, which is why adversarial review with reproductions (not just re-reading) found them. See [[2026-06-03-implement-tier-1-memory-index-incremental-persistent-index-bm25-ranked-search]].
