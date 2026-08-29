# R2C Magic

Enrich Lightspeed **R-Series** book exports with online metadata and produce
**C-Series** import CSVs for the rokko bookshop coop's webshop.

## Why

Rokko's shop runs Lightspeed R-Series at the till and Lightspeed C-Series
on the web. The R-Series export has the inventory essentials (EAN, price,
stock, vendor, category) but lacks everything the webshop needs to actually
sell a book online (long description, cover, meta tags). R2C Magic takes the
R-Series CSV, looks each ISBN up in several public catalogs, merges the
results, and writes a C-Series-ready import file. Zero manual data entry.

## How it works

```
   item_listings_local_matches.csv      (R-Series export)
                  │
                  ▼
        ┌──────────────────┐
        │  R2C Magic       │
        │                  │
        │  parse CSV       │
        │  enrich by EAN ──┼──▶ Google Books
        │                  └──▶ Open Library
        │  merge per field │
        │  apply mapping   │
        └──────────────────┘
                  │
                  ▼
         import-products.csv            (C-Series import, semicolon-delimited)
```

Failed lookups are not fatal: the row goes out with the data we do have, and
the reason for the miss lands in the `_enrichment_errors` column so a human
can patch the gaps later.

> Full design rationale, mapping reference, and milestone plan live in
> [`spec/`](./spec/README.md).

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20 LTS |
| Language | TypeScript 5.7 (strict, `noUncheckedIndexedAccess`) |
| Framework | Next.js 15 (App Router, server actions) |
| UI | React 19 + Tailwind CSS 4 |
| DB | SQLite via better-sqlite3 + Drizzle ORM |
| Job queue | In-process p-queue, state persisted in SQLite |
| CSV | papaparse |
| Validation | Zod |
| Lint + format | Biome |
| Testing | Vitest (unit), Playwright (e2e, M2+) |
| Distribution | Docker (server), Tauri (desktop, M4) |

## Quick start — Docker (recommended)

```sh
cp .env.example .env
docker compose up -d --build
open http://localhost:3000
```

Data persists in `./data` (SQLite database + uploaded source files + generated
exports). The mapping config is mounted read-only from `./mapping.config.json`.

## Quick start — local development

```sh
pnpm install
cp .env.example .env
pnpm db:generate     # generate migrations from src/lib/db/schema.ts
pnpm db:migrate      # apply migrations to ./data/r2c.db
pnpm dev
```

Useful scripts:

| Command | What it does |
|---|---|
| `pnpm dev` | Next.js dev server on `http://localhost:3000` |
| `pnpm build` | Production build (standalone output for Docker) |
| `pnpm start` | Run the production build |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | Biome lint + format check |
| `pnpm lint:fix` | Biome lint + format, write fixes |
| `pnpm test` | Vitest unit tests |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm db:generate` | Generate a new migration from schema changes |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:studio` | Browse the database in Drizzle Studio |

## Mobile intake — camera & HTTPS requirement

The **New arrivals** flow (`/intake`, spec v2) is a phone-first, one-book-at-a-time
path that scans the barcode with the device camera. Browsers only grant camera
access on a **secure context**, so the barcode scanner (US-B1) works only when
the app is served over **HTTPS** (or via `http://localhost` during development).

- **Deployment:** terminate TLS at the reverse proxy in front of the app; a
  plain-HTTP origin on a phone will silently fail to open the camera.
- **Fallback:** if the camera is blocked, unavailable, or the barcode is
  damaged, the same screen offers **manual EAN/ISBN-13 entry** (US-B2), so the
  flow never hard-depends on the camera.
- The scanner prefers the native `BarcodeDetector` API and falls back to
  `@zxing/browser` where it is unavailable.

## Configuration

All runtime settings live in environment variables, parsed and validated at
boot by `src/lib/config.ts`. See `.env.example` for the full list. The most
relevant:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | `./data/r2c.db` | SQLite file path |
| `DATA_DIR` | `./data` | Directory for uploads, exports, DB |
| `ENRICH_CONCURRENCY` | `5` | Books enriched in parallel |
| `ENRICH_CACHE_TTL_DAYS` | `30` | How long cached hits + misses stay fresh |
| `ENRICH_ERROR_CACHE_TTL_HOURS` | `6` | Shorter TTL for cached upstream errors so transient 5xx/429 retry sooner |
| `ENRICH_TIMEOUT_MS` | `10000` | Per-source request timeout |
| `ENRICHMENT_ENABLED` | `true` | Master kill-switch for online sources — set to `false` to disable every adapter (useful for tests + mapping-only runs) |
| `GOOGLE_BOOKS_API_KEY` | — | Optional, raises the anonymous quota |
| `OPEN_LIBRARY_USER_AGENT` | `r2c-magic/0.1 …` | Required by Open Library policy |
| `INCLUDE_ERROR_COLUMN` | `true` | Append the per-row error column to exports |
| `ERROR_COLUMN_NAME` | `_enrichment_errors` | Name of that column |

## Mapping configuration

The R-Series → C-Series mapping lives in `mapping.config.json` at the repo
root and is validated against `src/lib/csv/mapping-schema.ts`. Each entry in
`columns` is one of:

- `{ "type": "constant", "value": "Y" }` — always emit this literal
- `{ "type": "ignore" }` — always emit blank (column header is still written)
- `{ "type": "field", "from": "rseries.brand" }` — single source path
- `{ "type": "field", "from": ["enriched.publisher", "rseries.brand"] }` — fallback list, first non-empty wins
- `{ "type": "computed", "expression": "metaTitle" }` — runs a named function in `src/lib/csv/computed.ts`

Optional `transform` on `field` columns supports `truncate`, `stripHtml`, and
`divide`. Per-field source priority for merging across enrichment sources is
configured under `fieldPriority`. See the file itself for the current rokko
configuration.

Editing the mapping JSON requires a restart (or a Docker container restart
when running in compose). A small in-app editor lands in milestone M3.

### Columns currently emitted blank

By rokko's request these C-Series columns are written blank because they are
already handled when R-Series and C-Series merge at the till/web boundary:

`Supplier, Price, Price_Old, Price_Cost, Price_Unit, Unit, Tax, Stock_Level,
Stock_Alert, Article_Code, SKU, Volume, Colli, Size_X, Size_Y, Size_Z,
Buy_Min, Buy_Max, Tags`

The remaining 24 columns are actively populated.

## Adding a new enrichment source

1. Create `src/lib/enrichment/sources/<your-source>.ts` that exports an
   object implementing the `EnrichmentSource` interface from
   `sources/source.ts`.
2. Append it to the array in `src/lib/enrichment/sources/index.ts`.
3. Optionally add the new source id to `sourcePriority` and any per-field
   `fieldPriority` entries in `mapping.config.json`.
4. Add a contract test under `tests/enrichment/sources/<your-source>.test.ts`
   using recorded JSON fixtures. **No live API calls in tests.**

## Roadmap

- **M0 ✅** — Project scaffold, mapping config, schema, source stubs, Docker, CI.
- **M1 ✅** — Upload page, run processing, C-Series export download.
- **M2** — Real Google Books / Open Library / KB SRU adapters with cache,
  retry, per-source toggles in the UI.
- **M3** — Per-run detail view, in-app mapping editor, CB Webservices adapter
  (requires rokko's CB credentials).
- **M4** — Tauri desktop bundle: signed `.dmg`, `.msi`, and `.AppImage`
  installers via GitHub Actions.

## License

MIT — see `LICENSE`.
