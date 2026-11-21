/**
 * HTTP data sources: the company's own API or its admin panel's, read with
 * GET only. A request is the source's base URL plus a path Pointer gives,
 * which must stay under the base URL (no "..", no other scheme or host) and
 * start with one of the source's allowed paths, if it has any. Every address,
 * the sign-in's and each redirect's included, goes through the apps' network
 * guard (apps-net.ts: https, public addresses checked by what they resolve
 * to, the connection pinned to those addresses); a source marked internal may
 * use private addresses, as may every source when ALLOW_PRIVATE_APP_URLS=1.
 * Credentials are added here, server side, and never shown: a token, Basic,
 * a header, or a sign-in with a user name and password whose token is kept
 * in memory until the API answers 401, then renewed once.
 */
import { createHash } from "node:crypto";
import type { DataSource } from "../../core/config.js";
import { AppUrlError, type FetchLike, type LookupFn, appUrlProblem, guardedFetch } from "../apps/apps-net.js";
import { DATA_LIMITS, DataSourceError, cap, errorText, flat } from "./common.js";

export type HttpConfig = NonNullable<DataSource["http"]>;
type LoginAuth = Extract<HttpConfig["auth"], { type: "login" }>;

export interface HttpDeps {
  env?: NodeJS.ProcessEnv;
  /** Test seam: the fetch underneath the network guard. */
  fetch?: FetchLike;
  lookup?: LookupFn;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface HttpReadResult {
  /** The path read, relative to the source's base URL, with its query. */
  path: string;
  status: number;
  contentType: string;
  /** Bytes read (at most maxBytes). */
  bytes: number;
  /** The response was longer than maxBytes; the rest was not read. */
  truncated: boolean;
  text: string;
}

const USER_AGENT = "agent-army-data-sources/1.0 (read-only)";
const ACCEPT = "application/json, text/plain;q=0.9, */*;q=0.5";
const MAX_REDIRECTS = 3;
/** A sign-in answer bigger than this is not a token. */
const MAX_LOGIN_BYTES = 64 * 1024;

const PRIVATE_HINT = 'That address is on a private network. If the API runs on your own network, turn on "Internal address" for this source.';

/** What the network guard sees for a source: private addresses pass when the source is internal. */
export function guardEnv(internal: boolean, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return internal ? { ...env, ALLOW_PRIVATE_APP_URLS: "1" } : env;
}

/**
 * The network guard's objection to an address (by name only; DNS is checked
 * on each request), with the "Internal address" hint for a private one.
 */
function addressProblem(url: string, internal: boolean, env: NodeJS.ProcessEnv): string | undefined {
  // Its shape first (https, no credentials), as if private addresses were allowed.
  const problem = appUrlProblem(url, guardEnv(true, env));
  if (problem) return problem;
  // Fine once private addresses are allowed, refused otherwise: it is private.
  return !internal && appUrlProblem(url, env) ? PRIVATE_HINT : undefined;
}

const guardMessage = (err: unknown) =>
  err instanceof AppUrlError && /private network/i.test(err.message) ? PRIVATE_HINT : errorText(err);

/** "https://api.example.com/v1/" → "https://api.example.com/v1". */
export const normalizeBaseUrl = (raw: string) => raw.trim().replace(/\/+$/, "");

/** Why a base URL cannot be used, or undefined. */
export function baseUrlProblem(raw: string, internal: boolean, env: NodeJS.ProcessEnv = process.env): string | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "That is not a valid address. Use the API's https:// address, e.g. https://api.example.com.";
  }
  if (u.search || u.hash) return "Leave the query (?…) and fragment (#…) out of the base address; requests add their own.";
  return addressProblem(raw, internal, env);
}

/** Why a sign-in address (absolute, or a path on the base URL's host) cannot be used, or undefined. */
export function loginUrlProblem(raw: string, internal: boolean, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (raw.startsWith("/")) return raw.startsWith("//") ? "Give the sign-in address in full (https://…) or as a path (/api/login)." : pathShapeProblem(raw.split("?")[0] ?? raw);
  try {
    new URL(raw);
  } catch {
    return "The sign-in address is not valid. Give it in full (https://cms.example.com/api/login) or as a path on the base address (/api/login).";
  }
  return addressProblem(raw, internal, env);
}

/** Characters no path may hold: spaces, controls, backslashes, and escapes that hide a dot, slash or NUL. */
function pathShapeProblem(path: string): string | undefined {
  if (/[\u0000- \u007f\\]/.test(path)) return "Paths may not contain spaces, control characters or backslashes; encode a space as %20.";
  if (/%(2e|2f|5c|00)/i.test(path)) return "Paths may not contain encoded dots, slashes or NULs (%2e, %2f, %5c, %00).";
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return "The path has a broken %-escape.";
  }
  if (decoded.split("/").some((s) => s === "." || s === "..")) return 'Paths may not contain "." or ".." segments.';
  return undefined;
}

/** An allowed path as the owner writes it, normalised ("/api/stats"), or the reason it is not one. */
export function normalizeAllowedPath(raw: string): { path: string } | { error: string } {
  let p = raw.trim();
  if (!p) return { error: "An allowed path is empty." };
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith("//")) return { error: `"${flat(p, 60)}" is an address; give a path under the base address, e.g. /api/stats.` };
  if (p.includes("?") || p.includes("#")) return { error: `"${flat(p, 60)}": leave the query out of allowed paths; any query is allowed under them.` };
  if (!p.startsWith("/")) p = `/${p}`;
  const problem = pathShapeProblem(p);
  if (problem) return { error: `"${flat(p, 60)}": ${problem}` };
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return { path: p };
}

/** Whether a path (relative to the base URL, without its query) is under one of the allowed prefixes, segment by segment. */
export function isAllowedPath(path: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  return allowed.some((p) => p === "/" || path === p || path.startsWith(`${p}/`));
}

const basePathOf = (base: URL) => base.pathname.replace(/\/+$/, "");

/** The path of `url` relative to the base URL, decoded, or undefined when it is not under it. */
function relativePath(base: URL, url: URL): string | undefined {
  if (url.origin !== base.origin) return undefined;
  const prefix = basePathOf(base);
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return undefined;
  try {
    return decodeURIComponent(url.pathname.slice(prefix.length)) || "/";
  } catch {
    return undefined;
  }
}

const allowedList = (allowed: string[]) => allowed.join(", ");

/**
 * The address to read for a path Pointer gives ("/api/stats/users?since=2026-11-01"):
 * the base URL plus the path, checked against the allowed paths. Throws DataSourceError.
 */
export function resolveRequestUrl(http: Pick<HttpConfig, "baseUrl" | "allowedPaths">, path: string): URL {
  const given = path.trim();
  if (!given) throw new DataSourceError("Give a path, e.g. /api/stats.");
  if (/^[a-z][a-z0-9+.-]*:/i.test(given) || given.startsWith("//")) {
    throw new DataSourceError("Give a path under the source's address (e.g. /api/stats?since=2026-11-01), not a full address.");
  }
  const withoutFragment = given.split("#")[0] ?? "";
  const q = withoutFragment.indexOf("?");
  let pathPart = q === -1 ? withoutFragment : withoutFragment.slice(0, q);
  const query = q === -1 ? "" : withoutFragment.slice(q + 1);
  if (!pathPart.startsWith("/")) pathPart = `/${pathPart}`;
  const problem = pathShapeProblem(pathPart);
  if (problem) throw new DataSourceError(problem);
  if (/[\u0000- \u007f]/.test(query)) throw new DataSourceError("The query may not contain spaces or control characters; encode a space as %20.");
  pathPart = pathPart.replace(/\/{2,}/g, "/");

  const base = new URL(http.baseUrl);
  const url = new URL(`${base.origin}${basePathOf(base)}${pathPart}${query ? `?${query}` : ""}`);
  const relative = relativePath(base, url);
  if (relative === undefined) throw new DataSourceError("That path leaves the source's address.");
  if (!isAllowedPath(relative, http.allowedPaths)) {
    throw new DataSourceError(`${relative} is not one of the paths allowed for this source (${allowedList(http.allowedPaths)}).`);
  }
  return url;
}

// ---------------------------------------------------------------------------
// Sign-in (auth type "login")

interface LoginEntry {
  key: string;
  token?: string;
  pending?: Promise<string>;
}

/** Sign-in tokens by source id, in memory only; a token whose credentials changed is not used. */
const logins = new Map<string, LoginEntry>();

/** Forgets a source's sign-in token (its settings changed, it was removed, or the API refused the token). */
export function forgetLogin(sourceId: string): void {
  logins.delete(sourceId);
}

/** The sign-in token a source holds now, for redaction. */
export function loginSecrets(sourceId: string): string[] {
  const token = logins.get(sourceId)?.token;
  return token ? [token] : [];
}

const loginKey = (baseUrl: string, a: LoginAuth) =>
  createHash("sha256").update(JSON.stringify([baseUrl, a.loginUrl, a.username, a.password, a.usernameField, a.passwordField, a.tokenPath])).digest("hex");

/** Sets `value` at a dot path ("user.email") in `target`. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".").filter(Boolean);
  let node = target;
  keys.forEach((key, i) => {
    if (i === keys.length - 1) node[key] = value;
    else {
      const next = node[key];
      node = (next && typeof next === "object" ? next : (node[key] = {})) as Record<string, unknown>;
    }
  });
}

/** The value at a dot path ("data.accessToken", "tokens.0") in parsed JSON. */
export function getPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined), value);
}

/** The key paths of a JSON answer, two levels deep and without values: where a token could be. */
function keyPaths(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "no fields";
  const paths = Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v as Record<string, unknown>).slice(0, 10).map((k2) => `${k}.${k2}`) : [k],
  );
  return paths.length ? `the fields ${paths.slice(0, 20).join(", ")}` : "no fields";
}

export function loginUrlOf(http: Pick<HttpConfig, "baseUrl">, auth: Pick<LoginAuth, "loginUrl">): URL {
  return auth.loginUrl.startsWith("/") ? new URL(auth.loginUrl, new URL(http.baseUrl).origin) : new URL(auth.loginUrl);
}

/** Reads at most `max` bytes of a body; the rest is dropped. */
async function readCapped(res: Response, max: number): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", bytes: 0, truncated: false };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.byteLength > max) {
      chunks.push(value.subarray(0, max - bytes));
      bytes = max;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    bytes += value.byteLength;
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), bytes, truncated };
}

const isTimeout = (err: unknown) => err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

function networkMessage(err: unknown, host: string, timeoutMs: number): string {
  if (isTimeout(err)) return `${host} did not answer within ${Math.max(1, Math.round(timeoutMs / 1000))} s.`;
  if (err instanceof AppUrlError) return guardMessage(err);
  const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
  return `Couldn't reach ${host}: ${errorText(err)}${cause}`;
}

async function signIn(http: HttpConfig, auth: LoginAuth, fetcher: FetchLike, signal: AbortSignal, timeoutMs: number): Promise<string> {
  const url = loginUrlOf(http, auth);
  const body: Record<string, unknown> = {};
  setPath(body, auth.usernameField || "email", auth.username);
  setPath(body, auth.passwordField || "password", auth.password);
  let res: Response;
  try {
    res = await fetcher(url.href, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify(body),
      redirect: "manual",
      signal,
    });
  } catch (err) {
    throw new DataSourceError(`Sign-in failed. ${networkMessage(err, url.host, timeoutMs)}`);
  }
  const { text } = await readCapped(res, MAX_LOGIN_BYTES);
  if (res.status < 200 || res.status >= 300) {
    const detail = flat(text, 200);
    throw new DataSourceError(
      `Sign-in at ${url.host}${url.pathname} answered HTTP ${res.status}${detail ? ` (${detail})` : ""}. Check the sign-in address, the user name and the password.`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new DataSourceError(`Sign-in at ${url.host}${url.pathname} answered, but not with JSON, so there is no token to read.`);
  }
  const token = getPath(json, auth.tokenPath || "token");
  if ((typeof token !== "string" && typeof token !== "number") || !String(token).trim()) {
    throw new DataSourceError(
      `Signed in, but the answer has no token at "${auth.tokenPath}". It has ${keyPaths(json)}: set the token path to the one holding the token, e.g. data.accessToken.`,
    );
  }
  return String(token).trim();
}

/** The source's sign-in token: the one kept, or a new sign-in (one at a time per source). */
async function loginToken(source: DataSource, auth: LoginAuth, fetcher: FetchLike, signal: AbortSignal, timeoutMs: number): Promise<string> {
  const http = source.http!;
  const key = loginKey(http.baseUrl, auth);
  const entry = logins.get(source.id);
  if (entry?.key === key) {
    if (entry.token) return entry.token;
    if (entry.pending) return entry.pending;
  }
  const pending = signIn(http, auth, fetcher, signal, timeoutMs);
  const fresh: LoginEntry = { key, pending };
  logins.set(source.id, fresh);
  try {
    const token = await pending;
    if (logins.get(source.id) === fresh) logins.set(source.id, { key, token });
    return token;
  } catch (err) {
    if (logins.get(source.id) === fresh) logins.delete(source.id);
    throw err;
  }
}

async function addAuth(source: DataSource, headers: Headers, fetcher: FetchLike, signal: AbortSignal, timeoutMs: number): Promise<void> {
  const a = source.http!.auth;
  if (a.type === "bearer") headers.set("authorization", `Bearer ${a.token}`);
  else if (a.type === "basic") headers.set("authorization", `Basic ${Buffer.from(`${a.username}:${a.password}`).toString("base64")}`);
  else if (a.type === "header") headers.set(a.name, a.value);
  else if (a.type === "login") headers.set(a.headerName || "Authorization", `${a.headerPrefix}${await loginToken(source, a, fetcher, signal, timeoutMs)}`);
}

/**
 * GETs a path of an HTTP source: the network guard on every address, the
 * source's credentials added, redirects followed only within the source's
 * allowed paths, at most maxBytes read within timeoutMs. With a sign-in, a 401
 * drops the kept token and signs in again, once. Throws DataSourceError.
 */
export async function httpGet(source: DataSource, path: string, deps: HttpDeps = {}): Promise<HttpReadResult> {
  const http = source.http;
  if (source.kind !== "http" || !http) throw new DataSourceError(`${source.name} is not an HTTP source.`);
  const timeoutMs = deps.timeoutMs ?? DATA_LIMITS.timeoutMs;
  const maxBytes = deps.maxBytes ?? DATA_LIMITS.maxResponseBytes;
  const base = new URL(http.baseUrl);
  const first = resolveRequestUrl(http, path);
  const signal = AbortSignal.timeout(timeoutMs);
  const fetcher = guardedFetch({
    env: guardEnv(http.internal, deps.env),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.lookup ? { lookup: deps.lookup } : {}),
    timeoutMs,
  });

  const send = async (): Promise<{ res: Response; url: URL }> => {
    const headers = new Headers({ accept: ACCEPT, "user-agent": USER_AGENT });
    await addAuth(source, headers, fetcher, signal, timeoutMs);
    let url = first;
    for (let hop = 0; ; hop++) {
      let res: Response;
      try {
        res = await fetcher(url.href, { method: "GET", headers, redirect: "manual", signal });
      } catch (err) {
        throw new DataSourceError(networkMessage(err, url.host, timeoutMs));
      }
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location || hop >= MAX_REDIRECTS) return { res, url };
      await res.body?.cancel().catch(() => undefined);
      const next = new URL(location, url);
      const relative = relativePath(base, next);
      if (next.origin !== base.origin) throw new DataSourceError(`The API redirected to ${next.host}; only ${base.host} is read for this source.`);
      if (relative === undefined || !isAllowedPath(relative, http.allowedPaths)) {
        throw new DataSourceError(`The API redirected to ${next.pathname}, which is outside the paths allowed for this source.`);
      }
      url = next;
    }
  };

  let { res, url } = await send();
  if (res.status === 401 && http.auth.type === "login") {
    await res.body?.cancel().catch(() => undefined);
    forgetLogin(source.id);
    ({ res, url } = await send());
  }
  let body: { text: string; bytes: number; truncated: boolean };
  try {
    body = await readCapped(res, maxBytes);
  } catch (err) {
    throw new DataSourceError(networkMessage(err, url.host, timeoutMs));
  }
  return {
    path: `${relativePath(base, url) ?? url.pathname}${url.search}`,
    status: res.status,
    contentType: (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase(),
    ...body,
  };
}

// ---------------------------------------------------------------------------
// What the model sees

const ITEM_STEPS = [50, 20, 10, 5, 3, 1];
const MAX_KEYS = 100;
const MAX_STRING = 500;
const MAX_DEPTH = 12;

function shrink(value: unknown, items: number, depth: number): unknown {
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length} characters)` : value;
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return `[${value.length} items]`;
    const kept = value.slice(0, items).map((v) => shrink(v, items, depth + 1));
    return value.length > items ? [...kept, `… ${value.length - items} more (${value.length} items in all)`] : kept;
  }
  if (value && typeof value === "object") {
    if (depth >= MAX_DEPTH) return "{…}";
    const entries = Object.entries(value as Record<string, unknown>);
    const kept: [string, unknown][] = entries.slice(0, MAX_KEYS).map(([k, v]) => [k, shrink(v, items, depth + 1)]);
    if (entries.length > MAX_KEYS) kept.push(["…", `${entries.length - MAX_KEYS} more fields`]);
    return Object.fromEntries(kept);
  }
  return value;
}

/**
 * JSON for the model within `maxChars`: as it is when it fits, else with
 * long arrays cut to their first items (each saying how many it holds) and
 * long strings shortened, fewer items until it fits.
 */
export function summarizeJson(value: unknown, maxChars: number = DATA_LIMITS.maxOutputChars): { text: string; cut: boolean; items?: number } {
  const full = JSON.stringify(value) ?? "null";
  if (full.length <= maxChars) return { text: full, cut: false };
  for (const items of ITEM_STEPS) {
    const text = JSON.stringify(shrink(value, items, 0)) ?? "null";
    if (text.length <= maxChars) return { text, cut: true, items };
  }
  return { text: cap(JSON.stringify(shrink(value, 1, 0)) ?? "null", maxChars), cut: true, items: 1 };
}

const sizeText = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`);
const BINARY_RE = /^(image|audio|video|font)\/|^application\/(octet-stream|pdf|zip|gzip|x-|vnd\.)/;

const htmlToText = (html: string) =>
  html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

/** A response as text for the model (or a test preview): a status line, then the body, summarised to `maxChars`. */
export function formatHttpResult(r: HttpReadResult, maxChars: number = DATA_LIMITS.maxOutputChars): string {
  const head = `GET ${r.path} → HTTP ${r.status} · ${r.contentType || "no content type"} · ${sizeText(r.bytes)}${r.truncated ? "+" : ""}`;
  const notes: string[] = [];
  if (r.truncated) {
    notes.push(
      `The response is larger than ${sizeText(DATA_LIMITS.maxResponseBytes)}: only the start was read. Ask for less with query parameters (filters, a date range, a smaller page, a count or stats endpoint).`,
    );
  }
  const budget = Math.max(200, maxChars - head.length - 400);
  let body: string;
  const looksJson = r.contentType.includes("json") || /^\s*[[{]/.test(r.text);
  let parsed: { ok: true; value: unknown } | { ok: false } = { ok: false };
  if (looksJson && !r.truncated) {
    try {
      parsed = { ok: true, value: JSON.parse(r.text) };
    } catch {
      parsed = { ok: false };
    }
  }
  if (parsed.ok) {
    const s = summarizeJson(parsed.value, budget);
    if (s.cut) notes.push(`Long arrays are cut to their first ${s.items ?? 1} items; each says how many it holds in all. Use query parameters to page or filter.`);
    body = s.text;
  } else if (BINARY_RE.test(r.contentType)) {
    body = `(binary content, not shown)`;
  } else if (r.contentType.includes("html")) {
    notes.push("The answer is a web page, not data: perhaps a sign-in page or a wrong path.");
    body = cap(htmlToText(r.text), Math.min(budget, 2_000));
  } else {
    body = cap(r.text, budget);
  }
  return cap([head, ...notes, "", body].join("\n"), maxChars);
}
