import { z } from "zod";
import { decrypt, deriveKey, encrypt, randomToken } from "./crypto.js";
import type { Store } from "./store.js";
import { TeamSchema, defaultTeam } from "./team.js";

/** owner/repo; "." and ".." are rejected as either part so a repo can never traverse API paths. */
export const REPO_RE = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
export const CHANNEL_RE = /^[CGD][A-Z0-9]+$/;
/** An environment variable name the agents' shell can receive. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Names the platform sets or guards itself; a repo setup cannot override them. */
export const RESERVED_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "LANG",
  "CI",
  "ANTHROPIC_API_KEY",
  "MASTER_KEY",
  "SETUP_TOKEN",
  "TASK_B64",
  "CLAUDE_AGENT_SDK_CLIENT_APP",
  "PLAYWRIGHT_BROWSERS_PATH",
]);
export const REPO_SETUP_MAX_ENV = 100;

/**
 * How the team prepares and runs one repository in repo tasks: a setup
 * command run once after the checkout, how to start the app (for browser
 * checks), and environment variables given to the agents' shell (stored
 * encrypted with the config; values are never sent to the browser).
 */
export const RepoSetupSchema = z.object({
  setupCommand: z.string().max(2000).default(""),
  startCommand: z.string().max(500).default(""),
  /** Where the started app answers, e.g. http://localhost:3000. Empty = unknown. */
  appUrl: z
    .string()
    .max(300)
    .refine((u) => u === "" || /^https?:\/\/[^\s]+$/.test(u), "The app URL must start with http:// or https://")
    .default(""),
  env: z
    .record(
      z.string().regex(ENV_KEY_RE, "Variable names use letters, digits and _, and do not start with a digit"),
      z.string().max(10_000),
    )
    .refine((env) => Object.keys(env).length <= REPO_SETUP_MAX_ENV, `At most ${REPO_SETUP_MAX_ENV} variables per repository`)
    .refine((env) => Object.keys(env).every((k) => !RESERVED_ENV_KEYS.has(k)), "That variable name is reserved by the platform")
    .default({}),
});
export type RepoSetup = z.infer<typeof RepoSetupSchema>;

/** monday.com board ids are digit strings. */
export const MONDAY_ID_RE = /^\d+$/;

/**
 * A monday.com board whose tickets start repo tasks (see monday-automation.ts):
 * a ticket whose status becomes `startLabel` is worked on in `repo`, and the
 * team moves the status as the work goes (an empty label leaves it alone).
 */
export const MondayBoardAutomationSchema = z.object({
  repo: z.string().regex(REPO_RE, "Repositories look like owner/repo"),
  /** The status column watched and updated, e.g. "status". */
  statusColumnId: z.string().trim().min(1).max(100),
  /** The status label that starts a task, e.g. "Ready for dev". */
  startLabel: z.string().trim().min(1).max(100),
  workingLabel: z.string().trim().max(100).default("Working on it"),
  reviewLabel: z.string().trim().max(100).default("In review"),
  doneLabel: z.string().trim().max(100).default("Done"),
  stuckLabel: z.string().trim().max(100).default("Stuck"),
});
export type MondayBoardAutomation = z.infer<typeof MondayBoardAutomationSchema>;

/** Spending caps for repo tasks and chat (see budget.ts). 0 = no cap. */
export const BudgetSchema = z.object({
  /** Claude spend allowed per calendar month (UTC), chat and repo tasks together. */
  monthlyUsd: z.number().min(0).max(100_000).default(0),
  /** Repo task spend allowed per repository per month. */
  perRepoUsd: z.record(z.string().regex(REPO_RE), z.number().min(0).max(100_000)).default({}),
  /** Warn when a cap is this far used, in percent. */
  alertPercent: z.number().int().min(10).max(100).default(80),
  /** Slack channel for spending alerts; empty = no Slack alert (the console still shows them). */
  alertChannel: z.union([z.literal(""), z.string().regex(CHANNEL_RE, "Channel IDs look like C012ABCDEF")]).default(""),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const ConfigSchema = z.object({
  orgName: z.string().default(""),
  adminPasswordHash: z.string().optional(),
  anthropic: z
    .object({
      apiKey: z.string().optional(),
      /** Optional model override for the Lead; empty = SDK default. */
      model: z.string().default(""),
    })
    .default({ model: "" }),
  slack: z
    .object({
      botToken: z.string().optional(),
      signingSecret: z.string().optional(),
      botUserId: z.string().optional(),
      teamName: z.string().optional(),
      /** Slack user IDs allowed to command the agents. Empty = whole workspace. */
      allowedUserIds: z.array(z.string()).default([]),
      /** Channels where Pointer answers every message, without an @mention. */
      pointerChannels: z.array(z.string().regex(CHANNEL_RE, "Channel IDs look like C012ABCDEF")).default([]),
    })
    .default({ allowedUserIds: [], pointerChannels: [] }),
  github: z
    .object({
      token: z.string().optional(),
      login: z.string().optional(),
      /** Owners ("your-org") or exact repos ("owner/repo") this token may touch. Empty = anything the token can reach. */
      allowedOwners: z.array(z.string()).default([]),
      /** Extra GitHub connections (e.g. a repo owned by another personal account), each with its own allow list. */
      extra: z
        .array(
          z.object({
            id: z.string().regex(/^gh-[0-9a-f]{6,}$/),
            token: z.string().min(20),
            login: z.string().optional(),
            allowed: z.array(z.string()).default([]),
          }),
        )
        .default([]),
      /** Shared secret of the GitHub webhook that reports pull request reviews and comments (POST /github/webhook). */
      webhookSecret: z.string().min(20).max(200).optional(),
    })
    .default({ allowedOwners: [], extra: [] }),
  /** Optional: monday.com, so Pointer can open and update tickets. */
  monday: z
    .object({
      token: z.string().optional(),
      /** Who the token belongs to and which account, from the verification call. */
      userName: z.string().optional(),
      accountName: z.string().optional(),
      /** Board new tickets go to when the request does not name one. */
      defaultBoardId: z.string().regex(/^\d+$/).optional(),
      /** Boards Pointer may read and write. Empty = every board the token can reach. */
      allowedBoardIds: z.array(z.string().regex(/^\d+$/)).default([]),
      /** Tickets that start repo tasks: the boards watched, and the secret in the webhook's URL. */
      automation: z
        .object({
          enabled: z.boolean().default(false),
          /** Part of the webhook URL (/monday/webhook/<secret>): monday.com does not sign webhooks created with an API token. */
          webhookSecret: z.string().min(20).max(200).optional(),
          boards: z.record(z.string().regex(MONDAY_ID_RE), MondayBoardAutomationSchema).default({}),
        })
        .default({ enabled: false, boards: {} }),
    })
    .default({ allowedBoardIds: [], automation: { enabled: false, boards: {} } }),
  /** Slack channel ID -> "owner/repo" default project for that channel. */
  bindings: z.record(z.string(), z.string().regex(REPO_RE)).default({}),
  limits: z
    .object({
      maxTurns: z.number().int().min(10).max(1000).default(200),
      maxBudgetUsd: z.number().min(0.5).max(500).default(15),
      maxParallel: z.number().int().min(1).max(50).default(3),
      /** Minutes between progress updates posted in a repo task's thread; 0 = only the live progress message. */
      progressEveryMin: z.number().int().min(0).max(60).default(5),
      /** Minutes a repo task waits for the pull request's checks (CI, Vercel…) after pushing; 0 = do not wait. */
      ciWaitMin: z.number().int().min(0).max(60).default(15),
      /** How many times the team tries to fix failing checks, within the task's budget; 0 = only report them. */
      ciFixRounds: z.number().int().min(0).max(5).default(2),
      /**
       * After the checks, open the pull request's preview deployment (Vercel, Netlify… via GitHub
       * deployments) in the browser: off, only when the change touches what people see, or always.
       */
      previewCheck: z.enum(["off", "visible", "always"]).default("visible"),
    })
    .default({ maxTurns: 200, maxBudgetUsd: 15, maxParallel: 3, progressEveryMin: 5, ciWaitMin: 15, ciFixRounds: 2, previewCheck: "visible" }),
  budget: BudgetSchema.default({ monthlyUsd: 0, perRepoUsd: {}, alertPercent: 80, alertChannel: "" }),
  /** "owner/repo" -> how repo tasks set up and run that repository. */
  repoSetup: z.record(z.string().regex(REPO_RE), RepoSetupSchema).default({}),
  /** Pointer and the agents it orchestrates (seeded with defaults on first load). */
  team: TeamSchema.default(defaultTeam),
});

export type Config = z.infer<typeof ConfigSchema>;

const CONFIG_KEY = "config.enc";
const MASTER_KEY_FILE = "master.key";

/**
 * The master key encrypts the config blob and signs admin sessions.
 * Production: set MASTER_KEY (the GCP deploy script puts it in Secret Manager).
 * Local/dev: if unset we generate one next to the data, which is convenient
 * but means the data directory alone is enough to read the secrets.
 */
export async function resolveMasterKey(store: Store, env = process.env): Promise<Buffer> {
  if (env.MASTER_KEY) return deriveKey(env.MASTER_KEY);
  if (env.REQUIRE_MASTER_KEY === "1") {
    throw new Error("MASTER_KEY is required in this deployment but is not set");
  }
  const existing = await store.get(MASTER_KEY_FILE);
  if (existing) return deriveKey(existing.toString("utf8").trim());
  const generated = randomToken(32);
  await store.put(MASTER_KEY_FILE, generated);
  console.warn("[config] MASTER_KEY not set; generated one in the data store (dev mode).");
  return deriveKey(generated);
}

export class ConfigRepo {
  private cache: { value: Config; at: number } | undefined;

  constructor(
    private readonly store: Store,
    private readonly key: Buffer,
    private readonly ttlMs = 5_000,
  ) {}

  async load(fresh = false): Promise<Config> {
    if (!fresh && this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.value;
    const blob = await this.store.get(CONFIG_KEY);
    const raw = blob ? JSON.parse(decrypt(this.key, blob)) : {};
    const value = ConfigSchema.parse(raw);
    this.cache = { value, at: Date.now() };
    return value;
  }

  /** Serialises read-modify-write so concurrent updates (Slack commands, admin saves) don't drop each other. */
  private chain: Promise<unknown> = Promise.resolve();

  update(mutate: (draft: Config) => void): Promise<Config> {
    const run = this.chain.then(() => this.updateNow(mutate));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async updateNow(mutate: (draft: Config) => void): Promise<Config> {
    const draft = structuredClone(await this.load(true));
    mutate(draft);
    const value = ConfigSchema.parse(draft);
    await this.store.put(CONFIG_KEY, encrypt(this.key, JSON.stringify(value)));
    this.cache = { value, at: Date.now() };
    return value;
  }
}

function mask(secret: string | undefined): string | null {
  if (!secret) return null;
  return secret.length <= 8 ? "••••" : `••••${secret.slice(-4)}`;
}

/** What the browser is allowed to see. Secrets never leave the server. */
export function publicView(c: Config) {
  return {
    orgName: c.orgName,
    anthropic: { connected: Boolean(c.anthropic.apiKey), key: mask(c.anthropic.apiKey), model: c.anthropic.model },
    slack: {
      connected: Boolean(c.slack.botToken && c.slack.signingSecret),
      teamName: c.slack.teamName ?? null,
      botUserId: c.slack.botUserId ?? null,
      allowedUserIds: c.slack.allowedUserIds,
      pointerChannels: c.slack.pointerChannels,
    },
    github: {
      connected: Boolean(c.github.token),
      login: c.github.login ?? null,
      allowedOwners: c.github.allowedOwners,
      /** Extra connections, without their tokens. */
      extra: c.github.extra.map((x) => ({ id: x.id, login: x.login ?? null, allowed: x.allowed, key: mask(x.token) })),
      webhook: { configured: Boolean(c.github.webhookSecret) },
    },
    /** Per-repo setup without the variables' values: only their names. */
    repoSetup: Object.fromEntries(
      Object.entries(c.repoSetup).map(([repo, s]) => [
        repo,
        { setupCommand: s.setupCommand, startCommand: s.startCommand, appUrl: s.appUrl, envKeys: Object.keys(s.env).sort() },
      ]),
    ),
    monday: {
      connected: Boolean(c.monday.token),
      userName: c.monday.userName ?? null,
      accountName: c.monday.accountName ?? null,
      defaultBoardId: c.monday.defaultBoardId ?? null,
      allowedBoardIds: c.monday.allowedBoardIds,
      /** Without the webhook secret: only whether one is set. */
      automation: {
        enabled: c.monday.automation.enabled,
        webhookConfigured: Boolean(c.monday.automation.webhookSecret),
        boards: c.monday.automation.boards,
      },
    },
    budget: c.budget,
    bindings: c.bindings,
    limits: c.limits,
    team: c.team,
  };
}

/** Everything connected: Claude, Slack and GitHub. Drives the admin page badge and repo tasks. */
export function isReady(c: Config): boolean {
  return Boolean(c.anthropic.apiKey && c.slack.botToken && c.slack.signingSecret && (c.github.token || c.github.extra.length > 0));
}

/** Enough for Pointer to chat: Claude and Slack. GitHub tools and repo tasks report when GitHub is missing. */
export function isChatReady(c: Config): boolean {
  return Boolean(c.anthropic.apiKey && c.slack.botToken && c.slack.signingSecret);
}
