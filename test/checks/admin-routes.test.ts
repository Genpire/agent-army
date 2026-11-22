import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server.js";

/**
 * Every route of the admin API needs a session (requireAdmin), except the
 * few the sign-in and the OAuth callback need. The routes are read from the
 * app itself, so a new route that forgets requireAdmin is noticed here
 * without anyone adding it to a list.
 */

/** The /api routes that answer without a session, and why. */
const PUBLIC = new Set([
  "GET /api/state", // says whether to show setup or sign-in; the config only with a session
  "POST /api/setup", // the setup token is the check
  "POST /api/reset-password", // the setup token is the check
  "POST /api/login", // the password is the check
  "POST /api/logout",
  "GET /api/apps/oauth/callback", // the vendor's redirect back; the single-use state is the check
  "GET /api/apps/oauth/client-metadata.json", // public by design (OAuth client id metadata)
]);

interface RouteLayer {
  route?: { path: unknown; methods: Record<string, boolean> };
  handle?: { stack?: RouteLayer[] };
}

/** Every route of a router, sub-routers included, as "METHOD /path". */
function routesOf(stack: RouteLayer[]): string[] {
  return stack.flatMap((layer) => {
    if (layer.route && typeof layer.route.path === "string") {
      const path = layer.route.path;
      return Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${path}`);
    }
    return layer.handle?.stack ? routesOf(layer.handle.stack) : [];
  });
}

describe("admin API sessions", () => {
  let base = "";
  let close: () => void;
  let routes: string[] = [];

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "army-checks-admin-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-acme-123", RUNNER: "local" });
    routes = routesOf((app as unknown as { router: { stack: RouteLayer[] } }).router.stack).filter((r) => r.split(" ")[1]!.startsWith("/api/"));
    const server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    // An admin account exists, so a missing session is the only thing wrong with the requests below.
    expect((await fetch(`${base}/api/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupToken: "setup-acme-123", password: "longpassword1" }) })).status).toBe(200);
  });
  afterAll(() => close());

  it("finds the admin API's routes, the public ones among them", () => {
    expect(routes.length).toBeGreaterThan(80);
    for (const route of PUBLIC) expect(routes, route).toContain(route);
  });

  it("answers 401 to every other route without a session, and with a forged one", async () => {
    const open: string[] = [];
    for (const route of routes.filter((r) => !PUBLIC.has(r))) {
      const [method, pattern] = route.split(" ") as [string, string];
      const path = pattern.replace(/:\w+/g, "x").replace(/\*\w+/g, "x");
      for (const cookie of [undefined, "army_session=9999999999999.forged"]) {
        const res = await fetch(base + path, {
          method,
          headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
          ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
        });
        if (res.status !== 401) open.push(`${route} (${cookie ? "forged" : "no"} session): ${res.status}`);
      }
    }
    expect(open).toEqual([]);
  });

  it("finds the session among other cookies, and only under its own name", async () => {
    const signIn = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "longpassword1" }) });
    const session = signIn.headers.get("set-cookie")!.split(";")[0]!;
    const value = session.slice(session.indexOf("=") + 1);
    const tasks = (cookie: string) => fetch(`${base}/api/tasks`, { headers: { cookie } });
    expect((await tasks(session)).status).toBe(200);
    expect((await tasks(`theme=dark; ${session}; lang=en`)).status).toBe(200);
    expect((await tasks(`other_session=${value}`)).status).toBe(401);
    expect((await tasks(`army_session=${value}x`)).status).toBe(401);
  });

  it("answers the public routes without a session", async () => {
    expect((await fetch(`${base}/api/state`)).status).toBe(200);
    expect((await fetch(`${base}/api/apps/oauth/client-metadata.json`)).status).toBe(200);
    expect((await fetch(`${base}/api/logout`, { method: "POST" })).status).toBe(200);
  });
});
