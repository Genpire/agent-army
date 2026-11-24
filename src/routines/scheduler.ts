/**
 * The routines' clock: a tick every minute in the web service starts the
 * routines that are due. POST /routines/tick runs the same tick, so an
 * external scheduler (Cloud Scheduler, cron) can wake a service that scales
 * to zero.
 *
 * - One instance ticks at a time: a lease in the store (routines/lease.json)
 *   that the holder renews on every tick. During a redeploy the new instance
 *   takes over when the old one's lease expires.
 * - Each scheduled run is claimed once (its id is its scheduled time), so two
 *   overlapping instances never both run it.
 * - Missed runs (the service was down): only the latest one counts. It runs
 *   once as a catch-up when it is less than an hour late; otherwise it is
 *   recorded as skipped, with a note. Earlier missed runs are only counted.
 * - A new, changed or resumed routine starts counting from then
 *   (RoutineState.since): it never catches up on runs from before.
 * - Other work on the same clock (the owner's follow-up reminders) runs
 *   after the routines on each tick this instance leads (onLeaderTick).
 */
import { randomBytes } from "node:crypto";
import type { ConfigRepo, Routine } from "../core/config.js";
import { normalizeTimeZone, parseCron, runsBetween } from "./cron.js";
import type { RoutineRunner } from "./runner.js";
import type { RoutineRun, RoutineRunRepo, RoutineState } from "./runs.js";

export const TICK_MS = 60_000;
/** Longer than two ticks: a holder that misses one tick keeps the lease. */
export const LEASE_TTL_MS = 3 * 60_000;
/** A missed run later than this is skipped instead of caught up. */
export const CATCH_UP_LIMIT_MS = 60 * 60_000;
/** A run started this soon after its time is on schedule; later, it is a catch-up. */
export const ON_TIME_MS = 5 * 60_000;
/** How far back missed runs are looked for. */
const LOOKBACK_MS = 8 * 24 * 60 * 60_000;
/** The longest a task on the clock (onLeaderTick) holds a tick up. */
export const LEADER_TASK_MS = 45_000;

export type Due =
  | { kind: "none" }
  /** First seen without a creation time: starts counting from now. */
  | { kind: "start" }
  | { kind: "run"; scheduledFor: Date; trigger: "schedule" | "catch-up"; missed: number }
  | { kind: "skip"; scheduledFor: Date; lateMs: number; missed: number };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function lateText(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 120) return plural(min, "minute");
  const h = Math.round(min / 60);
  return h < 48 ? plural(h, "hour") : plural(Math.round(h / 24), "day");
}

/**
 * Whether a routine is due at `now`, from its state: the latest scheduled time
 * in (last handled, now], on time, late (less than an hour: a catch-up) or
 * too late (skipped). Pure.
 */
export function dueRun(routine: Pick<Routine, "schedule" | "createdAt">, state: RoutineState | null, now: Date): Due {
  const parsed = parseCron(routine.schedule.cron);
  const tz = normalizeTimeZone(routine.schedule.timezone);
  if (!parsed.ok || !tz) return { kind: "none" };
  const marks = [state?.lastScheduledFor, state?.since, routine.createdAt].map((s) => (s ? Date.parse(s) : NaN)).filter(Number.isFinite);
  if (!marks.length) return { kind: "start" };
  const from = Math.max(...marks, now.getTime() - LOOKBACK_MS);
  const { count, last } = runsBetween(parsed.spec, tz, new Date(from), now);
  if (!last) return { kind: "none" };
  const lateMs = now.getTime() - last.getTime();
  if (lateMs < CATCH_UP_LIMIT_MS) return { kind: "run", scheduledFor: last, trigger: lateMs <= ON_TIME_MS ? "schedule" : "catch-up", missed: count - 1 };
  return { kind: "skip", scheduledFor: last, lateMs, missed: count - 1 };
}

/** The note on a late run or a skipped one. */
export function missedNote(due: Extract<Due, { kind: "run" | "skip" }>): string | undefined {
  const earlier = due.missed > 0 ? ` ${plural(due.missed, "earlier run")} ${due.missed === 1 ? "was" : "were"} missed too.` : "";
  if (due.kind === "skip") {
    return `Missed: the service was not running at the scheduled time (${lateText(due.lateMs)} ago). Runs more than an hour late are skipped; the next one runs on schedule.${earlier}`;
  }
  if (due.trigger === "catch-up") return `Ran late: the service was not running at the scheduled time.${earlier}`;
  return earlier ? earlier.trim() : undefined;
}

export interface TickResult {
  /** This instance holds the lease (only the holder starts runs). */
  leader: boolean;
  started: { routineId: string; runId: string; trigger: RoutineRun["trigger"] }[];
  skipped: { routineId: string; runId: string; note: string }[];
}

export interface TickOutcome extends TickResult {
  /** Resolves when the runs this tick started have ended. */
  finished: Promise<RoutineRun[]>;
}

export interface SchedulerDeps {
  configRepo: ConfigRepo;
  repo: RoutineRunRepo;
  runner: RoutineRunner;
  /** This instance's id in the lease. */
  owner: string;
  now?: () => Date;
  tickMs?: number;
  leaseTtlMs?: number;
  /** How long a task on the clock may hold a tick up (tests). */
  leaderTaskMs?: number;
}

/** An id for this process in the lease and on the runs it claims. */
export const newInstanceId = () => `inst-${randomBytes(6).toString("hex")}`;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class RoutineScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = true;
  /** Work on the same clock and lease, after the routines (onLeaderTick); `running` while a run of it has not finished. */
  private readonly leaderTasks: { name: string; run: (now: Date) => Promise<unknown>; running: boolean }[] = [];

  constructor(private readonly deps: SchedulerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Ticks every minute, just after the minute turns. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    const every = this.deps.tickMs ?? TICK_MS;
    const wait = every - (Date.now() % every) + 1_000;
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((err: unknown) => console.error("[routines] tick failed:", errorText(err).slice(0, 300)))
        .finally(() => this.schedule());
    }, wait);
    this.timer.unref?.();
  }

  /** Stops ticking and gives the lease up, so another instance takes over at once. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.deps.repo.releaseLease(this.deps.owner).catch(() => undefined);
  }

  /**
   * Runs `run` on every tick while this instance holds the lease, after the
   * routines were started: one instance at a time, every minute, and on
   * POST /routines/tick. A failure is logged and never stops the clock. A
   * run never overlaps the one before it: while that one has not finished
   * (it went past the tick's time limit), the task is skipped.
   */
  onLeaderTick(name: string, run: (now: Date) => Promise<unknown>): void {
    this.leaderTasks.push({ name, run, running: false });
  }

  /** One tick; ticks never overlap in this process. */
  tick(): Promise<TickOutcome> {
    const run = this.chain.then(() => this.tickNow());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async tickNow(): Promise<TickOutcome> {
    const now = this.now();
    const result: TickOutcome = { leader: false, started: [], skipped: [], finished: Promise.resolve([]) };
    if (!(await this.deps.repo.acquireLease(this.deps.owner, now, this.deps.leaseTtlMs ?? LEASE_TTL_MS))) return result;
    result.leader = true;
    const config = await this.deps.configRepo.load(true);
    const runs: Promise<RoutineRun>[] = [];
    for (const routine of config.routines) {
      if (!routine.enabled || this.deps.runner.isRunning(routine.id)) continue;
      try {
        const due = dueRun(routine, await this.deps.repo.state(routine.id), now);
        if (due.kind === "start") {
          await this.deps.repo.updateState(routine.id, { since: now.toISOString() });
        } else if (due.kind === "run") {
          const note = missedNote(due);
          const started = await this.deps.runner.start(routine.id, { trigger: due.trigger, scheduledFor: due.scheduledFor, ...(note ? { note } : {}) });
          if (started.ok) {
            result.started.push({ routineId: routine.id, runId: started.run.id, trigger: due.trigger });
            runs.push(started.done);
          }
        } else if (due.kind === "skip") {
          const note = missedNote(due)!;
          const skipped = await this.deps.runner.skip(routine, due.scheduledFor, note);
          if (skipped) result.skipped.push({ routineId: routine.id, runId: skipped.id, note });
        }
      } catch (err) {
        console.error(`[routines] ${routine.id}: not checked:`, errorText(err).slice(0, 300));
      }
    }
    result.finished = Promise.all(runs);
    for (const task of this.leaderTasks) {
      if (task.running) {
        console.warn(`[routines] ${task.name} is still running from an earlier tick: skipped on this one`);
        continue;
      }
      // A task that hangs (a calendar that never answers) must not stop the clock: the tick goes on after a while,
      // and the task stays marked running until it really ends, so the next tick does not start it twice.
      task.running = true;
      const run = Promise.resolve()
        .then(() => task.run(now))
        .finally(() => {
          task.running = false;
        });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), this.deps.leaderTaskMs ?? LEADER_TASK_MS);
        timer.unref?.();
      });
      try {
        if ((await Promise.race([run, limit])) === "late") {
          console.error(`[routines] ${task.name} is still running after the tick's time limit; the tick goes on`);
          run.catch((err: unknown) => console.error(`[routines] ${task.name} failed after the tick's time limit:`, errorText(err).slice(0, 300)));
        }
      } catch (err) {
        console.error(`[routines] ${task.name} failed on this tick:`, errorText(err).slice(0, 300));
      } finally {
        clearTimeout(timer);
      }
    }
    return result;
  }
}
