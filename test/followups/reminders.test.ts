import { describe, expect, it } from "vitest";
import type { Config } from "../../src/core/config.js";
import { FollowupReminders, briefDue, meetingDue, reminderDueAt } from "../../src/followups/reminders.js";
import { FollowupStore } from "../../src/followups/store.js";
import type { CalendarEvent, CalendarSource, EmailSource, EmailThread, FollowupItem } from "../../src/followups/types.js";
import { Clock, KEY, MemoryStore, configured, fakeSlack, fakeThreads, routineEnv, tmpStore } from "../routines/helpers.js";

const OWNER = "U0OWNER01";
const TZ = "Asia/Jerusalem"; // UTC+2 in November
const BRIEF = { enabled: true, time: "08:30", days: [1, 2, 3, 4, 5] };

const item = (n: number, extra: Partial<FollowupItem> = {}): FollowupItem => ({ n, title: `item ${n}`, detail: "", source: "owner", status: "open", createdAt: "2026-11-20T00:00:00.000Z", ...extra });

describe("when reminders are due", () => {
  it("the morning brief: on its days, at its local time, once a day, at most an hour late", () => {
    // Tuesday, November 24, 2026.
    expect(briefDue(BRIEF, TZ, new Date("2026-11-24T06:29:00Z"), undefined)).toBe(false);
    expect(briefDue(BRIEF, TZ, new Date("2026-11-24T06:30:00Z"), undefined)).toBe(true);
    expect(briefDue(BRIEF, TZ, new Date("2026-11-24T07:29:00Z"), undefined)).toBe(true);
    expect(briefDue(BRIEF, TZ, new Date("2026-11-24T07:30:00Z"), undefined)).toBe(false);
    expect(briefDue(BRIEF, TZ, new Date("2026-11-24T06:31:00Z"), "2026-11-24")).toBe(false);
    expect(briefDue(BRIEF, TZ, new Date("2026-11-24T06:31:00Z"), "2026-11-23")).toBe(true);
    // Saturday is not one of its days; off is off.
    expect(briefDue(BRIEF, TZ, new Date("2026-11-28T06:30:00Z"), undefined)).toBe(false);
    expect(briefDue({ ...BRIEF, days: [6] }, TZ, new Date("2026-11-28T06:30:00Z"), undefined)).toBe(true);
    expect(briefDue({ ...BRIEF, enabled: false }, TZ, new Date("2026-11-24T06:30:00Z"), undefined)).toBe(false);
    // In UTC the same instant is 06:30: too early.
    expect(briefDue(BRIEF, "UTC", new Date("2026-11-24T06:30:00Z"), undefined)).toBe(false);
  });

  it("an item: at its time, again every repeat, never snoozed, closed or reminded already", () => {
    const at = (iso: string) => new Date(iso);
    const once = item(1, { remindAt: "2026-11-24T13:00:00.000Z" });
    expect(reminderDueAt(once, at("2026-11-24T12:59:00Z"))).toBeUndefined();
    expect(reminderDueAt(once, at("2026-11-24T13:00:00Z"))?.toISOString()).toBe("2026-11-24T13:00:00.000Z");
    expect(reminderDueAt({ ...once, remindedAt: "2026-11-24T13:00:30.000Z" }, at("2026-11-24T18:00:00Z"))).toBeUndefined();
    // Late (the service was down): still reminded, once.
    expect(reminderDueAt(once, at("2026-11-26T09:00:00Z"))?.toISOString()).toBe("2026-11-24T13:00:00.000Z");
    expect(reminderDueAt({ ...once, status: "done" }, at("2026-11-24T13:00:00Z"))).toBeUndefined();
    expect(reminderDueAt({ ...once, snoozedUntil: "2026-11-24T15:00:00.000Z" }, at("2026-11-24T14:00:00Z"))).toBeUndefined();

    const every2h = item(2, { remindAt: "2026-11-24T09:00:00.000Z", repeatMin: 120, remindedAt: "2026-11-24T09:00:10.000Z" });
    expect(reminderDueAt(every2h, at("2026-11-24T10:59:00Z"))).toBeUndefined();
    expect(reminderDueAt(every2h, at("2026-11-24T11:00:00Z"))?.toISOString()).toBe("2026-11-24T11:00:00.000Z");
    expect(reminderDueAt({ ...every2h, remindedAt: "2026-11-24T11:00:05.000Z" }, at("2026-11-24T12:30:00Z"))).toBeUndefined();
    expect(reminderDueAt({ ...every2h, remindedAt: "2026-11-24T11:00:05.000Z" }, at("2026-11-24T13:01:00Z"))?.toISOString()).toBe("2026-11-24T13:00:00.000Z");
  });

  it("a meeting: its minutes before it starts, until it starts; not all-day or declined ones", () => {
    const e: CalendarEvent = { id: "ev1", title: "Standup", start: "2026-11-24T07:00:00.000Z", end: "2026-11-24T07:15:00.000Z", allDay: false };
    expect(meetingDue(e, new Date("2026-11-24T06:49:00Z"), 10)).toBe(false);
    expect(meetingDue(e, new Date("2026-11-24T06:50:00Z"), 10)).toBe(true);
    expect(meetingDue(e, new Date("2026-11-24T06:59:59Z"), 10)).toBe(true);
    expect(meetingDue(e, new Date("2026-11-24T07:00:00Z"), 10)).toBe(false);
    expect(meetingDue({ ...e, declined: true }, new Date("2026-11-24T06:55:00Z"), 10)).toBe(false);
    expect(meetingDue({ ...e, allDay: true }, new Date("2026-11-24T06:55:00Z"), 10)).toBe(false);
    expect(meetingDue(e, new Date("2026-11-24T06:55:00Z"), 0)).toBe(false);
  });
});

/** A calendar that returns these events (overlapping the window asked), counting its reads. */
function fakeCalendar(events: CalendarEvent[], ready = true) {
  const reads: [string, string][] = [];
  const calendar: CalendarSource = {
    ready: async () => ready,
    eventsBetween: async (from, to) => {
      reads.push([from.toISOString(), to.toISOString()]);
      return events.filter((e) => Date.parse(e.end) > from.getTime() && Date.parse(e.start) < to.getTime());
    },
  };
  return { calendar, reads };
}

async function setup(opts: { account?: boolean; calendar?: CalendarSource; email?: EmailSource; patch?: (c: Config) => void } = {}) {
  const store = await tmpStore();
  const configRepo = await configured(store, (c) => {
    c.timezone = TZ;
    if (opts.account !== false) {
      c.slack.user = { token: "xoxp-owner-reminders-121212", userId: OWNER, userName: "dana", scopes: [], connectedAt: "2026-11-01T00:00:00.000Z", listen: true, sendAsMe: true };
    }
    opts.patch?.(c);
  });
  const clock = new Clock(Date.parse("2026-11-24T06:00:00Z"));
  const followups = new FollowupStore(new MemoryStore(), KEY, { now: clock.now, batchMs: 0 });
  const slack = fakeSlack();
  const threads = fakeThreads();
  const make = () =>
    new FollowupReminders({
      configRepo,
      followups,
      slack: slack.slack,
      threads: threads.threads,
      calendarTtlMs: 0,
      ...(opts.calendar ? { calendar: opts.calendar } : {}),
      ...(opts.email ? { email: opts.email } : {}),
    });
  const reminders = make();
  const tick = (iso: string) => {
    clock.set(iso);
    return reminders.tick(clock.now());
  };
  return { configRepo, followups, clock, slack, threads, reminders, tick, make };
}

const EVENTS: CalendarEvent[] = [
  { id: "ev-standup", title: "Standup", start: "2026-11-24T07:00:00.000Z", end: "2026-11-24T07:15:00.000Z", allDay: false, link: "https://meet.example.com/abc" },
  { id: "ev-offsite", title: "Offsite <!channel>", start: "2026-11-23T22:00:00.000Z", end: "2026-11-24T22:00:00.000Z", allDay: true },
  { id: "ev-declined", title: "Declined sync", start: "2026-11-24T09:00:00.000Z", end: "2026-11-24T09:30:00.000Z", allDay: false, declined: true },
];

describe("the reminders", () => {
  it("send nothing at all when no Slack account of the owner's is connected", async () => {
    const t = await setup({ account: false, calendar: fakeCalendar(EVENTS).calendar });
    await t.followups.add({ title: "Call Omar", source: "owner", remindAt: "2026-11-24T06:00:00Z" });
    const r = await t.tick("2026-11-24T06:50:00Z");
    expect(r).toMatchObject({ brief: false, items: [], meetings: [], skipped: expect.stringContaining("No Slack account") });
    expect(t.slack.messages).toEqual([]);
    expect(t.threads.started).toEqual([]);
  });

  it("send the morning brief at its local time on its days: today's calendar and the open follow-ups by their numbers", async () => {
    const cal = fakeCalendar(EVENTS);
    const t = await setup({ calendar: cal.calendar, patch: (c) => void (c.followups.meetingReminderMin = 0) });
    await t.followups.add({ title: "Reply to Omar about the Q3 invoice", source: "slack", from: "Omar", link: "https://example.slack.com/archives/D1/p1" });
    await t.followups.add({ title: "Send the deck", source: "owner", remindAt: "2026-11-24T06:30:00Z" });
    await t.followups.add({ title: "Snoozed one", source: "owner" });
    await t.followups.snooze(3, new Date("2026-11-25T08:00:00Z"));

    expect((await t.tick("2026-11-24T06:29:00Z")).brief).toBe(false);
    const r = await t.tick("2026-11-24T06:30:00Z");
    expect(r.brief).toBe(true);
    // The item due before the brief was in it: not reminded again on its own.
    expect(r.items).toEqual([]);
    expect(t.slack.messages).toHaveLength(1);
    const dm = t.slack.messages[0]!;
    expect(dm.channel).toBe(OWNER);
    expect(dm.metadata).toEqual({ event_type: "pointer_outside_content", event_payload: { source: "followups", level: "read" } });
    expect(dm.text).toContain("*Good morning: Tuesday, November 24*");
    expect(dm.text).toContain("• All day: Offsite &lt;!channel&gt;");
    expect(dm.text).toContain("• 09:00–09:15 Standup · <https://meet.example.com/abc|join>");
    expect(dm.text).not.toContain("Declined sync");
    expect(dm.text).toContain("*Open follow-ups: 2*");
    // The most overdue first, then the oldest; each with its own number.
    expect(dm.text.indexOf("*#2* Send the deck")).toBeLessThan(dm.text.indexOf("*#1* Reply to Omar about the Q3 invoice"));
    expect(dm.text).toContain("*#1* Reply to Omar about the Q3 invoice · Omar · Slack");
    expect(dm.text).toContain("(1 snoozed.)");
    expect(dm.text).toContain("Reply `done 2 1` to close items when they are done.");
    // Today's window, local midnight to midnight.
    expect(cal.reads[0]).toEqual(["2026-11-23T22:00:00.000Z", "2026-11-24T22:00:00.000Z"]);
    // Kept in the console, as relayed outside content.
    expect(t.threads.started).toEqual([expect.objectContaining({ title: "Follow-ups", relayed: "read" })]);
    expect(t.threads.started[0]!.markdown).toContain("**#1** Reply to Omar about the Q3 invoice");
    expect(t.threads.started[0]!.markdown).toContain("[open](https://example.slack.com/archives/D1/p1)");

    // Once a day, also after a restart.
    expect((await t.tick("2026-11-24T06:31:00Z")).brief).toBe(false);
    expect((await t.make().tick(new Date("2026-11-24T06:40:00Z"))).brief).toBe(false);
    expect(t.slack.messages).toHaveLength(1);
    // The next day's goes to the same console conversation.
    expect((await t.tick("2026-11-25T06:30:00Z")).brief).toBe(true);
    expect(t.threads.posted).toHaveLength(1);
    // Not on Saturday.
    expect((await t.tick("2026-11-28T06:30:00Z")).brief).toBe(false);
  });

  it("say plainly in the brief when no calendar is connected", async () => {
    const t = await setup({ calendar: fakeCalendar([], false).calendar });
    await t.tick("2026-11-24T06:30:00Z");
    expect(t.slack.messages[0]!.text).toContain("No calendar is connected: connect Google Calendar on the Integrations page");
    expect(t.slack.messages[0]!.text).toContain("Nothing open.");
    const none = await setup();
    await none.tick("2026-11-24T06:30:00Z");
    expect(none.slack.messages[0]!.text).toContain("No calendar is connected");
  });

  it("remind of an item at its time and every repeat until it is closed, never while snoozed", async () => {
    const t = await setup({ patch: (c) => void (c.followups.morningBrief.enabled = false) });
    await t.followups.add({ title: "Call Omar", source: "owner", remindAt: "2026-11-24T13:00:00Z", repeatMin: 120 });
    await t.followups.add({ title: "Pay the invoice", source: "gmail", remindAt: "2026-11-24T13:00:00Z" });
    expect((await t.tick("2026-11-24T12:59:00Z")).items).toEqual([]);
    expect((await t.tick("2026-11-24T13:00:00Z")).items).toEqual([1, 2]);
    expect(t.slack.messages[0]!.text).toContain("⏰ *Reminders*");
    expect(t.slack.messages[0]!.text).toContain("• *#1* Call Omar");
    expect(t.slack.messages[0]!.text).toContain("Reply `done 1 2` to close items when they are done.");
    expect(t.slack.messages[0]!.metadata).toMatchObject({ event_payload: { source: "followups", level: "read" } });
    expect((await t.tick("2026-11-24T13:01:00Z")).items).toEqual([]);
    expect((await t.tick("2026-11-24T15:00:00Z")).items).toEqual([1]);
    expect(t.slack.messages[1]!.text).toMatch(/^⏰ \*Reminder\* \*#1\* Call Omar/);
    expect(t.slack.messages[1]!.text).toContain("Reply `done 1` to close it when it is done.");
    await t.followups.snooze(1, new Date("2026-11-24T20:00:00Z"));
    expect((await t.tick("2026-11-24T17:00:00Z")).items).toEqual([]);
    expect((await t.tick("2026-11-24T20:00:00Z")).items).toEqual([1]);
    await t.followups.done([1]);
    expect((await t.tick("2026-11-24T22:00:00Z")).items).toEqual([]);
    expect(t.slack.messages).toHaveLength(3);
  });

  it("do not mark a reminder sent when the DM did not go: the next tick tries again", async () => {
    const t = await setup({ patch: (c) => void (c.followups.morningBrief.enabled = false) });
    await t.followups.add({ title: "Call Omar", source: "owner", remindAt: "2026-11-24T13:00:00Z" });
    const failing = new FollowupReminders({
      configRepo: t.configRepo,
      followups: t.followups,
      slack: () => ({ chat: { postMessage: (async () => Promise.reject(new Error("ratelimited"))) as never } }),
    });
    expect((await failing.tick(new Date("2026-11-24T13:00:00Z"))).items).toEqual([]);
    expect((await t.tick("2026-11-24T13:01:00Z")).items).toEqual([1]);
  });

  it("remind before each meeting once, also across a restart", async () => {
    const cal = fakeCalendar(EVENTS);
    const t = await setup({ calendar: cal.calendar, patch: (c) => void (c.followups.morningBrief.enabled = false) });
    expect((await t.tick("2026-11-24T06:49:00Z")).meetings).toEqual([]);
    const r = await t.tick("2026-11-24T06:50:00Z");
    expect(r.meetings).toEqual(["meeting:ev-standup:2026-11-24T07:00:00.000Z"]);
    expect(t.slack.messages[0]!.text).toBe("📅 *In 10 min*: Standup · 09:00–09:15 · <https://meet.example.com/abc|join>");
    expect((await t.tick("2026-11-24T06:52:00Z")).meetings).toEqual([]);
    // A restart remembers what was sent (kept in the store).
    expect((await t.make().tick(new Date("2026-11-24T06:55:00Z"))).meetings).toEqual([]);
    expect(t.slack.messages).toHaveLength(1);
    // Moved to a later time: reminded again for the new time.
    EVENTS[0] = { ...EVENTS[0]!, start: "2026-11-24T08:00:00.000Z", end: "2026-11-24T08:15:00.000Z" };
    try {
      expect((await t.tick("2026-11-24T07:52:00Z")).meetings).toEqual(["meeting:ev-standup:2026-11-24T08:00:00.000Z"]);
      expect(t.slack.messages[1]!.text).toContain("*In 8 min*: Standup");
    } finally {
      EVENTS[0] = { ...EVENTS[0]!, start: "2026-11-24T07:00:00.000Z", end: "2026-11-24T07:15:00.000Z" };
    }
    // Off when set to 0.
    await t.configRepo.update((c) => void (c.followups.meetingReminderMin = 0));
    expect((await t.make().tick(new Date("2026-11-24T08:50:00Z"))).meetings).toEqual([]);
  });

  it("note Gmail threads the owner answered last, at most hourly", async () => {
    const threads: EmailThread[] = [
      { id: "t-answered", subject: "Invoice", from: "Rita <rita@example.com>", at: "2026-11-24T10:00:00.000Z", snippet: "", ownerRepliedLast: true, link: "https://mail.example.com/t1" },
      { id: "t-open", subject: "Contract", from: "Sam <sam@example.com>", at: "2026-11-24T09:00:00.000Z", snippet: "", ownerRepliedLast: false, link: "https://mail.example.com/t2" },
    ];
    let asked = 0;
    const email: EmailSource = {
      ready: async () => true,
      threadsSince: async () => {
        asked += 1;
        return threads;
      },
    };
    const t = await setup({ email, patch: (c) => void (c.followups.morningBrief.enabled = false) });
    await t.followups.add({ title: "Answer Rita", source: "gmail", ref: "gmail:t-answered" });
    await t.followups.add({ title: "Answer Sam", source: "gmail", ref: "gmail:t-open" });
    await t.tick("2026-11-24T11:00:00Z");
    expect(asked).toBe(1);
    const [rita, sam] = [await t.followups.get(1), await t.followups.get(2)];
    expect(rita).toMatchObject({ status: "open", answeredAt: "2026-11-24T10:00:00.000Z" });
    expect(sam?.answeredAt).toBeUndefined();
    await t.tick("2026-11-24T11:30:00Z");
    expect(asked).toBe(1);
    await t.tick("2026-11-24T12:01:00Z");
    expect(asked).toBe(2);
    await t.configRepo.update((c) => void (c.followups.trackGmail = false));
    await t.tick("2026-11-24T14:00:00Z");
    expect(asked).toBe(2);
  });
});

describe("the reminders on the routines' clock", () => {
  it("run on each tick only while this instance holds the lease", async () => {
    const store = await tmpStore();
    const a = await routineEnv({ store, owner: "inst-a" });
    const b = await routineEnv({ store, shared: true, owner: "inst-b", clock: a.clock });
    const ticks: string[] = [];
    a.service.scheduler.onLeaderTick("reminders", async (now) => void ticks.push(`a@${now.toISOString()}`));
    b.service.scheduler.onLeaderTick("reminders", async (now) => void ticks.push(`b@${now.toISOString()}`));
    b.service.scheduler.onLeaderTick("broken", async () => {
      throw new Error("boom");
    });
    expect((await a.service.scheduler.tick()).leader).toBe(true);
    expect((await b.service.scheduler.tick()).leader).toBe(false);
    expect(ticks).toEqual(["a@2026-11-21T07:00:00.000Z"]);
    // The lease expires: the other instance takes over, and a failing task never stops its tick.
    a.clock.ms += 4 * 60_000;
    expect((await b.service.scheduler.tick()).leader).toBe(true);
    expect(ticks).toEqual(["a@2026-11-21T07:00:00.000Z", "b@2026-11-21T07:04:00.000Z"]);
  });
});
