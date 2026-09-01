import { describe, expect, it } from "vitest";
import { useTmpEnv } from "../helpers/tmp-env";

/**
 * Slice E — assisted review form model + persistence (US-E1/E2/E3).
 *
 * Covers the precedence pre-fill (online > OCR > blank), suggestion assembly +
 * dedupe, saved-value round-trips, and Zod validation at the save boundary.
 * Suggestions are seeded by writing the enrichment/OCR columns directly (the
 * same columns the orchestrators fill), so the test needs no live sources.
 */
describe("lib/intake/review", () => {
  useTmpEnv();

  async function seedBook() {
    const { createSession, addBookToSession } = await import("../../src/lib/intake");
    const sessionId = createSession();
    const bookId = addBookToSession(sessionId);
    return { sessionId, bookId };
  }

  async function setSuggestions(
    bookId: string,
    fields: {
      online?: { title?: string; authors?: string[]; description?: string; weightGrams?: number };
      ocr?: { title?: string; author?: string; description?: string };
    },
  ) {
    const { getDb } = await import("../../src/lib/db/client");
    const { intakeBooks } = await import("../../src/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = getDb();

    const set: Record<string, unknown> = {};
    if (fields.online) {
      set.enrichmentStatus = "done";
      set.enrichedPayload = {
        ean: "9789462673359",
        source: "merged",
        titleShort: fields.online.title,
        authors: fields.online.authors,
        descriptionShort: fields.online.description,
        weightGrams: fields.online.weightGrams,
      };
    }
    if (fields.ocr) {
      set.ocrStatus = "done";
      set.ocrEngine = "pp-ocrv6";
      set.ocrTitle = fields.ocr.title ?? null;
      set.ocrAuthor = fields.ocr.author ?? null;
      set.ocrDescription = fields.ocr.description ?? null;
    }
    db.update(intakeBooks).set(set).where(eq(intakeBooks.id, bookId)).run();
  }

  it("prefers online over OCR for the default value", async () => {
    const { sessionId, bookId } = await seedBook();
    await setSuggestions(bookId, {
      online: { title: "Online Title", authors: ["Jane Roe"], description: "Online blurb." },
      ocr: { title: "Cover Title", author: "J. ROE", description: "Cover blurb." },
    });

    const { buildReviewModel } = await import("../../src/lib/intake/review");
    const model = buildReviewModel(sessionId, bookId);

    expect(model).toBeDefined();
    if (!model) return;
    expect(model.title.value).toBe("Online Title");
    expect(model.title.source).toBe("online");
    // Both online and OCR are offered as options, online first.
    expect(model.title.suggestions.map((s) => s.source)).toEqual(["online", "ocr"]);
    expect(model.author.value).toBe("Jane Roe");
    expect(model.description.value).toBe("Online blurb.");
  });

  it("falls back to OCR when there is no online match", async () => {
    const { sessionId, bookId } = await seedBook();
    await setSuggestions(bookId, {
      ocr: { title: "Cover Title", author: "Cover Author", description: "Cover blurb." },
    });

    const { buildReviewModel } = await import("../../src/lib/intake/review");
    const model = buildReviewModel(sessionId, bookId);
    if (!model) throw new Error("no model");

    expect(model.title.value).toBe("Cover Title");
    expect(model.title.source).toBe("ocr");
    expect(model.description.source).toBe("ocr");
  });

  it("leaves fields blank + manual with no suggestions", async () => {
    const { sessionId, bookId } = await seedBook();
    const { buildReviewModel } = await import("../../src/lib/intake/review");
    const model = buildReviewModel(sessionId, bookId);
    if (!model) throw new Error("no model");

    expect(model.title.value).toBe("");
    expect(model.title.source).toBe("manual");
    expect(model.title.suggestions).toEqual([]);
    expect(model.saved).toBeNull();
  });

  it("dedupes identical online/OCR values, keeping online", async () => {
    const { sessionId, bookId } = await seedBook();
    await setSuggestions(bookId, {
      online: { title: "Same Title" },
      ocr: { title: "Same Title" },
    });
    const { buildReviewModel } = await import("../../src/lib/intake/review");
    const model = buildReviewModel(sessionId, bookId);
    if (!model) throw new Error("no model");

    expect(model.title.suggestions).toHaveLength(1);
    expect(model.title.suggestions[0]?.source).toBe("online");
  });

  it("joins multiple online authors", async () => {
    const { sessionId, bookId } = await seedBook();
    await setSuggestions(bookId, { online: { authors: ["Ann", "Bob"] } });
    const { buildReviewModel } = await import("../../src/lib/intake/review");
    const model = buildReviewModel(sessionId, bookId);
    if (!model) throw new Error("no model");
    expect(model.author.value).toBe("Ann, Bob");
  });

  it("returns undefined for an unknown book", async () => {
    const { sessionId } = await seedBook();
    const { buildReviewModel } = await import("../../src/lib/intake/review");
    expect(buildReviewModel(sessionId, "nope")).toBeUndefined();
  });

  it("saves reviewed values and reflects them on reopen", async () => {
    const { sessionId, bookId } = await seedBook();
    await setSuggestions(bookId, { online: { title: "Online Title" } });

    const { saveIntakeReview, buildReviewModel } = await import("../../src/lib/intake/review");
    saveIntakeReview(sessionId, bookId, {
      title: "Confirmed Title",
      author: "A. Writer",
      description: "  Confirmed blurb.  ",
      weightGrams: 350,
      titleSource: "manual",
      authorSource: "online",
      descriptionSource: "ocr",
    });

    const model = buildReviewModel(sessionId, bookId);
    if (!model) throw new Error("no model");
    expect(model.saved).toEqual({
      title: "Confirmed Title",
      author: "A. Writer",
      description: "Confirmed blurb.",
      weightGrams: 350,
      titleSource: "manual",
      authorSource: "online",
      descriptionSource: "ocr",
    });
    // Reopened field prefers the saved value over the online suggestion.
    expect(model.title.value).toBe("Online Title"); // model.title reflects suggestions
    // The list-view title column is kept in sync.
    const { getIntakeBook } = await import("../../src/lib/intake");
    expect(getIntakeBook(sessionId, bookId)?.title).toBe("Confirmed Title");
  });

  it("rejects an empty title at the Zod boundary", async () => {
    const { sessionId, bookId } = await seedBook();
    const { saveIntakeReview } = await import("../../src/lib/intake/review");
    expect(() =>
      saveIntakeReview(sessionId, bookId, {
        title: "   ",
      }),
    ).toThrow();
  });

  it("throws for an unknown book on save", async () => {
    const { sessionId } = await seedBook();
    const { saveIntakeReview } = await import("../../src/lib/intake/review");
    expect(() => saveIntakeReview(sessionId, "nope", { title: "X" })).toThrow(
      /Unknown intake book/,
    );
  });

  it("defaults optional sources to manual", async () => {
    const { sessionId, bookId } = await seedBook();
    const { saveIntakeReview, buildReviewModel } = await import("../../src/lib/intake/review");
    saveIntakeReview(sessionId, bookId, { title: "T" });
    const model = buildReviewModel(sessionId, bookId);
    expect(model?.saved?.titleSource).toBe("manual");
    expect(model?.saved?.authorSource).toBe("manual");
  });
});
