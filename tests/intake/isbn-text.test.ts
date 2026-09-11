import { describe, expect, it } from "vitest";
import {
  extractIsbnFromOcrText,
  extractIsbnFromText,
  isbn10ToEan13,
  repairOcrDigits,
} from "../../src/lib/intake/isbn-text";

/**
 * WI-3: the printed-ISBN OCR fallback. These run on fixture strings only —
 * no camera, no OCR engine, no network (AGENTS.md rule #5). The strings are
 * representative of what Tesseract returns for a Dutch imprint page.
 */
describe("lib/intake/isbn-text — extractIsbnFromText", () => {
  it("reads a hyphenated ISBN-13 behind an ISBN label", () => {
    expect(extractIsbnFromText("ISBN 978-90-450-3527-7")).toBe("9789045035277");
  });

  it("reads a space-separated ISBN-13", () => {
    expect(extractIsbnFromText("ISBN 978 90 450 3527 7")).toBe("9789045035277");
  });

  it("reads a bare (unlabelled) ISBN-13", () => {
    expect(extractIsbnFromText("9789045035277")).toBe("9789045035277");
  });

  it("reads a 979-prefixed ISBN", () => {
    expect(extractIsbnFromText("ISBN-13: 979-10-90636-07-1")).toBe("9791090636071");
  });

  it("converts a legacy ISBN-10 to its 978 EAN-13", () => {
    // 90-274-1234-0 → 978-90-274-1234-x
    expect(extractIsbnFromText("ISBN 90-274-1234-0")).toBe("9789027412348");
  });

  it("accepts an ISBN-10 ending in X", () => {
    expect(extractIsbnFromText("ISBN 0-8044-2957-X")).toBe("9780804429573");
  });

  it("prefers the number after the ISBN label over other long numbers", () => {
    const page = ["Eerste druk, 2019", "NUR 301 / 9789000000005", "ISBN 978-90-450-3527-7"].join(
      "\n",
    );
    expect(extractIsbnFromText(page)).toBe("9789045035277");
  });

  it("finds the ISBN in a noisy multi-line imprint page", () => {
    const page = [
      "Oorspronkelijke titel: Utilitarianism",
      "© 2021 Uitgeverij Boom, Amsterdam",
      "Omslagontwerp: Studio Jan de Boer",
      "ISBN: 978-90-450-3527-7",
      "NUR 730",
    ].join("\n");
    expect(extractIsbnFromText(page)).toBe("9789045035277");
  });

  it("returns null when nothing verifies", () => {
    expect(extractIsbnFromText("")).toBeNull();
    expect(extractIsbnFromText("Uitgeverij Boom, Amsterdam 2021")).toBeNull();
    // Right shape, wrong check digit — never guess.
    expect(extractIsbnFromText("ISBN 978-90-450-3527-1")).toBeNull();
    expect(extractIsbnFromText("NUR 730 / eerste druk 2019")).toBeNull();
  });

  it("does not accept a truncated or over-long digit run on its own", () => {
    expect(extractIsbnFromText("97890450352")).toBeNull();
  });
});

describe("lib/intake/isbn-text — isbn10ToEan13", () => {
  it("verifies the ISBN-10 check character before converting", () => {
    expect(isbn10ToEan13("9027412340")).toBe("9789027412348");
    expect(isbn10ToEan13("9027412344")).toBeNull();
    expect(isbn10ToEan13("not-an-isbn")).toBeNull();
  });
});

describe("lib/intake/isbn-text — OCR glyph repair", () => {
  it("repairs O/l/S confusions inside digit runs", () => {
    expect(repairOcrDigits("978-9O-45O-3527-7")).toBe("978-90-450-3527-7");
  });

  it("leaves words alone", () => {
    expect(repairOcrDigits("Uitgeverij Boom")).toBe("Uitgeverij Boom");
  });

  it("recovers an ISBN that only parses after repair", () => {
    expect(extractIsbnFromText("ISBN 978-9O-45O-3527-7")).toBeNull();
    expect(extractIsbnFromOcrText("ISBN 978-9O-45O-3527-7")).toBe("9789045035277");
  });
});
