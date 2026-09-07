/**
 * Layout-aware OCR for back-cover description detection (spec v2 US-D6, R&D).
 *
 * PaddleOCR ships a document **layout detection** model (PP-DocLayout) that
 * segments an image into regions (paragraphs, titles, etc.) with bounding boxes
 * and labels. On book covers the labels are coarse (mostly generic `text`), but
 * the region **boxes** still group the loose OCR lines into paragraphs — which
 * is exactly the signal we need to isolate the main blurb from press quotes,
 * bios, and metadata.
 *
 * This module runs a committed Python script (`scripts/pp_layout.py`) that does
 * layout detection + text recognition, assigns each recognised line to the
 * region whose box contains it, and returns the regions (with their joined
 * text) plus any lines that fell outside every region. We keep the heavy model
 * behind a subprocess for the same reasons as the OCR engine, and this layer
 * only validates + shapes the JSON contract.
 *
 * For now this is exploratory: the integration test snapshots the output on
 * sample back covers so we can pick a description-selection heuristic. It is not
 * yet wired into the intake flow.
 */
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { z } from "zod";
import type { OcrBox } from "./engine";
import { runSubprocess } from "./subprocess";

/** A recognised text line with its bounding box, in source-image pixels. */
export interface LayoutTextLine {
  text: string;
  box: OcrBox;
}

/** A layout region: its detected class, confidence, box, and grouped text. */
export interface LayoutRegion {
  /** Layout class from the model (e.g. `text`, `paragraph_title`, `image`). */
  label: string;
  /** Detection confidence in [0, 1]. */
  score: number;
  /** Region bounding box in source-image pixels. */
  box: OcrBox;
  /** Recognised lines assigned to this region, in reading order. */
  lines: LayoutTextLine[];
  /** Convenience join of this region's line texts with spaces. */
  text: string;
}

/** Full layout-detection result for one image. */
export interface LayoutResult {
  /** Source image dimensions in pixels. */
  imageWidth: number;
  imageHeight: number;
  /** Detected regions, ordered top-to-bottom then left-to-right. */
  regions: LayoutRegion[];
  /** Recognised lines that fell outside every detected region. */
  unassignedLines: LayoutTextLine[];
}

const boxTupleSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const lineSchema = z.object({ text: z.string(), box: boxTupleSchema });
const scriptOutputSchema = z.object({
  image_width: z.number(),
  image_height: z.number(),
  regions: z.array(
    z.object({
      label: z.string(),
      score: z.number(),
      box: boxTupleSchema,
      lines: z.array(lineSchema),
    }),
  ),
  unassigned_lines: z.array(lineSchema),
});

function toBox([x, y, width, height]: [number, number, number, number]): OcrBox {
  return { x, y, width, height };
}

function toTextLine(raw: z.infer<typeof lineSchema>): LayoutTextLine {
  return { text: raw.text.trim(), box: toBox(raw.box) };
}

/**
 * Run layout detection + OCR on an image and return regions with grouped text.
 *
 * Throws on a real failure (missing runtime, non-zero exit, unparseable output)
 * so the caller can record it and fall back — the same contract as the OCR
 * engine. An image with no detected regions is a valid empty result, not an
 * error.
 */
export async function detectLayout(imagePath: string): Promise<LayoutResult> {
  const args = [config.PP_LAYOUT_SCRIPT, imagePath];
  if (config.PP_OCR_MODEL_DIR) {
    args.push("--model-dir", config.PP_OCR_MODEL_DIR);
  } else {
    args.push("--model-size", config.PP_OCR_MODEL_SIZE);
  }
  args.push("--layout-model", config.PP_LAYOUT_MODEL);

  logger.debug(
    { python: config.PP_OCR_PYTHON, args, timeoutMs: config.OCR_TIMEOUT_MS },
    "detectLayout: invoking script",
  );

  const { stdout, stderr } = await runSubprocess(config.PP_OCR_PYTHON, {
    args,
    timeoutMs: config.OCR_TIMEOUT_MS,
  });

  if (stderr.trim().length > 0) {
    logger.debug({ stderr: stderr.trim().slice(0, 2000) }, "detectLayout: script stderr");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    logger.error(
      { stdoutPreview: stdout.slice(0, 500), stdoutLength: stdout.length },
      "detectLayout: script did not return valid JSON",
    );
    throw new Error("Layout script did not return valid JSON");
  }

  const result = scriptOutputSchema.safeParse(parsed);
  if (!result.success) {
    logger.error({ issues: result.error.issues }, "detectLayout: JSON did not match schema");
    throw new Error("Layout script JSON did not match the expected shape");
  }

  const regions: LayoutRegion[] = result.data.regions.map((r) => {
    const lines = r.lines.map(toTextLine);
    return {
      label: r.label,
      score: r.score,
      box: toBox(r.box),
      lines,
      text: lines
        .map((l) => l.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    };
  });

  logger.debug(
    { regionCount: regions.length, unassigned: result.data.unassigned_lines.length },
    "detectLayout: parsed layout result",
  );

  return {
    imageWidth: result.data.image_width,
    imageHeight: result.data.image_height,
    regions,
    unassignedLines: result.data.unassigned_lines.map(toTextLine),
  };
}
