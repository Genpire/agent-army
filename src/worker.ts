import { resolve } from "node:path";
import { main } from "./tasks/worker.js";

/**
 * The per-task worker's entry point (dist/worker.js): the local runner spawns
 * it and the Cloud Run job runs it, with the task in TASK_B64. What it does
 * lives in tasks/worker.ts.
 */
if (process.argv[1] && resolve(process.argv[1]).endsWith("worker.js")) {
  main().catch((err) => {
    console.error("[worker] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
