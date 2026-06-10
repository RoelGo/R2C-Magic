# 06 — Milestones

R2C Magic ships in five milestones. Each is a self-contained branch / PR
target and ends with `pnpm typecheck && pnpm lint && pnpm test` green.

## Status snapshot

| ID | Title | Status |
|---|---|---|
| **M0** | Scaffold | **done** (commit `4fae5a8 — chore: initial scaffold (M0)`) |
| **M1** | CSV pipeline (no enrichment) | not started |
| **M2** | Real enrichment (Google Books, Open Library, KB SRU) | not started |
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
- `BookSource` interface, registry, and stubs for Google Books, Open
  Library, KB SRU; merge engine with per-field source priority
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

## M1 — CSV pipeline (no enrichment)

Goal: a user can upload an R-Series CSV in the browser and download a
C-Series CSV that has all the ignored columns blank, all the constant
columns filled, and all the R-Series-derived columns populated. Enrichment
columns are blank for now.

Tasks:

- [ ] Server action `uploadRun(formData)` that:
  - validates the file is a CSV ≤ 20 MB
  - copies it to `DATA_DIR/runs/<id>/source.csv`
  - calls `parseRSeriesCsv`
  - inserts a `runs` row + N `books` rows with `enriched_payload = null`
- [ ] Synchronous "fake enrichment" pass (M1 only): build `EnrichedBook`
  from `RSeriesRow` alone, persist, generate `export.csv` via `booksToCsv`
- [ ] Route handler `GET /api/runs/[id]/export` streams the export
- [ ] Route handler `GET /api/runs/[id]` returns the run + counts JSON
- [ ] `src/app/page.tsx`: a dropzone (HTML5, no external deps in M1) that
  POSTs to the server action and redirects to `/runs/[id]`
- [ ] `src/app/runs/[id]/page.tsx`: shows the run status and a download link
- [ ] New tests:
  - server action smoke test (with a tmp DATA_DIR)
  - end-to-end: parse fixture CSV → write fixture export → snapshot the
    output for regression
  - export route returns the right `Content-Disposition` and CSV body

Definition of done:
- All M0 gates still green.
- Uploading `imports/item_listings_local_matches.csv` produces a download
  whose first data row matches the expected fields by eyeball.

---

## M2 — Real enrichment

Goal: replace the source stubs with real implementations, add the
in-process job queue, and surface progress in the UI.

Tasks:

- [ ] **Google Books adapter** — real `fetchByEan`, with retry on 429,
  thumbnail URL upgrade (`http→https` + `&zoom=0`), category passthrough,
  fixtures for found / not-found / 429
- [ ] **Open Library adapter** — combine `/api/books?bibkeys=ISBN:<ean>&jscmd=data`
  with `/isbn/<ean>.json` for the description; set User-Agent from config;
  fixtures
- [ ] **KB SRU adapter** — add `fast-xml-parser`, hit
  `https://jsru.kb.nl/sru/sru.bibliotheken`, map Dublin Core fields,
  fixtures
- [ ] `src/lib/jobs/queue.ts` — single `p-queue` instance with concurrency
  from config
- [ ] `src/lib/jobs/runner.ts` — process one run end-to-end:
  - mark `runs.status = 'running'`
  - for each `books` row: cache lookup per source, call
    `enrichBook(rSeries, mapping)`, persist `enriched_payload` and per-source
    `enrichments` rows, update counters
  - when done, write `export.csv` and mark `runs.status = 'completed'`
- [ ] Boot-time resumption: on server start, find runs with `status =
  'running'` and either resume the pending books or mark the run `'failed'`
  (pick one and document it)
- [ ] Run page polls `/api/runs/[id]` (TanStack Query) and shows progress
- [ ] Add `coverage/` to `.gitignore`, raise coverage target for source
  adapters
- [ ] Playwright e2e: upload fixture CSV with mocked fetch → assert
  downloaded CSV contents

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
