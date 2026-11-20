import { randomBytes } from "node:crypto";
import type { ProgressSnapshot } from "./progress.js";
import type { Store } from "./core/store.js";

export type TaskStatus = "queued" | "running" | "done" | "failed";

/** The channel of tasks started from the admin console: no Slack thread, everything is on the task record. */
export const WEB_CHANNEL = "web";

/** True for tasks started from the admin console (a chat conversation or a direct task), which run without Slack. */
export const isWebTask = (task: Pick<Task, "channel">): boolean => task.channel === WEB_CHANNEL;

/** The steps of a repo task, in order: the console shows them as a stepper. */
export const TASK_PHASES = ["clone", "setup", "plan", "build", "verify", "publish", "checks"] as const;
export type TaskPhase = (typeof TASK_PHASES)[number];

/** What the team reported at the end of a run (the Slack result says the same). */
export interface TaskReport {
  title: string;
  summary: string;
  verification: string;
  risks: string;
}

export interface Task {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: TaskStatus;
  repo: string;
  channel: string;
  /** Slack thread the task lives in (a conversation id for web tasks); follow-ups in the thread reuse the branch. */
  threadTs: string;
  /** The bot's own progress message, edited in place while the team works. */
  progressTs?: string;
  userId: string;
  instruction: string;
  branch?: string;
  prUrl?: string;
  kind?: "change" | "answer" | "blocked";
  summary?: string;
  costUsd?: number;
  turns?: number;
  error?: string;
  /** Live progress while the team works, saved by the worker; Pointer reads it for status questions. */
  progress?: ProgressSnapshot;
  /** What started the task: a Slack request (default), the admin console, or feedback on its pull request. */
  trigger?: "slack" | "web" | "review" | "monday" | "jira";
  /** The pull request's checks after the last push (see ci.ts), when the task waited for them. */
  ci?: CiSummary;
  /** Screenshots from browser checks posted in the thread and kept in the store (see screenshots.ts). */
  screenshots?: number;
  /** The team's report (title, summary, verification, risks), once it finished with one. */
  report?: TaskReport;
  /** Other lines of the result (checks that could not be fixed, screenshots that could not be posted), Markdown. */
  notes?: string[];
  /** Where the task is now, outside the team's own progress: cloning, setup, publishing, waiting for checks. */
  stage?: { phase: TaskPhase; text: string; at: string };
  /** The pull request is a draft that keeps unfinished work (the task stopped early). */
  prDraft?: boolean;
  /** The last round of fixing failing checks the team started. */
  fixRound?: { round: number; rounds: number; failing: string[]; at: string };
  /** The monday.com or Jira ticket this task works on. */
  ticket?: TaskTicket;
  /** Estimated size (see sizing.ts) and the model and effort that size runs with. */
  size?: { size: "small" | "medium" | "large"; model: string; effort: string; reason?: string };
  /** Rough cost range from earlier tasks of the same size, in USD. */
  estimateUsd?: { low: number; high: number };
  /** The check of the pull request's preview deployment. */
  preview?: PreviewResult;
}

/** Outcome of waiting for a pull request's checks. */
/** The ticket a task works on (started from it, or linked to it): a monday.com item or a Jira issue. */
export interface TaskTicket {
  /** Absent on tickets saved before Jira existed: monday.com. */
  provider?: "monday" | "jira";
  /** monday.com: the board id. Jira: the project key ("ACME"). */
  boardId: string;
  /** monday.com: the item id. Jira: the issue key ("ACME-123"). */
  itemId: string;
  /** The ticket's name, for messages. */
  name?: string;
  url?: string;
}

/** What opening the pull request's preview deployment showed (see preview.ts). */
export interface PreviewResult {
  /** checked: opened and looked right; problems: opened and found issues; unavailable: no preview, or it could not be opened; skipped: not needed. */
  state: "checked" | "problems" | "unavailable" | "skipped";
  url?: string;
  /** One or two sentences: what was checked or why not. */
  note?: string;
}

export interface CiSummary {
  /** passed: every check succeeded; failed: at least one failed; pending: still running when the wait ended; none: the repo has no checks. */
  state: "passed" | "failed" | "pending" | "none";
  /** Fix rounds the team ran for failing checks. */
  fixRounds: number;
  /** Names of the checks that failed (state failed) or were still running (state pending). */
  names: string[];
  /** Number of checks seen on the last commit. */
  total: number;
}

export interface ThreadState {
  repo: string;
  branch: string;
  prUrl?: string;
  prNumber?: number;
  /** Slack user who started the thread's first task; follow-ups from GitHub mention them. */
  requester?: string;
  /** When the thread's last task ended (ISO): review feedback after it is new to the team. */
  lastRunAt?: string;
  /** Set when the last task stopped before finishing (timeout, budget, turns); its work is on the branch in a draft PR. */
  stopped?: { reason: string; at: string };
}

/** Which Slack thread a pull request opened by a task belongs to. */
export interface PrThread {
  channel: string;
  threadTs: string;
}

const prKey = (repo: string, number: number) => `prs/${repo.toLowerCase().replace("/", "__")}-${number}.json`;

/** Sortable by creation time, so listing newest-first is a string sort. */
export function newTaskId(now = Date.now()): string {
  return `${now.toString(36).padStart(9, "0")}-${randomBytes(3).toString("hex")}`;
}

const threadKey = (channel: string, threadTs: string) =>
  `threads/${channel}-${threadTs.replace(".", "_")}.json`;

export class TaskRepo {
  constructor(private readonly store: Store) {}

  async save(task: Task): Promise<void> {
    task.updatedAt = new Date().toISOString();
    await this.store.put(`tasks/${task.id}.json`, JSON.stringify(task));
  }

  async get(id: string): Promise<Task | null> {
    const blob = await this.store.get(`tasks/${id}.json`);
    return blob ? (JSON.parse(blob.toString("utf8")) as Task) : null;
  }

  async recent(limit = 30): Promise<Task[]> {
    const keys = (await this.store.list("tasks/")).filter((k) => k.endsWith(".json"));
    keys.sort().reverse();
    const tasks = await Promise.all(
      keys.slice(0, limit).map(async (k) => {
        const blob = await this.store.get(k);
        return blob ? (JSON.parse(blob.toString("utf8")) as Task) : null;
      }),
    );
    return tasks.filter((t): t is Task => t !== null);
  }

  /** Tasks created in [fromMs, toMs). Ids start with the creation time, so the keys alone select them. */
  async between(fromMs: number, toMs: number): Promise<Task[]> {
    const lo = newTaskId(fromMs).split("-")[0]!;
    const hi = newTaskId(toMs).split("-")[0]!;
    const keys = (await this.store.list("tasks/")).filter((k) => {
      if (!k.endsWith(".json")) return false;
      const stamp = k.slice(k.lastIndexOf("/") + 1).split("-")[0]!;
      return stamp >= lo && stamp < hi;
    });
    const tasks = await Promise.all(
      keys.map(async (k) => {
        const blob = await this.store.get(k);
        return blob ? (JSON.parse(blob.toString("utf8")) as Task) : null;
      }),
    );
    return tasks.filter((t): t is Task => t !== null);
  }

  async getThread(channel: string, threadTs: string): Promise<ThreadState | null> {
    const blob = await this.store.get(threadKey(channel, threadTs));
    return blob ? (JSON.parse(blob.toString("utf8")) as ThreadState) : null;
  }

  async saveThread(channel: string, threadTs: string, state: ThreadState): Promise<void> {
    await this.store.put(threadKey(channel, threadTs), JSON.stringify(state));
  }

  /** Remembers the Slack thread of a pull request a task opened, so GitHub feedback on it can be routed back. */
  async savePrThread(repo: string, number: number, ref: PrThread): Promise<void> {
    await this.store.put(prKey(repo, number), JSON.stringify(ref));
  }

  async getPrThread(repo: string, number: number): Promise<PrThread | null> {
    const blob = await this.store.get(prKey(repo, number));
    if (!blob) return null;
    const ref = JSON.parse(blob.toString("utf8")) as Partial<PrThread>;
    return typeof ref.channel === "string" && typeof ref.threadTs === "string" ? { channel: ref.channel, threadTs: ref.threadTs } : null;
  }

  /** Queued or running tasks of one Slack thread, newest first (looks at the most recent `scan` tasks). */
  async activeInThread(channel: string, threadTs: string, scan = 50): Promise<Task[]> {
    return (await this.recent(scan)).filter(
      (t) => t.channel === channel && t.threadTs === threadTs && (t.status === "queued" || t.status === "running"),
    );
  }
}

export function encodeTaskPayload(taskId: string): string {
  return Buffer.from(JSON.stringify({ taskId }), "utf8").toString("base64");
}

export function decodeTaskPayload(b64: string): { taskId: string } {
  const parsed = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as { taskId?: unknown };
  if (typeof parsed.taskId !== "string" || !/^[a-z0-9-]+$/.test(parsed.taskId)) {
    throw new Error("Invalid task payload");
  }
  return { taskId: parsed.taskId };
}
