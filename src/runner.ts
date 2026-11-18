import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encodeTaskPayload } from "./tasks.js";

/**
 * Starts one isolated worker per task.
 *
 *  - local:    child process of this server. Works anywhere Docker runs
 *              (laptop, VM, Kubernetes pod). Parallelism is capped in-process.
 *  - cloudrun: one Cloud Run Job execution per task, using this same image.
 *              Each task gets its own container, CPU and memory.
 */
export interface Runner {
  readonly kind: "local" | "cloudrun";
  launch(taskId: string): Promise<void>;
}

export class LocalRunner implements Runner {
  readonly kind = "local" as const;
  private running = 0;
  private readonly queue: string[] = [];

  constructor(
    private readonly maxParallel: () => number,
    private readonly workerPath = fileURLToPath(new URL("./worker.js", import.meta.url)),
  ) {}

  async launch(taskId: string): Promise<void> {
    this.queue.push(taskId);
    this.drain();
  }

  private drain(): void {
    while (this.running < this.maxParallel() && this.queue.length > 0) {
      const taskId = this.queue.shift()!;
      this.running++;
      const child = spawn(process.execPath, [this.workerPath], {
        env: { ...process.env, TASK_B64: encodeTaskPayload(taskId) },
        stdio: "inherit",
      });
      const finish = () => {
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

// The job is named by WORKER_JOB, not CLOUD_RUN_JOB: Cloud Run reserves that name
// (it rejects it on services and sets it to the short job name inside job executions).
export function createRunner(maxParallel: () => number, env = process.env): Runner {
  const kind = env.RUNNER ?? (env.WORKER_JOB ? "cloudrun" : "local");
  if (kind === "cloudrun") {
    if (!env.WORKER_JOB) throw new Error("RUNNER=cloudrun requires WORKER_JOB");
    return new CloudRunRunner(env.WORKER_JOB);
  }
  return new LocalRunner(maxParallel);
}
