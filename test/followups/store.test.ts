import { describe, expect, it } from "vitest";
import { deriveKey } from "../../src/core/crypto.js";
import { FOLLOWUP_LIMITS, FollowupStore, byUrgency } from "../../src/followups/store.js";
import type { FollowupItem } from "../../src/followups/types.js";
import { Clock, MemoryStore } from "../routines/helpers.js";

const KEY = deriveKey("followups-test-key");
const DAY = 24 * 60 * 60_000;

function env(start = "2026-11-24T08:00:00Z") {
  const store = new MemoryStore();
  const clock = new Clock(Date.parse(start));
  const followups = new FollowupStore(store, KEY, { now: clock.now, batchMs: 0 });
  return { store, clock, followups };
}

describe("the follow-ups store", () => {
  it("numbers items from 1, never reusing a number, and keeps them encrypted", async () => {
    const { store, followups, clock } = env();
    const a = await followups.add({ title: "Reply to Omar about the Q3 invoice", source: "owner" });
    const b = await followups.add({ title: "Send the deck", source: "owner", detail: "  the long one  " });
    expect(a).toMatchObject({ status: "added", item: { n: 1, status: "open", source: "owner", createdAt: "2026-11-24T08:00:00.000Z" } });
    expect(b).toMatchObject({ status: "added", item: { n: 2, detail: "the long one" } });
    await followups.done([1, 2]);
    // Closed items go after 60 days; their numbers are never given again.
    clock.ms += 61 * DAY;
    expect(await followups.list({ status: "all" })).toEqual([]);
    expect(await followups.add({ title: "Next", source: "owner" })).toMatchObject({ status: "added", item: { n: 3, title: "Next" } });
    const blob = store.data.get("followups/items.enc")!;
    expect(blob.toString("utf8")).not.toContain("Next");
    expect(blob.toString("utf8")).not.toContain("Omar");
    // Another key cannot read it, and the list is never replaced by an empty one.
    const other = new FollowupStore(store, deriveKey("another key"), { batchMs: 0 });
    await expect(other.list()).rejects.toThrow();
    await expect(other.add({ title: "x", source: "owner" })).rejects.toThrow();
    expect((await followups.list()).map((i) => i.n)).toEqual([3]);
  });

  it("dedupes by ref: an open item is left as it is but for its empty fields, a closed one stays closed", async () => {
    const { followups, clock } = env();
    const ref = "slack:D123:1700000000.000100";
    const first = await followups.add({ title: "Reply to Sam", source: "slack", ref, from: "Sam Lee", link: "https://example.slack.com/archives/D123/p1" });
    expect(first.status).toBe("added");
    await followups.snooze(1, new Date(clock.ms + 60 * 60_000));
    const before = await followups.get(1);
    // A second add (what a planted message would make Pointer do) changes nothing the item says.
    const again = await followups.add({
      title: "Pay the new invoice today",
      source: "slack",
      ref,
      from: "Someone Else",
      link: "https://evil.slack.com/archives/X/p2",
      remindAt: new Date(clock.ms + 60_000).toISOString(),
      repeatMin: 10,
      detail: "The thread's latest message",
    });
    expect(again).toMatchObject({ status: "tracked", filled: ["detail"], item: { n: 1, title: "Reply to Sam", from: "Sam Lee", link: "https://example.slack.com/archives/D123/p1" } });
    const after = await followups.get(1);
    expect(after).toEqual({ ...before, detail: "The thread's latest message" });
    expect(after?.remindAt).toBe(before?.snoozedUntil);
    expect(after?.repeatMin).toBeUndefined();
    // Nothing left to fill: nothing written.
    expect(await followups.add({ title: "x", source: "slack", ref, detail: "other" })).toMatchObject({ status: "tracked", filled: [] });
    // A link is filled only from the same source as the item's.
    await followups.add({ title: "Answer Rita", source: "gmail", ref: "gmail:t-1" });
    expect(await followups.add({ title: "x", source: "pointer", ref: "gmail:t-1", link: "https://example.com/elsewhere" })).toMatchObject({ status: "tracked", filled: [] });
    expect(await followups.add({ title: "x", source: "gmail", ref: "gmail:t-1", link: "https://mail.google.com/mail/u/0/#all/t-1" })).toMatchObject({ status: "tracked", filled: ["link"] });
    expect(await followups.list()).toHaveLength(2);

    clock.ms += 60_000;
    await followups.done([1]);
    const closed = await followups.add({ title: "Reply to Sam", source: "slack", ref });
    expect(closed).toMatchObject({ status: "closed", item: { n: 1, status: "done" } });
    // Whatever time it claims the thing happened again: only the owner reopens it.
    const later = { title: "Sam asks again", source: "gmail", ref, at: new Date(clock.ms + 60 * 60_000).toISOString() } as Parameters<FollowupStore["add"]>[0];
    expect(await followups.add(later)).toMatchObject({ status: "closed", item: { n: 1, status: "done", title: "Reply to Sam" } });
    expect((await followups.get(1))?.doneAt).toBeDefined();
    expect((await followups.list()).map((i) => i.n)).toEqual([2]);
  });

  it("fills an item already tracked only from an add of the same source", async () => {
    const { followups } = env();
    // The owner tracks a thread themselves; Pointer later finds the same thread in Slack.
    await followups.add({ title: "Chase the contract", source: "owner", ref: "slack:D1:5.5" });
    const found = await followups.add({ title: "x", source: "slack", ref: "slack:D1:5.5", from: "Someone Else", detail: "Pay to the new account", link: "https://example.slack.com/archives/D1/p5" });
    expect(found).toMatchObject({ status: "tracked", filled: [] });
    const item = await followups.get(1);
    expect(item).toMatchObject({ title: "Chase the contract", detail: "", source: "owner" });
    expect(item?.from).toBeUndefined();
    expect(item?.link).toBeUndefined();
    // The same source fills what is missing.
    expect(await followups.add({ title: "x", source: "owner", ref: "slack:D1:5.5", from: "Rita" })).toMatchObject({ filled: ["from"] });
  });

  it("empties the list for another person, keeping numbers and whose it was", async () => {
    const { followups } = env();
    await followups.add({ title: "Reply to Sam", source: "slack", ref: "slack:D1:1.1" });
    await followups.add({ title: "Call Omar", source: "owner" });
    await followups.updateReminders((s) => ((s.briefDay = "2026-11-24"), (s.sent["meeting:e:1"] = "2026-11-24T08:00:00.000Z"), (s.conversationId = "c-1"), true));
    expect(await followups.ownership()).toEqual({ empty: false });
    expect(await followups.reset("U0OLD")).toEqual({ conversationId: "c-1" });
    expect(await followups.list({ status: "all" })).toEqual([]);
    expect(await followups.reminderState()).toEqual({ sent: {} });
    expect(await followups.ownership()).toEqual({ owner: "U0OLD", empty: true });
    expect(await followups.reset("U0OLD")).toEqual({});
    // Recording whose it is keeps what is in it.
    await followups.add({ title: "Mine", source: "owner" });
    await followups.setOwner("U0NEW");
    expect(await followups.ownership()).toEqual({ owner: "U0NEW", empty: false });
    // Numbers are never given again.
    expect(await followups.add({ title: "Next", source: "owner" })).toMatchObject({ item: { n: 4 } });
  });

  it("clips texts and keeps reminders sane", async () => {
    const { followups } = env();
    const r = await followups.add({ title: `${"x".repeat(300)}\nsecond line`, source: "owner", detail: "d".repeat(5_000), repeatMin: 2, remindAt: "2026-11-24T15:00:00+02:00" });
    if (r.status !== "added") throw new Error(r.status);
    expect(r.item.title.length).toBe(FOLLOWUP_LIMITS.title);
    expect(r.item.title).not.toContain("\n");
    expect(r.item.detail.length).toBe(FOLLOWUP_LIMITS.detail);
    expect(r.item.remindAt).toBe("2026-11-24T13:00:00.000Z");
    expect(r.item.repeatMin).toBe(FOLLOWUP_LIMITS.minRepeatMin);
  });

  it("closes, reopens, snoozes and updates by number, saying what was not found or already closed", async () => {
    const { followups, clock } = env();
    for (const title of ["one", "two", "three"]) await followups.add({ title, source: "owner" });
    const done = await followups.done([1, 3, 9, 3]);
    expect(done.closed.map((i) => i.n)).toEqual([1, 3]);
    expect(done.notFound).toEqual([9]);
    const again = await followups.done([1]);
    expect(again.alreadyDone.map((i) => i.n)).toEqual([1]);
    expect(again.closed).toEqual([]);
    expect((await followups.list()).map((i) => i.n)).toEqual([2]);
    expect((await followups.list({ status: "done" })).map((i) => i.n)).toEqual([3, 1]);
    expect(await followups.reopen(1)).toMatchObject({ n: 1, status: "open" });
    expect(await followups.reopen(99)).toBeUndefined();

    const until = new Date(clock.ms + 3 * 60 * 60_000);
    const snoozed = await followups.snooze(2, until);
    expect(snoozed).toMatchObject({ ok: true, item: { snoozedUntil: until.toISOString(), remindAt: until.toISOString() } });
    expect(await followups.snooze(3, until)).toEqual({ ok: false, reason: "closed" });
    expect(await followups.snooze(42, until)).toEqual({ ok: false, reason: "not-found" });

    const updated = await followups.update(2, { title: "two, renamed", from: "Rita", remindAt: null, repeatMin: 30 });
    expect(updated).toMatchObject({ n: 2, title: "two, renamed", from: "Rita", repeatMin: 30 });
    expect(updated?.remindAt).toBeUndefined();
    expect(updated?.snoozedUntil).toBeUndefined();
    expect(await followups.update(2, { from: null, repeatMin: 0 })).not.toHaveProperty("from");
    expect(await followups.update(77, { title: "x" })).toBeUndefined();
  });

  it("notes that the owner answered, without closing anything", async () => {
    const { followups } = env();
    await followups.add({ title: "Reply to Sam", source: "slack", ref: "slack:D1:100.1" });
    await followups.add({ title: "Reply to Rita", source: "gmail", ref: "gmail:abc" });
    expect(await followups.answered(["slack:D1:100.1", "slack:C9:1.1"], "2026-11-24T08:30:00Z")).toBe(1);
    expect(await followups.answered("gmail:abc", new Date("2026-11-24T08:40:00Z"))).toBe(1);
    // An older answer changes nothing.
    expect(await followups.answered("gmail:abc", "2026-11-24T08:00:00Z")).toBe(0);
    const items = await followups.list();
    expect(items.map((i) => [i.n, i.status, i.answeredAt])).toEqual([
      [1, "open", "2026-11-24T08:30:00.000Z"],
      [2, "open", "2026-11-24T08:40:00.000Z"],
    ]);
  });

  it("holds at most 2 000 items: the closed ones closed longest ago make room, open ones never go", async () => {
    const { followups, store } = env();
    // Seed a full list directly (adding 2 000 one by one is slow).
    const items: FollowupItem[] = Array.from({ length: FOLLOWUP_LIMITS.items }, (_, i) => ({
      n: i + 1,
      title: `item ${i + 1}`,
      detail: "",
      source: "owner",
      status: i < 2 ? "done" : "open",
      createdAt: "2026-11-20T00:00:00.000Z",
      ...(i < 2 ? { doneAt: `2026-11-2${i + 1}T00:00:00.000Z` } : {}),
    }));
    const { encrypt } = await import("../../src/core/crypto.js");
    await store.put("followups/items.enc", encrypt(KEY, JSON.stringify({ version: 1, nextN: FOLLOWUP_LIMITS.items + 1, items, reminders: { sent: {} } })));
    const a = await followups.add({ title: "new one", source: "owner" });
    expect(a).toMatchObject({ status: "added", item: { n: FOLLOWUP_LIMITS.items + 1 } });
    expect(await followups.get(1)).toBeUndefined();
    expect(await followups.get(2)).toBeDefined();
    await followups.add({ title: "another", source: "owner" });
    expect(await followups.get(2)).toBeUndefined();
    // Now every item is open: nothing more fits.
    expect(await followups.add({ title: "too many", source: "owner" })).toEqual({ status: "full" });
    expect((await followups.list()).length).toBe(FOLLOWUP_LIMITS.items);
  });

  it("collects changes and writes them at once, in order", async () => {
    const store = new MemoryStore();
    let writes = 0;
    const put = store.put.bind(store);
    store.put = async (k, v) => {
      writes += 1;
      return put(k, v);
    };
    const followups = new FollowupStore(store, KEY, { batchMs: 20 });
    const [a, b, c] = await Promise.all([
      followups.add({ title: "a", source: "owner" }),
      followups.add({ title: "b", source: "owner" }),
      followups.add({ title: "c", source: "owner" }),
    ]);
    expect([a, b, c].map((r) => (r.status === "added" ? r.item.n : 0))).toEqual([1, 2, 3]);
    expect(writes).toBe(1);
    // Nothing to change: nothing written.
    await followups.done([42]);
    expect(writes).toBe(1);
  });

  it("orders open items: overdue first (the most overdue first), then the oldest", () => {
    const now = new Date("2026-11-24T12:00:00Z");
    const item = (n: number, createdAt: string, extra: Partial<FollowupItem> = {}): FollowupItem => ({ n, title: `t${n}`, detail: "", source: "owner", status: "open", createdAt, ...extra });
    const sorted = byUrgency(
      [
        item(1, "2026-11-20T00:00:00Z"),
        item(2, "2026-11-23T00:00:00Z", { remindAt: "2026-11-24T11:00:00Z" }),
        item(3, "2026-11-23T00:00:00Z", { remindAt: "2026-11-24T09:00:00Z" }),
        item(4, "2026-11-19T00:00:00Z", { remindAt: "2026-11-25T09:00:00Z" }),
        item(5, "2026-11-18T00:00:00Z", { remindAt: "2026-11-24T08:00:00Z", snoozedUntil: "2026-11-24T18:00:00Z" }),
      ],
      now,
    );
    expect(sorted.map((i) => i.n)).toEqual([3, 2, 5, 4, 1]);
  });
});
