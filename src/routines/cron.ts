/**
 * Standard 5-field cron ("minute hour day-of-month month day-of-week") in an
 * IANA timezone, for routines. No dependency: Intl gives each zone's offsets.
 *
 * Fields: numbers, ranges (1-5), steps (* /15, 9-17/2, 5/10), lists (1,15),
 * month names (jan…dec) and day names (sun…sat; 0 and 7 are Sunday), plus
 * the macros @hourly, @daily (@midnight), @weekly, @monthly, @yearly
 * (@annually). When both day fields are restricted a day matches either
 * (classic cron); a field starting with "*" counts as unrestricted.
 *
 * Daylight saving time, as classic cron does it:
 * - a local time skipped when clocks go forward (02:30 on the spring change)
 *   runs at the same moment shifted by the gap (03:30 local), so a daily
 *   routine still runs that day, and never twice;
 * - a local time that happens twice when clocks go back runs once, the first
 *   time, unless the hour field is "*" (an every-hour or more often
 *   schedule), which runs in both passes.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Wall-clock time looked back before a moment: transitions shift local time by at most 2 hours. */
const DST_LOOKBACK_MS = 3 * HOUR;
/** A schedule that does not run within this many years never runs (e.g. 30 February). */
const SEARCH_YEARS = 6;

export interface CronSpec {
  /** The expression as written (macros expanded). */
  expression: string;
  minutes: boolean[];
  hours: boolean[];
  /** Index 1-31. */
  days: boolean[];
  /** Index 1-12. */
  months: boolean[];
  /** Index 0-6, Sunday first. */
  weekdays: boolean[];
  domStar: boolean;
  dowStar: boolean;
  /** The hour field is unrestricted ("*"): repeated local times run in both passes. */
  hourStar: boolean;
}

export type CronParse = { ok: true; spec: CronSpec } | { ok: false; error: string };

const MACROS: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface FieldDef {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** The first name's number (month names start at 1). */
  nameBase?: number;
}

const FIELDS: FieldDef[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  // 7 is Sunday too; folded to 0 after parsing.
  { name: "day-of-week", min: 0, max: 7, names: DAY_NAMES, nameBase: 0 },
];

export const CRON_FORMAT_HINT = "A schedule is 5 fields: minute hour day-of-month month day-of-week, e.g. 0 8 * * 1-5 (08:00 on weekdays).";

function parseValue(text: string, f: FieldDef): number | string {
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (n < f.min || n > f.max) return `The ${f.name} field: ${n} is outside ${f.min}-${f.max}.`;
    return n;
  }
  const index = f.names?.indexOf(text.toLowerCase()) ?? -1;
  if (index >= 0) return index + (f.nameBase ?? 0);
  return `The ${f.name} field: "${text}" is not a number${f.names ? " or a name" : ""}.`;
}

function parseField(text: string, f: FieldDef): boolean[] | string {
  const out = new Array<boolean>(f.max + 1).fill(false);
  for (const item of text.split(",")) {
    const m = item.match(/^([^/]+)(?:\/(\d+))?$/);
    if (!m) return `The ${f.name} field: "${item}" is not valid.`;
    const [, range = "", stepText] = m;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1 || step > f.max - f.min + 1) return `The ${f.name} field: the step in "${item}" is out of range.`;
    let from: number;
    let to: number;
    if (range === "*") {
      from = f.min;
      to = f.name === "day-of-week" ? 6 : f.max;
    } else {
      const [a, b, ...rest] = range.split("-");
      if (rest.length || a === undefined || a === "") return `The ${f.name} field: "${item}" is not valid.`;
      const start = parseValue(a, f);
      if (typeof start === "string") return start;
      from = start;
      if (b !== undefined) {
        const end = parseValue(b, f);
        if (typeof end === "string") return end;
        if (end < start) return `The ${f.name} field: the range "${range}" goes backwards.`;
        to = end;
      } else {
        // "5/15" means 5 to the end in steps of 15; a bare value is just itself.
        to = stepText === undefined ? start : f.name === "day-of-week" ? 6 : f.max;
      }
    }
    for (let v = from; v <= to; v += step) out[v] = true;
  }
  return out;
}

/** Parses a cron expression; the error says which field is wrong. */
export function parseCron(input: string): CronParse {
  const raw = input.trim().replace(/\s+/g, " ");
  if (!raw) return { ok: false, error: CRON_FORMAT_HINT };
  const expression = MACROS[raw.toLowerCase()] ?? raw;
  if (expression.startsWith("@")) return { ok: false, error: `"${raw}" is not a schedule: use 5 fields, or @hourly, @daily, @weekly, @monthly or @yearly.` };
  const parts = expression.split(" ");
  if (parts.length !== 5) return { ok: false, error: CRON_FORMAT_HINT };
  const fields: boolean[][] = [];
  for (let i = 0; i < 5; i++) {
    const parsed = parseField(parts[i]!, FIELDS[i]!);
    if (typeof parsed === "string") return { ok: false, error: parsed };
    fields.push(parsed);
  }
  const weekdays = fields[4]!.slice(0, 7);
  if (fields[4]![7]) weekdays[0] = true;
  return {
    ok: true,
    spec: {
      expression: MACROS[raw.toLowerCase()] ? raw.toLowerCase() : expression,
      minutes: fields[0]!,
      hours: fields[1]!,
      days: fields[2]!,
      months: fields[3]!,
      weekdays,
      domStar: parts[2]!.startsWith("*"),
      dowStar: parts[4]!.startsWith("*"),
      hourStar: parts[1] === "*",
    },
  };
}

// ---------- Timezones ----------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The local wall-clock time at `ms` in `timeZone`, as if it were UTC (whole seconds). */
export function wallClock(timeZone: string, ms: number): number {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, (parts.hour ?? 0) % 24, parts.minute ?? 0, parts.second ?? 0);
}

/** The zone's offset from UTC at `ms`, in milliseconds (local minus UTC). */
export const offsetAt = (timeZone: string, ms: number): number => wallClock(timeZone, ms) - (ms - (((ms % 1000) + 1000) % 1000));

const supportedZones = (() => {
  let list: string[] = [];
  try {
    list = Intl.supportedValuesOf("timeZone");
  } catch {
    // very old engines: accept whatever Intl accepts
  }
  return new Set(list);
})();

/**
 * The zone as stored when it is a valid IANA timezone (letter case fixed,
 * aliases such as Asia/Kolkata kept as written), else undefined. Checked
 * against Intl.supportedValuesOf("timeZone"), which lists canonical names
 * only; UTC and Etc/… zones are accepted too.
 */
export function normalizeTimeZone(input: string): string | undefined {
  const tz = input.trim();
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(tz)) return undefined;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
  const known = supportedZones.size === 0 || supportedZones.has(resolved) || resolved === "UTC" || resolved.startsWith("Etc/");
  if (!known) return undefined;
  return tz.toLowerCase() === resolved.toLowerCase() ? resolved : tz;
}

export const isTimeZone = (input: string): boolean => normalizeTimeZone(input) !== undefined;

/** Every zone a picker offers, UTC first. */
export function timeZoneList(): string[] {
  return ["UTC", ...[...supportedZones].filter((z) => z !== "UTC")];
}

// ---------- Next runs ----------

const floorMinute = (ms: number) => Math.floor(ms / MIN) * MIN;

function dayMatches(spec: CronSpec, d: Date): boolean {
  const dom = spec.days[d.getUTCDate()] === true;
  const dow = spec.weekdays[d.getUTCDay()] === true;
  if (spec.domStar && spec.dowStar) return true;
  if (spec.domStar) return dow;
  if (spec.dowStar) return dom;
  return dom || dow;
}

/** The first wall-clock minute at or after `from` that the schedule names, or null within SEARCH_YEARS. */
function nextWall(spec: CronSpec, from: number): number | null {
  let t = floorMinute(from);
  const end = from + SEARCH_YEARS * 366 * DAY;
  while (t <= end) {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth();
    if (!spec.months[mo + 1]) {
      t = Date.UTC(y, mo + 1, 1);
      continue;
    }
    if (!dayMatches(spec, d)) {
      t = Date.UTC(y, mo, d.getUTCDate() + 1);
      continue;
    }
    if (!spec.hours[d.getUTCHours()]) {
      t = Date.UTC(y, mo, d.getUTCDate(), d.getUTCHours() + 1);
      continue;
    }
    if (!spec.minutes[d.getUTCMinutes()]) {
      t += MIN;
      continue;
    }
    return t;
  }
  return null;
}

/**
 * The moments whose local time in `timeZone` is the wall-clock minute
 * `wall`: one, two when clocks went back (first one first), or, when it was
 * skipped by clocks going forward, the moment shifted by the gap.
 */
export function momentsFor(timeZone: string, wall: number): { moments: number[]; skipped: boolean; nearTransition: boolean } {
  const before = offsetAt(timeZone, wall - 18 * HOUR);
  const after = offsetAt(timeZone, wall + 18 * HOUR);
  const nearTransition = before !== after;
  const moments = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((t) => floorMinute(wallClock(timeZone, t)) === wall)
    .sort((a, b) => a - b);
  if (moments.length) return { moments, skipped: false, nearTransition };
  return { moments: [wall - before], skipped: true, nearTransition };
}

/** The first run strictly after `after`, or null when the schedule never runs again. */
export function nextRun(spec: CronSpec, timeZone: string, after: Date): Date | null {
  const afterMs = after.getTime();
  let wall: number | null = floorMinute(wallClock(timeZone, afterMs)) - DST_LOOKBACK_MS;
  let best: number | undefined;
  /** Near a clock change wall-clock order is not time order: later wall times are checked up to here. */
  let scanUntil: number | undefined;
  for (let guard = 0; guard < 100_000; guard++) {
    wall = nextWall(spec, wall);
    if (wall === null || (scanUntil !== undefined && wall > scanUntil)) break;
    const { moments, nearTransition } = momentsFor(timeZone, wall);
    const usable = moments.length > 1 && !spec.hourStar ? moments.slice(0, 1) : moments;
    const found = usable.find((t) => t > afterMs);
    if (found !== undefined && (best === undefined || found < best)) {
      best = found;
      if (!nearTransition) break;
      scanUntil = floorMinute(wallClock(timeZone, found)) + DST_LOOKBACK_MS;
    }
    wall += MIN;
  }
  return best === undefined ? null : new Date(best);
}

/** The next `count` runs after `after`. */
export function nextRuns(spec: CronSpec, timeZone: string, after: Date, count: number): Date[] {
  const out: Date[] = [];
  let cursor = after;
  while (out.length < count) {
    const next = nextRun(spec, timeZone, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/**
 * The runs in (from, to]: how many (at most `limit`) and the last one. For
 * due detection: a routine is due when the last run in (last handled, now]
 * exists.
 */
export function runsBetween(spec: CronSpec, timeZone: string, from: Date, to: Date, limit = 20_000): { count: number; last?: Date } {
  let count = 0;
  let last: Date | undefined;
  let cursor = from;
  while (count < limit) {
    const next = nextRun(spec, timeZone, cursor);
    if (!next || next.getTime() > to.getTime()) break;
    count += 1;
    last = next;
    cursor = next;
  }
  return { count, ...(last ? { last } : {}) };
}

/** The shortest time between two of the next `sample` runs, in minutes; undefined with fewer than two runs. */
export function shortestGapMinutes(spec: CronSpec, timeZone: string, after: Date, sample = 60): number | undefined {
  const runs = nextRuns(spec, timeZone, after, sample);
  let gap: number | undefined;
  for (let i = 1; i < runs.length; i++) {
    const g = (runs[i]!.getTime() - runs[i - 1]!.getTime()) / MIN;
    if (gap === undefined || g < gap) gap = g;
  }
  return gap;
}

// ---------- In words ----------

const pad = (n: number) => String(n).padStart(2, "0");
const on = (flags: boolean[], from = 0) => flags.flatMap((v, i) => (v && i >= from ? [i] : []));
const WEEKDAY_WORDS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_WORDS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function list(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

const ordinal = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
};

/** A uniform step over the whole range ("every 15 minutes"), or undefined. */
function everyStep(values: number[], size: number): number | undefined {
  if (values.length < 2 || values[0] !== 0) return undefined;
  const step = values[1]! - values[0]!;
  if (values.some((v, i) => v !== i * step)) return undefined;
  return size % step === 0 && values.length === size / step ? step : undefined;
}

/**
 * The schedule in words, e.g. "Every day at 08:00", "Weekdays at 09:30",
 * "Every Monday at 08:00", "On the 1st of every month at 09:00", "Every 30
 * minutes". Anything else: "At cron <expression>". Times are 24-hour.
 */
export function describeCron(spec: CronSpec): string {
  const minutes = on(spec.minutes);
  const hours = on(spec.hours);
  const days = on(spec.days, 1);
  const months = on(spec.months, 1);
  const weekdays = on(spec.weekdays);
  const allMonths = months.length === 12;

  // When in the day.
  let when: string | undefined;
  const minuteStep = everyStep(minutes, 60);
  if (spec.hourStar && minuteStep && minuteStep > 1) when = `every ${minuteStep} minutes`;
  else if (spec.hourStar && minutes.length === 60) when = "every minute";
  else if (spec.hourStar && minutes.length === 1) when = minutes[0] === 0 ? "every hour" : `every hour at minute ${minutes[0]}`;
  else if (!spec.hourStar && minutes.length * hours.length <= 6) when = `at ${list(hours.flatMap((h) => minutes.map((m) => `${pad(h)}:${pad(m)}`)))}`;
  else if (minutes.length === 1 && everyStep(hours, 24)) when = `every ${everyStep(hours, 24)} hours at minute ${minutes[0]}`;
  if (!when) return `At cron ${spec.expression}`;

  // Which days.
  const everyDay = spec.domStar && spec.dowStar;
  let which: string | undefined;
  if (everyDay) which = "every day";
  else if (spec.domStar && !spec.dowStar) {
    const key = weekdays.join(",");
    if (key === "1,2,3,4,5") which = "weekdays";
    else if (key === "0,6") which = "weekends";
    else if (weekdays.length === 7) which = "every day";
    else which = weekdays.length === 1 ? `every ${WEEKDAY_WORDS[weekdays[0]!]}` : list(weekdays.map((d) => `${WEEKDAY_WORDS[d]}s`));
  } else if (!spec.domStar && spec.dowStar) {
    which = `on the ${list(days.map(ordinal))} of ${allMonths ? "every month" : list(months.map((m) => MONTH_WORDS[m - 1]!))}`;
  }
  if (!which) return `At cron ${spec.expression}`;
  if (!allMonths && !(!spec.domStar && spec.dowStar)) which += ` in ${list(months.map((m) => MONTH_WORDS[m - 1]!))}`;

  const text = which === "every day" && when.startsWith("every ") ? when : `${which} ${when}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Mon, Nov 23, 08:00" in the zone. */
export function formatRunTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

/** "Nov 23, 2026" in the zone. */
export function formatRunDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(date);
}
