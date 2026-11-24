import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigRepo } from "../../src/core/config.js";
import { deriveKey } from "../../src/core/crypto.js";
import { FsStore } from "../../src/core/store.js";
import type { CalendarSource } from "../../src/followups/types.js";
import { createApp } from "../../src/server.js";

/** The follow-ups API through the real HTTP server. */
describe("the follow-ups API", () => {
  let base = "";
  let close: () => void;
  let cookie = "";
  const post = (path: string, body: unknown, withCookie = true) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(withCookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const get = (path: string, withCookie = true) => fetch(base + path, { headers: withCookie ? { cookie } : {} });
  const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: string } });

  beforeAll(async () => {
    const dir = await mkdtemp(join(tmpdir(), "army-followups-api-"));
    const app = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" }, { followups: { batchMs: 0 } });
    const server = app.app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const res = await post("/api/setup", { setupToken: "setup-123", password: "longpassword1" }, false);
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    expect((await post("/api/settings", { timezone: "Asia/Jerusalem" })).status).toBe(200);
  });
  afterAll(() => close());

  it("is for the admin only", async () => {
    expect((await get("/api/followups", false)).status).toBe(401);
    expect((await post("/api/followups", { title: "x" }, false)).status).toBe(401);
    expect((await post("/api/followups/1/done", {}, false)).status).toBe(401);
    expect((await post("/api/followups/settings", { trackGmail: false }, false)).status).toBe(401);
  });

  it("lists, adds, closes, reopens and snoozes by number", async () => {
    const empty = await json(await get("/api/followups"));
    expect(empty).toEqual({
      status: 200,
      body: { items: [], settings: { morningBrief: { enabled: true, time: "08:30", days: [1, 2, 3, 4, 5] }, meetingReminderMin: 10, trackGmail: true } },
    });

    const added = await json(await post("/api/followups", { title: "Call Omar about the contract", detail: "He asked twice", remindAt: "2026-12-01T15:00", repeatMin: 60 }));
    expect(added.status).toBe(200);
    // A time without an offset is the organisation's (Asia/Jerusalem, UTC+2 in December).
    expect(added.body).toMatchObject({ ok: true, item: { n: 1, title: "Call Omar about the contract", source: "owner", status: "open", remindAt: "2026-12-01T13:00:00.000Z", repeatMin: 60 } });
    const second = await json(await post("/api/followups", { title: "Send the deck" }));
    expect(second.body).toMatchObject({ item: { n: 2 } });

    for (const [body, error] of [
      [{}, "Say what to follow up on."],
      [{ title: "  " }, "Say what to follow up on."],
      [{ title: "x", remindAt: "soon" }, '"soon" is not a time'],
      [{ title: "x", repeatMin: 60 }, "A repeat needs remindAt"],
      [{ title: "x", remindAt: "2026-12-01T15:00", repeatMin: 3 }, "Repeat at most every 10 minutes."],
    ] as const) {
      const res = await json(await post("/api/followups", body));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toContain(error);
    }

    const done = await json(await post("/api/followups/1/done", {}));
    expect(done.body).toMatchObject({ ok: true, item: { n: 1, status: "done" } });
    // Closing again is fine; an unknown number is not.
    expect((await post("/api/followups/1/done", {})).status).toBe(200);
    expect((await post("/api/followups/99/done", {})).status).toBe(404);
    expect((await post("/api/followups/abc/done", {})).status).toBe(404);

    const open = (await json(await get("/api/followups?status=open"))).body.items as { n: number }[];
    expect(open.map((i) => i.n)).toEqual([2]);
    const closed = (await json(await get("/api/followups?status=done"))).body.items as { n: number }[];
    expect(closed.map((i) => i.n)).toEqual([1]);
    expect((await get("/api/followups?status=everything")).status).toBe(400);

    const until = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    expect((await json(await post("/api/followups/1/snooze", { until }))).status).toBe(409);
    expect((await json(await post("/api/followups/1/reopen", {}))).body).toMatchObject({ ok: true, item: { n: 1, status: "open" } });
    expect((await post("/api/followups/77/reopen", {})).status).toBe(404);
    const snoozed = await json(await post("/api/followups/1/snooze", { until }));
    expect(snoozed.body).toMatchObject({ ok: true, item: { n: 1, snoozedUntil: until, remindAt: until } });
    expect((await post("/api/followups/1/snooze", { until: new Date(Date.now() - 60_000).toISOString() })).status).toBe(400);
    expect((await post("/api/followups/1/snooze", {})).status).toBe(400);
    expect((await post("/api/followups/55/snooze", { until })).status).toBe(404);
  });

  it("changes the reminders' settings, shown in the state without secrets", async () => {
    const changed = await json(await post("/api/followups/settings", { morningBrief: { time: "07:45", days: [5, 1, 1] }, meetingReminderMin: 15 }));
    expect(changed).toEqual({
      status: 200,
      body: { ok: true, settings: { morningBrief: { enabled: true, time: "07:45", days: [1, 5] }, meetingReminderMin: 15, trackGmail: true } },
    });
    expect((await json(await post("/api/followups/settings", { trackGmail: false }))).body).toMatchObject({ settings: { trackGmail: false, meetingReminderMin: 15 } });
    expect((await post("/api/followups/settings", { morningBrief: { time: "25:00" } })).status).toBe(400);
    expect((await post("/api/followups/settings", { meetingReminderMin: 999 })).status).toBe(400);
    expect((await post("/api/followups/settings", {})).status).toBe(400);
    const state = (await (await get("/api/state")).json()) as { config: { followups: unknown } };
    expect(state.config.followups).toEqual({ morningBrief: { enabled: true, time: "07:45", days: [1, 5] }, meetingReminderMin: 15, trackGmail: false });
    expect((await json(await get("/api/followups"))).body.settings).toEqual(state.config.followups);
  });
});

describe("the server's reminders", () => {
  it("go out on the routines' clock as DMs to the owner: an item's own time and the next meeting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "army-followups-clock-"));
    // The config as the owner left it: Slack and their own account connected, no morning brief.
    const configRepo = new ConfigRepo(new FsStore(dir), deriveKey("m"));
    await configRepo.update((c) => {
      c.slack.botToken = "xoxb-clock-test-token";
      c.slack.signingSecret = "s".repeat(20);
      c.slack.user = { token: "xoxp-owner-clock-token", userId: "U0OWNER01", userName: "dana", scopes: [], connectedAt: "2026-11-01T00:00:00.000Z", listen: true, sendAsMe: true };
      c.followups.morningBrief.enabled = false;
    });
    const posts: { channel: string; text: string }[] = [];
    const slack = () => ({ chat: { postMessage: async (m: { channel: string; text: string }) => (posts.push(m), { ok: true, ts: "1.1" }) } });
    const soon = Date.now() + 5 * 60_000;
    const calendar: CalendarSource = {
      ready: async () => true,
      eventsBetween: async () => [{ id: "ev-1", title: "Design review", start: new Date(soon).toISOString(), end: new Date(soon + 30 * 60_000).toISOString(), allDay: false }],
    };
    const app = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" }, { slack: slack as never, followups: { batchMs: 0 }, google: { calendar } });
    await app.followups.add({ title: "Call Omar", source: "owner", remindAt: new Date(Date.now() - 60_000).toISOString() });
    const tick = await app.routines.scheduler.tick();
    expect(tick.leader).toBe(true);
    expect(posts.map((p) => p.channel)).toEqual(["U0OWNER01", "U0OWNER01"]);
    expect(posts[0]!.text).toContain("⏰ *Reminder* *#1* Call Omar");
    expect(posts[1]!.text).toMatch(/^📅 \*In 5 min\*: Design review/);
    // Kept in the console too.
    const list = await app.conversations.list();
    expect(list.map((c) => c.title)).toEqual(["Follow-ups"]);
    // Nothing twice.
    await app.routines.scheduler.tick();
    expect(posts).toHaveLength(2);
    await app.routines.scheduler.stop();
  });
});
