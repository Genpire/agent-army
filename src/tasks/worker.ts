import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
} from "../team/agents.js";
import { AttachmentRepo, type ThreadRef, classify, expandZip } from "../chat/attachments.js";
import { Spending, agentNamer, perTaskCapUsd, teamWithout } from "../spending/budget.js";
import { LEAD_AGENT_ID } from "../spending/attribution.js";
import { runtimePrices } from "../spending/prices.js";
import { TaskSpend } from "../spending/task-spend.js";
import { type Screenshot, browserAvailable, browserServer, collectScreenshots } from "./browser.js";
import { type CiOutcome, type WaitOptions, ciFailureDetails, ciFixPrompt, ciSummary, ciSummaryLine, storedCiSummary, waitForChecks } from "./ci.js";
import { type ProviderSession, providerProblem, providerRuntime, secretParts } from "../ai/ai-providers.js";
import { repoTaskApps } from "../integrations/apps/apps.js";
import { repoTaskEngines, runCli } from "../ai/engines.js";
import type { CodeHost } from "../integrations/code-hosts/code-host.js";
import { allHostSecrets, codeHostFor } from "../integrations/code-hosts/code-host-factory.js";
import { type Config, ConfigRepo, integrationSecrets, resolveMasterKey } from "../core/config.js";
import { type PrRef, isHumanFeedback } from "../integrations/github/github.js";
import { checkBashCommand } from "./guard.js";
import { NOTES_MAX_CHARS, NotesRepo } from "../chat/notes.js";
import { LessonsRepo, lessonsNote, materializeLessons, saveTaskLessons } from "../team/lessons.js";
import { formatFeedback } from "./pr-feedback.js";
import { BYPASS_ENV, type PreviewResult, checkPreview, previewSlackLine } from "./preview.js";
import { type PlanItem, ProgressTracker, formatProgress } from "./progress.js";
import {
  type CommandRunner,
  type RecheckResult,
  type RecheckRun,
  codeSpan,
  needsFix,
  planRecheck,
  recheckBudgetMs,
  recheckEventText,
  recheckFixPrompt,
  recheckLine,
  recheckPrSection,
  recheckSummary,
  restoreWorkTree,
  runRecheck,
} from "./recheck.js";
import { type CodeHostKind, HOST_TERMS, repoHost } from "../integrations/code-hosts/repo-id.js";
import { findRepoSetup, repoSetupContext, runSetupCommand, setupEnv } from "./repo-setup.js";
import { ScreenshotRepo } from "./screenshots.js";
import { HISTORY_SCAN, routeRepoTask } from "./sizing.js";
import { SkillLibrary, materializeSkills } from "../skills/skills.js";
import { slackClient, slackErrorCode, toMrkdwn, truncate, uploadThreadFiles } from "../slack/slack.js";
import { createStore } from "../core/store.js";
import { TimelineRecorder, checkItems, plainLine } from "./task-events.js";
import { type Task, type TaskPhase, type TaskReport, TaskRepo, type ThreadState, decodeTaskPayload, isWebTask } from "./tasks.js";
import { type RepoAgentOptions, type Team, type TeamSkills, agentLabel, buildRepoAgents, repoAllowedTools, skillQueryOptions } from "../team/team.js";
import { ticketFinished, ticketPrOpened, ticketStarted, ticketStopped, ticketSyncDeps } from "../integrations/tickets/ticket-sync.js";
import { UsageRepo } from "../spending/usage.js";

const execFileAsync = promisify(execFile);

/** How a subagent call appears in the Slack progress line, e.g. ":hammer_and_wrench: Sara (Coder)". */
export function subagentLabel(team: Team, subagentType: string | undefined): string {
  const agent = team.agents.find((a) => a.id === subagentType);
  return agent ? agentLabel(agent) : `:robot_face: ${subagentType || "agent"}`;
}

/**
 * The parts of the query that come from the configured team: Pointer's prompt, the subagents and what they may use.
 * With shared files (context.attachments) and the folder they were written to, that folder is opened to the team too,
 * and so is the screenshots folder when the team has a browser (`opts.browser`, `context.browser`).
 * With installed skills (`opts.skills`), the library's plugin is loaded, each agent gets its assigned skills
 * preloaded, the Skill tool is allowed and the plugin folder is opened to the team (skills' scripts and references).
 */
export function teamQueryOptions(
  config: Config,
  context: OrchestratorContext = {},
  attachmentsDir?: string,
  opts: RepoAgentOptions = {},
): Required<Pick<Options, "systemPrompt" | "agents" | "allowedTools">> & Pick<Options, "effort" | "additionalDirectories" | "plugins" | "skills" | "mcpServers"> {
  const skills = skillQueryOptions(opts.skills);
  // All sit next to the checkout, not in it, so nothing in them is ever committed.
  const directories = [
    ...(attachmentsDir && context.attachments?.length ? [attachmentsDir] : []),
    ...(opts.browser && context.browser ? [context.browser.shotsDir] : []),
    ...(skills && opts.skills ? [opts.skills.pluginDir] : []),
    ...(context.lessons ? [context.lessons.dir] : []),
  ];
  return {
    ...(skills ?? {}),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      // Which agent may use which app (apps.ts), and which work through a coding agent CLI (engines.ts).
      append: [orchestratorPrompt(config, context), opts.apps?.promptRule, opts.engines?.promptRule].filter(Boolean).join("\n"),
    },
    // Each agent carries its own effort (its setting, or this one); the task provider maps it, or leaves it out.
    ...effortOption(opts.provider ? opts.provider.effort(config.team.pointer.taskEffort) : config.team.pointer.taskEffort),
    agents: buildRepoAgents(config.team, opts),
    // Under "dontAsk" anything not listed is denied, so this covers every
    // enabled agent's tools (e.g. WebSearch for agents that only look).
    allowedTools: repoAllowedTools(config.team, opts),
    ...(directories.length ? { additionalDirectories: directories } : {}),
    // The coding agent CLIs' in-process servers: the SDK hosts in-process servers only at the top level.
    ...(opts.engines && Object.keys(opts.engines.servers).length ? { mcpServers: opts.engines.servers } : {}),
  };
}

const effortOption = (effort: Options["effort"] | undefined): Pick<Options, "effort"> => (effort ? { effort } : {});

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

/**
 * The installed skills written into `dir` (outside the checkout) as the plugin
 * the team loads, or undefined when none is installed. Never throws: a library
 * that cannot be read is logged (redacted) and the team runs without skills.
 */
export async function prepareSkills(
  library: Pick<SkillLibrary, "list" | "readFiles">,
  dir: string,
  redact: (text: string) => string = (t) => t,
): Promise<TeamSkills | undefined> {
  try {
    return await materializeSkills(library, dir);
  } catch (err) {
    console.error(`[worker] could not load the skills library: ${redact(errorText(err)).slice(0, 300)}`);
    return undefined;
  }
}

/** The timeline's line about the skills the team has. */
export function skillsNote(skills: TeamSkills): string {
  const names = skills.skills.map((s) => s.name);
  const shown = names.slice(0, 8).join(", ") + (names.length > 8 ? ` and ${names.length - 8} more` : "");
  return `The team has ${names.length} skill${names.length === 1 ? "" : "s"} from the library: ${shown}`;
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
 * monday.com, the GitHub webhook secret, every code host's credential (every
 * GitHub connection's token, not only the one in use, GitLab's and
 * Bitbucket's) in every form its client sends it (allHostSecrets: tokens, git
 * auth headers and their Basic values), the other integrations' and the AI
 * providers' (integrationSecrets), and the values of every repository's setup
 * variables (any of them may be a secret; makeRedactor skips very short
 * ones). Secrets made of parts (a JSON key file, header lines) come with the
 * parts that can be printed on their own (secretParts).
 */
export function configSecrets(c: Config): (string | undefined)[] {
  // Repo variables are redacted unless they are plainly not secret (a word like "development", a port):
  // hiding those would garble every Slack message and PR text that happens to contain the word.
  const repoEnv = Object.values(c.repoSetup)
    .flatMap((setup) => Object.values(setup.env))
    .filter((value) => !/^(?:[A-Za-z]+|\d+)$/.test(value.trim()))
    .flatMap((value) => secretParts(value));
  return [
    c.anthropic.apiKey,
    c.slack.botToken,
    c.slack.signingSecret,
    c.monday.token,
    c.monday.automation.webhookSecret,
    c.github.webhookSecret,
    ...allHostSecrets(c),
    ...integrationSecrets(c),
    ...repoEnv,
  ];
}

// Who a task's commits on GitHub are authored by; each host's client decides for its own (CodeHost.commitIdentity).
export { FALLBACK_COMMIT_EMAIL, githubCommitIdentity as commitIdentity } from "../integrations/github/github.js";

// ---------- Pull request texts ----------

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** How the host refers to a pull or merge request by number: "#12" (GitHub, Bitbucket), "!12" (GitLab). */
export function prRef(number: number, host: CodeHostKind = "github"): string {
  return `${host === "gitlab" ? "!" : "#"}${number}`;
}

/** "pull request #12", "merge request !12". */
export const prLabel = (number: number, host: CodeHostKind = "github") => `${HOST_TERMS[host].pr} ${prRef(number, host)}`;

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

/** Where a task was requested and reports: a Slack thread, or a conversation in the admin console. */
export type TaskSurface = "slack" | "web";

/** The last part of every pull request body the platform writes. */
export function prFooter(taskId: string, pointerName: string, where: TaskSurface = "slack"): string {
  const from = where === "web" ? "the admin console" : "Slack";
  return `---\nRequested in ${from} · task \`${taskId}\` · built by ${pointerName} and the team. A human must review and merge.`;
}

/**
 * The pull (merge) request's description for finished work: the team's report,
 * the platform's own run of its checks next to its verification, the
 * screenshots and the footer. Redacted by the caller.
 */
export function prBody(
  report: Pick<Report, "summary" | "verification" | "testProof" | "risks">,
  o: { recheck?: RecheckRun; screenshots: number; where?: TaskSurface; footer: string },
): string {
  return [
    report.summary,
    report.verification && `### Verification\n${report.verification}`,
    report.testProof && `### How the tests were shown to catch the problem\n${report.testProof}`,
    o.recheck && recheckPrSection(o.recheck),
    report.risks && `### Risks and follow-ups\n${report.risks}`,
    screenshotsSection(o.screenshots, o.where),
    o.footer,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Points reviewers to the screenshots posted in Slack (or kept in the admin console), or "" when there are none. */
export function screenshotsSection(count: number, where: TaskSurface = "slack"): string {
  if (!count) return "";
  const place = where === "web" ? "the admin console, on this task in its conversation" : "the Slack thread";
  return `### Screenshots\n${plural(count, "screenshot")} from the browser checks ${count === 1 ? "is" : "are"} in ${place}.`;
}

const continueHint = (where: TaskSurface) =>
  where === "web"
    ? 'Reply in its conversation in the admin console (for example "continue") to pick it up on this branch.'
    : 'Reply in the Slack thread (for example "continue") to pick it up on this branch.';

/** The body of the draft pull request that keeps a stopped task's work. */
export function draftPrBody(o: {
  reason: string;
  /** What the draft may lack (a change left in `git stash`), right after the reason. */
  warning?: string;
  plan: PlanItem[];
  filesChanged: number;
  screenshots: number;
  footer: string;
  where?: TaskSurface;
}): string {
  return [
    `**Stopped early:** ${o.reason}`,
    o.warning ? `⚠️ ${o.warning}` : "",
    "The team did not finish this task; this draft keeps its work so far.",
    o.plan.length ? `### Plan\n${planChecklist(o.plan)}` : "",
    `${plural(o.filesChanged, "file")} changed.`,
    continueHint(o.where ?? "slack"),
    screenshotsSection(o.screenshots, o.where),
    o.footer,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Posted on an open pull request when a follow-up on it stopped early. */
export function stoppedComment(reason: string, plan: PlanItem[], where: TaskSurface = "slack"): string {
  return [`**Stopped early:** ${reason}`, plan.length ? planChecklist(plan) : "", continueHint(where)].filter(Boolean).join("\n\n");
}

/**
 * Why the worker cannot run this task, or undefined when it can: the task
 * provider (Claude by default) is always needed; Slack only for tasks that
 * report in a Slack thread (console tasks keep everything on the task record).
 */
export function onboardingError(task: Pick<Task, "channel">, config: Config): string | undefined {
  const providerMissing = providerProblem(config, config.ai.taskProvider);
  if (providerMissing && config.ai.taskProvider !== "anthropic") return `Onboarding is incomplete: ${providerMissing}`;
  if (providerMissing) return isWebTask(task) ? "Onboarding is incomplete (Claude missing)." : "Onboarding is incomplete (Claude or Slack missing).";
  if (!isWebTask(task) && !config.slack.botToken) return "Onboarding is incomplete (Claude or Slack missing).";
  return undefined;
}

/** The team's report as kept on the task (redacted): what the Slack result says, for the console. */
export function taskReport(report: Pick<Report, "title" | "summary" | "verification" | "risks">, redact: (text: string) => string = (t) => t): TaskReport {
  return { title: redact(report.title), summary: redact(report.summary), verification: redact(report.verification), risks: redact(report.risks) };
}

/**
 * Screenshots not handled yet, by content: a later one saved under the same
 * name is new. Marks the returned ones as handled in `seen`.
 */
export function newScreenshots(shots: Screenshot[], seen: Set<string>): Screenshot[] {
  const fresh = shots.filter((s) => !seen.has(screenshotKey(s)));
  for (const s of fresh) seen.add(screenshotKey(s));
  return fresh;
}

/** The Slack result when a stopped task's work was saved in a pull (or merge) request. */
export function stoppedSlackText(o: {
  userId: string;
  reason: string;
  pr: Pick<PrRef, "html_url" | "number" | "draft">;
  cost: string;
  host?: CodeHostKind;
}): string {
  const pr = HOST_TERMS[o.host ?? "github"].pr;
  const where = o.pr.draft ? `a draft ${pr}` : `the ${pr}`;
  return `:warning: <@${o.userId}> Stopped: ${o.reason} The unfinished work is saved in ${where}: <${o.pr.html_url}|${prRef(o.pr.number, o.host)}>. Reply here (for example "continue") to pick it up on the same branch.${o.cost}`;
}

/** The first line of the Slack result: blocked, published (with the link to review), or answered. */
export function resultHeadline(o: {
  userId: string;
  title: string;
  outcome: "blocked" | "published" | "answered";
  prUrl?: string;
  host?: CodeHostKind;
}): string {
  switch (o.outcome) {
    case "blocked":
      return `:warning: <@${o.userId}> *Blocked: ${o.title}*`;
    case "published":
      return `:white_check_mark: <@${o.userId}> *${o.title}* — <${o.prUrl}|review the ${HOST_TERMS[o.host ?? "github"].pr}>`;
    case "answered":
      return `:speech_balloon: <@${o.userId}> *${o.title}*`;
  }
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
  /** Where the request was made; "slack" when omitted. */
  where?: TaskSurface;
}): string {
  const terms = HOST_TERMS[repoHost(o.repo)];
  const from =
    o.trigger === "review" ? `${terms.name} (user ${o.userId})` : o.where === "web" ? "the admin console (the owner)" : `Slack (user ${o.userId})`;
  const lines = [
    `Request from ${from}:`,
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
  if (o.trigger === "review") lines.push(`This follow-up was started by feedback on the ${terms.pr}, not by a message in Slack.`);
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

// ---------- Git and the code host (GitHub, GitLab, Bitbucket through CodeHost) ----------

/** Runs git in the checkout (or `cwd`); `auth` adds the code host's credentials to that one command. */
export type GitRun = (args: string[], opts?: { auth?: boolean; cwd?: string }) => Promise<string>;

/** execFile, promisified (no shell): what gitRunner runs git with (tests pass a fake). */
export type ExecFile = (file: string, args: string[], opts: { cwd: string; maxBuffer: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string }>;

const execGit: ExecFile = (file, args, opts) => execFileAsync(file, args, opts);

/**
 * The whole environment of every worker git command. Git hands its `-c`
 * options, the auth header included, to everything it starts (hooks, filters,
 * helpers) through GIT_CONFIG_PARAMETERS, so it must never also carry the
 * worker's own environment (MASTER_KEY, TASK_B64, cloud credentials). No
 * system or user config is read either: HOME is an empty folder of the
 * worker's and the global config is /dev/null.
 */
export function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    LANG: process.env.LANG ?? "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

/**
 * Before every worker git command: no hooks (agents can plant .git/hooks/* or
 * set core.hooksPath), no fsmonitor program and no signing program, whatever
 * the repository's config says (command-line config wins).
 */
export const GIT_SAFETY_ARGS: readonly string[] = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false"];

/**
 * git for a task, with the safety arguments and the minimal environment
 * (gitEnv) on every command. The host's credentials go on the command line of
 * each command that needs them (CodeHost.gitAuthArgs, `-c http.<host>.extraheader=…`),
 * never into .git/config or the remote URL. Errors are redacted, the auth
 * arguments included.
 */
export function gitRunner(o: {
  host: Pick<CodeHost, "gitAuthArgs">;
  cwd: string;
  /** An empty folder of the worker's, outside the checkout, for HOME. */
  home: string;
  redact: (text: string) => string;
  run?: ExecFile;
}): GitRun {
  const run = o.run ?? execGit;
  return async (args, opts = {}) => {
    const auth = opts.auth ? o.host.gitAuthArgs() : [];
    try {
      const { stdout } = await run("git", [...GIT_SAFETY_ARGS, ...auth, ...args], {
        cwd: opts.cwd ?? o.cwd,
        maxBuffer: 16 * 1024 * 1024,
        env: gitEnv(o.home),
      });
      return stdout.trim();
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      // The subcommand, past global options such as `--git-dir <path>`.
      const verb = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "--git-dir") ?? "command";
      // execFile's message repeats the whole command line, auth arguments and all.
      throw new Error(o.redact(makeRedactor(auth)(`git ${verb} failed: ${e.stderr?.trim() || e.message}`)));
    }
  };
}

/**
 * Keeps the checkout's .git/config as the worker left it: saved after the
 * checkout, before any agent runs, and returned as a function that puts it
 * back. The worker calls it before each of its own commands on what the
 * agents left (add, status, commit, diff): agents can run git, and filter,
 * clean or diff drivers, fsmonitor, includes, signing programs, remotes or
 * proxies they set there would otherwise run or apply in those commands. A
 * .git that is no longer a plain folder fails the command (nothing is published).
 */
export async function snapshotGitConfig(repoDir: string): Promise<() => Promise<void>> {
  const gitDir = join(repoDir, ".git");
  const path = join(gitDir, "config");
  const saved = await readFile(path);
  return async () => {
    const dir = await lstat(gitDir).catch(() => undefined);
    if (!dir?.isDirectory()) throw new Error("The checkout's .git is no longer a folder, so the worker does not use it.");
    const current = await lstat(path).then(
      (s) => (s.isFile() ? readFile(path) : undefined),
      () => undefined,
    );
    if (current?.equals(saved)) return;
    // Replaced, never written through: the path may now be a link to somewhere else.
    await rm(path, { recursive: true, force: true });
    await writeFile(path, saved, { flag: "wx", mode: 0o644 });
  };
}

/** A branch name the worker made (branchName) or kept: no refspec or option characters. */
const SAFE_BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}$/;

/**
 * Pushes the checkout's HEAD to `branch` on the host from a fresh bare
 * repository the agents never touched, so nothing they wrote in the checkout
 * (hooks, core.hooksPath, remote and push URLs, proxies, TLS settings,
 * credential helpers) applies to the one command that carries the host's
 * credentials. HEAD comes over by path, without credentials (git ignores hook
 * settings such as uploadpack.packObjectsHook in the served repository's own
 * config), and goes to the host's clone URL itself, never to "origin". Not a
 * force push. The bare repository is removed afterwards.
 */
export async function publishBranch(o: {
  host: Pick<CodeHost, "cloneUrl">;
  repo: string;
  repoDir: string;
  branch: string;
  git: GitRun;
  /** Where the bare repository is made: outside the folders the agents are given. */
  tmp: string;
}): Promise<void> {
  const url = o.host.cloneUrl(o.repo);
  if (!isPlainHttpsUrl(url)) throw new Error(`The code host gave a push URL for ${o.repo} that is not plain https.`);
  if (!SAFE_BRANCH.test(o.branch) || o.branch.endsWith(".lock") || o.branch.endsWith("/")) {
    throw new Error(`Not pushing to a branch named "${o.branch}".`);
  }
  const ref = `refs/heads/${o.branch}`;
  const pushDir = await mkdtemp(join(o.tmp, "army-push-"));
  try {
    await o.git(["init", "--quiet", "--bare", "--template=", pushDir], { cwd: pushDir });
    // The checkout is shallow (--depth 50): without --update-shallow, fetch quietly refuses the ref.
    await o.git(["--git-dir", pushDir, "fetch", "--quiet", "--no-tags", "--update-shallow", o.repoDir, `+HEAD:${ref}`], { cwd: pushDir });
    await o.git(["--git-dir", pushDir, "push", "--quiet", "--no-verify", url, `${ref}:${ref}`], { cwd: pushDir, auth: true });
  } finally {
    await rm(pushDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** A Jira issue key ("ACME-12"); Jira reads Smart Commit commands after one. */
const ISSUE_KEY = /\b[A-Za-z][A-Za-z0-9_]*-\d+\b/;

/**
 * A commit message that cannot run Jira Smart Commits: a `#word` after an
 * issue key on the same line ("ACME-1 #done", "#time 2h", "#comment …") would
 * transition, log work on or comment on the issue when the commit is pushed.
 * Its "#" becomes a full-width "＃". "#12" (an issue or pull request number)
 * stays as it is.
 */
export function smartCommitSafe(message: string): string {
  return message
    .split("\n")
    .map((line) => {
      const key = ISSUE_KEY.exec(line);
      if (!key) return line;
      const at = key.index + key[0].length;
      return line.slice(0, at) + line.slice(at).replace(/#(?=[A-Za-z])/g, "＃");
    })
    .join("\n");
}

/** `git commit` as the worker runs it: no hooks, the message without Smart Commit commands. */
export const commitArgs = (message: string): string[] => ["commit", "--quiet", "--no-verify", "-m", smartCommitSafe(message)];

/** An https URL without a user or password: credentials in a clone URL would be kept in .git/config. */
function isPlainHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Clones the repository through its host into `dir` and authors the task's
 * commits as the host says (CodeHost.commitIdentity: the token owner, so the
 * host and its deployers attribute them to that account). Returns the base branch.
 */
export async function checkoutRepo(o: {
  host: Pick<CodeHost, "cloneUrl" | "defaultBranch" | "viewer" | "commitIdentity">;
  repo: string;
  dir: string;
  workRoot: string;
  git: GitRun;
  pointerName: string;
  redact: (text: string) => string;
}): Promise<{ base: string; author: { name: string; email: string } }> {
  const base = await o.host.defaultBranch(o.repo);
  const url = o.host.cloneUrl(o.repo);
  if (!isPlainHttpsUrl(url)) throw new Error(`The code host gave a clone URL for ${o.repo} that is not plain https.`);
  await o.git(["clone", "--depth", "50", "--no-tags", url, o.dir], { auth: true, cwd: o.workRoot });
  const viewer = await o.host.viewer().catch((err: unknown) => {
    console.error("[worker] could not look up the token owner:", o.redact(String(err)));
    return undefined;
  });
  const author = o.host.commitIdentity(o.pointerName, viewer);
  await o.git(["config", "user.name", author.name]);
  await o.git(["config", "user.email", author.email]);
  return { base, author };
}

/**
 * Opens the pull (merge) request for the finished work, or updates the one
 * already open on the branch: a comment with the update and, when it is a
 * draft of unfinished work, ready for review with the finished work's title
 * and description instead of the "WIP: …" ones. `title` and `body` are
 * redacted by the caller.
 */
export async function publishPr(o: {
  host: Pick<CodeHost, "findOpenPr" | "createPr" | "commentOnPr" | "markReady" | "updatePr">;
  repo: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  redact: (text: string) => string;
}): Promise<{ pr: PrRef; updated: boolean }> {
  const existing = await o.host.findOpenPr(o.repo, o.branch);
  if (!existing) return { pr: await o.host.createPr(o.repo, { title: o.title, body: o.body, head: o.branch, base: o.base }), updated: false };
  await o.host.commentOnPr(o.repo, existing.number, `**Update: ${o.title}**\n\n${o.body}`);
  if (existing.draft) {
    await o.host
      .markReady(o.repo, existing)
      .then(() => o.host.updatePr(o.repo, existing.number, { title: o.title, body: o.body }))
      .catch((err: unknown) => console.error(`[worker] could not mark the pull request ready: ${o.redact(errorText(err))}`));
  }
  return { pr: existing, updated: true };
}

/**
 * Keeps a stopped task's pushed work: a comment on the pull (merge) request
 * already open on the branch, or a new draft. `body` is only built for a new
 * draft. Texts are redacted by the caller.
 */
export async function saveUnfinishedPr(o: {
  host: Pick<CodeHost, "findOpenPr" | "createPr" | "commentOnPr">;
  repo: string;
  branch: string;
  base: string;
  title: string;
  body: () => Promise<string>;
  comment: string;
}): Promise<PrRef> {
  const existing = await o.host.findOpenPr(o.repo, o.branch);
  if (existing) {
    await o.host.commentOnPr(o.repo, existing.number, o.comment);
    return existing;
  }
  return o.host.createPr(o.repo, { title: o.title, body: await o.body(), head: o.branch, base: o.base, draft: true });
}

export interface FollowChecksDeps {
  host: Pick<CodeHost, "kind" | "checksFor" | "checkAnnotations" | "jobLog" | "commentOnPr">;
  repo: string;
  pr: Pick<PrRef, "number">;
  limits: Pick<Config["limits"], "ciWaitMin" | "ciFixRounds">;
  /** When everything must be done (jobDeadline); undefined = no limit. */
  deadline: number | undefined;
  base: string;
  branch: string;
  request: string;
  /** What is left of the task's budget for a fix round. */
  budgetLeft: () => number;
  /** git on what the agents left: the worker's own config is put back first (snapshotGitConfig). */
  git: GitRun;
  /** Publishes the branch (publishBranch). */
  push: () => Promise<unknown>;
  /** One fix round of the team; it adds the round's cost to the task and keeps its project notes. */
  runRound: (prompt: string, o: { budgetUsd: number; runMs: number; since: string; phaseLabel: string }) => Promise<{ report?: Report; failure?: string }>;
  /** Keeps the checks' outcome and the fix round in progress as it goes (the console and Pointer read them). */
  task: Pick<Task, "ci" | "fixRound">;
  timeline: Pick<TimelineRecorder, "add" | "checks">;
  /** The task moved to a step of the checks phase. */
  onStage: (text: string) => Promise<void>;
  /** The live progress message (Slack). */
  progress: (text: string) => Promise<void>;
  redact: (text: string) => string;
  now?: () => number;
  /** Overrides for polling the checks (tests: poll interval, grace, sleep, clock). */
  wait?: Pick<WaitOptions, "pollMs" | "graceMs" | "sleep" | "now">;
}

/**
 * After a push: wait for the pull (merge) request's checks on the host and,
 * while they fail and rounds, budget and time are left, let the team fix them
 * (with what the host says failed: annotations and job logs), push the fix,
 * comment on the request and wait again. Returns the last outcome and, when
 * the team could not fix them, why.
 */
export async function followPrChecks(d: FollowChecksDeps): Promise<{ outcome: CiOutcome; note?: string } | undefined> {
  const now = d.now ?? Date.now;
  const { ciWaitMin, ciFixRounds: rounds } = d.limits;
  const pr = HOST_TERMS[d.host.kind].pr;
  let fixRounds = 0;
  let last: CiOutcome | undefined;
  for (;;) {
    const waitMs = Math.min(ciWaitMin * 60_000, d.deadline === undefined ? Infinity : d.deadline - now());
    if (waitMs < 60_000) return last && { outcome: last, note: "No time was left to wait for the checks after the last fix." };
    await d.onStage(`Waiting for the ${pr}'s checks`);
    await d.progress(`:hourglass_flowing_sand: Waiting for the ${pr}'s checks…`);
    const sha = await d.git(["rev-parse", "HEAD"]);
    const waitStart = now();
    // Each poll's checks go to the timeline, so the console lists them live.
    const watched = {
      checksFor: async (repo: string, ref: string) => {
        const data = await d.host.checksFor(repo, ref);
        d.timeline.checks(checkItems(data));
        return data;
      },
    };
    const wait = await waitForChecks(watched, d.repo, sha, { waitMs, ...d.wait });
    last = ciSummary(wait, fixRounds);
    d.timeline.add(
      {
        kind: "checks",
        text: plainLine(ciSummaryLine(last, ciWaitMin, d.host.kind).replace(/\*/g, "")) || "The repository has no checks",
        ok: last.state === "passed" || last.state === "none",
        ms: now() - waitStart,
      },
      true,
    );
    // Kept as it goes, so the console and Pointer see the checks before the task ends.
    const stored = storedCiSummary(last);
    if (stored) d.task.ci = stored;
    if (wait.state !== "failed" || fixRounds >= rounds) return { outcome: last };

    // The task's own budget (capped by what was left of the caps when it started).
    const budgetUsd = d.budgetLeft();
    if (budgetUsd < 1) return { outcome: last, note: "Not enough of the task's budget was left to fix them." };
    const fixMs = fixRunTimeoutMs(d.deadline, now());
    if (fixMs === null) return { outcome: last, note: "Not enough time was left to fix them." };

    fixRounds += 1;
    const round = `round ${fixRounds} of ${rounds}`;
    d.task.fixRound = { round: fixRounds, rounds, failing: last.names.slice(0, 20), at: new Date(now()).toISOString() };
    d.timeline.add({ kind: "fix-round", text: `Checks failed (${last.names.join(", ")}): fixing them (${round})` }, true);
    await d.onStage(`Fixing the failing checks (${round})`);
    await d.progress(`:wrench: Checks failed (${truncate(last.names.join(", "), 200)}): the team is fixing them (${round})…`);
    const details = await ciFailureDetails(d.host, d.repo, wait, d.redact);
    const stashed = await stashEntries(d.git);
    const run = await d.runRound(
      ciFixPrompt(details, { round: fixRounds, rounds, base: d.base, branch: d.branch, request: d.request, host: d.host.kind }),
      { budgetUsd, runMs: fixMs, since: sha, phaseLabel: `Fixing the failing checks (${round})` },
    );
    last = ciSummary(wait, fixRounds);

    // An unfinished or blocked fix is not pushed: the request keeps its last complete state.
    if (!run.report || run.failure) return { outcome: last, note: `Fixing the checks stopped early: ${run.failure}` };
    if (run.report.kind === "blocked") {
      // Markdown; the Slack result converts it.
      return { outcome: last, note: `**Checks blocked: ${run.report.title}** ${truncate(run.report.summary, 800)}` };
    }
    // Only what this round left in `git stash` goes back (popStashes); a fix that lacks part of its change is not pushed.
    const unstashed = await popStashes(d.git, stashed);
    if (unstashed.stuck) return { outcome: last, note: `Fixing the checks stopped early: ${unstashed.stuck}` };
    await d.git(["add", "-A"]);
    if ((await d.git(["status", "--porcelain"])) !== "") await d.git(commitArgs(`Fix failing checks: ${run.report.title}`));
    if (Number(await d.git(["rev-list", "--count", `${sha}..HEAD`])) === 0) {
      return { outcome: last, note: "The team changed nothing for the failing checks." };
    }
    await d.progress(":rocket: Pushing the fix…");
    await d.push();
    d.timeline.add({ kind: "push", text: `Pushed the fix (round ${fixRounds}): ${run.report.title}` }, true);
    await d.host
      .commentOnPr(d.repo, d.pr.number, d.redact(fixComment(fixRounds, run.report)))
      .catch((err: unknown) => console.error(`[worker] fix comment not posted: ${d.redact(errorText(err))}`));
  }
}

export interface RecheckDeps {
  /** The team's report: the checks it says it ran, with their outcomes. */
  report: Pick<Report, "checks">;
  /** The owner's test command for the repository (Repo setup); "" = the team's passing checks are run. */
  testCommand: string;
  limits: Pick<Config["limits"], "recheckMin" | "ciFixRounds">;
  /** When everything must be done (jobDeadline); undefined = no limit. */
  deadline: number | undefined;
  repoDir: string;
  /** The agents' environment, never the worker's own. */
  env: Record<string, string>;
  /** What the shell guard keeps the team's commands away from (the platform's data directory). */
  protectedPaths: string[];
  base: string;
  branch: string;
  request: string;
  /** What is left of the task's budget for a fix round. */
  budgetLeft: () => number;
  /** git on what the agents left: the worker's own config is put back first (snapshotGitConfig). */
  git: GitRun;
  /** One fix round of the team; it adds the round's cost to the task and keeps its project notes. */
  runRound: FollowChecksDeps["runRound"];
  timeline: Pick<TimelineRecorder, "add">;
  /** The task moved to a step of the verify phase. */
  onStage: (text: string) => Promise<void>;
  /** The live progress message (Slack). */
  progress: (text: string) => Promise<void>;
  redact: (text: string) => string;
  now?: () => number;
  /** Runs one command (runCli). */
  run?: CommandRunner;
}

/**
 * After the team's change is committed, before anything is published: the
 * platform runs the checks again itself (recheck.ts) and puts the checkout
 * back as the team left it. When a check failed or showed no result and fix
 * rounds, budget and time allow, the team gets one round to fix it, with the
 * commands and their real output; its change is committed like the other
 * rounds' and the checks run again. An unfinished fix, or a round that changed
 * nothing in the code, leaves the work as it was. Nothing a command wrote is
 * ever committed.
 */
export async function followRecheck(d: RecheckDeps): Promise<RecheckRun> {
  const now = d.now ?? Date.now;
  const plan = planRecheck(d.report.checks, d.testCommand, d.protectedPaths);
  const kept = { source: plan.source, notRechecked: plan.notRechecked };
  if (!plan.checks.length) {
    d.timeline.add({ kind: "recheck", text: "Nothing to check again: no test command is set and the team reported no passing check" });
    return { ...kept, first: [], final: [], fixRounds: 0 };
  }

  const runAll = async (text: string): Promise<RecheckResult[]> => {
    await d.onStage(text);
    await d.progress(`:mag: ${text}…`);
    const sha = await d.git(["rev-parse", "HEAD"]);
    let results: RecheckResult[];
    try {
      results = await runRecheck({
        checks: plan.checks,
        cwd: d.repoDir,
        env: d.env,
        budgetMs: recheckBudgetMs(d.limits.recheckMin, d.deadline, now()),
        run: d.run ?? runCli,
        redact: d.redact,
        now,
      });
    } finally {
      // Whatever the commands wrote, the checkout goes back to the team's committed work.
      await restoreWorkTree(d.git, sha);
    }
    for (const r of results) {
      d.timeline.add({ kind: "recheck", text: recheckEventText(r), ok: r.outcome === "passed", ...(r.ms !== undefined ? { ms: r.ms } : {}) }, true);
    }
    return results;
  };

  const first = await runAll(plan.source === "owner" ? "Running the owner's test command on the team's work" : "Running the team's checks again");
  // `final` is `first` itself until the checks run again after a fix.
  const ended = (o: { fixRounds?: number; note?: string } = {}): RecheckRun => ({ ...kept, first, final: first, fixRounds: o.fixRounds ?? 0, ...(o.note ? { note: o.note } : {}) });
  if (!needsFix(first)) return ended();
  if (d.limits.ciFixRounds <= 0) return ended({ note: "No fix round: fix rounds are turned off (Settings)." });
  const budgetUsd = d.budgetLeft();
  if (budgetUsd < 1) return ended({ note: "Not enough of the task's budget was left to fix them." });
  const fixMs = fixRunTimeoutMs(d.deadline, now());
  if (fixMs === null) return ended({ note: "Not enough time was left to fix them." });

  const failing = first.filter((r) => r.outcome === "failed" || r.outcome === "no-result").map((r) => r.command);
  const label = "Fixing what the checks run again found";
  d.timeline.add({ kind: "fix-round", text: `Checked again: ${failing.join(", ")} did not pass: the team is fixing it` }, true);
  await d.onStage(label);
  await d.progress(`:wrench: Checked again: ${truncate(failing.join(", "), 200)} did not pass: the team is fixing it…`);
  const sha = await d.git(["rev-parse", "HEAD"]);
  // What a check run left there stays there: only what the round leaves goes back (popStashes).
  const stashed = await stashEntries(d.git);
  const run = await d.runRound(recheckFixPrompt(first, { source: plan.source, base: d.base, branch: d.branch, request: d.request }), {
    budgetUsd,
    runMs: fixMs,
    since: sha,
    phaseLabel: label,
  });

  // An unfinished fix, or a round that changed nothing in the code, is not kept: the work stays as the team finished it.
  if (!run.report || run.failure) {
    await restoreWorkTree(d.git, sha);
    return ended({ fixRounds: 1, note: `Fixing them stopped early: ${run.failure ?? "the team finished without a report."}` });
  }
  if (run.report.kind !== "change") {
    await restoreWorkTree(d.git, sha);
    // Markdown; the Slack result converts it.
    return ended({ fixRounds: 1, note: `**The team on the checks: ${run.report.title}** ${truncate(run.report.summary, 800)}` });
  }
  const unstashed = await popStashes(d.git, stashed);
  if (unstashed.stuck) {
    await restoreWorkTree(d.git, sha);
    return ended({ fixRounds: 1, note: `Fixing them stopped early: ${unstashed.stuck}` });
  }
  await d.git(["add", "-A"]);
  if ((await d.git(["status", "--porcelain"])) !== "") await d.git(commitArgs(`Fix the checks run again: ${run.report.title}`));
  if (Number(await d.git(["rev-list", "--count", `${sha}..HEAD`])) === 0) return ended({ fixRounds: 1, note: "The team changed nothing for them." });
  d.timeline.add({ kind: "note", text: `Committed the fix: ${run.report.title}` });
  const final = await runAll("Running the checks again after the fix");
  return { ...kept, first, final, fixRounds: 1 };
}

/**
 * HEAD back on `sha`, the team's committed work, after the platform's run of
 * the checks broke off: a check may have committed before the checkout could
 * be put back (`git reset` fails on an index.lock a killed check left), and
 * publishBranch pushes HEAD. Only the ref moves (update-ref), never the index
 * or the files. Returns why HEAD could not be put back, or undefined when it
 * is on `sha`. `git` is the worker's own git on what the agents left.
 */
export async function headBackTo(git: GitRun, sha: string): Promise<string | undefined> {
  try {
    if ((await git(["rev-parse", "HEAD"]).catch(() => "")) !== sha) await git(["update-ref", "HEAD", sha]);
    const head = await git(["rev-parse", "HEAD"]);
    return head === sha ? undefined : `HEAD is on ${head.slice(0, 12)}, not on ${sha.slice(0, 12)}`;
  } catch (err) {
    return plainLine(errorText(err), 300);
  }
}

/** The entries in `git stash`, newest first (their commits). */
export async function stashEntries(git: GitRun): Promise<string[]> {
  return (await git(["stash", "list", "--format=%H"])).split("\n").filter(Boolean);
}

/** What popStashes put back, and why it stopped when an entry would not go back. */
export interface Unstashed {
  popped: number;
  /** Why an entry was left (one sentence, Markdown): for the result (Slack, the console) and the pull request's risks. */
  stuck?: string;
}

/**
 * Puts back what the team left in `git stash`, newest first. A run stopped
 * between the test proof's `git stash push` and its `git stash pop` leaves the
 * product change only there, and the worker's `git add -A` would commit and
 * publish the tree without it. Entries in `before` (there before the round)
 * stay. A pop that does not apply cleanly is undone, its entry is left and no
 * other is tried: the files go back as they were before it (everything
 * staged), and `stuck` says so. `git` is the worker's own git on what the
 * agents left (gitAfterAgents).
 */
export async function popStashes(git: GitRun, before: readonly string[] = []): Promise<Unstashed> {
  let popped = 0;
  for (let tries = (await stashEntries(git)).length; tries > 0; tries -= 1) {
    const at = (await stashEntries(git)).findIndex((entry) => !before.includes(entry));
    if (at < 0) break;
    // Everything staged first: what a pop that does not apply is undone to.
    await git(["add", "-A"]);
    const tree = await git(["write-tree"]);
    try {
      await git(["stash", "pop", "--quiet", `stash@{${at}}`]);
      popped += 1;
    } catch (err) {
      // The files it conflicts with, when it got that far; otherwise git's own error (an untracked file in the way).
      const conflicts = (await git(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").filter(Boolean);
      await git(["read-tree", "--reset", "-u", tree]);
      await git(["clean", "-f", "-f", "-d", "--quiet"]);
      const why = conflicts.length
        ? `it conflicts with later changes to ${conflicts.slice(0, 5).map(codeSpan).join(", ")}${conflicts.length > 5 ? ` and ${plural(conflicts.length - 5, "more file")}` : ""}`
        : plainLine(errorText(err), 300);
      return {
        popped,
        stuck: `Part of the team's change was left in \`git stash\` (a run stopped between \`git stash push\` and \`git stash pop\`) and could not be put back (${why}).`,
      };
    }
  }
  return { popped };
}

/**
 * The worker's commit of the team's work before publishing: what the team left
 * in `git stash` put back first (popStashes), then everything committed with
 * `message` when anything changed. Returns how many commits HEAD is ahead of
 * `since`, and what was put back.
 */
export async function commitTeamWork(git: GitRun, o: { message: string; since: string }): Promise<{ ahead: number; unstashed: Unstashed }> {
  // The checkout is a fresh clone: every entry in `git stash` is the team's.
  const unstashed = await popStashes(git);
  await git(["add", "-A"]);
  if ((await git(["status", "--porcelain"])) !== "") await git(commitArgs(o.message));
  return { ahead: Number(await git(["rev-list", "--count", `${o.since}..HEAD`])), unstashed };
}

/** Runs the task in TASK_B64 to the end. The entry point (src/worker.ts) calls it. */
export async function main(): Promise<void> {
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
  // The monthly and per-repo caps (budget.ts): this task's budget before it runs, the Slack alerts after.
  const spending = new Spending({ store, usage: new UsageRepo(store, tasks), config: () => new ConfigRepo(store, masterKey).load(true), slack: slackClient });

  const notReady = onboardingError(task, config);
  if (notReady) throw new Error(notReady);
  // The task provider (Anthropic, Claude on a cloud, or another provider): credentials, model mapping, what it cannot do.
  const provider = providerRuntime(config, "task");
  if (!provider.ok) throw new Error(provider.error);
  const runtime = provider.runtime;
  // The Claude card's model is Anthropic's; another provider runs its main tier unless routing picks a size's model.
  const taskConfig: Config = runtime.provider === "anthropic" ? config : { ...config, anthropic: { ...config.anthropic, model: "" } };
  // Its environment with any credential file written (outside the checkout); removed when the task ends.
  let providerSession: ProviderSession | undefined;
  // Console tasks run without Slack: everything the Slack messages would say is kept on the task record.
  const web = isWebTask(task);
  const where: TaskSurface = web ? "web" : "slack";
  const botToken = config.slack.botToken;
  const slack = !web && botToken ? slackClient(botToken) : undefined;

  const pointerName = config.team.pointer.name;
  // Every credential, including every code host connection's token, not only this task's;
  // once the task's code host is known, its client's own credential forms too (see below).
  let redactor = makeRedactor(configSecrets(config));
  const redact = (text: string) => redactor(text);
  // The fuller timeline the admin console shows (Slack and console tasks alike).
  const timeline = new TimelineRecorder(store, task.id, { redact });
  const screenshotStore = new ScreenshotRepo(store, masterKey);
  // The monday.com ticket the task works on, if any: its status and updates follow the task (each call is a no-op without one).
  const ticket = await ticketSyncDeps({ store, config, task, redact, record: (e) => timeline.add(e, true) });
  /** Moves the timeline to a step and keeps where the task is on its record. Never throws. */
  const stage = async (phase: TaskPhase, text: string) => {
    timeline.enter(phase, text);
    task.stage = { phase, text: plainLine(redact(text), 200), at: new Date().toISOString() };
    await tasks.save(task).catch((err: unknown) => console.error("[worker] stage not saved:", redact(String(err))));
  };

  let lastProgress = 0;
  const progress = async (text: string, force = false) => {
    if (!slack) return;
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
    if (!slack) return;
    const minutes = Math.max(1, Math.round((Date.now() - workerStart) / 60_000));
    await progress(`${outcome} after ${minutes} min. The result is below.`, true);
    try {
      await slack.chat.postMessage({ channel: task.channel, thread_ts: task.threadTs, text: truncate(redact(text)) });
    } catch (err) {
      console.error("[worker] result not posted:", redact(String(err)));
      await progress(redact(text), true);
    }
  };

  // The repository's code host (the GitHub connection allowed to work on it, GitLab or Bitbucket)
  // clones, pushes and opens the pull or merge request.
  const access = codeHostFor(config, task.repo);
  if (!access.ok) {
    task.status = "failed";
    task.error = access.error;
    await tasks.save(task);
    await ticketStopped(ticket, task, { reason: access.error });
    await timeline.close(false, access.error);
    await progress(`:x: <@${task.userId}> ${access.error}`, true);
    process.exitCode = 1;
    return;
  }
  const host = access.host;
  // Whatever forms of its credential the client sends (configSecrets already has the usual ones).
  redactor = makeRedactor([...configSecrets(config), ...host.secrets()]);
  // What the host calls a pull request ("merge request" on GitLab), for every message below.
  const prWord = HOST_TERMS[host.kind].pr;

  // Real path: the agents' file tools are given folders by path and do not follow links.
  const workRoot = await realpath(await mkdtemp(join(process.env.WORK_DIR ?? tmpdir(), "army-")));
  const repoDir = join(workRoot, "repo");
  // Files shared in the thread: next to the checkout, never inside it, so `git add -A` cannot commit them.
  const attachmentsDir = join(workRoot, "attachments");
  // Screenshots from the browser checks: next to the checkout too, posted in the thread after the task.
  const shotsDir = join(workRoot, "screenshots");
  // The skills library as a local plugin: next to the checkout as well, so no skill file is ever committed.
  const skillsDir = join(workRoot, "skills-plugin");
  // The worker's own git folder, apart from the folders the agents are given: git's HOME
  // (empty, see gitEnv) and the bare repositories each push is made from (publishBranch).
  const gitPrivate = await realpath(await mkdtemp(join(tmpdir(), "army-git-")));
  const gitHome = join(gitPrivate, "home");
  await mkdir(gitHome, { mode: 0o700 });
  const git = gitRunner({ host, cwd: repoDir, home: gitHome, redact });
  // Replaced right after the checkout (snapshotGitConfig); until then there is nothing the agents wrote.
  let restoreGitConfig: () => Promise<void> = async () => {};
  /** git on what the agents left: the checkout's config as the worker left it first. */
  const gitAfterAgents: GitRun = async (args, opts) => {
    await restoreGitConfig();
    return git(args, opts);
  };

  task.status = "running";
  // Its Claude cost counts for this provider's monthly cap (budget.ts).
  task.provider = runtime.provider;
  await tasks.save(task);
  await ticketStarted(ticket, task);

  // The first run of the team (with the checkout and setup before it) stops at TASK_TIMEOUT_MIN, or earlier at the deadline.
  const abort = new AbortController();
  const firstRunMs = firstRunTimeoutMs(taskTimeoutMin(process.env.TASK_TIMEOUT_MIN), deadline, workerStart);
  const timer = setTimeout(() => abort.abort(), firstRunMs);

  try {
    // ---------- 1. Check out the project ----------
    await stage("clone", `Cloning ${task.repo}`);
    await progress(`:package: Cloning \`${task.repo}\`…`, true);
    const { base } = await checkoutRepo({ host, repo: task.repo, dir: repoDir, workRoot, git, pointerName, redact });

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
    // Before the setup command and the agents, which run code that can change .git/config.
    restoreGitConfig = await snapshotGitConfig(repoDir);
    task.branch = branch;
    await tasks.save(task);
    timeline.add({ kind: "note", text: resumed ? `Continuing on branch ${branch} (base ${base})` : `New branch ${branch} off ${base}` });

    // ---------- 2. Prepare: the owner's setup, shared files, the browser, review feedback ----------
    const setup = findRepoSetup(config, task.repo);
    // Replaces the environment: the agents' shell sees none of the platform's own
    // secrets (master key, Slack and GitHub tokens), only the owner's variables for
    // this repository, which cannot override the platform's own names.
    providerSession = await runtime.session();
    const providerEnv = providerSession.env;
    // Names reserved after they were saved (ANTHROPIC_BASE_URL, HTTPS_PROXY, AWS_…) are left out: they would
    // redirect Claude Code itself, and the platform's key with it. Their names only are logged.
    const repoVars = setupEnv(setup);
    const leftOut = Object.keys(setup?.env ?? {}).filter((name) => !(name in repoVars));
    if (leftOut.length) console.warn(`[worker] repo variables reserved by the platform were left out: ${leftOut.join(", ")}`);
    const agentEnv: Record<string, string> = {
      ...repoVars,
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "/tmp",
      LANG: process.env.LANG ?? "C.UTF-8",
      CI: "1",
      // The task provider's credentials: also the agents' shell environment, as Anthropic's key always was.
      ...providerEnv,
      CLAUDE_AGENT_SDK_CLIENT_APP: "agent-army/0.1.0",
    };
    let setupResult: SetupResult | undefined;
    const setupCommand = setup?.setupCommand.trim();
    if (setupCommand) {
      await stage("setup", "Running the repo's setup command");
      await progress(":wrench: Running the repo's setup command…", true);
      // Never throws; a failed setup is reported to the team, which decides what to do about it.
      setupResult = await runSetupCommand(setupCommand, { cwd: repoDir, env: agentEnv, redact });
      console.log(`[worker] setup command ${setupResult.ok ? "succeeded" : "failed"} after ${setupResult.seconds}s`);
      const lastLine = setupResult.outputTail.trim().split("\n").at(-1) ?? "";
      timeline.add(
        {
          kind: "setup",
          text: setupResult.ok ? `Setup command succeeded: ${setupCommand}` : `Setup command failed: ${setupCommand}${lastLine ? ` — ${lastLine}` : ""}`,
          ok: setupResult.ok,
          ms: setupResult.seconds * 1000,
        },
        true,
      );
    } else {
      timeline.skip("setup", "No setup command for this repository");
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

    // Skills from the team's library; a library that cannot be read leaves the team without skills, never fails the task.
    const skills = await prepareSkills(new SkillLibrary(store, masterKey), skillsDir, redact);
    if (skills) timeline.add({ kind: "note", text: skillsNote(skills) });

    // Apps (MCP servers) assigned to the team's agents; an app that cannot be reached is left out, never fails the task.
    // Their stored tokens only: the web service renews them before the task, the worker never writes the config.
    const apps = await repoTaskApps(config, { redact, note: (text) => timeline.add({ kind: "note", text }) }).catch((err: unknown) => {
      console.warn("[worker] apps not available:", redact(errorText(err)).slice(0, 300));
      return undefined;
    });
    if (apps) timeline.add({ kind: "note", text: `Apps for this task: ${Object.keys(apps.servers).length}` });

    // Agents over their monthly budget, or working through an engine whose budget is used up, sit this task out (budget.ts).
    const overBudget = await spending.leftOut(config.team);
    for (const l of overBudget) timeline.add({ kind: "note", text: l.note }, true);
    const teamConfig: Config = overBudget.length ? { ...taskConfig, team: teamWithout(taskConfig.team, overBudget) } : taskConfig;
    // Who spends what (attribution.ts), and each agent's budget for this task: past it, its tool calls are denied and its engine runs stopped.
    const agentName = agentNamer(config.team);
    const spend = new TaskSpend({
      agents: teamConfig.team.agents.filter((a) => a.enabled).map((a) => a.id),
      engineAgents: {
        codex: teamConfig.team.agents.filter((a) => a.enabled && a.engine === "codex").map((a) => a.id),
        gemini: teamConfig.team.agents.filter((a) => a.enabled && a.engine === "gemini").map((a) => a.id),
      },
      price: runtimePrices(runtime),
      capFor: (id) => perTaskCapUsd(config.budget, id),
      name: agentName,
      onCapReached: (_id, text) => timeline.add({ kind: "note", text }, true),
    });

    // Coding agent CLIs (Codex, Gemini) for agents whose engine is not Claude; one that cannot start is left out, never fails the task.
    const engineDeps = { repoDir, workRoot, redact, note: (text: string) => timeline.add({ kind: "note", text }), spend: spend.engines };
    const engines = await repoTaskEngines(teamConfig, engineDeps).catch((err: unknown) => {
      console.warn("[worker] engines not available:", redact(errorText(err)).slice(0, 300));
      return undefined;
    });

    // Reviews and comments on the pull (merge) request since the last run, by people with write access
    // (each host maps its own roles onto GitHub's associations, see CodeHost.prFeedback).
    // Feedback written from now on is new to the next run (see lastRunAt below).
    const seenAt = new Date().toISOString();
    let feedback = "";
    if (resumed && prior?.prNumber) {
      try {
        const items = (await host.prFeedback(task.repo, prior.prNumber)).filter((f) => isHumanFeedback(f, prior.lastRunAt));
        feedback = redact(formatFeedback(items, { prNumber: prior.prNumber, prUrl: prior.prUrl, repo: task.repo }));
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
      where,
    });

    const sharedNote = attachments.length ? ` and ${attachments.length} shared file${attachments.length === 1 ? "" : "s"}` : "";
    await stage("plan", `${pointerName} is reading ${task.repo}${sharedNote} and planning`);
    if (feedback) timeline.add({ kind: "note", text: `Read the new review feedback on the ${prWord}` });
    if (browser) timeline.add({ kind: "note", text: "The team has a headless browser for checks" });

    // Spending (budget.ts, sizing.ts): the task's budget is what is left of the caps, at most the per-task
    // budget (too little left refuses it, before the team runs); with routing on, its size picks the model.
    const allowance = await spending.taskBudget(task.repo, config.limits.maxBudgetUsd);
    if (!allowance.ok) throw new Error(allowance.error);
    const taskBudgetUsd = allowance.budgetUsd;
    if (allowance.note) timeline.add({ kind: "note", text: allowance.note });
    const routed = config.team.pointer.routing.enabled
      ? await routeRepoTask({
          config: teamConfig,
          task,
          followUp: resumed,
          attachments: attachments.length,
          history: () => tasks.recent(HISTORY_SCAN),
          budgetUsd: taskBudgetUsd,
          provider: runtime,
          redact,
        })
      : undefined;
    // The team runs with the routed model and effort (agents with their own keep them).
    const runConfig = routed?.config ?? teamConfig;
    if (routed) {
      task.size = routed.size;
      task.estimateUsd = routed.estimateUsd;
      timeline.add({ kind: "routing", text: routed.text }, true);
      await tasks.save(task).catch((err: unknown) => console.error("[worker] task not saved:", redact(String(err))));
    }
    await progress(`:compass: ${pointerName} is reading \`${task.repo}\`${sharedNote} and planning…${routed ? ` _(${routed.short})_` : ""}`, true);

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
    // The lessons library, written next to the checkout for the team to grep (lessons.ts). Unreadable lessons are skipped, not fatal.
    const lessonsLibrary = new LessonsRepo(store, masterKey);
    const lessons = await materializeLessons(lessonsLibrary, task.repo, join(workRoot, "lessons"), redact);
    if (lessons) timeline.add({ kind: "note", text: lessonsNote(lessons) });

    // The owner's test command, which the platform runs after the team instead of the team's own checks (recheck.ts).
    const testCommand = setup?.testCommand.trim() ?? "";
    const context: OrchestratorContext = {
      projectNotes,
      ...(lessons ? { lessons } : {}),
      attachments,
      ...(browser ? { browser: { shotsDir } } : {}),
      ...(setup ? { repoSetup: repoSetupContext(setup, setupResult) } : {}),
      host: host.kind,
      ...(config.limits.recheckMin > 0 ? { recheck: { testCommand } } : {}),
    };

    const everyMin = config.limits.progressEveryMin;
    // Read-only and lock-free, so it never gets in the way of the agents' own git commands. It runs while
    // they work, so their config is left alone: without credentials or the worker's environment
    // (gitRunner), a driver they configured could do no more here than their own commands can.
    const changedFiles = async (since: string) => {
      const [tracked, untracked] = await Promise.all([
        git(["--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv", "--name-only", since]),
        git(["--no-optional-locks", "ls-files", "--others", "--exclude-standard"]),
      ]);
      return [...new Set([...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean))];
    };
    // From a fresh bare repository, never from the checkout the agents had (publishBranch).
    const push = async () => {
      await restoreGitConfig();
      await publishBranch({ host, repo: task.repo, repoDir, branch, git, tmp: gitPrivate });
    };

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
        onEvent: (e) => timeline.tracker(e),
      });
      if (opts.phaseLabel) tracker.setPhase(opts.phaseLabel);
      // Each agent's share of this run, on top of the task's earlier runs (the console shows them live).
      const spendTracker = spend.startRun();
      let lastSaved = 0;
      const saveProgress = async (force = false) => {
        if (!force && Date.now() - lastSaved < 30_000) return;
        lastSaved = Date.now();
        task.progress = tracker.snapshot();
        task.agentCosts = spend.live();
        await tasks.save(task).catch((err: unknown) => console.error("[worker] progress not saved:", redact(String(err))));
      };
      let updating: Promise<void> = Promise.resolve();
      const postUpdate = () => {
        updating = updating
          .then(async () => {
            tracker.setFiles(await changedFiles(opts.since).catch(() => []));
            await saveProgress(true);
            // Console tasks: the saved progress is the update.
            if (!slack) return;
            await slack.chat.postMessage({
              channel: task.channel,
              thread_ts: task.threadTs,
              text: truncate(redact(formatProgress(tracker.snapshot(), { kind: "update" }))),
            });
          })
          .catch((err: unknown) => console.error("[worker] progress update failed:", redact(String(err))));
      };
      // Console tasks refresh the saved progress (files changed) every minute; Slack gets an update every `everyMin`.
      const updateMs = web ? 60_000 : everyMin * 60_000;
      const updateTimer = updateMs > 0 ? setInterval(postUpdate, updateMs) : undefined;

      let report: Report | undefined;
      let failure: string | undefined;
      let costUsd = 0;
      let turns = 0;
      let result: Parameters<TaskSpend["endRun"]>[0];
      try {
        for await (const message of query({
          prompt: runPrompt,
          options: {
            cwd: repoDir,
            abortController: opts.abort,
            ...teamQueryOptions(runConfig, opts.context, attachmentsDir, { browser, skills, apps, engines, provider: runtime }),
            // Headless: nothing can prompt, so anything not in allowedTools is denied.
            permissionMode: "dontAsk",
            settingSources: ["project"], // loads the project's own CLAUDE.md
            // The shell guard, and each agent's budget for this task (it also matches engine runs to their agents).
            hooks: { PreToolUse: [{ matcher: "Bash", hooks: [bashGuard] }, { hooks: [spend.hook] }] },
            outputFormat: { type: "json_schema", schema: REPORT_SCHEMA },
            maxTurns: config.limits.maxTurns,
            maxBudgetUsd: opts.budgetUsd,
            ...(runtime.model(runConfig.anthropic.model) ? { model: runtime.model(runConfig.anthropic.model) } : {}),
            ...(runtime.disallowedTools.length ? { disallowedTools: runtime.disallowedTools } : {}),
            ...(runtime.managedSettings ? { managedSettings: runtime.managedSettings } : {}),
            env: agentEnv,
          },
        })) {
          spendTracker.feed(message);
          if (tracker.onMessage(message)) {
            await progress(redact(formatProgress(tracker.snapshot(), { kind: "live", everyMin })));
            await saveProgress();
          }
          if (message.type === "result") {
            costUsd = message.total_cost_usd;
            result = message;
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
        // Claude Code's own cost per model, shared out between the agents.
        task.agentCosts = spend.endRun(result);
      }
      if (opts.abort.signal.aborted) failure = `Timed out after ${opts.timeoutMin} minutes.`;
      if (!report && !failure) failure = "The team finished without a report.";
      const final = tracker.snapshot();
      task.progress = final;
      return { report, failure: failure && redact(failure), costUsd, turns, plan: final.plan };
    };

    /**
     * One more round of the team after the first (fixing checks, checking the
     * preview): bounded by `runMs`, its cost added to the task's, its project
     * notes kept.
     */
    const extraRound = async (roundPrompt: string, o: { budgetUsd: number; runMs: number; since: string; phaseLabel: string }) => {
      const notesBefore = await loadNotes();
      const roundAbort = new AbortController();
      const roundTimer = setTimeout(() => roundAbort.abort(), o.runMs);
      const run = await runTeam(roundPrompt, {
        budgetUsd: o.budgetUsd,
        abort: roundAbort,
        timeoutMin: Math.round(o.runMs / 60_000),
        since: o.since,
        context: { ...context, projectNotes: notesBefore },
        phaseLabel: o.phaseLabel,
      }).finally(() => clearTimeout(roundTimer));
      task.costUsd = (task.costUsd ?? 0) + run.costUsd;
      task.turns = (task.turns ?? 0) + run.turns;
      if (run.report) await saveProjectNotes(notes, task.repo, notesBefore, run.report.projectNotes, redact);
      if (run.report) await saveTaskLessons(lessonsLibrary, task.repo, run.report.lessons, task.id, redact);
      return run;
    };

    // Set when the platform's run of the checks broke off (see below): the checkout may not be as the team left it,
    // so no later round commits from it.
    let workTreeUnsure = false;
    /** After a push: the request's checks and the fix rounds (followPrChecks). */
    const followChecks = (pr: PrRef) =>
      followPrChecks({
        host,
        repo: task.repo,
        pr,
        limits: workTreeUnsure ? { ...config.limits, ciFixRounds: 0 } : config.limits,
        deadline,
        base,
        branch,
        request: task.instruction,
        budgetLeft: () => taskBudgetUsd - (task.costUsd ?? 0),
        git: gitAfterAgents,
        push,
        runRound: extraRound,
        task,
        timeline,
        onStage: (text) => stage("checks", text),
        progress: (text) => progress(text, true),
        redact,
      });

    /**
     * After the checks: open the pull (merge) request's preview deployment in
     * the browser with one more round of the team that changes nothing (see
     * preview.ts). Its cost counts toward the task's; screenshots go the same
     * way as the others.
     */
    const previewOf = async (pr: PrRef, published: Report, checksFollowed: boolean): Promise<PreviewResult> => {
      const names = (out: string) => out.split("\n").filter(Boolean);
      const files = await gitAfterAgents(["--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv", "--name-only", `origin/${base}...HEAD`])
        .catch(() => gitAfterAgents(["--no-optional-locks", "diff", "--no-ext-diff", "--no-textconv", "--name-only", startSha, "HEAD"]))
        .then(names);
      const sha = await gitAfterAgents(["rev-parse", "HEAD"]);
      const phase: TaskPhase = config.limits.ciWaitMin > 0 ? "checks" : "publish";
      return checkPreview({
        mode: config.limits.previewCheck,
        files,
        browser: Boolean(browser),
        budget: { maxUsd: config.limits.maxBudgetUsd, spentUsd: task.costUsd ?? 0 },
        deadline,
        host,
        repo: task.repo,
        sha,
        since: await gitAfterAgents(["show", "-s", "--format=%cI", "HEAD"]).catch(() => undefined),
        prNumber: pr.number,
        checksFollowed,
        report: published,
        base,
        branch,
        request: task.instruction,
        where,
        bypassSecret: agentEnv[BYPASS_ENV],
        redact,
        onStage: async (text) => {
          await stage(phase, text);
          await progress(`:globe_with_meridians: ${text}…`, true);
        },
        onEvent: (e) => timeline.add({ kind: "preview", ...e }, true),
        runRound: (roundPrompt, { budgetUsd, runMs }) =>
          extraRound(roundPrompt, { budgetUsd, runMs, since: sha, phaseLabel: "Checking the preview deployment" }),
        postScreenshots: async (url) => {
          const before = shotsForPr();
          await postScreenshots((n) => `:camera: ${plural(n, "screenshot")} from the preview at ${url}.`);
          return shotsForPr() - before;
        },
      });
    };

    // ---------- 3. Let the team work ----------
    const first = await runTeam(prompt, {
      budgetUsd: taskBudgetUsd,
      abort,
      timeoutMin: Math.round(firstRunMs / 60_000),
      since: startSha,
      context,
    });
    clearTimeout(timer);
    // The size estimate's own (tiny) cost counts too: Pointer's.
    task.costUsd = first.costUsd + (routed?.costUsd ?? 0);
    if (routed?.costUsd) {
      spend.add({ [LEAD_AGENT_ID]: { usd: routed.costUsd } });
      task.agentCosts = spend.live();
    }
    task.turns = first.turns;
    const { report, failure } = first;
    // What the Slack result says, kept on the task for the console (and Pointer).
    if (report) task.report = taskReport(report, redact);

    // Saved before publishing so a failed push doesn't lose what the team learned (blocked reports too).
    if (report) await saveProjectNotes(notes, task.repo, projectNotes, report.projectNotes, redact);
    if (report) await saveTaskLessons(lessonsLibrary, task.repo, report.lessons, task.id, redact);

    // ---------- 4. Publish ----------
    // With the worker's own config back first: no filter or clean driver the agents configured runs in `add`.
    // What the team left in `git stash` goes back before anything is committed (commitTeamWork).
    const { ahead, unstashed } = await commitTeamWork(gitAfterAgents, {
      message: failure || !report ? `Work in progress (stopped early): ${failure}` : report.title,
      since: startSha,
    });
    if (unstashed.popped) timeline.add({ kind: "note", text: "Put back what the team had left in git stash" });
    // Said in the result and in the pull request: the published work may lack part of the change.
    const stashWarning = unstashed.stuck && redact(`${unstashed.stuck} The published work may lack it.`);
    if (stashWarning) timeline.add({ kind: "error", text: stashWarning }, true);

    // Screenshots go up first, so the pull request can point to them: into the store
    // (the console shows them, for every task) and, for Slack tasks, into the thread.
    const seenShots = new Set<string>();
    const posted = new Set<string>();
    let storedShots = 0;
    const resultNotes: string[] = stashWarning ? [stashWarning] : [];
    const postScreenshots = async (comment: (count: number) => string) => {
      const shots = newScreenshots(await collectScreenshots(shotsDir), seenShots);
      if (!shots.length) return;
      try {
        const stored = await screenshotStore.add(task.id, shots);
        storedShots += stored.length;
        task.screenshots = Math.max(task.screenshots ?? 0, storedShots);
        if (stored.length) {
          timeline.add({ kind: "screenshot", text: `${plural(stored.length, "screenshot")} saved: ${stored.map((s) => s.name).join(", ")}` }, true);
        }
      } catch (err) {
        console.error(`[worker] screenshots not stored: ${redact(errorText(err))}`);
      }
      if (!slack) return;
      try {
        await uploadThreadFiles(slack, {
          channel: task.channel,
          threadTs: task.threadTs,
          comment: comment(shots.length),
          files: shots.map((s) => ({ filename: s.name, data: s.bytes })),
        });
        for (const s of shots) posted.add(screenshotKey(s));
        task.screenshots = Math.max(task.screenshots ?? 0, posted.size);
      } catch (err) {
        const code = slackErrorCode(err);
        console.error(`[worker] screenshots not posted: ${redact(code ?? errorText(err))}`);
        const line = screenshotFailureLine(code);
        if (!resultNotes.includes(line)) resultNotes.push(line);
      }
    };
    // ---------- The platform runs the team's checks again (recheck.ts) ----------
    // On the committed change, before it is published; the checkout goes back to the team's work after each run.
    let recheck: RecheckRun | undefined;
    if (!failure && report?.kind === "change" && ahead > 0 && config.limits.recheckMin > 0) {
      // The team's committed work: what is published if the run breaks off (headBackTo).
      const teamHead = await gitAfterAgents(["rev-parse", "HEAD"]);
      try {
        recheck = await followRecheck({
          report,
          testCommand,
          limits: config.limits,
          deadline,
          repoDir,
          env: agentEnv,
          protectedPaths: [dataDir],
          base,
          branch,
          request: task.instruction,
          budgetLeft: () => taskBudgetUsd - (task.costUsd ?? 0),
          git: gitAfterAgents,
          runRound: extraRound,
          timeline,
          onStage: (text) => stage("verify", text),
          progress: (text) => progress(text, true),
          redact,
        });
        task.recheck = recheckSummary(recheck, redact);
        await tasks.save(task).catch((err: unknown) => console.error("[worker] task not saved:", redact(String(err))));
      } catch (err) {
        // The team's work is committed and is published as it is; nothing commits from the checkout after this.
        workTreeUnsure = true;
        const message = redact(errorText(err));
        console.error(`[worker] checks not run again: ${message}`);
        timeline.add({ kind: "error", text: `The checks could not be run again: ${message}` }, true);
        resultNotes.push(`The platform could not run the checks again: ${truncate(message, 300)}`);
        // A check may have committed before the checkout could be put back: never publish that commit.
        const stuck = await headBackTo(gitAfterAgents, teamHead);
        if (stuck) {
          throw new Error(`Nothing was published: the checks run again broke off (${truncate(message, 300)}) and the branch could not be put back on the team's work (${redact(stuck)}).`);
        }
      }
    } else if (!failure && report?.kind === "change" && ahead > 0) {
      timeline.add({ kind: "note", text: "Running the team's checks again is turned off" });
    }

    await postScreenshots((n) => `:camera: ${plural(n, "screenshot")} from the browser checks.`);
    // What the pull request points reviewers to: the thread's screenshots, or the console's.
    const shotsForPr = () => (slack ? posted.size : storedShots);

    const cost = () => (task.costUsd !== undefined ? ` · ~$${task.costUsd.toFixed(2)}` : "");
    const footer = prFooter(task.id, pointerName, where);
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
      // ---------- Stopped early: the work so far goes into a draft pull (merge) request ----------
      const reason = failure ?? "The team finished without a report.";
      let saved: PrRef | undefined;
      let pushed = false;
      timeline.add({ kind: "error", text: `Stopped early: ${reason}` }, true);
      // Where the team stopped; saving its work in a draft afterwards is not the failure.
      const stoppedIn = timeline.phase;
      if (ahead > 0) {
        try {
          await stage("publish", `Saving the unfinished work in a draft ${prWord}`);
          await progress(`:rocket: Saving the unfinished work in a draft ${prWord}…`, true);
          await push();
          pushed = true;
          timeline.add({ kind: "push", text: `Pushed branch ${branch}` });
          saved = await saveUnfinishedPr({
            host,
            repo: task.repo,
            branch,
            base,
            title: redact(wipTitle(task.instruction)),
            body: async () => {
              const filesChanged = (await gitAfterAgents(["diff", "--no-ext-diff", "--no-textconv", "--name-only", startSha, "HEAD"]))
                .split("\n")
                .filter(Boolean).length;
              return redact(draftPrBody({ reason, warning: stashWarning, plan: first.plan, filesChanged, screenshots: shotsForPr(), footer, where }));
            },
            comment: redact(stoppedComment(reason, first.plan, where)),
          });
          const label = prLabel(saved.number, host.kind);
          timeline.add({ kind: "pr", text: `${saved.draft ? `Draft ${label}` : capitalized(label)} keeps the unfinished work`, url: saved.html_url }, true);
        } catch (err) {
          console.error(`[worker] unfinished work not published: ${redact(errorText(err))}`);
          timeline.add({ kind: "error", text: `The unfinished work was not published: ${redact(errorText(err))}` });
          saved = undefined;
        }
      }

      task.status = "failed";
      task.error = reason;
      if (saved) {
        task.prUrl = saved.html_url;
        task.prDraft = Boolean(saved.draft);
        await saveThreadState(nextThreadState(saved, { reason, at: new Date().toISOString() }));
        const text = stoppedSlackText({ userId: task.userId, reason, pr: saved, cost: cost(), host: host.kind });
        await finish([text, ...resultNotes].join("\n\n"), ":warning: Stopped");
      } else {
        await saveThreadState(nextThreadState());
        const partial = !ahead
          ? ""
          : pushed
            ? ` The unfinished work is on branch \`${branch}\`, but no ${prWord} could be opened.`
            : " Partial work was not published.";
        if (partial) task.notes = [partial.trim()];
        await finish([`:x: <@${task.userId}> ${reason}${partial}${cost()}`, ...resultNotes].join("\n\n"), ":x: Stopped");
      }
      task.notes = [...(task.notes ?? []), ...resultNotes];
      await ticketStopped(ticket, task, { reason, ...(saved ? { prUrl: saved.html_url, draft: Boolean(saved.draft) } : {}) });
      await timeline.close(false, saved ? `Stopped: ${reason} The work so far is in ${prLabel(saved.number, host.kind)}.` : `Stopped: ${reason}`, stoppedIn);
    } else {
      const publish = ahead > 0 && report.kind !== "blocked";
      let pr: PrRef | undefined;
      let ci: { outcome: CiOutcome; note?: string } | undefined;

      if (publish) {
        await stage("publish", `Publishing the branch and opening the ${prWord}`);
        await progress(`:rocket: Publishing the branch and opening the ${prWord}…`, true);
        await push();
        timeline.add({ kind: "push", text: `Pushed branch ${branch}` });
        // A change left in `git stash` that could not be put back leads the risks.
        const risks = [stashWarning, report.risks].filter(Boolean).join("\n\n");
        const body = redact(prBody({ ...report, risks }, { recheck, screenshots: shotsForPr(), where, footer }));
        const published = await publishPr({ host, repo: task.repo, branch, base, title: redact(report.title), body, redact });
        pr = published.pr;
        const updated = published.updated;
        timeline.add({ kind: "pr", text: `${updated ? "Updated" : "Opened"} ${prLabel(pr.number, host.kind)}: ${report.title}`, url: pr.html_url }, true);
        // Saved now, not at the end: waiting for the checks can take a while (the console shows the link meanwhile).
        await saveThreadState(nextThreadState(pr));
        task.prUrl = pr.html_url;
        task.prDraft = false;
        await tasks.save(task).catch((err: unknown) => console.error("[worker] task not saved:", redact(String(err))));
        await ticketPrOpened(ticket, task, { url: pr.html_url, number: pr.number, title: redact(report.title), updated });

        if (config.limits.ciWaitMin <= 0) timeline.skip("checks", "Waiting for checks is turned off");
        if (config.limits.ciWaitMin > 0) {
          try {
            ci = await followChecks(pr);
          } catch (err) {
            // The request is open; only the follow-up on its checks broke (e.g. a fix could not be pushed).
            const message = redact(errorText(err));
            console.error(`[worker] checks not followed: ${message}`);
            resultNotes.push(`Following the ${prWord}'s checks failed: ${truncate(message, 300)}`);
          }
          // Only fix rounds can have added any; those already posted are skipped.
          await postScreenshots((n) => `:camera: ${plural(n, "more screenshot")} from fixing the checks.`);
        }

        // The preview deployment, after the checks (see preview.ts). Never fails the task: the pull request is open.
        task.preview = await previewOf(pr, report, ci !== undefined && ci.outcome.state !== "unavailable").catch((err: unknown): PreviewResult => {
          const note = `The preview could not be checked: ${truncate(redact(errorText(err)), 200)}`;
          console.error(`[worker] ${note}`);
          timeline.add({ kind: "preview", text: note, ok: false }, true);
          return { state: "unavailable", note };
        });
        await tasks.save(task).catch((err: unknown) => console.error("[worker] task not saved:", redact(String(err))));
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
      // Markdown for the console (the Slack text below converts the same notes).
      const rechecked = task.recheck;
      task.notes = [rechecked && recheckLine(rechecked), recheck?.note, ci?.note, ...resultNotes]
        .filter((n): n is string => Boolean(n))
        .map((n) => redact(n));
      const endText =
        report.kind === "blocked"
          ? `Blocked: ${report.title}`
          : publish
            ? `Done: ${report.title}${ci ? CHECKS_OUTCOME[ci.outcome.state] : ""}`
            : `Answered: ${report.title}`;
      await ticketFinished(ticket, task);
      await timeline.close(report.kind !== "blocked", endText);
      const head = resultHeadline({
        userId: task.userId,
        title: report.title,
        outcome: report.kind === "blocked" ? "blocked" : publish ? "published" : "answered",
        prUrl: pr?.html_url,
        host: host.kind,
      });
      const parts = [
        head,
        toMrkdwn(report.summary),
        report.verification && `*Verification:* ${toMrkdwn(report.verification)}`,
        rechecked && recheckLine(rechecked, "slack"),
        recheck?.note && toMrkdwn(recheck.note),
        report.risks && `*Risks:* ${toMrkdwn(report.risks)}`,
        ci && ciSummaryLine(ci.outcome, config.limits.ciWaitMin, host.kind),
        ci?.note && toMrkdwn(ci.note),
        task.preview && previewSlackLine(task.preview),
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
    await ticketStopped(ticket, task, { reason: messageText, ...(task.prUrl ? { prUrl: task.prUrl, draft: Boolean(task.prDraft) } : {}) });
    await timeline.close(false, `The task failed: ${messageText}`);
    await finish(`:x: <@${task.userId}> The task failed: ${truncate(messageText, 600)}`, ":x: Failed");
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    await rm(workRoot, { recursive: true, force: true }).catch(() => {});
    await rm(gitPrivate, { recursive: true, force: true }).catch(() => {});
    await providerSession?.dispose();
    // The task's cost is known now: a cap it took past its alert level or 100% tells the alert channel. Never throws.
    await spending.notify();
  }
}
