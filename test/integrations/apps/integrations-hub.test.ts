import { describe, expect, it } from "vitest";
import { APP_CATALOG, type CatalogApp } from "../../../src/integrations/apps/apps-catalog.js";
import { logoFor } from "../../../web/src/lib/logos.js";
import type { PublicConfig } from "../../../web/src/lib/types.js";
import { type AppView, addAndSignIn, appTileStatus } from "../../../web/src/pages/integrations/apps/apps.js";
import { BUILT_IN_APP_PRESETS, builtInApps, summarize } from "../../../web/src/pages/integrations/catalog.js";
import { GENPIRE_EXAMPLES, GENPIRE_PRESET_ID, connectGenpire } from "../../../web/src/pages/integrations/genpire/genpire.js";
import {
  ALL_CATEGORIES,
  NATIVE_CATEGORY,
  type NativeSummary,
  byCategory,
  connectedLine,
  filterCatalog,
  filterConnectedApps,
  filterNatives,
  hubApps,
  listText,
  missingRequired,
  tileNote,
} from "../../../web/src/pages/integrations/hub/model.js";
import { hubLanding, parseHubRoute } from "../../../web/src/pages/integrations/hub/route.js";

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
    expect(filterNatives(rows, all).map((r) => r.id)).toEqual(["claude", "codex", "gemini", "slack", "github", "gitlab", "bitbucket", "monday", "jira", "miro", "genpire"]);
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

describe("integrations hub: Genpire, built in", () => {
  const genpire = (over: Partial<AppView> = {}) =>
    app({
      id: "app-genpire",
      name: "Genpire",
      presetId: "genpire",
      url: "https://mcp.genpire.com/mcp",
      access: "write",
      tools: [
        { name: "list_products", description: "", readOnly: true },
        { name: "get_tech_pack", description: "", readOnly: true },
        { name: "design_product", description: "", readOnly: false },
      ],
      ...over,
    });
  const genpireRow = (apps: AppView[]) => summarize(config({ apps })).find((r) => r.id === "genpire")!;
  const withGenpire = [...catalog, { id: "genpire", name: "Genpire", category: "Design", description: "Design real products." } as CatalogApp];

  it("is a built-in row under Design, optional until its app is signed in", () => {
    expect(genpireRow([])).toMatchObject({
      name: "Genpire",
      group: "Design",
      enables: "Lets Pointer design real products in your Genpire account: products, brand styles, tech packs, print files.",
      required: false,
      connected: false,
      status: "Optional",
      tone: "neutral",
    });
    expect(NATIVE_CATEGORY.genpire).toBe("Design");
    expect(logoFor("genpire")).toBeDefined();
  });

  it("reads its status from the genpire app connection", () => {
    expect(genpireRow([genpire()])).toMatchObject({ connected: true, status: "Signed in · 3 tools · can design", tone: "success" });
    expect(genpireRow([genpire({ access: "read" })])).toMatchObject({ connected: true, status: "Signed in · 2 tools · look only", tone: "success" });
    expect(genpireRow([genpire({ disabledTools: ["design_product"] })]).status).toBe("Signed in · 2 tools · can design");
    const expired = genpireRow([genpire({ auth: { type: "oauth", signedIn: false } })]);
    expect(expired).toMatchObject({ connected: false, status: "Sign-in expired", tone: "warning" });
    // Its tile says so before it is connected again; other optional tiles say nothing.
    expect(tileNote(expired as NativeSummary)).toEqual({ tone: "warning", text: "Sign-in expired" });
    expect(tileNote(genpireRow([]) as NativeSummary)).toBeUndefined();
    expect(genpireRow([genpire({ auth: { type: "oauth", signedIn: false }, checkedAt: null, tools: [] })]).status).toBe("Not signed in");
    expect(genpireRow([genpire({ enabled: false })])).toMatchObject({ connected: false, status: "Off" });
    // An app of another preset is not Genpire.
    expect(genpireRow([app()]).status).toBe("Optional");
  });

  it("is found by what it is for", () => {
    const rows = summarize(config());
    for (const query of ["genpire", "design", "products", "tech pack", "brand", "manufacturing", "quotes"]) {
      expect(filterNatives(rows, { query, category: ALL_CATEGORIES }).map((r) => r.id), query).toContain("genpire");
    }
    expect(filterNatives(rows, { query: "", category: "Design" }).map((r) => r.id)).toEqual(["miro", "genpire"]);
  });

  it("is not also a connected app, nor a catalog app to add, nor counted among the apps", () => {
    const apps = [app(), genpire()];
    expect(filterConnectedApps(apps, withGenpire, all).map((c) => c.app.id)).toEqual(["app-linear"]);
    expect(filterConnectedApps(apps, withGenpire, { query: "genpire", category: ALL_CATEGORIES })).toEqual([]);
    expect(hubApps(apps).map((a) => a.id)).toEqual(["app-linear"]);
    // The built-in tile stands for the catalog entry, connected or not.
    expect(filterCatalog(withGenpire, [], all).map((c) => c.id)).toEqual(["linear", "stripe", "sentry"]);
    expect(filterCatalog(withGenpire, [], { query: "genpire", category: ALL_CATEGORIES })).toEqual([]);
    expect(BUILT_IN_APP_PRESETS.get("genpire")).toBe("genpire");
    expect(connectedLine(summarize(config({ apps })), hubApps(apps).length)).toBe("Claude, Slack, GitHub, Jira & Confluence and Genpire connected · 1 app");
    expect(summarize(config({ apps })).find((r) => r.id === "apps")!.status).toBe("1 app connected");
  });

  it("leaves a second connection from the same preset an app of its own", () => {
    const second = genpire({ id: "app-genpire-2", name: "Genpire (studio)" });
    expect(hubApps([genpire(), second]).map((a) => a.id)).toEqual(["app-genpire-2"]);
    expect(builtInApps([genpire(), second])).toEqual(new Map([["app-genpire", "genpire"]]));
  });

  it("opens its pane from its app's address, also back from Genpire's sign-in", () => {
    const apps = [app(), genpire()];
    const back = parseHubRoute(["apps", "app-genpire?signin=ok"]);
    expect(back.signIn).toEqual({ ok: true, reason: undefined, checkFailed: false });
    expect(hubLanding(back.target, apps)).toEqual({ kind: "native", id: "genpire" });
    expect(hubLanding(parseHubRoute(["apps", "app-genpire?signin=error&reason=denied"]).target, apps)).toEqual({ kind: "native", id: "genpire" });
    expect(hubLanding({ kind: "app", appId: "app-linear" }, apps)).toEqual({ kind: "app", appId: "app-linear" });
    expect(hubLanding(parseHubRoute(["genpire"]).target, apps)).toEqual({ kind: "native", id: "genpire" });
    // Not connected (yet): the app address opens nothing special.
    expect(hubLanding({ kind: "app", appId: "app-genpire" }, [app()])).toEqual({ kind: "app", appId: "app-genpire" });
  });

  it("connects in one click: adds the connection from the catalog preset and opens Genpire's sign-in page", async () => {
    const posts: { path: string; body: unknown }[] = [];
    const opened: string[] = [];
    const deps = {
      post: async (path: string, body: unknown) => {
        posts.push({ path, body });
        return { app: genpire({ auth: { type: "oauth", signedIn: false } }), signInUrl: "https://mcp.genpire.com/authorize?client_id=x&state=y" };
      },
      open: (url: string) => void opened.push(url),
    };
    const result = await connectGenpire(APP_CATALOG, deps);
    expect(posts).toEqual([
      {
        path: "/api/apps",
        body: {
          presetId: "genpire",
          name: "Genpire",
          url: "https://mcp.genpire.com/mcp",
          transport: "http",
          auth: { type: "oauth" },
          access: "write",
          agentIds: [],
        },
      },
    ]);
    expect(opened).toEqual(["https://mcp.genpire.com/authorize?client_id=x&state=y"]);
    expect(result.app.id).toBe("app-genpire");
    expect(GENPIRE_PRESET_ID).toBe("genpire");
  });

  it("asks nothing of the server when the catalog has no Genpire entry", async () => {
    const posts: unknown[] = [];
    const deps = { post: async (_: string, body: unknown) => (posts.push(body), { app: genpire() }), open: () => undefined };
    await expect(connectGenpire(catalog, deps)).rejects.toThrow("Genpire is not in this version's app catalog.");
    await expect(connectGenpire(undefined, deps)).rejects.toThrow();
    expect(posts).toEqual([]);
  });

  it("lists requests to try", () => {
    expect(GENPIRE_EXAMPLES).toEqual([
      "In Genpire, design a canvas tote bag with our brand style",
      "Show my latest Genpire products",
      "Make a tech pack for the linen shirt",
      "Prepare a factory quote request for the tote",
    ]);
  });
});

describe("integrations hub: one-click sign-in", () => {
  it("adds a catalog app read only by default and opens its sign-in page", async () => {
    const posts: unknown[] = [];
    const opened: string[] = [];
    await addAndSignIn(
      { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", transport: "http" },
      {},
      { post: async (_, body) => (posts.push(body), { app: app(), signInUrl: "https://linear.app/oauth" }), open: (u) => void opened.push(u) },
    );
    expect(posts).toEqual([{ presetId: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", transport: "http", auth: { type: "oauth" }, access: "read", agentIds: [] }]);
    expect(opened).toEqual(["https://linear.app/oauth"]);
  });
});

describe("integrations hub: logos", () => {
  it("has a logo for every built-in integration, Slack and monday.com in their own colours", () => {
    for (const id of ["claude", "slack", "github", "gitlab", "bitbucket", "monday", "jira", "miro", "genpire"]) expect(logoFor(id), id).toBeDefined();
    expect(logoFor("slack")?.parts?.map((p) => p.hex)).toEqual(["E01E5A", "36C5F0", "2EB67D", "ECB22E"]);
    expect(logoFor("monday")?.parts).toHaveLength(3);
  });
});
