/**
 * Bitbucket Cloud: the admin routes (connect, disconnect, webhook secret) and
 * the webhook Bitbucket delivers pull request events to.
 *
 *   POST /api/bitbucket             connect or replace the token, or change the allow list
 *   POST /api/bitbucket/disconnect  forget the token (and the webhook secret)
 *   POST /api/bitbucket/webhook     make a new webhook secret (shown once), optionally add the
 *                                   webhook to the allowed repositories; or remove the secret
 *   POST /bitbucket/webhook         deliveries, signed with that secret
 *
 * Tokens and secrets are accepted, never returned (except a new webhook
 * secret, once); /api/state shows the connection without them.
 */
import express, { type Request, type Response, Router } from "express";
import { z } from "zod";
import { Bitbucket, bitbucketStatus } from "../bitbucket.js";
import { BITBUCKET_EVENT_RE, BITBUCKET_WEBHOOK_EVENTS, handleBitbucketWebhook, verifyBitbucketSignature } from "../bitbucket-webhook.js";
import { randomToken } from "../crypto.js";
import { RecentSet } from "../listen.js";
import { repoId } from "../repo-id.js";
import { configSecrets, makeRedactor } from "../worker.js";
import type { IntegrationRouteDeps } from "./types.js";

/** One path segment of a workspace id or repository slug; "." and ".." never. */
const SEG = String.raw`(?!\.{1,2}(?:/|$))[A-Za-z0-9_.-]{1,100}`;
const ALLOWED_ENTRY_RE = new RegExp(`^${SEG}(?:/${SEG})?$`);
const ALLOWED_ERROR = "Allowed entries are workspaces (your-workspace) or exact repositories (your-workspace/your-repo).";
const MAX_ALLOWED = 50;
/** Webhooks added in one go, at most. */
const MAX_HOOKS = 20;

/** A Bitbucket allow list: workspaces or workspace/repo, typed with or without "bitbucket:", deduplicated. */
const ALLOW_LIST = z
  .array(
    z
      .string()
      .trim()
      .max(300)
      .transform((s) => s.replace(/^bitbucket:/i, "").replace(/^\/+|\/+$/g, ""))
      .refine((s) => ALLOWED_ENTRY_RE.test(s), ALLOWED_ERROR),
  )
  .max(MAX_ALLOWED, `Allow at most ${MAX_ALLOWED} workspaces or repositories.`)
  .transform((xs) => [...new Set(xs)]);

const CONNECT_INPUT = z.object({
  /** Absent: only the allow list changes, with the saved token. */
  token: z.string().trim().min(20, "That doesn't look like a Bitbucket token.").max(4000, "That is too long to be a Bitbucket token.").optional(),
  /** The Atlassian account email of an API token; empty for an access token. */
  email: z
    .string()
    .trim()
    .max(200, "The email is at most 200 characters.")
    .refine((s) => s === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s), "That doesn't look like an email address.")
    .optional(),
  allowed: ALLOW_LIST.optional(),
});

const WEBHOOK_INPUT = z.object({
  /** Removes the secret, which turns the webhook off. */
  remove: z.boolean().optional(),
  /** Also add (or update) the webhook on each exact repository in the allow list, through the API. */
  createHooks: z.boolean().optional(),
});

const skipValidation = () => process.env.SKIP_VALIDATION === "1";

function body<T extends z.ZodType>(schema: T, req: Request, res: Response): z.infer<T> | undefined {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    return undefined;
  }
  return parsed.data;
}

/** A message for the person, from a failed check: never the token, only what went wrong. */
function checkError(err: unknown, what: string): string {
  const status = bitbucketStatus(err);
  if (status === undefined) return "Couldn't reach Bitbucket. Try again.";
  if (status === 401 || status === 403 || status === 404) return `This token cannot reach ${what}.`;
  return `Bitbucket check for ${what} failed (HTTP ${status}).`;
}

/** Who an API token belongs to (GET /user). Access tokens have no user and are checked by what they can reach instead. */
async function checkViewer(client: Bitbucket): Promise<{ username: string; accountId?: string }> {
  try {
    const viewer = await client.viewer();
    return { username: viewer.login, ...(typeof viewer.id === "string" && viewer.id ? { accountId: viewer.id } : {}) };
  } catch (err) {
    const status = bitbucketStatus(err);
    if (status === 401) throw new Error("Bitbucket rejected this email and API token. Check both, and that it is an API token with Bitbucket scopes.");
    if (status === 403) throw new Error("This API token may not read its account: add the read:user:bitbucket scope.");
    throw new Error(status === undefined ? "Couldn't reach Bitbucket. Try again." : `Bitbucket check failed (HTTP ${status}).`);
  }
}

/** Proves the token reaches every entry of the allow list: each workspace's repositories, each exact repository. */
async function checkAllowed(client: Bitbucket, allowed: string[]): Promise<void> {
  for (const entry of allowed) {
    try {
      await client.checkReach(entry);
    } catch (err) {
      throw new Error(checkError(err, entry));
    }
  }
}

export function bitbucketRoutes(deps: IntegrationRouteDeps): Router {
  const router = Router();
  const { configRepo, requireAdmin } = deps;

  // ---------- connect, change the allow list, disconnect ----------
  router.post("/api/bitbucket", requireAdmin, async (req, res) => {
    const input = body(CONNECT_INPUT, req, res);
    if (!input) return;
    const saved = (await configRepo.load(true)).bitbucket;

    if (!input.token) {
      if (!saved.token) return void res.status(400).json({ error: "Paste a Bitbucket token." });
      const allowed = input.allowed ?? saved.allowed;
      if (!saved.email && allowed.length === 0) return void res.status(400).json({ error: ACCESS_TOKEN_SCOPE_ERROR });
      try {
        if (!skipValidation()) await checkAllowed(new Bitbucket({ token: saved.token, ...(saved.email ? { email: saved.email } : {}) }), allowed);
      } catch (err) {
        return void res.status(400).json({ error: (err as Error).message });
      }
      await configRepo.update((c) => {
        c.bitbucket.allowed = allowed;
      });
      return void res.json({ ok: true, username: saved.username ?? null, tokenKind: saved.email ? "api-token" : "access-token" });
    }

    const email = input.email || undefined;
    const allowed = input.allowed ?? saved.allowed;
    // An access token belongs to one repository, project or workspace; it has no user to check, and must name what it is for.
    if (!email && allowed.length === 0) return void res.status(400).json({ error: ACCESS_TOKEN_SCOPE_ERROR });
    const client = new Bitbucket({ token: input.token, ...(email ? { email } : {}) });
    let who: { username?: string; accountId?: string } = {};
    try {
      if (!skipValidation()) {
        if (email) who = await checkViewer(client);
        await checkAllowed(client, allowed);
      }
    } catch (err) {
      return void res.status(400).json({ error: (err as Error).message });
    }
    await configRepo.update((c) => {
      c.bitbucket = {
        ...c.bitbucket,
        token: input.token,
        email,
        username: who.username || undefined,
        accountId: who.accountId,
        allowed,
      };
    });
    res.json({ ok: true, username: who.username || null, tokenKind: email ? "api-token" : "access-token" });
  });

  router.post("/api/bitbucket/disconnect", requireAdmin, async (_req, res) => {
    await configRepo.update((c) => {
      c.bitbucket = { allowed: c.bitbucket.allowed };
    });
    res.json({ ok: true });
  });

  // ---------- webhook secret (and the repositories' webhooks) ----------
  router.post("/api/bitbucket/webhook", requireAdmin, async (req, res) => {
    const input = body(WEBHOOK_INPUT, req, res);
    if (!input) return;
    const url = `${deps.baseUrl(req)}/bitbucket/webhook`;
    if (input.remove) {
      await configRepo.update((c) => {
        c.bitbucket.webhookSecret = undefined;
      });
      return void res.json({ ok: true, url });
    }
    const config = await configRepo.load(true);
    if (input.createHooks && !config.bitbucket.token) return void res.status(400).json({ error: "Connect Bitbucket first: the token adds the webhooks." });
    const secret = randomToken(32);
    await configRepo.update((c) => {
      c.bitbucket.webhookSecret = secret;
    });
    if (!input.createHooks) return void res.json({ ok: true, url, secret });

    const { token, email, allowed } = config.bitbucket;
    const client = new Bitbucket({ token: token!, ...(email ? { email } : {}) });
    const redact = makeRedactor([...configSecrets(config), secret]);
    const repos = allowed.filter((a) => a.includes("/")).slice(0, MAX_HOOKS);
    const hooks: { repo: string; result: "created" | "updated" | "failed"; error?: string }[] = [];
    for (const path of repos) {
      const repo = repoId("bitbucket", path);
      try {
        const result = await client.ensureWebhook(repo, { url, secret, events: [...BITBUCKET_WEBHOOK_EVENTS], description: "Agent Army: pull request reviews" });
        hooks.push({ repo, result });
      } catch (err) {
        hooks.push({ repo, result: "failed", error: redact(hookError(err)) });
      }
    }
    res.json({ ok: true, url, secret, hooks });
  });

  // ---------- deliveries ----------
  const seenDeliveries = new RecentSet(2000);
  router.post("/bitbucket/webhook", express.raw({ type: "*/*", limit: "5mb" }), async (req, res) => {
    const secret = (await configRepo.load()).bitbucket.webhookSecret;
    if (!secret) return void res.status(404).json({ error: "Bitbucket webhook is not configured" });
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyBitbucketSignature(secret, rawBody, req.get("x-hub-signature"))) return void res.status(401).json({ error: "Invalid signature." });
    const event = req.get("x-event-key") ?? "";
    if (!BITBUCKET_EVENT_RE.test(event)) return void res.status(400).json({ error: "Missing or invalid X-Event-Key header." });
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return void res.status(400).json({ error: "Invalid JSON." });
    }

    // A retry carries the same request id; the first delivery is already handled.
    const delivery = (req.get("x-request-uuid") ?? "").slice(0, 100);
    if (delivery && seenDeliveries.has(delivery)) return void res.status(200).json({ ok: true, duplicate: true });
    if (delivery) seenDeliveries.add(delivery);

    // Answer first (Bitbucket waits 10 seconds at most); the follow-up starts after this.
    res.status(200).json({ ok: true });
    void handleBitbucketWebhook(event, payload, deps.webhookDeps).catch(() => console.error(`[bitbucket] ${event} failed`));
  });

  return router;
}

const ACCESS_TOKEN_SCOPE_ERROR =
  "Without an email this is an access token, which belongs to one repository, project or workspace: name it under allowed workspaces or repositories.";

/** Why a webhook could not be added, for the admin page. */
function hookError(err: unknown): string {
  const status = bitbucketStatus(err);
  if (status === 401 || status === 403) return "The token may not manage this repository's webhooks (it needs the webhook scopes and admin on the repository).";
  if (status === 404) return "Repository not found, or the token cannot reach it.";
  if (status === 400) return "Bitbucket refused the webhook. Its address must be public (set PUBLIC_URL).";
  return status === undefined ? "Couldn't reach Bitbucket." : `Bitbucket answered HTTP ${status}.`;
}
