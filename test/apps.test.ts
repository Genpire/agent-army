import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { APP_CATALOG, APP_CATEGORIES } from "../src/apps-catalog.js";
import { type FetchLike, AppUrlError, appUrlProblem, assertPublicUrl, guardedFetch, guardedLookup, isBlockedAddress, pinnedFetch } from "../src/apps-net.js";
import { AppSignInError, OAUTH_STATE_TTL_MS, SignInCallbackError, completeAppSignIn, freshAccessToken, startAppSignIn } from "../src/apps-oauth.js";
import { REGISTRY_CACHE_TTL_MS, searchRegistry } from "../src/apps-registry.js";
import { AppProxy, PROXY_KEY_HEADER } from "../src/apps-proxy.js";
import {
  EXPIRED_IN_TASK,
  allowedToolsOf,
  appChatIntegrations,
  appToolName,
  listAppTools,
  mcpServerConfig,
  readOnlyToolsOf,
  refreshAppsForTask,
  removeApp,
  repoTaskApps,
  setAppAgents,
} from "../src/apps.js";
import { type AppConnection, AppConnectionSchema, type Config, ConfigRepo, ConfigSchema } from "../src/core/config.js";
import { deriveKey } from "../src/core/crypto.js";
import { newAppId } from "../src/routes/apps.js";
import { createApp } from "../src/server.js";
import { FsStore } from "../src/core/store.js";
import { TaskRepo, WEB_CHANNEL } from "../src/tasks.js";
import { startThreadTask } from "../src/thread-task.js";
import { defaultTeam } from "../src/team/team.js";

const PUBLIC = { env: {} as NodeJS.ProcessEnv };
const redact = (s: string) => s;

const TOOLS = [
  { name: "search_issues", description: "Search issues", annotations: { readOnlyHint: true } },
  { name: "get_issue", description: "Get one issue", annotations: { readOnlyHint: true } },
  { name: "create_issue", description: "Create an issue" },
  { name: "delete.issue", description: "Delete an issue", annotations: { readOnlyHint: false, destructiveHint: true } },
];

const app = (patch: Partial<AppConnection> = {}): AppConnection =>
  AppConnectionSchema.parse({
    id: "app-linear",
    name: "Linear",
    presetId: "linear",
    url: "https://mcp.example.com/mcp",
    auth: { type: "bearer", token: "lin_api_secret_key_123456" },
    access: "read",
    tools: [
      { name: "search_issues", readOnly: true },
      { name: "get_issue", readOnly: true },
      { name: "create_issue", readOnly: false },
      { name: "delete.issue", readOnly: false },
    ],
    ...patch,
  });

// ---------------------------------------------------------------------------
// A fake MCP server (Streamable HTTP, JSON answers) behind a fetch function
// ---------------------------------------------------------------------------

interface FakeMcpOptions {
  tools?: typeof TOOLS;
  /** The Authorization header (or other header) the server insists on. */
  require?: { header: string; value: string };
  pageSize?: number;
}

function fakeMcp(opts: FakeMcpOptions = {}) {
  const tools = opts.tools ?? TOOLS;
  const seen: { method: string; headers: Headers; body?: unknown }[] = [];
  const handle = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    seen.push({ method, headers });
    if (method === "GET") return new Response(null, { status: 405 });
    if (method === "DELETE") return new Response(null, { status: 200 });
    if (opts.require && headers.get(opts.require.header) !== opts.require.value) return new Response("Unauthorized", { status: 401 });
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { cursor?: string; protocolVersion?: string } };
    seen[seen.length - 1]!.body = body;
    if (body.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (body.method === "initialize") {
      result = { protocolVersion: body.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0.0" } };
    } else if (body.method === "tools/list") {
      const size = opts.pageSize ?? tools.length;
      const start = Number(body.params?.cursor ?? 0);
      const page = tools.slice(start, start + size).map((t) => ({ inputSchema: { type: "object" }, ...t }));
      result = { tools: page, ...(start + size < tools.length ? { nextCursor: String(start + size) } : {}) };
    } else {
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no" } });
    }
    void url;
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  };
  const fetch: FetchLike = (url, init) => handle(String(url), init);
  return { fetch, handle, seen };
}

// ---------------------------------------------------------------------------
// A fake OAuth authorization server for the MCP server at mcp.example.com
// ---------------------------------------------------------------------------

function fakeOAuth(opts: { refreshRefused?: boolean } = {}) {
  const calls: { url: string; body?: URLSearchParams }[] = [];
  let issued = 0;
  const handle = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const raw = init?.body;
    const body = raw instanceof URLSearchParams ? raw : typeof raw === "string" && !raw.startsWith("{") ? new URLSearchParams(raw) : undefined;
    calls.push({ url, ...(body ? { body } : {}) });
    if (u.host === "mcp.example.com" && u.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({ resource: "https://mcp.example.com/mcp", authorization_servers: ["https://auth.example.com"] });
    }
    if (u.host !== "auth.example.com") return new Response("not found", { status: 404 });
    if (u.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        registration_endpoint: "https://auth.example.com/register",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (u.pathname === "/register") {
      const meta = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ ...meta, client_id: "client-1" }, { status: 201 });
    }
    if (u.pathname === "/token") {
      const grant = body?.get("grant_type");
      if (grant === "authorization_code") {
        if (body?.get("code") !== "good-code" || !body?.get("code_verifier")) return Response.json({ error: "invalid_grant" }, { status: 400 });
        issued++;
        return Response.json({ access_token: `access-token-${issued}`, refresh_token: `refresh-token-${issued}`, expires_in: 3600, token_type: "Bearer" });
      }
      if (grant === "refresh_token") {
        if (opts.refreshRefused) return Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 });
        issued++;
        return Response.json({ access_token: `access-token-${issued}`, refresh_token: `refresh-token-${issued}`, expires_in: 3600, token_type: "Bearer" });
      }
    }
    return new Response("not found", { status: 404 });
  };
  const fetch: FetchLike = (url, init) => handle(String(url), init);
  return { fetch, handle, calls };
}

async function configRepoWith(patch: (c: Config) => void): Promise<ConfigRepo> {
  const repo = new ConfigRepo(new FsStore(await mkdtemp(join(tmpdir(), "army-apps-"))), deriveKey("k"), 0);
  await repo.update(patch);
  return repo;
}

// ---------------------------------------------------------------------------

describe("apps catalog", () => {
  it("has verified, complete entries sorted by category then name", () => {
    expect(APP_CATALOG.length).toBeGreaterThanOrEqual(20);
    const ids = new Set<string>();
    for (const a of APP_CATALOG) {
      expect(a.id).toMatch(/^[a-z0-9][a-z0-9-]{0,40}$/);
      expect(ids.has(a.id)).toBe(false);
      ids.add(a.id);
      expect(APP_CATEGORIES).toContain(a.category);
      expect(a.url).toMatch(/^https:\/\/[^\s]+$/);
      expect(a.docsUrl).toMatch(/^https:\/\//);
      expect(["http", "sse"]).toContain(a.transport);
      expect(a.auth).toMatch(/^(oauth|bearer|none|header:[A-Za-z0-9-]+)$/);
      if (a.altAuth) expect(a.altAuth).not.toBe(a.auth);
      if (a.auth === "bearer" || a.auth.startsWith("header:")) expect(a.keyHelp).toBeTruthy();
      if (a.valueTemplate) expect(a.valueTemplate).toContain("{key}");
      // Every {placeholder} in a per-account address is asked for by a field.
      const placeholders = [...a.url.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
      expect(placeholders.sort()).toEqual((a.urlFields ?? []).map((f) => f.key).sort());
      expect(a.description.length).toBeGreaterThan(10);
      expect(a.examples.length).toBeGreaterThanOrEqual(1);
    }
    const sorted = [...APP_CATALOG].sort((x, y) => x.category.localeCompare(y.category) || x.name.localeCompare(y.name));
    expect(APP_CATALOG.map((a) => a.id)).toEqual(sorted.map((a) => a.id));
  });
});

describe("app address guard (SSRF)", () => {
  it("refuses non-https, credentials and private hosts by name", () => {
    for (const url of [
      "http://mcp.example.com/mcp",
      "https://user:pw@mcp.example.com/mcp",
      "https://localhost/mcp",
      "https://api.localhost/mcp",
      "https://127.0.0.1/mcp",
      "https://10.1.2.3/mcp",
      "https://172.20.0.1/mcp",
      "https://192.168.1.1/mcp",
      "https://169.254.169.254/latest",
      "https://[::1]/mcp",
      "https://[::ffff:127.0.0.1]/mcp",
      "https://[fd00::1]/mcp",
      "https://metadata.google.internal/computeMetadata",
      "https://metadata/computeMetadata",
      "not a url",
    ]) {
      expect(appUrlProblem(url, {}), url).toBeTruthy();
    }
    expect(appUrlProblem("https://mcp.linear.app/mcp", {})).toBeUndefined();
    expect(appUrlProblem("https://93.184.216.34/mcp", {})).toBeUndefined();
    expect(isBlockedAddress("100.64.1.1")).toBe(true);
    expect(isBlockedAddress("::ffff:a00:5")).toBe(true);
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("2606:4700::1111")).toBe(false);
  });

  it("refuses public names that resolve to private addresses, and allows private ones only in tests or when asked", async () => {
    await expect(assertPublicUrl("https://evil.example.com/mcp", { env: {}, lookup: async () => ["93.184.216.34", "10.0.0.5"] })).rejects.toBeInstanceOf(AppUrlError);
    await expect(assertPublicUrl("https://ok.example.com/mcp", { env: {}, lookup: async () => ["93.184.216.34"] })).resolves.toBeInstanceOf(URL);
    await expect(assertPublicUrl("https://gone.example.com/mcp", { env: {}, lookup: async () => Promise.reject(new Error("ENOTFOUND")) })).rejects.toThrow(/Couldn't find/);
    expect(appUrlProblem("https://127.0.0.1/mcp", { NODE_ENV: "test" })).toBeUndefined();
    expect(appUrlProblem("https://127.0.0.1/mcp", { ALLOW_PRIVATE_APP_URLS: "1" })).toBeUndefined();
    // https is required even then.
    expect(appUrlProblem("http://127.0.0.1/mcp", { ALLOW_PRIVATE_APP_URLS: "1" })).toBeTruthy();
  });

  it("checks every redirect before following it", async () => {
    const lookup = async () => ["93.184.216.34"];
    const to = (location: string) => new Response(null, { status: 302, headers: { location } });
    const hops: string[] = [];
    const fetch: FetchLike = async (url) => {
      hops.push(String(url));
      if (String(url).endsWith("/start")) return to("https://other.example.com/next");
      if (String(url).endsWith("/next")) return to("http://169.254.169.254/latest/meta-data");
      return new Response("ok");
    };
    await expect(guardedFetch({ env: {}, lookup, fetch })("https://a.example.com/start")).rejects.toBeInstanceOf(AppUrlError);
    expect(hops).toEqual(["https://a.example.com/start", "https://other.example.com/next"]);
    // A POST is not followed; a "manual" caller gets the redirect itself.
    expect((await guardedFetch({ env: {}, lookup, fetch })("https://a.example.com/start", { method: "POST" })).status).toBe(302);
    expect((await guardedFetch({ env: {}, lookup, fetch })("https://a.example.com/start", { redirect: "manual" })).status).toBe(302);
  });

  it("keeps credentials on a same-origin redirect and drops them when a redirect leaves the origin", async () => {
    const lookup = async () => ["93.184.216.34"];
    const to = (location: string) => new Response(null, { status: 302, headers: { location } });
    const seen = new Map<string, Record<string, string>>();
    const fetch: FetchLike = async (url, init) => {
      seen.set(String(url), Object.fromEntries(new Headers(init?.headers)));
      if (String(url).endsWith("/start")) return to("/same");
      if (String(url).endsWith("/same")) return to("https://other.example.com/next");
      if (String(url).endsWith("/next")) return to("https://a.example.com/back");
      return new Response("ok");
    };
    const headers = { Authorization: "Bearer app-key", Cookie: "session=1", "X-API-Key": "custom-key", "Proxy-Authorization": "Basic x", Accept: "application/json" };
    expect((await guardedFetch({ env: {}, lookup, fetch })("https://a.example.com/start", { headers })).status).toBe(200);
    expect(seen.get("https://a.example.com/same")).toMatchObject({ authorization: "Bearer app-key", cookie: "session=1", "x-api-key": "custom-key" });
    expect(seen.get("https://other.example.com/next")).toEqual({ accept: "application/json" });
    // Once dropped they stay dropped, even back on the first origin.
    expect(seen.get("https://a.example.com/back")).toEqual({ accept: "application/json" });
  });

  it("connects only to the addresses it checked (pinned DNS)", async () => {
    const http = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      res.writeHead(201, { "content-type": "application/json", "x-reply": "yes" });
      res.write('{"method":"' + req.method + '",');
      setTimeout(() => res.end(`"header":"${req.headers["x-test"]}","body":${Buffer.concat(chunks).toString("utf8")}}`), 10);
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const port = (http.address() as AddressInfo).port;
    try {
      // An address is connected to as given; the request and the streamed response go through.
      const res = await pinnedFetch()(`http://127.0.0.1:${port}/echo`, { method: "POST", headers: { "x-test": "1", "content-type": "application/json" }, body: '{"a":1}' });
      expect(res.status).toBe(201);
      expect(res.headers.get("x-reply")).toBe("yes");
      expect(await res.json()).toEqual({ method: "POST", header: "1", body: { a: 1 } });
      // A name is resolved by the guard at connect time: one that resolves to a private address is refused.
      await expect(pinnedFetch({ lookup: async () => ["127.0.0.1"] })(`http://local.example.com:${port}/echo`)).rejects.toThrow(/private network/);
    } finally {
      await new Promise<void>((r) => http.close(() => r()));
    }
    const resolved = await new Promise<unknown>((resolve) =>
      guardedLookup(async () => ["93.184.216.34", "2606:4700::1111"])("ok.example.com", { all: true }, (err, addresses) => resolve(err ?? addresses)),
    );
    expect(resolved).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ]);
  });
});

describe("app tools: read and write access", () => {
  it("offers read-only tools for read access, all for write, never disabled ones", () => {
    expect(allowedToolsOf(app())).toEqual(["search_issues", "get_issue"]);
    expect(allowedToolsOf(app({ access: "write" }))).toEqual(["search_issues", "get_issue", "create_issue", "delete.issue"]);
    expect(allowedToolsOf(app({ access: "write", disabledTools: ["delete.issue", "get_issue"] }))).toEqual(["search_issues", "create_issue"]);
    expect(readOnlyToolsOf(app({ access: "write", disabledTools: ["get_issue"] }))).toEqual(["search_issues"]);
    expect(appToolName(app(), "delete.issue")).toBe("mcp__app-linear__delete_issue");
  });

  it("gives Claude Code the proxy's loopback route and key, never the app's address or credentials", async () => {
    const proxy = new AppProxy();
    try {
      const server = await mcpServerConfig(app(), { proxy });
      expect(server).toEqual({
        type: "http",
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/app-linear\/all$/),
        headers: { [PROXY_KEY_HEADER]: proxy.secret },
        alwaysLoad: true,
        tools: [
          { name: "create_issue", permission_policy: "always_deny" },
          { name: "delete.issue", permission_policy: "always_deny" },
        ],
      });
      // An SSE app is reached by the proxy; Claude Code still speaks Streamable HTTP to the proxy.
      const sse = await mcpServerConfig(app({ transport: "sse", access: "write", auth: { type: "headers", headers: { "X-API-Key": "k-123456789" } } }), { proxy, scope: "read" });
      expect(sse).toMatchObject({ type: "http", url: expect.stringMatching(/\/app-linear\/read$/), alwaysLoad: true });
      const shown = JSON.stringify([server, sse]);
      for (const secret of ["lin_api_secret_key_123456", "k-123456789", "mcp.example.com"]) expect(shown).not.toContain(secret);
      await expect(mcpServerConfig(app({ url: "https://10.0.0.1/mcp" }), { ...PUBLIC, proxy })).rejects.toBeInstanceOf(AppUrlError);
    } finally {
      await proxy.close();
    }
  });

  it("lists tools over Streamable HTTP with the key, page by page, with read-only hints", async () => {
    const mcp = fakeMcp({ require: { header: "authorization", value: "Bearer lin_api_secret_key_123456" }, pageSize: 3 });
    const tools = await listAppTools(app({ tools: [] }), { fetch: mcp.fetch });
    expect(tools).toEqual([
      { name: "search_issues", description: "Search issues", readOnly: true },
      { name: "get_issue", description: "Get one issue", readOnly: true },
      { name: "create_issue", description: "Create an issue", readOnly: false },
      { name: "delete.issue", description: "Delete an issue", readOnly: false },
    ]);
    expect(mcp.seen.filter((s) => (s.body as { method?: string } | undefined)?.method === "tools/list")).toHaveLength(2);
    const custom = fakeMcp({ require: { header: "x-api-key", value: "k-123456789" } });
    await expect(listAppTools(app({ auth: { type: "headers", headers: { "X-API-Key": "k-123456789" } } }), { fetch: custom.fetch })).resolves.toHaveLength(4);
  });

  it("explains a refused key without repeating it, and gives up after the timeout", async () => {
    const mcp = fakeMcp({ require: { header: "authorization", value: "Bearer the-right-key" } });
    const refused = await listAppTools(app(), { fetch: mcp.fetch }).catch((e: Error) => e.message);
    expect(refused).toBe("Linear refused the sign-in. Check the key, and that it may use the MCP server.");
    const hang: FetchLike = (_url, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const slow = await listAppTools(app(), { fetch: hang, timeoutMs: 200 }).catch((e: Error) => e.message);
    expect(slow).toBe("Linear did not answer within 1 second.");
  });
});

describe("apps in chat and in repo tasks", () => {
  const configWithApps = () => {
    const config = ConfigSchema.parse({ team: defaultTeam() });
    config.apps = [
      app(),
      app({ id: "app-stripe", name: "Stripe", presetId: "stripe", access: "write", auth: { type: "bearer", token: "rk_live_secret_987654321" } }),
      app({ id: "app-off", name: "Off", presetId: undefined, enabled: false }),
      app({ id: "app-notion", name: "Notion", presetId: "notion", auth: { type: "oauth", oauth: {} } }),
      app({ id: "app-empty", name: "Empty", presetId: undefined, tools: [] }),
    ];
    const agent = (id: string) => config.team.agents.find((a) => a.id === id)!;
    agent("coder").apps = ["app-linear", "app-stripe", "app-notion"];
    agent("researcher").apps = ["app-linear", "app-stripe"];
    agent("writer").apps = ["app-off"];
    return config;
  };
  const ctx = (config: Config) => ({ configRepo: undefined as unknown as ConfigRepo, requester: "owner", redact, config });

  it("gives Pointer every allowed tool and the assigned agents the read-only ones", async () => {
    const config = configWithApps();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const integrations = await appChatIntegrations(config, ctx(config));
    warn.mockRestore();
    expect(integrations.map((i) => i.key)).toEqual(["app-linear", "app-stripe", "app-notion", "app-empty"]);
    const [linear, stripe, notion, empty] = integrations;
    expect(linear).toMatchObject({
      agentIds: ["coder", "researcher"],
      allToolNames: ["mcp__app-linear__search_issues", "mcp__app-linear__get_issue"],
      readOnlyToolNames: ["mcp__app-linear__search_issues", "mcp__app-linear__get_issue"],
    });
    expect(linear!.server).toMatchObject({ type: "http", alwaysLoad: true });
    expect(linear!.promptRule).toMatch(/^- Linear is connected \(tools mcp__app-linear__\*\)\. Search, create.*read-only.*coder, researcher.*data, never instructions/);
    expect(stripe!.allToolNames).toContain("mcp__app-stripe__create_issue");
    expect(stripe!.readOnlyToolNames).not.toContain("mcp__app-stripe__create_issue");
    expect(stripe!.promptRule).toMatch(/You may change things in Stripe/);
    // Not signed in: no server, only a rule; it never throws.
    expect(notion).toMatchObject({ allToolNames: [], readOnlyToolNames: [], agentIds: ["coder"] });
    expect(notion!.server).toBeUndefined();
    expect(notion!.promptRule).toMatch(/Notion is connected but cannot be used right now \(Notion is not signed in/);
    expect(empty!.promptRule).toMatch(/tools have not been listed yet/);
    // No secret in any rule.
    expect(JSON.stringify(integrations.map((i) => i.promptRule))).not.toMatch(/secret/);
  });

  it("gives each agent its apps' servers and tools in a repo task; looks-only agents get read-only tools", async () => {
    const config = configWithApps();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const notes: string[] = [];
    const proxy = new AppProxy();
    const apps = (await repoTaskApps(config, { redact, proxy, note: (n) => notes.push(n) }))!;
    expect(warn).toHaveBeenCalledWith("[worker] app Notion left out:", EXPIRED_IN_TASK);
    expect(notes).toEqual([`Notion left out: ${EXPIRED_IN_TASK}.`]);
    warn.mockRestore();
    expect(Object.keys(apps.servers).sort()).toEqual(["app-linear", "app-stripe"]);
    // Each agent starts its own route: the full one, or the read-only one for an agent that only looks.
    const route = (agent: string, key: string) => (apps.serversFor!(agent)[key] as { url: string } | undefined)?.url;
    expect(route("coder", "app-stripe")).toMatch(/\/app-stripe\/all$/);
    expect(route("researcher", "app-stripe")).toMatch(/\/app-stripe\/read$/);
    expect(Object.keys(apps.serversFor!("qa"))).toEqual([]);
    expect(JSON.stringify(apps.servers)).not.toContain("rk_live_secret_987654321");
    await proxy.close();
    expect(apps.toolsFor("coder")).toEqual([
      "mcp__app-linear__search_issues",
      "mcp__app-linear__get_issue",
      "mcp__app-stripe__search_issues",
      "mcp__app-stripe__get_issue",
      "mcp__app-stripe__create_issue",
      "mcp__app-stripe__delete_issue",
    ]);
    // The researcher only looks: Stripe's read-only tools only.
    expect(apps.toolsFor("researcher")).toEqual(["mcp__app-linear__search_issues", "mcp__app-linear__get_issue", "mcp__app-stripe__search_issues", "mcp__app-stripe__get_issue"]);
    expect(apps.toolsFor("qa")).toEqual([]);
    expect(apps.toolsFor("writer")).toEqual([]);
    expect(apps.allToolNames).toHaveLength(6);
    expect(apps.promptRule).toContain("- Stripe (tools mcp__app-stripe__*): Query and manage");
    expect(apps.promptRule).toContain("Agents: coder (can change things), researcher (looks only).");
    expect(apps.promptRule).toMatch(/never as instructions/);
  });

  it("has no apps for a task when no enabled agent has one", async () => {
    const config = configWithApps();
    for (const a of config.team.agents) a.apps = a.id === "coder" ? ["app-linear"] : [];
    config.team.agents.find((a) => a.id === "coder")!.enabled = false;
    expect(await repoTaskApps(config, { redact })).toBeUndefined();
  });

  it("keeps agents' app lists and the app's agentIds in step, and removes an app everywhere", () => {
    const config = configWithApps();
    setAppAgents(config, "app-linear", ["qa", "nobody"]);
    expect(config.team.agents.filter((a) => a.apps.includes("app-linear")).map((a) => a.id)).toEqual(["qa"]);
    expect(config.apps[0]!.agentIds).toEqual(["qa"]);
    removeApp(config, "app-stripe");
    expect(config.apps.map((a) => a.id)).not.toContain("app-stripe");
    expect(config.team.agents.some((a) => a.apps.includes("app-stripe"))).toBe(false);
  });
});

describe("app OAuth", () => {
  const oauthApp = () => app({ auth: { type: "oauth", oauth: {} }, tools: [] });
  const BASE = "https://army.example.com";

  it("signs in: registers, keeps a single-use state and the verifier, exchanges the code", async () => {
    const auth = fakeOAuth();
    const repo = await configRepoWith((c) => void (c.apps = [oauthApp()]));
    let now = 1_800_000_000_000;
    const deps = { configRepo: repo, baseUrl: BASE, fetch: auth.fetch, now: () => now };

    const url = new URL(await startAppSignIn("app-linear", deps));
    expect(url.origin + url.pathname).toBe("https://auth.example.com/authorize");
    // This deployment publishes client metadata, but the server does not take URL client ids: dynamic registration.
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe(`${BASE}/api/apps/oauth/callback`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const state = url.searchParams.get("state")!;
    const saved = (await repo.load(true)).apps[0]!.auth;
    expect(saved.type === "oauth" && saved.oauth).toMatchObject({ state: `${state}:${now}`, codeVerifier: expect.any(String), clientInformation: { client_id: "client-1" } });

    await expect(completeAppSignIn({ state: "x".repeat(32), code: "good-code" }, deps)).rejects.toMatchObject({ reason: "invalid" });
    now += 60_000;
    expect(await completeAppSignIn({ state, code: "good-code" }, deps)).toEqual({ appId: "app-linear" });
    const signedIn = (await repo.load(true)).apps[0]!.auth;
    const oauth = signedIn.type === "oauth" ? signedIn.oauth : {};
    expect(oauth).toMatchObject({ tokens: { access_token: "access-token-1", refresh_token: "refresh-token-1" }, expiresAt: now + 3600 * 1000 });
    expect(oauth.state).toBeUndefined();
    expect(oauth.codeVerifier).toBeUndefined();
    // The state works once.
    await expect(completeAppSignIn({ state, code: "good-code" }, deps)).rejects.toMatchObject({ reason: "invalid" });
  });

  it("uses a client the owner registered by hand instead of registering one", async () => {
    const auth = fakeOAuth();
    const owners = { client_id: "owner-client", client_secret: "owner-secret-123456", entered_by_owner: true };
    const repo = await configRepoWith((c) => void (c.apps = [app({ auth: { type: "oauth", oauth: { clientInformation: owners } }, tools: [] })]));
    const url = new URL(await startAppSignIn("app-linear", { configRepo: repo, baseUrl: BASE, fetch: auth.fetch }));
    expect(url.searchParams.get("client_id")).toBe("owner-client");
    expect(auth.calls.some((c) => c.url.endsWith("/register"))).toBe(false);
  });

  it("refuses a late, refused or failed callback and uses the state up", async () => {
    const auth = fakeOAuth();
    const repo = await configRepoWith((c) => void (c.apps = [oauthApp()]));
    let now = 1_800_000_000_000;
    const deps = { configRepo: repo, baseUrl: BASE, fetch: auth.fetch, now: () => now };
    const stateOf = async () => new URL(await startAppSignIn("app-linear", deps)).searchParams.get("state")!;

    let state = await stateOf();
    now += OAUTH_STATE_TTL_MS + 1;
    await expect(completeAppSignIn({ state, code: "good-code" }, deps)).rejects.toMatchObject({ reason: "expired", appId: "app-linear" });
    await expect(completeAppSignIn({ state, code: "good-code" }, deps)).rejects.toMatchObject({ reason: "invalid" });

    state = await stateOf();
    await expect(completeAppSignIn({ state }, deps)).rejects.toMatchObject({ reason: "denied" });

    state = await stateOf();
    const failed = await completeAppSignIn({ state, code: "bad-code" }, deps).catch((e: SignInCallbackError) => e);
    expect(failed).toBeInstanceOf(SignInCallbackError);
    expect((failed as SignInCallbackError).reason).toBe("failed");
    const after = (await repo.load(true)).apps[0]!.auth;
    expect(after.type === "oauth" && after.oauth.tokens).toBeUndefined();
  });

  it("refreshes a token about to expire once, and asks for a new sign-in when the refresh is refused", async () => {
    const now = 1_800_000_000_000;
    const signedIn = (expiresAt: number) =>
      app({
        auth: {
          type: "oauth",
          oauth: {
            clientInformation: { client_id: "client-1" },
            tokens: { access_token: "access-token-0", refresh_token: "refresh-token-0", token_type: "Bearer" },
            expiresAt,
            serverMetadata: { authorizationServerUrl: "https://auth.example.com" },
          },
        },
      });

    // Plenty of time left: no network.
    const idle = fakeOAuth();
    expect(await freshAccessToken(signedIn(now + 3_600_000), { fetch: idle.fetch, now: () => now })).toBe("access-token-0");
    expect(idle.calls).toHaveLength(0);

    // About to expire: one refresh for two callers, saved.
    const auth = fakeOAuth();
    const repo = await configRepoWith((c) => void (c.apps = [signedIn(now + 30_000)]));
    const stored = (await repo.load(true)).apps[0]!;
    const deps = { configRepo: repo, fetch: auth.fetch, now: () => now };
    const [a, b] = await Promise.all([freshAccessToken(stored, deps), freshAccessToken(stored, deps)]);
    expect([a, b]).toEqual(["access-token-1", "access-token-1"]);
    expect(auth.calls.filter((c) => c.body?.get("grant_type") === "refresh_token")).toHaveLength(1);
    const saved = (await repo.load(true)).apps[0]!.auth;
    expect(saved.type === "oauth" && saved.oauth.tokens).toMatchObject({ access_token: "access-token-1", refresh_token: "refresh-token-1" });

    // Refused: the tokens are dropped and the app must be signed in again.
    const refused = fakeOAuth({ refreshRefused: true });
    const repo2 = await configRepoWith((c) => void (c.apps = [signedIn(now - 1)]));
    const err = await freshAccessToken((await repo2.load(true)).apps[0]!, { configRepo: repo2, fetch: refused.fetch, now: () => now }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(AppSignInError);
    expect((err as Error).message).toMatch(/Sign in again/);
    const cleared = (await repo2.load(true)).apps[0]!.auth;
    expect(cleared.type === "oauth" && cleared.oauth.tokens).toBeUndefined();

    // Expired with nowhere to keep a new token: sign in again, without a request.
    await expect(freshAccessToken(signedIn(now - 1), { fetch: idle.fetch, now: () => now })).rejects.toBeInstanceOf(AppSignInError);

    // A client bound to another authorization server is never re-registered by a refresh.
    const moved = signedIn(now - 1);
    if (moved.auth.type === "oauth") moved.auth.oauth.clientInformation = { client_id: "client-1", issuer: "https://old-auth.example.com" };
    const repo3 = await configRepoWith((c) => void (c.apps = [moved]));
    await expect(freshAccessToken((await repo3.load(true)).apps[0]!, { configRepo: repo3, fetch: idle.fetch, now: () => now })).rejects.toThrow(/Sign in again/);
    expect(idle.calls).toHaveLength(0);
  });
});

describe("OAuth tokens and repo tasks", () => {
  const now = 1_800_000_000_000;
  const signedIn = (id: string, expiresAt: number, refresh = "refresh-token-0") =>
    app({
      id,
      name: id.replace("app-", ""),
      tools: [{ name: "search_issues", readOnly: true }],
      auth: {
        type: "oauth",
        oauth: {
          clientInformation: { client_id: "client-1" },
          tokens: { access_token: `access-${id}`, refresh_token: refresh, token_type: "Bearer" },
          expiresAt,
          serverMetadata: { authorizationServerUrl: "https://auth.example.com" },
        },
      },
    });
  const assign = (c: Config, ids: string[]) => void (c.team.agents.find((a) => a.id === "coder")!.apps = ids);

  it("uses a stored token in a repo task only while it is valid, and never renews it there", async () => {
    const auth = fakeOAuth();
    const config = ConfigSchema.parse({ team: defaultTeam() });
    config.apps = [signedIn("app-valid", now + 10 * 60_000), signedIn("app-expired", now - 1)];
    assign(config, ["app-valid", "app-expired"]);
    const notes: string[] = [];
    const proxy = new AppProxy();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const apps = (await repoTaskApps(config, { redact, proxy, fetch: auth.fetch, now: () => now, note: (n) => notes.push(n) }))!;
    warn.mockRestore();
    await proxy.close();
    expect(Object.keys(apps.servers)).toEqual(["app-valid"]);
    expect(notes).toEqual([`expired left out: ${EXPIRED_IN_TASK}.`]);
    // Nothing was renewed (no token request), and there is no ConfigRepo to write to.
    expect(auth.calls).toHaveLength(0);
  });

  it("renews before a task, in the web service, the tokens that would expire during it", async () => {
    const auth = fakeOAuth();
    const repo = await configRepoWith((c) => {
      c.apps = [signedIn("app-soon", now + 20 * 60_000), signedIn("app-later", now + 2 * 3_600_000), signedIn("app-unused", now + 60_000)];
      assign(c, ["app-soon", "app-later"]);
    });
    await refreshAppsForTask(repo, { redact, fetch: auth.fetch, now: () => now });
    expect(auth.calls.filter((c) => c.body?.get("grant_type") === "refresh_token")).toHaveLength(1);
    const tokens = Object.fromEntries((await repo.load(true)).apps.map((a) => [a.id, a.auth.type === "oauth" ? a.auth.oauth.tokens?.access_token : undefined]));
    expect(tokens).toEqual({ "app-soon": "access-token-1", "app-later": "access-app-later", "app-unused": "access-app-unused" });

    // A refused renewal never stops the task from starting.
    const refused = fakeOAuth({ refreshRefused: true });
    const repo2 = await configRepoWith((c) => {
      c.apps = [signedIn("app-soon", now + 60_000)];
      assign(c, ["app-soon"]);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(refreshAppsForTask(repo2, { redact, fetch: refused.fetch, now: () => now })).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it("renews the team's sign-ins before a repo task's worker is launched", async () => {
    const order: string[] = [];
    const auth = fakeOAuth();
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.host !== "auth.example.com" && url.host !== "mcp.example.com") return realFetch(input, init);
      if (url.pathname === "/token") order.push("renew");
      return auth.handle(url.href, init);
    });
    try {
      // A token that expires within the task's horizon (50 minutes), at today's clock.
      const repo = await configRepoWith((c) => {
        c.apps = [signedIn("app-soon", Date.now() + 10 * 60_000)];
        assign(c, ["app-soon"]);
      });
      const tasks = new TaskRepo(new FsStore(await mkdtemp(join(tmpdir(), "army-apps-task-"))));
      const runner = { kind: "local" as const, launch: async () => void order.push("launch") };
      const started = await startThreadTask(
        { tasks, runner, configRepo: repo },
        { repo: "acme/web", channel: WEB_CHANNEL, threadTs: "conversation-1", userId: "admin", instruction: "Fix the login bug", ackText: "" },
      );
      expect(started.ok).toBe(true);
      expect(order).toEqual(["renew", "launch"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never writes a renewed token over a sign-in made meanwhile, and only changes the sign-in", async () => {
    const repo = await configRepoWith((c) => void (c.apps = [signedIn("app-linear", now - 1)]));
    const base = fakeOAuth();
    const fetch: FetchLike = async (url, init) => {
      if (String(url).endsWith("/token")) {
        // The owner signs in again, and renames the app, while the renewal is on its way.
        await repo.update((c) => {
          const a = c.apps[0]!;
          a.name = "Linear (work)";
          if (a.auth.type === "oauth") a.auth.oauth.tokens = { access_token: "newer-access", refresh_token: "newer-refresh", token_type: "Bearer" };
        });
      }
      return base.fetch(url, init);
    };
    expect(await freshAccessToken((await repo.load(true)).apps[0]!, { configRepo: repo, fetch, now: () => now })).toBe("access-token-1");
    const saved = (await repo.load(true)).apps[0]!;
    expect(saved.name).toBe("Linear (work)");
    expect(saved.auth.type === "oauth" && saved.auth.oauth.tokens).toMatchObject({ access_token: "newer-access", refresh_token: "newer-refresh" });
  });
});

describe("MCP Registry search", () => {
  const entry = (name: string, remotes: unknown[], extra: Record<string, unknown> = {}, status = "active") => ({
    server: { name, description: `${name} server`, version: "1.0.0", remotes, ...extra },
    _meta: { "io.modelcontextprotocol.registry/official": { status } },
  });
  const registry = (servers: unknown[], status = 200) => {
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(String(url));
      return status === 200 ? Response.json({ servers, metadata: { count: servers.length } }) : new Response("down", { status });
    };
    return { fetch, calls };
  };

  it("keeps public remote servers, shaped like catalog entries, and caches the search for an hour", async () => {
    const reg = registry([
      entry("io.example/tracker", [{ type: "streamable-http", url: "https://mcp.tracker.example/mcp" }, { type: "sse", url: "https://mcp.tracker.example/sse" }], {
        title: "Tracker",
        websiteUrl: "https://tracker.example",
      }),
      entry("io.example/keyed", [{ type: "sse", url: "https://keyed.example/sse", headers: [{ name: "X-API-Key", isSecret: true }] }]),
      entry("io.example/bearer", [{ type: "streamable-http", url: "https://bearer.example/mcp", headers: [{ name: "Authorization", isSecret: true }] }]),
      entry("io.example/local-only", [{ type: "stdio" }]),
      entry("io.example/template", [{ type: "streamable-http", url: "https://{tenant}.example/mcp" }]),
      entry("io.example/private", [{ type: "streamable-http", url: "https://10.0.0.8/mcp" }]),
      entry("io.example/plain", [{ type: "streamable-http", url: "http://plain.example/mcp" }]),
      entry("io.example/old", [{ type: "streamable-http", url: "https://old.example/mcp" }], {}, "deleted"),
      entry("app.linear/linear", [{ type: "streamable-http", url: "https://mcp.linear.app/mcp" }]),
      { server: { nonsense: true } },
    ]);
    let now = 1_000_000;
    const opts = { env: {}, fetch: reg.fetch, now: () => now, lookup: async () => ["93.184.216.34"] };
    const apps = await searchRegistry("tracker", opts);
    expect(reg.calls[0]).toBe("https://registry.modelcontextprotocol.io/v0.1/servers?search=tracker&version=latest&limit=100");
    expect(apps).toEqual([
      {
        id: "io.example/tracker",
        name: "Tracker",
        publisher: "io.example",
        description: "io.example/tracker server",
        url: "https://mcp.tracker.example/mcp",
        transport: "http",
        auth: "custom",
        docsUrl: "https://tracker.example",
        version: "1.0.0",
        onPublisherDomain: false,
        source: "registry",
      },
      expect.objectContaining({ id: "io.example/keyed", transport: "sse", auth: "header:X-API-Key" }),
      expect.objectContaining({ id: "io.example/bearer", auth: "bearer" }),
    ]);
    expect(await searchRegistry("  Tracker ", opts)).toBe(apps);
    expect(reg.calls).toHaveLength(1);
    now += REGISTRY_CACHE_TTL_MS + 1;
    await searchRegistry("tracker", opts);
    expect(reg.calls).toHaveLength(2);
  });

  it("lists a vendor's own server, on its own domain, before others' wrappers", async () => {
    const reg = registry([
      entry("io.github.someone/acme-wrapper", [{ type: "streamable-http", url: "https://acme-wrapper.example.net/mcp" }]),
      entry("com.reseller/acme", [{ type: "streamable-http", url: "https://mcp.othervendor.com/acme" }]),
      entry("com.acme/acme", [{ type: "streamable-http", url: "https://mcp.acme.com/mcp" }]),
    ]);
    const apps = await searchRegistry("acme", { env: {}, fetch: reg.fetch, lookup: async () => ["93.184.216.34"] });
    expect(apps.map((a) => [a.id, a.onPublisherDomain])).toEqual([
      ["com.acme/acme", true],
      ["io.github.someone/acme-wrapper", false],
      ["com.reseller/acme", false],
    ]);
  });

  it("needs three characters and reports a registry that cannot be reached", async () => {
    const reg = registry([], 503);
    expect(await searchRegistry("ab", { fetch: reg.fetch })).toEqual([]);
    expect(reg.calls).toHaveLength(0);
    await expect(searchRegistry("broken-registry", { fetch: reg.fetch })).rejects.toThrow("Couldn't search the MCP Registry (HTTP 503).");
  });
});

// ---------------------------------------------------------------------------
// The admin API, through HTTP (vendors faked)
// ---------------------------------------------------------------------------

describe("apps admin API", () => {
  const KEY = "lin_api_route_secret_key_42";
  let base = "";
  let close: () => void;
  let cookie = "";
  const mcp = fakeMcp({ require: { header: "authorization", value: `Bearer ${KEY}` } });
  const oauthMcp = fakeMcp({ require: { header: "authorization", value: "Bearer access-token-1" } });
  const auth = fakeOAuth();
  const registryCalls: string[] = [];

  const post = (path: string, body: unknown, withCookie = true) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(withCookie && cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const get = (path: string, withCookie = true) => fetch(base + path, { headers: withCookie && cookie ? { cookie } : {}, redirect: "manual" });
  const config = async () => (await (await get("/api/state")).json()).config;

  beforeAll(async () => {
    delete process.env.SKIP_VALIDATION;
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "127.0.0.1") return realFetch(input, init);
      if (url.host === "mcp.example.com" && url.pathname === "/mcp") return mcp.handle(url.href, init);
      if (url.host === "mcp.example.com" && url.pathname === "/oauth-mcp") return oauthMcp.handle(url.href, init);
      if (url.host === "mcp.example.com" || url.host === "auth.example.com") {
        // The OAuth app's MCP server lives at /oauth-mcp: its resource metadata names that address.
        if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
          return Response.json({ resource: "https://mcp.example.com/oauth-mcp", authorization_servers: ["https://auth.example.com"] });
        }
        return auth.handle(url.href, init);
      }
      if (url.host === "registry.modelcontextprotocol.io") {
        registryCalls.push(url.href);
        return Response.json({
          servers: [{ server: { name: "io.example/tickets", title: "Tickets", remotes: [{ type: "streamable-http", url: "https://tickets.example/mcp" }] } }],
        });
      }
      return new Response("unexpected", { status: 599 });
    });
    const dir = await mkdtemp(join(tmpdir(), "army-apps-api-"));
    const { app: server } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" });
    const listening = server.listen(0);
    base = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
    close = () => listening.close();
    const res = await post("/api/setup", { setupToken: "setup-123", password: "longpassword1" });
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
  });
  afterAll(() => {
    close();
    vi.unstubAllGlobals();
  });
  afterEach(() => vi.restoreAllMocks());

  it("is admin only, except the OAuth callback and the client metadata", async () => {
    for (const res of [
      await get("/api/apps/catalog", false),
      await get("/api/apps/registry?search=tickets", false),
      await post("/api/apps", {}, false),
      await post("/api/apps/app-x", {}, false),
      await post("/api/apps/app-x/check", {}, false),
      await post("/api/apps/app-x/oauth/start", {}, false),
      await post("/api/apps/app-x/delete", {}, false),
    ]) {
      expect(res.status).toBe(401);
    }
    const metadata = await (await get("/api/apps/oauth/client-metadata.json", false)).json();
    expect(metadata).toMatchObject({ client_id: `${base}/api/apps/oauth/client-metadata.json`, redirect_uris: [`${base}/api/apps/oauth/callback`] });
    const callback = await get("/api/apps/oauth/callback?state=nope&code=x", false);
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/#/integrations/apps?signin=error&reason=invalid");
  });

  it("serves the catalog from memory, and searches the registry", async () => {
    const res = await get("/api/apps/catalog");
    expect(res.headers.get("cache-control")).toBe("private, max-age=3600");
    const body = await res.json();
    expect(body.apps).toHaveLength(APP_CATALOG.length);
    expect(body.redirectUrl).toBe(`${base}/api/apps/oauth/callback`);
    expect(await (await get("/api/apps/registry?search=ti")).json()).toEqual({ apps: [] });
    const found = await (await get("/api/apps/registry?search=tickets")).json();
    expect(found.apps).toEqual([expect.objectContaining({ id: "io.example/tickets", url: "https://tickets.example/mcp", auth: "custom", source: "registry" })]);
    expect(registryCalls).toHaveLength(1);
  });

  it("adds an app with a key after listing its tools, never showing the key", async () => {
    const bad = await post("/api/apps", { presetId: "linear", name: "Linear", url: "https://mcp.example.com/mcp", auth: { type: "bearer", token: "wrong-key-123456" } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Linear refused the sign-in. Check the key, and that it may use the MCP server." });
    for (const [input, error] of [
      [{ name: "X", url: "http://mcp.example.com/mcp", auth: { type: "none" } }, "Use an https:// address."],
      [{ name: "X", url: "https://{stack}.example.com/mcp", auth: { type: "none" } }, "Replace the {placeholder} in the address first."],
      [{ name: "X", url: "https://mcp.example.com/mcp", auth: { type: "bearer", token: "" } }, "Paste the API key."],
      [{ name: "X", url: "https://mcp.example.com/mcp", auth: { type: "none" }, agentIds: ["ghost"] }, 'There is no agent "ghost" on the team.'],
      [{ name: "X", presetId: "nope", url: "https://mcp.example.com/mcp", auth: { type: "none" } }, "That app is not in the catalog."],
    ] as const) {
      const res = await post("/api/apps", input);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(error);
    }

    const res = await post("/api/apps", {
      presetId: "linear",
      name: "Linear",
      url: "https://mcp.example.com/mcp",
      auth: { type: "bearer", token: KEY },
      access: "read",
      agentIds: ["coder", "researcher"],
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(KEY);
    const { app: added } = JSON.parse(text);
    expect(added).toMatchObject({
      id: "app-linear",
      presetId: "linear",
      auth: { type: "bearer", key: "••••y_42" },
      access: "read",
      agentIds: ["coder", "researcher"],
      enabled: true,
      checkedAt: expect.any(String),
    });
    expect(added.tools.map((t: { name: string }) => t.name)).toEqual(["search_issues", "get_issue", "create_issue", "delete.issue"]);
    const state = await config();
    expect(JSON.stringify(state)).not.toContain(KEY);
    expect(state.team.agents.filter((a: { apps: string[] }) => a.apps.includes("app-linear")).map((a: { id: string }) => a.id)).toEqual(["coder", "researcher"]);
  });

  it("updates access, tools, agents and the key, and re-lists tools", async () => {
    const res = await post("/api/apps/app-linear", { access: "write", disabledTools: ["delete.issue", "delete.issue"], agentIds: ["qa"], name: "Linear (work)" });
    expect((await res.json()).app).toMatchObject({ name: "Linear (work)", access: "write", disabledTools: ["delete.issue"], agentIds: ["qa"] });
    const agents = (await config()).team.agents as { id: string; apps: string[] }[];
    expect(agents.filter((a) => a.apps.includes("app-linear")).map((a) => a.id)).toEqual(["qa"]);
    // An empty key keeps the saved one; a wrong new one is refused and not saved.
    expect((await post("/api/apps/app-linear", { auth: { type: "bearer", token: "" } })).status).toBe(200);
    const wrong = await post("/api/apps/app-linear", { auth: { type: "bearer", token: "another-wrong-key-99" } });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).not.toContain("another-wrong-key-99");
    expect((await post("/api/apps/app-linear/check", {})).status).toBe(200);
    expect((await post("/api/apps/app-nope/check", {})).status).toBe(404);
    expect((await post("/api/apps/NOT-AN-ID", {})).status).toBe(404);
  });

  it("signs in with OAuth: start, callback with a single-use state, tools listed with the new token", async () => {
    const res = await post("/api/apps", { name: "Tracker", url: "https://mcp.example.com/oauth-mcp", auth: { type: "oauth" }, agentIds: ["coder"] });
    expect(res.status).toBe(200);
    const { app: added, signInUrl } = await res.json();
    expect(added).toMatchObject({ id: "app-tracker", auth: { type: "oauth", signedIn: false }, tools: [] });
    const authorize = new URL(signInUrl);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${base}/api/apps/oauth/callback`);
    const state = authorize.searchParams.get("state")!;

    const wrong = await get(`/api/apps/oauth/callback?state=${"y".repeat(32)}&code=good-code`, false);
    expect(wrong.headers.get("location")).toBe("/#/integrations/apps?signin=error&reason=invalid");
    const done = await get(`/api/apps/oauth/callback?state=${state}&code=good-code`, false);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/#/integrations/apps/app-tracker?signin=ok");
    const again = await get(`/api/apps/oauth/callback?state=${state}&code=good-code`, false);
    expect(again.headers.get("location")).toBe("/#/integrations/apps?signin=error&reason=invalid");

    const view = ((await config()).apps as { id: string; auth: unknown; tools: unknown[] }[]).find((a) => a.id === "app-tracker")!;
    expect(view.auth).toEqual({ type: "oauth", signedIn: true });
    expect(view.tools).toHaveLength(4);
    const raw = JSON.stringify(await config());
    expect(raw).not.toContain("access-token-1");
    expect(raw).not.toContain("refresh-token-1");

    // Starting again gives a new address; refusing at the vendor uses that state up.
    const restart = await (await post("/api/apps/app-tracker/oauth/start", {})).json();
    const state2 = new URL(restart.url).searchParams.get("state")!;
    const refused = await get(`/api/apps/oauth/callback?state=${state2}&error=access_denied`, false);
    expect(refused.headers.get("location")).toBe("/#/integrations/apps/app-tracker?signin=error&reason=denied");
  });

  it("removes an app and takes it off every agent", async () => {
    expect((await post("/api/apps/app-linear/delete", {})).status).toBe(200);
    expect((await post("/api/apps/app-linear/delete", {})).status).toBe(404);
    const state = await config();
    expect(state.apps.map((a: { id: string }) => a.id)).toEqual(["app-tracker"]);
    expect(state.team.agents.some((a: { apps: string[] }) => a.apps.includes("app-linear"))).toBe(false);
  });

  it("names new apps uniquely", () => {
    expect(newAppId("Linear", new Set())).toBe("app-linear");
    expect(newAppId("Linear", new Set(["app-linear"]))).toBe("app-linear-2");
    expect(newAppId("X", new Set())).toBe("app-x-app");
    expect(newAppId("Ünïcode!! Server", new Set())).toBe("app-n-code-server");
  });
});
