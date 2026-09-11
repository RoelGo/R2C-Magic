"use client";

import {
  captureGuideFrame,
  disposeIsbnOcr,
  recognizeIsbn,
  warmUpIsbnOcr,
} from "@/lib/intake/isbn-ocr";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { useCallback, useEffect, useRef, useState } from "react";

interface BarcodeScannerProps {
  /** Called with the raw scanned digits once a barcode (or ISBN) is read. */
  onDetected: (rawValue: string) => void;
  /** Called when the worker closes the scanner without a result. */
  onCancel: () => void;
}

type ScannerState = "starting" | "scanning" | "error";
type Mode = "barcode" | "isbn";

/**
 * Fraction of the video frame that the framing guide covers, per mode. The ISBN
 * guide is a wide, short strip because a printed ISBN is a single line.
 * (The preview is `object-cover`, so the on-screen box and the cropped region
 * are approximately — not exactly — the same area. The crop is the generous
 * one, which is what we want.)
 */
const GUIDES: Record<Mode, { widthRatio: number; heightRatio: number }> = {
  barcode: { widthRatio: 0.8, heightRatio: 0.3 },
  isbn: { widthRatio: 0.86, heightRatio: 0.18 },
};

/**
 * Live camera capture for a book's identifier (spec v2 US-B1 + WI-3).
 *
 * Two modes over one camera stream:
 *   - **barcode** (default): the native `BarcodeDetector` API where available
 *     (fast, off the main thread), falling back to `@zxing/browser`.
 *   - **ISBN OCR**: for stock-counted books whose ISBN barcode is covered by a
 *     Lightspeed item sticker. The worker frames the *printed* ISBN and taps
 *     capture; a lazily-loaded Tesseract.js (WASM) engine reads the still and
 *     `extractIsbnFromText` normalises it to an EAN-13.
 *
 * Both paths call the same `onDetected`, so validation and saving are identical
 * (`cleanEan` → `isValidEan13` → `setBookEanAction`), and an unreadable result
 * always falls through to manual entry rather than saving a guess.
 *
 * Barcode detection keeps running in ISBN mode: if the barcode happens to be
 * readable after all, it still wins automatically. Full "magic" auto-detect
 * (continuous OCR on every Nth frame in parallel with barcode scanning, WI-3
 * option B) is deliberately NOT enabled — continuous WASM OCR drops the camera
 * framerate badly on the low-end Android phones rokko uses, and an explicit
 * capture is more reliable on a busy imprint page. The pieces are all here
 * (`recognizeIsbn` + a running barcode loop) if we revisit it.
 *
 * The component owns the camera stream lifecycle and always releases it on
 * unmount / after a successful read.
 */
export function BarcodeScanner({ onDetected, onCancel }: BarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // Guard so a late async detection (barcode loop or OCR) after unmount or a
  // first successful read is ignored.
  const doneRef = useRef(false);
  const [state, setState] = useState<ScannerState>("starting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("barcode");
  const [reading, setReading] = useState(false);
  const [ocrHint, setOcrHint] = useState<string | null>(null);

  const finish = useCallback(
    (rawValue: string) => {
      if (doneRef.current) return;
      doneRef.current = true;
      onDetected(rawValue);
    },
    [onDetected],
  );

  useEffect(() => {
    let stream: MediaStream | null = null;
    let rafId: number | null = null;
    let zxingControls: { stop: () => void } | null = null;
    let cancelled = false;
    doneRef.current = false;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (cancelled) return;

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setState("scanning");

        const NativeDetector = window.BarcodeDetector;
        if (NativeDetector) {
          const supported = await NativeDetector.getSupportedFormats().catch((): string[] => []);
          const wanted = ["ean_13", "ean_8", "upc_a", "upc_e"].filter((f) => supported.includes(f));
          if (wanted.length > 0) {
            runNativeLoop(new NativeDetector({ formats: wanted }), video);
            return;
          }
        }
        runZxing(video);
      } catch (err) {
        if (cancelled) return;
        setState("error");
        setErrorMessage(cameraErrorMessage(err));
      }
    }

    function runNativeLoop(detector: BarcodeDetector, video: HTMLVideoElement) {
      const tick = async () => {
        if (cancelled || doneRef.current) return;
        try {
          const barcodes = await detector.detect(video);
          const hit = barcodes.find((b) => b.rawValue.length > 0);
          if (hit) {
            finish(hit.rawValue);
            return;
          }
        } catch {
          // Transient detect() failures (e.g. video not ready) are ignored;
          // the next frame retries.
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    }

    function runZxing(video: HTMLVideoElement) {
      const hints = new Map();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
      ]);
      const reader = new BrowserMultiFormatReader(hints);
      reader
        .decodeFromVideoElement(video, (result) => {
          if (result && !doneRef.current) {
            finish(result.getText());
          }
        })
        .then((controls) => {
          if (cancelled || doneRef.current) {
            controls.stop();
          } else {
            zxingControls = controls;
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setState("error");
            setErrorMessage(cameraErrorMessage(err));
          }
        });
    }

    start();

    return () => {
      cancelled = true;
      doneRef.current = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      zxingControls?.stop();
      for (const track of stream?.getTracks() ?? []) track.stop();
      void disposeIsbnOcr();
    };
  }, [finish]);

  /** Switch to printed-ISBN mode and start pulling the WASM engine down. */
  function enterIsbnMode() {
    setMode("isbn");
    setOcrHint(null);
    warmUpIsbnOcr();
  }

  /** Read the framed still and, if an ISBN verifies, hand it to `onDetected`. */
  async function captureIsbn() {
    const video = videoRef.current;
    if (!video || reading || doneRef.current) return;

    setReading(true);
    setOcrHint(null);
    try {
      const frame = captureGuideFrame(video, GUIDES.isbn);
      if (!frame) {
        setOcrHint("The camera is not ready yet — try again.");
        return;
      }
      const { ean } = await recognizeIsbn(frame);
      if (ean) {
        finish(ean);
        return;
      }
      setOcrHint("No ISBN found. Line the printed ISBN up inside the box, hold still, and retry.");
    } catch {
      setOcrHint("Could not run the text reader. Use “Enter manually” instead.");
    } finally {
      setReading(false);
    }
  }

  const guide = GUIDES[mode];

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="relative flex-1 overflow-hidden">
        <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
        {/* Framing guide: a barcode reticle, or a wide strip for the ISBN line. */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            className="rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
            style={{
              width: `${guide.widthRatio * 100}%`,
              height: `${guide.heightRatio * 100}%`,
              maxWidth: mode === "barcode" ? "18rem" : undefined,
              maxHeight: mode === "barcode" ? "7rem" : "6rem",
            }}
          />
        </div>

        {state !== "scanning" ? (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-white">
            {state === "starting" ? (
              <p>Starting camera…</p>
            ) : (
              <p className="max-w-xs">{errorMessage ?? "Could not access the camera."}</p>
            )}
          </div>
        ) : (
          <p className="absolute inset-x-0 bottom-28 px-6 text-center text-sm text-white/90">
            {mode === "barcode"
              ? "Point the camera at the barcode"
              : "Frame the printed ISBN (imprint page) and tap Read ISBN"}
          </p>
        )}

        {ocrHint ? (
          <p className="absolute inset-x-4 bottom-4 rounded-md bg-black/70 px-3 py-2 text-center text-sm text-amber-200">
            {ocrHint}
          </p>
        ) : null}
      </div>

      <div className="space-y-2 p-4">
        {state === "scanning" ? (
          mode === "barcode" ? (
            <button
              type="button"
              onClick={enterIsbnMode}
              className="w-full rounded-md bg-white/15 px-4 py-3 text-base font-semibold text-white backdrop-blur hover:bg-white/25"
            >
              Barcode covered? Scan printed ISBN
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={captureIsbn}
                disabled={reading}
                className="w-full rounded-md bg-blue-600 px-4 py-4 text-base font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {reading ? "Reading…" : "Read ISBN"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode("barcode");
                  setOcrHint(null);
                }}
                className="w-full rounded-md px-4 py-2 text-sm font-medium text-white/80 hover:text-white"
              >
                Back to barcode scanning
              </button>
            </>
          )
        ) : null}

        <button
          type="button"
          onClick={onCancel}
          className="w-full rounded-md bg-white/15 px-4 py-3 text-base font-semibold text-white backdrop-blur hover:bg-white/25"
        >
          {state === "error" ? "Enter manually instead" : "Cancel"}
        </button>
      </div>
    </div>
  );
}

function cameraErrorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") {
      return "Camera permission was denied. Allow camera access or enter the EAN manually.";
    }
    if (err.name === "NotFoundError") {
      return "No camera found on this device. Enter the EAN manually.";
    }
    if (err.name === "NotReadableError") {
      return "The camera is in use by another app. Close it and try again.";
    }
  }
  return "Camera unavailable. This screen needs HTTPS and camera permission.";
}
