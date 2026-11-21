import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server.js";
import {
  LocalRunner,
  instanceMemoryBytes,
  maxParallelEnv,
  memoryCap,
  parallelCap,
  parallelCapNote,
  parallelLimit,
  runnerKind,
} from "../../src/tasks/runner.js";
import { parallelCapNote as settingsNote } from "../../web/src/pages/settings/parallel.js";

const GIB = 1024 ** 3;

describe("tasks at the same time", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fit in the instance's memory: max(1, floor((GiB - 1.5) / 2))", () => {
    expect(memoryCap(1 * GIB)).toBe(1);
    expect(memoryCap(2 * GIB)).toBe(1);
    expect(memoryCap(4 * GIB)).toBe(1);
    expect(memoryCap(5.5 * GIB)).toBe(2);
    expect(memoryCap(8 * GIB)).toBe(3);
    expect(memoryCap(16 * GIB)).toBe(7);
    expect(memoryCap(32 * GIB)).toBe(15);
  });

  it("reads the container's limit, else the machine's memory", () => {
    const spy = vi.spyOn(process, "constrainedMemory");
    spy.mockReturnValue(4 * GIB);
    expect(instanceMemoryBytes()).toBe(Math.min(4 * GIB, totalmem()));
    // No limit: Node returns 0, or a huge number (cgroup "max").
    spy.mockReturnValue(0);
    expect(instanceMemoryBytes()).toBe(totalmem());
    spy.mockReturnValue(18446744073709552000);
    expect(instanceMemoryBytes()).toBe(totalmem());
  });

  it("is capped by memory for the local runner, by MAX_PARALLEL when set, and not on Cloud Run", () => {
    expect(parallelCap({ RUNNER: "local" }, 4 * GIB)).toEqual({ max: 1, reason: "memory", memoryGiB: 4 });
    expect(parallelCap({}, 8 * GIB)).toEqual({ max: 3, reason: "memory", memoryGiB: 8 });
    expect(parallelCap({ RUNNER: "local" }, 7.7 * GIB)).toEqual({ max: 3, reason: "memory", memoryGiB: 7.7 });
    expect(parallelCap({ RUNNER: "local", MAX_PARALLEL: "5" }, 4 * GIB)).toEqual({ max: 5, reason: "env" });
    expect(parallelCap({ RUNNER: "cloudrun", WORKER_JOB: "projects/p/locations/r/jobs/j" }, 4 * GIB)).toBeUndefined();
    expect(parallelCap({ WORKER_JOB: "projects/p/locations/r/jobs/j" }, 4 * GIB)).toBeUndefined();
    // An invalid MAX_PARALLEL is ignored.
    expect(parallelCap({ MAX_PARALLEL: "lots" }, 4 * GIB)).toEqual({ max: 1, reason: "memory", memoryGiB: 4 });
  });

  it("takes MAX_PARALLEL only as a whole number from 1 to 50", () => {
    expect(maxParallelEnv(undefined)).toBeUndefined();
    expect(maxParallelEnv("")).toBeUndefined();
    expect(maxParallelEnv(" 2 ")).toBe(2);
    expect(maxParallelEnv("50")).toBe(50);
    for (const bad of ["0", "-1", "1.5", "51", "two", "1e9"]) expect(maxParallelEnv(bad), bad).toBeUndefined();
  });

  it("is the setting lowered to the cap", () => {
    expect(parallelLimit(3, { max: 1, reason: "memory", memoryGiB: 4 })).toEqual({ configured: 3, effective: 1, cap: { max: 1, reason: "memory", memoryGiB: 4 } });
    expect(parallelLimit(2, { max: 3, reason: "memory", memoryGiB: 8 })).toMatchObject({ configured: 2, effective: 2 });
    expect(parallelLimit(10, { max: 6, reason: "env" })).toMatchObject({ effective: 6 });
    expect(parallelLimit(4, undefined)).toEqual({ configured: 4, effective: 4 });
  });

  it("says why in the log and in Settings", () => {
    expect(parallelCapNote({ max: 1, reason: "memory", memoryGiB: 4 }, {})).toBe(
      "[runner] 4 GB of memory: at most 1 repo task at the same time (MAX_PARALLEL changes it).",
    );
    expect(parallelCapNote({ max: 1, reason: "memory", memoryGiB: 4 }, { MAX_PARALLEL: "x" })).toMatch(/MAX_PARALLEL is not a whole number/);
    expect(parallelCapNote({ max: 2, reason: "env" }, {})).toBe("[runner] at most 2 repo tasks at the same time (MAX_PARALLEL)");
    expect(parallelCapNote(undefined, {})).toBeUndefined();

    const capped = parallelLimit(3, { max: 1, reason: "memory", memoryGiB: 4 });
    expect(settingsNote(capped, 3)).toBe("This server runs at most 1 at a time: capped by memory (4 GB).");
    expect(settingsNote(capped, 1)).toBeUndefined();
    expect(settingsNote(parallelLimit(9, { max: 4, reason: "env" }), 9)).toBe("This server runs at most 4 at a time: capped by MAX_PARALLEL.");
    expect(settingsNote(parallelLimit(3, undefined), 3)).toBeUndefined();
    expect(settingsNote(undefined, 3)).toBeUndefined();
  });

  it("names the runner like before: RUNNER, else cloudrun with WORKER_JOB", () => {
    expect(runnerKind({})).toBe("local");
    expect(runnerKind({ RUNNER: "local", WORKER_JOB: "j" })).toBe("local");
    expect(runnerKind({ WORKER_JOB: "j" })).toBe("cloudrun");
    expect(runnerKind({ RUNNER: "", WORKER_JOB: "j" })).toBe("cloudrun");
    expect(runnerKind({ RUNNER: "cloudrun" })).toBe("cloudrun");
  });
});

describe("the local runner", () => {
  it("never runs more workers than its limit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "army-runner-"));
    const log = join(dir, "log");
    const worker = join(dir, "worker.mjs");
    // Each worker notes its start and end; they overlap while each waits a little.
    await writeFile(
      worker,
      `import { appendFileSync } from "node:fs";
const id = JSON.parse(Buffer.from(process.env.TASK_B64, "base64").toString()).taskId;
appendFileSync(${JSON.stringify(log)}, "start " + id + "\\n");
setTimeout(() => appendFileSync(${JSON.stringify(log)}, "end " + id + "\\n"), 300);
`,
    );
    const runner = new LocalRunner(() => 2, worker);
    for (const id of ["t-1", "t-2", "t-3", "t-4", "t-5"]) await runner.launch(id);
    await vi.waitFor(async () => expect((await readFile(log, "utf8").catch(() => "")).match(/^end /gm)?.length).toBe(5), { timeout: 10_000, interval: 100 });
    let running = 0;
    let most = 0;
    for (const line of (await readFile(log, "utf8")).trim().split("\n")) {
      running += line.startsWith("start ") ? 1 : -1;
      most = Math.max(most, running);
    }
    expect(most).toBe(2);
  });
});

describe("GET /api/state", () => {
  const servers: { close(): void }[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  async function parallel(env: NodeJS.ProcessEnv, memoryBytes: number, runner?: { kind: "local" | "cloudrun"; launch: () => Promise<void> }) {
    const dir = await mkdtemp(join(tmpdir(), "army-runner-state-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", ...env }, { memoryBytes, ...(runner ? { runner } : {}) });
    const server = app.listen(0);
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const setup = await fetch(`${base}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupToken: "setup-123", password: "longpassword1" }),
    });
    const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
    return (await (await fetch(`${base}/api/state`, { headers: { cookie } })).json()).parallel;
  }

  it("shows the effective number of tasks and why it is lower", async () => {
    expect(await parallel({ RUNNER: "local" }, 4 * GIB)).toEqual({ configured: 3, effective: 1, cap: { max: 1, reason: "memory", memoryGiB: 4 } });
    expect(await parallel({ RUNNER: "local", MAX_PARALLEL: "2" }, 4 * GIB)).toEqual({ configured: 3, effective: 2, cap: { max: 2, reason: "env" } });
    expect(await parallel({ RUNNER: "local" }, 16 * GIB)).toEqual({ configured: 3, effective: 3, cap: { max: 7, reason: "memory", memoryGiB: 16 } });
    const cloudRun = { kind: "cloudrun" as const, launch: async () => undefined };
    expect(await parallel({ RUNNER: "cloudrun", WORKER_JOB: "projects/p/locations/r/jobs/j" }, 4 * GIB, cloudRun)).toEqual({ configured: 3, effective: 3 });
  });
});
