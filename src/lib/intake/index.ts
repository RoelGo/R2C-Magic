/**
 * v2 mobile intake — session lifecycle and queries (spec v2 Slice A).
 *
 * A worker starts an `intake_session` from the mobile "New arrivals" screen
 * and adds books to it one at a time. This module owns creating sessions,
 * adding book rows, and the summary queries the session screen renders
 * (book list + running count, US-A2). Barcode/enrichment/OCR/eCom state is
 * layered onto `intake_books` by later slices.
 */
import { getDb } from "@/lib/db/client";
import { intakeBooks, intakeSessions } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { and, desc, eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { normalizeEan13 } from "./ean";

export type IntakeBookStatus = "draft" | "pushed" | "failed";

export interface CreateSessionInput {
  /** Optional worker-supplied label (e.g. supplier / delivery note). */
  label?: string;
}

/** Create a new active intake session and return its id. */
export function createSession(input: CreateSessionInput = {}): string {
  const db = getDb();
  const id = ulid();
  const label = input.label?.trim() || null;
  db.insert(intakeSessions).values({ id, label, status: "active" }).run();
  logger.info({ sessionId: id, label }, "intake session started");
  return id;
}

export interface IntakeBookSummary {
  id: string;
  ean: string | null;
  title: string | null;
  status: IntakeBookStatus;
  createdAt: Date;
}

/** Extended book view for the per-book screen (includes push + review state). */
export interface IntakeBookDetail extends IntakeBookSummary {
  reviewedTitle: string | null;
  retailLookupStatus: "idle" | "checking" | "found" | "missing" | "error";
  retailLookupError: string | null;
  retailItemID: string | null;
  pushError: string | null;
  pushedAt: Date | null;
}

export interface IntakeSessionSummary {
  id: string;
  label: string | null;
  status: "active" | "closed";
  startedAt: Date;
  /** Total books added to the session (any status). */
  bookCount: number;
}

export interface IntakeSessionDetail extends IntakeSessionSummary {
  books: IntakeBookSummary[];
}

/** Fetch a session with its books (newest first) for the session screen. */
export function getSessionDetail(sessionId: string): IntakeSessionDetail | undefined {
  const db = getDb();
  const session = db.select().from(intakeSessions).where(eq(intakeSessions.id, sessionId)).get();
  if (!session) return undefined;

  const books = db
    .select({
      id: intakeBooks.id,
      ean: intakeBooks.ean,
      title: intakeBooks.title,
      status: intakeBooks.status,
      createdAt: intakeBooks.createdAt,
    })
    .from(intakeBooks)
    .where(eq(intakeBooks.sessionId, sessionId))
    .orderBy(desc(intakeBooks.createdAt), desc(intakeBooks.id))
    .all();

  return {
    id: session.id,
    label: session.label,
    status: session.status,
    startedAt: session.startedAt,
    bookCount: books.length,
    books,
  };
}

/** List recent sessions (newest first) with their book counts. */
export function listSessions(limit = 50): IntakeSessionSummary[] {
  const db = getDb();
  const rows = db
    .select({
      id: intakeSessions.id,
      label: intakeSessions.label,
      status: intakeSessions.status,
      startedAt: intakeSessions.startedAt,
      bookCount: sql<number>`count(${intakeBooks.id})`.as("book_count"),
    })
    .from(intakeSessions)
    .leftJoin(intakeBooks, eq(intakeBooks.sessionId, intakeSessions.id))
    .groupBy(intakeSessions.id)
    .orderBy(desc(intakeSessions.startedAt), desc(intakeSessions.id))
    .limit(limit)
    .all();
  return rows.map((r) => ({ ...r, bookCount: Number(r.bookCount) }));
}

/**
 * Add a new (draft) book to a session and return its id. Later slices fill in
 * EAN, title, and push status as the worker progresses through the flow.
 *
 * @throws if the session does not exist.
 */
export function addBookToSession(sessionId: string): string {
  const db = getDb();
  const session = db
    .select({ id: intakeSessions.id })
    .from(intakeSessions)
    .where(eq(intakeSessions.id, sessionId))
    .get();
  if (!session) throw new Error(`Unknown intake session: ${sessionId}`);

  const id = ulid();
  db.insert(intakeBooks).values({ id, sessionId, status: "draft" }).run();
  logger.info({ sessionId, bookId: id }, "intake book added");
  return id;
}

/** Fetch a single book within a session (for reopening its review form). */
export function getIntakeBook(sessionId: string, bookId: string): IntakeBookDetail | undefined {
  const db = getDb();
  return db
    .select({
      id: intakeBooks.id,
      ean: intakeBooks.ean,
      title: intakeBooks.title,
      status: intakeBooks.status,
      createdAt: intakeBooks.createdAt,
      reviewedTitle: intakeBooks.reviewedTitle,
      retailLookupStatus: intakeBooks.retailLookupStatus,
      retailLookupError: intakeBooks.retailLookupError,
      retailItemID: intakeBooks.retailItemID,
      pushError: intakeBooks.pushError,
      pushedAt: intakeBooks.pushedAt,
    })
    .from(intakeBooks)
    .where(and(eq(intakeBooks.sessionId, sessionId), eq(intakeBooks.id, bookId)))
    .get();
}

/**
 * Persist a captured/typed EAN onto an intake book (spec v2 US-B1/US-B2).
 *
 * The EAN is validated (length + EAN-13 check digit) at this boundary; an
 * invalid value throws so callers surface it inline rather than storing junk.
 * Later slices trigger background enrichment (US-C1) off the stored EAN.
 *
 * @throws if the book is not found in the session, or the EAN is invalid.
 */
export function setBookEan(sessionId: string, bookId: string, rawEan: string): string {
  const normalized = normalizeEan13(rawEan);
  if (!normalized) {
    throw new Error(`Invalid EAN-13: ${rawEan}`);
  }

  const db = getDb();
  const result = db
    .update(intakeBooks)
    .set({ ean: normalized, updatedAt: new Date() })
    .where(and(eq(intakeBooks.sessionId, sessionId), eq(intakeBooks.id, bookId)))
    .run();

  if (result.changes === 0) {
    throw new Error(`Unknown intake book: ${bookId} in session ${sessionId}`);
  }

  logger.info({ sessionId, bookId, ean: normalized }, "intake book EAN captured");
  return normalized;
}
