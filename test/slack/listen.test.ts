import { describe, expect, it } from "vitest";
import {
  KeyedQueue,
  RecentSet,
  Semaphore,
  dedupeKey,
  isExplicitMention,
  queueKey,
  replyThreadTs,
  shouldRespond,
  taskThreadTs,
} from "../../src/slack/listen.js";
import type { SlackMessageEvent } from "../../src/chat/pointer-types.js";

const BOT = "UBOT";
const opts = { botUserId: BOT, pointerChannels: ["CPTR"] };
const msg = (extra: Partial<SlackMessageEvent> = {}): SlackMessageEvent => ({
  type: "message",
  channel: "C1",
  channel_type: "channel",
  user: "U1",
  ts: "100.1",
  text: "hello",
  ...extra,
});

describe("shouldRespond", () => {
  const table: [string, SlackMessageEvent, ReturnType<typeof shouldRespond>][] = [
    ["a DM", msg({ channel: "D1", channel_type: "im" }), "yes"],
    ["a DM thread reply", msg({ channel: "D1", channel_type: "im", thread_ts: "90.1" }), "yes"],
    ["a mention in the text", msg({ text: `<@${BOT}> hi` }), "yes"],
    ["an app_mention event", { type: "app_mention", channel: "C1", user: "U1", ts: "100.1", text: "hi" }, "yes"],
    ["a Pointer channel message", msg({ channel: "CPTR" }), "yes"],
    ["a plain top-level channel message", msg(), "no"],
    ["a thread reply elsewhere", msg({ thread_ts: "90.1" }), "if-pointer-in-thread"],
    ["a thread parent (thread_ts === ts)", msg({ thread_ts: "100.1" }), "no"],
    ["a bot message", msg({ channel_type: "im", bot_id: "B1" }), "no"],
    ["a message without a user", msg({ channel_type: "im", user: undefined }), "no"],
    ["Pointer's own message", msg({ channel_type: "im", user: BOT }), "no"],
    ["a message_changed edit", msg({ channel_type: "im", subtype: "message_changed" }), "no"],
    ["a channel_join", msg({ channel: "CPTR", subtype: "channel_join" }), "no"],
    ["a file_share in a DM", msg({ channel_type: "im", subtype: "file_share" }), "yes"],
    ["a thread_broadcast reply", msg({ subtype: "thread_broadcast", thread_ts: "90.1" }), "if-pointer-in-thread"],
    ["an event of another type", msg({ type: "reaction_added", channel_type: "im" }), "no"],
    ["a message without a channel", msg({ channel_type: "im", channel: undefined }), "no"],
  ];
  it.each(table)("%s", (_name, event, want) => {
    expect(shouldRespond(event, opts)).toBe(want);
  });

  it("counts only Pointer's own mention as explicit", () => {
    expect(isExplicitMention(msg({ text: `<@${BOT}> hi` }), BOT)).toBe(true);
    expect(isExplicitMention(msg({ text: `<@${BOT}|pointer> hi` }), BOT)).toBe(true);
    expect(isExplicitMention(msg({ text: "<@UOTHER> hi" }), BOT)).toBe(false);
    expect(isExplicitMention({ type: "app_mention", text: "hi" }, undefined)).toBe(true);
    expect(isExplicitMention(msg({ text: "<@UBOT> hi" }), undefined)).toBe(false);
  });
});

describe("ts helpers", () => {
  const dm = msg({ channel: "D1", channel_type: "im" });
  const dmThread = msg({ channel: "D1", channel_type: "im", thread_ts: "90.1" });
  const top = msg();
  const reply = msg({ thread_ts: "90.1" });
  const mention: SlackMessageEvent = { type: "app_mention", channel: "C1", user: "U1", ts: "100.1" };

  it("dedupes by channel and ts, whatever the event type", () => {
    expect(dedupeKey(top)).toBe("C1:100.1");
    expect(dedupeKey(mention)).toBe(dedupeKey(top));
  });
  it("queues per thread, per DM, or per top-level channel message", () => {
    expect(queueKey(reply)).toBe("C1:90.1");
    expect(queueKey(dmThread)).toBe("D1:90.1");
    expect(queueKey(dm)).toBe("D1");
    expect(queueKey(top)).toBe("C1:100.1");
    // A top-level message and the replies in its thread share one queue.
    expect(queueKey(msg({ thread_ts: "100.1", ts: "100.9" }))).toBe(queueKey(top));
  });
  it("replies in a thread in channels and flat in DMs", () => {
    expect(replyThreadTs(top)).toBe("100.1");
    expect(replyThreadTs(reply)).toBe("90.1");
    expect(replyThreadTs(mention)).toBe("100.1");
    expect(replyThreadTs(dm)).toBeUndefined();
    expect(replyThreadTs(dmThread)).toBe("90.1");
  });
  it("keeps repo tasks in the thread, or on the message itself", () => {
    expect(taskThreadTs(reply)).toBe("90.1");
    expect(taskThreadTs(dm)).toBe("100.1");
    expect(taskThreadTs(top)).toBe("100.1");
  });
});

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("KeyedQueue", () => {
  it("runs jobs with the same key in order, other keys in parallel", async () => {
    const q = new KeyedQueue();
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a1 = q.run("a", async () => {
      log.push("a1 start");
      await gate;
      log.push("a1 end");
    });
    const a2 = q.run("a", async () => void log.push("a2"));
    const b1 = q.run("b", async () => void log.push("b1"));
    await b1;
    expect(log).toEqual(["a1 start", "b1"]);
    release();
    await Promise.all([a1, a2]);
    expect(log).toEqual(["a1 start", "b1", "a1 end", "a2"]);
  });

  it("does not let a failing job block the next one", async () => {
    const q = new KeyedQueue();
    const failing = q.run("k", async () => {
      throw new Error("boom");
    });
    const next = q.run("k", async () => "ok");
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });

  it("forgets idle keys", async () => {
    const q = new KeyedQueue();
    await q.run("k", async () => 1);
    await q.run("j", async () => {
      throw new Error("x");
    }).catch(() => undefined);
    await tick();
    expect(q.size).toBe(0);
  });
});

describe("Semaphore", () => {
  it("allows n at once and admits waiters in order", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const releases: (() => void)[] = [];
    const jobs = [0, 1, 2, 3, 4].map((i) =>
      sem.run(async () => {
        started.push(i);
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => releases.push(r));
        active--;
        return i;
      }),
    );
    await tick();
    expect(started).toEqual([0, 1]);
    while (releases.length) {
      releases.shift()!();
      await tick();
      await tick();
    }
    expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3, 4]);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it("frees the slot when a job throws", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(sem.run(async () => "next")).resolves.toBe("next");
  });
});

describe("RecentSet", () => {
  it("evicts the oldest entry beyond its size", () => {
    const s = new RecentSet(3);
    for (const k of ["a", "b", "c", "d"]) s.add(k);
    expect(s.has("a")).toBe(false);
    expect(["b", "c", "d"].every((k) => s.has(k))).toBe(true);
  });
  it("refreshes an entry that is added again", () => {
    const s = new RecentSet(2);
    s.add("a");
    s.add("b");
    s.add("a");
    s.add("c");
    expect(s.has("a")).toBe(true);
    expect(s.has("b")).toBe(false);
  });
});
