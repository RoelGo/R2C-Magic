/**
 * ISBN extraction from OCR text (spec v2 WI-3).
 *
 * Rokko pastes a Lightspeed item-barcode sticker over the book's ISBN barcode
 * during stock counts, so the barcode can no longer be scanned. The worker then
 * points the camera at the **printed** ISBN on the imprint page instead, and
 * this module turns the (noisy) OCR text into a storable EAN-13.
 *
 * Pure and I/O-free on purpose — the camera/OCR plumbing lives in
 * `isbn-ocr.ts`, all the fiddly parsing is here and unit-tested on fixture
 * strings (AGENTS.md: no live calls in tests).
 */
import { cleanEan, isValidEan13 } from "@/lib/intake/ean";

/**
 * A run of digits possibly broken by the separators printed ISBNs use
 * (hyphens, spaces) or that OCR inserts. Deliberately greedy: candidates are
 * validated by check digit afterwards, so over-matching is harmless.
 */
const CANDIDATE_RE = /\d[\d\u2010-\u2015\s-]{8,30}[\dXx]/g;

/** OCR frequently confuses these glyphs inside a digit run. */
const GLYPH_FIXES: Record<string, string> = {
  O: "0",
  o: "0",
  Q: "0",
  D: "0",
  I: "1",
  l: "1",
  "|": "1",
  S: "5",
  s: "5",
  B: "8",
  Z: "2",
  z: "2",
  G: "6",
  "—": "-",
  "–": "-",
  "‐": "-",
  "‑": "-",
  _: "-",
};

/**
 * Extract the first valid ISBN from free OCR text and return it as an EAN-13.
 *
 * Accepts ISBN-13 (`978`/`979`, hyphenated or spaced) and legacy ISBN-10
 * (converted to its `978` EAN-13 equivalent — most second-hand stock predates
 * ISBN-13). Candidates are only returned when the check digit verifies, so a
 * misread never yields a plausible-but-wrong EAN; the caller falls back to
 * manual entry.
 *
 * @returns a 13-digit EAN string, or `null` when nothing verifies.
 */
export function extractIsbnFromText(text: string): string | null {
  if (!text) return null;

  // Prefer the part of the text that follows an "ISBN" label — imprint pages
  // are busy and often carry other long numbers (NUR codes, print runs, years).
  for (const source of [afterIsbnLabel(text), text]) {
    const hit = firstValidIsbn(source);
    if (hit) return hit;
  }
  return null;
}

/**
 * The text following the first `ISBN` mention (label, optional `-10`/`-13`
 * suffix and separators), or `null` when the text is unlabelled.
 */
function afterIsbnLabel(text: string): string | null {
  const match = /IS[B8]N(?:\s*[-–—]?\s*1[03])?\s*:?\s*/i.exec(text);
  return match ? text.slice(match.index + match[0].length) : null;
}

function firstValidIsbn(text: string | null): string | null {
  if (!text) return null;
  for (const raw of text.matchAll(CANDIDATE_RE)) {
    const ean = toEan13(raw[0]);
    if (ean) return ean;
  }
  return null;
}

/**
 * Normalise one candidate run to a verified EAN-13. A run may be longer than
 * the ISBN itself (OCR glues neighbouring numbers together), so both ISBN-13
 * and ISBN-10 windows are tried across it.
 */
function toEan13(candidate: string): string | null {
  const compact = candidate.replace(/[\s\u2010-\u2015-]/g, "");

  // ISBN-13 window: any 13-digit slice that validates.
  const digits = cleanEan(compact);
  for (let i = 0; i + 13 <= digits.length; i++) {
    const window = digits.slice(i, i + 13);
    if (isValidEan13(window)) return window;
  }

  // ISBN-10 window: 9 digits + check char (digit or X).
  const isbn10 = /\d{9}[\dXx]/g;
  for (const match of compact.matchAll(isbn10)) {
    const ean = isbn10ToEan13(match[0]);
    if (ean) return ean;
  }
  return null;
}

/**
 * Convert a 10-character ISBN to its EAN-13 form (`978` + first 9 digits + a
 * recomputed check digit), after verifying the ISBN-10 check character.
 * Returns `null` when the ISBN-10 check fails.
 */
export function isbn10ToEan13(isbn10: string): string | null {
  const chars = isbn10.replace(/[\s-]/g, "").toUpperCase();
  if (!/^\d{9}[\dX]$/.test(chars)) return null;

  // ISBN-10 check: sum of digit * (10 - position) must be a multiple of 11.
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const char = chars[i] as string;
    const value = char === "X" ? 10 : char.charCodeAt(0) - 48;
    sum += value * (10 - i);
  }
  if (sum % 11 !== 0) return null;

  const body = `978${chars.slice(0, 9)}`;
  const ean = body + ean13CheckDigit(body);
  return isValidEan13(ean) ? ean : null;
}

/** Check digit for the first 12 digits of an EAN-13 (weights 1,3,1,3,…). */
function ean13CheckDigit(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = first12.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return String((10 - (sum % 10)) % 10);
}

/**
 * Repair the glyphs OCR most often gets wrong (`O`→`0`, `l`→`1`, …) inside
 * digit-ish runs, without touching real words. Applied before extraction as a
 * second pass when the raw text yields nothing.
 */
export function repairOcrDigits(text: string): string {
  // Only rewrite a character when it sits next to a digit — "Boom Uitgevers"
  // must not become "800m", but "9O0-8-1234" should.
  return text.replace(/[A-Za-z|_—–‐‑]/g, (char, offset: number) => {
    const prev = text[offset - 1] ?? "";
    const next = text[offset + 1] ?? "";
    const nearDigit = /\d/.test(prev) || /\d/.test(next);
    return nearDigit ? (GLYPH_FIXES[char] ?? char) : char;
  });
}

/**
 * Convenience wrapper: try the raw OCR text first, then a glyph-repaired pass.
 * This is what the camera UI calls.
 */
export function extractIsbnFromOcrText(text: string): string | null {
  return extractIsbnFromText(text) ?? extractIsbnFromText(repairOcrDigits(text));
}
