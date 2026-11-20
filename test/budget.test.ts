import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MIN_TASK_USD,
  Spending,
  alertText,
  budgetView,
  capStatus,
  capsApply,
  chatDecision,
  reachedAlerts,
  remainingForTask,
  repoCapUsd,
  taskBudgetFor,
  taskDecision,
} from "../src/budget.js";
import { type Budget, BudgetSchema, type Config, ConfigRepo } from "../src/core/config.js";
import { ConversationService } from "../src/conversations.js";
import { deriveKey } from "../src/core/crypto.js";
import { handleSlackEvent, resetDispatchStateForTests } from "../src/dispatch.js";
import { MemoryRepo } from "../src/memory.js";
import type { PointerBrain, PointerContext, PointerReply, PointerRequest, SlackMessageEvent, StartRepoTaskResult } from "../src/pointer-types.js";
import { createApp } from "../src/server.js";
import { FsStore } from "../src/core/store.js";
import { type Task, TaskRepo, newTaskId } from "../src/tasks.js";
import { startThreadTask } from "../src/thread-task.js";
import { UsageRepo } from "../src/usage.js";
import { handleGithubWebhook, resetWebhookStateForTests } from "../src/webhook.js";

const NOW = new Date("2026-11-18T12:00:00Z");
const budget = (b: Partial<Budget> = {}): Budget => BudgetSchema.parse(b);
const spend = (totalUsd: number, repos: Record<string, number> = {}) => ({
  totalUsd,
  repos: Object.entries(repos).map(([repo, usd]) => ({ repo, usd, count: 1 })),
});

describe("cap math", () => {
  it("has no cap at 0, and levels from the alert percent and at 100%", () => {
    expect(capStatus(0, 500, 80)).toBeNull();
    expect(capStatus(50, 39.99, 80)).toEqual({ capUsd: 50, usedUsd: 39.99, remainingUsd: 50 - 39.99, percent: 79, level: "ok" });
    expect(capStatus(50, 40, 80)).toMatchObject({ percent: 80, level: "alert", remainingUsd: 10 });
    expect(capStatus(50, 50, 80)).toMatchObject({ percent: 100, level: "exceeded", remainingUsd: 0 });
    expect(capStatus(50, 61, 80)).toMatchObject({ percent: 122, level: "exceeded", remainingUsd: 0 });
    // At 100% the alert level is the cap itself.
    expect(capStatus(50, 49, 100)).toMatchObject({ level: "ok" });
    expect(capStatus(50, Number.NaN, 80)).toMatchObject({ usedUsd: 0, level: "ok" });
  });

  it("matches repository caps without letter case", () => {
    const b = budget({ perRepoUsd: { "Acme/Web": 20 } });
    expect(repoCapUsd(b, "acme/web")).toBe(20);
    expect(repoCapUsd(b, "acme/api")).toBe(0);
    expect(capsApply(b, "ACME/WEB")).toBe(true);
    expect(capsApply(b, "acme/api")).toBe(false);
    expect(capsApply(budget({ monthlyUsd: 5 }))).toBe(true);
    expect(capsApply(budget())).toBe(false);
  });

  it("refuses a task at the monthly cap, with what was used, the cap and where to change it", () => {
    const b = budget({ monthlyUsd: 50 });
    expect(taskDecision(b, spend(10), "acme/web")).toEqual({ ok: true });
    const refused = taskDecision(b, spend(50.2), "acme/web");
    expect(refused).toEqual({
      ok: false,
      error:
        "This month's Claude budget is used up: $50.20 of the $50.00 cap spent on chat and repo tasks. New repo tasks are refused until the month ends (UTC). The owner can raise the cap in the admin console under Settings → Spending.",
    });
    // Less left than a task needs is used up too.
    const almost = taskDecision(b, spend(50 - MIN_TASK_USD / 2), "acme/web");
    expect(almost.ok).toBe(false);
    if (!almost.ok) expect(almost.error).toContain("Only $0.25 is left, less than the $0.50 a repo task needs.");
  });

  it("refuses a task at its repository's cap, but not tasks on other repositories", () => {
    const b = budget({ perRepoUsd: { "acme/web": 20 } });
    const usage = spend(30, { "acme/web": 20.1, "acme/api": 9.9 });
    const refused = taskDecision(b, usage, "Acme/Web");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toBe(
        "The monthly budget for Acme/Web is used up: $20.10 of the $20.00 cap spent on its repo tasks. New tasks on Acme/Web are refused until the month ends (UTC). The owner can raise the cap in the admin console under Settings → Spending.",
      );
    }
    expect(taskDecision(b, usage, "acme/api")).toEqual({ ok: true });
    // 0 = no cap anywhere.
    expect(taskDecision(budget(), spend(1e6, { "acme/web": 1e6 }), "acme/web")).toEqual({ ok: true });
  });

  it("refuses chat only once the monthly cap is used up; repository caps never stop chat", () => {
    expect(chatDecision(budget({ monthlyUsd: 50 }), spend(49.9))).toEqual({ ok: true });
    const refused = chatDecision(budget({ monthlyUsd: 50 }), spend(50));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error).toContain("$50.00 of the $50.00 cap");
      expect(refused.error).toContain("Chat replies and new repo tasks are refused");
      expect(refused.error).toContain("Settings → Spending");
    }
    expect(chatDecision(budget({ perRepoUsd: { "acme/web": 1 } }), spend(1000, { "acme/web": 1000 }))).toEqual({ ok: true });
    expect(chatDecision(budget(), spend(1e6))).toEqual({ ok: true });
  });

  it("caps a task's own budget at the least left of the caps that apply", () => {
    expect(remainingForTask(budget(), spend(5), "acme/web")).toBeUndefined();
    expect(remainingForTask(budget({ monthlyUsd: 50 }), spend(46.8), "acme/web")).toEqual({ usd: 50 - 46.8, scope: "monthly" });
    const both = budget({ monthlyUsd: 50, perRepoUsd: { "acme/web": 10 } });
    expect(remainingForTask(both, spend(20, { "acme/web": 8 }), "acme/web")).toEqual({ usd: 2, scope: "repo" });
    expect(remainingForTask(both, spend(49, { "acme/web": 1 }), "acme/web")).toEqual({ usd: 1, scope: "monthly" });

    expect(taskBudgetFor(budget(), spend(5), "acme/web", 15)).toEqual({ ok: true, budgetUsd: 15 });
    expect(taskBudgetFor(budget({ monthlyUsd: 100 }), spend(5), "acme/web", 15)).toEqual({ ok: true, budgetUsd: 15 });
    expect(taskBudgetFor(budget({ monthlyUsd: 50 }), spend(46.789), "acme/web", 15)).toEqual({
      ok: true,
      budgetUsd: 3.21,
      note: "This task may spend $3.21: what is left of this month's Claude budget (the per-task budget is $15.00).",
    });
    expect(taskBudgetFor(both, spend(20, { "acme/web": 8 }), "acme/web", 15)).toMatchObject({ ok: true, budgetUsd: 2 });
    const refused = taskBudgetFor(both, spend(20, { "acme/web": 9.8 }), "acme/web", 15);
    expect(refused.ok).toBe(false);
  });
});

describe("alerts", () => {
  it("names one alert per cap, the higher level, with keys that change with the cap and threshold", () => {
    const b = budget({ monthlyUsd: 50, alertPercent: 80, perRepoUsd: { "acme/web": 10, "acme/api": 10 } });
    const alerts = reachedAlerts(b, spend(41, { "acme/web": 12, "acme/api": 2 }));
    expect(alerts.map((a) => [a.key, a.level])).toEqual([
      ["monthly|alert@80%|$50", "alert"],
      ["repo:acme/web|exceeded|$10", "exceeded"],
    ]);
    // Reaching 100% settles the alert level too, so it is never sent afterwards.
    expect(alerts[1]!.covers).toEqual(["repo:acme/web|exceeded|$10", "repo:acme/web|alert@80%|$10"]);
    expect(reachedAlerts(budget({ monthlyUsd: 100 }), spend(41))).toEqual([]);
  });

  it("writes the Slack text with the spend, the cap and where to change it", () => {
    expect(alertText({ scope: "monthly", level: "alert", capUsd: 50, usedUsd: 41, percent: 82 })).toBe(
      ":warning: Claude spending is at 82% of this month's cap: $41.00 of $50.00 (chat and repo tasks). At the cap, new repo tasks and chat replies are refused until the month ends (UTC). Change the cap or this alert in the admin console under Settings → Spending.",
    );
    expect(alertText({ scope: "repo", repo: "acme/web", level: "exceeded", capUsd: 10, usedUsd: 12, percent: 120 })).toBe(
      ":no_entry: The monthly cap for repo tasks on `acme/web` is used up: $12.00 of $10.00. New tasks there are refused until the month ends (UTC); running tasks finish. The owner can raise the cap in the admin console under Settings → Spending.",
    );
  });

  it("builds the console's view: every cap, the worst level, and when Slack was told", () => {
    const b = budget({ monthlyUsd: 50, perRepoUsd: { "acme/web": 10, "acme/api": 100 } });
    const view = budgetView(b, spend(30, { "acme/web": 9 }), { "repo:acme/web|alert@80%|$10": "2026-11-18T10:00:00.000Z" });
    expect(view.monthly).toMatchObject({ percent: 60, level: "ok" });
    expect(view.repos.map((r) => [r.repo, r.level])).toEqual([
      ["acme/web", "alert"],
      ["acme/api", "ok"],
    ]);
    expect(view.level).toBe("alert");
    expect(view.alerts).toEqual([
      { key: "repo:acme/web|alert@80%|$10", scope: "repo", repo: "acme/web", level: "alert", capUsd: 10, usedUsd: 9, percent: 90, notifiedAt: "2026-11-18T10:00:00.000Z" },
    ]);
    expect(budgetView(budget(), spend(1000)).level).toBe("ok");
  });
});

// ---------- The service, against the store ----------

const costed = (at: Date, costUsd: number, repo = "acme/web"): Task => ({
  id: newTaskId(at.getTime()),
  createdAt: at.toISOString(),
  updatedAt: at.toISOString(),
  status: "done",
  repo,
  channel: "C1",
  threadTs: "1.1",
  userId: "U1",
  instruction: "do it",
  costUsd,
});

async function spendingSetup(b: Partial<Budget>, opts: { channel?: string; botToken?: string } = {}) {
  const store = new FsStore(await mkdtemp(join(tmpdir(), "army-budget-")));
  const tasks = new TaskRepo(store);
  const usage = new UsageRepo(store, tasks);
  const config = { budget: budget({ alertChannel: opts.channel ?? "CALERTS", ...b }), slack: { botToken: opts.botToken ?? "xoxb-secret" } } as unknown as Config;
  const posts: { channel: string; text: string }[] = [];
  const slack = { fail: false };
  let now = NOW;
  const spending = new Spending({
    store,
    usage,
    config: async () => config,
    slack: () =>
      ({
        chat: {
          postMessage: async (m: { channel: string; text: string }) => {
            if (slack.fail) throw Object.assign(new Error("An API error occurred: not_in_channel"), { data: { error: "not_in_channel" } });
            posts.push(m);
            return { ok: true };
          },
        },
      }) as never,
    now: () => now,
  });
  let n = 0;
  const addTask = (costUsd: number, repo = "acme/web") => tasks.save(costed(new Date(now.getTime() - 60_000 + n++), costUsd, repo));
  return { store, tasks, usage, config, posts, slack, spending, addTask, setNow: (d: Date) => void (now = d) };
}

describe("Spending", () => {
  it("posts each alert level once per month, and a new month starts over", async () => {
    const t = await spendingSetup({ monthlyUsd: 10, alertPercent: 80 });
    await t.addTask(5);
    await t.spending.notify();
    expect(t.posts).toEqual([]);

    await t.addTask(3.5);
    await t.spending.notify();
    await t.spending.notify();
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0]).toMatchObject({ channel: "CALERTS" });
    expect(t.posts[0]!.text).toContain("85% of this month's cap: $8.50 of $10.00");

    await t.addTask(2);
    await Promise.all([t.spending.notify(), t.spending.notify()]);
    expect(t.posts).toHaveLength(2);
    expect(t.posts[1]!.text).toContain("This month's Claude spending cap is used up: $10.50 of $10.00");

    t.setNow(new Date("2026-12-02T09:00:00Z"));
    await t.addTask(9);
    await t.spending.notify();
    expect(t.posts).toHaveLength(3);
    expect(t.posts[2]!.text).toContain("90% of this month's cap: $9.00 of $10.00");
  });

  it("sends only the 100% alert when a cap is passed at once, and never the lower one afterwards", async () => {
    const t = await spendingSetup({ perRepoUsd: { "acme/web": 4 } });
    await t.addTask(5);
    await t.spending.notify();
    await t.spending.notify();
    expect(t.posts.map((p) => p.text)).toEqual([expect.stringContaining("The monthly cap for repo tasks on `acme/web` is used up: $5.00 of $4.00")]);
    expect((await t.spending.view()).budget.alerts[0]).toMatchObject({ level: "exceeded", notifiedAt: NOW.toISOString() });
  });

  it("alerts again when the cap changes, and retries an alert Slack refused", async () => {
    const t = await spendingSetup({ monthlyUsd: 10 });
    await t.addTask(9);
    t.slack.fail = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await t.spending.notify();
    expect(t.posts).toEqual([]);
    expect(errors.mock.calls.flat().join(" ")).toContain("not_in_channel");
    expect(errors.mock.calls.flat().join(" ")).not.toContain("xoxb-secret");
    errors.mockRestore();

    t.slack.fail = false;
    await t.spending.notify();
    expect(t.posts).toHaveLength(1);
    t.config.budget.monthlyUsd = 11;
    await t.spending.notify();
    expect(t.posts).toHaveLength(2);
    expect(t.posts[1]!.text).toContain("$9.00 of $11.00");
  });

  it("sends nothing without an alert channel or a Slack token, and remembers nothing", async () => {
    const t = await spendingSetup({ monthlyUsd: 10 }, { channel: "" });
    await t.addTask(12);
    await t.spending.notify();
    expect(t.posts).toEqual([]);
    expect((await t.spending.view()).budget).toMatchObject({ level: "exceeded", alerts: [expect.not.objectContaining({ notifiedAt: expect.anything() })] });
  });

  it("checks tasks and chat against this month's spend, and reads nothing without caps", async () => {
    const t = await spendingSetup({ monthlyUsd: 10, perRepoUsd: { "acme/api": 2 } });
    await t.addTask(2, "acme/api");
    await t.addTask(7);
    expect(await t.spending.checkTask("acme/web")).toEqual({ ok: true });
    expect((await t.spending.checkTask("acme/api")).ok).toBe(false);
    expect(await t.spending.checkChat()).toEqual({ ok: true });
    expect(await t.spending.taskBudget("acme/web", 15)).toMatchObject({ ok: true, budgetUsd: 1 });
    await t.addTask(1.5);
    expect((await t.spending.checkTask("acme/web")).ok).toBe(false);
    expect((await t.spending.checkChat()).ok).toBe(false);
    expect((await t.spending.taskBudget("acme/web", 15)).ok).toBe(false);

    const month = vi.spyOn(t.usage, "month");
    t.config.budget = budget();
    expect(await t.spending.checkTask("acme/web")).toEqual({ ok: true });
    expect(await t.spending.checkChat()).toEqual({ ok: true });
    expect(await t.spending.taskBudget("acme/web", 15)).toEqual({ ok: true, budgetUsd: 15 });
    expect(month).not.toHaveBeenCalled();
  });

  it("never blocks work when the spend cannot be read", async () => {
    const t = await spendingSetup({ monthlyUsd: 10 });
    vi.spyOn(t.usage, "month").mockRejectedValue(new Error("store down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await t.spending.checkTask("acme/web")).toEqual({ ok: true });
    expect(await t.spending.checkChat()).toEqual({ ok: true });
    expect(await t.spending.taskBudget("acme/web", 15)).toEqual({ ok: true, budgetUsd: 15 });
    await expect(t.spending.notify()).resolves.toBeUndefined();
    errors.mockRestore();
    vi.restoreAllMocks();
  });
});

// ---------- Every start path refuses at the cap ----------

const API_KEY = "sk-ant-secret-key-0123456789";

/** A deployment whose monthly cap ($10) is used up by a task this month, and the pieces every start path needs. */
async function cappedDeployment(b: Partial<Budget> = { monthlyUsd: 10 }) {
  resetDispatchStateForTests();
  resetWebhookStateForTests();
  const store = new FsStore(await mkdtemp(join(tmpdir(), "army-capped-")));
  const configRepo = new ConfigRepo(store, deriveKey("k"), 0);
  await configRepo.update((c) => {
    c.anthropic.apiKey = API_KEY;
    c.slack = { botToken: "xoxb-secret-token", signingSecret: "s".repeat(20), botUserId: "UBOT", allowedUserIds: [], pointerChannels: [] };
    c.github = { ...c.github, token: "ghp_secret_token_0123456789", allowedOwners: ["acme"], webhookSecret: "whsec-0123456789abcdef" };
    c.bindings["C1"] = "acme/web";
    Object.assign(c.budget, b);
  });
  const tasks = new TaskRepo(store);
  const usage = new UsageRepo(store, tasks);
  await tasks.save(costed(new Date(Date.now() - 60_000), 10));
  const spending = new Spending({ store, usage, config: () => configRepo.load() });
  const launched: string[] = [];
  const runner = { kind: "local" as const, launch: async (id: string) => void launched.push(id) };
  const posts: { channel: string; thread_ts?: string; text: string }[] = [];
  const slack = {
    chat: {
      postMessage: async (m: { channel: string; thread_ts?: string; text: string }) => {
        posts.push(m);
        return { ok: true, ts: `900.${posts.length}` };
      },
    },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    conversations: { replies: async () => ({ messages: [] }), history: async () => ({ messages: [] }) },
    users: { info: async () => ({ user: { profile: { display_name: "Someone" } } }) },
    auth: { test: async () => ({ team_id: "T1" }) },
  };
  const brainCalls: PointerRequest[] = [];
  let script: (req: PointerRequest, ctx: PointerContext) => Promise<PointerReply> = async () => ({ text: "hi", isError: false });
  const brain: PointerBrain = {
    reply: async (req, ctx) => {
      brainCalls.push(req);
      return script(req, ctx);
    },
  };
  const conversations = new ConversationService({ store, configRepo, tasks, runner, brain, usage, spending });
  const taskCount = async () => (await tasks.recent(100)).length;
  return {
    store,
    configRepo,
    tasks,
    spending,
    launched,
    runner,
    posts,
    slack,
    brain,
    brainCalls,
    conversations,
    taskCount,
    setScript: (s: typeof script) => void (script = s),
    slackDeps: {
      configRepo,
      tasks,
      runner,
      memory: new MemoryRepo(store, deriveKey("k")),
      usage,
      brain,
      slack: () => slack as never,
      spending,
      web: conversations,
    },
  };
}

describe("refusals on every start path", () => {
  it("startThreadTask: refused before anything is posted, saved or launched", async () => {
    const t = await cappedDeployment();
    const before = await t.taskCount();
    const result = await startThreadTask(
      { tasks: t.tasks, runner: t.runner, slack: t.slack as never, budget: t.spending },
      { repo: "acme/web", channel: "C1", threadTs: "1.2", userId: "U1", instruction: "fix it", ackText: "On it" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("This month's Claude budget is used up: $10.00 of the $10.00 cap");
    expect(t.posts).toEqual([]);
    expect(t.launched).toEqual([]);
    expect(await t.taskCount()).toBe(before);
  });

  it("Slack: Pointer's start_repo_task is refused, and chat is refused at the monthly cap", async () => {
    const t = await cappedDeployment({ perRepoUsd: { "acme/web": 5 } });
    const results: StartRepoTaskResult[] = [];
    t.setScript(async (_req, ctx) => {
      results.push(await ctx.startRepoTask({ instruction: "fix the login bug" }));
      return { text: "Could not start it.", isError: false };
    });
    const mention = (ts: string, text: string) =>
      handleSlackEvent({ type: "app_mention", user: "U1", channel: "C1", ts, text: `<@UBOT> ${text}` } as SlackMessageEvent, t.slackDeps);
    await mention("100.1", "fix the login bug");
    expect(results).toEqual([{ ok: false, error: expect.stringContaining("The monthly budget for acme/web is used up: $10.00 of the $5.00 cap") }]);
    expect(t.launched).toEqual([]);
    expect(t.posts.map((p) => p.text)).toEqual(["Could not start it."]);

    // The monthly cap: no model call at all.
    await t.configRepo.update((c) => {
      c.budget.monthlyUsd = 10;
    });
    t.brainCalls.length = 0;
    await mention("101.1", "what changed this week?");
    expect(t.brainCalls).toEqual([]);
    expect(t.posts.at(-1)).toMatchObject({ channel: "C1", thread_ts: "101.1" });
    expect(t.posts.at(-1)!.text).toMatch(/^:no_entry: This month's Claude budget is used up: \$10\.00 of the \$10\.00 cap/);
    expect(t.posts.at(-1)!.text).toContain("Settings → Spending");

    // Commands cost nothing and still work; `status` shows the caps.
    await mention("102.1", "status");
    expect(t.brainCalls).toEqual([]);
    expect(t.posts.at(-1)!.text).toContain("*Monthly cap:* $10.00 of $10.00 (100%), used up");
    expect(t.posts.at(-1)!.text).toContain("*Cap for `acme/web`:* $10.00 of $5.00 (200%), used up");
  });

  it("console: a direct task is refused without a conversation, Pointer's task is refused, and chat is refused", async () => {
    const t = await cappedDeployment();
    const direct = await t.conversations.startDirectTask("acme/web", "fix it");
    expect(direct).toEqual({ ok: false, status: 409, error: expect.stringContaining("This month's Claude budget is used up") });
    expect(await t.conversations.list()).toEqual([]);

    // Chat at the monthly cap: the reply is the refusal, the brain is never asked.
    const created = await t.conversations.create("hello");
    if (!created.ok) throw new Error(created.error);
    await t.conversations.idle();
    expect(t.brainCalls).toEqual([]);
    const view = await t.conversations.view(created.conversation.id);
    expect(view?.conversation.messages.at(-1)).toMatchObject({ role: "pointer", isError: true, text: expect.stringContaining("Chat replies and new repo tasks are refused") });

    // Under the monthly cap, a repo cap still refuses Pointer's start_repo_task (startTask).
    await t.configRepo.update((c) => {
      c.budget.monthlyUsd = 0;
      c.budget.perRepoUsd = { "acme/web": 10 };
    });
    const results: StartRepoTaskResult[] = [];
    t.setScript(async (_req, ctx) => {
      results.push(await ctx.startRepoTask({ repo: "acme/web", instruction: "fix it" }));
      return { text: "No.", isError: false };
    });
    const sent = await t.conversations.send(created.conversation.id, "fix it in acme/web");
    expect(sent.ok).toBe(true);
    await t.conversations.idle();
    expect(results).toEqual([{ ok: false, error: expect.stringContaining("The monthly budget for acme/web is used up") }]);
    expect(t.launched).toEqual([]);
    // Other repositories are not capped.
    const other = await t.conversations.startDirectTask("acme/api", "fix it");
    expect(other.ok).toBe(true);
    expect(t.launched).toHaveLength(1);
  });

  it("GitHub reviews: a follow-up in Slack or in the console is refused and says why", async () => {
    const t = await cappedDeployment();
    const review = (number: number) => ({
      action: "submitted",
      review: { state: "changes_requested", body: "Rename it.", user: { login: "octocat", type: "User" }, author_association: "MEMBER" },
      pull_request: { number, state: "open", html_url: `https://github.com/acme/web/pull/${number}` },
      repository: { full_name: "acme/web" },
      sender: { login: "octocat", type: "User" },
    });
    await t.tasks.savePrThread("acme/web", 7, { channel: "C1", threadTs: "100.1" });
    await t.tasks.saveThread("C1", "100.1", { repo: "acme/web", branch: "army/x-abc123", prNumber: 7, requester: "U1" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await handleGithubWebhook("pull_request_review", review(7), t.slackDeps);
    expect(t.launched).toEqual([]);
    expect(t.posts).toEqual([{ channel: "C1", thread_ts: "100.1", text: expect.stringMatching(/^:x: This month's Claude budget is used up/) }]);

    // A pull request opened from the console: the refusal goes into its conversation.
    const created = await t.conversations.create("hi");
    if (!created.ok) throw new Error(created.error);
    await t.conversations.idle();
    const id = created.conversation.id;
    await t.tasks.savePrThread("acme/web", 8, { channel: "web", threadTs: id });
    await handleGithubWebhook("pull_request_review", review(8), t.slackDeps);
    expect(t.launched).toEqual([]);
    const view = await t.conversations.view(id);
    expect(view?.conversation.messages.at(-1)?.text).toContain("This month's Claude budget is used up");
    vi.restoreAllMocks();
  });
});

// ---------- Admin API ----------

describe("POST /api/budget and GET /api/usage", () => {
  let base = "";
  let cookie = "";
  let close: () => void;
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  const get = async (path: string) => (await fetch(base + path, { headers: { cookie } })).json();

  beforeAll(async () => {
    process.env.SKIP_VALIDATION = "1";
    const dir = await mkdtemp(join(tmpdir(), "army-budget-api-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" });
    const server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const res = await post("/api/setup", { setupToken: "setup-123", password: "longpassword1" });
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    // A task this month on acme/web that cost $4.
    const tasks = new TaskRepo(new FsStore(dir));
    await tasks.save(costed(new Date(Date.now() - 60_000), 4));
  });
  afterAll(() => close());

  it("needs a session", async () => {
    expect((await fetch(`${base}/api/budget`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  });

  it("saves the caps field by field, drops repo caps of 0, and shows them in the state", async () => {
    expect((await post("/api/budget", { monthlyUsd: 50, alertChannel: " C0ALERTS1 " })).status).toBe(200);
    const res = await post("/api/budget", { perRepoUsd: { "acme/web": 5, "acme/api": 0 }, alertPercent: 75 });
    expect(res.status).toBe(200);
    const expected = { monthlyUsd: 50, perRepoUsd: { "acme/web": 5 }, alertPercent: 75, alertChannel: "C0ALERTS1" };
    expect(await res.json()).toEqual({ ok: true, budget: expected });
    expect((await get("/api/state")).config.budget).toEqual(expected);
  });

  it("rejects bad caps with a readable message and keeps the saved ones", async () => {
    const bad: [unknown, string][] = [
      [{ monthlyUsd: -1 }, "Caps are amounts in USD from 0 (no cap) to 100,000."],
      [{ monthlyUsd: "50" }, "Caps are amounts in USD from 0 (no cap) to 100,000."],
      [{ alertPercent: 5 }, "The alert level is a whole percent from 10 to 100."],
      [{ alertPercent: 80.5 }, "The alert level is a whole percent from 10 to 100."],
      [{ alertChannel: "general" }, "Channel IDs look like C012ABCDEF."],
      [{ perRepoUsd: { "not a repo": 5 } }, "Repositories look like owner/repo (GitHub), gitlab:group/project or bitbucket:workspace/repo."],
      [{ perRepoUsd: { "acme/web": 5, "ACME/web": 6 } }, "ACME/web is listed twice."],
    ];
    for (const [body, error] of bad) {
      const res = await post("/api/budget", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    expect((await get("/api/state")).config.budget).toMatchObject({ monthlyUsd: 50, perRepoUsd: { "acme/web": 5 } });
  });

  it("returns the month's spend with the caps, per repository, and the alert state", async () => {
    const usage = await get("/api/usage");
    expect(usage).toMatchObject({ totalUsd: 4, repos: [{ repo: "acme/web", usd: 4, count: 1 }] });
    expect(usage.budget).toMatchObject({
      monthly: { capUsd: 50, usedUsd: 4, percent: 8, level: "ok" },
      repos: [{ repo: "acme/web", capUsd: 5, usedUsd: 4, percent: 80, level: "alert" }],
      alertPercent: 75,
      alertChannel: "C0ALERTS1",
      level: "alert",
      alerts: [{ scope: "repo", repo: "acme/web", level: "alert", percent: 80 }],
    });
  });

  it("saves the preview check with the limits", async () => {
    expect((await post("/api/settings", { limits: { previewCheck: "always" } })).status).toBe(200);
    expect((await get("/api/state")).config.limits.previewCheck).toBe("always");
    const res = await post("/api/settings", { limits: { previewCheck: "sometimes" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'The preview check is "off", "visible" or "always".' });
  });
});
