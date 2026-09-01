"use server";

import { addBookToSession, createSession, setBookEan } from "@/lib/intake";
import { startEnrichment } from "@/lib/intake/enrichment";
import { type SaveReviewInput, saveIntakeReview } from "@/lib/intake/review";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";

/**
 * Server action: start a new intake session and redirect the worker to it
 * (spec v2 US-A1). Accepts an optional free-text label from the form.
 */
export async function startIntakeSessionAction(formData: FormData): Promise<void> {
  const rawLabel = formData.get("label");
  const label = typeof rawLabel === "string" ? rawLabel : undefined;
  const sessionId = createSession({ label });
  revalidatePath("/intake");
  redirect(`/intake/${sessionId}`);
}

/**
 * Server action: add a fresh draft book to a session and jump into its flow
 * (Slice B onwards). For Slice A this simply creates the row and reopens the
 * session screen so the new book appears in the list.
 */
export async function addIntakeBookAction(formData: FormData): Promise<void> {
  const sessionId = formData.get("sessionId");
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error("Missing sessionId");
  }
  const bookId = addBookToSession(sessionId);
  revalidatePath(`/intake/${sessionId}`);
  redirect(`/intake/${sessionId}/books/${bookId}`);
}

export type SetBookEanResult = { ok: true; ean: string } | { ok: false; error: string };

/**
 * Server action: validate and persist a scanned/typed EAN onto a book
 * (spec v2 US-B1/US-B2). Called from the client capture component, so it
 * returns a result object (rather than throwing) to drive inline validation
 * messages. A successful capture revalidates the book + session views.
 */
export async function setBookEanAction(
  sessionId: string,
  bookId: string,
  rawEan: string,
): Promise<SetBookEanResult> {
  try {
    const ean = setBookEan(sessionId, bookId, rawEan);
    // Kick off background online enrichment immediately (US-C1). Non-blocking:
    // the worker moves on to photos while sources are queried.
    startEnrichment(sessionId, bookId, ean);
    revalidatePath(`/intake/${sessionId}/books/${bookId}`);
    revalidatePath(`/intake/${sessionId}`);
    return { ok: true, ean };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to save EAN" };
  }
}

export type SaveReviewResult = { ok: true } | { ok: false; error: string };

/**
 * Server action: validate and persist the assisted review form (spec v2
 * US-E1/E2/E3). Called from the client review form, so it returns a result
 * object (rather than throwing) to drive inline validation. On success the
 * book + session views are revalidated so the confirmed title appears in the
 * list. The webshop push is a separate step (Slice F).
 */
export async function saveIntakeReviewAction(
  sessionId: string,
  bookId: string,
  input: SaveReviewInput,
): Promise<SaveReviewResult> {
  try {
    saveIntakeReview(sessionId, bookId, input);
    revalidatePath(`/intake/${sessionId}/books/${bookId}`);
    revalidatePath(`/intake/${sessionId}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof ZodError) {
      return { ok: false, error: err.issues[0]?.message ?? "Invalid review details" };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Failed to save review" };
  }
}
