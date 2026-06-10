# 02 — Architecture

## End-to-end data flow

```
   item_listings_local_matches.csv      (R-Series export)
            or
   Kopie van sjabloon … sjabloon.csv    (CB-intake template)
                  │
                  ▼ (multipart upload to a server action)
        ┌──────────────────┐
        │  R2C Magic       │
        │                  │
        │  detect format ──┼──▶ src/lib/csv/format-detect.ts
        │  parse + Zod     │  src/lib/csv/r-series.ts (R-Series)
        │                  │  src/lib/csv/cb-intake.ts (CB-intake)
        │  insert run +    │  src/lib/db/schema.ts
        │  books rows      │
        │                  │
        │  enqueue jobs ───┼──▶ in-process p-queue
        │                  │
        │  per book:       │
        │   ├─ cache hit?  │  enrichment_cache
        │   ├─ fetch each ─┼──▶ Google Books
        │   │  source in   ├──▶ Open Library
        │   │  parallel    └──▶ KB SRU
        │   │              │     (CB Webservices — pending credentials)
        │   ├─ merge       │  src/lib/enrichment/merge.ts
        │   └─ persist     │  enrichments + books.enriched_payload
        │                  │
        │  apply mapping   │  src/lib/csv/c-series.ts
        │  write export    │  data/runs/<id>/export.csv
        └──────────────────┘
                  │
                  ▼ (streamed download from /api/runs/[id]/export)
         import-products.csv            (C-Series import)
```

## Repository layout

```
r2c-magic/
├── AGENTS.md                  Operational rules for AI agents
├── README.md                  User-facing quick start
├── LICENSE                    MIT
├── spec/                      This folder — design rationale
├── mapping.config.json        R → C mapping (single source of truth)
├── imports/                   Sample CSVs (R-Series + CB-intake — gitignored, rokko-provided)
├── templates/                 Sample C-Series CSV (Lightspeed-provided)
├── data/                      Runtime DB + per-run files (gitignored)
│
├── package.json, tsconfig.json, biome.json, vitest.config.ts,
├── drizzle.config.ts, next.config.ts, tailwind.config.ts, postcss.config.mjs
├── Dockerfile, docker-compose.yml, .dockerignore
├── .env.example, .gitignore, .editorconfig
├── .github/workflows/ci.yml   typecheck + lint + test
│
├── src/
│   ├── app/                   Next.js App Router (UI + route handlers)
│   │   ├── layout.tsx
│   │   ├── page.tsx           Dashboard: upload + recent runs
│   │   ├── globals.css
│   │   ├── api/
│   │   │   ├── health/route.ts          GET /api/health
│   │   │   ├── runs/route.ts            (M1) POST upload, GET list
│   │   │   ├── runs/[id]/route.ts       (M1) GET status
│   │   │   └── runs/[id]/export/route.ts (M1) GET C-series CSV
│   │   └── runs/[id]/page.tsx (M1) Run detail
│   │
│   ├── components/            React components (M1+)
│   │
│   ├── lib/
│   │   ├── config.ts          Validated env config (Zod)
│   │   ├── logger.ts          pino structured logger
│   │   │
│   │   ├── csv/
│   │   │   ├── r-series.ts          Parse comma/quoted R-Series export
│   │   │   ├── cb-intake.ts         Parse the rokko CB-intake template
│   │   │   ├── format-detect.ts     Sniff header row → InputFormat
│   │   │   ├── c-series.ts          Write semicolon C-Series import
│   │   │   ├── mapping.ts           Field resolution + transforms
│   │   │   ├── mapping-schema.ts    Zod schema for mapping.config.json
│   │   │   └── computed.ts          Computed columns (metaTitle, images, …)
│   │   │
│   │   ├── db/
│   │   │   ├── schema.ts            Drizzle table definitions
│   │   │   ├── client.ts            Singleton SQLite + Drizzle client
│   │   │   ├── migrate.ts           CLI: apply pending migrations
│   │   │   └── migrations/          drizzle-kit output
│   │   │
│   │   ├── enrichment/
│   │   │   ├── sources/
│   │   │   │   ├── source.ts            BookSource interface
│   │   │   │   ├── google-books.ts      Stub (M2)
│   │   │   │   ├── open-library.ts      Stub (M2)
│   │   │   │   ├── kb-sru.ts            Stub (M2)
│   │   │   │   └── index.ts             Source registry
│   │   │   ├── merge.ts             Per-field priority merge
│   │   │   └── orchestrator.ts      Enrich one book end-to-end
│   │   │
│   │   └── jobs/                    (M2) p-queue + run worker
│   │
│   └── types/
│       └── book.ts            Canonical InputFormat, RSeriesRow, CbIntakeRow, BookSource, EnrichedBook
│
└── tests/
    ├── csv/                   Parser, writer, mapping engine
    ├── enrichment/            Merge + (M2) per-source contract tests
    │   └── sources/__fixtures__/  Recorded API responses (M2)
    └── e2e/                   Playwright (M2+)
```

## Module responsibilities (and what NOT to do in each)

### `src/lib/config.ts`

- **Does**: parse `process.env` once at boot, validate with Zod, export
  typed `config` object.
- **Does not**: read env anywhere else. AGENTS.md hard rule: no
  `process.env.*` outside this file.

### `src/lib/csv/r-series.ts`

- **Does**: parse the R-Series export shape, normalize EANs to 13 digits,
  produce `RSeriesRow[]` and a separate `invalid[]` list. Exports the
  generic `ParseResult<TRow>` type that the CB-intake parser also uses.
- **Does not**: enrich, transform values, or write anything to disk.

### `src/lib/csv/cb-intake.ts`

- **Does**: parse the rokko CB-intake template (mixed English / Dutch
  headers), normalize EANs, produce `CbIntakeRow[]` + `invalid[]`.
- **Does not**: enrich, transform values, or convert locale-formatted
  numbers (prices stay as strings until the mapping layer sees them).

### `src/lib/csv/format-detect.ts`

- **Does**: read the header row of an uploaded CSV and return the
  matching `InputFormat`, or `undefined` if neither parser would accept
  it. Pure function of input.
- **Does not**: parse the body of the file, do any I/O, or decide what
  to do on `undefined` — that's the caller's job.

### `src/lib/csv/mapping.ts` + `mapping-schema.ts` + `computed.ts`

- **Does**: load `mapping.config.json`, validate it, resolve dotted paths
  (`enriched.titleLong`, `rseries.subcategory.0`, `cb.description`), apply
  transforms (`truncate`, `stripHtml`, `divide`), evaluate named computed
  columns. Paths for the wrong input format silently resolve to
  `undefined` so a single `from: [...]` chain can serve both formats.
- **Does not**: contain any actual mapping rules. Rules live in the JSON.

### `src/lib/csv/c-series.ts`

- **Does**: take `EnrichedBook[]` + mapping config, produce a CSV string
  with the configured delimiter, line ending, BOM, and `_enrichment_errors`
  column.
- **Does not**: enrich, persist, or trigger I/O. Pure function of inputs.

### `src/lib/enrichment/sources/<name>.ts`

- **Does**: implement `BookSource.fetchByEan(ean, signal)` for one source.
  Returns `{ data: PartialEnrichment, httpStatus }`. Returns `{ data: {} }`
  for "not found" (does NOT throw).
- **Does not**: cache, retry, log to stdout (use the pino logger),
  reference other sources, or call the merger directly.

### `src/lib/enrichment/merge.ts`

- **Does**: combine per-source `PartialEnrichment` objects into one
  `EnrichedBook` according to `fieldPriority` and `sourcePriority` in the
  mapping config. Handles the special `"merge"` policy for arrays
  (currently only `coverImageUrls`).
- **Does not**: fetch, persist, or know about specific sources.

### `src/lib/enrichment/orchestrator.ts`

- **Does**: for one book, kick off all enabled sources in parallel with one
  shared abort signal, collect results + errors, call the merger.
- **Does not**: queue work, persist results, or write the CSV. Those are
  the job runner's responsibility (M2).

### `src/lib/db/*`

- **Does**: declare the schema, expose a singleton Drizzle client, run
  migrations on demand.
- **Does not**: contain business logic. Database queries live in feature
  modules that import from here.

### `src/app/`

- **Does**: render UI, define server actions and route handlers, call into
  `src/lib/*` for everything else.
- **Does not**: do file I/O, parse CSVs, hit external APIs, or talk to the
  database directly. All of those go through `src/lib/`. AGENTS.md hard
  rule: pages are thin.

## Conventions

- **Server actions** handle mutations triggered by forms / file uploads.
- **Route handlers** under `src/app/api/` are reserved for streaming
  responses (CSV downloads), webhooks, and health checks.
- **Run state is in SQLite**, not in memory. A restarted server can still
  see what was in flight.
- **Logs are structured**. `logger.info({ runId, ean }, "enriched")`, not
  `logger.info('enriched ' + runId)`.
- **All boundaries are Zod-validated** (env, CSV rows, API responses,
  mapping config).
