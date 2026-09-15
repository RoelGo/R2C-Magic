import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * `runs` — one row per uploaded book CSV. Tracks lifecycle, counts, and the
 * detected input format (R-Series export or CB-intake template).
 */
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(), // ULID
  sourceFileName: text("source_file_name").notNull(),
  sourceFilePath: text("source_file_path").notNull(),
  /** Which CSV shape the upload was — used to pick the right parser. */
  format: text("format", { enum: ["r-series", "cb-intake"] })
    .notNull()
    .default("r-series"),
  uploadedAt: integer("uploaded_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  status: text("status", { enum: ["pending", "running", "completed", "failed"] })
    .notNull()
    .default("pending"),
  totalBooks: integer("total_books").notNull().default(0),
  processedBooks: integer("processed_books").notNull().default(0),
  failedBooks: integer("failed_books").notNull().default(0),
  error: text("error"),
});

/**
 * `books` — one row per book in an uploaded run.
 * `sourcePayload` stores the parsed upload row as a `BookSource` discriminated
 * union (`{ kind: "r-series", rSeries: {...} } | { kind: "cb-intake", cb: {...} }`)
 * so the format is recoverable for audit/replay without consulting the run.
 */
export const books = sqliteTable("books", {
  id: text("id").primaryKey(), // ULID
  runId: text("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  ean: text("ean").notNull(),
  sourcePayload: text("source_payload", { mode: "json" }).notNull(),
  enrichedPayload: text("enriched_payload", { mode: "json" }),
  status: text("status", { enum: ["pending", "enriching", "done", "failed"] })
    .notNull()
    .default("pending"),
  errors: text("errors", { mode: "json" }), // JSON array of { source, message }
});

/**
 * `enrichments` — per-source response per book. Lets us inspect raw payloads.
 */
export const enrichments = sqliteTable("enrichments", {
  id: text("id").primaryKey(),
  bookId: text("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  payload: text("payload", { mode: "json" }),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  httpStatus: integer("http_status"),
  error: text("error"),
});

/**
 * `enrichment_cache` — global, source-keyed cache by EAN so multiple runs
 * for the same titles don't re-hit external APIs.
 *
 * Cached rows can represent any of three outcomes:
 *  - **hit**: `payload` is the source's `FetchResult.data` (may be `{}` for
 *    a "not found" response — we cache misses so we don't retry next run).
 *  - **error**: `payload` is null and `error` carries the thrown message.
 *    Errors are still TTL'd so transient 5xx / 429 don't permanently lock
 *    a book out of enrichment.
 */
export const enrichmentCache = sqliteTable(
  "enrichment_cache",
  {
    source: text("source").notNull(),
    ean: text("ean").notNull(),
    payload: text("payload", { mode: "json" }),
    httpStatus: integer("http_status"),
    error: text("error"),
    fetchedAt: integer("fetched_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({ pk: primaryKey({ columns: [t.source, t.ean] }) }),
);

/**
 * `exports` — generated C-series CSVs, one (or more) per run.
 */
export const exports = sqliteTable("exports", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  filePath: text("file_path").notNull(),
  rowCount: integer("row_count").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/**
 * v2 mobile intake — `intake_sessions`: one row per "New arrivals" session a
 * worker starts at the receiving table. Persisted so progress survives a page
 * reload / phone lock (spec v2 US-A1). A session is a lightweight container;
 * the per-book work lives in `intake_books`.
 */
export const intakeSessions = sqliteTable("intake_sessions", {
  id: text("id").primaryKey(), // ULID
  /** Optional worker-supplied label (e.g. supplier / delivery note). */
  label: text("label"),
  status: text("status", { enum: ["active", "closed"] })
    .notNull()
    .default("active"),
  startedAt: integer("started_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/**
 * v2 mobile intake — `intake_books`: one row per book a worker is adding in a
 * session. Slice A only needs identity + status + title for the session list
 * (US-A2); later slices (B–F) attach EAN, enrichment, OCR, image, and eCom
 * push state to this row.
 *
 * `status` lifecycle:
 *  - `draft`   — in progress / not yet pushed (default)
 *  - `pushed`  — successfully sent to Lightspeed eCom
 *  - `failed`  — a push was attempted and failed (recoverable)
 */
export const intakeBooks = sqliteTable("intake_books", {
  id: text("id").primaryKey(), // ULID
  sessionId: text("session_id")
    .notNull()
    .references(() => intakeSessions.id, { onDelete: "cascade" }),
  ean: text("ean"),
  /** Best-known title for the session list; may be null until enriched/OCR'd. */
  title: text("title"),
  status: text("status", { enum: ["draft", "pushed", "failed"] })
    .notNull()
    .default("draft"),
  /**
   * Background online enrichment lifecycle (spec v2 US-C1/US-C2), independent
   * of the push `status` above. Kicked off the moment an EAN is captured.
   *  - `idle`      — no EAN yet / not started
   *  - `searching` — orchestrator running across online sources
   *  - `done`      — finished with at least one usable enriched field
   *  - `empty`     — finished but no online match (degrades to OCR/manual)
   *  - `failed`    — every enabled source errored
   */
  enrichmentStatus: text("enrichment_status", {
    enum: ["idle", "searching", "done", "empty", "failed"],
  })
    .notNull()
    .default("idle"),
  /** Merged `EnrichedBook` JSON once enrichment finishes (null until then). */
  enrichedPayload: text("enriched_payload", { mode: "json" }),
  /** Per-source enrichment errors as a JSON array of { source, message }. */
  enrichmentErrors: text("enrichment_errors", { mode: "json" }),
  /**
   * Server-side cover OCR lifecycle (spec v2 US-D3/D4), independent of the
   * enrichment and push states. Runs after a cover photo is uploaded.
   *  - `idle`    — no photo OCR'd yet
   *  - `running` — an engine is processing a cover image
   *  - `done`    — finished with at least one usable field (title/description)
   *  - `empty`   — finished but nothing usable was read
   *  - `failed`  — the engine errored on every attempted image
   */
  ocrStatus: text("ocr_status", {
    enum: ["idle", "running", "done", "empty", "failed"],
  })
    .notNull()
    .default("idle"),
  /** Which engine produced the current OCR result (for benchmarking). */
  ocrEngine: text("ocr_engine"),
  /** Title candidate read off the front cover (null until OCR'd). */
  ocrTitle: text("ocr_title"),
  /** Optional author candidate read off the front cover. */
  ocrAuthor: text("ocr_author"),
  /** Description candidate read off the back cover. */
  ocrDescription: text("ocr_description"),
  /** Per-image OCR errors as a JSON array of { kind, message }. */
  ocrErrors: text("ocr_errors", { mode: "json" }),
  /**
   * Back-cover layout regions from the layout pass (spec v2 US-D7/US-D8), as
   * `{ imageWidth, imageHeight, regions: [{ id, label, box, text,
   * autoSelected }] }`. Persisted so the worker can re-open the tap-to-select
   * description picker after a reload (US-G1). Null when layout detection is
   * off, failed, or found nothing.
   */
  ocrBackRegions: text("ocr_back_regions", { mode: "json" }),
  /**
   * Worker-confirmed values from the assisted review form (spec v2 Slice E,
   * US-E1/E2). These are the authoritative values pushed to the webshop in
   * Slice F — distinct from the enrichment/OCR *suggestions* above, which the
   * worker adopts or overrides. Null until the review form is saved.
   */
  reviewedTitle: text("reviewed_title"),
  reviewedAuthor: text("reviewed_author"),
  reviewedDescription: text("reviewed_description"),
  reviewedWeightGrams: integer("reviewed_weight_grams"),
  /**
   * Chosen provenance per field (US-E2), for later QA / source tuning:
   *  - `online`  — adopted from an online-catalog suggestion
   *  - `ocr`     — adopted from a cover-OCR suggestion
   *  - `manual`  — typed/edited by the worker
   */
  titleSource: text("title_source", { enum: ["online", "ocr", "manual"] }),
  authorSource: text("author_source", { enum: ["online", "ocr", "manual"] }),
  descriptionSource: text("description_source", { enum: ["online", "ocr", "manual"] }),
  /**
   * Lightspeed Retail push state (spec v2 Slice F, US-F1/F2), layered onto the
   * `status` lifecycle above.
   *  - `retailItemID`  — the matched Retail Item id (set on a successful push;
   *    kept so a re-push is idempotent and update-only, per rokko's decision).
   *  - `pushError`     — the last push failure message, for the retry UI. Null
   *    while `draft`/`pushed`; set alongside `status = "failed"`.
   *  - `pushedAt`      — when the book last pushed successfully (null until then).
   */
  /**
   * Live Retail lookup by EAN (spec v2 US-B3), run the moment an EAN is
   * captured. Independent of the push `status`. Tells the review/push UI
   * whether the scanned book already exists as a Retail Item so submit can be
   * gated (found → update; not found → blocked unless the worker opts to
   * create it).
   *  - `idle`     — no EAN captured yet
   *  - `checking` — a lookup is in flight
   *  - `found`    — a matching Retail Item exists (`retailItemID` set)
   *  - `missing`  — the EAN is not in Retail (worker may opt to create)
   *  - `error`    — the lookup could not complete (not connected / API error)
   */
  retailLookupStatus: text("retail_lookup_status", {
    enum: ["idle", "checking", "found", "missing", "error"],
  })
    .notNull()
    .default("idle"),
  /** Last lookup failure message (set with `retailLookupStatus = "error"`). */
  retailLookupError: text("retail_lookup_error"),
  retailItemID: text("retail_item_id"),
  pushError: text("push_error"),
  pushedAt: integer("pushed_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/**
 * v2 mobile intake — `intake_images`: cover photos a worker takes for a book
 * (spec v2 US-D1 front, US-D2 back). One current image per `kind`; a retake
 * replaces the row (and its file on disk). Bytes live on disk under
 * `DATA_DIR/intake-images/<bookId>/`; only metadata + the relative path are
 * stored here so the DB stays small and the files are ready for the eCom
 * image upload in Slice F.
 */
export const intakeImages = sqliteTable(
  "intake_images",
  {
    id: text("id").primaryKey(), // ULID
    bookId: text("book_id")
      .notNull()
      .references(() => intakeBooks.id, { onDelete: "cascade" }),
    /** Which cover this is — front (primary) or back (blurb/OCR source). */
    kind: text("kind", { enum: ["front", "back"] }).notNull(),
    /** Path relative to DATA_DIR, e.g. `intake-images/<bookId>/front.jpg`. */
    filePath: text("file_path").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  // At most one image per (book, kind); a retake upserts onto this key.
  (t) => ({ pk: primaryKey({ columns: [t.bookId, t.kind] }) }),
);

/**
 * v2 (Slice F) — `lightspeed_connection`: the app's single OAuth link to a
 * Lightspeed Retail (R-Series) account. rokko runs an omnichannel plan, so
 * products are pushed through the Retail API; this holds the access/refresh
 * tokens from the authorization-code-grant flow. Single-tenant, self-hosted
 * app → exactly one row (`id = "default"`). Tokens are secrets stored in the
 * gitignored SQLite DB under DATA_DIR; the refresh token rotates on every use.
 */
export const lightspeedConnection = sqliteTable("lightspeed_connection", {
  /** Always the constant `"default"` — one connection per install. */
  id: text("id").primaryKey(),
  /** Retail account id (the `acct` claim in the access-token JWT). */
  accountId: text("account_id").notNull(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  /** Absolute expiry of the access token (from `expires_in` at issue time). */
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }).notNull(),
  /** Space-separated scopes actually granted. */
  scope: text("scope"),
  connectedAt: integer("connected_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type Run = InferSelectModel<typeof runs>;
export type NewRun = InferInsertModel<typeof runs>;
export type BookRow = InferSelectModel<typeof books>;
export type NewBookRow = InferInsertModel<typeof books>;
export type EnrichmentRow = InferSelectModel<typeof enrichments>;
export type ExportRow = InferSelectModel<typeof exports>;
export type IntakeSession = InferSelectModel<typeof intakeSessions>;
export type NewIntakeSession = InferInsertModel<typeof intakeSessions>;
export type IntakeBookRow = InferSelectModel<typeof intakeBooks>;
export type NewIntakeBookRow = InferInsertModel<typeof intakeBooks>;
export type IntakeImageRow = InferSelectModel<typeof intakeImages>;
export type NewIntakeImageRow = InferInsertModel<typeof intakeImages>;
export type LightspeedConnectionRow = InferSelectModel<typeof lightspeedConnection>;
export type NewLightspeedConnectionRow = InferInsertModel<typeof lightspeedConnection>;
