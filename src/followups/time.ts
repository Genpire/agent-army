/**
 * Local time in the organisation's timezone (config.timezone), for the
 * follow-ups: the day and time of the morning brief, "remind me at 3", the
 * start and end of today for the calendar. Built on the routines' cron
 * helpers (wallClock, momentsFor), so daylight saving time works the same.
 */
import { momentsFor, normalizeTimeZone, wallClock } from "../routines/cron.js";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** A reminder is at most this far ahead. */
export const MAX_AHEAD_MS = 366 * DAY;

/** The zone to use: config.timezone when valid, else UTC. */
export const zoneOf = (timeZone: string): string => normalizeTimeZone(timeZone) ?? "UTC";

export interface LocalParts {
  /** "YYYY-MM-DD" */
  date: string;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  /** Minutes since local midnight. */
  minutes: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The local date, weekday and time at `now` in `timeZone`. */
export function localParts(now: Date, timeZone: string): LocalParts {
  const wall = new Date(wallClock(timeZone, now.getTime()));
  return {
    date: `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}`,
    weekday: wall.getUTCDay(),
    minutes: wall.getUTCHours() * 60 + wall.getUTCMinutes(),
  };
}

/** The moment a local wall-clock time happens (the first one when clocks go back; shifted when skipped). */
export function atLocal(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(momentsFor(timeZone, Date.UTC(year, month - 1, day, hour, minute)).moments[0]!);
}

/**
 * The same local wall-clock time `days` days after `at` in `timeZone` (the
 * first one when clocks go back; shifted when skipped): "every day at 9"
 * stays at 9 across a daylight saving change, where adding 24 hours would
 * move it an hour.
 */
export function sameTimeDaysLater(at: Date, days: number, timeZone: string): Date {
  return new Date(momentsFor(timeZone, wallClock(timeZone, at.getTime()) + days * DAY).moments[0]!);
}

/** The local calendar day `days` after the one `now` is in (0: today), as year, month, day. */
function localDate(now: Date, timeZone: string, days = 0): [number, number, number] {
  const wall = new Date(wallClock(timeZone, now.getTime()));
  const d = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + days));
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

/** Local midnight of the day `now` is in, and of the next day: today's window for the calendar. */
export function localDay(now: Date, timeZone: string): { start: Date; end: Date } {
  return { start: atLocal(timeZone, ...localDate(now, timeZone), 0, 0), end: atLocal(timeZone, ...localDate(now, timeZone, 1), 0, 0) };
}

/** "08:30" → minutes since midnight; undefined when it is not HH:MM. */
export function hhmm(text: string): number | undefined {
  const m = text.trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

export type When = { ok: true; at: Date } | { ok: false; error: string };

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/;
const TIME_OF_DAY_RE = /^(\d{1,2}):(\d{2})$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * A time the owner or Pointer gives: an ISO time with its offset
 * ("2026-11-24T13:00:00Z", "…+02:00"), a local time in `timeZone` without one
 * ("2026-11-24 15:00", "2026-11-24T15:00"; a date alone is 09:00 that day),
 * or a time of day alone ("15:00": the next one, today or tomorrow). At most
 * a year ahead.
 */
export function parseWhen(input: string, timeZone: string, now: Date): When {
  const text = input.trim();
  const fail = (): When => ({ ok: false, error: `"${text.slice(0, 40)}" is not a time: use "YYYY-MM-DD HH:MM" in ${timeZone}, a time of day "HH:MM", or an ISO time.` });
  if (!text) return fail();
  let at: number;
  const local = text.match(LOCAL_RE);
  const timeOfDay = text.match(TIME_OF_DAY_RE);
  if (local) {
    const [y, mo, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(local[i] ?? (i === 4 ? 9 : 0))) as [number, number, number, number, number];
    if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59) return fail();
    if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return fail();
    at = atLocal(timeZone, y, mo, d, h, mi).getTime();
  } else if (timeOfDay) {
    const [h, mi] = [Number(timeOfDay[1]), Number(timeOfDay[2])];
    if (h > 23 || mi > 59) return fail();
    const today = atLocal(timeZone, ...localDate(now, timeZone), h, mi).getTime();
    at = today > now.getTime() ? today : atLocal(timeZone, ...localDate(now, timeZone, 1), h, mi).getTime();
  } else if (ISO_RE.test(text)) {
    at = Date.parse(text);
  } else {
    return fail();
  }
  if (!Number.isFinite(at)) return fail();
  if (at - now.getTime() > MAX_AHEAD_MS) return { ok: false, error: "That is more than a year ahead." };
  return { ok: true, at: new Date(at) };
}

const format = (timeZone: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone, ...options });

/** "Tue, Nov 24, 15:00" */
export const shortTime = (date: Date, timeZone: string): string =>
  format(timeZone, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);

/** "15:00" */
export const clockTime = (date: Date, timeZone: string): string => format(timeZone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);

/** "Tuesday, November 24" */
export const dayTitle = (date: Date, timeZone: string): string => format(timeZone, { weekday: "long", month: "long", day: "numeric" }).format(date);

/** "Tuesday, November 24, 2026 at 11:20" */
export const longTime = (date: Date, timeZone: string): string =>
  format(timeZone, { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);

/** "just now", "40m", "5h", "3d": how long ago. */
export function age(from: Date, now: Date): string {
  const min = Math.floor((now.getTime() - from.getTime()) / MIN);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** "every 2h", "every 30 min", "every day". */
export function everyText(repeatMin: number): string {
  if (repeatMin % (24 * 60) === 0) return repeatMin === 24 * 60 ? "every day" : `every ${repeatMin / (24 * 60)} days`;
  if (repeatMin % 60 === 0) return `every ${repeatMin / 60}h`;
  return `every ${repeatMin} min`;
}
