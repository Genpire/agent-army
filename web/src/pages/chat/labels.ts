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

const KIND_NAME: Record<ActivityKind, string> = {
  web: "web",
  github: "github",
  memory: "memory",
  notes: "notes",
  monday: "monday",
  task: "task",
  agent: "agent",
  other: "tool",
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
  push: "Pushed",
  pr: "Pull request",
  checks: "Checks",
  "fix-round": "Fix round",
  end: "Ended",
  note: "Note",
  error: "Problem",
};
