/**
 * Apps beyond the curated catalog: a search of the official MCP Registry
 * (registry.modelcontextprotocol.io), keeping only servers with a remote
 * endpoint (Streamable HTTP or SSE on a public https address), shaped like
 * catalog entries. The registry does not say how a server signs in unless
 * it lists headers, so most results are "custom": the owner picks. Results
 * are cached for an hour per search.
 */
import { z } from "zod";
import { APP_CATALOG, type AppAuthKind } from "./apps-catalog.js";
import { type NetGuardOptions, appUrlProblem, guardedFetch } from "./apps-net.js";
import { APP_HEADER_RE } from "../../core/config.js";

export const REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1/servers";
export const REGISTRY_CACHE_TTL_MS = 60 * 60_000;
/** The registry searches names and needs at least this many characters. */
export const REGISTRY_MIN_QUERY = 3;
const REGISTRY_TIMEOUT_MS = 10_000;
const MAX_RESULTS = 30;
const MAX_CACHED_SEARCHES = 200;

/** A server from the MCP Registry, shaped like a catalog entry. */
export interface RegistryApp {
  /** The registry's server name, e.g. "app.linear/linear". */
  id: string;
  name: string;
  /** Who published it: the name's namespace, e.g. "app.linear". */
  publisher: string;
  description: string;
  url: string;
  transport: "http" | "sse";
  /** "bearer" or "header:<Name>" when the server lists the header it needs; otherwise "custom". */
  auth: AppAuthKind;
  /** Every header the server lists, when it needs more than one. */
  headerNames?: string[];
  docsUrl?: string;
  version?: string;
  /** The server's address is on its publisher's own domain (app.linear/… at mcp.linear.app): listed first. */
  onPublisherDomain: boolean;
  source: "registry";
}

/**
 * The domain a registry namespace stands for ("app.linear" → "linear.app"),
 * or undefined for namespaces that are not a domain the publisher proved
 * (io.github.<user>).
 */
function namespaceDomain(namespace: string): string | undefined {
  if (/^io\.github\./i.test(namespace) || !namespace.includes(".")) return undefined;
  return namespace.toLowerCase().split(".").reverse().join(".");
}

function onDomain(url: string, domain: string | undefined): boolean {
  if (!domain) return false;
  const host = new URL(url).hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

const HeaderSchema = z.object({ name: z.string(), isSecret: z.boolean().optional(), isRequired: z.boolean().optional() });
const RemoteSchema = z.object({ type: z.string(), url: z.string().optional(), headers: z.array(HeaderSchema).nullish() });
const EntrySchema = z.object({
  server: z.object({
    name: z.string().min(1).max(200),
    title: z.string().optional(),
    description: z.string().optional(),
    version: z.string().optional(),
    websiteUrl: z.string().optional(),
    repository: z.object({ url: z.string().optional() }).optional(),
    remotes: z.array(RemoteSchema).nullish(),
  }),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
const ResponseSchema = z.object({ servers: z.array(z.unknown()) });

const normalized = (url: string) => url.replace(/\/+$/, "").toLowerCase();
const CURATED = new Set(APP_CATALOG.map((a) => normalized(a.url)));
const httpsOrUndefined = (url: string | undefined) => (url && /^https:\/\/[^\s]+$/.test(url) ? url : undefined);

function toRegistryApp(raw: unknown, env: NodeJS.ProcessEnv): RegistryApp | undefined {
  const parsed = EntrySchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { server, _meta } = parsed.data;
  const official = _meta?.["io.modelcontextprotocol.registry/official"] as { status?: unknown } | undefined;
  if (official?.status !== undefined && official.status !== "active") return undefined;
  // Remote endpoints only, on a public https address without {placeholders}.
  const remotes = (server.remotes ?? []).filter(
    (r): r is z.infer<typeof RemoteSchema> & { url: string } =>
      (r.type === "streamable-http" || r.type === "sse") && typeof r.url === "string" && r.url.length <= 500 && !r.url.includes("{") && !appUrlProblem(r.url, env),
  );
  const remote = remotes.find((r) => r.type === "streamable-http") ?? remotes[0];
  if (!remote) return undefined;
  const headers = (remote.headers ?? []).filter((h) => APP_HEADER_RE.test(h.name));
  const auth: AppAuthKind = headers.some((h) => h.name.toLowerCase() === "authorization")
    ? "bearer"
    : headers.length === 1
      ? `header:${headers[0]!.name}`
      : "custom";
  const name = (server.title?.trim() || server.name.split("/").pop() || server.name).slice(0, 60);
  const docsUrl = httpsOrUndefined(server.websiteUrl) ?? httpsOrUndefined(server.repository?.url);
  const publisher = server.name.split("/")[0] ?? server.name;
  return {
    id: server.name,
    name,
    publisher,
    description: (server.description ?? "").trim().slice(0, 300),
    url: remote.url,
    transport: remote.type === "sse" ? "sse" : "http",
    auth,
    ...(headers.length > 1 ? { headerNames: headers.map((h) => h.name) } : {}),
    ...(docsUrl ? { docsUrl } : {}),
    ...(server.version ? { version: server.version.slice(0, 40) } : {}),
    onPublisherDomain: onDomain(remote.url, namespaceDomain(publisher)),
    source: "registry",
  };
}

const cache = new Map<string, { at: number; apps: RegistryApp[] }>();

/**
 * Remote MCP servers in the registry whose names match `query` (at least 3
 * characters), without the ones already in the catalog. Cached for an hour.
 * Throws when the registry cannot be reached.
 */
export async function searchRegistry(query: string, opts: NetGuardOptions & { now?: () => number } = {}): Promise<RegistryApp[]> {
  const q = query.trim().slice(0, 100);
  if (q.length < REGISTRY_MIN_QUERY) return [];
  const now = opts.now ?? Date.now;
  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && now() - hit.at < REGISTRY_CACHE_TTL_MS) return hit.apps;

  const url = `${REGISTRY_URL}?${new URLSearchParams({ search: q, version: "latest", limit: "100" })}`;
  let body: unknown;
  try {
    const res = await guardedFetch({ timeoutMs: REGISTRY_TIMEOUT_MS, ...opts })(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    throw new Error(`Couldn't search the MCP Registry (${err instanceof Error ? err.message : String(err)}).`.slice(0, 300));
  }
  const parsed = ResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error("The MCP Registry sent an answer this version does not understand.");

  const env = opts.env ?? process.env;
  const seen = new Set<string>();
  const found: RegistryApp[] = [];
  for (const raw of parsed.data.servers) {
    const app = toRegistryApp(raw, env);
    if (!app || CURATED.has(normalized(app.url)) || seen.has(normalized(app.url))) continue;
    seen.add(normalized(app.url));
    found.push(app);
  }
  // Most of the registry is third parties' wrappers: a vendor's own server, on its own domain, first.
  const apps = [...found.filter((a) => a.onPublisherDomain), ...found.filter((a) => !a.onPublisherDomain)].slice(0, MAX_RESULTS);
  if (cache.size >= MAX_CACHED_SEARCHES) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: now(), apps });
  return apps;
}
