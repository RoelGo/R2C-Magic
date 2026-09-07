import { describe, expect, it } from "vitest";
import type { OcrLine } from "../../src/lib/ocr/engine";
import { cleanLines, extractBackCover, extractFrontCover } from "../../src/lib/ocr/extract";

/** Build a geometry line at a given box height (x/y/width default to 0/10). */
function line(text: string, height: number, y = 0): OcrLine {
  return { text, box: { x: 0, y, width: 100, height } };
}

describe("lib/ocr/extract — cleanLines", () => {
  it("collapses whitespace and trims", () => {
    expect(cleanLines(["  Hello   world  ", "Foo\tbar"])).toEqual(["Hello world", "Foo bar"]);
  });

  it("drops empty and noise-only lines", () => {
    expect(cleanLines(["", "   ", "***", "12.99", "9789012345678", "A real title"])).toEqual([
      "A real title",
    ]);
  });

  it("keeps lines with at least two letters", () => {
    // "A" alone is noise; "AB" survives.
    expect(cleanLines(["A", "AB"])).toEqual(["AB"]);
  });
});

describe("lib/ocr/extract — extractFrontCover (reading-order fallback)", () => {
  it("takes the first substantial line as the title when no geometry", () => {
    const { title, author } = extractFrontCover(["De Ontdekking", "een roman"]);
    expect(title).toBe("De Ontdekking");
    expect(author).toBeUndefined();
  });

  it("pulls out an author credit and strips the prefix", () => {
    const { title, author } = extractFrontCover(["The Great Book", "by Jane Author"]);
    expect(title).toBe("The Great Book");
    expect(author).toBe("Jane Author");
  });

  it("recognises Dutch author prefixes", () => {
    const { title, author } = extractFrontCover(["Het Verhaal", "door Piet Schrijver"]);
    expect(title).toBe("Het Verhaal");
    expect(author).toBe("Piet Schrijver");
  });

  it("ignores noise when picking the title", () => {
    const { title } = extractFrontCover(["***", "12,99", "Real Title Here"]);
    expect(title).toBe("Real Title Here");
  });

  it("returns empty for no usable lines", () => {
    expect(extractFrontCover(["", "  ", "**"])).toEqual({});
  });

  it("recognises a bare author line printed after the title", () => {
    const { title, author } = extractFrontCover(["The Silent Patient", "Alex Michaelides"]);
    expect(title).toBe("The Silent Patient");
    expect(author).toBe("Alex Michaelides");
  });
});

describe("lib/ocr/extract — extractFrontCover (US-D5 size heuristic)", () => {
  it("picks the tallest line as the title even when the author is on top", () => {
    // Author printed above (first in reading order) but smaller than the title.
    const { title, author } = extractFrontCover([
      line("Alex Michaelides", 40, 0),
      line("The Silent Patient", 120, 100),
    ]);
    expect(title).toBe("The Silent Patient");
    expect(author).toBe("Alex Michaelides");
  });

  it("does not misassign the author as the title (author above, larger reading pos)", () => {
    const { title } = extractFrontCover([
      line("STEPHEN KING", 50, 0),
      line("The Shining", 150, 80),
      line("a novel", 30, 260),
    ]);
    expect(title).toBe("The Shining");
  });

  it("merges multiple title-sized lines into a multi-line title", () => {
    const { title } = extractFrontCover([
      line("The Very Long", 100, 0),
      line("Book Title", 98, 110),
      line("Jane Author", 40, 240),
    ]);
    expect(title).toBe("The Very Long Book Title");
  });

  it("strips an explicit prefix author even when large", () => {
    const { title, author } = extractFrontCover([
      line("Winter", 130, 0),
      line("by Ali Smith", 90, 150),
    ]);
    expect(title).toBe("Winter");
    expect(author).toBe("Ali Smith");
  });

  it("handles multiple authors joined by &", () => {
    const { title, author } = extractFrontCover([
      line("Good Omens", 140, 0),
      line("Terry Pratchett & Neil Gaiman", 45, 160),
    ]);
    expect(title).toBe("Good Omens");
    expect(author).toBe("Terry Pratchett & Neil Gaiman");
  });
});

describe("lib/ocr/extract — extractFrontCover (catalog cross-check)", () => {
  it("prefers the catalog title when OCR grabbed the author", () => {
    // No geometry, author-first: naive reading order would title = author.
    const { title, author } = extractFrontCover(["Haruki Murakami", "1Q84"], {
      title: "1Q84",
      author: "Haruki Murakami",
    });
    expect(title).toBe("1Q84");
    expect(author).toBe("Haruki Murakami");
  });

  it("keeps OCR casing when it matches the catalog title", () => {
    const { title } = extractFrontCover([line("Norwegian Wood", 120)], {
      title: "norwegian wood",
    });
    expect(title).toBe("Norwegian Wood");
  });

  it("swaps out a title that matches the catalog author", () => {
    const { title, author } = extractFrontCover(
      [line("Jane Austen", 100, 0), line("Emma", 90, 120)],
      { author: "Jane Austen" },
    );
    expect(title).toBe("Emma");
    expect(author).toBe("Jane Austen");
  });

  it("falls back to catalog values when OCR is empty", () => {
    const { title, author } = extractFrontCover([], { title: "Dune", author: "Frank Herbert" });
    expect(title).toBe("Dune");
    expect(author).toBe("Frank Herbert");
  });
});

describe("lib/ocr/extract — extractBackCover", () => {
  it("joins cleaned lines into a paragraph", () => {
    const desc = extractBackCover(["This is a", "gripping   novel", "about books."]);
    expect(desc).toBe("This is a gripping novel about books.");
  });

  it("drops noise lines from the blurb", () => {
    const desc = extractBackCover(["A story.", "9789012345678", "The end."]);
    expect(desc).toBe("A story. The end.");
  });

  it("returns undefined for no usable lines", () => {
    expect(extractBackCover(["", "***"])).toBeUndefined();
  });
});
