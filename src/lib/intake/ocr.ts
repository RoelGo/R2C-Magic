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
 * The engine is a swappable subprocess adapter (`pp-ocrv6`), selected
 * by config; tests inject a stub so the unit suite needs no binary or model.
 *
 * For the back cover we prefer layout detection (US-D7): PaddleOCR segments the
 * cover into regions and we keep the blurb region, so press quotes, the author
 * bio and ISBN/price/publisher blocks stay out of the description. The plain
 * line-join extraction remains the fallback whenever layout detection is off,
 * fails, or finds no usable region.
 */
import { config } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { intakeBooks } from "@/lib/db/schema";
import { getIntakeImagePath } from "@/lib/intake/images";
import { getQueue } from "@/lib/jobs/queue";
import { logger } from "@/lib/logger";
import {
  type BackCoverRegions,
  backCoverRegionsSchema,
  describeFromLayout,
  layoutLines,
  toBackCoverRegions,
} from "@/lib/ocr/description";
import type { OcrEngine } from "@/lib/ocr/engine";
import { type CatalogHint, extractBackCover, extractFrontCover } from "@/lib/ocr/extract";
import { activeOcrEngine } from "@/lib/ocr/index";
import { type LayoutResult, detectLayout } from "@/lib/ocr/layout";
import type { EnrichedBook } from "@/types/book";
import { and, eq } from "drizzle-orm";

/** OCR lifecycle for an intake book (mirrors the DB enum). */
export type IntakeOcrStatus = "idle" | "running" | "done" | "empty" | "failed";

/**
 * Layout detection for one image (US-D7). Injectable so tests can stub it and
 * so the flow degrades to plain OCR when it is disabled or unavailable.
 */
export type LayoutDetector = (imagePath: string) => Promise<LayoutResult>;

/** The configured layout detector, or `undefined` when it is switched off. */
export function activeLayoutDetector(): LayoutDetector | undefined {
  if (!config.OCR_ENABLED || config.OCR_ENGINE === "none" || !config.PP_LAYOUT_ENABLED) {
    return undefined;
  }
  return detectLayout;
}

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
 * `engine` and `layout` are injectable for tests; production uses the
 * configured engine + layout detector.
 */
export function startOcr(
  sessionId: string,
  bookId: string,
  engine: OcrEngine | undefined = activeOcrEngine(),
  layout: LayoutDetector | undefined = activeLayoutDetector(),
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
    .add(() => runOcr(sessionId, bookId, engine, layout))
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
  layout: LayoutDetector | undefined = activeLayoutDetector(),
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

  // Pull the online-enrichment result (Slice C) to disambiguate title vs author
  // on the front cover (US-D5). Best-effort: any absence just means OCR runs on
  // its own signals.
  const catalogHint = readCatalogHint(sessionId, bookId);

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
  let backRegions: BackCoverRegions | null = null;
  let attempted = 0;

  if (frontPath) {
    attempted += 1;
    try {
      logger.debug({ sessionId, bookId, frontPath }, "runOcr: recognising front cover");
      const result = await engine.recognize(frontPath);
      // Prefer geometry-carrying lines (US-D5 size heuristic); fall back to
      // plain text lines for engines/stubs that don't expose boxes.
      const frontInput = result.linesWithGeometry ?? result.lines;
      const front = extractFrontCover(frontInput, catalogHint);
      title = front.title ?? null;
      author = front.author ?? null;
      logger.debug(
        { sessionId, bookId, lineCount: result.lines.length, title, author },
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
      const back = await readBackCover(sessionId, bookId, backPath, engine, layout);
      description = back.description;
      backRegions = back.regions;
      logger.debug(
        {
          sessionId,
          bookId,
          descriptionLength: description?.length ?? 0,
          regionCount: backRegions?.regions.length ?? 0,
        },
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
      ocrBackRegions: backRegions,
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

/**
 * Read the back-cover description (US-D4, refined by US-D7).
 *
 * Preferred path: one layout-detection pass segments the cover into regions and
 * `describeFromLayout` picks the blurb region, skipping press quotes, bio and
 * metadata. When layout detection is off, fails, or yields no usable region we
 * fall back to the plain line-join extraction — reusing the layout pass's own
 * recognised lines when we have them, so the fallback costs no extra pass.
 * Only a completely failed layout run falls back to the OCR engine, whose
 * failure then propagates to the caller as a recorded back-cover error.
 */
interface BackCoverRead {
  description: string | null;
  /** Tappable layout regions for the picker (US-D8); null without layout. */
  regions: BackCoverRegions | null;
}

async function readBackCover(
  sessionId: string,
  bookId: string,
  backPath: string,
  engine: OcrEngine,
  layout: LayoutDetector | undefined,
): Promise<BackCoverRead> {
  if (layout) {
    try {
      const result = await layout(backPath);
      const regions = toBackCoverRegions(result) ?? null;
      const fromRegion = describeFromLayout(result);
      if (fromRegion) {
        logger.debug(
          { sessionId, bookId, regionCount: result.regions.length },
          "runOcr: description picked from a layout region",
        );
        return { description: fromRegion, regions };
      }
      logger.debug(
        { sessionId, bookId, regionCount: result.regions.length },
        "runOcr: no usable layout region — falling back to line-join extraction",
      );
      return { description: extractBackCover(layoutLines(result)) ?? null, regions };
    } catch (err) {
      logger.warn(
        { sessionId, bookId, backPath, err: errorMessage(err) },
        "runOcr: layout detection failed — falling back to the OCR engine",
      );
    }
  }

  const { lines } = await engine.recognize(backPath);
  return { description: extractBackCover(lines) ?? null, regions: null };
}

/**
 * Read a title/author hint from the book's online-enrichment payload, if any.
 * Used to disambiguate the front-cover OCR title from the author (US-D5). The
 * payload is the merged `EnrichedBook`; we take the short title (falling back to
 * the long one) and the first author. Returns `undefined` when nothing usable
 * is stored, so extraction runs on OCR signals alone.
 */
function readCatalogHint(sessionId: string, bookId: string): CatalogHint | undefined {
  const db = getDb();
  const row = db
    .select({ enrichedPayload: intakeBooks.enrichedPayload })
    .from(intakeBooks)
    .where(and(eq(intakeBooks.sessionId, sessionId), eq(intakeBooks.id, bookId)))
    .get();

  const payload = row?.enrichedPayload as Partial<EnrichedBook> | null | undefined;
  if (!payload) return undefined;

  const title = payload.titleShort ?? payload.titleLong;
  const author = payload.authors?.[0];
  if (!title && !author) return undefined;

  return {
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
  };
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
  /**
   * Back-cover layout regions the worker can tap-select to compose the
   * description (US-D8). Undefined when layout detection produced none, in
   * which case the UI hides the picker.
   */
  backRegions?: BackCoverRegions;
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
      ocrBackRegions: intakeBooks.ocrBackRegions,
      ocrErrors: intakeBooks.ocrErrors,
    })
    .from(intakeBooks)
    .where(and(eq(intakeBooks.sessionId, sessionId), eq(intakeBooks.id, bookId)))
    .get();
  if (!row) return undefined;

  const backRegions = parseBackRegions(row.ocrBackRegions, sessionId, bookId);

  return {
    status: row.ocrStatus,
    engine: row.ocrEngine,
    suggestions: {
      title: row.ocrTitle ?? undefined,
      author: row.ocrAuthor ?? undefined,
      description: row.ocrDescription ?? undefined,
    },
    ...(backRegions ? { backRegions } : {}),
    errors: (row.ocrErrors as OcrError[] | null) ?? [],
  };
}

/**
 * Parse the persisted back-cover regions JSON at the DB boundary (AGENTS.md
 * rule #2). A row written by an older / broken run that no longer matches the
 * schema is treated as "no regions" rather than crashing the review page.
 */
function parseBackRegions(
  raw: unknown,
  sessionId: string,
  bookId: string,
): BackCoverRegions | undefined {
  if (raw == null) return undefined;
  const parsed = backCoverRegionsSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn(
      { sessionId, bookId, issues: parsed.error.issues },
      "getOcrSnapshot: stored back-cover regions did not match the schema — ignoring",
    );
    return undefined;
  }
  return parsed.data;
}
