import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FsStore } from "../../src/core/store.js";
import {
  DEFAULT_STALE_WORK_MS,
  INTERRUPTED_ERROR,
  WorkerPids,
  markInterruptedTasks,
  removeStaleWorkFolders,
  staleWorkFolderAgeMs,
  workFolderDirs,
  workerProcessRunning,
} from "../../src/tasks/restart.js";
import { emptyTimeline, enterPhase, readTimeline, timelineKey } from "../../src/tasks/task-events.js";
import { type Task, TaskRepo, newTaskId } from "../../src/tasks/tasks.js";
import { startThreadTask } from "../../src/tasks/thread-task.js";

const children: ChildProcess[] = [];
/** A live process that looks like a worker (its command line names worker.js). */
const fakeWorker = async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "dist/worker.js"], { stdio: "ignore" });
  children.push(child);
  await new Promise((r) => child.once("spawn", r));
  return child;
};
afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  vi.restoreAllMocks();
});

describe("the local runner's worker notes", () => {
  it("tell a live worker from a stopped one", async () => {
    const pids = new WorkerPids(join(await mkdtemp(join(tmpdir(), "army-pids-")), "workers"));
    const child = await fakeWorker();
    pids.started("t-live", child.pid);
    expect(pids.running("t-live")).toBe(true);
    expect(pids.running("t-unknown")).toBe(false);

    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    expect(pids.running("t-live")).toBe(false);

    // This process, and bad task ids, never count.
    pids.started("t-self", process.pid);
    expect(pids.running("t-self")).toBe(false);
    pids.started("../escape", child.pid);
    expect(pids.running("../escape")).toBe(false);
  });

  it("are removed when the worker ends, and swept when it is gone", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "army-pids-")), "workers");
    const pids = new WorkerPids(dir);
    const live = await fakeWorker();
    pids.started("t-a", live.pid);
    pids.started("t-b", 999_999_999);
    pids.started("t-c", live.pid);
    pids.ended("t-c");
    expect((await readdir(dir)).sort()).toEqual(["t-a.json", "t-b.json"]);
    pids.sweep();
    expect(await readdir(dir)).toEqual(["t-a.json"]);
  });

  it("check a process id: gone, this one, or not a worker where /proc says so", () => {
    expect(workerProcessRunning(999_999_999)).toBe(false);
    expect(workerProcessRunning(process.pid)).toBe(false);
    expect(workerProcessRunning(process.ppid)).toBe(false);
    if (existsSync("/proc/self/cmdline")) expect(workerProcessRunning(1)).toBe(false);
  });
});

describe("tasks interrupted by a restart", () => {
  async function setup() {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-restart-")));
    const tasks = new TaskRepo(store);
    let n = 0;
    const add = async (fields: Partial<Task>) => {
      const now = new Date().toISOString();
      const task: Task = {
        id: newTaskId(Date.now() + n++),
        createdAt: now,
        updatedAt: now,
        status: "running",
        repo: "acme/web",
        channel: "C1",
        threadTs: `1.${n}`,
        userId: "U1",
        instruction: "fix it",
        ...fields,
      };
      await tasks.save(task);
      return task.id;
    };
    return { store, tasks, add };
  }

  it("are told apart by the runner each task records when it is saved", async () => {
    const { tasks } = await setup();
    for (const kind of ["local", "cloudrun"] as const) {
      const started = await startThreadTask(
        { tasks, runner: { kind, launch: async () => undefined } },
        { repo: "acme/web", channel: "web", threadTs: "c-000000001-abcdef", userId: "admin", instruction: "Fix it", ackText: "", trigger: "web" },
      );
      expect(started.ok).toBe(true);
      if (started.ok) expect((await tasks.get(started.taskId))!.runner).toBe(kind);
    }
  });

  it("marks local tasks whose worker is gone failed, and leaves the others", async () => {
    const { store, tasks, add } = await setup();
    const running = await add({ status: "running", runner: "local" });
    const queued = await add({ status: "queued", runner: "local" });
    const older = await add({ status: "running" }); // saved before tasks named their runner
    const alive = await add({ status: "running", runner: "local" });
    const cloud = await add({ status: "running", runner: "cloudrun" });
    const done = await add({ status: "done", runner: "local" });
    const failed = await add({ status: "failed", runner: "local", error: "boom" });
    const ended = vi.fn();
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});

    const marked = await markInterruptedTasks({ tasks, store, runner: "local", workers: { running: (id) => id === alive, ended } });

    expect(marked.sort()).toEqual([running, queued, older].sort());
    for (const id of [running, queued, older]) {
      expect(await tasks.get(id)).toMatchObject({ status: "failed", error: INTERRUPTED_ERROR });
    }
    expect((await tasks.get(alive))!.status).toBe("running");
    expect((await tasks.get(cloud))!.status).toBe("running");
    expect((await tasks.get(done))!.status).toBe("done");
    expect(await tasks.get(failed)).toMatchObject({ status: "failed", error: "boom" });
    expect(ended.mock.calls.map((c) => c[0]).sort()).toEqual(marked.sort());
    expect(logs.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/3 tasks interrupted by the restart/);
  });

  it("leaves every task alone on a Cloud Run deployment, except the local ones", async () => {
    const { store, tasks, add } = await setup();
    const older = await add({ status: "running" });
    const local = await add({ status: "queued", runner: "local" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await markInterruptedTasks({ tasks, store, runner: "cloudrun", workers: { running: () => false, ended: () => {} } })).toEqual([local]);
    expect((await tasks.get(older))!.status).toBe("running");
  });

  it("closes the timeline where the task was", async () => {
    const { store, tasks, add } = await setup();
    const building = await add({ status: "running", runner: "local" });
    const waiting = await add({ status: "queued", runner: "local" });
    const timeline = emptyTimeline(building, new Date("2026-11-20T10:00:00Z"));
    enterPhase(timeline, "clone", "2026-11-20T10:00:00Z");
    enterPhase(timeline, "build", "2026-11-20T10:05:00Z");
    await store.put(timelineKey(building), JSON.stringify(timeline));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await markInterruptedTasks({ tasks, store, runner: "local", workers: { running: () => false, ended: () => {} }, now: () => new Date("2026-11-20T10:30:00Z") });

    const closed = (await readTimeline(store, building))!;
    expect(closed.phases.map((p) => [p.phase, p.state])).toEqual([
      ["clone", "done"],
      ["setup", "skipped"],
      ["plan", "skipped"],
      ["build", "failed"],
      ["verify", "skipped"],
      ["publish", "skipped"],
      ["checks", "skipped"],
    ]);
    expect(closed.phases.find((p) => p.phase === "build")).toMatchObject({ endedAt: "2026-11-20T10:30:00.000Z", note: INTERRUPTED_ERROR });
    expect(closed.events.at(-1)).toMatchObject({ kind: "end", ok: false, phase: "build", text: INTERRUPTED_ERROR });

    // A queued task never had one: it gets a closed timeline too.
    const fresh = (await readTimeline(store, waiting))!;
    expect(fresh.phases.every((p) => p.state === "skipped")).toBe(true);
    expect(fresh.events).toEqual([expect.objectContaining({ kind: "end", ok: false, text: INTERRUPTED_ERROR })]);
  });
});

describe("leftover work folders", () => {
  const HOUR = 60 * 60_000;

  it("are the job deadline old: JOB_TIMEOUT_MIN, else a day", () => {
    expect(staleWorkFolderAgeMs({ JOB_TIMEOUT_MIN: "180" })).toBe(3 * HOUR);
    expect(staleWorkFolderAgeMs({})).toBe(DEFAULT_STALE_WORK_MS);
    expect(staleWorkFolderAgeMs({ JOB_TIMEOUT_MIN: "" })).toBe(DEFAULT_STALE_WORK_MS);
    expect(staleWorkFolderAgeMs({ JOB_TIMEOUT_MIN: "soon" })).toBe(DEFAULT_STALE_WORK_MS);
    expect(staleWorkFolderAgeMs({ JOB_TIMEOUT_MIN: "-5" })).toBe(DEFAULT_STALE_WORK_MS);
  });

  it("are looked for in WORK_DIR and the temp folder", () => {
    expect(workFolderDirs({})).toEqual([resolve(tmpdir())]);
    expect(workFolderDirs({ WORK_DIR: "/data" })).toEqual([resolve("/data"), resolve(tmpdir())]);
    expect(workFolderDirs({ WORK_DIR: tmpdir() })).toEqual([resolve(tmpdir())]);
    expect(workFolderDirs({ WORK_DIR: " " })).toEqual([resolve(tmpdir())]);
  });

  it("are removed when old and a worker's, and nothing else is", async () => {
    const dir = await mkdtemp(join(tmpdir(), "army-sweep-"));
    const now = Date.now();
    const old = new Date(now - 4 * HOUR);
    const folder = async (name: string, entries: string[], mtime = old) => {
      const path = join(dir, name);
      await mkdir(path);
      for (const e of entries) await mkdir(join(path, e));
      await utimes(path, mtime, mtime);
    };
    await folder("army-Ab3dE9", ["repo", "attachments", "screenshots", "skills-plugin", "engines-x1Y2z3"]); // a killed task's checkout
    await folder("army-q1w2e3", []); // killed before the clone
    await folder("army-git-Zx9yW8", ["home", "army-push-a1b2c3"]); // its git folder
    await folder("army-n3w0ne", ["repo"], new Date(now - 10 * 60_000)); // a task still running
    await folder("army-backup", ["repo", "my-notes"]); // someone's own folder
    await folder("army-data", []); // not a worker's name
    await folder("army-skills-A1b2C3", []); // the server's skills plugin
    await writeFile(join(dir, "army-file01"), "x");
    await folder("elsewhere", []);
    await symlink(join(dir, "elsewhere"), join(dir, "army-l1nk00"));
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await removeStaleWorkFolders({ dirs: [dir, join(dir, "missing")], maxAgeMs: 3 * HOUR, now })).toBe(3);
    expect((await readdir(dir)).sort()).toEqual(["army-backup", "army-data", "army-file01", "army-l1nk00", "army-n3w0ne", "army-skills-A1b2C3", "elsewhere"]);
  });
});
