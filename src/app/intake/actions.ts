"use server";

import { addBookToSession, createSession } from "@/lib/intake";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

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
