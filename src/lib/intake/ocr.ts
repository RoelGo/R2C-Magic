/**
 * v2 mobile intake — server-side cover OCR (spec v2 US-D3/D4).
 *
 * After a cover photo is uploaded we run the configured OCR engine on the
 * stored image, off the shared p-queue, and record a title/author (front) or
 * description (back) suggestion on the `intake_books` row. The review screen
 * polls the result and never blocks on it (US-C2-style). A failure is recorded
 * and the flow degrades to manual entry (US-G2) — OCR never aborts the session
 * (AGENTS.md rule #6).
 *
 * The engine is a swappable subprocess adapter (`ocrs` / `pp-ocrv6`), selected
 * by config; tests inject a stub so the unit suite needs no binary or model.
 */
import { getDb } from "@/lib/db/client";
import { intakeBooks } from "@/lib/db/schema";
import { getIntakeImagePath } from "@/lib/intake/images";
import { getQueue } from "@/lib/jobs/queue";
import { logger } from "@/lib/logger";
import type { OcrEngine } from "@/lib/ocr/engine";
import { extractBackCover, extractFrontCover } from "@/lib/ocr/extract";
import { activeOcrEngine } from "@/lib/ocr/index";
import { and, eq } from "drizzle-orm";

/** OCR lifecycle for an intake book (mirrors the DB enum). */
export type IntakeOcrStatus = "idle" | "running" | "done" | "empty" | "failed";

export type OcrCoverKind = "front" | "back";

export interface OcrError {
  kind: OcrCoverKind;
  message: string;
}

/**
 * Kick off OCR for a book after a cover photo changes. Marks the row `running`
 * synchronously (so the UI reflects it) and processes on the shared queue.
 * No-op that marks `empty` when OCR is disabled/unconfigured, so the flow
 * degrades gracefully instead of hanging on "running".
 *
 * `engine` is injectable for tests; production uses the configured engine.
 */
export function startOcr(
  sessionId: string,
  bookId: string,
  engine: OcrEngine | undefined = activeOcrEngine(),
): void {
  const db = getDb();

  if (!engine) {
    logger.warn(
      { sessionId, bookId },
      "startOcr: no active OCR engine (OCR disabled or not configured) — marking empty",
    );
    db.update(intakeBooks)
      .set({ ocrStatus: "empty", updatedAt: new Date() })
      .where(and(eq(intakeBooks.sessionId, sessionId), eq(intakeBooks.id, bookId)))
      .run();
    return;
  }

  logger.debug({ sessionId, bookId, engine: engine.id }, "startOcr: marking running + enqueueing");

  db.update(intakeBooks)
    .set({ ocrStatus: "running", updatedAt: new Date() })
    .where(and(eq(intakeBooks.sessionId, sessionId), eq(intakeBooks.id, bookId)))
    .run();

  // Fire-and-forget on the shared queue. runOcr never throws, but guard the
  // queue task itself so a scheduling error can't vanish silently.
  void getQueue()
    .add(() => runOcr(sessionId, bookId, engine))
    .catch((err) => {
      logger.error(
        { sessionId, bookId, err: errorMessage(err) },
        "startOcr: queued OCR task rejected unexpectedly",
      );
    });
}

/**
 * Run OCR to completion for one book across whichever cover photos exist, and
 * persist the extracted fields. Exposed (not only enqueued) so tests can await
 * the full cycle deterministically. Never throws — failures are recorded.
 */
export async function runOcr(
  sessionId: string,
  bookId: string,
  engine: OcrEngine | undefined = activeOcrEngine(),
): Promise<OcrError[]> {
  const db = getDb();
  const errors: OcrError[] = [];

  if (!engine) {
    logger.warn({ sessionId, bookId }, "runOcr: no active engine — marking empty");
    db.update(intakeBooks)
      .set({ ocrStatus: "empty", updatedAt: new Date() })
      .where(and(eq(intakeBooks.sessionId, sessionId), eq(intakeBooks.id, bookId)))
      .run();
    return errors;
  }

  const frontPath = getIntakeImagePath(sessionId, bookId, "front");
  const backPath = getIntakeImagePath(sessionId, bookId, "back");

  logger.debug(
    {
      sessionId,
      bookId,
      engine: engine.id,
      frontPath: frontPath ?? null,
      backPath: backPath ?? null,
    },
    "runOcr: starting — resolved cover image paths",
  );

  if (!frontPath && !backPath) {
    logger.warn(
      { sessionId, bookId },
      "runOcr: no cover images found on disk for this book — marking empty",
    );
  }

  let title: string | null = null;
  let author: string | null = null;
  let description: string | null = null;
  let attempted = 0;

  if (frontPath) {
    attempted += 1;
    try {
      logger.debug({ sessionId, bookId, frontPath }, "runOcr: recognising front cover");
      const { lines } = await engine.recognize(frontPath);
      const front = extractFrontCover(lines);
      title = front.title ?? null;
      author = front.author ?? null;
      logger.debug(
        { sessionId, bookId, lineCount: lines.length, title, author },
        "runOcr: front cover recognised",
      );
    } catch (err) {
      logger.error(
        { sessionId, bookId, frontPath, err: errorMessage(err) },
        "runOcr: front cover recognition failed",
      );
      errors.push({ kind: "front", message: errorMessage(err) });
    }
  }

  if (backPath) {
    attempted += 1;
    try {
      logger.debug({ sessionId, bookId, backPath }, "runOcr: recognising back cover");
      const { lines } = await engine.recognize(backPath);
      description = extractBackCover(lines) ?? null;
      logger.debug(
        { sessionId, bookId, lineCount: lines.length, descriptionLength: description?.length ?? 0 },
        "runOcr: back cover recognised",
      );
    } catch (err) {
      logger.error(
        { sessionId, bookId, backPath, err: errorMessage(err) },
        "runOcr: back cover recognition failed",
      );
      errors.push({ kind: "back", message: errorMessage(err) });
    }
  }

  const hasUsable = Boolean(title || author || description);
  const allFailed = attempted > 0 && errors.length === attempted;
  const status: IntakeOcrStatus = allFailed ? "failed" : hasUsable ? "done" : "empty";

  db.update(intakeBooks)
    .set({
      ocrStatus: status,
      ocrEngine: engine.id,
      ocrTitle: title,
      ocrAuthor: author,
      ocrDescription: description,
      ocrErrors: errors.length > 0 ? errors : null,
      updatedAt: new Date(),
    })
    .where(and(eq(intakeBooks.sessionId, sessionId), eq(intakeBooks.id, bookId)))
    .run();

  logger.info(
    {
      sessionId,
      bookId,
      engine: engine.id,
      status,
      attempted,
      errorCount: errors.length,
      hasTitle: Boolean(title),
      hasAuthor: Boolean(author),
      hasDescription: Boolean(description),
    },
    "intake OCR finished",
  );
  return errors;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A concise OCR snapshot for the review UI + polling. */
export interface IntakeOcrSnapshot {
  status: IntakeOcrStatus;
  engine: string | null;
  suggestions: {
    title?: string;
    author?: string;
    description?: string;
  };
  errors: OcrError[];
}

/** Read the current OCR state for an intake book (for the poller). */
export function getOcrSnapshot(sessionId: string, bookId: string): IntakeOcrSnapshot | undefined {
  const db = getDb();
  const row = db
    .select({
      ocrStatus: intakeBooks.ocrStatus,
      ocrEngine: intakeBooks.ocrEngine,
      ocrTitle: intakeBooks.ocrTitle,
      ocrAuthor: intakeBooks.ocrAuthor,
      ocrDescription: intakeBooks.ocrDescription,
      ocrErrors: intakeBooks.ocrErrors,
    })
    .from(intakeBooks)
    .where(and(eq(intakeBooks.sessionId, sessionId), eq(intakeBooks.id, bookId)))
    .get();
  if (!row) return undefined;

  return {
    status: row.ocrStatus,
    engine: row.ocrEngine,
    suggestions: {
      title: row.ocrTitle ?? undefined,
      author: row.ocrAuthor ?? undefined,
      description: row.ocrDescription ?? undefined,
    },
    errors: (row.ocrErrors as OcrError[] | null) ?? [],
  };
}
