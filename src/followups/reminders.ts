/**
 * The owner's reminders, on the routines' minute clock (scheduler.ts
 * onLeaderTick: one instance at a time, under the routines' lease, and on
 * POST /routines/tick), in the organisation's timezone (config.timezone):
 *
 * - the morning brief, at followups.morningBrief.time on its days: today's
 *   calendar (or that none is connected) and the open follow-ups, numbered
 *   with their own numbers, the most overdue and oldest first, at most 15;
 *   sent once per local day (the day is kept in the store), up to an hour
 *   late when the service was down at that time;
 * - an item's own reminder: at its remindAt, and again every repeatMin until
 *   it is closed (a repeat of whole days at the same local time, across
 *   daylight saving changes); never while it is snoozed. Each time it is
 *   reminded (remindedAt), so it goes once per due time, also across
 *   restarts; one the brief has just listed is not reminded again;
 * - before each calendar event the owner has not declined (not all-day
 *   ones), followups.meetingReminderMin minutes ahead: "In 10 min: …", once
 *   per event and start (the keys sent are kept in the store for 3 days);
 * - Gmail threads of open items the owner answered (ownerRepliedLast): the
 *   item says "you replied", checked at most hourly.
 *
 * Deterministic: no model call. Each goes as a DM from Pointer to the owner
 * (config.slack.user; nothing at all when no account is connected) and a
 * short copy (titles only, no links) is kept in the console's "Follow-ups"
 * conversation, its latest 200 messages. Calendar titles, meeting links and
 * items found in other people's messages are copies of what reaches the
 * owner: the posts are marked as relayed at level "inbox" (Slack metadata,
 * the console's `relayed`), so a reply to them starts as if it had read the
 * owner's inbox (pointer.ts relayedLevel: the web, the team and other apps
 * off, writes held for a yes), while "done 3" still closes items directly
 * (done-command.ts, without the model). Nothing of an item or an event is
 * logged.
 *
 * Nothing goes twice: a tick that starts while the one before it still runs
 * (a slow calendar, Google's retries) is skipped, and what was posted is
 * remembered in this process at once, before it is recorded in the store,
 * so a store that cannot be written does not send the brief again every
 * minute.
 */
import type { Config, ConfigRepo, FollowupSettings } from "../core/config.js";
import type { ConsoleThreads, SlackPoster } from "../routines/runner.js";
import { pointerPostMetadata } from "../slack/slack.js";
import { configSecrets, makeRedactor } from "../tasks/worker.js";
import { CONSOLE_TITLE_MAX, type Target, bold, closeHint, itemLine, linkTo, safe } from "./format.js";
import { FOLLOWUP_LIMITS, type FollowupStore } from "./store.js";
import { clockTime, dayTitle, hhmm, localDay, localParts, sameTimeDaysLater, zoneOf } from "./time.js";
import type { CalendarEvent, CalendarSource, EmailSource, FollowupItem } from "./types.js";

/** Items listed in the brief; the rest are counted. */
export const BRIEF_MAX_ITEMS = 15;
/** Events listed in the brief. */
const BRIEF_MAX_EVENTS = 20;
/** A brief later than this after its time (the service was down) is not sent that day. */
export const BRIEF_LATE_MIN = 60;
/** Items in one reminder; the rest are counted. */
const REMINDER_MAX_ITEMS = 15;
/** How long the upcoming events are kept between ticks. */
const CALENDAR_TTL_MS = 5 * 60_000;
/** Gmail is asked about answered threads at most this often. */
const GMAIL_CHECK_MS = 60 * 60_000;
const GMAIL_LOOKBACK_MS = 14 * 24 * 60 * 60_000;
const MIN = 60_000;
const DAY_MIN = 24 * 60;
/** The console conversation the reminders are kept in, and how many of its latest messages it keeps. */
export const CONSOLE_TITLE = "Follow-ups";
export const CONSOLE_KEEP = 200;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------- When ----------

/** The morning brief is due: one of its days, at or after its time (at most an hour late), not sent today yet. */
export function briefDue(brief: FollowupSettings["morningBrief"], timeZone: string, now: Date, lastDay: string | undefined): boolean {
  if (!brief.enabled) return false;
  const at = hhmm(brief.time);
  if (at === undefined) return false;
  const local = localParts(now, timeZone);
  return brief.days.includes(local.weekday) && lastDay !== local.date && local.minutes >= at && local.minutes < at + BRIEF_LATE_MIN;
}

/** Whether an item is snoozed at `now`. */
export const snoozed = (item: FollowupItem, now: Date): boolean => Boolean(item.snoozedUntil && Date.parse(item.snoozedUntil) > now.getTime());

/**
 * The due time an item is reminded for now, or undefined: open, not snoozed,
 * its remindAt passed (with a repeat, the latest repeat that passed), and not
 * reminded since.
 */
export function reminderDueAt(item: FollowupItem, now: Date, timeZone = "UTC"): Date | undefined {
  if (item.status !== "open" || !item.remindAt || snoozed(item, now)) return undefined;
  const first = Date.parse(item.remindAt);
  if (!Number.isFinite(first) || first > now.getTime()) return undefined;
  const due = item.repeatMin && item.repeatMin > 0 ? latestRepeat(first, item.repeatMin, now, timeZone) : first;
  const last = item.remindedAt ? Date.parse(item.remindedAt) : NaN;
  return Number.isFinite(last) && last >= due ? undefined : new Date(due);
}

/**
 * The latest repeat of a reminder that has passed by `now`. A repeat of
 * whole days ("every day", "every week") stays at the same local time in
 * `timeZone` when the clocks change; a shorter one steps in minutes.
 */
function latestRepeat(first: number, repeatMin: number, now: Date, timeZone: string): number {
  const t = now.getTime();
  if (repeatMin % DAY_MIN !== 0) {
    const step = repeatMin * MIN;
    return first + Math.floor((t - first) / step) * step;
  }
  const days = repeatMin / DAY_MIN;
  // Counted in elapsed time this is off by at most one repeat around a clock change: the next one up and down are checked too.
  const k = Math.floor((t - first) / (repeatMin * MIN));
  for (const n of [k + 1, k, k - 1]) {
    if (n < 0) continue;
    const at = n === 0 ? first : sameTimeDaysLater(new Date(first), n * days, timeZone).getTime();
    if (at <= t) return at;
  }
  return first;
}

/** A meeting is reminded `minutes` before it starts, until it starts: not all-day, not declined. */
export function meetingDue(event: CalendarEvent, now: Date, minutes: number): boolean {
  if (event.allDay || event.declined || minutes <= 0) return false;
  const start = Date.parse(event.start);
  return Number.isFinite(start) && start - minutes * MIN <= now.getTime() && now.getTime() < start;
}

export const meetingKey = (event: Pick<CalendarEvent, "id" | "start">) => `meeting:${event.id}:${event.start}`;

// ---------- What ----------

/** Today's calendar for the brief: its events, or why there are none to show. */
export type TodayCalendar = { kind: "events"; events: CalendarEvent[] } | { kind: "none" } | { kind: "error" };

/** An event's title, shorter in the console's copy. */
const eventTitle = (e: CalendarEvent, target: Target) => safe(e.title || "(no title)", target).slice(0, target === "console" ? CONSOLE_TITLE_MAX : 140);

function eventLine(e: CalendarEvent, timeZone: string, target: Target): string {
  const title = eventTitle(e, target);
  const link = linkTo(e.link, "join", target);
  if (e.allDay) return `• All day: ${title}${link ? ` · ${link}` : ""}`;
  const when = `${clockTime(new Date(e.start), timeZone)}–${clockTime(new Date(e.end), timeZone)}`;
  // The console's copy keeps no location (a room, an address, a dial-in written by whoever sent the invite).
  const where = e.location && target !== "console" ? ` · ${safe(e.location, target).slice(0, 80)}` : "";
  return `• ${when} ${title}${where}${link ? ` · ${link}` : ""}`;
}

export interface BriefInput {
  now: Date;
  timeZone: string;
  calendar: TodayCalendar;
  /** The open items, most urgent first (byUrgency). */
  items: FollowupItem[];
  target: Target;
}

/** The morning brief, and the numbers of the items it lists. */
export function briefText(input: BriefInput): { text: string; listed: number[] } {
  const { now, timeZone: tz, target } = input;
  const lines = [`☀️ ${bold(`Good morning: ${dayTitle(now, tz)}`, target)}`, "", bold("Today", target)];
  const cal = input.calendar;
  if (cal.kind === "none") lines.push("No calendar is connected: connect Google Calendar on the Integrations page to see your day here.");
  else if (cal.kind === "error") lines.push("Your calendar is connected but could not be read just now: if this goes on, check Google Calendar on the Integrations page.");
  else {
    const events = cal.events.filter((e) => !e.declined).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
    if (!events.length) lines.push("Nothing on your calendar today.");
    for (const e of events.slice(0, BRIEF_MAX_EVENTS)) lines.push(eventLine(e, tz, target));
    if (events.length > BRIEF_MAX_EVENTS) lines.push(`…and ${events.length - BRIEF_MAX_EVENTS} more.`);
  }
  const active = input.items.filter((i) => !snoozed(i, now));
  const paused = input.items.length - active.length;
  lines.push("", bold(`Open follow-ups: ${active.length}`, target));
  const shown = active.slice(0, BRIEF_MAX_ITEMS);
  if (!shown.length) lines.push("Nothing open.");
  for (const i of shown) lines.push(`• ${itemLine(i, { timeZone: tz, now, target })}`);
  if (active.length > shown.length) lines.push(`…and ${active.length - shown.length} more: ask me for your follow-ups.`);
  if (paused) lines.push(`(${paused} snoozed.)`);
  if (shown.length) lines.push("", closeHint(shown.map((i) => i.n), target));
  return { text: lines.join("\n"), listed: shown.map((i) => i.n) };
}

/** An item's own reminder, one or several at once. */
export function itemReminderText(items: FollowupItem[], now: Date, timeZone: string, target: Target): string {
  const shown = items.slice(0, REMINDER_MAX_ITEMS);
  const more = items.length > shown.length ? [`…and ${items.length - shown.length} more: ask me for your follow-ups.`] : [];
  const hint = closeHint(shown.map((i) => i.n), target);
  if (shown.length === 1) return [`⏰ ${bold("Reminder", target)} ${itemLine(shown[0]!, { timeZone, now, target })}`, hint].join("\n");
  return [`⏰ ${bold("Reminders", target)}`, ...shown.map((i) => `• ${itemLine(i, { timeZone, now, target })}`), ...more, hint].join("\n");
}

/** "In 10 min: Standup · 09:00–09:30 · join" for each meeting about to start. */
export function meetingText(events: CalendarEvent[], now: Date, timeZone: string, target: Target): string {
  return events
    .map((e) => {
      const start = new Date(e.start);
      const min = Math.max(1, Math.ceil((start.getTime() - now.getTime()) / MIN));
      const title = eventTitle(e, target);
      const link = linkTo(e.link, "join", target);
      return `📅 ${bold(`In ${min} min`, target)}: ${title} · ${clockTime(start, timeZone)}–${clockTime(new Date(e.end), timeZone)}${link ? ` · ${link}` : ""}`;
    })
    .join("\n");
}

// ---------- The reminders ----------

export interface ReminderDeps {
  configRepo: Pick<ConfigRepo, "load">;
  followups: FollowupStore;
  /** The owner's calendar (google/calendar.ts); absent = none. */
  calendar?: CalendarSource;
  /** The owner's mail (google/gmail.ts), for threads they answered; absent = none. */
  email?: EmailSource;
  slack: (botToken: string) => SlackPoster;
  /** The console conversation they are kept in; absent = Slack only. */
  threads?: ConsoleThreads;
  /** How long upcoming events are kept between ticks (tests: 0). */
  calendarTtlMs?: number;
}

/** What one tick sent. */
export interface ReminderTick {
  brief: boolean;
  /** Items reminded on their own. */
  items: number[];
  /** Meeting reminders, by key. */
  meetings: string[];
  /** Why nothing could be sent. */
  skipped?: string;
}

export class FollowupReminders {
  private upcoming: { at: number; from: number; to: number; events: CalendarEvent[] } | undefined;
  /** A tick is under way: one that starts meanwhile is skipped. */
  private running = false;
  /**
   * What this process posted, kept the moment the DM went: the brief's local
   * day, each item with when it was reminded, each meeting reminder's key
   * with when. The store records them too, but a write that fails after the
   * post must not make them go again.
   */
  private readonly posted = { briefDay: undefined as string | undefined, items: new Map<number, number>(), meetings: new Map<string, number>() };

  constructor(private readonly deps: ReminderDeps) {}

  /**
   * One minute's work (see the file's comment). A failure in one part never
   * stops the others; nothing is marked sent unless the DM went. Skipped while
   * the tick before it still runs (the scheduler goes on after its time limit
   * without waiting for it).
   */
  async tick(now: Date): Promise<ReminderTick> {
    if (this.running) {
      console.warn("[followups] the previous reminders tick is still running: this one is skipped");
      return { brief: false, items: [], meetings: [], skipped: "The previous tick is still running." };
    }
    this.running = true;
    try {
      return await this.tickNow(now);
    } finally {
      this.running = false;
    }
  }

  private async tickNow(now: Date): Promise<ReminderTick> {
    const out: ReminderTick = { brief: false, items: [], meetings: [] };
    const config = await this.deps.configRepo.load(true);
    const owner = config.slack.user?.userId;
    const token = config.slack.botToken;
    if (!owner || !token) return { ...out, skipped: "No Slack account of the owner's is connected." };
    const tz = zoneOf(config.timezone);
    const settings = config.followups;
    const store = this.deps.followups;
    const state = await store.reminderState();
    const open = await store.list({ status: "open" });
    this.forget(open, now);
    const post = (build: (target: Target) => string) => this.post(config, owner, token, build);
    /** Records what went in the store; a failure is logged (this process still remembers it). */
    const record = (what: string, write: () => Promise<unknown>) =>
      write().catch((err: unknown) => console.error(`[followups] ${what} went but could not be recorded:`, errorText(err).slice(0, 200)));
    const today = localParts(now, tz).date;

    // The morning brief.
    const listed = new Set<number>();
    if (briefDue(settings.morningBrief, tz, now, this.posted.briefDay === today ? today : state.briefDay)) {
      try {
        const calendar = await this.today(now, tz);
        const brief = (target: Target) => briefText({ now, timeZone: tz, calendar, items: open, target });
        await post((target) => brief(target).text);
        this.posted.briefDay = today;
        const shown = brief("text").listed;
        for (const n of shown) {
          listed.add(n);
          this.posted.items.set(n, now.getTime());
        }
        out.brief = true;
        await record("the morning brief", async () => {
          await store.updateReminders((s) => (s.briefDay === today ? false : ((s.briefDay = today), true)));
          if (shown.length) await store.markReminded(shown, now);
        });
      } catch (err) {
        console.error("[followups] the morning brief was not sent:", errorText(err).slice(0, 200));
      }
    }

    // Items' own reminders.
    const due = open.filter((i) => {
      if (listed.has(i.n)) return false;
      const at = reminderDueAt(i, now, tz);
      return at !== undefined && !((this.posted.items.get(i.n) ?? -Infinity) >= at.getTime());
    });
    if (due.length) {
      try {
        await post((target) => itemReminderText(due, now, tz, target));
        for (const i of due) this.posted.items.set(i.n, now.getTime());
        out.items = due.map((i) => i.n);
        await record("reminders", () => store.markReminded(out.items, now));
      } catch (err) {
        console.error("[followups] reminders were not sent:", errorText(err).slice(0, 200));
      }
    }

    // Before meetings.
    const minutes = settings.meetingReminderMin;
    if (minutes > 0 && this.deps.calendar) {
      try {
        const sent = (key: string) => Boolean(state.sent[key]) || this.posted.meetings.has(key);
        const soon = (await this.upcomingEvents(now, minutes)).filter((e) => meetingDue(e, now, minutes) && !sent(meetingKey(e)));
        if (soon.length) {
          await post((target) => meetingText(soon, now, tz, target));
          const keys = soon.map(meetingKey);
          for (const key of keys) this.posted.meetings.set(key, now.getTime());
          out.meetings = keys;
          await record("meeting reminders", () =>
            store.updateReminders((s) => {
              for (const key of keys) s.sent[key] = now.toISOString();
              return true;
            }),
          );
        }
      } catch (err) {
        console.error("[followups] meeting reminders were not sent:", errorText(err).slice(0, 200));
      }
    }

    // Gmail threads the owner answered.
    if (settings.trackGmail) await this.gmailAnswers(open, now, state.gmailCheckedAt).catch((err) => console.error("[followups] Gmail was not checked:", errorText(err).slice(0, 200)));
    return out;
  }

  /** Forgets what was posted for items no longer open, and meeting reminders past the days the store keeps them. */
  private forget(open: FollowupItem[], now: Date): void {
    const openNs = new Set(open.map((i) => i.n));
    for (const n of this.posted.items.keys()) if (!openNs.has(n)) this.posted.items.delete(n);
    const cutoff = now.getTime() - FOLLOWUP_LIMITS.sentDays * 24 * 60 * MIN;
    for (const [key, at] of this.posted.meetings) if (at < cutoff) this.posted.meetings.delete(key);
  }

  /** Today's events, or why there are none to show: none connected, or connected but not readable now. */
  private async today(now: Date, tz: string): Promise<TodayCalendar> {
    const cal = this.deps.calendar;
    try {
      if (!cal) return { kind: "none" };
      if (!(await cal.ready())) return (await cal.connected?.()) ? { kind: "error" } : { kind: "none" };
      const { start, end } = localDay(now, tz);
      return { kind: "events", events: await cal.eventsBetween(start, end) };
    } catch (err) {
      console.error("[followups] the calendar could not be read:", errorText(err).slice(0, 200));
      return { kind: "error" };
    }
  }

  /** The events of the next minutes, kept a few minutes between ticks (one calendar read every five minutes, not every minute). */
  private async upcomingEvents(now: Date, minutes: number): Promise<CalendarEvent[]> {
    const cal = this.deps.calendar;
    if (!cal) return [];
    const t = now.getTime();
    const ttl = this.deps.calendarTtlMs ?? CALENDAR_TTL_MS;
    const hit = this.upcoming;
    if (hit && t - hit.at < ttl && hit.from <= t && hit.to >= t + (minutes + 1) * MIN) return hit.events;
    const from = t - MIN;
    const to = t + (minutes + 15) * MIN;
    // Kept only once the read has finished, so a read still under way is never taken for an empty calendar. A
    // failed read is kept as no events until the next read, so a calendar that is down is not asked every minute.
    let events: CalendarEvent[];
    try {
      events = (await cal.ready()) ? await cal.eventsBetween(new Date(from), new Date(to)) : [];
    } catch (err) {
      this.upcoming = { at: t, from, to, events: [] };
      throw err;
    }
    this.upcoming = { at: t, from, to, events };
    return events;
  }

  /** Marks the open Gmail items whose thread the owner answered last, at most hourly. */
  private async gmailAnswers(open: FollowupItem[], now: Date, checkedAt: string | undefined): Promise<void> {
    const email = this.deps.email;
    const refs = new Set(open.flatMap((i) => (i.ref?.startsWith("gmail:") && !i.answeredAt ? [i.ref] : [])));
    if (!email || !refs.size) return;
    if (checkedAt && now.getTime() - Date.parse(checkedAt) < GMAIL_CHECK_MS) return;
    await this.deps.followups.updateReminders((s) => ((s.gmailCheckedAt = now.toISOString()), true));
    if (!(await email.ready())) return;
    const oldest = Math.min(...open.filter((i) => i.ref && refs.has(i.ref)).map((i) => Date.parse(i.createdAt)));
    const since = new Date(Math.max(now.getTime() - GMAIL_LOOKBACK_MS, oldest - 24 * 60 * MIN));
    for (const thread of await email.threadsSince(since)) {
      const ref = `gmail:${thread.id}`;
      if (thread.ownerRepliedLast && refs.has(ref)) await this.deps.followups.answered(ref, thread.at);
    }
  }

  /**
   * A DM from Pointer to the owner, marked as relayed outside content at
   * level "inbox", then a short copy in the console. Throws when the DM did
   * not go.
   */
  private async post(config: Config, owner: string, token: string, build: (target: Target) => string): Promise<void> {
    const redact = makeRedactor(configSecrets(config));
    await this.deps.slack(token).chat.postMessage({
      channel: owner,
      text: redact(build("slack")),
      metadata: pointerPostMetadata("outside", "followups", "inbox"),
      unfurl_links: false,
      unfurl_media: false,
    });
    const threads = this.deps.threads;
    if (!threads) return;
    try {
      // Console conversations are stored as plain text: the copy has short titles and no links (format.ts "console"),
      // and the conversation keeps only its latest messages.
      const markdown = redact(build("console"));
      const { conversationId } = await this.deps.followups.reminderState();
      if (conversationId && (await threads.post(conversationId, markdown, false, "inbox", CONSOLE_KEEP))) return;
      const id = await threads.start(CONSOLE_TITLE, markdown, false, "inbox");
      await this.deps.followups.updateReminders((s) => ((s.conversationId = id), true));
    } catch (err) {
      console.error("[followups] not kept in the console:", errorText(err).slice(0, 200));
    }
  }
}
