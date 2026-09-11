# v2 Work Items

Each item below is scoped to be implementable on its own branch. A "better OCR
background" idea from the original notes is intentionally omitted here — it is
already covered by an existing story elsewhere in `spec/v2`.

---

## WI-1 — BUG: cover photos uploaded twice on push to Retail

**Type:** Bug · **Priority:** High · **Area:** `src/lib/intake/push.ts`,
`src/lib/lightspeed/push.ts`, `src/app/intake/actions.ts`

### Summary

When a book is pushed to Lightspeed Retail, **two sets** of front/back images end
up on the Retail Item. Observed consistently during manual testing today, including
for **freshly created** items that had **no prior images** — so this is not a
re-push/retake accumulation problem, it is a genuine double-invocation (or
double-upload) bug within a single push.

### Current behaviour (reference)

- `submitIntakeBook()` (`src/lib/intake/push.ts:32`) resolves `front`/`back` bytes
  into a `PushImage[]` (max 2 entries — one per kind) and calls `pushBookToRetail`.
- `pushBookToRetail()` (`src/lib/lightspeed/push.ts:84`) sorts the images and loops
  once, calling `uploadItemImage` per image (`src/lib/lightspeed/push.ts:126-143`).
- `uploadItemImage()` (`src/lib/lightspeed/api.ts:212`) unconditionally POSTs a new
  `/Item/{itemID}/Image.json`.

On paper the loop runs once per kind, so a single push should yield exactly one
front + one back. The observed 2× duplication means something is invoking the
upload path twice. **The task is to find and fix the actual double-invocation**,
not to paper over it with dedup (that is WI-2).

### Investigation checklist (likely culprits — verify, don't assume)

1. **Server action fired twice.** Check the submit server action in
   `src/app/intake/actions.ts` and its caller component for a double submit:
   React 18 double-invoke in dev/StrictMode, a form that both `onSubmit`s and
   triggers a server action, or a button without `type="button"` submitting a form.
2. **`submitIntakeBook` called twice** per user action (e.g. optimistic call +
   real call, or a `useTransition` + effect re-run).
3. **`images` array containing duplicates** — confirm `readIntakeImage` returns one
   file per kind and the `for (const kind of ["front","back"])` loop isn't entered
   twice.
4. **`pushBookToRetail` invoked twice** for one submit (retry-on-failure logic that
   still succeeds the first time, then runs again).
5. **Next.js request duplication** — a route/component rendered twice, or a
   `router.refresh()` re-triggering the action.

Add a temporary `logger.info({ bookId, imageKinds })` at the top of
`pushBookToRetail` and inside the upload loop to confirm exactly how many times the
upload runs per user click, then trace upward.

### Acceptance criteria

- [ ] Root cause identified and documented in the PR description.
- [ ] A single "push" user action results in **exactly one** front image and
      **one** back image on the Retail Item (verified against the live/staging
      Retail account or a mocked `uploadItemImage` call count).
- [ ] A regression test asserts `uploadItemImage` is called **once per image kind**
      per `submitIntakeBook` / `pushBookToRetail` invocation (mock the Retail
      client and count calls).
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` pass.

### Notes

Keep this change minimal and surgical — it is a bug fix. The broader idempotency
work (tracking image IDs, delete-before-reupload) is deliberately split into WI-2.

---

## WI-2 — CHANGE: idempotent image push (track image IDs, delete + reupload on re-push)

**Type:** Change request · **Priority:** Medium · **Depends on:** WI-1 landing
first (so we fix the bug before adding idempotency on top) · **Area:**
`src/lib/lightspeed/api.ts`, `src/lib/lightspeed/push.ts`, `src/lib/intake/push.ts`,
`src/lib/db/schema.ts`

### Summary

Make image push **idempotent** across re-pushes. Today `intake_books` stores only
`retailItemID` (not the uploaded `imageID`s), and `uploadItemImage` never removes
existing images. So a re-push (retry after a recoverable failure, or a retake +
resubmit) **appends** more images to the Retail Item over time.

Chosen approach (per product decision): **on push, delete the existing images we
previously uploaded, then upload the current set fresh.**

### Scope

1. **Persist uploaded image IDs.** Add a column to `intake_books` (e.g.
   `retailImageIDs` as JSON text, or a small child table) to record the `imageID`s
   returned by `uploadItemImage` on the last successful push.
   - Requires a migration: `pnpm db:generate` after editing
     `src/lib/db/schema.ts`, commit the migration.
2. **Delete-before-upload.** Before uploading the current front/back set in
   `pushBookToRetail`, delete the previously-recorded image IDs from the Retail
   Item. Add a `deleteItemImage(client, itemID, imageID)` to
   `src/lib/lightspeed/api.ts` (DELETE `/Item/{itemID}/Image/{imageID}.json`).
3. **Reconcile on partial failure.** If deletion or re-upload fails midway, the
   stored `imageID`s must reflect what is actually on the Item so the next retry
   can clean up correctly (never leave orphaned IDs untracked).
4. **Persist the new IDs** on success via the existing
   `db.update(intakeBooks).set({...})` in `src/lib/intake/push.ts`.

### Acceptance criteria

- [ ] `src/lib/db/schema.ts` has a field for uploaded image IDs; migration
      generated and committed.
- [ ] Re-pushing a book results in the Retail Item having **exactly** the current
      photo set (no accumulation), verified via mocked Retail client call
      sequence: delete(old) → upload(new).
- [ ] `deleteItemImage` added with a unit test (mocked HTTP).
- [ ] First-ever push (no prior IDs) skips deletion cleanly.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` pass.

---

## WI-3 — FEATURE: unified barcode + ISBN reader with client-side ISBN-OCR fallback

**Type:** Feature · **Priority:** Medium-High · **Area:**
`src/components/barcode-scanner.tsx`, `src/components/ean-capture.tsx`, plus a new
client-side OCR module.

### Motivation

During stock counts, Rokko pastes a **Lightspeed item-barcode sticker over the
book's ISBN barcode**, so the ISBN barcode can no longer be scanned. Workers work
around this by opening the book and reading the printed ISBN (e.g. `ISBN
978-90-...`) from the first/imprint page. We want the app to let them **point the
camera at the printed ISBN and capture it via OCR**, as an alternative to barcode
scanning — feeding the exact same EAN validation + save flow.

### Current behaviour (reference)

- `BarcodeScanner` (`src/components/barcode-scanner.tsx`) opens the rear camera and
  reads EAN/UPC via native `window.BarcodeDetector`, falling back to
  `@zxing/browser`. It calls `onDetected(rawValue)`.
- `EanCapture` (`src/components/ean-capture.tsx`) hosts the scanner, validates the
  result with `cleanEan` / `isValidEan13` (`src/lib/intake/ean.ts`), and saves via
  `setBookEanAction`. Manual numeric entry shares the same save path.

### Deliverable — describe & implement BOTH approaches, toggle takes priority

#### A) Fallback toggle (PRIORITY — build this)

Add an explicit **"Scan printed ISBN (OCR)"** mode alongside the existing barcode
scan, surfaced in the scanner UI and/or `EanCapture`:

- A toggle/button lets the worker switch the live camera view into **ISBN OCR
  mode** (e.g. "Barcode covered? Read the printed ISBN instead").
- In OCR mode, run **client-side OCR** on camera frames (or a captured still),
  extract candidate ISBN strings, normalise to EAN-13, and feed the **same**
  `onDetected` → `cleanEan` → `isValidEan13` → `setBookEanAction` path.
- Show a framing guide + a "capture" affordance so the worker controls when a frame
  is read (more reliable than continuous OCR on a busy imprint page).
- Manual entry remains the final fallback (unchanged).

#### B) Unified "magic" auto-detect (SECONDARY — describe, implement only if cheap)

Ideal UX: one camera view that **simultaneously** attempts barcode detection AND
ISBN-text OCR, and auto-captures whichever resolves first — the worker just points
at the book. Implementation sketch:

- Keep the existing `BarcodeDetector`/zxing loop running.
- In parallel (throttled, e.g. every N frames to control CPU), run OCR on the frame
  and scan the text for an ISBN pattern.
- First valid EAN-13 from **either** path wins and calls `onDetected`; the `done`
  guard already prevents double-detection.
- Risk/cost: client-side OCR is CPU-heavy and may drop the camera framerate on
  low-end devices; needs throttling and a graceful degrade. Treat as a stretch goal
  behind the same OCR module — do not block WI-3 on it.

### ISBN text extraction

- Parse OCR text for ISBN patterns: `ISBN(-13)?`, `978`/`979` prefixes, hyphenated
  and spaced groupings; strip non-digits; validate EAN-13 check digit.
- Put the extraction/normalisation in a small, **unit-testable pure function**
  (e.g. `extractIsbnFromText(text: string): string | null` in
  `src/lib/intake/`), reusing `cleanEan`/`isValidEan13`.

### Technical notes / constraints

- **Client-side OCR engine:** the existing OCR (`src/lib/ocr/*`) is a **server-side
  Python (PaddleOCR)** subprocess and is not usable in the browser. This needs an
  in-browser engine — evaluate **Tesseract.js (WASM)**. Confirm bundle-size impact
  and lazy-load it only when OCR mode is entered (dynamic `import()`), so the
  barcode path stays lightweight.
- Requires HTTPS + camera permission (same as the barcode scanner today).
- Per `AGENTS.md`: no live network calls in tests — the ISBN-extraction unit tests
  must run on fixture strings, not live OCR.

### Acceptance criteria

- [ ] Worker can switch to an "ISBN OCR" mode from the scan UI and capture a printed
      ISBN into a valid EAN-13 that saves via `setBookEanAction`.
- [ ] `extractIsbnFromText` is a pure function with unit tests covering hyphenated,
      spaced, `ISBN 978-…`, `979-…`, and noisy/failing inputs.
- [ ] OCR engine is lazy-loaded (no bundle-size regression on the barcode-only
      path).
- [ ] Invalid/uncertain OCR reads fall through to manual entry (never save a bad
      EAN).
- [ ] Unified auto-detect (B) implemented **or** explicitly documented as deferred
      with rationale.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` pass.
