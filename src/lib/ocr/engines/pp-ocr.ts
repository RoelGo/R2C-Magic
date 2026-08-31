/**
 * PP-OCRv6 engine adapter — PaddlePaddle's PP-OCRv6 via a committed Python
 * script (`scripts/pp_ocr.py`). We shell out to `python3 scripts/pp_ocr.py
 * <image>` and read a single JSON object from stdout:
 *
 *   { "lines": ["Recognised line 1", "Recognised line 2", ...] }
 *
 * Keeping the model behind a script means the heavy PaddleOCR / ONNX runtime
 * stays out of the Node process and is installed once per environment
 * (documented in the README + Dockerfile). The adapter only cares about the
 * JSON contract, so the script's internals can evolve independently.
 */
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { z } from "zod";
import type { OcrEngine, OcrResult } from "../engine";
import { runSubprocess } from "../subprocess";

const scriptOutputSchema = z.object({
  lines: z.array(z.string()),
});

export const ppOcrEngine: OcrEngine = {
  id: "pp-ocrv6",
  async recognize(imagePath: string): Promise<OcrResult> {
    const args = [config.PP_OCR_SCRIPT, imagePath];
    if (config.PP_OCR_MODEL_DIR) {
      args.push("--model-dir", config.PP_OCR_MODEL_DIR);
    } else {
      args.push("--model-size", config.PP_OCR_MODEL_SIZE);
    }

    logger.debug(
      { python: config.PP_OCR_PYTHON, args, cwd: process.cwd(), timeoutMs: config.OCR_TIMEOUT_MS },
      "pp-ocrv6: invoking script",
    );

    const { stdout, stderr } = await runSubprocess(config.PP_OCR_PYTHON, {
      args,
      timeoutMs: config.OCR_TIMEOUT_MS,
    });

    if (stderr.trim().length > 0) {
      // PaddleOCR is chatty on stderr (progress, warnings); log at debug so it
      // is available when diagnosing but doesn't spam normal runs.
      logger.debug({ stderr: stderr.trim().slice(0, 2000) }, "pp-ocrv6: script stderr");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      logger.error(
        { stdoutPreview: stdout.slice(0, 500), stdoutLength: stdout.length },
        "pp-ocrv6: script did not return valid JSON",
      );
      throw new Error("PP-OCRv6 script did not return valid JSON");
    }

    const result = scriptOutputSchema.safeParse(parsed);
    if (!result.success) {
      logger.error({ parsed }, "pp-ocrv6: script JSON did not match expected shape");
      throw new Error("PP-OCRv6 script JSON did not match the expected shape");
    }

    const lines = result.data.lines.map((l) => l.trim()).filter((l) => l.length > 0);
    logger.debug({ lineCount: lines.length }, "pp-ocrv6: parsed recognised lines");
    return { lines, text: lines.join("\n") };
  },
};
