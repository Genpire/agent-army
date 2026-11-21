import { spawn } from "node:child_process";
import { totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import { WorkerPids } from "./restart.js";
import { encodeTaskPayload } from "./tasks.js";

/**
 * Starts one isolated worker per task.
 *
 *  - local:    child process of this server. Works anywhere Docker runs
 *              (laptop, VM, Kubernetes pod). Parallelism is capped in-process,
 *              by the Settings limit and this instance's memory (parallelCap).
 *  - cloudrun: one Cloud Run Job execution per task, using this same image.
 *              Each task gets its own container, CPU and memory.
 */
export interface Runner {
  readonly kind: "local" | "cloudrun";
  launch(taskId: string): Promise<void>;
  /** The server is stopping: start no more workers (queued tasks are marked interrupted at the next start). */
  stop?(): void;
}

export type RunnerKind = Runner["kind"];

// The job is named by WORKER_JOB, not CLOUD_RUN_JOB: Cloud Run reserves that name
// (it rejects it on services and sets it to the short job name inside job executions).
/** RUNNER, else cloudrun when WORKER_JOB is set, else local. */
export function runnerKind(env: NodeJS.ProcessEnv = process.env): RunnerKind {
  return env.RUNNER === "cloudrun" || (!env.RUNNER && env.WORKER_JOB) ? "cloudrun" : "local";
}

// ---------- How many tasks run at the same time ----------

/** What one repo task is planned with (Claude Code, the repo's own build, Chromium), and what the server keeps. Estimates. */
export const TASK_MEMORY_GIB = 2;
export const SERVER_MEMORY_GIB = 1.5;
const GIB = 1024 ** 3;

/** The deployment's ceiling on parallel tasks, and why: MAX_PARALLEL, or this instance's memory. */
export interface ParallelCap {
  max: number;
  reason: "env" | "memory";
  /** The instance's memory in GiB, to one decimal (reason "memory"). */
  memoryGiB?: number;
}

/** How many repo tasks this server runs at the same time, for the console. */
export interface ParallelLimit {
  /** The Settings value (limits.maxParallel). */
  configured: number;
  /** What the runner allows: the setting, lowered to the cap. */
  effective: number;
  /** Undefined on Cloud Run: every task is its own job. */
  cap?: ParallelCap;
}

/**
 * This instance's memory in bytes: its container's limit when there is one
 * (process.constrainedMemory, the cgroup limit; 0 or a huge number when
 * there is none), else the machine's.
 */
export function instanceMemoryBytes(): number {
  const total = totalmem();
  const constrained = process.constrainedMemory?.() ?? 0;
  return constrained > 0 && constrained < total ? constrained : total;
}

/** Tasks that fit in this much memory next to the server: max(1, floor((GiB − 1.5) / 2)). 4 GiB → 1, 8 GiB → 3, 16 GiB → 7. */
export function memoryCap(bytes: number): number {
  return Math.max(1, Math.floor((bytes / GIB - SERVER_MEMORY_GIB) / TASK_MEMORY_GIB));
}

/** MAX_PARALLEL as a whole number from 1 to 50; undefined when unset, empty or anything else. */
export function maxParallelEnv(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : undefined;
}

/**
 * The local runner's ceiling: MAX_PARALLEL when set (the owner knows how big
 * their repos' tasks are), else what fits in this instance's memory.
 * Undefined for the Cloud Run runner, where each task has its own container.
 */
export function parallelCap(env: NodeJS.ProcessEnv = process.env, memoryBytes: number = instanceMemoryBytes()): ParallelCap | undefined {
  if (runnerKind(env) !== "local") return undefined;
  const fromEnv = maxParallelEnv(env.MAX_PARALLEL);
  if (fromEnv !== undefined) return { max: fromEnv, reason: "env" };
  return { max: memoryCap(memoryBytes), reason: "memory", memoryGiB: Math.round((memoryBytes / GIB) * 10) / 10 };
}

/** The Settings value lowered to the cap. */
export function parallelLimit(configured: number, cap: ParallelCap | undefined): ParallelLimit {
  return { configured, effective: cap ? Math.min(configured, cap.max) : configured, ...(cap ? { cap } : {}) };
}

/** The server's log line about the cap; undefined when there is none. */
export function parallelCapNote(cap: ParallelCap | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!cap) return undefined;
  const tasks = `${cap.max} repo task${cap.max === 1 ? "" : "s"}`;
  if (cap.reason === "env") return `[runner] at most ${tasks} at the same time (MAX_PARALLEL)`;
  const ignored = env.MAX_PARALLEL?.trim() ? " MAX_PARALLEL is not a whole number from 1 to 50, so it is ignored." : "";
  return `[runner] ${cap.memoryGiB} GB of memory: at most ${tasks} at the same time (MAX_PARALLEL changes it).${ignored}`;
}

// ---------- Runners ----------

export class LocalRunner implements Runner {
  readonly kind = "local" as const;
  private running = 0;
  private stopped = false;
  private readonly queue: string[] = [];

  constructor(
    private readonly maxParallel: () => number,
    private readonly workerPath = fileURLToPath(new URL("../worker.js", import.meta.url)),
    /** Each worker's process, so the next start can tell which tasks lost theirs (restart.ts). */
    private readonly workers = new WorkerPids(),
  ) {}

  async launch(taskId: string): Promise<void> {
    this.queue.push(taskId);
    this.drain();
  }

  stop(): void {
    this.stopped = true;
  }

  private drain(): void {
    while (!this.stopped && this.running < this.maxParallel() && this.queue.length > 0) {
      const taskId = this.queue.shift()!;
      this.running++;
      const child = spawn(process.execPath, [this.workerPath], {
        env: { ...process.env, TASK_B64: encodeTaskPayload(taskId) },
        stdio: "inherit",
      });
      this.workers.started(taskId, child.pid);
      const finish = () => {
        this.workers.ended(taskId);
        this.running--;
        this.drain();
      };
      child.once("exit", finish);
      child.once("error", (err) => {
        console.error(`[runner] failed to start worker for ${taskId}:`, err);
        finish();
      });
    }
  }
}

export class CloudRunRunner implements Runner {
  readonly kind = "cloudrun" as const;

  /** jobName: projects/PROJECT/locations/REGION/jobs/JOB */
  constructor(private readonly jobName: string) {}

  async launch(taskId: string): Promise<void> {
    const { JobsClient } = await import("@google-cloud/run");
    const client = new JobsClient();
    // We only wait for the execution to be accepted, not for it to finish.
    await client.runJob({
      name: this.jobName,
      overrides: {
        containerOverrides: [{ env: [{ name: "TASK_B64", value: encodeTaskPayload(taskId) }] }],
      },
    });
  }
}

/** The runner RUNNER names (runnerKind). `maxParallel` is the local runner's limit at each start: the setting, already capped. */
export function createRunner(maxParallel: () => number, env = process.env): Runner {
  if (runnerKind(env) === "cloudrun") {
    if (!env.WORKER_JOB) throw new Error("RUNNER=cloudrun requires WORKER_JOB");
    return new CloudRunRunner(env.WORKER_JOB);
  }
  return new LocalRunner(maxParallel);
}
