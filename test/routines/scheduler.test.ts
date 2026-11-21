import { describe, expect, it } from "vitest";
import { RoutineRunRepo, scheduledRunId } from "../../src/routines/runs.js";
import { CATCH_UP_LIMIT_MS, dueRun, missedNote } from "../../src/routines/scheduler.js";
import { Clock, DIGEST, KEY, MemoryStore, fakeBrain, routineEnv, sharedStores, tmpStore } from "./helpers.js";

const daily = (createdAt?: string) => ({ schedule: { cron: "0 8 * * *", timezone: "UTC" }, ...(createdAt ? { createdAt } : {}) });
const at = (iso: string) => new Date(iso);

describe("due detection", () => {
  it("is due on time, once", () => {
    const due = dueRun(daily("2026-11-20T12:00:00Z"), null, at("2026-11-21T08:00:30Z"));
    expect(due).toEqual({ kind: "run", scheduledFor: at("2026-11-21T08:00:00Z"), trigger: "schedule", missed: 0 });
    // Handled: the same time is not due again.
    expect(dueRun(daily("2026-11-20T12:00:00Z"), { lastScheduledFor: "2026-11-21T08:00:00.000Z" }, at("2026-11-21T08:01:30Z"))).toEqual({ kind: "none" });
    expect(dueRun(daily("2026-11-20T12:00:00Z"), null, at("2026-11-21T07:59:59Z"))).toEqual({ kind: "none" });
  });

  it("catches up once when less than an hour late, counting earlier misses", () => {
    const late = dueRun(daily("2026-11-20T12:00:00Z"), null, at("2026-11-21T08:40:00Z"));
    expect(late).toMatchObject({ kind: "run", trigger: "catch-up", missed: 0 });
    // Down for three days: only the latest run counts, the two before are only counted.
    const down = dueRun(daily("2026-11-10T12:00:00Z"), { lastScheduledFor: "2026-11-18T08:00:00.000Z" }, at("2026-11-21T08:20:00Z"));
    expect(down).toEqual({ kind: "run", scheduledFor: at("2026-11-21T08:00:00Z"), trigger: "catch-up", missed: 2 });
    expect(missedNote(down as Extract<typeof down, { kind: "run" }>)).toBe("Ran late: the service was not running at the scheduled time. 2 earlier runs were missed too.");
  });

  it("skips with a note when an hour late or more", () => {
    const due = dueRun(daily("2026-11-20T12:00:00Z"), null, at("2026-11-21T10:00:00Z"));
    expect(due).toEqual({ kind: "skip", scheduledFor: at("2026-11-21T08:00:00Z"), lateMs: 2 * 60 * 60_000, missed: 0 });
    expect(missedNote(due as Extract<typeof due, { kind: "skip" }>)).toBe(
      "Missed: the service was not running at the scheduled time (2 hours ago). Runs more than an hour late are skipped; the next one runs on schedule.",
    );
    expect(dueRun(daily("2026-11-20T12:00:00Z"), null, new Date(Date.parse("2026-11-21T08:00:00Z") + CATCH_UP_LIMIT_MS)).kind).toBe("skip");
  });

  it("never catches up on runs from before a routine was created, changed or resumed", () => {
    // Created at 08:10: today's 08:00 does not count.
    expect(dueRun(daily("2026-11-21T08:10:00Z"), null, at("2026-11-21T08:20:00Z"))).toEqual({ kind: "none" });
    // Resumed at 08:10 (since): the run missed while paused does not count either.
    expect(dueRun(daily("2026-11-01T00:00:00Z"), { lastScheduledFor: "2026-11-15T08:00:00.000Z", since: "2026-11-21T08:10:00.000Z" }, at("2026-11-21T08:20:00Z"))).toEqual({
      kind: "none",
    });
    // Without a creation time or state, it starts counting now.
    expect(dueRun(daily(), null, at("2026-11-21T08:20:00Z"))).toEqual({ kind: "start" });
  });

  it("ignores a routine whose schedule or timezone cannot be read", () => {
    expect(dueRun({ schedule: { cron: "nope", timezone: "UTC" }, createdAt: "2026-11-01T00:00:00Z" }, null, at("2026-11-21T08:00:30Z"))).toEqual({ kind: "none" });
    expect(dueRun({ schedule: { cron: "0 8 * * *", timezone: "Mars/Base" }, createdAt: "2026-11-01T00:00:00Z" }, null, at("2026-11-21T08:00:30Z"))).toEqual({ kind: "none" });
  });
});

describe("the lease", () => {
  it("lets one instance tick at a time, until its lease expires or it gives it up", async () => {
    const store = await tmpStore();
    const repo = new RoutineRunRepo(store, KEY);
    const t0 = at("2026-11-21T08:00:00Z");
    expect(await repo.acquireLease("a", t0, 180_000)).toBe(true);
    expect(await repo.acquireLease("b", new Date(t0.getTime() + 60_000), 180_000)).toBe(false);
    // The holder renews.
    expect(await repo.acquireLease("a", new Date(t0.getTime() + 60_000), 180_000)).toBe(true);
    // Expired (a stopped renewing): b takes over, and a no longer has it.
    expect(await repo.acquireLease("b", new Date(t0.getTime() + 300_000), 180_000)).toBe(true);
    expect(await repo.acquireLease("a", new Date(t0.getTime() + 310_000), 180_000)).toBe(false);
    await repo.releaseLease("b");
    expect(await repo.acquireLease("a", new Date(t0.getTime() + 320_000), 180_000)).toBe(true);
  });

  it("of two instances writing at once, only one keeps it", async () => {
    const [storeA, storeB] = await sharedStores();
    const a = new RoutineRunRepo(storeA, KEY);
    const b = new RoutineRunRepo(storeB, KEY);
    const now = at("2026-11-21T08:00:00Z");
    const results = await Promise.all([a.acquireLease("a", now, 180_000), b.acquireLease("b", now, 180_000)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe("the lease: takeovers", () => {
  it("is renewed by its holder with the same token, and taken over by another only once it expires", async () => {
    const [storeA, storeB] = await sharedStores();
    const a = new RoutineRunRepo(storeA, KEY);
    const b = new RoutineRunRepo(storeB, KEY);
    const t0 = at("2026-11-21T08:00:00Z");
    expect(await a.acquireLease("a", t0, 180_000)).toBe(true);
    const token = (await a.lease())?.token;
    expect(token).toBeTruthy();
    expect(await b.acquireLease("b", at("2026-11-21T08:01:00Z"), 180_000)).toBe(false);
    expect(await a.acquireLease("a", at("2026-11-21T08:01:00Z"), 180_000)).toBe(true);
    expect((await a.lease())?.token).toBe(token);
    // a stops renewing: once its lease expires, b takes it over with a new token.
    expect(await b.acquireLease("b", at("2026-11-21T08:05:00Z"), 180_000)).toBe(true);
    expect((await b.lease())?.owner).toBe("b");
    expect((await b.lease())?.token).not.toBe(token);
  });

  it("is free right after its holder gives it up", async () => {
    const [storeA, storeB] = await sharedStores();
    const a = new RoutineRunRepo(storeA, KEY);
    const b = new RoutineRunRepo(storeB, KEY);
    expect(await a.acquireLease("a", at("2026-11-21T08:00:00Z"), 180_000)).toBe(true);
    await a.releaseLease("a");
    expect(await b.acquireLease("b", at("2026-11-21T08:00:10Z"), 180_000)).toBe(true);
  });

  it("recovers in the next lease period when a takeover's winner died before writing the lease", async () => {
    const [storeA, storeB] = await sharedStores();
    const a = new RoutineRunRepo(storeA, KEY);
    const b = new RoutineRunRepo(storeB, KEY);
    expect(await a.acquireLease("a", at("2026-11-21T08:00:00Z"), 180_000)).toBe(true);
    const expired = at("2026-11-21T08:05:00Z");
    // A winner that died: it created this period's race key but never wrote the lease.
    const stuck = new RoutineRunRepo(storeA, KEY);
    const create = storeA.create.bind(storeA);
    storeA.create = async (key, data) => {
      const won = await create(key, data);
      if (key.startsWith("routines/lease-takeovers/")) throw new Error("died after winning");
      return won;
    };
    await expect(stuck.acquireLease("dead", expired, 180_000)).rejects.toThrow("died after winning");
    storeA.create = create;
    expect(await b.acquireLease("b", expired, 180_000)).toBe(false);
    // The next lease period opens a new race.
    expect(await b.acquireLease("b", at("2026-11-21T08:09:00Z"), 180_000)).toBe(true);
  });
});

describe("duplicate prevention", () => {
  it("claims a scheduled run once, even when two instances race for it", async () => {
    const [storeA, storeB] = await sharedStores();
    const a = new RoutineRunRepo(storeA, KEY);
    const b = new RoutineRunRepo(storeB, KEY);
    const scheduledFor = at("2026-11-21T08:00:00Z");
    const run = (owner: string) => ({
      id: scheduledRunId(scheduledFor),
      routineId: "rt-digest",
      trigger: "schedule" as const,
      scheduledFor: scheduledFor.toISOString(),
      startedAt: "2026-11-21T08:00:01.000Z",
      status: "running" as const,
      delivered: { email: null, slack: null, console: null },
      owner,
    });
    const claims = await Promise.all([a.claim(run("a")), b.claim(run("b"))]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    // Later attempts find it taken.
    expect(await a.claim(run("a"))).toBe(false);
    expect(await a.list("rt-digest")).toHaveLength(1);
  });

  it("two overlapping instances run a due routine once", async () => {
    const clock = new Clock(Date.parse("2026-11-21T07:00:00Z"));
    const [storeA, storeB] = await sharedStores();
    const first = await routineEnv({ clock, store: storeA, owner: "old" });
    const created = await first.service.create(DIGEST, "test");
    expect(created.ok).toBe(true);
    // The new instance shares the store (a redeploy).
    const second = await routineEnv({ clock, store: storeB, shared: true, owner: "new" });

    clock.set("2026-11-21T08:00:30Z");
    const [a, b] = await Promise.all([first.service.scheduler.tick(), second.service.scheduler.tick()]);
    await Promise.all([a.finished, b.finished]);
    expect([a.leader, b.leader].filter(Boolean)).toHaveLength(1);
    expect(first.brain.requests.length + second.brain.requests.length).toBe(1);

    // The old instance stops (gives the lease up); the new one ticks and finds nothing due.
    await first.service.scheduler.stop();
    clock.set("2026-11-21T08:01:30Z");
    const later = await second.service.scheduler.tick();
    await later.finished;
    expect(later.leader).toBe(true);
    expect(later.started).toEqual([]);
    expect(first.brain.requests.length + second.brain.requests.length).toBe(1);
  });
});

describe("ticks", () => {
  it("starts a due routine once, records the run, and leaves paused ones alone", async () => {
    const env = await routineEnv();
    const created = await env.service.create(DIGEST, "test");
    if (!created.ok) throw new Error(created.error);
    const id = created.routine.id;

    env.clock.set("2026-11-21T07:59:00Z");
    expect((await env.service.scheduler.tick()).started).toEqual([]);

    env.clock.set("2026-11-21T08:00:20Z");
    const tick = await env.service.scheduler.tick();
    expect(tick).toMatchObject({ leader: true, started: [{ routineId: id, runId: "s-202611210800", trigger: "schedule" }] });
    const [run] = await tick.finished;
    expect(run).toMatchObject({ id: "s-202611210800", status: "succeeded", scheduledFor: "2026-11-21T08:00:00.000Z" });
    expect(env.brain.requests).toHaveLength(1);

    env.clock.set("2026-11-21T08:01:20Z");
    expect((await env.service.scheduler.tick()).started).toEqual([]);

    const runs = await env.service.runs(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "succeeded", trigger: "schedule", hasReport: true });

    await env.service.update(id, { enabled: false });
    env.clock.set("2026-11-22T08:00:20Z");
    expect((await env.service.scheduler.tick()).started).toEqual([]);
    expect(env.brain.requests).toHaveLength(1);
  });

  it("after downtime: one catch-up under an hour late, a skip with a note after", async () => {
    const env = await routineEnv({ clock: new Clock(Date.parse("2026-11-18T07:00:00Z")) });
    const created = await env.service.create(DIGEST, "test");
    if (!created.ok) throw new Error(created.error);
    const id = created.routine.id;

    // Down from the 18th to the 21st, back at 08:25.
    env.clock.set("2026-11-21T08:25:00Z");
    const tick = await env.service.scheduler.tick();
    expect(tick.started).toEqual([{ routineId: id, runId: "s-202611210800", trigger: "catch-up" }]);
    const [run] = await tick.finished;
    expect(run?.note).toBe("Ran late: the service was not running at the scheduled time. 3 earlier runs were missed too.");
    expect(env.brain.requests[0]?.text).toContain("This run is late");
    env.clock.set("2026-11-21T08:26:00Z");
    expect((await env.service.scheduler.tick()).started).toEqual([]);

    // Down again on the 22nd until 09:30: skipped, not run.
    env.clock.set("2026-11-22T09:30:00Z");
    const skipTick = await env.service.scheduler.tick();
    expect(skipTick.started).toEqual([]);
    expect(skipTick.skipped).toEqual([{ routineId: id, runId: "s-202611220800", note: expect.stringContaining("Missed: the service was not running") }]);
    expect(env.brain.requests).toHaveLength(1);
    const runs = await env.service.runs(id);
    expect(runs.map((r) => [r.id, r.status])).toEqual([
      ["s-202611220800", "skipped"],
      ["s-202611210800", "succeeded"],
    ]);
    // The skip counts as handled.
    env.clock.set("2026-11-22T09:31:00Z");
    expect((await env.service.scheduler.tick()).skipped).toEqual([]);
  });

  it("does not start a routine that is still running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const brain = fakeBrain(async () => {
      await gate;
      return { text: "Done.", isError: false };
    });
    const env = await routineEnv({ brain });
    const created = await env.service.create({ ...DIGEST, cron: "*/15 * * * *" }, "test");
    if (!created.ok) throw new Error(created.error);
    env.clock.set("2026-11-21T07:15:10Z");
    const first = await env.service.scheduler.tick();
    expect(first.started).toHaveLength(1);
    env.clock.set("2026-11-21T07:30:10Z");
    expect((await env.service.scheduler.tick()).started).toEqual([]);
    release();
    await first.finished;
    env.clock.set("2026-11-21T07:31:10Z");
    const next = await env.service.scheduler.tick();
    // The 07:30 run, a minute late, once the 07:15 one ended.
    expect(next.started).toEqual([{ routineId: created.routine.id, runId: "s-202611210730", trigger: "schedule" }]);
    await next.finished;
  });

  it("keeps the last 50 runs", async () => {
    const store = new MemoryStore();
    const repo = new RoutineRunRepo(store, KEY);
    for (let i = 0; i < 55; i++) {
      const when = new Date(Date.parse("2026-11-01T00:00:00Z") + i * 3_600_000);
      await repo.save({
        id: scheduledRunId(when),
        routineId: "rt-many",
        trigger: "schedule",
        scheduledFor: when.toISOString(),
        startedAt: when.toISOString(),
        status: "succeeded",
        report: `report ${i}`,
        delivered: { email: null, slack: null, console: null },
      });
    }
    const runs = await repo.list("rt-many");
    expect(runs).toHaveLength(50);
    expect(runs[0]?.id).toBe(scheduledRunId(new Date(Date.parse("2026-11-01T00:00:00Z") + 54 * 3_600_000)));
    // The oldest are blanked.
    expect(await repo.get("rt-many", scheduledRunId(new Date("2026-11-01T00:00:00Z")))).toBeNull();
    expect((await repo.get("rt-many", runs[0]!.id))?.report).toBe("report 54");
  });
});
