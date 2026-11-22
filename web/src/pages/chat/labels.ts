/**
 * Pure helpers for the Chat page: display labels, task status, tool-call rows
 * and repository suggestions. No React here.
 */
import type { ChatToolCallItem } from "@astryxdesign/core/Chat";
import type { ActivityKind, ActivityStep, PublicConfig, Task, TaskEvent, TaskPhase } from "../../lib/types";

/** Slack emoji codes out of server labels: ":hammer_and_wrench: Sara (Coder)" → "Sara (Coder)". */
export function plainLabel(text: string | undefined): string {
  return (text ?? "")
    .replace(/(^|\s):[a-z0-9_+-]+:(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export const isActiveTask = (t: Pick<Task, "status">) => t.status === "queued" || t.status === "running";

export type StatusTone = "neutral" | "info" | "success" | "warning" | "error";

/** What a task card's badge says. */
export function taskStatus(t: Task): { label: string; tone: StatusTone } {
  switch (t.status) {
    case "queued":
      return { label: "Queued", tone: "neutral" };
    case "running":
      return { label: "Working", tone: "info" };
    case "failed":
      return t.prUrl ? { label: "Stopped", tone: "warning" } : { label: "Failed", tone: "error" };
    case "done":
      if (t.kind === "blocked") return { label: "Blocked", tone: "warning" };
      if (t.kind === "answer") return { label: "Answered", tone: "info" };
      return { label: "Done", tone: "success" };
  }
}

/** The checks line of a task card, or null when there is nothing to say. */
export function checksStatus(t: Task): { label: string; tone: StatusTone } | null {
  if (t.fixRound && isActiveTask(t)) {
    return { label: `Fixing failing checks (round ${t.fixRound.round} of ${t.fixRound.rounds})`, tone: "warning" };
  }
  if (isActiveTask(t) && t.stage?.phase === "checks") return { label: "Waiting for checks", tone: "info" };
  const ci = t.ci;
  if (!ci || ci.state === "none") return null;
  const after = ci.fixRounds ? ` after ${ci.fixRounds} fix round${ci.fixRounds === 1 ? "" : "s"}` : "";
  if (ci.state === "passed") return { label: `Checks passed${after}`, tone: "success" };
  if (ci.state === "failed") return { label: `${ci.names.length || "Some"} check${ci.names.length === 1 ? "" : "s"} failing${after}`, tone: "error" };
  return { label: "Checks still running", tone: "warning" };
}

type Recheck = NonNullable<Task["recheck"]>;
type RecheckOutcome = Recheck["checks"][number]["outcome"];

const RECHECK_OUTCOME: Record<RecheckOutcome, { label: string; tone: StatusTone }> = {
  passed: { label: "Passed", tone: "success" },
  failed: { label: "Failed", tone: "error" },
  "no-result": { label: "No result", tone: "warning" },
  "timed-out": { label: "Timed out", tone: "warning" },
  "not-started": { label: "Could not start", tone: "error" },
  "not-run": { label: "Not run", tone: "neutral" },
};
const CLAIM_LABEL = { pass: "passed", fail: "failed", "no-result": "no result" } as const;

/**
 * The checks the platform ran again after the team (src/tasks/recheck.ts), one
 * row each: its real result, and what the team said about it, with a warning
 * when the team said it passed and the platform's run did not confirm it.
 */
export function recheckRows(r: Recheck): { command: string; label: string; tone: StatusTone; description: string }[] {
  return r.checks.map((c) => {
    const claim = c.claimed ? `The team said: ${CLAIM_LABEL[c.claimed]}` : "The team did not report it";
    const doubted = r.mismatches.includes(c.command);
    const held = !doubted ? "" : c.outcome === "passed" ? " · did not pass before the fix round" : " · not as the team reported";
    const outcome = RECHECK_OUTCOME[c.outcome];
    return {
      command: c.command,
      label: outcome.label,
      tone: doubted && c.outcome !== "passed" ? "error" : outcome.tone,
      description: [`${claim}${held}`, c.note, c.ms !== undefined && c.outcome !== "not-run" ? formatMs(c.ms) : ""].filter(Boolean).join(" · "),
    };
  });
}

/** What the preview check found, in a few words; null when there is no result (not run yet, or an older task). */
export function previewStatus(t: Pick<Task, "preview">): { label: string; tone: StatusTone; note?: string; url?: string } | null {
  const p = t.preview;
  if (!p) return null;
  const rest = { ...(p.note ? { note: plainLabel(p.note) } : {}), ...(p.url && /^https?:\/\//.test(p.url) ? { url: p.url } : {}) };
  switch (p.state) {
    case "checked":
      return { label: "Preview looks right", tone: "success", ...rest };
    case "problems":
      return { label: "Problems on the preview", tone: "warning", ...rest };
    case "unavailable":
      return { label: "Preview not checked", tone: "neutral", ...rest };
    case "skipped":
      return { label: "Preview not needed", tone: "neutral", ...rest };
  }
}

const SIZE_NAME = { small: "Small", medium: "Medium", large: "Large" } as const;

/** "$1.20–$3.50", or "" without an estimate. */
export function estimateRange(t: Pick<Task, "estimateUsd">): string {
  const e = t.estimateUsd;
  if (!e || !Number.isFinite(e.low) || !Number.isFinite(e.high)) return "";
  return e.low === e.high ? `$${e.low.toFixed(2)}` : `$${e.low.toFixed(2)}–$${e.high.toFixed(2)}`;
}

/** "Medium task · est. $1.20–$3.50" for the task card, or "" when neither is known. */
export function sizeLine(t: Pick<Task, "size" | "estimateUsd">): string {
  const size = t.size ? `${SIZE_NAME[t.size.size] ?? t.size.size} task` : "";
  const estimate = estimateRange(t);
  return [size, estimate && `est. ${estimate}`].filter(Boolean).join(" · ");
}

/** "Medium · claude-sonnet-5-5, medium effort" for the task's details, or "" when it was not sized. */
export function sizeDetail(t: Pick<Task, "size">): string {
  const s = t.size;
  if (!s) return "";
  return `${SIZE_NAME[s.size] ?? s.size} · ${s.model || "the configured model"}, ${s.effort} effort`;
}

/** What the team is doing now, in a few words. */
export function taskNow(t: Task): string {
  if (t.status === "queued") return "Waiting for a worker…";
  const stage = t.stage;
  const progress = t.progress;
  // The team's own progress is newer while it works; the worker's stage covers clone, setup, publish and checks.
  if (progress && (!stage || stage.phase === "plan" || stage.phase === "build" || stage.phase === "verify" || progress.updatedAt > stage.at)) {
    return plainLabel(progress.now);
  }
  return plainLabel(stage?.text) || "Starting…";
}

export const PHASE_LABEL: Record<TaskPhase, string> = {
  clone: "Clone",
  setup: "Setup",
  plan: "Plan",
  build: "Build",
  verify: "Verify",
  publish: "Publish",
  checks: "Checks",
};

/** "45 s", "12 min", "1 h 5 min". */
export function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

export const between = (from: string | undefined, to: string | undefined): number | undefined =>
  from && to ? Date.parse(to) - Date.parse(from) : undefined;

/** What kind of step it is, as people say it (shown before the step's own label). */
const KIND_NAME: Record<ActivityKind, string> = {
  web: "Web",
  github: "GitHub",
  memory: "Memory",
  notes: "Project notes",
  monday: "monday.com",
  task: "Repo task",
  agent: "Team",
  other: "Tool",
};

/** One of Pointer's steps as a ChatToolCalls row. */
export function toolCall(step: ActivityStep): ChatToolCallItem {
  return {
    key: step.id,
    name: KIND_NAME[step.kind],
    target: step.label,
    ...(step.agent ? { node: step.agent } : {}),
    status: step.endedAt ? (step.isError ? "error" : "complete") : "running",
    ...(step.endedAt ? { duration: formatMs(between(step.startedAt, step.endedAt)) } : {}),
    ...(step.isError ? { errorMessage: "This step failed." } : {}),
  };
}

/** "Used 5 tools" for a finished reply. */
export function activitySummary(steps: ActivityStep[]): string {
  const agents = new Set(steps.filter((s) => s.kind === "agent").map((s) => s.label)).size;
  const tools = steps.length - agents;
  const parts = [tools ? `${tools} tool${tools === 1 ? "" : "s"}` : "", agents ? `${agents} team member${agents === 1 ? "" : "s"}` : ""].filter(Boolean);
  return `Used ${parts.join(" and ") || "no tools"}`;
}

export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Repositories to suggest for a new task: channel bindings, repo setups, exact allow-list entries, recent tasks. */
export function knownRepos(config: PublicConfig, recentTasks: Pick<Task, "repo">[] = []): string[] {
  const all = [
    ...Object.values(config.bindings),
    ...Object.keys(config.repoSetup),
    ...config.github.allowedOwners,
    ...config.github.extra.flatMap((x) => x.allowed),
    ...recentTasks.map((t) => t.repo),
  ].filter((r) => REPO_PATTERN.test(r));
  const seen = new Map<string, string>();
  for (const repo of all) if (!seen.has(repo.toLowerCase())) seen.set(repo.toLowerCase(), repo);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** The last path segment of a pull request URL: "#12". */
export function prLabel(url: string): string {
  const n = url.match(/\/pull\/(\d+)/)?.[1];
  return n ? `Pull request #${n}` : "Pull request";
}

/** A team member's work, from the timeline: what they were asked, what they did, how long it took. */
export interface AgentWork {
  agent: string;
  runs: number;
  working: boolean;
  ms: number;
  assignment?: string;
  outcome?: string;
  failed: boolean;
  steps: TaskEvent[];
}

/** Groups the timeline's events by who did them (agents and the lead), in the order they first appear. */
export function agentWork(events: TaskEvent[], now = Date.now()): AgentWork[] {
  const byAgent = new Map<string, AgentWork & { openSince?: string }>();
  for (const e of events) {
    if (!e.agent) continue;
    let w = byAgent.get(e.agent);
    if (!w) {
      w = { agent: e.agent, runs: 0, working: false, ms: 0, failed: false, steps: [] };
      byAgent.set(e.agent, w);
    }
    if (e.kind === "agent-start") {
      w.runs += 1;
      w.working = true;
      w.openSince = e.at;
      w.assignment = e.text;
    } else if (e.kind === "agent-done") {
      w.working = false;
      w.ms += e.ms ?? between(w.openSince, e.at) ?? 0;
      w.openSince = undefined;
      w.outcome = e.text;
      if (e.ok === false) w.failed = true;
    } else {
      w.steps.push(e);
    }
  }
  return [...byAgent.values()].map(({ openSince, ...w }) => ({
    ...w,
    ms: w.ms + (openSince ? Math.max(0, now - Date.parse(openSince)) : 0),
  }));
}

/** A one-line description of a timeline event's kind. */
export const EVENT_VERB: Record<TaskEvent["kind"], string> = {
  phase: "Step",
  setup: "Setup command",
  "agent-start": "Started",
  "agent-done": "Finished",
  edit: "Edited",
  command: "Ran",
  browser: "Browser",
  screenshot: "Screenshots",
  preview: "Preview",
  ticket: "Ticket",
  routing: "Model",
  push: "Pushed",
  pr: "Pull request",
  checks: "Checks",
  "fix-round": "Fix round",
  recheck: "Checked again",
  end: "Ended",
  note: "Note",
  error: "Problem",
};
