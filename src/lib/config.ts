import { z } from "zod";

/**
 * Centralized, validated env config. Import `config` anywhere instead of
 * touching `process.env` directly so missing/invalid values fail loud at boot.
 */
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  DATABASE_URL: z.string().default("./data/r2c.db"),
  DATA_DIR: z.string().default("./data"),

  ENRICH_CONCURRENCY: z.coerce.number().int().positive().default(5),
  ENRICH_CACHE_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /**
   * Shorter TTL for cached *errors* (network failures, 429, 5xx) so
   * transient outages don't permanently lock a book out of enrichment.
   * Hits and "not found" results still respect ENRICH_CACHE_TTL_DAYS.
   */
  ENRICH_ERROR_CACHE_TTL_HOURS: z.coerce.number().int().positive().default(6),
  ENRICH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  GOOGLE_BOOKS_API_KEY: z.string().optional(),
  OPEN_LIBRARY_USER_AGENT: z.string().default("r2c-magic/0.1 (mailto:tech@rokko.coop)"),

  /**
   * Master kill-switch for online enrichment. Defaults to true. Tests set
   * this to false in `tests/helpers/tmp-env.ts` so the queue does not
   * fan out to live APIs while running the suite.
   */
  ENRICHMENT_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),

  INCLUDE_ERROR_COLUMN: z
    .string()
    .default("true")
    .transform((v) => v.toLowerCase() !== "false"),
  ERROR_COLUMN_NAME: z.string().default("_enrichment_errors"),

  /**
   * Server-side OCR of cover photos (spec v2 US-D3/D4). Off by default so the
   * app runs with no OCR engine installed; the photo flow simply skips the
   * suggestion step (US-G2). Enable + pick an engine to benchmark the two
   * subprocess adapters.
   */
  OCR_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  /** Which subprocess engine to run. `none` disables OCR regardless. */
  OCR_ENGINE: z.enum(["none", "ocrs", "pp-ocrv6"]).default("ocrs"),
  OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  /** Path to the `ocrs` CLI binary (https://github.com/robertknight/ocrs). */
  OCRS_BIN: z.string().default("ocrs"),

  /** Python interpreter + script that run PP-OCRv6 and emit JSON on stdout. */
  PP_OCR_PYTHON: z.string().default("python3"),
  PP_OCR_SCRIPT: z.string().default("scripts/pp_ocr.py"),
  /**
   * PP-OCRv6 det+rec variant. Smaller = far faster cold start with a small
   * accuracy cost (on the sample cover: tiny ~6s, small ~12s, medium ~49s per
   * run). `tiny` is the default as it fits the OCR timeout and is nearly as
   * accurate as `medium` after cleanup + human review.
   */
  PP_OCR_MODEL_SIZE: z.enum(["medium", "small", "tiny"]).default("tiny"),
  /** Optional local model dir for PP-OCRv6 (overrides PP_OCR_MODEL_SIZE). */
  PP_OCR_MODEL_DIR: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema>;

function load(): AppConfig {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config: AppConfig = load();
