import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigRepo } from "../src/core/config.js";
import {
  ACTIVITY_MAX,
  type ChatMessage,
  type Conversation,
  ConversationService,
  type LiveReply,
  applyActivity,
  conversationTitle,
  insertByTime,
  pendingMilestones,
  taskResultMarkdown,
  toHistory,
} from "../src/conversations.js";
import { deriveKey } from "../src/core/crypto.js";
import { ActivityMapper, toolLabel } from "../src/pointer-activity.js";
import type { PointerBrain, PointerContext, PointerReply, PointerRequest } from "../src/pointer-types.js";
import { FsStore } from "../src/core/store.js";
import { TimelineRecorder } from "../src/task-events.js";
import { type Task, TaskRepo, WEB_CHANNEL } from "../src/tasks.js";
import { defaultTeam } from "../src/team/team.js";
import { UsageRepo } from "../src/spending/usage.js";
import { handleGithubWebhook, resetWebhookStateForTests } from "../src/webhook.js";

const API_KEY = "sk-ant-secret-key-0123456789";
const GH_TOKEN = "ghp_secret_token_0123456789";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Script = (req: PointerRequest, ctx: PointerContext) => Promise<PointerReply>;

async function setup(opts: { apiKey?: boolean; github?: boolean } = {}) {
  const store = new FsStore(await mkdtemp(join(tmpdir(), "army-conv-")));
  const configRepo = new ConfigRepo(store, deriveKey("k"), 0);
  await configRepo.update((c) => {
    if (opts.apiKey !== false) c.anthropic.apiKey = API_KEY;
    if (opts.github !== false) c.github = { ...c.github, token: GH_TOKEN, allowedOwners: ["acme"] };
  });
  const tasks = new TaskRepo(store);
  const usage = new UsageRepo(store, tasks);
  const launched: string[] = [];
  const runner = {
    kind: "local" as const,
    launch: async (id: string) => {
      launched.push(id);
    },
  };
  const calls: { req: PointerRequest; ctx: PointerContext }[] = [];
  let script: Script = async () => ({ text: "Hello from Pointer.", costUsd: 0.012, isError: false });
  const brain: PointerBrain = {
    reply: async (req, ctx) => {
      calls.push({ req, ctx });
      return script(req, ctx);
    },
  };
  const service = new ConversationService({ store, configRepo, tasks, runner, brain, usage });
  return {
    store,
    configRepo,
    tasks,
    usage,
    launched,
    calls,
    service,
    setScript: (s: Script) => {
      script = s;
    },
  };
}

const created = async (service: ConversationService, text: string): Promise<Conversation> => {
  const r = await service.create(text);
  if (!r.ok) throw new Error(r.error);
  return r.conversation;
};

const lastPointer = (c: Conversation) => [...c.messages].reverse().find((m) => m.role === "pointer");

describe("ConversationService", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates a conversation, answers in the background and records the cost", async () => {
    const t = await setup();
    const c = await created(t.service, "What changed on acme/web this week?\nDetails please");
    expect(c).toMatchObject({ title: "What changed on acme/web this week?", pending: true, taskIds: [] });
    expect(c.id).toMatch(/^c-[0-9a-z]{9}-[0-9a-f]{6}$/);
    expect(c.messages).toEqual([expect.objectContaining({ role: "user", text: "What changed on acme/web this week?\nDetails please" })]);

    await t.service.idle();
    const view = await t.service.view(c.id);
    expect(view?.conversation.pending).toBe(false);
    expect(view?.live).toBeUndefined();
    expect(lastPointer(view!.conversation)).toMatchObject({ role: "pointer", text: "Hello from Pointer.", costUsd: 0.012 });
    expect(lastPointer(view!.conversation)?.isError).toBeUndefined();
    expect((await t.usage.month()).chat).toEqual({ usd: 0.012, count: 1 });

    const { req } = t.calls[0]!;
    expect(req).toMatchObject({
      text: "What changed on acme/web this week?\nDetails please",
      userId: "admin",
      userName: "Admin (console)",
      channel: WEB_CHANNEL,
      threadTs: c.id,
      surface: "web",
      history: [],
      thread: null,
    });
  });

  it("refuses a second message while Pointer answers (409), then sends it with the history", async () => {
    const t = await setup();
    const gate = deferred<PointerReply>();
    t.setScript(() => gate.promise);
    const c = await created(t.service, "first question");
    // Let the answer start.
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    expect(await t.service.send(c.id, "second")).toEqual({ ok: false, status: 409, error: expect.stringContaining("still answering") });
    expect((await t.service.view(c.id))?.live).toMatchObject({ text: "", activity: [], tasks: [] });

    gate.resolve({ text: "first answer", isError: false });
    await t.service.idle();
    t.setScript(async () => ({ text: "second answer", isError: false }));
    const sent = await t.service.send(c.id, "  second  ");
    expect(sent.ok).toBe(true);
    await t.service.idle();
    expect(t.calls[1]!.req.text).toBe("second");
    expect(t.calls[1]!.req.history.map((m) => [m.name, m.text, m.isPointer])).toEqual([
      ["Admin (console)", "first question", false],
      ["Pointer", "first answer", true],
    ]);
    const view = await t.service.view(c.id);
    expect(view!.conversation.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "first question"],
      ["pointer", "first answer"],
      ["user", "second"],
      ["pointer", "second answer"],
    ]);
  });

  it("checks messages and conversation ids", async () => {
    const t = await setup();
    expect(await t.service.create("   ")).toMatchObject({ ok: false, status: 400 });
    expect(await t.service.create("x".repeat(8001))).toMatchObject({ ok: false, status: 400 });
    expect(await t.service.send("c-000000000-000000", "hi")).toMatchObject({ ok: false, status: 404 });
    expect(await t.service.send("../etc", "hi")).toMatchObject({ ok: false, status: 404 });
    expect(await t.service.view("not-an-id")).toBeNull();
  });

  it("lists conversations newest first and deletes them for good", async () => {
    let clock = Date.parse("2026-11-19T10:00:00Z");
    const t = await setup();
    const service = new ConversationService({ ...t, runner: { kind: "local", launch: async () => undefined }, brain: { reply: async () => ({ text: "ok", isError: false }) }, now: () => new Date((clock += 1000)) });
    const a = await created(service, "alpha");
    // Newest activity first: let alpha's reply land before beta starts, so beta is the newest.
    await service.idle();
    const b = await created(service, "beta");
    await service.idle();
    expect((await service.list()).map((s) => s.title)).toEqual(["beta", "alpha"]);
    expect((await service.list())[0]).toMatchObject({ id: b.id, pending: false, messageCount: 2, taskCount: 0 });

    expect(await service.remove(a.id)).toBe(true);
    expect(await service.remove(a.id)).toBe(false);
    expect(await service.view(a.id)).toBeNull();
    expect((await service.list()).map((s) => s.id)).toEqual([b.id]);
    // The file keeps no text.
    expect((await t.store.get(`conversations/${a.id}.json`))!.toString()).not.toContain("alpha");
  });

  it("drops the reply of a conversation deleted while Pointer answered", async () => {
    const t = await setup();
    const gate = deferred<PointerReply>();
    t.setScript(() => gate.promise);
    const c = await created(t.service, "question");
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    expect(await t.service.remove(c.id)).toBe(true);
    gate.resolve({ text: "late", isError: false });
    await t.service.idle();
    expect(await t.service.view(c.id)).toBeNull();
  });

  it("stores a clear error reply without calling Claude when it is not connected", async () => {
    const t = await setup({ apiKey: false });
    const c = await created(t.service, "hello?");
    await t.service.idle();
    const reply = lastPointer((await t.service.view(c.id))!.conversation);
    expect(reply).toMatchObject({ isError: true, text: expect.stringContaining("Claude is not connected") });
    expect(t.calls).toHaveLength(0);
  });

  it("turns a failing brain into a redacted error reply and never logs the message", async () => {
    const t = await setup();
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    t.setScript(async () => {
      throw new Error(`boom ${API_KEY}`);
    });
    const c = await created(t.service, "my private question");
    await t.service.idle();
    const reply = lastPointer((await t.service.view(c.id))!.conversation)!;
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain("[redacted]");
    expect(reply.text).not.toContain(API_KEY);
    expect(logged.join("\n")).not.toContain("my private question");
    expect(logged.join("\n")).not.toContain(API_KEY);
  });

  it("keeps the live reply (streamed text and steps) and saves the steps with the answer", async () => {
    const t = await setup();
    const gate = deferred<void>();
    t.setScript(async (_req, ctx) => {
      ctx.onActivity?.({ type: "step", id: "tu1", label: "Searching the web for “acme”", kind: "web" });
      ctx.onActivity?.({ type: "text", delta: "Looking" });
      ctx.onActivity?.({ type: "turn" });
      ctx.onActivity?.({ type: "text", delta: "The answer " });
      ctx.onActivity?.({ type: "text", delta: `is ${API_KEY}` });
      await gate.promise;
      ctx.onActivity?.({ type: "step-done", id: "tu1", isError: false });
      ctx.onActivity?.({ type: "step", id: "tu2", label: "Asking Rita (Researcher)…", kind: "agent" });
      return { text: "The answer is 42.", isError: false };
    });
    const c = await created(t.service, "question");
    await vi.waitFor(async () => expect((await t.service.view(c.id))?.live?.text).toContain("The answer"));
    const live = (await t.service.view(c.id))!.live!;
    expect(live.text).toBe("The answer is [redacted]");
    expect(live.activity).toEqual([expect.objectContaining({ id: "tu1", label: "Searching the web for “acme”", kind: "web" })]);
    expect(live.activity[0]!.endedAt).toBeUndefined();

    gate.resolve();
    await t.service.idle();
    const reply = lastPointer((await t.service.view(c.id))!.conversation)!;
    expect(reply.activity?.map((s) => [s.id, s.kind, Boolean(s.endedAt)])).toEqual([
      ["tu1", "web", true],
      ["tu2", "agent", true],
    ]);
  });

  it("recovers a conversation left pending by a restart", async () => {
    const t = await setup();
    const gate = deferred<PointerReply>();
    t.setScript(() => gate.promise);
    const c = await created(t.service, "question");
    await vi.waitFor(() => expect(t.calls).toHaveLength(1));
    // A new process: nothing is answering there.
    const restarted = new ConversationService({ ...t, runner: { kind: "local", launch: async () => undefined }, brain: { reply: async () => ({ text: "again", isError: false }) } });
    const view = await restarted.view(c.id);
    expect(view!.conversation.pending).toBe(false);
    expect(lastPointer(view!.conversation)).toMatchObject({ isError: true, text: expect.stringContaining("interrupted") });
    expect((await restarted.send(c.id, "retry")).ok).toBe(true);
    gate.resolve({ text: "old", isError: false });
    await t.service.idle();
    await restarted.idle();
  });

  it("starts repo tasks from Pointer's reply without Slack, under the reply", async () => {
    const t = await setup();
    let started: unknown;
    t.setScript(async (_req, ctx) => {
      started = await ctx.startRepoTask({ repo: "acme/web", instruction: "Add a dark mode toggle" });
      return { text: "The team is on it.", isError: false };
    });
    const c = await created(t.service, "add dark mode to acme/web");
    await t.service.idle();
    expect(started).toMatchObject({ ok: true, repo: "acme/web" });
    const taskId = (started as { taskId: string }).taskId;
    expect(t.launched).toEqual([taskId]);
    const task = await t.tasks.get(taskId);
    expect(task).toMatchObject({ channel: "web", threadTs: c.id, userId: "admin", trigger: "web", status: "queued", instruction: "Add a dark mode toggle" });
    expect(task!.progressTs).toBeUndefined();

    const view = (await t.service.view(c.id))!;
    expect(view.conversation.taskIds).toEqual([taskId]);
    expect(lastPointer(view.conversation)).toMatchObject({ text: "The team is on it.", tasks: [taskId] });
    expect(view.tasks.map((x) => x.id)).toEqual([taskId]);
  });

  it("refuses repo tasks Slack would refuse", async () => {
    const t = await setup({ github: false });
    const results: unknown[] = [];
    t.setScript(async (_req, ctx) => {
      results.push(await ctx.startRepoTask({ repo: "acme/web", instruction: "x" }));
      return { text: "ok", isError: false };
    });
    await created(t.service, "do it");
    await t.service.idle();
    expect(results[0]).toEqual({ ok: false, error: expect.stringContaining("GitHub is not connected") });

    await t.configRepo.update((c) => {
      c.github = { ...c.github, token: GH_TOKEN, allowedOwners: ["acme"] };
    });
    t.setScript(async (_req, ctx) => {
      results.push(await ctx.startRepoTask({ repo: "other/repo", instruction: "x" }));
      results.push(await ctx.startRepoTask({ instruction: "x" }));
      return { text: "ok", isError: false };
    });
    await created(t.service, "do it elsewhere");
    await t.service.idle();
    expect(results[1]).toEqual({ ok: false, error: expect.stringContaining("Not allowed to work on other/repo") });
    expect(results[2]).toEqual({ ok: false, error: expect.stringContaining("No repository") });
    expect(t.launched).toEqual([]);
  });

  it("follows up on the same branch: thread state is keyed by web and the conversation", async () => {
    const t = await setup();
    const c = await created(t.service, "start");
    await t.service.idle();
    await t.tasks.saveThread(WEB_CHANNEL, c.id, { repo: "acme/web", branch: "army/dark-mode-abc123", prNumber: 3, prUrl: "https://github.com/acme/web/pull/3" });
    let started: unknown;
    t.setScript(async (req, ctx) => {
      expect(req.thread).toMatchObject({ repo: "acme/web", branch: "army/dark-mode-abc123" });
      started = await ctx.startRepoTask({ instruction: "also add a test" });
      return { text: "Continuing.", isError: false };
    });
    expect((await t.service.send(c.id, "also add a test")).ok).toBe(true);
    await t.service.idle();
    expect(started).toMatchObject({ ok: true, repo: "acme/web" });
  });

  it("starts a direct task in a new conversation", async () => {
    const t = await setup();
    const r = await t.service.startDirectTask("acme/web", "Fix the login redirect");
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    const view = (await t.service.view(r.conversationId))!;
    expect(view.conversation).toMatchObject({ title: "Fix the login redirect", pending: false, taskIds: [r.taskId] });
    expect(view.conversation.messages.map((m) => [m.role, m.text, m.tasks])).toEqual([
      ["user", "Fix the login redirect", undefined],
      ["pointer", "On it. Putting the team on `acme/web`…", [r.taskId]],
    ]);
    expect(await t.tasks.get(r.taskId)).toMatchObject({ channel: "web", threadTs: r.conversationId, trigger: "web", userId: "admin" });
    expect(t.calls).toHaveLength(0);

    expect(await t.service.startDirectTask("other/repo", "x")).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("Not allowed") });
  });

  it("keeps the conversation and says why when the worker cannot start", async () => {
    const t = await setup();
    const service = new ConversationService({
      ...t,
      runner: {
        kind: "local",
        launch: async () => {
          throw new Error(`no capacity ${GH_TOKEN}`);
        },
      },
      brain: { reply: async () => ({ text: "", isError: false }) },
    });
    const r = await service.startDirectTask("acme/web", "Fix it");
    expect(r).toMatchObject({ ok: false, status: 502, conversationId: expect.any(String) });
    if (r.ok || !r.conversationId) return;
    const c = (await service.view(r.conversationId))!.conversation;
    expect(lastPointer(c)).toMatchObject({ isError: true, text: expect.stringContaining("Could not start a worker") });
    expect(lastPointer(c)!.text).not.toContain(GH_TOKEN);
  });

  it("adds task milestones once: the pull request, a fix round, then the result", async () => {
    const t = await setup();
    const r = await t.service.startDirectTask("acme/web", "Add dark mode");
    if (!r.ok) throw new Error("not started");
    const task = (await t.tasks.get(r.taskId))!;
    task.status = "running";
    task.report = { title: "Dark mode", summary: "Adds a toggle.", verification: "Clicked it.", risks: "" };
    task.prUrl = "https://github.com/acme/web/pull/12";
    await t.tasks.save(task);
    let c = (await t.service.view(r.conversationId))!.conversation;
    expect(c.messages.filter((m) => m.result).map((m) => [m.result!.milestone, m.text])).toEqual([
      ["pr", "Opened [pull request #12](https://github.com/acme/web/pull/12): **Dark mode**. Waiting for its checks…"],
    ]);

    task.fixRound = { round: 1, rounds: 2, failing: ["lint"], at: new Date().toISOString() };
    await t.tasks.save(task);
    c = (await t.service.view(r.conversationId))!.conversation;
    expect(c.messages.filter((m) => m.result?.milestone === "checks").map((m) => m.text)).toEqual([
      "The pull request's checks failed: lint. The team is fixing them (round 1 of 2)…",
    ]);

    task.status = "done";
    task.kind = "change";
    task.ci = { state: "passed", fixRounds: 1, names: [], total: 3 };
    task.costUsd = 1.5;
    task.branch = "army/dark-mode-abc123";
    await t.tasks.save(task);
    c = (await t.service.view(r.conversationId))!.conversation;
    c = (await t.service.view(r.conversationId))!.conversation;
    const end = c.messages.filter((m) => m.result?.milestone === "end");
    expect(end).toHaveLength(1);
    expect(end[0]!.text).toContain("**Done: Dark mode** — [review the pull request](https://github.com/acme/web/pull/12)");
    expect(end[0]!.text).toContain("**Checks:** all 3 passed after 1 fix round");
    expect(end[0]!.text).toContain("_acme/web · `army/dark-mode-abc123` · ~$1.50_");
    expect(c.messages.filter((m) => m.result)).toHaveLength(3);
  });

  it("answers status questions from the saved progress and the timeline", async () => {
    const t = await setup();
    const r = await t.service.startDirectTask("acme/web", "Add dark mode");
    if (!r.ok) throw new Error("not started");
    const task = (await t.tasks.get(r.taskId))!;
    task.status = "running";
    task.stage = { phase: "checks", text: "Waiting for the pull request's checks", at: new Date().toISOString() };
    await t.tasks.save(task);
    const rec = new TimelineRecorder(t.store, r.taskId);
    rec.enter("build", "Building");
    rec.add({ kind: "edit", agent: "Sara (Coder)", text: "src/theme.ts" });
    await rec.flush(true);

    let status = "";
    t.setScript(async (_req, ctx) => {
      status = (await ctx.taskStatus?.()) ?? "";
      return { text: "It is going well.", isError: false };
    });
    expect((await t.service.send(r.conversationId, "how is it going?")).ok).toBe(true);
    await t.service.idle();
    expect(status).toContain(`Task ${r.taskId} on acme/web: running`);
    expect(status).toContain("Stage: Waiting for the pull request's checks");
    expect(status).toContain(`Timeline of task ${r.taskId}:`);
    expect(status).toContain("Sara (Coder): edit — src/theme.ts");
  });
});

describe("conversation helpers", () => {
  it("titles a conversation by its first line", () => {
    expect(conversationTitle("\n\n  Fix   the login \n more")).toBe("Fix the login");
    expect(conversationTitle("   ")).toBe("New conversation");
    expect(conversationTitle("x".repeat(200))).toHaveLength(80);
  });

  it("applies live activity with caps", () => {
    const live: LiveReply = { messageId: "m", startedAt: "t", text: "", activity: [], tasks: [] };
    applyActivity(live, { type: "text", delta: "a" }, "t1");
    applyActivity(live, { type: "turn" }, "t1");
    applyActivity(live, { type: "text", delta: "b" }, "t1");
    expect(live.text).toBe("b");
    applyActivity(live, { type: "step", id: "s1", label: ":mag: Reading\nthe docs", kind: "web", agent: "Rita" }, "t2");
    applyActivity(live, { type: "step", id: "s1", label: "dup", kind: "web" }, "t2");
    applyActivity(live, { type: "step-done", id: "s1", isError: true }, "t3");
    applyActivity(live, { type: "step-done", id: "nope", isError: false }, "t3");
    expect(live.activity).toEqual([{ id: "s1", label: "Reading the docs", kind: "web", agent: "Rita", startedAt: "t2", endedAt: "t3", isError: true }]);
    for (let i = 0; i < ACTIVITY_MAX + 10; i++) applyActivity(live, { type: "step", id: `x${i}`, label: "x", kind: "other" }, "t");
    expect(live.activity).toHaveLength(ACTIVITY_MAX);
    applyActivity(live, { type: "text", delta: "z".repeat(30_000) }, "t");
    expect(live.text.length).toBe(20_000);
  });

  it("inserts messages by time and maps the history", () => {
    const m = (id: string, at: string, role: ChatMessage["role"] = "user"): ChatMessage => ({ id, role, text: id, at });
    const out = insertByTime([m("a", "1"), m("b", "3")], [m("c", "2"), m("d", "9"), m("e", "3")]);
    expect(out.map((x) => x.id)).toEqual(["a", "c", "b", "e", "d"]);
    expect(toHistory([m("hi", "1"), m("yo", "2", "pointer")], "Scout")).toEqual([
      { ts: "1", userId: "admin", name: "Admin (console)", text: "hi", isPointer: false },
      { ts: "2", name: "Scout", text: "yo", isPointer: true },
    ]);
  });

  const base: Task = {
    id: "abc-123456",
    createdAt: "2026-11-19T10:00:00.000Z",
    updatedAt: "2026-11-19T10:30:00.000Z",
    status: "done",
    repo: "acme/web",
    channel: "web",
    threadTs: "c-1",
    userId: "admin",
    instruction: "Make it faster",
  };

  it("writes the result like Slack does, in Markdown", () => {
    expect(taskResultMarkdown({ ...base, kind: "answer", report: { title: "It is slow because…", summary: "N+1 queries.", verification: "", risks: "" } })).toBe(
      "**It is slow because…**\n\nN+1 queries.\n\n_acme/web_",
    );
    expect(
      taskResultMarkdown({
        ...base,
        kind: "blocked",
        report: { title: "Needs a secret", summary: "Add STRIPE_KEY.", verification: "", risks: "Payments" },
        notes: ["**Checks blocked: x** y"],
      }),
    ).toBe("**Blocked: Needs a secret**\n\nAdd STRIPE_KEY.\n\n**Risks:** Payments\n\n**Checks blocked: x** y\n\n_acme/web_");
    expect(
      taskResultMarkdown({ ...base, status: "failed", error: "Timed out after 50 minutes.", prUrl: "https://github.com/acme/web/pull/4", prDraft: true, costUsd: 2 }),
    ).toBe(
      '**Stopped:** Timed out after 50 minutes. The unfinished work is saved in a draft pull request: [#4](https://github.com/acme/web/pull/4). Reply here (for example "continue") to pick it up on the same branch.\n\n_acme/web · ~$2.00_',
    );
    expect(taskResultMarkdown({ ...base, status: "failed", error: "clone failed" })).toBe("**The task failed:** clone failed\n\n_acme/web_");
    expect(taskResultMarkdown({ ...base, kind: "change", prUrl: "https://github.com/acme/web/pull/5", ci: { state: "failed", fixRounds: 2, names: ["lint", "e2e"], total: 4 } })).toContain(
      "**Checks:** 2 failing after 2 fix rounds: lint, e2e",
    );
  });

  it("gives an ended task only its result, and tasks of other conversations nothing", () => {
    const c: Conversation = { id: "c-1", title: "t", createdAt: "1", updatedAt: "1", pending: false, messages: [], taskIds: [base.id] };
    const ended = pendingMilestones(c, [{ ...base, prUrl: "https://github.com/acme/web/pull/5", fixRound: { round: 1, rounds: 2, failing: [], at: "x" } }]);
    expect(ended.map((m) => m.result?.milestone)).toEqual(["end"]);
    expect(pendingMilestones({ ...c, taskIds: [] }, [base])).toEqual([]);
    expect(pendingMilestones({ ...c, messages: ended }, [base])).toEqual([]);

    const pr = "https://github.com/acme/web/pull/5";
    const followUp: Task = { ...base, id: "abd-123456", status: "running", prUrl: pr };
    const both = pendingMilestones({ ...c, taskIds: [base.id, followUp.id] }, [{ ...base, prUrl: pr }, followUp]);
    expect(both.find((m) => m.result?.milestone === "pr")?.text).toBe(`Updated [pull request #5](${pr}). Waiting for its checks…`);
  });
});

describe("Pointer activity", () => {
  const team = defaultTeam();
  const researcher = team.agents[0]!;

  it("labels tools in words", () => {
    expect(toolLabel("WebSearch", { query: "vite 8 release notes" }, team)).toEqual({ label: "Searching the web for “vite 8 release notes”", kind: "web" });
    expect(toolLabel("WebFetch", { url: "https://example.com/docs/a?x=1" }, team).label).toBe("Reading example.com/docs/a");
    expect(toolLabel("mcp__pointer__github_read_file", { repo: "Acme/web", path: "src/app.tsx" }, team)).toEqual({ label: "Reading Acme/web: src/app.tsx", kind: "github" });
    expect(toolLabel("mcp__pointer__memory_save", { text: "x" }, team)).toEqual({ label: "Saving a memory", kind: "memory" });
    expect(toolLabel("mcp__pointer__start_repo_task", { repo: "owner/repo", instruction: "x" }, team)).toEqual({ label: "Starting a repo task on owner/repo", kind: "task" });
    expect(toolLabel("Agent", { subagent_type: researcher.id, description: "compare options" }, team).label).toBe(
      `Asking ${researcher.name === researcher.role ? researcher.name : `${researcher.name} (${researcher.role})`}: compare options`,
    );
    expect(toolLabel("mcp__pointer__monday_search_items", { text: "login" }, team).label).toBe("Searching monday.com for “login”");
    expect(toolLabel("Mystery", {}, team)).toEqual({ label: "Using Mystery", kind: "other" });
  });

  it("maps the SDK stream: Pointer's text, its steps and its team members' steps", () => {
    const mapper = new ActivityMapper(team);
    const feed = (m: unknown) => mapper.feed(m as SDKMessage);
    expect(feed({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: {} } })).toEqual([{ type: "turn" }]);
    expect(feed({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } } })).toEqual([
      { type: "text", delta: "Hi" },
    ]);
    // A team member's own text is not Pointer's answer.
    expect(feed({ type: "stream_event", parent_tool_use_id: "a1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } } })).toEqual([]);
    expect(
      feed({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "a1", name: "Agent", input: { subagent_type: researcher.id, description: "dig" } }] },
      }),
    ).toEqual([{ type: "step", id: "a1", label: expect.stringContaining("Asking"), kind: "agent" }]);
    expect(
      feed({ type: "assistant", parent_tool_use_id: "a1", message: { content: [{ type: "tool_use", id: "w1", name: "WebSearch", input: { query: "q" } }] } }),
    ).toEqual([{ type: "step", id: "w1", label: "Searching the web for “q”", kind: "web", agent: expect.stringContaining(researcher.name) }]);
    expect(feed({ type: "user", parent_tool_use_id: "a1", message: { content: [{ type: "tool_result", tool_use_id: "w1", content: "r" }] } })).toEqual([
      { type: "step-done", id: "w1", isError: false },
    ]);
    expect(feed({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "a1", is_error: true }] } })).toEqual([
      { type: "step-done", id: "a1", isError: true },
    ]);
    // Unknown results and repeats are ignored.
    expect(feed({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: "a1" }] } })).toEqual([]);
    expect(feed({ type: "result", subtype: "success" })).toEqual([]);
  });
});

describe("GitHub webhook for a console conversation", () => {
  const PR_URL = "https://github.com/acme/web/pull/7";
  const review = {
    action: "submitted",
    review: { id: 1, state: "changes_requested", body: "Please rename the helper.", user: { login: "octocat", type: "User" }, author_association: "MEMBER" },
    pull_request: { number: 7, state: "open", html_url: PR_URL },
    repository: { full_name: "acme/web" },
    sender: { login: "octocat", type: "User" },
  };

  async function webPr(status: Task["status"]) {
    resetWebhookStateForTests();
    const t = await setup();
    const r = await t.service.startDirectTask("acme/web", "rename the helper");
    if (!r.ok) throw new Error("not started");
    const task = (await t.tasks.get(r.taskId))!;
    task.status = status;
    await t.tasks.save(task);
    await t.tasks.savePrThread("acme/web", 7, { channel: WEB_CHANNEL, threadTs: r.conversationId });
    await t.tasks.saveThread(WEB_CHANNEL, r.conversationId, { repo: "acme/web", branch: "army/rename-abc123", prUrl: PR_URL, prNumber: 7, requester: "admin" });
    const slackCalls: string[] = [];
    const deps = {
      configRepo: t.configRepo,
      tasks: t.tasks,
      runner: { kind: "local" as const, launch: async (id: string) => void t.launched.push(id) },
      slack: () => {
        slackCalls.push("slack");
        throw new Error("Slack must not be called for a console conversation");
      },
      web: t.service,
    };
    return { ...t, conversationId: r.conversationId, firstTask: r.taskId, deps, slackCalls };
  }

  it("starts the follow-up in the conversation, without Slack", async () => {
    const t = await webPr("done");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await handleGithubWebhook("pull_request_review", review, t.deps);
    expect(t.slackCalls).toEqual([]);
    const followUp = (await t.tasks.recent()).find((x) => x.trigger === "review")!;
    expect(followUp).toMatchObject({ channel: "web", threadTs: t.conversationId, userId: "admin", repo: "acme/web" });
    expect(followUp.instruction).toContain("Address the feedback from octocat on pull request #7");
    expect(t.launched).toContain(followUp.id);
    const c = (await t.service.view(t.conversationId))!.conversation;
    expect(c.taskIds).toEqual([t.firstTask, followUp.id]);
    expect(lastPointer(c)).toMatchObject({ text: `**octocat** requested changes on [PR #7](${PR_URL}). The team is on it…`, tasks: [followUp.id] });
  });

  it("notes the review in the conversation while a task is still running", async () => {
    const t = await webPr("running");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await handleGithubWebhook("pull_request_review", review, t.deps);
    expect(t.slackCalls).toEqual([]);
    expect((await t.tasks.recent()).filter((x) => x.trigger === "review")).toEqual([]);
    const c = (await t.service.view(t.conversationId))!.conversation;
    expect(lastPointer(c)!.text).toContain("**octocat** reviewed [PR #7]");
    expect(lastPointer(c)!.text).toContain("still working");
  });
});
