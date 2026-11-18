import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { type HookCallback, type Options, query } from "@anthropic-ai/claude-agent-sdk";
import {
  type OrchestratorContext,
  REPORT_SCHEMA,
  type Report,
  type SharedFile,
  orchestratorPrompt,
  parseReport,
} from "./agents.js";
import { AttachmentRepo, type ThreadRef, classify, expandZip } from "./attachments.js";
import { type Config, ConfigRepo, resolveMasterKey } from "./config.js";
import { GitHub } from "./github.js";
import { connectionForRepo, githubTokens } from "./github-access.js";
import { checkBashCommand } from "./guard.js";
import { NOTES_MAX_CHARS, NotesRepo } from "./notes.js";
import { slackClient, toMrkdwn, truncate } from "./slack.js";
import { ProgressTracker, formatProgress } from "./progress.js";
import { createStore } from "./store.js";
import { type Task, TaskRepo, decodeTaskPayload } from "./tasks.js";
import { type Team, agentLabel, buildRepoAgents, repoAllowedTools } from "./team.js";

const exec = promisify(execFile);

/** How a subagent call appears in the Slack progress line, e.g. ":hammer_and_wrench: Sara (Coder)". */
export function subagentLabel(team: Team, subagentType: string | undefined): string {
  const agent = team.agents.find((a) => a.id === subagentType);
  return agent ? agentLabel(agent) : `:robot_face: ${subagentType || "agent"}`;
}

/**
 * The parts of the query that come from the configured team: Pointer's prompt, the subagents and what they may use.
 * With shared files (context.attachments) and the folder they were written to, that folder is opened to the team too.
 */
export function teamQueryOptions(
  config: Config,
  context: OrchestratorContext = {},
  attachmentsDir?: string,
): Required<Pick<Options, "systemPrompt" | "agents" | "allowedTools" | "effort">> & Pick<Options, "additionalDirectories"> {
  return {
    systemPrompt: { type: "preset", preset: "claude_code", append: orchestratorPrompt(config, context) },
    // Each agent carries its own effort (its setting, or this one).
    effort: config.team.pointer.taskEffort,
    agents: buildRepoAgents(config.team),
    // Under "dontAsk" anything not listed is denied, so this covers every
    // enabled agent's tools (e.g. WebSearch for agents that only look).
    allowedTools: repoAllowedTools(config.team),
    // The shared files sit next to the checkout, not in it, so they are never committed.
    ...(attachmentsDir && context.attachments?.length ? { additionalDirectories: [attachmentsDir] } : {}),
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
  const needles = secrets.filter((s): s is string => Boolean(s && s.length >= 6));
  return (text: string) => needles.reduce((acc, s) => acc.split(s).join("[redacted]"), text);
}

/**
 * Every credential the config holds, for makeRedactor: Claude, Slack and
 * monday.com, and every GitHub connection's token (not only the one in use),
 * each also in the form git sends it (the Basic auth header and its value).
 */
export function configSecrets(c: Config): (string | undefined)[] {
  const github = githubTokens(c).flatMap((token) => {
    const header = new GitHub(token).gitAuthHeader();
    return [token, header, header.split(" ").pop()];
  });
  return [c.anthropic.apiKey, c.slack.botToken, c.slack.signingSecret, c.monday.token, ...github];
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

  const abort = new AbortController();
  const timeoutMin = Number(process.env.TASK_TIMEOUT_MIN ?? 50);
  const timer = setTimeout(() => abort.abort(), timeoutMin * 60_000);

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
    let branch = thread?.repo === task.repo ? thread.branch : branchName(task.instruction, task.id);
    let resumed = false;
    if (thread?.repo === task.repo) {
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

    // ---------- 2. Let the team work ----------
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

    const prompt = [
      `Request from Slack (user ${task.userId}):`,
      task.instruction,
      "",
      `Repository: ${task.repo}. Base branch: ${base}. You are on branch: ${branch}.`,
      resumed
        ? "This is a follow-up in an existing thread: the branch already contains the team's earlier work (see `git log`). Build on it."
        : "This is a fresh branch off the base branch.",
      ...(attachments.length
        ? [`The requester shared ${attachments.length} file(s) for this task: see "Files shared for this task" in your instructions.`]
        : []),
    ].join("\n");

    const sharedNote = attachments.length ? ` and ${attachments.length} shared file${attachments.length === 1 ? "" : "s"}` : "";
    await progress(`:compass: ${pointerName} is reading \`${task.repo}\`${sharedNote} and planning…`, true);

    // What earlier tasks learned about this repo. Unreadable notes are skipped, not fatal.
    const projectNotes = await notes.get(task.repo).then(
      (n) => n?.text ?? "",
      (err: unknown) => {
        console.error(`[worker] could not load project notes: ${redact(err instanceof Error ? err.message : String(err))}`);
        return "";
      },
    );

    // Live progress: the progress message becomes a dashboard, the task record keeps a
    // copy for Pointer, and an update is posted in the thread every few minutes.
    const tracker = new ProgressTracker({
      lead: pointerName,
      label: (type) => subagentLabel(config.team, type),
      repoDir,
    });
    const everyMin = config.limits.progressEveryMin;
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
          tracker.setFiles(await changedFiles().catch(() => []));
          await saveProgress(true);
          await slack.chat.postMessage({
            channel: task.channel,
            thread_ts: task.threadTs,
            text: truncate(redact(formatProgress(tracker.snapshot(), { kind: "update" }))),
          });
        })
        .catch((err: unknown) => console.error("[worker] progress update failed:", redact(String(err))));
    };
    // Read-only and lock-free, so it never gets in the way of the agents' own git commands.
    const changedFiles = async () => {
      const [tracked, untracked] = await Promise.all([
        git(["--no-optional-locks", "diff", "--name-only", startSha]),
        git(["--no-optional-locks", "ls-files", "--others", "--exclude-standard"]),
      ]);
      return [...new Set([...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean))];
    };
    const updateTimer = everyMin > 0 ? setInterval(postUpdate, everyMin * 60_000) : undefined;

    let report: Report | undefined;
    let failure: string | undefined;
    try {
      for await (const message of query({
        prompt,
        options: {
          cwd: repoDir,
          abortController: abort,
          ...teamQueryOptions(config, { projectNotes, attachments }, attachmentsDir),
          // Headless: nothing can prompt, so anything not in allowedTools is denied.
          permissionMode: "dontAsk",
          settingSources: ["project"], // loads the project's own CLAUDE.md
          hooks: { PreToolUse: [{ matcher: "Bash", hooks: [bashGuard] }] },
          outputFormat: { type: "json_schema", schema: REPORT_SCHEMA },
          maxTurns: config.limits.maxTurns,
          maxBudgetUsd: config.limits.maxBudgetUsd,
          ...(config.anthropic.model ? { model: config.anthropic.model } : {}),
          // Replaces the environment: the agents' shell sees none of the
          // platform's own secrets (master key, Slack and GitHub tokens).
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "/tmp",
            LANG: process.env.LANG ?? "C.UTF-8",
            CI: "1",
            ANTHROPIC_API_KEY: apiKey,
            CLAUDE_AGENT_SDK_CLIENT_APP: "agent-army/0.1.0",
          },
        },
      })) {
        if (tracker.onMessage(message)) {
          await progress(redact(formatProgress(tracker.snapshot(), { kind: "live", everyMin })));
          await saveProgress();
        }
        if (message.type === "result") {
          task.costUsd = message.total_cost_usd;
          task.turns = message.num_turns;
          if (message.subtype === "success" && !message.is_error) {
            report = parseReport(message.structured_output, message.result);
          } else if (message.subtype === "success") {
            // e.g. a rejected API key arrives as a "success" result flagged is_error
            failure = `The team could not run: ${message.result || "unknown error"}.`;
          } else {
            const why: Record<string, string> = {
              error_max_turns: `hit the ${config.limits.maxTurns}-turn limit`,
              error_max_budget_usd: `hit the $${config.limits.maxBudgetUsd} budget limit`,
            };
            failure = `The team stopped early: ${why[message.subtype] ?? (message.errors.join("; ") || message.subtype)}.`;
          }
        }
      }
    } catch (err) {
      // The SDK also throws after an error result; keep the more specific message.
      failure ??= redact(`The team could not run: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // No progress save may land after the final status below.
      clearInterval(updateTimer);
      await updating;
    }
    if (abort.signal.aborted) failure = `Timed out after ${timeoutMin} minutes.`;
    if (!report && !failure) failure = "The team finished without a report.";

    // Saved before publishing so a failed push doesn't lose what the team learned (blocked reports too).
    if (report) await saveProjectNotes(notes, task.repo, projectNotes, report.projectNotes, redact);

    // ---------- 3. Publish ----------
    await git(["add", "-A"]);
    const dirty = (await git(["status", "--porcelain"])) !== "";
    if (dirty) await git(["commit", "-m", report?.title ?? "Work in progress (Agent Army)"]);
    const ahead = Number(await git(["rev-list", "--count", `${startSha}..HEAD`]));

    let prUrl: string | undefined = thread?.repo === task.repo ? thread.prUrl : undefined;
    let prNumber: number | undefined = thread?.repo === task.repo ? thread.prNumber : undefined;
    const publish = ahead > 0 && report !== undefined && report.kind !== "blocked";

    if (publish && report) {
      await progress(":rocket: Publishing the branch and opening the pull request…", true);
      await git(["push", "origin", `HEAD:refs/heads/${branch}`], { auth: true });
      const prBody = [
        report.summary,
        report.verification && `### Verification\n${report.verification}`,
        report.risks && `### Risks and follow-ups\n${report.risks}`,
        `---\nRequested in Slack · task \`${task.id}\` · built by ${pointerName} and the team. A human must review and merge.`,
      ]
        .filter(Boolean)
        .join("\n\n");
      const existing = await github.findOpenPr(task.repo, branch);
      if (existing) {
        await github.commentOnPr(task.repo, existing.number, `**Update: ${report.title}**\n\n${prBody}`);
        prUrl = existing.html_url;
        prNumber = existing.number;
      } else {
        const pr = await github.createPr(task.repo, { title: report.title, body: prBody, head: branch, base });
        prUrl = pr.html_url;
        prNumber = pr.number;
      }
      await tasks.saveThread(task.channel, task.threadTs, { repo: task.repo, branch, prUrl, prNumber });
    }

    // ---------- 4. Report ----------
    const cost = task.costUsd !== undefined ? ` · ~$${task.costUsd.toFixed(2)}` : "";
    if (failure || !report) {
      task.status = "failed";
      task.error = failure;
      await finish(`:x: <@${task.userId}> ${failure}${ahead > 0 ? " Partial work was not published." : ""}${cost}`, ":x: Stopped");
    } else {
      task.status = "done";
      task.kind = publish ? "change" : report.kind;
      task.summary = report.summary;
      task.prUrl = publish ? prUrl : undefined;
      const head =
        report.kind === "blocked"
          ? `:warning: <@${task.userId}> *Blocked: ${report.title}*`
          : publish
            ? `:white_check_mark: <@${task.userId}> *${report.title}* — <${prUrl}|review the pull request>`
            : `:speech_balloon: <@${task.userId}> *${report.title}*`;
      const parts = [
        head,
        toMrkdwn(report.summary),
        report.verification && `*Verification:* ${toMrkdwn(report.verification)}`,
        report.risks && `*Risks:* ${toMrkdwn(report.risks)}`,
        `_${task.repo} · \`${branch}\`${cost}_`,
      ];
      const outcome = report.kind === "blocked" ? ":warning: Blocked" : publish ? ":white_check_mark: Done" : ":speech_balloon: Answered";
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
