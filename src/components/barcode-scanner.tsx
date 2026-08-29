"use client";

import { BrowserMultiFormatReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { useEffect, useRef, useState } from "react";

interface BarcodeScannerProps {
  /** Called with the raw scanned digits once a barcode is read. */
  onDetected: (rawValue: string) => void;
  /** Called when the worker closes the scanner without a result. */
  onCancel: () => void;
}

type ScannerState = "starting" | "scanning" | "error";

/**
 * Live camera barcode scanner (spec v2 US-B1). Prefers the native
 * `BarcodeDetector` API (fast, no decode work on the main thread); falls back
 * to `@zxing/browser` where it is unavailable (e.g. desktop Firefox, older
 * iOS). Recognises EAN-13 / EAN-8 / UPC. Requires an HTTPS origin for camera
 * access — see docs/deployment note.
 *
 * The component owns the camera stream lifecycle and always releases it on
 * unmount / after a successful read.
 */
export function BarcodeScanner({ onDetected, onCancel }: BarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<ScannerState>("starting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let rafId: number | null = null;
    let zxingControls: { stop: () => void } | null = null;
    let cancelled = false;
    // Guard so a late async detection after unmount/success is ignored.
    let done = false;

    function finish(rawValue: string) {
      if (done) return;
      done = true;
      onDetected(rawValue);
    }

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
        if (cancelled || done) return;
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
          if (result && !done) {
            finish(result.getText());
          }
        })
        .then((controls) => {
          if (cancelled || done) {
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
      done = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      zxingControls?.stop();
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
  }, [onDetected]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="relative flex-1 overflow-hidden">
        <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
        {/* Scanning overlay: a centred reticle to aim at the barcode. */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-28 w-72 max-w-[80%] rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]" />
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
          <p className="absolute inset-x-0 bottom-24 text-center text-sm text-white/90">
            Point the camera at the barcode
          </p>
        )}
      </div>

      <div className="p-4">
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
