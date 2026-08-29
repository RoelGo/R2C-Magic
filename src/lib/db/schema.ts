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
