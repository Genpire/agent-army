import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppConnectionSchema, ConfigRepo } from "../../src/core/config.js";
import { deriveKey } from "../../src/core/crypto.js";
import { FsStore } from "../../src/core/store.js";
import type { FetchLike } from "../../src/integrations/apps/apps-net.js";
import { completeAppSignIn, freshAccessToken, startAppSignIn, withOfflineAccess } from "../../src/integrations/apps/apps-oauth.js";

/**
 * An app's OAuth sign-in outside tests (env {}): discovery, registration and
 * the code exchange go through the network guard, and the sign-in page must
 * be https. Each with the case that passes next to the one that is refused.
 */

const BASE = "https://army.example.com";
const PUBLIC = ["93.184.216.34"];
const PRIVATE = ["10.0.0.5"];

/** An authorization server whose sign-in page is at `authorize`. */
function fakeAuthServer(authorize = "https://auth.example.com/authorize"): FetchLike {
  return async (input, init) => {
    const u = new URL(String(input));
    if (u.host === "mcp.example.com" && u.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({ resource: "https://mcp.example.com/mcp", authorization_servers: ["https://auth.example.com"] });
    }
    if (u.host !== "auth.example.com") return new Response("not found", { status: 404 });
    if (u.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: "https://auth.example.com",
        authorization_endpoint: authorize,
        token_endpoint: "https://auth.example.com/token",
        registration_endpoint: "https://auth.example.com/register",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (u.pathname === "/register") return Response.json({ ...(JSON.parse(String(init?.body)) as object), client_id: "client-1" }, { status: 201 });
    if (u.pathname === "/token") return Response.json({ access_token: "access-token-1", refresh_token: "refresh-token-1", expires_in: 3600, token_type: "Bearer" });
    return new Response("not found", { status: 404 });
  };
}

async function repoWithApp(): Promise<ConfigRepo> {
  const repo = new ConfigRepo(new FsStore(await mkdtemp(join(tmpdir(), "army-checks-oauth-"))), deriveKey("k"), 0);
  await repo.update((c) => {
    c.apps = [AppConnectionSchema.parse({ id: "app-tracker", name: "Tracker", url: "https://mcp.example.com/mcp", auth: { type: "oauth", oauth: {} } })];
  });
  return repo;
}

describe("app sign-in through the network guard", () => {
  it("starts a sign-in when the app's servers are public, and refuses one whose servers resolve to a private address", async () => {
    const configRepo = await repoWithApp();
    const fetch = fakeAuthServer();
    const url = await startAppSignIn("app-tracker", { configRepo, baseUrl: BASE, fetch, env: {}, lookup: async () => PUBLIC });
    expect(new URL(url).origin).toBe("https://auth.example.com");
    await expect(startAppSignIn("app-tracker", { configRepo, baseUrl: BASE, fetch, env: {}, lookup: async () => PRIVATE })).rejects.toThrow();
  });

  it("exchanges the code only with a public token endpoint", async () => {
    const fetch = fakeAuthServer();
    for (const [answer, ok] of [
      [PUBLIC, true],
      [PRIVATE, false],
    ] as const) {
      const configRepo = await repoWithApp();
      const state = new URL(await startAppSignIn("app-tracker", { configRepo, baseUrl: BASE, fetch, env: {}, lookup: async () => PUBLIC })).searchParams.get("state")!;
      const done = completeAppSignIn({ state, code: "good-code" }, { configRepo, baseUrl: BASE, fetch, env: {}, lookup: async () => answer });
      if (ok) await expect(done).resolves.toEqual({ appId: "app-tracker" });
      else await expect(done).rejects.toMatchObject({ reason: "failed" });
    }
  });
});

describe("a sign-in that renews itself", () => {
  it("asks Google for a refresh token, even when the owner approved the app before", () => {
    const url = withOfflineAccess(new URL("https://accounts.google.com/o/oauth2/v2/auth?client_id=c&scope=openid&prompt=select_account"));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe("openid");
  });

  it("adds offline_access only where the server lists it, and only to a scope list", () => {
    const listed = { authorizationServerMetadata: { scopes_supported: ["read", "offline_access"] } };
    expect(withOfflineAccess(new URL("https://auth.example.com/a?scope=read"), listed).searchParams.get("scope")).toBe("read offline_access");
    expect(withOfflineAccess(new URL("https://auth.example.com/a?scope=read+offline_access"), listed).searchParams.get("scope")).toBe("read offline_access");
    // No scope asked for: adding one could narrow the grant.
    expect(withOfflineAccess(new URL("https://auth.example.com/a"), listed).searchParams.has("scope")).toBe(false);
    // Not listed: unchanged.
    expect(withOfflineAccess(new URL("https://auth.example.com/a?scope=read"), { authorizationServerMetadata: { scopes_supported: ["read"] } }).href).toBe("https://auth.example.com/a?scope=read");
  });

  it("keeps the refresh token when a renewal does not send a new one", async () => {
    const configRepo = await repoWithApp();
    let renewals = 0;
    const base = fakeAuthServer();
    // Like Google: the renewal answers with a new access token and no refresh token.
    const fetch: FetchLike = async (input, init) => {
      const u = new URL(String(input));
      if (u.host === "auth.example.com" && u.pathname === "/token" && String(init?.body).includes("grant_type=refresh_token")) {
        renewals++;
        return Response.json({ access_token: `access-renewed-${renewals}`, expires_in: 3600, token_type: "Bearer" });
      }
      return base(input, init);
    };
    const deps = { configRepo, baseUrl: BASE, fetch, env: {}, lookup: async () => PUBLIC };
    const state = new URL(await startAppSignIn("app-tracker", deps)).searchParams.get("state")!;
    await completeAppSignIn({ state, code: "good-code" }, deps);
    let clock = Date.now();
    for (const n of [1, 2]) {
      // An hour later the access token has expired: it is renewed with the same refresh token.
      clock += 2 * 3600_000;
      const app = (await configRepo.load(true)).apps.find((a) => a.id === "app-tracker")!;
      expect(await freshAccessToken(app, { ...deps, now: () => clock })).toBe(`access-renewed-${n}`);
      const saved = (await configRepo.load(true)).apps.find((a) => a.id === "app-tracker")!;
      expect(saved.auth.type === "oauth" && saved.auth.oauth.tokens?.refresh_token).toBe("refresh-token-1");
    }
    expect(renewals).toBe(2);
  });
});

describe("app sign-in page", () => {
  it("refuses a sign-in page that is not https, outside tests and local development", async () => {
    const configRepo = await repoWithApp();
    const deps = { configRepo, baseUrl: BASE, env: {}, lookup: async () => PUBLIC };
    await expect(startAppSignIn("app-tracker", { ...deps, fetch: fakeAuthServer("http://auth.example.com/authorize") })).rejects.toThrow(
      "Tracker's sign-in page is not on an https:// address.",
    );
    await expect(startAppSignIn("app-tracker", { ...deps, fetch: fakeAuthServer("https://auth.example.com/authorize") })).resolves.toMatch(/^https:\/\/auth\.example\.com\/authorize\?/);
  });
});
