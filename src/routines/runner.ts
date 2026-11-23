/**
 * Runs one routine: Pointer's brain answers the routine's instruction as a
 * request with surface "routine" (no Slack thread, nobody reading along), with
 * only read-only tools (pointer.ts), the routine's own budget, the chat
 * provider and the spending caps. Its answer is the report. Delivery is done
 * here, never by the model, and only to the routine's own recipients: email
 * (sendEmail), Slack (a channel or user id, split into messages) and the
 * console (one conversation per routine, so reports read like a thread).
 * Secrets are redacted from the report before it goes anywhere. A run reads
 * the owner's own Slack account only when the routine is the owner's and
 * reports to them alone (ownerRoutine in slack/user-account.ts), checked on
 * each run.
 */
import { randomBytes } from "node:crypto";
import type { WebClient } from "@slack/web-api";
import { type ChatMessage, type Conversation, type ConversationRepo, conversationTitle, newConversationId } from "../chat/conversations.js";
import type { PointerBrain, PointerContext, PointerRequest } from "../chat/pointer-types.js";
import type { Config, ConfigRepo, Routine } from "../core/config.js";
import type { EmailMessage, EmailResult } from "../integrations/email/email.js";
import { toMrkdwn } from "../slack/slack.js";
import { splitText } from "../slack/slack-tools.js";
import { ownerRoutine } from "../slack/user-account.js";
import type { Spending } from "../spending/budget.js";
import type { UsageRepo } from "../spending/usage.js";
import { configSecrets, makeRedactor } from "../tasks/worker.js";
import { describeCron, formatRunDate, formatRunTime, parseCron } from "./cron.js";
import { type Delivered, type DeliveryOutcome, type RoutineRun, type RoutineRunRepo, type RunTrigger, manualRunId, scheduledRunId } from "./runs.js";

/** The request's user and channel: no person and no Slack channel. */
export const ROUTINE_USER_ID = "routine";
export const ROUTINE_CHANNEL = "routine";
/** First runs cover this much. */
export const FIRST_WINDOW_MS = 24 * 60 * 60_000;
/** Longest report kept and delivered. */
export const REPORT_MAX_CHARS = 20_000;
/** Slack: one message's text. */
const SLACK_PART_CHARS = 3_000;
/** Slack channel (C, G), DM (D) or user (U, W) ids. */
export const SLACK_TARGET_RE = /^[CGDUW][A-Z0-9]{2,30}$/;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 20).trimEnd()}\n\n…(truncated)`);

/** The schedule in words with its timezone, or the cron when it cannot be read. */
export function scheduleText(routine: Pick<Routine, "schedule">): string {
  const parsed = parseCron(routine.schedule.cron);
  return parsed.ok ? describeCron(parsed.spec) : `cron ${routine.schedule.cron}`;
}

const longTime = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

export interface RoutineRequestInput {
  now: Date;
  /** When the last successful run started; absent for the first run. */
  since?: string;
  trigger: RunTrigger;
  runId: string;
  /** The routine is the owner's and reports to them alone (ownerRoutine): the run may read their Slack account. */
  ownerRoutine?: boolean;
}

/** What Pointer is asked on each run: the routine's instruction with the date, timezone and window. */
export function routineRequest(routine: Routine, input: RoutineRequestInput): PointerRequest {
  const tz = routine.schedule.timezone;
  const { now } = input;
  const since = input.since && Number.isFinite(Date.parse(input.since)) ? new Date(input.since) : undefined;
  const windowStart = since ?? new Date(now.getTime() - FIRST_WINDOW_MS);
  const how =
    input.trigger === "manual" ? " The owner asked for this run now." : input.trigger === "catch-up" ? " This run is late: the service was not running at the scheduled time." : "";
  const text = [
    `Scheduled routine "${oneLine(routine.name)}" (${routine.id}), ${scheduleText(routine).toLowerCase()} (${tz}).${how}`,
    `Now: ${longTime(now, tz)} in ${tz} (${now.toISOString()}).`,
    since
      ? `Window: since the last successful run, ${longTime(windowStart, tz)} (${windowStart.toISOString()}), until now.`
      : `Window: this is the first run, so the last 24 hours: since ${longTime(windowStart, tz)} (${windowStart.toISOString()}), until now.`,
    "",
    "The routine's instruction, for every run:",
    routine.instruction,
    "",
    "Do it now with read-only tools and answer with the report itself (Markdown). The platform delivers it.",
  ].join("\n");
  return {
    text,
    userId: ROUTINE_USER_ID,
    userName: `Routine: ${oneLine(routine.name)}`,
    channel: ROUTINE_CHANNEL,
    channelType: "unknown",
    threadTs: `${routine.id}:${input.runId}`,
    history: [],
    surface: "routine",
    budgetUsd: routine.budgetUsd,
    ...(input.ownerRoutine ? { ownerRoutine: true } : {}),
  };
}

// ---------- Delivery targets ----------

/** The console conversations reports go to. */
export interface ConsoleThreads {
  /** Adds Pointer's message to a conversation; false when it no longer exists. */
  post(conversationId: string, markdown: string, isError?: boolean): Promise<boolean>;
  /** Starts a conversation titled `title` whose first message is Pointer's; returns its id. */
  start(title: string, markdown: string, isError?: boolean): Promise<string>;
}

/** Console conversations through the ConversationService (posting) and its repo (starting one). */
export function consoleThreads(
  conversations: { repo: Pick<ConversationRepo, "save">; post(conversationId: string, markdown: string, isError?: boolean): Promise<boolean> },
  now: () => Date = () => new Date(),
): ConsoleThreads {
  return {
    post: (id, markdown, isError) => conversations.post(id, markdown, isError),
    async start(title, markdown, isError) {
      const at = now();
      const message: ChatMessage = { id: `m-${randomBytes(5).toString("hex")}`, role: "pointer", text: clip(markdown, REPORT_MAX_CHARS), at: at.toISOString(), ...(isError ? { isError } : {}) };
      const c: Conversation = {
        id: newConversationId(at.getTime()),
        title: conversationTitle(title),
        createdAt: at.toISOString(),
        updatedAt: at.toISOString(),
        pending: false,
        messages: [message],
        taskIds: [],
      };
      await conversations.repo.save(c, at);
      return c.id;
    },
  };
}

export interface SlackPoster {
  chat: Pick<WebClient["chat"], "postMessage">;
}

export interface EmailSender {
  ready(config: Config): boolean;
  send(config: Config, message: EmailMessage): Promise<EmailResult>;
}

/** Special mentions (<!here>, <!channel>, <!subteam^…>) become plain words: a report never pings a whole channel. */
const withoutBroadcasts = (text: string) => text.replace(/<!([^|>]*)(?:\|([^>]*))?>/g, (_m, kind: string, label?: string) => label || `@${kind.split("^")[0]}`);
const escapeMrkdwn = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- The runner ----------

export interface RoutineRunnerDeps {
  configRepo: ConfigRepo;
  repo: RoutineRunRepo;
  brain: PointerBrain;
  /** This instance, recorded on the runs it claims. */
  owner: string;
  usage?: Pick<UsageRepo, "recordChat">;
  spending?: Pick<Spending, "checkChat" | "notify">;
  threads?: ConsoleThreads;
  slack?: (botToken: string) => SlackPoster;
  email?: EmailSender;
  /** The concurrency limit chat answers use. */
  brainSlot?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** More values to redact (the tick secret). */
  extraSecrets?: () => Promise<string[]>;
  now?: () => Date;
}

export type StartResult = { ok: true; run: RoutineRun; done: Promise<RoutineRun> } | { ok: false; status: 404 | 409; error: string };

const emptyDelivered = (): Delivered => ({ email: null, slack: null, console: null });
const NOT_HERE: PointerContext["startRepoTask"] = async () => ({ ok: false, error: "Routines are read-only: they cannot start repo tasks." });

export class RoutineRunner {
  private readonly running = new Map<string, Promise<RoutineRun | null>>();

  constructor(private readonly deps: RoutineRunnerDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  isRunning(routineId: string): boolean {
    return this.running.has(routineId);
  }

  /** Tests and the tick route: resolves when every run in flight has ended. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()]);
  }

  /**
   * Claims a run (a scheduled one once across instances, by its scheduled
   * time) and starts it in the background. 409 when the routine is running
   * here already or the run was claimed elsewhere.
   */
  async start(routineId: string, opts: { trigger: RunTrigger; scheduledFor?: Date; note?: string }): Promise<StartResult> {
    if (this.running.has(routineId)) return { ok: false, status: 409, error: "This routine is running now. Wait for its report." };
    const config = await this.deps.configRepo.load(true);
    const routine = config.routines.find((r) => r.id === routineId);
    if (!routine) return { ok: false, status: 404, error: "Routine not found." };
    if (this.running.has(routineId)) return { ok: false, status: 409, error: "This routine is running now. Wait for its report." };
    const now = this.now();
    const scheduledFor = opts.scheduledFor ?? now;
    const run: RoutineRun = {
      id: opts.trigger === "manual" ? manualRunId(now) : scheduledRunId(scheduledFor),
      routineId,
      trigger: opts.trigger,
      scheduledFor: scheduledFor.toISOString(),
      startedAt: now.toISOString(),
      status: "running",
      delivered: emptyDelivered(),
      owner: this.deps.owner,
      ...(opts.note ? { note: opts.note } : {}),
    };

    let markClaimed!: (ok: boolean) => void;
    const claimed = new Promise<boolean>((resolve) => (markClaimed = resolve));
    const task: Promise<RoutineRun | null> = (async () => {
      try {
        const ok = await this.deps.repo.claim(run);
        markClaimed(ok);
        if (!ok) {
          // Claimed elsewhere: that scheduled time is handled.
          if (run.trigger !== "manual") await this.deps.repo.updateState(routineId, { lastScheduledFor: run.scheduledFor });
          return null;
        }
      } catch (err) {
        markClaimed(false);
        throw err;
      }
      if (run.trigger !== "manual") await this.deps.repo.updateState(routineId, { lastScheduledFor: run.scheduledFor });
      return this.execute(routine, run);
    })()
      .catch((err: unknown) => {
        console.error(`[routines] ${routineId}: run failed:`, errorText(err).slice(0, 300));
        return null;
      })
      .finally(() => {
        if (this.running.get(routineId) === task) this.running.delete(routineId);
      });
    this.running.set(routineId, task);
    if (!(await claimed)) return { ok: false, status: 409, error: "This run was already taken by another instance." };
    return { ok: true, run: { ...run }, done: task.then((r) => r ?? run) };
  }

  /** Records a scheduled run that is not run (too late), once across instances. */
  async skip(routine: Routine, scheduledFor: Date, note: string): Promise<RoutineRun | null> {
    const now = this.now().toISOString();
    const run: RoutineRun = {
      id: scheduledRunId(scheduledFor),
      routineId: routine.id,
      trigger: "schedule",
      scheduledFor: scheduledFor.toISOString(),
      startedAt: now,
      finishedAt: now,
      status: "skipped",
      delivered: emptyDelivered(),
      note,
      owner: this.deps.owner,
    };
    const claimed = await this.deps.repo.claim(run);
    await this.deps.repo.updateState(routine.id, { lastScheduledFor: run.scheduledFor });
    return claimed ? run : null;
  }

  private async execute(routine: Routine, run: RoutineRun): Promise<RoutineRun> {
    const config = await this.deps.configRepo.load(true);
    const extra = (await this.deps.extraSecrets?.().catch(() => [])) ?? [];
    const redact = makeRedactor([...configSecrets(config), ...extra]);
    const finish = async (patch: Partial<RoutineRun>): Promise<RoutineRun> => {
      Object.assign(run, patch, { finishedAt: this.now().toISOString() });
      await this.deps.repo.save(run);
      return run;
    };
    try {
      // The spending caps, before any model call.
      const allowed = (await this.deps.spending?.checkChat("routines")) ?? { ok: true as const };
      if (!allowed.ok) return await finish({ status: "skipped", note: [run.note, `Skipped: ${allowed.error}`].filter(Boolean).join(" ") });

      const state = await this.deps.repo.state(routine.id);
      // The owner's Slack account only for the owner's routine reporting to them alone, checked now
      // against the current config and on the very routine whose recipients get the report.
      const req = routineRequest(routine, {
        now: new Date(run.startedAt),
        ...(state?.lastSuccessAt ? { since: state.lastSuccessAt } : {}),
        trigger: run.trigger,
        runId: run.id,
        ownerRoutine: ownerRoutine(config, routine),
      });
      const slot = this.deps.brainSlot ?? (<T>(fn: () => Promise<T>) => fn());
      const reply = await slot(() => this.deps.brain.reply(req, { startRepoTask: NOT_HERE }));
      if (reply.costUsd !== undefined) run.costUsd = reply.costUsd;
      void this.deps.usage
        ?.recordChat(reply)
        .then(() => this.deps.spending?.notify())
        .catch((err: unknown) => console.error("[usage] routine cost not recorded:", errorText(err).slice(0, 200)));

      if (reply.isError) {
        const error = clip(redact(reply.text.trim()) || "The run failed.", 2_000);
        const delivered = emptyDelivered();
        if (routine.deliver.console) {
          delivered.console = await this.toConsole(routine, `**The routine could not finish:** ${error}`, true, redact);
        }
        return await finish({ status: "failed", error, delivered });
      }

      const report = clip(redact(reply.text.trim()) || "(The run returned an empty report.)", REPORT_MAX_CHARS);
      run.report = report;
      const delivered = await this.deliver(routine, config, run, redact);
      await this.deps.repo.updateState(routine.id, { lastSuccessAt: run.startedAt });
      return await finish({ status: "succeeded", delivered });
    } catch (err) {
      return finish({ status: "failed", error: clip(redact(errorText(err)), 2_000) });
    }
  }

  /** Sends the report to the routine's recipients, and only to them. Each failure is recorded, never thrown. */
  private async deliver(routine: Routine, config: Config, run: RoutineRun, redact: (text: string) => string): Promise<Delivered> {
    const report = run.report ?? "";
    const tz = routine.schedule.timezone;
    const date = formatRunDate(new Date(run.scheduledFor), tz);
    const out = emptyDelivered();
    const attempt = async (fn: () => Promise<DeliveryOutcome>): Promise<DeliveryOutcome> => {
      try {
        return await fn();
      } catch (err) {
        return { ok: false, error: redact(errorText(err)).slice(0, 300) };
      }
    };

    if (routine.deliver.email.length) {
      out.email = await attempt(async () => {
        const email = this.deps.email;
        if (!email || !email.ready(config)) return { ok: false, error: "Email is not set up: set it up on the Integrations page." };
        const sent = await email.send(config, { to: [...routine.deliver.email], subject: `${routine.name} · ${date}`, markdown: report });
        return sent.ok ? { ok: true, detail: `Sent to ${routine.deliver.email.length === 1 ? routine.deliver.email[0] : `${routine.deliver.email.length} addresses`}` } : { ok: false, error: redact(sent.error).slice(0, 300) };
      });
    }

    if (routine.deliver.slack) {
      out.slack = await attempt(async () => {
        const target = routine.deliver.slack;
        if (!SLACK_TARGET_RE.test(target)) return { ok: false, error: `"${target.slice(0, 40)}" is not a Slack channel or user id.` };
        const token = config.slack.botToken;
        if (!token || !this.deps.slack) return { ok: false, error: "Slack is not connected." };
        const client = this.deps.slack(token);
        const body = `*${escapeMrkdwn(oneLine(routine.name))}* · ${date}\n\n${toMrkdwn(withoutBroadcasts(report))}`;
        const parts = splitText(body, SLACK_PART_CHARS);
        for (const part of parts) {
          await client.chat.postMessage({ channel: target, text: part, unfurl_links: false, unfurl_media: false });
        }
        return { ok: true, detail: parts.length === 1 ? `Posted to ${target}` : `Posted to ${target} in ${parts.length} messages` };
      });
    }

    if (routine.deliver.console) {
      const head = `_${run.trigger === "manual" ? "Run now" : run.trigger === "catch-up" ? "Late run" : "Scheduled run"} · ${formatRunTime(new Date(run.scheduledFor), tz)} (${tz})_`;
      const note = run.note ? `\n\n_${run.note}_` : "";
      out.console = await attempt(() => this.toConsole(routine, `${head}${note}\n\n${report}`, false, redact));
    }
    return out;
  }

  /** Appends to the routine's console conversation, starting it (titled with the routine's name) when there is none. */
  private async toConsole(routine: Routine, markdown: string, isError: boolean, redact: (text: string) => string): Promise<DeliveryOutcome> {
    const threads = this.deps.threads;
    if (!threads) return { ok: false, error: "The console is not available." };
    try {
      const state = await this.deps.repo.state(routine.id);
      if (state?.conversationId && (await threads.post(state.conversationId, markdown, isError))) return { ok: true, detail: state.conversationId };
      const id = await threads.start(routine.name, markdown, isError);
      await this.deps.repo.updateState(routine.id, { conversationId: id });
      return { ok: true, detail: id };
    } catch (err) {
      return { ok: false, error: redact(errorText(err)).slice(0, 300) };
    }
  }
}
