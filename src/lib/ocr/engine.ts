/**
 * OCR engine abstraction (spec v2 US-D3/D4).
 *
 * Both supported engines run as subprocesses behind this one interface so they
 * are swappable by config (`OCR_ENGINE`) and benchmarkable against each other:
 *
 *  - `ocrs`     — Robert Knight's Rust OCR CLI (https://github.com/robertknight/ocrs)
 *  - `pp-ocrv6` — PaddlePaddle PP-OCRv6 via a committed Python script
 *
 * An engine's only job is image → recognised text lines. All title/author/
 * description extraction and cleanup lives in the pure `extract.ts` module, so
 * this layer stays a thin, testable process boundary.
 */
export type OcrEngineId = "ocrs" | "pp-ocrv6";

/**
 * Axis-aligned bounding box of a recognised text line, in source-image pixels.
 * Derived from the engine's per-line polygon. Optional across the contract:
 * an engine that only knows plain text omits it, and extraction (`extract.ts`)
 * falls back to reading order when boxes are absent (spec v2 US-D5).
 */
export interface OcrBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A single recognised line, optionally carrying its geometry. */
export interface OcrLine {
  text: string;
  /** Bounding box in image pixels, when the engine exposes geometry. */
  box?: OcrBox;
}

export interface OcrResult {
  /** Recognised text as ordered lines (top-to-bottom, best effort). */
  lines: string[];
  /**
   * The same recognised lines with optional per-line geometry, in the same
   * order as `lines`. Present when the engine emits bounding boxes; used by the
   * size/position title heuristic (US-D5). When present it is the same length
   * as `lines`. Optional so a minimal engine (or a test stub) can return just
   * `lines`; callers fall back to plain reading order in that case.
   */
  linesWithGeometry?: OcrLine[];
  /** Convenience join of `lines` with newlines. */
  text: string;
}

export interface OcrEngine {
  readonly id: OcrEngineId;
  /**
   * Recognise text in the image at `imagePath`. Must reject (throw) on a real
   * failure — a missing binary, a non-zero exit, a timeout, or unparseable
   * output — so the orchestrator can record it and fall back. Returning empty
   * `lines` is a valid "nothing found" result, not an error.
   */
  recognize(imagePath: string): Promise<OcrResult>;
}
