/**
 * The four integrations, what each enables, and how connected each one is,
 * derived from the configuration the server sends (it never sends secrets,
 * only whether they are set and their last characters).
 */
import { plural } from "../../lib/format";
import type { PublicConfig } from "../../lib/types";

export const INTEGRATION_IDS = ["claude", "slack", "github", "monday"] as const;
export type IntegrationId = (typeof INTEGRATION_IDS)[number];

export const isIntegrationId = (s: string | undefined): s is IntegrationId => (INTEGRATION_IDS as readonly string[]).includes(s ?? "");

/** success = connected, warning = required and missing, neutral = optional and missing. */
export type StatusTone = "success" | "warning" | "neutral";

export interface IntegrationSummary {
  id: IntegrationId;
  name: string;
  /** One line: what it enables. */
  enables: string;
  required: boolean;
  connected: boolean;
  /** "Connected as octocat", "Not connected", "Optional"… */
  status: string;
  tone: StatusTone;
}

export function summarize(config: PublicConfig): IntegrationSummary[] {
  const name = config.team.pointer.name;
  const { anthropic, slack, github, monday } = config;
  const extra = github.extra.length;
  const githubConnected = github.connected || extra > 0;
  const githubStatus = github.connected
    ? `Connected${github.login ? ` as ${github.login}` : ""}${extra ? ` · ${plural(extra, "more token")}` : ""}`
    : extra
      ? plural(extra, "connection")
      : "Not connected";

  const rows: Omit<IntegrationSummary, "tone">[] = [
    {
      id: "claude",
      name: "Claude",
      enables: `The model ${name} and the agents think with.`,
      required: true,
      connected: anthropic.connected,
      status: anthropic.connected ? `Connected${anthropic.key ? ` · key ${anthropic.key}` : ""}` : "Not connected",
    },
    {
      id: "slack",
      name: "Slack",
      enables: `Where your team talks to ${name} and gets replies.`,
      required: true,
      connected: slack.connected,
      status: slack.connected ? `Connected${slack.teamName ? ` to ${slack.teamName}` : ""}` : "Not connected",
    },
    {
      id: "github",
      name: "GitHub",
      enables: "Reading code, opening pull requests and following reviews.",
      required: true,
      connected: githubConnected,
      status: githubStatus,
    },
    {
      id: "monday",
      name: "monday.com",
      enables: `Lets ${name} find, open and update tickets.`,
      required: false,
      connected: monday.connected,
      status: monday.connected ? `Connected${monday.userName ? ` as ${monday.userName}` : ""}` : "Optional",
    },
  ];
  return rows.map((r) => ({ ...r, tone: r.connected ? "success" : r.required ? "warning" : "neutral" }));
}

/** The integration to show when none is selected: the first required one still missing, else Claude. */
export function defaultIntegration(rows: IntegrationSummary[]): IntegrationId {
  return rows.find((r) => r.required && !r.connected)?.id ?? "claude";
}

// ---------- Input helpers (the server validates again) ----------

/** "a, b  c" → ["a", "b", "c"]: allow lists and board ids are typed comma or space separated. */
export const parseList = (s: string): string[] =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

// Mirror ALLOW_LIST in src/server.ts and REPO_RE in src/config.ts.
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
