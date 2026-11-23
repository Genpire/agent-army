import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SlackMessageEvent } from "../../src/chat/pointer-types.js";
import { type Config, ConfigSchema } from "../../src/core/config.js";
import { deriveKey, encrypt } from "../../src/core/crypto.js";
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

async function setup(patch: Partial<Config["slack"]["user"]> = {}, conversations = CONVERSATIONS) {
  const store = new FsStore(await mkdtemp(join(tmpdir(), "army-inbox-")));
  const key = deriveKey("k");
  const inbox = new SlackInbox(store, key, () => NOW);
  const c = clients(conversations);
  const cfg = config(patch);
  const redact = makeRedactor(["xoxp-owner-token-secret", "sk-live-very-secret-value"]);
  const send = (e: Partial<SlackMessageEvent>) =>
    inbox.capture({ type: "message", user: "U2", ...e } as SlackMessageEvent, { config: cfg, client: (token) => (token.startsWith("xoxp-") ? c.user : c.bot) as never, redact });
  const list = (openOnly = true) => inbox.list({ since: new Date(NOW.getTime() - 3 * 86_400_000), openOnly, ownerId: OWNER }).then((r) => r.entries);
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
    expect(after).toEqual({ entries: [] });
  });
});
