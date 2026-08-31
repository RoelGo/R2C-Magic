import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OcrEngineId } from "../../src/lib/ocr/engine";
import { getOcrEngine } from "../../src/lib/ocr/index";

/**
 * Engine integration tests (opt-in: `pnpm test:lib:integration`).
 *
 * These exercise the REAL OCR engines against a sample cover image to validate
 * the subprocess wiring — binary discovery, argument passing, output parsing —
 * end to end. They are intentionally excluded from the default unit run
 * because they need the engines installed and are slow (model load).
 *
 * Each engine's block is skipped unless BOTH are true:
 *   1. a sample image exists at tests/integration/__fixtures__/cover.jpg
 *      (drop in any book cover photo with legible text), and
 *   2. the engine's runtime is available on this machine.
 *
 * The assertion is deliberately loose (we get *some* text back) so the test
 * validates connectivity without pinning exact recognition output, which
 * varies by engine and model version.
 */
const FIXTURE = join(import.meta.dirname, "__fixtures__", "cover.jpg");
const hasFixture = existsSync(FIXTURE);

function commandAvailable(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch (err) {
    // A non-zero exit for `--version`/`--help` still proves the binary exists;
    // only ENOENT (not installed) should skip.
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ENOENT";
  }
}

// Honour the same env the engine adapters use, so a virtualenv Python
// (PP_OCR_PYTHON=.venv-ocr/bin/python) is detected rather than the system one.
const ppPython = process.env.PP_OCR_PYTHON ?? "python3";
const ocrsBin = process.env.OCRS_BIN ?? "ocrs";

const ocrsAvailable = commandAvailable(ocrsBin, ["--help"]);
const ppAvailable =
  commandAvailable(ppPython, ["-c", "import paddleocr"]) &&
  existsSync(join(process.cwd(), "scripts", "pp_ocr.py"));

async function expectSomeText(id: OcrEngineId) {
  const engine = getOcrEngine(id);
  const result = await engine.recognize(FIXTURE);
  // Connectivity check: the pipeline ran and returned a well-formed result.
  expect(Array.isArray(result.lines)).toBe(true);
  await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot(`ocr-result-${id}.json`);
  expect(result.text.length).toBeGreaterThan(0);
}

describe.skipIf(!hasFixture || !ocrsAvailable)("ocr integration — ocrs", () => {
  it("reads text from the sample cover", async () => {
    await expectSomeText("ocrs");
  });
});

describe.skipIf(!hasFixture || !ppAvailable)("ocr integration — pp-ocrv6", () => {
  it("reads text from the sample cover", async () => {
    await expectSomeText("pp-ocrv6");
  });
});

// Guarantee the integration project always has at least one executed test, so
// `vitest run --project integration` doesn't exit non-zero on "no tests" when
// the engines/fixture are absent in CI.
describe("ocr integration — availability report", () => {
  it("reports which engines/fixtures are present", () => {
    // Not an assertion on the environment; just surfaces the skip reasons.
    expect(typeof hasFixture).toBe("boolean");
    expect(typeof ocrsAvailable).toBe("boolean");
    expect(typeof ppAvailable).toBe("boolean");
  });
});
