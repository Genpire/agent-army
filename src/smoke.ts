import { resolve } from "node:path";
import { ConfigRepo, resolveMasterKey } from "./config.js";
import { MemoryRepo } from "./memory.js";
import { NotesRepo } from "./notes.js";
import { createPointerBrain } from "./pointer.js";
import type { PointerContext, PointerReply, PointerRequest } from "./pointer-types.js";
import { createStore } from "./store.js";

/**
 * Cloud smoke test: runs Pointer's brain once, without Slack, and prints the
 * reply. Meant to run inside the worker job, where the storage and master key
 * already live:
 *
 *   gcloud run jobs execute agent-army-worker --region REGION \
 *     --args=dist/smoke.js,"what is the last commit on owner/repo" --wait
 *
 * Repo tasks are stubbed out, so nothing is posted to Slack or GitHub. Memory and
 * project notes are the real ones, so the tools that write them do write.
 */

const DEFAULT_QUESTION = "Introduce yourself and the team in two sentences.";

export function smokeRequest(args: string[]): PointerRequest {
  return {
    text: args.join(" ").trim() || DEFAULT_QUESTION,
    userId: "USMOKE",
    channel: "DSMOKE",
    channelType: "im",
    threadTs: "0",
    history: [],
  };
}

export const smokeContext: PointerContext = {
  startRepoTask: async () => ({ ok: false, error: "not available in smoke test" }),
};

export function formatSmokeReply(reply: PointerReply): string {
  const cost = reply.costUsd === undefined ? "n/a" : `$${reply.costUsd.toFixed(4)}`;
  return `--- reply ---\n${reply.text}\n--- cost: ${cost} · error: ${reply.isError}\n`;
}

async function main(): Promise<PointerReply> {
  const store = createStore();
  const key = await resolveMasterKey(store);
  const configRepo = new ConfigRepo(store, key);
  const memory = new MemoryRepo(store, key);
  const notes = new NotesRepo(store, key);

  const brain = createPointerBrain({ configRepo, memory, notes });
  return brain.reply(smokeRequest(process.argv.slice(2)), smokeContext);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry.endsWith("smoke.js") || entry.endsWith("smoke.ts")) {
  main().then(
    // Exit explicitly once stdout is flushed: open storage sockets or timers must
    // not keep a Cloud Run Job execution (billed) alive after the answer is printed.
    (reply) => process.stdout.write(formatSmokeReply(reply), () => process.exit(reply.isError ? 1 : 0)),
    (err) => {
      console.error("[smoke] fatal:", err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
