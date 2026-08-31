/**
 * OCR engine registry. Resolves the configured engine (`OCR_ENGINE`) to its
 * adapter, or `undefined` when OCR is disabled (`OCR_ENABLED=false` or
 * `OCR_ENGINE=none`) so the orchestrator can degrade to "no OCR" (US-G2).
 */
import { config } from "@/lib/config";
import type { OcrEngine, OcrEngineId } from "./engine";
import { ocrsEngine } from "./engines/ocrs";
import { ppOcrEngine } from "./engines/pp-ocr";

const ENGINES: Record<OcrEngineId, OcrEngine> = {
  ocrs: ocrsEngine,
  "pp-ocrv6": ppOcrEngine,
};

/** The engine selected by config, or `undefined` when OCR is off. */
export function activeOcrEngine(): OcrEngine | undefined {
  if (!config.OCR_ENABLED || config.OCR_ENGINE === "none") return undefined;
  return ENGINES[config.OCR_ENGINE];
}

/** Look up a specific engine by id (used by the integration benchmark). */
export function getOcrEngine(id: OcrEngineId): OcrEngine {
  return ENGINES[id];
}
