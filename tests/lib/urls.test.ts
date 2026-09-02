import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `publicUrl` / `publicOrigin` build redirect URLs against the app's public
 * origin. `config` reads env once at import, so each test sets env then
 * `vi.resetModules()` before importing the helper (the codebase's opt-in env
 * pattern).
 */
describe("lib/urls", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("uses APP_BASE_URL when set, ignoring the request host", async () => {
    process.env.APP_BASE_URL = "https://intake.rokko.coop";
    vi.resetModules();
    const { publicUrl } = await import("../../src/lib/urls");

    const url = publicUrl(
      "/settings/lightspeed",
      new Request("http://0.0.0.0:3000/api/lightspeed/callback?code=x"),
    );
    expect(url.origin).toBe("https://intake.rokko.coop");
    expect(url.pathname).toBe("/settings/lightspeed");
  });

  it("preserves an existing query on the target path", async () => {
    process.env.APP_BASE_URL = "https://intake.rokko.coop";
    vi.resetModules();
    const { publicUrl } = await import("../../src/lib/urls");

    const url = publicUrl(
      "/settings/lightspeed?status=connected",
      new Request("http://0.0.0.0:3000/"),
    );
    expect(url.toString()).toBe("https://intake.rokko.coop/settings/lightspeed?status=connected");
  });

  it("falls back to the request origin when APP_BASE_URL is unset", async () => {
    process.env.APP_BASE_URL = undefined;
    vi.resetModules();
    const { publicUrl, publicOrigin } = await import("../../src/lib/urls");

    const url = publicUrl("/settings/lightspeed", new Request("http://localhost:3001/api/x"));
    expect(url.origin).toBe("http://localhost:3001");
    expect(publicOrigin()).toBeUndefined();
  });

  it("publicOrigin returns the configured origin (scheme + host only)", async () => {
    process.env.APP_BASE_URL = "https://intake.rokko.coop/some/path";
    vi.resetModules();
    const { publicOrigin } = await import("../../src/lib/urls");
    expect(publicOrigin()).toBe("https://intake.rokko.coop");
  });
});
