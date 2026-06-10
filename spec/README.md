# R2C Magic — Specification

This folder is the canonical reference for the R2C Magic project. It captures
**what** we are building, **why**, and the **decisions** that shaped the
implementation. Source code lives in `../src/`, `../tests/`, and
`../mapping.config.json`; this folder explains the intent behind it.

Read these documents in order on first read.

| # | Document | Topic |
|---|---|---|
| 01 | [overview.md](./01-overview.md) | Goal, target users, tech stack, decisions log |
| 02 | [architecture.md](./02-architecture.md) | Data flow, repo layout, module responsibilities |
| 03 | [mapping.md](./03-mapping.md) | R-Series → C-Series column mapping, ignore list, config format |
| 04 | [enrichment.md](./04-enrichment.md) | Sources, merge rules, CB Webservices notes |
| 05 | [data-model.md](./05-data-model.md) | Canonical `Book` type, SQLite schema |
| 06 | [milestones.md](./06-milestones.md) | M0–M4 plan with status |
| 07 | [deployment.md](./07-deployment.md) | Docker, future desktop bundle, configuration |
| 08 | [open-questions.md](./08-open-questions.md) | Deferred decisions that need a human |

## Status (as of M0)

| Milestone | Status |
|---|---|
| M0 — Scaffold | **done** — committed as `chore: initial scaffold (M0)` |
| M1 — CSV pipeline (upload → mapping → export) | not started |
| M2 — Real enrichment (Google Books, Open Library, KB SRU) | not started |
| M3 — Polish (per-run UI, mapping editor, CB adapter) | not started |
| M4 — Tauri desktop bundle | not started |

## How this spec relates to the codebase

- `AGENTS.md` at the repo root holds the **operational rules** for AI agents
  working in the code (no `any`, no live API calls in tests, etc.). This
  spec holds the **design rationale**. The two should never contradict —
  if they do, AGENTS.md wins for code rules and this spec wins for intent.
- `README.md` at the repo root is the **user-facing** entry point
  (quick-start, configuration table). This spec is the **builder-facing**
  reference. Some content overlaps; the spec is allowed to go deeper.
- `mapping.config.json` is the **runtime** truth for the R→C mapping.
  Document 03 explains the schema and current values; if they diverge,
  the JSON file wins and the spec must be updated.
