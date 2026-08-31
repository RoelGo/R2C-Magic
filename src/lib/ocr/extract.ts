/**
 * Pure OCR text → structured suggestion extraction (spec v2 US-D3/D4).
 *
 * The engine adapters return raw recognised lines; this module turns them into
 * a title (+ optional author) from a front cover and a description from a back
 * cover, with light cleanup (whitespace collapse, obvious-noise removal). It is
 * deliberately free of I/O so it can be unit-tested exhaustively without any
 * engine, binary, or model. The worker always edits freely afterwards, so we
 * favour a reasonable guess over cleverness.
 */

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

/** Heuristic: does this line look like an author credit ("by X", "X Y")? */
function looksLikeAuthor(line: string): boolean {
  return /^(by|door|van)\s+/i.test(line);
}

export interface FrontCoverExtraction {
  title?: string;
  author?: string;
}

/**
 * Extract a title (and optional author) from front-cover OCR lines.
 *
 * Covers put the title prominently near the top, so we take the first
 * substantial cleaned line as the title. If a nearby line reads like an author
 * credit ("by …", "door …"), we surface it separately and strip the prefix.
 */
export function extractFrontCover(rawLines: string[]): FrontCoverExtraction {
  const lines = cleanLines(rawLines);
  if (lines.length === 0) return {};

  let title: string | undefined;
  let author: string | undefined;

  for (const line of lines) {
    if (!author && looksLikeAuthor(line)) {
      author = line.replace(/^(by|door|van)\s+/i, "").trim() || undefined;
      continue;
    }
    if (!title) {
      title = line;
    }
    if (title && author) break;
  }

  return { title, author };
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
