import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectLayout } from "../../src/lib/ocr/layout";

/**
 * Layout-detection integration snapshots (opt-in: `pnpm test:lib:integration`).
 *
 * Exploratory for spec v2 US-D6: run PaddleOCR layout detection + OCR on sample
 * back covers and snapshot the region breakdown so we can design a
 * description-selection heuristic (which region is the blurb vs. press quotes,
 * bio, ISBN/price, publisher). Not yet wired into the intake flow.
 *
 * Skipped unless the PaddleOCR runtime is available and the script exists. Uses
 * `PP_LAYOUT_MODEL_SIZE`-equivalent config via the env the adapter reads.
 *
 * Snapshots are normalised (line boxes dropped, coordinates rounded) so they
 * stay readable and stable across minor model jitter; the region text + label
 * are what we care about for the heuristic.
 */
const FIXTURE_DIR = join(import.meta.dirname, "__fixtures__");
const IMAGES = ["back-with-blurbs.jpg", "back-with-a-lot-of-text.jpg", "cover.jpg"] as const;

const ppPython = process.env.PP_OCR_PYTHON ?? "python3";

function paddleAvailable(): boolean {
  if (!existsSync(join(process.cwd(), "scripts", "pp_layout.py"))) return false;
  try {
    execFileSync(ppPython, ["-c", "import paddleocr"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const available = paddleAvailable();

/** Round a number for stable snapshots (model boxes jitter by a few pixels). */
function round(n: number): number {
  return Math.round(n);
}

/** Reduce a full layout result to a compact, snapshot-friendly summary. */
function summarize(result: Awaited<ReturnType<typeof detectLayout>>) {
  return {
    imageWidth: result.imageWidth,
    imageHeight: result.imageHeight,
    regions: result.regions.map((r) => ({
      label: r.label,
      score: Number(r.score.toFixed(2)),
      box: [round(r.box.x), round(r.box.y), round(r.box.width), round(r.box.height)],
      lineCount: r.lines.length,
      text: r.text,
    })),
    unassignedLines: result.unassignedLines.map((l) => l.text),
  };
}

describe.skipIf(!available)("ocr layout detection — back-cover segmentation", () => {
  for (const image of IMAGES) {
    it(`segments ${image} into regions`, async () => {
      const result = await detectLayout(join(FIXTURE_DIR, image));
      const summary = summarize(result);
      await expect(JSON.stringify(summary, null, 2)).toMatchFileSnapshot(
        `layout-${image.replace(/\.jpg$/, "")}.json`,
      );
      // Sanity: we always get a well-formed result (regions may be empty).
      expect(Array.isArray(result.regions)).toBe(true);
    }, 120_000);
  }
});

describe("ocr layout detection — availability report", () => {
  it("reports whether the layout runtime is present", () => {
    expect(typeof available).toBe("boolean");
  });
});
