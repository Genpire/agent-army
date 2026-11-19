import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentRepo } from "../src/attachments.js";
import { type Config, ConfigRepo } from "../src/config.js";
import { deriveKey } from "../src/crypto.js";
import { handleSlackEvent, resetDispatchStateForTests } from "../src/dispatch.js";
import { MemoryRepo } from "../src/memory.js";
import type {
  PointerContext,
  PointerReply,
  PointerRequest,
  SlackDeps,
  SlackMessageEvent,
  StartRepoTaskResult,
} from "../src/pointer-types.js";
import { FsStore } from "../src/store.js";
import { TaskRepo } from "../src/tasks.js";

interface Post {
  channel: string;
  thread_ts?: string;
  text: string;
}
interface SlackMsg {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  files?: unknown[];
}

/** Records everything Pointer does in Slack; threads and DMs are seeded per test. */
function fakeSlack() {
  const posts: Post[] = [];
  const reactions: string[] = [];
  const calls: string[] = [];
  const replies = new Map<string, SlackMsg[]>();
  const history = new Map<string, SlackMsg[]>();
  const fileInfo = new Map<string, object>();
  const client = {
    files: {
      info: async (a: { file: string }) => {
        calls.push(`files.info:${a.file}`);
        const file = fileInfo.get(a.file);
        if (!file) throw Object.assign(new Error("An API error occurred: file_not_found"), { data: { error: "file_not_found" } });
        return { ok: true, file };
      },
    },
    chat: {
      postMessage: async (m: Post) => {
        posts.push(m);
        return { ok: true, ts: `900.${posts.length}` };
      },
    },
    reactions: {
      add: async (a: { name: string; timestamp: string }) => void reactions.push(`+${a.name}@${a.timestamp}`),
      remove: async (a: { name: string; timestamp: string }) => void reactions.push(`-${a.name}@${a.timestamp}`),
    },
    conversations: {
      replies: async (a: { channel: string; ts: string }) => {
        calls.push(`replies:${a.channel}:${a.ts}`);
        return { messages: replies.get(`${a.channel}:${a.ts}`) ?? [] };
      },
      history: async (a: { channel: string }) => {
        calls.push(`history:${a.channel}`);
        return { messages: history.get(a.channel) ?? [] };
      },
    },
    users: { info: async (a: { user: string }) => ({ user: { profile: { display_name: `Name ${a.user}` } } }) },
  };
  return { client, posts, reactions, calls, replies, history, fileInfo };
}

type BrainFn = (req: PointerRequest, ctx: PointerContext) => Promise<PointerReply>;

async function setup(configure?: (c: Config) => void, opts: { attachments?: boolean } = {}) {
  resetDispatchStateForTests();
  const store = new FsStore(await mkdtemp(join(tmpdir(), "army-dispatch-")));
  const key = deriveKey("k");
  const configRepo = new ConfigRepo(store, key, 0);
  await configRepo.update((c) => {
    c.anthropic.apiKey = "sk-ant-secret-key";
    c.slack = {
      botToken: "xoxb-secret-token",
      signingSecret: "s".repeat(20),
      botUserId: "UBOT",
      allowedUserIds: [],
      pointerChannels: ["CPTR"],
    };
    c.github = { token: "ghp_secret_token", allowedOwners: ["acme"] };
    c.bindings["C1"] = "acme/web";
    configure?.(c);
  });
  const slack = fakeSlack();
  const tasks = new TaskRepo(store);
  const attachments = opts.attachments ? new AttachmentRepo(store, key) : undefined;
  const launched: string[] = [];
  const requests: PointerRequest[] = [];
  const contexts: PointerContext[] = [];
  const state: { brain: BrainFn; launchError?: Error } = {
    brain: async (req) => ({ text: `**echo** ${req.text}`, isError: false }),
  };
  const deps: SlackDeps = {
    configRepo,
    tasks,
    memory: new MemoryRepo(store, key),
    runner: {
      kind: "local",
      launch: async (id) => {
        if (state.launchError) throw state.launchError;
        launched.push(id);
      },
    },
    brain: {
      reply: async (req, ctx) => {
        requests.push(req);
        contexts.push(ctx);
        return state.brain(req, ctx);
      },
    },
    slack: () => slack.client as never,
    ...(attachments ? { attachments } : {}),
  };
  const send = (e: Partial<SlackMessageEvent>) =>
    handleSlackEvent({ type: "message", user: "U1", ...e } as SlackMessageEvent, deps);
  const dm = (ts: string, text: string, extra: Partial<SlackMessageEvent> = {}) =>
    send({ channel: "D1", channel_type: "im", ts, text, ...extra });
  const mention = (channel: string, ts: string, text: string, extra: Partial<SlackMessageEvent> = {}) =>
    send({ type: "app_mention", channel, ts, text: `<@UBOT> ${text}`, ...extra });
  /** The brain calls start_repo_task once and reports what it got back. */
  const brainStartsTask = (input: { repo?: string; instruction: string }) => {
    const results: StartRepoTaskResult[] = [];
    state.brain = async (_req, ctx) => {
      results.push(await ctx.startRepoTask(input));
      return { text: "The team is on it.", isError: false };
    };
    return results;
  };
  return { ...slack, configRepo, tasks, attachments, launched, requests, contexts, state, deps, send, dm, mention, brainStartsTask };
}

describe("handleSlackEvent: where Pointer answers", () => {
  it("answers a DM flat, with the recent DM history as context", async () => {
    const t = await setup();
    t.history.set("D1", [
      { ts: "99.2", user: "UBOT", bot_id: "B1", text: "Hi!" },
      { ts: "99.1", user: "U1", text: "hello" },
    ]);
    await t.dm("100.1", "what can you do?");
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]).toMatchObject({
      text: "what can you do?",
      userId: "U1",
      userName: "Name U1",
      channel: "D1",
      channelType: "im",
      threadTs: "100.1",
      thread: null,
    });
    expect(t.requests[0]!.history.map((m) => [m.name, m.text, m.isPointer])).toEqual([
      ["Name U1", "hello", false],
      ["Pointer", "Hi!", true],
    ]);
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0]).toMatchObject({ channel: "D1", text: "*echo* what can you do?" });
    expect(t.posts[0]!.thread_ts).toBeUndefined();
    expect(t.reactions).toEqual(["+eyes@100.1", "-eyes@100.1", "+white_check_mark@100.1"]);
  });

  it("ignores a plain top-level channel message", async () => {
    const t = await setup();
    await t.send({ channel: "C1", channel_type: "channel", ts: "100.1", text: "lunch anyone?" });
    expect(t.requests).toHaveLength(0);
    expect(t.posts).toHaveLength(0);
    expect(t.reactions).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });

  it("answers a mention in a thread on the message", async () => {
    const t = await setup();
    await t.mention("C1", "100.1", "what changed <https://github.com/acme/web|here>?");
    expect(t.requests[0]).toMatchObject({
      text: "what changed https://github.com/acme/web?",
      channel: "C1",
      channelType: "unknown",
      threadTs: "100.1",
      channelRepo: "acme/web",
      history: [],
    });
    expect(t.posts).toEqual([{ channel: "C1", thread_ts: "100.1", text: "*echo* what changed https://github.com/acme/web?" }]);
  });

  it("answers every message in a Pointer channel, without a mention", async () => {
    const t = await setup();
    await t.send({ channel: "CPTR", channel_type: "channel", ts: "100.1", text: "summarise the week" });
    expect(t.requests[0]).toMatchObject({ channelType: "channel", threadTs: "100.1" });
    expect(t.posts[0]).toMatchObject({ channel: "CPTR", thread_ts: "100.1" });
  });

  it("answers a thread reply only when Pointer is in the thread, reusing the fetch as context", async () => {
    const t = await setup();
    t.replies.set("C1:50.1", [{ ts: "50.1", user: "U2", text: "deploy is red" }]);
    await t.send({ channel: "C1", channel_type: "channel", ts: "50.3", thread_ts: "50.1", text: "any idea?" });
    expect(t.requests).toHaveLength(0);
    expect(t.posts).toHaveLength(0);
    expect(t.reactions).toHaveLength(0);

    t.replies.set("C1:60.1", [
      { ts: "60.1", user: "U2", text: "deploy is red" },
      { ts: "60.2", user: "UBOT", bot_id: "B1", text: "Looking." },
      { ts: "60.3", user: "U1", text: "any idea?" },
    ]);
    await t.send({ channel: "C1", channel_type: "channel", ts: "60.3", thread_ts: "60.1", text: "any idea?" });
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]!.history.map((m) => m.text)).toEqual(["deploy is red", "Looking."]);
    expect(t.requests[0]!.threadTs).toBe("60.1");
    expect(t.posts[0]).toMatchObject({ channel: "C1", thread_ts: "60.1" });
    expect(t.calls).toEqual(["replies:C1:50.1", "replies:C1:60.1"]);
  });

  it("keeps following a thread it answered in", async () => {
    const t = await setup();
    await t.mention("C1", "70.1", "hi");
    // Slack has not caught up yet: the thread looks empty, but Pointer remembers posting there.
    await t.send({ channel: "C1", channel_type: "channel", ts: "70.2", thread_ts: "70.1", text: "and then?" });
    expect(t.requests).toHaveLength(2);
    expect(t.posts.at(-1)).toMatchObject({ thread_ts: "70.1", text: "*echo* and then?" });
  });

  it("handles the app_mention and message events of one message once", async () => {
    const t = await setup();
    const text = "<@UBOT> hi";
    await Promise.all([
      t.send({ type: "app_mention", channel: "C1", ts: "100.1", text }),
      t.send({ channel: "C1", channel_type: "channel", ts: "100.1", text }),
    ]);
    expect(t.requests).toHaveLength(1);
    expect(t.posts).toHaveLength(1);
  });

  it("ignores bots, itself and edits", async () => {
    const t = await setup();
    await t.dm("1.1", "x", { bot_id: "B1" });
    await t.dm("1.2", "x", { user: "UBOT" });
    await t.dm("1.3", "x", { subtype: "message_changed" });
    expect(t.requests).toHaveLength(0);
    expect(t.posts).toHaveLength(0);
    expect(t.reactions).toHaveLength(0);
  });

  it("ignores empty unmentioned messages and shows help for a bare mention", async () => {
    const t = await setup();
    await t.dm("1.1", "", { subtype: "file_share" });
    expect(t.posts).toHaveLength(0);
    expect(t.reactions).toHaveLength(0);
    await t.send({ type: "app_mention", channel: "C1", ts: "1.2", text: "<@UBOT>" });
    expect(t.requests).toHaveLength(0);
    expect(t.posts[0]!.text).toContain("listen here");
    expect(t.posts[0]!.thread_ts).toBe("1.2");
  });

  it("processes messages of one conversation in order", async () => {
    const t = await setup();
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    t.state.brain = async (req) => {
      log.push(`start ${req.text}`);
      if (req.text === "first") await gate;
      log.push(`end ${req.text}`);
      return { text: "ok", isError: false };
    };
    const first = t.dm("1.1", "first");
    const second = t.dm("1.2", "second");
    try {
      for (let i = 0; i < 400 && !log.length; i++) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => setTimeout(r, 30)); // room for "second" to (wrongly) start
      expect(log).toEqual(["start first"]);
    } finally {
      release();
    }
    await Promise.all([first, second]);
    expect(log).toEqual(["start first", "end first", "start second", "end second"]);
  });

  it("keeps arrival order even when the first message's config load is slower", async () => {
    const t = await setup();
    const order: string[] = [];
    t.state.brain = async (req) => (order.push(req.text), { text: "ok", isError: false });
    const real = t.configRepo;
    let loads = 0;
    const slowFirst = {
      load: async () => {
        if (loads++ === 0) await new Promise((r) => setTimeout(r, 30));
        return real.load();
      },
      update: real.update.bind(real),
    };
    const deps = { ...t.deps, configRepo: slowFirst as never };
    const event = (ts: string, text: string): SlackMessageEvent => ({ type: "message", channel: "D1", channel_type: "im", user: "U1", ts, text });
    await Promise.all([handleSlackEvent(event("1.1", "first"), deps), handleSlackEvent(event("1.2", "second"), deps)]);
    expect(order).toEqual(["first", "second"]);
  });
});

describe("handleSlackEvent: commands", () => {
  it("listen here and stop listening toggle a Pointer channel", async () => {
    const t = await setup();
    await t.mention("C3", "1.1", "listen here");
    expect((await t.configRepo.load(true)).slack.pointerChannels).toEqual(["CPTR", "C3"]);
    expect(t.posts.at(-1)).toMatchObject({ channel: "C3", thread_ts: "1.1" });

    // Now a Pointer channel: no mention needed.
    await t.send({ channel: "C3", channel_type: "channel", ts: "1.2", text: "stop listening" });
    expect((await t.configRepo.load(true)).slack.pointerChannels).toEqual(["CPTR"]);

    await t.dm("1.3", "listen here");
    expect(t.posts.at(-1)!.text).toMatch(/channels/);
    expect((await t.configRepo.load(true)).slack.pointerChannels).toEqual(["CPTR"]);
    expect(t.requests).toHaveLength(0);
  });

  it("binds and unbinds a channel's project within the allowed owners", async () => {
    const t = await setup();
    await t.mention("C9", "1.1", "bind acme/api");
    expect((await t.configRepo.load(true)).bindings["C9"]).toBe("acme/api");
    await t.mention("C9", "1.2", "bind stranger/api");
    expect((await t.configRepo.load(true)).bindings["C9"]).toBe("acme/api");
    expect(t.posts.at(-1)!.text).toContain("allowed owner");
    await t.mention("C9", "1.3", "unbind");
    expect((await t.configRepo.load(true)).bindings["C9"]).toBeUndefined();
    expect(t.requests).toHaveLength(0);
  });

  it("reports status", async () => {
    const t = await setup();
    await t.mention("C1", "1.1", "status");
    const text = t.posts[0]!.text;
    expect(text).toContain("acme/web");
    expect(text).toContain("*Listening here:* no");
    expect(text).toContain("local");
  });
});

describe("handleSlackEvent: access and errors", () => {
  it("is silent to non-allowed users unless they mention Pointer, then replies once", async () => {
    const t = await setup((c) => void (c.slack.allowedUserIds = ["U999"]));
    await t.dm("1.1", "hi");
    expect(t.posts).toHaveLength(0);
    expect(t.reactions).toHaveLength(0);

    const text = "<@UBOT> hi";
    await Promise.all([
      t.send({ type: "app_mention", channel: "C1", ts: "2.1", text }),
      t.send({ channel: "C1", channel_type: "channel", ts: "2.1", text }),
    ]);
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0]).toMatchObject({ channel: "C1", thread_ts: "2.1" });
    expect(t.posts[0]!.text).toMatch(/not on the list/);
    expect(t.requests).toHaveLength(0);
    expect(t.reactions).toHaveLength(0);

    await t.dm("3.1", "hi", { user: "U999" });
    expect(t.requests).toHaveLength(1);
  });

  it("asks for setup when Claude is not connected", async () => {
    const t = await setup((c) => void (c.anthropic.apiKey = undefined));
    await t.dm("1.1", "hi");
    expect(t.requests).toHaveLength(0);
    expect(t.posts[0]!.text).toMatch(/admin page/);
  });

  it("reacts with an x and posts the reason when the brain fails", async () => {
    const t = await setup();
    t.state.brain = async () => ({ text: "Claude is not connected.", isError: true });
    await t.dm("1.1", "hi");
    expect(t.posts[0]!.text).toBe(":x: Claude is not connected.");
    expect(t.reactions).toEqual(["+eyes@1.1", "-eyes@1.1", "+x@1.1"]);
  });

  it("never throws, and redacts secrets from unexpected errors", async () => {
    const t = await setup();
    t.state.brain = async () => {
      throw new Error("boom with xoxb-secret-token and ghp_secret_token");
    };
    await expect(t.dm("1.1", "hi")).resolves.toBeUndefined();
    const text = t.posts[0]!.text;
    expect(text).toMatch(/^:x: Something went wrong: boom/);
    expect(text).not.toContain("xoxb-secret-token");
    expect(text).not.toContain("ghp_secret_token");
    expect(t.reactions.at(-1)).toBe("+x@1.1");

    const broken = { ...t.deps, configRepo: { load: async () => Promise.reject(new Error("disk")) } as never };
    await expect(handleSlackEvent({ type: "message", channel_type: "im", channel: "D1", user: "U1", ts: "2.1", text: "hi" }, broken)).resolves.toBeUndefined();
  });
});

describe("handleSlackEvent: start_repo_task", () => {
  it("prefers the thread's repo over the channel's and continues its branch", async () => {
    const t = await setup();
    await t.tasks.saveThread("C1", "200.1", { repo: "acme/api", branch: "army/x-abc123" });
    t.replies.set("C1:200.1", [{ ts: "200.2", user: "UBOT", text: "PR opened" }]);
    const results = t.brainStartsTask({ instruction: "handle the empty case" });
    await t.send({ channel: "C1", channel_type: "channel", ts: "200.5", thread_ts: "200.1", text: "also handle the empty case" });

    expect(t.requests[0]!.thread).toEqual({ repo: "acme/api", branch: "army/x-abc123" });
    expect(results).toEqual([{ ok: true, taskId: t.launched[0], repo: "acme/api" }]);
    const ack = t.posts[0]!;
    expect(ack).toMatchObject({ channel: "C1", thread_ts: "200.1" });
    expect(ack.text).toContain("army/x-abc123");
    expect(await t.tasks.get(t.launched[0]!)).toMatchObject({
      repo: "acme/api",
      channel: "C1",
      threadTs: "200.1",
      progressTs: "900.1",
      userId: "U1",
      instruction: "handle the empty case",
      status: "queued",
      trigger: "slack",
    });
    expect(t.posts[1]).toMatchObject({ thread_ts: "200.1", text: "The team is on it." });
  });

  it("gives Pointer the live status of this thread's task, not another thread's", async () => {
    const t = await setup();
    t.brainStartsTask({ instruction: "add a healthcheck" });
    await t.mention("C1", "1.1", "add a healthcheck");
    t.brainStartsTask({ instruction: "add metrics" });
    await t.mention("C1", "2.1", "add metrics");
    const [first] = t.launched;
    const task = (await t.tasks.get(first!))!;
    task.status = "running";
    task.progress = {
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      now: ":hammer_and_wrench: Coder — Add the endpoint",
      plan: [{ content: "Add the endpoint", status: "in_progress" }],
      agents: [],
      recent: [],
      files: ["src/health.ts"],
      filesCount: 1,
    };
    await t.tasks.save(task);

    let status = "";
    t.state.brain = async (_req, ctx) => {
      status = (await ctx.taskStatus?.()) ?? "";
      return { text: "ok", isError: false };
    };
    await t.mention("C1", "1.5", "how is it going?", { thread_ts: "1.1" });
    expect(status).toContain(`Task ${first} on acme/web: running`);
    expect(status).toContain("[>] Add the endpoint");
    expect(status).toContain("Files changed so far (1): src/health.ts");
    expect(status).not.toContain("add metrics");
  });

  it("uses the channel's repo, or an explicit one", async () => {
    const t = await setup();
    const results = t.brainStartsTask({ instruction: "add a healthcheck" });
    await t.mention("C1", "1.1", "add a healthcheck");
    expect(results[0]).toMatchObject({ ok: true, repo: "acme/web" });
    expect(t.posts[0]!.text).toContain("On it");

    const explicit = t.brainStartsTask({ repo: "https://github.com/acme/shop", instruction: "migrate billing" });
    await t.mention("C1", "1.2", "migrate billing in acme/shop");
    expect(explicit[0]).toMatchObject({ ok: true, repo: "acme/shop" });
    expect(t.launched).toHaveLength(2);
  });

  it("starts a task from a DM in a thread on the message, while chatting flat", async () => {
    const t = await setup();
    t.brainStartsTask({ repo: "acme/web", instruction: "fix login" });
    await t.dm("300.1", "fix login on acme/web");
    const task = await t.tasks.get(t.launched[0]!);
    expect(task).toMatchObject({ channel: "D1", threadTs: "300.1", repo: "acme/web" });
    expect(t.posts[0]).toMatchObject({ channel: "D1", thread_ts: "300.1" });
    expect(t.posts[1]!.thread_ts).toBeUndefined();
  });

  it("refuses without a repo, outside the allowed owners, or without GitHub", async () => {
    const t = await setup();
    const none = t.brainStartsTask({ instruction: "fix it" });
    await t.mention("C9", "1.1", "fix it");
    expect(none[0]).toEqual({ ok: false, error: "No repository: ask the user which owner/repo to use." });

    const stranger = t.brainStartsTask({ repo: "stranger/repo", instruction: "do things" });
    await t.mention("C1", "1.2", "do things");
    expect(stranger[0]).toMatchObject({ ok: false, error: expect.stringContaining("allowed") });
    expect(t.launched).toHaveLength(0);
    expect(await t.tasks.recent()).toHaveLength(0);

    const u = await setup((c) => void (c.github = { allowedOwners: [] }));
    const noGithub = u.brainStartsTask({ instruction: "fix it" });
    await u.mention("C1", "1.3", "fix it");
    expect(noGithub[0]).toMatchObject({ ok: false, error: expect.stringContaining("GitHub is not connected") });
  });

  it("marks the task failed when the worker cannot start", async () => {
    const t = await setup();
    t.state.launchError = new Error("quota exceeded");
    const results = t.brainStartsTask({ instruction: "add a healthcheck" });
    await t.mention("C1", "1.1", "add a healthcheck");
    expect(results[0]).toMatchObject({ ok: false, error: expect.stringContaining("quota exceeded") });
    const [task] = await t.tasks.recent();
    expect(task).toMatchObject({ status: "failed", error: expect.stringContaining("quota exceeded") });
  });

  it("saves nothing when the progress message cannot be posted, and redacts the reason", async () => {
    const t = await setup();
    const realPost = t.client.chat.postMessage;
    let failed = false;
    t.client.chat.postMessage = async (m) => {
      if (!failed) {
        failed = true;
        throw new Error("channel_not_found for xoxb-secret-token");
      }
      return realPost(m);
    };
    const results = t.brainStartsTask({ instruction: "add a healthcheck" });
    await t.mention("C1", "1.1", "add a healthcheck");
    expect(results[0]).toEqual({ ok: false, error: "Could not start the task: channel_not_found for [redacted]" });
    expect(await t.tasks.recent()).toHaveLength(0);
    expect(t.launched).toHaveLength(0);
  });
});

describe("handleSlackEvent: several GitHub connections", () => {
  const EXTRA_TOKEN = "ghp_extra_secret_token_0000000000";
  const extra = [{ id: "gh-abc123", token: EXTRA_TOKEN, login: "shosh", allowed: ["Partner-Co/Acme"] }];
  const withExtra = (c: Config) => void (c.github.extra = extra);

  it("starts a task on a repository only an extra connection covers, and refuses one no connection covers", async () => {
    const t = await setup(withExtra);
    const covered = t.brainStartsTask({ repo: "Partner-Co/Acme", instruction: "fix the build" });
    await t.mention("C1", "1.1", "fix the build in Partner-Co/Acme");
    expect(covered[0]).toMatchObject({ ok: true, repo: "Partner-Co/Acme" });
    expect(t.launched).toHaveLength(1);

    const outside = t.brainStartsTask({ repo: "Partner-Co/other", instruction: "fix the build" });
    await t.mention("C1", "1.2", "fix the build in Partner-Co/other");
    expect(outside[0]).toEqual({
      ok: false,
      error: "Not allowed to work on Partner-Co/other. Allowed owners and repositories: acme, Partner-Co/Acme.",
    });
    expect(t.launched).toHaveLength(1);
  });

  it("works with only an extra connection, without a primary token", async () => {
    const t = await setup((c) => void (c.github = { allowedOwners: [], extra }));
    const covered = t.brainStartsTask({ repo: "Partner-Co/Acme", instruction: "fix the build" });
    await t.mention("C1", "1.1", "fix the build in Partner-Co/Acme");
    expect(covered[0]).toMatchObject({ ok: true, repo: "Partner-Co/Acme" });

    // The channel's acme/web is covered by no connection: not allowed (GitHub itself is connected).
    const channelRepo = t.brainStartsTask({ instruction: "fix the build" });
    await t.mention("C1", "1.2", "fix the build");
    expect(channelRepo[0]).toEqual({
      ok: false,
      error: "Not allowed to work on acme/web. Allowed owners and repositories: Partner-Co/Acme.",
    });
  });

  it("binds a channel to a repository any connection covers", async () => {
    const t = await setup(withExtra);
    await t.mention("C9", "1.1", "bind Partner-Co/Acme");
    expect((await t.configRepo.load(true)).bindings["C9"]).toBe("Partner-Co/Acme");
    await t.mention("C9", "1.2", "bind Partner-Co/other");
    expect((await t.configRepo.load(true)).bindings["C9"]).toBe("Partner-Co/Acme");
    expect(t.posts.at(-1)!.text).toContain("allowed owner");

    const none = await setup((c) => void (c.github = { allowedOwners: [] }));
    await none.mention("C9", "2.1", "bind acme/api");
    expect((await none.configRepo.load(true)).bindings["C9"]).toBeUndefined();
    expect(none.posts.at(-1)!.text).toContain("GitHub is not connected");
  });

  it("redacts every GitHub token from errors", async () => {
    const t = await setup(withExtra);
    t.state.brain = async () => {
      throw new Error(`boom with ghp_secret_token and ${EXTRA_TOKEN}`);
    };
    await t.dm("1.1", "hi");
    const text = t.posts[0]!.text;
    expect(text).toMatch(/^:x: Something went wrong: boom/);
    expect(text).not.toContain("ghp_secret_token");
    expect(text).not.toContain(EXTRA_TOKEN);
  });
});

describe("handleSlackEvent: files shared in Slack", () => {
  const TOKEN = "xoxb-secret-token";
  const dl = (id: string, name: string) => `https://files.slack.com/files-pri/T1-${id}/download/${encodeURIComponent(name)}`;
  const file = (id: string, name: string, mimetype: string) => ({ id, name, mimetype, url_private_download: dl(id, name) });

  /** Serves files.slack.com downloads by file id and records each request (no real network). */
  function stubDownloads(bodies: Record<string, { body: string | Uint8Array; type: string }>) {
    const calls: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      const hit = bodies[url.match(/T1-(F\w+)\//)?.[1] ?? ""];
      if (!hit) return new Response("not found", { status: 404 });
      return new Response(hit.body, { status: 200, headers: { "content-type": hit.type } });
    });
    return calls;
  }
  afterEach(() => void vi.unstubAllGlobals());

  it("stores new files once per thread and hands them to Pointer", async () => {
    const t = await setup(undefined, { attachments: true });
    const calls = stubDownloads({ F1: { body: "<h1>Chat</h1>", type: "text/html" } });
    const design = file("F1", "Chat Section.html", "text/html");
    await t.mention("C1", "100.1", "build this page", { files: [design] });
    expect(calls).toEqual([{ url: dl("F1", "Chat Section.html"), auth: `Bearer ${TOKEN}` }]);
    const thread = { channel: "C1", threadTs: "100.1" };
    const stored = await t.attachments!.list(thread);
    expect(stored).toMatchObject([{ name: "Chat Section.html", mime: "text/html", source: "slack", sourceId: "F1" }]);
    expect((await t.attachments!.get(thread, stored[0]!.id))!.toString("utf8")).toBe("<h1>Chat</h1>");
    expect(t.requests[0]).toMatchObject({ text: "build this page", attachments: stored });
    expect(t.contexts[0]!.addAttachment).toBeTypeOf("function");

    // A reply in the thread: the file is in the history now, and already stored.
    t.replies.set("C1:100.1", [
      { ts: "100.1", user: "U1", text: "<@UBOT> build this page", files: [design] },
      { ts: "100.2", user: "UBOT", bot_id: "B1", text: "Done." },
    ]);
    await t.send({ channel: "C1", channel_type: "channel", ts: "100.3", thread_ts: "100.1", text: "make it blue" });
    expect(calls).toHaveLength(1);
    expect(await t.attachments!.list(thread)).toHaveLength(1);
    expect(t.requests[1]!.attachments).toEqual(stored);
    expect(t.requests[1]!.history[0]!.files).toEqual([design]);
  });

  it("lets Pointer attach files to the conversation", async () => {
    const t = await setup(undefined, { attachments: true });
    t.state.brain = async (_req, ctx) => {
      const added = await ctx.addAttachment!({
        name: "brief.pdf",
        mime: "application/pdf",
        bytes: new Uint8Array([37, 80, 68, 70]),
        source: "monday",
        sourceId: "A9",
      });
      return { text: added.ok ? `saved ${added.info.name}` : added.error, isError: !added.ok };
    };
    await t.dm("300.1", "attach the brief from the ticket");
    expect(t.requests[0]!.attachments).toEqual([]);
    expect(t.posts[0]!.text).toBe("saved brief.pdf");
    expect(await t.attachments!.list({ channel: "D1", threadTs: "300.1" })).toMatchObject([{ name: "brief.pdf", source: "monday" }]);
  });

  it("copies recent files from the DM history under the new message", async () => {
    const t = await setup(undefined, { attachments: true });
    const calls = stubDownloads({ F2: { body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), type: "image/png" } });
    t.history.set("D1", [
      { ts: "99.2", user: "UBOT", bot_id: "B1", text: "Nice screenshot." },
      { ts: "99.1", user: "U1", text: "", files: [file("F2", "image.png", "image/png")] },
    ]);
    await t.dm("100.1", "what's wrong with this layout?");
    expect(calls).toHaveLength(1);
    expect(t.requests[0]!.attachments).toMatchObject([{ name: "image.png", sourceId: "F2" }]);
    expect(t.requests[0]!.history[0]).toMatchObject({ text: "", files: [{ id: "F2", name: "image.png" }] });
    expect(await t.attachments!.list({ channel: "D1", threadTs: "100.1" })).toHaveLength(1);
  });

  it("answers anyway and tells Pointer which files it could not read", async () => {
    const t = await setup(undefined, { attachments: true });
    stubDownloads({
      // Without files:read, Slack serves its sign-in page instead of the file.
      F3: { body: "<!DOCTYPE html><html>Sign in to Slack</html>", type: "text/html; charset=utf-8" },
      F4: { body: "ok", type: "text/plain" },
    });
    await t.dm("1.1", "here you go", {
      subtype: "file_share",
      files: [file("F3", "design.zip", "application/zip"), file("F4", "notes.txt", "text/plain"), { id: "F5", file_access: "check_file_info" }],
    });
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]!.text).toBe(
      "here you go\n\n[Pointer could not read these attachments: design.zip (missing files:read permission — reinstall the Slack app); F5 (Slack would not describe the file — file_not_found)]",
    );
    expect(t.requests[0]!.attachments).toMatchObject([{ name: "notes.txt" }]);
    expect(t.posts).toHaveLength(1);
    expect(t.reactions.at(-1)).toBe("+white_check_mark@1.1");
    expect(JSON.stringify(t.requests)).not.toContain(TOKEN);
  });

  it("answers a bare file share where it answers without a mention, never an empty message", async () => {
    const t = await setup(undefined, { attachments: true });
    stubDownloads({ F6: { body: "<p>m</p>", type: "text/html" } });
    await t.dm("1.1", "", { subtype: "file_share", files: [file("F6", "Mobile.html", "text/html")] });
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]).toMatchObject({ text: "(shared a file without a message: Mobile.html)", attachments: [{ name: "Mobile.html" }] });

    await t.dm("1.2", "", { subtype: "file_share" });
    await t.send({ channel: "C1", channel_type: "channel", ts: "1.3", subtype: "file_share", text: "", files: [file("F7", "x.png", "image/png")] });
    expect(t.requests).toHaveLength(1);

    // A bare mention with files goes to Pointer, not help.
    await t.mention("C1", "1.4", "", { files: [file("F6", "Mobile.html", "text/html")] });
    expect(t.requests).toHaveLength(2);
    expect(t.posts.at(-1)!.text).not.toContain("listen here");
  });

  it("reads at most 10 new files per message, and none for commands", async () => {
    const t = await setup(undefined, { attachments: true });
    const many = Array.from({ length: 12 }, (_, i) => file(`F${i + 10}`, `f${i}.txt`, "text/plain"));
    const calls = stubDownloads(Object.fromEntries(many.map((f, i) => [f.id, { body: `file ${i}`, type: "text/plain" }])));
    await t.dm("1.1", "read all of these", { files: many });
    expect(calls).toHaveLength(10);
    expect(t.requests[0]!.attachments).toHaveLength(10);
    expect(t.requests[0]!.text).toMatch(/could not read these attachments: f10\.txt, f11\.txt \(.*10 new files per message/);

    await t.mention("C1", "2.1", "status", { files: [file("F30", "s.txt", "text/plain")] });
    expect(calls).toHaveLength(10);
    expect(t.requests).toHaveLength(1);
  });

  it("works as before without an attachment store", async () => {
    const t = await setup();
    const calls = stubDownloads({ F1: { body: "x", type: "text/plain" } });
    await t.dm("1.1", "hi", { files: [file("F1", "a.txt", "text/plain")] });
    expect(calls).toEqual([]);
    expect(t.requests[0]!.text).toBe("hi");
    expect(t.requests[0]!.attachments).toBeUndefined();
    expect(t.contexts[0]!.addAttachment).toBeUndefined();
    await t.dm("1.2", "", { subtype: "file_share", files: [file("F1", "a.txt", "text/plain")] });
    expect(t.requests).toHaveLength(1);
    expect(t.posts).toHaveLength(1);
  });
});
