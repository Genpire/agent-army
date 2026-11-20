/**
 * This month's spend with the caps (GET /api/usage), shared by the Overview
 * page and Settings → Spending. Types come from the server (type-only).
 */
import type { BudgetView, CapLevel, CapStatus, UsageView } from "../../../../src/spending/budget.js";
import { usd } from "../../lib/format";
import { type Polled, USAGE_EVERY_MS, usePolled } from "../activity/usePolled";

export type { BudgetView, CapLevel, CapStatus, UsageView };
export type BudgetAlertView = BudgetView["alerts"][number];

/** GET /api/usage: spend this calendar month (UTC), the caps and their alerts. */
export const useSpending = (): Polled<UsageView> => usePolled<UsageView>("/api/usage", USAGE_EVERY_MS);

/** A cap's progress bar colour by level. */
export const CAP_VARIANT: Record<CapLevel, "accent" | "warning" | "error"> = { ok: "accent", alert: "warning", exceeded: "error" };

/** "$41.00 of $50.00 · 82%". */
export const capLine = (s: Pick<CapStatus, "usedUsd" | "capUsd" | "percent">): string => `${usd(s.usedUsd)} of ${usd(s.capUsd)} · ${s.percent}%`;

/** "$9.00 left", or "Used up". */
export const capLeft = (s: Pick<CapStatus, "remainingUsd" | "level">): string => (s.level === "exceeded" ? "Used up" : `${usd(s.remainingUsd)} left`);

/** One sentence for a banner: which cap, how far it is used, and what is refused. */
export function alertSentence(a: BudgetAlertView): string {
  const what = a.scope === "monthly" ? "This month's budget" : `${a.repo ?? "A repository"}'s monthly cap`;
  const spent = `${usd(a.usedUsd)} of ${usd(a.capUsd)}`;
  if (a.level === "exceeded") {
    const refused = a.scope === "monthly" ? "new repo tasks and chat replies are refused" : "new tasks there are refused";
    return `${what} is used up (${spent}): ${refused} until the month ends (UTC).`;
  }
  return `${what} is ${a.percent}% used (${spent}).`;
}
