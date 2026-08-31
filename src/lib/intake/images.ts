/**
 * v2 mobile intake — cover photo storage (spec v2 US-D1 front, US-D2 back).
 *
 * Bytes are written to disk under `DATA_DIR/intake-images/<bookId>/`; the DB
 * keeps only a metadata row per (book, kind), so a retake cleanly overwrites
 * both the file and the row. Every input crosses a Zod boundary before we
 * touch the filesystem (AGENTS.md rule #2). OCR (US-D3/D4) consumes these
 * files later; here we only capture and serve them.
 */
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { intakeBooks, intakeImages } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";

export type IntakeImageKind = "front" | "back";

/** Accepted upload content types → file extension. */
const MIME_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const satisfies Record<string, string>;

/** Hard cap on a single stored cover photo. Phones easily fit under this. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024; // 12 MiB

const saveImageSchema = z.object({
  kind: z.enum(["front", "back"]),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  bytes: z
    .instanceof(Uint8Array)
    .refine((b) => b.byteLength > 0, "Image is empty")
    .refine((b) => b.byteLength <= MAX_IMAGE_BYTES, "Image exceeds the size limit"),
});

export interface SaveImageInput {
  kind: IntakeImageKind;
  mimeType: string;
  bytes: Uint8Array;
}

export interface IntakeImageMeta {
  kind: IntakeImageKind;
  mimeType: string;
  byteSize: number;
  createdAt: Date;
}

function dataRoot(): string {
  return resolve(process.cwd(), config.DATA_DIR);
}

function bookImageDir(bookId: string): string {
  return resolve(dataRoot(), "intake-images", bookId);
}

/** Absolute path for a stored image given its DB-relative `filePath`. */
export function absoluteImagePath(relativePath: string): string {
  return resolve(dataRoot(), relativePath);
}

/**
 * Save (or replace) a cover photo for an intake book. Validates the payload,
 * confirms the book belongs to the session, writes the file, and upserts the
 * metadata row. Returns the stored metadata.
 *
 * @throws if the payload is invalid or the book is not found in the session.
 */
export async function saveIntakeImage(
  sessionId: string,
  bookId: string,
  input: SaveImageInput,
): Promise<IntakeImageMeta> {
  const parsed = saveImageSchema.parse(input);

  const db = getDb();
  const book = db
    .select({ id: intakeBooks.id })
    .from(intakeBooks)
    .where(and(eq(intakeBooks.sessionId, sessionId), eq(intakeBooks.id, bookId)))
    .get();
  if (!book) {
    throw new Error(`Unknown intake book: ${bookId} in session ${sessionId}`);
  }

  const ext = MIME_EXTENSIONS[parsed.mimeType];
  const relativePath = `intake-images/${bookId}/${parsed.kind}.${ext}`;
  const dir = bookImageDir(bookId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  await writeFile(absoluteImagePath(relativePath), parsed.bytes);

  const now = new Date();
  db.insert(intakeImages)
    .values({
      id: ulid(),
      bookId,
      kind: parsed.kind,
      filePath: relativePath,
      mimeType: parsed.mimeType,
      byteSize: parsed.bytes.byteLength,
      createdAt: now,
    })
    // Retake: overwrite the existing (book, kind) row in place.
    .onConflictDoUpdate({
      target: [intakeImages.bookId, intakeImages.kind],
      set: {
        filePath: relativePath,
        mimeType: parsed.mimeType,
        byteSize: parsed.bytes.byteLength,
        createdAt: now,
      },
    })
    .run();

  logger.info(
    { sessionId, bookId, kind: parsed.kind, bytes: parsed.bytes.byteLength },
    "intake cover photo saved",
  );

  return {
    kind: parsed.kind,
    mimeType: parsed.mimeType,
    byteSize: parsed.bytes.byteLength,
    createdAt: now,
  };
}

/** List the cover photos captured for a book (front and/or back). */
export function listIntakeImages(sessionId: string, bookId: string): IntakeImageMeta[] {
  const db = getDb();
  const rows = db
    .select({
      kind: intakeImages.kind,
      mimeType: intakeImages.mimeType,
      byteSize: intakeImages.byteSize,
      createdAt: intakeImages.createdAt,
      sessionId: intakeBooks.sessionId,
    })
    .from(intakeImages)
    .innerJoin(intakeBooks, eq(intakeBooks.id, intakeImages.bookId))
    .where(and(eq(intakeImages.bookId, bookId), eq(intakeBooks.sessionId, sessionId)))
    .all();

  return rows.map(({ kind, mimeType, byteSize, createdAt }) => ({
    kind,
    mimeType,
    byteSize,
    createdAt,
  }));
}

export interface IntakeImageFile {
  bytes: Buffer;
  mimeType: string;
}

/**
 * Resolve the absolute filesystem path of a stored cover photo, for engines
 * (OCR) that operate on a file path. Returns `undefined` if the book/kind has
 * no image or the file is missing on disk.
 */
export function getIntakeImagePath(
  sessionId: string,
  bookId: string,
  kind: IntakeImageKind,
): string | undefined {
  const db = getDb();
  const row = db
    .select({ filePath: intakeImages.filePath })
    .from(intakeImages)
    .innerJoin(intakeBooks, eq(intakeBooks.id, intakeImages.bookId))
    .where(
      and(
        eq(intakeImages.bookId, bookId),
        eq(intakeImages.kind, kind),
        eq(intakeBooks.sessionId, sessionId),
      ),
    )
    .get();
  if (!row) return undefined;

  const absolute = absoluteImagePath(row.filePath);
  return existsSync(absolute) ? absolute : undefined;
}

/**
 * Read a stored cover photo's bytes for serving/OCR. Returns `undefined` if
 * the book/kind has no image (or the row exists but the file is missing).
 */
export async function readIntakeImage(
  sessionId: string,
  bookId: string,
  kind: IntakeImageKind,
): Promise<IntakeImageFile | undefined> {
  const db = getDb();
  const row = db
    .select({
      filePath: intakeImages.filePath,
      mimeType: intakeImages.mimeType,
    })
    .from(intakeImages)
    .innerJoin(intakeBooks, eq(intakeBooks.id, intakeImages.bookId))
    .where(
      and(
        eq(intakeImages.bookId, bookId),
        eq(intakeImages.kind, kind),
        eq(intakeBooks.sessionId, sessionId),
      ),
    )
    .get();
  if (!row) return undefined;

  const absolute = absoluteImagePath(row.filePath);
  if (!existsSync(absolute)) {
    logger.warn({ sessionId, bookId, kind, path: row.filePath }, "intake image file missing");
    return undefined;
  }
  return { bytes: await readFile(absolute), mimeType: row.mimeType };
}
