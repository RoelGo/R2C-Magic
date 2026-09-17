#!/usr/bin/env python3
"""PP layout + OCR runner for R2C-Magic (spec v2 US-D6, exploratory).

Runs PaddleOCR's document **layout detection** (PP-DocLayout family) and text
recognition on one image, assigns each recognised line to the layout region
whose box contains it, and prints a single JSON object to stdout that the Node
`layout` module consumes:

    {
      "image_width": 3024,
      "image_height": 4032,
      "regions": [
        {
          "label": "text",
          "score": 0.82,
          "box": [x, y, width, height],
          "lines": [{"text": "...", "box": [x, y, width, height]}, ...]
        },
        ...
      ],
      "unassigned_lines": [{"text": "...", "box": [x, y, width, height]}, ...]
    }

Boxes are axis-aligned, in source-image pixels. Regions are ordered
top-to-bottom then left-to-right; lines within a region keep OCR reading order.
The goal is to group loose OCR lines into paragraphs so a downstream heuristic
can pick the main blurb and drop press quotes / bios / metadata.

Usage:
    python3 scripts/pp_layout.py <image> \
        [--model-size medium|small|tiny] [--model-dir DIR] \
        [--layout-model PP-DocLayout_plus-L] [--mkldnn auto|on|off]
    python3 scripts/pp_layout.py --selftest --model-size small

Setup is the same virtualenv as scripts/pp_ocr.py (paddleocr + paddlepaddle);
see the README. Any failure exits non-zero with a message on stderr, which the
Node caller surfaces as an error.
"""

import argparse
import json
import os
import sys

# Shared oneDNN fallback policy. pp_ocr.py lives next to this file, so the
# implicit sys.path[0] entry (the script's own directory) finds it regardless of
# the caller's cwd. Importing it has no side effects — everything is under
# `if __name__ == "__main__"`.
from pp_ocr import _disable_mkldnn_globally, _mkldnn_attempts


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def _poly_box(poly):
    """Reduce a polygon (list of [x, y]) to [x, y, width, height]."""
    xs = [float(p[0]) for p in poly]
    ys = [float(p[1]) for p in poly]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    return [x0, y0, x1 - x0, y1 - y0]


def _poly_center(poly):
    xs = [float(p[0]) for p in poly]
    ys = [float(p[1]) for p in poly]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def _mkldnn_kwarg(cls, enable_mkldnn: bool) -> dict:
    """`{"enable_mkldnn": ...}` if `cls` accepts it, else `{}`.

    PaddleOCR's predictor classes have gained/renamed constructor kwargs across
    3.x point releases. Passing an unsupported one would raise TypeError inside
    the retry loop and be misreported as a backend failure, so probe first and
    fall back to the global `FLAGS_use_mkldnn` kill switch alone.
    """
    try:
        import inspect

        params = inspect.signature(cls.__init__).parameters
        if "enable_mkldnn" in params or any(
            p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()
        ):
            return {"enable_mkldnn": enable_mkldnn}
    except (TypeError, ValueError):  # unintrospectable C/bound signature
        pass
    return {}


def main() -> int:
    parser = argparse.ArgumentParser(description="Run PP layout detection + OCR on an image.")
    parser.add_argument("image", nargs="?", help="Path to the image to process.")
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="Build the layout + OCR pipelines (downloading weights if missing) and exit.",
    )
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
    parser.add_argument(
        "--layout-model",
        default="PP-DocLayout_plus-L",
        help="PaddleOCR layout-detection model name (default: PP-DocLayout_plus-L).",
    )
    parser.add_argument(
        "--mkldnn",
        default="auto",
        choices=["auto", "on", "off"],
        help=(
            "oneDNN (MKL-DNN) CPU acceleration. 'auto' (default) tries it and "
            "transparently retries without it if the backend errors — some x86 "
            "CPUs hit an unimplemented oneDNN op in Paddle's PIR executor "
            "(ConvertPirAttribute2RuntimeAttribute). 'off' skips it outright."
        ),
    )
    args = parser.parse_args()

    if not args.selftest and not args.image:
        parser.error("an image path is required unless --selftest is given")

    # Layout/OCR models are already upright book covers; skip the connectivity
    # check so a cached model runs offline without a long hang.
    os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

    try:
        from paddleocr import LayoutDetection, PaddleOCR
    except ImportError:
        eprint("paddleocr is not installed. Run: pip install paddleocr paddlepaddle")
        return 2

    ocr_kwargs = {
        "lang": "en",
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
    }
    if args.model_dir:
        ocr_kwargs["text_detection_model_dir"] = args.model_dir
        ocr_kwargs["text_recognition_model_dir"] = args.model_dir
    else:
        ocr_kwargs["text_detection_model_name"] = f"PP-OCRv6_{args.model_size}_det"
        ocr_kwargs["text_recognition_model_name"] = f"PP-OCRv6_{args.model_size}_rec"

    layout_res = None
    ocr_res = None
    attempts = _mkldnn_attempts(args.mkldnn)
    for attempt, enable_mkldnn in enumerate(attempts):
        last = attempt == len(attempts) - 1
        if enable_mkldnn is False:
            _disable_mkldnn_globally()
        try:
            layout = LayoutDetection(
                model_name=args.layout_model, **_mkldnn_kwarg(LayoutDetection, enable_mkldnn)
            )
            if args.selftest:
                # Constructing the pipelines is what triggers the weight
                # download; that is the whole point of the build-time selftest.
                PaddleOCR(**ocr_kwargs, **_mkldnn_kwarg(PaddleOCR, enable_mkldnn))
                eprint(
                    f"pp_layout selftest OK ({args.layout_model}, {args.model_size}, "
                    f"enable_mkldnn={enable_mkldnn})"
                )
                return 0

            # Run inference, not just construction: the oneDNN/PIR failure only
            # surfaces when the executor actually runs the graph, so a retry
            # decision cannot be made off the constructor alone.
            layout_res = layout.predict(args.image)[0]

            ocr = PaddleOCR(**ocr_kwargs, **_mkldnn_kwarg(PaddleOCR, enable_mkldnn))
            ocr_res = ocr.predict(args.image)[0]
            break
        except Exception as exc:  # noqa: BLE001 - surface any engine failure
            if last:
                eprint(f"PP layout/OCR failed: {exc}")
                return 1
            eprint(
                f"PP layout/OCR failed with enable_mkldnn={enable_mkldnn} ({exc}); "
                "retrying without oneDNN acceleration"
            )

    # Layout regions: label + score + [x0, y0, x1, y1] coordinate.
    regions = []
    for b in layout_res.get("boxes", []) or []:
        coord = b.get("coordinate")
        if coord is None:
            continue
        x0, y0, x1, y1 = (float(coord[0]), float(coord[1]), float(coord[2]), float(coord[3]))
        regions.append(
            {
                "label": str(b.get("label", "unknown")),
                "score": float(b.get("score", 0.0)),
                "coord": (x0, y0, x1, y1),
                "box": [x0, y0, x1 - x0, y1 - y0],
                "lines": [],
            }
        )

    # OCR lines: text + polygon.
    texts = ocr_res.get("rec_texts", []) or []
    polys = ocr_res.get("rec_polys", None)
    if polys is None:
        polys = ocr_res.get("dt_polys", None)

    unassigned = []
    for i, text in enumerate(texts):
        if not (isinstance(text, str) and text.strip()):
            continue
        if polys is None or i >= len(polys):
            continue
        poly = polys[i]
        line = {"text": text.strip(), "box": _poly_box(poly)}
        cx, cy = _poly_center(poly)
        # Assign to the first (smallest-area) region containing the line centre.
        candidates = [
            r for r in regions if r["coord"][0] <= cx <= r["coord"][2] and r["coord"][1] <= cy <= r["coord"][3]
        ]
        if candidates:
            candidates.sort(key=lambda r: r["box"][2] * r["box"][3])
            candidates[0]["lines"].append(line)
        else:
            unassigned.append(line)

    # Order regions top-to-bottom then left-to-right; drop the internal `coord`.
    regions.sort(key=lambda r: (round(r["box"][1] / 20), r["box"][0]))
    out_regions = [
        {"label": r["label"], "score": r["score"], "box": r["box"], "lines": r["lines"]}
        for r in regions
    ]

    input_img = layout_res.get("input_img", None)
    if input_img is not None and hasattr(input_img, "shape"):
        h, w = int(input_img.shape[0]), int(input_img.shape[1])
    else:
        h, w = 0, 0

    json.dump(
        {
            "image_width": w,
            "image_height": h,
            "regions": out_regions,
            "unassigned_lines": unassigned,
        },
        sys.stdout,
        ensure_ascii=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
