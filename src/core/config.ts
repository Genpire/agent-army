import { z } from "zod";
import { presetFor } from "../ai/ai-presets.js";
import { connectionSecretParts, isProviderReady } from "../ai/ai-providers.js";
import { decrypt, deriveKey, encrypt, randomToken } from "./crypto.js";
import type { Store } from "./store.js";
import { REPO_RE } from "../integrations/code-hosts/repo-id.js";
import { TeamSchema, defaultTeam } from "../team/team.js";

/** Any repository id (GitHub owner/repo, gitlab:group/project, bitbucket:workspace/repo); see repo-id.ts. */
export { REPO_RE };
export const CHANNEL_RE = /^[CGD][A-Z0-9]+$/;
/** An environment variable name the agents' shell can receive. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Names the platform sets itself (the agents' shell, the worker). */
const PLATFORM_ENV_NAMES = new Set([
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
/**
 * Names that decide where Claude Code sends its requests, with which
 * credentials, or whom it trusts. The repo's variables share the environment
 * with Claude Code itself (worker.ts), so one of these, pasted from the repo's
 * own .env, would send the platform's key to another host. Prefixes and
 * suffixes are matched in any case (curl and Node read http_proxy too).
 */
const CLIENT_ENV_NAMES = new Set([
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUD_ML_REGION",
  "CLAUDE_CONFIG_DIR",
]);
const CLIENT_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_CODE_", "AWS_", "VERTEX_REGION_"];
const CLIENT_ENV_SUFFIXES = ["_PROXY"];

/** Why a repo variable cannot have this name, or undefined when it can. */
export function reservedEnvKeyProblem(name: string): string | undefined {
  if (PLATFORM_ENV_NAMES.has(name)) return `${name} is reserved by the platform: it sets it itself.`;
  const upper = name.toUpperCase();
  if (CLIENT_ENV_NAMES.has(name) || CLIENT_ENV_PREFIXES.some((p) => upper.startsWith(p)) || CLIENT_ENV_SUFFIXES.some((s) => upper.endsWith(s))) {
    return `${name} is reserved by the platform: names starting with ANTHROPIC_, CLAUDE_CODE_ or AWS_, proxy, TLS and Google credential settings decide where Claude Code sends its requests and key.`;
  }
  return undefined;
}

/**
 * Names a repo setup cannot use: the platform's own (exact names) and the ones
 * that redirect Claude Code (exact names, the ANTHROPIC_, CLAUDE_CODE_, AWS_
 * and VERTEX_REGION_ prefixes, and *_PROXY). See reservedEnvKeyProblem.
 */
export const RESERVED_ENV_KEYS: Pick<ReadonlySet<string>, "has"> = { has: (name) => reservedEnvKeyProblem(name) !== undefined };
export const REPO_SETUP_MAX_ENV = 100;

/**
 * A repo setup as stored. Names reserved after a setup was saved still load
 * (an older config must keep loading): setupEnv leaves them out at runtime,
 * and the worker logs their names. What the owner saves is RepoSetupSchema.
 */
export const StoredRepoSetupSchema = z.object({
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
    .default({}),
});

/**
 * How the team prepares and runs one repository in repo tasks: a setup
 * command run once after the checkout, how to start the app (for browser
 * checks), and environment variables given to the agents' shell (stored
 * encrypted with the config; values are never sent to the browser). Reserved
 * names (RESERVED_ENV_KEYS) are refused, saying why.
 */
export const RepoSetupSchema = StoredRepoSetupSchema.superRefine((setup, ctx) => {
  for (const name of Object.keys(setup.env)) {
    const problem = reservedEnvKeyProblem(name);
    if (problem) {
      ctx.addIssue({ code: "custom", path: ["env", name], message: `${problem} Remove it from this repository's variables.` });
      return;
    }
  }
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


// ---------- More code hosts, trackers and apps ----------

/** Allow-list entries: a group or workspace ("acme", "acme/platform") or an exact repository path ("acme/web"), without the host prefix. */
const ALLOWED_PATHS = z.array(z.string().trim().min(1).max(300)).max(200).default([]);

/** GitLab (gitlab.com or a self-managed instance), so the team can work on gitlab:group/project repositories. */
export const GitLabConfigSchema = z
  .object({
    /** A personal, group or project access token with the api scope (and write_repository). */
    token: z.string().optional(),
    /** https://gitlab.com, or the self-managed instance's address. */
    baseUrl: z
      .string()
      .max(300)
      .refine((u) => /^https:\/\/[^\s/?#]+(?::\d+)?(?:\/[^\s?#]*)?$/.test(u), "The GitLab address must start with https://")
      .default("https://gitlab.com"),
    /** Who the token belongs to, from the verification call. */
    username: z.string().optional(),
    userId: z.number().int().optional(),
    allowed: ALLOWED_PATHS,
    /** The secret token GitLab sends in X-Gitlab-Token with merge request events (POST /gitlab/webhook). */
    webhookSecret: z.string().min(20).max(200).optional(),
  })
  .default({ baseUrl: "https://gitlab.com", allowed: [] });

/** Bitbucket Cloud, so the team can work on bitbucket:workspace/repo repositories. */
export const BitbucketConfigSchema = z
  .object({
    /**
     * An Atlassian API token with Bitbucket scopes (used with `email`), or a
     * workspace / repository access token (no email: sent as a Bearer token).
     */
    token: z.string().optional(),
    /** The Atlassian account email an API token belongs to; empty for access tokens. */
    email: z.string().max(200).optional(),
    /** Who the token belongs to, from the verification call. */
    username: z.string().optional(),
    accountId: z.string().optional(),
    allowed: ALLOWED_PATHS,
    /** The secret Bitbucket signs webhook deliveries with (X-Hub-Signature, POST /bitbucket/webhook). */
    webhookSecret: z.string().min(20).max(200).optional(),
  })
  .default({ allowed: [] });

/** Jira project keys: an uppercase letter, then uppercase letters, digits or "_". */
export const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]{0,49}$/;

/**
 * A Jira project whose issues start repo tasks (see jira-automation.ts): an
 * issue moved to `startStatus` is worked on in `repo`, and the team moves it
 * through the workflow as the work goes (an empty status leaves it alone).
 */
export const JiraProjectAutomationSchema = z.object({
  repo: z.string().regex(REPO_RE, "Repositories look like owner/repo, gitlab:group/project or bitbucket:workspace/repo"),
  /** The status that starts a task, e.g. "Ready for dev". */
  startStatus: z.string().trim().min(1).max(100),
  workingStatus: z.string().trim().max(100).default("In Progress"),
  reviewStatus: z.string().trim().max(100).default("In Review"),
  doneStatus: z.string().trim().max(100).default("Done"),
  stuckStatus: z.string().trim().max(100).default(""),
});
export type JiraProjectAutomation = z.infer<typeof JiraProjectAutomationSchema>;

/** Jira Cloud (and Confluence on the same site), so Pointer can find, open and update issues and read pages. */
export const JiraConfigSchema = z
  .object({
    /** https://your-site.atlassian.net */
    siteUrl: z
      .string()
      .max(300)
      .refine((u) => /^https:\/\/[^\s/?#]+$/.test(u), "The site address looks like https://your-site.atlassian.net")
      .optional(),
    /** The Atlassian account email the API token belongs to. */
    email: z.string().max(200).optional(),
    token: z.string().optional(),
    /** Who the token belongs to, from the verification call. */
    userName: z.string().optional(),
    accountId: z.string().optional(),
    /** Project new issues go to when the request does not name one. */
    defaultProjectKey: z.string().regex(JIRA_KEY_RE).optional(),
    /** Projects Pointer may read and write. Empty = every project the token can reach. */
    allowedProjectKeys: z.array(z.string().regex(JIRA_KEY_RE)).max(200).default([]),
    /** Confluence pages on the same site are readable too. */
    confluence: z.boolean().default(true),
    /** Issues that start repo tasks: the projects watched, and the secret in the webhook's URL. */
    automation: z
      .object({
        enabled: z.boolean().default(false),
        /** Part of the webhook URL (/jira/webhook/<secret>), and the secret Jira signs deliveries with when set there. */
        webhookSecret: z.string().min(20).max(200).optional(),
        /** The webhook in Jira has the secret, so every delivery must be signed with it (X-Hub-Signature). Absent = not known to. */
        signed: z.boolean().optional(),
        projects: z.record(z.string().regex(JIRA_KEY_RE), JiraProjectAutomationSchema).default({}),
      })
      .default({ enabled: false, projects: {} }),
  })
  .default({ allowedProjectKeys: [], confluence: true, automation: { enabled: false, projects: {} } });

/** Miro boards ids look like "uXjVOabc123=". */
export const MIRO_BOARD_ID_RE = /^[A-Za-z0-9_=-]{4,64}$/;

/** Miro, so Pointer can read boards and add stickies, cards and diagrams. */
export const MiroConfigSchema = z
  .object({
    /** An access token from a Miro app installed in the team (boards:read, boards:write). */
    token: z.string().optional(),
    userName: z.string().optional(),
    teamName: z.string().optional(),
    /** Board new content goes to when the request does not name one. */
    defaultBoardId: z.string().regex(MIRO_BOARD_ID_RE).optional(),
    /** Boards Pointer may read and write. Empty = every board the token can reach. */
    allowedBoardIds: z.array(z.string().regex(MIRO_BOARD_ID_RE)).max(200).default([]),
  })
  .default({ allowedBoardIds: [] });

/** App connection ids: "app-" and a slug. */
export const APP_ID_RE = /^app-[a-z0-9][a-z0-9-]{1,40}$/;
export const MAX_APPS = 40;
/** HTTP header names an app connection may set. */
export const APP_HEADER_RE = /^[A-Za-z0-9-]{1,100}$/;

/** A tool an app's MCP server offers, as listed when the connection was last checked. */
export const AppToolSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(2000).default(""),
  /** The server marks it read-only (MCP readOnlyHint). */
  readOnly: z.boolean().default(false),
});
export type AppTool = z.infer<typeof AppToolSchema>;

/** OAuth state for an app whose MCP server signs in with OAuth (MCP authorization spec). */
export const AppOAuthSchema = z.object({
  /** Client registration (dynamic registration, or entered by hand), as the MCP SDK returns it. */
  clientInformation: z.record(z.string(), z.unknown()).optional(),
  /** Tokens as the MCP SDK returns them, with when the access token expires (ms since epoch). */
  tokens: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.number().optional(),
  /** Between starting the sign-in and the callback. */
  codeVerifier: z.string().max(200).optional(),
  state: z.string().max(200).optional(),
  /** The authorization server metadata discovered for this app, cached. */
  serverMetadata: z.record(z.string(), z.unknown()).optional(),
});

export const AppAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  /** Sent as "Authorization: Bearer <token>". */
  z.object({ type: z.literal("bearer"), token: z.string().min(1).max(10_000) }),
  /** Custom headers (e.g. "X-API-Key"); values are secrets. */
  z.object({
    type: z.literal("headers"),
    headers: z
      .record(z.string().regex(APP_HEADER_RE), z.string().max(10_000))
      .refine((h) => Object.keys(h).length <= 10, "At most 10 headers"),
  }),
  z.object({ type: z.literal("oauth"), oauth: AppOAuthSchema.default({}) }),
]);
export type AppAuth = z.infer<typeof AppAuthSchema>;

/**
 * An app connected through its remote MCP server (see apps.ts): Linear,
 * Notion, Sentry, Stripe, Zapier… Pointer uses it in chat; the agents listed
 * in `agentIds` use it in repo tasks too.
 */
export const AppConnectionSchema = z.object({
  id: z.string().regex(APP_ID_RE),
  name: z.string().trim().min(1).max(60),
  /** The catalog entry it was added from (apps-catalog.ts); absent for a custom app. */
  presetId: z.string().max(60).optional(),
  url: z
    .string()
    .max(500)
    .refine((u) => /^https:\/\/[^\s]+$/.test(u), "The MCP server address must start with https://"),
  transport: z.enum(["http", "sse"]).default("http"),
  auth: AppAuthSchema.default({ type: "none" }),
  /** read: only the tools the server marks read-only; write: every tool. disabledTools are never offered. */
  access: z.enum(["read", "write"]).default("read"),
  disabledTools: z.array(z.string().max(128)).max(500).default([]),
  /** The server's tools when the connection was last checked. */
  tools: z.array(AppToolSchema).max(500).default([]),
  checkedAt: z.string().optional(),
  /** Team agents that may use it (chat and repo tasks); Pointer always may while it is enabled. */
  agentIds: z.array(z.string().max(31)).max(30).default([]),
  enabled: z.boolean().default(true),
});
export type AppConnection = z.infer<typeof AppConnectionSchema>;


// ---------- AI providers and coding engines ----------

/**
 * Where the models Pointer and the team think with come from (see
 * ai-providers.ts): Anthropic's API (config.anthropic), Claude on a cloud
 * (Bedrock, Vertex, Google Cloud, Foundry), or another provider with an
 * Anthropic-compatible API (DeepSeek, Qwen, Kimi, GLM) or any such endpoint.
 */
export const AI_PROVIDER_IDS = ["anthropic", "bedrock", "vertex", "google-cloud", "foundry", "deepseek", "qwen", "kimi", "zai", "custom"] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];
/** The model tiers a provider maps (Claude Code's opus, sonnet and haiku aliases, the main model and subagents' default). */
export const MODEL_TIERS = ["main", "opus", "sonnet", "haiku", "subagent"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const AiProviderConnectionSchema = z.object({
  /** Secret values by the preset's field key (apiKey, bearerToken, credentialsJson…). Never sent to the browser. */
  secrets: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,40}$/), z.string().max(20_000)).default({}),
  /** Other values by the preset's field key (region, projectId, workspaceId, resource, baseUrl…). */
  settings: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,40}$/), z.string().max(500)).default({}),
  /** The model each tier runs on; a tier left out uses the preset's default. */
  models: z.partialRecord(z.enum(MODEL_TIERS), z.string().trim().max(200)).default({}),
  /** When the connection last answered a test call. */
  checkedAt: z.string().optional(),
});
export type AiProviderConnection = z.infer<typeof AiProviderConnectionSchema>;

/** A coding agent CLI the team can hand work to in repo tasks (see engines.ts). */
export const ENGINE_IDS = ["codex", "gemini"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];
export const EngineConnectionSchema = z.object({
  /** OpenAI API key (Codex) or Gemini API key. */
  apiKey: z.string().optional(),
  /** The model the CLI runs; empty = the CLI's default. */
  model: z.string().trim().max(100).default(""),
  checkedAt: z.string().optional(),
});
export type EngineConnection = z.infer<typeof EngineConnectionSchema>;

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
  gitlab: GitLabConfigSchema,
  bitbucket: BitbucketConfigSchema,
  jira: JiraConfigSchema,
  miro: MiroConfigSchema,
  /** The AI provider chat (Pointer) and repo tasks run on, and each provider's connection. Anthropic's key stays in `anthropic`. */
  ai: z
    .object({
      chatProvider: z.enum(AI_PROVIDER_IDS).default("anthropic"),
      taskProvider: z.enum(AI_PROVIDER_IDS).default("anthropic"),
      providers: z.partialRecord(z.enum(AI_PROVIDER_IDS), AiProviderConnectionSchema).default({}),
    })
    // A new object each time: zod copies a default only one level deep, and `providers` is written to.
    .default(() => ({ chatProvider: "anthropic" as const, taskProvider: "anthropic" as const, providers: {} })),
  /** Coding agent CLIs the team can hand work to in repo tasks. */
  // Factory defaults: zod copies a default object only one level deep, so a literal would be shared between configs.
  engines: z
    .object({ codex: EngineConnectionSchema.default(() => ({ model: "" })), gemini: EngineConnectionSchema.default(() => ({ model: "" })) })
    .default(() => ({ codex: { model: "" }, gemini: { model: "" } })),
  /** Apps connected through their MCP servers. */
  apps: z.array(AppConnectionSchema).max(MAX_APPS).default([]),
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
  repoSetup: z.record(z.string().regex(REPO_RE), StoredRepoSetupSchema).default({}),
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

/** A secret as the browser may see it: whether it is set, and its last four characters when it is long. */
export function mask(secret: string | undefined): string | null {
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
    gitlab: {
      connected: Boolean(c.gitlab.token),
      baseUrl: c.gitlab.baseUrl,
      username: c.gitlab.username ?? null,
      key: mask(c.gitlab.token),
      allowed: c.gitlab.allowed,
      webhook: { configured: Boolean(c.gitlab.webhookSecret) },
    },
    bitbucket: {
      connected: Boolean(c.bitbucket.token),
      username: c.bitbucket.username ?? null,
      /** "api-token" (with an Atlassian account email) or "access-token" (a workspace or repository token). */
      tokenKind: c.bitbucket.email ? ("api-token" as const) : ("access-token" as const),
      key: mask(c.bitbucket.token),
      allowed: c.bitbucket.allowed,
      webhook: { configured: Boolean(c.bitbucket.webhookSecret) },
    },
    jira: {
      connected: Boolean(c.jira.token && c.jira.siteUrl && c.jira.email),
      siteUrl: c.jira.siteUrl ?? null,
      email: c.jira.email ?? null,
      userName: c.jira.userName ?? null,
      key: mask(c.jira.token),
      defaultProjectKey: c.jira.defaultProjectKey ?? null,
      allowedProjectKeys: c.jira.allowedProjectKeys,
      confluence: c.jira.confluence,
      automation: {
        enabled: c.jira.automation.enabled,
        webhookConfigured: Boolean(c.jira.automation.webhookSecret),
        signed: c.jira.automation.signed === true,
        projects: c.jira.automation.projects,
      },
    },
    miro: {
      connected: Boolean(c.miro.token),
      userName: c.miro.userName ?? null,
      teamName: c.miro.teamName ?? null,
      key: mask(c.miro.token),
      defaultBoardId: c.miro.defaultBoardId ?? null,
      allowedBoardIds: c.miro.allowedBoardIds,
    },
    /** Without credentials: the kind of sign-in, whether it is signed in, and header names only. */
    apps: c.apps.map((a) => ({
      id: a.id,
      name: a.name,
      presetId: a.presetId ?? null,
      url: a.url,
      transport: a.transport,
      auth:
        a.auth.type === "oauth"
          ? {
              type: "oauth" as const,
              signedIn: Boolean(a.auth.oauth.tokens),
              /** Signs in with an OAuth app the owner registered (apps-oauth.ts OWNER_CLIENT_FLAG), not automatic registration. */
              ownClient: a.auth.oauth.clientInformation?.entered_by_owner === true,
            }
          : a.auth.type === "headers"
            ? { type: "headers" as const, headerNames: Object.keys(a.auth.headers).sort() }
            : a.auth.type === "bearer"
              ? { type: "bearer" as const, key: mask(a.auth.token) }
              : { type: "none" as const },
      access: a.access,
      disabledTools: a.disabledTools,
      tools: a.tools,
      checkedAt: a.checkedAt ?? null,
      agentIds: a.agentIds,
      enabled: a.enabled,
    })),
    /** Without secrets: which ones are set (masked), the settings and model choices. */
    ai: {
      chatProvider: c.ai.chatProvider,
      taskProvider: c.ai.taskProvider,
      /** What chat and repo tasks run on, by name, and whether that provider is connected and complete. */
      chat: { provider: c.ai.chatProvider, name: presetFor(c.ai.chatProvider).short, ready: isProviderReady(c, "chat") },
      task: { provider: c.ai.taskProvider, name: presetFor(c.ai.taskProvider).short, ready: isProviderReady(c, "task") },
      providers: Object.fromEntries(
        Object.entries(c.ai.providers).map(([id, p]) => [
          id,
          {
            secrets: Object.fromEntries(Object.entries(p.secrets).map(([k, v]) => [k, mask(v)])),
            settings: p.settings,
            models: p.models,
            checkedAt: p.checkedAt ?? null,
          },
        ]),
      ),
    },
    engines: Object.fromEntries(
      ENGINE_IDS.map((id) => [id, { connected: Boolean(c.engines[id].apiKey), key: mask(c.engines[id].apiKey), model: c.engines[id].model, checkedAt: c.engines[id].checkedAt ?? null }]),
    ) as Record<EngineId, { connected: boolean; key: string | null; model: string; checkedAt: string | null }>,
    budget: c.budget,
    bindings: c.bindings,
    limits: c.limits,
    team: c.team,
  };
}

/** At least one code host (GitHub, GitLab or Bitbucket) is connected, so repo tasks can run. */
export function hasCodeHost(c: Config): boolean {
  return Boolean(c.github.token || c.github.extra.length > 0 || c.gitlab.token || c.bitbucket.token);
}

/**
 * Everything connected: the AI providers chat and repo tasks run on (Claude
 * by default, see ai-providers.ts), Slack and a code host. Drives the admin
 * page badge and repo tasks.
 */
export function isReady(c: Config): boolean {
  return Boolean(isProviderReady(c, "chat") && isProviderReady(c, "task") && c.slack.botToken && c.slack.signingSecret && hasCodeHost(c));
}

/**
 * The credentials of the integrations beyond Claude, Slack, GitHub and
 * monday.com (GitLab, Bitbucket, Jira, Miro, apps), for redaction. Includes
 * the forms they are sent in (Basic auth values) where those differ.
 */
export function integrationSecrets(c: Config): string[] {
  const basic = (user: string | undefined, token: string | undefined) =>
    user && token ? [Buffer.from(`${user}:${token}`).toString("base64")] : [];
  const appSecrets = c.apps.flatMap((a): unknown[] => {
    switch (a.auth.type) {
      case "bearer":
        return [a.auth.token];
      case "headers":
        // The whole value, and the key inside a templated one ("Token token=<key>", "ApiKey <key>").
        return Object.values(a.auth.headers).flatMap((v) => [v, ...v.split(/[\s=]+/).filter((part) => part.length >= 12)]);
      case "oauth": {
        const t = a.auth.oauth.tokens ?? {};
        const client = a.auth.oauth.clientInformation ?? {};
        return [t.access_token, t.refresh_token, t.id_token, client.client_secret];
      }
      default:
        return [];
    }
  });
  return [
    c.gitlab.token,
    c.gitlab.webhookSecret,
    c.bitbucket.token,
    c.bitbucket.webhookSecret,
    ...basic(c.bitbucket.email, c.bitbucket.token),
    ...basic("x-bitbucket-api-token-auth", c.bitbucket.token),
    ...basic("x-token-auth", c.bitbucket.token),
    ...basic("oauth2", c.gitlab.token),
    c.jira.token,
    c.jira.automation.webhookSecret,
    ...basic(c.jira.email, c.jira.token),
    c.miro.token,
    ...appSecrets,
    // With their parts: a Google key file's private key and its lines, each extra header's value.
    ...Object.values(c.ai.providers).flatMap((p) => connectionSecretParts(p.secrets)),
    ...ENGINE_IDS.map((id) => c.engines[id].apiKey),
  ].filter((x): x is string => typeof x === "string" && x.length > 0);
}

/** Enough for Pointer to chat: the chat provider (Claude by default) and Slack. GitHub tools and repo tasks report when GitHub is missing. */
export function isChatReady(c: Config): boolean {
  return Boolean(isProviderReady(c, "chat") && c.slack.botToken && c.slack.signingSecret);
}
