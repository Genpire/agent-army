/**
 * Routines as Pointer's tools and the admin routes see them: create, change,
 * delete, list with their next runs and last run, run now, the runs and
 * their reports, and the tick secret. Built once in server.ts; it owns the
 * run store, the runner and the scheduler.
 */
import { z } from "zod";
import type { PointerBrain } from "../chat/pointer-types.js";
import { type Config, type ConfigRepo, ROUTINE_ID_RE, type Routine, RoutineSchema } from "../core/config.js";
import { safeEqual } from "../core/crypto.js";
import type { Store } from "../core/store.js";
import { emailReady, sendEmail } from "../integrations/email/email.js";
import { parseSlackTarget } from "../slack/slack-tools.js";
import type { Spending } from "../spending/budget.js";
import type { UsageRepo } from "../spending/usage.js";
import { describeCron, nextRun, nextRuns, normalizeTimeZone, parseCron, shortestGapMinutes } from "./cron.js";
import { type ConsoleThreads, type EmailSender, RoutineRunner, SLACK_TARGET_RE, type SlackPoster, type StartResult } from "./runner.js";
import { type RoutineRun, RoutineRunRepo, type RunSummary } from "./runs.js";
import { RoutineScheduler, newInstanceId } from "./scheduler.js";

export const MAX_ROUTINES = 50;
/** Routines run at most this often: each run is a model call with its own budget. */
export const MIN_INTERVAL_MIN = 15;
export const NEXT_RUNS_SHOWN = 3;
/** The header external schedulers send with POST /routines/tick. */
export const TICK_HEADER = "x-routines-secret";
export const TICK_PATH = "/routines/tick";

/** A routine as the console and Pointer see it. */
export interface RoutineView extends Routine {
  /** The schedule in words, e.g. "Weekdays at 08:00". */
  scheduleText: string;
  /** The next runs (ISO), at most NEXT_RUNS_SHOWN; empty while paused. */
  nextRuns: string[];
  lastRun: RunSummary | null;
  running: boolean;
  /** Why it cannot run, e.g. a schedule saved before it was checked; null when it can. */
  problem: string | null;
  /** The console conversation its reports go to, once there is one. */
  conversationId: string | null;
}

/** Fields of a new routine or a change; what is left out is kept (or defaulted). */
export interface RoutineDraft {
  name?: string;
  instruction?: string;
  cron?: string;
  timezone?: string;
  email?: string[];
  /** A Slack channel or user id (or a channel link); "" = none. */
  slack?: string;
  console?: boolean;
  budgetUsd?: number;
  enabled?: boolean;
}

export type RoutineResult = { ok: true; routine: RoutineView } | { ok: false; status: 400 | 404 | 409; error: string };

export type SchedulePreview = { ok: true; timezone: string; scheduleText: string; nextRuns: string[] } | { ok: false; error: string };

const EMAIL = z.email();

/** The schedule in words and its next runs, or why it cannot be used: invalid, never runs, or too often. */
export function previewSchedule(cron: string, timezone: string, now: Date, count = NEXT_RUNS_SHOWN): SchedulePreview {
  const tz = normalizeTimeZone(timezone);
  if (!tz) return { ok: false, error: `"${timezone.slice(0, 64)}" is not a timezone: use an IANA name such as Europe/London, America/New_York or UTC.` };
  const parsed = parseCron(cron);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (!nextRun(parsed.spec, tz, now)) return { ok: false, error: "This schedule never runs (no such date)." };
  const gap = shortestGapMinutes(parsed.spec, tz, now);
  if (gap !== undefined && gap < MIN_INTERVAL_MIN) {
    return { ok: false, error: `Routines run at most every ${MIN_INTERVAL_MIN} minutes; this schedule runs ${gap < 1 ? "more than once a minute" : `every ${gap} minute${gap === 1 ? "" : "s"}`} at times.` };
  }
  return { ok: true, timezone: tz, scheduleText: describeCron(parsed.spec), nextRuns: nextRuns(parsed.spec, tz, now, count).map((d) => d.toISOString()) };
}

/** A Slack channel or user id from an id, a mention or a channel link; undefined when it is none of these. */
export function slackTarget(input: string): string | undefined {
  const s = input.trim();
  if (!s) return "";
  const target = parseSlackTarget(s);
  if (!target || target.kind === "me") return undefined;
  return SLACK_TARGET_RE.test(target.id) ? target.id : undefined;
}

/** "rt-" and a slug of the name, unique among `taken`. */
export function newRoutineId(name: string, taken: Set<string>): string {
  const slug =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30)
      .replace(/-+$/, "") || "routine";
  const base = `rt-${slug.length >= 2 ? slug : `${slug}-routine`}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** Applies a draft to a routine (or a new one) and checks it: the first problem, or the routine. */
export function applyDraft(base: Routine, draft: RoutineDraft, now: Date): { ok: true; routine: Routine } | { ok: false; error: string } {
  const next: Routine = structuredClone(base);
  if (draft.name !== undefined) next.name = draft.name.trim();
  if (draft.instruction !== undefined) next.instruction = draft.instruction.trim();
  if (draft.cron !== undefined) next.schedule.cron = draft.cron.trim();
  if (draft.timezone !== undefined) next.schedule.timezone = draft.timezone.trim();
  if (draft.console !== undefined) next.deliver.console = draft.console;
  if (draft.budgetUsd !== undefined) next.budgetUsd = draft.budgetUsd;
  if (draft.enabled !== undefined) next.enabled = draft.enabled;
  if (draft.email !== undefined) {
    const seen = new Set<string>();
    const emails: string[] = [];
    for (const raw of draft.email) {
      const e = raw.trim();
      if (!e) continue;
      if (!EMAIL.safeParse(e).success || e.length > 200) return { ok: false, error: `"${e.slice(0, 80)}" is not an email address.` };
      if (!seen.has(e.toLowerCase())) emails.push(e);
      seen.add(e.toLowerCase());
    }
    if (emails.length > 20) return { ok: false, error: "A routine emails at most 20 addresses." };
    next.deliver.email = emails;
  }
  if (draft.slack !== undefined) {
    const target = slackTarget(draft.slack);
    if (target === undefined) return { ok: false, error: `"${draft.slack.trim().slice(0, 60)}" is not a Slack channel or user id: they look like C012ABCDEF or U012ABCDEF.` };
    next.deliver.slack = target;
  }

  if (!next.name || next.name.length > 80) return { ok: false, error: "Give the routine a name of at most 80 characters." };
  if (next.instruction.length < 10) return { ok: false, error: "Say what Pointer should do on each run, in at least 10 characters." };
  if (next.instruction.length > 8000) return { ok: false, error: "The instruction is limited to 8 000 characters." };
  if (!Number.isFinite(next.budgetUsd) || next.budgetUsd < 0.05 || next.budgetUsd > 20) return { ok: false, error: "The budget per run is from $0.05 to $20." };
  const preview = previewSchedule(next.schedule.cron, next.schedule.timezone, now);
  if (!preview.ok) return preview;
  next.schedule.timezone = preview.timezone;
  if (!next.deliver.email.length && !next.deliver.slack && !next.deliver.console) {
    return { ok: false, error: "Choose where the reports go: email, a Slack channel or person, or the console." };
  }
  const parsed = RoutineSchema.safeParse(next);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid routine." };
  return { ok: true, routine: parsed.data };
}

export interface RoutineServiceDeps {
  configRepo: ConfigRepo;
  store: Store;
  masterKey: Buffer;
  brain: PointerBrain;
  usage?: Pick<UsageRepo, "recordChat">;
  spending?: Pick<Spending, "checkChat" | "notify">;
  threads?: ConsoleThreads;
  slack?: (botToken: string) => SlackPoster;
  email?: EmailSender;
  brainSlot?: <T>(fn: () => Promise<T>) => Promise<T>;
  now?: () => Date;
  /** Store read-back delay for claims and the lease (tests: 0). */
  settleMs?: number;
  owner?: string;
}

export class RoutineService {
  readonly repo: RoutineRunRepo;
  readonly runner: RoutineRunner;
  readonly scheduler: RoutineScheduler;
  readonly owner: string;
  private readonly configRepo: ConfigRepo;
  private readonly clock: () => Date;

  constructor(deps: RoutineServiceDeps) {
    this.configRepo = deps.configRepo;
    this.clock = deps.now ?? (() => new Date());
    this.owner = deps.owner ?? newInstanceId();
    this.repo = new RoutineRunRepo(deps.store, deps.masterKey, deps.settleMs !== undefined ? { settleMs: deps.settleMs } : {});
    this.runner = new RoutineRunner({
      configRepo: deps.configRepo,
      repo: this.repo,
      brain: deps.brain,
      owner: this.owner,
      ...(deps.usage ? { usage: deps.usage } : {}),
      ...(deps.spending ? { spending: deps.spending } : {}),
      ...(deps.threads ? { threads: deps.threads } : {}),
      ...(deps.slack ? { slack: deps.slack } : {}),
      email: deps.email ?? { ready: emailReady, send: sendEmail },
      ...(deps.brainSlot ? { brainSlot: deps.brainSlot } : {}),
      extraSecrets: async () => [await this.repo.tickSecret()],
      now: this.clock,
    });
    this.scheduler = new RoutineScheduler({ configRepo: deps.configRepo, repo: this.repo, runner: this.runner, owner: this.owner, now: this.clock });
  }

  private now(): Date {
    return this.clock();
  }

  async view(routine: Routine): Promise<RoutineView> {
    const now = this.now();
    const preview = previewSchedule(routine.schedule.cron, routine.schedule.timezone, now);
    const [runs, state] = await Promise.all([this.repo.list(routine.id), this.repo.state(routine.id)]);
    return {
      ...routine,
      scheduleText: preview.ok ? preview.scheduleText : `cron ${routine.schedule.cron}`,
      nextRuns: preview.ok && routine.enabled ? preview.nextRuns : [],
      lastRun: runs[0] ?? null,
      running: this.runner.isRunning(routine.id),
      problem: preview.ok ? null : preview.error,
      conversationId: state?.conversationId ?? null,
    };
  }

  async list(): Promise<{ routines: RoutineView[]; timezone: string; emailReady: boolean; max: number; minIntervalMin: number }> {
    const config = await this.configRepo.load(true);
    return {
      routines: await Promise.all(config.routines.map((r) => this.view(r))),
      timezone: config.timezone,
      emailReady: emailReady(config),
      max: MAX_ROUTINES,
      minIntervalMin: MIN_INTERVAL_MIN,
    };
  }

  async get(id: string): Promise<RoutineView | null> {
    if (!ROUTINE_ID_RE.test(id)) return null;
    const routine = (await this.configRepo.load(true)).routines.find((r) => r.id === id);
    return routine ? this.view(routine) : null;
  }

  /** A new routine; the timezone defaults to the organisation's. It counts its schedule from now. */
  async create(draft: RoutineDraft, createdBy: string): Promise<RoutineResult> {
    const now = this.now();
    let created: Routine | undefined;
    let problem: RoutineResult | undefined;
    await this.configRepo.update((c) => {
      if (c.routines.length >= MAX_ROUTINES) {
        problem = { ok: false, status: 409, error: `There are already ${MAX_ROUTINES} routines, the most there can be. Delete one first.` };
        return;
      }
      const name = (draft.name ?? "").trim();
      const base: Routine = {
        id: newRoutineId(name, new Set(c.routines.map((r) => r.id))),
        name,
        instruction: "",
        schedule: { cron: "", timezone: c.timezone },
        deliver: { email: [], slack: "", console: true },
        budgetUsd: 1,
        enabled: true,
        createdBy: createdBy.slice(0, 120),
        createdAt: now.toISOString(),
      };
      const applied = applyDraft(base, { ...draft, timezone: draft.timezone?.trim() || c.timezone }, now);
      if (!applied.ok) {
        problem = { ok: false, status: 400, error: applied.error };
        return;
      }
      created = applied.routine;
      c.routines.push(created);
    });
    if (problem) return problem;
    if (!created) return { ok: false, status: 400, error: "Invalid routine." };
    await this.repo.updateState(created.id, { since: now.toISOString() });
    return { ok: true, routine: await this.view(created) };
  }

  /**
   * Changes a routine. A new schedule or timezone, or resuming it, counts the
   * schedule from now: runs missed before are not caught up.
   */
  async update(id: string, draft: RoutineDraft): Promise<RoutineResult> {
    const now = this.now();
    let updated: Routine | undefined;
    let restart = false;
    let problem: RoutineResult | undefined;
    await this.configRepo.update((c) => {
      const index = c.routines.findIndex((r) => r.id === id);
      const current = c.routines[index];
      if (!current) {
        problem = { ok: false, status: 404, error: "Routine not found." };
        return;
      }
      const applied = applyDraft(current, draft, now);
      if (!applied.ok) {
        problem = { ok: false, status: 400, error: applied.error };
        return;
      }
      const next = applied.routine;
      restart =
        next.schedule.cron !== current.schedule.cron || next.schedule.timezone !== current.schedule.timezone || (next.enabled && !current.enabled);
      c.routines[index] = next;
      updated = next;
    });
    if (problem) return problem;
    if (!updated) return { ok: false, status: 404, error: "Routine not found." };
    if (restart) await this.repo.updateState(id, { since: now.toISOString() });
    return { ok: true, routine: await this.view(updated) };
  }

  /** Deletes a routine and blanks its runs; its console conversation stays. False when there is none. */
  async remove(id: string): Promise<boolean> {
    let found = false;
    await this.configRepo.update((c) => {
      found = c.routines.some((r) => r.id === id);
      c.routines = c.routines.filter((r) => r.id !== id);
    });
    if (found) await this.repo.forget(id);
    return found;
  }

  /** Runs a routine now (in the background), to its own recipients. */
  runNow(id: string): Promise<StartResult> {
    if (!ROUTINE_ID_RE.test(id)) return Promise.resolve({ ok: false, status: 404, error: "Routine not found." });
    return this.runner.start(id, { trigger: "manual" });
  }

  runs(id: string): Promise<RunSummary[]> {
    return this.repo.list(id);
  }

  run(id: string, runId: string): Promise<RoutineRun | null> {
    return this.repo.get(id, runId).then((r) => {
      if (!r) return null;
      const { owner: _owner, ...rest } = r;
      return rest;
    });
  }

  preview(cron: string, timezone: string | undefined, config: Pick<Config, "timezone">): SchedulePreview {
    return previewSchedule(cron, timezone?.trim() || config.timezone, this.now());
  }

  /** Whether `value` is the tick secret (constant time). */
  async checkTickSecret(value: string | undefined): Promise<boolean> {
    if (!value) return false;
    return safeEqual(value, await this.repo.tickSecret());
  }
}

