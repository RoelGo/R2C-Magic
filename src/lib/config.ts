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

  /**
   * The app's canonical public origin, e.g. `https://intake.rokko.coop`. Used
   * to build absolute redirect URLs (notably the Lightspeed OAuth callback →
   * settings redirect) so they point at the externally reachable host rather
   * than the container bind address. Behind a reverse proxy, a route handler's
   * `request.url` host is the internal bind (e.g. `0.0.0.0:3000`); set this to
   * the public URL to override it. Optional so dev/tests fall back to
   * `request.url`. Must NOT be `localhost`/`0.0.0.0` in production.
   */
  APP_BASE_URL: z.string().url().optional(),

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
   * suggestion step (US-G2). Enable to run the PP-OCRv6 subprocess adapter.
   */
  OCR_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v.toLowerCase() === "true"),
  /** Which subprocess engine to run. `none` disables OCR regardless. */
  OCR_ENGINE: z.enum(["none", "pp-ocrv6"]).default("pp-ocrv6"),
  /**
   * Per-image budget for the OCR subprocess. It covers a cold Python start
   * (importing paddle is seconds on its own) plus inference, so it is far from
   * tight: a 12 MP cover on a 2-core NAS measures ~17s end to end.
   */
  OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  /** Python interpreter + script that run PP-OCRv6 and emit JSON on stdout. */
  PP_OCR_PYTHON: z.string().default("python3"),
  PP_OCR_SCRIPT: z.string().default("scripts/pp_ocr.py"),
  /**
   * PP-OCRv6 det+rec variant. Smaller = far faster cold start with a small
   * accuracy cost (on the sample cover: tiny ~6s, small ~12s, medium ~49s per
   * run). `small` is the default: a middleground that fits the OCR timeout and
   * is noticeably more accurate than `tiny` while far faster than `medium`.
   */
  PP_OCR_MODEL_SIZE: z.enum(["medium", "small", "tiny"]).default("small"),
  /** Optional local model dir for PP-OCRv6 (overrides PP_OCR_MODEL_SIZE). */
  PP_OCR_MODEL_DIR: z.string().optional(),
  /**
   * Longest edge (px) the cover is downscaled to before recognition; 0 keeps
   * the original. Phone uploads are ~12 MP, on which PP-OCRv6 is roughly 3x
   * slower for byte-identical text (measured: 47s → 17s at 1600px on 2 cores).
   * Line geometry is mapped back to original pixels by the script.
   */
  PP_OCR_MAX_SIDE: z.coerce.number().int().min(0).default(1600),

  /**
   * Layout-aware description detection (spec v2 US-D6, exploratory). Runs
   * PaddleOCR layout detection + OCR to group back-cover text into paragraphs.
   */
  PP_LAYOUT_SCRIPT: z.string().default("scripts/pp_layout.py"),
  /** PaddleOCR layout-detection model name (PP-DocLayout family). */
  PP_LAYOUT_MODEL: z.string().default("PP-DocLayout_plus-L"),

  /**
   * Lightspeed Retail (R-Series) OAuth client credentials (spec v2 Slice F).
   * rokko runs an omnichannel subscription, so products are pushed through the
   * Retail API rather than the eCom API. The connection flow (authorization
   * code grant + PKCE) is only offered when the client id/secret/redirect are
   * all present; otherwise the settings page shows "not configured" and the
   * app runs exactly as before. Secrets are optional so the app still boots
   * (and the test suite runs) without a Lightspeed account.
   */
  LIGHTSPEED_CLIENT_ID: z.string().optional(),
  LIGHTSPEED_CLIENT_SECRET: z.string().optional(),
  /**
   * The redirect URI registered with the Lightspeed OAuth client. Must exactly
   * match the callback this app exposes, e.g.
   * `https://intake.rokko.coop/api/lightspeed/callback`.
   */
  LIGHTSPEED_REDIRECT_URI: z.string().url().optional(),
  /** Space-separated access scopes requested during authorization. */
  LIGHTSPEED_SCOPES: z.string().default("employee:all"),
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
