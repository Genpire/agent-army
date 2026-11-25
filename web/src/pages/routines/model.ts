/**
 * The Routines page's shapes, taken from the server's own types (type-only
 * imports), its API paths, and the example routines the empty page offers.
 */
import type { RoutineDraft, RoutineView, SchedulePreview } from "../../../../src/routines/service.js";
import type { Delivered, DeliveryOutcome, RoutineRun, RunStatus, RunSummary, RunTrigger } from "../../../../src/routines/runs.js";
import type { TickInfo } from "../../../../src/routes/routines.js";

export type { Delivered, DeliveryOutcome, RoutineDraft, RoutineRun, RoutineView, RunStatus, RunSummary, RunTrigger, SchedulePreview, TickInfo };

/** GET /api/routines */
export interface RoutineList {
  routines: RoutineView[];
  /** The organisation's timezone: new routines' default. */
  timezone: string;
  emailReady: boolean;
  max: number;
  minIntervalMin: number;
}

/** POST /api/routines and POST /api/routines/:id: the routine as config.routines holds it. */
export interface RoutineBody {
  name: string;
  instruction: string;
  schedule: { cron: string; timezone: string };
  deliver: { email: string[]; slack: string; console: boolean };
  budgetUsd: number;
  /** Minutes one run may take (1–60; the server's default is 20). */
  timeoutMin?: number;
  enabled?: boolean;
}

/** A run's time limit: the default and the most, in minutes (config.ts ROUTINE_TIMEOUT_*). */
export const ROUTINE_TIMEOUT_DEFAULT_MIN = 20;
export const ROUTINE_TIMEOUT_MAX_MIN = 60;

export const ROUTINES_PATH = "/api/routines";
export const routinePath = (id: string) => `${ROUTINES_PATH}/${encodeURIComponent(id)}`;
export const runPath = (id: string, runId: string) => `${routinePath(id)}/runs/${encodeURIComponent(runId)}`;

export const STATUS_LABEL: Record<RunStatus, string> = { running: "Running", succeeded: "Delivered", failed: "Failed", skipped: "Skipped" };
export const STATUS_VARIANT: Record<RunStatus, "info" | "success" | "error" | "warning"> = { running: "info", succeeded: "success", failed: "error", skipped: "warning" };
export const TRIGGER_LABEL: Record<RunTrigger, string> = { schedule: "Scheduled", "catch-up": "Late run", manual: "Run now" };

/** "08:00 Mon, Nov 23" in the routine's timezone. */
export function runTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Where a routine's reports go, short: "Email (2), Slack, Console". */
export function deliveryText(r: Pick<RoutineView, "deliver">): string {
  const parts: string[] = [];
  if (r.deliver.email.length) parts.push(r.deliver.email.length === 1 ? "Email" : `Email (${r.deliver.email.length})`);
  if (r.deliver.slack) parts.push("Slack");
  if (r.deliver.console) parts.push("Console");
  return parts.join(", ") || "Nowhere";
}

export interface RoutineExample {
  key: string;
  name: string;
  summary: string;
  cron: string;
  instruction: string;
}

/** Added in one click from the empty page (to the console; recipients can be added after). */
export const EXAMPLES: RoutineExample[] = [
  {
    key: "github",
    name: "Daily GitHub digest",
    summary: "Every morning at 08:00: what happened on GitHub in the last day.",
    cron: "0 8 * * *",
    instruction:
      "Summarise what happened on GitHub in the window across the repositories you can read: pull requests opened, merged and waiting for review, " +
      "issues opened and closed, and notable commits on the default branches. Group by repository, link every pull request and issue, " +
      "and end with what needs attention today (stale reviews, failing checks, blocked work).",
  },
  {
    key: "team",
    name: "Weekly team activity",
    summary: "Mondays at 09:00: last week's work in code and tickets.",
    cron: "0 9 * * 1",
    instruction:
      "Write a weekly activity report for the team covering the window: merged pull requests and what they changed, work in progress, " +
      "and tickets moved or closed in the connected trackers (Jira, monday.com, Linear) if any are connected. " +
      "Highlight wins, risks and anything stuck for more than a few days. Keep it to one screen.",
  },
  {
    key: "metrics",
    name: "Monday metrics from company data",
    summary: "Mondays at 08:30: signups, subscriptions and revenue from your data.",
    cron: "30 8 * * 1",
    instruction:
      "Using the company data sources you can read, report the key numbers for the window and the week before it: new signups, active and new subscriptions, " +
      "cancellations and revenue, with the change in percent. Show them in a small table, then three bullet points on what stands out. " +
      "If no company data source is connected, say so in one line.",
  },
];
