/**
 * Apps connected through their MCP servers: the shapes the console uses, the
 * catalog (fetched once per page load, kept in memory, filtered in the
 * browser), the MCP Registry search, and how a connected app's status reads.
 */
import { useEffect, useState } from "react";
import type { AppAuthKind, AppCategory, CatalogApp, CatalogUrlField } from "../../../../../src/integrations/apps/apps-catalog.js";
import type { RegistryApp } from "../../../../../src/integrations/apps/apps-registry.js";
import { api, errorMessage } from "../../../lib/api";
import { plural } from "../../../lib/format";
import type { AgentSpec, PublicConfig } from "../../../lib/types";
import type { StatusTone } from "../catalog";

export type { AppAuthKind, AppCategory, CatalogApp, CatalogUrlField, RegistryApp };

/** A connected app as the server shows it (no credentials). */
export type AppView = PublicConfig["apps"][number];

/** What the add drawer connects: a catalog entry, a server found in the MCP Registry, or an app typed in by hand. */
export type AppSource = { kind: "catalog"; app: CatalogApp } | { kind: "registry"; app: RegistryApp } | { kind: "custom" };

/** GET /api/apps/catalog */
export interface AppCatalogData {
  apps: CatalogApp[];
  categories: AppCategory[];
  /** Where vendors send the browser back after a sign-in: what a client registered by hand must allow. */
  redirectUrl: string;
}

/** POST /api/apps */
export interface AddAppResult {
  app: AppView;
  /** For an OAuth app: the vendor's sign-in page, opened next. */
  signInUrl?: string;
}

// The catalog is static: fetched once per page load, then kept in memory and
// shared by every component that shows it, so coming back to a page shows it at once.
let catalogRequest: Promise<AppCatalogData> | undefined;
let catalogData: AppCatalogData | undefined;

/** Starts fetching the catalog, once; a failed fetch is tried again on the next call. */
export function loadAppCatalog(): Promise<AppCatalogData> {
  catalogRequest ??= api.get<AppCatalogData>("/api/apps/catalog").then(
    (data) => (catalogData = data),
    (err: unknown) => {
      catalogRequest = undefined;
      throw err;
    },
  );
  return catalogRequest;
}

export function useAppCatalog(): { data?: AppCatalogData; error?: string } {
  const [state, setState] = useState<{ data?: AppCatalogData; error?: string }>(() => (catalogData ? { data: catalogData } : {}));
  useEffect(() => {
    if (catalogData) return;
    let live = true;
    loadAppCatalog().then(
      (data) => live && setState({ data }),
      (err: unknown) => live && setState({ error: errorMessage(err) }),
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/** Mirrors REGISTRY_MIN_QUERY in src/integrations/apps/apps-registry.ts. */
export const REGISTRY_MIN_QUERY = 3;

/** Servers in the MCP Registry matching `query`, searched shortly after typing stops. */
export function useRegistrySearch(query: string, enabled: boolean): { apps: RegistryApp[]; loading: boolean; error?: string } {
  const [state, setState] = useState<{ apps: RegistryApp[]; loading: boolean; error?: string }>({ apps: [], loading: false });
  const q = query.trim();
  const active = enabled && q.length >= REGISTRY_MIN_QUERY;
  useEffect(() => {
    if (!active) return setState({ apps: [], loading: false });
    let live = true;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    const timer = setTimeout(() => {
      api.get<{ apps: RegistryApp[] }>(`/api/apps/registry?search=${encodeURIComponent(q)}`).then(
        (r) => live && setState({ apps: r.apps, loading: false }),
        (err: unknown) => live && setState({ apps: [], loading: false, error: errorMessage(err) }),
      );
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, active]);
  return state;
}

/** Whether every word of the query is in the app's name, description, category or examples. */
export function matchesQuery(app: { name: string; description: string; category?: string; examples?: string[] }, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = [app.name, app.description, app.category ?? "", ...(app.examples ?? [])].join(" ").toLowerCase();
  return words.every((w) => text.includes(w));
}

/** The header an auth kind names ("header:X-API-Key" → "X-API-Key"). */
export const headerOf = (kind: AppAuthKind): string | undefined => (kind.startsWith("header:") ? kind.slice("header:".length) : undefined);

export function authLabel(kind: AppAuthKind, appName: string): string {
  if (kind === "oauth") return `Sign in with ${appName}`;
  if (kind === "bearer") return "API key";
  if (kind === "none") return "No sign-in";
  if (kind === "custom") return "Choose how it signs in";
  return `API key in the ${headerOf(kind)} header`;
}

/** A catalog app that signs in with one click: OAuth, no client to register, no address to fill in. */
export const signsInDirectly = (app: CatalogApp) => app.auth === "oauth" && !app.clientRegistration && !app.url.includes("{");

/** What adding an app and going to its sign-in needs: the API, and how the browser opens the vendor's page (tests pass fakes). */
export interface SignInDeps {
  post: (path: string, body: unknown) => Promise<AddAppResult>;
  open: (url: string) => void;
}

const browserSignIn: SignInDeps = {
  post: (path, body) => api.post<AddAppResult>(path, body),
  open: (url) => window.location.assign(url),
};

/**
 * One click for a catalog app that only needs a sign-in: adds the connection
 * from its catalog entry and opens the vendor's sign-in page. The vendor sends
 * the browser back to `#/integrations/apps/<app id>?signin=…`.
 */
export async function addAndSignIn(
  preset: Pick<CatalogApp, "id" | "name" | "url" | "transport">,
  { access = "read", agentIds = [] }: { access?: AppView["access"]; agentIds?: string[] } = {},
  deps: SignInDeps = browserSignIn,
): Promise<AddAppResult> {
  const result = await deps.post("/api/apps", {
    presetId: preset.id,
    name: preset.name,
    url: preset.url,
    transport: preset.transport,
    auth: { type: "oauth" },
    access,
    agentIds,
  });
  if (result.signInUrl) deps.open(result.signInUrl);
  return result;
}

const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;

/** The parts of a per-account address to ask for: the catalog's fields, and any other {placeholder} by its name. */
export function urlFieldsOf(app: { url: string; urlFields?: CatalogUrlField[] }): CatalogUrlField[] {
  const keys = [...new Set([...app.url.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!))];
  return keys.map((key) => app.urlFields?.find((f) => f.key === key) ?? { key, label: key });
}

/** A placeholder's value: a name or a host, never something that changes the rest of the address (no / @ ? #). */
const URL_VALUE_RE = /^[A-Za-z0-9._~:-]+$/;
export const urlValueError = (value: string): string | undefined =>
  !value.trim() ? "Fill this in." : URL_VALUE_RE.test(value.trim()) ? undefined : "Use letters, digits, dots and dashes only.";

/** The address with its placeholders filled in (unfilled ones stay as they are). */
export const fillUrl = (template: string, values: Record<string, string>) =>
  template.replace(PLACEHOLDER_RE, (whole, key: string) => values[key]?.trim() || whole);

/** A header's value from the key: the catalog's template ("Token token={key}") or the key itself. */
export const headerValue = (template: string | undefined, key: string) => (template ?? "{key}").split("{key}").join(key);

/** The tools a connected app may use. Mirrors allowedToolsOf in src/integrations/apps/apps.ts. */
export function allowedTools(app: Pick<AppView, "access" | "tools" | "disabledTools">) {
  const disabled = new Set(app.disabledTools);
  return app.tools.filter((t) => !disabled.has(t.name) && (app.access === "write" || t.readOnly));
}

/** The agents an app is assigned to: those whose apps list it (the Team page edits the same lists). */
export const appAgents = <A extends Pick<AgentSpec, "id" | "apps">>(agents: A[], appId: string): A[] => agents.filter((a) => a.apps.includes(appId));

export const isSignedOut = (app: AppView) => app.auth.type === "oauth" && !app.auth.signedIn;

/** How a connected app reads in a list: whether it can be used, and what it may do. */
export function appStatus(app: AppView): { tone: StatusTone; text: string } {
  if (!app.enabled) return { tone: "neutral", text: "Off" };
  if (isSignedOut(app)) return { tone: "warning", text: "Not signed in" };
  if (!app.tools.length) return { tone: "warning", text: "No tools listed yet" };
  const usable = allowedTools(app).length;
  if (!usable) return { tone: "warning", text: "No tools allowed" };
  return { tone: "success", text: `${plural(usable, "tool")} · ${app.access === "write" ? "can change things" : "looks only"}` };
}

/**
 * How a connected app reads on its tile: how it signs in, then how many tools
 * it may use and what it may do. "Signed in · 12 tools · read only",
 * "Sign-in expired" (signed out after its tools were listed), "Off".
 */
export function appTileStatus(app: AppView): { tone: StatusTone; text: string } {
  if (app.enabled && isSignedOut(app)) return { tone: "warning", text: app.checkedAt ? "Sign-in expired" : "Not signed in" };
  const status = appStatus(app);
  if (status.tone !== "success") return status;
  const parts = [app.auth.type === "oauth" ? "Signed in" : "", plural(allowedTools(app).length, "tool"), app.access === "write" ? "can change things" : "read only"];
  return { tone: "success", text: parts.filter(Boolean).join(" · ") };
}

/** The catalog entry an app was added from. */
export const presetOf = (catalog: CatalogApp[] | undefined, app: Pick<AppView, "presetId">) =>
  app.presetId ? catalog?.find((c) => c.id === app.presetId) : undefined;

/** "Sara (Coder)", "QA", "Writer (off)". */
export function agentLabel(a: Pick<AgentSpec, "name" | "role" | "enabled">): string {
  const notes = [a.name === a.role ? "" : a.role, a.enabled ? "" : "off"].filter(Boolean);
  return notes.length ? `${a.name} (${notes.join(", ")})` : a.name;
}

/** Why an address cannot be used, as the server would say (it checks again, including private networks). */
export function urlError(url: string): string | undefined {
  const u = url.trim();
  if (!u) return "Give the MCP server's address.";
  if (u.includes("{")) return "Replace the {placeholder} in the address.";
  if (!/^https:\/\/[^\s]+$/.test(u)) return "Use an https:// address.";
  return undefined;
}

/** Mirrors APP_HEADER_RE in src/core/config.ts. */
export const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,100}$/;
