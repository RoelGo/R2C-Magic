# 01 — Overview

## Goal

Build a self-hostable web app that takes a Lightspeed book CSV — either an
**R-Series** export or the rokko **CB-intake** template that employees fill
in by hand — enriches every book by ISBN/EAN against several online catalogs,
and produces a Lightspeed **C-Series** import CSV that the rokko bookshop
coop can feed into their webshop with zero manual data entry per book.

## Users

- The rokko coop's webshop maintainer. One human, occasionally two. Runs the
  app maybe weekly when new stock arrives.
- Self-hosted on rokko's infrastructure (Docker) or a coop laptop (desktop
  bundle, M4).

## Non-goals (v1)

- Multi-tenant SaaS.
- Per-user accounts / authentication. Reverse-proxy auth is assumed.
- Real-time stock or price sync with Lightspeed APIs. We are a CSV-in,
  CSV-out tool.
- Editing the C-Series catalog directly. The app produces a file; rokko
  imports it through Lightspeed's existing UI.

## Decisions log

These are the choices the user explicitly made in the planning conversation
that led to M0. Future PRs should not silently reverse them.

| # | Decision | Source |
|---|---|---|
| 1 | **License: MIT** | User answer |
| 2 | **Tax columns blank** — handled when R-Series and C-Series merge at the till/web boundary, so R2C Magic does not compute tax | User answer |
| 3 | **Failed enrichment is not fatal** — leave the column blank, write the reason to a `_enrichment_errors` column appended to the export | User answer |
| 4 | **Skip CB Webservices** until rokko provides credentials. Do not even scaffold a stub file | User answer |
| 5 | **Add KB SRU** (Dutch National Library) as a free fourth source — recommended over CB-only because it's auth-free and strong for the BE/NL market | User accepted recommendation |
| 6 | **No authentication in v1** — self-hosted behind a reverse proxy is the assumed deployment | User answer |
| 7 | **Auto-commit M0** once scaffold + docs are in place | User answer |
| 8 | **Package / repo name: `r2c-magic`** | User answer |
| 9 | **Mapping is configurable** via `mapping.config.json`, not hard-coded | User answer |
| 10 | **Auto-enrich without per-book review** — upload → process → download | User answer |
| 11 | **Local SQLite persistence** for runs, books, enrichments, cache, exports | User answer |
| 12 | **Web framework: Next.js 15 (App Router)** | User accepted recommendation |
| 13 | **Deployment: Docker primary, desktop binary later** | User answer |
| 14 | **Ignored C-Series columns** (written blank): `Supplier, Price, Price_Old, Price_Cost, Price_Unit, Unit, Tax, Stock_Level, Stock_Alert, Article_Code, SKU, Volume, Colli, Size_X, Size_Y, Size_Z, Buy_Min, Buy_Max, Tags` | User answer (with `*` wildcard expanded) |
| 15 | **Support both R-Series and CB-intake input formats side by side**, auto-detected from the header row. CB-intake is the hand-curated Google Sheets template rokko employees fill in for new titles | User answer (follow-up) |

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 20 LTS | Stable, matches Next.js 15 support matrix, available in Docker `node:20-bookworm-slim` |
| Language | TypeScript 5.7 strict + `noUncheckedIndexedAccess` | Catches the array/object access bugs that bite CSV pipelines |
| Framework | Next.js 15 App Router | Full-stack, server actions handle upload + run trigger, route handlers stream CSV downloads. One codebase. |
| UI | React 19 + Tailwind CSS 4 | Minimal styling needs (upload + table + progress); Tailwind is fast |
| State (client) | TanStack Query (planned M2) | For polling run progress |
| DB | SQLite via `better-sqlite3` + Drizzle ORM | Zero-config, single file, ships well in Docker and (later) Tauri |
| Job queue | In-process `p-queue`, state in SQLite | No Redis, no second process; survives restarts because state is persisted |
| CSV | `papaparse` (both read and write) | Battle-tested, handles quoting + custom delimiters |
| HTTP | native `fetch` + `AbortController` | No `axios` / `got` — fewer deps |
| Validation | Zod | All external boundaries (env, CSV rows, API responses, mapping config) |
| Logging | `pino` (+ `pino-pretty` in dev) | Structured logs are non-negotiable for a job runner |
| Lint + format | Biome | One tool, no Prettier + ESLint split |
| Testing | Vitest (unit), Playwright (e2e, M2+) | Vitest + ESM are seamless |
| Package manager | pnpm 10 (via Corepack) | Fast, strict lockfile, plays nicely with Docker layer caching |
| Container | Multi-stage Dockerfile (Node 20 slim) + docker-compose.yml | One `docker compose up` to run |
| Desktop bundle (M4) | Tauri 2 | Tiny binary, ships the Next.js standalone server inside an OS webview |

## What we explicitly chose **not** to do

| Choice | Why not |
|---|---|
| Redis + BullMQ | Adds a second process; SQLite + p-queue is enough at this scale |
| Postgres | SQLite ships as a single file; we do not need concurrent writers |
| NextAuth | No multi-user requirement in v1 |
| Electron | Too heavy compared to Tauri for our needs |
| Prisma | Drizzle's SQL-first API is closer to what we actually need, and lighter |
| `axios` / `got` | `fetch` is fine and adds zero deps |
| A second CSV library | `papaparse` covers both delimiters cleanly |
| GraphQL | Overkill — internal app with one client (the UI) |
| Live API calls in tests | Source adapter tests must use recorded JSON/XML fixtures |
