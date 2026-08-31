#!/usr/bin/env python3
"""PP-OCRv6 runner for R2C-Magic (spec v2 US-D3/D4).

Reads a single image path, runs PaddleOCR's PP-OCRv6 pipeline, and prints one
JSON object to stdout that the Node `pp-ocr` engine adapter consumes:

    {"lines": ["Recognised line 1", "Recognised line 2", ...]}

Lines are ordered top-to-bottom, best effort, so downstream extraction can
treat the first lines of a front cover as the title.

Usage:
    python3 scripts/pp_ocr.py <image> [--model-dir DIR]

Setup (once per environment; see README):
    pip install paddleocr paddlepaddle

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
    # PaddleOCR downloads PP-OCRv6 weights on first use unless a local
    # model dir is supplied.
    kwargs = {"lang": "en", "use_angle_cls": True, "show_log": False}
    if args.model_dir:
        # Newer PaddleOCR builds accept explicit det/rec model dirs; pass the
        # same dir for both and let PaddleOCR resolve the sub-models.
        kwargs["det_model_dir"] = args.model_dir
        kwargs["rec_model_dir"] = args.model_dir

    try:
        ocr = PaddleOCR(**kwargs)
        raw = ocr.ocr(args.image, cls=True)
    except Exception as exc:  # noqa: BLE001 - surface any engine failure
        eprint(f"PP-OCRv6 failed: {exc}")
        return 1

    lines: list[str] = []
    # PaddleOCR returns a list (per image) of [box, (text, score)] entries.
    for page in raw or []:
        for entry in page or []:
            try:
                text = entry[1][0]
            except (IndexError, TypeError):
                continue
            if isinstance(text, str) and text.strip():
                lines.append(text.strip())

    json.dump({"lines": lines}, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
