import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Task } from "./tasks.js";

/**
 * Live progress of a repo task, built from the Agent SDK's message stream at no
 * extra Claude cost: the lead's plan (TodoWrite or TaskCreate/TaskUpdate), which
 * agent is doing what, recent steps (files edited, commands run) and the files
 * changed so far. The worker shows it in Slack and saves it on the task record,
 * where Pointer reads it to answer "how is it going?".
 */

export type PlanStatus = "pending" | "in_progress" | "completed";
export interface PlanItem {
  content: string;
  status: PlanStatus;
}

export interface AgentProgress {
  label: string;
  description: string;
  state: "working" | "done";
  minutes: number;
  toolUses: number;
  /** First line of the agent's report, once it is done. */
  outcome?: string;
}

export interface ProgressSnapshot {
  updatedAt: string;
  startedAt: string;
  /** What the team is doing now, in a few words. */
  now: string;
  plan: PlanItem[];
  /** The latest agent runs, oldest first. */
  agents: AgentProgress[];
  /** Latest steps, oldest first, each prefixed with the minute it happened ("[12m] …"). */
  recent: string[];
  /** Changed paths in the working tree (at most FILES_SHOWN), and how many there are in all. */
  files: string[];
  filesCount: number;
}

/**
 * What the tracker saw, one step at a time, for a fuller timeline (see
 * task-events.ts). Only reported when the tracker is given `onEvent`.
 */
export type TrackerEvent =
  | { kind: "agent-start"; label: string; description: string }
  | { kind: "agent-done"; label: string; ms: number; outcome?: string; isError: boolean; toolUses: number }
  | { kind: "edit"; by: string; path: string }
  | { kind: "command"; by: string; command: string }
  | { kind: "browser"; by: string; action: string; detail?: string };

const BROWSER_PREFIX = "mcp__browser__";

/** A browser tool call in words: "Opened http://localhost:3000", "Took a screenshot: home.png". */
export function browserAction(tool: string, input: Record<string, unknown>): { action: string; detail?: string } | undefined {
  if (!tool.startsWith(BROWSER_PREFIX)) return undefined;
  const name = tool.slice(BROWSER_PREFIX.length);
  const target = oneLine(str(input.element) || str(input.ref) || "", 80) || undefined;
  switch (name) {
    case "browser_navigate":
      return { action: "Opened", detail: oneLine(str(input.url), 120) || undefined };
    case "browser_take_screenshot":
      return { action: "Took a screenshot", detail: oneLine(str(input.filename), 80) || undefined };
    case "browser_click":
      return { action: "Clicked", detail: target };
    case "browser_type":
    case "browser_fill_form":
      return { action: "Filled in", detail: target };
    case "browser_snapshot":
      return { action: "Read the page" };
    case "browser_resize":
      return { action: "Resized the window", detail: input.width && input.height ? `${String(input.width)}×${String(input.height)}` : undefined };
    case "browser_console_messages":
      return { action: "Read the console" };
    case "browser_network_requests":
      return { action: "Read the network requests" };
    default:
      return { action: name.replace(/^browser_/, "").replace(/_/g, " ") };
  }
}

export const RECENT_SHOWN = 8;
export const AGENTS_SHOWN = 6;
export const PLAN_SHOWN = 12;
export const FILES_SHOWN = 15;
const TEXT_MAX = 160;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);

interface Run {
  label: string;
  description: string;
  startedAt: number;
  endedAt?: number;
  toolUses: number;
  outcome?: string;
}

/** One line, without Markdown heading or list markers, at most `max` characters. */
export function oneLine(text: string, max = TEXT_MAX): string {
  const line =
    text
      .split("\n")
      .map((l) => l.replace(/^\s*(#+|[-*>]|\d+\.)\s*/, "").trim())
      .find((l) => l.length > 0) ?? "";
  const flat = line.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isPlanStatus = (v: unknown): v is PlanStatus => v === "pending" || v === "in_progress" || v === "completed";

/** Text of a tool_result block's content (a string or text blocks). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (isRecord(c) && c.type === "text" ? str(c.text) : "")).join("\n");
  return "";
}

export class ProgressTracker {
  private readonly startedAt: number;
  private readonly runs = new Map<string, Run>();
  private readonly order: string[] = [];
  private readonly events: string[] = [];
  private plan: PlanItem[] = [];
  /** TaskCreate/TaskUpdate plans: task id -> plan index; pending TaskCreate calls by tool_use id. */
  private readonly taskIds = new Map<string, number>();
  private readonly pendingCreates = new Map<string, number>();
  private files: string[] = [];
  private phase = "Reading the repository and planning";

  constructor(
    private readonly opts: {
      /** Name of the lead (Pointer). */
      lead: string;
      /** Display label for a subagent type, e.g. ":hammer_and_wrench: Coder". */
      label: (subagentType: string | undefined) => string;
      /** Absolute checkout path, stripped from file paths. */
      repoDir?: string;
      now?: () => number;
      /** Every step the tracker sees, for a fuller timeline; Slack progress is the same with or without it. */
      onEvent?: (event: TrackerEvent) => void;
    },
  ) {
    this.startedAt = this.now();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private minute(at = this.now()): number {
    return Math.max(0, Math.floor((at - this.startedAt) / 60_000));
  }

  private event(text: string): void {
    const line = `[${this.minute()}m] ${text}`;
    // The same step twice in a row (an agent editing one file repeatedly) is shown once.
    const last = this.events.at(-1);
    if (last && last.slice(last.indexOf("]")) === line.slice(line.indexOf("]"))) return;
    this.events.push(line);
    if (this.events.length > 50) this.events.shift();
  }

  private relPath(path: string): string {
    const dir = this.opts.repoDir;
    if (dir && path.startsWith(`${dir}/`)) return path.slice(dir.length + 1);
    return path;
  }

  setPhase(text: string): void {
    this.phase = text;
  }

  /** Paths changed in the working tree since the task started. */
  setFiles(paths: string[]): void {
    this.files = paths;
  }

  /** Feeds one SDK message; true when something visible changed. */
  onMessage(message: SDKMessage): boolean {
    if (message.type === "assistant") {
      let changed = false;
      for (const block of message.message.content) {
        if (block.type !== "tool_use") continue;
        const input = isRecord(block.input) ? block.input : {};
        changed =
          (message.parent_tool_use_id === null
            ? this.leadTool(block.id, block.name, input)
            : this.agentTool(message.parent_tool_use_id, block.name, input)) || changed;
      }
      return changed;
    }
    if (message.type === "user" && message.parent_tool_use_id === null) {
      const content = message.message.content;
      if (!Array.isArray(content)) return false;
      let changed = false;
      for (const block of content) {
        if (!isRecord(block) || block.type !== "tool_result") continue;
        changed = this.toolResult(str(block.tool_use_id), resultText(block.content), block.is_error === true) || changed;
      }
      return changed;
    }
    if (message.type === "system" && message.subtype === "task_progress") {
      const run = message.tool_use_id ? this.runs.get(message.tool_use_id) : undefined;
      if (run) run.toolUses = Math.max(run.toolUses, message.usage.tool_uses);
      return false;
    }
    return false;
  }

  private emit(event: TrackerEvent): void {
    try {
      this.opts.onEvent?.(event);
    } catch {
      // a listener must never break progress tracking
    }
  }

  /** Edits, commands and browser steps, reported to onEvent only (Slack shows them as before). */
  private reportStep(by: string, name: string, input: Record<string, unknown>): void {
    if (!this.opts.onEvent) return;
    if (EDIT_TOOLS.has(name)) {
      const path = str(input.file_path) || str(input.notebook_path);
      if (path) this.emit({ kind: "edit", by, path: this.relPath(path) });
      return;
    }
    if (name === "Bash") {
      const command = oneLine(str(input.command), 200);
      if (command) this.emit({ kind: "command", by, command });
      return;
    }
    const browser = browserAction(name, input);
    if (browser) this.emit({ kind: "browser", by, ...browser });
  }

  private leadTool(id: string, name: string, input: Record<string, unknown>): boolean {
    if (AGENT_TOOLS.has(name)) {
      const label = this.opts.label(str(input.subagent_type) || undefined);
      const description = oneLine(str(input.description) || "working", 100);
      this.runs.set(id, { label, description, startedAt: this.now(), toolUses: 0 });
      this.order.push(id);
      this.phase = `${label} — ${description}`;
      this.event(`${label} started: ${description}`);
      this.emit({ kind: "agent-start", label, description: oneLine(str(input.prompt) ? `${description}: ${str(input.prompt)}` : description, 300) });
      return true;
    }
    this.reportStep(this.opts.lead, name, input);
    if (name === "TodoWrite" && Array.isArray(input.todos)) {
      this.plan = input.todos
        .filter(isRecord)
        .map((t) => ({ content: oneLine(str(t.content), 120), status: isPlanStatus(t.status) ? t.status : "pending" }))
        .filter((t) => t.content);
      return true;
    }
    if (name === "TaskCreate") {
      const content = oneLine(str(input.subject) || str(input.description), 120);
      if (!content) return false;
      this.plan.push({ content, status: "pending" });
      this.pendingCreates.set(id, this.plan.length - 1);
      return true;
    }
    if (name === "TaskUpdate") {
      const index = this.taskIds.get(str(input.taskId));
      const item = index === undefined ? undefined : this.plan[index];
      if (!item) return false;
      if (input.status === "deleted") item.status = "completed";
      else if (isPlanStatus(input.status)) item.status = input.status;
      if (str(input.subject)) item.content = oneLine(str(input.subject), 120);
      return true;
    }
    if (name === "Bash") {
      this.event(`${this.opts.lead} ran \`${oneLine(str(input.command), 80)}\``);
      return true;
    }
    return false;
  }

  private agentTool(parentId: string, name: string, input: Record<string, unknown>): boolean {
    const run = this.runs.get(parentId);
    if (!run) return false;
    run.toolUses += 1;
    this.reportStep(run.label, name, input);
    if (EDIT_TOOLS.has(name)) {
      const path = str(input.file_path) || str(input.notebook_path);
      if (!path) return false;
      this.event(`${run.label} edited ${this.relPath(path)}`);
      return true;
    }
    if (name === "Bash") {
      this.event(`${run.label} ran \`${oneLine(str(input.command), 80)}\``);
      return true;
    }
    return false;
  }

  private toolResult(toolUseId: string, text: string, isError: boolean): boolean {
    const createdAt = this.pendingCreates.get(toolUseId);
    if (createdAt !== undefined) {
      this.pendingCreates.delete(toolUseId);
      const id = taskIdFromResult(text);
      if (id) this.taskIds.set(id, createdAt);
      return false;
    }
    const run = this.runs.get(toolUseId);
    if (!run || run.endedAt !== undefined) return false;
    run.endedAt = this.now();
    run.outcome = oneLine(text) || undefined;
    const mins = Math.max(1, Math.round((run.endedAt - run.startedAt) / 60_000));
    this.event(`${run.label} ${isError ? "stopped with an error" : "finished"} after ${mins} min${run.outcome ? `: ${run.outcome}` : ""}`);
    this.emit({
      kind: "agent-done",
      label: run.label,
      ms: run.endedAt - run.startedAt,
      ...(run.outcome ? { outcome: run.outcome } : {}),
      isError,
      toolUses: run.toolUses,
    });
    const working = this.order.map((id) => this.runs.get(id)!).filter((r) => r.endedAt === undefined);
    this.phase = working.length ? `${working.at(-1)!.label} — ${working.at(-1)!.description}` : `${this.opts.lead} is checking the results`;
    return true;
  }

  snapshot(): ProgressSnapshot {
    const now = this.now();
    return {
      updatedAt: new Date(now).toISOString(),
      startedAt: new Date(this.startedAt).toISOString(),
      now: this.phase,
      plan: this.plan.slice(0, PLAN_SHOWN).map((p) => ({ ...p })),
      agents: this.order.slice(-AGENTS_SHOWN).map((id) => {
        const r = this.runs.get(id)!;
        return {
          label: r.label,
          description: r.description,
          state: r.endedAt === undefined ? "working" : "done",
          minutes: Math.round(((r.endedAt ?? now) - r.startedAt) / 60_000),
          toolUses: r.toolUses,
          ...(r.outcome ? { outcome: r.outcome } : {}),
        };
      }),
      recent: this.events.slice(-RECENT_SHOWN),
      files: this.files.slice(0, FILES_SHOWN),
      filesCount: this.files.length,
    };
  }
}

const TASK_ID_IN_TEXT = /task\s*#?\s*(\w+)/i;

/** The id in a TaskCreate result: JSON `{ task: { id } }` or text like "Task #3 created". */
export function taskIdFromResult(text: string): string | undefined {
  try {
    const data = JSON.parse(text) as unknown;
    if (isRecord(data) && isRecord(data.task) && (typeof data.task.id === "string" || typeof data.task.id === "number")) {
      return String(data.task.id);
    }
  } catch {
    // not JSON
  }
  return text.match(TASK_ID_IN_TEXT)?.[1];
}

const PLAN_ICON: Record<PlanStatus, string> = {
  completed: ":white_check_mark:",
  in_progress: ":arrow_forward:",
  pending: ":white_square:",
};

const minutesSince = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));

/**
 * Slack text for a progress snapshot. `kind` "live" is the task's progress
 * message (edited in place), "update" a periodic message in the thread.
 */
export function formatProgress(
  s: ProgressSnapshot,
  opts: { kind: "live" | "update"; everyMin?: number; now?: number },
): string {
  const now = opts.now ?? Date.now();
  const elapsed = minutesSince(s.startedAt, now);
  const head =
    opts.kind === "live"
      ? `:gear: *Working* · ${elapsed} min${opts.everyMin ? ` · an update is posted here every ${opts.everyMin} min` : ""}`
      : `:hourglass_flowing_sand: *Update · ${elapsed} min in*`;
  const lines = [head, `*Now:* ${s.now}`];
  if (s.plan.length) {
    const done = s.plan.filter((p) => p.status === "completed").length;
    lines.push(`*Plan* (${done}/${s.plan.length} done)`, ...s.plan.map((p) => `${PLAN_ICON[p.status]} ${p.content}`));
  }
  const working = s.agents.filter((a) => a.state === "working");
  if (working.length) {
    lines.push(`*Working:* ${working.map((a) => `${a.label} (${a.minutes} min, ${a.toolUses} tool uses)`).join(", ")}`);
  }
  if (s.recent.length) lines.push("*Recent steps:*", ...s.recent.map((r) => `• ${r}`));
  if (s.filesCount) {
    const more = s.filesCount > s.files.length ? `, +${s.filesCount - s.files.length} more` : "";
    lines.push(
      `*Changed so far:* ${s.filesCount} file${s.filesCount === 1 ? "" : "s"} — ${s.files.map((f) => `\`${f}\``).join(", ")}${more}`,
    );
  }
  return lines.join("\n");
}

/** Plain text about one task, for Pointer's repo_task_status tool. */
export function describeTask(t: Task, now = Date.now()): string {
  const started = minutesSince(t.createdAt, now);
  const lines = [
    `Task ${t.id} on ${t.repo}: ${t.status}, started ${started} min ago${t.branch ? `, branch ${t.branch}` : ""}.`,
    `Request: ${oneLine(t.instruction, 300)}`,
  ];
  if (t.status === "done") {
    if (t.prUrl) lines.push(`Pull request: ${t.prUrl}`);
    if (t.summary) lines.push(`Summary: ${oneLine(t.summary, 400)}`);
  }
  if (t.status === "failed" && t.error) lines.push(`Error: ${oneLine(t.error, 400)}`);
  if (t.costUsd !== undefined) lines.push(`Cost: $${t.costUsd.toFixed(2)}`);
  if ((t.status === "running" || t.status === "queued") && t.stage) lines.push(`Stage: ${t.stage.text}`);
  if (t.status === "running" && t.prUrl) lines.push(`Pull request (open, checks pending): ${t.prUrl}`);
  if (t.ci) lines.push(`Checks: ${t.ci.state}${t.ci.names.length ? ` (${t.ci.names.join(", ")})` : ""}${t.ci.fixRounds ? `, after ${t.ci.fixRounds} fix round(s)` : ""}`);
  const p = t.progress;
  if (p && (t.status === "running" || t.status === "queued")) {
    lines.push(`Progress (saved ${minutesSince(p.updatedAt, now)} min ago): ${p.now}`);
    if (p.plan.length) {
      const mark = { completed: "[x]", in_progress: "[>]", pending: "[ ]" } as const;
      lines.push(
        `Plan (${p.plan.filter((x) => x.status === "completed").length}/${p.plan.length} done):`,
        ...p.plan.map((x) => `  ${mark[x.status]} ${x.content}`),
      );
    }
    for (const a of p.agents) {
      const state = a.state === "working" ? `working for ${a.minutes} min` : `done after ${a.minutes} min`;
      lines.push(`Agent ${a.label}: ${a.description} — ${state}, ${a.toolUses} tool uses${a.outcome ? `. Reported: ${a.outcome}` : ""}`);
    }
    if (p.recent.length) lines.push("Recent steps:", ...p.recent.map((r) => `  ${r}`));
    if (p.filesCount) lines.push(`Files changed so far (${p.filesCount}): ${p.files.join(", ")}`);
  } else if (t.status === "running" || t.status === "queued") {
    lines.push(
      started < 3
        ? "No progress saved yet: the team is starting (cloning and reading the repository)."
        : `No live progress is saved for this task: it started before progress tracking was available, or the worker has not reported yet. Its result will be posted in ${t.channel === "web" ? "its conversation in the admin console" : "its Slack thread"}.`,
    );
  }
  return lines.join("\n");
}

/** What Pointer's repo_task_status tool returns: this conversation's tasks, else the tasks running anywhere. */
export function describeTasks(threadTasks: Task[], running: Task[], now = Date.now()): string {
  if (threadTasks.length) {
    return [`Repo tasks started in this conversation (newest first):`, ...threadTasks.slice(0, 3).map((t) => describeTask(t, now))].join(
      "\n\n",
    );
  }
  if (running.length) {
    return [
      "No repo task was started in this conversation. Tasks running elsewhere (newest first):",
      ...running.slice(0, 3).map((t) => describeTask(t, now)),
    ].join("\n\n");
  }
  return "No repo task was started in this conversation, and none is running.";
}
