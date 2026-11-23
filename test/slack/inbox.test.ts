import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../../src/chat/pointer-types.js";
import { type Config, ConfigSchema } from "../../src/core/config.js";
import { decrypt, deriveKey, encrypt } from "../../src/core/crypto.js";
import { FsStore } from "../../src/core/store.js";
import { INBOX_LIMITS, SlackInbox, inboxSignal, isAnswered, tsAfter } from "../../src/slack/inbox.js";
import { makeRedactor } from "../../src/tasks/worker.js";

const OWNER = "UOWN";
const NOW = new Date("2026-11-23T12:00:00Z");
const BASE = Math.floor(NOW.getTime() / 1000);
/** A Slack ts `sec` seconds before now. */
const ago = (sec: number) => `${BASE - sec}.000100`;

type Info = Record<string, unknown> | string;

/** The owner's token sees these conversations (a string is Slack's error); the bot names people. */
function clients(conversations: Record<string, Info>) {
  const infoCalls: string[] = [];
  const user = {
    conversations: {
      info: async ({ channel }: { channel: string }) => {
        infoCalls.push(channel);
        const a = conversations[channel] ?? "channel_not_found";
        if (typeof a === "string") throw Object.assign(new Error(`An API error occurred: ${a}`), { data: { error: a } });
        return { ok: true, channel: { id: channel, ...a } };
      },
    },
    users: { info: async () => Promise.reject(new Error("names come from the bot")) },
  };
  const names: Record<string, string> = { U2: "Sam Lee", U3: "Rita Oz", [OWNER]: "Dana" };
  const bot = {
    conversations: { info: async () => Promise.reject(new Error("not used")) },
    users: { info: async ({ user: id }: { user: string }) => ({ user: { profile: { display_name: names[id] ?? id } } }) },
  };
  return { user, bot, infoCalls };
}

const CONVERSATIONS: Record<string, Info> = {
  D2: { is_im: true, user: "U2" },
  // The owner's DM with Pointer.
  DBOT: { is_im: true, user: "UBOT" },
  G5: { is_mpim: true, name: "mpdm-sam--rita--dana-1" },
  C1: { is_member: true, name: "ops" },
  C8: { is_member: false, name: "random" },
};

function config(patch: Partial<Config["slack"]["user"]> = {}): Config {
  return ConfigSchema.parse({
    slack: {
      botToken: "xoxb-bot-token-secret",
      signingSecret: "s".repeat(20),
      botUserId: "UBOT",
      user: { token: "xoxp-owner-token-secret", userId: OWNER, userName: "dana", connectedAt: "2026-11-01T00:00:00Z", ...patch },
    },
  });
}

/** A store that counts writes and can fail the next ones. */
class CountingStore extends FsStore {
  puts = 0;
  failNext = 0;
  override async put(key: string, value: string | Buffer): Promise<void> {
    this.puts++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("HTTP 429 rate limited");
    }
    return super.put(key, value);
  }
}

async function setup(patch: Partial<Config["slack"]["user"]> = {}, conversations = CONVERSATIONS, opts: { batchMs?: number; now?: () => Date } = {}) {
  const store = new CountingStore(await mkdtemp(join(tmpdir(), "army-inbox-")));
  const key = deriveKey("k");
  const inbox = new SlackInbox(store, key, { now: opts.now ?? (() => NOW), batchMs: opts.batchMs ?? 0 });
  const c = clients(conversations);
  const cfg = config(patch);
  const redact = makeRedactor(["xoxp-owner-token-secret", "sk-live-very-secret-value"]);
  const ctx = (config: Config) => ({ config, client: (token: string) => (token.startsWith("xoxp-") ? c.user : c.bot) as never, redact });
  const send = (e: Partial<SlackMessageEvent>, as = cfg) => inbox.capture({ type: "message", user: "U2", ...e } as SlackMessageEvent, ctx(as));
  const list = (openOnly = true, ownerId = OWNER) => inbox.list({ since: new Date(NOW.getTime() - 3 * 86_400_000), openOnly, ownerId }).then((r) => r.entries);
  return { store, key, inbox, send, list, ...c };
}

describe("inboxSignal", () => {
  it("sorts the owner's messages, other people's, and what the inbox ignores", () => {
    const e = (x: Partial<SlackMessageEvent>) => ({ type: "message", channel: "C1", channel_type: "channel", ts: "5.1", user: "U2", text: "hi", ...x }) as SlackMessageEvent;
    expect(inboxSignal(e({ user: OWNER }), OWNER, "UBOT")).toEqual({ kind: "owner", channel: "C1", ts: "5.1" });
    expect(inboxSignal(e({ user: OWNER, thread_ts: "4.1" }), OWNER, "UBOT")).toEqual({ kind: "owner", channel: "C1", ts: "5.1", threadTs: "4.1" });
    expect(inboxSignal(e({ text: `<@${OWNER}> look` }), OWNER, "UBOT")).toMatchObject({ kind: "message", where: "channel", mentioned: true });
    expect(inboxSignal(e({ channel_type: "im" }), OWNER, "UBOT")).toMatchObject({ kind: "message", where: "dm", mentioned: false });
    expect(inboxSignal(e({ channel_type: "mpim" }), OWNER, "UBOT")).toMatchObject({ kind: "message", where: "group_dm" });
    // Pointer, bots, edits, joins and app_mention duplicates.
    for (const x of [{ user: "UBOT" }, { bot_id: "B1" }, { subtype: "message_changed" }, { subtype: "channel_join" }, { type: "app_mention" }, { channel_type: undefined }]) {
      expect(inboxSignal(e(x), OWNER, "UBOT")).toEqual({ kind: "skip" });
    }
  });

  it("compares Slack timestamps without floats, and closes items answered after them", () => {
    expect(tsAfter("1700000000.000101", "1700000000.000100")).toBe(true);
    expect(tsAfter("1700000000.1", "1700000000.099999")).toBe(true);
    expect(tsAfter("1700000000.000100", "1700000000.000100")).toBe(false);
    expect(tsAfter("999999999.9", "1700000000.0")).toBe(false);
    const answered = { D2: "10.5", "C1:20.1": "20.9", C1: "30.0" };
    expect(isAnswered({ channel: "D2", ts: "10.4", where: "dm" }, answered)).toBe(true);
    expect(isAnswered({ channel: "D2", ts: "10.6", where: "dm" }, answered)).toBe(false);
    expect(isAnswered({ channel: "C1", ts: "20.5", threadTs: "20.1", where: "channel" }, answered)).toBe(true);
    expect(isAnswered({ channel: "C1", ts: "20.1", where: "channel" }, answered)).toBe(true);
    // The owner's later post elsewhere in a channel answers no mention there.
    expect(isAnswered({ channel: "C1", ts: "25.0", where: "channel" }, answered)).toBe(false);
    // A reply in a DM thread is answered only in that thread.
    expect(isAnswered({ channel: "D2", ts: "10.4", threadTs: "10.1", where: "dm" }, answered)).toBe(false);
  });
});

describe("SlackInbox", () => {
  it("keeps DMs, group DMs, mentions and replies in the owner's threads from other people", async () => {
    const t = await setup();
    await t.send({ channel: "D2", channel_type: "im", ts: ago(600), text: "can you review the plan?" });
    await t.send({ channel: "G5", channel_type: "mpim", ts: ago(500), user: "U3", text: "lunch at 1?" });
    await t.send({ channel: "C1", channel_type: "channel", ts: ago(400), text: `<@${OWNER}> the deploy is blocked on you` });
    // The owner starts a thread; a colleague replies in it.
    await t.send({ channel: "C1", channel_type: "channel", ts: ago(300), user: OWNER, text: "who owns the flaky test?" });
    await t.send({ channel: "C1", channel_type: "channel", ts: ago(200), thread_ts: ago(300), user: "U3", text: "I do, fixing it today" });

    const entries = await t.list();
    expect(entries.map((e) => [e.where, e.channelName, e.userName, e.text, e.waiting])).toEqual([
      ["dm", "Sam Lee", "Sam Lee", "can you review the plan?", true],
      ["group_dm", "group DM (sam, rita)", "Rita Oz", "lunch at 1?", false],
      ["channel", "#ops", "Sam Lee", "@Dana the deploy is blocked on you", true],
      ["channel", "#ops", "Rita Oz", "I do, fixing it today", true],
    ]);
    expect(entries[2]).toMatchObject({ mentioned: true, followed: false });
    expect(entries[3]).toMatchObject({ mentioned: false, followed: true, threadTs: ago(300) });
  });

  it("ignores channel chatter without looking anything up", async () => {
    const t = await setup();
    await t.send({ channel: "C1", channel_type: "channel", ts: ago(100), text: "lunch anyone?" });
    // A reply in a thread the owner is not in.
    await t.send({ channel: "C1", channel_type: "channel", ts: ago(90), thread_ts: ago(95), text: "+1" });
    expect(await t.list()).toEqual([]);
    expect(t.infoCalls).toEqual([]);
  });

  it("closes an item when the owner answers after it, in its thread or its conversation", async () => {
    const t = await setup();
    await t.send({ channel: "D2", channel_type: "im", ts: ago(600), text: "first question" });
    await t.send({ channel: "C1", channel_type: "channel", ts: ago(500), text: `<@${OWNER}> second question` });
    await t.send({ channel: "D2", channel_type: "im", ts: ago(400), user: OWNER, text: "answered" });
    // A reply in the mention's own thread answers it.
    await t.send({ channel: "C1", channel_type: "channel", ts: ago(300), thread_ts: ago(500), user: OWNER, text: "on it" });
    await t.send({ channel: "D2", channel_type: "im", ts: ago(200), text: "a new one" });
    expect((await t.list()).map((e) => e.text)).toEqual(["a new one"]);
    expect((await t.list(false)).map((e) => [e.text, e.answered])).toEqual([
      ["first question", true],
      ["@Dana second question", true],
      ["a new one", false],
    ]);
  });

  it("never keeps the owner's DM with Pointer, Pointer's own DMs, or conversations the owner is not in", async () => {
    const t = await setup();
    await t.send({ channel: "DBOT", channel_type: "im", ts: ago(100), user: "UBOT", text: "here is your report" });
    await t.send({ channel: "DBOT", channel_type: "im", ts: ago(99), user: "U2", text: `<@${OWNER}> hi` });
    // Pointer's DM with a colleague: the owner's token cannot see it.
    await t.send({ channel: "D7", channel_type: "im", ts: ago(98), text: `tell <@${OWNER}> I am late` });
    // A public channel the owner left.
    await t.send({ channel: "C8", channel_type: "channel", ts: ago(97), text: `<@${OWNER}> ping` });
    await t.send({ channel: "D2", channel_type: "im", ts: ago(96), bot_id: "B1", text: "a bot" });
    expect(await t.list(false)).toEqual([]);
  });

  it("keeps nothing while listening is off, and nothing it cannot place", async () => {
    const off = await setup({ listen: false });
    await off.send({ channel: "D2", channel_type: "im", ts: ago(100), text: "hello" });
    expect(await off.list()).toEqual([]);
    expect(off.infoCalls).toEqual([]);

    const flaky = await setup({}, { D2: "ratelimited" });
    await flaky.send({ channel: "D2", channel_type: "im", ts: ago(100), text: "hello" });
    expect(await flaky.list()).toEqual([]);
  });

  it("names mentions, unwraps links, lists files, redacts secrets and clips; stored encrypted", async () => {
    const t = await setup();
    await t.send({
      channel: "D2",
      channel_type: "im",
      ts: ago(100),
      subtype: "file_share",
      text: "<@U3> see <https://x.example/plan|the plan> &amp; use sk-live-very-secret-value <!here>",
      files: [{ id: "F1", name: "plan.pdf" }],
    });
    await t.send({ channel: "D2", channel_type: "im", ts: ago(90), text: "x".repeat(5000) });
    const [first, long] = await t.list();
    expect(first!.text).toBe("@Rita Oz see the plan (https://x.example/plan) & use [redacted] @here\n[files: plan.pdf]");
    expect(long!.text).toHaveLength(INBOX_LIMITS.text);
    const raw = (await t.store.get("slack/inbox.enc"))!.toString("latin1");
    expect(raw).not.toContain("the plan");
    expect(raw).not.toContain("Sam Lee");
  });

  it("keeps each message once", async () => {
    const t = await setup();
    await t.send({ channel: "D2", channel_type: "im", ts: ago(100), text: "hi" });
    await t.send({ channel: "D2", channel_type: "im", ts: ago(100), text: "hi" });
    expect(await t.list()).toHaveLength(1);
  });

  it("keeps 14 days and at most 3 000 items", async () => {
    const t = await setup();
    const item = (i: number, sec: number) => ({
      id: `D2:${ago(sec)}-${i}`,
      channel: "D2",
      channelName: "Sam Lee",
      where: "dm",
      ts: ago(sec),
      userId: "U2",
      userName: "Sam Lee",
      mentioned: false,
      followed: false,
      text: `m${i}`,
    });
    const seed = (items: object[]) =>
      t.store.put("slack/inbox.enc", encrypt(t.key, JSON.stringify({ version: 1, ownerId: OWNER, startedAt: NOW.toISOString(), items, answered: {} })));
    const all = async () => (await t.inbox.list({ since: new Date(0), openOnly: false, ownerId: OWNER })).entries.map((e) => e.text);

    // 15 days old: gone at the next write.
    await seed([item(0, 15 * 86_400), item(1, 13 * 86_400)]);
    await t.send({ channel: "D2", channel_type: "im", ts: ago(2), text: "new" });
    expect(await all()).toEqual(["m1", "new"]);

    // Beyond 3 000: the oldest go.
    await seed(Array.from({ length: 3_005 }, (_, i) => item(i + 1, 3_100 - i)));
    await t.send({ channel: "D2", channel_type: "im", ts: ago(1), text: "newest" });
    const kept = await all();
    expect(kept).toHaveLength(INBOX_LIMITS.items);
    expect([kept[0], kept.at(-1)]).toEqual(["m7", "newest"]);
  });

  it("starts empty for another account and after clear", async () => {
    const t = await setup();
    await t.send({ channel: "D2", channel_type: "im", ts: ago(100), text: "hi" });
    expect(await t.list()).toHaveLength(1);
    expect((await t.inbox.list({ since: new Date(0), openOnly: false, ownerId: "UOTHER" })).entries).toEqual([]);
    await t.inbox.clear();
    const after = await t.inbox.list({ since: new Date(0), openOnly: false, ownerId: OWNER });
    expect(after).toEqual({ entries: [], outreach: [] });
  });
});

describe("SlackInbox: writes, clears and retention", () => {
  const slackError = (code: string) => Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });
  const event = (e: Partial<SlackMessageEvent>) => ({ type: "message", user: "U2", channel: "D2", channel_type: "im", ...e }) as SlackMessageEvent;

  it("collects changes for about a second and writes them at once", async () => {
    const t = await setup({}, CONVERSATIONS, { batchMs: 50 });
    await Promise.all([
      t.send({ channel: "D2", channel_type: "im", ts: ago(50), text: "one" }),
      t.send({ channel: "D2", channel_type: "im", ts: ago(40), text: "two" }),
      t.send({ channel: "G5", channel_type: "mpim", ts: ago(30), user: "U3", text: "three" }),
      t.send({ channel: "D2", channel_type: "im", ts: ago(20), user: OWNER, text: "an answer" }),
    ]);
    expect(t.store.puts).toBe(1);
    expect((await t.list(false)).map((e) => [e.text, e.answered])).toEqual([
      ["one", true],
      ["two", true],
      ["three", false],
    ]);
    expect(t.store.puts).toBe(1);
  });

  it("writes nothing when nothing changed", async () => {
    const t = await setup();
    await t.send({ channel: "D2", channel_type: "im", ts: ago(100), text: "hi" });
    await t.send({ channel: "D2", channel_type: "im", ts: ago(90), user: OWNER, text: "hello" });
    expect(t.store.puts).toBe(2);
    // The same message again, and the owner's same answer again.
    await t.send({ channel: "D2", channel_type: "im", ts: ago(100), text: "hi" });
    await t.send({ channel: "D2", channel_type: "im", ts: ago(90), user: OWNER, text: "hello" });
    expect(t.store.puts).toBe(2);
  });

  it("keeps a reply in a thread the owner just wrote in, when both wait for the same write", async () => {
    const t = await setup({}, CONVERSATIONS, { batchMs: 50 });
    await Promise.all([
      t.send({ channel: "C1", channel_type: "channel", ts: ago(30), user: OWNER, text: "who owns the flaky test?" }),
      t.send({ channel: "C1", channel_type: "channel", ts: ago(20), thread_ts: ago(30), user: "U3", text: "I do" }),
    ]);
    expect(await t.list()).toMatchObject([{ text: "I do", followed: true }]);
    expect(t.store.puts).toBe(1);
  });

  it("tries a failed write once more, and logs neither the text nor a token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const t = await setup();
      t.store.failNext = 1;
      await t.send({ channel: "D2", channel_type: "im", ts: ago(100), text: "the secret plan" });
      expect((await t.list()).map((e) => e.text)).toEqual(["the secret plan"]);
      expect(t.store.puts).toBe(2);
      expect(warn.mock.calls.map((a) => a.join(" "))).toEqual(["[slack] inbox write failed, trying once more: HTTP 429 rate limited"]);

      // Failing twice: the change is lost, said once, and the capture still resolves.
      t.store.failNext = 2;
      await t.send({ channel: "D2", channel_type: "im", ts: ago(90), text: "another secret" });
      expect(error.mock.calls.map((a) => a.join(" "))).toEqual(["[slack] inbox write failed, 1 change not kept: HTTP 429 rate limited"]);
      expect((await t.list()).map((e) => e.text)).toEqual(["the secret plan"]);
      expect([...warn.mock.calls, ...error.mock.calls].flat().join("\n")).not.toMatch(/secret|xoxp/);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("drops expired messages when read, from the store too", async () => {
    const t = await setup();
    const item = (text: string, sec: number) => ({
      id: `D2:${ago(sec)}`,
      channel: "D2",
      channelName: "Sam Lee",
      where: "dm",
      ts: ago(sec),
      userId: "U2",
      userName: "Sam Lee",
      mentioned: false,
      followed: false,
      text,
    });
    const items = [item("old", 15 * 86_400), item("recent", 86_400)];
    await t.store.put("slack/inbox.enc", encrypt(t.key, JSON.stringify({ version: 1, ownerId: OWNER, startedAt: NOW.toISOString(), items, answered: {} })));
    const { entries } = await t.inbox.list({ since: new Date(0), openOnly: false, ownerId: OWNER });
    expect(entries.map((e) => e.text)).toEqual(["recent"]);
    const stored = JSON.parse(decrypt(t.key, (await t.store.get("slack/inbox.enc"))!)) as { items: { text: string }[] };
    expect(stored.items.map((i) => i.text)).toEqual(["recent"]);
  });

  it("drops a capture still waiting on Slack when the inbox is cleared", async () => {
    const t = await setup();
    let answer: (() => void) | undefined;
    const slow = {
      users: t.user.users,
      conversations: {
        info: async () => {
          await new Promise<void>((resolve) => (answer = resolve));
          return { ok: true, channel: { id: "D2", is_im: true, user: "U2" } };
        },
      },
    };
    const capture = t.inbox.capture(event({ ts: ago(100), text: "hi" }), {
      config: config(),
      client: (token) => (token.startsWith("xoxp-") ? slow : t.bot) as never,
      redact: (s) => s,
    });
    expect(answer).toBeDefined();
    await t.inbox.clear();
    answer!();
    await capture;
    expect(await t.list(false)).toEqual([]);
    expect((await t.store.get("slack/inbox.enc"))?.length).toBe(0);
  });

  it("keeps what it knows of conversations per owner, and forgets it on clear", async () => {
    const t = await setup();
    await t.send({ channel: "D2", channel_type: "im", ts: ago(100), text: "for dana" });
    expect(t.infoCalls).toEqual(["D2"]);

    // Sam's account replaces Dana's in the same process: his token cannot see her DM.
    const samCalls: string[] = [];
    const samClient = {
      users: t.user.users,
      conversations: {
        info: async ({ channel }: { channel: string }) => {
          samCalls.push(channel);
          throw slackError("channel_not_found");
        },
      },
    };
    const sam = config({ token: "xoxp-sam-token-secret", userId: "USAM", userName: "sam" });
    await t.inbox.capture(event({ ts: ago(90), text: "dana's colleague again" }), {
      config: sam,
      client: (token) => (token === "xoxp-sam-token-secret" ? samClient : t.bot) as never,
      redact: (s) => s,
    });
    expect(samCalls).toEqual(["D2"]);
    expect(await t.list(false, "USAM")).toEqual([]);

    // After a clear, Dana's conversations are looked up again.
    await t.inbox.clear();
    await t.send({ channel: "D2", channel_type: "im", ts: ago(80), text: "after the clear" });
    expect(t.infoCalls).toEqual(["D2", "D2"]);
  });

  it("looks again soon at a conversation the owner's token was refused, a DM included", async () => {
    let now = NOW;
    const conversations: Record<string, Info> = { ...CONVERSATIONS, D2: "missing_scope" };
    const t = await setup({}, conversations, { now: () => now });
    await t.send({ channel: "D2", channel_type: "im", ts: ago(100), text: "first" });
    expect(await t.list()).toEqual([]);
    // Reconnected with im:read a minute later.
    conversations.D2 = { is_im: true, user: "U2" };
    now = new Date(NOW.getTime() + 61_000);
    await t.send({ channel: "D2", channel_type: "im", ts: ago(50), text: "second" });
    expect((await t.list()).map((e) => e.text)).toEqual(["second"]);
  });
});
