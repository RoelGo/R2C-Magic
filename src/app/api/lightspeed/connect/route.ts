import { buildAuthorizeUrl, createPkce, createState, getOAuthClient } from "@/lib/lightspeed";
import { logger } from "@/lib/logger";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Cookie names for the in-flight OAuth handshake (short-lived, httpOnly). */
export const OAUTH_STATE_COOKIE = "ls_oauth_state";
export const OAUTH_VERIFIER_COOKIE = "ls_oauth_verifier";
const HANDSHAKE_TTL_SECONDS = 600; // 10 minutes to complete the login

/**
 * Begin the Lightspeed Retail authorization-code grant (spec v2 Slice F).
 *
 * Generates a PKCE verifier/challenge + CSRF `state`, stashes the secrets in
 * short-lived httpOnly cookies, and redirects the worker to Lightspeed's
 * consent screen. The matching `callback` route validates `state` and
 * exchanges the returned code for tokens.
 */
export async function GET(): Promise<NextResponse> {
  const client = getOAuthClient();
  if (!client) {
    return NextResponse.json(
      { error: "Lightspeed is not configured (set LIGHTSPEED_CLIENT_ID/SECRET/REDIRECT_URI)" },
      { status: 400 },
    );
  }

  const state = createState();
  const pkce = createPkce();

  const authorizeUrl = buildAuthorizeUrl({
    clientId: client.clientId,
    scope: client.scope,
    state,
    codeChallenge: pkce.challenge,
  });

  const jar = await cookies();
  const secure = client.redirectUri.startsWith("https://");
  const cookieOpts = {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: HANDSHAKE_TTL_SECONDS,
  };
  jar.set(OAUTH_STATE_COOKIE, state, cookieOpts);
  jar.set(OAUTH_VERIFIER_COOKIE, pkce.verifier, cookieOpts);

  logger.debug("lightspeed authorization started");
  return NextResponse.redirect(authorizeUrl);
}
