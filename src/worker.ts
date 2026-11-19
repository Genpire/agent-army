import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { type HookCallback, type Options, query } from "@anthropic-ai/claude-agent-sdk";
import {
  type OrchestratorContext,
  REPORT_SCHEMA,
  type Report,
  type SetupResult,
  type SharedFile,
  orchestratorPrompt,
  parseReport,
} from "./agents.js";
import { AttachmentRepo, type ThreadRef, classify, expandZip } from "./attachments.js";
import { type Screenshot, browserAvailable, browserServer, collectScreenshots } from "./browser.js";
import { type CiOutcome, ciFailureDetails, ciFixPrompt, ciSummary, ciSummaryLine, storedCiSummary, waitForChecks } from "./ci.js";
import { type Config, ConfigRepo, resolveMasterKey } from "./config.js";
import { GitHub, type PrRef, isHumanFeedback } from "./github.js";
import { connectionForRepo, githubTokens } from "./github-access.js";
import { checkBashCommand } from "./guard.js";
import { NOTES_MAX_CHARS, NotesRepo } from "./notes.js";
import { formatFeedback } from "./pr-feedback.js";
import { type PlanItem, ProgressTracker, formatProgress } from "./progress.js";
import { findRepoSetup, repoSetupContext, runSetupCommand, setupEnv } from "./repo-setup.js";
import { slackClient, slackErrorCode, toMrkdwn, truncate, uploadThreadFiles } from "./slack.js";
import { createStore } from "./store.js";
import { type Task, TaskRepo, type ThreadState, decodeTaskPayload } from "./tasks.js";
import { type RepoAgentOptions, type Team, agentLabel, buildRepoAgents, repoAllowedTools } from "./team.js";

const exec = promisify(execFile);

/** How a subagent call appears in the Slack progress line, e.g. ":hammer_and_wrench: Sara (Coder)". */
export function subagentLabel(team: Team, subagentType: string | undefined): string {
  const agent = team.agents.find((a) => a.id === subagentType);
  return agent ? agentLabel(agent) : `:robot_face: ${subagentType || "agent"}`;
}

/**
 * The parts of the query that come from the configured team: Pointer's prompt, the subagents and what they may use.
 * With shared files (context.attachments) and the folder they were written to, that folder is opened to the team too,
 * and so is the screenshots folder when the team has a browser (`opts.browser`, `context.browser`).
 */
export function teamQueryOptions(
  config: Config,
  context: OrchestratorContext = {},
  attachmentsDir?: string,
  opts: RepoAgentOptions = {},
): Required<Pick<Options, "systemPrompt" | "agents" | "allowedTools" | "effort">> & Pick<Options, "additionalDirectories"> {
  // Both sit next to the checkout, not in it, so nothing in them is ever committed.
  const directories = [
    ...(attachmentsDir && context.attachments?.length ? [attachmentsDir] : []),
    ...(opts.browser && context.browser ? [context.browser.shotsDir] : []),
  ];
  return {
    systemPrompt: { type: "preset", preset: "claude_code", append: orchestratorPrompt(config, context) },
    // Each agent carries its own effort (its setting, or this one).
    effort: config.team.pointer.taskEffort,
    agents: buildRepoAgents(config.team, opts),
    // Under "dontAsk" anything not listed is denied, so this covers every
    // enabled agent's tools (e.g. WebSearch for agents that only look).
    allowedTools: repoAllowedTools(config.team, opts),
    ...(directories.length ? { additionalDirectories: directories } : {}),
  };
}

/** Characters that are unsafe in a file name on common filesystems, or that would break a Markdown code span. */
const UNSAFE_NAME_CHARS = /[\x00-\x1f\x7f<>:"|?*`]/g;
const ALL_DOTS = /^\.+$/;

/** One path segment (no separators: callers split on them) without control characters or runs of dots, bounded. */
const safeSegment = (segment: string) => segment.replace(UNSAFE_NAME_CHARS, "_").replace(/\.{2,}/g, ".").trim().slice(0, 150);

/** A flat file name: separators and dot segments removed, never empty, never "." or "..". */
function safeFileName(name: string): string {
  const parts = name
    .split(/[\\/]+/)
    .map(safeSegment)
    .filter((p) => p && !ALL_DOTS.test(p));
  const joined = parts.join("_").slice(0, 150);
  return joined || "file";
}

/** A zip entry's path, relative and normalised, or null when it is absolute or has a ".." segment. */
function safeEntryPath(entry: string): string | null {
  const path = entry.replace(/\\/g, "/");
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return null;
  const segments = path.split("/").filter((s) => s !== "" && s !== ".");
  if (!segments.length || segments.some((s) => s.trim() === "..")) return null;
  const safe = segments.map(safeSegment);
  return safe.every((s) => s && !ALL_DOTS.test(s)) ? safe.join("/") : null;
}

/** `name`, or `name-2`, `name-3`… (before the extension) when taken; compared case-insensitively. */
function uniqueName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${stem}-${n}${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

const errorCode = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code ?? "error";

/**
 * Write the files shared in a conversation thread into `dir` (outside the
 * checkout) so the team can read them: each under a safe, unique name, zips
 * expanded into `dir/<zip name>/` with every entry path checked. A file that
 * cannot be read, opened or written is skipped with a short log line (never
 * its contents); only failing to list the thread's files throws.
 */
export async function materializeAttachments(
  repo: Pick<AttachmentRepo, "list" | "get">,
  thread: ThreadRef,
  dir: string,
): Promise<SharedFile[]> {
  const infos = await repo.list(thread);
  if (!infos.length) return [];
  const root = resolve(dir);
  await mkdir(root, { recursive: true });
  const taken = new Set<string>();
  const out: SharedFile[] = [];

  for (const info of infos) {
    const skip = (why: string) => console.error(`[worker] skipped shared file ${info.id}: ${why}`);
    let bytes: Buffer | null;
    try {
      bytes = await repo.get(thread, info.id);
    } catch {
      skip("could not be read");
      continue;
    }
    if (!bytes) {
      skip("missing from the store");
      continue;
    }

    if (classify(info.name, info.mime) !== "zip") {
      const path = join(root, uniqueName(safeFileName(info.name), taken));
      try {
        await writeFile(path, bytes, { flag: "wx" });
        out.push({ path, name: info.name, size: bytes.byteLength });
      } catch (err) {
        skip(`could not be written (${errorCode(err)})`);
      }
      continue;
    }

    let entries: { name: string; bytes: Uint8Array }[];
    try {
      entries = expandZip(bytes);
    } catch {
      skip("zip could not be opened");
      continue;
    }
    const folder = join(root, uniqueName(safeFileName(info.name.replace(/\.zip$/i, "")), taken));
    let unsafe = 0;
    let failed = 0;
    for (const entry of entries) {
      const rel = safeEntryPath(entry.name);
      const path = rel === null ? null : resolve(folder, rel);
      if (rel === null || !path || !path.startsWith(folder + sep)) {
        unsafe += 1;
        continue;
      }
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, entry.bytes, { flag: "wx" });
        out.push({ path, name: rel, size: entry.bytes.byteLength, fromZip: info.name });
      } catch {
        failed += 1;
      }
    }
    if (unsafe) console.error(`[worker] skipped ${unsafe} unsafe path(s) in shared zip ${info.id}`);
    if (failed) console.error(`[worker] skipped ${failed} file(s) in shared zip ${info.id} that could not be written`);
  }
  return out;
}

export function branchName(instruction: string, taskId: string): string {
  const slug = instruction
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `army/${slug || "task"}-${taskId.slice(-6)}`;
}

/**
 * The project notes to store after a task, or null to leave them as they are:
 * the team returns "" for unchanged, and identical text is not rewritten.
 * Over-long notes are cut at the last line break that fits.
 */
export function notesToSave(previous: string, reported: string): string | null {
  let text = reported.trim();
  if (text.length > NOTES_MAX_CHARS) {
    const cut = text.lastIndexOf("\n", NOTES_MAX_CHARS);
    text = text.slice(0, cut > 0 ? cut : NOTES_MAX_CHARS).trimEnd();
  }
  return text && text !== previous.trim() ? text : null;
}

/**
 * Store the team's updated project notes, with known credentials redacted.
 * Never throws: losing an update must not fail the task, and the log never
 * carries the notes themselves.
 */
/**
 * Lines someone added to the notes while the task ran (Slack "remember for …",
 * an admin edit) are kept: they are appended to the team's rewrite unless it
 * already contains them.
 */
export function mergeConcurrentNotes(previous: string, current: string, text: string): string {
  if (current.trim() === previous.trim()) return text;
  const before = new Set(previous.split("\n").map((l) => l.trim()));
  const present = new Set(text.split("\n").map((l) => l.trim()));
  const added = current
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !before.has(l) && !present.has(l));
  return added.length ? `${text}\n${added.join("\n")}` : text;
}

export async function saveProjectNotes(
  notes: Pick<NotesRepo, "put"> & Partial<Pick<NotesRepo, "get">>,
  repo: string,
  previous: string,
  reported: string,
  redact: (text: string) => string = (text) => text,
): Promise<boolean> {
  let text = notesToSave(previous, redact(reported));
  if (text === null) return false;
  try {
    // The notes may have changed while the team worked (up to ~50 minutes): re-read and keep additions.
    const current = notes.get ? ((await notes.get(repo))?.text ?? "") : previous;
    text = notesToSave("", mergeConcurrentNotes(previous, current, text)) ?? text;
    const result = await notes.put(repo, text);
    if (!result.ok) throw new Error(result.error);
    return true;
  } catch (err) {
    console.error(`[worker] could not save project notes: ${redact(err instanceof Error ? err.message : String(err))}`);
    return false;
  }
}

/** Keep credentials out of anything we log, store or post. */
export function makeRedactor(secrets: (string | undefined)[]) {
  // Longest first: a short secret inside a longer one must not leave the rest of the longer one readable.
  const needles = [...new Set(secrets.filter((s): s is string => Boolean(s && s.length >= 6)))].sort((a, b) => b.length - a.length);
  return (text: string) => needles.reduce((acc, s) => acc.split(s).join("[redacted]"), text);
}

/**
 * Every credential the config holds, for makeRedactor: Claude, Slack and
 * monday.com, the GitHub webhook secret, every GitHub connection's token (not
 * only the one in use), each also in the form git sends it (the Basic auth
 * header and its value), and the values of every repository's setup
 * variables (any of them may be a secret; makeRedactor skips very short ones).
 */
export function configSecrets(c: Config): (string | undefined)[] {
  const github = githubTokens(c).flatMap((token) => {
    const header = new GitHub(token).gitAuthHeader();
    return [token, header, header.split(" ").pop()];
  });
  // Repo variables are redacted unless they are plainly not secret (a word like "development", a port):
  // hiding those would garble every Slack message and PR text that happens to contain the word.
  const repoEnv = Object.values(c.repoSetup)
    .flatMap((setup) => Object.values(setup.env))
    .filter((value) => !/^(?:[A-Za-z]+|\d+)$/.test(value.trim()));
  return [c.anthropic.apiKey, c.slack.botToken, c.slack.signingSecret, c.monday.token, c.github.webhookSecret, ...github, ...repoEnv];
}

/**
 * The GitHub token a task on `repo` uses: the connection allowed to work on it
 * (the most specific allow-list match), or why there is none.
 */
export function taskGitHubToken(config: Config, repo: string): { ok: true; token: string } | { ok: false; error: string } {
  const token = connectionForRepo(config, repo)?.token;
  if (token) return { ok: true, token };
  return { ok: false, error: `No GitHub connection is allowed to work on ${repo}; add one on the admin page.` };
}

/** Used only when the token owner cannot be looked up: a reserved domain, so GitHub links it to nobody. */
export const FALLBACK_COMMIT_EMAIL = "pointer@agent-army.invalid";

/**
 * Who the task's commits are authored by. The email is the token owner's
 * GitHub noreply address, so GitHub and Vercel attribute the commits to the
 * account that pushes them and opens the pull request. A Vercel team blocks
 * Git deployments whose commit author is not a member, and an address like
 * "agent-army@users.noreply.github.com" would belong to an unrelated GitHub
 * user named agent-army.
 */
export function commitIdentity(
  pointerName: string,
  viewer: { id: number; login: string } | undefined,
): { name: string; email: string } {
  if (!viewer || !Number.isInteger(viewer.id) || viewer.id <= 0 || !/^[A-Za-z0-9-]+$/.test(viewer.login)) {
    return { name: pointerName, email: FALLBACK_COMMIT_EMAIL };
  }
  return { name: `${pointerName} (via ${viewer.login})`, email: `${viewer.id}+${viewer.login}@users.noreply.github.com` };
}

// ---------- Pull request texts ----------

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The draft pull request's title for unfinished work: the request's first line, short. */
export function wipTitle(instruction: string): string {
  const first = instruction
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return "WIP: unfinished task";
  return `WIP: ${first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first}`;
}

/** The lead's plan as a Markdown checklist; the step in progress is marked ▶. */
export function planChecklist(plan: PlanItem[]): string {
  const line = (p: PlanItem) =>
    p.status === "completed" ? `- [x] ${p.content}` : p.status === "in_progress" ? `- [ ] ▶ ${p.content}` : `- [ ] ${p.content}`;
  return plan.map(line).join("\n");
}

/** The last part of every pull request body the platform writes. */
export function prFooter(taskId: string, pointerName: string): string {
  return `---\nRequested in Slack · task \`${taskId}\` · built by ${pointerName} and the team. A human must review and merge.`;
}

/** Points reviewers to the screenshots posted in Slack, or "" when there are none. */
export function screenshotsSection(count: number): string {
  if (!count) return "";
  return `### Screenshots\n${plural(count, "screenshot")} from the browser checks ${count === 1 ? "is" : "are"} in the Slack thread.`;
}

const CONTINUE_HINT = 'Reply in the Slack thread (for example "continue") to pick it up on this branch.';

/** The body of the draft pull request that keeps a stopped task's work. */
export function draftPrBody(o: { reason: string; plan: PlanItem[]; filesChanged: number; screenshots: number; footer: string }): string {
  return [
    `**Stopped early:** ${o.reason}`,
    "The team did not finish this task; this draft keeps its work so far.",
    o.plan.length ? `### Plan\n${planChecklist(o.plan)}` : "",
    `${plural(o.filesChanged, "file")} changed.`,
    CONTINUE_HINT,
    screenshotsSection(o.screenshots),
    o.footer,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Posted on an open pull request when a follow-up on it stopped early. */
export function stoppedComment(reason: string, plan: PlanItem[]): string {
  return [`**Stopped early:** ${reason}`, plan.length ? planChecklist(plan) : "", CONTINUE_HINT].filter(Boolean).join("\n\n");
}

/** The Slack result when a stopped task's work was saved in a pull request. */
export function stoppedSlackText(o: { userId: string; reason: string; pr: Pick<PrRef, "html_url" | "number" | "draft">; cost: string }): string {
  const where = o.pr.draft ? "a draft pull request" : "the pull request";
  return `:warning: <@${o.userId}> Stopped: ${o.reason} The unfinished work is saved in ${where}: <${o.pr.html_url}|#${o.pr.number}>. Reply here (for example "continue") to pick it up on the same branch.${o.cost}`;
}

/** Posted on the pull request after a fix round pushed. */
export function fixComment(round: number, report: Pick<Report, "title" | "summary" | "verification">): string {
  return [
    `**Fixed failing checks (round ${round}):** ${report.title}`,
    report.summary,
    report.verification && `### Verification\n${report.verification}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const MISSING_FILES_WRITE =
  "Screenshots could not be posted: the Slack app needs the files:write scope (update the app from the admin page).";

/** The line added to the Slack result when the screenshots could not be uploaded. */
export function screenshotFailureLine(code: string | undefined): string {
  if (code === "missing_scope" || code === "not_allowed_token_type") return MISSING_FILES_WRITE;
  return `Screenshots could not be posted${code ? ` (${code})` : ""}.`;
}

/** "$15", or "$3.20" for a remaining budget. */
export const usd = (amount: number) => (Number.isInteger(amount) ? `$${amount}` : `$${amount.toFixed(2)}`);

// ---------- The task's prompt ----------

/** The first message of a task: the request, where the team is, and what an earlier run or the pull request left for it. */
export function taskPrompt(o: {
  userId: string;
  instruction: string;
  trigger?: Task["trigger"];
  repo: string;
  base: string;
  branch: string;
  resumed: boolean;
  attachments: number;
  /** The previous run on this branch stopped before finishing. */
  stopped?: ThreadState["stopped"];
  /** formatFeedback's section, or "". */
  feedback?: string;
}): string {
  const lines = [
    `Request from ${o.trigger === "review" ? "GitHub" : "Slack"} (user ${o.userId}):`,
    o.instruction,
    "",
    `Repository: ${o.repo}. Base branch: ${o.base}. You are on branch: ${o.branch}.`,
    o.resumed
      ? "This is a follow-up in an existing thread: the branch already contains the team's earlier work (see `git log`). Build on it."
      : "This is a fresh branch off the base branch.",
  ];
  if (o.resumed && o.stopped) {
    lines.push(
      `The previous run stopped early (${o.stopped.reason.replace(/\.$/, "")}; at ${o.stopped.at}). Its unfinished work is on this branch: check \`git log\` and \`git diff origin/${o.base}...HEAD\`, then continue where it left off.`,
    );
  }
  if (o.trigger === "review") lines.push("This follow-up was started by feedback on the pull request, not by a message in Slack.");
  if (o.attachments) {
    lines.push(`The requester shared ${o.attachments} file(s) for this task: see "Files shared for this task" in your instructions.`);
  }
  if (o.feedback) lines.push("", o.feedback);
  return lines.join("\n");
}

// ---------- Time ----------

/** Kept free before the job's hard limit (JOB_TIMEOUT_MIN) to publish and report. */
const JOB_MARGIN_MS = 8 * 60_000;
export const FIX_RUN_MAX_MS = 25 * 60_000;
/** A fix round needs at least this much time before the deadline. */
export const FIX_ROUND_MIN_LEFT_MS = 10 * 60_000;

/** When everything must be done: the job's limit (JOB_TIMEOUT_MIN) minus a margin; undefined = no job limit. */
export function jobDeadline(workerStart: number, jobTimeoutMin: string | undefined): number | undefined {
  if (!jobTimeoutMin?.trim()) return undefined;
  const minutes = Number(jobTimeoutMin);
  return Number.isFinite(minutes) && minutes > 0 ? workerStart + minutes * 60_000 - JOB_MARGIN_MS : undefined;
}

/** TASK_TIMEOUT_MIN as a positive number of minutes; unset, empty or invalid means the default of 50. */
export function taskTimeoutMin(value: string | undefined): number {
  const minutes = Number(value);
  return value?.trim() && Number.isFinite(minutes) && minutes > 0 ? minutes : 50;
}

/** How long the first team run may take: TASK_TIMEOUT_MIN, capped by the deadline (at least a minute). */
export function firstRunTimeoutMs(taskTimeoutMin: number, deadline: number | undefined, now: number): number {
  const own = taskTimeoutMin * 60_000;
  return deadline === undefined ? own : Math.max(60_000, Math.min(own, deadline - now));
}

/** How long a fix round may take, or null when too little time is left to start one. */
export function fixRunTimeoutMs(deadline: number | undefined, now: number): number | null {
  if (deadline === undefined) return FIX_RUN_MAX_MS;
  const left = deadline - now;
  if (left < FIX_ROUND_MIN_LEFT_MS) return null;
  // The rest is for waiting on the checks of the fix and reporting.
  return Math.min(FIX_RUN_MAX_MS, left - JOB_MARGIN_MS);
}

// ---------- Thread state ----------

/**
 * What the thread remembers after a task, or null to leave it alone: the new
 * pull request when the task published (a stop is kept only for a draft of
 * unfinished work), else the previous state of the same repository with the
 * new `lastRunAt`. The requester is the one who started the thread.
 */
export function threadStateAfter(
  previous: ThreadState | null,
  run: {
    repo: string;
    branch: string;
    userId: string;
    lastRunAt: string;
    pr?: { url: string; number: number };
    stopped?: ThreadState["stopped"];
  },
): ThreadState | null {
  const requester = previous?.requester ?? run.userId;
  if (run.pr) {
    return {
      repo: run.repo,
      branch: run.branch,
      prUrl: run.pr.url,
      prNumber: run.pr.number,
      requester,
      lastRunAt: run.lastRunAt,
      ...(run.stopped ? { stopped: run.stopped } : {}),
    };
  }
  if (previous?.repo === run.repo) return { ...previous, requester, lastRunAt: run.lastRunAt };
  return null;
}

/** A run of the team: its report or why it has none, what it cost, and its plan at the end. */
interface TeamRun {
  report?: Report;
  failure?: string;
  costUsd: number;
  turns: number;
  plan: PlanItem[];
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Identifies a screenshot already posted: a later one saved under the same name is new. */
const screenshotKey = (s: Screenshot) => `${s.name}:${createHash("sha256").update(s.bytes).digest("hex")}`;

/** Added to "Done" in the progress message when the checks did not pass. */
const CHECKS_OUTCOME: Record<CiOutcome["state"], string> = {
  passed: "",
  none: "",
  failed: " (checks failing)",
  pending: " (checks still running)",
  unavailable: " (checks not readable)",
};

async function main(): Promise<void> {
  const payload = process.env.TASK_B64;
  if (!payload) throw new Error("TASK_B64 is not set; the worker is started by the server, not by hand.");
  const { taskId } = decodeTaskPayload(payload);

  const store = createStore();
  const masterKey = await resolveMasterKey(store);
  const config = await new ConfigRepo(store, masterKey).load(true);
  // Kept in the store, never in the checkout: the worker commits the whole tree.
  const notes = new NotesRepo(store, masterKey);
  const tasks = new TaskRepo(store);
  const task = await tasks.get(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const { apiKey } = config.anthropic;
  const { botToken } = config.slack;
  if (!apiKey || !botToken) throw new Error("Onboarding is incomplete (Claude or Slack missing).");

  const pointerName = config.team.pointer.name;
  const slack = slackClient(botToken);
  // Every credential, including every GitHub connection's token, not only this task's.
  const redact = makeRedactor(configSecrets(config));

  let lastProgress = 0;
  const progress = async (text: string, force = false) => {
    if (!force && Date.now() - lastProgress < 4000) return;
    lastProgress = Date.now();
    const body = { channel: task.channel, text: truncate(text) };
    try {
      if (task.progressTs) await slack.chat.update({ ...body, ts: task.progressTs });
      else task.progressTs = (await slack.chat.postMessage({ ...body, thread_ts: task.threadTs })).ts;
    } catch (err) {
      console.error("[worker] slack update failed:", redact(String(err)));
    }
  };

  // The result is a new thread message, so Slack notifies the requester (edits never do);
  // the progress message keeps a one-line outcome pointing at it.
  const workerStart = Date.now();
  // Everything (the team's runs, waiting for checks, fix rounds) ends before the job's own limit.
  const deadline = jobDeadline(workerStart, process.env.JOB_TIMEOUT_MIN);
  const finish = async (text: string, outcome: string) => {
    const minutes = Math.max(1, Math.round((Date.now() - workerStart) / 60_000));
    await progress(`${outcome} after ${minutes} min. The result is below.`, true);
    try {
      await slack.chat.postMessage({ channel: task.channel, thread_ts: task.threadTs, text: truncate(redact(text)) });
    } catch (err) {
      console.error("[worker] result not posted:", redact(String(err)));
      await progress(redact(text), true);
    }
  };

  // The connection allowed to work on this repository clones, pushes and opens the pull request.
  const access = taskGitHubToken(config, task.repo);
  if (!access.ok) {
    task.status = "failed";
    task.error = access.error;
    await tasks.save(task);
    await progress(`:x: <@${task.userId}> ${access.error}`, true);
    process.exitCode = 1;
    return;
  }
  const github = new GitHub(access.token);
  const authHeader = github.gitAuthHeader();

  // Real path: the agents' file tools are given folders by path and do not follow links.
  const workRoot = await realpath(await mkdtemp(join(process.env.WORK_DIR ?? tmpdir(), "army-")));
  const repoDir = join(workRoot, "repo");
  // Files shared in the thread: next to the checkout, never inside it, so `git add -A` cannot commit them.
  const attachmentsDir = join(workRoot, "attachments");
  // Screenshots from the browser checks: next to the checkout too, posted in the thread after the task.
  const shotsDir = join(workRoot, "screenshots");
  const git = async (args: string[], opts: { auth?: boolean; cwd?: string } = {}) => {
    const full = opts.auth ? ["-c", `http.https://github.com/.extraheader=${authHeader}`, ...args] : args;
    try {
      const { stdout } = await exec("git", full, {
        cwd: opts.cwd ?? repoDir,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return stdout.trim();
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      throw new Error(redact(`git ${args[0]} failed: ${e.stderr?.trim() || e.message}`));
    }
  };

  task.status = "running";
  await tasks.save(task);

  // The first run of the team (with the checkout and setup before it) stops at TASK_TIMEOUT_MIN, or earlier at the deadline.
  const abort = new AbortController();
  const firstRunMs = firstRunTimeoutMs(taskTimeoutMin(process.env.TASK_TIMEOUT_MIN), deadline, workerStart);
  const timer = setTimeout(() => abort.abort(), firstRunMs);

  try {
    // ---------- 1. Check out the project ----------
    await progress(`:package: Cloning \`${task.repo}\`…`, true);
    const base = await github.defaultBranch(task.repo);
    await git(["clone", "--depth", "50", "--no-tags", `https://github.com/${task.repo}.git`, repoDir], {
      auth: true,
      cwd: workRoot,
    });
    const viewer = await github.viewer().catch((err: unknown) => {
      console.error("[worker] could not look up the token owner:", redact(String(err)));
      return undefined;
    });
    const author = commitIdentity(pointerName, viewer);
    await git(["config", "user.name", author.name]);
    await git(["config", "user.email", author.email]);

    // A follow-up in the same Slack thread keeps building on the same branch.
    const thread = await tasks.getThread(task.channel, task.threadTs);
    const prior = thread?.repo === task.repo ? thread : null;
    let branch = prior ? prior.branch : branchName(task.instruction, task.id);
    let resumed = false;
    if (prior) {
      try {
        await git(["fetch", "--depth", "50", "origin", branch], { auth: true });
        await git(["checkout", "-B", branch, "FETCH_HEAD"]);
        resumed = true;
      } catch {
        branch = branchName(task.instruction, task.id); // old branch merged or deleted
      }
    }
    if (!resumed) await git(["checkout", "-b", branch]);
    const startSha = await git(["rev-parse", "HEAD"]);
    task.branch = branch;
    await tasks.save(task);

    // ---------- 2. Prepare: the owner's setup, shared files, the browser, review feedback ----------
    const setup = findRepoSetup(config, task.repo);
    // Replaces the environment: the agents' shell sees none of the platform's own
    // secrets (master key, Slack and GitHub tokens), only the owner's variables for
    // this repository, which cannot override the platform's own names.
    const agentEnv: Record<string, string> = {
      ...setupEnv(setup),
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "/tmp",
      LANG: process.env.LANG ?? "C.UTF-8",
      CI: "1",
      ANTHROPIC_API_KEY: apiKey,
      CLAUDE_AGENT_SDK_CLIENT_APP: "agent-army/0.1.0",
    };
    let setupResult: SetupResult | undefined;
    const setupCommand = setup?.setupCommand.trim();
    if (setupCommand) {
      await progress(":wrench: Running the repo's setup command…", true);
      // Never throws; a failed setup is reported to the team, which decides what to do about it.
      setupResult = await runSetupCommand(setupCommand, { cwd: repoDir, env: agentEnv, redact });
      console.log(`[worker] setup command ${setupResult.ok ? "succeeded" : "failed"} after ${setupResult.seconds}s`);
    }

    const dataDir = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : "";
    const bashGuard: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return {};
      const command = String((input.tool_input as { command?: unknown })?.command ?? "");
      const reason = checkBashCommand(command, [dataDir]);
      if (!reason) return {};
      return {
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
      };
    };

    // Designs and screenshots shared in the thread (Slack or monday.com). Unreadable files are skipped, not fatal.
    const attachments = await materializeAttachments(
      new AttachmentRepo(store, masterKey),
      { channel: task.channel, threadTs: task.threadTs },
      attachmentsDir,
    ).catch((err: unknown): SharedFile[] => {
      console.error(`[worker] could not load shared files: ${redact(err instanceof Error ? err.message : String(err))}`);
      return [];
    });

    // Agents that can run commands get a headless browser when this worker has one.
    await mkdir(shotsDir, { recursive: true });
    const browser = browserAvailable() ? browserServer(shotsDir) : undefined;

    // Reviews and comments on the pull request since the last run, by people with write access.
    // Feedback written from now on is new to the next run (see lastRunAt below).
    const seenAt = new Date().toISOString();
    let feedback = "";
    if (resumed && prior?.prNumber) {
      try {
        const items = (await github.prFeedback(task.repo, prior.prNumber)).filter((f) => isHumanFeedback(f, prior.lastRunAt));
        feedback = redact(formatFeedback(items, { prNumber: prior.prNumber, prUrl: prior.prUrl }));
      } catch (err) {
        console.error(`[worker] could not read the pull request's feedback: ${redact(errorText(err))}`);
      }
    }

    const prompt = taskPrompt({
      userId: task.userId,
      instruction: task.instruction,
      trigger: task.trigger,
      repo: task.repo,
      base,
      branch,
      resumed,
      attachments: attachments.length,
      stopped: prior?.stopped,
      feedback,
    });

    const sharedNote = attachments.length ? ` and ${attachments.length} shared file${attachments.length === 1 ? "" : "s"}` : "";
    await progress(`:compass: ${pointerName} is reading \`${task.repo}\`${sharedNote} and planning…`, true);

    // What earlier tasks learned about this repo. Unreadable notes are skipped, not fatal.
    const loadNotes = () =>
      notes.get(task.repo).then(
        (n) => n?.text ?? "",
        (err: unknown) => {
          console.error(`[worker] could not load project notes: ${redact(errorText(err))}`);
          return "";
        },
      );
    const projectNotes = await loadNotes();

    const context: OrchestratorContext = {
      projectNotes,
      attachments,
      ...(browser ? { browser: { shotsDir } } : {}),
      ...(setup ? { repoSetup: repoSetupContext(setup, setupResult) } : {}),
    };

    const everyMin = config.limits.progressEveryMin;
    // Read-only and lock-free, so it never gets in the way of the agents' own git commands.
    const changedFiles = async (since: string) => {
      const [tracked, untracked] = await Promise.all([
        git(["--no-optional-locks", "diff", "--name-only", since]),
        git(["--no-optional-locks", "ls-files", "--others", "--exclude-standard"]),
      ]);
      return [...new Set([...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean))];
    };
    const push = () => git(["push", "origin", `HEAD:refs/heads/${branch}`], { auth: true });

    /**
     * One run of the team on `runPrompt`: the first run, then each round of
     * fixing failing checks. Each run has its own live progress: the progress
     * message becomes a dashboard, the task record keeps a copy for Pointer,
     * and an update is posted in the thread every few minutes.
     */
    const runTeam = async (
      runPrompt: string,
      opts: {
        budgetUsd: number;
        abort: AbortController;
        /** For the message when `abort` fires. */
        timeoutMin: number;
        /** Files changed since this commit are shown as progress. */
        since: string;
        context: OrchestratorContext;
        /** What the dashboard says the team is doing before its first step. */
        phaseLabel?: string;
      },
    ): Promise<TeamRun> => {
      const tracker = new ProgressTracker({
        lead: pointerName,
        label: (type) => subagentLabel(config.team, type),
        repoDir,
      });
      if (opts.phaseLabel) tracker.setPhase(opts.phaseLabel);
      let lastSaved = 0;
      const saveProgress = async (force = false) => {
        if (!force && Date.now() - lastSaved < 30_000) return;
        lastSaved = Date.now();
        task.progress = tracker.snapshot();
        await tasks.save(task).catch((err: unknown) => console.error("[worker] progress not saved:", redact(String(err))));
      };
      let updating: Promise<void> = Promise.resolve();
      const postUpdate = () => {
        updating = updating
          .then(async () => {
            tracker.setFiles(await changedFiles(opts.since).catch(() => []));
            await saveProgress(true);
            await slack.chat.postMessage({
              channel: task.channel,
              thread_ts: task.threadTs,
              text: truncate(redact(formatProgress(tracker.snapshot(), { kind: "update" }))),
            });
          })
          .catch((err: unknown) => console.error("[worker] progress update failed:", redact(String(err))));
      };
      const updateTimer = everyMin > 0 ? setInterval(postUpdate, everyMin * 60_000) : undefined;

      let report: Report | undefined;
      let failure: string | undefined;
      let costUsd = 0;
      let turns = 0;
      try {
        for await (const message of query({
          prompt: runPrompt,
          options: {
            cwd: repoDir,
            abortController: opts.abort,
            ...teamQueryOptions(config, opts.context, attachmentsDir, { browser }),
            // Headless: nothing can prompt, so anything not in allowedTools is denied.
            permissionMode: "dontAsk",
            settingSources: ["project"], // loads the project's own CLAUDE.md
            hooks: { PreToolUse: [{ matcher: "Bash", hooks: [bashGuard] }] },
            outputFormat: { type: "json_schema", schema: REPORT_SCHEMA },
            maxTurns: config.limits.maxTurns,
            maxBudgetUsd: opts.budgetUsd,
            ...(config.anthropic.model ? { model: config.anthropic.model } : {}),
            env: agentEnv,
          },
        })) {
          if (tracker.onMessage(message)) {
            await progress(redact(formatProgress(tracker.snapshot(), { kind: "live", everyMin })));
            await saveProgress();
          }
          if (message.type === "result") {
            costUsd = message.total_cost_usd;
            turns = message.num_turns;
            if (message.subtype === "success" && !message.is_error) {
              report = parseReport(message.structured_output, message.result);
            } else if (message.subtype === "success") {
              // e.g. a rejected API key arrives as a "success" result flagged is_error
              failure = `The team could not run: ${message.result || "unknown error"}.`;
            } else {
              const why: Record<string, string> = {
                error_max_turns: `hit the ${config.limits.maxTurns}-turn limit`,
                error_max_budget_usd: `hit the ${usd(opts.budgetUsd)} budget limit`,
              };
              failure = `The team stopped early: ${why[message.subtype] ?? (message.errors.join("; ") || message.subtype)}.`;
            }
          }
        }
      } catch (err) {
        // The SDK also throws after an error result; keep the more specific message.
        failure ??= redact(`The team could not run: ${errorText(err)}`);
      } finally {
        // No progress save may land after the final status below.
        clearInterval(updateTimer);
        await updating;
      }
      if (opts.abort.signal.aborted) failure = `Timed out after ${opts.timeoutMin} minutes.`;
      if (!report && !failure) failure = "The team finished without a report.";
      const final = tracker.snapshot();
      task.progress = final;
      return { report, failure: failure && redact(failure), costUsd, turns, plan: final.plan };
    };

    /**
     * After a push: wait for the pull request's checks and, while they fail
     * and rounds, budget and time are left, let the team fix them, push the
     * fix and wait again. Returns the last outcome and, when the team could
     * not fix them, why.
     */
    const followChecks = async (pr: PrRef): Promise<{ outcome: CiOutcome; note?: string } | undefined> => {
      const { ciWaitMin, ciFixRounds: rounds, maxBudgetUsd } = config.limits;
      let fixRounds = 0;
      let last: CiOutcome | undefined;
      for (;;) {
        const waitMs = Math.min(ciWaitMin * 60_000, deadline === undefined ? Infinity : deadline - Date.now());
        if (waitMs < 60_000) return last && { outcome: last, note: "No time was left to wait for the checks after the last fix." };
        await progress(":hourglass_flowing_sand: Waiting for the pull request's checks…", true);
        const sha = await git(["rev-parse", "HEAD"]);
        const wait = await waitForChecks(github, task.repo, sha, { waitMs });
        last = ciSummary(wait, fixRounds);
        if (wait.state !== "failed" || fixRounds >= rounds) return { outcome: last };

        const budgetUsd = maxBudgetUsd - (task.costUsd ?? 0);
        if (budgetUsd < 1) return { outcome: last, note: "Not enough of the task's budget was left to fix them." };
        const fixMs = fixRunTimeoutMs(deadline, Date.now());
        if (fixMs === null) return { outcome: last, note: "Not enough time was left to fix them." };

        fixRounds += 1;
        const round = `round ${fixRounds} of ${rounds}`;
        await progress(`:wrench: Checks failed (${truncate(last.names.join(", "), 200)}): the team is fixing them (${round})…`, true);
        const details = await ciFailureDetails(github, task.repo, wait, redact);
        const notesBefore = await loadNotes();
        const fixAbort = new AbortController();
        const fixTimer = setTimeout(() => fixAbort.abort(), fixMs);
        const run = await runTeam(ciFixPrompt(details, { round: fixRounds, rounds, base, branch, request: task.instruction }), {
          budgetUsd,
          abort: fixAbort,
          timeoutMin: Math.round(fixMs / 60_000),
          since: sha,
          context: { ...context, projectNotes: notesBefore },
          phaseLabel: `Fixing the failing checks (${round})`,
        }).finally(() => clearTimeout(fixTimer));
        task.costUsd = (task.costUsd ?? 0) + run.costUsd;
        task.turns = (task.turns ?? 0) + run.turns;
        last = ciSummary(wait, fixRounds);
        if (run.report) await saveProjectNotes(notes, task.repo, notesBefore, run.report.projectNotes, redact);

        // An unfinished or blocked fix is not pushed: the pull request keeps its last complete state.
        if (!run.report || run.failure) return { outcome: last, note: `Fixing the checks stopped early: ${run.failure}` };
        if (run.report.kind === "blocked") {
          return { outcome: last, note: `*Checks blocked: ${run.report.title}* ${toMrkdwn(truncate(run.report.summary, 800))}` };
        }
        await git(["add", "-A"]);
        if ((await git(["status", "--porcelain"])) !== "") await git(["commit", "-m", `Fix failing checks: ${run.report.title}`]);
        if (Number(await git(["rev-list", "--count", `${sha}..HEAD`])) === 0) {
          return { outcome: last, note: "The team changed nothing for the failing checks." };
        }
        await progress(":rocket: Pushing the fix…", true);
        await push();
        await github
          .commentOnPr(task.repo, pr.number, redact(fixComment(fixRounds, run.report)))
          .catch((err: unknown) => console.error(`[worker] fix comment not posted: ${redact(errorText(err))}`));
      }
    };

    // ---------- 3. Let the team work ----------
    const first = await runTeam(prompt, {
      budgetUsd: config.limits.maxBudgetUsd,
      abort,
      timeoutMin: Math.round(firstRunMs / 60_000),
      since: startSha,
      context,
    });
    clearTimeout(timer);
    task.costUsd = first.costUsd;
    task.turns = first.turns;
    const { report, failure } = first;

    // Saved before publishing so a failed push doesn't lose what the team learned (blocked reports too).
    if (report) await saveProjectNotes(notes, task.repo, projectNotes, report.projectNotes, redact);

    // ---------- 4. Publish ----------
    await git(["add", "-A"]);
    const dirty = (await git(["status", "--porcelain"])) !== "";
    if (dirty) await git(["commit", "-m", failure || !report ? `Work in progress (stopped early): ${failure}` : report.title]);
    const ahead = Number(await git(["rev-list", "--count", `${startSha}..HEAD`]));

    // Screenshots go up first, so the pull request can point to them.
    const posted = new Set<string>();
    const resultNotes: string[] = [];
    const postScreenshots = async (comment: (count: number) => string) => {
      const shots = (await collectScreenshots(shotsDir)).filter((s) => !posted.has(screenshotKey(s)));
      if (!shots.length) return;
      try {
        await uploadThreadFiles(slack, {
          channel: task.channel,
          threadTs: task.threadTs,
          comment: comment(shots.length),
          files: shots.map((s) => ({ filename: s.name, data: s.bytes })),
        });
        for (const s of shots) posted.add(screenshotKey(s));
        task.screenshots = posted.size;
      } catch (err) {
        const code = slackErrorCode(err);
        console.error(`[worker] screenshots not posted: ${redact(code ?? errorText(err))}`);
        const line = screenshotFailureLine(code);
        if (!resultNotes.includes(line)) resultNotes.push(line);
      }
    };
    await postScreenshots((n) => `:camera: ${plural(n, "screenshot")} from the browser checks.`);

    const cost = () => (task.costUsd !== undefined ? ` · ~$${task.costUsd.toFixed(2)}` : "");
    const footer = prFooter(task.id, pointerName);
    // Never fails the task: the pull request is already there.
    const saveThreadState = async (state: ThreadState | null) => {
      if (!state) return;
      try {
        await tasks.saveThread(task.channel, task.threadTs, state);
        if (state.prNumber) await tasks.savePrThread(state.repo, state.prNumber, { channel: task.channel, threadTs: task.threadTs });
      } catch (err) {
        console.error(`[worker] thread state not saved: ${redact(errorText(err))}`);
      }
    };
    const nextThreadState = (pr?: PrRef, stopped?: ThreadState["stopped"]) =>
      threadStateAfter(thread, {
        repo: task.repo,
        branch,
        userId: task.userId,
        lastRunAt: seenAt,
        ...(pr ? { pr: { url: pr.html_url, number: pr.number } } : {}),
        ...(stopped ? { stopped } : {}),
      });

    if (failure || !report) {
      // ---------- Stopped early: the work so far goes into a draft pull request ----------
      const reason = failure ?? "The team finished without a report.";
      let saved: PrRef | undefined;
      let pushed = false;
      if (ahead > 0) {
        try {
          await progress(":rocket: Saving the unfinished work in a draft pull request…", true);
          await push();
          pushed = true;
          const existing = await github.findOpenPr(task.repo, branch);
          if (existing) {
            await github.commentOnPr(task.repo, existing.number, redact(stoppedComment(reason, first.plan)));
            saved = existing;
          } else {
            const filesChanged = (await git(["diff", "--name-only", startSha, "HEAD"])).split("\n").filter(Boolean).length;
            saved = await github.createPr(task.repo, {
              title: redact(wipTitle(task.instruction)),
              body: redact(draftPrBody({ reason, plan: first.plan, filesChanged, screenshots: posted.size, footer })),
              head: branch,
              base,
              draft: true,
            });
          }
        } catch (err) {
          console.error(`[worker] unfinished work not published: ${redact(errorText(err))}`);
          saved = undefined;
        }
      }

      task.status = "failed";
      task.error = reason;
      if (saved) {
        task.prUrl = saved.html_url;
        await saveThreadState(nextThreadState(saved, { reason, at: new Date().toISOString() }));
        const text = stoppedSlackText({ userId: task.userId, reason, pr: saved, cost: cost() });
        await finish([text, ...resultNotes].join("\n\n"), ":warning: Stopped");
      } else {
        await saveThreadState(nextThreadState());
        const partial = !ahead
          ? ""
          : pushed
            ? ` The unfinished work is on branch \`${branch}\`, but no pull request could be opened.`
            : " Partial work was not published.";
        await finish([`:x: <@${task.userId}> ${reason}${partial}${cost()}`, ...resultNotes].join("\n\n"), ":x: Stopped");
      }
    } else {
      const publish = ahead > 0 && report.kind !== "blocked";
      let pr: PrRef | undefined;
      let ci: { outcome: CiOutcome; note?: string } | undefined;

      if (publish) {
        await progress(":rocket: Publishing the branch and opening the pull request…", true);
        await push();
        const prBody = redact(
          [
            report.summary,
            report.verification && `### Verification\n${report.verification}`,
            report.risks && `### Risks and follow-ups\n${report.risks}`,
            screenshotsSection(posted.size),
            footer,
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
        const existing = await github.findOpenPr(task.repo, branch);
        if (existing) {
          await github.commentOnPr(task.repo, existing.number, `**Update: ${redact(report.title)}**\n\n${prBody}`);
          pr = existing;
          // Unfinished work kept in a draft is finished now: ready for review, with the
          // finished work's title and description instead of the "WIP: …" ones.
          if (existing.draft) {
            await github
              .markReadyForReview(existing.node_id)
              .then(() => github.updatePr(task.repo, existing.number, { title: redact(report.title), body: prBody }))
              .catch((err: unknown) => console.error(`[worker] could not mark the pull request ready: ${redact(errorText(err))}`));
          }
        } else {
          pr = await github.createPr(task.repo, { title: redact(report.title), body: prBody, head: branch, base });
        }
        // Saved now, not at the end: waiting for the checks can take a while.
        await saveThreadState(nextThreadState(pr));

        if (config.limits.ciWaitMin > 0) {
          try {
            ci = await followChecks(pr);
          } catch (err) {
            // The pull request is open; only the follow-up on its checks broke (e.g. a fix could not be pushed).
            const message = redact(errorText(err));
            console.error(`[worker] checks not followed: ${message}`);
            resultNotes.push(`Following the pull request's checks failed: ${truncate(message, 300)}`);
          }
          // Only fix rounds can have added any; those already posted are skipped.
          await postScreenshots((n) => `:camera: ${plural(n, "more screenshot")} from fixing the checks.`);
        }
      } else {
        await saveThreadState(nextThreadState());
      }

      // ---------- 5. Report ----------
      task.status = "done";
      task.kind = publish ? "change" : report.kind;
      task.summary = report.summary;
      task.prUrl = publish ? pr?.html_url : undefined;
      const storedCi = ci && storedCiSummary(ci.outcome);
      if (storedCi) task.ci = storedCi;
      const head =
        report.kind === "blocked"
          ? `:warning: <@${task.userId}> *Blocked: ${report.title}*`
          : publish
            ? `:white_check_mark: <@${task.userId}> *${report.title}* — <${pr?.html_url}|review the pull request>`
            : `:speech_balloon: <@${task.userId}> *${report.title}*`;
      const parts = [
        head,
        toMrkdwn(report.summary),
        report.verification && `*Verification:* ${toMrkdwn(report.verification)}`,
        report.risks && `*Risks:* ${toMrkdwn(report.risks)}`,
        ci && ciSummaryLine(ci.outcome, config.limits.ciWaitMin),
        ci?.note,
        ...resultNotes,
        `_${task.repo} · \`${branch}\`${cost()}_`,
      ];
      const checksNote = ci ? CHECKS_OUTCOME[ci.outcome.state] : "";
      const outcome =
        report.kind === "blocked" ? ":warning: Blocked" : publish ? `:white_check_mark: Done${checksNote}` : ":speech_balloon: Answered";
      await finish(parts.filter(Boolean).join("\n\n"), outcome);
    }
    await tasks.save(task);
  } catch (err) {
    const messageText = redact(err instanceof Error ? err.message : String(err));
    console.error("[worker] task failed:", messageText);
    task.status = "failed";
    task.error = messageText;
    await tasks.save(task);
    await finish(`:x: <@${task.userId}> The task failed: ${truncate(messageText, 600)}`, ":x: Failed");
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    await rm(workRoot, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("worker.js")) {
  main().catch((err) => {
    console.error("[worker] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
