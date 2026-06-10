/**
 * Run lifecycle: create from upload, process synchronously, query state.
 *
 * M1 runs the whole pipeline synchronously inside the same request as the
 * upload — there is no enrichment yet, so total work per row is microseconds.
 * M2 will swap `processRunSync` for an enqueue + async worker.
 */
import { writeFile } from "node:fs/promises";
import { booksToCsv } from "@/lib/csv/c-series";
import { parseCbIntakeCsv } from "@/lib/csv/cb-intake";
import { detectInputFormat } from "@/lib/csv/format-detect";
import { loadMappingConfig } from "@/lib/csv/mapping";
import { type ParseResult, parseRSeriesCsv } from "@/lib/csv/r-series";
import { getDb } from "@/lib/db/client";
import { books, exports, runs } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { BookSource, EnrichedBook, InputFormat } from "@/types/book";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { ensureRunDir, exportCsvPath, sourceCsvPath } from "./paths";
import { seedEnrichedBookFromSource } from "./seed";

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
 * Does NOT process. Call `processRunSync(runId)` afterwards (or, in M2, the
 * job runner).
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

export interface ProcessResult {
  runId: string;
  processedBooks: number;
  failedBooks: number;
  exportPath: string;
}

/**
 * Walk every book in a run, build a `seedEnrichedBook` (no enrichment in M1),
 * write the merged C-Series export, and update counters.
 *
 * Idempotent: rerunning re-writes the export file from whatever is in the DB.
 */
export async function processRunSync(runId: string): Promise<ProcessResult> {
  const db = getDb();
  const mapping = loadMappingConfig();

  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) throw new Error(`run ${runId} not found`);

  db.update(runs).set({ status: "running" }).where(eq(runs.id, runId)).run();

  const rows = db.select().from(books).where(eq(books.runId, runId)).all();
  logger.info({ runId, bookCount: rows.length }, "processRunSync start");

  const enriched: EnrichedBook[] = [];
  let processed = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const source = row.sourcePayload as BookSource;
      const book = seedEnrichedBookFromSource(source);
      enriched.push(book);

      db.update(books)
        .set({ enrichedPayload: book, status: "done" })
        .where(eq(books.id, row.id))
        .run();
      processed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ runId, bookId: row.id, message }, "book processing failed");
      db.update(books)
        .set({ status: "failed", errors: [{ source: "r-series", message }] })
        .where(eq(books.id, row.id))
        .run();
      failed += 1;
    }
  }

  const csv = booksToCsv(enriched, mapping);
  const outPath = exportCsvPath(runId);
  await writeFile(outPath, csv, "utf8");

  db.insert(exports)
    .values({
      id: ulid(),
      runId,
      filePath: outPath,
      rowCount: enriched.length,
    })
    .run();

  db.update(runs)
    .set({
      status: failed === rows.length && rows.length > 0 ? "failed" : "completed",
      processedBooks: processed,
      failedBooks: failed,
    })
    .where(eq(runs.id, runId))
    .run();

  logger.info({ runId, processed, failed, exportPath: outPath }, "processRunSync done");

  return { runId, processedBooks: processed, failedBooks: failed, exportPath: outPath };
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
