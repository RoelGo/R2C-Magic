import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { useTmpEnv } from "../helpers/tmp-env";

// A minimal valid JPEG header + body is unnecessary here: the lib validates
// size/mime, not pixel content. We use small byte buffers as stand-in photos.
function fakeJpeg(size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes[0] = 0xff;
  bytes[1] = 0xd8; // JPEG SOI marker, for realism
  return bytes;
}

describe("lib/intake/images", () => {
  useTmpEnv();

  async function seedBook() {
    const { createSession, addBookToSession } = await import("../../src/lib/intake");
    const sessionId = createSession();
    const bookId = addBookToSession(sessionId);
    return { sessionId, bookId };
  }

  it("saves a front cover to disk and records metadata", async () => {
    const { sessionId, bookId } = await seedBook();
    const { saveIntakeImage, listIntakeImages, absoluteImagePath } = await import(
      "../../src/lib/intake/images"
    );

    const meta = await saveIntakeImage(sessionId, bookId, {
      kind: "front",
      mimeType: "image/jpeg",
      bytes: fakeJpeg(),
    });

    expect(meta.kind).toBe("front");
    expect(meta.byteSize).toBe(64);
    expect(existsSync(absoluteImagePath(`intake-images/${bookId}/front.jpg`))).toBe(true);

    const list = listIntakeImages(sessionId, bookId);
    expect(list.map((i) => i.kind)).toEqual(["front"]);
  });

  it("stores front and back independently", async () => {
    const { sessionId, bookId } = await seedBook();
    const { saveIntakeImage, listIntakeImages } = await import("../../src/lib/intake/images");

    await saveIntakeImage(sessionId, bookId, {
      kind: "front",
      mimeType: "image/jpeg",
      bytes: fakeJpeg(),
    });
    await saveIntakeImage(sessionId, bookId, {
      kind: "back",
      mimeType: "image/png",
      bytes: fakeJpeg(32),
    });

    const kinds = listIntakeImages(sessionId, bookId)
      .map((i) => i.kind)
      .sort();
    expect(kinds).toEqual(["back", "front"]);
  });

  it("a retake overwrites the existing (book, kind) row and file", async () => {
    const { sessionId, bookId } = await seedBook();
    const { saveIntakeImage, listIntakeImages, readIntakeImage } = await import(
      "../../src/lib/intake/images"
    );

    await saveIntakeImage(sessionId, bookId, {
      kind: "front",
      mimeType: "image/jpeg",
      bytes: fakeJpeg(64),
    });
    await saveIntakeImage(sessionId, bookId, {
      kind: "front",
      mimeType: "image/jpeg",
      bytes: fakeJpeg(128),
    });

    // Still exactly one front row, now reflecting the newer size.
    const fronts = listIntakeImages(sessionId, bookId).filter((i) => i.kind === "front");
    expect(fronts).toHaveLength(1);
    expect(fronts[0]?.byteSize).toBe(128);

    const file = await readIntakeImage(sessionId, bookId, "front");
    expect(file?.bytes.byteLength).toBe(128);
  });

  it("reads back stored bytes with the right mime type", async () => {
    const { sessionId, bookId } = await seedBook();
    const { saveIntakeImage, readIntakeImage } = await import("../../src/lib/intake/images");

    await saveIntakeImage(sessionId, bookId, {
      kind: "back",
      mimeType: "image/webp",
      bytes: fakeJpeg(),
    });

    const file = await readIntakeImage(sessionId, bookId, "back");
    expect(file?.mimeType).toBe("image/webp");
    expect(file?.bytes.byteLength).toBe(64);
  });

  it("returns undefined reading a kind with no photo", async () => {
    const { sessionId, bookId } = await seedBook();
    const { readIntakeImage } = await import("../../src/lib/intake/images");
    expect(await readIntakeImage(sessionId, bookId, "front")).toBeUndefined();
  });

  it("rejects an empty image", async () => {
    const { sessionId, bookId } = await seedBook();
    const { saveIntakeImage } = await import("../../src/lib/intake/images");
    await expect(
      saveIntakeImage(sessionId, bookId, {
        kind: "front",
        mimeType: "image/jpeg",
        bytes: new Uint8Array(0),
      }),
    ).rejects.toThrow();
  });

  it("rejects an oversized image", async () => {
    const { sessionId, bookId } = await seedBook();
    const { saveIntakeImage, MAX_IMAGE_BYTES } = await import("../../src/lib/intake/images");
    await expect(
      saveIntakeImage(sessionId, bookId, {
        kind: "front",
        mimeType: "image/jpeg",
        bytes: new Uint8Array(MAX_IMAGE_BYTES + 1),
      }),
    ).rejects.toThrow();
  });

  it("rejects an unsupported mime type", async () => {
    const { sessionId, bookId } = await seedBook();
    const { saveIntakeImage } = await import("../../src/lib/intake/images");
    // Cross the runtime boundary with a bad mime; the Zod enum must reject it.
    const badInput = {
      kind: "front",
      mimeType: "image/gif",
      bytes: fakeJpeg(),
    } as unknown as Parameters<typeof saveIntakeImage>[2];
    await expect(saveIntakeImage(sessionId, bookId, badInput)).rejects.toThrow();
  });

  it("rejects saving to an unknown book", async () => {
    const { sessionId } = await seedBook();
    const { saveIntakeImage } = await import("../../src/lib/intake/images");
    await expect(
      saveIntakeImage(sessionId, "nope", {
        kind: "front",
        mimeType: "image/jpeg",
        bytes: fakeJpeg(),
      }),
    ).rejects.toThrow(/Unknown intake book/);
  });

  it("scopes images to the owning session", async () => {
    const { sessionId, bookId } = await seedBook();
    const { createSession } = await import("../../src/lib/intake");
    const { saveIntakeImage, listIntakeImages, readIntakeImage } = await import(
      "../../src/lib/intake/images"
    );

    await saveIntakeImage(sessionId, bookId, {
      kind: "front",
      mimeType: "image/jpeg",
      bytes: fakeJpeg(),
    });

    const otherSession = createSession();
    // Same bookId but a different session must not see the image.
    expect(listIntakeImages(otherSession, bookId)).toEqual([]);
    expect(await readIntakeImage(otherSession, bookId, "front")).toBeUndefined();
  });
});
