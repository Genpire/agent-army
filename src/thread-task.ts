import type { WebClient } from "@slack/web-api";
import type { Config } from "./config.js";
import { connectionForRepo, describeAllowed, hasGitHub } from "./github-access.js";
import type { Runner } from "./runner.js";
import { repoFromToken, resolveRepo } from "./targeting.js";
import { type Task, type TaskRepo, type TaskTicket, WEB_CHANNEL, newTaskId } from "./tasks.js";

export interface ThreadTaskDeps {
  tasks: TaskRepo;
  runner: Runner;
  /** A Slack client for the installed bot token; not needed for console (web) tasks. */
  slack?: WebClient;
  /** Removes credentials from error text before it is stored or returned. */
  redact?: (text: string) => string;
}

export interface ThreadTaskInput {
  repo: string;
  /** A Slack channel, or WEB_CHANNEL for a console conversation (then threadTs is the conversation id). */
  channel: string;
  threadTs: string;
  /** Slack user the task reports to ("admin" for console tasks). */
  userId: string;
  instruction: string;
  /** Posted in the Slack thread first; that message becomes the task's live progress message. Not posted for web tasks. */
  ackText: string;
  /** What started the task; "slack" when omitted. */
  trigger?: Task["trigger"];
  /** The monday.com ticket the task works on; its status follows the task (see ticket-sync.ts). */
  ticket?: TaskTicket;
}

export type ThreadTaskResult = { ok: true; taskId: string } | { ok: false; error: string };

/**
 * Starts a repo task in a Slack thread or a console conversation: for Slack,
 * posts the acknowledgement (its ts is the progress message the worker
 * edits); then saves the task as queued and launches the worker. A launch
 * failure marks the task failed. Never throws.
 */
export async function startThreadTask(deps: ThreadTaskDeps, input: ThreadTaskInput): Promise<ThreadTaskResult> {
  const redact = deps.redact ?? ((text: string) => text);
  let task: Task | undefined;
  try {
    const web = input.channel === WEB_CHANNEL;
    let progressTs: string | undefined;
    if (!web) {
      if (!deps.slack) return { ok: false, error: "Could not start the task: Slack is not connected." };
      const ack = await deps.slack.chat.postMessage({ channel: input.channel, thread_ts: input.threadTs, text: input.ackText });
      progressTs = ack.ts;
    }
    const now = new Date().toISOString();
    task = {
      id: newTaskId(),
      createdAt: now,
      updatedAt: now,
      status: "queued",
      repo: input.repo,
      channel: input.channel,
      threadTs: input.threadTs,
      ...(progressTs ? { progressTs } : {}),
      userId: input.userId,
      instruction: input.instruction.trim(),
      trigger: input.trigger ?? "slack",
      ...(input.ticket ? { ticket: input.ticket } : {}),
    };
    await deps.tasks.save(task);
  } catch (err) {
    return { ok: false, error: `Could not start the task: ${redact(errorText(err))}` };
  }

  try {
    await deps.runner.launch(task.id);
  } catch (err) {
    const error = `Could not start a worker: ${redact(errorText(err))}`;
    task.status = "failed";
    task.error = error;
    await deps.tasks.save(task).catch(() => undefined);
    return { ok: false, error };
  }
  return { ok: true, taskId: task.id };
}

/**
 * The repository a new task works on, with the same checks for Slack and the
 * console: the named repo (owner/repo), else the thread's, else the channel's
 * default; GitHub connected; a connection allowed to work on it (the worker
 * picks the same one). Errors are written for Pointer and the person.
 */
export function resolveTaskRepo(
  config: Config,
  opts: { repo?: string; threadRepo?: string; channelRepo?: string },
): { ok: true; repo: string } | { ok: false; error: string } {
  const named = opts.repo?.trim() ? repoFromToken(opts.repo.trim()) : undefined;
  if (named === null) return { ok: false, error: `"${opts.repo}" is not a repository. Use owner/repo.` };
  const target = resolveRepo({ override: named, threadRepo: opts.threadRepo, channelRepo: opts.channelRepo });
  if (!target) return { ok: false, error: "No repository: ask the user which owner/repo to use." };
  if (!hasGitHub(config)) {
    return { ok: false, error: "GitHub is not connected. Ask the owner to connect it on the admin page." };
  }
  if (!connectionForRepo(config, target)) {
    return { ok: false, error: `Not allowed to work on ${target}. Allowed owners and repositories: ${describeAllowed(config)}.` };
  }
  return { ok: true, repo: target };
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
