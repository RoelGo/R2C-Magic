/**
 * Build absolute URLs that point at the app's *public* origin.
 *
 * In a route handler, `request.url`'s host is whatever the server bound to —
 * behind a reverse proxy that is the internal address (e.g. `0.0.0.0:3000`),
 * not the URL users actually reach. Redirects built from `request.url` would
 * then send the browser to the wrong host. When `APP_BASE_URL` is configured
 * we use it as the canonical origin; otherwise we fall back to the request's
 * own origin (fine for local dev where they coincide).
 */
import { config } from "@/lib/config";

/**
 * Resolve `path` against the public base URL (`APP_BASE_URL`) when set, else
 * against the incoming request's origin. `path` may be an absolute-path string
 * ("/settings") — its query/hash are preserved.
 *
 * @param path  A path (optionally with query), e.g. "/settings/lightspeed".
 * @param request  The incoming request, used as the fallback origin.
 */
export function publicUrl(path: string, request: Request): URL {
  const base = config.APP_BASE_URL ?? request.url;
  return new URL(path, base);
}

/** The configured public origin (scheme + host), or `undefined` if unset. */
export function publicOrigin(): string | undefined {
  return config.APP_BASE_URL ? new URL(config.APP_BASE_URL).origin : undefined;
}
