import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newSourceId } from "../../../src/routes/data-sources.js";
import { createApp } from "../../../src/server.js";

const TOKEN = "route-test-api-token-0123456789";
const NEW_TOKEN = "route-test-api-token-rotated-9876";
const PASSWORD = "route-test-cms-password-42";
const PG_PASSWORD = "route-test-pg-password";
const API = "https://api.example.com";

/** The company data admin routes through the real HTTP API (the company's API faked). */
describe("Company data admin API", () => {
  let base = "";
  let close: () => void;
  let cookie = "";
  const post = (path: string, body: unknown, withCookie = true) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(withCookie && cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const get = (path: string, withCookie = true) => fetch(base + path, { headers: withCookie && cookie ? { cookie } : {} });
  const state = async () => (await get("/api/state")).json();
  const error = async (path: string, input: unknown) => {
    const res = await post(path, input);
    return { status: res.status, error: (await res.json()).error as string };
  };

  /** What the fake API received, and what it answers. */
  const received: { path: string; auth: string | null }[] = [];
  let answer: (path: string, auth: string | null) => Response = () => Response.json({ ok: true });

  beforeAll(async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (!url.hostname.endsWith(".example.com")) return realFetch(input, init);
      const auth = new Headers(init?.headers).get("authorization");
      received.push({ path: url.pathname + url.search, auth });
      return answer(url.pathname, auth);
    });
    const dir = await mkdtemp(join(tmpdir(), "army-data-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" });
    const server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const res = await post("/api/setup", { setupToken: "setup-123", password: "longpassword1" });
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterAll(() => {
    close();
    vi.unstubAllGlobals();
  });

  it("is admin only", async () => {
    expect((await get("/api/data-sources", false)).status).toBe(401);
    expect((await post("/api/data-sources", { name: "x", kind: "http" }, false)).status).toBe(401);
    expect((await post("/api/data-sources/ds-x", {}, false)).status).toBe(401);
    expect((await post("/api/data-sources/ds-x/test", {}, false)).status).toBe(401);
    expect((await post("/api/data-sources/ds-x/delete", {}, false)).status).toBe(401);
  });

  it("validates what is added", async () => {
    const http = (h: Record<string, unknown>) => ({ name: "API", kind: "http", http: { baseUrl: `${API}/v1`, auth: { type: "none" }, ...h } });
    expect(await error("/api/data-sources", { kind: "http" })).toEqual({ status: 400, error: "Invalid input: expected string, received undefined" });
    expect(await error("/api/data-sources", { name: "API", kind: "mysql" })).toEqual({ status: 400, error: "Choose HTTP or Postgres." });
    expect(await error("/api/data-sources", { name: "API", kind: "http" })).toEqual({ status: 400, error: "Give the API's address." });
    expect(await error("/api/data-sources", http({ baseUrl: "http://api.example.com" }))).toEqual({ status: 400, error: "Use an https:// address." });
    expect(await error("/api/data-sources", http({ allowedPaths: ["/stats/../admin"] }))).toEqual({ status: 400, error: '"/stats/../admin": Paths may not contain "." or ".." segments.' });
    expect(await error("/api/data-sources", http({ auth: { type: "bearer", token: "" } }))).toEqual({ status: 400, error: "Paste the API token." });
    expect(await error("/api/data-sources", http({ auth: { type: "header", name: "X Key", value: "v" } }))).toEqual({ status: 400, error: "Header names use letters, digits and dashes." });
    expect(await error("/api/data-sources", http({ auth: { type: "login", loginUrl: "http://cms.example.com/login", username: "r", password: "p" } }))).toEqual({
      status: 400,
      error: "Sign-in address: Use an https:// address.",
    });
    expect(await error("/api/data-sources", { name: "DB", kind: "postgres", postgres: { connectionString: "mysql://x" } })).toEqual({
      status: 400,
      error: "The connection string must start with postgres:// or postgresql://.",
    });
    expect(await error("/api/data-sources", { name: "DB", kind: "postgres", postgres: { connectionString: "host=db user=x" } })).toEqual({
      status: 400,
      error: "Give the connection string as a URL: postgres://user:password@host:5432/database?sslmode=require.",
    });
    expect(await error("/api/data-sources", { name: "DB", kind: "postgres", postgres: { connectionString: "postgres://u:p@db.example.com/app", schemas: ["bad name"] } })).toEqual({
      status: 400,
      error: "Schema names use letters, digits and _, and start with a letter.",
    });
    expect((await state()).config.dataSources).toEqual([]);
  });

  it("adds an HTTP source and never shows its token", async () => {
    const res = await post("/api/data-sources", {
      name: "Product API",
      description: "Sign-ups and subscriptions",
      kind: "http",
      http: { baseUrl: `${API}/v1/`, auth: { type: "bearer", token: ` ${TOKEN} ` }, allowedPaths: ["stats/", "/users", "/users"] },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.source).toEqual({
      id: "ds-product-api",
      name: "Product API",
      description: "Sign-ups and subscriptions",
      kind: "http",
      enabled: true,
      checkedAt: null,
      http: { baseUrl: `${API}/v1`, allowedPaths: ["/stats", "/users"], internal: false, auth: { type: "bearer", token: "••••6789" } },
      postgres: null,
    });
    const all = JSON.stringify([body, await state(), await (await get("/api/data-sources")).json()]);
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(TOKEN.slice(0, 20));
  });

  it("tests a source with a sample request, and shows a short preview without the token", async () => {
    answer = (_path, auth) => Response.json({ signups: 42, echo: auth });
    const res = await post("/api/data-sources/ds-product-api/test", {});
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.preview).toMatch(/^GET \/stats → HTTP 200 · application\/json · \d+ B\n\n\{"signups":42,"echo":"Bearer \[redacted\]"\}$/);
    expect(body.warnings).toEqual([]);
    expect(received.at(-1)).toEqual({ path: "/v1/stats", auth: `Bearer ${TOKEN}` });
    expect((await state()).config.dataSources[0].checkedAt).toBe(body.checkedAt);

    answer = () => Response.json({ message: `nope ${TOKEN}` }, { status: 403 });
    expect(await error("/api/data-sources/ds-product-api/test", {})).toEqual({ status: 400, error: 'The API answered HTTP 403 for /stats: {"message":"nope [redacted]"}' });
    expect(await error("/api/data-sources/ds-product-api/test", { path: "/admin" })).toEqual({
      status: 400,
      error: "/admin is not one of the paths allowed for this source (/stats, /users).",
    });
    answer = () => Response.json({ ok: true });
  });

  it("keeps the saved token when none is sent, only while it goes to the same address", async () => {
    const update = (http: Record<string, unknown>) =>
      post("/api/data-sources/ds-product-api", { name: "Product API v1", http: { baseUrl: `${API}/v1`, auth: { type: "bearer", token: "" }, allowedPaths: ["/stats"], ...http } });
    const res = await update({});
    expect(res.status).toBe(200);
    expect((await res.json()).source).toMatchObject({ name: "Product API v1", checkedAt: null, http: { allowedPaths: ["/stats"], auth: { token: "••••6789" } } });
    await post("/api/data-sources/ds-product-api/test", {});
    expect(received.at(-1)?.auth).toBe(`Bearer ${TOKEN}`);

    // Another host: the token must be entered again.
    expect(await error("/api/data-sources/ds-product-api", { http: { baseUrl: "https://other.example.com", auth: { type: "bearer", token: "" } } })).toEqual({
      status: 400,
      error: "The address changed: enter the credential again (a saved one is only sent where it was sent before).",
    });
    // Another auth type: its credential is needed.
    expect(await error("/api/data-sources/ds-product-api", { http: { baseUrl: `${API}/v1`, auth: { type: "header", name: "X-API-Key", value: "" } } })).toEqual({
      status: 400,
      error: "Give the value of the X-API-Key header.",
    });

    // A new token replaces it.
    expect((await update({ auth: { type: "bearer", token: NEW_TOKEN } })).status).toBe(200);
    await post("/api/data-sources/ds-product-api/test", {});
    expect(received.at(-1)?.auth).toBe(`Bearer ${NEW_TOKEN}`);

    // Name and on/off alone keep everything.
    expect((await post("/api/data-sources/ds-product-api", { enabled: false })).status).toBe(200);
    expect((await state()).config.dataSources[0]).toMatchObject({ enabled: false, http: { auth: { type: "bearer", token: "••••9876" } } });
    expect(JSON.stringify(await state())).not.toContain(NEW_TOKEN);
    expect((await post("/api/data-sources/ds-product-api", { postgres: { connectionString: "postgres://u:p@h/db" } })).status).toBe(400);
  });

  it("keeps a sign-in password, and a Postgres connection string, without showing either", async () => {
    const res = await post("/api/data-sources", {
      name: "CMS",
      kind: "http",
      http: { baseUrl: "https://cms.example.com/api", auth: { type: "login", loginUrl: "/auth/login", username: "reports@example.com", password: PASSWORD, tokenPath: "data.token" } },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).source.http.auth).toEqual({
      type: "login",
      loginUrl: "/auth/login",
      username: "reports@example.com",
      password: "••••d-42",
      usernameField: "email",
      passwordField: "password",
      tokenPath: "data.token",
      headerName: "Authorization",
      headerPrefix: "Bearer ",
    });
    const kept = await post("/api/data-sources/ds-cms", {
      http: { baseUrl: "https://cms.example.com/api", auth: { type: "login", loginUrl: "https://cms.example.com/auth/login", username: "reports@example.com", password: "", tokenPath: "token" } },
    });
    expect(kept.status).toBe(200);
    expect((await kept.json()).source.http.auth).toMatchObject({ password: "••••d-42", tokenPath: "token", loginUrl: "https://cms.example.com/auth/login" });

    const pg = await post("/api/data-sources", {
      name: "App DB",
      kind: "postgres",
      postgres: { connectionString: `postgres://reader:${PG_PASSWORD}@db.example.com:5432/app?sslmode=require`, schemas: ["public", "analytics", "public"] },
    });
    expect(pg.status).toBe(200);
    expect((await pg.json()).source).toMatchObject({ id: "ds-app-db", kind: "postgres", http: null, postgres: { configured: true, address: "reader@db.example.com:5432/app", schemas: ["public", "analytics"] } });
    // Schemas alone: the connection string stays.
    expect((await post("/api/data-sources/ds-app-db", { postgres: { connectionString: "", schemas: ["public"] } })).status).toBe(200);
    expect((await state()).config.dataSources.find((d: { id: string }) => d.id === "ds-app-db").postgres).toEqual({ configured: true, address: "reader@db.example.com:5432/app", schemas: ["public"] });

    const everything = JSON.stringify([await state(), await (await get("/api/data-sources")).json()]);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(PG_PASSWORD);
  });

  it("removes a source", async () => {
    expect((await post("/api/data-sources/ds-cms/delete", {})).status).toBe(200);
    expect((await state()).config.dataSources.map((d: { id: string }) => d.id)).toEqual(["ds-product-api", "ds-app-db"]);
    expect(await error("/api/data-sources/ds-cms/delete", {})).toEqual({ status: 404, error: "No such source." });
    expect(await error("/api/data-sources/ds-cms/test", {})).toEqual({ status: 404, error: "No such source." });
    expect(await error("/api/data-sources/not-an-id", {})).toEqual({ status: 404, error: "No such source." });
  });

  it("makes ids from names", () => {
    expect(newSourceId("Product API", new Set())).toBe("ds-product-api");
    expect(newSourceId("Product API", new Set(["ds-product-api"]))).toBe("ds-product-api-2");
    expect(newSourceId("!", new Set())).toBe("ds-x-source");
    expect(newSourceId("מסד נתונים", new Set())).toBe("ds-x-source");
  });
});
