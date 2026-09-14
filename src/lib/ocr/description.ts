/**
 * Pick the blurb region out of a back-cover layout (spec v2 US-D7).
 *
 * `detectLayout` already segments a back cover into regions with boxes, labels
 * and grouped text. Reviewing the committed snapshots
 * (`tests/integration/layout-*.json`) shows a simple, reviewable rule works:
 *
 *  - the main blurb is a **wide** region spanning the cover's text column,
 *  - press-quote endorsements sit in a **narrow side column**,
 *  - ISBN / price / URL / imprint blocks carry distinct labels (`footer`,
 *    `header`) or obvious metadata patterns.
 *
 * So: keep prose-ish regions, drop structural and metadata ones, and take the
 * **widest** remaining region (ties broken by area, then text length). This is
 * a pure function over a `LayoutResult` so it is unit-testable against those
 * snapshots without running a model.
 *
 * The caller keeps the line-join extraction (`extractBackCover`) as the
 * fallback whenever this returns `undefined` — OCR never blocks (US-D4).
 */
import type { LayoutRegion, LayoutResult } from "./layout";

/** Layout labels that are structurally never the blurb. */
const EXCLUDED_LABELS = new Set(["header", "footer", "doc_title", "paragraph_title", "image"]);

/** Lines that are metadata, not prose: ISBN, price, URL, shouted imprint. */
const METADATA = [
  /\bISBN(?:-1[03])?\b/i,
  /\b(?:€|EUR|\$|USD|£|GBP)\s?\d/i,
  /\d+[.,]\d{2}\s*(?:€|EUR|\$|USD)\b/i,
  /\bwww\.\S+|\bhttps?:\/\/\S+/i,
  /\b(?:uitgeverij|publishers?|publishing|press|verlag)\b/i,
];

/** Minimum prose length (letters) before a region is credible as a blurb. */
const MIN_PROSE_LETTERS = 80;

function letterCount(text: string): number {
  return (text.match(/\p{L}/gu) ?? []).length;
}

/** Is the region metadata/boilerplate rather than blurb prose? */
function isMetadataRegion(region: LayoutRegion): boolean {
  return METADATA.some((re) => re.test(region.text));
}

/** Is this region a plausible blurb candidate at all? */
function isCandidate(region: LayoutRegion): boolean {
  if (EXCLUDED_LABELS.has(region.label)) return false;
  if (letterCount(region.text) < MIN_PROSE_LETTERS) return false;
  return !isMetadataRegion(region);
}

/**
 * How close to the widest candidate a region must be to count as "full width".
 * Back covers often split the blurb into several stacked paragraphs of roughly
 * equal width, with an author bio as the last one; picking the *topmost* of the
 * full-width regions lands on the blurb rather than on the bio.
 */
const FULL_WIDTH_RATIO = 0.8;

/**
 * Choose the region most likely to hold the blurb, or `undefined` when no
 * region qualifies (so the caller falls back to the line-join extraction).
 *
 * Among the candidates we keep those as wide as (or nearly as wide as) the
 * widest one — the cover's main text column, as opposed to the narrow
 * side-column press quotes — and take the topmost, which is where the blurb
 * starts. Ties break on width, then area, then text length.
 */
export function selectDescriptionRegion(result: LayoutResult): LayoutRegion | undefined {
  const candidates = result.regions.filter(isCandidate);
  if (candidates.length === 0) return undefined;

  const maxWidth = Math.max(...candidates.map((r) => r.box.width));
  const fullWidth = candidates.filter((r) => r.box.width >= maxWidth * FULL_WIDTH_RATIO);

  return fullWidth.reduce((best, region) => {
    if (region.box.y !== best.box.y) return region.box.y < best.box.y ? region : best;
    if (region.box.width !== best.box.width) {
      return region.box.width > best.box.width ? region : best;
    }
    const area = region.box.width * region.box.height;
    const bestArea = best.box.width * best.box.height;
    if (area !== bestArea) return area > bestArea ? region : best;
    return region.text.length > best.text.length ? region : best;
  });
}

/** The selected region's text as a description, or `undefined` if none fits. */
export function describeFromLayout(result: LayoutResult): string | undefined {
  const region = selectDescriptionRegion(result);
  const text = region?.text.replace(/\s+/g, " ").trim();
  return text && text.length > 0 ? text : undefined;
}

/**
 * All recognised lines of a layout result in reading order (top-to-bottom),
 * including lines that fell outside every region. Lets the caller reuse the
 * layout pass's OCR for the `extractBackCover` fallback instead of paying for a
 * second recognition pass.
 */
export function layoutLines(result: LayoutResult): string[] {
  const lines = [...result.regions.flatMap((r) => r.lines), ...result.unassignedLines];
  return lines.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x).map((l) => l.text);
}
