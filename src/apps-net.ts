/**
 * The network guard for apps (apps.ts, apps-oauth.ts, apps-registry.ts):
 * every address the service connects to for an app (its MCP server, its
 * OAuth endpoints, the MCP Registry) must be https and public. Private,
 * loopback, link-local and metadata addresses are refused, by name and by
 * what the name resolves to, so an app cannot be used to reach the
 * deployment's own network (SSRF). Tests (NODE_ENV=test) and local
 * development (ALLOW_PRIVATE_APP_URLS=1) may use private addresses.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** The fetch the MCP SDK takes (FetchLike in @modelcontextprotocol/sdk). */
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;
/** Resolves a host name to its addresses. */
export type LookupFn = (host: string) => Promise<string[]>;

export interface NetGuardOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam: the fetch used underneath (default: the global fetch at call time). */
  fetch?: FetchLike;
  lookup?: LookupFn;
  /** Per request, unless the caller passes its own signal (then both apply). */
  timeoutMs?: number;
}

export class AppUrlError extends Error {}

const PRIVATE_MESSAGE = "That address is on a private network. Apps must use a public https:// address.";
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

/** Ranges no app address may resolve to: private, loopback, link-local, shared, documentation, multicast and reserved. */
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv4");
}
// IPv4-mapped addresses (::ffff:10.0.0.1) are checked against the IPv4 ranges above by BlockList itself.
for (const [net, prefix] of [
  // Unspecified, loopback and the deprecated IPv4-compatible block.
  ["::", 96],
  // NAT64, which can reach IPv4 private ranges.
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(net, prefix, "ipv6");
}

/** Host names that only mean something inside a network. */
const PRIVATE_HOST_RE = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/;

export function privateAppUrlsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test" || env.ALLOW_PRIVATE_APP_URLS === "1";
}

export function isBlockedAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return BLOCKED.check(address, "ipv4");
  if (kind === 6) return BLOCKED.check(address, "ipv6");
  return true;
}

const hostOf = (u: URL) => u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();

/**
 * Why an address may not be used for an app, from the address alone (no DNS),
 * or undefined when it may. https only, no credentials in it, no private host.
 */
export function appUrlProblem(url: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "That is not a valid address.";
  }
  if (u.protocol !== "https:") return "Use an https:// address.";
  if (u.username || u.password) return "Leave any user name or password out of the address.";
  if (privateAppUrlsAllowed(env)) return undefined;
  const host = hostOf(u);
  if (isIP(host)) return isBlockedAddress(host) ? PRIVATE_MESSAGE : undefined;
  // A single-label name ("metadata") is resolved through the network's search domains.
  if (!host.includes(".") || PRIVATE_HOST_RE.test(host)) return PRIVATE_MESSAGE;
  return undefined;
}

// Lookups are cached briefly: chat builds every app's server on each message.
const LOOKUP_TTL_MS = 60_000;
const lookups = new Map<string, { at: number; addresses: string[] }>();

const systemLookup: LookupFn = async (host) => {
  const hit = lookups.get(host);
  if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.addresses;
  const addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  if (lookups.size > 500) lookups.clear();
  lookups.set(host, { at: Date.now(), addresses });
  return addresses;
};

/** The address, once it is https and public by name and by every address its host resolves to. Throws AppUrlError. */
export async function assertPublicUrl(url: string | URL, opts: Pick<NetGuardOptions, "env" | "lookup"> = {}): Promise<URL> {
  const env = opts.env ?? process.env;
  const href = String(url);
  const problem = appUrlProblem(href, env);
  if (problem) throw new AppUrlError(problem);
  const u = new URL(href);
  const host = hostOf(u);
  if (privateAppUrlsAllowed(env) || isIP(host)) return u;
  let addresses: string[];
  try {
    addresses = await (opts.lookup ?? systemLookup)(host);
  } catch {
    throw new AppUrlError(`Couldn't find ${host}. Check the address.`);
  }
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) throw new AppUrlError(PRIVATE_MESSAGE);
  return u;
}

const timeoutSignal = (signal: AbortSignal | null | undefined, ms: number) =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

/**
 * A fetch that checks every address before connecting, including each
 * redirect's (followed by hand, GET and HEAD only, at most 5), and gives up
 * after a timeout. A caller that asks for redirect "manual" gets the redirect
 * itself, as with fetch.
 */
export function guardedFetch(opts: NetGuardOptions = {}): FetchLike {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  return async (input, init = {}) => {
    const doFetch = opts.fetch ?? ((u: string | URL, i?: RequestInit) => globalThis.fetch(u, i));
    const method = (init.method ?? "GET").toUpperCase();
    const signal = timeoutSignal(init.signal, timeoutMs);
    let url = String(input);
    for (let hop = 0; ; hop++) {
      await assertPublicUrl(url, opts);
      const res = await doFetch(url, { ...init, signal, redirect: "manual" });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location || init.redirect === "manual") return res;
      if (init.redirect === "error") throw new TypeError(`Redirected from ${new URL(url).host}`);
      if ((method !== "GET" && method !== "HEAD") || hop >= MAX_REDIRECTS) return res;
      await res.body?.cancel().catch(() => undefined);
      url = new URL(location, url).href;
    }
  };
}
