import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { TaskBudgetCheck } from "../../spending/budget.js";
import { type Config, REPO_RE } from "../../core/config.js";
import { BOT_MARKER, WRITE_ASSOCIATIONS } from "../github/github.js";
import { isRepoAllowedOnHost } from "./code-host-access.js";
import { isJiraConnected } from "../jira/jira.js";
import { HOST_TERMS, repoHost, repoWebUrl } from "./repo-id.js";
import { KeyedQueue } from "../../slack/listen.js";
import type { SlackDeps } from "../../chat/pointer-types.js";
import type { WebThreads } from "../../chat/conversations.js";
import { type PrThread, type TaskRepo, WEB_CHANNEL } from "../../tasks/tasks.js";
import type { Store } from "../../core/store.js";
import { startThreadTask } from "../../tasks/thread-task.js";
import { type TicketClient, appendTicketEvent, ticketPrClosed } from "../tickets/ticket-sync.js";
import { configSecrets, makeRedactor } from "../../tasks/worker.js";

/**
 * GitHub webhook: a review or a comment addressed to Pointer on a pull request
 * the team opened starts a follow-up task in that pull request's Slack thread.
 * Only people with write access steer the team; nothing from the payload is
 * logged except the event type, the repository and the outcome. When such a
 * pull request is merged (or closed), its monday.com ticket is told.
 */

/** Longest part of a review or comment quoted in the follow-up's instruction. */
export const EXCERPT_MAX_CHARS = 2000;

/** `X-Hub-Signature-256`: "sha256=" + the hex HMAC-SHA256 of the raw body, compared in constant time. */
export function verifyGithubSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The JSON payload of a delivery, sent as application/json or as a form field (`payload=`). Undefined when unreadable. */
export function parseGithubPayload(rawBody: Buffer, contentType: string | undefined): unknown {
  try {
    const text = rawBody.toString("utf8");
    if ((contentType ?? "").toLowerCase().includes("application/x-www-form-urlencoded")) {
      const field = new URLSearchParams(text).get("payload");
      return field === null ? undefined : (JSON.parse(field) as unknown);
    }
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export type ReviewKind = "changes_requested" | "commented" | "asked";

export type ReviewDecision =
  | { start: false; reason: string; repo?: string }
  | { start: true; repo: string; prNumber: number; prUrl: string; login: string; kind: ReviewKind; excerpt: string };

/** GitHub logins: letters, digits, "-" (plus "_" and "." on enterprise hosts), "[bot]" for apps. */
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}(\[bot\])?$/;
/** Safe inside a Slack link: no whitespace, "|", "<" or ">". */
const URL_RE = /^https:\/\/[^\s|<>]{1,500}$/;

const Actor = z.object({ login: z.string().max(120), type: z.string().max(40).optional() });
const Repository = z.object({ full_name: z.string().regex(REPO_RE) });
const Body = z
  .string()
  .nullish()
  .transform((s) => s ?? "");

const ReviewPayload = z.object({
  action: z.string().max(40),
  review: z.object({
    state: z.string().max(40),
    body: Body,
    user: Actor.nullish(),
    author_association: z.string().max(40).default(""),
  }),
  pull_request: z.object({ number: z.number().int().positive(), state: z.string().max(20), html_url: z.string().max(500).optional() }),
  repository: Repository,
  sender: Actor.nullish(),
});

const CommentPayload = z.object({
  action: z.string().max(40),
  issue: z.object({
    number: z.number().int().positive(),
    state: z.string().max(20),
    html_url: z.string().max(500).optional(),
    /** Present only when the issue is a pull request. */
    pull_request: z.object({ html_url: z.string().max(500).nullish() }).nullish(),
  }),
  comment: z.object({ body: Body, user: Actor.nullish(), author_association: z.string().max(40).default("") }),
  repository: Repository,
  sender: Actor.nullish(),
});

const repoOf = (payload: unknown): string | undefined => {
  const parsed = z.object({ repository: Repository }).safeParse(payload);
  return parsed.success ? parsed.data.repository.full_name : undefined;
};

/** The names a comment can address Pointer by: the configured name without spaces, and "pointer". */
function pointerHandles(pointerName: string): string[] {
  const own = pointerName.toLowerCase().replace(/\s+/g, "");
  return [...new Set([own, "pointer"].filter(Boolean))];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when the comment starts with `/pointer` or mentions `@pointer` (case-insensitive); quoted lines do not count. */
export function addressesPointer(body: string, pointerName: string): boolean {
  const text = body
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n")
    .toLowerCase();
  const names = pointerHandles(pointerName).map(escapeRegExp).join("|");
  const end = "(?![a-z0-9_-])";
  return new RegExp(`^\\s*/(?:${names})${end}`).test(text) || new RegExp(`(?:^|[^a-z0-9_.\`/-])@(?:${names})${end}`).test(text);
}

const excerptOf = (body: string): string => {
  const text = body.replace(/\r\n/g, "\n").trim();
  return text.length > EXCERPT_MAX_CHARS ? `${text.slice(0, EXCERPT_MAX_CHARS - 1).trimEnd()}…` : text;
};

/**
 * Whether a webhook delivery should start a follow-up, from the payload alone.
 * Starts for a submitted review that requests changes or comments, and for a
 * new pull request comment addressed to Pointer, by a human with write access.
 * The allow lists, the PR's Slack thread and Slack itself are checked by the handler.
 */
export function reviewTrigger(event: string, payload: unknown, opts: { pointerName: string }): ReviewDecision {
  const repo = repoOf(payload);
  const no = (reason: string): ReviewDecision => ({ start: false, reason, ...(repo ? { repo } : {}) });

  let fields: {
    kind: ReviewKind;
    prNumber: number;
    prState: string;
    prUrl: string | undefined;
    body: string;
    author: { login: string; type?: string } | null | undefined;
    association: string;
    sender: { login: string; type?: string } | null | undefined;
    repo: string;
  };
  if (event === "pull_request_review_comment") return no("inline comments arrive with their review");
  if (event === "pull_request_review") {
    const parsed = ReviewPayload.safeParse(payload);
    if (!parsed.success) return no("unexpected payload");
    const p = parsed.data;
    if (p.action !== "submitted") return no("review not submitted");
    const state = p.review.state.toLowerCase();
    if (state !== "changes_requested" && state !== "commented") return no("review approved or dismissed");
    fields = {
      kind: state,
      prNumber: p.pull_request.number,
      prState: p.pull_request.state,
      prUrl: p.pull_request.html_url,
      body: p.review.body,
      author: p.review.user,
      association: p.review.author_association,
      sender: p.sender,
      repo: p.repository.full_name,
    };
  } else if (event === "issue_comment") {
    const parsed = CommentPayload.safeParse(payload);
    if (!parsed.success) return no("unexpected payload");
    const p = parsed.data;
    if (p.action !== "created") return no("comment not created");
    if (!p.issue.pull_request) return no("comment on an issue, not a pull request");
    if (!addressesPointer(p.comment.body, opts.pointerName)) return no("comment does not address Pointer");
    fields = {
      kind: "asked",
      prNumber: p.issue.number,
      prState: p.issue.state,
      prUrl: p.issue.pull_request.html_url ?? p.issue.html_url,
      body: p.comment.body,
      author: p.comment.user,
      association: p.comment.author_association,
      sender: p.sender,
      repo: p.repository.full_name,
    };
  } else {
    return no("event not handled");
  }

  if (fields.sender?.type === "Bot" || fields.author?.type === "Bot") return no("sent by a bot");
  if (!WRITE_ASSOCIATIONS.has(fields.association.toUpperCase())) return no("author has no write access");
  if (fields.body.includes(BOT_MARKER)) return no("posted by the platform");
  if (fields.prState.toLowerCase() !== "open") return no("pull request is not open");
  const login = fields.author?.login ?? fields.sender?.login ?? "";
  if (!LOGIN_RE.test(login)) return no("unexpected payload");
  const prUrl =
    fields.prUrl && URL_RE.test(fields.prUrl) ? fields.prUrl : `https://github.com/${fields.repo}/pull/${fields.prNumber}`;
  return {
    start: true,
    repo: fields.repo,
    prNumber: fields.prNumber,
    prUrl,
    login,
    kind: fields.kind,
    excerpt: excerptOf(fields.body),
  };
}

export type WebhookDeps = Pick<SlackDeps, "configRepo" | "tasks" | "runner" | "slack"> & {
  /** Console conversations, for pull requests opened from the admin console (no Slack there). */
  web?: WebThreads;
  /** Where task timelines are kept: a ticket update after a merge is added to the task's timeline. */
  store?: Pick<Store, "get" | "put">;
  /** Test seam: the monday.com client for a token. */
  monday?: (token: string) => TicketClient;
  /** The spending caps, checked before a follow-up starts (the console path checks them in startTask). */
  spending?: TaskBudgetCheck;
};

// One delivery at a time per pull request, so two quick reviews cannot both start a task.
let queue = new KeyedQueue();

/**
 * Handles one verified delivery (not `ping`): starts a follow-up in the pull
 * request's Slack thread, or notes the feedback there while a task is running.
 * Never throws; every outcome is logged without payload content.
 */
export async function handleGithubWebhook(event: string, payload: unknown, deps: WebhookDeps): Promise<void> {
  let redact = (text: string) => text;
  try {
    const config = await deps.configRepo.load();
    redact = makeRedactor([...configSecrets(config), config.github.webhookSecret]);
    if (event === "pull_request") return await pullRequestClosed(payload, config, deps, redact);
    const decision = reviewTrigger(event, payload, { pointerName: config.team.pointer.name });
    if (!decision.start) return log(event, decision.repo, `ignored: ${decision.reason}`);
    const key = `${decision.repo.toLowerCase()}#${decision.prNumber}`;
    await queue.run(key, () => followUp(event, decision, config, deps, redact));
  } catch (err) {
    console.error(`[github] ${event} failed:`, redact(errorText(err)));
  }
}

type Start = Extract<ReviewDecision, { start: true }>;

/**
 * Feedback on a pull or merge request from any code host: GitLab and
 * Bitbucket webhooks (routes/gitlab.ts, routes/bitbucket.ts) turn their
 * payloads into a ReviewDecision and hand it here, so the follow-up is the
 * same as GitHub's. Never throws.
 */
export async function handleReviewDecision(event: string, decision: ReviewDecision, deps: WebhookDeps): Promise<void> {
  let redact = (text: string) => text;
  try {
    const config = await deps.configRepo.load();
    redact = makeRedactor(configSecrets(config));
    if (!decision.start) return log(event, decision.repo, `ignored: ${decision.reason}`);
    const key = `${decision.repo.toLowerCase()}#${decision.prNumber}`;
    await queue.run(key, () => followUp(event, decision, config, deps, redact));
  } catch (err) {
    console.error(`[webhook] ${event} failed:`, redact(errorText(err)));
  }
}

/** A pull or merge request the team opened was closed (merged or not), on any code host. Never throws. */
export async function handlePrClosed(event: string, pr: ClosedPr, deps: WebhookDeps): Promise<void> {
  let redact = (text: string) => text;
  try {
    const config = await deps.configRepo.load();
    redact = makeRedactor(configSecrets(config));
    await prClosed(event, pr, config, deps, redact);
  } catch (err) {
    console.error(`[webhook] ${event} failed:`, redact(errorText(err)));
  }
}

/** A closed pull or merge request, as any host's webhook reports it. */
export interface ClosedPr {
  repo: string;
  prNumber: number;
  /** Its web address; absent or unsafe = built from the repository. */
  url?: string;
  merged: boolean;
}

async function followUp(event: string, d: Start, config: Config, deps: WebhookDeps, redact: (text: string) => string): Promise<void> {
  const at = `${d.repo}#${d.prNumber}`;
  if (!isRepoAllowedOnHost(config, d.repo)) return log(event, at, "ignored: repository not allowed");
  const ref = await deps.tasks.getPrThread(d.repo, d.prNumber);
  if (!ref) return log(event, at, "ignored: not a pull request the team opened");
  if (ref.channel === WEB_CHANNEL) return webFollowUp(event, d, config, deps, ref);
  const botToken = config.slack.botToken;
  if (!botToken) return log(event, at, "ignored: Slack not connected");
  const slack = deps.slack(botToken);
  const prLink = `<${d.prUrl}|PR #${d.prNumber}>`;
  const post = (text: string) => slack.chat.postMessage({ channel: ref.channel, thread_ts: ref.threadTs, text });

  if ((await deps.tasks.activeInThread(ref.channel, ref.threadTs)).length > 0) {
    await post(
      `:speech_balloon: ${d.login} reviewed ${prLink} while the team is still working. When this run ends, reply here (for example "address the review") and the team will pick it up.`,
    );
    return log(event, at, "noted in Slack: a task is still running");
  }

  const thread = await deps.tasks.getThread(ref.channel, ref.threadTs);
  const userId = thread?.requester ?? (await lastRequester(deps.tasks, ref));
  if (!userId) return log(event, at, "ignored: no Slack requester for the thread");
  // The thread's spelling of the repo, so the worker recognises its branch.
  const repo = thread && thread.repo.toLowerCase() === d.repo.toLowerCase() ? thread.repo : d.repo;
  const verb = d.kind === "changes_requested" ? "requested changes on" : d.kind === "commented" ? "commented on" : `asked ${config.team.pointer.name} on`;
  const started = await startThreadTask(
    { tasks: deps.tasks, runner: deps.runner, slack, redact, budget: deps.spending, configRepo: deps.configRepo },
    {
      repo,
      channel: ref.channel,
      threadTs: ref.threadTs,
      userId,
      instruction: reviewInstruction(d),
      ackText: `:speech_balloon: *${d.login}* ${verb} ${prLink}. The team is on it…`,
      trigger: "review",
    },
  );
  if (!started.ok) {
    await post(`:x: ${started.error}`).catch(() => undefined);
    return log(event, at, `could not start a follow-up: ${started.error}`);
  }
  log(event, at, `started follow-up task ${started.taskId}`);
}

/**
 * The same follow-up for a pull request opened from the admin console: the
 * conversation gets Pointer's messages (Markdown) and the task; Slack is never
 * called. The requester is the console's admin.
 */
async function webFollowUp(event: string, d: Start, config: Config, deps: WebhookDeps, ref: PrThread): Promise<void> {
  const at = `${d.repo}#${d.prNumber}`;
  if (!deps.web) return log(event, at, "ignored: console conversations are not available");
  const prLink = `[PR #${d.prNumber}](${d.prUrl})`;
  if ((await deps.tasks.activeInThread(ref.channel, ref.threadTs)).length > 0) {
    const posted = await deps.web.post(
      ref.threadTs,
      `**${d.login}** reviewed ${prLink} while the team is still working. When this run ends, reply here (for example "address the review") and the team will pick it up.`,
    );
    return log(event, at, posted ? "noted in the console: a task is still running" : "ignored: the conversation was deleted");
  }
  const thread = await deps.tasks.getThread(ref.channel, ref.threadTs);
  const repo = thread && thread.repo.toLowerCase() === d.repo.toLowerCase() ? thread.repo : d.repo;
  const verb = d.kind === "changes_requested" ? "requested changes on" : d.kind === "commented" ? "commented on" : `asked ${config.team.pointer.name} on`;
  const started = await deps.web.startTask(ref.threadTs, {
    repo,
    instruction: reviewInstruction(d),
    ackText: `**${d.login}** ${verb} ${prLink}. The team is on it…`,
    trigger: "review",
  });
  if (!started.ok) {
    await deps.web.post(ref.threadTs, started.error).catch(() => undefined);
    return log(event, at, `could not start a follow-up: ${started.error}`);
  }
  log(event, at, `started follow-up task ${started.taskId} (console)`);
}

const PullRequestPayload = z.object({
  action: z.string().max(40),
  pull_request: z.object({ number: z.number().int().positive(), merged: z.boolean().nullish(), html_url: z.string().max(500).optional() }),
  repository: Repository,
});

/** Recent tasks looked at to find the ticket of a pull request's thread. */
const TICKET_SCAN = 200;

/**
 * A pull request the team opened was closed: merged, its monday.com ticket
 * gets the board's "done" label and an update; closed without merging, an
 * update only. The ticket is the one of the newest task in the pull request's
 * thread that has one.
 */
async function pullRequestClosed(payload: unknown, config: Config, deps: WebhookDeps, redact: (text: string) => string): Promise<void> {
  const event = "pull_request";
  const parsed = PullRequestPayload.safeParse(payload);
  if (!parsed.success) return log(event, repoOf(payload), "ignored: unexpected payload");
  const p = parsed.data;
  const at = `${p.repository.full_name}#${p.pull_request.number}`;
  if (p.action !== "closed") return log(event, at, "ignored: pull request not closed");
  await prClosed(
    event,
    { repo: p.repository.full_name, prNumber: p.pull_request.number, url: p.pull_request.html_url, merged: p.pull_request.merged === true },
    config,
    deps,
    redact,
  );
}

/**
 * The ticket of the pull request's thread (a monday.com item or a Jira issue)
 * hears that the pull request closed: merged, it gets the "done" status of its
 * board or project and an update; closed without merging, an update only.
 */
async function prClosed(event: string, pr: ClosedPr, config: Config, deps: WebhookDeps, redact: (text: string) => string): Promise<void> {
  const repo = pr.repo;
  const at = `${repo}#${pr.prNumber}`;
  if (!isRepoAllowedOnHost(config, repo)) return log(event, at, "ignored: repository not allowed");
  const ref = await deps.tasks.getPrThread(repo, pr.prNumber);
  if (!ref) return log(event, at, "ignored: not a pull request the team opened");
  const task = (await deps.tasks.recent(TICKET_SCAN)).find((t) => t.channel === ref.channel && t.threadTs === ref.threadTs && t.ticket);
  if (!task?.ticket) return log(event, at, "ignored: no ticket");
  const jira = task.ticket.provider === "jira";
  const token = config.monday.token;
  if (jira ? !isJiraConnected(config) : !token) return log(event, at, `ignored: ${jira ? "Jira" : "monday.com"} not connected`);
  const path = { github: `/pull/${pr.prNumber}`, gitlab: `/-/merge_requests/${pr.prNumber}`, bitbucket: `/pull-requests/${pr.prNumber}` }[repoHost(repo)];
  const url = pr.url && URL_RE.test(pr.url) ? pr.url : `${repoWebUrl(repo, config.gitlab.baseUrl)}${path}`;
  const merged = pr.merged;
  const store = deps.store;
  await ticketPrClosed(
    {
      config,
      redact,
      ...(!jira && token && deps.monday ? { client: deps.monday(token) } : {}),
      // Only a finished task's timeline: while a follow-up runs, its worker is the timeline's only writer.
      ...(store && task.status !== "queued" && task.status !== "running" ? { record: (e) => appendTicketEvent(store, task.id, e) } : {}),
    },
    task,
    { url, merged },
  );
  log(event, at, merged ? `ticket ${task.ticket!.itemId} marked done` : `ticket ${task.ticket!.itemId} told the pull request was closed`);
}

/** The instruction the worker gets; it fetches every new piece of review feedback itself. */
export function reviewInstruction(d: Pick<Start, "login" | "prNumber" | "excerpt"> & { repo?: string }): string {
  const host = HOST_TERMS[repoHost(d.repo ?? "")];
  const head = `Address the feedback from ${d.login} on ${host.pr} #${d.prNumber} (${host.name}).`;
  if (!d.excerpt) return head;
  const quoted = d.excerpt
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
  return `${head}\n\n${quoted}`;
}

/** Who asked for the thread's most recent task, when the thread state does not say. */
async function lastRequester(tasks: TaskRepo, ref: PrThread): Promise<string | undefined> {
  const recent = await tasks.recent(200);
  return recent.find((t) => t.channel === ref.channel && t.threadTs === ref.threadTs && t.userId)?.userId;
}

function log(event: string, where: string | undefined, outcome: string): void {
  console.log(`[github] ${event}${where ? ` ${where}` : ""}: ${outcome}`);
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Tests only: forget queued work. */
export function resetWebhookStateForTests(): void {
  queue = new KeyedQueue();
}
