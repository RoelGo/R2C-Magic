# 04 — Enrichment

R2C Magic's job is taking a thin R-Series row and fattening it up with the
data a webshop needs: long descriptions, covers, authors, publisher, weight,
dimensions, categories. We do that by looking up the EAN against multiple
public catalogs in parallel and merging the results.

## Sources

| Source | Status | Auth | Strength | Notes |
|---|---|---|---|---|
| **Google Books** | live (M2) | optional API key | Broad coverage, English-dominant, decent covers | Returns HTTP 429 quickly without a key on big runs |
| **Open Library** | live (M2) | none (User-Agent required) | Open data, covers, descriptions, works | Slower; descriptions live on the `works` document; a hit requires up to 3 HTTP calls |
| **CB Webservices** | not implemented | bookseller contract | The richest BE/NL trade metadata: descriptions, covers, NUR codes, dimensions, themas | Requires `aansluitnummer` + a webservice subscription, see below |

The decision to skip the CB stub until credentials arrive is recorded in
`spec/01-overview.md` (decision #4).

> **Dropped: KB SRU.** The plan was to use KB's free `jsru.kb.nl` SRU
> endpoint as a Dutch-market source. Investigation during M2 showed that
> endpoint is essentially a Delpher (newspapers / digitized text) index —
> ISBN queries return either zero records or an unrelated default record
> (always the same ANP news clip from 1970). The real book catalog (GGC)
> requires KB credentials. We removed the adapter rather than ship a
> source that returns garbage. Until rokko gets CB credentials, Dutch
> coverage falls to Google Books and Open Library, which is the same
> position we were in for English titles all along.

## Source contract — `EnrichmentSource`

Defined in `src/lib/enrichment/sources/source.ts`. Named to disambiguate
from `BookSource` in `@/types/book` (the parsed-upload-row discriminated
union — a different concept entirely):

```ts
export interface EnrichmentSource {
  readonly id: EnrichmentSourceId;     // "google-books" | "open-library" | "cb"
  readonly displayName: string;
  isEnabled(): boolean;                // typically: are credentials present?
  fetchByEan(ean: string, signal: AbortSignal): Promise<FetchResult>;
}

export interface FetchResult {
  data: PartialEnrichment;             // {} for "not found" — NEVER throw for that
  raw?: unknown;                       // optional raw payload, for audit
  httpStatus: number;
}
```

`PartialEnrichment` is `Omit<Partial<EnrichedBook>, "ean" | "source" |
"fieldSources" | "errors">` — i.e. every enriched field is optional and the
source can supply any subset.

### Hard rules for adapters (from AGENTS.md)

1. **`{ data: {} }` for "not found"**. Throwing aborts the pipeline.
2. **Throw for real errors** (network, parse). The orchestrator catches and
   records them in `EnrichedBook.errors`.
3. **Respect `AbortSignal`**. The orchestrator gives each source its own
   `AbortController` with `ENRICH_TIMEOUT_MS`, so a slow upstream does not
   cancel the others.
4. **No live API calls in tests**. Use recorded JSON/XML fixtures committed
   under `tests/enrichment/sources/__fixtures__/`.
5. **One adapter file per source** under `src/lib/enrichment/sources/`.
6. **No cross-source coupling**. An adapter knows about its own API and
   nothing else.

### Google Books cover image quality rule

Google's `imageLinks` object maps field names to `zoom` values:

| `imageLinks` key | `zoom` | Quality    |
|---|---|---|
| `smallThumbnail` | 5 | thumbnail — **excluded** |
| `thumbnail`      | 1 | thumbnail — **excluded** |
| `small`          | 2 | proper ✓ |
| `medium`         | 3 | proper ✓ |
| `large`          | 4 | proper ✓ |
| `extraLarge`     | 6 | proper ✓ |

The Google Books adapter (`src/lib/enrichment/sources/google-books.ts`)
only includes `small`, `medium`, `large`, and `extraLarge` in
`coverImageUrls`. If none of those sizes are present (which is the common
case for ISBN lookups — Google typically returns only
`thumbnail`/`smallThumbnail`), the adapter returns `[]` for
`coverImageUrls`, and the merge step naturally falls through to the next
source (Open Library or CB). The export's `Images` column then reflects the
Open Library or CB cover instead.

When no proper cover exists from any source, `Images` is left blank.

### Cover image selection at export time

The `images` computed expression (`src/lib/csv/computed.ts`) collapses the
merged `coverImageUrls` array to a **single best-resolution URL** via
`pickPrimaryCover`:

- Open Library covers grouped by numeric cover id; `-L > -M > -S`.
- Google Books covers grouped by `id` query param; input order (largest
  first) determines the winner.
- Unknown hosts: each URL is its own group; array order decides.

The first group in array order (which encodes source priority and
largest-first within source) provides the output URL.



1. Create `src/lib/enrichment/sources/<your-source>.ts` exporting an
   `EnrichmentSource`.
2. Append it to the array in `src/lib/enrichment/sources/index.ts`.
3. If it should outrank other sources for any field, add it to
   `sourcePriority` and/or `fieldPriority` in `mapping.config.json`.
4. Add `<your-source>.test.ts` with at least: a 200-response fixture, a
   404-response fixture (asserts `{ data: {} }`), and an abort test.

## Merge engine — `src/lib/enrichment/merge.ts`

The merger combines per-source `PartialEnrichment` objects into one
`EnrichedBook` according to the mapping config. It is **pure** — no I/O,
no logging, no source knowledge beyond the priority lists.

### Rules

1. For each enriched field, look up the priority list:
   - `fieldPriority[<field>]` if present
   - else `sourcePriority`
2. Walk the priority list in order; take the first source whose value for
   that field is "present" (non-null, non-empty string, non-empty array,
   non-empty object).
3. The chosen source id is recorded in `EnrichedBook.fieldSources` for
   audit and future UI use.
4. The special value `"merge"` (currently only `coverImageUrls`) unions the
   array values from every source in `sourcePriority` order, dedup
   preserving first-seen.
5. `errors` is the concatenation of all source errors — never empty
   silenced.

### Example

With `sourcePriority: ["cb", "google-books", "open-library"]` and
`fieldPriority: { "descriptionLong": ["cb", "google-books", "open-library"] }`:

| Source | `descriptionLong` provided? |
|---|---|
| cb | — |
| google-books | "From Google" |
| open-library | "From OL" |

→ The merger picks `"From Google"` and sets `fieldSources.descriptionLong =
"google-books"`.

## Orchestrator — `src/lib/enrichment/orchestrator.ts`

For one book:

```ts
async function enrichBook(source: BookSource, mapping: MappingConfig): Promise<EnrichedBook>
```

- Accepts a `BookSource` (the discriminated union: either an R-Series row
  or a CB-intake row) so enrichment works the same way regardless of
  which CSV the user uploaded. The EAN is read off the active branch.
- Creates one `AbortController` with `ENRICH_TIMEOUT_MS` per source.
- Calls every `enabledSources()` adapter in parallel via `Promise.all`.
- Catches per-source errors, records them in `errors`, **never throws**.
- Hands `(source, perSource, errors)` to the merger.
- Returns the merged `EnrichedBook`.

The orchestrator does **not** persist anything or talk to the queue — those
are the job runner's concerns (M2).

## Job runner (M2)

Implemented under `src/lib/jobs/` as four modules:

- **`queue.ts`** — a module-level `p-queue` instance sized by
  `ENRICH_CONCURRENCY` (default 5). One instance shared across runs so
  total upstream load is capped no matter how many runs the user starts.
- **`runner.ts`** — `processBook(bookId, mapping)`. For one book:
  1. Mark `books.status = 'enriching'`.
  2. For each `enabledSources()` adapter in parallel:
     - Consult `enrichment_cache` keyed on `(source, ean)`. Two TTLs:
       `ENRICH_CACHE_TTL_DAYS` (default 30d) for hits and cached misses,
       `ENRICH_ERROR_CACHE_TTL_HOURS` (default 6h) for cached errors so
       transient 5xx/429 retry sooner.
     - On cache miss, call `fetchByEan` with a per-source
       `AbortController` budgeted at `ENRICH_TIMEOUT_MS` (10s).
     - Mirror every outcome (hit, miss, error) into `enrichment_cache`
       *and* persist a row into `enrichments` for audit.
  3. Pass per-source partials to `mergeEnrichments`. Persist the merged
     `EnrichedBook` to `books.enriched_payload`.
  4. Mark `books.status = 'done'` (or `'failed'` only if every enabled
     source errored). Errors are recorded on `books.errors`.
- **`run.ts`** — `enqueueRun(runId)` schedules every pending book onto
  the queue and returns immediately. When the last book lands, it
  triggers `finalizeRun(runId)` which writes the C-Series export and
  flips `runs.status`. A test helper `processRunInline(runId)` wraps
  enqueue + await for synchronous-feeling tests.
- **`boot.ts`** — `runBootRecovery()` runs once per process via the
  Next.js `instrumentation.ts` hook. Books left in `'enriching'` get
  flipped back to `'pending'` (the previous worker crashed mid-call);
  runs still marked `'running'` or `'pending'` get re-enqueued. We
  intentionally **resume** rather than fail because the self-hosted
  single-binary deployment may restart frequently, and forcing the
  user to re-upload every interrupted run would be hostile.

### `enrichment_cache` shape

| Column | Notes |
|---|---|
| `source` + `ean` | Composite primary key |
| `payload` | `null` for cached errors; `{}` for cached misses; otherwise the source's `FetchResult.data` |
| `http_status` | Whatever the upstream returned (`null` for thrown errors) |
| `error` | `null` for hits; the thrown message for errors |
| `fetched_at` | Used with one of the two TTLs above |

### Master kill-switch

Set `ENRICHMENT_ENABLED=false` to disable every online source (the
registry returns `[]`). The test suite uses this so it never reaches
the live APIs; users can also flip it to validate the mapping step
without burning quota.

The orchestrator in `src/lib/enrichment/orchestrator.ts` still exists
as a pure, uncached `enrichBook(source, mapping)` — useful for tests
and a future "retry this single book without cache" M3 feature.

## CB Webservices — onboarding notes

When rokko unlocks CB access, here's what to ask their CB account manager
(contact via `uitgeverij@cb.nl` or rokko's bookseller portal contact):

1. **Activate webservice access** for rokko's `aansluitnummer`.
2. **Get the WSDL or OpenAPI** for at least:
   - `TitelInfo` (titel metadata: titles, authors, publisher, NUR, themas,
     descriptions, dimensions)
   - `Image` (cover URLs / binary)
   - Optionally `Voorraad` (stock) and `Prijs` (price) — but we already
     handle those via the R-Series side, so not needed for v1.
3. **Get the technical onboarding doc** (env URLs for test + production,
   auth scheme — usually basic auth with the customer number + a separate
   password).
4. **Confirm the rate limit** so we can size `ENRICH_CONCURRENCY`.

Then implement `src/lib/enrichment/sources/cb.ts`:

- Read base URL + credentials from `CB_API_BASE_URL`, `CB_API_USERNAME`,
  `CB_API_PASSWORD` (or whatever CB's scheme requires). Add these to
  `src/lib/config.ts` and `.env.example` at the same time.
- `isEnabled()` → `!!CB_API_BASE_URL && !!CB_API_USERNAME`.
- Append to `sources/index.ts` registry.
- Bump CB to the front of relevant `fieldPriority` entries in
  `mapping.config.json`.

## Caching

- Keyed by `(source, ean)` in the `enrichment_cache` table.
- TTL from `ENRICH_CACHE_TTL_DAYS` (default 30 days).
- On every cache hit we still record an `enrichments` row pointing at the
  cached payload, so the per-run audit trail is complete.
- A future "force refresh" toggle on the run page (M3) bypasses the cache
  for one run.

## Failure handling

| Failure mode | Behavior |
|---|---|
| Source returns 404 / no result | `{ data: {} }`, no error, no entry in `EnrichedBook.errors` |
| Source returns 429 / 5xx | Adapter throws, error captured in `EnrichedBook.errors`, other sources still merged |
| All sources fail for a book | Book is exported with R-Series data + ignored blanks + a populated `_enrichment_errors` column |
| AbortSignal fires (timeout) | Adapter throws an `AbortError`, captured as above |
| Run process dies mid-run | Books left in `'enriching'` are flipped back to `'pending'` and re-enqueued at boot via `instrumentation.ts` → `runBootRecovery()`. Runs still marked `'running'` resume from where they left off. |
