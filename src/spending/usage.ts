import type { Store } from "../core/store.js";
import type { Task, TaskRepo } from "../tasks/tasks.js";
import { type AgentCosts, LEAD_AGENT_ID } from "./attribution.js";

/**
 * What Claude has cost this month, so the owner can see where the credit goes.
 * Repo task costs are already on each task record (with each agent's share,
 * see attribution.ts); chat replies are tallied here per month, by agent and
 * provider (the web service, one instance, is the only writer).
 */

export interface UsageTotals {
  usd: number;
  count: number;
}

/** One repository's repo tasks this month (chat is not counted per repository). */
export interface RepoUsage extends UsageTotals {
  /** As its most recent task spells it; repositories are matched without letter case. */
  repo: string;
}

/** Totals with how they were measured. */
export interface SpendTotals {
  usd: number;
  /** Part of usd is estimated from tokens (Codex or Gemini CLI runs), not reported by the provider. */
  estimated: boolean;
  /** Repo tasks it spent in. */
  tasks: number;
  /** Chat replies (and the console's own calls) it spent in. */
  chats: number;
  tokens: number;
  /** Tokens with no dollar figure: engine runs on a model with no price here. */
  unpricedTokens: number;
}

/** One agent's month ("pointer" is Pointer itself). Tasks saved before per-agent shares existed count only in the totals. */
export interface AgentUsage extends SpendTotals {
  agentId: string;
}

/** One AI provider's or coding agent CLI's month. */
export interface ProviderUsage extends SpendTotals {
  provider: string;
}

export interface MonthUsage {
  /** "2026-11", in UTC. */
  month: string;
  chat: UsageTotals;
  tasks: UsageTotals;
  totalUsd: number;
  /** The most expensive repo tasks this month, highest first. */
  topTasks: Pick<Task, "id" | "repo" | "instruction" | "costUsd" | "createdAt">[];
  /** Repo task spend per repository this month, highest first (budget.ts checks the caps against it). */
  repos: RepoUsage[];
  /** Spend per agent this month, highest first: its shares of repo tasks and chat. */
  agents: AgentUsage[];
  /** Spend per AI provider and coding agent CLI ("codex", "gemini") this month, highest first. */
  providers: ProviderUsage[];
}

/** What one chat reply (or console call) cost, and who spent it: Pointer when no share is given. */
export interface ChatSpend {
  costUsd?: number;
  agentCosts?: AgentCosts;
  /** The provider it ran on; absent: the chat provider when the month is read. */
  provider?: string;
}

type Tally = UsageTotals & { tokens?: number };

/** The month's chat tally as stored: totals, and by agent and provider (empty in tallies saved before those existed). */
interface ChatTally extends UsageTotals {
  agents: Record<string, Tally>;
  providers: Record<string, Tally>;
}

export const monthKey = (d: Date): string => d.toISOString().slice(0, 7);

const chatKey = (month: string) => `usage/chat-${month}.json`;

/** Start of the UTC month of `d`, and of the next one, in milliseconds. */
export function monthBounds(d: Date): { from: number; to: number } {
  const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { from, to };
}

const validCost = (usd: unknown): usd is number => typeof usd === "number" && Number.isFinite(usd) && usd >= 0;
const amount = (n: unknown): number => (validCost(n) ? n : 0);
const countOf = (n: unknown): number => (typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0);

export class UsageRepo {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly tasks: TaskRepo,
  ) {}

  /**
   * Adds one chat reply (its cost, or the reply with its agents' shares and
   * provider) to this month's tally. Calls are serialised so concurrent
   * replies are all counted.
   */
  recordChat(spend: number | undefined | ChatSpend, now = new Date()): Promise<void> {
    const s: ChatSpend = typeof spend === "object" ? spend : { costUsd: spend };
    const costUsd = s.costUsd;
    if (!validCost(costUsd)) return Promise.resolve();
    const run = this.chain.then(async () => {
      const key = chatKey(monthKey(now));
      const current = await this.readChat(key);
      const shares = Object.entries(s.agentCosts ?? {}).filter(([, c]) => validCost(c?.usd));
      const byAgent: [string, { usd: number; tokens?: number }][] = shares.length ? shares : [[LEAD_AGENT_ID, { usd: costUsd }]];
      for (const [agent, c] of byAgent) {
        const a = (current.agents[agent] ??= { usd: 0, count: 0 });
        a.usd += c.usd;
        a.count += 1;
        if (amount(c.tokens) > 0) a.tokens = (a.tokens ?? 0) + amount(c.tokens);
      }
      if (s.provider) {
        const p = (current.providers[s.provider] ??= { usd: 0, count: 0 });
        p.usd += costUsd;
        p.count += 1;
      }
      await this.store.put(
        key,
        JSON.stringify({ usd: current.usd + costUsd, count: current.count + 1, agents: current.agents, providers: current.providers }),
      );
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** This month's spend. Chat cost not tied to a provider (older tallies, calls without one) counts for `chatProvider`. */
  async month(now = new Date(), opts: { chatProvider?: string } = {}): Promise<MonthUsage> {
    const month = monthKey(now);
    const { from, to } = monthBounds(now);
    const [tally, tasks] = await Promise.all([this.readChat(chatKey(month)), this.tasks.between(from, to)]);
    const chat: UsageTotals = { usd: tally.usd, count: tally.count };
    const costed = tasks.filter((t) => validCost(t.costUsd));
    const taskUsd = costed.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
    const topTasks = [...costed]
      .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
      .slice(0, 5)
      .map(({ id, repo, instruction, costUsd, createdAt }) => ({ id, repo, instruction, costUsd, createdAt }));
    return {
      month,
      chat,
      tasks: { usd: taskUsd, count: tasks.length },
      totalUsd: chat.usd + taskUsd,
      topTasks,
      repos: repoTotals(tasks),
      agents: agentTotals(tasks, tally),
      providers: providerTotals(tasks, tally, opts.chatProvider ?? "anthropic"),
    };
  }

  private async readChat(key: string): Promise<ChatTally> {
    const empty = (): ChatTally => ({ usd: 0, count: 0, agents: {}, providers: {} });
    const blob = await this.store.get(key);
    if (!blob) return empty();
    try {
      const data = JSON.parse(blob.toString("utf8")) as Partial<Record<keyof ChatTally, unknown>>;
      return { usd: amount(data.usd), count: countOf(data.count), agents: tallies(data.agents), providers: tallies(data.providers) };
    } catch {
      return empty();
    }
  }
}

/** A stored record of totals, without anything malformed. */
function tallies(value: unknown): Record<string, Tally> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, Tally> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const t = v as Record<string, unknown>;
    if (!validCost(t.usd)) continue;
    out[key] = { usd: t.usd, count: countOf(t.count), ...(amount(t.tokens) > 0 ? { tokens: amount(t.tokens) } : {}) };
  }
  return out;
}

/** Repo task totals per repository (matched without letter case), highest spend first. */
export function repoTotals(tasks: Pick<Task, "id" | "repo" | "costUsd">[]): RepoUsage[] {
  const byRepo = new Map<string, RepoUsage & { newest: string }>();
  for (const t of tasks) {
    const key = t.repo.toLowerCase();
    const cost = validCost(t.costUsd) ? t.costUsd : 0;
    const entry = byRepo.get(key);
    if (!entry) {
      byRepo.set(key, { repo: t.repo, usd: cost, count: 1, newest: t.id });
      continue;
    }
    entry.usd += cost;
    entry.count += 1;
    if (t.id > entry.newest) {
      entry.newest = t.id;
      entry.repo = t.repo;
    }
  }
  return [...byRepo.values()]
    .map(({ repo, usd: total, count }) => ({ repo, usd: total, count }))
    .sort((a, b) => b.usd - a.usd || a.repo.localeCompare(b.repo));
}

const blank = (): SpendTotals => ({ usd: 0, estimated: false, tasks: 0, chats: 0, tokens: 0, unpricedTokens: 0 });

/** A map that makes an entry on first use. */
function totalsBy<T extends SpendTotals>(make: (key: string) => T) {
  const by = new Map<string, T>();
  return {
    get(key: string): T {
      let e = by.get(key);
      if (!e) by.set(key, (e = make(key)));
      return e;
    },
    sorted(name: (t: T) => string): T[] {
      return [...by.values()].sort((a, b) => b.usd - a.usd || name(a).localeCompare(name(b)));
    },
  };
}

/** Per agent: each task's shares (tasks saved before shares existed are left out) and the chat tally's (Pointer's when none). */
export function agentTotals(tasks: Pick<Task, "agentCosts">[], chat: Pick<ChatTally, "usd" | "count" | "agents">): AgentUsage[] {
  const by = totalsBy<AgentUsage>((agentId) => ({ agentId, ...blank() }));
  for (const t of tasks) {
    for (const [agentId, c] of Object.entries(t.agentCosts ?? {})) {
      if (!c) continue;
      const e = by.get(agentId);
      e.usd += amount(c.usd);
      e.tasks += 1;
      if (c.estimated) e.estimated = true;
      e.tokens += amount(c.tokens);
      e.unpricedTokens += amount(c.unpricedTokens);
    }
  }
  let shared = 0;
  for (const [agentId, a] of Object.entries(chat.agents)) {
    const e = by.get(agentId);
    e.usd += a.usd;
    e.chats += a.count;
    e.tokens += a.tokens ?? 0;
    shared += a.usd;
  }
  // Tallies from before per-agent shares: Pointer answered them.
  const rest = chat.usd - shared;
  if (rest > 1e-9) {
    const lead = by.get(LEAD_AGENT_ID);
    lead.usd += rest;
    if (!Object.keys(chat.agents).length) lead.chats += chat.count;
  }
  return by.sorted((a) => a.agentId);
}

/** Per provider: each repo task's Claude cost on the provider it ran on, its engine runs' estimates, and chat. */
export function providerTotals(
  tasks: Pick<Task, "costUsd" | "provider" | "agentCosts">[],
  chat: Pick<ChatTally, "usd" | "count" | "providers">,
  chatProvider: string,
): ProviderUsage[] {
  const by = totalsBy<ProviderUsage>((provider) => ({ provider, ...blank() }));
  for (const t of tasks) {
    const own = by.get(t.provider ?? "anthropic");
    own.usd += amount(t.costUsd);
    own.tasks += 1;
    const engines = new Set<string>();
    for (const c of Object.values(t.agentCosts ?? {})) {
      if (!c) continue;
      let engineTokens = 0;
      for (const [id, run] of Object.entries(c.engines ?? {})) {
        if (!run) continue;
        const e = by.get(id);
        e.tokens += amount(run.tokens);
        engineTokens += amount(run.tokens);
        if (validCost(run.usd)) e.usd += run.usd;
        else e.unpricedTokens += amount(run.tokens);
        e.estimated = true;
        if (!engines.has(id)) {
          engines.add(id);
          e.tasks += 1;
        }
      }
      own.tokens += Math.max(0, amount(c.tokens) - engineTokens);
    }
  }
  let labelled = 0;
  let labelledCount = 0;
  for (const [provider, p] of Object.entries(chat.providers)) {
    const e = by.get(provider);
    e.usd += p.usd;
    e.chats += p.count;
    labelled += p.usd;
    labelledCount += p.count;
  }
  // Replies recorded without a provider: the chat provider's.
  const rest = chat.usd - labelled;
  if (rest > 1e-9) {
    const e = by.get(chatProvider);
    e.usd += rest;
    e.chats += Math.max(0, chat.count - labelledCount);
  }
  return by.sorted((p) => p.provider).filter((p) => p.usd > 0 || p.tasks > 0 || p.chats > 0 || p.tokens > 0);
}

/** What repo tasks on `repo` cost this month (0 when none ran), matched without letter case. */
export const repoSpend = (u: Pick<MonthUsage, "repos">, repo: string): number =>
  u.repos.find((r) => r.repo.toLowerCase() === repo.toLowerCase())?.usd ?? 0;

/** What an agent spent this month (0 when nothing). */
export const agentSpend = (u: Pick<MonthUsage, "agents">, agentId: string): number => u.agents.find((a) => a.agentId === agentId)?.usd ?? 0;

/** What a provider or engine cost this month (0 when nothing). */
export const providerSpend = (u: Pick<MonthUsage, "providers">, provider: string): number =>
  u.providers.find((p) => p.provider === provider)?.usd ?? 0;

/** "$12.34". */
export const usd = (n: number): string => `$${n.toFixed(2)}`;

/** One line for Slack's `status` command. */
export function usageLine(u: MonthUsage): string {
  return `${usd(u.totalUsd)} (chat ${usd(u.chat.usd)} over ${u.chat.count} replies · repo tasks ${usd(u.tasks.usd)} over ${u.tasks.count} tasks)`;
}
