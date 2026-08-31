#!/usr/bin/env python3
"""PP-OCRv6 runner for R2C-Magic (spec v2 US-D3/D4).

Reads a single image path, runs PaddleOCR's PP-OCRv6 pipeline, and prints one
JSON object to stdout that the Node `pp-ocr` engine adapter consumes:

    {"lines": ["Recognised line 1", "Recognised line 2", ...]}

Lines are ordered top-to-bottom, best effort, so downstream extraction can
treat the first lines of a front cover as the title.

Usage:
    python3 scripts/pp_ocr.py <image> [--model-dir DIR]

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
        "--model-dir",
        default=None,
        help="Optional local PP-OCRv6 model directory.",
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

    try:
        ocr = PaddleOCR(**kwargs)
        results = ocr.predict(args.image)
    except Exception as exc:  # noqa: BLE001 - surface any engine failure
        eprint(f"PP-OCRv6 failed: {exc}")
        return 1

    lines: list[str] = []
    # PaddleOCR 3.x returns one result object per input image; recognised
    # strings live under `rec_texts`, already ordered top-to-bottom.
    for result in results or []:
        texts = result.get("rec_texts", []) if hasattr(result, "get") else []
        for text in texts:
            if isinstance(text, str) and text.strip():
                lines.append(text.strip())

    json.dump({"lines": lines}, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
