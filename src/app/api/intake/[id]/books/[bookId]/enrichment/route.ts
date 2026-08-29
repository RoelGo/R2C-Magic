import { getEnrichmentSnapshot } from "@/lib/intake/enrichment";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string; bookId: string }>;
}

/**
 * Live background-enrichment state for an intake book, polled by the review
 * screen (spec v2 US-C2). Returns the current status plus any online
 * suggestions found so far; never blocks the worker.
 */
export async function GET(_request: Request, { params }: Context) {
  const { id, bookId } = await params;
  const snapshot = getEnrichmentSnapshot(id, bookId);
  if (!snapshot) {
    return NextResponse.json({ error: "book not found" }, { status: 404 });
  }
  return NextResponse.json(snapshot);
}
