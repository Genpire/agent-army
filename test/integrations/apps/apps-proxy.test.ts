import { type IncomingHttpHeaders, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FetchLike } from "../../../src/integrations/apps/apps-net.js";
import { AppProxy, PROXY_KEY_HEADER, type ProxyScope, type ProxySource } from "../../../src/integrations/apps/apps-proxy.js";
import { allowedToolsOf, readOnlyToolsOf } from "../../../src/integrations/apps/apps.js";
import { type AppConnection, AppConnectionSchema } from "../../../src/core/config.js";

const KEY = "up-secret-key-123456";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A real MCP server (Streamable HTTP, stateless) on 127.0.0.1: the app the proxy reaches. */
async function upstreamServer() {
  const seen: { headers: IncomingHttpHeaders; method?: string; tool?: string }[] = [];
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    seen.push({ headers: req.headers, method: body?.method, tool: body?.params?.name });
    if (req.method !== "POST") return void res.writeHead(405).end();
    if (req.headers.authorization !== `Bearer ${KEY}`) return void res.writeHead(401).end("Unauthorized");
    const server = new Server({ name: "upstream", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: "search", description: "Search", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
        { name: "create", description: "Create", inputSchema: { type: "object" } },
        { name: "slow_count", description: "Counts slowly", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
        { name: "hidden", description: "Never offered", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (request.params.name === "slow_count") {
        const token = request.params._meta?.progressToken;
        for (let i = 1; i <= 3; i++) {
          await sleep(40);
          if (token !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: i, total: 3 } });
        }
        return { content: [{ type: "text", text: "counted to 3" }] };
      }
      return { content: [{ type: "text", text: `called ${request.params.name} with ${JSON.stringify(request.params.arguments ?? {})}` }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  const port = (http.address() as AddressInfo).port;
  return { port, seen, close: () => new Promise<void>((r) => http.close(() => r())) };
}

describe("app proxy", () => {
  let upstream: Awaited<ReturnType<typeof upstreamServer>>;
  let proxy: AppProxy;
  let current: AppConnection;
  let signedOut = false;
  const clients: Client[] = [];

  /** The app's https address, served by the local upstream (the guard itself is tested in apps.test.ts). */
  const toUpstream: FetchLike = (url, init) => globalThis.fetch(String(url).replace("https://upstream.example.com", `http://127.0.0.1:${upstream.port}`), init);

  const source = (scope: ProxyScope): ProxySource => ({
    app: async () => {
      if (signedOut) throw new Error("Upstream is not signed in. Sign in on the Integrations page.");
      return current;
    },
    headers: async () => ({ Authorization: `Bearer ${KEY}` }),
    tools: (a) => (scope === "read" ? readOnlyToolsOf(a) : allowedToolsOf(a)),
  });

  /** An MCP client as Claude Code is one: the loopback address and the proxy key, nothing else. */
  async function connect(scope: ProxyScope) {
    const config = await proxy.serverConfig("app-upstream", scope, source(scope));
    const client = new Client({ name: "claude-code", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
    clients.push(client);
    return { client, config };
  }

  beforeAll(async () => {
    upstream = await upstreamServer();
    proxy = new AppProxy({ net: { fetch: toUpstream }, warn: () => {} });
    current = AppConnectionSchema.parse({
      id: "app-upstream",
      name: "Upstream",
      url: "https://upstream.example.com/mcp",
      auth: { type: "bearer", token: KEY },
      access: "write",
      disabledTools: ["hidden"],
      tools: [
        { name: "search", readOnly: true },
        { name: "create", readOnly: false },
        { name: "slow_count", readOnly: true },
        { name: "hidden", readOnly: true },
      ],
    });
  });
  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    await proxy.close();
    await upstream.close();
  });

  it("answers only requests with its key, on a known route, over POST", async () => {
    const { config } = await connect("all");
    const post = (url: string, headers: Record<string, string>) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    expect((await post(config.url, {})).status).toBe(401);
    expect((await post(config.url, { [PROXY_KEY_HEADER]: "wrong-key" })).status).toBe(401);
    expect((await post(config.url.replace("app-upstream", "app-other"), { [PROXY_KEY_HEADER]: proxy.secret })).status).toBe(404);
    expect((await fetch(config.url, { headers: { [PROXY_KEY_HEADER]: proxy.secret } })).status).toBe(405);
    // Claude Code's config holds the loopback address and the proxy key only.
    expect(JSON.stringify(config)).not.toContain(KEY);
    expect(config.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/app-upstream\/all$/);
  });

  it("lists and calls only the route's allowed tools, decided per request", async () => {
    const all = (await connect("all")).client;
    const read = (await connect("read")).client;
    expect((await all.listTools()).tools.map((t) => t.name)).toEqual(["search", "create", "slow_count"]);
    expect((await read.listTools()).tools.map((t) => t.name)).toEqual(["search", "slow_count"]);

    const before = upstream.seen.filter((s) => s.method === "tools/call").length;
    const refused = await read.callTool({ name: "create", arguments: {} });
    expect(refused).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("create is not one of the Upstream tools") }] });
    expect(await all.callTool({ name: "hidden", arguments: {} })).toMatchObject({ isError: true });
    expect(await all.callTool({ name: "unknown_tool", arguments: {} })).toMatchObject({ isError: true });
    // Refused calls never reach the app.
    expect(upstream.seen.filter((s) => s.method === "tools/call").length).toBe(before);

    expect(await all.callTool({ name: "create", arguments: { title: "Bug" } })).toMatchObject({ content: [{ type: "text", text: 'called create with {"title":"Bug"}' }] });
    // The app gets its key from the proxy, and never the proxy's key.
    const call = upstream.seen.filter((s) => s.tool === "create").at(-1)!;
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.headers[PROXY_KEY_HEADER]).toBeUndefined();

    // The owner turns a tool off: the next request knows.
    current = { ...current, disabledTools: ["hidden", "search"] };
    expect((await all.listTools()).tools.map((t) => t.name)).toEqual(["create", "slow_count"]);
    expect(await all.callTool({ name: "search", arguments: {} })).toMatchObject({ isError: true });
    current = { ...current, disabledTools: ["hidden"] };
  });

  it("streams a long call's progress back before its result", async () => {
    const { client } = await connect("read");
    const events: string[] = [];
    let firstProgressAt = 0;
    const result = await client.callTool({ name: "slow_count", arguments: {} }, undefined, {
      onprogress: (p) => {
        firstProgressAt ||= Date.now();
        events.push(`progress ${p.progress}/${p.total}`);
      },
    });
    const resultAt = Date.now();
    events.push("result");
    expect(events).toEqual(["progress 1/3", "progress 2/3", "progress 3/3", "result"]);
    expect(result).toMatchObject({ content: [{ type: "text", text: "counted to 3" }] });
    // Streamed as it happened, not delivered with the result: the app waits 40 ms between steps.
    expect(resultAt - firstProgressAt).toBeGreaterThanOrEqual(60);
  });

  it("refuses calls while the app cannot be used, with the reason", async () => {
    const { client } = await connect("all");
    signedOut = true;
    try {
      expect(await client.callTool({ name: "search", arguments: {} })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: "Upstream is not signed in. Sign in on the Integrations page." }],
      });
      await expect(client.listTools()).rejects.toThrow(/not signed in/);
    } finally {
      signedOut = false;
    }
  });
});
