"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface CameraCaptureProps {
  /** Human label for what to photograph, e.g. "front cover". */
  label: string;
  /** Called with the captured JPEG once the worker confirms it. */
  onCapture: (blob: Blob) => void;
  /** Called when the worker closes the camera without capturing. */
  onCancel: () => void;
}

type CameraState = "starting" | "live" | "preview" | "error";

const JPEG_QUALITY = 0.85;

/**
 * Fullscreen live-camera capture for a cover photo (spec v2 US-D1/US-D2).
 *
 * Mirrors the barcode scanner's camera lifecycle: opens the environment-facing
 * camera, lets the worker snap a still to a canvas, shows a preview with a
 * retake option, and hands back a JPEG `Blob` on confirm. The stream is always
 * released on unmount / after confirm. Requires HTTPS + camera permission.
 */
export function CameraCapture({ label, onCapture, onCancel }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<CameraState>("starting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const blobRef = useRef<Blob | null>(null);

  const setPreview = useCallback((url: string | null) => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = url;
    setPreviewUrl(url);
  }, []);

  const stopStream = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
  }, []);

  const startStream = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      setState("live");
    } catch (err) {
      setState("error");
      setErrorMessage(cameraErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    startStream();
    return () => {
      stopStream();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, [startStream, stopStream]);

  function snap() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        blobRef.current = blob;
        setPreview(URL.createObjectURL(blob));
        setState("preview");
        stopStream();
      },
      "image/jpeg",
      JPEG_QUALITY,
    );
  }

  function retake() {
    setPreview(null);
    blobRef.current = null;
    setState("starting");
    startStream();
  }

  function confirm() {
    if (blobRef.current) onCapture(blobRef.current);
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="relative flex-1 overflow-hidden">
        {state === "preview" && previewUrl ? (
          <img
            src={previewUrl}
            alt="Captured cover preview"
            className="h-full w-full object-contain"
          />
        ) : (
          <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
        )}
        <canvas ref={canvasRef} className="hidden" />

        {state === "starting" ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-white">
            <p>Starting camera…</p>
          </div>
        ) : null}
        {state === "error" ? (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-white">
            <p className="max-w-xs">{errorMessage ?? "Could not access the camera."}</p>
          </div>
        ) : null}
        {state === "live" ? (
          <p className="absolute inset-x-0 top-6 text-center text-sm text-white/90">
            Frame the {label}, then tap the button
          </p>
        ) : null}
      </div>

      <div className="flex gap-3 p-4">
        {state === "preview" ? (
          <>
            <button
              type="button"
              onClick={retake}
              className="flex-1 rounded-md bg-white/15 px-4 py-3 text-base font-semibold text-white backdrop-blur hover:bg-white/25"
            >
              Retake
            </button>
            <button
              type="button"
              onClick={confirm}
              className="flex-1 rounded-md bg-blue-600 px-4 py-3 text-base font-semibold text-white hover:bg-blue-700"
            >
              Use photo
            </button>
          </>
        ) : state === "live" ? (
          <>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md bg-white/15 px-4 py-3 text-base font-semibold text-white backdrop-blur hover:bg-white/25"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={snap}
              className="flex-1 rounded-md bg-white px-4 py-3 text-base font-semibold text-black hover:bg-slate-100"
            >
              Capture {label}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onCancel}
            className="w-full rounded-md bg-white/15 px-4 py-3 text-base font-semibold text-white backdrop-blur hover:bg-white/25"
          >
            {state === "error" ? "Close" : "Cancel"}
          </button>
        )}
      </div>
    </div>
  );
}

function cameraErrorMessage(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") {
      return "Camera permission was denied. Allow camera access to photograph the cover.";
    }
    if (err.name === "NotFoundError") {
      return "No camera found on this device.";
    }
    if (err.name === "NotReadableError") {
      return "The camera is in use by another app. Close it and try again.";
    }
  }
  return "Camera unavailable. This screen needs HTTPS and camera permission.";
}
