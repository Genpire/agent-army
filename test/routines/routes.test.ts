import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RoutineService } from "../../src/routines/service.js";
import { createApp } from "../../src/server.js";
import { DIGEST, fakeBrain } from "./helpers.js";

/** The Routines admin API and the tick, through the real HTTP app (Pointer faked). */
describe("routines admin API", () => {
  let base = "";
  let close: () => void;
  let cookie = "";
  let routines: RoutineService;
  const brain = fakeBrain(() => ({ text: "## Digest\nTwo pull requests merged.", costUsd: 0.07, isError: false }));
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}, withCookie = true) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(withCookie && cookie ? { cookie } : {}), ...headers },
      body: JSON.stringify(body),
    });
  const get = (path: string, withCookie = true) => fetch(base + path, { headers: withCookie && cookie ? { cookie } : {} });
  const json = async (res: Response | Promise<Response>) => (await res).json();
  const body = { name: DIGEST.name, instruction: DIGEST.instruction, schedule: { cron: DIGEST.cron }, deliver: { console: true } };

  beforeAll(async () => {
    process.env.SKIP_VALIDATION = "1";
    const dir = await mkdtemp(join(tmpdir(), "army-routines-routes-"));
    const app = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" }, { brain: brain.brain });
    routines = app.routines;
    const server = app.app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const res = await post("/api/setup", { setupToken: "setup-123", password: "longpassword1" });
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    await post("/api/anthropic", { apiKey: "sk-ant-routes-test-000000" });
  });
  afterAll(() => {
    close();
    delete process.env.SKIP_VALIDATION;
  });

  it("is admin only", async () => {
    for (const path of ["/api/routines", "/api/routines/tick", "/api/routines/rt-x", "/api/routines/rt-x/runs", "/api/routines/rt-x/runs/s-202611210800"]) {
      expect((await get(path, false)).status).toBe(401);
    }
    for (const path of ["/api/routines", "/api/routines/preview", "/api/routines/tick/rotate", "/api/routines/rt-x", "/api/routines/rt-x/delete", "/api/routines/rt-x/run"]) {
      expect((await post(path, body, {}, false)).status).toBe(401);
    }
  });

  it("creates, lists with the next runs, changes, runs and deletes", async () => {
    const created = await post("/api/routines", { ...body, deliver: { email: ["dana@acme.example"], slack: "C0ACMEDEV1", console: true }, budgetUsd: 0.5 });
    expect(created.status).toBe(200);
    const { routine } = await created.json();
    expect(routine).toMatchObject({
      id: "rt-daily-github-digest",
      scheduleText: "Every day at 08:00",
      schedule: { cron: "0 8 * * *", timezone: "UTC" },
      deliver: { email: ["dana@acme.example"], slack: "C0ACMEDEV1", console: true },
      budgetUsd: 0.5,
      createdBy: "Admin (console)",
      lastRun: null,
      running: false,
    });
    expect(routine.nextRuns).toHaveLength(3);

    const list = await json(get("/api/routines"));
    expect(list).toMatchObject({ timezone: "UTC", emailReady: false, max: 50, minIntervalMin: 15 });
    expect(list.routines.map((r: { id: string }) => r.id)).toEqual(["rt-daily-github-digest"]);

    const bad = await post("/api/routines", { ...body, schedule: { cron: "* * * * *" } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("at most every 15 minutes");

    const paused = await json(post("/api/routines/rt-daily-github-digest", { enabled: false }));
    expect(paused.routine).toMatchObject({ enabled: false, nextRuns: [] });
    const changed = await json(post("/api/routines/rt-daily-github-digest", { enabled: true, schedule: { cron: "30 9 * * 1", timezone: "Europe/London" } }));
    expect(changed.routine).toMatchObject({ scheduleText: "Every Monday at 09:30", schedule: { timezone: "Europe/London" } });

    const run = await post("/api/routines/rt-daily-github-digest/run");
    expect(run.status).toBe(202);
    const { run: started } = await run.json();
    expect(started).toMatchObject({ trigger: "manual", status: "running" });
    await routines.runner.idle();
    const runs = await json(get("/api/routines/rt-daily-github-digest/runs"));
    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]).toMatchObject({ id: started.id, status: "succeeded", hasReport: true, costUsd: 0.07 });
    expect(runs.runs[0].report).toBeUndefined();
    const one = await json(get(`/api/routines/rt-daily-github-digest/runs/${started.id}`));
    expect(one.run).toMatchObject({ report: "## Digest\nTwo pull requests merged.", delivered: { email: { ok: false }, slack: { ok: false, error: "Slack is not connected." }, console: { ok: true } } });
    expect(one.run.owner).toBeUndefined();
    expect(brain.requests[0]).toMatchObject({ surface: "routine", budgetUsd: 0.5 });

    // The console delivery is a real conversation, titled with the routine's name.
    const conversations = await json(get("/api/conversations"));
    expect(conversations.conversations[0]).toMatchObject({ title: "Daily GitHub digest", messageCount: 1 });

    expect((await get("/api/routines/rt-daily-github-digest/runs/s-999")).status).toBe(404);
    expect((await post("/api/routines/rt-daily-github-digest/delete")).status).toBe(200);
    expect((await post("/api/routines/rt-daily-github-digest/delete")).status).toBe(404);
    expect((await get("/api/routines/rt-daily-github-digest")).status).toBe(404);
  });

  it("marks what the console creates or changes as the owner's (ownerOnly)", async () => {
    const { routine } = await json(post("/api/routines", { ...body, name: "Owner digest" }));
    expect(routine).toMatchObject({ id: "rt-owner-digest", ownerOnly: true });
    // A change by anyone else clears the mark; the owner's next change in the console sets it again.
    const elsewhere = await routines.update(routine.id, { name: "Changed elsewhere" });
    expect(elsewhere.ok && elsewhere.routine.ownerOnly).toBe(false);
    const changed = await json(post(`/api/routines/${routine.id}`, { enabled: false }));
    expect(changed.routine).toMatchObject({ ownerOnly: true, enabled: false });
    expect((await post(`/api/routines/${routine.id}/delete`)).status).toBe(200);
  });

  it("previews a schedule", async () => {
    const ok = await json(post("/api/routines/preview", { cron: "0 9 * * 1-5", timezone: "America/New_York" }));
    expect(ok).toMatchObject({ ok: true, timezone: "America/New_York", scheduleText: "Weekdays at 09:00" });
    expect(ok.nextRuns).toHaveLength(3);
    const bad = await post("/api/routines/preview", { cron: "0 9 * * 1-5", timezone: "Nowhere/Land" });
    expect(bad.status).toBe(400);
  });

  it("wakes up with the tick secret only, and a rotated secret replaces the old one", async () => {
    const info = await json(get("/api/routines/tick"));
    expect(info).toMatchObject({ url: `${base}/routines/tick`, header: "X-Routines-Secret", method: "POST" });
    expect(info.secret.length).toBeGreaterThanOrEqual(32);

    expect((await post("/routines/tick", {}, {}, false)).status).toBe(401);
    expect((await post("/routines/tick", {}, { "x-routines-secret": "wrong" }, false)).status).toBe(401);
    const tick = await post("/routines/tick", {}, { "x-routines-secret": info.secret }, false);
    expect(tick.status).toBe(200);
    expect(await tick.json()).toMatchObject({ ok: true, leader: true, started: [], skipped: [], finished: [] });

    const rotated = await json(post("/api/routines/tick/rotate"));
    expect(rotated.secret).not.toBe(info.secret);
    expect((await post("/routines/tick", {}, { "x-routines-secret": info.secret }, false)).status).toBe(401);
    expect((await post("/routines/tick", {}, { "x-routines-secret": rotated.secret }, false)).status).toBe(200);
    // The secret never appears in the config the page reads.
    expect(JSON.stringify(await json(get("/api/state")))).not.toContain(rotated.secret);
  });

  it("saves the organisation's timezone, checked against the IANA list", async () => {
    expect((await post("/api/settings", { timezone: "Asia/Jerusalem" })).status).toBe(200);
    expect((await json(get("/api/state"))).config.timezone).toBe("Asia/Jerusalem");
    const bad = await post("/api/settings", { timezone: "Mars/Olympus" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("Choose a timezone from the list");
    expect((await json(get("/api/state"))).config.timezone).toBe("Asia/Jerusalem");
    // New routines default to it.
    const { routine } = await json(post("/api/routines", { ...body, name: "Weekly team activity" }));
    expect(routine.schedule.timezone).toBe("Asia/Jerusalem");
  });
});
