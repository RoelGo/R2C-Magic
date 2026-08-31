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

export interface OcrResult {
  /** Recognised text as ordered lines (top-to-bottom, best effort). */
  lines: string[];
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
