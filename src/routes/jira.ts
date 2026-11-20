/**
 * Jira admin routes (/api/jira/…): connect or update (site, email, API
 * token, default and allowed projects, Confluence), disconnect, the projects
 * and a project's statuses for the pickers, the issue automation and its
 * webhook; and the webhook itself (POST /jira/webhook/<secret>), which starts
 * repo tasks from issues moved to a project's start status.
 */
import express, { type Request, type Response, Router } from "express";
import { z } from "zod";
import { type Config, JIRA_KEY_RE, type JiraProjectAutomation, JiraProjectAutomationSchema, REPO_RE, publicView } from "../core/config.js";
import { randomToken, safeEqual } from "../core/crypto.js";
import { repoAccessError } from "../integrations/code-hosts/code-host-access.js";
import { JiraError, checkJira, jiraClientFor } from "../integrations/jira/jira.js";
import {
  JiraAutomation,
  checkProjectAutomation,
  connectJiraWebhook,
  deliveryIssue,
  manualJiraWebhookSteps,
  statusConflict,
  verifyJiraSignature,
  webhookJql,
} from "../integrations/jira/jira-automation.js";
import { RecentSet } from "../slack/listen.js";
import { REPO_FORMAT_HINT } from "../integrations/code-hosts/repo-id.js";
import { rememberConsoleUrl } from "../integrations/tickets/ticket-sync.js";
import { configSecrets, makeRedactor } from "../worker.js";
import type { IntegrationRouteDeps } from "./types.js";

const PROJECT_KEY = z.string().trim().toUpperCase().max(50).regex(JIRA_KEY_RE, "Project keys look like ACME: capital letters, digits or _, starting with a letter.");
const EMAIL = z.string().trim().max(200).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Enter the email of the Atlassian account the API token belongs to.");
const MAX_ALLOWED_PROJECTS = 200;
const MAX_AUTOMATED_PROJECTS = 50;
const SITE_ERROR = "The site address looks like https://your-site.atlassian.net.";

const SAVE = z.object({
  siteUrl: z.string().max(300).optional(),
  email: EMAIL.optional(),
  token: z.string().max(4000).optional(),
  /** "" clears the default project. */
  defaultProjectKey: z.union([z.literal(""), PROJECT_KEY]).optional(),
  allowedProjectKeys: z.array(PROJECT_KEY).max(MAX_ALLOWED_PROJECTS, `Allow at most ${MAX_ALLOWED_PROJECTS} projects.`).optional(),
  confluence: z.boolean().optional(),
});

/** A project's issue automation as the admin page sends it; statuses left out get the defaults (JiraProjectAutomationSchema). */
const STATUS_INPUT = (what: string) => z.string().trim().max(100, `The ${what} status is at most 100 characters.`).optional();
const PROJECT_AUTOMATION_INPUT = z.object({
  repo: z.string().trim().max(300).regex(REPO_RE, REPO_FORMAT_HINT),
  startStatus: z.string().trim().min(1, "Choose the status that starts a task.").max(100, "The start status is at most 100 characters."),
  workingStatus: STATUS_INPUT("working"),
  reviewStatus: STATUS_INPUT("in review"),
  doneStatus: STATUS_INPUT("done"),
  stuckStatus: STATUS_INPUT("stuck"),
});

/**
 * A Jira Cloud site's address from what was typed ("acme.atlassian.net", a
 * link to any page on it): https and the host only. Undefined for anything
 * else, including IP addresses and local names.
 */
export function normalizeSiteUrl(input: string): string | undefined {
  let s = input.trim();
  if (!s) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || /^[\d.]+$/.test(host)) return undefined;
  return `https://${host}`;
}

const notConnected = (res: Response) => void res.status(400).json({ error: "Jira is not connected." });
/** JiraClient errors are already redacted and readable; anything else is reported generically. */
const jiraFailure = (res: Response, err: unknown) => void res.status(400).json({ error: err instanceof JiraError ? err.message : "Jira request failed." });

export function jiraRoutes(deps: IntegrationRouteDeps): Router {
  const { configRepo, store, requireAdmin, baseUrl } = deps;
  const router = Router();
  const automation = new JiraAutomation({ configRepo, tasks: deps.tasks, startTask: (repo, instruction, opts) => deps.startDirectTask(repo, instruction, opts) });
  const seenDeliveries = new RecentSet(2000);
  const allowedError = (config: Config, key: string): string | undefined => {
    const allowed = config.jira.allowedProjectKeys;
    return allowed.length > 0 && !allowed.includes(key) ? `Project ${key} is not one of the projects ${config.team.pointer.name} may use. Add it under Projects first.` : undefined;
  };

  // Connects (site, email and token: checked with Jira unless SKIP_VALIDATION=1) and/or saves the project settings.
  router.post("/api/jira", requireAdmin, async (req, res) => {
    const parsed = SAVE.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input." });
    const input = parsed.data;
    const config = await configRepo.load(true);
    const current = config.jira;
    const fail = (error: string) => void res.status(400).json({ error });

    let siteUrl = current.siteUrl;
    if (input.siteUrl !== undefined) {
      const site = normalizeSiteUrl(input.siteUrl);
      if (!site) return fail(SITE_ERROR);
      siteUrl = site;
    }
    const email = input.email ?? current.email;
    const token = input.token?.trim() ?? "";
    if (token && (token.length < 20 || /\s/.test(token))) return fail("That doesn't look like an Atlassian API token.");
    const moved = siteUrl !== current.siteUrl || email !== current.email;
    if (!token && !current.token) return fail("Connect Jira with the site address, the account's email and an API token first.");
    if (!token && moved) return fail("Paste the API token again: it belongs to the account's email and works on that site.");
    if (token && (!siteUrl || !email)) return fail(!siteUrl ? SITE_ERROR : "Enter the email of the Atlassian account the API token belongs to.");

    const allowed = input.allowedProjectKeys ? [...new Set(input.allowedProjectKeys)] : current.allowedProjectKeys;
    const defaultProjectKey = input.defaultProjectKey === undefined ? current.defaultProjectKey : input.defaultProjectKey || undefined;
    if (defaultProjectKey && allowed.length > 0 && !allowed.includes(defaultProjectKey)) {
      return fail(`The default project must be one of the projects ${config.team.pointer.name} may use.`);
    }

    let info: { userName: string; accountId: string } | undefined;
    if (token) {
      try {
        info = await checkJira({ siteUrl: siteUrl!, email: email!, token });
      } catch (err) {
        // checkJira's messages never contain the token; redacted again in case.
        const redact = makeRedactor([...configSecrets(config), token, Buffer.from(`${email}:${token}`).toString("base64")]);
        return fail(redact((err as Error).message));
      }
    }
    await configRepo.update((c) => {
      if (info) c.jira = { ...c.jira, siteUrl, email, token, ...info };
      c.jira.allowedProjectKeys = allowed;
      c.jira.defaultProjectKey = defaultProjectKey;
      if (input.confluence !== undefined) c.jira.confluence = input.confluence;
    });
    res.json({ ok: true, ...(info ? { userName: info.userName } : {}) });
  });

  // Forgets the token and who it belongs to; the site, email, projects and automation stay for a later reconnect.
  router.post("/api/jira/disconnect", requireAdmin, async (_req, res) => {
    await configRepo.update((c) => {
      c.jira = { ...c.jira, token: undefined, userName: undefined, accountId: undefined };
    });
    res.json({ ok: true });
  });

  // Projects for the page's "Default project" picker and the automation, most recently active first.
  router.get("/api/jira/projects", requireAdmin, async (req, res) => {
    const client = jiraClientFor(await configRepo.load(true));
    if (!client) return notConnected(res);
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
    try {
      res.json({ projects: await client.listProjects({ ...(search ? { query: search } : {}), limit: 50 }) });
    } catch (err) {
      jiraFailure(res, err);
    }
  });

  // A project's workflow statuses, for the automation's pickers.
  router.get("/api/jira/statuses", requireAdmin, async (req, res) => {
    const config = await configRepo.load(true);
    const client = jiraClientFor(config);
    if (!client) return notConnected(res);
    const key = PROJECT_KEY.safeParse(typeof req.query.projectKey === "string" ? req.query.projectKey : "");
    if (!key.success) return void res.status(400).json({ error: "Project keys look like ACME." });
    const denied = allowedError(config, key.data);
    if (denied) return void res.status(400).json({ error: denied });
    try {
      const [project, statuses] = await Promise.all([client.getProject(key.data), client.projectStatuses(key.data)]);
      res.json({ project: { key: project.key, name: project.name }, statuses });
    } catch (err) {
      jiraFailure(res, err);
    }
  });

  // ---------- Issues that start repo tasks (admin) ----------
  // Projects whose issues start tasks (`null` removes one), and whether the webhook in Jira signs its deliveries
  // (set when it is registered from here; confirmed by the owner after pasting the secret into Jira by hand).
  router.post("/api/jira/automation", requireAdmin, async (req, res) => {
    const parsed = z
      .object({
        enabled: z.boolean().optional(),
        signed: z.boolean().optional(),
        projects: z.record(z.string(), z.union([PROJECT_AUTOMATION_INPUT, z.null()])).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const [section, key] = issue?.path ?? [];
      const where = section === "projects" && typeof key === "string" ? `Project ${key.slice(0, 50)}: ` : "";
      return void res.status(400).json({ error: `${where}${issue?.message ?? "Invalid input."}` });
    }
    const input = parsed.data;
    const changes = Object.entries(input.projects ?? {});
    const badKey = changes.find(([key]) => !JIRA_KEY_RE.test(key));
    if (badKey) return void res.status(400).json({ error: `"${badKey[0].slice(0, 50)}" is not a Jira project key. Project keys look like ACME.` });

    const config = await configRepo.load(true);
    const client = jiraClientFor(config);
    const adding = changes.filter((e): e is [string, z.infer<typeof PROJECT_AUTOMATION_INPUT>] => e[1] !== null);
    if ((input.enabled || adding.length > 0) && !client) return void res.status(400).json({ error: "Connect Jira first." });
    if (input.signed && !config.jira.automation.webhookSecret) return void res.status(400).json({ error: "Set up the webhook first: it makes the secret Jira signs with." });
    const total = new Set([...Object.keys(config.jira.automation.projects), ...adding.map(([key]) => key)]).size;
    if (total > MAX_AUTOMATED_PROJECTS) return void res.status(400).json({ error: `Automate at most ${MAX_AUTOMATED_PROJECTS} projects.` });

    const checked: Record<string, JiraProjectAutomation> = {};
    for (const [key, value] of adding) {
      const fail = (error: string) => void res.status(400).json({ error });
      const denied = allowedError(config, key);
      if (denied) return fail(denied);
      const auto = JiraProjectAutomationSchema.parse(value);
      const repoDenied = repoAccessError(config, auto.repo);
      if (repoDenied) return fail(repoDenied);
      const conflict = statusConflict(auto);
      if (conflict) return fail(`Project ${key}: ${conflict}`);
      if (process.env.SKIP_VALIDATION === "1" || !client) {
        checked[key] = auto;
        continue;
      }
      let result: ReturnType<typeof checkProjectAutomation>;
      try {
        const [project, statuses] = await Promise.all([client.getProject(key), client.projectStatuses(key)]);
        result = checkProjectAutomation(project, statuses, auto);
      } catch (err) {
        return fail(`Couldn't read project ${key} from Jira: ${err instanceof JiraError ? err.message : "the request failed."}`);
      }
      if (!result.ok) return fail(result.error);
      checked[key] = result.automation;
    }

    const updated = await configRepo.update((c) => {
      for (const [key, value] of changes) {
        if (value === null) delete c.jira.automation.projects[key];
        else c.jira.automation.projects[key] = checked[key]!;
      }
      if (input.enabled !== undefined) c.jira.automation.enabled = input.enabled;
      if (input.signed !== undefined) c.jira.automation.signed = input.signed;
    });
    await rememberConsoleUrl(store, baseUrl(req));
    res.json({ ok: true, automation: publicView(updated).jira.automation });
  });

  // The webhook's URL (the secret is made on first use, or anew with rotate), registered in Jira when the token's user is a Jira admin.
  router.post("/api/jira/automation/webhook", requireAdmin, async (req, res) => {
    const parsed = z.object({ rotate: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return void res.status(400).json({ error: "Invalid input." });
    let config = await configRepo.load(true);
    const client = jiraClientFor(config);
    if (!client) return void res.status(400).json({ error: "Connect Jira first." });
    const projectKeys = Object.keys(config.jira.automation.projects);
    if (projectKeys.length === 0) return void res.status(400).json({ error: "Add a project first." });
    if (!config.jira.automation.webhookSecret || parsed.data.rotate) {
      const fresh = randomToken(32);
      config = await configRepo.update((c) => {
        c.jira.automation.webhookSecret = parsed.data.rotate ? fresh : (c.jira.automation.webhookSecret ?? fresh);
      });
    }
    const secret = config.jira.automation.webhookSecret!;
    const base = baseUrl(req);
    const url = `${base}/jira/webhook/${secret}`;
    await rememberConsoleUrl(store, base);
    const jql = webhookJql(projectKeys);
    const redact = makeRedactor([...configSecrets(config), secret]);
    const result = await connectJiraWebhook(
      { store, client, redact },
      { name: `Agent Army (${config.team.pointer.name.slice(0, 40)})`, url, secret, projectKeys },
    );
    // Registered from here, the webhook has the secret: from now on every delivery must be signed. A new secret
    // that could not be registered is not in Jira yet: unsigned deliveries are accepted until the owner confirms it.
    if (result.ok || parsed.data.rotate) {
      config = await configRepo.update((c) => {
        c.jira.automation.signed = result.ok;
      });
    }
    res.json({
      ok: result.ok,
      url,
      secret,
      jql,
      signed: config.jira.automation.signed === true,
      ...(result.ok ? { registered: true, kept: result.kept } : { registered: false, error: result.error, manualSteps: manualJiraWebhookSteps(url, jql) }),
    });
  });

  // ---------- The webhook: issues that start repo tasks ----------
  // The secret in the URL is the check, and Jira's signature (X-Hub-Signature): required once the webhook is known
  // to have the secret (automation.signed), and checked whenever one is sent. The payload only names the issue;
  // it is read again from Jira.
  router.post("/jira/webhook/:secret", express.raw({ type: "*/*", limit: "5mb" }), async (req: Request, res: Response) => {
    const auto = (await configRepo.load()).jira.automation;
    const given = String(req.params.secret ?? "");
    if (!auto.enabled || !auto.webhookSecret || !safeEqual(given, auto.webhookSecret)) {
      // Wrong guesses count towards the brute-force brake; Jira's deliveries never get here.
      return deps.throttle(req, res, () => void res.status(404).json({ error: "Not found." }));
    }
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const signature = req.get("x-hub-signature");
    if (signature === undefined ? auto.signed : !verifyJiraSignature(auto.webhookSecret, rawBody, signature)) {
      return void res.status(401).json({ error: signature === undefined ? "Missing signature." : "Invalid signature." });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return void res.status(400).json({ error: "Invalid JSON." });
    }
    // A retry carries the same identifier; the first delivery is already handled.
    const delivery = (req.get("x-atlassian-webhook-identifier") ?? "").slice(0, 100);
    if (delivery && seenDeliveries.has(delivery)) return void res.status(200).json({ ok: true, duplicate: true });
    if (delivery) seenDeliveries.add(delivery);
    // Answer first (Jira retries slow deliveries); the issue is read and the task started after this.
    res.status(200).json({ ok: true });
    const found = deliveryIssue(payload);
    if (!found.ok) return void console.log(`[jira] delivery: ignored: ${found.reason}`);
    void automation.handle(found.issueKey);
  });

  return router;
}
