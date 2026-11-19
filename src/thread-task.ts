import type { WebClient } from "@slack/web-api";
import type { Runner } from "./runner.js";
import { type Task, type TaskRepo, newTaskId } from "./tasks.js";

export interface ThreadTaskDeps {
  tasks: TaskRepo;
  runner: Runner;
  /** A Slack client for the installed bot token. */
  slack: WebClient;
  /** Removes credentials from error text before it is stored or returned. */
  redact?: (text: string) => string;
}

export interface ThreadTaskInput {
  repo: string;
  channel: string;
  threadTs: string;
  /** Slack user the task reports to. */
  userId: string;
  instruction: string;
  /** Posted in the thread first; that message becomes the task's live progress message. */
  ackText: string;
  /** What started the task; "slack" when omitted. */
  trigger?: Task["trigger"];
}

export type ThreadTaskResult = { ok: true; taskId: string } | { ok: false; error: string };

/**
 * Starts a repo task in a Slack thread: posts the acknowledgement (its ts is
 * the progress message the worker edits), saves the task as queued and
 * launches the worker. A launch failure marks the task failed. Never throws.
 */
export async function startThreadTask(deps: ThreadTaskDeps, input: ThreadTaskInput): Promise<ThreadTaskResult> {
  const redact = deps.redact ?? ((text: string) => text);
  let task: Task | undefined;
  try {
    const ack = await deps.slack.chat.postMessage({ channel: input.channel, thread_ts: input.threadTs, text: input.ackText });
    const now = new Date().toISOString();
    task = {
      id: newTaskId(),
      createdAt: now,
      updatedAt: now,
      status: "queued",
      repo: input.repo,
      channel: input.channel,
      threadTs: input.threadTs,
      progressTs: ack.ts,
      userId: input.userId,
      instruction: input.instruction.trim(),
      trigger: input.trigger ?? "slack",
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

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
