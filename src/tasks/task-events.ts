import type { CheckInfo, StatusInfo } from "../integrations/github/github.js";
import type { TrackerEvent } from "./progress.js";
import type { Store } from "../core/store.js";
import { TASK_PHASES, type TaskPhase } from "./tasks.js";

/**
 * A repo task's timeline: the steps (clone → setup → plan → build → verify →
 * publish → checks) and a capped log of what happened inside them, with times
 * and durations. The worker writes it (`task-events/<taskId>.json`, one writer
 * per task); the admin console reads it to show the task live. Slack and web
 * tasks alike. Text is redacted before it is stored and kept to one line.
 */

/** Events kept per task; older ones are dropped (and counted). */
export const TASK_EVENTS_MAX = 300;
/** Longest event text. */
export const TASK_EVENT_TEXT_MAX = 300;
/** Checks listed per task. */
export const TASK_CHECKS_MAX = 50;

export type PhaseState = "pending" | "active" | "done" | "skipped" | "failed";

export interface PhaseInfo {
  phase: TaskPhase;
  state: PhaseState;
  startedAt?: string;
  endedAt?: string;
  /** Why it was skipped or failed, or what it is doing. */
  note?: string;
}

export type TaskEventKind =
  /** A step started; text says what the worker is doing. */
  | "phase"
  /** The repo's setup command finished (ok, ms). */
  | "setup"
  /** An agent was given work (agent; text: the assignment). */
  | "agent-start"
  /** An agent finished (agent, ms, ok; text: the first line of its report). */
  | "agent-done"
  /** A file was edited (agent; text: the path). */
  | "edit"
  /** A command was run (agent; text: the command). */
  | "command"
  /** A browser check step (agent; text: the action). */
  | "browser"
  /** Screenshots were saved (text: how many and their names). */
  | "screenshot"
  /** The preview deployment was opened or could not be (url, ok; text: what was found). */
  | "preview"
  /** The monday.com ticket was updated (text: what changed, e.g. "Status set to In review"). */
  | "ticket"
  /** The task's size was estimated and its model chosen (text: size, model, effort). */
  | "routing"
  /** The branch was pushed. */
  | "push"
  /** The pull request was opened or updated (url). */
  | "pr"
  /** The pull request's checks after a push (ok: passed; text: the outcome). */
  | "checks"
  /** A round of fixing failing checks started. */
  | "fix-round"
  /** The platform ran one of the team's checks again after it finished (ok: passed; ms; text: the command and its result). */
  | "recheck"
  /** The task ended (ok; text: the outcome). */
  | "end"
  /** Anything else worth showing. */
  | "note"
  /** Something went wrong (the task may still go on). */
  | "error";

export interface TaskEvent {
  at: string;
  phase: TaskPhase;
  kind: TaskEventKind;
  text: string;
  /** Who did it: an agent's label ("Sara (Coder)") or the lead's name. */
  agent?: string;
  /** How long it took, when it is the end of something. */
  ms?: number;
  ok?: boolean;
  url?: string;
}

export type CheckState = "queued" | "running" | "passed" | "failed" | "skipped" | "neutral";

export interface CheckItem {
  name: string;
  state: CheckState;
  url?: string;
}

export interface TaskTimeline {
  taskId: string;
  updatedAt: string;
  phases: PhaseInfo[];
  /** Oldest first, at most TASK_EVENTS_MAX. */
  events: TaskEvent[];
  /** Events dropped from the start to stay under the cap. */
  dropped: number;
  /** The pull request's checks at the last look, while waiting and after. */
  checks: CheckItem[];
}

export const timelineKey = (taskId: string) => `task-events/${taskId}.json`;

export function emptyTimeline(taskId: string, now = new Date()): TaskTimeline {
  return {
    taskId,
    updatedAt: now.toISOString(),
    phases: TASK_PHASES.map((phase) => ({ phase, state: "pending" as const })),
    events: [],
    dropped: 0,
    checks: [],
  };
}

/** Slack emoji codes (":hammer_and_wrench: Sara") and line breaks out, one line, bounded. */
export function plainLine(text: string, max = TASK_EVENT_TEXT_MAX): string {
  const flat = text
    .replace(/(^|\s):[a-z0-9_+-]+:(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Adds an event, dropping the oldest past `max`. Mutates and returns the timeline. */
export function addEvent(t: TaskTimeline, e: TaskEvent, max = TASK_EVENTS_MAX): TaskTimeline {
  t.events.push(e);
  const extra = t.events.length - max;
  if (extra > 0) {
    t.events.splice(0, extra);
    t.dropped += extra;
  }
  return t;
}

const phaseIndex = (p: TaskPhase) => TASK_PHASES.indexOf(p);

/**
 * Moves the stepper to `phase`: the active step and every pending step before
 * it are closed (done, or skipped when they never started). Steps only move
 * forward; moving to an earlier or the current step changes nothing. Returns
 * whether the step changed.
 */
export function enterPhase(t: TaskTimeline, phase: TaskPhase, at: string): boolean {
  const target = phaseIndex(phase);
  const active = t.phases.findIndex((p) => p.state === "active");
  if (active >= target) return false;
  for (const p of t.phases) {
    const i = phaseIndex(p.phase);
    if (i >= target) break;
    if (p.state === "active") {
      p.state = "done";
      p.endedAt = at;
    } else if (p.state === "pending") {
      p.state = "skipped";
    }
  }
  const info = t.phases[target]!;
  info.state = "active";
  info.startedAt ??= at;
  return true;
}

/** Marks a step as skipped (not run), when it has not started. */
export function skipPhase(t: TaskTimeline, phase: TaskPhase, note?: string): void {
  const info = t.phases.find((p) => p.phase === phase);
  if (!info || info.state !== "pending") return;
  info.state = "skipped";
  if (note) info.note = plainLine(note, 200);
}

/**
 * The task ended: the active step is done (or failed), the steps after it are
 * skipped. `failedPhase` names an earlier step where it went wrong (the team
 * stopped while building, then its work was saved in a draft): that one is
 * failed and the active one done.
 */
export function closeTimeline(t: TaskTimeline, ok: boolean, at: string, note?: string, failedPhase?: TaskPhase): void {
  const active = t.phases.find((p) => p.state === "active");
  const blamed = !ok && failedPhase && failedPhase !== active?.phase ? t.phases.find((p) => p.phase === failedPhase) : undefined;
  for (const p of t.phases) {
    if (p.state === "pending") p.state = "skipped";
  }
  if (active) {
    active.state = ok || blamed ? "done" : "failed";
    active.endedAt = at;
    if (!ok && !blamed && note) active.note = plainLine(note, 200);
  }
  if (blamed) {
    blamed.state = "failed";
    blamed.endedAt ??= at;
    if (note) blamed.note = plainLine(note, 200);
  }
}

/** The step the stepper is on, or the last one that ran. */
export function currentPhase(t: TaskTimeline): TaskPhase {
  const active = t.phases.find((p) => p.state === "active");
  if (active) return active.phase;
  const ran = t.phases.filter((p) => p.state === "done" || p.state === "failed");
  return ran.at(-1)?.phase ?? "clone";
}

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

/** The pull request's checks and commit statuses as one list for the console. */
export function checkItems(data: { checks: CheckInfo[]; statuses: StatusInfo[] }): CheckItem[] {
  const fromCheck = (c: CheckInfo): CheckItem => {
    let state: CheckState;
    if (c.status !== "completed") state = c.status === "in_progress" ? "running" : "queued";
    else if (c.conclusion === "success") state = "passed";
    else if (FAILED_CONCLUSIONS.has(c.conclusion ?? "")) state = "failed";
    else if (c.conclusion === "skipped") state = "skipped";
    else state = "neutral";
    return { name: plainLine(c.name, 120), state, ...(c.detailsUrl && /^https:\/\//.test(c.detailsUrl) ? { url: c.detailsUrl } : {}) };
  };
  const fromStatus = (s: StatusInfo): CheckItem => ({
    name: plainLine(s.context, 120),
    state: s.state === "success" ? "passed" : s.state === "pending" ? "running" : "failed",
    ...(s.targetUrl && /^https:\/\//.test(s.targetUrl) ? { url: s.targetUrl } : {}),
  });
  return [...data.checks.map(fromCheck), ...data.statuses.map(fromStatus)].slice(0, TASK_CHECKS_MAX);
}

/** Commands that check the work rather than build it: tests, linters, type checks, builds. */
const VERIFY_COMMAND =
  /\b(test|tests|vitest|jest|mocha|pytest|rspec|phpunit|playwright|cypress|lint|eslint|ruff|flake8|mypy|tsc|typecheck|type-check|go\s+vet|go\s+test|cargo\s+(test|check|clippy)|build)\b/i;

/**
 * Turns the progress tracker's events into timeline events, and tells which
 * step they belong to: the first file edit starts "build", a browser check or
 * a test/lint/build command after that starts "verify". Pure.
 */
export function trackerToEvent(e: TrackerEvent, at: string, current: TaskPhase): { event: TaskEvent; phase?: TaskPhase } {
  const base = { at, phase: current };
  switch (e.kind) {
    case "agent-start":
      return { event: { ...base, kind: "agent-start", agent: plainLine(e.label, 80), text: plainLine(e.description) } };
    case "agent-done":
      return {
        event: {
          ...base,
          kind: "agent-done",
          agent: plainLine(e.label, 80),
          text: plainLine(e.outcome ?? (e.isError ? "Stopped with an error" : "Finished")),
          ms: e.ms,
          ok: !e.isError,
        },
      };
    case "edit": {
      const phase: TaskPhase | undefined = phaseIndex(current) < phaseIndex("build") ? "build" : undefined;
      return { event: { ...base, phase: phase ?? current, kind: "edit", agent: plainLine(e.by, 80), text: plainLine(e.path) }, phase };
    }
    case "command": {
      const verifies = VERIFY_COMMAND.test(e.command) && current === "build";
      const phase: TaskPhase | undefined = verifies ? "verify" : undefined;
      return { event: { ...base, phase: phase ?? current, kind: "command", agent: plainLine(e.by, 80), text: plainLine(e.command, 200) }, phase };
    }
    case "browser": {
      const phase: TaskPhase | undefined = current === "build" || current === "plan" ? "verify" : undefined;
      return {
        event: { ...base, phase: phase ?? current, kind: "browser", agent: plainLine(e.by, 80), text: plainLine(e.detail ? `${e.action}: ${e.detail}` : e.action) },
        phase,
      };
    }
  }
}

/**
 * Records one task's timeline and writes it to the store: at most every
 * `everyMs` unless forced, one write at a time and in order. Writing never
 * throws (a lost update must not fail the task); the log never carries the
 * timeline's text.
 */
export class TimelineRecorder {
  readonly timeline: TaskTimeline;
  private lastWrite = 0;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;
  private later: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly store: Pick<Store, "put">,
    taskId: string,
    private readonly opts: { redact?: (text: string) => string; now?: () => number; everyMs?: number } = {},
  ) {
    this.timeline = emptyTimeline(taskId, new Date(this.now()));
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private clean(text: string, max = TASK_EVENT_TEXT_MAX): string {
    return plainLine(this.opts.redact ? this.opts.redact(text) : text, max);
  }

  get phase(): TaskPhase {
    return currentPhase(this.timeline);
  }

  /** Moves to a step and logs what the worker is doing there. */
  enter(phase: TaskPhase, text: string): void {
    const at = this.iso();
    enterPhase(this.timeline, phase, at);
    addEvent(this.timeline, { at, phase: this.phase, kind: "phase", text: this.clean(text) });
    void this.flush(true);
  }

  skip(phase: TaskPhase, note?: string): void {
    skipPhase(this.timeline, phase, note && this.clean(note, 200));
    this.dirty = true;
  }

  add(e: Omit<TaskEvent, "at" | "phase"> & { phase?: TaskPhase }, force = false): void {
    const event: TaskEvent = {
      ...e,
      at: this.iso(),
      phase: e.phase ?? this.phase,
      text: this.clean(e.text),
      ...(e.agent ? { agent: this.clean(e.agent, 80) } : {}),
    };
    addEvent(this.timeline, event);
    void this.flush(force);
  }

  /** One of the progress tracker's events; may move the stepper to build or verify. */
  tracker(e: TrackerEvent): void {
    const { event, phase } = trackerToEvent(e, this.iso(), this.phase);
    if (phase) enterPhase(this.timeline, phase, event.at);
    addEvent(this.timeline, { ...event, text: this.clean(event.text), ...(event.agent ? { agent: this.clean(event.agent, 80) } : {}) });
    void this.flush(Boolean(phase));
  }

  checks(items: CheckItem[]): void {
    const next = JSON.stringify(items);
    if (next === JSON.stringify(this.timeline.checks)) return;
    this.timeline.checks = items;
    void this.flush();
  }

  /** The task ended (see closeTimeline for `failedPhase`). Always written. */
  close(ok: boolean, text: string, failedPhase?: TaskPhase): Promise<void> {
    const at = this.iso();
    closeTimeline(this.timeline, ok, at, this.clean(text, 200), failedPhase);
    addEvent(this.timeline, { at, phase: this.phase, kind: "end", text: this.clean(text), ok });
    return this.flush(true);
  }

  /** Writes now when forced or when `everyMs` has passed since the last write; otherwise once that time is up. */
  flush(force = false): Promise<void> {
    this.dirty = true;
    const every = this.opts.everyMs ?? 3000;
    const wait = every - (this.now() - this.lastWrite);
    if (!force && wait > 0) {
      if (!this.later) {
        this.later = setTimeout(() => {
          this.later = undefined;
          void this.flush(true);
        }, wait);
        this.later.unref?.();
      }
      return this.writing;
    }
    if (this.later) {
      clearTimeout(this.later);
      this.later = undefined;
    }
    this.lastWrite = this.now();
    this.writing = this.writing.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      this.timeline.updatedAt = this.iso();
      try {
        await this.store.put(timelineKey(this.timeline.taskId), JSON.stringify(this.timeline));
      } catch (err) {
        console.error("[worker] task timeline not saved:", (err as NodeJS.ErrnoException | undefined)?.code ?? "error");
      }
    });
    return this.writing;
  }
}

/** Reads a task's timeline; null when the task has none (older tasks, or not started yet). */
export async function readTimeline(store: Pick<Store, "get">, taskId: string): Promise<TaskTimeline | null> {
  const blob = await store.get(timelineKey(taskId));
  if (!blob) return null;
  try {
    const data = JSON.parse(blob.toString("utf8")) as Partial<TaskTimeline>;
    if (!Array.isArray(data.phases) || !Array.isArray(data.events)) return null;
    return { taskId, updatedAt: data.updatedAt ?? "", phases: data.phases, events: data.events, dropped: data.dropped ?? 0, checks: data.checks ?? [] };
  } catch {
    return null;
  }
}

const PHASE_MARK: Record<PhaseState, string> = { done: "[x]", active: "[>]", pending: "[ ]", skipped: "[-]", failed: "[!]" };
const took = (ms: number) => {
  const min = Math.floor(ms / 60_000);
  return min >= 1 ? `${min} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
};

/** Plain text about a task's timeline for Pointer's repo_task_status: steps, checks and the latest events. */
export function describeTimeline(t: TaskTimeline, now = Date.now(), latest = 12): string {
  const lines = [`Steps: ${t.phases.map((p) => `${PHASE_MARK[p.state]} ${p.phase}`).join(", ")}`];
  if (t.checks.length) lines.push(`Checks: ${t.checks.map((c) => `${c.name} (${c.state})`).join(", ")}`);
  const events = t.events.slice(-latest);
  if (events.length) {
    lines.push(
      "Latest events (oldest first):",
      ...events.map((e) => {
        const ago = Math.max(0, Math.round((now - Date.parse(e.at)) / 60_000));
        const who = e.agent ? `${e.agent}: ` : "";
        const duration = e.ms !== undefined ? ` (${took(e.ms)})` : "";
        return `  ${ago} min ago [${e.phase}] ${who}${e.kind} — ${e.text}${duration}`;
      }),
    );
  }
  return lines.join("\n");
}
