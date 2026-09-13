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
    medium          — most accurate, slowest
    small (default) — lighter; matches PP_OCR_MODEL_SIZE and is baked into the
                      Docker image, so it needs no download at run time
    tiny            — smallest / fastest (also baked in)

Only the baked sizes work offline: asking for a size whose weights are not in
PADDLE_PDX_CACHE_HOME makes PaddleOCR try three model hosts with retrI goies before
failing, which from the Node side looks like an unexplained timeout.

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
    parser.add_argument("image", nargs="?", help="Path to the image to OCR.")
    parser.add_argument(
        "--model-size",
        default="small",
        choices=["medium", "small", "tiny"],
        help=(
            "PP-OCRv6 det+rec variant (default: small, matching the app's "
            "PP_OCR_MODEL_SIZE default and the weights baked into the image)."
        ),
    )
    parser.add_argument(
        "--model-dir",
        default=None,
        help="Optional local PP-OCRv6 model directory (overrides --model-size).",
    )
    parser.add_argument(
        "--max-side",
        type=int,
        default=1600,
        help=(
            "Downscale the image so its longest side is at most this many pixels "
            "before recognition (default: 1600; 0 disables). Phone cameras produce "
            "12 MP covers on which PP-OCRv6 is ~3x slower for identical text."
        ),
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
    parser.add_argument(
        "--selftest",
        action="store_true",
        help=(
            "Diagnose the environment instead of running OCR: prints the Python/"
            "paddle versions, the model cache location and whether the weights are "
            "already downloaded, then builds the pipeline (timing the cold start)."
        ),
    )
    args = parser.parse_args()

    if args.selftest:
        return selftest(args)
    if not args.image:
        parser.error("an image path is required (or pass --selftest)")

    try:
        from paddleocr import PaddleOCR
    except ImportError:
        eprint(
            "paddleocr is not installed. Run: pip install paddleocr paddlepaddle"
        )
        return 2

    try:
        image, scale = _load_image(args.image, args.max_side)
    except Exception as exc:  # noqa: BLE001
        eprint(f"PP-OCRv6 failed to read the image: {exc}")
        return 1

    results = None
    attempts = _mkldnn_attempts(args.mkldnn)
    for attempt, enable_mkldnn in enumerate(attempts):
        last = attempt == len(attempts) - 1
        # PaddleOCR 3.x runs the PP-OCRv6 pipeline and downloads the det/rec
        # weights on first use unless a local model dir is supplied — see
        # `_pipeline_kwargs` / `--selftest`.
        if enable_mkldnn is False:
            _disable_mkldnn_globally()
        kwargs = _pipeline_kwargs(args, enable_mkldnn)
        try:
            ocr = PaddleOCR(**kwargs)
            results = ocr.predict(image)
            break
        except Exception as exc:  # noqa: BLE001 - surface any engine failure
            if last:
                eprint(f"PP-OCRv6 failed: {exc}")
                return 1
            eprint(
                f"PP-OCRv6 failed with enable_mkldnn={enable_mkldnn} ({exc}); "
                "retrying without oneDNN acceleration"
            )

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
                # Report geometry in ORIGINAL image pixels, so downscaling for
                # speed stays invisible to the extraction heuristics (US-D5).
                entry["box"] = [v / scale for v in box] if scale != 1.0 else box
            lines.append(entry)

    json.dump({"lines": lines}, sys.stdout, ensure_ascii=False)
    return 0


def selftest(args) -> int:
    """Print environment diagnostics for the OCR runtime (stderr), exit 0/1.

    Run inside the container when OCR "just times out":

        docker exec -it r2c-magic /opt/ocr-venv/bin/python scripts/pp_ocr.py --selftest

    It separates the three things that look identical from Node's side: a
    broken install (import fails), a missing model cache (weights download on
    first use — slow or impossible without internet), and a genuinely slow CPU
    (pipeline builds, but takes longer than OCR_TIMEOUT_MS).
    """
    import os
    import time

    eprint(f"python           : {sys.version.split()[0]} ({sys.executable})")
    eprint(f"cwd              : {os.getcwd()}")
    eprint(f"HOME             : {os.environ.get('HOME', '<unset>')}")

    cache_home = os.environ.get("PADDLE_PDX_CACHE_HOME")
    eprint(f"PADDLE_PDX_CACHE_HOME: {cache_home or '<unset — defaults to ~/.paddlex>'}")
    cache_dir = cache_home or os.path.expanduser("~/.paddlex")
    eprint(f"cache dir exists : {os.path.isdir(cache_dir)}")
    eprint(f"cache dir writable: {os.access(cache_dir, os.W_OK) if os.path.isdir(cache_dir) else 'n/a'}")
    official = os.path.join(cache_dir, "official_models")
    if os.path.isdir(official):
        models = sorted(os.listdir(official))
        eprint(f"cached models    : {models or '<none>'}")
    else:
        eprint("cached models    : <none — first run must DOWNLOAD the weights>")

    try:
        import paddle  # noqa: F401

        eprint(f"paddlepaddle     : {paddle.__version__}")
    except Exception as exc:  # noqa: BLE001
        eprint(f"paddlepaddle     : IMPORT FAILED: {exc}")
        return 1

    try:
        import paddleocr

        eprint(f"paddleocr        : {paddleocr.__version__}")
        from paddleocr import PaddleOCR
    except Exception as exc:  # noqa: BLE001
        eprint(f"paddleocr        : IMPORT FAILED: {exc}")
        return 1

    ok = False
    for enable_mkldnn in _mkldnn_attempts(args.mkldnn):
        if enable_mkldnn is False:
            _disable_mkldnn_globally()
        kwargs = _pipeline_kwargs(args, enable_mkldnn)
        eprint(f"pipeline kwargs  : {kwargs}")
        eprint("building pipeline (this is what downloads the weights on a cold start)…")
        started = time.monotonic()
        try:
            ocr = PaddleOCR(**kwargs)
            eprint(f"pipeline build   : ok in {time.monotonic() - started:.1f}s")
            # Inference, not just construction: the oneDNN/PIR backend failures
            # that plague some x86 hosts only surface when a kernel actually
            # runs, so a build-only self-test would wrongly report success.
            eprint("running inference on a synthetic image…")
            started = time.monotonic()
            ocr.predict(_synthetic_image())
            eprint(
                f"inference        : ok in {time.monotonic() - started:.1f}s "
                f"(enable_mkldnn={enable_mkldnn})"
            )
            ok = True
            break
        except Exception as exc:  # noqa: BLE001
            eprint(f"FAILED after {time.monotonic() - started:.1f}s: {exc}")

    if not ok:
        eprint("Self-test FAILED. See the error(s) above.")
        return 1
    eprint("Self-test passed. If OCR still times out, raise OCR_TIMEOUT_MS.")
    return 0


def _synthetic_image():
    """A small white image with a black bar — enough to exercise det + rec."""
    import numpy as np

    image = np.full((320, 640, 3), 255, dtype=np.uint8)
    image[150:170, 100:540] = 0
    return image


def _load_image(path: str, max_side: int):
    """Return (image, scale) for `path`, downscaled to `max_side` if needed.

    `scale` is the factor applied to the original (1.0 when untouched), so line
    boxes can be mapped back to original-image pixels. Recognition quality is
    unaffected at 1600px — PaddleOCR internally caps the long side at 4000
    anyway — but runtime drops roughly threefold on a 12 MP phone photo, which
    is the difference between fitting and blowing OCR_TIMEOUT_MS on a NAS CPU.
    """
    if not max_side or max_side <= 0:
        return path, 1.0

    import cv2

    image = cv2.imread(path)
    if image is None:
        # Let PaddleOCR deal with (and report on) anything OpenCV can't read.
        return path, 1.0

    height, width = image.shape[:2]
    longest = max(height, width)
    if longest <= max_side:
        return image, 1.0

    scale = max_side / longest
    eprint(f"downscaling {width}x{height} by {scale:.3f} for OCR speed")
    resized = cv2.resize(
        image,
        (max(1, int(width * scale)), max(1, int(height * scale))),
        interpolation=cv2.INTER_AREA,
    )
    return resized, scale


def _mkldnn_attempts(mode: str) -> list:
    """oneDNN settings to try, in order.

    'auto' means: try with oneDNN (faster on x86), and fall back to the plain
    CPU kernels if the backend blows up. Paddle 3.x's PIR executor raises
    `(Unimplemented) ConvertPirAttribute2RuntimeAttribute not support …
    onednn_instruction.cc` on some x86 hosts — a hard failure of the whole
    inference, not a slow path, and one that never appears on arm64. Retrying
    costs a pipeline rebuild (sub-second with cached weights).
    """
    if mode == "on":
        return [True]
    if mode == "off":
        return [False]
    return [True, False]


def _disable_mkldnn_globally() -> None:
    """Best-effort global oneDNN kill switch, for the fallback attempt.

    `enable_mkldnn=False` on the predictor is the documented lever, but the
    retry happens in a process where paddle is already imported, so we also
    flip the runtime flag where the build supports it. Failures are ignored —
    this is belt and braces on top of the kwarg.
    """
    try:
        import paddle

        paddle.set_flags({"FLAGS_use_mkldnn": False})
    except Exception:  # noqa: BLE001
        pass


def _pipeline_kwargs(args, enable_mkldnn=None) -> dict:
    """Pipeline construction kwargs shared by OCR and the self-test."""
    # `lang='en'` covers the Latin-script (NL/EN) book covers in scope.
    # We disable the document-orientation / unwarping / textline-orientation
    # sub-models: book covers are already upright, so skipping them is faster
    # and avoids extra model downloads.
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
    if enable_mkldnn is not None:
        kwargs["enable_mkldnn"] = enable_mkldnn
    return kwargs


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
