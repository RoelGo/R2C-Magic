import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTmpEnv } from "../helpers/tmp-env";

/**
 * Slice F — Lightspeed connection persistence + token refresh.
 *
 * Uses the hermetic tmp DB/env, then opts into Lightspeed configuration by
 * setting the client env vars and re-importing modules (config reads env once
 * at import). The OAuth HTTP layer is mocked via a stubbed global fetch, so no
 * network calls are made.
 */
function fakeJwt(acct: string): string {
  const b64 = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url").replace(/=+$/, "");
  return `${b64({ typ: "JWT" })}.${b64({ acct })}.sig`;
}

function tokenResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return new Response(
    JSON.stringify({
      token_type: "Bearer",
      expires_in: 3600,
      access_token: fakeJwt("acct-9"),
      refresh_token: "refresh-new",
      scope: "employee:all",
      ...overrides,
    }),
    { status: 200 },
  );
}

describe("lib/lightspeed/connection", () => {
  useTmpEnv();

  const fetchMock = vi.fn();

  beforeEach(() => {
    const env = process.env as Record<string, string | undefined>;
    env.LIGHTSPEED_CLIENT_ID = "cid";
    env.LIGHTSPEED_CLIENT_SECRET = "secret";
    env.LIGHTSPEED_REDIRECT_URI = "https://app.test/api/lightspeed/callback";
    vi.resetModules();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports not-connected but configured before any handshake", async () => {
    const { getConnectionStatus, isLightspeedConfigured } = await import(
      "../../src/lib/lightspeed/connection"
    );
    expect(isLightspeedConfigured()).toBe(true);
    const status = getConnectionStatus();
    expect(status).toMatchObject({ configured: true, connected: false });
  });

  it("saves tokens and derives the account id from the JWT", async () => {
    const { saveTokens, getConnectionStatus } = await import("../../src/lib/lightspeed/connection");
    saveTokens({
      accessToken: fakeJwt("acct-42"),
      refreshToken: "r1",
      expiresIn: 3600,
      scope: "employee:all",
    });
    const status = getConnectionStatus();
    expect(status.connected).toBe(true);
    expect(status.accountId).toBe("acct-42");
    expect(status.scope).toBe("employee:all");
  });

  it("rejects tokens without an account id", async () => {
    const { saveTokens } = await import("../../src/lib/lightspeed/connection");
    expect(() =>
      saveTokens({ accessToken: "not-a-jwt", refreshToken: "r", expiresIn: 60 }),
    ).toThrow(/account id/);
  });

  it("returns the stored token when it is still fresh", async () => {
    const { saveTokens, getValidAccessToken } = await import("../../src/lib/lightspeed/connection");
    saveTokens({ accessToken: fakeJwt("a"), refreshToken: "r1", expiresIn: 3600 });
    const token = await getValidAccessToken();
    expect(token).toBe(fakeJwt("a"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes (and rotates) when the token is near expiry", async () => {
    const { saveTokens, getValidAccessToken, getConnectionStatus } = await import(
      "../../src/lib/lightspeed/connection"
    );
    // Store a token that expires in 60s — inside the 5-min refresh skew.
    saveTokens({ accessToken: fakeJwt("a"), refreshToken: "old-refresh", expiresIn: 60 });
    fetchMock.mockResolvedValueOnce(tokenResponse());

    const token = await getValidAccessToken();
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body);
    expect(body).toMatchObject({ grant_type: "refresh_token", refresh_token: "old-refresh" });
    expect(token).toBe(fakeJwt("acct-9"));
    // The rotated refresh token is persisted (account id updated too).
    expect(getConnectionStatus().accountId).toBe("acct-9");
  });

  it("returns undefined when not connected", async () => {
    const { getValidAccessToken } = await import("../../src/lib/lightspeed/connection");
    expect(await getValidAccessToken()).toBeUndefined();
  });

  it("disconnect revokes and removes the connection", async () => {
    const { saveTokens, disconnect, getConnectionStatus } = await import(
      "../../src/lib/lightspeed/connection"
    );
    saveTokens({ accessToken: fakeJwt("a"), refreshToken: "r1", expiresIn: 3600 });
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));

    await disconnect();
    // Revocation was attempted.
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://cloud.lightspeedapp.com/auth/oauth/revoke");
    expect(getConnectionStatus().connected).toBe(false);
  });
});

describe("lib/lightspeed/connection — unconfigured", () => {
  useTmpEnv();

  it("reports not configured when env is absent", async () => {
    // useTmpEnv does not set LIGHTSPEED_* — config leaves them undefined.
    vi.resetModules();
    const { isLightspeedConfigured, getConnectionStatus, getValidAccessToken } = await import(
      "../../src/lib/lightspeed/connection"
    );
    expect(isLightspeedConfigured()).toBe(false);
    expect(getConnectionStatus().configured).toBe(false);
    expect(await getValidAccessToken()).toBeUndefined();
  });
});
