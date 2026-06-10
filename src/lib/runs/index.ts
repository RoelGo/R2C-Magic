/**
 * Run lifecycle: create from upload, query state. Processing is handled
 * by the M2 job queue — see `src/lib/jobs/run.ts` (`enqueueRun`,
 * `awaitRun`, `processRunInline`).
 */
import { writeFile } from "node:fs/promises";
import { parseCbIntakeCsv } from "@/lib/csv/cb-intake";
import { detectInputFormat } from "@/lib/csv/format-detect";
import { type ParseResult, parseRSeriesCsv } from "@/lib/csv/r-series";
import { getDb } from "@/lib/db/client";
import { books, exports, runs } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { BookSource, InputFormat } from "@/types/book";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { ensureRunDir, sourceCsvPath } from "./paths";

export interface CreateRunInput {
  fileName: string;
  /** Full file contents as a UTF-8 string. */
  content: string;
}

export interface CreateRunResult {
  runId: string;
  format: InputFormat;
  totalBooks: number;
  invalidRows: ParseResult["invalid"];
}

/**
 * Thrown by `createRun` when the upload's header row doesn't match any known
 * format. The caller (server action) is responsible for surfacing this as a
 * user-friendly validation error instead of letting it bubble to the UI.
 */
export class UnknownInputFormatError extends Error {
  constructor() {
    super(
      "Could not recognise the CSV format. " +
        "Expected an R-Series export (with 'System ID' and 'Item' columns) " +
        "or a CB-intake template (with 'EAN' and 'aankoopprijs' columns).",
    );
    this.name = "UnknownInputFormatError";
  }
}

/**
 * Create a run from an uploaded CSV: detect the input format, parse with the
 * appropriate parser, then persist the source file + run + book rows.
 * Does NOT process. Hand the returned `runId` to `enqueueRun` (production)
 * or `processRunInline` (tests) from `src/lib/jobs/run.ts`.
 *
 * @throws {UnknownInputFormatError} if the CSV's header row doesn't match
 *   any known format.
 */
export async function createRun(input: CreateRunInput): Promise<CreateRunResult> {
  const format = detectInputFormat(input.content);
  if (!format) throw new UnknownInputFormatError();

  const runId = ulid();
  const dir = ensureRunDir(runId);
  const srcPath = sourceCsvPath(runId);

  await writeFile(srcPath, input.content, "utf8");
  logger.info({ runId, dir, fileName: input.fileName, format }, "run source written");

  // Dispatch to the right parser and immediately wrap each row in the
  // BookSource discriminated union so the rest of the function (and the DB
  // row payload) is format-agnostic.
  const sourceRows: Array<{ ean: string; payload: BookSource }> = [];
  let invalidRows: ParseResult["invalid"];
  if (format === "r-series") {
    const parsed = parseRSeriesCsv(input.content);
    invalidRows = parsed.invalid;
    for (const row of parsed.rows) {
      sourceRows.push({ ean: row.ean, payload: { kind: "r-series", rSeries: row } });
    }
  } else {
    const parsed = parseCbIntakeCsv(input.content);
    invalidRows = parsed.invalid;
    for (const row of parsed.rows) {
      sourceRows.push({ ean: row.ean, payload: { kind: "cb-intake", cb: row } });
    }
  }

  const db = getDb();
  db.transaction((tx) => {
    tx.insert(runs)
      .values({
        id: runId,
        sourceFileName: input.fileName,
        sourceFilePath: srcPath,
        format,
        status: "pending",
        totalBooks: sourceRows.length,
        processedBooks: 0,
        failedBooks: 0,
      })
      .run();

    if (sourceRows.length > 0) {
      // Chunk the insert to stay under SQLite's variable limit on huge uploads.
      const CHUNK = 500;
      for (let i = 0; i < sourceRows.length; i += CHUNK) {
        const chunk = sourceRows.slice(i, i + CHUNK);
        tx.insert(books)
          .values(
            chunk.map((row) => ({
              id: ulid(),
              runId,
              ean: row.ean,
              sourcePayload: row.payload,
              status: "pending" as const,
            })),
          )
          .run();
      }
    }
  });

  logger.info(
    {
      runId,
      format,
      totalBooks: sourceRows.length,
      invalidRows: invalidRows.length,
    },
    "run created",
  );

  return {
    runId,
    format,
    totalBooks: sourceRows.length,
    invalidRows,
  };
}

export interface RunSummary {
  id: string;
  sourceFileName: string;
  format: InputFormat;
  uploadedAt: Date;
  status: "pending" | "running" | "completed" | "failed";
  totalBooks: number;
  processedBooks: number;
  failedBooks: number;
  exportCount: number;
}

export function listRuns(limit = 50): RunSummary[] {
  const db = getDb();
  const rows = db
    .select({
      id: runs.id,
      sourceFileName: runs.sourceFileName,
      format: runs.format,
      uploadedAt: runs.uploadedAt,
      status: runs.status,
      totalBooks: runs.totalBooks,
      processedBooks: runs.processedBooks,
      failedBooks: runs.failedBooks,
    })
    .from(runs)
    .orderBy(desc(runs.uploadedAt), desc(runs.id))
    .limit(limit)
    .all();

  if (rows.length === 0) return [];

  const counts = countExportsByRun(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => ({ ...r, exportCount: counts.get(r.id) ?? 0 }));
}

export function getRun(runId: string): RunSummary | undefined {
  const db = getDb();
  const row = db
    .select({
      id: runs.id,
      sourceFileName: runs.sourceFileName,
      format: runs.format,
      uploadedAt: runs.uploadedAt,
      status: runs.status,
      totalBooks: runs.totalBooks,
      processedBooks: runs.processedBooks,
      failedBooks: runs.failedBooks,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .get();
  if (!row) return undefined;
  const counts = countExportsByRun(db, [row.id]);
  return { ...row, exportCount: counts.get(row.id) ?? 0 };
}

/**
 * Live progress detail for the run-page poller. Adds per-status book counts
 * (so the UI can render a multi-segment progress bar) and a small sample of
 * the most recent enrichment errors (so the user can see *what* is going
 * wrong mid-run instead of waiting for the final report).
 *
 * The recent-errors list is deliberately capped — for a 200-book run with
 * a misconfigured upstream, we don't want to ship 800 messages over the
 * polling channel every second.
 */
export interface BookStatusCounts {
  pending: number;
  enriching: number;
  done: number;
  failed: number;
}

export interface RunErrorSample {
  ean: string;
  source: string;
  message: string;
}

export interface RunDetail extends RunSummary {
  bookStatusCounts: BookStatusCounts;
  recentErrors: RunErrorSample[];
}

const RECENT_ERRORS_LIMIT = 25;

export function getRunDetail(runId: string): RunDetail | undefined {
  const summary = getRun(runId);
  if (!summary) return undefined;

  const db = getDb();

  // Per-status histogram for the progress bar. SQLite has no FULL OUTER JOIN
  // semantics we need, so the simplest correct shape is GROUP BY status and
  // fill in zeros for any status that didn't appear.
  const counts: BookStatusCounts = { pending: 0, enriching: 0, done: 0, failed: 0 };
  const rows = db
    .select({ status: books.status, count: sql<number>`count(*)`.as("count") })
    .from(books)
    .where(eq(books.runId, runId))
    .groupBy(books.status)
    .all();
  for (const r of rows) {
    counts[r.status] = Number(r.count);
  }

  // Recent errors: pull every failed book's `errors` JSON array and flatten.
  // Capped by RECENT_ERRORS_LIMIT after flattening so a single book with
  // many failed sources can't crowd out other books' errors.
  const failed = db
    .select({ ean: books.ean, errors: books.errors })
    .from(books)
    .where(eq(books.runId, runId))
    .all()
    .filter((b): b is { ean: string; errors: unknown[] } => Array.isArray(b.errors));
  const recentErrors: RunErrorSample[] = [];
  for (const b of failed) {
    for (const e of b.errors) {
      if (
        e &&
        typeof e === "object" &&
        "source" in e &&
        "message" in e &&
        typeof e.source === "string" &&
        typeof e.message === "string"
      ) {
        recentErrors.push({ ean: b.ean, source: e.source, message: e.message });
        if (recentErrors.length >= RECENT_ERRORS_LIMIT) break;
      }
    }
    if (recentErrors.length >= RECENT_ERRORS_LIMIT) break;
  }

  return { ...summary, bookStatusCounts: counts, recentErrors };
}

function countExportsByRun(db: ReturnType<typeof getDb>, runIds: string[]): Map<string, number> {
  const map = new Map<string, number>();
  if (runIds.length === 0) return map;
  const rows = db
    .select({
      runId: exports.runId,
      count: sql<number>`count(*)`.as("count"),
    })
    .from(exports)
    .where(inArray(exports.runId, runIds))
    .groupBy(exports.runId)
    .all();
  for (const r of rows) map.set(r.runId, Number(r.count));
  return map;
}

export function getLatestExportPath(runId: string): string | undefined {
  const db = getDb();
  const row = db
    .select({ filePath: exports.filePath })
    .from(exports)
    .where(eq(exports.runId, runId))
    .orderBy(desc(exports.createdAt))
    .limit(1)
    .get();
  return row?.filePath;
}
