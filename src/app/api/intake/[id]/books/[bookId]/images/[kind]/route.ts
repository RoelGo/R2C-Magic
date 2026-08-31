import { type IntakeImageKind, readIntakeImage, saveIntakeImage } from "@/lib/intake/images";
import { startOcr } from "@/lib/intake/ocr";
import { logger } from "@/lib/logger";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string; bookId: string; kind: string }>;
}

function parseKind(kind: string): IntakeImageKind | undefined {
  return kind === "front" || kind === "back" ? kind : undefined;
}

/**
 * Upload (or retake) a cover photo for an intake book (spec v2 US-D1/US-D2).
 * The client posts the captured image as a `multipart/form-data` `file`
 * field; the lib validates size/type, writes it under DATA_DIR, and upserts
 * the (book, kind) metadata row.
 */
export async function POST(request: Request, { params }: Context) {
  const { id, bookId, kind: rawKind } = await params;
  const kind = parseKind(rawKind);
  if (!kind) {
    return NextResponse.json({ error: "kind must be 'front' or 'back'" }, { status: 400 });
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "missing 'file'" }, { status: 400 });
  }

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const meta = await saveIntakeImage(id, bookId, {
      kind,
      mimeType: file.type,
      bytes,
    });
    // Kick off cover OCR now that a new/updated photo exists (US-D3/D4).
    // Non-blocking: runs on the shared queue and is polled separately.
    startOcr(id, bookId);
    return NextResponse.json(meta, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save image";
    logger.warn({ sessionId: id, bookId, kind, message }, "intake image upload rejected");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** Stream a stored cover photo back for the in-app preview. */
export async function GET(_request: Request, { params }: Context) {
  const { id, bookId, kind: rawKind } = await params;
  const kind = parseKind(rawKind);
  if (!kind) {
    return NextResponse.json({ error: "kind must be 'front' or 'back'" }, { status: 400 });
  }

  const image = await readIntakeImage(id, bookId, kind);
  if (!image) {
    return NextResponse.json({ error: "image not found" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(image.bytes), {
    status: 200,
    headers: {
      "content-type": image.mimeType,
      "cache-control": "no-store",
    },
  });
}
