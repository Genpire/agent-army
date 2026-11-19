import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AttachmentRepo } from "./attachments.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import {
  CHANNEL_RE,
  ConfigRepo,
  ENV_KEY_RE,
  type MondayBoardAutomation,
  MondayBoardAutomationSchema,
  REPO_RE,
  RESERVED_ENV_KEYS,
  type RepoSetup,
  RepoSetupSchema,
  isReady,
  publicView,
  resolveMasterKey,
} from "./config.js";
import { hashPassword, randomToken, safeEqual, sessionKey, signSession, verifyPassword, verifySession } from "./crypto.js";
import { connectionForRepo, describeAllowed, hasGitHub } from "./github-access.js";
import { CONVERSATION_ID_RE, ConversationService, MESSAGE_MAX_CHARS, type WebThreads } from "./conversations.js";
import { handleSlackEvent, withBrainSlot } from "./dispatch.js";
import { RecentSet } from "./listen.js";
import { MEMORY_MAX_FACTS, MemoryRepo } from "./memory.js";
import { MondayClient, MondayError, checkMonday, statusColumns } from "./monday.js";
import {
  TicketAutomation,
  checkBoardAutomation,
  connectWebhooks,
  labelConflict,
  manualWebhookSteps,
  removeWebhook,
  webhookChallenge,
  webhookIds,
} from "./monday-automation.js";
import { NOTES_MAX_CHARS, NotesRepo } from "./notes.js";
import { createPointerBrain } from "./pointer.js";
import type { PointerBrain, SlackDeps, SlackMessageEvent } from "./pointer-types.js";
import { type Runner, createRunner } from "./runner.js";
import { SCREENSHOT_NAME_RE, ScreenshotRepo, TASK_ID_RE, screenshotType } from "./screenshots.js";
import { buildManifest, manifestCreateUrl, slackClient, verifySlackSignature } from "./slack.js";
import { createStore } from "./store.js";
import { readTimeline } from "./task-events.js";
import { TaskRepo } from "./tasks.js";
import { TeamSchema } from "./team.js";
import { rememberConsoleUrl } from "./ticket-sync.js";
import { checkAnthropic, checkGithub, checkSlack } from "./validate.js";
import { UsageRepo } from "./usage.js";
import { handleGithubWebhook, parseGithubPayload, verifyGithubSignature } from "./webhook.js";
import { configSecrets, makeRedactor } from "./worker.js";

const SESSION_COOKIE = "army_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const BOARD_ID = z.string().max(20).regex(/^\d+$/, "Board ids are numbers, like 1234567890.");

/** A GitHub allow list: owners ("your-org") or exact repos ("someone/some-repo"), deduplicated. */
const OWNER_RE = /^[A-Za-z0-9-]+$/;
const ALLOW_LIST = z
  .array(
    z
      .string()
      .trim()
      .max(200)
      .refine((s) => OWNER_RE.test(s) || REPO_RE.test(s), "Allowed entries are owners (your-org) or exact repos (owner/repo)."),
  )
  .max(50, "Allow at most 50 owners or repos.")
  .transform((xs) => [...new Set(xs)]);
const CONNECTION_ID = z.string().max(40).regex(/^gh-[0-9a-f]{6,}$/, "Connection ids look like gh-1a2b3c.");
const MAX_EXTRA_GITHUB = 10;
const CI_WAIT_ERROR = "The wait for checks is a whole number of minutes from 0 to 60.";
const CI_FIX_ERROR = "Fix rounds are a whole number from 0 to 5.";
/** GitHub event names, e.g. pull_request_review. */
const GITHUB_EVENT = z.string().max(100).regex(/^[a-z_]+$/);
/** The webhook secret pasted in GitHub and on the admin page: printable ASCII without spaces. "" removes it. */
const WEBHOOK_SECRET = z.union([
  z.literal(""),
  z
    .string()
    .min(20, "Use a secret of at least 20 characters.")
    .max(200, "Use a secret of at most 200 characters.")
    .regex(/^[\x21-\x7e]+$/, "Use printable characters without spaces in the secret."),
]);
const REPO_INPUT = z.string().trim().max(200).regex(REPO_RE, "Repos look like owner/repo.");
/** A board's ticket automation as the admin page sends it; labels left out get the defaults (MondayBoardAutomationSchema). */
const LABEL_INPUT = (what: string) => z.string().trim().max(100, `The ${what} label is at most 100 characters.`).optional();
const BOARD_AUTOMATION_INPUT = z.object({
  repo: REPO_INPUT,
  statusColumnId: z.string().trim().min(1, "Choose the status column to watch.").max(100, "Column ids are at most 100 characters."),
  startLabel: z.string().trim().min(1, "Choose the status that starts a task.").max(100, "The start label is at most 100 characters."),
  workingLabel: LABEL_INPUT("working"),
  reviewLabel: LABEL_INPUT("in review"),
  doneLabel: LABEL_INPUT("done"),
  stuckLabel: LABEL_INPUT("stuck"),
});
const MAX_AUTOMATED_BOARDS = 50;
const ENV_VALUE_MAX = 10_000;
/** Variables to set (a string) or delete (null); names left out are kept. */
const ENV_CHANGES = z
  .record(
    z.string(),
    z.union([
      z
        .string()
        .min(1, "Empty values are not allowed; send null to delete a variable.")
        .max(ENV_VALUE_MAX, `Variable values are limited to ${ENV_VALUE_MAX} characters.`),
      z.null(),
    ]),
  )
  .superRefine((env, ctx) => {
    const names = Object.keys(env);
    const invalid = names.find((k) => !ENV_KEY_RE.test(k));
    if (invalid !== undefined) {
      const shown = invalid.length > 40 ? `${invalid.slice(0, 40)}…` : invalid;
      ctx.addIssue({ code: "custom", message: `"${shown}" is not a variable name: use letters, digits and _, and do not start with a digit.` });
      return;
    }
    const reserved = names.find((k) => env[k] !== null && RESERVED_ENV_KEYS.has(k));
    if (reserved) ctx.addIssue({ code: "custom", message: `${reserved} is reserved by the platform.` });
  });

function newConnectionId(taken: Set<string>): string {
  for (;;) {
    const id = `gh-${randomBytes(3).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

/** Proves `token` can see every exact repo in an allow list. Owner entries are not checked. Errors never include the token. */
async function checkRepoAccess(token: string, allowed: string[]): Promise<void> {
  if (process.env.SKIP_VALIDATION === "1") return;
  for (const repo of allowed.filter((x) => x.includes("/"))) {
    const res = await fetch(`https://api.github.com/repos/${repo.split("/").map(encodeURIComponent).join("/")}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "agent-army" },
    }).catch(() => undefined);
    if (!res) throw new Error(`Couldn't reach GitHub to check ${repo}.`);
    await res.body?.cancel();
    if (res.status === 401 || res.status === 403 || res.status === 404) throw new Error(`This token cannot reach ${repo}.`);
    if (!res.ok) throw new Error(`GitHub check for ${repo} failed (HTTP ${res.status}).`);
  }
}

/** Test seams: a fake brain, runner or Slack client instead of the real ones. */
export interface AppOverrides {
  brain?: PointerBrain;
  runner?: Runner;
  slack?: SlackDeps["slack"];
}

export async function createApp(env: NodeJS.ProcessEnv = process.env, overrides: AppOverrides = {}) {
  const store = createStore(env);
  const masterKey = await resolveMasterKey(store, env);
  const configRepo = new ConfigRepo(store, masterKey);
  const tasks = new TaskRepo(store);
  const memory = new MemoryRepo(store, masterKey);
  const notes = new NotesRepo(store, masterKey);
  const attachments = new AttachmentRepo(store, masterKey);
  const screenshots = new ScreenshotRepo(store, masterKey);

  let maxParallel = (await configRepo.load()).limits.maxParallel;
  const runner = overrides.runner ?? createRunner(() => maxParallel, env);
  const brain = overrides.brain ?? createPointerBrain({ configRepo, memory, notes, attachments });
  const usage = new UsageRepo(store, tasks);
  // Console conversations: answered by the same brain, within the same limit as Slack answers.
  const conversations = new ConversationService({ store, configRepo, tasks, runner, brain, usage, brainSlot: withBrainSlot });
  const slackDeps: SlackDeps & { web: WebThreads } = {
    configRepo,
    tasks,
    runner,
    memory,
    attachments,
    usage,
    brain,
    slack: overrides.slack ?? slackClient,
    web: conversations,
  };

  // The setup token creates the admin account on first run and resets its
  // password later: only someone who can read the deployment's secrets (the
  // deploy output, Secret Manager) or its log can use it.
  const setupToken = env.SETUP_TOKEN ?? randomToken(18);
  if (!env.SETUP_TOKEN) {
    const firstRun = !(await configRepo.load()).adminPasswordHash;
    console.log(
      firstRun
        ? `\n[setup] Open the app and use this one-time setup token: ${setupToken}\n`
        : `\n[setup] Forgot the admin password? Reset it on the sign-in page with this setup token: ${setupToken}\n`,
    );
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  const baseUrl = (req: Request) =>
    (env.PUBLIC_URL ?? `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");

  // Sessions are signed with a key tied to the current password, so a new password signs everyone out.
  const currentSessionKey = async () => sessionKey(masterKey, (await configRepo.load()).adminPasswordHash);

  const isAuthed = async (req: Request) => {
    const cookie = (req.headers.cookie ?? "")
      .split(";")
      .map((p) => p.trim().split("="))
      .find(([k]) => k === SESSION_COOKIE)?.[1];
    return verifySession(await currentSessionKey(), cookie);
  };

  const startSession = async (req: Request, res: Response) => {
    const secure = req.protocol === "https" ? "; Secure" : "";
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${signSession(await currentSessionKey(), SESSION_TTL_MS)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
    );
  };

  const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
    if (!(await isAuthed(req))) return void res.status(401).json({ error: "Sign in first." });
    next();
  };

  // Brute-force brake for the two unauthenticated secret-checking routes.
  const attempts = new Map<string, { n: number; resetAt: number }>();
  const throttle = (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const entry = attempts.get(key);
    if (!entry || entry.resetAt < now) attempts.set(key, { n: 1, resetAt: now + 10 * 60_000 });
    else if (++entry.n > 10) return void res.status(429).json({ error: "Too many attempts. Try again later." });
    next();
  };

  // ---------- Slack events (raw body is needed for the signature) ----------
  const seenEvents = new Set<string>();
  app.post("/slack/events", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    let payload: { type?: string; challenge?: string; event_id?: string; event?: SlackMessageEvent };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return void res.status(400).send("bad json");
    }

    // Echoing the challenge reveals nothing, and it must work before the
    // signing secret has been pasted into the wizard.
    if (payload.type === "url_verification") {
      return void res.json({ challenge: payload.challenge ?? "" });
    }

    const config = await configRepo.load();
    const ok =
      config.slack.signingSecret &&
      verifySlackSignature({
        signingSecret: config.slack.signingSecret,
        timestamp: req.get("x-slack-request-timestamp"),
        signature: req.get("x-slack-signature"),
        rawBody,
      });
    if (!ok) return void res.status(401).send("invalid signature");

    // Slack retries when we are slow; the first delivery is already handled.
    if (req.get("x-slack-retry-num") || (payload.event_id && seenEvents.has(payload.event_id))) {
      return void res.status(200).send("ok");
    }
    if (payload.event_id) {
      seenEvents.add(payload.event_id);
      if (seenEvents.size > 2000) seenEvents.delete(seenEvents.values().next().value!);
    }

    // Answer first: a reply can take minutes, Slack retries after 3 seconds, and
    // the service runs with CPU always allocated, so the work goes on after this.
    res.status(200).send("ok");
    const event = payload.type === "event_callback" ? payload.event : undefined;
    if (event?.type === "message" || event?.type === "app_mention") {
      void handleSlackEvent(event, slackDeps).catch((err) => console.error("[slack] event failed:", String(err)));
    }
  });

  // ---------- GitHub webhook: reviews and comments on the team's pull requests ----------
  const seenDeliveries = new RecentSet(2000);
  app.post("/github/webhook", express.raw({ type: "*/*", limit: "5mb" }), async (req, res) => {
    const secret = (await configRepo.load()).github.webhookSecret;
    if (!secret) return void res.status(404).json({ error: "GitHub webhook is not configured" });
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyGithubSignature(secret, rawBody, req.get("x-hub-signature-256"))) {
      return void res.status(401).json({ error: "Invalid signature." });
    }
    const event = GITHUB_EVENT.safeParse(req.get("x-github-event"));
    if (!event.success) return void res.status(400).json({ error: "Missing or invalid X-GitHub-Event header." });
    const payload = parseGithubPayload(rawBody, req.get("content-type"));
    if (payload === undefined) return void res.status(400).json({ error: "Invalid JSON." });

    // A redelivery carries the same id; the first delivery is already handled.
    const delivery = (req.get("x-github-delivery") ?? "").slice(0, 100);
    if (delivery && seenDeliveries.has(delivery)) return void res.status(200).json({ ok: true, duplicate: true });
    if (delivery) seenDeliveries.add(delivery);

    if (event.data === "ping") return void res.status(200).json({ ok: true });
    // Answer first (GitHub gives up after 10 seconds); the follow-up starts after this.
    res.status(202).json({ ok: true });
    void handleGithubWebhook(event.data, payload, { ...slackDeps, store }).catch(() => console.error(`[github] ${event.data} failed`));
  });

  // ---------- monday.com webhook: tickets that start repo tasks ----------
  // monday.com does not sign webhooks created with an API token: the secret in the
  // URL is the check. The payload only names the board and item; both are read again.
  const automation = new TicketAutomation({
    configRepo,
    tasks,
    startTask: (repo, instruction, opts) => conversations.startDirectTask(repo, instruction, opts),
  });
  app.post("/monday/webhook/:secret", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    const auto = (await configRepo.load()).monday.automation;
    const given = String(req.params.secret ?? "");
    if (!auto.enabled || !auto.webhookSecret || !safeEqual(given, auto.webhookSecret)) return void res.status(404).json({ error: "Not found." });
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "");
    } catch {
      return void res.status(400).json({ error: "Invalid JSON." });
    }
    // Sent once when the webhook is created; monday.com expects it back.
    const challenge = webhookChallenge(payload);
    if (challenge !== undefined) return void res.json({ challenge });
    // Answer first (monday.com retries slow deliveries); the item is read and the task started after this.
    res.status(200).json({ ok: true });
    const ids = webhookIds(payload);
    if (ids) void automation.handle(ids.boardId, ids.itemId);
  });

  // ---------- Admin API ----------
  // A full team (30 agents with up to 8 000-character instructions) is larger
  // than any other admin payload. The general parser skips an already-read body.
  app.use("/api/team", express.json({ limit: "1mb" }));
  // A repo setup can hold 100 variables of up to 10 000 characters each.
  app.use("/api/repo-setup", express.json({ limit: "2mb" }));
  app.use("/api", express.json({ limit: "100kb" }));

  const body = <T extends z.ZodType>(schema: T, req: Request, res: Response): z.infer<T> | undefined => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
      return undefined;
    }
    return parsed.data;
  };

  app.get("/healthz", (_req, res) => void res.send("ok"));

  app.get("/api/state", async (req, res) => {
    const config = await configRepo.load(true);
    const authed = await isAuthed(req);
    res.json({
      setupRequired: !config.adminPasswordHash,
      authed,
      ...(authed
        ? {
            ready: isReady(config),
            config: publicView(config),
            runner: runner.kind,
            storage: store.describe(),
            eventsUrl: `${baseUrl(req)}/slack/events`,
            githubWebhookUrl: `${baseUrl(req)}/github/webhook`,
          }
        : {}),
    });
  });

  app.post("/api/setup", throttle, async (req, res) => {
    const input = body(z.object({ setupToken: z.string(), password: z.string().min(10, "Use at least 10 characters.") }), req, res);
    if (!input) return;
    if ((await configRepo.load(true)).adminPasswordHash) {
      return void res.status(409).json({ error: "Already set up. Sign in instead." });
    }
    if (!safeEqual(input.setupToken.trim(), setupToken)) {
      return void res.status(403).json({ error: "Wrong setup token." });
    }
    await configRepo.update((c) => {
      c.adminPasswordHash = hashPassword(input.password);
    });
    await startSession(req, res);
    res.json({ ok: true });
  });

  // Forgot the password: the setup token (Secret Manager, the deploy output or
  // the server log) sets a new one. Every existing session is signed out.
  app.post("/api/reset-password", throttle, async (req, res) => {
    const input = body(z.object({ setupToken: z.string(), password: z.string().min(10, "Use at least 10 characters.") }), req, res);
    if (!input) return;
    if (!(await configRepo.load(true)).adminPasswordHash) {
      return void res.status(409).json({ error: "There is no admin account yet. Set it up instead." });
    }
    if (!safeEqual(input.setupToken.trim(), setupToken)) {
      return void res.status(403).json({ error: "Wrong setup token." });
    }
    await configRepo.update((c) => {
      c.adminPasswordHash = hashPassword(input.password);
    });
    await startSession(req, res);
    res.json({ ok: true });
  });

  app.post("/api/login", throttle, async (req, res) => {
    const input = body(z.object({ password: z.string() }), req, res);
    if (!input) return;
    const hash = (await configRepo.load(true)).adminPasswordHash;
    if (!hash || !verifyPassword(input.password, hash)) {
      return void res.status(403).json({ error: "Wrong password." });
    }
    await startSession(req, res);
    res.json({ ok: true });
  });

  app.post("/api/logout", (_req, res) => {
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });

  // Signed in: change the password. The current one is asked again, so a borrowed
  // session cannot lock the owner out. Other sessions are signed out; this one stays.
  app.post("/api/password", throttle, requireAdmin, async (req, res) => {
    const input = body(
      z.object({ currentPassword: z.string(), password: z.string().min(10, "Use at least 10 characters.") }),
      req,
      res,
    );
    if (!input) return;
    const hash = (await configRepo.load(true)).adminPasswordHash;
    if (!hash || !verifyPassword(input.currentPassword, hash)) {
      return void res.status(403).json({ error: "The current password is wrong." });
    }
    await configRepo.update((c) => {
      c.adminPasswordHash = hashPassword(input.password);
    });
    await startSession(req, res);
    res.json({ ok: true });
  });

  app.post("/api/anthropic", requireAdmin, async (req, res) => {
    const input = body(z.object({ apiKey: z.string().min(10), model: z.string().max(100).default("") }), req, res);
    if (!input) return;
    try {
      await checkAnthropic(input.apiKey.trim());
    } catch (err) {
      return void res.status(400).json({ error: (err as Error).message });
    }
    await configRepo.update((c) => {
      c.anthropic = { apiKey: input.apiKey.trim(), model: input.model.trim() };
    });
    res.json({ ok: true });
  });

  app.get("/api/slack/manifest", requireAdmin, async (req, res) => {
    const config = await configRepo.load();
    const requested = String(req.query.name ?? "").trim();
    const name = (requested || config.team.pointer.name).slice(0, 35);
    const manifest = buildManifest(baseUrl(req), name);
    res.json({ manifest, createUrl: manifestCreateUrl(manifest) });
  });

  app.post("/api/slack", requireAdmin, async (req, res) => {
    const input = body(z.object({ botToken: z.string().startsWith("xoxb-", "Bot tokens start with xoxb-"), signingSecret: z.string().min(16) }), req, res);
    if (!input) return;
    let info: { botUserId: string; teamName: string };
    try {
      info = await checkSlack(input.botToken.trim());
    } catch (err) {
      return void res.status(400).json({ error: (err as Error).message });
    }
    await configRepo.update((c) => {
      c.slack = { ...c.slack, botToken: input.botToken.trim(), signingSecret: input.signingSecret.trim(), ...info };
    });
    res.json({ ok: true, ...info });
  });

  app.post("/api/github", requireAdmin, async (req, res) => {
    const input = body(z.object({ token: z.string().min(20), allowedOwners: ALLOW_LIST.default([]) }), req, res);
    if (!input) return;
    let info: { login: string };
    try {
      info = await checkGithub(input.token.trim());
    } catch (err) {
      return void res.status(400).json({ error: (err as Error).message });
    }
    await configRepo.update((c) => {
      c.github = { ...c.github, token: input.token.trim(), login: info.login, allowedOwners: input.allowedOwners };
    });
    res.json({ ok: true, ...info });
  });

  // ---------- Other GitHub connections (e.g. a repo on another person's account) ----------
  // Tokens are accepted, never returned; /api/state lists the connections with masked keys.
  app.post("/api/github/connections", requireAdmin, async (req, res) => {
    const input = body(
      z.object({ token: z.string().trim().min(20, "That doesn't look like a GitHub token.").max(4000), allowed: ALLOW_LIST.default([]) }),
      req,
      res,
    );
    if (!input) return;
    const full = `At most ${MAX_EXTRA_GITHUB} other GitHub connections. Remove one first.`;
    if ((await configRepo.load(true)).github.extra.length >= MAX_EXTRA_GITHUB) return void res.status(400).json({ error: full });
    let info: { login: string };
    try {
      info = await checkGithub(input.token);
      await checkRepoAccess(input.token, input.allowed);
    } catch (err) {
      return void res.status(400).json({ error: (err as Error).message });
    }
    let id = "";
    let added = false;
    await configRepo.update((c) => {
      if (c.github.extra.length >= MAX_EXTRA_GITHUB) return;
      id = newConnectionId(new Set(c.github.extra.map((x) => x.id)));
      c.github.extra.push({ id, token: input.token, login: info.login || undefined, allowed: input.allowed });
      added = true;
    });
    if (!added) return void res.status(400).json({ error: full });
    res.json({ ok: true, id, login: info.login });
  });

  app.post("/api/github/connections/update", requireAdmin, async (req, res) => {
    const input = body(z.object({ id: CONNECTION_ID, allowed: ALLOW_LIST }), req, res);
    if (!input) return;
    const conn = (await configRepo.load(true)).github.extra.find((x) => x.id === input.id);
    if (!conn) return void res.status(404).json({ error: "Not found." });
    try {
      await checkRepoAccess(conn.token, input.allowed);
    } catch (err) {
      return void res.status(400).json({ error: (err as Error).message });
    }
    let found = false;
    await configRepo.update((c) => {
      const x = c.github.extra.find((e) => e.id === input.id);
      if (!x) return;
      x.allowed = input.allowed;
      found = true;
    });
    if (!found) return void res.status(404).json({ error: "Not found." });
    res.json({ ok: true });
  });

  app.post("/api/github/connections/delete", requireAdmin, async (req, res) => {
    const input = body(z.object({ id: CONNECTION_ID }), req, res);
    if (!input) return;
    let found = false;
    await configRepo.update((c) => {
      found = c.github.extra.some((x) => x.id === input.id);
      c.github.extra = c.github.extra.filter((x) => x.id !== input.id);
    });
    if (!found) return void res.status(404).json({ error: "Not found." });
    res.json({ ok: true });
  });

  // ---------- GitHub webhook secret ----------
  // "" removes it, which turns the webhook off. The secret is never returned.
  app.post("/api/github/webhook", requireAdmin, async (req, res) => {
    const input = body(z.object({ secret: z.string().trim().pipe(WEBHOOK_SECRET) }), req, res);
    if (!input) return;
    await configRepo.update((c) => {
      c.github.webhookSecret = input.secret || undefined;
    });
    res.json({ ok: true, url: `${baseUrl(req)}/github/webhook` });
  });

  // ---------- Per-repo setup for repo tasks ----------
  // Fields left out are kept; env merges by name (null deletes). Values are never returned.
  app.post("/api/repo-setup", requireAdmin, async (req, res) => {
    const input = body(
      z.object({
        repo: REPO_INPUT,
        setupCommand: z.string().trim().max(2000, "The setup command is limited to 2000 characters.").optional(),
        startCommand: z.string().trim().max(500, "The start command is limited to 500 characters.").optional(),
        appUrl: z.string().trim().max(300, "The app URL is limited to 300 characters.").optional(),
        env: ENV_CHANGES.optional(),
      }),
      req,
      res,
    );
    if (!input) return;
    let error: string | undefined;
    const updated = await configRepo.update((c) => {
      const existingKey = repoSetupKey(c.repoSetup, input.repo);
      const current: RepoSetup = (existingKey && c.repoSetup[existingKey]) || RepoSetupSchema.parse({});
      const env = { ...current.env };
      for (const [name, value] of Object.entries(input.env ?? {})) {
        if (value === null) delete env[name];
        else env[name] = value;
      }
      const merged = RepoSetupSchema.safeParse({
        setupCommand: input.setupCommand ?? current.setupCommand,
        startCommand: input.startCommand ?? current.startCommand,
        appUrl: input.appUrl ?? current.appUrl,
        env,
      });
      if (!merged.success) {
        error = merged.error.issues[0]?.message ?? "Invalid repository setup.";
        return;
      }
      if (existingKey) delete c.repoSetup[existingKey];
      c.repoSetup[input.repo] = merged.data;
    });
    if (error) return void res.status(400).json({ error });
    res.json({ ok: true, repoSetup: publicView(updated).repoSetup[input.repo] });
  });

  app.post("/api/repo-setup/delete", requireAdmin, async (req, res) => {
    const input = body(z.object({ repo: REPO_INPUT }), req, res);
    if (!input) return;
    let found = false;
    await configRepo.update((c) => {
      const key = repoSetupKey(c.repoSetup, input.repo);
      if (!key) return;
      delete c.repoSetup[key];
      found = true;
    });
    if (!found) return void res.status(404).json({ error: "Not found." });
    res.json({ ok: true });
  });

  app.post("/api/settings", requireAdmin, async (req, res) => {
    const input = body(
      z.object({
        orgName: z.string().max(60).optional(),
        allowedUserIds: z.array(z.string().regex(/^[UW][A-Z0-9]+$/, "Slack user IDs look like U012ABCDEF")).max(200).optional(),
        allowedOwners: ALLOW_LIST.optional(),
        bindings: z.record(z.string().regex(CHANNEL_RE, "Channel IDs look like C012ABCDEF"), z.string().regex(REPO_RE, "Repos look like owner/repo")).optional(),
        pointerChannels: z.array(z.string().regex(CHANNEL_RE, "Channel IDs look like C012ABCDEF")).max(100).optional(),
        limits: z
          .object({
            maxTurns: z.number(),
            maxBudgetUsd: z.number(),
            maxParallel: z.number(),
            progressEveryMin: z.number(),
            ciWaitMin: z.number().int(CI_WAIT_ERROR).min(0, CI_WAIT_ERROR).max(60, CI_WAIT_ERROR),
            ciFixRounds: z.number().int(CI_FIX_ERROR).min(0, CI_FIX_ERROR).max(5, CI_FIX_ERROR),
          })
          .partial()
          .optional(),
      }),
      req,
      res,
    );
    if (!input) return;
    try {
      const updated = await configRepo.update((c) => {
        if (input.orgName !== undefined) c.orgName = input.orgName;
        if (input.allowedUserIds) c.slack.allowedUserIds = input.allowedUserIds;
        if (input.allowedOwners) c.github.allowedOwners = input.allowedOwners;
        if (input.bindings) c.bindings = input.bindings;
        if (input.pointerChannels) c.slack.pointerChannels = [...new Set(input.pointerChannels)];
        if (input.limits) c.limits = { ...c.limits, ...input.limits };
      });
      maxParallel = updated.limits.maxParallel;
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof z.ZodError ? (err.issues[0]?.message ?? "Invalid settings.") : "Invalid settings." });
    }
  });

  app.get("/api/tasks", requireAdmin, async (_req, res) => {
    res.json({ tasks: await tasks.recent(30) });
  });

  // ---------- Chat: conversations with Pointer from the console ----------
  // Pointer answers in the background (202); the page polls the conversation.
  const MESSAGE_TEXT = z.object({
    text: z
      .string()
      .trim()
      .min(1, "Write a message first.")
      .max(MESSAGE_MAX_CHARS, `Messages are limited to ${MESSAGE_MAX_CHARS} characters.`),
  });
  const CONVERSATION_NOT_FOUND = "Conversation not found.";
  const conversationParam = (req: Request, res: Response): string | undefined => {
    const id = String(req.params.id ?? "");
    if (CONVERSATION_ID_RE.test(id)) return id;
    res.status(404).json({ error: CONVERSATION_NOT_FOUND });
    return undefined;
  };

  app.get("/api/conversations", requireAdmin, async (_req, res) => {
    res.json({ conversations: await conversations.list() });
  });

  app.post("/api/conversations", requireAdmin, async (req, res) => {
    const input = body(MESSAGE_TEXT, req, res);
    if (!input) return;
    const result = await conversations.create(input.text);
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.status(202).json({ conversation: result.conversation });
  });

  app.get("/api/conversations/:id", requireAdmin, async (req, res) => {
    const id = conversationParam(req, res);
    if (!id) return;
    const view = await conversations.view(id);
    if (!view) return void res.status(404).json({ error: CONVERSATION_NOT_FOUND });
    res.json(view);
  });

  app.post("/api/conversations/:id/messages", requireAdmin, async (req, res) => {
    const id = conversationParam(req, res);
    if (!id) return;
    const input = body(MESSAGE_TEXT, req, res);
    if (!input) return;
    const result = await conversations.send(id, input.text);
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.status(202).json({ conversation: result.conversation });
  });

  app.post("/api/conversations/:id/delete", requireAdmin, async (req, res) => {
    const id = conversationParam(req, res);
    if (!id) return;
    if (!(await conversations.remove(id))) return void res.status(404).json({ error: CONVERSATION_NOT_FOUND });
    res.json({ ok: true });
  });

  // A repo task straight from the console (no Pointer reply), in a new conversation.
  app.post("/api/tasks", requireAdmin, async (req, res) => {
    const input = body(
      z.object({
        repo: REPO_INPUT,
        instruction: z
          .string()
          .trim()
          .min(1, "Say what the team should do.")
          .max(MESSAGE_MAX_CHARS, `Instructions are limited to ${MESSAGE_MAX_CHARS} characters.`),
      }),
      req,
      res,
    );
    if (!input) return;
    const result = await conversations.startDirectTask(input.repo, input.instruction);
    if (!result.ok) {
      return void res.status(result.status).json({ error: result.error, ...(result.conversationId ? { conversationId: result.conversationId } : {}) });
    }
    res.status(202).json({ conversationId: result.conversationId, taskId: result.taskId });
  });

  // ---------- A repo task's timeline and screenshots (Slack and console tasks) ----------
  const TASK_NOT_FOUND = "Task not found.";
  const taskParam = async (req: Request, res: Response): Promise<string | undefined> => {
    const id = String(req.params.id ?? "");
    if (TASK_ID_RE.test(id) && (await tasks.get(id))) return id;
    res.status(404).json({ error: TASK_NOT_FOUND });
    return undefined;
  };

  app.get("/api/tasks/:id/events", requireAdmin, async (req, res) => {
    const id = await taskParam(req, res);
    if (!id) return;
    res.json({ timeline: await readTimeline(store, id) });
  });

  app.get("/api/tasks/:id/screenshots", requireAdmin, async (req, res) => {
    const id = await taskParam(req, res);
    if (!id) return;
    const list = await screenshots.list(id);
    res.json({ screenshots: list.map(({ name, size }) => ({ name, size })) });
  });

  app.get("/api/tasks/:id/screenshots/:name", requireAdmin, async (req, res) => {
    const name = String(req.params.name ?? "");
    if (!SCREENSHOT_NAME_RE.test(name) || name.includes("..")) return void res.status(400).json({ error: "Invalid screenshot name." });
    const id = await taskParam(req, res);
    if (!id) return;
    const bytes = await screenshots.get(id, name);
    const type = bytes && screenshotType(bytes);
    if (!bytes || !type) return void res.status(404).json({ error: "Screenshot not found." });
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `inline; filename="${name}"`);
    res.send(bytes);
  });

  // Claude spend this calendar month (UTC): chat replies and repo tasks.
  app.get("/api/usage", requireAdmin, async (_req, res) => {
    res.json(await usage.month());
  });

  app.post("/api/team", requireAdmin, async (req, res) => {
    const parsed = TeamSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: teamError(parsed.error, req.body) });
    await configRepo.update((c) => {
      c.team = parsed.data;
    });
    res.json({ ok: true });
  });

  app.get("/api/memory", requireAdmin, async (_req, res) => {
    res.json({ facts: await memory.list(), max: MEMORY_MAX_FACTS });
  });

  app.post("/api/memory/delete", requireAdmin, async (req, res) => {
    const input = body(z.object({ id: z.string().min(1).max(100) }), req, res);
    if (!input) return;
    if (!(await memory.forget(input.id))) return void res.status(404).json({ error: "Not found." });
    res.json({ ok: true });
  });

  // ---------- Project notes ----------
  app.get("/api/notes", requireAdmin, async (_req, res) => {
    res.json({ notes: await notes.list(), max: NOTES_MAX_CHARS });
  });

  app.get("/api/notes/:owner/:repo", requireAdmin, async (req, res) => {
    const repo = `${req.params.owner}/${req.params.repo}`;
    if (!REPO_RE.test(repo)) return void res.status(400).json({ error: "Repos look like owner/repo." });
    const found = await notes.get(repo);
    if (!found) return void res.status(404).json({ error: `No notes for ${repo} yet.` });
    res.json({ repo: found.repo, text: found.text, updatedAt: found.updatedAt });
  });

  // Empty text deletes the notes. NotesRepo checks the repo and the length.
  app.post("/api/notes", requireAdmin, async (req, res) => {
    const input = body(z.object({ repo: z.string().max(200), text: z.string() }), req, res);
    if (!input) return;
    const saved = await notes.put(input.repo.trim(), input.text);
    if (!saved.ok) return void res.status(400).json({ error: saved.error });
    res.json({ ok: true });
  });

  // ---------- monday.com (optional) ----------
  app.post("/api/monday", requireAdmin, async (req, res) => {
    const input = body(
      z.object({
        token: z.string().max(4000).optional(),
        /** "" clears the default board. */
        defaultBoardId: z.union([z.literal(""), BOARD_ID]).optional(),
        allowedBoardIds: z.array(BOARD_ID).max(100, "Allow at most 100 boards.").optional(),
      }),
      req,
      res,
    );
    if (!input) return;
    const token = input.token?.trim() ?? "";
    if (token && token.length < 20) {
      return void res.status(400).json({ error: "That doesn't look like a monday.com API token." });
    }
    const current = (await configRepo.load(true)).monday;
    if (!token && !current.token) {
      return void res.status(400).json({ error: "Connect monday.com with an API token first." });
    }
    const allowed = input.allowedBoardIds ? [...new Set(input.allowedBoardIds)] : current.allowedBoardIds;
    const defaultBoardId = input.defaultBoardId === undefined ? current.defaultBoardId : input.defaultBoardId || undefined;
    if (defaultBoardId && allowed.length > 0 && !allowed.includes(defaultBoardId)) {
      return void res.status(400).json({ error: "The default board must be one of the boards Pointer may use." });
    }

    let info: { userName: string; accountName: string } | undefined;
    if (token) {
      try {
        info = await checkMonday(token);
      } catch (err) {
        return void res.status(400).json({ error: (err as Error).message });
      }
    }
    await configRepo.update((c) => {
      if (info) c.monday = { ...c.monday, token, ...info };
      c.monday.allowedBoardIds = allowed;
      c.monday.defaultBoardId = defaultBoardId;
    });
    res.json({ ok: true, ...info });
  });

  // Forgets the token and who it belongs to; the board settings stay for a later reconnect.
  app.post("/api/monday/disconnect", requireAdmin, async (_req, res) => {
    await configRepo.update((c) => {
      c.monday = { ...c.monday, token: undefined, userName: undefined, accountName: undefined };
    });
    res.json({ ok: true });
  });

  // Boards for the page's "Default board" picker, most recently used first.
  app.get("/api/monday/boards", requireAdmin, async (req, res) => {
    const token = (await configRepo.load(true)).monday.token;
    if (!token) return void res.status(400).json({ error: "monday.com is not connected." });
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
    try {
      const boards = await new MondayClient(token).listBoards({ ...(search ? { search } : {}), limit: 50 });
      res.json({ boards });
    } catch (err) {
      // MondayClient redacts the token from its errors; anything else is reported generically.
      res.status(400).json({ error: err instanceof MondayError ? err.message : "monday.com request failed." });
    }
  });

  // ---------- monday.com ticket automation (admin) ----------
  // Boards whose tickets start repo tasks. `null` removes a board (and its webhook).
  app.post("/api/monday/automation", requireAdmin, async (req, res) => {
    const parsed = z
      .object({ enabled: z.boolean().optional(), boards: z.record(z.string(), z.union([BOARD_AUTOMATION_INPUT, z.null()])).optional() })
      .safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const [section, boardId] = issue?.path ?? [];
      const where = section === "boards" && typeof boardId === "string" ? `Board ${boardId.slice(0, 20)}: ` : "";
      return void res.status(400).json({ error: `${where}${issue?.message ?? "Invalid input."}` });
    }
    const input = parsed.data;
    const changes = Object.entries(input.boards ?? {});
    const badId = changes.find(([id]) => !BOARD_ID.safeParse(id).success);
    if (badId) return void res.status(400).json({ error: `"${badId[0].slice(0, 20)}" is not a board id. Board ids are numbers, like 1234567890.` });

    const config = await configRepo.load(true);
    const name = config.team.pointer.name;
    const token = config.monday.token;
    const adding = changes.filter((e): e is [string, z.infer<typeof BOARD_AUTOMATION_INPUT>] => e[1] !== null);
    if ((input.enabled || adding.length > 0) && !token) {
      return void res.status(400).json({ error: "Connect monday.com with an API token first." });
    }
    const total = new Set([...Object.keys(config.monday.automation.boards), ...adding.map(([id]) => id)]).size;
    if (total > MAX_AUTOMATED_BOARDS) return void res.status(400).json({ error: `Automate at most ${MAX_AUTOMATED_BOARDS} boards.` });

    const allowedBoards = config.monday.allowedBoardIds;
    const checked: Record<string, MondayBoardAutomation> = {};
    const client = token ? new MondayClient(token) : undefined;
    for (const [id, value] of adding) {
      const fail = (error: string) => void res.status(400).json({ error });
      if (allowedBoards.length > 0 && !allowedBoards.includes(id)) {
        return fail(`Board ${id} is not one of the boards ${name} may use. Add it under Boards first.`);
      }
      const auto = MondayBoardAutomationSchema.parse(value);
      if (!hasGitHub(config)) return fail("Connect GitHub first: tickets become repo tasks that open pull requests.");
      if (!connectionForRepo(config, auto.repo)) {
        return fail(`No GitHub connection may work on ${auto.repo}. Allowed owners and repositories: ${describeAllowed(config)}.`);
      }
      const conflict = labelConflict(auto);
      if (conflict) return fail(`Board ${id}: ${conflict}`);
      if (process.env.SKIP_VALIDATION === "1" || !client) {
        checked[id] = auto;
        continue;
      }
      let board;
      try {
        board = await client.getBoard(id);
      } catch (err) {
        return fail(`Couldn't read board ${id} from monday.com: ${err instanceof MondayError ? err.message : "the request failed."}`);
      }
      const result = checkBoardAutomation(board, auto);
      if (!result.ok) return fail(result.error);
      checked[id] = result.automation;
    }

    const updated = await configRepo.update((c) => {
      for (const [id, value] of changes) {
        if (value === null) delete c.monday.automation.boards[id];
        else c.monday.automation.boards[id] = checked[id]!;
      }
      if (input.enabled !== undefined) c.monday.automation.enabled = input.enabled;
    });
    for (const [id] of changes.filter(([, value]) => value === null)) await removeWebhook({ store, client }, id);
    await rememberConsoleUrl(store, baseUrl(req));
    res.json({ ok: true, automation: publicView(updated).monday.automation });
  });

  // Creates the webhook on every automated board (the secret is made on first use).
  app.post("/api/monday/automation/webhook", requireAdmin, async (req, res) => {
    let config = await configRepo.load(true);
    const token = config.monday.token;
    if (!token) return void res.status(400).json({ error: "Connect monday.com with an API token first." });
    if (!config.monday.automation.enabled) {
      return void res.status(400).json({
        error: "Turn the automation on first: monday.com checks the webhook's address when it is created, and the address answers only while the automation is on.",
      });
    }
    if (Object.keys(config.monday.automation.boards).length === 0) return void res.status(400).json({ error: "Add a board first." });
    if (!config.monday.automation.webhookSecret) {
      config = await configRepo.update((c) => {
        c.monday.automation.webhookSecret ??= randomToken(32);
      });
    }
    const secret = config.monday.automation.webhookSecret!;
    const base = baseUrl(req);
    const url = `${base}/monday/webhook/${secret}`;
    await rememberConsoleUrl(store, base);
    if (url.length > 255) {
      return void res.status(400).json({ error: "The webhook address is longer than the 255 characters monday.com accepts. Set PUBLIC_URL to a shorter address." });
    }
    const redact = makeRedactor([...configSecrets(config), secret]);
    const result = await connectWebhooks({ store, client: new MondayClient(token), redact }, config.monday.automation.boards, url);
    res.json({ ok: result.failed.length === 0, url, ...result, ...(result.failed.length ? { manualSteps: manualWebhookSteps(url) } : {}) });
  });

  // A board's status columns and their labels, for the automation's pickers.
  app.get("/api/monday/columns", requireAdmin, async (req, res) => {
    const config = await configRepo.load(true);
    const token = config.monday.token;
    if (!token) return void res.status(400).json({ error: "monday.com is not connected." });
    const id = BOARD_ID.safeParse(typeof req.query.boardId === "string" ? req.query.boardId.trim() : "");
    if (!id.success) return void res.status(400).json({ error: "Board ids are numbers, like 1234567890." });
    const allowedBoards = config.monday.allowedBoardIds;
    if (allowedBoards.length > 0 && !allowedBoards.includes(id.data)) {
      return void res.status(400).json({ error: `Board ${id.data} is not one of the boards ${config.team.pointer.name} may use.` });
    }
    try {
      const board = await new MondayClient(token).getBoard(id.data);
      res.json({ board: { id: board.id, name: board.name }, columns: statusColumns(board) });
    } catch (err) {
      res.status(400).json({ error: err instanceof MondayError ? err.message : "monday.com request failed." });
    }
  });

  // ---------- UI ----------
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url)), { index: "index.html" }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[server] unhandled error:", err);
    res.status(500).json({ error: "Something went wrong on the server." });
  });

  return { app, runner, store, conversations, automation };
}

/** The stored key of a repo's setup: repo names are compared without letter case. */
function repoSetupKey(setups: Record<string, RepoSetup>, repo: string): string | undefined {
  const wanted = repo.toLowerCase();
  return Object.keys(setups).find((k) => k.toLowerCase() === wanted);
}

/** The first issue as one line. An agent's issue names the agent, so the page can show where it is. */
function teamError(error: z.ZodError, input: unknown): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid team.";
  const [section, index] = issue.path;
  if (section !== "agents" || typeof index !== "number") return issue.message;
  const id = agentIdAt(input, index);
  return `Agent ${id ? `"${id}"` : `#${index + 1}`}: ${issue.message}`;
}

function agentIdAt(input: unknown, index: number): string | undefined {
  const agents = typeof input === "object" && input !== null ? (input as { agents?: unknown }).agents : undefined;
  const agent: unknown = Array.isArray(agents) ? agents[index] : undefined;
  const id = typeof agent === "object" && agent !== null ? (agent as { id?: unknown }).id : undefined;
  return typeof id === "string" && id ? id.slice(0, 40) : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 8080);
  const { app, runner, store } = await createApp();
  app.listen(port, () => {
    console.log(`[server] Agent Army listening on :${port} (runner=${runner.kind}, storage=${store.describe()})`);
  });
}
