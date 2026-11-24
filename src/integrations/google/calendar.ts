/**
 * The owner's Google Calendar through the Calendar REST API, with the
 * connected Google Calendar app's token (google-api.ts): the events of their
 * primary calendar in a range, recurring ones expanded, as CalendarEvent.
 *
 * Mapping: an all-day event (start.date) runs from the start of its first
 * day to the start of the day after its last, in config.timezone; a timed
 * one keeps its times. Cancelled events and working-location entries are
 * left out; one the owner declined is kept with `declined`. The link is the
 * video call (hangoutLink, else conferenceData's video entry point), else
 * the event's page.
 */
import type { CalendarEvent, CalendarSource } from "../../followups/types.js";
import { momentsFor, wallClock } from "../../routines/cron.js";
import { CALENDAR, type GoogleDeps, connectedApp, googleClient } from "./google-api.js";

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
/** Events per page (the API's maximum is 2500). */
export const CALENDAR_PAGE_SIZE = 250;
/** Events one call reads at most. */
export const MAX_EVENTS = 500;
/** Pages one call reads at most (cancelled events take room on a page too). */
const MAX_PAGES = 4;
const TITLE_MAX = 200;
const LOCATION_MAX = 200;
/** ready() answers from its last check for this long. */
const READY_TTL_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** Only what the mapping needs. */
const FIELDS =
  "nextPageToken,items(id,status,eventType,summary,location,htmlLink,hangoutLink,start,end,attendees(self,responseStatus),conferenceData(entryPoints(entryPointType,uri)))";

interface GoogleTime {
  date?: string;
  dateTime?: string;
}
export interface GoogleEvent {
  id?: string;
  status?: string;
  eventType?: string;
  summary?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  attendees?: { self?: boolean; responseStatus?: string }[];
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
}
interface EventList {
  items?: GoogleEvent[];
  nextPageToken?: string;
}

// ---------- Days in the owner's timezone ----------

/** The start of a calendar day (UTC midnight of its wall date, e.g. Date.UTC(2026, 10, 24)) in `timeZone`. */
export function dayStart(timeZone: string, wallDay: number): Date {
  return new Date(momentsFor(timeZone, wallDay).moments[0]!);
}

/** The calendar day a moment falls on in `timeZone`, as the UTC midnight of that wall date. */
export function wallDayOf(timeZone: string, at: Date): number {
  const wall = wallClock(timeZone, at.getTime());
  return wall - (((wall % DAY_MS) + DAY_MS) % DAY_MS);
}

/** "2026-11-24" as the UTC midnight of that date, or undefined. */
export function parseDate(value: string): number | undefined {
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return undefined;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? ms : undefined;
}

// ---------- Mapping ----------

const clip = (s: string, max: number) => {
  const line = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
};

const httpsLink = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  try {
    const u = new URL(value);
    return u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
};

/** A Google event as a CalendarEvent, or undefined when it is cancelled, a working-location entry, or unreadable. */
export function mapEvent(e: GoogleEvent, timeZone: string): CalendarEvent | undefined {
  if (!e.id || e.status === "cancelled" || e.eventType === "workingLocation") return undefined;
  let start: Date;
  let end: Date;
  const allDay = Boolean(e.start?.date && !e.start.dateTime);
  if (allDay) {
    const first = parseDate(e.start!.date!);
    const after = e.end?.date ? parseDate(e.end.date) : undefined;
    if (first === undefined) return undefined;
    start = dayStart(timeZone, first);
    end = dayStart(timeZone, after !== undefined && after > first ? after : first + DAY_MS);
  } else {
    start = new Date(e.start?.dateTime ?? NaN);
    end = new Date(e.end?.dateTime ?? NaN);
    if (!Number.isFinite(start.getTime())) return undefined;
    if (!Number.isFinite(end.getTime()) || end < start) end = start;
  }
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
  const link = httpsLink(e.hangoutLink) ?? httpsLink(video) ?? httpsLink(e.htmlLink);
  const me = e.attendees?.find((a) => a.self);
  const location = e.location ? clip(e.location, LOCATION_MAX) : "";
  return {
    id: e.id,
    title: clip(e.summary ?? "", TITLE_MAX) || "(no title)",
    start: start.toISOString(),
    end: end.toISOString(),
    allDay,
    ...(location ? { location } : {}),
    ...(link ? { link } : {}),
    ...(e.attendees?.length ? { attendees: e.attendees.length } : {}),
    ...(me?.responseStatus === "declined" ? { declined: true } : {}),
  };
}

// ---------- The source ----------

/** The calendar source, with whether the last read stopped at MAX_EVENTS (for Pointer's tool). */
export interface GoogleCalendarSource extends CalendarSource {
  agenda(from: Date, to: Date): Promise<{ events: CalendarEvent[]; more: boolean; timeZone: string }>;
}

/** The owner's calendar, through the connected Google Calendar app. */
export function googleCalendarSource(deps: GoogleDeps): GoogleCalendarSource {
  const nowMs = () => (deps.now ? deps.now().getTime() : Date.now());
  let readyCache: { value: boolean; at: number } | undefined;

  const read = async (from: Date, to: Date, limit: number, maxPages = MAX_PAGES) => {
    const config = await deps.configRepo.load();
    const timeZone = config.timezone || "UTC";
    const api = googleClient(config, CALENDAR, deps);
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    let more = false;
    let pages = 0;
    do {
      const params = new URLSearchParams({
        singleEvents: "true",
        orderBy: "startTime",
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        timeZone,
        maxResults: String(Math.min(CALENDAR_PAGE_SIZE, limit)),
        fields: FIELDS,
      });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await api.get<EventList>(`${EVENTS_URL}?${params}`);
      for (const item of page.items ?? []) {
        const event = mapEvent(item, timeZone);
        if (event) events.push(event);
      }
      pageToken = typeof page.nextPageToken === "string" && page.nextPageToken ? page.nextPageToken : undefined;
      if (events.length >= limit || ++pages >= maxPages) {
        more = pageToken !== undefined || events.length > limit;
        break;
      }
    } while (pageToken);
    events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || Date.parse(a.end) - Date.parse(b.end));
    return { events: events.slice(0, limit), more, timeZone };
  };

  return {
    async ready() {
      if (readyCache && nowMs() - readyCache.at < READY_TTL_MS) return readyCache.value;
      let value = false;
      try {
        if (connectedApp(await deps.configRepo.load(), CALENDAR)) {
          // A cheap read: the next event, if any.
          const now = new Date(nowMs());
          await read(now, new Date(now.getTime() + DAY_MS), 1, 1);
          value = true;
        }
      } catch {
        value = false;
      }
      readyCache = { value, at: nowMs() };
      return value;
    },
    async eventsBetween(from: Date, to: Date) {
      if (!(to > from)) return [];
      return (await read(from, to, MAX_EVENTS)).events;
    },
    agenda: (from, to) => read(from, to, MAX_EVENTS),
  };
}
