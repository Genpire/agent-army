import type { WebClient } from "@slack/web-api";
import { routeProviders } from "../ai/routing.js";
import type { Budget, Config, WorkKind } from "../core/config.js";
import { slackErrorCode } from "../slack/slack.js";
import type { Store } from "../core/store.js";
import type { AgentSpec, Team } from "../team/team.js";
import { LEAD_AGENT_ID } from "./attribution.js";
import { BUDGET_PROVIDER_IDS, enginePrice, isBudgetProviderId, isEngineId, providerLabel } from "./prices.js";
import { type AgentUsage, type MonthUsage, type ProviderUsage, type UsageRepo, repoSpend, usd } from "./usage.js";

/**
 * Spending caps: a monthly Claude budget for chat and repo tasks together,
 * optional monthly caps per repository (repo tasks only), per agent (its
 * share of tasks and chat, attribution.ts; "pointer" is Pointer itself) and
 * per AI provider or coding agent CLI, and what one agent may spend in a
 * single task. A cap of 0 means no cap.
 *
 * - New repo tasks are refused when the monthly, the repository's or
 *   Pointer's own cap is used up (every start path asks startThreadTask,
 *   which asks `checkTask`; the worker asks again), chat replies when the
 *   monthly or Pointer's cap is. A provider whose cap is used up is skipped:
 *   the work runs on the next provider of its route (routing.ts,
 *   `providerCaps`), and is refused only when every one of them is used up.
 *   A task's own budget never exceeds what is left.
 * - An agent over its monthly cap, or working through an engine whose cap is
 *   used up, is left out of the team for the task (`leftOut`).
 * - Within a task, an agent past its per-task cap has its tool calls denied
 *   (the worker's hook) and its engine runs stopped (engines.ts).
 * Running tasks are otherwise never stopped by a cap: their own budget bounds them.
 *
 * Alerts: when a cap reaches `alertPercent` and again at 100%, one Slack
 * message in `alertChannel` per level per month (the log is in the store), and
 * a banner in the console (from `view`).
 */

/** A repo task needs at least this much of a cap left to start: less would stop it after a step or two. */
export const MIN_TASK_USD = 0.5;

/** Where the owner changes the caps, for every message about them. */
const WHERE = "The owner can raise the cap in the admin console under Settings → Spending.";

export { BUDGET_PROVIDER_IDS, LEAD_AGENT_ID };

export type CapLevel = "ok" | "alert" | "exceeded";

export interface CapStatus {
  capUsd: number;
  usedUsd: number;
  /** What is left of the cap, never below 0. */
  remainingUsd: number;
  /** How much of the cap is used, rounded down; past 100 when spend went over. */
  percent: number;
  /** alert from `alertPercent`, exceeded at 100%. */
  level: CapLevel;
}

export interface RepoCapStatus extends CapStatus {
  /** As the cap is saved. */
  repo: string;
}

export type CapDecision = { ok: true } | { ok: false; error: string };

/** What startThreadTask asks before a repo task starts (anything that starts one passes it). */
export interface TaskBudgetCheck {
  checkTask(repo: string): Promise<CapDecision>;
}

/** The spend the caps are checked against; the per-agent and per-provider lists may be left out (no spend). */
export type SpendInput = Pick<MonthUsage, "totalUsd" | "repos"> & Partial<Pick<MonthUsage, "agents" | "providers">>;

const OK: CapDecision = { ok: true };

/** A cap's state, or null when there is none (0). */
export function capStatus(capUsd: number, usedUsd: number, alertPercent: number): CapStatus | null {
  if (!(capUsd > 0)) return null;
  const used = Number.isFinite(usedUsd) && usedUsd > 0 ? usedUsd : 0;
  const level: CapLevel = used >= capUsd ? "exceeded" : used >= (capUsd * alertPercent) / 100 ? "alert" : "ok";
  return { capUsd, usedUsd: used, remainingUsd: Math.max(0, capUsd - used), percent: Math.floor((used / capUsd) * 100), level };
}

/** The repository's monthly cap, matched without letter case; 0 = none. */
export function repoCapUsd(budget: Pick<Budget, "perRepoUsd">, repo: string): number {
  const wanted = repo.toLowerCase();
  for (const [name, cap] of Object.entries(budget.perRepoUsd)) if (name.toLowerCase() === wanted) return cap;
  return 0;
}

const capOf = (caps: Record<string, number> | undefined, key: string): number => {
  const cap = caps?.[key];
  return typeof cap === "number" && cap > 0 ? cap : 0;
};
const anyCap = (caps: Record<string, number> | undefined) => Object.values(caps ?? {}).some((c) => c > 0);

/** An agent's monthly cap ("pointer" for Pointer itself); 0 = none. */
export const agentCapUsd = (budget: Pick<Budget, "perAgentUsd">, agentId: string): number => capOf(budget.perAgentUsd, agentId);
/** An AI provider's or engine's monthly cap; 0 = none. */
export const providerCapUsd = (budget: Pick<Budget, "perProviderUsd">, provider: string): number => capOf(budget.perProviderUsd, provider);
/** What one agent may spend in a single repo task; 0 = no limit beyond the task's own budget. */
export const perTaskCapUsd = (budget: Pick<Budget, "perTaskAgentUsd">, agentId: string): number => capOf(budget.perTaskAgentUsd, agentId);

/** True when some monthly cap applies to a task on `repo` (else nothing needs to be read). */
export const capsApply = (budget: Budget, repo?: string): boolean =>
  budget.monthlyUsd > 0 || (repo !== undefined && repoCapUsd(budget, repo) > 0) || anyCap(budget.perAgentUsd) || anyCap(budget.perProviderUsd);

const agentUsed = (usage: Partial<Pick<MonthUsage, "agents">>, agentId: string) => usage.agents?.find((a) => a.agentId === agentId)?.usd ?? 0;
const providerUsed = (usage: Partial<Pick<MonthUsage, "providers">>, provider: string) => usage.providers?.find((p) => p.provider === provider)?.usd ?? 0;

export const monthlyStatus = (budget: Budget, usage: Pick<MonthUsage, "totalUsd">): CapStatus | null =>
  capStatus(budget.monthlyUsd, usage.totalUsd, budget.alertPercent);

export const repoStatus = (budget: Budget, usage: Pick<MonthUsage, "repos">, repo: string): CapStatus | null =>
  capStatus(repoCapUsd(budget, repo), repoSpend(usage, repo), budget.alertPercent);

export const agentStatus = (budget: Budget, usage: Partial<Pick<MonthUsage, "agents">>, agentId: string): CapStatus | null =>
  capStatus(agentCapUsd(budget, agentId), agentUsed(usage, agentId), budget.alertPercent);

export const providerStatus = (budget: Budget, usage: Partial<Pick<MonthUsage, "providers">>, provider: string): CapStatus | null =>
  capStatus(providerCapUsd(budget, provider), providerUsed(usage, provider), budget.alertPercent);

function usedUp(what: string, spentOn: string, s: CapStatus, refused: string, forTask: boolean): string {
  const left = forTask && s.remainingUsd > 0 ? ` Only ${usd(s.remainingUsd)} is left, less than the ${usd(MIN_TASK_USD)} a repo task needs.` : "";
  return `${what} is used up: ${usd(s.usedUsd)} of the ${usd(s.capUsd)} cap spent on ${spentOn}.${left} ${refused} until the month ends (UTC). ${WHERE}`;
}

const MONTHLY = "This month's Claude budget";
const SPENT_MONTHLY = "chat and repo tasks";

/** Who a decision is about besides the repository: the providers the work can run on, and Pointer's name. */
export interface DecisionContext {
  /** The AI provider the task or reply runs on (config.ai.taskProvider / chatProvider) when there is one only. */
  provider?: string;
  /**
   * The route's providers in order (routing.ts), the work moving on to the
   * next one when one cannot run: a provider's monthly cap refuses the work
   * only when every one of them is used up, and the work runs on the first
   * one that is not. Takes the place of `provider` when set.
   */
  providers?: string[];
  /** Pointer's name, for its own cap. */
  leadName?: string;
}

/** What a provider's monthly cap is checked for: a chat reply (anything left) or a repo task (MIN_TASK_USD left). */
export type CapWork = "chat" | "task";

/** Why a provider's monthly cap stops new work on it now, or undefined when it does not (no cap, or enough left). */
export function providerCapProblem(budget: Budget, usage: Partial<Pick<MonthUsage, "providers">>, provider: string, work: CapWork): string | undefined {
  const p = providerStatus(budget, usage, provider);
  if (!p) return undefined;
  const task = work === "task";
  if (task ? p.remainingUsd >= MIN_TASK_USD : p.remainingUsd > 0) return undefined;
  const label = providerLabel(provider);
  return usedUp(`The monthly budget for ${label}`, `chat and repo tasks on ${label}`, p, task ? `New repo tasks on ${label} are refused` : `Chat replies on ${label} are refused`, task);
}

const routeOf = (ctx: DecisionContext): string[] => (ctx.providers?.length ? ctx.providers : ctx.provider ? [ctx.provider] : []);

/** The provider the work runs on: the first of the route whose cap does not stop it (the first when every one does). */
export function providerToRun(budget: Budget, usage: Partial<Pick<MonthUsage, "providers">>, ctx: DecisionContext, work: CapWork): string | undefined {
  const route = routeOf(ctx);
  return route.find((p) => !providerCapProblem(budget, usage, p, work)) ?? route[0];
}

const listed = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** Refused for the providers' caps only when every provider of the route has used its cap up. */
function providersDecision(budget: Budget, usage: Partial<Pick<MonthUsage, "providers">>, ctx: DecisionContext, work: CapWork): CapDecision {
  const route = routeOf(ctx);
  const problems = route.map((p) => providerCapProblem(budget, usage, p, work));
  if (!route.length || problems.some((p) => p === undefined)) return OK;
  if (route.length === 1) return { ok: false, error: problems[0]! };
  const spent = route.map((p) => {
    const s = providerStatus(budget, usage, p);
    return `${providerLabel(p)} (${usd(s?.usedUsd ?? 0)} of ${usd(s?.capUsd ?? 0)})`;
  });
  const refused = work === "task" ? "New repo tasks are refused" : "Chat replies are refused";
  return {
    ok: false,
    error: `The monthly budgets of every provider this work can run on are used up: ${listed(spent)}. ${refused} until the month ends (UTC). ${WHERE}`,
  };
}

/**
 * Whether a new repo task on `repo` may start: refused when the monthly, the
 * repository's or Pointer's own cap has less than MIN_TASK_USD left, or every
 * provider it can run on has less than that left of its own cap.
 */
export function taskDecision(budget: Budget, usage: SpendInput, repo: string, ctx: DecisionContext = {}): CapDecision {
  const monthly = monthlyStatus(budget, usage);
  if (monthly && monthly.remainingUsd < MIN_TASK_USD) {
    return { ok: false, error: usedUp(MONTHLY, SPENT_MONTHLY, monthly, "New repo tasks are refused", true) };
  }
  const own = repoStatus(budget, usage, repo);
  if (own && own.remainingUsd < MIN_TASK_USD) {
    return { ok: false, error: usedUp(`The monthly budget for ${repo}`, `its repo tasks`, own, `New tasks on ${repo} are refused`, true) };
  }
  const providers = providersDecision(budget, usage, ctx, "task");
  if (!providers.ok) return providers;
  const lead = agentStatus(budget, usage, LEAD_AGENT_ID);
  if (lead && lead.remainingUsd < MIN_TASK_USD) {
    const name = ctx.leadName || "Pointer";
    return { ok: false, error: usedUp(`${name}'s own monthly budget`, `its share of chat and repo tasks`, lead, "New repo tasks are refused", true) };
  }
  return OK;
}

/** Whether a chat reply may start: refused once the monthly or Pointer's own cap is used up, or the cap of every provider it can run on. */
export function chatDecision(budget: Budget, usage: Pick<MonthUsage, "totalUsd"> & Partial<Pick<MonthUsage, "agents" | "providers">>, ctx: DecisionContext = {}): CapDecision {
  const monthly = monthlyStatus(budget, usage);
  if (monthly && monthly.remainingUsd <= 0) {
    return { ok: false, error: usedUp(MONTHLY, SPENT_MONTHLY, monthly, "Chat replies and new repo tasks are refused", false) };
  }
  const providers = providersDecision(budget, usage, ctx, "chat");
  if (!providers.ok) return providers;
  const lead = agentStatus(budget, usage, LEAD_AGENT_ID);
  if (lead && lead.remainingUsd <= 0) {
    const name = ctx.leadName || "Pointer";
    return { ok: false, error: usedUp(`${name}'s own monthly budget`, `its share of chat and repo tasks`, lead, "Chat replies and new repo tasks are refused", false) };
  }
  return OK;
}

/** The least left of the caps that bound a whole task on `repo` (monthly, repository, provider), or undefined when none applies. */
export function remainingForTask(
  budget: Budget,
  usage: SpendInput,
  repo: string,
  provider?: string,
): { usd: number; scope: "monthly" | "repo" | "provider" } | undefined {
  const caps: { usd: number; scope: "monthly" | "repo" | "provider" }[] = [];
  const monthly = monthlyStatus(budget, usage);
  if (monthly) caps.push({ usd: monthly.remainingUsd, scope: "monthly" });
  const own = repoStatus(budget, usage, repo);
  if (own) caps.push({ usd: own.remainingUsd, scope: "repo" });
  const p = provider ? providerStatus(budget, usage, provider) : null;
  if (p) caps.push({ usd: p.remainingUsd, scope: "provider" });
  // The first of the smallest: monthly before repo before provider.
  return caps.reduce<(typeof caps)[number] | undefined>((least, c) => (!least || c.usd < least.usd ? c : least), undefined);
}

export type TaskBudget = { ok: true; budgetUsd: number; note?: string } | { ok: false; error: string };

/**
 * A repo task's own budget: the per-task budget, lowered to what is left of
 * the caps that apply (rounded down to the cent), or the refusal when too
 * little is left. `note` says why it was lowered (for the task's timeline).
 */
export function taskBudgetFor(budget: Budget, usage: SpendInput, repo: string, maxBudgetUsd: number, ctx: DecisionContext = {}): TaskBudget {
  const decision = taskDecision(budget, usage, repo, ctx);
  if (!decision.ok) return decision;
  // The provider the task starts on: the first of its route with enough of its cap left.
  const provider = providerToRun(budget, usage, ctx, "task");
  const left = remainingForTask(budget, usage, repo, provider);
  if (!left || left.usd >= maxBudgetUsd) return { ok: true, budgetUsd: maxBudgetUsd };
  const budgetUsd = Math.floor(left.usd * 100) / 100;
  const of =
    left.scope === "monthly"
      ? "this month's Claude budget"
      : left.scope === "repo"
        ? `the monthly budget for ${repo}`
        : `the monthly budget for ${providerLabel(provider ?? "")}`;
  return { ok: true, budgetUsd, note: `This task may spend ${usd(budgetUsd)}: what is left of ${of} (the per-task budget is ${usd(maxBudgetUsd)}).` };
}

/** An agent left out of a task by a cap, and the timeline's line about it. */
export interface LeftOutAgent {
  id: string;
  note: string;
  /**
   * Set when the agent stays and only CLIs of its line sit out (an agent with
   * a fallback): its engine, model and fallback for this task, what is left
   * of its line once they are out (Claude when no CLI is).
   */
  line?: Pick<AgentSpec, "engine" | "engineModel" | "fallback">;
}

/** An agent as agentsLeftOut reads it: its line only when it has one. */
export type CappedAgent = Pick<AgentSpec, "id" | "name" | "engine" | "enabled"> & Partial<Pick<AgentSpec, "engineModel" | "fallback">>;

/**
 * The enabled agents a monthly cap changes in the next repo task. Over its
 * own cap, an agent sits out. Working through an engine (Codex, Gemini CLI)
 * whose cap is used up: an agent with no fallback sits out; one with a
 * fallback stays, and moves to the next step of its line whose CLI still has
 * budget (Claude when none has and its fallback names Claude; else it sits
 * out too, as Claude takes over only where the owner put it), while a capped
 * CLI further down its line is only dropped from it. Pointer itself is never
 * left out (its cap refuses the task instead).
 */
export function agentsLeftOut(budget: Budget, usage: Partial<Pick<MonthUsage, "agents" | "providers">>, agents: CappedAgent[]): LeftOutAgent[] {
  const out: LeftOutAgent[] = [];
  const capped = (engine: string) => {
    const status = providerStatus(budget, usage, engine);
    return status && status.remainingUsd <= 0 ? status : undefined;
  };
  for (const a of agents) {
    if (!a.enabled) continue;
    const own = agentStatus(budget, usage, a.id);
    if (own && own.remainingUsd <= 0) {
      out.push({ id: a.id, note: `${a.name} is over its monthly budget (${usd(own.usedUsd)} of ${usd(own.capUsd)}), so it is left out of this task.` });
      continue;
    }
    if (a.engine === "claude") continue;
    if (!a.fallback?.length) {
      const engine = capped(a.engine);
      if (!engine) continue;
      const label = providerLabel(a.engine);
      out.push({
        id: a.id,
        note: `${a.name} is over its monthly budget: ${label}, which does its work, has used up its cap (${usd(engine.usedUsd)} of ${usd(engine.capUsd)}), so ${a.name} is left out of this task.`,
      });
      continue;
    }
    // Its line up to Claude (nothing after Claude runs): the capped CLIs drop out of it.
    const steps: { engine: AgentSpec["engine"]; model: string }[] = [{ engine: a.engine, model: a.engineModel ?? "" }];
    for (const f of a.fallback) {
      if (steps.at(-1)!.engine === "claude") break;
      steps.push(f);
    }
    const dropped = steps.filter((s) => s.engine !== "claude" && capped(s.engine));
    if (!dropped.length) continue;
    const [first, ...rest] = steps.filter((s) => !dropped.includes(s));
    const why = dropped
      .map((s) => {
        const status = capped(s.engine)!;
        return `${providerLabel(s.engine)} has used up its monthly cap (${usd(status.usedUsd)} of ${usd(status.capUsd)})`;
      })
      .join(" and ");
    // Every CLI of its line is capped and its fallback does not name Claude: it sits out, as an agent with no fallback does.
    if (!first) {
      out.push({ id: a.id, note: `${why}, so ${a.name} is left out of this task.` });
      continue;
    }
    const line: LeftOutAgent["line"] = first.engine !== "claude" ? { engine: first.engine, engineModel: first.model, fallback: rest } : { engine: "claude", engineModel: "", fallback: [] };
    const where =
      line.engine === a.engine
        ? `so ${dropped.length === 1 ? "it is" : "they are"} left out of ${a.name}'s fallback in this task`
        : `so ${a.name} ${line.engine === "claude" ? "works as Claude" : `works through ${providerLabel(line.engine)}`} in this task`;
    out.push({ id: a.id, note: `${why}, ${where}.`, line });
  }
  return out;
}

/** The team without the agents a cap left out, and with what is left of the line of those it only moved. */
export function teamWithout(team: Team, leftOut: (Pick<LeftOutAgent, "id"> & Partial<Pick<LeftOutAgent, "line">>)[]): Team {
  if (!leftOut.length) return team;
  const byId = new Map(leftOut.map((l) => [l.id, l]));
  return {
    ...team,
    agents: team.agents.flatMap((a) => {
      const l = byId.get(a.id);
      if (!l) return [a];
      return l.line ? [{ ...a, ...l.line }] : [];
    }),
  };
}

// ---------- Alerts ----------

export type AlertScope = "monthly" | "repo" | "agent" | "provider";

export interface BudgetAlert {
  /** Identifies the alert in the month's log: scope, level, threshold and cap, so a new cap or threshold alerts again. */
  key: string;
  /** Keys this alert settles in the log: reaching 100% at once settles the alert level too. */
  covers: string[];
  scope: AlertScope;
  /** For a repository's cap, as it is saved. */
  repo?: string;
  /** For an agent's cap: its id ("pointer" for Pointer itself). */
  agentId?: string;
  /** For a provider's or engine's cap: its id. */
  provider?: string;
  /** The agent's or provider's name, for messages. */
  name?: string;
  level: "alert" | "exceeded";
  capUsd: number;
  usedUsd: number;
  percent: number;
}

/** Agent names for messages: the team's, "Pointer" for the lead, else the id. */
export function agentNamer(team: Pick<Team, "pointer" | "agents"> | undefined): (agentId: string) => string {
  return (agentId) => {
    if (agentId === LEAD_AGENT_ID) return team?.pointer.name || "Pointer";
    return team?.agents.find((a) => a.id === agentId)?.name ?? agentId;
  };
}

/** The level each cap has reached this month, at most one alert per cap (the higher level). */
export function reachedAlerts(budget: Budget, usage: SpendInput, agentName: (agentId: string) => string = agentNamer(undefined)): BudgetAlert[] {
  const out: BudgetAlert[] = [];
  const add = (scope: AlertScope, base: string, extra: Pick<BudgetAlert, "repo" | "agentId" | "provider" | "name">, s: CapStatus | null) => {
    if (!s || s.level === "ok") return;
    const alertKey = `${base}|alert@${budget.alertPercent}%|$${s.capUsd}`;
    const fullKey = `${base}|exceeded|$${s.capUsd}`;
    const exceeded = s.level === "exceeded";
    out.push({
      key: exceeded ? fullKey : alertKey,
      covers: exceeded ? [fullKey, alertKey] : [alertKey],
      scope,
      ...extra,
      level: exceeded ? "exceeded" : "alert",
      capUsd: s.capUsd,
      usedUsd: s.usedUsd,
      percent: s.percent,
    });
  };
  add("monthly", "monthly", {}, monthlyStatus(budget, usage));
  for (const repo of Object.keys(budget.perRepoUsd).sort()) add("repo", `repo:${repo.toLowerCase()}`, { repo }, repoStatus(budget, usage, repo));
  for (const id of Object.keys(budget.perAgentUsd).sort()) add("agent", `agent:${id}`, { agentId: id, name: agentName(id) }, agentStatus(budget, usage, id));
  for (const id of Object.keys(budget.perProviderUsd).sort()) add("provider", `provider:${id}`, { provider: id, name: providerLabel(id) }, providerStatus(budget, usage, id));
  return out;
}

const CHANGE = "Change the cap or this alert in the admin console under Settings → Spending.";

/** The Slack message for an alert (mrkdwn). */
export function alertText(a: Pick<BudgetAlert, "scope" | "repo" | "agentId" | "provider" | "name" | "level" | "capUsd" | "usedUsd" | "percent">): string {
  const spent = `${usd(a.usedUsd)} of ${usd(a.capUsd)}`;
  if (a.scope === "monthly") {
    return a.level === "exceeded"
      ? `:no_entry: This month's Claude spending cap is used up: ${spent} (chat and repo tasks). New repo tasks and chat replies are refused until the month ends (UTC); running tasks finish. ${WHERE}`
      : `:warning: Claude spending is at ${a.percent}% of this month's cap: ${spent} (chat and repo tasks). At the cap, new repo tasks and chat replies are refused until the month ends (UTC). ${CHANGE}`;
  }
  if (a.scope === "agent") {
    const name = a.name ?? a.agentId ?? "An agent";
    const lead = a.agentId === LEAD_AGENT_ID;
    const atCap = lead ? "new repo tasks and chat replies are refused" : `${name} is left out of new repo tasks`;
    return a.level === "exceeded"
      ? `:no_entry: ${name}'s monthly budget is used up: ${spent}. ${atCap.charAt(0).toUpperCase()}${atCap.slice(1)} until the month ends (UTC); running tasks finish. ${WHERE}`
      : `:warning: ${name} is at ${a.percent}% of its monthly budget: ${spent}. At the cap, ${atCap} until the month ends (UTC). ${CHANGE}`;
  }
  if (a.scope === "provider") {
    const name = a.name ?? a.provider ?? "A provider";
    const engine = isEngineId(a.provider ?? "");
    const atCap = engine ? `agents working through ${name} are left out of new repo tasks` : `new repo tasks and chat replies on ${name} are refused`;
    return a.level === "exceeded"
      ? `:no_entry: The monthly budget for ${name} is used up: ${spent}. ${atCap.charAt(0).toUpperCase()}${atCap.slice(1)} until the month ends (UTC); running tasks finish. ${WHERE}`
      : `:warning: ${name} is at ${a.percent}% of its monthly budget: ${spent}${engine ? " (estimated from tokens)" : ""}. At the cap, ${atCap} until the month ends (UTC). ${CHANGE}`;
  }
  const repo = `\`${a.repo ?? ""}\``;
  return a.level === "exceeded"
    ? `:no_entry: The monthly cap for repo tasks on ${repo} is used up: ${spent}. New tasks there are refused until the month ends (UTC); running tasks finish. ${WHERE}`
    : `:warning: Repo tasks on ${repo} are at ${a.percent}% of their monthly cap: ${spent}. At the cap, new tasks there are refused until the month ends (UTC). ${CHANGE}`;
}

const alertLogKey = (month: string) => `budget/alerts-${month}.json`;

/** Which alerts were sent to Slack in a month: alert key -> when (ISO). One file per month. */
export class AlertLog {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: Store) {}

  async sent(month: string): Promise<Record<string, string>> {
    const blob = await this.store.get(alertLogKey(month));
    if (!blob) return {};
    try {
      const data = JSON.parse(blob.toString("utf8")) as { sent?: unknown };
      const sent = data.sent && typeof data.sent === "object" ? (data.sent as Record<string, unknown>) : {};
      return Object.fromEntries(Object.entries(sent).filter((e): e is [string, string] => typeof e[1] === "string"));
    } catch {
      return {};
    }
  }

  /** Adds keys to the month's log; calls are serialised so none is lost. */
  mark(month: string, keys: string[], at: string): Promise<void> {
    const run = this.chain.then(async () => {
      const sent = await this.sent(month);
      for (const key of keys) sent[key] ??= at;
      await this.store.put(alertLogKey(month), JSON.stringify({ sent }));
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}

// ---------- The console's view ----------

export interface BudgetView {
  /** null when there is no monthly cap. */
  monthly: CapStatus | null;
  /** Every repository with a cap, most used first. */
  repos: RepoCapStatus[];
  alertPercent: number;
  alertChannel: string;
  /** The highest level of any cap: the console's banner. */
  level: CapLevel;
  /** The caps at or past the alert level, with when Slack was told (absent: not sent, e.g. no alert channel). */
  alerts: (Omit<BudgetAlert, "covers"> & { notifiedAt?: string })[];
}

/** One agent's month with its caps, for the console ("pointer" is Pointer itself, named "<name> (lead)"). */
export interface AgentSpendView extends AgentUsage {
  name: string;
  /** Pointer itself. */
  lead: boolean;
  /** For team members: whether it is enabled, and who does its work in repo tasks. */
  enabled?: boolean;
  engine?: AgentSpec["engine"];
  /** Its monthly cap, when it has one, and how far it is used. */
  capUsd?: number;
  remainingUsd?: number;
  percent?: number;
  level: CapLevel;
  /** What it may spend in one repo task, when limited. */
  perTaskCapUsd?: number;
}

/** One AI provider's or engine's month with its cap, for the console. */
export interface ProviderSpendView extends ProviderUsage {
  name: string;
  kind: "ai" | "engine";
  /** Connected (or chosen for chat or repo tasks), rather than only having spend or a cap. */
  configured: boolean;
  /** Engines: the model it runs ("" = the CLI's default), and whether that model has a price (else tokens only, no dollars). */
  model?: string;
  priced?: boolean;
  capUsd?: number;
  remainingUsd?: number;
  percent?: number;
  level: CapLevel;
}

/** GET /api/usage: this month's spend with the caps, per agent and per provider too. */
export type UsageView = Omit<MonthUsage, "agents" | "providers"> & {
  agents: AgentSpendView[];
  providers: ProviderSpendView[];
  budget: BudgetView;
};

const LEVEL_RANK: Record<CapLevel, number> = { ok: 0, alert: 1, exceeded: 2 };
const worst = (levels: CapLevel[]): CapLevel => levels.reduce<CapLevel>((w, l) => (LEVEL_RANK[l] > LEVEL_RANK[w] ? l : w), "ok");

export function budgetView(
  budget: Budget,
  usage: SpendInput,
  sent: Record<string, string> = {},
  agentName: (agentId: string) => string = agentNamer(undefined),
): BudgetView {
  const monthly = monthlyStatus(budget, usage);
  const repos = Object.keys(budget.perRepoUsd)
    .flatMap((repo) => {
      const s = repoStatus(budget, usage, repo);
      return s ? [{ repo, ...s }] : [];
    })
    .sort((a, b) => b.usedUsd / b.capUsd - a.usedUsd / a.capUsd || a.repo.localeCompare(b.repo));
  const alerts = reachedAlerts(budget, usage, agentName);
  return {
    monthly,
    repos,
    alertPercent: budget.alertPercent,
    alertChannel: budget.alertChannel,
    level: worst([monthly?.level ?? "ok", ...repos.map((r) => r.level), ...alerts.map((a) => a.level)]),
    alerts: alerts.map(({ covers: _covers, ...a }) => ({ ...a, ...(sent[a.key] ? { notifiedAt: sent[a.key] } : {}) })),
  };
}

const capFields = (s: CapStatus | null): Pick<AgentSpendView, "capUsd" | "remainingUsd" | "percent" | "level"> =>
  s ? { capUsd: s.capUsd, remainingUsd: s.remainingUsd, percent: s.percent, level: s.level } : { level: "ok" };

const noSpend = { usd: 0, estimated: false, tasks: 0, chats: 0, tokens: 0, unpricedTokens: 0 };

/** Every agent (Pointer first, then the team, then removed agents that still spent or have a cap) with its month and caps. */
export function agentViews(config: Pick<Config, "team" | "budget">, usage: Partial<Pick<MonthUsage, "agents">>): AgentSpendView[] {
  const { team, budget } = config;
  const spent = new Map((usage.agents ?? []).map((a) => [a.agentId, a]));
  const view = (agentId: string, name: string, extra: Partial<AgentSpendView>): AgentSpendView => ({
    agentId,
    ...noSpend,
    ...spent.get(agentId),
    name,
    lead: agentId === LEAD_AGENT_ID,
    ...extra,
    ...capFields(agentStatus(budget, usage, agentId)),
    ...(perTaskCapUsd(budget, agentId) > 0 ? { perTaskCapUsd: perTaskCapUsd(budget, agentId) } : {}),
  });
  const out = [view(LEAD_AGENT_ID, `${team.pointer.name} (lead)`, {}), ...team.agents.map((a) => view(a.id, a.name, { enabled: a.enabled, engine: a.engine }))];
  const known = new Set(out.map((a) => a.agentId));
  const others = new Set([...spent.keys(), ...Object.keys(budget.perAgentUsd), ...Object.keys(budget.perTaskAgentUsd)].filter((id) => !known.has(id)));
  for (const id of [...others].sort()) {
    const a = view(id, id, {});
    if (a.usd > 0 || a.tokens > 0 || a.capUsd || a.perTaskCapUsd) out.push(a);
  }
  return out;
}

/** The providers and engines this deployment has (connected or chosen), and any other with spend or a cap, chosen ones first. */
export function providerViews(
  config: Pick<Config, "ai" | "anthropic" | "engines" | "budget">,
  usage: Partial<Pick<MonthUsage, "providers">>,
): ProviderSpendView[] {
  const spent = new Map((usage.providers ?? []).map((p) => [p.provider, p]));
  const configured = new Set<string>([config.ai.chatProvider, config.ai.taskProvider, ...Object.keys(config.ai.providers)]);
  if (config.anthropic.apiKey) configured.add("anthropic");
  for (const id of ["codex", "gemini"] as const) if (config.engines[id].apiKey) configured.add(id);
  const ids = BUDGET_PROVIDER_IDS.filter((id) => configured.has(id) || spent.has(id) || providerCapUsd(config.budget, id) > 0);
  return ids.map((id): ProviderSpendView => {
    const engine = isEngineId(id);
    const model = engine ? config.engines[id].model : undefined;
    return {
      provider: id,
      ...noSpend,
      ...spent.get(id),
      name: providerLabel(id),
      kind: engine ? "engine" : "ai",
      configured: configured.has(id),
      ...(engine ? { model: model ?? "", priced: enginePrice(id, model) !== undefined } : {}),
      ...capFields(providerStatus(config.budget, usage, id)),
    };
  });
}

/** Cap keys of a POST /api/budget: an error message, or the caps to save (0 left out). */
export function parseCapKeys(
  caps: Record<string, number>,
  o: { what: "agent" | "task" | "provider"; agentIds: string[] },
): { ok: true; caps: Record<string, number> } | { ok: false; error: string } {
  const known = new Set(o.what === "agent" ? [LEAD_AGENT_ID, ...o.agentIds] : o.agentIds);
  const out: Record<string, number> = {};
  for (const [key, cap] of Object.entries(caps)) {
    if (o.what === "provider" ? !isBudgetProviderId(key) : !known.has(key)) {
      const error =
        o.what === "provider"
          ? `${key} is not an AI provider or coding agent CLI. Use one of: ${BUDGET_PROVIDER_IDS.join(", ")}.`
          : `${key} is not an agent on the team${o.what === "agent" ? ` (use "${LEAD_AGENT_ID}" for Pointer itself)` : ""}.`;
      return { ok: false, error };
    }
    if (cap > 0) out[key] = cap;
  }
  return { ok: true, caps: out };
}

// ---------- The service ----------

export interface SpendingDeps {
  store: Store;
  usage: UsageRepo;
  /** The current configuration, read on every check so a new cap applies at once. */
  config: () => Promise<Config>;
  /** A Slack client for the bot token, for alerts; without it no Slack alert is sent. */
  slack?: (botToken: string) => Pick<WebClient, "chat">;
  now?: () => Date;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The caps against this month's spend, for the web service and the worker.
 * A spend lookup that fails never blocks work (it is logged): the caps are a
 * brake, not a lock, and the task's own budget still bounds it.
 */
export class Spending implements TaskBudgetCheck {
  readonly alerts: AlertLog;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SpendingDeps) {
    this.alerts = new AlertLog(deps.store);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private month(config: Config): Promise<MonthUsage> {
    return this.deps.usage.month(this.now(), { chatProvider: config.ai?.chatProvider });
  }

  /** The config and this month's spend, or undefined when no cap applies (nothing is read then) or the lookup failed. */
  private async current(repo?: string): Promise<{ config: Config; usage: MonthUsage } | undefined> {
    try {
      const config = await this.deps.config();
      if (!capsApply(config.budget, repo)) return undefined;
      return { config, usage: await this.month(config) };
    } catch (err) {
      console.error("[budget] spend not checked:", errorText(err).slice(0, 200));
      return undefined;
    }
  }

  /** The providers the kind of work can run on (its route's connected ones), and Pointer's name. */
  private static context(config: Config, kind: WorkKind): DecisionContext {
    const leadName = config.team?.pointer.name;
    if (!config.ai) return { leadName };
    const providers = routeProviders(config, kind);
    return { provider: providers[0], providers, leadName };
  }

  async checkTask(repo: string): Promise<CapDecision> {
    const c = await this.current(repo);
    return c ? taskDecision(c.config.budget, c.usage, repo, Spending.context(c.config, "tasks")) : OK;
  }

  /** A chat reply, a routine run or a light call (`kind`, chat when left out): refused by the monthly, Pointer's or every route provider's cap. */
  async checkChat(kind: Exclude<WorkKind, "tasks"> = "chat"): Promise<CapDecision> {
    const c = await this.current();
    return c ? chatDecision(c.config.budget, c.usage, Spending.context(c.config, kind)) : OK;
  }

  /**
   * The worker, before the team's first run: the task's own budget, or the
   * refusal. With `provider` (the one the worker chose from the task route),
   * that provider's cap bounds it; else the route's first with enough left.
   */
  async taskBudget(repo: string, maxBudgetUsd: number, provider?: string): Promise<TaskBudget> {
    const c = await this.current(repo);
    if (!c) return { ok: true, budgetUsd: maxBudgetUsd };
    const ctx = Spending.context(c.config, "tasks");
    return taskBudgetFor(c.config.budget, c.usage, repo, maxBudgetUsd, provider ? { ...ctx, provider, providers: [provider] } : ctx);
  }

  /**
   * The worker, before the next provider of the task route takes over a
   * task: the least left of the caps that bound a task on `repo` on that
   * provider (remainingForTask: monthly, repository, the provider's own), or
   * undefined when none applies or the spend cannot be read. Never throws.
   */
  async leftFor(repo: string, provider: string): Promise<{ usd: number; scope: "monthly" | "repo" | "provider" } | undefined> {
    const c = await this.current(repo);
    return c ? remainingForTask(c.config.budget, c.usage, repo, provider) : undefined;
  }

  /**
   * Each provider's monthly cap, as routing.ts takes it (capProblem): why the
   * cap stops new work on a provider now, so the route skips it. Read once;
   * no cap applies (and nothing is read) without caps or when the spend
   * cannot be read. Never throws.
   */
  async providerCaps(work: CapWork): Promise<(provider: string) => string | undefined> {
    const c = await this.current();
    if (!c) return () => undefined;
    return (provider) => providerCapProblem(c.config.budget, c.usage, provider, work);
  }

  /** The worker, before the team is built: the agents a monthly cap leaves out of this task. Never throws. */
  async leftOut(team: Team): Promise<LeftOutAgent[]> {
    const c = await this.current();
    return c ? agentsLeftOut(c.config.budget, c.usage, team.agents) : [];
  }

  async view(): Promise<UsageView> {
    const config = await this.deps.config();
    const usage = await this.month(config);
    const sent = await this.alerts.sent(usage.month).catch(() => ({}));
    return {
      ...usage,
      agents: agentViews(config, usage),
      providers: providerViews(config, usage),
      budget: budgetView(config.budget, usage, sent, agentNamer(config.team)),
    };
  }

  /**
   * After spend was recorded (a task ended, a chat reply was counted): posts
   * the alerts this month's log does not have yet in the alert channel. Never
   * throws; an alert that could not be posted is tried again next time.
   */
  notify(): Promise<void> {
    const run = this.chain.then(() => this.sendDue());
    this.chain = run.catch(() => undefined);
    return run.catch((err: unknown) => console.error("[budget] alerts not checked:", errorText(err).slice(0, 200)));
  }

  private async sendDue(): Promise<void> {
    const config = await this.deps.config();
    const { budget } = config;
    const token = config.slack.botToken;
    const hasCap = budget.monthlyUsd > 0 || anyCap(budget.perRepoUsd) || anyCap(budget.perAgentUsd) || anyCap(budget.perProviderUsd);
    if (!hasCap || !budget.alertChannel || !token || !this.deps.slack) return;
    const now = this.now();
    const usage = await this.month(config);
    const sent = await this.alerts.sent(usage.month);
    const due = reachedAlerts(budget, usage, agentNamer(config.team)).filter((a) => !sent[a.key]);
    if (!due.length) return;
    const slack = this.deps.slack(token);
    const done: string[] = [];
    for (const alert of due) {
      try {
        await slack.chat.postMessage({ channel: budget.alertChannel, text: alertText(alert) });
        done.push(...alert.covers);
      } catch (err) {
        // The Slack error code only (e.g. channel_not_found, not_in_channel): never the token.
        console.error(`[budget] alert not posted: ${slackErrorCode(err) ?? "request failed"}`);
      }
    }
    if (done.length) await this.alerts.mark(usage.month, done, now.toISOString());
  }
}
