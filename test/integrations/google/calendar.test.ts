import { describe, expect, it } from "vitest";
import { type GoogleEvent, dayStart, googleCalendarSource, mapEvent, parseDate, wallDayOf } from "../../../src/integrations/google/calendar.js";
import { HOUR, NOW, configRepoWith, fakeGoogle, googleApp } from "./fake-google.js";

const TZ = "Asia/Jerusalem";

const timed = (id: string, start: string, end: string, patch: Partial<GoogleEvent> = {}): GoogleEvent => ({
  id,
  status: "confirmed",
  summary: `Event ${id}`,
  start: { dateTime: start },
  end: { dateTime: end },
  htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
  ...patch,
});

describe("calendar days in the owner's timezone", () => {
  it("finds a day's start and the day a moment falls on", () => {
    // Jerusalem is UTC+2 in November.
    expect(dayStart(TZ, Date.UTC(2026, 10, 24)).toISOString()).toBe("2026-11-23T22:00:00.000Z");
    expect(wallDayOf(TZ, new Date("2026-11-23T22:30:00Z"))).toBe(Date.UTC(2026, 10, 24));
    expect(wallDayOf(TZ, new Date("2026-11-23T21:30:00Z"))).toBe(Date.UTC(2026, 10, 23));
    // The day clocks go back in New York is 25 hours long.
    const ny = "America/New_York";
    expect(dayStart(ny, Date.UTC(2026, 10, 1)).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(dayStart(ny, Date.UTC(2026, 10, 2)).toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(parseDate("2026-11-24")).toBe(Date.UTC(2026, 10, 24));
    expect(parseDate("2026-02-30")).toBeUndefined();
    expect(parseDate("tomorrow")).toBeUndefined();
  });
});

describe("mapping Google events", () => {
  it("keeps a timed event's times, the video link, the people and the place", () => {
    const e = mapEvent(
      timed("ev1", "2026-11-24T09:00:00+02:00", "2026-11-24T09:30:00+02:00", {
        summary: "Standup",
        location: "Room 4\nsecond floor",
        hangoutLink: "https://meet.google.com/abc-defg-hij",
        attendees: [{ self: true, responseStatus: "accepted" }, { responseStatus: "accepted" }, { responseStatus: "needsAction" }],
      }),
      TZ,
    );
    expect(e).toEqual({
      id: "ev1",
      title: "Standup",
      start: "2026-11-24T07:00:00.000Z",
      end: "2026-11-24T07:30:00.000Z",
      allDay: false,
      location: "Room 4 second floor",
      link: "https://meet.google.com/abc-defg-hij",
      attendees: 3,
    });
  });

  it("runs an all-day event from its first day's start to the start of the day after its last, in the owner's timezone", () => {
    const one = mapEvent({ id: "ad1", summary: "Offsite", start: { date: "2026-11-24" }, end: { date: "2026-11-25" } }, TZ)!;
    expect(one).toMatchObject({ allDay: true, start: "2026-11-23T22:00:00.000Z", end: "2026-11-24T22:00:00.000Z" });
    const three = mapEvent({ id: "ad3", summary: "Trip", start: { date: "2026-11-24" }, end: { date: "2026-11-27" } }, TZ)!;
    expect(three).toMatchObject({ allDay: true, start: "2026-11-23T22:00:00.000Z", end: "2026-11-26T22:00:00.000Z" });
    const utc = mapEvent({ id: "ad0", start: { date: "2026-11-24" }, end: { date: "2026-11-25" } }, "UTC")!;
    expect(utc).toMatchObject({ title: "(no title)", start: "2026-11-24T00:00:00.000Z", end: "2026-11-25T00:00:00.000Z" });
  });

  it("marks one the owner declined, and leaves out cancelled events and working-location entries", () => {
    const declined = mapEvent(timed("ev2", "2026-11-24T12:00:00Z", "2026-11-24T13:00:00Z", { attendees: [{ self: true, responseStatus: "declined" }, {}] }), TZ);
    expect(declined).toMatchObject({ declined: true, attendees: 2 });
    expect(mapEvent(timed("ev3", "2026-11-24T12:00:00Z", "2026-11-24T13:00:00Z", { attendees: [{ responseStatus: "declined" }, { self: true, responseStatus: "tentative" }] }), TZ)).not.toHaveProperty(
      "declined",
    );
    expect(mapEvent(timed("ev4", "2026-11-24T12:00:00Z", "2026-11-24T13:00:00Z", { status: "cancelled" }), TZ)).toBeUndefined();
    expect(mapEvent({ ...timed("ev5", "2026-11-24T08:00:00Z", "2026-11-24T16:00:00Z"), eventType: "workingLocation" }, TZ)).toBeUndefined();
    expect(mapEvent({ status: "confirmed", start: { dateTime: "2026-11-24T08:00:00Z" } }, TZ)).toBeUndefined();
  });

  it("links the video call, else the event's page, and only over https", () => {
    const video = mapEvent(
      timed("ev6", "2026-11-24T12:00:00Z", "2026-11-24T13:00:00Z", {
        conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:+1-555" }, { entryPointType: "video", uri: "https://zoom.example/j/123" }] },
      }),
      TZ,
    );
    expect(video?.link).toBe("https://zoom.example/j/123");
    expect(mapEvent(timed("ev7", "2026-11-24T12:00:00Z", "2026-11-24T13:00:00Z"), TZ)?.link).toBe("https://www.google.com/calendar/event?eid=ev7");
    expect(mapEvent(timed("ev8", "2026-11-24T12:00:00Z", "2026-11-24T13:00:00Z", { hangoutLink: "javascript:alert(1)", htmlLink: "http://x.example" }), TZ)).not.toHaveProperty("link");
  });
});

describe("googleCalendarSource", () => {
  async function source(events: GoogleEvent[], opts: Parameters<typeof fakeGoogle>[0] = {}, timezone = TZ) {
    const google = fakeGoogle({ events, ...opts });
    const repo = await configRepoWith((c) => {
      c.apps = [googleApp("google-calendar")];
      c.timezone = timezone;
    });
    return { src: googleCalendarSource({ configRepo: repo, fetch: google.fetch, now: () => NOW, sleep: async () => undefined }), google };
  }

  it("reads the primary calendar's events in the range, every page, sorted by start, in the owner's timezone", async () => {
    const events: GoogleEvent[] = [
      timed("b", "2026-11-24T11:00:00+02:00", "2026-11-24T12:00:00+02:00"),
      { id: "allday", summary: "Holiday", start: { date: "2026-11-24" }, end: { date: "2026-11-25" } },
      timed("cancelled", "2026-11-24T13:00:00+02:00", "2026-11-24T14:00:00+02:00", { status: "cancelled" }),
      timed("a", "2026-11-24T09:00:00+02:00", "2026-11-24T10:00:00+02:00"),
      timed("c", "2026-11-24T15:00:00+02:00", "2026-11-24T16:00:00+02:00"),
    ];
    const { src, google } = await source(events, { eventPageSize: 2 });
    const from = dayStart(TZ, Date.UTC(2026, 10, 24));
    const to = dayStart(TZ, Date.UTC(2026, 10, 25));
    const out = await src.eventsBetween(from, to);
    expect(out.map((e) => e.id)).toEqual(["allday", "a", "b", "c"]);
    expect(google.calls).toHaveLength(3);
    const first = google.calls[0]!.url;
    expect(`${first.origin}${first.pathname}`).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    expect(Object.fromEntries([...first.searchParams].filter(([k]) => k !== "fields" && k !== "maxResults"))).toEqual({
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: "2026-11-23T22:00:00.000Z",
      timeMax: "2026-11-24T22:00:00.000Z",
      timeZone: TZ,
    });
    expect(google.calls.map((c) => c.url.searchParams.get("pageToken"))).toEqual([null, "2", "4"]);
    expect(google.calls.every((c) => c.auth === "Bearer access-1")).toBe(true);
    // An empty range asks nothing.
    expect(await src.eventsBetween(to, from)).toEqual([]);
    expect(google.calls).toHaveLength(3);
  });

  it("is ready with one cheap read when the calendar is connected, and remembers it briefly", async () => {
    const { src, google } = await source([timed("x", "2026-11-24T11:00:00Z", "2026-11-24T12:00:00Z")]);
    expect(await src.ready()).toBe(true);
    expect(await src.ready()).toBe(true);
    expect(google.calls).toHaveLength(1);
    expect(google.calls[0]!.url.searchParams.get("maxResults")).toBe("1");
    expect(google.calls[0]!.url.searchParams.get("timeMin")).toBe(NOW.toISOString());
    expect(google.calls[0]!.url.searchParams.get("timeMax")).toBe(new Date(NOW.getTime() + 24 * HOUR).toISOString());

    const repo = await configRepoWith((c) => void (c.apps = []));
    const none = googleCalendarSource({ configRepo: repo, fetch: google.fetch });
    expect(await none.ready()).toBe(false);
    await expect(none.eventsBetween(NOW, new Date(NOW.getTime() + HOUR))).rejects.toThrow(/Google Calendar is not connected/);

    const disabled = await source([], { script: () => new Response(JSON.stringify({ error: { code: 403, errors: [{ reason: "accessNotConfigured" }] } }), { status: 403 }) });
    expect(await disabled.src.ready()).toBe(false);
    await expect(disabled.src.eventsBetween(NOW, new Date(NOW.getTime() + HOUR))).rejects.toThrow(/calendar-json\.googleapis\.com/);
  });
});
