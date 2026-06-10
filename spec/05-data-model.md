# 05 — Data model

Two layers: TypeScript types in `src/types/book.ts` (what flows through the
runtime) and SQLite tables in `src/lib/db/schema.ts` (what survives a
restart). They are not 1:1 — the type carries computed/merged state that
the DB stores as opaque JSON.

## Runtime types — `src/types/book.ts`

### `InputFormat`

```ts
type InputFormat = "r-series" | "cb-intake";
```

Identifies which CSV shape the user uploaded. Drives parser dispatch and is
persisted on the `runs` row.

### `RSeriesRow`

One row from the R-Series CSV after parsing + Zod validation.

```ts
interface RSeriesRow {
  systemId: string;            // R-Series "System ID" — pk in R-Series
  upc?: string;
  ean: string;                 // normalized to 13 digits, lookup key
  customSku?: string;
  manufactSku?: string;
  item: string;                // title from R-Series
  vendorId?: string;
  qty?: number;
  price?: string;              // raw e.g. "€19.90" — we do not coerce
  tax?: string;
  brand?: string;
  publishToEcom?: string;
  season?: string;
  department?: string;
  msrp?: string;
  taxClass?: string;
  defaultCost?: string;
  vendor?: string;
  category?: string;
  subcategories: string[];     // Subcategory 1..9 filtered to non-empty
}
```

### `CbIntakeRow`

One row from the CB-intake Google Sheets template after parsing + Zod
validation. Dutch column headers are mapped to lowerCamel TS field names.

```ts
interface CbIntakeRow {
  ean: string;                 // lookup key, 13 digits
  description?: string;        // -> title (the "Description" column)
  brand?: string;              // -> author (the "Brand" column — rokko convention)
  sku?: string;
  tag?: string;                // free-form, e.g. "nederlands"
  purchasePrice?: string;      // aankoopprijs, kept verbatim ("19.2", "30.00")
  sellPrice?: string;          // verkoopprijs
  supplier?: string;           // leverancier, usually "CB"
  taxClass?: string;           // btw, usually "Item"
  desiredStock?: number;       // gewenste voorraad
  reorderPoint?: number;       // herbestellingspunt
}
```

### `BookSource`

Discriminated union carrying the raw upload row alongside its format kind.
The mapping engine uses `kind` to decide which dotted-path roots resolve.

```ts
type BookSource =
  | { kind: "r-series"; rSeries: RSeriesRow }
  | { kind: "cb-intake"; cb: CbIntakeRow };
```

### `EnrichedBook`

The canonical post-merge shape — what the C-Series writer consumes.

```ts
interface EnrichedBook {
  ean: string;
  source: BookSource;          // raw upload row + format kind

  titleShort?: string;
  titleLong?: string;
  subtitle?: string;
  authors?: string[];
  publisher?: string;
  descriptionShort?: string;
  descriptionLong?: string;        // may contain HTML
  weightGrams?: number;
  dimensionsMm?: { x?: number; y?: number; z?: number };
  pages?: number;
  language?: string;               // ISO 639-1 when possible
  publicationDate?: string;        // ISO yyyy[-mm[-dd]]
  categories?: string[];
  coverImageUrls?: string[];

  fieldSources: Partial<Record<keyof EnrichedBook, EnrichmentSourceId>>;
  errors: Array<{ source: EnrichmentSourceId; message: string }>;
}

type EnrichmentSourceId =
  | "google-books"
  | "open-library"
  | "kb-sru"
  | "cb"        // reserved for CB Webservices, M3+
  | "r-series"  // provenance: value came from the uploaded row, not online
  | "merged";   // sentinel for fields whose priority is "merge" (e.g. coverImageUrls)
```

> Note: `EnrichmentSourceId` is distinct from `InputFormat`. `EnrichmentSourceId`
> names *online* data sources used during enrichment (the `"cb"` entry is the
> reserved Centraal Boekhuis Webservices source, M3+); `InputFormat` names
> *input file shapes* the parser knows.

`fieldSources` records provenance per field for future UI surfaces ("this
description came from KB SRU"). `errors` is the per-source failure list
that ends up in the `_enrichment_errors` CSV column.

### `PartialEnrichment`

What an `EnrichmentSource` adapter returns. Equivalent to:

```ts
type PartialEnrichment = Omit<Partial<EnrichedBook>, "ean" | "source" | "fieldSources" | "errors">;
```

Every field optional; the source supplies whichever subset it has.

## SQLite schema — `src/lib/db/schema.ts`

Five tables, all defined with Drizzle. Foreign keys are enforced
(`PRAGMA foreign_keys = ON` in `client.ts`).

### `runs`

One row per uploaded book CSV (R-Series or CB-intake — see `format`).

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | ULID |
| `source_file_name` | text NOT NULL | Original upload name |
| `source_file_path` | text NOT NULL | Path under `DATA_DIR/runs/<id>/` |
| `format` | enum text | `r-series \| cb-intake` — detected from header row |
| `uploaded_at` | int (ms epoch) | default `unixepoch() * 1000` |
| `status` | enum text | `pending \| running \| completed \| failed` |
| `total_books` | int | populated after parse |
| `processed_books` | int | incremented as the queue chews through |
| `failed_books` | int | books with no usable enrichment |
| `error` | text NULL | run-level error message |

### `books`

One row per book in a run.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | ULID |
| `run_id` | text FK → `runs.id` ON DELETE CASCADE | |
| `ean` | text NOT NULL | denormalized for indexed lookups |
| `source_payload` | json NOT NULL | full `BookSource` discriminated union (`{ kind, rSeries\|cb }`) for replay |
| `enriched_payload` | json NULL | full `EnrichedBook` after merge |
| `status` | enum text | `pending \| enriching \| done \| failed` |
| `errors` | json NULL | array of `{ source, message }` |

### `enrichments`

Per-source response per book — raw audit trail.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `book_id` | text FK → `books.id` ON DELETE CASCADE | |
| `source` | text NOT NULL | source id |
| `payload` | json NULL | raw or normalized response |
| `fetched_at` | int (ms epoch) | |
| `http_status` | int NULL | |
| `error` | text NULL | error message if the call failed |

### `enrichment_cache`

Global, source-keyed cache by EAN. Survives across runs so re-uploading
the same titles costs us nothing.

| Column | Type | Notes |
|---|---|---|
| `source` | text | composite PK |
| `ean` | text | composite PK |
| `payload` | json NULL | |
| `fetched_at` | int (ms epoch) | TTL applied at read time |

### `exports`

Generated C-Series CSVs.

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | |
| `run_id` | text FK → `runs.id` ON DELETE CASCADE | |
| `file_path` | text NOT NULL | under `DATA_DIR/runs/<id>/` |
| `row_count` | int NOT NULL | |
| `created_at` | int (ms epoch) | |

## Migrations

- Files live in `src/lib/db/migrations/`, generated by Drizzle Kit.
- `pnpm db:generate` produces a new migration from `schema.ts` changes.
- `pnpm db:migrate` applies pending migrations to `DATABASE_URL`.
- Current migrations:
  - `0000_moaning_natasha_romanoff.sql` — initial schema (M0)
  - `0001_add_format_and_rename_payload.sql` — adds `runs.format`, renames
    `books.r_series_payload` to `books.source_payload`, and re-wraps
    existing payload JSON as a `{ kind: "r-series", rSeries: {...} }`
    discriminated union
- AGENTS.md hard rule: if `schema.ts` changes, the migration must be
  generated and committed in the same change.

## Storage layout on disk

```
data/
├── r2c.db                      SQLite database (gitignored)
├── r2c.db-wal                  WAL file (gitignored)
└── runs/
    └── <ulid>/
        ├── source.csv          Uploaded CSV (R-Series export or CB-intake template)
        └── export.csv          Generated C-Series CSV
```

The `data/` directory is mounted as a Docker volume in `docker-compose.yml`
and is the entire persistent state of the app. A backup script needs only
to copy this directory.
