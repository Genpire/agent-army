import { describe, expect, it } from "vitest";
import type { CatalogApp } from "../../../src/integrations/apps/apps-catalog.js";
import { logoFor } from "../../../web/src/lib/logos.js";
import type { PublicConfig } from "../../../web/src/lib/types.js";
import { type AppView, appTileStatus } from "../../../web/src/pages/integrations/apps/apps.js";
import { summarize } from "../../../web/src/pages/integrations/catalog.js";
import {
  ALL_CATEGORIES,
  byCategory,
  connectedLine,
  filterCatalog,
  filterConnectedApps,
  filterNatives,
  listText,
  missingRequired,
} from "../../../web/src/pages/integrations/hub/model.js";
import { parseHubRoute } from "../../../web/src/pages/integrations/hub/route.js";

const app = (over: Partial<AppView> = {}): AppView => ({
  id: "app-linear",
  name: "Linear",
  presetId: "linear",
  url: "https://mcp.linear.app/mcp",
  transport: "http",
  auth: { type: "oauth", signedIn: true },
  access: "read",
  disabledTools: [],
  tools: [
    { name: "list_issues", description: "", readOnly: true },
    { name: "get_issue", description: "", readOnly: true },
    { name: "create_issue", description: "", readOnly: false },
  ],
  checkedAt: "2026-11-01T00:00:00.000Z",
  agentIds: [],
  enabled: true,
  ...over,
}) as AppView;

const config = (over: { anthropic?: boolean; slack?: boolean; github?: boolean; apps?: AppView[] } = {}): PublicConfig =>
  ({
    team: { pointer: { name: "Pointer" } },
    anthropic: { connected: over.anthropic ?? true, key: "…abcd" },
    ai: {
      chat: { provider: "anthropic", name: "Claude", ready: over.anthropic ?? true },
      task: { provider: "anthropic", name: "Claude", ready: over.anthropic ?? true },
    },
    slack: { connected: over.slack ?? true, teamName: "Acme" },
    github: { connected: over.github ?? true, login: "acme-bot", extra: [] },
    gitlab: { connected: false },
    bitbucket: { connected: false },
    monday: { connected: false },
    jira: { connected: true, userName: "Dana" },
    miro: { connected: false },
    engines: { codex: { connected: false, model: "" }, gemini: { connected: false, model: "" } },
    apps: over.apps ?? [],
  }) as unknown as PublicConfig;

const catalog = [
  { id: "linear", name: "Linear", category: "Project management", description: "Issues, projects and cycles.", examples: ["Find my open issues"] },
  { id: "stripe", name: "Stripe", category: "Payments", description: "Customers, payments and invoices." },
  { id: "sentry", name: "Sentry", category: "Monitoring", description: "Errors and performance issues." },
] as CatalogApp[];

const all = { query: "", category: ALL_CATEGORIES };

describe("integrations hub: the address", () => {
  it("opens nothing, a built-in integration or an app", () => {
    expect(parseHubRoute([])).toEqual({ target: { kind: "hub" } });
    expect(parseHubRoute(["github"])).toEqual({ target: { kind: "native", id: "github" } });
    expect(parseHubRoute(["apps"])).toEqual({ target: { kind: "hub" } });
    expect(parseHubRoute(["apps", "app-linear"])).toEqual({ target: { kind: "app", appId: "app-linear" } });
    expect(parseHubRoute(["nope"])).toEqual({ target: { kind: "hub" } });
    expect(parseHubRoute(["apps", "../settings"])).toEqual({ target: { kind: "hub" } });
  });

  it("reads the OAuth callback's flags off the last segment", () => {
    expect(parseHubRoute(["apps", "app-linear?signin=ok&check=failed"])).toEqual({
      target: { kind: "app", appId: "app-linear" },
      signIn: { ok: true, reason: undefined, checkFailed: true },
    });
    expect(parseHubRoute(["apps?signin=error&reason=denied"])).toEqual({
      target: { kind: "hub" },
      signIn: { ok: false, reason: "denied", checkFailed: false },
    });
  });
});

describe("integrations hub: search and categories", () => {
  const rows = summarize(config());

  it("finds built-in integrations by name, category and what they do, never the Apps row", () => {
    expect(filterNatives(rows, all).map((r) => r.id)).toEqual(["claude", "codex", "gemini", "slack", "github", "gitlab", "bitbucket", "monday", "jira", "miro"]);
    expect(filterNatives(rows, { query: "git", category: ALL_CATEGORIES }).map((r) => r.id)).toEqual(["github", "gitlab", "bitbucket"]);
    expect(filterNatives(rows, { query: "tickets", category: ALL_CATEGORIES }).map((r) => r.id)).toEqual(["monday", "jira"]);
    expect(filterNatives(rows, { query: "", category: "Developer tools" }).map((r) => r.id)).toEqual(["github", "gitlab", "bitbucket"]);
    expect(filterNatives(rows, { query: "confluence", category: "Payments" })).toEqual([]);
  });

  it("leaves connected catalog apps out of what can be added, and groups the rest by category", () => {
    const connected = [app()];
    expect(filterCatalog(catalog, connected, all).map((c) => c.id)).toEqual(["stripe", "sentry"]);
    expect(filterCatalog(catalog, connected, { query: "issues", category: ALL_CATEGORIES }).map((c) => c.id)).toEqual(["sentry"]);
    expect(byCategory(filterCatalog(catalog, [], all), ["Monitoring", "Payments", "Project management"]).map((g) => g.category)).toEqual([
      "Monitoring",
      "Payments",
      "Project management",
    ]);
  });

  it("finds connected apps through their catalog entry; a custom app only under all categories", () => {
    const custom = app({ id: "app-internal", name: "Internal wiki", presetId: null, url: "https://wiki.example.com/mcp" });
    const apps = [app(), custom];
    expect(filterConnectedApps(apps, catalog, { query: "cycles", category: ALL_CATEGORIES }).map((c) => c.app.id)).toEqual(["app-linear"]);
    expect(filterConnectedApps(apps, catalog, { query: "wiki", category: ALL_CATEGORIES }).map((c) => c.app.id)).toEqual(["app-internal"]);
    expect(filterConnectedApps(apps, catalog, { query: "", category: "Project management" }).map((c) => c.app.id)).toEqual(["app-linear"]);
  });
});

describe("integrations hub: status", () => {
  it("says what is connected in one line", () => {
    expect(listText(["Claude"])).toBe("Claude");
    expect(listText(["Claude", "Slack", "GitHub"])).toBe("Claude, Slack and GitHub");
    expect(connectedLine(summarize(config({ apps: [app()] })), 4)).toBe("Claude, Slack, GitHub and Jira & Confluence connected · 4 apps");
    expect(connectedLine(summarize(config({ anthropic: false, slack: false, github: false })), 0)).toBe("Jira & Confluence connected");
  });

  it("lists what is still required, a code host as one", () => {
    expect(missingRequired(config())).toEqual([]);
    expect(missingRequired(config({ slack: false, github: false })).map((m) => [m.id, m.label])).toEqual([
      ["slack", "Slack"],
      ["github", "a code host"],
    ]);
  });

  it("says how a connected app signs in and what it may do", () => {
    expect(appTileStatus(app())).toEqual({ tone: "success", text: "Signed in · 2 tools · read only" });
    expect(appTileStatus(app({ access: "write" })).text).toBe("Signed in · 3 tools · can change things");
    expect(appTileStatus(app({ auth: { type: "oauth", signedIn: false } }))).toEqual({ tone: "warning", text: "Sign-in expired" });
    expect(appTileStatus(app({ auth: { type: "oauth", signedIn: false }, checkedAt: null, tools: [] })).text).toBe("Not signed in");
    expect(appTileStatus(app({ enabled: false })).text).toBe("Off");
  });
});

describe("integrations hub: logos", () => {
  it("has a logo for every built-in integration, Slack and monday.com in their own colours", () => {
    for (const id of ["claude", "slack", "github", "gitlab", "bitbucket", "monday", "jira", "miro"]) expect(logoFor(id), id).toBeDefined();
    expect(logoFor("slack")?.parts?.map((p) => p.hex)).toEqual(["E01E5A", "36C5F0", "2EB67D", "ECB22E"]);
    expect(logoFor("monday")?.parts).toHaveLength(3);
  });
});
