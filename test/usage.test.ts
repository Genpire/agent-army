import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FsStore } from "../src/store.js";
import { type Task, TaskRepo, newTaskId } from "../src/tasks.js";
import { UsageRepo, monthBounds, monthKey, usageLine } from "../src/usage.js";

const setup = async () => {
  const store = new FsStore(await mkdtemp(join(tmpdir(), "army-usage-")));
  const tasks = new TaskRepo(store);
  return { store, tasks, usage: new UsageRepo(store, tasks) };
};

const task = (at: Date, costUsd: number | undefined, instruction = "do it"): Task => ({
  id: newTaskId(at.getTime()),
  createdAt: at.toISOString(),
  updatedAt: at.toISOString(),
  status: costUsd === undefined ? "running" : "done",
  repo: "acme/web",
  channel: "C1",
  threadTs: "1.1",
  userId: "U1",
  instruction,
  ...(costUsd === undefined ? {} : { costUsd }),
});

describe("usage", () => {
  const now = new Date("2026-11-18T12:00:00Z");

  it("bounds the UTC month", () => {
    expect(monthKey(now)).toBe("2026-11");
    const { from, to } = monthBounds(now);
    expect(new Date(from).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(new Date(to).toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(new Date(monthBounds(new Date("2026-12-31T23:00:00Z")).to).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("counts every chat reply, even when they arrive together, and ignores missing or bad costs", async () => {
    const { usage } = await setup();
    await Promise.all([0.1, 0.2, 0.3, undefined, Number.NaN, -1].map((c) => usage.recordChat(c, now)));
    const month = await usage.month(now);
    expect(month.chat.count).toBe(3);
    expect(month.chat.usd).toBeCloseTo(0.6);
    // Another month starts from zero.
    expect((await usage.month(new Date("2026-12-02T00:00:00Z"))).chat).toEqual({ usd: 0, count: 0 });
  });

  it("sums this month's repo tasks only and lists the costliest", async () => {
    const { tasks, usage } = await setup();
    await tasks.save(task(new Date("2026-10-31T23:59:59Z"), 50, "last month"));
    await tasks.save(task(new Date("2026-11-01T00:00:00Z"), 9.5, "funnel"));
    await tasks.save(task(new Date("2026-11-10T08:00:00Z"), 0.25, "last commit"));
    await tasks.save(task(new Date("2026-11-18T11:00:00Z"), undefined, "still running"));
    await tasks.save(task(new Date("2026-12-01T00:00:00Z"), 70, "next month"));
    await usage.recordChat(1.25, now);

    const month = await usage.month(now);
    expect(month.tasks.count).toBe(3);
    expect(month.tasks.usd).toBeCloseTo(9.75);
    expect(month.totalUsd).toBeCloseTo(11);
    expect(month.topTasks.map((t) => t.instruction)).toEqual(["funnel", "last commit"]);
    expect(usageLine(month)).toBe("$11.00 (chat $1.25 over 1 replies · repo tasks $9.75 over 3 tasks)");
  });

  it("treats an unreadable tally as empty", async () => {
    const { store, usage } = await setup();
    await store.put("usage/chat-2026-11.json", "not json");
    expect((await usage.month(now)).chat).toEqual({ usd: 0, count: 0 });
    await usage.recordChat(0.5, now);
    expect((await usage.month(now)).chat).toEqual({ usd: 0.5, count: 1 });
  });
});
