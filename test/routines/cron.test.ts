import { describe, expect, it } from "vitest";
import { describeCron, formatRunTime, nextRun, nextRuns, normalizeTimeZone, parseCron, runsBetween, shortestGapMinutes } from "../../src/routines/cron.js";

const spec = (expr: string) => {
  const parsed = parseCron(expr);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.spec;
};
const iso = (dates: Date[]) => dates.map((d) => d.toISOString());
const runs = (expr: string, tz: string, after: string, count = 3) => iso(nextRuns(spec(expr), tz, new Date(after), count));

describe("parseCron", () => {
  it("reads numbers, ranges, steps, lists, names and macros", () => {
    const s = spec("*/15 9-17 1,15 jan-mar mon-fri");
    expect(s.minutes.flatMap((v, i) => (v ? [i] : []))).toEqual([0, 15, 30, 45]);
    expect(s.hours.flatMap((v, i) => (v ? [i] : []))).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(s.days.flatMap((v, i) => (v ? [i] : []))).toEqual([1, 15]);
    expect(s.months.flatMap((v, i) => (v ? [i] : []))).toEqual([1, 2, 3]);
    expect(s.weekdays.flatMap((v, i) => (v ? [i] : []))).toEqual([1, 2, 3, 4, 5]);
    expect(spec("0 0 * * 7").weekdays[0]).toBe(true);
    expect(spec("5/20 * * * *").minutes.flatMap((v, i) => (v ? [i] : []))).toEqual([5, 25, 45]);
    expect(spec("@daily").expression).toBe("@daily");
    expect(describeCron(spec("@weekly"))).toBe("Every Sunday at 00:00");
  });

  it("names the field that is wrong", () => {
    const error = (expr: string) => {
      const parsed = parseCron(expr);
      return parsed.ok ? "" : parsed.error;
    };
    expect(error("61 * * * *")).toBe("The minute field: 61 is outside 0-59.");
    expect(error("0 24 * * *")).toBe("The hour field: 24 is outside 0-23.");
    expect(error("0 8 * * funday")).toContain("day-of-week");
    expect(error("0 8 5-1 * *")).toContain("goes backwards");
    expect(error("0 8 * *")).toContain("5 fields");
    expect(error("")).toContain("5 fields");
    expect(error("@reboot")).toContain("is not a schedule");
    expect(error("*/0 * * * *")).toContain("step");
  });
});

describe("next runs in a timezone", () => {
  it("runs at local time, every day, in the zone", () => {
    // Jerusalem is UTC+2 in November.
    expect(runs("0 8 * * *", "Asia/Jerusalem", "2026-11-21T12:00:00Z")).toEqual(["2026-11-22T06:00:00.000Z", "2026-11-23T06:00:00.000Z", "2026-11-24T06:00:00.000Z"]);
    expect(runs("0 8 * * *", "UTC", "2026-11-21T07:59:59Z", 1)).toEqual(["2026-11-21T08:00:00.000Z"]);
    // Strictly after: a run at exactly `after` is not the next one.
    expect(runs("0 8 * * *", "UTC", "2026-11-21T08:00:00Z", 1)).toEqual(["2026-11-22T08:00:00.000Z"]);
  });

  it("weekdays, weekly and monthly", () => {
    // 2026-11-21 is a Saturday.
    expect(runs("0 9 * * 1-5", "UTC", "2026-11-21T00:00:00Z", 2)).toEqual(["2026-11-23T09:00:00.000Z", "2026-11-24T09:00:00.000Z"]);
    expect(runs("30 8 * * 1", "Europe/London", "2026-11-21T00:00:00Z", 2)).toEqual(["2026-11-23T08:30:00.000Z", "2026-11-30T08:30:00.000Z"]);
    expect(runs("0 9 1 * *", "UTC", "2026-11-21T00:00:00Z", 2)).toEqual(["2026-12-01T09:00:00.000Z", "2027-01-01T09:00:00.000Z"]);
  });

  it("matches either day field when both are restricted, as classic cron does", () => {
    // The 1st of the month or any Monday.
    expect(runs("0 9 1 * 1", "UTC", "2026-11-28T00:00:00Z", 3)).toEqual(["2026-11-30T09:00:00.000Z", "2026-12-01T09:00:00.000Z", "2026-12-07T09:00:00.000Z"]);
  });

  it("finds leap days and knows a schedule that never runs", () => {
    expect(runs("0 0 29 2 *", "UTC", "2026-11-21T00:00:00Z", 1)).toEqual(["2028-02-29T00:00:00.000Z"]);
    expect(nextRun(spec("0 0 31 2 *"), "UTC", new Date("2026-11-21T00:00:00Z"))).toBeNull();
  });

  it("spring forward: a skipped local time runs once, shifted by the gap", () => {
    // New York jumps from 02:00 to 03:00 on 2026-03-08.
    expect(runs("30 2 * * *", "America/New_York", "2026-03-07T12:00:00Z")).toEqual([
      "2026-03-08T07:30:00.000Z", // 03:30 EDT, the day of the change
      "2026-03-09T06:30:00.000Z", // 02:30 EDT
      "2026-03-10T06:30:00.000Z",
    ]);
    // Every 30 minutes: no run is lost or doubled across the jump.
    expect(runs("*/30 * * * *", "America/New_York", "2026-03-08T06:15:00Z", 4)).toEqual([
      "2026-03-08T06:30:00.000Z", // 01:30 EST
      "2026-03-08T07:00:00.000Z", // 03:00 EDT
      "2026-03-08T07:30:00.000Z",
      "2026-03-08T08:00:00.000Z",
    ]);
  });

  it("fall back: a fixed time runs once; an every-hour schedule runs in both passes", () => {
    // New York repeats 01:00-02:00 on 2026-11-01.
    expect(runs("30 1 * * *", "America/New_York", "2026-10-31T12:00:00Z", 2)).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
    expect(runs("*/30 * * * *", "America/New_York", "2026-11-01T04:45:00Z", 6)).toEqual([
      "2026-11-01T05:00:00.000Z", // 01:00 EDT
      "2026-11-01T05:30:00.000Z", // 01:30 EDT
      "2026-11-01T06:00:00.000Z", // 01:00 EST
      "2026-11-01T06:30:00.000Z", // 01:30 EST
      "2026-11-01T07:00:00.000Z", // 02:00 EST
      "2026-11-01T07:30:00.000Z",
    ]);
  });

  it("handles a half-hour change (Lord Howe) in time order", () => {
    // Lord Howe goes from +10:30 to +11:00 at 02:00 on 2026-10-04: 02:00-02:30 is skipped.
    expect(runs("15,30 2 * * *", "Australia/Lord_Howe", "2026-10-03T10:00:00Z", 3)).toEqual([
      "2026-10-03T15:30:00.000Z", // 02:30
      "2026-10-03T15:45:00.000Z", // 02:15, shifted to 02:45
      "2026-10-04T15:15:00.000Z",
    ]);
  });

  it("counts the runs in a window and the shortest gap", () => {
    const window = runsBetween(spec("0 * * * *"), "UTC", new Date("2026-11-21T00:00:00Z"), new Date("2026-11-21T05:30:00Z"));
    expect(window.count).toBe(5);
    expect(window.last?.toISOString()).toBe("2026-11-21T05:00:00.000Z");
    expect(runsBetween(spec("0 8 * * *"), "UTC", new Date("2026-11-21T08:00:00Z"), new Date("2026-11-21T09:00:00Z")).count).toBe(0);
    expect(shortestGapMinutes(spec("*/15 * * * *"), "UTC", new Date("2026-11-21T00:00:00Z"))).toBe(15);
    expect(shortestGapMinutes(spec("0,5 8 * * *"), "UTC", new Date("2026-11-21T00:00:00Z"))).toBe(5);
  });
});

describe("schedules in words", () => {
  it.each([
    ["0 8 * * *", "Every day at 08:00"],
    ["0 9 * * 1-5", "Weekdays at 09:00"],
    ["0 10 * * 0,6", "Weekends at 10:00"],
    ["30 8 * * 1", "Every Monday at 08:30"],
    ["0 8 * * 1,3", "Mondays and Wednesdays at 08:00"],
    ["0 9 1 * *", "On the 1st of every month at 09:00"],
    ["0 8,17 * * *", "Every day at 08:00 and 17:00"],
    ["*/30 * * * *", "Every 30 minutes"],
    ["0 * * * *", "Every hour"],
    ["0 */2 * * *", "Every 2 hours at minute 0"],
    ["0 9 * 1 1", "Every Monday in January at 09:00"],
    ["7,9,11,13 */3 2-5 * *", "At cron 7,9,11,13 */3 2-5 * *"],
  ])("%s → %s", (expr, words) => {
    expect(describeCron(spec(expr))).toBe(words);
  });

  it("formats a run time in the zone", () => {
    expect(formatRunTime(new Date("2026-11-23T06:00:00Z"), "Asia/Jerusalem")).toBe("Mon, Nov 23, 08:00");
  });
});

describe("normalizeTimeZone", () => {
  it("accepts IANA zones (aliases kept, case fixed) and UTC; refuses the rest", () => {
    expect(normalizeTimeZone("Asia/Jerusalem")).toBe("Asia/Jerusalem");
    expect(normalizeTimeZone("asia/jerusalem")).toBe("Asia/Jerusalem");
    expect(normalizeTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(normalizeTimeZone("UTC")).toBe("UTC");
    expect(normalizeTimeZone(" Europe/London ")).toBe("Europe/London");
    expect(normalizeTimeZone("Mars/Olympus")).toBeUndefined();
    expect(normalizeTimeZone("")).toBeUndefined();
    expect(normalizeTimeZone("../etc/passwd")).toBeUndefined();
  });
});
