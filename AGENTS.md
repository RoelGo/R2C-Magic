# AGENTS.md

Instructions for any AI coding agent working on this repository. Keep this
file short, scannable, and project-specific — the conventions here are what
distinguish "good change" from "merge conflict" in this codebase.

## Project in one paragraph

**R2C Magic** ingests Lightspeed R-Series book export CSVs, enriches each
book by ISBN/EAN against public catalogs (Google Books, Open Library, KB SRU;
CB Webservices once credentials arrive), and produces a Lightspeed C-Series
import CSV for the rokko bookshop coop's webshop. The mapping between
R-Series fields, enriched metadata, and C-Series columns is encoded in
`mapping.config.json` at the repo root — it is the single source of truth.

> Full design rationale lives in [`spec/`](./spec/README.md). When this file
> and the spec disagree on **code rules**, this file wins; when they disagree
> on **design intent**, the spec wins. Surface conflicts rather than guessing.

## Tech stack

- **Node.js 20 LTS**, **TypeScript 5.7 strict** (`noUncheckedIndexedAccess`)
- **Next.js 15** App Router, server actions for mutations
- **SQLite** via `better-sqlite3` + **Drizzle ORM** (schema in
  `src/lib/db/schema.ts`)
- **Tailwind CSS 4** for styling
- **Vitest** for unit tests, **Playwright** for e2e (added in M2)
- **Biome** for lint + format (single tool, no Prettier, no ESLint)
- **pnpm** as package manager (Node Corepack picks the right version)

## Repository layout

```
src/
  app/                Next.js App Router (UI + route handlers)
  components/         React components
  lib/
    csv/              R-Series parser, C-Series writer, mapping engine
    db/               Drizzle schema, client, migrations
    enrichment/
      sources/        One file per external data source
      merge.ts        Per-field merge across sources
      orchestrator.ts Enrich a single book end-to-end
    jobs/             In-process queue + run worker
    config.ts         Validated env config (Zod)
    logger.ts         pino logger
  types/              Cross-cutting types (Book, RSeriesRow, …)
tests/
  csv/                Unit tests for parser, writer, mapping
  enrichment/         Unit tests for merge + per-source contracts
  e2e/                Playwright (M2+)
mapping.config.json   Editable R→C mapping
imports/              Sample R-Series CSV (do not commit user data)
templates/            Sample C-Series CSV (reference for column shape)
data/                 SQLite DB + per-run files — gitignored
```

## Hard rules

1. **TypeScript strict, no `any`.** Biome is configured to error on
   `noExplicitAny`. Use `unknown` + Zod at every boundary instead.
2. **Validate at boundaries.** Every CSV row, API response, and env var goes
   through a Zod schema before being used. See `src/lib/config.ts` and
   `src/lib/csv/r-series.ts` for the pattern.
3. **The mapping is data, not code.** Do not hard-code R→C field rules in
   `src/`. Add or edit entries in `mapping.config.json`. New transform kinds
   (e.g. `transform.uppercase`) go through `mapping-schema.ts` first.
4. **No `process.env` outside `src/lib/config.ts`.** Read from the exported
   `config` object so missing/invalid env fails at startup.
5. **No live network calls in tests.** Source adapter tests must use recorded
   JSON/XML fixtures committed under `tests/enrichment/sources/__fixtures__/`.
6. **Failed enrichment is not a crash.** A source returns
   `{ data: {} }` for "not found" and throws only on real errors. The error
   is recorded in `EnrichedBook.errors` and surfaces in the output CSV's
   `_enrichment_errors` column — it never aborts the run.
7. **Never commit anything under `data/`** (SQLite db, uploaded CSVs, exports).
   The directory is gitignored; keep it that way.
8. **Do not change C-Series column ignore list without confirmation.** The
   set of `"type": "ignore"` columns in `mapping.config.json` was negotiated
   with rokko. Adjust only when explicitly asked.

## Architectural conventions

- **Server actions** handle mutations triggered by the UI (form submits, file
  uploads). **Route handlers under `src/app/api/`** are reserved for streaming
  responses (CSV downloads), webhooks, and health checks.
- **All file I/O lives in `src/lib/`**, never in `src/app/` components or
  pages. Pages call lib functions.
- **One adapter file per source** under `src/lib/enrichment/sources/`. Each
  exports a single `EnrichmentSource` object (not to be confused with the
  `BookSource` discriminated union in `@/types/book`, which is the parsed
  upload row). The registry in `sources/index.ts` is the only consumer of
  those exports.
- **Run state is in SQLite, not in memory.** A restarted server must be able
  to resume or at least report on in-flight runs.
- **Logs are structured** (pino). Use `logger.info({ runId, ean }, "...")`,
  not template strings.

## Commands

```sh
pnpm install
pnpm dev               # next dev
pnpm build             # next build (standalone output)
pnpm typecheck         # tsc --noEmit
pnpm lint              # biome check .
pnpm lint:fix          # biome check --write .
pnpm test              # vitest run
pnpm test:watch
pnpm db:generate       # drizzle-kit generate (after schema.ts changes)
pnpm db:migrate        # apply pending migrations
pnpm db:studio         # browse the DB
docker compose up -d   # run the full app in a container
```

## Definition of done

A change is ready for review when **all** of the following are true:

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes (and new behavior has tests)
- [ ] If `src/lib/db/schema.ts` changed, a migration was generated with
      `pnpm db:generate` and committed
- [ ] If `mapping.config.json` changed, `tests/csv/mapping-config.test.ts`
      still passes
- [ ] No new entries in `data/`, no secrets, no live API responses committed

## What NOT to do

- Do not run `pnpm db:migrate` against a production database without an
  explicit user request — it mutates state.
- Do not introduce a second CSV library; we standardize on `papaparse`.
- Do not introduce a second HTTP client; native `fetch` is sufficient.
- Do not add Redis / a separate queue process. The in-process p-queue +
  SQLite state is intentional for the self-hosted single-binary distribution.
- Do not add authentication in v1. Self-hosted behind a reverse proxy is the
  assumed deployment.
- Do not refactor the mapping engine to "be more flexible" without a concrete
  need — the current shape (constant / ignore / field / computed) covers
  every C-Series column today.

## Git + commits

- Use Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`,
  `refactor:`. Scope is optional but encouraged: `feat(csv): …`.
- Never commit `.env`, anything in `data/`, or files under `imports/` that
  contain real rokko inventory.
- Keep PRs scoped: one milestone task per branch when possible.

## Open questions for the human

These are deferred decisions the agent should surface rather than guess:

- **CB Webservices credentials.** When rokko's CB account manager provides
  the WSDL / OpenAPI spec, scaffold the adapter in
  `src/lib/enrichment/sources/cb.ts` and add it to the registry. Until then,
  the source is intentionally absent.
- **Google Books taxonomy → rokko categories.** Currently we set
  `NL_Google_Category` to a constant `Media > Books`. A proper mapping
  table (likely keyed on R-Series subcategories) is a future task.
- **Image hosting.** Cover URLs from external sources go directly into the
  `Images` column. If C-Series prefers self-hosted images, we'll need a
  download + upload step. Defer until rokko confirms.
- **Mapping editor UI.** Listed for M3. Until then, editing the JSON file
  and restarting the app is the workflow.
