import type { ParallelLimit } from "../../lib/types";

/**
 * Why this server runs fewer tasks at the same time than the setting asks
 * (its memory, or MAX_PARALLEL); undefined when the setting applies as is.
 */
export function parallelCapNote(parallel: ParallelLimit | undefined, wanted: number): string | undefined {
  const cap = parallel?.cap;
  if (!cap || !(wanted > cap.max)) return undefined;
  const why = cap.reason === "memory" ? `capped by memory (${cap.memoryGiB} GB)` : "capped by MAX_PARALLEL";
  return `This server runs at most ${cap.max} at a time: ${why}.`;
}
