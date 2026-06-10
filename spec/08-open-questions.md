# 08 — Open questions

Decisions that were deliberately deferred during M0. Each one has a clear
owner and a place in the codebase where the answer should land.

## Awaiting rokko

### CB Webservices credentials

- **Owner**: rokko (account manager via `uitgeverij@cb.nl` or the
  bookseller portal contact)
- **Question**: Can rokko's `aansluitnummer` be enabled for CB
  Webservices, specifically `TitelInfo` and `Image` endpoints?
- **What we need**:
  1. WSDL or OpenAPI for the endpoints
  2. Test + production base URLs
  3. Auth scheme (likely basic auth, customer number + a separate
     webservice password)
  4. Rate limits (so we can size `ENRICH_CONCURRENCY`)
- **When answered**: implement
  `src/lib/enrichment/sources/cb.ts`, add config vars to
  `src/lib/config.ts` + `.env.example`, append to `sources/index.ts`,
  bump CB to the front of `sourcePriority` in `mapping.config.json`,
  add contract tests with recorded XML fixtures. Captured in
  `spec/04-enrichment.md` and AGENTS.md.

### Google Books category → rokko categories

- **Owner**: rokko (catalog team)
- **Question**: How should `NL_Google_Category` be set? Right now it's the
  constant `Media > Books` for every row. Google Books returns much
  richer category strings; rokko may want a mapping table (e.g. keyed on
  R-Series subcategories) to drive a better Google taxonomy classification.
- **When answered**: add a new mapping table file (likely
  `category-mapping.json`) and a computed column that consults it.

### Image hosting

- **Owner**: rokko (webshop team)
- **Question**: Are external cover URLs (from Google Books / KB / OL) OK to
  drop straight into the C-Series `Images` column, or does Lightspeed
  C-Series want self-hosted images?
- **What changes if self-hosted is required**: a download + upload step in
  the job runner, an `images/` subdirectory in `data/runs/<id>/`, and a URL
  rewriter in the `images` computed column.

### Authentication

- **Owner**: rokko (IT)
- **Status**: explicitly out of scope for v1 (decision #6). Assumes reverse
  proxy auth.
- **Revisit if**: the app is exposed to multiple coop members from
  different locations.

## Awaiting M2 / M3 implementation decisions

### Run resumption on restart

- **Question**: when the server boots and finds a `runs.status = 'running'`
  row, do we resume from `books.status = 'pending'` rows, or mark the run
  `'failed'` and let the user re-upload?
- **Default**: mark `'failed'` (simpler). Resumption is a nice-to-have for
  M3.

### Mapping editor write strategy

- **Question**: when the in-app mapping editor (M3) saves, do we write
  back to `mapping.config.json` on disk, or store the active mapping in a
  new SQLite table?
- **Tradeoffs**:
  - JSON file: matches current behavior, git-friendly, but only one
    mapping at a time, and Docker users mount it read-only by default.
  - DB table: supports multiple mapping presets, runtime A/B, but loses
    git tracking of changes.
- **Current lean**: write back to disk. Track edits via git in the deploy
  workflow.

### Per-run mapping override

- **Question**: should a run be able to use a different mapping than the
  current default (for "what would this re-export look like with this
  tweak")?
- **Default**: no. One global mapping. Revisit if rokko asks.

### Forced re-enrichment

- **Question**: should the run page have a "bypass cache" toggle so a user
  can force re-fetch when a source's data improves?
- **Default**: M3 adds it. M2 ships with cache always-on.

## Code-level deferrals

### `Data_01/02/03` fields

- Currently constant empty. Could hold author / language / publication
  year if rokko wants them indexable separately from descriptions.
- Owner: rokko, when they decide what those columns are for.

### `Tags`

- Ignored per decision #14. If rokko later wants book-level tags (genre,
  series, awards), we can populate this with a computed column.

### Author canonicalization

- Sources disagree on author name format ("Jan Janssens" vs
  "Janssens, Jan"). Currently we take the first source's value verbatim.
- A normalization step + a manual override table could improve quality.
  Backlog only.

### Image deduplication

- The `coverImageUrls` merge dedups by exact URL string. Different sources
  often return the same image under different URLs (e.g. Google thumbnail
  vs full-size). Smarter dedup (by resolved redirect target, or by image
  hash) is a backlog item.

## How to close a question

When a question gets answered:

1. Update the relevant spec document with the decision.
2. Move the entry out of this document into the appropriate place
   (`01-overview.md` decisions log, `04-enrichment.md`, etc.).
3. Open / link the implementation task in `06-milestones.md`.
4. If it changes a rule, update AGENTS.md in the same change.
