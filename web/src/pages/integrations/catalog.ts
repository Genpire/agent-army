/**
 * The integrations, grouped, what each enables, and how connected each one
 * is, derived from the configuration the server sends (it never sends
 * secrets, only whether they are set and their last characters).
 */
import { plural } from "../../lib/format";
import type { PublicConfig } from "../../lib/types";
import { GENPIRE_PRESET_ID, genpireApp, genpireStatus } from "./genpire/genpire";

export const INTEGRATION_IDS = ["claude", "codex", "gemini", "slack", "github", "gitlab", "bitbucket", "monday", "jira", "miro", "genpire", "email", "data", "apps"] as const;
export type IntegrationId = (typeof INTEGRATION_IDS)[number];

export const isIntegrationId = (s: string | undefined): s is IntegrationId => (INTEGRATION_IDS as readonly string[]).includes(s ?? "");

/** success = connected, warning = required and missing, neutral = optional and missing. */
export type StatusTone = "success" | "warning" | "neutral";

/** What kind of integration each is, in order (the hub files them under the catalog's categories: hub/model.ts). */
export const INTEGRATION_GROUPS = ["Essentials", "AI", "Code", "Work tracking", "Boards", "Design", "Apps"] as const;
export type IntegrationGroup = (typeof INTEGRATION_GROUPS)[number];

/**
 * Built-in integrations that are an app connection underneath, by the catalog
 * preset they connect: their tile and pane show that connection, so the hub
 * leaves it out of the connected apps and the preset out of what can be added
 * (hub/model.ts). The catalog entry stays on the server: the pane adds the
 * connection from it.
 */
export const BUILT_IN_APP_PRESETS: ReadonlyMap<string, Exclude<IntegrationId, "apps">> = new Map([[GENPIRE_PRESET_ID, "genpire"]]);

/**
 * The app connections built-in integrations show, by app id: the first one
 * added from each of their presets (genpireApp). Any other connection from
 * the same preset stays an app of its own.
 */
export function builtInApps(apps: readonly { id: string; presetId?: string | null }[]): Map<string, Exclude<IntegrationId, "apps">> {
  const shown = new Map<string, Exclude<IntegrationId, "apps">>();
  for (const [presetId, id] of BUILT_IN_APP_PRESETS) {
    const app = apps.find((a) => a.presetId === presetId);
    if (app) shown.set(app.id, id);
  }
  return shown;
}

export interface IntegrationSummary {
  id: IntegrationId;
  name: string;
  /** How a list of what is connected names it, when not by `name`: the AI model row says its provider ("Claude"). */
  listName?: string;
  group: IntegrationGroup;
  /** One line: what it enables. */
  enables: string;
  /** Needed before the team can work (the AI model, Slack, and one code host). */
  required: boolean;
  connected: boolean;
  /** "Connected as octocat", "Not connected", "Optional"… */
  status: string;
  tone: StatusTone;
}

/** GitHub, GitLab or Bitbucket: at least one is needed for repo tasks. */
export const hasCodeHost = (config: PublicConfig): boolean =>
  config.github.connected || config.github.extra.length > 0 || config.gitlab.connected || config.bitbucket.connected;

/**
 * The AI model row's status: "Claude" when chat and repo tasks run on it,
 * "Claude · tasks on Kimi" when they differ, what is missing otherwise.
 */
export function aiStatus(config: PublicConfig): string {
  const { chat, task } = config.ai;
  if (!chat.ready) return chat.provider === "anthropic" ? "Not connected" : `${chat.name} for chat is not set up`;
  if (!task.ready) return `${chat.name} · ${task.name} for tasks is not set up`;
  return chat.provider === task.provider ? chat.name : `${chat.name} · tasks on ${task.name}`;
}

/** The providers chat and repo tasks run on are both connected and complete. */
export const aiReady = (config: PublicConfig): boolean => config.ai.chat.ready && config.ai.task.ready;

export function summarize(config: PublicConfig): IntegrationSummary[] {
  const name = config.team.pointer.name;
  const { ai, slack, github, gitlab, bitbucket, monday, jira, miro, apps } = config;
  const extra = github.extra.length;
  const githubConnected = github.connected || extra > 0;
  const githubStatus = github.connected
    ? `Connected${github.login ? ` as ${github.login}` : ""}${extra ? ` · ${plural(extra, "more token")}` : ""}`
    : extra
      ? plural(extra, "connection")
      : "Not connected";
  // A code host is required until one is connected; the others are then optional.
  const codeRequired = !hasCodeHost(config);
  const optional = (connected: boolean, text: string) => (connected ? text : "Optional");
  // The apps built-in integrations show (Genpire) are counted by their own rows.
  const builtIn = builtInApps(apps);
  const enabledApps = apps.filter((a) => a.enabled && !builtIn.has(a.id)).length;

  // A row sets its tone only where it differs from what `connected` and `required` give (a sign-in that expired).
  const rows: (Omit<IntegrationSummary, "tone"> & { tone?: StatusTone })[] = [
    {
      id: "claude",
      name: "AI model",
      group: "AI",
      enables: `The models ${name} and the agents think with: Claude, or another provider's.`,
      listName: ai.chat.name,
      required: true,
      connected: aiReady(config),
      status: aiStatus(config),
    },
    {
      id: "codex",
      name: "Codex",
      group: "AI",
      enables: "OpenAI's coding agent as a team member: agents set to Codex hand their repo work to it.",
      required: false,
      connected: config.engines.codex.connected,
      status: optional(config.engines.codex.connected, `Connected${config.engines.codex.model ? ` · ${config.engines.codex.model}` : ""}`),
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      group: "AI",
      enables: "Google's coding agent as a team member: agents set to Gemini hand their repo work to it.",
      required: false,
      connected: config.engines.gemini.connected,
      // Gemini CLI has no sandbox in the task container: it runs only once the owner allows that.
      status: optional(
        config.engines.gemini.connected,
        config.engines.gemini.allowUnsandboxed
          ? `Connected${config.engines.gemini.model ? ` · ${config.engines.gemini.model}` : ""}`
          : "Connected · not allowed to run yet",
      ),
    },
    {
      id: "slack",
      name: "Slack",
      group: "Essentials",
      enables: `Where your team talks to ${name} and gets replies.`,
      required: true,
      connected: slack.connected,
      status: slack.connected ? `Connected${slack.teamName ? ` to ${slack.teamName}` : ""}` : "Not connected",
    },
    {
      id: "github",
      name: "GitHub",
      group: "Code",
      enables: "Reading code, opening pull requests and following reviews.",
      required: codeRequired,
      connected: githubConnected,
      status: githubConnected ? githubStatus : codeRequired ? "Not connected" : "Optional",
    },
    {
      id: "gitlab",
      name: "GitLab",
      group: "Code",
      enables: "The same on gitlab.com or your own GitLab: merge requests, pipelines, reviews.",
      required: codeRequired,
      connected: gitlab.connected,
      status: gitlab.connected ? `Connected${gitlab.username ? ` as ${gitlab.username}` : ""}` : codeRequired ? "Not connected" : "Optional",
    },
    {
      id: "bitbucket",
      name: "Bitbucket",
      group: "Code",
      enables: "The same on Bitbucket Cloud: pull requests, Pipelines, reviews.",
      required: codeRequired,
      connected: bitbucket.connected,
      status: bitbucket.connected ? `Connected${bitbucket.username ? ` as ${bitbucket.username}` : ""}` : codeRequired ? "Not connected" : "Optional",
    },
    {
      id: "monday",
      name: "monday.com",
      group: "Work tracking",
      enables: `Lets ${name} find, open and update tickets.`,
      required: false,
      connected: monday.connected,
      status: optional(monday.connected, `Connected${monday.userName ? ` as ${monday.userName}` : ""}`),
    },
    {
      id: "jira",
      name: "Jira & Confluence",
      group: "Work tracking",
      enables: `Lets ${name} find, open and move issues, read Confluence, and start the team on issues.`,
      required: false,
      connected: jira.connected,
      status: optional(jira.connected, `Connected${jira.userName ? ` as ${jira.userName}` : ""}`),
    },
    {
      id: "miro",
      name: "Miro",
      group: "Boards",
      enables: `Lets ${name} read boards and add stickies, cards and diagrams.`,
      required: false,
      connected: miro.connected,
      status: optional(miro.connected, `Connected${miro.userName ? ` as ${miro.userName}` : ""}`),
    },
    {
      id: "email",
      name: "Email",
      group: "Boards",
      enables: `Lets ${name} send routines' reports by email (SMTP or Resend).`,
      required: false,
      connected: config.email.configured,
      status: optional(config.email.configured, `Sends as ${config.email.from}`),
    },
    {
      id: "data",
      name: "Company data",
      group: "Boards",
      enables: `Lets ${name} read your own APIs, admin panel or database (read-only) for numbers and reports.`,
      required: false,
      connected: config.dataSources.some((d) => d.enabled),
      status: optional(config.dataSources.some((d) => d.enabled), plural(config.dataSources.filter((d) => d.enabled).length, "source")),
    },
    {
      id: "genpire",
      name: "Genpire",
      group: "Design",
      enables: `Lets ${name} design real products in your Genpire account: products, brand styles, tech packs, print files.`,
      required: false,
      ...genpireStatus(genpireApp(apps)),
    },
    {
      id: "apps",
      name: "Apps",
      group: "Apps",
      enables: "Linear, Notion, Sentry, Stripe, Zapier and more through their MCP servers.",
      required: false,
      connected: enabledApps > 0,
      status: enabledApps > 0 ? plural(enabledApps, "app") + " connected" : "Optional",
    },
  ];
  return rows.map((r) => ({ ...r, tone: r.tone ?? (r.connected ? "success" : r.required ? "warning" : "neutral") }));
}

// ---------- Input helpers (the server validates again) ----------

/** "a, b  c" → ["a", "b", "c"]: allow lists and board ids are typed comma or space separated. */
export const parseList = (s: string): string[] =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

// Mirror ALLOW_LIST in src/server.ts and REPO_RE in src/core/config.ts.
const OWNER_RE = /^[A-Za-z0-9-]+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The first problem with an allow list, or undefined when every entry is an owner or an exact repo. */
export function allowListError(entries: string[]): string | undefined {
  const bad = entries.find((x) => !OWNER_RE.test(x) && !REPO_RE.test(x));
  if (bad !== undefined) return `"${bad}" is not an owner (your-org) or a repo (owner/repo).`;
  if (entries.length > 50) return "Allow at most 50 owners or repos.";
  return undefined;
}

/** The first problem with a list of monday.com board ids. */
export function boardIdsError(ids: string[]): string | undefined {
  const bad = ids.find((x) => !/^\d{1,20}$/.test(x));
  if (bad !== undefined) return `"${bad}" is not a board id. Board ids are numbers, like 1234567890.`;
  if (ids.length > 100) return "Allow at most 100 boards.";
  return undefined;
}

/** Mirrors WEBHOOK_SECRET in src/server.ts. */
export function webhookSecretError(secret: string): string | undefined {
  if (secret.length < 20) return "Use a secret of at least 20 characters.";
  if (secret.length > 200) return "Use a secret of at most 200 characters.";
  if (!/^[\x21-\x7e]+$/.test(secret)) return "Use printable characters without spaces in the secret.";
  return undefined;
}

/** 32 random bytes as hex (64 characters), made in the browser so it can be copied into GitHub before saving. */
export function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** "any repository the token can reach" for an empty allow list. */
export const allowedText = (allowed: string[]): string => (allowed.length ? allowed.join(", ") : "Any repository the token can reach");
