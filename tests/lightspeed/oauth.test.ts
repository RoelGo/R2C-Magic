import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OAuthError,
  accountIdFromAccessToken,
  buildAuthorizeUrl,
  createPkce,
  createState,
  exchangeCodeForTokens,
  refreshAccessToken,
} from "../../src/lib/lightspeed/oauth";

/** Build an unsigned JWT-shaped token with the given payload (header.payload.sig). */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url").replace(/=+$/, "");
  return `${b64({ typ: "JWT", alg: "RS256" })}.${b64(payload)}.sig`;
}

const client = { clientId: "abc", clientSecret: "shh" };

describe("lightspeed/oauth — PKCE + state", () => {
  it("creates an S256 challenge from the verifier", () => {
    const { verifier, challenge } = createPkce();
    // base64url characters only, verifier within 43–128 chars.
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).not.toBe(verifier);
  });

  it("produces unique verifiers and states", () => {
    expect(createPkce().verifier).not.toBe(createPkce().verifier);
    expect(createState()).not.toBe(createState());
  });
});

describe("lightspeed/oauth — buildAuthorizeUrl", () => {
  it("includes all required OAuth + PKCE params", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "cid",
        scope: "employee:all",
        state: "st",
        codeChallenge: "chal",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://cloud.lightspeedapp.com/auth/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("scope")).toBe("employee:all");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("code_challenge")).toBe("chal");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("lightspeed/oauth — accountIdFromAccessToken", () => {
  it("extracts the acct claim", () => {
    expect(accountIdFromAccessToken(fakeJwt({ acct: "12345" }))).toBe("12345");
    // numeric acct is coerced to string
    expect(accountIdFromAccessToken(fakeJwt({ acct: 678 }))).toBe("678");
  });

  it("returns undefined for a non-JWT or missing acct", () => {
    expect(accountIdFromAccessToken("not-a-jwt")).toBeUndefined();
    expect(accountIdFromAccessToken(fakeJwt({ sub: "1" }))).toBeUndefined();
  });
});

describe("lightspeed/oauth — token HTTP calls", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function okTokenResponse() {
    return new Response(
      JSON.stringify({
        token_type: "Bearer",
        expires_in: 3600,
        access_token: "access-1",
        refresh_token: "refresh-1",
        scope: "employee:all",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  it("exchanges a code for tokens and posts the right body", async () => {
    fetchMock.mockResolvedValueOnce(okTokenResponse());
    const tokens = await exchangeCodeForTokens(client, {
      code: "the-code",
      codeVerifier: "the-verifier",
    });

    expect(tokens).toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresIn: 3600,
      scope: "employee:all",
    });
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("fetch not called");
    const [url, init] = call;
    expect(url).toBe("https://cloud.lightspeedapp.com/auth/oauth/token");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      client_id: "abc",
      client_secret: "shh",
      grant_type: "authorization_code",
      code: "the-code",
      code_verifier: "the-verifier",
    });
    // Lightspeed's token endpoint rejects redirect_uri — it must NOT be sent.
    expect(body).not.toHaveProperty("redirect_uri");
  });

  it("refreshes using grant_type=refresh_token", async () => {
    fetchMock.mockResolvedValueOnce(okTokenResponse());
    await refreshAccessToken(client, "old-refresh");
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body);
    expect(body).toMatchObject({ grant_type: "refresh_token", refresh_token: "old-refresh" });
  });

  it("throws OAuthError with the hint on a 400", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant", hint: "code expired" }), {
          status: 400,
        }),
    );
    await expect(refreshAccessToken(client, "x")).rejects.toThrow(OAuthError);
    await expect(refreshAccessToken(client, "x")).rejects.toThrow(/code expired/);
  });

  it("throws OAuthError on a malformed success body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 }),
    );
    await expect(refreshAccessToken(client, "x")).rejects.toThrow(/expected shape/);
  });

  it("wraps network failures", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(refreshAccessToken(client, "x")).rejects.toThrow(/Could not reach/);
  });
});
