import { describe, expect, it } from "vitest";
import { cleanEan, isValidEan13, normalizeEan13 } from "../../src/lib/intake/ean";

describe("lib/intake/ean", () => {
  // Real, valid ISBN-13s (check digit correct).
  const VALID = ["9780140328721", "9789462673359", "9789083436999", "9789403139838"];

  it("accepts valid EAN-13 / ISBN-13 values", () => {
    for (const ean of VALID) {
      expect(isValidEan13(ean), ean).toBe(true);
      expect(normalizeEan13(ean)).toBe(ean);
    }
  });

  it("strips hyphens and spaces before validating", () => {
    expect(cleanEan("978-0-14-032872-1")).toBe("9780140328721");
    expect(isValidEan13("978-0-14-032872-1")).toBe(true);
    expect(isValidEan13("978 0140 328721")).toBe(true);
    expect(normalizeEan13("978-0-14-032872-1")).toBe("9780140328721");
  });

  it("rejects a wrong check digit", () => {
    // 9780140328721 is valid; flip the last digit.
    expect(isValidEan13("9780140328722")).toBe(false);
    expect(normalizeEan13("9780140328722")).toBeUndefined();
  });

  it("rejects wrong-length input", () => {
    expect(isValidEan13("")).toBe(false);
    expect(isValidEan13("978014032872")).toBe(false); // 12 digits
    expect(isValidEan13("97801403287211")).toBe(false); // 14 digits
    expect(normalizeEan13("978014032872")).toBeUndefined();
  });

  it("rejects non-numeric junk", () => {
    expect(isValidEan13("abcdefghijklm")).toBe(false);
    expect(isValidEan13("978014032872X")).toBe(false);
  });
});
