/**
 * `ocrs` engine adapter — Robert Knight's Rust OCR CLI.
 * https://github.com/robertknight/ocrs
 *
 * We invoke it in its default mode, which writes the recognised text to
 * stdout, one text line per output line. (The `--json` mode exposes word/line
 * geometry, which we don't need — extraction works off plain lines.) On first
 * run the CLI downloads its models to `~/.cache/ocrs`; subsequent runs are
 * fast. Latin-script only, which covers the NL/EN book covers in scope.
 */
import { config } from "@/lib/config";
import type { OcrEngine, OcrResult } from "../engine";
import { runSubprocess } from "../subprocess";

export const ocrsEngine: OcrEngine = {
  id: "ocrs",
  async recognize(imagePath: string): Promise<OcrResult> {
    const { stdout } = await runSubprocess(config.OCRS_BIN, {
      args: [imagePath],
      timeoutMs: config.OCR_TIMEOUT_MS,
    });
    const lines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return { lines, text: lines.join("\n") };
  },
};
