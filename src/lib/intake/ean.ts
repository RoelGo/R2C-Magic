/**
 * EAN-13 / ISBN-13 validation for the v2 mobile intake (spec v2 US-B2).
 *
 * Both scanned (US-B1) and manually typed (US-B2) barcodes flow through here
 * before we accept them onto an intake book. Unlike v1's `normalizeEan`
 * (`src/lib/csv/r-series.ts`), which only checks for 13 digits, this validates
 * the EAN-13 **check digit** too so a mistyped ISBN is caught inline rather
 * than being pushed to the webshop.
 */

const EAN13_RE = /^\d{13}$/;

/**
 * Compute the EAN-13 check digit for the first 12 digits.
 * Weights alternate 1,3,1,3,… left to right; the check digit makes the
 * weighted sum a multiple of 10.
 */
function ean13CheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = first12.charCodeAt(i) - 48; // '0' === 48
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return (10 - (sum % 10)) % 10;
}

/** Strip everything but digits (hyphens/spaces are common in printed ISBNs). */
export function cleanEan(input: string): string {
  return input.replace(/\D/g, "");
}

/**
 * True when `input` is a structurally valid EAN-13 / ISBN-13: exactly 13
 * digits (after stripping separators) with a correct check digit.
 */
export function isValidEan13(input: string): boolean {
  const cleaned = cleanEan(input);
  if (!EAN13_RE.test(cleaned)) return false;
  return ean13CheckDigit(cleaned.slice(0, 12)) === cleaned.charCodeAt(12) - 48;
}

/**
 * Normalise an EAN-13 for storage: returns the 13-digit string if valid,
 * otherwise `undefined`. Use at boundaries (scan result, manual entry) before
 * persisting.
 */
export function normalizeEan13(input: string): string | undefined {
  const cleaned = cleanEan(input);
  return isValidEan13(cleaned) ? cleaned : undefined;
}
