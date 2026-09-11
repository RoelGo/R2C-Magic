# syntax=docker/dockerfile:1.7

# --- ppocr --------------------------------------------------------------
# PP-OCRv6 (PaddleOCR) Python runtime. Placed as early as possible and built
# only from the stable base image + a static requirements list, so its layers
# stay cached across app source changes — this is a heavy, slow-to-build stage
# and we never want to rebuild it just because `src/` changed.
#
# The heavy deps live in a self-contained virtualenv at /opt/ocr-venv, which is
# copied wholesale into the runtime stage. PP_OCR_PYTHON points at it there.
FROM node:20-bookworm-slim AS ppocr
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip libgomp1 \
    && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/ocr-venv
ENV PATH=/opt/ocr-venv/bin:$PATH
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir paddlepaddle paddleocr

# --- deps ---------------------------------------------------------------
FROM node:20-bookworm-slim AS deps
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# --- build --------------------------------------------------------------
FROM node:20-bookworm-slim AS builder
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build
# `public/` is optional in this project; ensure it exists so the runtime
# COPY below always has a source and the build never breaks.
RUN mkdir -p public

# --- runtime ------------------------------------------------------------
FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_URL=/app/data/r2c.db \
    DATA_DIR=/app/data
# --- Cover OCR (PP-OCRv6) ------------------------------------------------
# OCR is opt-in at runtime (OCR_ENABLED=true) but the engine is baked in so no
# image rebuild is needed to turn it on. PP_OCR_PYTHON points at the venv from
# the `ppocr` stage; model weights download to PADDLE_PDX_CACHE_HOME on first
# use (under the /app/data volume) so they persist across restarts.
ENV OCR_ENABLED=false \
    OCR_ENGINE=pp-ocrv6 \
    PP_OCR_PYTHON=/opt/ocr-venv/bin/python \
    PP_OCR_MODEL_SIZE=small \
    PADDLE_PDX_CACHE_HOME=/app/data/.paddlex

# `gosu` lets the entrypoint drop from root to the host-provided PUID/PGID.
# python3 + the shared libs below are PaddleOCR's runtime deps: libgomp1
# (OpenMP), and libgl1 + libglib2.0-0 (OpenCV, pulled in by paddleocr — without
# them `import paddleocr` fails with "libGL.so.1: cannot open shared object
# file", which the runner script misreports as "paddleocr is not installed").
# The self-contained venv (paddleocr/paddlepaddle) is copied from the ppocr stage.
RUN apt-get update && apt-get install -y --no-install-recommends \
      gosu python3 libgomp1 libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ppocr /opt/ocr-venv /opt/ocr-venv

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs \
    && mkdir -p /app/data && chown -R nextjs:nodejs /app/data

# next.config.ts sets `output: "standalone"`. The build output bundles the
# minimum server + node_modules required at runtime.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/db/migrations ./src/lib/db/migrations
COPY --from=builder --chown=nextjs:nodejs /app/mapping.config.json ./mapping.config.json
# PP-OCRv6 runner script (used only when OCR_ENGINE=pp-ocrv6). Harmless to
# ship even when OCR is disabled.
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --chmod=755 docker-entrypoint.sh /app/docker-entrypoint.sh

# --- Cover OCR engine ------------------------------------------------------
# The PP-OCRv6 runtime (paddleocr/paddlepaddle) is baked into the image via the
# `ppocr` stage above and wired up through the OCR_*/PP_OCR_* env vars. It stays
# dormant until OCR_ENABLED=true, so the default runtime cost is just the venv
# on disk. Enable at run time with e.g. OCR_ENABLED=true (OCR_ENGINE defaults to
# pp-ocrv6). Model weights are fetched on first use into PADDLE_PDX_CACHE_HOME
# (under the /app/data volume) so they persist across restarts.


# NOTE: we intentionally do NOT set `USER nextjs` here. The container starts as
# root so docker-entrypoint.sh can align the runtime user with the host's
# PUID/PGID and chown the bind-mounted data dir, then drops privileges via gosu.
EXPOSE 3000
VOLUME ["/app/data"]

# server.js is generated by Next.js standalone output.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
