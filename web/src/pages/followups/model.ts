/**
 * The Follow-ups page's shapes, taken from the server's own types (type-only
 * imports), its API paths, the labels it shows, and the times it works with.
 * Every time is shown and picked in the organisation's timezone
 * (config.timezone), the one Pointer uses for "remind me at 3".
 */
import type { FollowupSettings } from "../../../../src/core/config.js";
import type { FollowupItem, FollowupSource, FollowupStatus } from "../../../../src/followups/types.js";
import { isSignedOut } from "../integrations/apps/apps";
import type { PublicConfig } from "../../lib/types";

export type { FollowupItem, FollowupSettings, FollowupSource, FollowupStatus };

/** GET /api/followups?status=open|done */
export interface FollowupList {
  items: FollowupItem[];
  settings: FollowupSettings;
  /** Why no reminder goes out although a Slack account is connected: the follow-ups are not that account's. */
  paused?: string;
}

/** POST /api/followups, /:n/done, /:n/reopen, /:n/snooze */
export interface FollowupSaved {
  ok: true;
  item: FollowupItem;
}

/** POST /api/followups/settings */
export interface FollowupSettingsSaved {
  ok: true;
  settings: FollowupSettings;
}

/** POST /api/followups */
export interface FollowupDraft {
  title: string;
  detail?: string;
  remindAt?: string;
  repeatMin?: number;
}

export const FOLLOWUPS_PATH = "/api/followups";
export const listPath = (status: FollowupStatus) => `${FOLLOWUPS_PATH}?status=${status}`;
export const itemPath = (n: number, action: "done" | "reopen" | "snooze") => `${FOLLOWUPS_PATH}/${n}/${action}`;
export const SETTINGS_PATH = `${FOLLOWUPS_PATH}/settings`;

/** The server's defaults (core/config.ts FollowupSettingsSchema), for a server that does not send settings yet. */
export const DEFAULT_SETTINGS: FollowupSettings = {
  morningBrief: { enabled: true, time: "08:30", days: [1, 2, 3, 4, 5] },
  meetingReminderMin: 10,
  trackGmail: true,
};

export const TITLE_MAX = 200;
export const DETAIL_MAX = 2000;

// ---------- Sources ----------

/** What each source is called; Pointer's own items carry its name. */
export function sourceLabel(source: FollowupSource, pointer: string): string {
  return { owner: "You", slack: "Slack", gmail: "Gmail", calendar: "Calendar", pointer }[source];
}

/** The words of an item's link to its source. */
export const OPEN_IN: Record<FollowupSource, string> = {
  owner: "Open the link",
  slack: "Open in Slack",
  gmail: "Open in Gmail",
  calendar: "Open in Calendar",
  pointer: "Open the link",
};

// ---------- Repeats and meeting reminders ----------

/** "every 30 min", "every hour", "every 2 h", "every day", "every 3 days". */
export function everyText(min: number): string {
  if (min % 1440 === 0) return min === 1440 ? "every day" : `every ${min / 1440} days`;
  if (min % 60 === 0) return min === 60 ? "every hour" : `every ${min / 60} h`;
  return `every ${min} min`;
}

const REPEATS = [0, 30, 60, 120, 240, 1440];

export const REPEAT_OPTIONS = REPEATS.map((min) => ({ value: String(min), label: min === 0 ? "Once" : everyText(min).replace(/^e/, "E") }));

const MEETING_MINUTES = [0, 5, 10, 15, 30];

/** Off, 5, 10, 15 or 30 minutes before; a value set elsewhere (by asking Pointer) is kept as an option. */
export function meetingOptions(current: number): { value: string; label: string }[] {
  const all = MEETING_MINUTES.includes(current) ? MEETING_MINUTES : [...MEETING_MINUTES, current].sort((a, b) => a - b);
  return all.map((min) => ({ value: String(min), label: min === 0 ? "Off" : `${min} min before` }));
}

// ---------- Times, in the organisation's timezone ----------

interface WallClock {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
}

/** What a clock in `timeZone` shows at `date`. */
function wallClock(date: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") % 24, min: get("minute") };
}

const pad = (n: number) => String(n).padStart(2, "0");
const wallUtc = (w: WallClock) => Date.UTC(w.y, w.m - 1, w.d, w.h, w.min);

/** "2026-11-24T15:00": the date and time a clock in `timeZone` shows at `date`, the shape DateTimeInput takes. */
export function toLocalInput(date: Date, timeZone: string): string {
  const w = wallClock(date, timeZone);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.min)}`;
}

/** The instant a local "YYYY-MM-DDTHH:MM" in `timeZone` stands for (in a repeated or skipped daylight-saving hour, the one an hour earlier). */
export function fromLocalInput(local: string, timeZone: string): Date | undefined {
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return undefined;
  const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  // The zone's offset near the target, then again at the first guess: two passes settle daylight-saving changes.
  let t = target - (wallUtc(wallClock(new Date(target), timeZone)) - target);
  t = target - (wallUtc(wallClock(new Date(t), timeZone)) - t);
  return new Date(t);
}

/** Days between the local dates of two instants in `timeZone` (0 = same day, 1 = the next). */
function dayDiff(from: Date, to: Date, timeZone: string): number {
  const a = wallClock(from, timeZone);
  const b = wallClock(to, timeZone);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

/** "at 15:00" today, "tomorrow at 09:00", "Tue at 15:00" this week, "Nov 30 at 15:00" further. */
export function atText(iso: string, timeZone: string, now = new Date()): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const w = wallClock(date, timeZone);
  const time = `${pad(w.h)}:${pad(w.min)}`;
  const days = dayDiff(now, date, timeZone);
  if (days === 0) return `at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days === -1) return `yesterday at ${time}`;
  const opts: Intl.DateTimeFormatOptions = days > 1 && days < 7 ? { weekday: "short", timeZone } : { month: "short", day: "numeric", timeZone };
  return `${new Intl.DateTimeFormat(undefined, opts).format(date)} at ${time}`;
}

/** An item's own reminder: "Reminds at 15:00, every 2 h", "Reminded at 09:00", or nothing. */
export function reminderText(item: FollowupItem, timeZone: string, now = new Date()): string | undefined {
  if (!item.remindAt) return undefined;
  const at = atText(item.remindAt, timeZone, now);
  const repeat = item.repeatMin ? `, ${everyText(item.repeatMin)}` : "";
  if (Date.parse(item.remindAt) > now.getTime()) return `Reminds ${at}${repeat}`;
  return item.repeatMin ? `Reminds ${everyText(item.repeatMin)} since ${at.replace(/^at /, "")}` : `Reminded ${at}`;
}

/** Whether the item is snoozed now. */
export const isSnoozed = (item: FollowupItem, now = Date.now()) => Boolean(item.snoozedUntil && Date.parse(item.snoozedUntil) > now);

export interface SnoozeChoice {
  key: string;
  label: string;
  /** "at 18:00" */
  when: string;
  until: string;
}

/** Later today (in about three hours, until 21:00) and tomorrow morning at 09:00, in `timeZone`. */
export function snoozeChoices(timeZone: string, now = new Date()): SnoozeChoice[] {
  const choices: SnoozeChoice[] = [];
  const today = wallClock(now, timeZone);
  const dateOf = (utc: number) => {
    const d = new Date(utc);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };
  // In three hours, on the hour after.
  const soon = wallClock(new Date(now.getTime() + 3 * 3_600_000), timeZone);
  const hour = soon.min > 0 ? soon.h + 1 : soon.h;
  if (soon.d === today.d && hour <= 21) {
    const later = fromLocalInput(`${dateOf(Date.UTC(today.y, today.m - 1, today.d))}T${pad(hour)}:00`, timeZone);
    if (later) choices.push({ key: "later", label: "Later today", when: `at ${pad(hour)}:00`, until: later.toISOString() });
  }
  const morning = fromLocalInput(`${dateOf(Date.UTC(today.y, today.m - 1, today.d + 1))}T09:00`, timeZone);
  if (morning) choices.push({ key: "morning", label: "Tomorrow morning", when: "at 09:00", until: morning.toISOString() });
  return choices;
}

// ---------- What reminders need ----------

export type AppReadiness = { state: "ready"; appId: string } | { state: "signed-out"; appId: string } | { state: "off"; appId: string } | { state: "missing" };

/** Whether the connected app from a catalog preset ("gmail", "google-calendar") can be read now. */
export function appReadiness(config: PublicConfig, presetId: string): AppReadiness {
  const app = config.apps.find((a) => a.presetId === presetId);
  if (!app) return { state: "missing" };
  if (!app.enabled) return { state: "off", appId: app.id };
  if (isSignedOut(app)) return { state: "signed-out", appId: app.id };
  return { state: "ready", appId: app.id };
}

/** Where Pointer's DMs to the owner stand: the Slack bot, then the owner's own account. */
export function slackReadiness(config: PublicConfig): "ready" | "no-account" | "no-slack" {
  if (!config.slack.connected) return "no-slack";
  return config.slack.user.connected ? "ready" : "no-account";
}
