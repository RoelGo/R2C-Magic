/**
 * Lightspeed Retail (R-Series) OAuth — protocol helpers (spec v2 Slice F).
 *
 * rokko runs an omnichannel plan, so products are managed through the Retail
 * API rather than the eCom API. Access is granted via the OAuth 2.0
 * authorization-code grant with PKCE, documented at
 * https://developers.lightspeedhq.com/retail/authentication/authorization-code-grant/.
 *
 * This module is intentionally I/O-light and stateless: it builds the
 * authorize URL, performs the token/refresh/revoke HTTP calls, and validates
 * responses at the boundary with Zod. Token *persistence* lives in
 * `connection.ts`; the client credentials come from `config.ts`. Nothing here
 * reads or writes the database, so the pure pieces (PKCE, URL building) are
 * exhaustively unit-testable.
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

/** OAuth authorization + token host (the same for token/refresh/revoke). */
const OAUTH_BASE = "https://cloud.lightspeedapp.com";
const AUTHORIZE_URL = `${OAUTH_BASE}/auth/oauth/authorize`;
const TOKEN_URL = `${OAUTH_BASE}/auth/oauth/token`;
const REVOKE_URL = `${OAUTH_BASE}/auth/oauth/revoke`;

/** base64url without padding, per RFC 7636. */
function base64Url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh PKCE verifier/challenge pair (S256). */
export interface Pkce {
  /** 43–128 char base64url secret, sent with the token exchange. */
  verifier: string;
  /** SHA-256(verifier), sent with the authorize request. */
  challenge: string;
}

/** Generate a PKCE verifier + S256 challenge. */
export function createPkce(): Pkce {
  const verifier = base64Url(randomBytes(64)); // ~86 chars, within 43–128
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** A random opaque value for the OAuth `state` (CSRF protection). */
export function createState(): string {
  return base64Url(randomBytes(24));
}

export interface AuthorizeUrlParams {
  clientId: string;
  scope: string;
  state: string;
  codeChallenge: string;
}

/**
 * Build the URL the worker is redirected to in order to authorize the app.
 * Uses PKCE (`S256`) and always includes `state`, per Lightspeed's guidance.
 */
export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("scope", params.scope);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** The token endpoint response (authorization-code and refresh grants). */
const tokenResponseSchema = z.object({
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  scope: z.string().optional(),
});

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires (from issue time). */
  expiresIn: number;
  scope?: string;
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/** JWT payload fields we rely on (the account id the token is scoped to). */
const jwtPayloadSchema = z.object({
  acct: z.union([z.string(), z.number()]).transform((v) => String(v)),
  scope: z.string().optional(),
});

/**
 * Extract the Retail account id from an access-token JWT without verifying the
 * signature (we only just received it over TLS from Lightspeed; we use `acct`
 * to build the API base path, not for authorization). Returns `undefined` if
 * the token is not a well-formed JWT with an `acct` claim.
 */
export function accountIdFromAccessToken(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return undefined;
  const payloadPart = parts[1];
  if (!payloadPart) return undefined;
  try {
    const json = Buffer.from(payloadPart, "base64url").toString("utf8");
    const parsed = jwtPayloadSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data.acct : undefined;
  } catch {
    return undefined;
  }
}

/** Raised when the token endpoint returns a non-2xx or unparseable response. */
export class OAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

async function postToken(body: Record<string, string>): Promise<OAuthTokens> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new OAuthError(
      `Could not reach Lightspeed token endpoint: ${err instanceof Error ? err.message : "network error"}`,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    // Surface the "hint"/"error_description" when present, but never the token.
    const hint = safeErrorHint(text);
    throw new OAuthError(
      `Lightspeed token request failed (${res.status})${hint ? `: ${hint}` : ""}`,
      res.status,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OAuthError("Lightspeed token response was not valid JSON", res.status);
  }

  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new OAuthError("Lightspeed token response did not match the expected shape", res.status);
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresIn: parsed.data.expires_in,
    scope: parsed.data.scope,
  };
}

function safeErrorHint(body: string): string | undefined {
  try {
    const obj = JSON.parse(body) as Record<string, unknown>;
    const hint = obj.hint ?? obj.error_description ?? obj.error;
    return typeof hint === "string" ? hint : undefined;
  } catch {
    return undefined;
  }
}

/** Exchange an authorization code (+ PKCE verifier) for tokens. */
export async function exchangeCodeForTokens(
  client: OAuthClient,
  args: { code: string; codeVerifier: string; redirectUri: string },
): Promise<OAuthTokens> {
  return postToken({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    grant_type: "authorization_code",
    code: args.code,
    code_verifier: args.codeVerifier,
    redirect_uri: args.redirectUri,
  });
}

/** Exchange a refresh token for a fresh access + (rotated) refresh token. */
export async function refreshAccessToken(
  client: OAuthClient,
  refreshToken: string,
): Promise<OAuthTokens> {
  return postToken({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

/** Revoke a refresh token (and its access token). Best-effort; never throws. */
export async function revokeRefreshToken(client: OAuthClient, refreshToken: string): Promise<void> {
  try {
    await fetch(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: refreshToken,
      }),
    });
  } catch {
    // Revocation is a courtesy to Lightspeed; local disconnect still proceeds.
  }
}
