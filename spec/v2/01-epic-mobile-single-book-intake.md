# v2 — Epic: Mobile single-book ecom intake

> This document lives under `spec/v2/`. It describes the **next major
> iteration** of R2C Magic. It does not replace v1 — the bulk CSV pipeline
> (v1) stays. v2 adds a complementary, human-in-the-loop path for the
> everyday "a few new books arrived" case, and pushes results directly to
> the Lightspeed **eCom (C-Series)** API instead of producing a CSV.
>
> When this document and v1 disagree on **intent**, this document wins for
> the v2 flow; the repo-root `AGENTS.md` still wins for **code rules**.

---

## 1. Why v2

v1 was built and shipped as a **bulk import** tool: upload an R-Series (or
CB-intake) CSV, auto-enrich every row against online catalogs, download a
C-Series CSV. Real-world use at rokko confirmed two things:

1. **The bulk path works** and was used semi-successfully for the initial
   catalog migration.
2. **The bulk path is the wrong shape for the steady state.** rokko's actual
   recurring workload is small: a supplier delivery arrives with a handful of
   new titles that are *already in Lightspeed R-Series (retail)* and just need
   an ecom (webshop) presence. For that, a CSV round-trip is heavyweight, and
   pure online auto-enrichment falls short — coverage of Dutch/Belgian titles
   is thin (v1 M2 confirmed near-zero Open Library coverage for the sample),
   and there is no cover photography or human correction step.

**v2 reframes enrichment as an assisted, mostly-automatic form** a worker
completes on a phone, one book at a time, standing at the receiving table.
Online sources and OCR **pre-fill** the form; the human confirms or corrects;
the result is pushed straight to Lightspeed eCom.

### Design principles

- **Minimal input by default, manual intervention where necessary.** The happy
  path is: scan → snap two photos → glance at a pre-filled form → submit.
- **Never block on a source.** Online enrichment runs in the background while
  the worker photographs the book. OCR and online data are *suggestions*, not
  gatekeepers. Every field is editable.
- **Mobile-first.** The primary device is a phone in a possibly-noisy back
  room. Camera, barcode scanning, and large tap targets are first-class.
- **Reuse v1.** The enrichment orchestrator, source adapters, merge engine,
  and canonical `Book` type are reused as-is. v2 adds a per-book interactive
  session, OCR, image capture, and an eCom push adapter.

### Non-goals (v2)

- Replacing the v1 bulk CSV pipeline. Both coexist.
- Authentication / multi-user accounts (still reverse-proxy-assumed).
- Creating brand-new products in R-Series. The book **already exists** in
  R-Series; v2 only creates/updates its **eCom** representation.
- Inventory/price/stock sync. v2 pushes catalog **content** (title,
  description, author, weight, images), not commercial fields.
- Offline-first / full PWA sync. v2 assumes connectivity at the table
  (graceful failure, not local queue) unless a later story says otherwise.

---

## 2. Actors & prerequisites

**Actor:** *Receiving worker* — a rokko coop member at the receiving table
with a phone, unpacking a supplier delivery. Not a developer.

**Prerequisites for a session:**

- A supplier order has been received; the package contains new books.
- Each book is **already present in Lightspeed R-Series (retail)** (so an
  EAN/ISBN already maps to an existing article).
- The worker can open the web app on their phone (same reverse-proxied host
  as the v1 UI) and the app can reach the Lightspeed eCom API.

---

## 3. Target flow (happy path)

```
 select book ──▶ scan barcode ──▶ [ EAN captured ]
                     │  (fail)          │
                     ▼                  ├──▶ online enrichment starts (async)
              manual EAN entry ─────────┘
                                        │
        photograph front cover ◀────────┘   ── OCR → title suggestion
                     │
        photograph back cover              ── OCR → description suggestion
                     │
                     ▼
     pre-filled review form
   (title · description · author · weight · images)
   each field: pick an online value, an OCR value, or type your own
                     │
                     ▼
           submit ──▶ push to Lightspeed eCom API
                     │
                     ▼
              confirmation + "next book"
```

The three inputs to the form each carry **provenance**:

| Field        | Source A (online)         | Source B (OCR)            | Source C (manual) |
|--------------|---------------------------|---------------------------|-------------------|
| Title        | catalog merge result      | front-cover OCR           | free text         |
| Description  | catalog merge result      | back-cover OCR            | free text         |
| Author       | catalog merge result      | (optional, front OCR)     | free text         |
| Weight       | catalog (if available)    | —                         | free text/number  |
| Images       | —                         | front + back photos       | retake            |

The UI presents suggested values as selectable chips per field so the worker
taps the right one instead of typing. Typing is always available as a fallback.

---

## 4. User stories

Stories are grouped into deliverable slices. Each story has a rough size
(S/M/L) and acceptance criteria. Ordering within the epic is roughly the
recommended build order.

### Slice A — Session skeleton & book selection

#### US-A1 — Start an intake session (S)
*As a receiving worker, I want to open a "New arrivals" mobile screen so I can
begin adding books from a delivery one at a time.*

- Given the app is open on a phone, there is a clearly labelled entry point
  (e.g. `/intake`) distinct from the v1 bulk upload dashboard.
- The screen is mobile-first: single column, large tap targets, works in
  portrait.
- Starting a session creates a persisted `intake_session` row (so progress
  survives a page reload / phone lock).

#### US-A2 — Track books added in this session (S)
*As a worker, I want to see the books I've already added in this session so I
know where I am in the pile.*

- The session screen lists books added so far with title + a status chip
  (`pushed` / `failed` / `draft`).
- A running count is visible ("3 books added").
- Tapping a listed book reopens its review form (read-only or editable).

---

### Slice B — Barcode capture

#### US-B1 — Scan an EAN/ISBN with the camera (M)
*As a worker, I want to scan the book's barcode with my phone camera so I don't
have to type the number.*

- Tapping "Scan" opens a live camera view with a scanning overlay.
- The scanner recognises EAN-13 / ISBN barcodes and captures the digits.
- On a successful scan the camera closes and the number is shown for
  confirmation.
- Requires HTTPS (camera access); document this deployment constraint.
- Library candidate: a WASM/JS barcode scanner (e.g. `zxing-wasm` /
  `@zxing/browser` or `BarcodeDetector` where available). No native app.

#### US-B2 — Fall back to manual EAN entry (S)
*As a worker, when scanning fails or the barcode is damaged, I want to type the
EAN/ISBN so I can still proceed.*

- If scanning fails, times out, or the worker taps "Enter manually", a numeric
  input appears.
- The entered value is validated as a plausible EAN-13 / ISBN-13 (length +
  checksum) before continuing; invalid input is flagged inline, not blocking
  after confirmation.

#### SKIP! US-B3 — Resolve the book against R-Series / existing data (M)
*As a worker, I want the system to recognise a scanned book that's already in
retail so its known data is used and I don't create a duplicate.*

- Once an EAN is captured, the system looks up whether the book is already
  known (from prior v1 runs / R-Series data available to the app) and, if so,
  pre-loads any known fields.
- **Open question (see §7):** how the app accesses current R-Series article
  data — reuse of prior imported data, an R-Series export, or a live retail
  API lookup. Story is written against "known EAN → known article" without
  binding the mechanism.

---

### Slice C — Background online enrichment

#### US-C1 — Kick off online enrichment on scan (M)
*As a worker, I want the system to start looking up the book online the moment
it has the EAN, so the data is ready by the time I finish photographing.*

- Enrichment starts **immediately after** the EAN is captured (US-B1/US-B2),
  in the background, while the worker moves on to photos.
- Reuses the v1 enrichment orchestrator + registered sources
  (`src/lib/enrichment/*`) — no new source logic for the happy path.
- A per-source not-found returns empty and never blocks; real errors are
  recorded but do not abort the session (same contract as v1 rule #6).

#### US-C2 — Show enrichment status without blocking (S)
*As a worker, I want to see whether online lookup is still running, done, or
came up empty, without it stopping me.*

- The review form shows a small inline indicator per enrichment-derived field
  ("searching…", a suggested value, or "no online match").
- If the worker reaches the form before enrichment finishes, fields fill in
  live as results arrive; the worker is never forced to wait.

---

### Slice D — Cover photography & OCR

#### US-D1 — Photograph the front cover (M)
*As a worker, I want to take a photo of the front cover so the webshop has a
product image.*

- After the EAN step the worker is prompted to capture the **front cover**.
- Live camera capture with a retake option and a visible preview.
- The image is stored against the current book (for OCR + as the primary
  webshop image).

#### US-D2 — Photograph the back cover (S)
*As a worker, I want to take a photo of the back cover so the blurb/description
can be read and shown.*

- Same capture UX as US-D1, for the **back cover**.
- Stored as a secondary image + OCR source for the description.

#### US-D3 — OCR the front cover for a title suggestion (M)
*As a worker, I want the title read off the cover automatically so I usually
don't type it.*

- OCR runs on the front-cover image and extracts candidate **title** (and
  optionally author) text.
- The result is offered as a selectable suggestion on the review form,
  labelled as coming from the cover photo.
- OCR runs asynchronously; a failure yields "no OCR result" and never blocks.
- **Open question (see §7):** OCR engine choice — on-device (e.g.
  `tesseract.js`) vs. a server-side / cloud OCR call. Story is engine-agnostic.

#### US-D4 — OCR the back cover for a description suggestion (M)
*As a worker, I want the back-cover blurb read automatically so I usually don't
type the description.*

- OCR runs on the back-cover image and extracts candidate **description** text.
- Offered as a selectable suggestion on the review form, labelled as coming
  from the back photo.
- Basic cleanup (collapse whitespace, drop obvious OCR noise) applied before
  presenting; the worker can still edit freely.

#### US-D5 — Improve title/author extraction from the front cover (M)
*As a worker, I want the OCR title to be the actual book title — not the
author's name — so the pre-filled title is usually right.*

**Why:** The initial implementation (`src/lib/ocr/extract.ts`,
`extractFrontCover`) simply takes the **first substantial cleaned line** as the
title and only treats a line as the author when it starts with `by`/`door`/
`van`. On real covers this misfires: when the author's name is printed **above**
the title, or the title is not the topmost text, the author is captured as the
title and the true title is lost. Reading order (top-to-bottom) is a poor proxy
for "which line is the title".

- Distinguish **title** vs **author** more reliably than "first line wins",
  e.g. by combining signals available from the engine: text **size / bounding
  box height** (titles are typically the largest text), position, and
  line grouping — rather than reading order alone.
- Handle the common layout where the **author appears before the title** without
  misassigning it.
- Recognise author credits beyond the `by/door/van` prefixes (bare
  "Firstname Lastname" credit lines, multiple authors, "&"/"and"/"met").
- Cross-check against online enrichment (Slice C) when available: if the
  catalog title/author is known, prefer it or use it to disambiguate which OCR
  line is the title. OCR remains the fallback when there is no online match
  (US-G2).
- **Note:** this likely needs richer engine output than plain text lines. The
  `ocrs` (`--json`) and PP-OCRv6 pipelines both expose per-line **geometry**
  (bounding boxes); the `OcrEngine` contract (`src/lib/ocr/engine.ts`) currently
  returns only `lines`/`text` and would need to carry optional box/size data for
  the size-based heuristic. Keep the plain-text path working as a fallback.

#### US-D6 — Trim non-description text from the back cover (M)
*As a worker, I want the OCR description to contain just the blurb — not review
quotes, the author bio, price, ISBN, or publisher boilerplate — so I don't have
to delete lines every time.*

**Why:** `extractBackCover` currently **joins every cleaned back-cover line**
into one paragraph. Back covers routinely also carry press-quote endorsements,
an author biography, series/publisher blurb, a barcode/ISBN block, price, and a
website — all of which end up appended to the description today.

- Identify and drop non-blurb regions: **review/press quotes** (often quoted or
  attributed to a source), **author bio** ("X is the author of…", "X lives
  in…"), **publisher/series boilerplate**, and metadata lines (**ISBN**,
  **price**, **URLs**, imprint names like "OXFORD UNIVERSITY PRESS").
- Prefer the **main blurb paragraph(s)** — typically the largest contiguous
  block of prose — over scattered fragments.
- Apply light punctuation/spacing cleanup so the result reads as prose, while
  the worker can still edit freely in the review form.
- Where the back-cover OCR is too noisy to segment confidently, fall back to
  the current "join everything" behaviour rather than returning nothing, and
  let the worker trim it — never block (US-D4 contract).

> **Status / context.** Observed during manual testing of Slice D on a real
> book: the front-cover author line was returned as the title, and the back-cover
> description included review quotes and bio lines that shouldn't be there. The
> engines themselves read the text well (PP-OCRv6 in particular); the gap is in
> the **extraction heuristics** (`src/lib/ocr/extract.ts`), not the OCR. These
> two stories are deliberately scoped to that module (plus a possible
> `OcrEngine` geometry extension) and can be picked up after the review form
> (Slice E) lands, since the form already lets the worker correct any residue.

---

### Slice E — Assisted review form

#### US-E1 — Present a pre-filled review form (L)
*As a worker, I want a single form that's already filled in with the best
available values so I can confirm at a glance.*

- The form shows **title, description, author, weight (optional)** and the
  captured **images**.
- Each text field is pre-filled with the best available value using a defined
  precedence (proposed default: online catalog > OCR > blank), while still
  exposing the alternatives.
- Weight defaults from the catalog if available, otherwise blank/optional.

#### US-E2 — Choose per-field among online / OCR / manual (M)
*As a worker, I want to pick which suggested value to use per field, or type my
own, so corrections are fast.*

- Each field displays its available suggestions as chips with provenance
  labels (e.g. "Google Books", "Front cover", "Open Library").
- Tapping a chip fills the field; the worker can still edit the text after.
- A manual free-text option is always available.
- The chosen provenance per field is recorded (useful for later QA / tuning
  which sources are trusted).

#### US-E3 — Validate before submit (S)
*As a worker, I want to be warned if something required is missing so I don't
push an empty product.*

- Minimal required set (proposed: title + at least the front image) is
  enforced with inline messages.
- Description, author, weight, back image are recommended but not blocking
  (configurable).

---

### Slice F — Push to Lightspeed Retail

> **Pivot (eCom → Retail).** rokko is on a Lightspeed **omnichannel**
> subscription, where products cannot be created/updated through the eCom API
> (see the [omnichannel note](https://developers.lightspeedhq.com/ecom/introduction/omnichannel/)).
> Slice F therefore targets the **Retail (R-Series) API** instead. The user
> stories below are unchanged in intent; only the transport changes. Open
> questions: not all intake metadata may be settable via the Retail API — most
> fields are expected to go through Retail **imports**, and images through the
> API (to be confirmed; we may need to pivot the field set again).
>
> **F0 — OAuth connection (done, this slice).** Before any push, the app
> authorizes against the Retail account via the OAuth 2.0 authorization-code
> grant with PKCE
> ([docs](https://developers.lightspeedhq.com/retail/authentication/authorization-code-grant/)).
> Implemented in `src/lib/lightspeed/` (`oauth.ts` + `connection.ts`), with
> `GET /api/lightspeed/connect` + `/callback` routes, a `lightspeed_connection`
> token table, and a **Settings → Lightspeed** page to connect/disconnect.
> `LIGHTSPEED_CLIENT_ID/SECRET/REDIRECT_URI/SCOPES` are read via `config.ts`.
> Access tokens refresh automatically (refresh-token rotation). US-F1/F2/F3
> below build on `getValidAccessToken()`.

#### US-F1 — Submit the book to Lightspeed Retail (L)
*As a worker, I want submitting the form to create/update the product in the
webshop so the book goes live without a CSV export.*

- On submit, the app creates/updates the product via the Lightspeed **Retail**
  API (Item + related endpoints) — or, where a field is not settable via the
  API, stages it for a Retail **import** — with the confirmed title,
  description, author, and weight.
- Reuses the v1 R→C field semantics where they still apply (mapping remains the
  source of truth for field shapes), adapted to the Retail payload instead of
  a CSV row.
- API failures are surfaced to the worker with a retry option; the book is kept
  as a recoverable `draft` (never silently lost).
- New env/config for Retail credentials (client id/secret, redirect, scopes)
  via `src/lib/config.ts` only (AGENTS.md rule #4). No `process.env` elsewhere.

#### US-F2 — Upload cover images to Retail (M)
*As a worker, I want my cover photos attached to the webshop product so
customers see them.*

- The front (primary) and back images are uploaded to the item via the Retail
  Item Image endpoint(s).
- Image order/roles: front = main image, back = secondary.
- Upload failures are retryable and do not lose the already-created product;
  the product-content push (US-F1) and image push are independently recoverable.

#### US-F3 — Confirm success and advance (S)
*As a worker, I want a clear "done" state with a fast path to the next book so
I can work through the pile.*

- On success the worker sees a confirmation (title + "added to webshop") and a
  prominent "Scan next book" button that returns to Slice B for a fresh book in
  the same session.

---

### Slice G — Robustness & recovery (cross-cutting)

#### US-G1 — Survive reloads and interruptions (M)
*As a worker, if my phone locks or the page reloads mid-book, I don't want to
lose my photos and inputs.*

- Per-book draft state (EAN, images, enrichment results, field choices) is
  persisted server-side keyed to the session so a reload restores the
  in-progress book.

#### US-G2 — Handle "no online match" gracefully (S)
*As a worker, when nothing is found online, I want the OCR/manual path to carry
me through so the book still gets added.*

- With zero online hits, the form still functions on OCR + manual values; the
  happy path degrades, it does not break (directly addresses the v1 shortfall).

---

## 5. Reuse map (what v2 borrows from v1)

| v1 asset | v2 use |
|---|---|
| `src/lib/enrichment/orchestrator.ts` + `sources/*` + `merge.ts` | Background per-book online enrichment (US-C1) |
| Canonical `Book` / `EnrichedBook` types (`src/types/`) | Shape of the per-book session record |
| `mapping.config.json` semantics | Field meanings when building the eCom payload (US-F1) |
| SQLite + Drizzle (`src/lib/db`) | New `intake_session`, `intake_book`, `intake_image` tables |
| `src/lib/config.ts` (Zod env) | New eCom + OCR credentials |
| pino logger, structured logs | Per-session / per-book logging |

New surface area v2 introduces: barcode scanning (client), image capture +
storage, OCR (US-D3/D4), the interactive review form, and the eCom push
adapter (`src/lib/ecom/` — proposed).

---

## 6. Proposed milestones for v2

| ID | Title | Contains |
|---|---|---|
| **M5** | Session + barcode + background enrichment | Slices A, B, C |
| **M6** | Photos + OCR + review form | Slices D, E |
| **M7** | eCom push + images + confirmation | Slice F |
| **M8** | Robustness, recovery, field-choice telemetry | Slice G + polish |

Each milestone ends with `pnpm typecheck && pnpm lint && pnpm test` green,
following the v1 definition-of-done and AGENTS.md rules (no `any`, Zod at
boundaries, no live API calls in tests — record OCR/eCom fixtures).

---

## 7. Open questions for the human

Deferred decisions to surface rather than guess (extends
`spec/v1/08-open-questions.md`):

1. **R-Series linkage (US-B3).** How does v2 access current retail article
   data for a scanned EAN? Options: (a) reuse data from prior v1 imports,
   (b) a fresh R-Series export uploaded per session, (c) a live R-Series
   retail API lookup. Which is available at rokko?
   - Just using data available in the db will suffice. No need to connect with R-series. 
2. **OCR engine (US-D3/D4).** On-device `tesseract.js` (no data leaves the
   phone, weaker on stylised covers) vs. a cloud OCR API (better accuracy,
   cost + connectivity + credentials). Preference?
   - On-device `tesseract.js` 
3. **eCom credentials & environment (Slice F).** Which Lightspeed eCom API
   (cluster/region), auth model (API key + secret), and a sandbox/test shop for
   development. Needed before M7.
4. **Product create vs. update semantics.** When the book already exists in the
   webshop (re-scan), should submit update the existing eCom product or refuse?
   Define the idempotency/matching key (EAN?).
5. **Image hosting.** eCom Product image endpoints accept uploaded images
   directly — confirm this replaces the v1 "Images = external URL" approach for
   photographed covers.
6. **Field precedence default (US-E1).** Proposed online > OCR > manual for
   pre-fill. Confirm, or should OCR (physical book) outrank online catalog for
   title/description?
7. **Weight source.** Rarely present online. Is a per-worker manual estimate
   acceptable, or is weight optional/omitted at launch?
8. **Connectivity assumption.** Is the receiving table reliably online? If not,
   an offline draft queue (out of scope above) becomes a real requirement.
