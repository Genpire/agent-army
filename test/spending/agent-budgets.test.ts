import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Budget, BudgetSchema, type Config, ConfigSchema } from "../../src/core/config.js";
import { FsStore } from "../../src/core/store.js";
import { createApp } from "../../src/server.js";
import {
  Spending,
  agentViews,
  agentsLeftOut,
  alertText,
  budgetView,
  chatDecision,
  providerCapProblem,
  providerToRun,
  providerViews,
  reachedAlerts,
  taskBudgetFor,
  taskDecision,
  teamWithout,
} from "../../src/spending/budget.js";
import { UsageRepo, monthKey } from "../../src/spending/usage.js";
import { type Task, TaskRepo, newTaskId } from "../../src/tasks/tasks.js";
import { defaultTeam } from "../../src/team/team.js";

const NOW = new Date("2026-11-18T12:00:00Z");
const budget = (b: Partial<Budget> = {}): Budget => BudgetSchema.parse(b);

const task = (at: Date, o: Partial<Task> = {}): Task => ({
  id: newTaskId(at.getTime()),
  createdAt: at.toISOString(),
  updatedAt: at.toISOString(),
  status: "done",
  repo: "acme/web",
  channel: "C1",
  threadTs: "1.1",
  userId: "U1",
  instruction: "do it",
  ...o,
});

const usageSetup = async () => {
  const store = new FsStore(await mkdtemp(join(tmpdir(), "army-agent-usage-")));
  const tasks = new TaskRepo(store);
  return { store, tasks, usage: new UsageRepo(store, tasks) };
};

// ---------- Monthly sums ----------

describe("monthly spend per agent and per provider", () => {
  it("adds up each task's shares and each chat reply's, by agent and by provider", async () => {
    const { tasks, usage } = await usageSetup();
    await tasks.save(
      task(new Date("2026-11-02T10:00:00Z"), {
        costUsd: 1,
        provider: "anthropic",
        agentCosts: {
          pointer: { usd: 0.4, tokens: 1_000 },
          coder: { usd: 0.6, tokens: 2_000 },
          "codex-coder": { usd: 0.35, estimated: true, tokens: 50_500, engines: { codex: { tokens: 50_000, usd: 0.3 } } },
        },
      }),
    );
    await tasks.save(
      task(new Date("2026-11-03T10:00:00Z"), {
        costUsd: 2,
        provider: "kimi",
        agentCosts: { pointer: { usd: 0.5 }, coder: { usd: 1.5 }, gem: { usd: 0, tokens: 9_000, unpricedTokens: 9_000, engines: { gemini: { tokens: 9_000 } } } },
      }),
    );
    // Saved before per-agent shares existed: counts in the totals and for its provider only.
    await tasks.save(task(new Date("2026-11-04T10:00:00Z"), { costUsd: 4 }));
    // Last month: not counted.
    await tasks.save(task(new Date("2026-10-30T10:00:00Z"), { costUsd: 9, agentCosts: { coder: { usd: 9 } } }));
    await usage.recordChat({ costUsd: 0.3, provider: "anthropic", agentCosts: { pointer: { usd: 0.1 }, researcher: { usd: 0.2, tokens: 700 } } }, NOW);
    await usage.recordChat({ costUsd: 0.2, provider: "kimi" }, NOW);
    // No provider (a console call from before providers were tallied): the chat provider's when read.
    await usage.recordChat(0.05, NOW);

    const month = await usage.month(NOW, { chatProvider: "kimi" });
    expect(month.totalUsd).toBeCloseTo(7.55, 6);
    const agents = Object.fromEntries(month.agents.map((a) => [a.agentId, a]));
    expect(agents.pointer).toMatchObject({ tasks: 2, chats: 3, estimated: false });
    expect(agents.pointer!.usd).toBeCloseTo(0.4 + 0.5 + 0.1 + 0.2 + 0.05, 6);
    expect(agents.coder).toMatchObject({ usd: 2.1, tasks: 2, chats: 0, tokens: 2_000 });
    expect(agents.researcher).toMatchObject({ usd: 0.2, tasks: 0, chats: 1, tokens: 700 });
    expect(agents["codex-coder"]).toMatchObject({ usd: 0.35, estimated: true, tasks: 1 });
    expect(agents.gem).toMatchObject({ usd: 0, unpricedTokens: 9_000 });
    // Highest first.
    expect(month.agents[0]!.agentId).toBe("coder");

    const providers = Object.fromEntries(month.providers.map((p) => [p.provider, p]));
    expect(providers.anthropic).toMatchObject({ tasks: 2, chats: 1, estimated: false });
    expect(providers.anthropic!.usd).toBeCloseTo(1 + 4 + 0.3, 6);
    expect(providers.kimi!.usd).toBeCloseTo(2 + 0.2 + 0.05, 6);
    expect(providers.kimi).toMatchObject({ tasks: 1, chats: 2 });
    expect(providers.codex).toMatchObject({ usd: 0.3, estimated: true, tasks: 1, tokens: 50_000, unpricedTokens: 0 });
    expect(providers.gemini).toMatchObject({ usd: 0, estimated: true, tokens: 9_000, unpricedTokens: 9_000 });
  });

  it("reads tallies saved before agents and providers were kept as Pointer's, on the chat provider", async () => {
    const { store, usage } = await usageSetup();
    await store.put(`usage/chat-${monthKey(NOW)}.json`, JSON.stringify({ usd: 3, count: 4 }));
    const month = await usage.month(NOW);
    expect(month.agents).toEqual([{ agentId: "pointer", usd: 3, estimated: false, tasks: 0, chats: 4, tokens: 0, unpricedTokens: 0 }]);
    expect(month.providers).toEqual([{ provider: "anthropic", usd: 3, estimated: false, tasks: 0, chats: 4, tokens: 0, unpricedTokens: 0 }]);
  });
});

// ---------- Enforcement ----------

const spendOf = (o: { total?: number; agents?: Record<string, number>; providers?: Record<string, number> }) => ({
  totalUsd: o.total ?? 0,
  repos: [],
  agents: Object.entries(o.agents ?? {}).map(([agentId, usd]) => ({ agentId, usd, estimated: false, tasks: 1, chats: 0, tokens: 0, unpricedTokens: 0 })),
  providers: Object.entries(o.providers ?? {}).map(([provider, usd]) => ({ provider, usd, estimated: false, tasks: 1, chats: 0, tokens: 0, unpricedTokens: 0 })),
});

const team = () => {
  const t = defaultTeam();
  t.agents.push({ ...t.agents[0]!, id: "codex-coder", name: "Codex", engine: "codex" });
  return t;
};

describe("caps per agent and per provider", () => {
  it("leaves out agents over their monthly cap, and engine agents whose engine's cap is used up", () => {
    const b = budget({ perAgentUsd: { coder: 5, reviewer: 10 }, perProviderUsd: { codex: 2 } });
    const left = agentsLeftOut(b, spendOf({ agents: { coder: 5, reviewer: 9.99 }, providers: { codex: 2.5 } }), team().agents);
    expect(left).toEqual([
      { id: "coder", note: "Coder is over its monthly budget ($5.00 of $5.00), so it is left out of this task." },
      { id: "codex-coder", note: expect.stringMatching(/^Codex is over its monthly budget: Codex, which does its work, has used up its cap \(\$2\.50 of \$2\.00\)/) },
    ]);
    const t = teamWithout(team(), left);
    expect(t.agents.map((a) => a.id)).not.toContain("coder");
    expect(t.agents.map((a) => a.id)).toContain("reviewer");
    // A disabled agent is never "left out": it was not on the team anyway.
    const disabled = team();
    disabled.agents[0]!.enabled = false;
    expect(agentsLeftOut(b, spendOf({ agents: { coder: 50 } }), disabled.agents)).toEqual([]);
  });

  it("refuses a task, and a chat reply, when the provider it runs on has used up its cap", () => {
    const b = budget({ perProviderUsd: { kimi: 10 } });
    const usage = spendOf({ total: 30, providers: { kimi: 10.2, anthropic: 20 } });
    const refused = taskDecision(b, usage, "acme/web", { provider: "kimi" });
    expect(refused).toEqual({
      ok: false,
      error:
        "The monthly budget for Kimi is used up: $10.20 of the $10.00 cap spent on chat and repo tasks on Kimi. New repo tasks on Kimi are refused until the month ends (UTC). The owner can raise the cap in the admin console under Settings → Spending.",
    });
    expect(taskDecision(b, usage, "acme/web", { provider: "anthropic" })).toEqual({ ok: true });
    const chat = chatDecision(b, usage, { provider: "kimi" });
    expect(chat.ok).toBe(false);
    if (!chat.ok) expect(chat.error).toContain("Chat replies on Kimi are refused");
    // What is left of the provider's cap bounds the task's own budget.
    const lowered = taskBudgetFor(b, spendOf({ providers: { kimi: 7 } }), "acme/web", 15, { provider: "kimi" });
    expect(lowered).toEqual({ ok: true, budgetUsd: 3, note: "This task may spend $3.00: what is left of the monthly budget for Kimi (the per-task budget is $15.00)." });
  });

  it("skips a provider whose cap is used up when its route has another, and refuses only when every one's is", () => {
    const b = budget({ perProviderUsd: { kimi: 10, anthropic: 20 } });
    const kimiOut = spendOf({ total: 30, providers: { kimi: 10.2, anthropic: 5 } });
    const route = { providers: ["kimi", "anthropic"] };
    expect(taskDecision(b, kimiOut, "acme/web", route)).toEqual({ ok: true });
    expect(chatDecision(b, kimiOut, route)).toEqual({ ok: true });
    // The task runs on the first provider with enough left: its cap bounds the task's budget.
    expect(providerToRun(b, kimiOut, route, "task")).toBe("anthropic");
    expect(taskBudgetFor(b, kimiOut, "acme/web", 30, route)).toEqual({
      ok: true,
      budgetUsd: 15,
      note: "This task may spend $15.00: what is left of the monthly budget for Claude (the per-task budget is $30.00).",
    });
    // A task needs MIN_TASK_USD left of a provider's cap; a chat reply anything.
    const almost = spendOf({ providers: { kimi: 9.8 } });
    expect(providerCapProblem(b, almost, "kimi", "task")).toMatch(/^The monthly budget for Kimi is used up: \$9\.80 of the \$10\.00 cap/);
    expect(providerCapProblem(b, almost, "kimi", "chat")).toBeUndefined();
    expect(providerCapProblem(b, almost, "deepseek", "task")).toBeUndefined();

    const bothOut = spendOf({ total: 40, providers: { kimi: 10.2, anthropic: 20 } });
    const task = taskDecision(b, bothOut, "acme/web", route);
    expect(task).toEqual({
      ok: false,
      error:
        "The monthly budgets of every provider this work can run on are used up: Kimi ($10.20 of $10.00) and Claude ($20.00 of $20.00). New repo tasks are refused until the month ends (UTC). The owner can raise the cap in the admin console under Settings → Spending.",
    });
    const chat = chatDecision(b, bothOut, route);
    expect(!chat.ok && chat.error).toContain("Chat replies are refused");
    // A route of one keeps the provider's own message.
    expect(taskDecision(b, bothOut, "acme/web", { providers: ["kimi"] })).toEqual(taskDecision(b, bothOut, "acme/web", { provider: "kimi" }));
  });

  it("checks each kind of work against its own route through the service, and gives routing the caps", async () => {
    const { store, tasks, usage } = await usageSetup();
    const config: Config = ConfigSchema.parse({
      anthropic: { apiKey: "sk-ant-route-0001" },
      ai: { chatProvider: "kimi", taskProvider: "kimi", providers: { kimi: { secrets: { apiKey: "sk-kimi-route-0001" } } }, routes: { chat: ["kimi", "anthropic"] } },
      budget: { perProviderUsd: { kimi: 1 } },
    });
    await tasks.save(task(new Date(NOW.getTime() - 60_000), { costUsd: 1.2, provider: "kimi" }));
    const spending = new Spending({ store, usage, config: async () => config, now: () => NOW });
    // Chat moves on to Claude; repo tasks have Kimi alone.
    expect(await spending.checkChat()).toEqual({ ok: true });
    expect(await spending.checkChat("light")).toEqual({ ok: true });
    expect((await spending.checkTask("acme/web")).ok).toBe(false);
    config.ai.routes.tasks = ["kimi", "anthropic"];
    expect(await spending.checkTask("acme/web")).toEqual({ ok: true });
    expect(await spending.taskBudget("acme/web", 15)).toEqual({ ok: true, budgetUsd: 15 });
    // The provider the worker chose bounds the task by its own cap.
    expect((await spending.taskBudget("acme/web", 15, "kimi")).ok).toBe(false);
    const caps = await spending.providerCaps("task");
    expect(caps("kimi")).toMatch(/^The monthly budget for Kimi is used up/);
    expect(caps("anthropic")).toBeUndefined();
    // Without caps nothing is read and nothing is skipped.
    const none = new Spending({ store, usage, config: async () => ConfigSchema.parse({}), now: () => NOW });
    expect((await none.providerCaps("chat"))("kimi")).toBeUndefined();
  });

  it("refuses tasks and chat once Pointer's own cap is used up", () => {
    const b = budget({ perAgentUsd: { pointer: 4 } });
    const over = spendOf({ agents: { pointer: 4 } });
    const task = taskDecision(b, over, "acme/web", { leadName: "Sara" });
    expect(task.ok).toBe(false);
    if (!task.ok) expect(task.error).toMatch(/^Sara's own monthly budget is used up: \$4\.00 of the \$4\.00 cap/);
    expect(chatDecision(b, over, { leadName: "Sara" }).ok).toBe(false);
    expect(chatDecision(b, spendOf({ agents: { pointer: 3.99 } })).ok).toBe(true);
  });

  it("alerts on agent and provider caps like the others", () => {
    const b = budget({ alertPercent: 80, perAgentUsd: { coder: 10, pointer: 5 }, perProviderUsd: { gemini: 4 } });
    const usage = spendOf({ agents: { coder: 8.5, pointer: 5 }, providers: { gemini: 1 } });
    const names = (id: string) => ({ coder: "Coder", pointer: "Pointer" })[id] ?? id;
    const alerts = reachedAlerts(b, usage, names);
    expect(alerts.map((a) => [a.key, a.level])).toEqual([
      ["agent:coder|alert@80%|$10", "alert"],
      ["agent:pointer|exceeded|$5", "exceeded"],
    ]);
    expect(alertText(alerts[0]!)).toBe(
      ":warning: Coder is at 85% of its monthly budget: $8.50 of $10.00. At the cap, Coder is left out of new repo tasks until the month ends (UTC). Change the cap or this alert in the admin console under Settings → Spending.",
    );
    expect(alertText(alerts[1]!)).toContain("New repo tasks and chat replies are refused");
    expect(alertText({ scope: "provider", provider: "gemini", name: "Gemini CLI", level: "exceeded", capUsd: 4, usedUsd: 4.2, percent: 105 })).toContain(
      "Agents working through Gemini CLI are left out of new repo tasks",
    );
    expect(budgetView(b, usage, {}, names).level).toBe("exceeded");
  });

  it("lists every agent and every configured provider with its month and caps", () => {
    const config = ConfigSchema.parse({
      anthropic: { apiKey: "sk-ant-x" },
      ai: { chatProvider: "anthropic", taskProvider: "kimi", providers: { kimi: { secrets: { apiKey: "k" } } } },
      engines: { codex: { apiKey: "sk-openai", model: "gpt-5.1-codex" }, gemini: { model: "" } },
      budget: { perAgentUsd: { coder: 20, gone: 3 }, perTaskAgentUsd: { coder: 2 }, perProviderUsd: { gemini: 1 } },
    });
    const agents = agentViews(config, spendOf({ agents: { coder: 5, pointer: 1, removed: 0.5 } }));
    expect(agents[0]).toMatchObject({ agentId: "pointer", name: "Pointer (lead)", lead: true, usd: 1, level: "ok" });
    expect(agents.find((a) => a.agentId === "coder")).toMatchObject({ name: "Coder", usd: 5, capUsd: 20, percent: 25, remainingUsd: 15, perTaskCapUsd: 2, level: "ok", enabled: true, engine: "claude" });
    expect(agents.find((a) => a.agentId === "qa")).toMatchObject({ usd: 0, level: "ok" });
    expect(agents.find((a) => a.agentId === "qa")!.capUsd).toBeUndefined();
    // Removed agents that still spent this month or keep a cap.
    expect(agents.slice(-2).map((a) => a.agentId)).toEqual(["gone", "removed"]);

    const providers = providerViews(config, spendOf({ providers: { anthropic: 2, codex: 0.4 } }));
    expect(providers.map((p) => [p.provider, p.configured])).toEqual([
      ["anthropic", true],
      ["kimi", true],
      ["codex", true],
      ["gemini", false],
    ]);
    expect(providers.find((p) => p.provider === "codex")).toMatchObject({ name: "Codex", kind: "engine", model: "gpt-5.1-codex", priced: true, usd: 0.4 });
    expect(providers.find((p) => p.provider === "gemini")).toMatchObject({ kind: "engine", priced: false, capUsd: 1 });
  });

  it("leaves agents out through the service, reading this month's spend from the store", async () => {
    const { store, tasks, usage } = await usageSetup();
    const config: Config = ConfigSchema.parse({ budget: { perAgentUsd: { qa: 1 } } });
    await tasks.save(task(new Date(NOW.getTime() - 60_000), { costUsd: 1.2, agentCosts: { qa: { usd: 1.2 } } }));
    const spending = new Spending({ store, usage, config: async () => config, now: () => NOW });
    expect(await spending.leftOut(config.team)).toEqual([{ id: "qa", note: "QA is over its monthly budget ($1.20 of $1.00), so it is left out of this task." }]);
    // Without any cap nothing is read.
    const none = new Spending({ store, usage, config: async () => ConfigSchema.parse({}), now: () => NOW });
    expect(await none.leftOut(config.team)).toEqual([]);
  });
});

// ---------- Older configs ----------

describe("older configs", () => {
  it("load without the new caps, which default to none", () => {
    const old = { monthlyUsd: 50, perRepoUsd: { "acme/web": 5 }, alertPercent: 75, alertChannel: "C0ALERTS1" };
    expect(ConfigSchema.parse({ budget: old }).budget).toEqual({ ...old, perAgentUsd: {}, perProviderUsd: {}, perTaskAgentUsd: {} });
    expect(ConfigSchema.parse({}).budget).toEqual({ monthlyUsd: 0, perRepoUsd: {}, alertPercent: 80, alertChannel: "", perAgentUsd: {}, perProviderUsd: {}, perTaskAgentUsd: {} });
    // Two configs never share a cap list.
    const a = ConfigSchema.parse({});
    a.budget.perAgentUsd.coder = 5;
    expect(ConfigSchema.parse({}).budget.perAgentUsd).toEqual({});
    // A cap of an agent removed since still loads.
    expect(ConfigSchema.parse({ budget: { perAgentUsd: { "old-agent": 3 } } }).budget.perAgentUsd).toEqual({ "old-agent": 3 });
  });

  it("show tasks saved without per-agent shares in the totals only", async () => {
    const { tasks, usage } = await usageSetup();
    await tasks.save(task(new Date(NOW.getTime() - 60_000), { costUsd: 2 }));
    const month = await usage.month(NOW);
    expect(month.totalUsd).toBe(2);
    expect(month.agents).toEqual([]);
    expect(month.providers).toMatchObject([{ provider: "anthropic", usd: 2, tasks: 1 }]);
  });
});

// ---------- Admin API ----------

describe("POST /api/budget with agent and provider caps", () => {
  let base = "";
  let cookie = "";
  let dir = "";
  let close: () => void;
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  const get = async (path: string) => (await fetch(base + path, { headers: { cookie } })).json();

  beforeAll(async () => {
    process.env.SKIP_VALIDATION = "1";
    dir = await mkdtemp(join(tmpdir(), "army-agent-budget-api-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" });
    const server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
    const res = await post("/api/setup", { setupToken: "setup-123", password: "longpassword1" });
    cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const tasks = new TaskRepo(new FsStore(dir));
    await tasks.save(task(new Date(Date.now() - 60_000), { costUsd: 3, provider: "anthropic", agentCosts: { pointer: { usd: 1 }, coder: { usd: 2 } } }));
    await mkdir(join(dir, "usage"), { recursive: true });
    await writeFile(join(dir, "usage", `chat-${monthKey(new Date())}.json`), JSON.stringify({ usd: 0, count: 0 }));
  });
  afterAll(() => close());

  it("saves caps for known agents (and Pointer), providers and engines, dropping zeros", async () => {
    const res = await post("/api/budget", {
      perAgentUsd: { pointer: 10, coder: 5, qa: 0 },
      perTaskAgentUsd: { coder: 1.5 },
      perProviderUsd: { anthropic: 100, codex: 20, gemini: 0 },
    });
    expect(res.status).toBe(200);
    const saved = (await res.json()).budget;
    expect(saved).toMatchObject({ perAgentUsd: { pointer: 10, coder: 5 }, perTaskAgentUsd: { coder: 1.5 }, perProviderUsd: { anthropic: 100, codex: 20 } });
    // A field left out is kept; one sent replaces its list.
    const again = await (await post("/api/budget", { perTaskAgentUsd: {} })).json();
    expect(again.budget).toMatchObject({ perAgentUsd: { pointer: 10, coder: 5 }, perTaskAgentUsd: {}, perProviderUsd: { anthropic: 100, codex: 20 } });
  });

  it("rejects unknown agents and providers, and amounts out of range, keeping what was saved", async () => {
    const bad: [unknown, string][] = [
      [{ perAgentUsd: { ghost: 5 } }, 'ghost is not an agent on the team (use "pointer" for Pointer itself).'],
      [{ perTaskAgentUsd: { pointer: 5 } }, "pointer is not an agent on the team."],
      [{ perProviderUsd: { openai: 5 } }, expect.stringMatching(/^openai is not an AI provider or coding agent CLI\. Use one of: anthropic, bedrock/)],
      [{ perAgentUsd: { coder: 100_001 } }, "Caps are amounts in USD from 0 (no cap) to 100,000."],
      [{ perProviderUsd: { codex: -1 } }, "Caps are amounts in USD from 0 (no cap) to 100,000."],
      [{ perAgentUsd: { coder: "5" } }, "Caps are amounts in USD from 0 (no cap) to 100,000."],
    ];
    for (const [body, error] of bad) {
      const res = await post("/api/budget", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error });
    }
    expect((await get("/api/state")).config.budget).toMatchObject({ perAgentUsd: { pointer: 10, coder: 5 } });
  });

  it("returns this month's spend per agent and per provider, with their caps", async () => {
    const usage = await get("/api/usage");
    expect(usage.agents[0]).toMatchObject({ agentId: "pointer", name: "Pointer (lead)", usd: 1, capUsd: 10, percent: 10, level: "ok", tasks: 1 });
    expect(usage.agents.find((a: { agentId: string }) => a.agentId === "coder")).toMatchObject({ usd: 2, estimated: false, capUsd: 5, percent: 40, level: "ok" });
    expect(usage.providers.find((p: { provider: string }) => p.provider === "anthropic")).toMatchObject({ usd: 3, capUsd: 100, percent: 3, level: "ok", configured: true });
    expect(usage.providers.find((p: { provider: string }) => p.provider === "codex")).toMatchObject({ usd: 0, capUsd: 20, kind: "engine", configured: false, priced: false });
  });
});
