/**
 * Browser-side ISBN OCR (spec v2 WI-3) — **client only**.
 *
 * The existing OCR pipeline (`src/lib/ocr/*`) is a server-side Python
 * (PaddleOCR) subprocess and cannot run in the browser, so the printed-ISBN
 * fallback uses Tesseract.js (WASM). The engine is heavy (~2 MB of wasm + a
 * language pack, fetched from the CDN on first use and then cached by the
 * browser), so it is **lazily imported**: nothing here is pulled into the
 * bundle unless the worker actually switches the scanner into ISBN OCR mode.
 *
 * The worker is created once and reused for the lifetime of the page —
 * spinning one up per capture would cost several seconds each time.
 *
 * Parsing lives in `isbn-text.ts` (pure + unit-tested); this module only does
 * the frame-grab and the recognise call.
 */
import { extractIsbnFromOcrText } from "@/lib/intake/isbn-text";

/** What the recognizer accepts — a canvas, image, or blob of a still frame. */
export type IsbnOcrSource = HTMLCanvasElement | HTMLImageElement | Blob;

export interface IsbnOcrResult {
  /** The verified EAN-13, or `null` when no ISBN could be read. */
  ean: string | null;
  /** Raw recognised text, for debugging / showing "we read: …" to the worker. */
  text: string;
  /** Tesseract's mean confidence for the page (0–100). */
  confidence: number;
}

/** Minimal shape we use from the Tesseract worker (keeps `any` out). */
interface TesseractLikeWorker {
  recognize(image: IsbnOcrSource): Promise<{ data: { text: string; confidence: number } }>;
  setParameters(params: Record<string, string>): Promise<unknown>;
  terminate(): Promise<unknown>;
}

let workerPromise: Promise<TesseractLikeWorker> | null = null;

/**
 * Load Tesseract.js (dynamic `import()`) and start a single English worker.
 * Subsequent calls reuse the same promise. A failure clears the cache so the
 * next attempt can retry (e.g. after the CDN fetch failed on a flaky connection).
 */
function getWorker(): Promise<TesseractLikeWorker> {
  if (workerPromise) return workerPromise;

  workerPromise = (async () => {
    const { createWorker } = await import("tesseract.js");
    const worker = (await createWorker("eng")) as unknown as TesseractLikeWorker;
    // An imprint page is dense; restricting the charset to what an ISBN line
    // can contain measurably cuts misreads. `PSM 6` = a uniform block of text.
    await worker.setParameters({
      tessedit_char_whitelist: "0123456789ISBNisbn-–— :.Xx",
      tessedit_pageseg_mode: "6",
    });
    return worker;
  })().catch((err) => {
    workerPromise = null;
    throw err;
  });

  return workerPromise;
}

/**
 * Start loading the OCR engine without blocking on a result. Call this when the
 * worker switches into ISBN mode so the first capture is not stuck behind the
 * wasm download.
 */
export function warmUpIsbnOcr(): void {
  void getWorker().catch(() => {
    /* surfaced on the first real capture instead */
  });
}

/** Terminate the shared worker (on unmount) and free its memory. */
export async function disposeIsbnOcr(): Promise<void> {
  const pending = workerPromise;
  workerPromise = null;
  if (!pending) return;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    /* nothing to clean up */
  }
}

/**
 * Recognise a still frame and extract an ISBN from it.
 *
 * Never throws for a "no ISBN here" outcome — that is `{ ean: null }`, and the
 * caller keeps the camera open (or falls through to manual entry). Engine
 * load/recognition failures do throw, so the UI can show a real error.
 */
export async function recognizeIsbn(source: IsbnOcrSource): Promise<IsbnOcrResult> {
  const worker = await getWorker();
  const { data } = await worker.recognize(source);
  return {
    ean: extractIsbnFromOcrText(data.text),
    text: data.text,
    confidence: data.confidence,
  };
}

/**
 * Grab the region of the video inside the on-screen framing guide as a canvas.
 *
 * Cropping to the guide is what makes this usable on a busy imprint page: the
 * worker aligns the printed ISBN line in the box and everything else (titles,
 * colophon, NUR codes) is excluded before OCR ever sees it. The crop is then
 * upscaled, because Tesseract is markedly more accurate on larger glyphs.
 *
 * @param guide fractions of the video frame (0–1) describing the guide box.
 */
export function captureGuideFrame(
  video: HTMLVideoElement,
  guide: { widthRatio: number; heightRatio: number },
  scale = 2,
): HTMLCanvasElement | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const cropW = Math.round(vw * guide.widthRatio);
  const cropH = Math.round(vh * guide.heightRatio);
  const cropX = Math.round((vw - cropW) / 2);
  const cropY = Math.round((vh - cropH) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = cropW * scale;
  canvas.height = cropH * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
  toGrayscaleWithContrast(ctx, canvas.width, canvas.height);
  return canvas;
}

/**
 * Flatten the crop to high-contrast greyscale in place. Phone camera frames of
 * a paper page are low-contrast and slightly warm; this is a cheap, meaningful
 * accuracy win before the WASM engine runs.
 */
function toGrayscaleWithContrast(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;
  for (let i = 0; i < px.length; i += 4) {
    const luma =
      0.299 * (px[i] as number) + 0.587 * (px[i + 1] as number) + 0.114 * (px[i + 2] as number);
    // Stretch around mid-grey so print goes black and paper goes white.
    const boosted = Math.max(0, Math.min(255, (luma - 128) * 1.6 + 128));
    px[i] = boosted;
    px[i + 1] = boosted;
    px[i + 2] = boosted;
  }
  ctx.putImageData(image, 0, 0);
}
