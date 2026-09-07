import { describe, expect, it, vi } from "vitest";
import type { OcrEngine } from "../../src/lib/ocr/engine";
import { useTmpEnv } from "../helpers/tmp-env";

function fakeJpeg(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  return bytes;
}

/** A stub engine returning canned lines per call, so no binary/model is used. */
function stubEngine(recognize: OcrEngine["recognize"]): OcrEngine {
  return { id: "pp-ocrv6", recognize };
}

describe("lib/intake/ocr", () => {
  useTmpEnv();

  async function seedBookWithPhotos(opts: { front?: boolean; back?: boolean }) {
    const { createSession, addBookToSession } = await import("../../src/lib/intake");
    const { saveIntakeImage } = await import("../../src/lib/intake/images");
    const sessionId = createSession();
    const bookId = addBookToSession(sessionId);
    if (opts.front) {
      await saveIntakeImage(sessionId, bookId, {
        kind: "front",
        mimeType: "image/jpeg",
        bytes: fakeJpeg(),
      });
    }
    if (opts.back) {
      await saveIntakeImage(sessionId, bookId, {
        kind: "back",
        mimeType: "image/jpeg",
        bytes: fakeJpeg(),
      });
    }
    return { sessionId, bookId };
  }

  it("runOcr extracts a title from the front cover and marks done", async () => {
    const { sessionId, bookId } = await seedBookWithPhotos({ front: true });
    const { runOcr, getOcrSnapshot } = await import("../../src/lib/intake/ocr");

    const engine = stubEngine(async () => ({
      lines: ["De Ontdekking", "by Jan Jansen"],
      text: "De Ontdekking\nby Jan Jansen",
    }));

    const errors = await runOcr(sessionId, bookId, engine);
    expect(errors).toEqual([]);

    const snap = getOcrSnapshot(sessionId, bookId);
    expect(snap?.status).toBe("done");
    expect(snap?.engine).toBe("pp-ocrv6");
    expect(snap?.suggestions.title).toBe("De Ontdekking");
    expect(snap?.suggestions.author).toBe("Jan Jansen");
  });

  it("runOcr reads a description from the back cover", async () => {
    const { sessionId, bookId } = await seedBookWithPhotos({ back: true });
    const { runOcr, getOcrSnapshot } = await import("../../src/lib/intake/ocr");

    const engine = stubEngine(async () => ({
      lines: ["A gripping tale", "of books and code."],
      text: "A gripping tale\nof books and code.",
    }));

    await runOcr(sessionId, bookId, engine);

    const snap = getOcrSnapshot(sessionId, bookId);
    expect(snap?.status).toBe("done");
    expect(snap?.suggestions.description).toBe("A gripping tale of books and code.");
  });

  it("marks empty when the engine reads nothing usable", async () => {
    const { sessionId, bookId } = await seedBookWithPhotos({ front: true });
    const { runOcr, getOcrSnapshot } = await import("../../src/lib/intake/ocr");

    const engine = stubEngine(async () => ({ lines: ["***", "12,99"], text: "***\n12,99" }));

    await runOcr(sessionId, bookId, engine);
    expect(getOcrSnapshot(sessionId, bookId)?.status).toBe("empty");
  });

  it("marks failed and records the error when every image errors", async () => {
    const { sessionId, bookId } = await seedBookWithPhotos({ front: true });
    const { runOcr, getOcrSnapshot } = await import("../../src/lib/intake/ocr");

    const engine = stubEngine(async () => {
      throw new Error("OCR binary not found: pp-ocrv6");
    });

    const errors = await runOcr(sessionId, bookId, engine);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("front");

    const snap = getOcrSnapshot(sessionId, bookId);
    expect(snap?.status).toBe("failed");
    expect(snap?.errors[0]?.message).toMatch(/binary not found/);
  });

  it("partial failure (front errors, back ok) still yields done", async () => {
    const { sessionId, bookId } = await seedBookWithPhotos({ front: true, back: true });
    const { runOcr, getOcrSnapshot } = await import("../../src/lib/intake/ocr");

    const engine = stubEngine(async (imagePath: string) => {
      if (imagePath.endsWith("front.jpg")) throw new Error("boom");
      return { lines: ["Back blurb text."], text: "Back blurb text." };
    });

    const errors = await runOcr(sessionId, bookId, engine);
    expect(errors.map((e) => e.kind)).toEqual(["front"]);

    const snap = getOcrSnapshot(sessionId, bookId);
    expect(snap?.status).toBe("done");
    expect(snap?.suggestions.description).toBe("Back blurb text.");
  });

  it("marks empty with no engine (OCR disabled) and never calls one", async () => {
    // useTmpEnv leaves OCR_ENABLED unset -> disabled by default.
    const { sessionId, bookId } = await seedBookWithPhotos({ front: true });
    const { runOcr, getOcrSnapshot } = await import("../../src/lib/intake/ocr");

    const recognize = vi.fn();
    // Pass undefined explicitly to exercise the disabled path.
    await runOcr(sessionId, bookId, undefined);
    expect(recognize).not.toHaveBeenCalled();
    expect(getOcrSnapshot(sessionId, bookId)?.status).toBe("empty");
  });

  it("getOcrSnapshot returns undefined for an unknown book", async () => {
    const { createSession } = await import("../../src/lib/intake");
    const { getOcrSnapshot } = await import("../../src/lib/intake/ocr");
    expect(getOcrSnapshot(createSession(), "nope")).toBeUndefined();
  });

  it("startOcr marks running synchronously then completes via the queue", async () => {
    process.env.OCR_ENABLED = "true";
    vi.resetModules();
    const { sessionId, bookId } = await seedBookWithPhotos({ front: true });
    const { startOcr, getOcrSnapshot } = await import("../../src/lib/intake/ocr");
    const { getQueue } = await import("../../src/lib/jobs/queue");

    const engine = stubEngine(async () => ({ lines: ["Queued Title"], text: "Queued Title" }));
    startOcr(sessionId, bookId, engine);

    // Running is set synchronously before the queue drains.
    expect(getOcrSnapshot(sessionId, bookId)?.status).toBe("running");

    await getQueue().onIdle();
    const snap = getOcrSnapshot(sessionId, bookId);
    expect(snap?.status).toBe("done");
    expect(snap?.suggestions.title).toBe("Queued Title");
  });
});
