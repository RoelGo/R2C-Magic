/**
 * Minimal ambient types for the native Barcode Detection API, which is not yet
 * in TypeScript's `lib.dom`. Used as the fast path in the intake barcode
 * scanner (spec v2 US-B1); we fall back to `@zxing/browser` when absent.
 *
 * Spec: https://wicg.github.io/shape-detection-api/#barcode-detection-api
 */

interface DetectedBarcode {
  rawValue: string;
  format: string;
  boundingBox: DOMRectReadOnly;
  cornerPoints: ReadonlyArray<{ x: number; y: number }>;
}

interface BarcodeDetectorOptions {
  formats?: string[];
}

declare class BarcodeDetector {
  constructor(options?: BarcodeDetectorOptions);
  static getSupportedFormats(): Promise<string[]>;
  detect(source: CanvasImageSource | Blob | ImageData): Promise<DetectedBarcode[]>;
}

interface Window {
  BarcodeDetector?: typeof BarcodeDetector;
}
