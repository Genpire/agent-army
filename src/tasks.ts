import { randomBytes } from "node:crypto";
import type { ProgressSnapshot } from "./progress.js";
import type { Store } from "./store.js";

export type TaskStatus = "queued" | "running" | "done" | "failed";

export interface Task {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: TaskStatus;
  repo: string;
  channel: string;
  /** Slack thread the task lives in; follow-ups in the thread reuse the branch. */
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
}

export interface ThreadState {
  repo: string;
  branch: string;
  prUrl?: string;
  prNumber?: number;
}

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
