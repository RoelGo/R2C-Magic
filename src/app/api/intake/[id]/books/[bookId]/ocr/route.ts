import { getOcrSnapshot } from "@/lib/intake/ocr";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string; bookId: string }>;
}

/**
 * Live cover-OCR state for an intake book, polled by the review screen (spec
 * v2 US-D3/D4). Returns the current status plus any extracted title/author/
 * description; never blocks the worker.
 */
export async function GET(_request: Request, { params }: Context) {
  const { id, bookId } = await params;
  const snapshot = getOcrSnapshot(id, bookId);
  if (!snapshot) {
    return NextResponse.json({ error: "book not found" }, { status: 404 });
  }
  return NextResponse.json(snapshot);
}
