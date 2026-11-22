import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AttachmentRepo } from "./chat/attachments.js";
import { Spending, parseCapKeys } from "./spending/budget.js";
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
} from "./core/config.js";
import { hashPassword, randomToken, safeEqual, sessionKey, signSession, verifyPassword, verifySession } from "./core/crypto.js";
import { repoAccessError } from "./integrations/code-hosts/code-host-access.js";
import { GITHUB_REPO_RE, REPO_FORMAT_HINT, REPO_ID_MAX, isRepoId } from "./integrations/code-hosts/repo-id.js";
import { CONVERSATION_ID_RE, ConversationService, MAX_FILES_PER_MESSAGE, MESSAGE_MAX_CHARS, type WebThreads } from "./chat/conversations.js";
import { handleSlackEvent, withBrainSlot } from "./slack/dispatch.js";
import { HrService, PROPOSAL_ID_RE, REVIEW_ID_RE } from "./team/hr.js";
import { RecentSet } from "./slack/listen.js";
import { MEMORY_MAX_FACTS, MemoryRepo } from "./chat/memory.js";
import { MondayClient, MondayError, checkMonday, statusColumns } from "./integrations/monday/monday.js";
import {
  TicketAutomation,
  checkBoardAutomation,
  connectWebhooks,
  labelConflict,
  manualWebhookSteps,
  removeWebhook,
  webhookChallenge,
  webhookIds,
} from "./integrations/monday/monday-automation.js";
import { NOTES_MAX_CHARS, NotesRepo } from "./chat/notes.js";
import { LessonsRepo } from "./team/lessons.js";
import { loadOffice } from "./team/office.js";
import { type QueryFn, createPointerBrain } from "./chat/pointer.js";
import type { PointerBrain, SlackDeps, SlackMessageEvent } from "./chat/pointer-types.js";
import { type Runner, createRunner, parallelCap, parallelCapNote, parallelLimit } from "./tasks/runner.js";
import { SCREENSHOT_NAME_RE, ScreenshotRepo, TASK_ID_RE, screenshotType } from "./tasks/screenshots.js";
import { SCOUT_NEED_MAX_CHARS, findSkills } from "./skills/skill-scout.js";
import { type FetchLike, SKILL_LIMITS, SkillLibrary, SkillsPluginCache, skillView } from "./skills/skills.js";
import { buildManifest, manifestCreateUrl, slackClient, verifySlackSignature } from "./slack/slack.js";
import { createStore } from "./core/store.js";
import { detectPublicUrl, publicUrlWarning } from "./core/public-url.js";
import { readTimeline } from "./tasks/task-events.js";
import { TaskRepo } from "./tasks/tasks.js";
import { SKILL_NAME_RE, TeamSchema } from "./team/team.js";
import { rememberConsoleUrl } from "./integrations/tickets/ticket-sync.js";
import { checkAnthropic, checkGithub, checkSlack } from "./core/validate.js";
import { UsageRepo } from "./spending/usage.js";
import { handleGithubWebhook, parseGithubPayload, verifyGithubSignature } from "./integrations/code-hosts/webhook.js";
import { configSecrets, makeRedactor } from "./tasks/worker.js";
import { removeStaleCredentialFolders } from "./ai/ai-providers.js";
import { drain, exitLikeSignal } from "./core/shutdown.js";
import { WorkerPids, markInterruptedTasks, removeStaleWorkFolders, staleWorkFolderAgeMs, workFolderDirs } from "./tasks/restart.js";
import { aiRoutes } from "./routes/ai.js";
import { dataSourcesRoutes } from "./routes/data-sources.js";
import { emailRoutes } from "./routes/email.js";
import { routinesRoutes } from "./routes/routines.js";
import { normalizeTimeZone } from "./routines/cron.js";
import { registerRoutineService } from "./routines/routines.js";
import { consoleThreads } from "./routines/runner.js";
import { RoutineService } from "./routines/service.js";
import { appsRoutes } from "./routes/apps.js";
import { bitbucketRoutes } from "./routes/bitbucket.js";
import { chatRoutes } from "./routes/chat.js";
import { enginesRoutes } from "./routes/engines.js";
import { gitlabRoutes } from "./routes/gitlab.js";
import { jiraRoutes } from "./routes/jira.js";
import { lessonsRoutes } from "./routes/lessons.js";
import { miroRoutes } from "./routes/miro.js";
import type { IntegrationRouteDeps } from "./routes/types.js";

const SESSION_COOKIE = "army_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const BOARD_ID = z.string().max(20).regex(/^\d+$/, "Board ids are numbers, like 1234567890.");

/** A GitHub allow list: owners ("your-org") or exact GitHub repos ("someone/some-repo"), deduplicated. */
const OWNER_RE = /^[A-Za-z0-9-]+$/;
const ALLOW_LIST = z
  .array(
    z
      .string()
      .trim()
      .max(200)
      .refine((s) => OWNER_RE.test(s) || GITHUB_REPO_RE.test(s), "Allowed entries are owners (your-org) or exact repos (owner/repo)."),
  )
  .max(50, "Allow at most 50 owners or repos.")
  .transform((xs) => [...new Set(xs)]);
const CONNECTION_ID = z.string().max(40).regex(/^gh-[0-9a-f]{6,}$/, "Connection ids look like gh-1a2b3c.");
const MAX_EXTRA_GITHUB = 10;
const CI_WAIT_ERROR = "The wait for checks is a whole number of minutes from 0 to 60.";
const CI_FIX_ERROR = "Fix rounds are a whole number from 0 to 5.";
const PREVIEW_CHECK_ERROR = 'The preview check is "off", "visible" or "always".';
const CAP_ERROR = "Caps are amounts in USD from 0 (no cap) to 100,000.";
const ALERT_PERCENT_ERROR = "The alert level is a whole percent from 10 to 100.";
const TIMEZONE_ERROR = "Choose a timezone from the list: an IANA name such as Europe/London, America/New_York or UTC.";
const CAP_USD = z.number(CAP_ERROR).min(0, CAP_ERROR).max(100_000, CAP_ERROR);
/** Repositories with their own monthly cap; more is not a useful setting. */
const MAX_REPO_CAPS = 200;
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
/** A repository on any code host: owner/repo (GitHub), gitlab:group/project or bitbucket:workspace/repo. */
const REPO_INPUT = z.string().trim().max(REPO_ID_MAX, REPO_FORMAT_HINT).regex(REPO_RE, REPO_FORMAT_HINT);
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
  /** The Agent SDK's query for HR reviews (see hr.ts). */
  hrQuery?: QueryFn;
  /** The skills library's GitHub reads and the Skills Scout's query. */
  skills?: { fetch?: FetchLike; scoutQuery?: QueryFn };
  /** This instance's memory in bytes, instead of the container's or machine's (the parallel-task cap). */
  memoryBytes?: number;
}

/** A skill's assignment: every agent, or the listed agent ids. */
const SKILL_ASSIGNMENT = z.union(
  [z.literal("all"), z.array(z.string().max(40)).max(30, "A team has at most 30 agents.").transform((ids) => [...new Set(ids)])],
  { error: 'Assign a skill to "all" or to a list of agent ids.' },
);
/** A skill to preview or install: a GitHub folder or a pasted SKILL.md. */
const SKILL_INPUT = z
  .object({
    url: z.string().trim().max(500, "That address is too long.").optional(),
    skillMd: z.string().max(SKILL_LIMITS.maxPastedBytes, `A pasted SKILL.md may be at most ${SKILL_LIMITS.maxPastedBytes / 1024} KB.`).optional(),
    assignedTo: SKILL_ASSIGNMENT.optional(),
  })
  .refine((x) => Boolean(x.url) !== Boolean(x.skillMd?.trim()), "Give the GitHub address of a skill's folder, or paste a SKILL.md.");

export async function createApp(env: NodeJS.ProcessEnv = process.env, overrides: AppOverrides = {}) {
  const store = createStore(env);
  const masterKey = await resolveMasterKey(store, env);
  const configRepo = new ConfigRepo(store, masterKey);
  const tasks = new TaskRepo(store);
  const memory = new MemoryRepo(store, masterKey);
  const notes = new NotesRepo(store, masterKey);
  const lessons = new LessonsRepo(store, masterKey);
  const attachments = new AttachmentRepo(store, masterKey);
  const screenshots = new ScreenshotRepo(store, masterKey);

  // The skills library; Pointer's chat loads it as a plugin built in this service's temp dir.
  const skills = new SkillLibrary(store, masterKey, { configRepo, ...(overrides.skills?.fetch ? { fetch: overrides.skills.fetch } : {}) });
  const skillsPlugin = new SkillsPluginCache(skills);

  // Tasks at the same time: the Settings value, capped for the local runner by MAX_PARALLEL or this instance's memory.
  let maxParallel = (await configRepo.load()).limits.maxParallel;
  const cap = parallelCap(env, overrides.memoryBytes);
  const runner = overrides.runner ?? createRunner(() => parallelLimit(maxParallel, cap).effective, env);
  const brain = overrides.brain ?? createPointerBrain({ configRepo, memory, notes, lessons, attachments }, { skills: () => skillsPlugin.current() });
  const usage = new UsageRepo(store, tasks);
  const slackFactory = overrides.slack ?? slackClient;
  // Spending caps for every start path (Slack, console, GitHub reviews) and chat; alerts in Slack.
  const spending = new Spending({ store, usage, config: () => configRepo.load(), slack: slackFactory });
  // Console conversations: answered by the same brain, within the same limit as Slack answers.
  const conversations = new ConversationService({ store, configRepo, tasks, runner, brain, usage, spending, brainSlot: withBrainSlot, attachments });
  // Routines: Pointer's scheduled work, run by the same brain (read-only), within the same caps and concurrency limit.
  const routines = new RoutineService({
    configRepo,
    store,
    masterKey,
    brain,
    usage,
    spending,
    threads: consoleThreads(conversations),
    slack: slackFactory,
    brainSlot: withBrainSlot,
  });
  registerRoutineService(configRepo, routines);
  const slackDeps: SlackDeps & { web: WebThreads; spending: Spending } = {
    configRepo,
    tasks,
    runner,
    memory,
    attachments,
    usage,
    brain,
    slack: slackFactory,
    web: conversations,
    spending,
  };

  // The setup token creates the admin account on first run and resets its
  // password later: only someone who can read the deployment's secrets (the
  // deploy output, Secret Manager) or its log can use it. An empty or blank
  // SETUP_TOKEN (Docker Compose passes "" for a variable left empty in .env) is
  // no token: one is generated, so an empty token can never be the right one.
  const configuredToken = env.SETUP_TOKEN?.trim();
  const setupToken = configuredToken || randomToken(18);
  /** The submitted setup token is the deployment's. An empty one never is, whatever the deployment's is. */
  const isSetupToken = (given: string) => {
    const token = given.trim();
    return token.length > 0 && setupToken.length > 0 && safeEqual(token, setupToken);
  };
  if (!configuredToken) {
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

  // Stopping (SIGTERM, see the end of this file): while the requests in flight finish, new ones are refused,
  // so the platform sends them to the next instance, and the local runner starts no more workers.
  let stopping = false;
  app.use((_req, res, next) => {
    if (!stopping) return next();
    res.setHeader("Connection", "close");
    res.setHeader("Retry-After", "10");
    res.status(503).json({ error: "The server is restarting. Try again in a moment." });
  });
  const stopAcceptingWork = () => {
    stopping = true;
    runner.stop?.();
  };

  // PUBLIC_URL, else the platform's own address (Render, Railway, Fly.io…), else each request's (public-url.ts).
  // An empty PUBLIC_URL is unset; one that is not an http(s) address without a path is ignored, with a warning.
  const publicUrl = detectPublicUrl(env);
  const publicUrlProblem = publicUrlWarning(env);
  if (publicUrlProblem) console.warn(`[server] ${publicUrlProblem}`);
  const baseUrl = (req: Request) => (publicUrl ?? `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");

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
  // A pasted SKILL.md can be up to 256 KB.
  app.use("/api/skills", express.json({ limit: "600kb" }));
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
            parallel: parallelLimit(config.limits.maxParallel, runner.kind === "local" ? cap : undefined),
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
    if (!isSetupToken(input.setupToken)) {
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
    if (!isSetupToken(input.setupToken)) {
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
        bindings: z.record(z.string().regex(CHANNEL_RE, "Channel IDs look like C012ABCDEF"), REPO_INPUT).optional(),
        pointerChannels: z.array(z.string().regex(CHANNEL_RE, "Channel IDs look like C012ABCDEF")).max(100).optional(),
        /** The organisation's IANA timezone: the default for routines. */
        timezone: z
          .string()
          .max(64, TIMEZONE_ERROR)
          .refine((tz) => normalizeTimeZone(tz) !== undefined, TIMEZONE_ERROR)
          .optional(),
        limits: z
          .object({
            maxTurns: z.number(),
            maxBudgetUsd: z.number(),
            maxParallel: z.number(),
            progressEveryMin: z.number(),
            ciWaitMin: z.number().int(CI_WAIT_ERROR).min(0, CI_WAIT_ERROR).max(60, CI_WAIT_ERROR),
            ciFixRounds: z.number().int(CI_FIX_ERROR).min(0, CI_FIX_ERROR).max(5, CI_FIX_ERROR),
            previewCheck: z.enum(["off", "visible", "always"], PREVIEW_CHECK_ERROR),
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
        if (input.timezone !== undefined) c.timezone = normalizeTimeZone(input.timezone) ?? c.timezone;
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

  // The virtual office: everyone on the team, free or busy, and what they are doing now (see office.ts).
  // `tz` is the browser's Date#getTimezoneOffset(), so "today" starts at the owner's midnight.
  app.get("/api/office", requireAdmin, async (req, res) => {
    const tz = Number(req.query.tz ?? 0);
    const tzOffsetMin = Number.isInteger(tz) && Math.abs(tz) <= 14 * 60 ? tz : 0;
    const config = await configRepo.load();
    res.json(await loadOffice({ store, tasks, conversations, team: config.team }, { tzOffsetMin }));
  });

  // ---------- Chat: conversations with Pointer from the console ----------
  // Pointer answers in the background (202); the page polls the conversation.
  // Files and voice messages are uploaded first (src/routes/chat.ts), then sent by id with a message.
  const MESSAGE_BODY = z.object({
    text: z.string().trim().max(MESSAGE_MAX_CHARS, `Messages are limited to ${MESSAGE_MAX_CHARS} characters.`).default(""),
    attachmentIds: z
      .array(z.string().max(20).regex(/^a-[0-9a-f]{8}$/, "A file you attached is no longer here. Remove it and attach it again."))
      .max(MAX_FILES_PER_MESSAGE, `A message can carry ${MAX_FILES_PER_MESSAGE} files.`)
      .default([]),
  });
  const hasContent = (m: { text: string; attachmentIds: string[] }) => m.text !== "" || m.attachmentIds.length > 0;
  const MESSAGE_TEXT = MESSAGE_BODY.refine(hasContent, "Write a message first.");
  /** POST /api/conversations: with files, the draft id their upload answered. */
  const FIRST_MESSAGE = MESSAGE_BODY.extend({
    conversationId: z.string().max(40).regex(CONVERSATION_ID_RE, "The files you attached are no longer waiting here. Attach them again.").optional(),
  }).refine(hasContent, "Write a message first.");
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
    const input = body(FIRST_MESSAGE, req, res);
    if (!input) return;
    const result = await conversations.create(input.text, {
      attachmentIds: input.attachmentIds,
      ...(input.conversationId ? { draftId: input.conversationId } : {}),
    });
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
    const result = await conversations.send(id, input.text, { attachmentIds: input.attachmentIds });
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

  // Claude spend this calendar month (UTC): chat replies and repo tasks, with the caps and their alerts.
  app.get("/api/usage", requireAdmin, async (_req, res) => {
    res.json(await spending.view());
  });

  // Spending caps. Fields left out are kept; perRepoUsd replaces the whole list (0 or a missing repo = no cap).
  app.post("/api/budget", requireAdmin, async (req, res) => {
    const input = body(
      z.object({
        monthlyUsd: CAP_USD.optional(),
        // Keys are checked below: a record's key error has no readable message.
        perRepoUsd: z
          .record(z.string(), CAP_USD)
          .refine((caps) => Object.keys(caps).length <= MAX_REPO_CAPS, `At most ${MAX_REPO_CAPS} repositories can have their own cap.`)
          .optional(),
        alertPercent: z.number(ALERT_PERCENT_ERROR).int(ALERT_PERCENT_ERROR).min(10, ALERT_PERCENT_ERROR).max(100, ALERT_PERCENT_ERROR).optional(),
        alertChannel: z
          .string()
          .trim()
          .refine((c) => c === "" || CHANNEL_RE.test(c), "Channel IDs look like C012ABCDEF.")
          .optional(),
        // Per agent ("pointer" = Pointer itself), per AI provider or engine, and per agent in one task: each replaces its whole list.
        perAgentUsd: z.record(z.string(), CAP_USD).optional(),
        perProviderUsd: z.record(z.string(), CAP_USD).optional(),
        perTaskAgentUsd: z.record(z.string(), CAP_USD).optional(),
      }),
      req,
      res,
    );
    if (!input) return;
    const agentIds = (await configRepo.load()).team.agents.map((a) => a.id);
    const caps: Partial<Record<"perAgentUsd" | "perProviderUsd" | "perTaskAgentUsd", Record<string, number>>> = {};
    for (const [field, what] of [["perAgentUsd", "agent"], ["perProviderUsd", "provider"], ["perTaskAgentUsd", "task"]] as const) {
      const given = input[field];
      if (!given) continue;
      const parsed = parseCapKeys(given, { what, agentIds });
      if (!parsed.ok) return void res.status(400).json({ error: parsed.error });
      caps[field] = parsed.caps;
    }
    let perRepoUsd: Record<string, number> | undefined;
    if (input.perRepoUsd) {
      perRepoUsd = {};
      const seen = new Set<string>();
      for (const [repo, cap] of Object.entries(input.perRepoUsd)) {
        if (!isRepoId(repo)) return void res.status(400).json({ error: REPO_FORMAT_HINT });
        const key = repo.toLowerCase();
        if (seen.has(key)) return void res.status(400).json({ error: `${repo} is listed twice.` });
        seen.add(key);
        if (cap > 0) perRepoUsd[repo] = cap;
      }
    }
    const updated = await configRepo.update((c) => {
      if (input.monthlyUsd !== undefined) c.budget.monthlyUsd = input.monthlyUsd;
      if (perRepoUsd) c.budget.perRepoUsd = perRepoUsd;
      if (input.alertPercent !== undefined) c.budget.alertPercent = input.alertPercent;
      if (input.alertChannel !== undefined) c.budget.alertChannel = input.alertChannel;
      Object.assign(c.budget, caps);
    });
    // A lower cap may already be reached: tell the alert channel now, not after the next task.
    void spending.notify();
    res.json({ ok: true, budget: publicView(updated).budget });
  });

  app.post("/api/team", requireAdmin, async (req, res) => {
    const parsed = TeamSchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: teamError(parsed.error, req.body) });
    await configRepo.update((c) => {
      c.team = parsed.data;
    });
    res.json({ ok: true });
  });

  // ---------- HR: reviews of the team, with proposals the owner applies or dismisses (see hr.ts) ----------
  const hr = new HrService({
    store,
    tasks,
    usage,
    spending,
    config: () => configRepo.load(true),
    updateConfig: (mutate) => configRepo.update(mutate),
    // The installed skills, from the library's own index (not guessed from store keys).
    skills: async () => (await skills.list()).map((s) => ({ name: s.name, description: s.description })),
    queryFn: overrides.hrQuery,
  });
  const HR_PROPOSAL_PARAMS = z.object({
    id: z.string().regex(REVIEW_ID_RE, "Review not found."),
    pid: z.string().regex(PROPOSAL_ID_RE, "Proposal not found."),
  });
  const proposalParams = (req: Request, res: Response) => {
    const parsed = HR_PROPOSAL_PARAMS.safeParse(req.params);
    if (parsed.success) return parsed.data;
    res.status(404).json({ error: parsed.error.issues[0]?.message ?? "Not found." });
    return undefined;
  };

  // One model call (about a minute); refused when the monthly cap is used up. The cost is counted with chat.
  app.post("/api/hr/review", requireAdmin, async (_req, res) => {
    const result = await hr.review();
    if (!result.ok) {
      return void res.status(result.status).json({ error: result.error, ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}) });
    }
    res.json({ review: result.review });
  });

  app.get("/api/hr/reviews", requireAdmin, async (_req, res) => {
    res.json({ reviews: await hr.list() });
  });

  app.post("/api/hr/reviews/:id/proposals/:pid/apply", requireAdmin, async (req, res) => {
    const params = proposalParams(req, res);
    if (!params) return;
    const result = await hr.apply(params.id, params.pid);
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.json(result);
  });

  app.post("/api/hr/reviews/:id/proposals/:pid/dismiss", requireAdmin, async (req, res) => {
    const params = proposalParams(req, res);
    if (!params) return;
    const result = await hr.dismiss(params.id, params.pid);
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.json(result);
  });

  // The Team page's "Add HR to the team": the default team's HR agent.
  app.post("/api/hr/agent", requireAdmin, async (_req, res) => {
    const result = await hr.addHr();
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.json(result);
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

  const sendNotes = async (repo: string, res: Response) => {
    if (!isRepoId(repo)) return void res.status(400).json({ error: REPO_FORMAT_HINT });
    const found = await notes.get(repo);
    if (!found) return void res.status(404).json({ error: `No notes for ${repo} yet.` });
    res.json({ repo: found.repo, text: found.text, updatedAt: found.updatedAt });
  };

  // Any repository id, in the query: /api/notes/repo?repo=gitlab:group/sub/project.
  // One path segment, so it never meets /:owner/:repo below.
  app.get("/api/notes/repo", requireAdmin, async (req, res) => {
    const repo = z.string().trim().max(REPO_ID_MAX).safeParse(req.query.repo);
    await sendNotes(repo.success ? repo.data : "", res);
  });

  // GitHub's owner/repo in the path, as before.
  app.get("/api/notes/:owner/:repo", requireAdmin, async (req, res) => {
    await sendNotes(`${req.params.owner}/${req.params.repo}`, res);
  });

  // Empty text deletes the notes. NotesRepo checks the repo and the length.
  app.post("/api/notes", requireAdmin, async (req, res) => {
    const input = body(z.object({ repo: z.string().max(REPO_ID_MAX), text: z.string() }), req, res);
    if (!input) return;
    const saved = await notes.put(input.repo.trim(), input.text);
    if (!saved.ok) return void res.status(400).json({ error: saved.error });
    res.json({ ok: true });
  });

  // ---------- Skills library and the Skills Scout ----------
  const skillName = (req: Request, res: Response): string | undefined => {
    const name = String(req.params.name ?? "");
    if (SKILL_NAME_RE.test(name)) return name;
    res.status(400).json({ error: "Skill names use lowercase letters, digits and dashes." });
    return undefined;
  };
  const skillInput = (input: z.infer<typeof SKILL_INPUT>) => (input.url ? { url: input.url } : { skillMd: input.skillMd ?? "" });

  app.get("/api/skills", requireAdmin, async (_req, res) => {
    const [list, config] = await Promise.all([skills.list(true), configRepo.load()]);
    res.json({ skills: list.map((s) => skillView(s, config.team)), limits: SKILL_LIMITS });
  });

  // What an install would add (files, frontmatter, scripts, licence, problems); installs nothing.
  app.post("/api/skills/preview", requireAdmin, async (req, res) => {
    const input = body(SKILL_INPUT, req, res);
    if (!input) return;
    const result = await skills.preview(skillInput(input), await configRepo.load(true));
    if (!result.ok) return void res.status(400).json({ error: result.error });
    res.json({ preview: result.preview });
  });

  app.post("/api/skills/install", requireAdmin, async (req, res) => {
    const input = body(SKILL_INPUT, req, res);
    if (!input) return;
    const result = await skills.install(skillInput(input), await configRepo.load(true), input.assignedTo);
    if (!result.ok) return void res.status(400).json({ error: result.error });
    res.json({ ok: true, skill: skillView(result.skill, (await configRepo.load(true)).team) });
  });

  // Search the web for skills that fit a need (one Claude query, read-only tools, the monthly cap applies).
  app.post("/api/skills/find", requireAdmin, async (req, res) => {
    const input = body(
      z.object({
        need: z
          .string()
          .trim()
          .min(3, "Describe what the team needs a skill for.")
          .max(SCOUT_NEED_MAX_CHARS, `Describe the need in at most ${SCOUT_NEED_MAX_CHARS} characters.`),
      }),
      req,
      res,
    );
    if (!input) return;
    const [config, installed] = await Promise.all([configRepo.load(true), skills.list()]);
    const result = await findSkills(input.need, {
      config,
      spending,
      usage,
      installed: installed.map((s) => s.name),
      ...(overrides.skills?.scoutQuery ? { queryFn: overrides.skills.scoutQuery } : {}),
    });
    if (!result.ok) return void res.status(result.status).json({ error: result.error });
    res.json({ candidates: result.candidates, ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}) });
  });

  app.get("/api/skills/:name", requireAdmin, async (req, res) => {
    const name = skillName(req, res);
    if (!name) return;
    const meta = await skills.get(name);
    const text = meta && (await skills.skillMd(name));
    if (!meta || text === undefined) return void res.status(404).json({ error: `No skill named ${name} is installed.` });
    res.json({ skill: skillView(meta, (await configRepo.load()).team), skillMd: text });
  });

  app.post("/api/skills/:name/assign", requireAdmin, async (req, res) => {
    const name = skillName(req, res);
    if (!name) return;
    const input = body(z.object({ assignedTo: SKILL_ASSIGNMENT }), req, res);
    if (!input) return;
    if (!(await skills.get(name))) return void res.status(404).json({ error: `No skill named ${name} is installed.` });
    const result = await skills.assign(name, input.assignedTo);
    if (!result.ok) return void res.status(400).json({ error: result.error });
    res.json({ ok: true, skill: skillView(result.skill, (await configRepo.load(true)).team) });
  });

  app.post("/api/skills/:name/delete", requireAdmin, async (req, res) => {
    const name = skillName(req, res);
    if (!name) return;
    if (!(await skills.remove(name))) return void res.status(404).json({ error: `No skill named ${name} is installed.` });
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
      {
        const denied = repoAccessError(config, auto.repo);
        if (denied) return fail(denied);
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
  // ---------- More integrations: each one's admin routes and webhook (src/routes/) ----------
  const routeDeps: IntegrationRouteDeps = {
    configRepo,
    store,
    tasks,
    masterKey,
    requireAdmin,
    throttle,
    baseUrl,
    startDirectTask: (repo, instruction, opts) => conversations.startDirectTask(repo, instruction, opts),
    webhookDeps: { ...slackDeps, store },
  };
  app.use(gitlabRoutes(routeDeps));
  app.use(bitbucketRoutes(routeDeps));
  app.use(jiraRoutes(routeDeps));
  app.use(miroRoutes(routeDeps));
  app.use(appsRoutes(routeDeps));
  app.use(enginesRoutes(routeDeps));
  app.use(aiRoutes(routeDeps));
  app.use(emailRoutes(routeDeps));
  app.use(dataSourcesRoutes(routeDeps));
  // The Routines page's API, and POST /routines/tick for external schedulers (outside /api: its own secret header, no session).
  app.use(routinesRoutes({ ...routeDeps, routines }));
  app.use(chatRoutes({ ...routeDeps, conversations }));
  app.use(lessonsRoutes({ ...routeDeps, lessons }));

  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url)), { index: "index.html" }));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[server] unhandled error:", err);
    res.status(500).json({ error: "Something went wrong on the server." });
  });

  return { app, runner, store, conversations, automation, routines, stopAcceptingWork };
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
  void removeStaleCredentialFolders(); // Google key files left by processes that died (ai-providers.ts)
  // Checkouts of workers killed with an earlier process (older than the job's deadline: no worker runs longer).
  void removeStaleWorkFolders({ dirs: workFolderDirs(process.env), maxAgeMs: staleWorkFolderAgeMs(process.env) });
  const port = Number(process.env.PORT ?? 8080);
  const { app, runner, store, routines, stopAcceptingWork } = await createApp();
  // The local runner's workers stopped with the earlier process: their tasks are marked failed before anything
  // new starts. Cloud Run job tasks go on across a restart of this service.
  if (runner.kind === "local") {
    const workers = new WorkerPids();
    await markInterruptedTasks({ tasks: new TaskRepo(store), store, runner: runner.kind, workers });
    workers.sweep();
  }
  const server = app.listen(port, () => {
    console.log(`[server] Agent Army listening on :${port} (runner=${runner.kind}, storage=${store.describe()})`);
    const capNote = runner.kind === "local" ? parallelCapNote(parallelCap(process.env), process.env) : undefined;
    if (capNote) console.log(capNote);
    // Routines' clock: a tick every minute; the lease keeps overlapping instances from both running them.
    routines.scheduler.start();
  });
  // A redeploy stops this instance: stop taking work (new requests get 503, no more workers or routine ticks),
  // let the requests in flight finish (at most SHUTDOWN_GRACE_MS), give the routines' lease up (at most 3 s) so
  // the new instance takes over at once, then end as the signal would have (see exitLikeSignal).
  const shutdown = (signal: NodeJS.Signals) => {
    console.log(`[server] ${signal}: finishing the requests in flight, then stopping`);
    void drain({ server, stopAccepting: stopAcceptingWork, finish: [{ run: () => routines.scheduler.stop(), timeoutMs: 3_000 }] }).finally(() =>
      exitLikeSignal(signal),
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
