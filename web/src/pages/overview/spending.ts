/**
 * This month's spend with the caps (GET /api/usage), shared by the Overview
 * page, Activity, the Team page and Settings → Spending. Types come from the
 * server (type-only).
 */
import type { AgentCost, AgentCosts } from "../../../../src/spending/attribution.js";
import type { AgentSpendView, BudgetView, CapLevel, CapStatus, ProviderSpendView, UsageView } from "../../../../src/spending/budget.js";
import { api } from "../../lib/api";
import { usd } from "../../lib/format";
import type { PublicConfig } from "../../lib/types";
import { type Polled, USAGE_EVERY_MS, usePolled } from "../activity/usePolled";

export type { AgentCost, AgentCosts, AgentSpendView, BudgetView, CapLevel, CapStatus, ProviderSpendView, UsageView };
export type BudgetAlertView = BudgetView["alerts"][number];
type Budget = PublicConfig["budget"];

/** Pointer's own share: its agent id in the caps and in task costs. */
export const LEAD_ID = "pointer";

/** Mirrors BudgetSchema (src/core/config.ts); the server checks again. */
export const CAP_MAX = 100_000;
export const CAP_ERROR = `Use an amount from 0 (no cap) to ${CAP_MAX.toLocaleString()}.`;
export const capError = (n: number) => (!Number.isFinite(n) || n < 0 || n > CAP_MAX ? CAP_ERROR : undefined);

/** GET /api/usage: spend this calendar month (UTC), the caps and their alerts. */
export const useSpending = (): Polled<UsageView> => usePolled<UsageView>("/api/usage", USAGE_EVERY_MS);

/** A cap's progress bar colour by level. */
export const CAP_VARIANT: Record<CapLevel, "accent" | "warning" | "error"> = { ok: "accent", alert: "warning", exceeded: "error" };

/** "$41.00 of $50.00 · 82%". */
export const capLine = (s: Pick<CapStatus, "usedUsd" | "capUsd" | "percent">): string => `${usd(s.usedUsd)} of ${usd(s.capUsd)} · ${s.percent}%`;

/** "$9.00 left", or "Used up". */
export const capLeft = (s: Pick<CapStatus, "remainingUsd" | "level">): string => (s.level === "exceeded" ? "Used up" : `${usd(s.remainingUsd)} left`);

/** "950 tokens", "12k tokens", "3.4M tokens". */
export function tokenCount(n: number): string {
  const word = n === 1 ? "token" : "tokens";
  if (n < 1_000) return `${Math.round(n)} ${word}`;
  if (n < 1_000_000) return `${n < 10_000 ? (n / 1_000).toFixed(1) : Math.round(n / 1_000)}k ${word}`;
  return `${(n / 1_000_000).toFixed(1)}M ${word}`;
}

/** An amount as it was measured: "$1.20", "~$1.20 (estimated)", and "+ 12k tokens without a price" for engine runs on a model with no price. */
export function spendText(s: { usd: number; estimated?: boolean; unpricedTokens?: number }): string {
  const amount = s.estimated ? `~${usd(s.usd)} (estimated)` : usd(s.usd);
  return s.unpricedTokens ? `${amount} + ${tokenCount(s.unpricedTokens)} without a price` : amount;
}

/** An agent's or provider's spend against its cap: "~$3.10 (estimated) of $20.00 · 15%", or "$3.10 this month". */
export function spendAgainstCap(s: { usd: number; estimated?: boolean; unpricedTokens?: number; capUsd?: number; percent?: number }): string {
  return s.capUsd ? `${spendText(s)} of ${usd(s.capUsd)} · ${s.percent ?? 0}%` : `${spendText(s)} this month`;
}

/** An agent's name in costs: the team's, "<Pointer> (lead)" for Pointer itself, else its id (a removed agent). */
export function agentDisplayName(team: PublicConfig["team"], agentId: string): string {
  if (agentId === LEAD_ID) return `${team.pointer.name} (lead)`;
  return team.agents.find((a) => a.id === agentId)?.name ?? agentId;
}

/** A task's (or reply's) shares, highest first. */
export const costRows = (costs: AgentCosts | undefined): (AgentCost & { agentId: string })[] =>
  Object.entries(costs ?? {})
    .map(([agentId, c]) => ({ agentId, ...c }))
    .sort((a, b) => b.usd - a.usd || (b.tokens ?? 0) - (a.tokens ?? 0));

/** The caps to send for one field of POST /api/budget: only keys the server accepts (current agents or providers), 0 left out. */
export function capsFor(caps: Record<string, number>, keys: Iterable<string>): Record<string, number> {
  const known = new Set(keys);
  return Object.fromEntries(Object.entries(caps).filter(([k, v]) => known.has(k) && v > 0));
}

/** Saves an agent's monthly and per-task caps (0 = none), keeping the other agents' caps. */
export async function saveAgentCaps(budget: Budget, agentIds: string[], agentId: string, caps: { monthlyUsd: number; perTaskUsd: number }): Promise<void> {
  const ids = [...new Set([...agentIds, agentId])];
  await api.post("/api/budget", {
    perAgentUsd: capsFor({ ...budget.perAgentUsd, [agentId]: caps.monthlyUsd }, [LEAD_ID, ...ids]),
    ...(agentId === LEAD_ID ? {} : { perTaskAgentUsd: capsFor({ ...budget.perTaskAgentUsd, [agentId]: caps.perTaskUsd }, ids) }),
  });
}

const isEngine = (provider: string | undefined) => provider === "codex" || provider === "gemini";

/** One sentence for a banner: which cap, how far it is used, and what is refused. */
export function alertSentence(a: BudgetAlertView): string {
  const spent = `${usd(a.usedUsd)} of ${usd(a.capUsd)}`;
  const name = a.name ?? a.agentId ?? a.provider ?? "";
  const what =
    a.scope === "monthly"
      ? "This month's budget"
      : a.scope === "repo"
        ? `${a.repo ?? "A repository"}'s monthly cap`
        : a.scope === "agent"
          ? `${name}'s monthly budget`
          : `The monthly budget for ${name}`;
  if (a.level === "exceeded") {
    const refused =
      a.scope === "monthly"
        ? "new repo tasks and chat replies are refused"
        : a.scope === "repo"
          ? "new tasks there are refused"
          : a.scope === "agent"
            ? a.agentId === LEAD_ID
              ? "new repo tasks and chat replies are refused"
              : `${name} is left out of new repo tasks`
            : isEngine(a.provider)
              ? `agents working through ${name} are left out of new repo tasks`
              : `new repo tasks and chat replies on ${name} are refused`;
    return `${what} is used up (${spent}): ${refused} until the month ends (UTC).`;
  }
  return `${what} is ${a.percent}% used (${spent}).`;
}
