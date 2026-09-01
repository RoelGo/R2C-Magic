import { config } from "@/lib/config";
/**
 * Lightspeed Retail connection state (spec v2 Slice F).
 *
 * Owns the single `lightspeed_connection` row: persisting tokens after the
 * OAuth handshake, reporting connection status to the settings UI, and handing
 * out a valid access token to API callers — transparently refreshing (and
 * rotating the refresh token) when the current one is near expiry.
 *
 * Client credentials come from `config.ts`; if they are absent the app is
 * simply "not configured" and the connect flow is unavailable.
 */
import { getDb } from "@/lib/db/client";
import { lightspeedConnection } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { eq } from "drizzle-orm";
import {
  type OAuthClient,
  type OAuthTokens,
  accountIdFromAccessToken,
  refreshAccessToken,
  revokeRefreshToken,
} from "./oauth";

/** The one connection row's primary key (single-tenant install). */
const CONNECTION_ID = "default";

/**
 * Refresh the access token when it has this little life left, so an in-flight
 * push doesn't fail mid-request. Lightspeed tokens last ~60 min.
 */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Are the client credentials + redirect configured? (Connect flow gate.) */
export function isLightspeedConfigured(): boolean {
  return Boolean(
    config.LIGHTSPEED_CLIENT_ID &&
      config.LIGHTSPEED_CLIENT_SECRET &&
      config.LIGHTSPEED_REDIRECT_URI,
  );
}

/**
 * The configured OAuth client credentials, or `undefined` when not configured.
 * Callers that need these should first check `isLightspeedConfigured()`.
 */
export function getOAuthClient():
  | (OAuthClient & { redirectUri: string; scope: string })
  | undefined {
  if (!isLightspeedConfigured()) return undefined;
  return {
    // Non-null asserted safe by the guard above.
    clientId: config.LIGHTSPEED_CLIENT_ID as string,
    clientSecret: config.LIGHTSPEED_CLIENT_SECRET as string,
    redirectUri: config.LIGHTSPEED_REDIRECT_URI as string,
    scope: config.LIGHTSPEED_SCOPES,
  };
}

export interface LightspeedConnectionStatus {
  configured: boolean;
  connected: boolean;
  accountId?: string;
  scope?: string;
  connectedAt?: Date;
  accessTokenExpiresAt?: Date;
}

/** Current connection status for the settings screen. */
export function getConnectionStatus(): LightspeedConnectionStatus {
  const configured = isLightspeedConfigured();
  const row = getDb()
    .select()
    .from(lightspeedConnection)
    .where(eq(lightspeedConnection.id, CONNECTION_ID))
    .get();

  if (!row) return { configured, connected: false };
  return {
    configured,
    connected: true,
    accountId: row.accountId,
    scope: row.scope ?? undefined,
    connectedAt: row.connectedAt,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
  };
}

/**
 * Persist a freshly-issued set of tokens as the current connection, upserting
 * the single row. Derives the Retail account id from the access-token JWT.
 *
 * @throws if the access token lacks a usable `acct` claim.
 */
export function saveTokens(tokens: OAuthTokens): void {
  const accountId = accountIdFromAccessToken(tokens.accessToken);
  if (!accountId) {
    throw new Error("Lightspeed access token did not contain an account id");
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + tokens.expiresIn * 1000);
  const db = getDb();

  db.insert(lightspeedConnection)
    .values({
      id: CONNECTION_ID,
      accountId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: expiresAt,
      scope: tokens.scope ?? null,
      connectedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: lightspeedConnection.id,
      set: {
        accountId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExpiresAt: expiresAt,
        scope: tokens.scope ?? null,
        updatedAt: now,
      },
    })
    .run();

  logger.info({ accountId, scope: tokens.scope }, "lightspeed connection saved");
}

/**
 * Return a currently-valid access token, refreshing it first if it is missing,
 * expired, or within the refresh skew window. Refreshing rotates the refresh
 * token, which is persisted before the token is returned.
 *
 * @returns the access token, or `undefined` if the app is not connected.
 * @throws if a refresh is required but fails (e.g. the refresh token was
 *   revoked or expired) — callers surface this as "reconnect required".
 */
export async function getValidAccessToken(now: Date = new Date()): Promise<string | undefined> {
  const client = getOAuthClient();
  if (!client) return undefined;

  const db = getDb();
  const row = db
    .select()
    .from(lightspeedConnection)
    .where(eq(lightspeedConnection.id, CONNECTION_ID))
    .get();
  if (!row) return undefined;

  const fresh = row.accessTokenExpiresAt.getTime() - now.getTime() > REFRESH_SKEW_MS;
  if (fresh) return row.accessToken;

  logger.debug({ accountId: row.accountId }, "lightspeed access token stale; refreshing");
  const tokens = await refreshAccessToken(client, row.refreshToken);
  saveTokens(tokens);
  return tokens.accessToken;
}

/**
 * Disconnect: revoke the refresh token with Lightspeed (best-effort) and delete
 * the local connection row. Safe to call when not connected.
 */
export async function disconnect(): Promise<void> {
  const db = getDb();
  const row = db
    .select()
    .from(lightspeedConnection)
    .where(eq(lightspeedConnection.id, CONNECTION_ID))
    .get();
  if (!row) return;

  const client = getOAuthClient();
  if (client) {
    await revokeRefreshToken(client, row.refreshToken);
  }
  db.delete(lightspeedConnection).where(eq(lightspeedConnection.id, CONNECTION_ID)).run();
  logger.info({ accountId: row.accountId }, "lightspeed connection removed");
}
