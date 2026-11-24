/**
 * What the Gmail and Calendar sources share: finding the connected app,
 * its access token (renewed through apps-oauth.ts), the scopes it carries,
 * and GET requests to Google's REST APIs at fixed addresses, with backoff
 * when Google asks to slow down and errors in the owner's words.
 *
 * Tokens and response bodies are never logged or put in an error message:
 * an error names the HTTP status and Google's reason code only.
 */
import { type AppConnection, type Config, type ConfigRepo } from "../../core/config.js";
import { freshAccessToken } from "../apps/apps-oauth.js";
import { googleApiDisabled } from "./workspace-mcp.js";

export interface GoogleDeps {
  configRepo: ConfigRepo;
  /** Tests: a fake. Default: global fetch. */
  fetch?: typeof fetch;
  now?: () => Date;
  /** Tests: waits between retries without waiting. Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** A Google product read through its REST API with a connected app's token. */
export interface GoogleProduct {
  /** "Gmail", "Google Calendar". */
  name: string;
  /** The catalog preset of its app (apps-catalog-more.ts). */
  presetId: "gmail" | "google-calendar";
  /** Its Workspace MCP server's host: a custom app at that address counts too. */
  mcpHost: string;
  /** Its REST API's service, to enable in the client's project. */
  api: string;
  /** Its MCP service. */
  mcp: string;
  /** Scopes (without the https://www.googleapis.com/auth/ prefix, or a full URL) any one of which lets it read. */
  readScopes: string[];
  /** What it needs to read, for an error. */
  reading: string;
}

export const GMAIL: GoogleProduct = {
  name: "Gmail",
  presetId: "gmail",
  mcpHost: "gmailmcp.googleapis.com",
  api: "gmail.googleapis.com",
  mcp: "gmailmcp.googleapis.com",
  readScopes: ["gmail.readonly", "gmail.modify", "https://mail.google.com/"],
  reading: "reading mail (gmail.readonly)",
};

export const CALENDAR: GoogleProduct = {
  name: "Google Calendar",
  presetId: "google-calendar",
  mcpHost: "calendarmcp.googleapis.com",
  api: "calendar-json.googleapis.com",
  mcp: "calendarmcp.googleapis.com",
  readScopes: ["calendar.events.readonly", "calendar.events", "calendar.readonly", "calendar"],
  reading: "reading events (calendar.events.readonly)",
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/**
 * The product's app: an enabled one with its preset, else an enabled custom
 * app at its Workspace MCP address; the first one when there are several.
 */
export function productApp(config: Pick<Config, "apps">, product: GoogleProduct): AppConnection | undefined {
  const enabled = config.apps.filter((a) => a.enabled);
  return enabled.find((a) => a.presetId === product.presetId) ?? enabled.find((a) => !a.presetId && hostOf(a.url) === product.mcpHost);
}

/** The app signs in with OAuth and holds an access token. */
export function signedIn(app: AppConnection | undefined): app is AppConnection & { auth: { type: "oauth" } } {
  return app?.auth.type === "oauth" && typeof app.auth.oauth.tokens?.access_token === "string" && app.auth.oauth.tokens.access_token !== "";
}

/** The product's app, connected and signed in: what its tools and `ready()` need first. */
export const connectedApp = (config: Pick<Config, "apps">, product: GoogleProduct) => {
  const app = productApp(config, product);
  return signedIn(app) ? app : undefined;
};

const SCOPE_PREFIX = "https://www.googleapis.com/auth/";

/** The scopes the token was granted, short form; undefined when the token response did not say. */
export function grantedScopes(app: AppConnection): string[] | undefined {
  if (app.auth.type !== "oauth") return undefined;
  const scope = app.auth.oauth.tokens?.scope;
  if (typeof scope !== "string" || !scope.trim()) return undefined;
  return scope
    .trim()
    .split(/\s+/)
    .map((s) => (s.startsWith(SCOPE_PREFIX) ? s.slice(SCOPE_PREFIX.length) : s));
}

/** Whether the token may read the product: unknown scopes count as yes (Google answers 403 otherwise). */
export function canRead(app: AppConnection, product: GoogleProduct): boolean {
  const granted = grantedScopes(app);
  return !granted || granted.some((s) => product.readScopes.includes(s));
}

/** A Google request failed: `message` is for the owner (no token, no body text). */
export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** The product is not connected or not signed in. */
export class GoogleNotConnectedError extends Error {}

/** Retries after 429 (or a rate-limit 403, or a 5xx) before giving up. */
export const MAX_RETRIES = 3;
/** The first wait without Retry-After; it doubles each time. */
export const BACKOFF_MS = 1_000;
/** Never waits longer than this for one retry, whatever Retry-After says. */
const MAX_WAIT_MS = 20_000;
/** One request gives up after this. */
const REQUEST_TIMEOUT_MS = 20_000;

const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED", "quotaExceeded"]);
const DISABLED_REASONS = new Set(["accessNotConfigured", "SERVICE_DISABLED"]);
const SCOPE_REASONS = new Set(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"]);

/** Google's reason codes in an error body (errors[].reason, details[].reason, status), never its message text. */
async function reasonsOf(res: Response): Promise<string[]> {
  try {
    const body = (await res.json()) as { error?: { status?: unknown; errors?: { reason?: unknown }[]; details?: { reason?: unknown }[] } };
    const e = body.error;
    if (!e) return [];
    return [e.status, ...(e.errors ?? []).map((x) => x.reason), ...(e.details ?? []).map((x) => x.reason)].filter(
      (r): r is string => typeof r === "string" && /^[A-Za-z_]{1,60}$/.test(r),
    );
  } catch {
    return [];
  }
}

/** Seconds (or an HTTP date) in Retry-After, as milliseconds; undefined when absent or unreadable. */
function retryAfterMs(res: Response, now: number): number | undefined {
  const value = res.headers.get("retry-after");
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One product's API with the app's token: GET requests to addresses this
 * module builds (never one from a message), JSON answers. A 401 renews the
 * token once and tries again; a 429, a rate-limit 403 or a 5xx waits
 * (Retry-After, else 1 s, 2 s, 4 s) up to MAX_RETRIES times.
 */
export class GoogleClient {
  private token: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly nowMs: () => number;

  constructor(
    readonly product: GoogleProduct,
    private readonly app: AppConnection,
    private readonly deps: GoogleDeps,
  ) {
    this.fetchFn = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = deps.sleep ?? defaultSleep;
    this.nowMs = () => (deps.now ? deps.now().getTime() : Date.now());
  }

  /** The app whose token this client uses. */
  get appId(): string {
    return this.app.id;
  }

  /** The access token, renewed when it is about to expire (or now, after a 401). */
  private async accessToken(renew: boolean): Promise<string> {
    if (this.token && !renew) return this.token;
    // apps-oauth refreshes through the app's authorization server; its fetch is the same test seam.
    this.token = await freshAccessToken(this.app, {
      configRepo: this.deps.configRepo,
      now: this.nowMs,
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(renew ? { marginMs: Number.POSITIVE_INFINITY } : {}),
    });
    return this.token;
  }

  async get<T>(url: string): Promise<T> {
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken(false);
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          redirect: "error",
        });
      } catch (err) {
        const timedOut = err instanceof Error && /abort|timeout/i.test(`${err.name} ${err.message}`);
        throw new GoogleApiError(timedOut ? `${this.product.name} did not answer in time.` : `Couldn't reach ${this.product.name}.`, 0);
      }
      if (res.ok) return (await res.json()) as T;

      const reasons = await reasonsOf(res);
      const rateLimited = res.status === 429 || (res.status === 403 && reasons.some((r) => RATE_REASONS.has(r))) || res.status >= 500;
      if (rateLimited && attempt < MAX_RETRIES) {
        const wait = Math.min(MAX_WAIT_MS, retryAfterMs(res, this.nowMs()) ?? BACKOFF_MS * 2 ** attempt);
        await this.sleep(wait);
        continue;
      }
      if (res.status === 401 && !renewed) {
        renewed = true;
        await this.accessToken(true);
        continue;
      }
      throw this.problem(res.status, reasons, rateLimited);
    }
  }

  private problem(status: number, reasons: string[], rateLimited: boolean): GoogleApiError {
    const p = this.product;
    const reason = reasons.find((r) => r !== "PERMISSION_DENIED" && r !== "UNAUTHENTICATED") ?? reasons[0];
    if (rateLimited && status < 500) return new GoogleApiError(`${p.name} asked to slow down; try again in a minute.`, status, reason);
    if (status === 401) return new GoogleApiError(`${p.name} refused the sign-in. Sign in again on the Integrations page.`, status, reason);
    if (status === 403 && reasons.some((r) => DISABLED_REASONS.has(r))) return new GoogleApiError(googleApiDisabled(p.name, p.api, p.mcp), status, reason);
    if (status === 403 && reasons.some((r) => SCOPE_REASONS.has(r))) {
      return new GoogleApiError(`The ${p.name} sign-in does not allow ${p.reading}. Sign in again and allow it.`, status, reason);
    }
    return new GoogleApiError(`${p.name} answered ${status}${reason ? ` (${reason})` : ""}.`, status, reason);
  }
}

/**
 * The product's client for this config: its app connected, signed in and
 * allowed to read. Throws GoogleNotConnectedError otherwise.
 */
export function googleClient(config: Pick<Config, "apps">, product: GoogleProduct, deps: GoogleDeps): GoogleClient {
  const app = productApp(config, product);
  if (!app) throw new GoogleNotConnectedError(`${product.name} is not connected. Connect it on the Integrations page (Apps).`);
  if (!signedIn(app)) throw new GoogleNotConnectedError(`${product.name} is not signed in. Sign in on the Integrations page.`);
  if (!canRead(app, product)) {
    throw new GoogleNotConnectedError(`The ${product.name} sign-in does not allow ${product.reading}. Sign in again and allow it.`);
  }
  return new GoogleClient(product, app, deps);
}

/** Runs `work` on each item, `limit` at a time, keeping the order of `items`. */
export async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await work(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
