/**
 * The Gemini bridge: a small HTTP server inside this process that answers
 * Claude Code's Anthropic Messages API requests by calling the Gemini API
 * with the owner's Google AI Studio key (Pointer and the team run on Claude
 * Code, which speaks only Anthropic's API).
 *
 * - One per process, started on first use (GeminiBridge.open, from a
 *   google-ai runtime's session()), on 127.0.0.1 with a port the system picks.
 *   It never listens on another interface, answers only loopback peers with
 *   this Host, and refuses browsers (any Origin header).
 * - Each session gets a token of its own (sessions.ts); Claude Code sends it
 *   as its API key. The Gemini key stays in this process: it is in neither
 *   Claude Code's environment nor the agents' shell, and a token stops working
 *   when its session ends.
 * - POST /v1/messages (streaming or not) and /v1/messages/count_tokens.
 *   Anything else is a 404 in Anthropic's format, which Claude Code takes in
 *   its stride (model discovery and managed settings are opt-in or https only).
 *   A stream pings every 15 s, as Anthropic's do: Claude Code gives up on a
 *   stream that sends nothing for a few minutes, and Gemini may think longer.
 * - Request bodies up to 32 MB. Gemini calls have deadlines (upstream.ts), the
 *   only time limits they have (they go over node:https, not the global
 *   fetch, which gives up after 5 minutes without a byte), and stop when
 *   Claude Code hangs up. When Gemini sends nothing for too long, the answer
 *   is a 529 overloaded_error (errors.ts silenceError); when it cannot be
 *   reached, a 500 api_error with the network error's code. Nothing logged
 *   holds the key, a token or what was sent.
 * - Each session has limits of its own: requests in flight at once, and
 *   requests in all. Its token is in the environment of everything the query
 *   runs, a repo task's shell included, where the checkout's own (untrusted)
 *   code runs too: the limits bound what that code can spend through the
 *   bridge, on top of the task's own budget, which only Claude Code's
 *   requests count against. Past one, a 429 rate_limit_error, as Anthropic
 *   answers.
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ModelTier } from "../../core/config.js";
import type { FetchLike } from "../../integrations/apps/apps-net.js";
import { BridgeError, errorBody, geminiError, toBridgeError } from "./errors.js";
import { type Translated, countTokensBody, translateRequest } from "./request.js";
import { type ResponseContext, StreamTranslator, newId, translateResponse } from "./response.js";
import { type BridgeSession, SessionRegistry } from "./sessions.js";
import { type MessagesRequest, MessagesRequestSchema } from "./types.js";
import { Deadline, type UpstreamOptions, callGemini, geminiFetch, sseJson, timeoutOr } from "./upstream.js";

export interface GeminiBridgeOptions {
  /** The fetch for Gemini calls (tests pass a fake). Default: geminiFetch (node:https, no time limit but the deadlines below). */
  fetch?: FetchLike;
  /** A whole Gemini call, or the wait for a stream to start (default 10 minutes, as Claude Code's own). */
  timeoutMs?: number;
  /** The longest gap between a stream's chunks (default 10 minutes: Gemini may think that long before it writes). */
  idleTimeoutMs?: number;
  /** The largest request body (default 32 MB). */
  maxBodyBytes?: number;
  /** How often a stream pings while Gemini thinks (default 15 s). */
  pingMs?: number;
  /** How long a stream waits for Gemini to answer before it starts anyway (default 10 s). */
  streamStartMs?: number;
  /** Requests one session may have in flight at once (default 8). */
  maxConcurrent?: number;
  /** Requests one session may make in all (default 10 000). */
  maxRequests?: number;
  log?: (line: string) => void;
}

/** A session's way in: the base URL (no /v1) and token Claude Code is given. */
export interface BridgeHandle {
  baseUrl: string;
  token: string;
  /** Ends the session: its token stops working. Never throws. */
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
export const MAX_BODY_BYTES = 32 * 1024 * 1024;
const PING_MS = 15_000;
const STREAM_START_MS = 10_000;
/**
 * A query's lead and the subagents it runs side by side each have one request
 * in flight at a time, with room for Claude Code's own small calls; a 429
 * past it is retried by Claude Code after a pause (retry-after).
 */
export const MAX_CONCURRENT = 8;
/** Far above a long repo task's requests (its runs and fix rounds share one session): a bound on a loop, not on work. */
export const MAX_REQUESTS = 10_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A failure for the log: status, type, the network error's code when there was one, and the (redacted) message. */
const failureLine = (e: BridgeError): string => `${e.status} ${e.type}${e.code ? ` (cause ${e.code})` : ""}: ${e.message.slice(0, 200)}`;
const isLoopback =(address: string | undefined) => !!address && /^(?:::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$|^::1$/.test(address);

/** The token Claude Code sends: a Bearer token (ANTHROPIC_AUTH_TOKEN) or x-api-key (ANTHROPIC_API_KEY). */
function tokenOf(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && /^Bearer\s+\S/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const key = req.headers["x-api-key"];
  return typeof key === "string" && key.trim() ? key.trim() : undefined;
}

async function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  const tooLarge = () => new BridgeError(413, "request_too_large", `The request is larger than the Gemini bridge's ${Math.round(max / 1024 / 1024)} MB limit.`);
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw tooLarge();
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new BridgeError(400, "invalid_request_error", "The request body is not JSON.");
  }
}

function parseRequest(json: unknown, needsMaxTokens: boolean): MessagesRequest {
  const parsed = MessagesRequestSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BridgeError(400, "invalid_request_error", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`.slice(0, 300));
  }
  if (needsMaxTokens && parsed.data.max_tokens === undefined) throw new BridgeError(400, "invalid_request_error", "max_tokens: Field required");
  return parsed.data;
}

const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

export class GeminiBridge {
  readonly sessions = new SessionRegistry();
  private server?: Server;
  private listening?: Promise<number>;
  private readonly upstream: UpstreamOptions;
  private readonly maxBodyBytes: number;
  private readonly pingMs: number;
  private readonly streamStartMs: number;
  private readonly maxConcurrent: number;
  private readonly maxRequests: number;
  private readonly log: (line: string) => void;

  constructor(opts: GeminiBridgeOptions = {}) {
    this.upstream = {
      fetch: opts.fetch ?? geminiFetch(),
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    };
    this.maxBodyBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES;
    this.pingMs = opts.pingMs ?? PING_MS;
    this.streamStartMs = opts.streamStartMs ?? STREAM_START_MS;
    this.maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT;
    this.maxRequests = opts.maxRequests ?? MAX_REQUESTS;
    this.log = opts.log ?? ((line) => console.warn(line));
  }

  /** A new session for this key and tier models, starting the server if it is not running yet. */
  async open(apiKey: string, models: Record<ModelTier, string>): Promise<BridgeHandle> {
    const port = await this.start();
    const { token, close } = this.sessions.open(apiKey, models);
    return { baseUrl: `http://127.0.0.1:${port}`, token, close };
  }

  /** The port it listens on, starting it on first use (on loopback only). */
  start(): Promise<number> {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        server.on("error", (err) => this.log(`[gemini-bridge] server error: ${err.message}`));
        // Never what keeps the process alive: a query running on it does that.
        server.unref();
        this.server = server;
        resolve((server.address() as AddressInfo).port);
      });
    }).catch((err: unknown) => {
      this.listening = undefined;
      throw err;
    });
    return this.listening;
  }

  /** Stops listening and drops open connections (tests, shutdown). */
  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.listening = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private hostAllowed(host: string | undefined): boolean {
    const port = (this.server?.address() as AddressInfo | null)?.port;
    return !!host && !!port && [`127.0.0.1:${port}`, `localhost:${port}`].includes(host.toLowerCase());
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("request-id", newId("req_"));
    let session: BridgeSession | undefined;
    try {
      if (!isLoopback(req.socket.remoteAddress)) throw new BridgeError(403, "permission_error", "The Gemini bridge answers only this machine.");
      if (req.headers.origin !== undefined) throw new BridgeError(403, "permission_error", "The Gemini bridge does not answer browsers.");
      if (!this.hostAllowed(req.headers.host)) throw new BridgeError(403, "permission_error", "The Gemini bridge does not answer this Host.");
      const known = this.sessions.authenticate(tokenOf(req));
      if (!known) throw new BridgeError(401, "authentication_error", "Invalid bridge token: unknown, or its session has ended.");
      session = known;
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "POST" && path === "/v1/messages") return await this.limited(known, () => this.messages(req, res, known));
      if (req.method === "POST" && path === "/v1/messages/count_tokens") return await this.limited(known, () => this.countTokens(req, res, known));
      throw new BridgeError(404, "not_found_error", "The Gemini bridge serves POST /v1/messages and /v1/messages/count_tokens only.");
    } catch (err) {
      const e = toBridgeError(err, session?.redact);
      if (e.status >= 500 || e.status === 429) this.log(`[gemini-bridge] ${failureLine(e)}`);
      // A body left unread (too large) is not drained: the connection closes after the answer.
      sendJson(res, e.status, errorBody(e.type, e.message), { ...e.headers, ...(e.status === 413 ? { connection: "close" } : {}) });
    }
  }

  /**
   * One request of a session within its limits (SessionLoad): past the
   * requests in flight at once, a 429 that asks for a retry a second later;
   * past the requests in all, a 429 that asks for none (x-should-retry, which
   * Anthropic's SDK honours): the session has had its share.
   */
  private async limited(session: BridgeSession, serve: () => Promise<void>): Promise<void> {
    const { load } = session;
    if (load.requests >= this.maxRequests) {
      throw new BridgeError(429, "rate_limit_error", `This session has made the ${this.maxRequests} requests the Gemini bridge allows one session.`, { "x-should-retry": "false" });
    }
    if (load.inFlight >= this.maxConcurrent) {
      throw new BridgeError(429, "rate_limit_error", `This session already has ${this.maxConcurrent} requests in progress on the Gemini bridge. Try again when one has finished.`, {
        "retry-after": "1",
      });
    }
    load.inFlight += 1;
    load.requests += 1;
    try {
      await serve();
    } finally {
      load.inFlight -= 1;
    }
  }

  /** A deadline for one Gemini call that also ends when Claude Code hangs up. */
  private deadlineFor(res: ServerResponse): Deadline {
    const deadline = new Deadline();
    res.once("close", () => {
      if (!res.writableFinished) deadline.controller.abort(new Error("Claude Code closed the connection."));
    });
    return deadline;
  }

  private async messages(req: IncomingMessage, res: ServerResponse, session: BridgeSession): Promise<void> {
    const body = parseRequest(await readJson(req, this.maxBodyBytes), true);
    const t = translateRequest(body, session);
    const ctx: ResponseContext = { model: t.model, names: t.names, calls: session.calls };
    const deadline = this.deadlineFor(res);
    if (!body.stream) {
      const answer = await callGemini(this.upstream, session.apiKey, t.model, "generateContent", t.request, deadline, session.redact);
      let json: unknown;
      try {
        json = await answer.json();
      } catch (err) {
        const e = timeoutOr(err, deadline, session.redact);
        throw e instanceof BridgeError ? e : new BridgeError(500, "api_error", "The Gemini API answered with something that is not JSON.");
      } finally {
        deadline.clear();
      }
      sendJson(res, 200, translateResponse(json, ctx));
      return;
    }

    await this.stream(res, session, t, ctx, deadline);
  }

  /**
   * A streamed answer. Until Gemini answers, a failure is a plain error
   * answer with its status (what Claude Code retries and routing falls back
   * on). Gemini usually answers at once; when it has not after streamStartMs,
   * the stream starts anyway and pings keep Claude Code from giving up on it,
   * and from then on a failure is the stream's error event.
   */
  private async stream(res: ServerResponse, session: BridgeSession, t: Translated, ctx: ResponseContext, deadline: Deadline): Promise<void> {
    const stream = new StreamTranslator(ctx);
    const write = (text: string) => {
      if (text && !res.destroyed && !res.writableEnded) res.write(text);
    };
    let ping: NodeJS.Timeout | undefined;
    const begin = () => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
      write(stream.start());
      ping = setInterval(() => write(stream.ping()), this.pingMs);
      ping.unref();
    };
    const early = setTimeout(begin, this.streamStartMs);
    early.unref();
    let answer: Response | undefined;
    try {
      answer = await callGemini(this.upstream, session.apiKey, t.model, "streamGenerateContent", t.request, deadline, session.redact);
      clearTimeout(early);
      if (!answer.body) throw new BridgeError(500, "api_error", "The Gemini API sent an empty stream.");
      begin();
      for await (const chunk of sseJson(answer.body, deadline, this.upstream.idleTimeoutMs)) {
        // Gemini reports a failure half way as an event with an error in it.
        if (isObject(chunk) && isObject(chunk.error)) {
          const code = typeof chunk.error.code === "number" ? chunk.error.code : 500;
          throw geminiError(code, chunk, session.redact);
        }
        write(stream.push(chunk));
      }
      write(stream.end());
    } catch (err) {
      clearTimeout(early);
      const e = toBridgeError(timeoutOr(err, deadline, session.redact), session.redact);
      if (!res.headersSent) throw e;
      if (!res.destroyed) {
        this.log(`[gemini-bridge] stream failed: ${failureLine(e)}`);
        write(stream.error(e.type, e.message));
      }
    } finally {
      clearInterval(ping);
      deadline.clear();
      await answer?.body?.cancel().catch(() => undefined);
      if (res.headersSent && !res.writableEnded) res.end();
    }
  }

  private async countTokens(req: IncomingMessage, res: ServerResponse, session: BridgeSession): Promise<void> {
    const body = parseRequest(await readJson(req, this.maxBodyBytes), false);
    const t = translateRequest(body, session);
    const deadline = this.deadlineFor(res);
    const answer = await callGemini(this.upstream, session.apiKey, t.model, "countTokens", countTokensBody(t), deadline, session.redact);
    let json: unknown;
    try {
      json = await answer.json();
    } catch (err) {
      const e = timeoutOr(err, deadline, session.redact);
      throw e instanceof BridgeError ? e : new BridgeError(500, "api_error", "The Gemini API answered with something that is not JSON.");
    } finally {
      deadline.clear();
    }
    const total = isObject(json) && typeof json.totalTokens === "number" ? json.totalTokens : 0;
    sendJson(res, 200, { input_tokens: total });
  }
}

let shared: GeminiBridge | undefined;

/** The process's bridge (started on its first session). */
export const sharedGeminiBridge = (): GeminiBridge => (shared ??= new GeminiBridge());
