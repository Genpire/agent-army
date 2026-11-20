import type { WebClient } from "@slack/web-api";
import type { Budget, Config } from "../core/config.js";
import { slackErrorCode } from "../slack.js";
import type { Store } from "../core/store.js";
import { type MonthUsage, type UsageRepo, repoSpend, usd } from "./usage.js";

/**
 * Spending caps: a monthly Claude budget for chat and repo tasks together,
 * and optional monthly caps per repository (repo tasks only). New repo tasks
 * are refused when a cap is used up (every start path asks startThreadTask,
 * which asks `checkTask`), chat replies when the monthly cap is; a task's own
 * budget never exceeds what is left. Running tasks are never stopped by a cap:
 * their own budget already bounds them. A cap of 0 means no cap.
 *
 * Alerts: when a cap reaches `alertPercent` and again at 100%, one Slack
 * message in `alertChannel` per level per month (the log is in the store), and
 * a banner in the console (from `view`).
 */

/** A repo task needs at least this much of a cap left to start: less would stop it after a step or two. */
export const MIN_TASK_USD = 0.5;

/** Where the owner changes the caps, for every message about them. */
const WHERE = "The owner can raise the cap in the admin console under Settings → Spending.";

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

/** True when some cap applies to a task on `repo` (else nothing needs to be read). */
export const capsApply = (budget: Budget, repo?: string): boolean => budget.monthlyUsd > 0 || (repo !== undefined && repoCapUsd(budget, repo) > 0);

export const monthlyStatus = (budget: Budget, usage: Pick<MonthUsage, "totalUsd">): CapStatus | null =>
  capStatus(budget.monthlyUsd, usage.totalUsd, budget.alertPercent);

export const repoStatus = (budget: Budget, usage: Pick<MonthUsage, "repos">, repo: string): CapStatus | null =>
  capStatus(repoCapUsd(budget, repo), repoSpend(usage, repo), budget.alertPercent);

function usedUp(what: string, spentOn: string, s: CapStatus, refused: string, forTask: boolean): string {
  const left = forTask && s.remainingUsd > 0 ? ` Only ${usd(s.remainingUsd)} is left, less than the ${usd(MIN_TASK_USD)} a repo task needs.` : "";
  return `${what} is used up: ${usd(s.usedUsd)} of the ${usd(s.capUsd)} cap spent on ${spentOn}.${left} ${refused} until the month ends (UTC). ${WHERE}`;
}

const MONTHLY = "This month's Claude budget";
const SPENT_MONTHLY = "chat and repo tasks";

/** Whether a new repo task on `repo` may start: refused when the monthly or the repository's cap has less than MIN_TASK_USD left. */
export function taskDecision(budget: Budget, usage: Pick<MonthUsage, "totalUsd" | "repos">, repo: string): CapDecision {
  const monthly = monthlyStatus(budget, usage);
  if (monthly && monthly.remainingUsd < MIN_TASK_USD) {
    return { ok: false, error: usedUp(MONTHLY, SPENT_MONTHLY, monthly, "New repo tasks are refused", true) };
  }
  const own = repoStatus(budget, usage, repo);
  if (own && own.remainingUsd < MIN_TASK_USD) {
    return { ok: false, error: usedUp(`The monthly budget for ${repo}`, `its repo tasks`, own, `New tasks on ${repo} are refused`, true) };
  }
  return OK;
}

/** Whether a chat reply may start: refused once the monthly cap is used up. */
export function chatDecision(budget: Budget, usage: Pick<MonthUsage, "totalUsd">): CapDecision {
  const monthly = monthlyStatus(budget, usage);
  if (monthly && monthly.remainingUsd <= 0) {
    return { ok: false, error: usedUp(MONTHLY, SPENT_MONTHLY, monthly, "Chat replies and new repo tasks are refused", false) };
  }
  return OK;
}

/** The least left of the caps that apply to a task on `repo`, or undefined when none applies. */
export function remainingForTask(
  budget: Budget,
  usage: Pick<MonthUsage, "totalUsd" | "repos">,
  repo: string,
): { usd: number; scope: "monthly" | "repo" } | undefined {
  const monthly = monthlyStatus(budget, usage);
  const own = repoStatus(budget, usage, repo);
  if (!monthly && !own) return undefined;
  if (monthly && (!own || monthly.remainingUsd <= own.remainingUsd)) return { usd: monthly.remainingUsd, scope: "monthly" };
  return { usd: own!.remainingUsd, scope: "repo" };
}

export type TaskBudget = { ok: true; budgetUsd: number; note?: string } | { ok: false; error: string };

/**
 * A repo task's own budget: the per-task budget, lowered to what is left of
 * the caps that apply (rounded down to the cent), or the refusal when too
 * little is left. `note` says why it was lowered (for the task's timeline).
 */
export function taskBudgetFor(budget: Budget, usage: Pick<MonthUsage, "totalUsd" | "repos">, repo: string, maxBudgetUsd: number): TaskBudget {
  const decision = taskDecision(budget, usage, repo);
  if (!decision.ok) return decision;
  const left = remainingForTask(budget, usage, repo);
  if (!left || left.usd >= maxBudgetUsd) return { ok: true, budgetUsd: maxBudgetUsd };
  const budgetUsd = Math.floor(left.usd * 100) / 100;
  const of = left.scope === "monthly" ? "this month's Claude budget" : `the monthly budget for ${repo}`;
  return { ok: true, budgetUsd, note: `This task may spend ${usd(budgetUsd)}: what is left of ${of} (the per-task budget is ${usd(maxBudgetUsd)}).` };
}

// ---------- Alerts ----------

export interface BudgetAlert {
  /** Identifies the alert in the month's log: scope, level, threshold and cap, so a new cap or threshold alerts again. */
  key: string;
  /** Keys this alert settles in the log: reaching 100% at once settles the alert level too. */
  covers: string[];
  scope: "monthly" | "repo";
  /** For a repository's cap, as it is saved. */
  repo?: string;
  level: "alert" | "exceeded";
  capUsd: number;
  usedUsd: number;
  percent: number;
}

/** The level each cap has reached this month, at most one alert per cap (the higher level). */
export function reachedAlerts(budget: Budget, usage: Pick<MonthUsage, "totalUsd" | "repos">): BudgetAlert[] {
  const out: BudgetAlert[] = [];
  const add = (scope: BudgetAlert["scope"], repo: string | undefined, s: CapStatus | null) => {
    if (!s || s.level === "ok") return;
    const base = scope === "monthly" ? "monthly" : `repo:${(repo ?? "").toLowerCase()}`;
    const alertKey = `${base}|alert@${budget.alertPercent}%|$${s.capUsd}`;
    const fullKey = `${base}|exceeded|$${s.capUsd}`;
    const exceeded = s.level === "exceeded";
    out.push({
      key: exceeded ? fullKey : alertKey,
      covers: exceeded ? [fullKey, alertKey] : [alertKey],
      scope,
      ...(repo ? { repo } : {}),
      level: exceeded ? "exceeded" : "alert",
      capUsd: s.capUsd,
      usedUsd: s.usedUsd,
      percent: s.percent,
    });
  };
  add("monthly", undefined, monthlyStatus(budget, usage));
  for (const repo of Object.keys(budget.perRepoUsd).sort()) add("repo", repo, repoStatus(budget, usage, repo));
  return out;
}

const CHANGE = "Change the cap or this alert in the admin console under Settings → Spending.";

/** The Slack message for an alert (mrkdwn). */
export function alertText(a: Pick<BudgetAlert, "scope" | "repo" | "level" | "capUsd" | "usedUsd" | "percent">): string {
  const spent = `${usd(a.usedUsd)} of ${usd(a.capUsd)}`;
  if (a.scope === "monthly") {
    return a.level === "exceeded"
      ? `:no_entry: This month's Claude spending cap is used up: ${spent} (chat and repo tasks). New repo tasks and chat replies are refused until the month ends (UTC); running tasks finish. ${WHERE}`
      : `:warning: Claude spending is at ${a.percent}% of this month's cap: ${spent} (chat and repo tasks). At the cap, new repo tasks and chat replies are refused until the month ends (UTC). ${CHANGE}`;
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

/** GET /api/usage: this month's spend with the caps. */
export type UsageView = MonthUsage & { budget: BudgetView };

const LEVEL_RANK: Record<CapLevel, number> = { ok: 0, alert: 1, exceeded: 2 };

export function budgetView(budget: Budget, usage: Pick<MonthUsage, "totalUsd" | "repos">, sent: Record<string, string> = {}): BudgetView {
  const monthly = monthlyStatus(budget, usage);
  const repos = Object.keys(budget.perRepoUsd)
    .flatMap((repo) => {
      const s = repoStatus(budget, usage, repo);
      return s ? [{ repo, ...s }] : [];
    })
    .sort((a, b) => b.usedUsd / b.capUsd - a.usedUsd / a.capUsd || a.repo.localeCompare(b.repo));
  const levels = [monthly?.level ?? "ok", ...repos.map((r) => r.level)];
  const level = levels.reduce<CapLevel>((worst, l) => (LEVEL_RANK[l] > LEVEL_RANK[worst] ? l : worst), "ok");
  return {
    monthly,
    repos,
    alertPercent: budget.alertPercent,
    alertChannel: budget.alertChannel,
    level,
    alerts: reachedAlerts(budget, usage).map(({ covers: _covers, ...a }) => ({ ...a, ...(sent[a.key] ? { notifiedAt: sent[a.key] } : {}) })),
  };
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

  /** The config and this month's spend, or undefined when no cap applies (nothing is read then) or the lookup failed. */
  private async current(repo?: string): Promise<{ config: Config; usage: MonthUsage } | undefined> {
    try {
      const config = await this.deps.config();
      if (!capsApply(config.budget, repo)) return undefined;
      return { config, usage: await this.deps.usage.month(this.now()) };
    } catch (err) {
      console.error("[budget] spend not checked:", errorText(err).slice(0, 200));
      return undefined;
    }
  }

  async checkTask(repo: string): Promise<CapDecision> {
    const c = await this.current(repo);
    return c ? taskDecision(c.config.budget, c.usage, repo) : OK;
  }

  async checkChat(): Promise<CapDecision> {
    const c = await this.current();
    return c ? chatDecision(c.config.budget, c.usage) : OK;
  }

  /** The worker, before the team's first run: the task's own budget, or the refusal. */
  async taskBudget(repo: string, maxBudgetUsd: number): Promise<TaskBudget> {
    const c = await this.current(repo);
    return c ? taskBudgetFor(c.config.budget, c.usage, repo, maxBudgetUsd) : { ok: true, budgetUsd: maxBudgetUsd };
  }

  async view(): Promise<UsageView> {
    const now = this.now();
    const [config, usage] = await Promise.all([this.deps.config(), this.deps.usage.month(now)]);
    const sent = await this.alerts.sent(usage.month).catch(() => ({}));
    return { ...usage, budget: budgetView(config.budget, usage, sent) };
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
    const hasCap = budget.monthlyUsd > 0 || Object.values(budget.perRepoUsd).some((cap) => cap > 0);
    if (!hasCap || !budget.alertChannel || !token || !this.deps.slack) return;
    const now = this.now();
    const usage = await this.deps.usage.month(now);
    const sent = await this.alerts.sent(usage.month);
    const due = reachedAlerts(budget, usage).filter((a) => !sent[a.key]);
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
