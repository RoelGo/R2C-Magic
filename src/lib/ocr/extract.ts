/**
 * Pure OCR text → structured suggestion extraction (spec v2 US-D3/D4, US-D5).
 *
 * The engine adapters return recognised lines — plain text plus, when the
 * engine exposes it, a per-line bounding box. This module turns them into a
 * title (+ optional author) from a front cover and a description from a back
 * cover, with light cleanup. It is deliberately free of I/O so it can be
 * unit-tested exhaustively without any engine, binary, or model. The worker
 * always edits freely afterwards, so we favour a reasonable guess over
 * cleverness.
 *
 * US-D5 replaces the old "first substantial line is the title" rule, which
 * misfired whenever the author was printed above the title. When geometry is
 * present we pick the title by **text size** (the tallest line is almost always
 * the title on a cover) rather than reading order, recognise author credits
 * beyond the `by/door/van` prefixes, and — when online enrichment already knows
 * the title/author (Slice C) — use that to disambiguate or override. The plain
 * reading-order path is kept as a fallback when no geometry is available.
 */
import type { OcrLine } from "./engine";

/** Collapse internal whitespace and trim a single line. */
function collapse(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/**
 * Drop lines that are almost certainly not title/description content: empty
 * lines, pure punctuation/symbols, and lines with no letters (e.g. stray
 * barcodes, prices, ISBNs). Keeps anything with at least two letters.
 */
function isNoise(line: string): boolean {
  const letters = (line.match(/\p{L}/gu) ?? []).length;
  return letters < 2;
}

/** Normalise and de-noise a set of raw OCR lines. */
export function cleanLines(rawLines: string[]): string[] {
  return rawLines.map(collapse).filter((l) => l.length > 0 && !isNoise(l));
}

/** Clean a set of geometry-carrying lines, preserving their boxes. */
function cleanGeometryLines(lines: OcrLine[]): OcrLine[] {
  const cleaned: OcrLine[] = [];
  for (const line of lines) {
    const text = collapse(line.text);
    if (text.length === 0 || isNoise(text)) continue;
    cleaned.push(line.box ? { text, box: line.box } : { text });
  }
  return cleaned;
}

/** Explicit author-credit prefixes ("by X", "door X", "van X"). */
const AUTHOR_PREFIX = /^(by|door|van|met|written by|door\/by)\s+/i;

/** Strip a leading author-credit prefix, if present. */
function stripAuthorPrefix(line: string): string {
  return line.replace(AUTHOR_PREFIX, "").trim();
}

/** Heuristic: does this line carry an explicit author-credit prefix? */
function hasAuthorPrefix(line: string): boolean {
  return AUTHOR_PREFIX.test(line);
}

/**
 * Heuristic: does this line *look like* a bare author credit — one or more
 * capitalised personal names, optionally joined by "&"/"and"/"en"/","? Used to
 * spot an author line printed without a "by" prefix (common on covers). We keep
 * it conservative: 1–4 name tokens per author, each starting uppercase, so
 * ordinary title words don't get mistaken for a name.
 */
function looksLikeBareAuthor(line: string): boolean {
  const cleaned = stripAuthorPrefix(line);
  // Split on author separators.
  const parts = cleaned.split(/\s*(?:&|,|\ben\b|\band\b|\bmet\b)\s*/i).filter(Boolean);
  if (parts.length === 0 || parts.length > 3) return false;
  return parts.every((part) => {
    const tokens = part.trim().split(/\s+/);
    if (tokens.length < 1 || tokens.length > 4) return false;
    // Each token starts with an uppercase letter (allow lowercase particles
    // like "de"/"van"/"von" between names).
    return tokens.every((t, i) => {
      if (i > 0 && /^(de|van|von|der|den|del|di|la|le|el)$/i.test(t)) return true;
      return /^\p{Lu}[\p{L}'.-]*$/u.test(t);
    });
  });
}

/** Normalise text for loose comparison against a catalog value. */
function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Do two strings refer to (roughly) the same thing? Used to align OCR lines
 * with the catalog title/author. Matches on full normalised equality or one
 * being a prefix of the other (covers OCR truncation / catalog subtitle).
 */
function looseMatch(a: string, b: string): boolean {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (na.length === 0 || nb.length === 0) return false;
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
}

export interface FrontCoverExtraction {
  title?: string;
  author?: string;
}

/**
 * A catalog hint from online enrichment (Slice C). Used to disambiguate which
 * OCR line is the title, or to override a poor OCR guess (US-D5).
 */
export interface CatalogHint {
  title?: string;
  author?: string;
}

/** The box height of a line, or 0 when geometry is absent. */
function lineHeight(line: OcrLine): number {
  return line.box?.height ?? 0;
}

/**
 * Reading-order fallback (the original US-D3 behaviour), used when no geometry
 * is available. First substantial line is the title; an author-credit line is
 * surfaced separately.
 */
function extractByReadingOrder(lines: OcrLine[], hint?: CatalogHint): FrontCoverExtraction {
  let title: string | undefined;
  let author: string | undefined;

  for (const { text } of lines) {
    if (!author && (hasAuthorPrefix(text) || (title && looksLikeBareAuthor(text)))) {
      author = stripAuthorPrefix(text) || undefined;
      continue;
    }
    if (!title) title = text;
    if (title && author) break;
  }

  return applyHint({ title, author }, lines, hint);
}

/**
 * Size-based extraction (US-D5): when geometry is present, the title is the
 * tallest text on the cover, regardless of reading order. Lines close in height
 * to the tallest and vertically adjacent are merged (multi-line titles). Author
 * is taken from an explicit credit line, a bare-name line, or otherwise the
 * next-largest non-title text.
 */
function extractBySize(lines: OcrLine[], hint?: CatalogHint): FrontCoverExtraction {
  const maxHeight = Math.max(...lines.map(lineHeight));

  // Lines within 25% of the tallest are considered "title-sized".
  const titleThreshold = maxHeight * 0.75;
  const titleLines = lines.filter((l) => lineHeight(l) >= titleThreshold);

  // Merge title-sized lines in their reading order (they arrive top-to-bottom).
  const title = titleLines.map((l) => l.text).join(" ") || undefined;

  // Author: prefer an explicit-prefix or bare-name line that isn't part of the
  // title; fall back to the largest remaining line.
  let author: string | undefined;
  const nonTitle = lines.filter((l) => !titleLines.includes(l));

  const credit = nonTitle.find((l) => hasAuthorPrefix(l.text) || looksLikeBareAuthor(l.text));
  if (credit) {
    author = stripAuthorPrefix(credit.text) || undefined;
  } else {
    // Also consider a title-sized line that reads like a bare author (author
    // printed as large as the title) — but only if there is more than one
    // title-sized line, so we don't strip the sole title.
    const bareInTitle =
      titleLines.length > 1 ? titleLines.find((l) => looksLikeBareAuthor(l.text)) : undefined;
    if (bareInTitle) {
      author = stripAuthorPrefix(bareInTitle.text) || undefined;
      const remaining = titleLines.filter((l) => l !== bareInTitle);
      return applyHint(
        { title: remaining.map((l) => l.text).join(" ") || undefined, author },
        lines,
        hint,
      );
    }
  }

  return applyHint({ title, author }, lines, hint);
}

/**
 * Cross-check an OCR extraction against the online catalog (US-D5). When the
 * catalog knows the title/author we prefer it, but keep OCR when the catalog is
 * silent. We also use the catalog author to avoid returning the author as the
 * title: if the OCR "title" matches the catalog author, swap it out.
 */
function applyHint(
  extraction: FrontCoverExtraction,
  lines: OcrLine[],
  hint?: CatalogHint,
): FrontCoverExtraction {
  let { title, author } = extraction;

  if (hint?.author) {
    // If OCR captured the author as the title, drop it and let the catalog
    // author fill in; try to recover the real title from another line.
    if (title && looseMatch(title, hint.author)) {
      const replacement = lines.find((l) => !looseMatch(l.text, hint.author ?? ""));
      title = replacement?.text;
    }
    author = author ?? hint.author;
  }

  if (hint?.title) {
    // Prefer an OCR line that matches the catalog title (keeps OCR's exact
    // casing/diacritics when they agree); otherwise adopt the catalog title.
    const matching = lines.find((l) => looseMatch(l.text, hint.title ?? ""));
    title = matching?.text ?? hint.title;
  }

  return {
    title: title?.trim() || undefined,
    author: author?.trim() || undefined,
  };
}

/**
 * Extract a title (and optional author) from front-cover OCR lines.
 *
 * Accepts either plain strings (legacy / no-geometry engines) or
 * geometry-carrying `OcrLine`s. With geometry we pick the title by text size
 * (US-D5); without it we fall back to reading order. An optional `hint` from
 * online enrichment disambiguates or overrides the OCR guess.
 */
export function extractFrontCover(
  raw: string[] | OcrLine[],
  hint?: CatalogHint,
): FrontCoverExtraction {
  const asLines: OcrLine[] =
    raw.length > 0 && typeof raw[0] === "string"
      ? (raw as string[]).map((text) => ({ text }))
      : (raw as OcrLine[]);

  const lines = cleanGeometryLines(asLines);
  if (lines.length === 0) {
    // Nothing usable from OCR, but the catalog may still provide values.
    return applyHint({}, lines, hint);
  }

  const hasGeometry = lines.some((l) => (l.box?.height ?? 0) > 0);
  return hasGeometry ? extractBySize(lines, hint) : extractByReadingOrder(lines, hint);
}

/**
 * Extract a description from back-cover OCR lines: the blurb is typically the
 * bulk of the readable text, so we join the cleaned lines into a paragraph.
 * Adjacent short fragments are merged; the worker refines in the review form.
 */
export function extractBackCover(rawLines: string[]): string | undefined {
  const lines = cleanLines(rawLines);
  if (lines.length === 0) return undefined;
  const description = lines.join(" ").replace(/\s+/g, " ").trim();
  return description.length > 0 ? description : undefined;
}
