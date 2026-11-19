/**
 * How a repo task reads on the console: its status, checks, plan progress and
 * timings, from the server's own Task record. Shared by the Activity and
 * Overview pages.
 */
import type { StatusDotVariant } from "@astryxdesign/core/StatusDot";
import { duration, headline, plural } from "../../lib/format";
import type { CiSummary, MonthUsage, ProgressSnapshot, Task } from "../../lib/types";

export interface StatusView {
  label: string;
  variant: StatusDotVariant;
  /** One sentence: what the status means for this task. */
  description: string;
  isPulsing?: boolean;
}

export const isActive = (t: Task) => t.status === "queued" || t.status === "running";

export function taskStatus(t: Task): StatusView {
  switch (t.status) {
    case "queued":
      return { label: "Queued", variant: "neutral", description: "Waiting for a free worker." };
    case "running":
      return { label: "Running", variant: "accent", description: "The team is working on it.", isPulsing: true };
    case "done":
      if (t.kind === "blocked") return { label: "Blocked", variant: "warning", description: "The team could not go on and said why in the thread." };
      if (t.kind === "answer") return { label: "Answered", variant: "success", description: "Answered in Slack without changing code." };
      if (t.prUrl) return { label: "PR opened", variant: "success", description: "The change is in a pull request, ready for review." };
      return { label: "Done", variant: "success", description: "Finished." };
    case "failed":
      if (t.prUrl) return { label: "Stopped", variant: "warning", description: "Stopped before finishing. The work so far is in a draft pull request." };
      return { label: "Failed", variant: "error", description: "Stopped with an error." };
  }
}

export function checksView(ci: CiSummary): StatusView {
  const rounds = ci.fixRounds ? ` after ${plural(ci.fixRounds, "fix round")}` : "";
  const names = ci.names.length ? `: ${ci.names.slice(0, 3).join(", ")}${ci.names.length > 3 ? "…" : ""}` : "";
  switch (ci.state) {
    case "passed":
      return { label: "Passed", variant: "success", description: `${plural(ci.total, "check")} passed${rounds}.` };
    case "failed":
      return { label: "Failed", variant: "error", description: `Failing${rounds}${names}.` };
    case "pending":
      return { label: "Pending", variant: "warning", description: `Still running when the wait ended${names}.` };
    case "none":
      return { label: "No checks", variant: "neutral", description: "The repository has no checks." };
  }
}

/**
 * Slack markup as plain text: emoji codes (":hammer_and_wrench:") dropped,
 * mentions and links reduced to their text, inline code ticks removed.
 */
export function plainText(text: string): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/:[a-z0-9_+-]+:/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The request's first line, as plain text, for tables and lists. */
export const requestHeadline = (t: Pick<Task, "instruction">, max = 90) => headline(plainText(t.instruction.split("\n").find((l) => l.trim()) ?? ""), max) || "Untitled request";

/** "#123" from a pull request URL. */
export function prLabel(url: string): string {
  const n = url.match(/\/pull\/(\d+)/)?.[1];
  return n ? `#${n}` : "Pull request";
}

/** When the work started: the worker's own start time, else the request's. */
const startedAt = (t: Task) => t.progress?.startedAt ?? t.createdAt;

/** How long it ran ("12 min"), or has been running so far. Queued tasks have no duration yet. */
export function taskDuration(t: Task, now = Date.now()): string | undefined {
  if (t.status === "queued") return undefined;
  const end = isActive(t) ? new Date(now).toISOString() : t.updatedAt;
  return duration(startedAt(t), end);
}

export interface PlanProgress {
  done: number;
  total: number;
}

export function planProgress(p: ProgressSnapshot | undefined): PlanProgress | undefined {
  if (!p || p.plan.length === 0) return undefined;
  return { done: p.plan.filter((i) => i.status === "completed").length, total: p.plan.length };
}

/** "[12m] Coder edited src/a.ts" → { minute: "12 min", text: "Coder edited src/a.ts" } */
export function parseStep(line: string): { minute?: string; text: string } {
  const m = line.match(/^\[(\d+)m\]\s*(.*)$/);
  return m ? { minute: `${m[1]} min`, text: plainText(m[2] ?? "") } : { text: plainText(line) };
}

/** "November 2026" from "2026-11" (the server's UTC month). */
export function monthName(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

export type TopTask = MonthUsage["topTasks"][number];

export type StatusFilter = "all" | "active" | "done" | "failed";

export const STATUS_FILTERS: { value: StatusFilter; label: string; matches: (t: Task) => boolean }[] = [
  { value: "all", label: "All", matches: () => true },
  { value: "active", label: "Running", matches: isActive },
  { value: "done", label: "Done", matches: (t) => t.status === "done" },
  { value: "failed", label: "Failed", matches: (t) => t.status === "failed" },
];
