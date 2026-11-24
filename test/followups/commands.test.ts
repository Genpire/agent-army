import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationService } from "../../src/chat/conversations.js";
import { MemoryRepo } from "../../src/chat/memory.js";
import type { PointerRequest, SlackMessageEvent } from "../../src/chat/pointer-types.js";
import { ConfigRepo } from "../../src/core/config.js";
import { deriveKey } from "../../src/core/crypto.js";
import { FsStore } from "../../src/core/store.js";
import { followupQuickReplies } from "../../src/followups/done-command.js";
import { FollowupStore } from "../../src/followups/store.js";
import { handleSlackEvent, resetDispatchStateForTests } from "../../src/slack/dispatch.js";
import { TaskRepo } from "../../src/tasks/tasks.js";
import { MemoryStore } from "../routines/helpers.js";

/**
 * "done 3 5" in the owner's own conversation with Pointer is closed by the
 * platform, without the model: in their DM with Pointer and in the console.
 */

const OWNER = "UOWN";
const KEY = deriveKey("k");
const LISTED = ["☀️ *Good morning: Tuesday, November 24*", "", "*Open follow-ups: 2*", "• *#1* Reply to Omar · Omar · Slack · 2d", "• *#2* Answer Rita · Rita · Slack · 1d"].join("\n");

interface Post {
  channel: string;
  text: string;
  metadata?: { event_type: string; event_payload: Record<string, string> };
}

async function slackEnv(opts: { account?: boolean } = {}) {
  resetDispatchStateForTests();
  const store = new FsStore(await mkdtemp(join(tmpdir(), "army-followups-dm-")));
  const configRepo = new ConfigRepo(store, KEY, 0);
  await configRepo.update((c) => {
    c.anthropic.apiKey = "sk-ant-secret-key";
    c.slack = { botToken: "xoxb-secret-token", signingSecret: "s".repeat(20), botUserId: "UBOT", allowedUserIds: [], pointerChannels: [] };
    if (opts.account !== false) c.slack.user = { token: "xoxp-owner-token-123456", userId: OWNER, userName: "dana", scopes: [], connectedAt: "2026-11-23T08:00:00Z", listen: true, sendAsMe: true };
  });
  const followups = new FollowupStore(new MemoryStore(), KEY, { batchMs: 0 });
  await followups.add({ title: "Reply to Omar", source: "slack", from: "Omar" });
  await followups.add({ title: "Answer Rita", source: "slack", from: "Rita" });
  const posts: Post[] = [];
  const reactions: string[] = [];
  const history = new Map<string, { ts: string; user?: string; bot_id?: string; text?: string; metadata?: unknown }[]>();
  const client = {
    chat: { postMessage: async (m: Post) => (posts.push(m), { ok: true, ts: `900.${posts.length}` }) },
    reactions: {
      add: async (a: { name: string }) => void reactions.push(`+${a.name}`),
      remove: async (a: { name: string }) => void reactions.push(`-${a.name}`),
    },
    conversations: {
      info: async () => ({ ok: true, channel: { is_member: true } }),
      replies: async () => ({ messages: [] }),
      history: async (a: { channel: string; latest?: string }) => ({ messages: a.latest === undefined ? [] : (history.get(a.channel) ?? []) }),
    },
    users: { info: async (a: { user: string }) => ({ user: { profile: { display_name: `Name ${a.user}` } } }) },
    auth: { test: async () => ({ ok: true, team_id: "T1" }) },
  };
  const requests: PointerRequest[] = [];
  const deps = {
    configRepo,
    tasks: new TaskRepo(store),
    memory: new MemoryRepo(store, KEY),
    runner: { kind: "local" as const, launch: async () => undefined },
    brain: {
      reply: async (req: PointerRequest) => {
        requests.push(req);
        return { text: `echo ${req.text}`, isError: false };
      },
    },
    slack: () => client as never,
    followups,
  };
  const send = (e: Partial<SlackMessageEvent>) => handleSlackEvent({ type: "message", channel: "D0OWN", channel_type: "im", user: OWNER, ...e } as SlackMessageEvent, deps);
  return { followups, posts, reactions, history, requests, send };
}

describe("the done command in the owner's DM with Pointer", () => {
  it("closes the items itself, with no model call, and says what it closed", async () => {
    const t = await slackEnv();
    await t.send({ ts: "100.1", text: "done 1" });
    expect(t.requests).toEqual([]);
    expect(t.posts).toEqual([
      { channel: "D0OWN", text: "✅ Closed #1 Reply to Omar.", metadata: { event_type: "pointer_outside_content", event_payload: { source: "followups", level: "inbox" } } },
    ]);
    expect(t.reactions).toEqual(["+eyes", "-eyes", "+white_check_mark"]);
    expect((await t.followups.list()).map((i) => i.n)).toEqual([2]);
    await t.send({ ts: "100.2", text: "تم 1 و 2 و 9" });
    expect(t.posts[1]!.text).toBe("✅ Closed #2 Answer Rita. #1 was already closed. There is no follow-up #9.");
    expect(t.requests).toEqual([]);
  });

  it("takes the owner's numbered list under Pointer's list of follow-ups, even right after a reminder (relayed outside content)", async () => {
    const t = await slackEnv();
    t.history.set("D0OWN", [{ ts: "99.1", user: "UBOT", bot_id: "B1", text: LISTED, metadata: { event_type: "pointer_outside_content", event_payload: { source: "followups", level: "inbox" } } }]);
    await t.send({ ts: "100.1", text: "1. Omar (DM) - done\n2. Rita (DM) - done" });
    expect(t.requests).toEqual([]);
    expect(t.posts[0]!.text).toBe("✅ Closed #1 Reply to Omar, #2 Answer Rita.");
    expect(await t.followups.list()).toEqual([]);
  });

  it("closes in reply to the brief (relayed at the inbox level), while anything else there reaches Pointer as relayed inbox content", async () => {
    const t = await slackEnv();
    t.history.set("D0OWN", [{ ts: "99.1", user: "UBOT", bot_id: "B1", text: LISTED, metadata: { event_type: "pointer_outside_content", event_payload: { source: "followups", level: "inbox" } } }]);
    await t.send({ ts: "100.1", text: "done 2" });
    expect(t.requests).toEqual([]);
    expect((await t.followups.list()).map((i) => i.n)).toEqual([1]);
    await t.send({ ts: "100.2", text: "3 not done" });
    expect(t.requests.map((r) => r.text)).toEqual(["3 not done"]);
    expect(t.requests[0]!.history.find((m) => m.ts === "99.1")).toMatchObject({ isPointer: true, outsideContent: "inbox" });
    expect((await t.followups.list()).map((i) => i.n)).toEqual([1]);
  });

  it("leaves anything else, and anyone else, to Pointer", async () => {
    const t = await slackEnv();
    await t.send({ ts: "100.1", text: "1. Omar (DM) - done\n2. Rita (DM) - done" });
    // No list of follow-ups above it: not a command.
    await t.send({ ts: "100.2", text: "is 1 done?" });
    // Someone else's DM with Pointer: their "done 1" is theirs, not the owner's.
    await t.send({ ts: "100.3", text: "done 1", user: "U0SOMEONE", channel: "D0SOMEONE" });
    expect(t.requests.map((r) => r.text)).toEqual(["1. Omar (DM) - done\n2. Rita (DM) - done", "is 1 done?", "done 1"]);
    expect((await t.followups.list()).map((i) => i.n)).toEqual([1, 2]);

    // Without the owner's account connected, their DM cannot be told apart: Pointer answers.
    const none = await slackEnv({ account: false });
    await none.send({ ts: "100.1", text: "done 1" });
    expect(none.requests).toHaveLength(1);
    expect((await none.followups.list()).map((i) => i.n)).toEqual([1, 2]);
  });
});

describe("the done command in the console", () => {
  it("closes the items itself, without Pointer, and the reply is kept as relayed", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-followups-web-")));
    const configRepo = new ConfigRepo(store, KEY, 0);
    await configRepo.update((c) => void (c.anthropic.apiKey = "sk-ant-secret-key"));
    const followups = new FollowupStore(new MemoryStore(), KEY, { batchMs: 0 });
    await followups.add({ title: "Reply to Omar", source: "slack" });
    await followups.add({ title: "Answer Rita", source: "slack" });
    const asked: string[] = [];
    const conversations = new ConversationService({
      store,
      configRepo,
      tasks: new TaskRepo(store),
      runner: { kind: "local", launch: async () => undefined },
      brain: { reply: async (req) => (asked.push(req.text), { text: "Pointer's answer", isError: false }) },
      quickReplies: followupQuickReplies(followups),
    });
    const created = await conversations.create("done 1");
    if (!created.ok) throw new Error(created.error);
    expect(created.conversation.pending).toBe(false);
    expect(created.conversation.messages.map((m) => [m.role, m.text, m.relayed])).toEqual([
      ["user", "done 1", undefined],
      ["pointer", "✅ Closed #1 Reply to Omar.", "inbox"],
    ]);
    const id = created.conversation.id;
    const next = await conversations.send(id, "what else is open?");
    if (!next.ok) throw new Error(next.error);
    await conversations.idle();
    expect(asked).toEqual(["what else is open?"]);
    const again = await conversations.send(id, "close 2");
    if (!again.ok) throw new Error(again.error);
    expect(again.conversation.messages.at(-1)).toMatchObject({ role: "pointer", text: "✅ Closed #2 Answer Rita." });
    expect(asked).toHaveLength(1);
    expect(await followups.list()).toEqual([]);
  });
});
