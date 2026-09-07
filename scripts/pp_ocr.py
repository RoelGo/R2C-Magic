#!/usr/bin/env python3
"""PP-OCRv6 runner for R2C-Magic (spec v2 US-D3/D4).

Reads a single image path, runs PaddleOCR's PP-OCRv6 pipeline, and prints one
JSON object to stdout that the Node `pp-ocr` engine adapter consumes:

    {"lines": [
        {"text": "Recognised line 1", "box": [x, y, width, height]},
        {"text": "Recognised line 2"},
        ...
    ]}

Each line carries its axis-aligned bounding box (in source-image pixels) when
the pipeline exposes one, so downstream extraction (spec v2 US-D5) can use text
size/position — not just reading order — to tell the title from the author.
`box` is omitted when geometry is unavailable. Lines are ordered top-to-bottom,
best effort.

Usage:
    python3 scripts/pp_ocr.py <image> [--model-size medium|small|tiny] [--model-dir DIR]

`--model-size` picks a PP-OCRv6 det+rec variant. Smaller = faster cold start
and inference, at some accuracy cost:
    medium (default) — most accurate, slowest
    small            — lighter
    tiny             — smallest / fastest

Setup (once per environment; see README). Use a virtualenv so it works
regardless of a Homebrew/system Python that blocks global installs:
    python3 -m venv .venv-ocr
    .venv-ocr/bin/pip install paddleocr paddlepaddle
Then point the app at it with PP_OCR_PYTHON=.venv-ocr/bin/python
(requires PaddleOCR 3.x, which runs the PP-OCRv6 pipeline).

The heavy model/runtime deliberately lives here rather than in the Node
process, so the app runs without OCR installed and the engine is swappable by
config. Any failure exits non-zero with a message on stderr, which the Node
adapter surfaces as an OCR error.
"""

import argparse
import json
import sys


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run PP-OCRv6 on an image.")
    parser.add_argument("image", help="Path to the image to OCR.")
    parser.add_argument(
        "--model-size",
        default="medium",
        choices=["medium", "small", "tiny"],
        help="PP-OCRv6 det+rec variant (default: medium).",
    )
    parser.add_argument(
        "--model-dir",
        default=None,
        help="Optional local PP-OCRv6 model directory (overrides --model-size).",
    )
    args = parser.parse_args()

    try:
        from paddleocr import PaddleOCR
    except ImportError:
        eprint(
            "paddleocr is not installed. Run: pip install paddleocr paddlepaddle"
        )
        return 2

    # `lang='en'` covers the Latin-script (NL/EN) book covers in scope.
    # PaddleOCR 3.x runs the PP-OCRv6 pipeline and downloads the det/rec
    # weights on first use unless a local model dir is supplied. We disable the
    # document-orientation / unwarping / textline-orientation sub-models: book
    # covers are already upright, so skipping them is faster and avoids extra
    # model downloads.
    kwargs = {
        "lang": "en",
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
    }
    if args.model_dir:
        # Point both detection and recognition at the supplied local models.
        kwargs["text_detection_model_dir"] = args.model_dir
        kwargs["text_recognition_model_dir"] = args.model_dir
    else:
        # Select the PP-OCRv6 det+rec variant by size.
        kwargs["text_detection_model_name"] = f"PP-OCRv6_{args.model_size}_det"
        kwargs["text_recognition_model_name"] = f"PP-OCRv6_{args.model_size}_rec"

    try:
        ocr = PaddleOCR(**kwargs)
        results = ocr.predict(args.image)
    except Exception as exc:  # noqa: BLE001 - surface any engine failure
        eprint(f"PP-OCRv6 failed: {exc}")
        return 1

    lines: list[dict] = []
    # PaddleOCR 3.x returns one result object per input image; recognised
    # strings live under `rec_texts`, already ordered top-to-bottom. Per-line
    # polygons live under `rec_polys` (falling back to `rec_boxes`), aligned by
    # index with `rec_texts`.
    for result in results or []:
        if not hasattr(result, "get"):
            continue
        texts = result.get("rec_texts", []) or []
        polys = result.get("rec_polys", None)
        boxes = result.get("rec_boxes", None)
        for i, text in enumerate(texts):
            if not (isinstance(text, str) and text.strip()):
                continue
            entry: dict = {"text": text.strip()}
            box = _line_box(polys, boxes, i)
            if box is not None:
                entry["box"] = box
            lines.append(entry)

    json.dump({"lines": lines}, sys.stdout, ensure_ascii=False)
    return 0


def _line_box(polys, boxes, i):
    """Return [x, y, width, height] for line `i`, or None if unavailable.

    Prefers the detection polygon (`rec_polys`, four [x, y] points), reducing it
    to an axis-aligned box; falls back to a pre-computed [x1, y1, x2, y2] box.
    """
    try:
        if polys is not None and i < len(polys):
            poly = polys[i]
            xs = [float(p[0]) for p in poly]
            ys = [float(p[1]) for p in poly]
            if xs and ys:
                x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
                return [x0, y0, x1 - x0, y1 - y0]
        if boxes is not None and i < len(boxes):
            b = boxes[i]
            x0, y0, x1, y1 = float(b[0]), float(b[1]), float(b[2]), float(b[3])
            return [x0, y0, x1 - x0, y1 - y0]
    except (TypeError, ValueError, IndexError):
        return None
    return None


if __name__ == "__main__":
    sys.exit(main())
