import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../src/chat/pointer-types.js";
import { type Config, ConfigSchema } from "../../src/core/config.js";
import { decrypt, deriveKey, encrypt } from "../../src/core/crypto.js";
import { FsStore } from "../../src/core/store.js";
import { INBOX_LIMITS, type InboxItem, SlackInbox } from "../../src/slack/inbox.js";
import {
  AnswerNotifier,
  OUTREACH_LIMITS,
  type Outreach,
  answerCandidate,
  answerNotice,
  answeredOutreach,
  matchAnswer,
} from "../../src/slack/outreach.js";
import { makeRedactor } from "../../src/tasks/worker.js";

const OWNER = "UOWN";
const NOW = new Date("2026-11-23T12:00:00Z");
const BASE = Math.floor(NOW.getTime() / 1000);
/** A Slack ts `sec` seconds before now (negative: after). */
const ago = (sec: number) => `${BASE - sec}.000100`;
const MIN = 60;
const DAY = 24 * 60 * MIN;

/** Pointer's DM with Sam (D2) and a post in #ops (C1), both sent an hour ago. */
const toSam: Outreach = { id: `D2:${ago(3600)}`, channel: "D2", ts: ago(3600), where: "dm", recipient: "U2", recipientName: "Sam Lee", requester: "dana", text: "Can you send the Q3 deck by Friday?" };
const inOps: Outreach = { id: `C1:${ago(3600)}`, channel: "C1", ts: ago(3600), where: "channel", recipient: "C1", recipientName: "#ops", requester: "dana", text: "Who has the staging keys?" };

const candidate = (x: Partial<{ channel: string; ts: string; threadTs: string; userId: string }>) => ({ channel: "D2", ts: ago(60), userId: "U2", ...x });

describe("answeredOutreach", () => {
  it("takes the person's message in Pointer's DM after the outreach, within 7 days", () => {
    expect(answeredOutreach(candidate({}), [toSam], [])).toBe(toSam);
    // Before it, from someone else, in another DM, or after 7 days: no.
    expect(answeredOutreach(candidate({ ts: ago(4000) }), [toSam], [])).toBeUndefined();
    expect(answeredOutreach(candidate({ userId: "U3" }), [toSam], [])).toBeUndefined();
    expect(answeredOutreach(candidate({ channel: "D3" }), [toSam], [])).toBeUndefined();
    const old = { ...toSam, id: `D2:${ago(8 * DAY)}`, ts: ago(8 * DAY) };
    expect(answeredOutreach(candidate({}), [old], [])).toBeUndefined();
    expect(answeredOutreach(candidate({ ts: ago(8 * DAY - 6 * DAY) }), [old], [])).toBe(old);
    // No outreach at all.
    expect(answeredOutreach(candidate({}), [], [])).toBeUndefined();
  });

  it("keeps what they add within 30 minutes of their last answer; later messages are their own conversation", () => {
    const answered = [{ ts: ago(50 * MIN), outreachId: toSam.id }];
    expect(answeredOutreach(candidate({ ts: ago(25 * MIN) }), [toSam], answered)).toBe(toSam);
    expect(answeredOutreach(candidate({ ts: ago(10 * MIN) }), [toSam], answered)).toBeUndefined();
    // A chain of follow-ups: each one counts from the last.
    const chain = [...answered, { ts: ago(25 * MIN), outreachId: toSam.id }];
    expect(answeredOutreach(candidate({ ts: ago(10 * MIN) }), [toSam], chain)).toBe(toSam);
    // The same message again (kept already) gives the same answer: only earlier answers count.
    expect(answeredOutreach(candidate({ ts: ago(50 * MIN) }), [toSam], answered)).toBe(toSam);
  });

  it("a later outreach to the same person opens the window again", () => {
    const answered = [{ ts: ago(50 * MIN), outreachId: toSam.id }];
    const again: Outreach = { ...toSam, id: `D2:${ago(5 * MIN)}`, ts: ago(5 * MIN), text: "And the Q4 one?" };
    expect(answeredOutreach(candidate({ ts: ago(1 * MIN) }), [toSam, again], answered)).toBe(again);
  });

  it("takes every reply in the outreach's own thread, from anyone, within 7 days", () => {
    const reply = (x: Partial<{ ts: string; threadTs: string; userId: string }>) => candidate({ channel: "C1", threadTs: inOps.ts, userId: "U3", ...x });
    expect(answeredOutreach(reply({}), [inOps], [])).toBe(inOps);
    expect(answeredOutreach(reply({ userId: "U9" }), [inOps], [{ ts: ago(3000), outreachId: inOps.id }])).toBe(inOps);
    // Top-level messages in the channel, and replies in other threads, are not answers.
    expect(answeredOutreach(candidate({ channel: "C1", userId: "U3" }), [inOps], [])).toBeUndefined();
    expect(answeredOutreach(reply({ threadTs: ago(5000) }), [inOps], [])).toBeUndefined();
    const old = { ...inOps, id: `C1:${ago(8 * DAY)}`, ts: ago(8 * DAY) };
    expect(answeredOutreach(reply({ threadTs: old.ts }), [old], [])).toBeUndefined();
    // In a DM, a reply in the outreach's thread counts whatever the follow-up window says.
    const late = [{ ts: ago(50 * MIN), outreachId: toSam.id }];
    expect(answeredOutreach(candidate({ threadTs: toSam.ts, ts: ago(1 * MIN) }), [toSam], late)).toBe(toSam);
  });

  it("takes a person's new message only: never the owner's, Pointer's, a bot's, an edit or an app_mention", () => {
    const e = (x: Partial<SlackMessageEvent>) => ({ type: "message", channel: "D2", channel_type: "im", ts: "5.1", user: "U2", text: "sure", ...x }) as SlackMessageEvent;
    expect(answerCandidate(e({}), OWNER, "UBOT")).toEqual({ channel: "D2", ts: "5.1", userId: "U2" });
    expect(answerCandidate(e({ thread_ts: "4.1" }), OWNER, "UBOT")).toEqual({ channel: "D2", ts: "5.1", userId: "U2", threadTs: "4.1" });
    for (const x of [{ user: OWNER }, { user: "UBOT" }, { bot_id: "B1" }, { subtype: "message_changed" }, { type: "app_mention" }]) {
      expect(answerCandidate(e(x), OWNER, "UBOT")).toBeUndefined();
    }
  });
});

function config(patch: Partial<NonNullable<Config["slack"]["user"]>> = {}): Config {
  return ConfigSchema.parse({
    timezone: "UTC",
    slack: {
      botToken: "xoxb-bot-token-secret",
      signingSecret: "s".repeat(20),
      botUserId: "UBOT",
      user: { token: "xoxp-owner-token-secret", userId: OWNER, userName: "dana", connectedAt: "2026-11-01T00:00:00Z", ...patch },
    },
  });
}

const slackError = (code: string) => Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });

/** A post of Pointer's in a conversation's history, with the metadata Slack gives back. */
interface HistoryPost {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  metadata?: { event_type: string; event_payload: Record<string, string> };
}
const pointerPost = (ts: string, kind?: "pointer_chat_reply" | "pointer_sent_message" | "pointer_outside_content"): HistoryPost => ({
  ts,
  user: "UBOT",
  bot_id: "B1",
  text: "…",
  ...(kind ? { metadata: { event_type: kind, event_payload: { source: "test" } } } : {}),
});

async function setup(opts: { now?: () => Date } = {}) {
  const store = new FsStore(await mkdtemp(join(tmpdir(), "army-outreach-")));
  const key = deriveKey("k");
  const inbox = new SlackInbox(store, key, { now: opts.now ?? (() => NOW), batchMs: 0 });
  const names: Record<string, string> = { U2: "Sam Lee", U3: "Rita Oz" };
  /** What Slack has at the top level of each conversation (newest first, as Slack returns it), and the reads of it. */
  const history = new Map<string, HistoryPost[]>();
  const reads: { channel: string; oldest?: string; latest?: string; include_all_metadata?: boolean }[] = [];
  const bot = {
    conversations: {
      info: async () => Promise.reject(new Error("not used")),
      history: async (a: { channel: string; oldest?: string; latest?: string; include_all_metadata?: boolean }) => {
        reads.push(a);
        return { ok: true, messages: history.get(a.channel) ?? [], has_more: false };
      },
    },
    users: { info: async ({ user: id }: { user: string }) => ({ user: { profile: { display_name: names[id] ?? id } } }) },
  };
  // The owner's token sees none of Pointer's conversations; of the channels, only those they are in.
  const memberOf = new Map<string, string>([["C1", "ops"]]);
  const owner = {
    conversations: {
      info: async ({ channel }: { channel: string }) => {
        const name = memberOf.get(channel);
        if (name === undefined) throw slackError("channel_not_found");
        return { ok: true, channel: { id: channel, name, is_member: true } };
      },
    },
    users: bot.users,
  };
  const redact = makeRedactor(["sk-live-very-secret-value"]);
  const ctx = (c: Config) => ({ config: c, client: (token: string) => (token.startsWith("xoxp-") ? owner : bot) as never, redact });
  const event = (e: Partial<SlackMessageEvent>) => ({ type: "message", user: "U2", channel: "D2", channel_type: "im", ...e }) as SlackMessageEvent;
  const answer = (e: Partial<SlackMessageEvent>, c = config()) => inbox.captureAnswer(event(e), ctx(c));
  const all = () => inbox.list({ since: new Date(NOW.getTime() - 3 * DAY * 1000), openOnly: false, ownerId: OWNER });
  /** What recordOutreach checks against: the current config, the owner's token. */
  const octx = (c = config()) => ({ config: c, ownerClient: () => owner });
  /** Records an outreach as a request that started now would. */
  const record = (o: Outreach, c = config()) => inbox.recordOutreach(inbox.outreachTicket(OWNER), o, octx(c));
  return { store, key, inbox, answer, all, ctx, event, history, reads, memberOf, octx, record, bot };
}

describe("SlackInbox: messages Pointer sent for the owner, and their answers", () => {
  it("keeps an answer in the inbox under the outreach it answers, without starting the owner's inbox", async () => {
    const t = await setup();
    await t.record(toSam);
    await t.record(toSam);
    const captured = await t.answer({ ts: ago(10 * MIN), text: "Sure, <@U3> has it. Key sk-live-very-secret-value" });
    expect(captured?.outreach).toEqual(toSam);
    expect(captured?.item).toMatchObject({ where: "to_pointer", channel: "D2", channelName: "Sam Lee", userName: "Sam Lee", outreachId: toSam.id, text: "Sure, @Rita Oz has it. Key [redacted]" });

    const listed = await t.all();
    // Answers to Pointer come from its own conversations: the owner's inbox has not started.
    expect(listed.startedAt).toBeUndefined();
    expect(listed.entries).toEqual([]);
    expect(listed.outreach).toHaveLength(1);
    expect(listed.outreach[0]).toMatchObject({ id: toSam.id, open: true, answers: [{ text: "Sure, @Rita Oz has it. Key [redacted]" }] });
  });

  it("is stored encrypted, and reads back", async () => {
    const t = await setup();
    await t.record(toSam);
    await t.answer({ ts: ago(10 * MIN), text: "the deck is in the shared drive" });
    const raw = (await t.store.get("slack/inbox.enc"))!;
    expect(raw.toString("latin1")).not.toMatch(/Q3 deck|shared drive|Sam Lee/);
    const data = JSON.parse(decrypt(t.key, raw)) as { outreach: Outreach[]; items: InboxItem[] };
    expect(data.outreach.map((o) => o.text)).toEqual(["Can you send the Q3 deck by Friday?"]);
    expect(data.items.map((i) => [i.where, i.outreachId, i.text])).toEqual([["to_pointer", toSam.id, "the deck is in the shared drive"]]);
    // A new process reads the same.
    const again = new SlackInbox(t.store, t.key, { now: () => NOW, batchMs: 0 });
    expect((await again.list({ since: new Date(0), openOnly: false, ownerId: OWNER })).outreach[0]?.answers).toHaveLength(1);
  });

  it("keeps nothing that answers no outreach: others, the owner, Pointer, bots, too late, or listening off", async () => {
    const t = await setup();
    await t.record(toSam);
    expect(await t.answer({ ts: ago(10 * MIN), user: "U3" })).toBeUndefined();
    expect(await t.answer({ ts: ago(10 * MIN), user: OWNER })).toBeUndefined();
    expect(await t.answer({ ts: ago(10 * MIN), user: "UBOT" })).toBeUndefined();
    expect(await t.answer({ ts: ago(10 * MIN), bot_id: "B1" })).toBeUndefined();
    expect(await t.answer({ ts: ago(2 * 3600) })).toBeUndefined();
    expect(await t.answer({ ts: ago(10 * MIN), channel: "D3" })).toBeUndefined();
    expect(await t.answer({ ts: ago(10 * MIN) }, config({ listen: false }))).toBeUndefined();
    // Another owner's inbox has no outreach.
    expect(await t.answer({ ts: ago(10 * MIN) }, config({ userId: "UOTHER" }))).toBeUndefined();
    expect((await t.all()).outreach[0]?.answers).toEqual([]);
  });

  it("tells Pointer's reply what it answers, without keeping anything", async () => {
    const t = await setup();
    await t.record(toSam);
    const e = { type: "message", user: "U2", channel: "D2", channel_type: "im", ts: ago(10 * MIN), text: "sure" } as SlackMessageEvent;
    expect(await t.inbox.answering(e, config(), t.bot as never)).toEqual(toSam);
    expect(await t.inbox.answering({ ...e, user: "U3" }, config(), t.bot as never)).toBeUndefined();
    expect(await t.inbox.answering(e, config({ listen: false }), t.bot as never)).toBeUndefined();
    expect((await t.all()).outreach[0]?.answers).toEqual([]);
  });

  it("keeps outreaches 14 days and at most 1 000; answers go with their outreach", async () => {
    let now = NOW;
    const t = await setup({ now: () => now });
    const old: Outreach = { ...toSam, id: `D2:${ago(10 * DAY)}`, ts: ago(10 * DAY) };
    await t.record(old);
    // Answered a day later.
    const answer: InboxItem = { id: `D2:${ago(9 * DAY)}`, channel: "D2", channelName: "Sam Lee", where: "to_pointer", ts: ago(9 * DAY), userId: "U2", userName: "Sam Lee", mentioned: false, followed: false, text: "done", outreachId: old.id };
    const blob = JSON.parse(decrypt(t.key, (await t.store.get("slack/inbox.enc"))!)) as { items: InboxItem[] };
    blob.items.push(answer);
    await t.store.put("slack/inbox.enc", encrypt(t.key, JSON.stringify(blob)));
    expect((await t.inbox.list({ since: new Date(0), openOnly: false, ownerId: OWNER })).outreach.map((o) => [o.open, o.answers.length])).toEqual([[false, 1]]);
    // Five days on, the outreach is 15 days old: it goes, and its answer with it.
    now = new Date(NOW.getTime() + 5 * DAY * 1000);
    expect(await t.inbox.list({ since: new Date(0), openOnly: false, ownerId: OWNER })).toEqual({ entries: [], outreach: [] });

    // Beyond 1 000: the oldest go.
    now = NOW;
    const many = Array.from({ length: OUTREACH_LIMITS.items + 5 }, (_, i) => ({ ...toSam, id: `D2:${ago(2_000 - i)}`, ts: ago(2_000 - i), text: `m${i}` }));
    await Promise.all(many.map((o) => t.record(o)));
    const kept = (await t.inbox.list({ since: new Date(0), openOnly: false, ownerId: OWNER })).outreach;
    expect(kept).toHaveLength(OUTREACH_LIMITS.items);
    expect([kept[0]?.text, kept.at(-1)?.text]).toEqual([`m${OUTREACH_LIMITS.items + 4}`, "m5"]);
  });

  it("clips what Pointer sent, and forgets every outreach on clear", async () => {
    const t = await setup();
    await t.record({ ...toSam, text: "x".repeat(2_000) });
    expect((await t.all()).outreach[0]?.text).toHaveLength(OUTREACH_LIMITS.text);
    await t.inbox.clear();
    expect((await t.all()).outreach).toEqual([]);
    expect(await t.answer({ ts: ago(10 * MIN) })).toBeUndefined();
  });

  it("never trades a new outreach for an older read that finished after its write", async () => {
    /** A store whose next read is held back after reading. */
    class SlowStore extends FsStore {
      hold: Promise<void> | undefined;
      override async get(key: string) {
        const value = await super.get(key);
        const hold = this.hold;
        this.hold = undefined;
        if (hold) await hold;
        return value;
      }
    }
    const store = new SlowStore(await mkdtemp(join(tmpdir(), "army-outreach-")));
    const inbox = new SlackInbox(store, deriveKey("k"), { now: () => NOW, batchMs: 0 });
    const t = await setup();
    let release!: () => void;
    store.hold = new Promise<void>((resolve) => (release = resolve));
    const event = (x: Partial<SlackMessageEvent>) => ({ type: "message", user: "U2", channel: "D2", channel_type: "im", ...x }) as SlackMessageEvent;
    // A message arrives before anything is known: its read of the empty inbox is slow.
    const early = inbox.captureAnswer(event({ ts: ago(20 * MIN), user: "U3" }), t.ctx(config()));
    await inbox.recordOutreach(inbox.outreachTicket(OWNER), toSam, t.octx());
    release();
    expect(await early).toBeUndefined();
    expect(await inbox.captureAnswer(event({ ts: ago(10 * MIN), text: "sure" }), t.ctx(config()))).toMatchObject({ outreach: { id: toSam.id } });
  });

  it("an owner's message elsewhere still starts their inbox, with the outreaches kept", async () => {
    const t = await setup();
    await t.record(toSam);
    expect((await t.all()).startedAt).toBeUndefined();
    await t.inbox.capture({ type: "message", user: OWNER, channel: "D9", channel_type: "im", ts: ago(30), text: "hi" } as SlackMessageEvent, t.ctx(config()));
    const listed = await t.all();
    expect(listed.startedAt).toBe(NOW.toISOString());
    expect(listed.outreach.map((o) => o.id)).toEqual([toSam.id]);
  });
});

describe("only what answers the owner's message is passed on", () => {
  it("a reply in another thread of the DM never answers it, even when the DM rule would", () => {
    expect(matchAnswer(candidate({}), [toSam], [])).toEqual({ outreach: toSam, rule: "dm", since: toSam.ts });
    // A thread in Pointer's DM with Sam started before the outreach (a repo task's, say), and one after it.
    expect(matchAnswer(candidate({ threadTs: ago(DAY) }), [toSam], [])).toBeUndefined();
    expect(matchAnswer(candidate({ threadTs: ago(30 * MIN) }), [toSam], [])).toBeUndefined();
    // Its own thread still is: by the thread rule.
    expect(matchAnswer(candidate({ threadTs: toSam.ts }), [toSam], [])).toMatchObject({ outreach: toSam, rule: "thread" });
    // Follow-ups count from the last answer.
    expect(matchAnswer(candidate({ ts: ago(10 * MIN) }), [toSam], [{ ts: ago(20 * MIN), outreachId: toSam.id }])).toMatchObject({ since: ago(20 * MIN) });
  });

  it("anything else Pointer posts in the DM after it ends its window: a message sent for someone else, a routine's report, a post without metadata", async () => {
    for (const kind of ["pointer_sent_message", "pointer_outside_content", undefined] as const) {
      const t = await setup();
      await t.record(toSam);
      // Half an hour ago a colleague had Pointer write to Sam in the same DM; Sam answers that.
      t.history.set("D2", [pointerPost(ago(30 * MIN), kind)]);
      expect(await t.answer({ ts: ago(10 * MIN), text: "Sure, I can do that for you" }), String(kind)).toBeUndefined();
      expect(await t.inbox.answering(t.event({ ts: ago(10 * MIN), text: "Sure" }), config(), t.bot as never), String(kind)).toBeUndefined();
      expect((await t.all()).outreach[0]?.answers).toEqual([]);
    }
  });

  it("Pointer's own chat replies keep the window open; Slack is asked only for what lies between, with the metadata", async () => {
    const t = await setup();
    await t.record(toSam);
    t.history.set("D2", [pointerPost(ago(40 * MIN), "pointer_chat_reply")]);
    expect(await t.answer({ ts: ago(10 * MIN), text: "Sure" })).toMatchObject({ outreach: { id: toSam.id } });
    expect(t.reads.at(-1)).toMatchObject({ channel: "D2", oldest: toSam.ts, latest: ago(10 * MIN), include_all_metadata: true });
    // A follow-up is checked from the last answer on: a message sent for someone else since then ends the window.
    t.history.set("D2", [pointerPost(ago(5 * MIN), "pointer_sent_message"), pointerPost(ago(9 * MIN), "pointer_chat_reply")]);
    expect(await t.answer({ ts: ago(2 * MIN), text: "and here is yours" })).toBeUndefined();
    expect(t.reads.at(-1)).toMatchObject({ oldest: ago(10 * MIN), latest: ago(2 * MIN) });
    expect((await t.all()).outreach[0]?.answers.map((a) => a.text)).toEqual(["Sure"]);
  });

  it("a reply in the outreach's own thread needs no look at the DM", async () => {
    const t = await setup();
    await t.record(toSam);
    t.history.set("D2", [pointerPost(ago(30 * MIN), "pointer_sent_message")]);
    expect(await t.answer({ ts: ago(10 * MIN), thread_ts: toSam.ts, text: "in the thread" })).toMatchObject({ outreach: { id: toSam.id } });
    expect(t.reads).toEqual([]);
  });

  it("passes nothing on when Slack cannot say what Pointer posted in between, or there is too much of it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const t = await setup();
      await t.record(toSam);
      t.bot.conversations.history = async () => Promise.reject(slackError("ratelimited"));
      expect(await t.answer({ ts: ago(10 * MIN), text: "Sure" })).toBeUndefined();
      expect(warn.mock.calls.map((c) => c.join(" "))).toEqual(["[slack] could not tell whether a message answers one sent for the owner: ratelimited"]);
      t.bot.conversations.history = async () => ({ ok: true, messages: [], has_more: true });
      expect(await t.answer({ ts: ago(9 * MIN), text: "Sure" })).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps at most 20 answers per message: a busy thread stops there", async () => {
    const t = await setup();
    await t.record(inOps);
    const replies = Array.from({ length: OUTREACH_LIMITS.answers + 2 }, (_, i) => ({ channel: "C1", channel_type: "channel", user: "U3", ts: ago(50 * MIN - i), thread_ts: inOps.ts, text: `r${i}` }));
    const kept = [];
    for (const r of replies) kept.push(await t.answer(r));
    expect(kept.filter(Boolean)).toHaveLength(OUTREACH_LIMITS.answers);
    expect(kept.slice(-2)).toEqual([undefined, undefined]);
    expect((await t.all()).outreach[0]?.answers).toHaveLength(OUTREACH_LIMITS.answers);
  });

  it("answers never push the owner's own messages out of the inbox", async () => {
    const t = await setup();
    await t.record(inOps);
    const blob = JSON.parse(decrypt(t.key, (await t.store.get("slack/inbox.enc"))!)) as { items: InboxItem[]; startedAt: string };
    const mine = Array.from({ length: INBOX_LIMITS.items }, (_, i): InboxItem => ({ id: `D9:${ago(DAY - i)}`, channel: "D9", channelName: "Rita Oz", where: "dm", ts: ago(DAY - i), userId: "U3", userName: "Rita Oz", mentioned: false, followed: false, text: `m${i}` }));
    blob.items = mine;
    blob.startedAt = NOW.toISOString();
    await t.store.put("slack/inbox.enc", encrypt(t.key, JSON.stringify(blob)));
    // Newer answers, beyond the limit of 3 000 items together.
    for (let i = 0; i < 5; i++) await t.answer({ channel: "C1", channel_type: "channel", user: "U3", ts: ago(30 * MIN - i), thread_ts: inOps.ts, text: `a${i}` });
    const listed = await t.inbox.list({ since: new Date(0), openOnly: false, ownerId: OWNER });
    expect(listed.entries).toHaveLength(INBOX_LIMITS.items);
    expect(listed.outreach[0]?.answers).toHaveLength(5);
  });
});

describe("what Pointer sends for the owner is kept only while it may be", () => {
  it("a post in a channel only where the owner is a member, named as their token names it", async () => {
    const t = await setup();
    const ticket = t.inbox.outreachTicket(OWNER);
    expect(await t.inbox.outreachPlace(ticket, t.octx(), "C1")).toEqual({ keep: true, name: "#ops" });
    expect(await t.inbox.outreachPlace(ticket, t.octx(), "C9")).toEqual({ keep: false });
    // Pointer's DM with someone, and a DM to a person: the owner is never in those.
    expect(await t.inbox.outreachPlace(ticket, t.octx(), "D2")).toEqual({ keep: true });
    expect(await t.inbox.outreachPlace(ticket, t.octx(), undefined)).toEqual({ keep: true });
    const inC9: Outreach = { ...inOps, id: `C9:${inOps.ts}`, channel: "C9", recipient: "C9", recipientName: "C9" };
    expect(await t.record(inC9)).toBe(false);
    expect(await t.record(inOps)).toBe(true);
    expect((await t.all()).outreach.map((o) => o.channel)).toEqual(["C1"]);
    // So a reply in the thread of a post in a channel the owner is not in never reaches them.
    expect(await t.answer({ channel: "C9", channel_type: "channel", user: "U3", ts: ago(10 * MIN), thread_ts: inC9.ts, text: "private talk" })).toBeUndefined();
  });

  it("nothing once the inbox was cleared after the request started, nor for another account, with listening off, or to the owner", async () => {
    const t = await setup();
    const started = t.inbox.outreachTicket(OWNER);
    // Listening was turned off (and on again) while the request ran.
    await t.inbox.clear();
    expect(await t.inbox.recordOutreach(started, toSam, t.octx())).toBe(false);
    expect(await t.inbox.outreachPlace(started, t.octx(), undefined)).toEqual({ keep: false });
    const now = t.inbox.outreachTicket(OWNER);
    expect(await t.inbox.recordOutreach(now, toSam, t.octx(config({ listen: false })))).toBe(false);
    expect(await t.inbox.recordOutreach(now, toSam, t.octx(config({ userId: "UNEW" })))).toBe(false);
    expect(await t.inbox.recordOutreach(now, { ...toSam, recipient: OWNER }, t.octx())).toBe(false);
    expect((await t.all()).outreach).toEqual([]);
    expect(await t.inbox.recordOutreach(now, toSam, t.octx())).toBe(true);
  });

  it("a clear() while the outreach waits for its write drops it", async () => {
    const t = await setup();
    const kept = t.record(toSam);
    await t.inbox.clear();
    expect(await kept).toBe(false);
    expect((await t.all()).outreach).toEqual([]);
  });
});

describe("answers edited or deleted", () => {
  const changed = (ts: string, text: string, extra: Record<string, string> = {}): Partial<SlackMessageEvent> => ({
    subtype: "message_changed",
    ts: ago(1),
    message: { type: "message", user: "U2", ts, text, ...extra },
  });
  const deleted = (ts: string): Partial<SlackMessageEvent> => ({ subtype: "message_deleted", ts: ago(1), deleted_ts: ts });

  it("an edit changes the kept answer, a deletion removes it", async () => {
    const t = await setup();
    await t.record(toSam);
    const at = ago(10 * MIN);
    await t.answer({ ts: at, text: "Sure" });
    expect(await t.inbox.revise(t.event(changed(at, "Sure, on Friday <@U3>")), t.ctx(config()))).toEqual({ id: `D2:${at}`, deleted: false, text: "Sure, on Friday @Rita Oz" });
    expect((await t.all()).outreach[0]?.answers.map((a) => a.text)).toEqual(["Sure, on Friday @Rita Oz"]);
    // Only its author edits a message: anyone else's "edit" changes nothing.
    expect(await t.inbox.revise(t.event(changed(at, "hijacked", { user: "U3" })), t.ctx(config()))).toBeUndefined();
    expect(await t.inbox.revise(t.event(deleted(at)), t.ctx(config()))).toEqual({ id: `D2:${at}`, deleted: true });
    expect((await t.all()).outreach[0]?.answers).toEqual([]);
    // Nothing is done while listening is off.
    expect(await t.inbox.revise(t.event(deleted(at)), t.ctx(config({ listen: false })))).toBeUndefined();
  });

  it("an answer deleted or edited before it was kept is kept as it reads now, or not at all; a tombstone is a deletion", async () => {
    const t = await setup();
    await t.record(toSam);
    expect(await t.inbox.revise(t.event(deleted(ago(10 * MIN))), t.ctx(config()))).toEqual({ id: `D2:${ago(10 * MIN)}`, deleted: true });
    expect(await t.answer({ ts: ago(10 * MIN), text: "Oops, wrong person" })).toBeUndefined();
    await t.inbox.revise(t.event(changed(ago(9 * MIN), "Friday works")), t.ctx(config()));
    expect(await t.answer({ ts: ago(9 * MIN), text: "Firday wrks" })).toMatchObject({ item: { text: "Friday works" } });
    // A thread's first message deleted while it has replies: Slack leaves a tombstone.
    const tombstone = { subtype: "message_changed", ts: ago(1), message: { type: "message", subtype: "tombstone", ts: ago(9 * MIN), text: "This message was deleted." } };
    expect(await t.inbox.revise(t.event(tombstone), t.ctx(config()))).toEqual({ id: `D2:${ago(9 * MIN)}`, deleted: true });
    expect((await t.all()).outreach[0]?.answers).toEqual([]);
  });

  it("an edit that comes while the answer is being kept applies once it is written", async () => {
    const t = await setup();
    await t.record(toSam);
    // Naming the person it mentions waits on Slack: the edit arrives meanwhile.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const info = t.bot.users.info;
    t.bot.users.info = async (a: { user: string }) => (a.user === "U7HOLD" ? (await held, { user: { profile: { display_name: "Held" } } }) : info(a));
    const capturing = t.answer({ ts: ago(10 * MIN), text: "ask <@U7HOLD>" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await t.inbox.revise(t.event(changed(ago(10 * MIN), "never mind")), t.ctx(config()))).toBeUndefined();
    release();
    expect(await capturing).toMatchObject({ item: { text: "never mind" } });
    expect((await t.all()).outreach[0]?.answers.map((a) => a.text)).toEqual(["never mind"]);
  });
});

describe("telling the owner of answers", () => {
  afterEach(() => vi.useRealTimers());

  const item = (ts: string, text: string, user = "Sam Lee"): InboxItem => ({
    id: `D2:${ts}`,
    channel: "D2",
    channelName: user,
    where: "to_pointer",
    ts,
    userId: "U2",
    userName: user,
    mentioned: false,
    followed: false,
    text,
    outreachId: toSam.id,
  });

  function notifier(cfg: { current: Config }, opts: { postError?: string } = {}) {
    const posts: { channel: string; text: string; unfurl_links?: boolean; metadata?: unknown }[] = [];
    const links: string[] = [];
    const slack = (token: string) => {
      expect(token).toBe("xoxb-bot-token-secret");
      return {
        chat: {
          postMessage: async (m: { channel: string; text: string; unfurl_links?: boolean; metadata?: unknown }) => {
            if (opts.postError) throw Object.assign(new Error(`An API error occurred: ${opts.postError}`), { data: { error: opts.postError } });
            posts.push(m);
            return { ok: true };
          },
          getPermalink: async ({ channel, message_ts }: { channel: string; message_ts: string }) => {
            links.push(`${channel}:${message_ts}`);
            return { ok: true, permalink: `https://example.slack.com/archives/${channel}/p${message_ts.replace(".", "")}` };
          },
        },
      } as never;
    };
    const n = new AnswerNotifier({ configRepo: { load: async () => cfg.current }, slack, burstMs: 60_000 });
    return { n, posts, links };
  }

  it("sends one DM per outreach per burst, with every answer that came in", async () => {
    vi.useFakeTimers();
    const cfg = { current: config() };
    const t = notifier(cfg);
    t.n.add(cfg.current, toSam, item(ago(50), "Sure"));
    t.n.add(cfg.current, toSam, item(ago(40), "Friday works"));
    t.n.add(cfg.current, inOps, { ...item(ago(30), "I do", "Rita Oz"), id: `C1:${ago(30)}`, channel: "C1", threadTs: inOps.ts, outreachId: inOps.id });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(t.posts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.posts.map((p) => p.channel)).toEqual([OWNER, OWNER]);
    const dm = t.posts.find((p) => p.text.includes("Sam Lee"))!;
    expect(dm.text).toBe(
      [
        "*Sam Lee* answered the message I sent for you (Mon, Nov 23, 11:00):",
        "> Can you send the Q3 deck by Friday?",
        "• *Sam Lee*, Mon, Nov 23, 11:59: Sure",
        "• *Sam Lee*, Mon, Nov 23, 11:59: Friday works",
      ].join("\n"),
    );
    expect(dm.unfurl_links).toBe(false);
    // Marked as what other people wrote: a reply after it in the owner's DM starts as if it had read their inbox.
    expect(dm.metadata).toEqual({ event_type: "pointer_outside_content", event_payload: { source: "answer_notice", level: "inbox" } });
    // A channel's thread gets its link; Pointer's DM with someone does not (the owner cannot open it).
    const post = t.posts.find((p) => p.text.includes("#ops"))!;
    expect(post.text).toContain("*Rita Oz* replied to the post I made for you in #ops");
    expect(post.text).toContain(`<https://example.slack.com/archives/C1/p${inOps.ts.replace(".", "")}|Open the thread>`);
    expect(t.links).toEqual([`C1:${inOps.ts}`]);

    // The next answer starts a new burst.
    t.n.add(cfg.current, toSam, item(ago(10), "Sent"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.posts).toHaveLength(3);
  });

  it("tells nobody with the switch off, when it is turned off during the burst, or once the account changed", async () => {
    vi.useFakeTimers();
    const off = { current: config({ notifyAnswers: false }) };
    const a = notifier(off);
    a.n.add(off.current, toSam, item(ago(50), "Sure"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a.posts).toEqual([]);

    const cfg = { current: config() };
    const b = notifier(cfg);
    b.n.add(cfg.current, toSam, item(ago(50), "Sure"));
    cfg.current = config({ notifyAnswers: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(b.posts).toEqual([]);

    for (const changed of [config({ listen: false }), config({ userId: "UNEW" }), ConfigSchema.parse({ slack: { botToken: "xoxb-bot-token-secret" } })]) {
      const c = { current: config() };
      const t = notifier(c);
      t.n.add(c.current, toSam, item(ago(50), "Sure"));
      c.current = changed;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.posts).toEqual([]);
    }
  });

  it("sends what is collected on flush, and logs a failure without any text", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const cfg = { current: config() };
      const t = notifier(cfg);
      t.n.add(cfg.current, toSam, item(ago(50), "Sure"));
      await t.n.flush();
      expect(t.posts).toHaveLength(1);

      const failing = notifier(cfg, { postError: "channel_not_found" });
      failing.n.add(cfg.current, toSam, item(ago(50), "the secret plan"));
      await failing.n.flush();
      expect(error.mock.calls.map((c) => c.join(" "))).toEqual(["[slack] could not tell the owner of an answer: channel_not_found"]);
    } finally {
      error.mockRestore();
    }
  });

  it("quotes what people wrote as plain text: no links, mentions or broadcasts of its own", () => {
    const text = answerNotice(
      { ...toSam, text: "Ping <!channel> & <@U9>" },
      [item(ago(50), "see <https://evil.example|here> <!here>\nand *this*", "Sam <Lee>")],
      "UTC",
    );
    expect(text).not.toMatch(/<!|<@|<https/);
    expect(text).toContain("> Ping &lt;!channel&gt; &amp; &lt;@U9&gt;");
    expect(text).toContain("*Sam &lt;Lee&gt;*");
    expect(text).toContain("see &lt;https://evil.example|here&gt; &lt;!here&gt; and *this*");
  });

  it("lists the last 10 answers of a long burst and counts the rest", () => {
    const answers = Array.from({ length: 12 }, (_, i) => item(ago(100 - i), `a${i}`));
    const text = answerNotice(toSam, answers, "UTC");
    expect(text).toContain("_2 earlier answers are in your Slack inbox._");
    expect(text).not.toContain(": a1\n");
    expect(text).toContain(": a11");
  });

  it("quotes short: the rest is in the inbox", () => {
    const text = answerNotice({ ...toSam, text: "s".repeat(400) }, [item(ago(50), "a".repeat(400))], "UTC");
    expect(text.split("\n")[1]).toHaveLength(2 + 100);
    expect(text.split("\n")[2]!.split(": ")[1]).toHaveLength(160);
  });

  it("an answer edited or deleted before its notice goes is sent as it reads now, or left out", async () => {
    vi.useFakeTimers();
    const cfg = { current: config() };
    const t = notifier(cfg);
    t.n.add(cfg.current, toSam, item(ago(50), "Sure"));
    t.n.add(cfg.current, toSam, item(ago(40), "Firday"));
    t.n.revise({ id: `D2:${ago(40)}`, deleted: false, text: "Friday" });
    t.n.revise({ id: `D2:${ago(50)}`, deleted: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0]!.text).toContain(": Friday");
    expect(t.posts[0]!.text).not.toMatch(/Sure|Firday/);

    // Its only answer deleted: no notice at all; and an answer that arrives after its own deletion is not added.
    t.n.add(cfg.current, toSam, item(ago(30), "oops"));
    t.n.revise({ id: `D2:${ago(30)}`, deleted: true });
    t.n.revise({ id: `D2:${ago(20)}`, deleted: true });
    t.n.add(cfg.current, toSam, item(ago(20), "gone already"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.posts).toHaveLength(1);
  });

  it("drops the notices still waiting when the inbox is emptied", async () => {
    vi.useFakeTimers();
    const cfg = { current: config() };
    const t = notifier(cfg);
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-outreach-")));
    const inbox = new SlackInbox(store, deriveKey("k"), { batchMs: 0 });
    inbox.onClear(() => t.n.clear());
    t.n.add(cfg.current, toSam, item(ago(50), "Sure"));
    // Listening turned off and on again within the burst: the inbox was emptied, so is the notice.
    await inbox.clear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.posts).toEqual([]);
  });
});
