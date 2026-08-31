import { describe, expect, it } from "vitest";
import { cleanLines, extractBackCover, extractFrontCover } from "../../src/lib/ocr/extract";

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

describe("lib/ocr/extract — extractFrontCover", () => {
  it("takes the first substantial line as the title", () => {
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
