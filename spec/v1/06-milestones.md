# 06 — Milestones

R2C Magic ships in five milestones. Each is a self-contained branch / PR
target and ends with `pnpm typecheck && pnpm lint && pnpm test` green.

## Status snapshot

| ID | Title | Status |
|---|---|---|
| **M0** | Scaffold | **done** (commit `4fae5a8 — chore: initial scaffold (M0)`) |
| **M1** | CSV pipeline (no enrichment) | **done** |
| **M2** | Real enrichment (Google Books, Open Library) | not started |
| **M3** | Polish (per-run UI, mapping editor, CB adapter) | not started |
| **M4** | Tauri desktop bundle | not started |

---

## M0 — Scaffold ✅

Goal: a buildable project with the full architecture in place but no
end-to-end flow. Lets every later milestone start from the same baseline.

Delivered:

- Next.js 15 App Router + TypeScript strict + Tailwind 4 + Biome + Vitest
- Drizzle + better-sqlite3, schema for 5 tables, initial migration
- Configurable R→C mapping in `mapping.config.json` with the agreed ignore
  list (19 columns)
- CSV pipeline: R-Series parser, mapping engine, C-Series writer, computed
  columns, `_enrichment_errors` column
- `EnrichmentSource` interface, registry, and stubs for Google Books and
  Open Library; merge engine with per-field source priority
- 32 passing unit tests across 5 files
- Multi-stage Dockerfile + docker-compose.yml + healthcheck
- GitHub Actions CI (typecheck + lint + test)
- AGENTS.md, README.md, MIT LICENSE
- This `spec/` folder

Out of scope deliberately:
- Upload UI (M1)
- Real source implementations (M2)
- Job runner / queue (M2)

---

## M1 — CSV pipeline (no enrichment) ✅

Goal: a user can upload an R-Series CSV in the browser and download a
C-Series CSV that has all the ignored columns blank, all the constant
columns filled, and all the R-Series-derived columns populated. Enrichment
columns are blank for now.

Delivered:

- `src/lib/runs/` module: `createRun`, `processRunSync`, `listRuns`,
  `getRun`, `getLatestExportPath`, plus `paths.ts` (filesystem layout) and
  `seed.ts` (R-Series → EnrichedBook bridge with no enrichment).
- Auto-migration on first DB open: `src/lib/db/client.ts` runs pending
  migrations when it opens the SQLite file. No more separate
  `pnpm db:migrate` step in dev or production.
- Server action `uploadRunAction(formData)` in `src/app/actions.ts` with
  validation (CSV ≤ 20 MB, non-empty, plausible file type).
- Route handlers:
  - `GET /api/runs/[id]` → JSON `RunSummary`
  - `GET /api/runs/[id]/export` → streamed C-Series CSV with
    `Content-Disposition: attachment; filename="r2c_<source>.csv"`
- UI:
  - `src/components/upload-dropzone.tsx` — HTML5 dropzone client
    component (no external deps), uses `useTransition` for the upload
    server action call.
  - `src/components/run-table.tsx` — recent runs table with status
    chips.
  - `src/app/page.tsx` — dashboard combining the dropzone and the runs
    table.
  - `src/app/runs/[id]/page.tsx` — per-run detail with status, counts,
    download button, and a banner reminding the user that M1 exports
    have blank enrichment fields.
- Tests (43 passing total; 11 new for M1):
  - `tests/runs/runs.test.ts` (6) — `createRun` persists run + books;
    source CSV written under the run dir; `processRunSync` writes export
    and marks run completed; export CSV has the expected header + data
    shape; `listRuns` orders newest-first (with ULID tiebreaker for
    same-second uploads); unknown run IDs are rejected.
  - `tests/runs/api.test.ts` (4) — `GET /api/runs/[id]` returns the
    summary or 404; `GET /api/runs/[id]/export` streams CSV with correct
    headers or returns 404.
  - `tests/runs/e2e-sample.test.ts` (1, skipped if the sample CSV is
    absent) — uploads `imports/item_listings_local_matches.csv`,
    processes it, parses the export back with papaparse, asserts row
    count and per-row EAN/title/Visible values.
  - `tests/helpers/tmp-env.ts` — test fixture for an isolated tmp
    `DATA_DIR` + `DATABASE_URL` per test, with `vi.resetModules` so
    `lib/config.ts` re-reads env.

Out of scope deliberately (deferred to M2):
- Real source adapters (still stubs)
- In-process job queue (M1 runs everything synchronously inside the
  upload request — fine for the no-enrichment case)
- Per-book detail UI

Definition of done — all green:
- `pnpm typecheck` ✓
- `pnpm lint` ✓
- `pnpm test` ✓ (43/43)
- `pnpm build` ✓ (6 routes compiled)
- Uploading `imports/item_listings_local_matches.csv` produces a download
  whose data rows have the expected R-Series-derived values and blank
  enrichment columns (verified by `e2e-sample.test.ts`).

---

## M2 — Real enrichment

Goal: replace the source stubs with real implementations, add the
in-process job queue, and surface progress in the UI.

Tasks:

- [x] **Google Books adapter** — real `fetchByEan`, HTTP 429 surfaced as
  recordable error (key-less anonymous quota is shared and tiny — users
  set `GOOGLE_BOOKS_API_KEY` for real volume), thumbnail URL upgrade
  (`http→https` + strip `edge=curl`), category passthrough, fixtures
  for found / not-found / 429.
- [x] **Open Library adapter** — combine `/api/books?bibkeys=ISBN:<ean>&jscmd=data`
  with `/isbn/<ean>.json` and (when the edition links to a work)
  `/works/<id>.json` for the description; set User-Agent from config;
  fixtures.
- ~~**KB SRU adapter**~~ — dropped during M2 investigation. The free
  `jsru.kb.nl` endpoint returned a default ANP news record for every ISBN
  query; the real book catalog (GGC) requires KB credentials. See
  `spec/04-enrichment.md` for the full note.
- [x] `src/lib/jobs/queue.ts` — single `p-queue` instance with concurrency
  from config.
- [x] `src/lib/jobs/runner.ts` + `run.ts` — process one run end-to-end
  via the queue. Cache lookup per source (hits 30d, errors 6h), persist
  `enriched_payload` + per-source `enrichments` rows, finalize when the
  last book lands, write the C-Series export, flip `runs.status`.
- [x] Boot-time resumption via `instrumentation.ts` → `runBootRecovery()`:
  books stuck in `'enriching'` flipped back to `'pending'`; runs still
  marked `'running'` re-enqueued. Resume (not fail) chosen because the
  self-hosted deployment may restart frequently.
- [x] Run page polls `/api/runs/[id]` and shows progress (Piece 4).
      `getRunDetail` extends the run summary with a per-status book
      histogram and a small sample (cap 25) of the most recent enrichment
      errors; the new `src/components/run-progress.tsx` client component
      polls every 1s while the run is pending/running, renders a
      multi-segment progress bar (done / failed / enriching / pending)
      plus a collapsible "recent errors" panel, and calls
      `router.refresh()` exactly once on terminal state so the
      server-rendered download link swaps in without a manual reload.
- [x] M2 real-file e2e: upload the rokko CB-intake sample (29 Dutch
      books) with a routing `fetch` stub backed by 5 captured Google
      Books fixtures + permanent Open Library misses → assert both the
      generated C-Series CSV and the persisted `EnrichedBook` records
      (Piece 5). Fixture-selection probed Open Library against the
      live API for every Dutch EAN in the sample and confirmed zero
      coverage, so the e2e encodes that real-world limitation rather
      than fabricating hits we won't see in production.
- [ ] Add `coverage/` to `.gitignore`, raise coverage target for source
  adapters.

Definition of done:
- Uploading a 3,000-row CSV completes in reasonable time on a laptop
  (target: < 5 minutes warm, < 15 minutes cold).
- No live API calls in CI.

---

## M3 — Polish

Goal: rokko-friendly UI for run inspection and mapping edits, plus the CB
adapter once credentials are in hand.

Tasks:

- [ ] **Per-run detail page**:
  - Filter books by status (`done` / `failed`)
  - Click a book → see per-source raw payloads and merged result
  - "Retry failed books" button (re-enqueues failed rows with cache
    bypass)
- [ ] **Mapping editor UI** at `/mapping`:
  - Show every column with its current type + source
  - Edit `from` paths, transforms, constants
  - Validate against `mapping-schema.ts` before saving
  - Save writes back to `mapping.config.json` atomically
- [ ] **Source toggles** in `/settings`: enable/disable individual sources
  at runtime (writes to a new `app_settings` table)
- [ ] **CB adapter** (`src/lib/enrichment/sources/cb.ts`) once rokko provides
  the WSDL / OpenAPI. Add env vars `CB_API_BASE_URL`, `CB_API_USERNAME`,
  `CB_API_PASSWORD` (or whatever CB requires). See `04-enrichment.md`.
- [ ] **Run history** on the dashboard with delete / re-run actions

Definition of done:
- A non-developer at rokko can change a mapping rule and re-run a previous
  upload without touching the file system.

---

## M4 — Desktop bundle

Goal: a double-click installer for macOS / Windows / Linux so the rokko
maintainer doesn't need Docker.

Tasks:

- [ ] Create `desktop/` folder with a Tauri 2 shell project
- [ ] Tauri main process spawns the Next.js standalone server on a free
  local port, then opens a webview window pointing at it
- [ ] Bundle `better-sqlite3` prebuilds per target (macos-arm64,
  macos-x64, windows-x64, linux-x64)
- [ ] Replace the SQLite path so it uses the OS app-data directory
  (`~/Library/Application Support/r2c-magic/`, `%APPDATA%/r2c-magic/`,
  `~/.local/share/r2c-magic/`) instead of `./data/`
- [ ] GitHub Actions release workflow: on tag `v*`, build per-OS
  installers and upload to a GitHub Release (`.dmg`, `.msi`, `.AppImage`)
- [ ] First-run UX: empty DB, friendly "drop your first CSV here" state
- [ ] Auto-update channel (Tauri's built-in updater, opt-in)

Definition of done:
- Maintainer downloads one file, opens it, sees the upload page in a
  native window.

---

## Backlog (post-M4, no commitment)

- Webhook trigger so a Lightspeed automation can ping the app when new
  R-Series items are added (skips manual upload)
- Direct C-Series API push (requires reading the Lightspeed eCom API)
- Image self-hosting: download covers from sources, upload to rokko-owned
  storage, rewrite `Images` URLs
- Author / publisher canonicalization across sources (string normalization +
  manual override table)
- Bulk operations on past runs (re-export with a new mapping without
  re-enriching)
