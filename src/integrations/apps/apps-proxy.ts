/**
 * The apps' MCP servers as Claude Code sees them: a proxy on 127.0.0.1, in
 * this process (the web service for chat, the worker for a repo task).
 *
 * Claude Code connects to http://127.0.0.1:<port>/<app id>/<all|read> with a
 * random per-process key in x-proxy-key; it never gets an app's address or
 * credentials, so it cannot be redirected anywhere and nothing it shares
 * (its command line, its MCP config) carries a token. The proxy answers the
 * MCP protocol itself (Streamable HTTP, stateless) and reaches the app
 * through an MCP client of its own: every request through guardedFetch
 * (public https addresses only, pinned DNS, redirects checked), with the
 * credentials added per request (a key, headers, a current OAuth token).
 *
 * Only tools are offered: tools/list returns the route's allowed tools and
 * tools/call refuses any other, decided on the app's current settings.
 * Progress notifications of a long call stream back to Claude Code. Bodies
 * are never logged.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { McpHttpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { type FetchLike, type NetGuardOptions, assertPublicUrl, guardedFetch } from "./apps-net.js";
import type { AppConnection } from "../../core/config.js";
import { randomToken, safeEqual } from "../../core/crypto.js";

/** The header Claude Code sends the proxy's key in. */
export const PROXY_KEY_HEADER = "x-proxy-key";
/** "all": the app's allowed tools; "read": only its read-only ones (agents that only look). */
export type ProxyScope = "all" | "read";
/** A tool call may take this long (progress notifications restart the clock). */
export const PROXY_CALL_TIMEOUT_MS = 10 * 60_000;
const CONNECT_TIMEOUT_MS = 15_000;
const TOOLS_CACHE_MS = 5 * 60_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_TOOLS = 500;
const ROUTE_RE = /^\/(app-[a-z0-9][a-z0-9-]{1,40})\/(all|read)\/?$/;

/** Where a route's app, credentials and allowed tools come from. Each is asked per request, so a change applies at once. */
export interface ProxySource {
  /** The app now. Throws when it may not be used (removed, turned off, signed out). */
  app(): Promise<AppConnection>;
  /** The credentials for a request to it: Authorization, its headers, a current OAuth token. */
  headers(app: AppConnection): Promise<Record<string, string>>;
  /** The tools this route offers. */
  tools(app: AppConnection): string[];
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * An MCP client connected to the app's server (Streamable HTTP or SSE),
 * every request through guardedFetch with `headers()` added. Used by the
 * proxy and to list an app's tools when it is added or checked.
 */
export async function openUpstream(
  app: Pick<AppConnection, "url" | "transport">,
  headers: () => Promise<Record<string, string>>,
  net: NetGuardOptions & { timeoutMs?: number } = {},
): Promise<Client> {
  const guarded = guardedFetch(net);
  const fetch: FetchLike = async (url, init) => {
    const merged = new Headers(init?.headers);
    for (const [name, value] of Object.entries(await headers())) merged.set(name, value);
    return guarded(url, { ...init, headers: merged });
  };
  const url = await assertPublicUrl(app.url, net);
  const transport = app.transport === "sse" ? new SSEClientTransport(url, { fetch }) : new StreamableHTTPClientTransport(url, { fetch });
  const client = new Client({ name: "agent-army", version: "1.0.0" });
  await client.connect(transport, { timeout: net.timeoutMs ?? CONNECT_TIMEOUT_MS });
  return client;
}

/** Every tool the server lists, page by page, at most 500. */
export async function listAllTools(client: Client, timeout = CONNECT_TIMEOUT_MS, signal?: AbortSignal): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20 && tools.length < MAX_TOOLS; page++) {
    const res = await client.listTools(cursor ? { cursor } : undefined, { timeout, ...(signal ? { signal } : {}) });
    tools.push(...res.tools.slice(0, MAX_TOOLS - tools.length));
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

interface Upstream {
  client: Promise<Client>;
  tools?: { at: number; list: Tool[] };
}

export interface AppProxyOptions {
  /** How the proxy reaches apps (tests pass a fetch). */
  net?: NetGuardOptions;
  callTimeoutMs?: number;
  warn?: (message: string) => void;
}

export class AppProxy {
  /** Random per process; Claude Code sends it in x-proxy-key. */
  readonly secret = randomToken(32);
  private readonly routes = new Map<string, { appId: string; source: ProxySource }>();
  private readonly upstreams = new Map<string, Upstream>();
  private listening: Promise<number> | undefined;
  private http: HttpServer | undefined;

  constructor(private readonly opts: AppProxyOptions = {}) {}

  /**
   * Registers (or replaces) the route for an app and scope and returns the
   * server config Claude Code gets: the loopback address and the proxy key,
   * nothing of the app's own. Starts connecting to the app in the background.
   */
  async serverConfig(appId: string, scope: ProxyScope, source: ProxySource): Promise<McpHttpServerConfig> {
    this.routes.set(`${appId}/${scope}`, { appId, source });
    const port = await this.start();
    void source
      .app()
      .then((app) => this.upstream(app, source))
      .catch(() => undefined);
    return { type: "http", url: `http://127.0.0.1:${port}/${appId}/${scope}`, headers: { [PROXY_KEY_HEADER]: this.secret } };
  }

  /** The port, once listening on 127.0.0.1. The server never keeps the process alive. */
  start(): Promise<number> {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.unref();
        this.http = server;
        const address = server.address();
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("The app proxy has no port."));
      });
    });
    return this.listening;
  }

  async close(): Promise<void> {
    for (const u of this.upstreams.values()) await u.client.then((c) => c.close()).catch(() => undefined);
    this.upstreams.clear();
    const server = this.http;
    this.http = undefined;
    this.listening = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private warn(message: string) {
    (this.opts.warn ?? ((m: string) => console.warn(m)))(message);
  }

  /** One connection per app address, shared by its routes and kept between requests. */
  private upstreamKey = (app: AppConnection) => `${app.id} ${app.transport} ${app.url}`;

  private upstream(app: AppConnection, source: ProxySource): Upstream {
    const key = this.upstreamKey(app);
    let entry = this.upstreams.get(key);
    if (!entry) {
      const client = openUpstream(app, async () => source.headers(await source.app()), this.opts.net).then((c) => {
        // A server that says its tools changed is listed again on the next request.
        c.setNotificationHandler(ToolListChangedNotificationSchema, () => {
          const current = this.upstreams.get(key);
          if (current) current.tools = undefined;
        });
        return c;
      });
      entry = { client };
      this.upstreams.set(key, entry);
      client.catch(() => {
        if (this.upstreams.get(key) === entry) this.upstreams.delete(key);
      });
    }
    return entry;
  }

  /** Runs `fn` on the app's connection; a connection that broke (an expired session, a dropped stream) is opened again once. */
  private async withUpstream<T>(app: AppConnection, source: ProxySource, fn: (client: Client, entry: Upstream) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const entry = this.upstream(app, source);
      const client = await entry.client;
      try {
        return await fn(client, entry);
      } catch (err) {
        // Errors the server answered with (McpError) are the answer; anything else is the connection.
        if (err instanceof McpError || attempt > 0) throw err;
        if (this.upstreams.get(this.upstreamKey(app)) === entry) this.upstreams.delete(this.upstreamKey(app));
        await client.close().catch(() => undefined);
      }
    }
  }

  private async tools(app: AppConnection, source: ProxySource, signal: AbortSignal): Promise<Tool[]> {
    return this.withUpstream(app, source, async (client, entry) => {
      if (entry.tools && Date.now() - entry.tools.at < TOOLS_CACHE_MS) return entry.tools.list;
      const list = await listAllTools(client, CONNECT_TIMEOUT_MS, signal);
      entry.tools = { at: Date.now(), list };
      return list;
    });
  }

  /** The MCP server one request is answered by: tools only, decided per request. */
  private mcpServer(route: { appId: string; source: ProxySource }): Server {
    const { source } = route;
    const server = new Server({ name: route.appId, version: "1.0.0" }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
      let app: AppConnection;
      try {
        app = await source.app();
      } catch (err) {
        throw new McpError(ErrorCode.InvalidRequest, messageOf(err));
      }
      const allowed = new Set(source.tools(app));
      const tools = await this.tools(app, source, extra.signal);
      return { tools: tools.filter((t) => allowed.has(t.name)) };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
      const refuse = (text: string): CallToolResult => ({ isError: true, content: [{ type: "text", text }] });
      let app: AppConnection;
      try {
        app = await source.app();
      } catch (err) {
        return refuse(messageOf(err));
      }
      const { name, arguments: args } = request.params;
      if (!source.tools(app).includes(name)) return refuse(`${name} is not one of the ${app.name} tools that may be used here.`);
      const progressToken = request.params._meta?.progressToken;
      try {
        const result = await this.withUpstream(app, source, (client) =>
          client.callTool({ name, ...(args ? { arguments: args } : {}) }, undefined, {
            timeout: this.opts.callTimeoutMs ?? PROXY_CALL_TIMEOUT_MS,
            resetTimeoutOnProgress: true,
            signal: extra.signal,
            ...(progressToken !== undefined
              ? {
                  onprogress: (p) =>
                    void extra.sendNotification({ method: "notifications/progress", params: { progressToken, ...p } }).catch(() => undefined),
                }
              : {}),
          }),
        );
        return result as CallToolResult;
      } catch (err) {
        if (err instanceof McpError) throw err;
        this.warn(`[apps] ${app.name}: ${name} failed: ${messageOf(err).slice(0, 200)}`);
        return refuse(`${app.name} could not be reached: ${messageOf(err).slice(0, 200)}`);
      }
    });
    return server;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, message: string, headers: Record<string, string> = {}) => {
      if (res.headersSent) return void res.end();
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }));
    };
    try {
      const key = req.headers[PROXY_KEY_HEADER];
      if (typeof key !== "string" || !safeEqual(key, this.secret)) return reply(401, "Unauthorized");
      const match = new URL(req.url ?? "/", "http://127.0.0.1").pathname.match(ROUTE_RE);
      const route = match ? this.routes.get(`${match[1]}/${match[2]}`) : undefined;
      if (!route) return reply(404, "No such app");
      // Stateless: no server-initiated stream and no session to end.
      if (req.method !== "POST") return reply(405, "Method not allowed", { allow: "POST" });
      const body = await readJson(req);
      if (body === undefined) return reply(400, "Parse error");
      const server = this.mcpServer(route);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close().catch(() => undefined);
        void server.close().catch(() => undefined);
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      this.warn(`[apps] proxy request failed: ${messageOf(err).slice(0, 200)}`);
      reply(500, "Internal error");
    }
  }
}

/** The request's JSON body (at most 4 MB), or undefined when it is not JSON. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

let shared: AppProxy | undefined;

/** This process's proxy (the web service's, or a repo task's worker's). */
export const appProxy = (): AppProxy => (shared ??= new AppProxy());
