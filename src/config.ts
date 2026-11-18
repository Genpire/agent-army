import { z } from "zod";
import { decrypt, deriveKey, encrypt, randomToken } from "./crypto.js";
import type { Store } from "./store.js";
import { TeamSchema, defaultTeam } from "./team.js";

/** owner/repo; "." and ".." are rejected as either part so a repo can never traverse API paths. */
export const REPO_RE = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
export const CHANNEL_RE = /^[CGD][A-Z0-9]+$/;

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
    })
    .default({ allowedBoardIds: [] }),
  /** Slack channel ID -> "owner/repo" default project for that channel. */
  bindings: z.record(z.string(), z.string().regex(REPO_RE)).default({}),
  limits: z
    .object({
      maxTurns: z.number().int().min(10).max(1000).default(200),
      maxBudgetUsd: z.number().min(0.5).max(500).default(15),
      maxParallel: z.number().int().min(1).max(50).default(3),
      /** Minutes between progress updates posted in a repo task's thread; 0 = only the live progress message. */
      progressEveryMin: z.number().int().min(0).max(60).default(5),
    })
    .default({ maxTurns: 200, maxBudgetUsd: 15, maxParallel: 3, progressEveryMin: 5 }),
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
    },
    monday: {
      connected: Boolean(c.monday.token),
      userName: c.monday.userName ?? null,
      accountName: c.monday.accountName ?? null,
      defaultBoardId: c.monday.defaultBoardId ?? null,
      allowedBoardIds: c.monday.allowedBoardIds,
    },
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
