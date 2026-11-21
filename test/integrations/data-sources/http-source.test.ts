import { beforeEach, describe, expect, it } from "vitest";
import { type DataSource, DataSourceSchema } from "../../../src/core/config.js";
import type { FetchLike } from "../../../src/integrations/apps/apps-net.js";
import { dataHandlers } from "../../../src/integrations/data-sources/data-sources.js";
import {
  type HttpDeps,
  baseUrlProblem,
  forgetLogin,
  formatHttpResult,
  getPath,
  httpGet,
  isAllowedPath,
  loginSecrets,
  loginUrlProblem,
  normalizeAllowedPath,
  resolveRequestUrl,
  summarizeJson,
} from "../../../src/integrations/data-sources/http-source.js";

const TOKEN = "api-token-0123456789abcdef";
const PASSWORD = "cms-password-!secret-42";

type Http = NonNullable<DataSource["http"]>;
const source = (http: Partial<Http> & { auth?: Http["auth"] } = {}, id = "ds-api"): DataSource =>
  DataSourceSchema.parse({
    id,
    name: "Product API",
    kind: "http",
    http: { baseUrl: "https://api.example.com/v1", allowedPaths: ["/stats", "/users"], auth: { type: "bearer", token: TOKEN }, ...http },
  });

interface Seen {
  method: string;
  url: URL;
  headers: Headers;
  body?: string;
}

/** A fake API behind the network guard: records each request and answers with `reply`. */
function fakeApi(reply: (req: Seen, init: RequestInit) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const req = { method: init.method ?? "GET", url: new URL(String(input)), headers: new Headers(init.headers), ...(typeof init.body === "string" ? { body: init.body } : {}) };
    seen.push(req);
    return reply(req, init);
  };
  return { fetch, seen };
}

/** The guard as in production (no test exemption), with DNS answered here. */
const guarded = (fetch: FetchLike, addresses = ["93.184.216.34"]): HttpDeps => ({ env: {}, fetch, lookup: async () => addresses });

beforeEach(() => {
  for (const id of ["ds-api", "ds-cms", "ds-cms-2", "ds-cms-3"]) forgetLogin(id);
});

describe("HTTP source paths", () => {
  const http = { baseUrl: "https://api.example.com/v1", allowedPaths: ["/stats", "/users"] };
  const refused = (path: string, h = http) => {
    try {
      resolveRequestUrl(h, path);
    } catch (err) {
      return (err as Error).message;
    }
    return "accepted";
  };

  it("adds the path and query to the base address, under the allowed paths", () => {
    expect(resolveRequestUrl(http, "/stats/signups?from=2026-11-16&to=2026-11-22").href).toBe("https://api.example.com/v1/stats/signups?from=2026-11-16&to=2026-11-22");
    expect(resolveRequestUrl(http, "stats").href).toBe("https://api.example.com/v1/stats");
    expect(resolveRequestUrl(http, "/users//42#top").href).toBe("https://api.example.com/v1/users/42");
    expect(resolveRequestUrl({ baseUrl: "https://api.example.com", allowedPaths: [] }, "/anything/at/all").href).toBe("https://api.example.com/anything/at/all");
  });

  it("refuses paths outside the allow list, segment by segment", () => {
    expect(refused("/admin")).toBe("/admin is not one of the paths allowed for this source (/stats, /users).");
    expect(refused("/statsecret")).toMatch(/not one of the paths allowed/);
    expect(refused("/")).toMatch(/not one of the paths allowed/);
    expect(isAllowedPath("/stats", ["/stats"])).toBe(true);
    expect(isAllowedPath("/stats/x", ["/stats"])).toBe(true);
    expect(isAllowedPath("/stats2", ["/stats"])).toBe(false);
    expect(isAllowedPath("/anything", ["/"])).toBe(true);
  });

  it("refuses traversal and any change of scheme or host", () => {
    expect(refused("/stats/../admin")).toBe('Paths may not contain "." or ".." segments.');
    expect(refused("/stats/./x")).toMatch(/"\." or "\.\."/);
    expect(refused("/stats/%2e%2e/admin")).toMatch(/encoded dots, slashes/);
    expect(refused("/stats%2F..%2Fadmin")).toMatch(/encoded dots, slashes/);
    expect(refused("/stats\\..\\admin")).toMatch(/backslashes/);
    expect(refused("/stats/a b")).toMatch(/spaces/);
    expect(refused("/stats?q=a b")).toMatch(/query may not contain spaces/);
    expect(refused("https://evil.example/stats")).toMatch(/not a full address/);
    expect(refused("//evil.example/stats")).toMatch(/not a full address/);
    expect(refused("javascript:alert(1)")).toMatch(/not a full address/);
    expect(refused("/stats/%zz")).toBe("The path has a broken %-escape.");
    expect(refused("")).toBe("Give a path, e.g. /api/stats.");
  });

  it("normalises the allowed paths the owner writes", () => {
    expect(normalizeAllowedPath(" stats/ ")).toEqual({ path: "/stats" });
    expect(normalizeAllowedPath("/api//v1/")).toEqual({ path: "/api/v1" });
    expect(normalizeAllowedPath("/")).toEqual({ path: "/" });
    expect(normalizeAllowedPath("/api/../admin")).toEqual({ error: '"/api/../admin": Paths may not contain "." or ".." segments.' });
    expect(normalizeAllowedPath("https://x.example/api")).toMatchObject({ error: expect.stringMatching(/is an address/) });
    expect(normalizeAllowedPath("/api?x=1")).toMatchObject({ error: expect.stringMatching(/leave the query out/) });
  });
});

describe("the network guard (apps-net) on HTTP sources", () => {
  it("checks base and sign-in addresses: https, no credentials, private only when internal", () => {
    expect(baseUrlProblem("http://api.example.com", false, {})).toBe("Use an https:// address.");
    expect(baseUrlProblem("https://user:pw@api.example.com", false, {})).toBe("Leave any user name or password out of the address.");
    expect(baseUrlProblem("https://api.example.com/v1?key=1", false, {})).toMatch(/Leave the query/);
    expect(baseUrlProblem("not a url", false, {})).toMatch(/not a valid address/);
    expect(baseUrlProblem("https://10.0.0.5/api", false, {})).toMatch(/private network\. If the API runs on your own network, turn on "Internal address"/);
    expect(baseUrlProblem("https://metadata.google.internal", false, {})).toMatch(/Internal address/);
    expect(baseUrlProblem("https://10.0.0.5/api", true, {})).toBeUndefined();
    expect(baseUrlProblem("https://10.0.0.5/api", false, { ALLOW_PRIVATE_APP_URLS: "1" })).toBeUndefined();
    expect(baseUrlProblem("https://api.example.com/v1", false, {})).toBeUndefined();
    expect(loginUrlProblem("/auth/login", false, {})).toBeUndefined();
    expect(loginUrlProblem("/auth/../admin", false, {})).toMatch(/\.\./);
    expect(loginUrlProblem("//evil.example/login", false, {})).toMatch(/in full/);
    expect(loginUrlProblem("http://cms.example.com/login", false, {})).toBe("Use an https:// address.");
    expect(loginUrlProblem("https://192.168.1.10/login", false, {})).toMatch(/Internal address/);
  });

  it("refuses a public name that resolves to a private address, unless the source is internal", async () => {
    const api = fakeApi(() => Response.json({ ok: true }));
    await expect(httpGet(source(), "/stats", guarded(api.fetch, ["10.1.2.3"]))).rejects.toThrow(/private network\. If the API runs on your own network/);
    await expect(httpGet(source(), "/stats", guarded(api.fetch, ["169.254.169.254"]))).rejects.toThrow(/private network/);
    expect(api.seen).toEqual([]);
    const r = await httpGet(source({ internal: true }), "/stats", guarded(api.fetch, ["10.1.2.3"]));
    expect(r.status).toBe(200);
    expect(api.seen).toHaveLength(1);
  });

  it("sends GET only, with the credential added on the server", async () => {
    const api = fakeApi(() => Response.json({ signups: 42 }));
    const r = await httpGet(source(), "/stats/signups?from=2026-11-16", guarded(api.fetch));
    expect(api.seen).toHaveLength(1);
    expect(api.seen[0]!.method).toBe("GET");
    expect(api.seen[0]!.url.href).toBe("https://api.example.com/v1/stats/signups?from=2026-11-16");
    expect(api.seen[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(r).toMatchObject({ path: "/stats/signups?from=2026-11-16", status: 200, contentType: "application/json", truncated: false, text: '{"signups":42}' });

    const basic = fakeApi(() => Response.json({}));
    await httpGet(source({ auth: { type: "basic", username: "reader", password: PASSWORD } }), "/stats", guarded(basic.fetch));
    expect(basic.seen[0]!.headers.get("authorization")).toBe(`Basic ${Buffer.from(`reader:${PASSWORD}`).toString("base64")}`);

    const header = fakeApi(() => Response.json({}));
    await httpGet(source({ auth: { type: "header", name: "X-API-Key", value: TOKEN } }), "/stats", guarded(header.fetch));
    expect(header.seen[0]!.headers.get("x-api-key")).toBe(TOKEN);
  });

  it("follows redirects only within the source's allowed paths", async () => {
    const within = fakeApi((req) => (req.url.pathname === "/v1/stats" ? new Response(null, { status: 302, headers: { location: "/v1/stats/" } }) : Response.json({ n: 1 })));
    expect((await httpGet(source(), "/stats", guarded(within.fetch))).path).toBe("/stats/");
    expect(within.seen.map((s) => s.url.pathname)).toEqual(["/v1/stats", "/v1/stats/"]);

    const outside = fakeApi(() => new Response(null, { status: 302, headers: { location: "/v1/admin/users" } }));
    await expect(httpGet(source(), "/stats", guarded(outside.fetch))).rejects.toThrow("The API redirected to /v1/admin/users, which is outside the paths allowed for this source.");

    const elsewhere = fakeApi(() => new Response(null, { status: 301, headers: { location: "https://evil.example/collect" } }));
    await expect(httpGet(source(), "/stats", guarded(elsewhere.fetch))).rejects.toThrow("The API redirected to evil.example; only api.example.com is read for this source.");
    expect(elsewhere.seen).toHaveLength(1);
  });
});

describe("signing in to an admin panel", () => {
  const login = (over: Record<string, unknown> = {}, id = "ds-cms") =>
    source(
      {
        baseUrl: "https://cms.example.com/api",
        allowedPaths: ["/reports"],
        auth: {
          type: "login",
          loginUrl: "/auth/login",
          username: "reports@example.com",
          password: PASSWORD,
          usernameField: "user.email",
          passwordField: "user.password",
          tokenPath: "data.accessToken",
          headerName: "Authorization",
          headerPrefix: "Bearer ",
          ...over,
        } as Http["auth"],
      },
      id,
    );

  it("signs in once, keeps the token, and signs in again once after a 401", async () => {
    let issued = 0;
    let valid = "";
    const api = fakeApi((req) => {
      if (req.url.pathname === "/auth/login") {
        valid = `jwt-token-${++issued}-abcdefghij`;
        return Response.json({ data: { accessToken: valid } });
      }
      return req.headers.get("authorization") === `Bearer ${valid}` ? Response.json({ users: 3 }) : new Response("expired", { status: 401 });
    });
    const s = login();
    expect((await httpGet(s, "/reports/users", guarded(api.fetch))).status).toBe(200);
    const signIn = api.seen[0]!;
    expect(signIn.method).toBe("POST");
    expect(signIn.url.href).toBe("https://cms.example.com/auth/login");
    expect(signIn.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(signIn.body!)).toEqual({ user: { email: "reports@example.com", password: PASSWORD } });
    expect(loginSecrets("ds-cms")).toEqual(["jwt-token-1-abcdefghij"]);

    // Kept: no second sign-in.
    await httpGet(s, "/reports/users", guarded(api.fetch));
    expect(api.seen.filter((r) => r.url.pathname === "/auth/login")).toHaveLength(1);

    // The API stops accepting the token: one new sign-in, and the request is sent again.
    valid = "rotated";
    const r = await httpGet(s, "/reports/users", guarded(api.fetch));
    expect(r.status).toBe(200);
    expect(api.seen.filter((x) => x.url.pathname === "/auth/login")).toHaveLength(2);
    expect(api.seen.at(-1)!.headers.get("authorization")).toBe("Bearer jwt-token-2-abcdefghij");
  });

  it("gives up after one new sign-in when the API still answers 401", async () => {
    const api = fakeApi((req) => (req.url.pathname === "/auth/login" ? Response.json({ data: { accessToken: "token-that-never-works" } }) : new Response("no", { status: 401 })));
    const r = await httpGet(login({}, "ds-cms-2"), "/reports", guarded(api.fetch));
    expect(r.status).toBe(401);
    expect(api.seen.map((x) => `${x.method} ${x.url.pathname}`)).toEqual(["POST /auth/login", "GET /api/reports", "POST /auth/login", "GET /api/reports"]);
  });

  it("says why a sign-in failed, without the password", async () => {
    const wrong = fakeApi(() => Response.json({ error: `bad password ${PASSWORD}` }, { status: 401 }));
    await expect(httpGet(login({}, "ds-cms-3"), "/reports", guarded(wrong.fetch))).rejects.toThrow(/Sign-in at cms\.example\.com\/auth\/login answered HTTP 401/);

    // The sign-in answer echoes the password: the tool result shows it redacted.
    const h = dataHandlers({ sources: [login({}, "ds-cms-3")], http: guarded(wrong.fetch) });
    const out = await h.data_http_get({ source: "Product API", path: "/reports" });
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out)).not.toContain(PASSWORD);
    expect(JSON.stringify(out)).toContain("bad password [redacted]");

    const noToken = fakeApi(() => Response.json({ data: { jwt: "x", user: { id: 1 } }, ok: true }));
    await expect(httpGet(login({}, "ds-cms-3"), "/reports", guarded(noToken.fetch))).rejects.toThrow(
      'Signed in, but the answer has no token at "data.accessToken". It has the fields data.jwt, data.user, ok: set the token path to the one holding the token, e.g. data.accessToken.',
    );
    expect(getPath({ a: [{ b: "t" }] }, "a.0.b")).toBe("t");
  });
});

describe("response limits and what the model sees", () => {
  it("reads at most 200 KB and says the rest was cut", async () => {
    const big = "x".repeat(300 * 1024);
    const api = fakeApi(() => new Response(big, { headers: { "content-type": "text/plain" } }));
    const r = await httpGet(source(), "/stats", guarded(api.fetch));
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBe(200 * 1024);
    const text = formatHttpResult(r);
    expect(text.split("\n")[0]).toBe("GET /stats → HTTP 200 · text/plain · 200 KB+");
    expect(text).toMatch(/larger than 200 KB: only the start was read/);
    expect(text.length).toBeLessThanOrEqual(20_000);
  });

  it("gives up after the time limit", async () => {
    const api = fakeApi(
      (_req, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const started = Date.now();
    await expect(httpGet(source(), "/stats", { ...guarded(api.fetch), timeoutMs: 80 })).rejects.toThrow("api.example.com did not answer within 1 s.");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("summarises large JSON: arrays cut, with their totals", () => {
    const users = Array.from({ length: 1_000 }, (_, i) => ({ id: i, email: `user${i}@example.com`, plan: i % 3 ? "free" : "pro" }));
    const s = summarizeJson({ total: 1_000, users }, 5_000);
    expect(s.cut).toBe(true);
    expect(s.text.length).toBeLessThanOrEqual(5_000);
    expect(s.text).toContain('"total":1000');
    expect(s.text).toMatch(/… \d+ more \(1000 items in all\)/);
    expect(summarizeJson({ a: 1 })).toEqual({ text: '{"a":1}', cut: false });

    const formatted = formatHttpResult({ path: "/users", status: 200, contentType: "application/json", bytes: 70_000, truncated: false, text: JSON.stringify(users) }, 4_000);
    expect(formatted).toMatch(/^GET \/users → HTTP 200 · application\/json · 68 KB\nLong arrays are cut to their first \d+ items/);
    expect(formatted.length).toBeLessThanOrEqual(4_000);
    expect(formatHttpResult({ path: "/", status: 200, contentType: "text/html", bytes: 40, truncated: false, text: "<html><body><h1>Sign in</h1></body></html>" })).toContain("Sign in");
    expect(formatHttpResult({ path: "/f", status: 200, contentType: "application/pdf", bytes: 4, truncated: false, text: "%PDF" })).toContain("(binary content, not shown)");
  });

  it("redacts the source's credentials and its sign-in token from what the model sees", async () => {
    const echo = fakeApi((req) => Response.json({ youSent: req.headers.get("authorization"), token: TOKEN }));
    const h = dataHandlers({ sources: [source()], http: guarded(echo.fetch) });
    const r = await h.data_http_get({ source: "ds-api", path: "/stats" });
    expect(r.isError).toBeFalsy();
    const text = (r.content[0] as { text: string }).text;
    expect(text).not.toContain(TOKEN);
    expect(text).toContain('"youSent":"Bearer [redacted]"');

    let token = "";
    const cms = fakeApi((req) => {
      if (req.url.pathname === "/login") return Response.json({ token: (token = "fresh-session-token-1234567") });
      return Response.json({ me: req.headers.get("authorization") });
    });
    const s = source({ auth: { type: "login", loginUrl: "https://api.example.com/login", username: "r", password: PASSWORD, usernameField: "email", passwordField: "password", tokenPath: "token", headerName: "Authorization", headerPrefix: "" } }, "ds-cms");
    const out = await dataHandlers({ sources: [s], http: guarded(cms.fetch) }).data_http_get({ source: "ds-cms", path: "/users" });
    expect(token).not.toBe("");
    expect(JSON.stringify(out)).not.toContain(token);
    expect(JSON.stringify(out)).toContain('\\"me\\":\\"[redacted]\\"');
  });

  it("returns an API error as a tool error, with the status", async () => {
    const api = fakeApi(() => Response.json({ message: "not found" }, { status: 404 }));
    const r = await dataHandlers({ sources: [source()], http: guarded(api.fetch) }).data_http_get({ source: "Product API", path: "/users/9" });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toBe('Product API: GET /users/9 → HTTP 404 · application/json · 23 B\n\n{"message":"not found"}');
  });
});
