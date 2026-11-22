import { describe, expect, it } from "vitest";
import {
  CHECK_SUMMARY_MAX_CHARS,
  LESSON_AREA_MAX_CHARS,
  REPORTED_LESSONS_MAX,
  parseReport,
  parseReportedChecks,
  parseReportedLessons,
} from "../../src/team/agents.js";

/**
 * parseReport turns the team's structured output into what the worker
 * trusts: a known kind, clipped texts, well-formed checks and lessons. The
 * limits the contract test leaves open, each on both sides.
 */

const base = { kind: "change", title: "Fix the login redirect", summary: "s", verification: "v", risks: "", projectNotes: "" };

describe("parseReport: the kind and the title", () => {
  it("keeps the three known kinds and makes anything else an answer", () => {
    for (const kind of ["change", "blocked", "answer"]) expect(parseReport({ ...base, kind }, "").kind).toBe(kind);
    for (const kind of ["merge", "CHANGE", "", "change "]) expect(parseReport({ ...base, kind }, "").kind, kind).toBe("answer");
  });

  it("clips the title to 120 characters and falls back to Pointer's when there is none", () => {
    expect(parseReport({ ...base, title: "t".repeat(500) }, "").title).toBe("t".repeat(120));
    expect(parseReport({ ...base, title: "t".repeat(120) }, "").title).toBe("t".repeat(120));
    const { title: _omit, ...untitled } = base;
    expect(parseReport(untitled, "").title).toBe("Pointer update");
  });

  it("uses the fallback text when the report has no summary or kind, and keeps notes only as text", () => {
    expect(parseReport({ ...base, summary: 42 }, "plain answer")).toMatchObject({ kind: "answer", summary: "plain answer", title: "Pointer update" });
    expect(parseReport({ summary: "s" }, "plain answer")).toMatchObject({ summary: "plain answer" });
    expect(parseReport({ ...base, projectNotes: { text: "x" } }, "").projectNotes).toBe("");
    expect(parseReport({ ...base, projectNotes: "- uses pnpm" }, "").projectNotes).toBe("- uses pnpm");
  });
});

describe("parseReport: text fields that are not text", () => {
  const NOT_TEXT = [42, true, null, { text: "x" }, ["a title"]];

  it("falls back for a title, verification or risks that is not a string, as when it is missing", () => {
    for (const value of NOT_TEXT) {
      const report = parseReport({ ...base, title: value, verification: value, risks: value }, "");
      expect(report, JSON.stringify(value)).toMatchObject({ title: "Pointer update", verification: "", risks: "", summary: "s", kind: "change" });
    }
    const { title: _t, verification: _v, risks: _r, ...missing } = base;
    expect(parseReport(missing, "")).toMatchObject({ title: "Pointer update", verification: "", risks: "" });
  });

  it("uses the fallback text for a summary that is not a string", () => {
    for (const value of NOT_TEXT) {
      expect(parseReport({ ...base, summary: value }, "plain answer"), JSON.stringify(value)).toMatchObject({ kind: "answer", summary: "plain answer" });
    }
  });

  it("keeps the strings it is given", () => {
    expect(parseReport({ ...base, verification: "npm test: 12 passed", risks: "None known." }, "")).toMatchObject({
      title: "Fix the login redirect",
      verification: "npm test: 12 passed",
      risks: "None known.",
    });
  });
});

describe("parseReport: checks and lessons at their limits", () => {
  it("clips a check's summary to one line of at most the limit", () => {
    const [check] = parseReportedChecks([{ command: "npm test", outcome: "pass", summary: `${"a".repeat(CHECK_SUMMARY_MAX_CHARS)}\n${"b".repeat(500)}` }]);
    expect(check!.summary).toHaveLength(CHECK_SUMMARY_MAX_CHARS);
    expect(check!.summary).not.toContain("\n");
    expect(parseReportedChecks([{ command: "npm test", outcome: "fail", summary: "2 failed" }])[0]!.summary).toBe("2 failed");
  });

  it("keeps at most the limit of lessons, each area clipped", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ area: `area-${i}`, lesson: `lesson ${i}` }));
    const kept = parseReportedLessons(many);
    expect(kept).toHaveLength(REPORTED_LESSONS_MAX);
    expect(kept.at(-1)).toEqual({ area: `area-${REPORTED_LESSONS_MAX - 1}`, lesson: `lesson ${REPORTED_LESSONS_MAX - 1}` });
    const [long] = parseReportedLessons([{ area: "x".repeat(500), lesson: "Refunds are in cents." }]);
    expect(long!.area).toHaveLength(LESSON_AREA_MAX_CHARS);
    expect(parseReportedLessons([{ area: "billing", lesson: "Refunds are in cents." }])).toEqual([{ area: "billing", lesson: "Refunds are in cents." }]);
  });

  it("skips lessons that are not objects, null included, and keeps going", () => {
    expect(parseReportedLessons([null, undefined, "a lesson", 7, ["x"], { area: "auth", lesson: "Sessions end on a new password." }])).toEqual([
      { area: "auth", lesson: "Sessions end on a new password." },
    ]);
    expect(parseReportedChecks([null, undefined, 7, ["npm test"], { command: "npm test", outcome: "pass" }])).toEqual([{ command: "npm test", outcome: "pass", summary: "" }]);
  });
});
