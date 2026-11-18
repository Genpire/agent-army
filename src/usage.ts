import type { Store } from "./store.js";
import type { Task, TaskRepo } from "./tasks.js";

/**
 * What Claude has cost this month, so the owner can see where the credit goes.
 * Repo task costs are already on each task record; chat replies are tallied
 * here per month (the web service, one instance, is the only writer).
 */

export interface UsageTotals {
  usd: number;
  count: number;
}

export interface MonthUsage {
  /** "2026-11", in UTC. */
  month: string;
  chat: UsageTotals;
  tasks: UsageTotals;
  totalUsd: number;
  /** The most expensive repo tasks this month, highest first. */
  topTasks: Pick<Task, "id" | "repo" | "instruction" | "costUsd" | "createdAt">[];
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

export class UsageRepo {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly tasks: TaskRepo,
  ) {}

  /** Adds one chat reply to this month's tally. Calls are serialised so concurrent replies are all counted. */
  recordChat(costUsd: number | undefined, now = new Date()): Promise<void> {
    if (!validCost(costUsd)) return Promise.resolve();
    const run = this.chain.then(async () => {
      const key = chatKey(monthKey(now));
      const current = await this.readChat(key);
      await this.store.put(key, JSON.stringify({ usd: current.usd + costUsd, count: current.count + 1 }));
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  async month(now = new Date()): Promise<MonthUsage> {
    const month = monthKey(now);
    const { from, to } = monthBounds(now);
    const [chat, tasks] = await Promise.all([this.readChat(chatKey(month)), this.tasks.between(from, to)]);
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
    };
  }

  private async readChat(key: string): Promise<UsageTotals> {
    const blob = await this.store.get(key);
    if (!blob) return { usd: 0, count: 0 };
    try {
      const data = JSON.parse(blob.toString("utf8")) as Partial<UsageTotals>;
      return { usd: validCost(data.usd) ? data.usd : 0, count: Number.isInteger(data.count) ? (data.count as number) : 0 };
    } catch {
      return { usd: 0, count: 0 };
    }
  }
}

/** "$12.34". */
export const usd = (n: number): string => `$${n.toFixed(2)}`;

/** One line for Slack's `status` command. */
export function usageLine(u: MonthUsage): string {
  return `${usd(u.totalUsd)} (chat ${usd(u.chat.usd)} over ${u.chat.count} replies · repo tasks ${usd(u.tasks.usd)} over ${u.tasks.count} tasks)`;
}
