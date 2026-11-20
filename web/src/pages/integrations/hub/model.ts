/**
 * The integrations hub without React: the built-in integrations as tiles
 * (their category and the words a search finds them by), one search and
 * category filter over them, the connected apps and the app catalog, the
 * header's status line, and what is still required.
 */
import type { PublicConfig } from "../../../lib/types";
import { type AppCategory, type AppView, type CatalogApp, matchesQuery } from "../apps/apps";
import { type IntegrationId, type IntegrationSummary, aiReady, hasCodeHost, isIntegrationId } from "../catalog";

/** The integrations built into the console: everything but the apps, which are tiles of their own. */
export type NativeId = Exclude<IntegrationId, "apps">;
export type NativeSummary = IntegrationSummary & { id: NativeId };

export const isNativeId = (id: string | undefined): id is NativeId => isIntegrationId(id) && id !== "apps";
export const isNative = (row: IntegrationSummary): row is NativeSummary => isNativeId(row.id);

/** Where each built-in integration sits among the catalog's categories, so one filter covers both. */
export const NATIVE_CATEGORY: Record<NativeId, AppCategory> = {
  claude: "AI & search",
  codex: "AI & search",
  gemini: "AI & search",
  slack: "Communication",
  github: "Developer tools",
  gitlab: "Developer tools",
  bitbucket: "Developer tools",
  monday: "Project management",
  jira: "Project management",
  miro: "Design",
};

/** More words a search finds each one by, beyond its name, category and what it enables. */
const NATIVE_KEYWORDS: Record<NativeId, string[]> = {
  claude: [
    "claude",
    "anthropic",
    "model",
    "api key",
    "llm",
    "provider",
    "bedrock",
    "vertex",
    "google cloud",
    "foundry",
    "azure",
    "deepseek",
    "qwen",
    "alibaba",
    "kimi",
    "moonshot",
    "glm",
    "z.ai",
    "openrouter",
    "litellm",
    "gateway",
  ],
  codex: ["openai", "gpt", "coding agent", "cli", "engine"],
  gemini: ["google", "coding agent", "cli", "engine"],
  slack: ["chat", "messages", "bot", "channels"],
  github: ["git", "repos", "pull requests", "code host"],
  gitlab: ["git", "repos", "merge requests", "code host"],
  bitbucket: ["git", "repos", "pull requests", "atlassian", "code host"],
  monday: ["monday", "tickets", "boards", "work tracking"],
  jira: ["issues", "tickets", "confluence", "wiki", "atlassian", "work tracking"],
  miro: ["whiteboard", "boards", "stickies", "diagrams"],
};

/** The "all categories" choice of the category filter. */
export const ALL_CATEGORIES = "all";

export interface HubFilter {
  query: string;
  /** ALL_CATEGORIES or an AppCategory. */
  category: string;
}

const inCategory = (category: string | undefined, filter: string) => filter === ALL_CATEGORIES || category === filter;

/** The built-in integrations the search and category match, in the catalog's order (summarize). */
export function filterNatives(rows: IntegrationSummary[], { query, category }: HubFilter): NativeSummary[] {
  return rows
    .filter(isNative)
    .filter(
      (r) =>
        inCategory(NATIVE_CATEGORY[r.id], category) &&
        matchesQuery({ name: r.name, description: r.enables, category: NATIVE_CATEGORY[r.id], examples: [r.group, ...NATIVE_KEYWORDS[r.id]] }, query),
    );
}

/** A connected app with the catalog entry it was added from (none for a custom app). */
export interface ConnectedApp {
  app: AppView;
  preset?: CatalogApp;
}

/** The connected apps the search and category match; a custom app has no category, so only "all" shows it. */
export function filterConnectedApps(apps: AppView[], catalog: CatalogApp[] | undefined, { query, category }: HubFilter): ConnectedApp[] {
  const presets = new Map(catalog?.map((c) => [c.id, c]));
  return apps
    .map((app) => ({ app, preset: app.presetId ? presets.get(app.presetId) : undefined }))
    .filter(
      ({ app, preset }) =>
        inCategory(preset?.category, category) &&
        matchesQuery({ name: app.name, description: preset?.description ?? app.url, category: preset?.category, examples: preset ? [preset.name] : [] }, query),
    );
}

/** The catalog apps not connected yet that the search and category match. */
export function filterCatalog(catalog: CatalogApp[], connected: AppView[], { query, category }: HubFilter): CatalogApp[] {
  const added = new Set(connected.map((a) => a.presetId).filter(Boolean));
  return catalog.filter((c) => !added.has(c.id) && inCategory(c.category, category) && matchesQuery(c, query));
}

/** Catalog apps under their categories, in the categories' order, leaving out empty ones. */
export function byCategory(apps: CatalogApp[], categories: readonly AppCategory[]): { category: AppCategory; apps: CatalogApp[] }[] {
  return categories.map((category) => ({ category, apps: apps.filter((a) => a.category === category) })).filter((g) => g.apps.length > 0);
}

/** "Claude", "Claude and Slack", "Claude, Slack and GitHub". */
export function listText(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The header's one line: "Claude, Slack and GitHub connected · 4 apps". */
export function connectedLine(rows: IntegrationSummary[], appCount: number): string {
  const names = rows.filter((r) => isNative(r) && r.connected).map((r) => r.listName ?? r.name);
  const apps = appCount ? `${appCount} ${appCount === 1 ? "app" : "apps"}` : "";
  if (!names.length) return apps ? `${apps} connected` : "Nothing connected yet";
  return [`${listText(names)} connected`, apps].filter(Boolean).join(" · ");
}

/** A required integration still missing, and the one to open to connect it. */
export interface MissingIntegration {
  /** The pane that connects it: GitHub stands for "a code host". */
  id: NativeId;
  /** "Claude", "Slack", "a code host". */
  label: string;
  /** For the button: "Claude", "Slack", "GitHub". */
  name: string;
}

/**
 * What still needs connecting before the team can work: the AI model (the
 * providers chat and repo tasks run on), Slack and one code host (App.tsx
 * counts the same three).
 */
export function missingRequired(config: PublicConfig): MissingIntegration[] {
  const missing: MissingIntegration[] = [];
  if (!aiReady(config)) {
    const claude = config.ai.chat.provider === "anthropic" && config.ai.task.provider === "anthropic";
    missing.push(claude ? { id: "claude", label: "Claude", name: "Claude" } : { id: "claude", label: "the AI model", name: "the AI model" });
  }
  if (!config.slack.connected) missing.push({ id: "slack", label: "Slack", name: "Slack" });
  if (!hasCodeHost(config)) missing.push({ id: "github", label: "a code host", name: "GitHub" });
  return missing;
}

/** A built-in integration's line on its tile before it is connected: required ones say so, optional ones say nothing. */
export function requiredNote(row: NativeSummary): { tone: "warning"; text: string } | undefined {
  if (!row.required || row.connected) return undefined;
  return { tone: "warning", text: row.group === "Code" ? "Required: one code host" : "Required" };
}
