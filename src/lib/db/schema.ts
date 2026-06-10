import { type InferInsertModel, type InferSelectModel, sql } from "drizzle-orm";
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * `runs` — one row per uploaded R-series CSV. Tracks lifecycle and counts.
 */
export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(), // ULID
  sourceFileName: text("source_file_name").notNull(),
  sourceFilePath: text("source_file_path").notNull(),
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
 * `rSeriesPayload` stores the original R-series row as JSON for audit/replay.
 */
export const books = sqliteTable("books", {
  id: text("id").primaryKey(), // ULID
  runId: text("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  ean: text("ean").notNull(),
  rSeriesPayload: text("r_series_payload", { mode: "json" }).notNull(),
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
 */
export const enrichmentCache = sqliteTable(
  "enrichment_cache",
  {
    source: text("source").notNull(),
    ean: text("ean").notNull(),
    payload: text("payload", { mode: "json" }),
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

export type Run = InferSelectModel<typeof runs>;
export type NewRun = InferInsertModel<typeof runs>;
export type BookRow = InferSelectModel<typeof books>;
export type NewBookRow = InferInsertModel<typeof books>;
export type EnrichmentRow = InferSelectModel<typeof enrichments>;
export type ExportRow = InferSelectModel<typeof exports>;
