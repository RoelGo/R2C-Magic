import { exchangeCodeForTokens, getOAuthClient, saveTokens } from "@/lib/lightspeed";
import { logger } from "@/lib/logger";
import { publicUrl } from "@/lib/urls";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { OAUTH_STATE_COOKIE, OAUTH_VERIFIER_COOKIE } from "../connect/route";

export const dynamic = "force-dynamic";

/** Where we send the worker after the handshake, with a status flag. */
function settingsRedirect(
  request: Request,
  status: "connected" | "error",
  reason?: string,
): NextResponse {
  // Build against the public origin (APP_BASE_URL) so the browser is not sent
  // to the container's internal bind address behind a reverse proxy.
  const url = publicUrl("/settings/lightspeed", request);
  url.searchParams.set("status", status);
  if (reason) url.searchParams.set("reason", reason);
  return NextResponse.redirect(url);
}

/**
 * OAuth redirect target (spec v2 Slice F). Validates the CSRF `state` against
 * the cookie set by `connect`, exchanges the authorization code (with the PKCE
 * verifier) for tokens, and persists the connection. Always clears the
 * handshake cookies and redirects back to the settings page with a result.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const client = getOAuthClient();
  if (!client) {
    return settingsRedirect(request, "error", "not-configured");
  }

  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const state = requestUrl.searchParams.get("state");
  const oauthError = requestUrl.searchParams.get("error");

  const jar = await cookies();
  const expectedState = jar.get(OAUTH_STATE_COOKIE)?.value;
  const verifier = jar.get(OAUTH_VERIFIER_COOKIE)?.value;
  // Clear handshake cookies regardless of outcome.
  jar.delete(OAUTH_STATE_COOKIE);
  jar.delete(OAUTH_VERIFIER_COOKIE);

  if (oauthError) {
    logger.warn({ oauthError }, "lightspeed authorization denied");
    return settingsRedirect(request, "error", "denied");
  }
  if (!code || !state) {
    return settingsRedirect(request, "error", "missing-code");
  }
  if (!expectedState || state !== expectedState || !verifier) {
    logger.warn("lightspeed callback state mismatch");
    return settingsRedirect(request, "error", "state-mismatch");
  }

  try {
    const tokens = await exchangeCodeForTokens(client, {
      code,
      codeVerifier: verifier,
      redirectUri: client.redirectUri,
    });
    saveTokens(tokens);
    return settingsRedirect(request, "connected");
  } catch (err) {
    logger.warn(
      { message: err instanceof Error ? err.message : "unknown" },
      "lightspeed token exchange failed",
    );
    return settingsRedirect(request, "error", "exchange-failed");
  }
}
