/**
 * `ocrs` engine adapter — Robert Knight's Rust OCR CLI.
 * https://github.com/robertknight/ocrs
 *
 * We invoke it in `--json` mode, which emits the recognised text together with
 * per-line polygon geometry (`vertices`). The plain text is used as before; the
 * geometry feeds the size/position title heuristic (spec v2 US-D5). On first
 * run the CLI downloads its models to `~/.cache/ocrs`; subsequent runs are
 * fast. Latin-script only, which covers the NL/EN book covers in scope.
 *
 * JSON shape (only the parts we consume):
 *   { "paragraphs": [ { "lines": [ { "text": "...",
 *       "vertices": [[x,y],[x,y],[x,y],[x,y]] }, ... ] }, ... ] }
 *
 * If `--json` output can't be parsed we fall back to treating stdout as plain
 * lines, so a CLI version change never breaks recognition outright.
 */
import { config } from "@/lib/config";
import { z } from "zod";
import type { OcrEngine, OcrLine, OcrResult } from "../engine";
import { boxFromVertices } from "../geometry";
import { runSubprocess } from "../subprocess";

const vertexSchema = z.tuple([z.number(), z.number()]);
const ocrsLineSchema = z.object({
  text: z.string(),
  vertices: z.array(vertexSchema).optional(),
});
const ocrsJsonSchema = z.object({
  paragraphs: z
    .array(z.object({ lines: z.array(ocrsLineSchema) }))
    .optional()
    .default([]),
});

function parsePlainLines(stdout: string): OcrResult {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return {
    lines,
    linesWithGeometry: lines.map((text) => ({ text })),
    text: lines.join("\n"),
  };
}

export const ocrsEngine: OcrEngine = {
  id: "ocrs",
  async recognize(imagePath: string): Promise<OcrResult> {
    const { stdout } = await runSubprocess(config.OCRS_BIN, {
      args: ["--json", imagePath],
      timeoutMs: config.OCR_TIMEOUT_MS,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // Older CLI or unexpected output — degrade to plain-line parsing.
      return parsePlainLines(stdout);
    }

    const result = ocrsJsonSchema.safeParse(parsed);
    if (!result.success) return parsePlainLines(stdout);

    const linesWithGeometry: OcrLine[] = [];
    for (const paragraph of result.data.paragraphs) {
      for (const line of paragraph.lines) {
        const text = line.text.trim();
        if (text.length === 0) continue;
        const box = line.vertices ? boxFromVertices(line.vertices) : undefined;
        linesWithGeometry.push(box ? { text, box } : { text });
      }
    }

    const lines = linesWithGeometry.map((l) => l.text);
    return { lines, linesWithGeometry, text: lines.join("\n") };
  },
};
