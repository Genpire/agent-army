import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Store } from "../core/store.js";
import type { RunnerKind } from "./runner.js";
import { addEvent, closeTimeline, currentPhase, emptyTimeline, readTimeline, timelineKey } from "./task-events.js";
import type { TaskRepo } from "./tasks.js";

/**
 * What a restart of the web service leaves behind, cleaned up when it starts
 * again. Platforms restart it on every deploy (Render, Railway, Fly.io and
 * Docker send SIGTERM, then SIGKILL), and the local runner's workers are its
 * child processes, so they stop with it:
 *
 *  - their checkouts (army-* folders in WORK_DIR and the temp folder), which
 *    the worker removes only when it ends normally;
 *  - their tasks, still "running" (or "queued", waiting for a worker) on
 *    their records, which keep their thread busy.
 *
 * Cloud Run job tasks run in their own containers and go on across a restart
 * of the web service, so only local tasks are marked.
 */

// ---------- The local runner's workers ----------

/**
 * Where the local runner notes the process of each worker it starts, one file
 * per task: in the temp folder, because a process id means something only on
 * this machine (a new container starts with an empty one).
 */
export const WORKER_PIDS_DIR = "agent-army-workers";
const TASK_ID = /^[a-z0-9-]{1,40}$/;

/** The local runner's note of its workers' processes. Never throws: without a note, a task counts as stopped. */
export class WorkerPids {
  constructor(private readonly dir = join(tmpdir(), WORKER_PIDS_DIR)) {}

  /** A worker started for this task. */
  started(taskId: string, pid: number | undefined): void {
    if (!TASK_ID.test(taskId) || !pid) return;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      if (!this.ours()) return;
      writeFileSync(join(this.dir, `${taskId}.json`), JSON.stringify({ pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
    } catch {
      // Not noted: after a restart the task is taken for stopped.
    }
  }

  /** The task's worker ended. */
  ended(taskId: string): void {
    if (!TASK_ID.test(taskId)) return;
    try {
      rmSync(join(this.dir, `${taskId}.json`), { force: true });
    } catch {
      // Left for the next start's sweep.
    }
  }

  /** The task's worker process is still running (on this machine, and it is not this process). */
  running(taskId: string): boolean {
    const pid = this.pid(taskId);
    return pid !== undefined && workerProcessRunning(pid);
  }

  /** Removes the notes of workers that are gone. */
  sweep(): void {
    try {
      if (!this.ours()) return;
      for (const name of readdirSync(this.dir)) {
        const taskId = name.replace(/\.json$/, "");
        if (name.endsWith(".json") && !this.running(taskId)) this.ended(taskId);
      }
    } catch {
      // No folder: nothing noted.
    }
  }

  private pid(taskId: string): number | undefined {
    if (!TASK_ID.test(taskId)) return undefined;
    try {
      if (!this.ours()) return undefined;
      const { pid } = JSON.parse(readFileSync(join(this.dir, `${taskId}.json`), "utf8")) as { pid?: unknown };
      return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  /** The folder is a real folder of this user's (the temp folder may be shared with other users). */
  private ours(): boolean {
    const info = lstatSync(this.dir);
    const uid = process.getuid?.();
    return info.isDirectory() && (uid === undefined || info.uid === uid);
  }
}

/**
 * Whether `pid` is a live process other than this one and its parent. Where
 * /proc exists (Linux), it must also be a worker (a new container reuses low
 * process ids, so an old worker's id may now be someone else's).
 */
export function workerProcessRunning(pid: number): boolean {
  if (pid === process.pid || pid === process.ppid) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("worker");
  } catch (err) {
    // No /proc at all (macOS): the signal check is all there is. With /proc, the process is gone.
    return (err as NodeJS.ErrnoException).code === "ENOENT" && !existsSync("/proc/self/cmdline");
  }
}

// ---------- Interrupted tasks ----------

export const INTERRUPTED_ERROR = "Interrupted: the server restarted while the task ran. Reply in the thread to continue.";
/** Recent tasks looked at: running ones are among the newest. */
const RECENT_TASKS = 200;

/**
 * Marks the local tasks whose worker stopped with the server as failed, with
 * INTERRUPTED_ERROR, and closes their timeline. Call it once at the web
 * service's start, before it launches anything. A task's `runner` says where
 * it runs; tasks saved before it existed are taken to run on `runner`, this
 * server's. Returns the ids marked; never throws.
 */
export async function markInterruptedTasks(deps: {
  tasks: Pick<TaskRepo, "recent" | "save">;
  store: Pick<Store, "get" | "put">;
  runner: RunnerKind;
  workers: Pick<WorkerPids, "running" | "ended">;
  now?: () => Date;
}): Promise<string[]> {
  const marked: string[] = [];
  let recent;
  try {
    recent = await deps.tasks.recent(RECENT_TASKS);
  } catch (err) {
    console.error("[runner] interrupted tasks not checked:", (err as NodeJS.ErrnoException | undefined)?.code ?? "error");
    return marked;
  }
  for (const task of recent) {
    if (task.status !== "running" && task.status !== "queued") continue;
    if ((task.runner ?? deps.runner) !== "local" || deps.workers.running(task.id)) continue;
    try {
      task.status = "failed";
      task.error = INTERRUPTED_ERROR;
      await deps.tasks.save(task);
    } catch (err) {
      console.error(`[runner] task ${task.id} not marked interrupted:`, (err as NodeJS.ErrnoException | undefined)?.code ?? "error");
      continue;
    }
    marked.push(task.id);
    deps.workers.ended(task.id);
    await closeInterruptedTimeline(deps.store, task.id, (deps.now?.() ?? new Date()).toISOString()).catch((err: unknown) =>
      console.error(`[runner] timeline of task ${task.id} not closed:`, (err as NodeJS.ErrnoException | undefined)?.code ?? "error"),
    );
  }
  if (marked.length) console.log(`[runner] ${marked.length} task${marked.length === 1 ? "" : "s"} interrupted by the restart marked failed: ${marked.join(", ")}`);
  return marked;
}

/** The timeline ends where the task was, failed, like the worker's own close would. */
async function closeInterruptedTimeline(store: Pick<Store, "get" | "put">, taskId: string, at: string): Promise<void> {
  const timeline = (await readTimeline(store, taskId)) ?? emptyTimeline(taskId, new Date(at));
  closeTimeline(timeline, false, at, INTERRUPTED_ERROR);
  addEvent(timeline, { at, phase: currentPhase(timeline), kind: "end", text: INTERRUPTED_ERROR, ok: false });
  timeline.updatedAt = at;
  await store.put(timelineKey(taskId), JSON.stringify(timeline));
}

// ---------- Leftover checkouts ----------

/** A worker's folders: its checkout's (army-XXXXXX, in WORK_DIR or the temp folder) and its git folder's (army-git-XXXXXX). */
const WORK_FOLDER = /^army-(git-)?[A-Za-z0-9]{6}$/;
/** What a worker puts in them; a folder holding anything else is not a worker's. */
const WORK_ENTRIES = /^(repo|attachments|screenshots|skills-plugin|engines-[A-Za-z0-9]{6})$/;
const GIT_ENTRIES = /^(home|army-push-[A-Za-z0-9]{6})$/;
/** Local workers have no deadline unless JOB_TIMEOUT_MIN sets one; none runs this long. */
export const DEFAULT_STALE_WORK_MS = 24 * 60 * 60_000;

/** How old a worker's folder must be to be left over: the job's deadline (JOB_TIMEOUT_MIN), else a day. */
export function staleWorkFolderAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(env.JOB_TIMEOUT_MIN);
  return env.JOB_TIMEOUT_MIN?.trim() && Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : DEFAULT_STALE_WORK_MS;
}

/** WORK_DIR (where checkouts go when it is set) and the temp folder, each once. */
export function workFolderDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([env.WORK_DIR?.trim(), tmpdir()].filter((d): d is string => Boolean(d)).map((d) => resolve(d)))];
}

/**
 * Removes the folders of workers that were killed before they could remove
 * them: this user's army-* folders older than `maxAgeMs` (no worker runs
 * longer) that hold only what a worker puts there. Returns how many it
 * removed; never throws.
 */
export async function removeStaleWorkFolders(opts: { dirs?: string[]; maxAgeMs?: number; now?: number } = {}): Promise<number> {
  const dirs = opts.dirs ?? workFolderDirs();
  const maxAgeMs = opts.maxAgeMs ?? staleWorkFolderAgeMs();
  const now = opts.now ?? Date.now();
  const uid = process.getuid?.();
  let removed = 0;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = name.match(WORK_FOLDER);
      if (!match) continue;
      const path = join(dir, name);
      try {
        // lstat: a link with this name is not a folder of ours.
        const info = await lstat(path);
        if (!info.isDirectory() || (uid !== undefined && info.uid !== uid) || now - info.mtimeMs < maxAgeMs) continue;
        const allowed = match[1] ? GIT_ENTRIES : WORK_ENTRIES;
        if (!(await readdir(path)).every((entry) => allowed.test(entry))) continue;
        await rm(path, { recursive: true, force: true });
        removed++;
      } catch {
        // Gone already, or not ours to remove.
      }
    }
  }
  if (removed) console.log(`[runner] removed ${removed} work folder${removed === 1 ? "" : "s"} left by stopped tasks`);
  return removed;
}
