/**
 * GitLab admin routes (/api/gitlab/…, behind requireAdmin) and the webhook
 * GitLab delivers merge request and comment events to (POST /gitlab/webhook).
 * The token is accepted and never returned. The webhook secret is made here
 * and returned once, when it is made, so the owner can paste it into GitLab.
 */
import express, { type Request, type Response, Router } from "express";
import { z } from "zod";
import type { Config } from "../core/config.js";
import { randomToken } from "../core/crypto.js";
import { GITLAB_DEFAULT_URL, GitLab, gitlabStatus } from "../gitlab.js";
import { GITLAB_EVENTS, handleGitlabDelivery, verifyGitlabToken } from "../gitlab-webhook.js";
import { RecentSet } from "../slack/listen.js";
import { repoId } from "../repo-id.js";
import { configSecrets, makeRedactor } from "../worker.js";
import type { IntegrationRouteDeps } from "./types.js";

/** https:// and a host, optionally a port and a path (GitLab under a relative URL). No query, fragment or "=" (git reads the address as a config key). */
const BASE_URL_RE = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)*$/;
const BASE_URL = z
  .string()
  .trim()
  .max(300, "The GitLab address is at most 300 characters.")
  .transform((u) => u.replace(/\/+$/, ""))
  .pipe(z.string().regex(BASE_URL_RE, "The GitLab address starts with https://, like https://gitlab.com or https://gitlab.example.com."));

/** A group ("acme", "acme/platform") or a project ("acme/web"): segments of letters, digits, "_", "." and "-". */
const PATH_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){0,20}$/;
const ALLOWED_ERROR = "Allowed entries are groups (acme, acme/platform) or projects (acme/web).";
const ALLOWED = z
  .array(
    z
      .string()
      .trim()
      .max(300, ALLOWED_ERROR)
      // "gitlab:acme/web", "/acme/web/" and "acme/web.git" mean acme/web.
      .transform((s) => s.replace(/^gitlab:/i, "").replace(/^\/+|\/+$/g, "").replace(/\.git$/i, ""))
      .pipe(
        z
          .string()
          .regex(PATH_RE, ALLOWED_ERROR)
          .refine((s) => s.split("/").every((seg) => seg !== "." && seg !== ".."), ALLOWED_ERROR),
      ),
  )
  .max(200, "Allow at most 200 groups or projects.")
  .transform((xs) => [...new Set(xs)]);

const ConnectInput = z.object({
  /** Empty or left out: keep the saved token. */
  token: z.string().trim().max(4000, "That doesn't look like a GitLab token.").optional(),
  baseUrl: BASE_URL.optional(),
  allowed: ALLOWED.optional(),
});

const WebhookInput = z.object({
  /** Removes the secret: deliveries are refused until a new one is made. */
  remove: z.boolean().optional(),
  /** Also add (or update) the webhook on every allowed project, through the API. */
  installHooks: z.boolean().optional(),
});

/** X-Gitlab-Event, e.g. "Merge Request Hook". */
const EVENT = z.string().max(100).regex(/^[A-Za-z ]+$/);

/** Lookups made at once when checking an allow list or adding webhooks. */
const CONCURRENCY = 4;

const skipValidation = () => process.env.SKIP_VALIDATION === "1";
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One project's webhook, as POST /api/gitlab/webhook reports it. */
export interface GitlabHookResult {
  path: string;
  ok: boolean;
  action?: "created" | "updated";
  error?: string;
}

/** POST /api/gitlab */
export interface GitlabConnectResponse {
  ok: true;
  username: string | null;
  baseUrl: string;
  allowed: string[];
}

/** GET /api/gitlab/webhook */
export interface GitlabWebhookInfo {
  url: string;
  configured: boolean;
}

/** POST /api/gitlab/webhook: the new secret (shown once) and, when asked, each allowed project's webhook; or the removal. */
export type GitlabWebhookResponse =
  | { ok: true; url: string; removed: true }
  | { ok: true; url: string; secret: string; hooks?: GitlabHookResult[] };

export function gitlabRoutes(deps: IntegrationRouteDeps): Router {
  const router = Router();

  const parse = <T extends z.ZodType>(schema: T, req: Request, res: Response): z.infer<T> | undefined => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
      return undefined;
    }
    return parsed.data;
  };

  // ---------- Connect, or change the allow list ----------
  // A new token (or address) is checked with GET /user before it is saved; the allow list's new entries must be visible to the token.
  router.post("/api/gitlab", deps.requireAdmin, async (req, res) => {
    const input = parse(ConnectInput, req, res);
    if (!input) return;
    const current = (await deps.configRepo.load(true)).gitlab;
    const token = input.token || undefined;
    const baseUrl = input.baseUrl ?? current.baseUrl ?? GITLAB_DEFAULT_URL;
    const allowed = input.allowed ?? current.allowed;
    const fail = (error: string) => void res.status(400).json({ error });

    if (token && token.length < 20) return fail("That doesn't look like a GitLab token.");
    if (!token && !current.token) return fail("Paste a GitLab access token.");
    // The saved token is never sent to an address it was not checked with.
    if (!token && baseUrl !== current.baseUrl) return fail("Paste the token again to change the GitLab address: it is checked with the new address first.");

    const useToken = token ?? current.token!;
    let who: { username?: string; userId?: number } = { username: current.username, userId: current.userId };
    try {
      if (token) who = await verifyToken(token, baseUrl);
      await checkAllowed(new GitLab({ token: useToken, baseUrl }), token ? allowed : allowed.filter((e) => !current.allowed.includes(e)));
    } catch (err) {
      return fail(makeRedactor([useToken])(messageOf(err)));
    }
    await deps.configRepo.update((c) => {
      c.gitlab.baseUrl = baseUrl;
      c.gitlab.allowed = allowed;
      if (token) {
        c.gitlab.token = token;
        c.gitlab.username = who.username;
        c.gitlab.userId = who.userId;
      }
    });
    res.json({ ok: true, username: who.username ?? null, baseUrl, allowed } satisfies GitlabConnectResponse);
  });

  // ---------- Disconnect ----------
  // The token, its user and the webhook secret are removed; the address and allow list stay for a reconnect.
  router.post("/api/gitlab/disconnect", deps.requireAdmin, async (_req, res) => {
    if (!(await deps.configRepo.load(true)).gitlab.token) return void res.status(404).json({ error: "GitLab is not connected." });
    await deps.configRepo.update((c) => {
      c.gitlab = { baseUrl: c.gitlab.baseUrl, allowed: c.gitlab.allowed };
    });
    res.json({ ok: true });
  });

  // ---------- Webhook (merge request reviews and comments) ----------
  router.get("/api/gitlab/webhook", deps.requireAdmin, async (req, res) => {
    const { gitlab } = await deps.configRepo.load(true);
    res.json({ url: webhookUrl(req), configured: Boolean(gitlab.webhookSecret) } satisfies GitlabWebhookInfo);
  });

  // Makes a new secret (the old one stops working) and returns it once; with installHooks, adds the webhook to the allowed projects.
  router.post("/api/gitlab/webhook", deps.requireAdmin, async (req, res) => {
    const input = parse(WebhookInput, req, res);
    if (!input) return;
    const config = await deps.configRepo.load(true);
    if (!config.gitlab.token) return void res.status(404).json({ error: "Connect GitLab first." });
    const url = webhookUrl(req);
    if (input.remove) {
      await deps.configRepo.update((c) => {
        c.gitlab.webhookSecret = undefined;
      });
      return void res.json({ ok: true, url, removed: true } satisfies GitlabWebhookResponse);
    }
    const secret = randomToken(32);
    await deps.configRepo.update((c) => {
      c.gitlab.webhookSecret = secret;
    });
    const hooks = input.installHooks ? await installHooks(config, url, secret) : undefined;
    res.set("cache-control", "no-store");
    res.json({ ok: true, url, secret, ...(hooks ? { hooks } : {}) } satisfies GitlabWebhookResponse);
  });

  const webhookUrl = (req: Request) => `${deps.baseUrl(req)}/gitlab/webhook`;

  // ---------- Deliveries from GitLab ----------
  const seenDeliveries = new RecentSet(2000);
  router.post("/gitlab/webhook", express.raw({ type: "*/*", limit: "5mb" }), async (req, res) => {
    const config = await deps.configRepo.load();
    const secret = config.gitlab.webhookSecret;
    if (!config.gitlab.token || !secret) return void res.status(404).json({ error: "GitLab webhook is not configured" });
    if (!verifyGitlabToken(secret, req.get("x-gitlab-token"))) {
      // Wrong tokens count towards the brute-force brake; GitLab's own deliveries never do.
      return void deps.throttle(req, res, () => void res.status(401).json({ error: "Invalid token." }));
    }
    const event = EVENT.safeParse(req.get("x-gitlab-event"));
    if (!event.success) return void res.status(400).json({ error: "Missing or invalid X-Gitlab-Event header." });
    let payload: unknown;
    try {
      payload = JSON.parse((Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)).toString("utf8"));
    } catch {
      return void res.status(400).json({ error: "Invalid JSON." });
    }

    // A retry or a resend carries the same id; the first delivery is already handled.
    const delivery = (req.get("webhook-id") ?? req.get("idempotency-key") ?? "").slice(0, 100);
    if (delivery && seenDeliveries.has(delivery)) return void res.status(200).json({ ok: true, duplicate: true });
    if (delivery) seenDeliveries.add(delivery);

    // Other events are answered, not refused: GitLab disables a webhook whose deliveries keep failing.
    if (!GITLAB_EVENTS.has(event.data)) return void res.status(200).json({ ok: true, ignored: true });
    // Answer first (GitLab times out slow receivers); the follow-up starts after this.
    res.status(200).json({ ok: true });
    void handleGitlabDelivery(event.data, payload, deps.webhookDeps).catch(() => console.error("[gitlab] delivery failed"));
  });

  return router;
}

/** Who the token belongs to, and that it has the api scope. Error messages never include the token. */
async function verifyToken(token: string, baseUrl: string): Promise<{ username?: string; userId?: number }> {
  if (skipValidation()) return { username: "test" };
  const gl = new GitLab({ token, baseUrl });
  let viewer: Awaited<ReturnType<GitLab["viewer"]>>;
  try {
    viewer = await gl.viewer();
  } catch (err) {
    const status = gitlabStatus(err);
    if (status === 401) throw new Error("GitLab rejected this token. Check that it is active and not expired.");
    if (status === 403) throw new Error("This token cannot read its user: give it the api scope.");
    if (status === 0) throw new Error(`Couldn't reach GitLab at ${baseUrl}.`);
    throw new Error(`GitLab check failed (HTTP ${status ?? "?"}).`);
  }
  const scopes = await gl.tokenScopes();
  if (scopes && !scopes.includes("api")) {
    throw new Error(`This token needs the api scope (it has ${scopes.join(", ") || "none"}). Create one with api and write_repository.`);
  }
  return { username: viewer.login, ...(typeof viewer.id === "number" ? { userId: viewer.id } : {}) };
}

/** Every entry must be a project or a group the token can see, so a typo is caught before it silently allows nothing. */
async function checkAllowed(gl: GitLab, entries: string[]): Promise<void> {
  if (skipValidation() || entries.length === 0) return;
  const kinds = await mapLimit(entries, CONCURRENCY, async (entry) => {
    try {
      return await gl.pathKind(entry);
    } catch (err) {
      const status = gitlabStatus(err);
      throw new Error(status === 0 ? `Couldn't reach GitLab to check ${entry}.` : `GitLab check for ${entry} failed (HTTP ${status ?? "?"}).`);
    }
  });
  const missing = entries.filter((_, i) => kinds[i] === undefined);
  if (missing.length) throw new Error(`This token cannot see ${missing.slice(0, 5).join(", ")} on GitLab. Check the spelling, or give its user access.`);
}

/** Adds the webhook to each allowed project; groups and unreachable paths are reported, not fatal. */
async function installHooks(config: Config, url: string, secret: string): Promise<GitlabHookResult[]> {
  const gl = new GitLab({ token: config.gitlab.token!, baseUrl: config.gitlab.baseUrl });
  const redact = makeRedactor([...configSecrets(config), ...gl.secrets(), secret]);
  return mapLimit(config.gitlab.allowed, CONCURRENCY, async (path): Promise<GitlabHookResult> => {
    try {
      const kind = await gl.pathKind(path);
      if (kind === "namespace") return { path, ok: false, error: "A group or user, not a project: add the webhook to its projects, or as a group webhook in GitLab." };
      if (!kind) return { path, ok: false, error: "The token cannot see this project." };
      return { path, ok: true, action: await gl.installWebhook(repoId("gitlab", path), url, secret) };
    } catch (err) {
      const status = gitlabStatus(err);
      if (status === 403) return { path, ok: false, error: "The token's user needs the Maintainer role on this project to add webhooks." };
      return { path, ok: false, error: redact(messageOf(err)).slice(0, 300) };
    }
  });
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
